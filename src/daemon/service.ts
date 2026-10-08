import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore, type DeepPartial, type JafferConfig } from '../shared/config';
import { makePaths, type JafferPaths } from '../shared/paths';
import { ensureDir, errMsg, nowIso, writeFileAtomic } from '../shared/util';
import { RpcError, RpcServer, type ServerConn } from '../core/rpc';
import { SessionHost } from '../core/session/host';
import { resolveProject } from '../core/session/project';
import { MemoryEngine } from '../core/memory/engine';
import { makeMemoryApi } from '../core/memory-api';
import { ClaudeIngestor } from '../core/ingest/claude';
import { ClaudeCliLlm } from '../core/agent/claude-cli';
import { claudeStatus, findClaude, hooksPointAt, installHooks, setupClaude, teardownClaude } from '../core/integrations/claude';
import { ClaudeWatcher } from '../core/claude/watcher';
import { transcriptActive, watchInterruption } from '../core/claude/transcript-watch';
import { isTerminalReport } from '../shared/terminal-reports';
import { isClaudeCommand } from '../shared/process-badge';
import { endsConversation, isSessionId, type ResumeOffer } from '../shared/claude-resume';
import { ResumeStore } from '../core/claude/resume';
import { readTurnCost, transcriptSize } from '../core/claude/cost';
import { claudeAuth, ClaudeLogin } from '../core/integrations/claude-auth';
import { detectTargets } from '../core/memory/exports';
import { PROTOCOL, VERSION } from '../core/version';
import type { PtyEvent } from '../core/session/terminal';

export interface ServiceOptions {
  paths?: JafferPaths;
  version?: string;
  /** Absolute path of the CLI bundle the ~/.jaffer/bin/jaffer wrapper should run. */
  cliScript?: string;
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
  host!: SessionHost;
  memory!: MemoryEngine;
  private claudeBin: string | null = null;
  private claudeProbe: Promise<void> | null = null;
  private login: ClaudeLogin | null = null;
  private loginError: string | undefined;
  private startedAt = nowIso();
  private timers: NodeJS.Timeout[] = [];
  private ingestor: ClaudeIngestor | null = null;
  /** What the Claude in the terminal is doing, from its hook events. Lives here so it survives quitting the app. */
  private claudeWatcher = new ClaudeWatcher();
  /** The Claude Code conversation to offer back after a restart (ids and a folder only; see ResumeStore). */
  private resume: ResumeStore;
  private lastOffer = 'null';
  private rejectionWatches = new Map<string, () => void>();
  /** Where each session's transcript stood when its current prompt was sent: the answer is what was written after. */
  private turnStart = new Map<string, number>();
  private costTimers = new Set<NodeJS.Timeout>();
  /** The scan timers of Claude Code transcript ingest: kept so that switching it off stops them (and on again does not stack them). */
  private ingestTimers: NodeJS.Timeout[] = [];
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
    this.resume = new ResumeStore(path.join(this.paths.sessionDir, 'claude.json'));
    ensureDir(this.paths.home);
    ensureDir(this.paths.runDir);
    this.config = new ConfigStore(this.paths);
  }

  // ------------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    await this.rpc.assertFree(this.paths.socket); // before a shell is spawned for a daemon that cannot take the socket
    this.writeWrapper();
    try {
      // An install from before the live panel only has the memory hooks: add the new events (idempotent, only Jaffer's own
      // entries). Only when they already run THIS daemon's wrapper: another Jaffer home's hooks are not ours to rewrite.
      if (hooksPointAt(this.cliWrapper, this.userHome)) installHooks(this.cliWrapper, this.userHome);
    } catch {
      /* the user's settings are theirs: never fail startup over them */
    }
    this.memory = new MemoryEngine({
      paths: this.paths,
      config: this.config,
      home: this.userHome,
      // Jaffer runs on a Claude subscription: memory is curated through the user's own Claude Code login (`claude -p`).
      llm: () => this.cliLlm,
    });
    this.host = new SessionHost(this.paths, this.config, this.version);
    this.probeClaude();

    this.wireEvents();
    this.registerMethods();
    await this.host.start();
    await this.rpc.listen(this.paths.socket);
    this.memory.start(tickMs());
    this.lastOffer = JSON.stringify(this.resumeOffer()); // the baseline for what changes after this
    this.startIngest();
    this.timers.push(setInterval(() => this.memory.syncExports(), 120_000));
    this.timers[this.timers.length - 1]!.unref?.();
    // a turn that ended with no signal at all (Esc, an API error, a crash) must not stay "Working" for ever
    this.timers.push(setInterval(() => this.claudeWatcher.sweep((s) => transcriptActive(s.transcriptPath, s.tool ? 30 * 60_000 : 5 * 60_000)), 30_000));
    this.timers[this.timers.length - 1]!.unref?.();
    this.log(`jafferd ${this.version} listening on ${this.paths.socket}`);
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    for (const t of this.timers) clearInterval(t);
    for (const stop of this.rejectionWatches.values()) stop();
    this.rejectionWatches.clear();
    for (const t of this.costTimers) clearTimeout(t);
    this.costTimers.clear();
    for (const t of this.ingestTimers) clearTimeout(t);
    this.ingestTimers = [];
    this.memory?.stop();
    this.login?.cancel(); // a `claude auth login` left running would outlive the daemon
    this.resume.flush();
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
    } catch {
      /* gone: closing the server already removes it */
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

  // ------------------------------------------------------------------ terminal info

  private terminalInfo() {
    const pane = this.host.mainPane;
    const cwd = pane?.cwd ?? this.userHome;
    const proj = resolveProject(cwd, this.userHome);
    return { cwd, project: proj.root, branch: proj.branch, busy: pane?.runningCommand ?? null, busySince: pane?.runningSince ?? null };
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
      // where the shell is, and whether it is busy, decide whether a conversation can be offered back
      if (e.event.type === 'cwd' || e.event.type === 'start' || e.event.type === 'command') this.pushResume();
      if (e.event.type === 'command') {
        const ev = e.event;
        // The `claude` in the terminal finished (or crashed): whatever its hooks last said is over. Not when it was only
        // stopped (Ctrl+Z reports 128 + a stop signal): it comes back with `fg`.
        const stopped = ev.exit != null && ev.exit >= 145 && ev.exit <= 150;
        if (!stopped && isClaudeCommand(ev.cmd)) {
          this.claudeWatcher.endAll();
          // quit on purpose (exit 0, or Ctrl+C): nothing to offer afterwards. A crash or a kill leaves the offer, and a daemon that is
          // stopping must not take it away (the shell dying with it is not the person ending the conversation)
          if (!this.stopping && (ev.exit === 0 || ev.exit === 130) && endsConversation(ev.cmd)) this.resume.forget();
          this.pushResume();
        }
        const proj = resolveProject(ev.cwd, this.userHome);
        if (ev.cmd.trim()) this.memory.observeCommand({ cmd: ev.cmd, exit: ev.exit, cwd: ev.cwd, project: proj.root, branch: proj.branch, durMs: ev.durMs, out: ev.output });
      }
    });
    this.claudeWatcher.changes.on((sessions) => {
      this.pushClaudeState();
      this.watchForRejections(sessions);
      this.pushResume();
    });
    this.memory.events.on((e) => this.rpc.broadcast('memory.event', e));
    this.config.onChange.on((c) => {
      this.rpc.broadcast('config.changed', c);
      if (!c.session.resumeClaude) this.resume.forget(); // off forgets it, as Settings says: nothing of the conversation stays on disk
      this.pushResume();
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
    this.rpc.broadcast('claude.state', { sessions: this.claudeWatcher.view() });
    this.claudePushTimer = setTimeout(() => {
      this.claudePushTimer = null;
      if (this.claudePushPending) {
        this.claudePushPending = false;
        this.pushClaudeState();
      }
    }, 100);
    this.claudePushTimer.unref?.();
  }

  /**
   * What an answer cost: measured on the transcript from the prompt to the Stop hook, only the token counts are read. The last
   * lines may land just after the hook fires, so an empty read is tried once more.
   */
  private trackCost(p: unknown): void {
    if (!p || typeof p !== 'object') return;
    const o = p as Record<string, unknown>;
    const id = typeof o.session_id === 'string' ? o.session_id.slice(0, 80) : '';
    if (!id) return;
    const file = typeof o.transcript_path === 'string' ? o.transcript_path : this.claudeWatcher.sessions().find((s) => s.id === id)?.transcriptPath;
    if (o.hook_event_name === 'UserPromptSubmit') {
      this.turnStart.set(id, transcriptSize(file));
      if (this.turnStart.size > 20) this.turnStart.delete(this.turnStart.keys().next().value!);
    } else if (o.hook_event_name === 'SessionEnd') {
      this.turnStart.delete(id);
    } else if (o.hook_event_name === 'Stop') {
      const start = this.turnStart.get(id);
      if (start === undefined || !file) return;
      if (!this.config.get().claude.showCost) {
        this.turnStart.set(id, transcriptSize(file));
        return;
      }
      // a response Claude gives without a new prompt (a background agent finished) is measured from where the last one ended
      const read = (retry: boolean): void => {
        const end = transcriptSize(file);
        const turn = readTurnCost(file, start, end);
        if (turn) {
          this.turnStart.set(id, end);
          this.claudeWatcher.setCost(id, turn);
        } else if (retry) this.later(1500, () => read(false));
      };
      this.later(300, () => read(true));
    }
  }

  /** The hooks tell which conversation is alive and where; SessionEnd says the person ended it. */
  private trackResume(p: unknown): void {
    if (!p || typeof p !== 'object' || this.stopping) return;
    const o = p as Record<string, unknown>;
    const id = typeof o.session_id === 'string' ? o.session_id : '';
    if (!isSessionId(id)) return;
    if (o.hook_event_name === 'SessionEnd') this.resume.forget(id);
    else if (this.config.get().session.resumeClaude) this.resume.note({ id, cwd: typeof o.cwd === 'string' ? o.cwd : undefined, transcriptPath: typeof o.transcript_path === 'string' ? o.transcript_path : undefined, starts: o.hook_event_name === 'SessionStart' });
    this.pushResume();
  }

  private resumeOffer(): ResumeOffer | null {
    const pane = this.host?.mainPane;
    return this.resume.offer({
      shellCwd: pane?.cwd,
      active: this.claudeWatcher.sessions().some((s) => s.state !== 'ended'),
      busy: !!pane?.runningCommand,
      enabled: this.config.get().session.resumeClaude,
    });
  }

  /** Tells the window when what can be resumed changes (and only then). */
  private pushResume(): void {
    const offer = this.resumeOffer();
    const key = JSON.stringify(offer);
    if (key === this.lastOffer) return;
    this.lastOffer = key;
    this.rpc.broadcast('claude.resume', offer);
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.costTimers.delete(t);
      fn();
    }, ms);
    t.unref?.();
    this.costTimers.add(t);
  }

  /**
   * Declining a prompt or pressing Esc in the terminal fires no hook (and Esc no Stop): while a session works or waits for the
   * user, read its transcript for the line that says so.
   */
  private watchForRejections(sessions: { id: string; state: string; transcriptPath?: string; tool?: unknown }[]): void {
    for (const s of sessions) {
      const watching = this.rejectionWatches.has(s.id);
      const waiting = !!s.transcriptPath && (s.state === 'needs-you' || s.state === 'working');
      if (waiting && !watching) {
        const stop = watchInterruption(s.transcriptPath!, () => {
          this.rejectionWatches.delete(s.id);
          this.claudeWatcher.interrupted(s.id);
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
      for (const t of this.ingestTimers) clearTimeout(t);
      this.ingestTimers = [];
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
    const first = setTimeout(tick, Math.min(1500, tickMs()));
    const every = setInterval(tick, Math.max(300, tickMs() * 2 / 3));
    first.unref?.();
    every.unref?.();
    this.ingestTimers = [first, every];
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
      // typing while Claude waits for them means they are answering; the terminal's own replies and focus reports do not
      if (!isTerminalReport(String(p.data))) this.claudeWatcher.userAnswered();
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
    r.handle('session.info', () => ({ ...this.terminalInfo(), panes: this.host.list(), startedAt: this.startedAt, version: this.version }));

    // ---- the terminal's Claude, live (events come from `jaffer hook` inside Jaffer's own shell)
    r.handle('claude.event', (p: unknown) => {
      this.claudeWatcher.handle(p);
      this.trackCost(p);
      this.trackResume(p);
      return { ok: true };
    });
    r.handle('claude.state', () => ({ sessions: this.claudeWatcher.view() }));
    r.handle('claude.resume', () => {
      // what a window has just been told is what the next change is measured against
      const offer = this.resumeOffer();
      this.lastOffer = JSON.stringify(offer);
      return offer;
    });
    r.handle('claude.resume.dismiss', () => {
      this.resume.forget();
      this.pushResume();
      return true;
    });

    // ---- memory
    const api = makeMemoryApi(this.memory);
    for (const [method, fn] of Object.entries(api)) r.handle(method, (p) => fn(p ?? {}));
    r.handle('ingest.now', () => this.ingestor?.scan() ?? { files: 0, turns: 0 });

    // ---- config
    r.handle('config.get', () => this.config.get());
    r.handle('config.patch', (p: DeepPartial<JafferConfig>) => this.config.patch(p ?? {}));

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
    // `mcp: false` connects the hooks only (what the first run does); Settings adds the memory tools too.
    r.handle('setup.claude.install', async (p: { mcp?: boolean } | undefined) => {
      const res = await setupClaude(this.cliWrapper, { home: this.userHome, env: this.userEnv(), mcp: p?.mcp });
      this.config.patch({ claude: { skipped: false }, ingest: { claudeCode: true }, export: { targets: [...new Set([...this.config.get().export.targets, 'claude-code' as const])] } });
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
      const there = fs.lstatSync(link, { throwIfNoEntry: false });
      if (there && !there.isSymbolicLink()) throw new RpcError('~/.local/bin/jaffer is a file of yours, not a link Jaffer made. Move it away and try again.', 'EEXIST');
      if (there) fs.rmSync(link, { force: true });
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
        .then((p) => {
          this.claudeBin = p;
          // memory is curated through `claude -p` on the person's login, never an API key; picked up whenever Claude Code turns up
          if (p && !this.cliLlm) this.cliLlm = new ClaudeCliLlm(p, this.claudeEnv());
        })
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
