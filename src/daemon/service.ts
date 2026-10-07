import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { ConfigStore, type DeepPartial, type JafferConfig } from '../shared/config';
import { makePaths, type JafferPaths } from '../shared/paths';
import { makeSecretStore, type SecretStore } from '../shared/secrets';
import { ensureDir, errMsg, nowIso, writeFileAtomic } from '../shared/util';
import { isSensitiveCommand, redactText } from '../shared/redact';
import { RpcError, RpcServer, type ServerConn } from '../core/rpc';
import { SessionHost } from '../core/session/host';
import { resolveProject } from '../core/session/project';
import { MemoryEngine } from '../core/memory/engine';
import { makeMemoryApi } from '../core/memory-api';
import { AgentRuntime } from '../core/agent/runtime';
import { AgentHub } from '../core/agent/hub';
import { ClaudeCodeEngine } from '../core/agent/claude-engine';
import { executeTool } from '../core/agent/tools';
import { AnthropicLlm, AnthropicProvider, makeClient, resolveCredentials, type Credentials } from '../core/agent/anthropic';
import type { ToolEnv } from '../core/agent/tools';
import { ClaudeIngestor } from '../core/ingest/claude';
import { ClaudeCliLlm } from '../core/agent/claude-cli';
import { claudeStatus, findClaude, hooksConnected, installHooks, setupClaude, teardownClaude } from '../core/integrations/claude';
import { ClaudeWatcher } from '../core/claude/watcher';
import { watchRejection } from '../core/claude/transcript-watch';
import { claudeAuth, ClaudeLogin } from '../core/integrations/claude-auth';
import { detectTargets } from '../core/memory/exports';
import { PROTOCOL, VERSION } from '../core/version';
import type { Decision } from '../core/agent/types';
import type { PtyEvent } from '../core/session/terminal';

const KEY_NAME = 'anthropic-api-key';

export interface ServiceOptions {
  paths?: JafferPaths;
  version?: string;
  /** Absolute path of the CLI bundle the ~/.jaffer/bin/jaffer wrapper should run. */
  cliScript?: string;
  secrets?: SecretStore;
  /** Where "~" is for exports/ingest (tests). */
  userHome?: string;
  log?: (msg: string) => void;
}

/** Backpressure: if a client falls this far behind we stop streaming and resync from a snapshot. */
const MAX_BACKLOG = 8 * 1024 * 1024;

export class JafferService {
  readonly paths: JafferPaths;
  readonly config: ConfigStore;
  readonly rpc = new RpcServer();
  readonly secrets: SecretStore;
  host!: SessionHost;
  memory!: MemoryEngine;
  agent!: AgentHub;
  private claudeBin: string | null = null;
  private claudeProbe: Promise<void> | null = null;
  private login: ClaudeLogin | null = null;
  private loginError: string | undefined;
  private apiKey: string | null = null;
  private client: Anthropic | null = null;
  private startedAt = nowIso();
  private lastCommand: { cmd: string; exit: number | null } | undefined;
  /** The last commands of the session, for the app's session rail. Redacted; sensitive commands are left out entirely. */
  private recentCommands: { cmd: string; exit: number | null; durMs: number; cwd: string; at: number; by: 'user' | 'agent' }[] = [];
  private timers: NodeJS.Timeout[] = [];
  private ingestor: ClaudeIngestor | null = null;
  /** What the Claude in the terminal is doing, from its hook events. Lives here so it survives quitting the app. */
  private claudeWatcher = new ClaudeWatcher();
  private rejectionWatches = new Map<string, () => void>();
  private claudePushTimer: NodeJS.Timeout | null = null;
  private claudePushPending = false;
  private stopping = false;
  private cliLlm: ClaudeCliLlm | null = null;
  readonly onShutdown: { fn: () => void } = { fn: () => undefined };
  private log: (msg: string) => void;
  private userHome: string;
  private version: string;

  constructor(private opts: ServiceOptions = {}) {
    this.paths = opts.paths ?? makePaths();
    this.userHome = opts.userHome ?? os.homedir();
    this.version = opts.version ?? VERSION;
    this.log = opts.log ?? (() => undefined);
    ensureDir(this.paths.home);
    ensureDir(this.paths.runDir);
    this.config = new ConfigStore(this.paths);
    this.secrets = opts.secrets ?? makeSecretStore(this.paths);
  }

  // ------------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    // The API-key engine is off (Claude subscriptions only), so the Keychain is not even read.
    this.apiKey = this.apiEngineEnabled() ? await this.secrets.get(KEY_NAME).catch(() => null) : null;
    this.writeWrapper();
    try {
      // An install from before the live panel only has the memory hooks: add the new events (idempotent, only Jaffer's own entries).
      if (hooksConnected(this.userHome)) installHooks(this.cliWrapper, this.userHome);
    } catch {
      /* the user's settings are theirs: never fail startup over them */
    }
    void ClaudeCliLlm.detect(this.userEnv()).then((l) => (this.cliLlm = l)).catch(() => undefined);

    this.memory = new MemoryEngine({
      paths: this.paths,
      config: this.config,
      home: this.userHome,
      // An API key is preferred; otherwise curate through the user's own Claude Code login when it exists.
      llm: () => (this.credentialsReady() ? new AnthropicLlm(() => this.getClient(), this.config.get().memory.reflectorModel) : this.cliLlm),
    });
    this.host = new SessionHost(this.paths, this.config, this.version);
    const api = new AgentRuntime({
      paths: this.paths,
      config: this.config,
      provider: () => (this.credentialsReady() ? new AnthropicProvider(() => this.getClient()) : null),
      toolEnv: () => this.toolEnv(),
      terminal: () => this.terminalInfo(),
      memory: this.memory,
      credentialsReady: () => this.credentialsReady(),
    });
    const cli = new ClaudeCodeEngine({
      paths: this.paths,
      config: this.config,
      memory: this.memory,
      terminal: () => this.terminalInfo(),
      claudePath: () => this.claudeBin,
      mcp: () => ({ command: this.cliWrapper, args: ['mcp', '--session'], env: { JAFFER_HOME: this.paths.home } }),
      env: () => this.claudeEnv(),
      log: this.log,
    });
    this.agent = new AgentHub(api, cli, this.config, { api: () => this.credentialsReady(), claudeCode: () => this.claudeBin !== null, apiEnabled: () => this.apiEngineEnabled() });
    this.probeClaude();

    this.wireEvents();
    this.registerMethods();
    await this.host.start();
    await this.rpc.listen(this.paths.socket);
    this.memory.start(tickMs());
    this.startIngest();
    this.timers.push(setInterval(() => this.memory.syncExports(), 120_000));
    this.timers[this.timers.length - 1]!.unref?.();
    this.log(`jafferd ${this.version} listening on ${this.paths.socket}`);
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    for (const t of this.timers) clearInterval(t);
    for (const stop of this.rejectionWatches.values()) stop();
    this.rejectionWatches.clear();
    this.memory?.stop();
    await this.agent?.dispose();
    try {
      // Learn from whatever is pending before going away.
      await Promise.race([this.memory?.reflect({ force: false, llm: false }), new Promise((r) => setTimeout(r, 3000))]);
    } catch {
      /* ignore */
    }
    this.host?.dispose();
    await this.rpc.close();
    try {
      fs.unlinkSync(this.paths.socket);
      fs.unlinkSync(this.paths.pidFile);
    } catch {
      /* gone */
    }
  }

  /** ~/.jaffer/bin/jaffer: a stable path agents, hooks and the user can call regardless of where the app lives. */
  private writeWrapper(): void {
    const cli = this.opts.cliScript;
    if (!cli) return;
    ensureDir(this.paths.binDir);
    const isElectron = !!process.versions.electron;
    const script = `#!/bin/sh\n# Generated by Jaffer — runs the Jaffer CLI.\n${isElectron ? 'ELECTRON_RUN_AS_NODE=1 ' : ''}exec ${shq(process.execPath)} ${shq(cli)} "$@"\n`;
    const file = path.join(this.paths.binDir, 'jaffer');
    let cur = '';
    try {
      cur = fs.readFileSync(file, 'utf8');
    } catch {
      /* new */
    }
    if (cur !== script) writeFileAtomic(file, script, 0o755);
    try {
      fs.chmodSync(file, 0o755);
    } catch {
      /* best effort */
    }
  }

  get cliWrapper(): string {
    return path.join(this.paths.binDir, 'jaffer');
  }

  // ------------------------------------------------------------------ credentials

  /**
   * Jaffer runs on Claude subscriptions only for now: the panel and memory curation use the Claude Code login, and an
   * API key (stored or in the environment) is ignored. JAFFER_API_ENGINE=1 switches the old API-key engine back on;
   * the tests use it, and so can a future release.
   */
  apiEngineEnabled(): boolean {
    return process.env.JAFFER_API_ENGINE === '1';
  }

  credentialsReady(): boolean {
    return this.apiEngineEnabled() && (!!this.apiKey || !!process.env.ANTHROPIC_API_KEY || !!process.env.ANTHROPIC_AUTH_TOKEN);
  }

  private credentials(): Credentials {
    return resolveCredentials(this.apiKey);
  }

  private getClient(): Anthropic {
    if (!this.client) this.client = makeClient(this.credentials());
    return this.client;
  }


  // ------------------------------------------------------------------ terminal info + tool env

  private terminalInfo() {
    const pane = this.host.mainPane;
    const cwd = pane?.cwd ?? this.userHome;
    const proj = resolveProject(cwd, this.userHome);
    return { cwd, project: proj.root, branch: proj.branch, lastCommand: this.lastCommand, busy: pane?.runningCommand ?? null };
  }

  private toolEnv(): ToolEnv {
    const mem = this.memory;
    const cwd = () => this.host.mainPane?.cwd ?? this.userHome;
    const pane = () => this.host.mainPane;
    return {
      cwd,
      runIn: this.config.get().agent.runIn,
      runInSession: async (cmd, timeoutMs) => {
        const p = pane();
        if (!p) throw new Error('No terminal session.');
        return p.runCommand(cmd, { timeoutMs });
      },
      readScreen: (n) => pane()?.readScreen(n) ?? '',
      terminalState: () => ({ busy: pane()?.runningCommand ?? null, alt: pane()?.altScreen ?? false, cwd: cwd() }),
      typeIntoTerminal: (t) => pane()?.write(t),
      projectRoot: () => resolveProject(cwd(), this.userHome).root,
      recall: (q) => {
        const r = mem.recall(q, { cwd: cwd(), limit: 8 });
        const lines = r.items.map((i) => `[${i.id}] (${i.kind}${i.scope === 'global' ? '' : ', project'}) ${i.text}`);
        for (const s of r.skills) lines.push(`skill "${s.name}": ${s.whenToUse} → ${s.steps.join(' ; ')}`);
        return lines.join('\n') || 'No matching memories.';
      },
      remember: (text, kind, scope) => {
        const root = resolveProject(cwd(), this.userHome).root;
        const res = mem.remember(text, { source: 'agent', kind: kind as never, scope: scope === 'project' && root ? `project:${root}` : 'global' });
        if ('error' in res) return res.error;
        return res.deduped ? `Already known; reinforced: ${res.item.text}` : `Remembered [${res.item.id}]: ${res.item.text}`;
      },
      forget: (q) => {
        const r = mem.forget(q);
        return r.archived.length ? `Forgot: ${r.archived.map((i) => i.text).join(' | ')}` : 'Nothing matched.';
      },
    };
  }

  // ------------------------------------------------------------------ events

  private attached = (c: ServerConn) => c.meta.attached === true;

  private sendPty(pane: string, event: PtyEvent): void {
    const base = { pane };
    if (event.type === 'data') {
      for (const c of this.rpc.conns) {
        if (!this.attached(c) || c.meta.stale) continue;
        if (c.backlog > MAX_BACKLOG) {
          // Too far behind: stop feeding it, resync from a snapshot once its socket drains.
          c.meta.stale = true;
          c.socket.once('drain', () => void this.resync(c, pane));
          continue;
        }
        c.send({ event: 'pty.data', data: { ...base, data: event.data, seq: event.seq } });
      }
      return;
    }
    const name = `pty.${event.type}`;
    this.rpc.broadcast(name, { ...base, ...event }, this.attached);
  }

  private async resync(c: ServerConn, pane: string): Promise<void> {
    const p = this.host.get(pane);
    if (!p || !c.alive) return;
    const snapshot = await p.consistentSnapshot();
    c.meta.stale = false;
    c.send({ event: 'pty.reset', data: { pane, snapshot } });
  }

  private wireEvents(): void {
    this.host.events.on((e) => {
      if ('lifecycle' in e) {
        this.rpc.broadcast('session.lifecycle', e, this.attached);
        return;
      }
      this.sendPty(e.pane, e.event);
      if (e.event.type === 'command') {
        const ev = e.event;
        this.lastCommand = { cmd: ev.cmd, exit: ev.exit };
        if (ev.cmd.trim() && !isSensitiveCommand(ev.cmd)) {
          this.recentCommands.push({ cmd: redactText(ev.cmd).slice(0, 300), exit: ev.exit, durMs: ev.durMs, cwd: ev.cwd, at: Date.now(), by: ev.by });
          if (this.recentCommands.length > 40) this.recentCommands.splice(0, this.recentCommands.length - 40);
        }
        // The `claude` in the terminal finished (or crashed): whatever its hooks last said is over.
        if (/^\s*(?:\w+=\S*\s+)*(?:command\s+)?(?:\S*\/)?claude(?:\s|$)/.test(ev.cmd)) this.claudeWatcher.endAll();
        const proj = resolveProject(ev.cwd, this.userHome);
        if (ev.cmd.trim()) this.memory.observeCommand({ cmd: ev.cmd, exit: ev.exit, cwd: ev.cwd, project: proj.root, branch: proj.branch, durMs: ev.durMs, out: ev.output, by: ev.by });
      }
    });
    this.agent.events.on((e) => this.rpc.broadcast('agent.event', e));
    this.claudeWatcher.changes.on((sessions) => {
      this.pushClaudeState();
      this.watchForRejections(sessions);
    });
    this.memory.events.on((e) => this.rpc.broadcast('memory.event', e));
    this.config.onChange.on((c) => {
      this.rpc.broadcast('config.changed', c);
      this.memory.syncExports();
      this.startIngest();
    });
  }

  /** At most one push per 100 ms, and never fewer than the last state: the trailing push carries the newest snapshot. */
  private pushClaudeState(): void {
    if (this.claudePushTimer) {
      this.claudePushPending = true;
      return;
    }
    this.rpc.broadcast('claude.state', { sessions: this.claudeWatcher.sessions() });
    this.claudePushTimer = setTimeout(() => {
      this.claudePushTimer = null;
      if (this.claudePushPending) {
        this.claudePushPending = false;
        this.pushClaudeState();
      }
    }, 100);
    this.claudePushTimer.unref?.();
  }

  /** Declining a prompt in the terminal fires no hook: while a session waits for the user, read its transcript for that. */
  private watchForRejections(sessions: { id: string; state: string; transcriptPath?: string }[]): void {
    for (const s of sessions) {
      const waiting = s.state === 'needs-you' && !!s.transcriptPath;
      const watching = this.rejectionWatches.has(s.id);
      if (waiting && !watching) {
        const stop = watchRejection(s.transcriptPath!, () => {
          this.rejectionWatches.delete(s.id);
          this.claudeWatcher.retractNotice(s.id);
        });
        this.rejectionWatches.set(s.id, stop);
      } else if (!waiting && watching) {
        this.rejectionWatches.get(s.id)!();
        this.rejectionWatches.delete(s.id);
      }
    }
  }

  private startIngest(): void {
    const on = this.config.get().ingest.claudeCode && this.config.get().onboarded;
    if (!on) {
      this.ingestor = null;
      return;
    }
    if (this.ingestor) return;
    this.ingestor = new ClaudeIngestor({
      home: this.userHome,
      backfillDays: this.config.get().ingest.backfillDays,
      offsets: this.memory.cursorState().ingest,
      skipCwds: [this.paths.agentDir],
      emit: (e) => void this.memory.observe(e),
      save: (offsets) => this.memory.updateCursor((c) => (c.ingest = offsets)),
    });
    const tick = () => {
      try {
        this.ingestor?.scan();
      } catch (e) {
        this.log(`ingest error: ${errMsg(e)}`);
      }
    };
    setTimeout(tick, Math.min(1500, tickMs())).unref?.();
    const t = setInterval(tick, Math.max(300, tickMs() * 2 / 3));
    t.unref?.();
    this.timers.push(t);
  }

  // ------------------------------------------------------------------ rpc

  private registerMethods(): void {
    const r = this.rpc;
    const pane = (p: { pane?: string }) => {
      const s = this.host.get(p?.pane ?? 'main');
      if (!s) throw new RpcError('No such pane', 'ENOPANE');
      return s;
    };

    r.handle('hello', (p: { client?: string; protocol?: number }) => ({ version: this.version, protocol: PROTOCOL, pid: process.pid, startedAt: this.startedAt, home: this.paths.home, platform: process.platform, client: p?.client }));

    // ---- terminal
    r.handle('session.attach', async (p: { cols?: number; rows?: number; pane?: string }, conn) => {
      const s = pane(p);
      if (p.cols && p.rows) s.resize(p.cols, p.rows);
      const snapshot = await s.consistentSnapshot();
      conn.meta.attached = true;
      conn.meta.stale = false;
      return { pane: p.pane ?? 'main', panes: this.host.list(), snapshot };
    });
    r.handle('session.detach', (_p, conn) => {
      conn.meta.attached = false;
      return true;
    });
    r.handle('session.snapshot', async (p: { pane?: string }) => pane(p).consistentSnapshot());
    r.handle('pty.write', (p: { pane?: string; data: string }) => {
      pane(p).write(String(p.data));
      return true;
    });
    r.handle('pty.resize', (p: { pane?: string; cols: number; rows: number }) => {
      pane(p).resize(p.cols, p.rows);
      return true;
    });
    r.handle('pane.list', () => this.host.list());
    r.handle('session.restart', async () => {
      await this.host.restartMain();
      return true;
    });
    r.handle('session.info', () => ({ ...this.terminalInfo(), panes: this.host.list(), startedAt: this.startedAt, version: this.version, recentCommands: this.recentCommands }));

    // ---- agent
    r.handle('agent.send', async (p: { text: string }) => {
      const text = String(p?.text ?? '').trim();
      if (!text) throw new RpcError('Empty message');
      if (this.claudeProbe) await this.claudeProbe;
      return this.agent.send(text);
    });
    r.handle('agent.cancel', () => {
      this.agent.cancel();
      return true;
    });
    r.handle('agent.approve', (p: { callId: string; decision: Decision }) => this.agent.approve(p.callId, p.decision));
    r.handle('agent.thread', async () => {
      if (this.claudeProbe) await this.claudeProbe; // so the first status already knows whether Claude Code is there
      return { items: this.agent.thread.items(), status: this.agent.status() };
    });
    r.handle('agent.status', () => this.agent.status());
    // ---- the terminal's Claude, live (events come from `jaffer hook` inside Jaffer's own shell)
    r.handle('claude.event', (p: unknown) => {
      this.claudeWatcher.handle(p);
      return { ok: true };
    });
    r.handle('claude.state', () => ({ sessions: this.claudeWatcher.sessions() }));
    r.handle('agent.compact', async () => {
      if (this.agent.kind() === 'claude-code') return { compacted: false }; // Claude Code compacts its own context
      const provider = this.credentialsReady() ? new AnthropicProvider(() => this.getClient()) : null;
      if (!provider) throw new RpcError('No credentials', 'ENOAUTH');
      return { compacted: await this.agent.api.maybeCompact(provider, undefined, true) };
    });
    // Used by the panel's Claude Code process (through `jaffer mcp --session`) to act in the user's own terminal.
    // Approval has already happened: Claude Code asked Jaffer's UI before calling the tool.
    r.handle('agent.tool', async (p: { name: string; input: unknown }) => {
      if (p?.name !== 'run_command' && p?.name !== 'read_terminal') throw new RpcError(`Unknown tool ${p?.name}`);
      return executeTool(this.toolEnv(), p.name, p.input);
    });

    // ---- memory
    const api = makeMemoryApi(this.memory);
    for (const [method, fn] of Object.entries(api)) r.handle(method, (p) => fn(p ?? {}));
    r.handle('ingest.now', () => this.ingestor?.scan() ?? { files: 0, turns: 0 });

    // ---- config & secrets
    r.handle('config.get', () => this.config.get());
    r.handle('config.patch', (p: DeepPartial<JafferConfig>) => this.config.patch(p ?? {}));
    r.handle('secrets.status', async () => {
      await this.probeClaude();
      const st = this.agent.status();
      return { ready: st.ready, apiKey: this.credentialsReady(), claudeCode: this.claudeBin !== null, engine: st.engine, source: this.credentials().source, backend: this.secrets.backend };
    });

    // ---- integrations
    r.handle('setup.targets', () => detectTargets(this.userHome));
    r.handle('setup.claude.status', async () => {
      await this.probeClaude();
      return claudeStatus(this.userHome, this.userEnv());
    });
    // Signed in to Claude Code? Asked as the panel's own Claude Code would be (a login, never an API key). Re-detects
    // the binary each time, so installing Claude Code while the first-run screen is open is noticed.
    r.handle('setup.claude.auth', async () => {
      await this.probeClaude();
      const auth = await claudeAuth(this.claudeBin, this.claudeEnv());
      return { ...auth, loginRunning: this.login?.running ?? false, ...(this.loginError ? { loginError: this.loginError } : {}) };
    });
    // Starts `claude auth login` (it opens the user's browser) and returns at once; the UI watches setup.claude.auth.
    r.handle('setup.claude.login', async (p: { restart?: boolean } | undefined) => {
      await this.probeClaude();
      if (!this.claudeBin) throw new RpcError('Claude Code is not installed.', 'ENOENT');
      if (p?.restart && this.login?.running) {
        const old = this.login.start();
        this.login.cancel();
        await old;
      }
      this.login = this.login ?? new ClaudeLogin(this.claudeBin, this.claudeEnv());
      this.loginError = undefined;
      void this.login.start().then((r) => {
        if (!r.ok && r.message !== 'cancelled') this.loginError = r.message;
      });
      return { started: true };
    });
    r.handle('setup.claude.install', async () => {
      const res = await setupClaude(this.cliWrapper, { home: this.userHome, env: this.userEnv() });
      this.config.patch({ ingest: { claudeCode: true }, export: { targets: [...new Set([...this.config.get().export.targets, 'claude-code' as const])] } });
      return res;
    });
    r.handle('setup.claude.remove', async () => {
      const res = await teardownClaude(this.userHome, this.userEnv());
      this.config.patch({ export: { targets: this.config.get().export.targets.filter((t) => t !== 'claude-code') } });
      return res;
    });

    r.handle('setup.cli.install', () => {
      // A symlink in ~/.local/bin lets `jaffer` work from any terminal, not just Jaffer's own.
      const dir = path.join(this.userHome, '.local', 'bin');
      ensureDir(dir, 0o755);
      const link = path.join(dir, 'jaffer');
      try {
        fs.rmSync(link, { force: true });
      } catch {
        /* ignore */
      }
      fs.symlinkSync(this.cliWrapper, link);
      const onPath = (process.env.PATH ?? '').split(path.delimiter).includes(dir);
      return { link, onPath, hint: onPath ? undefined : 'Add ~/.local/bin to your PATH (e.g. export PATH="$HOME/.local/bin:$PATH" in ~/.zshrc).' };
    });

    r.handle('app.shutdown', () => {
      setTimeout(() => this.onShutdown.fn(), 50);
      return true;
    });
  }

  private userEnv(): NodeJS.ProcessEnv {
    return { ...process.env, HOME: this.userHome };
  }

  /** The environment the panel's Claude Code runs in: the user's own, signed in with their login rather than a key. */
  private claudeEnv(): NodeJS.ProcessEnv {
    const env = this.userEnv();
    if (process.env.JAFFER_KEEP_ANTHROPIC_ENV !== '1') {
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
    }
    env.JAFFER_NO_HOOKS = '1'; // the panel injects memory itself; Jaffer's hooks must not add it twice
    return env;
  }

  /** Find the `claude` binary once (and again on demand), so readiness checks stay synchronous. */
  private probeClaude(): Promise<void> {
    if (!this.claudeProbe) {
      this.claudeProbe = findClaude(this.userEnv())
        .then((p) => void (this.claudeBin = p))
        .catch(() => void (this.claudeBin = null))
        .finally(() => {
          this.claudeProbe = null;
        });
    }
    return this.claudeProbe;
  }
}

/** Housekeeping cadence. Overridable so tests can watch memory evolve in seconds instead of minutes. */
function tickMs(): number {
  const v = Number(process.env.JAFFER_TICK_MS);
  return Number.isFinite(v) && v >= 100 ? v : 30_000;
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
