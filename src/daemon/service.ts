import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { ConfigStore, type DeepPartial, type JafferConfig } from '../shared/config';
import { makePaths, type JafferPaths } from '../shared/paths';
import { makeSecretStore, type SecretStore } from '../shared/secrets';
import { ensureDir, errMsg, nowIso, writeFileAtomic } from '../shared/util';
import { RpcError, RpcServer, type ServerConn } from '../core/rpc';
import { SessionHost } from '../core/session/host';
import { resolveProject } from '../core/session/project';
import { MemoryEngine } from '../core/memory/engine';
import { makeMemoryApi } from '../core/memory-api';
import { AgentRuntime } from '../core/agent/runtime';
import { AnthropicLlm, AnthropicProvider, makeClient, resolveCredentials, type Credentials } from '../core/agent/anthropic';
import type { ToolEnv } from '../core/agent/tools';
import { ClaudeIngestor } from '../core/ingest/claude';
import { claudeStatus, setupClaude, teardownClaude } from '../core/integrations/claude';
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
  agent!: AgentRuntime;
  private apiKey: string | null = null;
  private client: Anthropic | null = null;
  private startedAt = nowIso();
  private lastCommand: { cmd: string; exit: number | null } | undefined;
  private timers: NodeJS.Timeout[] = [];
  private ingestor: ClaudeIngestor | null = null;
  private stopping = false;
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
    this.apiKey = await this.secrets.get(KEY_NAME).catch(() => null);
    this.writeWrapper();

    this.memory = new MemoryEngine({
      paths: this.paths,
      config: this.config,
      home: this.userHome,
      llm: () => (this.credentialsReady() ? new AnthropicLlm(() => this.getClient(), this.config.get().memory.reflectorModel) : null),
    });
    this.host = new SessionHost(this.paths, this.config, this.version);
    this.agent = new AgentRuntime({
      paths: this.paths,
      config: this.config,
      provider: () => (this.credentialsReady() ? new AnthropicProvider(() => this.getClient()) : null),
      toolEnv: () => this.toolEnv(),
      terminal: () => this.terminalInfo(),
      memory: this.memory,
      credentialsReady: () => this.credentialsReady(),
    });

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
    this.memory?.stop();
    this.agent?.cancel();
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

  credentialsReady(): boolean {
    return !!this.apiKey || !!process.env.ANTHROPIC_API_KEY || !!process.env.ANTHROPIC_AUTH_TOKEN;
  }

  private credentials(): Credentials {
    return resolveCredentials(this.apiKey);
  }

  private getClient(): Anthropic {
    if (!this.client) this.client = makeClient(this.credentials());
    return this.client;
  }

  private async setKey(key: string | null): Promise<void> {
    if (key) await this.secrets.set(KEY_NAME, key);
    else await this.secrets.delete(KEY_NAME);
    this.apiKey = key;
    this.client = null;
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
        const proj = resolveProject(ev.cwd, this.userHome);
        if (ev.cmd.trim()) this.memory.observeCommand({ cmd: ev.cmd, exit: ev.exit, cwd: ev.cwd, project: proj.root, branch: proj.branch, durMs: ev.durMs, out: ev.output, by: ev.by });
      }
    });
    this.agent.events.on((e) => this.rpc.broadcast('agent.event', e));
    this.memory.events.on((e) => this.rpc.broadcast('memory.event', e));
    this.config.onChange.on((c) => {
      this.rpc.broadcast('config.changed', c);
      this.memory.syncExports();
      this.startIngest();
    });
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
    r.handle('pane.split', async (p: { cwd?: string }) => ({ pane: await this.host.split(p?.cwd) }));
    r.handle('pane.close', (p: { pane: string }) => this.host.close(p.pane));
    r.handle('session.restart', async () => {
      await this.host.restartMain();
      return true;
    });
    r.handle('session.info', () => ({ ...this.terminalInfo(), panes: this.host.list(), startedAt: this.startedAt, version: this.version }));

    // ---- agent
    r.handle('agent.send', (p: { text: string }) => {
      const text = String(p?.text ?? '').trim();
      if (!text) throw new RpcError('Empty message');
      return this.agent.send(text);
    });
    r.handle('agent.cancel', () => {
      this.agent.cancel();
      return true;
    });
    r.handle('agent.approve', (p: { callId: string; decision: Decision }) => this.agent.approve(p.callId, p.decision));
    r.handle('agent.thread', () => ({ items: this.agent.thread.items(), status: this.agent.status() }));
    r.handle('agent.status', () => this.agent.status());
    r.handle('agent.compact', async () => {
      const provider = this.credentialsReady() ? new AnthropicProvider(() => this.getClient()) : null;
      if (!provider) throw new RpcError('No credentials', 'ENOAUTH');
      return { compacted: await this.agent.maybeCompact(provider, undefined, true) };
    });

    // ---- memory
    const api = makeMemoryApi(this.memory);
    for (const [method, fn] of Object.entries(api)) r.handle(method, (p) => fn(p ?? {}));
    r.handle('ingest.now', () => this.ingestor?.scan() ?? { files: 0, turns: 0 });

    // ---- config & secrets
    r.handle('config.get', () => this.config.get());
    r.handle('config.patch', (p: DeepPartial<JafferConfig>) => this.config.patch(p ?? {}));
    r.handle('secrets.status', async () => ({ ready: this.credentialsReady(), source: this.credentials().source, backend: this.secrets.backend }));
    r.handle('secrets.setAnthropicKey', async (p: { key: string; verify?: boolean }) => {
      const key = String(p?.key ?? '').trim();
      if (!key) throw new RpcError('Empty key');
      const previous = this.apiKey;
      await this.setKey(key);
      if (p.verify !== false) {
        try {
          await this.getClient().models.list({ limit: 1 });
        } catch (e) {
          const status = (e as { status?: number }).status;
          if (status === 401 || status === 403) {
            await this.setKey(previous);
            throw new RpcError('Anthropic rejected that key.', 'EAUTH');
          }
          // network trouble etc.: keep the key, report softly
          return { ok: true, verified: false, note: errMsg(e) };
        }
      }
      return { ok: true, verified: true };
    });
    r.handle('secrets.clearAnthropicKey', async () => {
      await this.setKey(null);
      return { ok: true };
    });

    // ---- integrations
    r.handle('setup.targets', () => detectTargets(this.userHome));
    r.handle('setup.claude.status', () => claudeStatus(this.userHome, this.userEnv()));
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
}

/** Housekeeping cadence. Overridable so tests can watch memory evolve in seconds instead of minutes. */
function tickMs(): number {
  const v = Number(process.env.JAFFER_TICK_MS);
  return Number.isFinite(v) && v >= 100 ? v : 30_000;
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
