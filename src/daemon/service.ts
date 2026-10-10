import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore, type DeepPartial, type JafferConfig } from '../shared/config';
import { makePaths, type JafferPaths } from '../shared/paths';
import { ensureDir, errMsg, nowIso, writeFileAtomic } from '../shared/util';
import { RpcError, RpcServer, type ServerConn } from '../core/rpc';
import { SessionHost } from '../core/session/host';
import { resolveProject } from '../core/session/project';
import { claudeStatus, findClaude, hooksPointAt, installHooks, setupClaude, teardownClaude } from '../core/integrations/claude';
import { ClaudeWatcher } from '../core/claude/watcher';
import { transcriptActive, watchInterruption } from '../core/claude/transcript-watch';
import { StayAwake, type Work } from '../core/session/stay-awake';
import { caffeinateHold } from '../core/session/caffeinate';
import { isTerminalReport } from '../shared/terminal-reports';
import { isClaudeCommand } from '../shared/process-badge';
import { readTurnCost, STOP_AFTER_END_GRACE_MS, transcriptSize } from '../core/claude/cost';
import { claudeAuth, ClaudeLogin } from '../core/integrations/claude-auth';
import { PROTOCOL, VERSION } from '../core/version';
import type { PtyEvent } from '../core/session/terminal';

export interface ServiceOptions {
  paths?: JafferPaths;
  version?: string;
  /** Absolute path of the CLI bundle the ~/.jaffer/bin/jaffer wrapper should run. */
  cliScript?: string;
  /** Where "~" is: Claude Code's settings (the hooks) and `~/.local/bin` live there (tests move it). */
  userHome?: string;
  log?: (msg: string) => void;
}

/** Backpressure: if a client falls this far behind we stop streaming and resync from a snapshot. */
const MAX_BACKLOG = 8 * 1024 * 1024;

/** While a command runs, the daemon looks at it this often, so that it holds the Mac awake soon after half a minute. */
const STAY_AWAKE_TICK_MS = 5000;

export class JafferService {
  readonly paths: JafferPaths;
  readonly config: ConfigStore;
  readonly rpc = new RpcServer();
  host!: SessionHost;
  private claudeBin: string | null = null;
  private claudeProbe: Promise<void> | null = null;
  private login: ClaudeLogin | null = null;
  private loginError: string | undefined;
  private startedAt = nowIso();
  private timers: NodeJS.Timeout[] = [];
  /** What the Claude in the terminal is doing, from its hook events. Lives here, with the shell, where the hooks report. */
  private claudeWatcher = new ClaudeWatcher();
  private rejectionWatches = new Map<string, () => void>();
  /** Where each session's transcript stood when its current prompt was sent: the answer is what was written after. */
  private turnStart = new Map<string, number>();
  private costTimers = new Set<NodeJS.Timeout>();
  private claudePushTimer: NodeJS.Timeout | null = null;
  private claudePushPending = false;
  private stopping = false;
  /** Keeps the Mac from idle sleep while Claude or a long command works (see `refreshStayAwake`). */
  private stayAwake: StayAwake;
  /** Looks at a running command every few seconds, so that it counts once it has run half a minute; only while one runs. */
  private commandTicker: NodeJS.Timeout | null = null;
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
    this.stayAwake = new StayAwake({
      ...caffeinateHold(this.paths.home),
      pid: process.pid,
      log: (m) => this.log(`stay awake: ${m}`), // (a hold that cannot start, said once)
      now: () => Date.now(),
      setTimer: (fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return t;
      },
      clearTimer: (t) => clearTimeout(t as NodeJS.Timeout),
    });
  }

  // ------------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    await this.rpc.assertFree(this.paths.socket); // before a shell is spawned for a daemon that cannot take the socket
    this.writeWrapper();
    try {
      // Jaffer's hooks as this version writes them (idempotent, only Jaffer's own entries): an install from before gets the events it
      // lacks, and its SessionStart and Stop (which fed the memory) become async and guarded like the rest. Only when they already run
      // THIS daemon's wrapper: another Jaffer home's hooks are not ours to rewrite.
      if (hooksPointAt(this.cliWrapper, this.userHome)) installHooks(this.cliWrapper, this.userHome);
    } catch {
      /* the user's settings are theirs: never fail startup over them */
    }
    this.host = new SessionHost(this.paths, this.config, this.version);
    this.probeClaude();

    this.wireEvents();
    this.registerMethods();
    await this.host.start();
    await this.rpc.listen(this.paths.socket);
    // a turn that ended with no signal at all (Esc, an API error, a crash) must not stay "Working" for ever
    this.timers.push(setInterval(() => this.claudeWatcher.sweep((s) => transcriptActive(s.transcriptPath, s.tool ? 30 * 60_000 : 5 * 60_000)), 30_000));
    this.timers[this.timers.length - 1]!.unref?.();
    this.log(`jafferd ${this.version} listening on ${this.paths.socket}`);
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.stopStayAwake(); // first: nothing below may keep the Mac awake
    for (const t of this.timers) clearInterval(t);
    for (const stop of this.rejectionWatches.values()) stop();
    this.rejectionWatches.clear();
    for (const t of this.costTimers) clearTimeout(t);
    this.costTimers.clear();
    this.login?.cancel(); // a `claude auth login` left running would outlive the daemon
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

  /**
   * A fresh shell replaced the one that exited (`exit`, Restart shell): its output counts from 1 again, so a window still showing the old
   * screen would drop it as already seen. Every attached window starts over from the new shell's blank screen, as after falling behind
   * (one that is behind gets its own snapshot of the new shell once it drains).
   */
  private async resyncAttached(pane: string): Promise<void> {
    const p = this.host.get(pane);
    if (!p) return;
    const snapshot = await p.consistentSnapshot();
    if (this.stopping || this.host.get(pane) !== p) return; // (replaced again meanwhile: that shell's own reset follows)
    for (const c of this.rpc.conns) {
      if (this.attached(c) && !c.meta.stale && c.alive) c.send({ event: 'pty.reset', data: { pane, snapshot } });
    }
  }

  private wireEvents(): void {
    this.host.events.on((e) => {
      if ('lifecycle' in e) {
        this.rpc.broadcast('session.lifecycle', e, this.attached);
        if (e.lifecycle === 'restarted') void this.resyncAttached(e.pane);
        this.refreshStayAwake(); // (a new shell runs nothing)
        return;
      }
      this.sendPty(e.pane, e.event);
      // a command began or ended, or the shell is gone: a long one holds the Mac awake, and none holds nothing
      if (e.event.type === 'start' || e.event.type === 'command' || e.event.type === 'exit') this.refreshStayAwake();
      // The shell is gone and took its Claude with it: no conversation is running any more (a daemon that is stopping leaves it as it is).
      if (e.event.type === 'exit' && !this.stopping) this.claudeWatcher.endAll();
      // The `claude` in the terminal finished (or crashed): whatever its hooks last said is over. Not when it was only stopped (Ctrl+Z
      // reports 128 + a stop signal): it comes back with `fg`. (The command line comes from the shell's marks, which any output can forge
      // at any length: `isClaudeCommand` reads only its start.)
      if (e.event.type === 'command' && !stoppedExit(e.event.exit) && isClaudeCommand(e.event.cmd)) this.claudeWatcher.endAll();
    });
    this.claudeWatcher.changes.on((sessions) => {
      this.refreshStayAwake();
      this.pushClaudeState();
      this.watchForRejections(sessions);
    });
    this.config.onChange.on((c) => {
      this.rpc.broadcast('config.changed', c);
      this.refreshStayAwake(); // (the switch for staying awake)
    });
  }

  // ------------------------------------------------------------------ stay awake

  /**
   * What works now. Claude: a session is working, or a background agent runs (a Claude that waits for the person is not work, and an
   * ended session has nothing running). A command: the one running in the shell, if the shell is alive (a shell that died mid-command
   * never reported its end).
   */
  private stayAwakeWork(): Work {
    const claude = this.claudeWatcher.sessions().some((s) => s.state !== 'ended' && (s.state === 'working' || s.subagents.some((a) => a.status === 'running')));
    const pane = this.host?.mainPane;
    const cmd = pane?.alive ? pane.runningCommand : null;
    const since = pane?.runningSince ?? null;
    return { enabled: this.config.get().session.stayAwake, claude, command: cmd !== null && since !== null ? { cmd, since } : null };
  }

  /** Tells `StayAwake` what works now, and keeps a look on a running command (it counts once it has run half a minute, with no event to say so). */
  private refreshStayAwake(): void {
    if (this.stopping) return;
    try {
      const work = this.stayAwakeWork();
      this.stayAwake.update(work);
      const ticking = work.enabled && work.command !== null;
      if (ticking && !this.commandTicker) {
        this.commandTicker = setInterval(() => this.refreshStayAwake(), STAY_AWAKE_TICK_MS);
        this.commandTicker.unref?.();
      } else if (!ticking && this.commandTicker) {
        clearInterval(this.commandTicker);
        this.commandTicker = null;
      }
    } catch (e) {
      this.log(`stay awake: ${errMsg(e)}`);
    }
  }

  private stopStayAwake(): void {
    if (this.commandTicker) clearInterval(this.commandTicker);
    this.commandTicker = null;
    this.stayAwake.stop();
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
      // Hooks are async: the Stop of the last answer may still be on its way (`claude -p` ends at once), so where it began is kept a
      // moment longer. Then it goes, unless the session came back meanwhile (a resume: the watcher has it alive again).
      this.later(STOP_AFTER_END_GRACE_MS, () => {
        if ((this.claudeWatcher.sessions().find((s) => s.id === id)?.state ?? 'ended') === 'ended') this.turnStart.delete(id);
      });
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
          if (this.turnStart.has(id)) this.turnStart.set(id, end); // (a session forgotten since, after its end, is not brought back)
          this.claudeWatcher.setCost(id, turn);
        } else if (retry) this.later(1500, () => read(false));
      };
      this.later(300, () => read(true));
    }
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
      return { ok: true };
    });
    r.handle('claude.state', () => ({ sessions: this.claudeWatcher.view() }));

    // ---- config
    r.handle('config.get', () => this.config.get());
    r.handle('config.patch', (p: DeepPartial<JafferConfig>) => this.config.patch(p ?? {}));

    // ---- integrations
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
    // Connects Claude Code: its hooks, so the companion, the notification and the cost figure follow it (the first run, and Settings).
    r.handle('setup.claude.install', async () => {
      const res = await setupClaude(this.cliWrapper, { home: this.userHome, env: this.userEnv() });
      this.config.patch({ claude: { skipped: false } });
      return res;
    });
    r.handle('setup.claude.remove', () => teardownClaude(this.userHome, this.userEnv()));

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

    // a client ends the session on purpose (`jaffer daemon stop`, `jaffer reset`, a newer Jaffer taking over): exit 0, and the app that
    // owns this daemon quits with it
    r.handle('app.shutdown', () => {
      this.onShutdown.fn(); // (the daemon's main claims the end now and begins the stop once this reply has gone out)
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
    env.JAFFER_NO_HOOKS = '1'; // a `claude` the daemon runs itself is not the terminal's: Jaffer's hooks report nothing for it
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

/** A command that was stopped, not ended (Ctrl+Z: the shell reports 128 + a stop signal, 145 to 150 on macOS and Linux). */
function stoppedExit(exit: number | null): boolean {
  return exit != null && exit >= 145 && exit <= 150;
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
