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
import { StayAwake, type Work } from '../core/session/stay-awake';
import { caffeinateHold, isDefaultHome } from '../core/session/caffeinate';
import { agentFiles, execLaunchctl, LaunchAgent, planAgent, REFUSED_OTHER_HOME, type AgentPlan, type PlanInput } from '../core/service/launch-agent';
import { KeepRunning } from './keep-running';
import { isTerminalReport } from '../shared/terminal-reports';
import { isClaudeCommand } from '../shared/process-badge';
import { COMMAND_HEAD, endsConversation, isPrintMode, isSessionId, type ResumeOffer } from '../shared/claude-resume';
import { ResumeStore } from '../core/claude/resume';
import { AutoResumer, shellChecks, type AutoResumeEvent, type AutoResumeTiming } from '../core/claude/auto-resume';
import { AUTO_RESUME, AUTO_RESUME_TEST, RESTART_HOLD_MS, RESTART_HOLD_TEST_MS } from '../shared/keep-running';
import { readTurnCost, transcriptSize } from '../core/claude/cost';
import { claudeAuth, ClaudeLogin } from '../core/integrations/claude-auth';
import { detectTargets } from '../core/memory/exports';
import { PROTOCOL, VERSION } from '../core/version';
import type { PtyEvent, PtySession } from '../core/session/terminal';

export interface ServiceOptions {
  paths?: JafferPaths;
  version?: string;
  /** Absolute path of the CLI bundle the ~/.jaffer/bin/jaffer wrapper should run. */
  cliScript?: string;
  /** Where "~" is for exports/ingest (tests). */
  userHome?: string;
  log?: (msg: string) => void;
  /** launchd runs this daemon (the login agent's wrapper says so with JAFFER_LAUNCHD=1). */
  launchd?: boolean;
  /** The daemon's own script, which the login agent's wrapper runs (default: the script this process was started with). */
  daemonScript?: string;
}

/** Backpressure: if a client falls this far behind we stop streaming and resync from a snapshot. */
const MAX_BACKLOG = 8 * 1024 * 1024;

/** While a command runs, the daemon looks at it this often, so that it holds the Mac awake soon after half a minute. */
const STAY_AWAKE_TICK_MS = 5000;

/** A Claude killed with its shell may say SessionEnd (an async hook) a moment after the shell's exit was seen: that is not the person quitting. */
const SHELL_EXIT_GRACE_MS = 5000;

/** How often, and how many times, a prompt whose shell does not have the terminal yet is looked at again (see `settleAfterPrompt`). */
const FOREGROUND_SETTLE_MS = 200;
const FOREGROUND_SETTLE_TRIES = 10;

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
  /** When the main shell last exited (0: never in this daemon's life); a SessionEnd right after it is the dying Claude's. */
  private lastShellExitAt = 0;
  /** Types `claude --resume <id>` for a Restart Claude Code the person asked for, after its notice (cancellable). Nothing is resumed by itself. */
  private autoResume: AutoResumer;
  /** When the person last typed (the quiet moment Restart Claude Code waits for before it types). */
  private lastInputAt = 0;
  /**
   * Keystrokes written to the main shell so far (the person's, and what Restart Claude Code typed): counted, so that two in the same millisecond
   * still differ. `lineEmptyAt` is that count when the shell's line was last known to be empty: it was just spawned, or a command began
   * (the keys before that were the command itself). Any keystroke after it sits in the shell's line, as bash and zsh keep what was typed
   * during startup or while a command ran and show it at the next prompt: nothing is ever added to such a line.
   */
  private inputSeq = 0;
  private lineEmptyAt = 0;
  /** The notice that is running, if one is: a window that connects after it was announced is told when it asks. */
  private autoNotice: Extract<AutoResumeEvent, { state: 'pending' }> | null = null;
  /**
   * A Restart Claude Code the person asked for, waiting for the new shell's prompt. `id`: the conversation it was asked for (no other
   * is resumed for it). `from`: the shell it was asked in, whose own prompts and death are not the new shell's. `armed`: the new shell's
   * prompt has made the request (so what the notice then says is about it).
   */
  private restartHold: { id: string; from: PtySession | undefined; armed: boolean; timer: NodeJS.Timeout } | null = null;
  /** A prompt whose shell did not have the terminal yet, looked at again (see `settleAfterPrompt`). */
  private foregroundTimer: NodeJS.Timeout | null = null;
  /** Keeps the Mac from idle sleep while Claude or a long command works (see `refreshStayAwake`). */
  private stayAwake: StayAwake;
  /** Looks at a running command every few seconds, so that it counts once it has run half a minute; only while one runs. */
  private commandTicker: NodeJS.Timeout | null = null;
  /** The switch "Keep my session running in the background": the login agent (launchd) that owns this daemon. */
  private keepRunning: KeepRunning;
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
    this.autoResume = new AutoResumer(
      {
        now: () => Date.now(),
        offer: () => this.resumeOffer(),
        // `promptReady`: at its prompt with an empty line (what we type must never be added to a line the person, or this, has started),
        // and the shell itself has the terminal (the marks are output any program can print: a remote shell over ssh). `mayType`: asked
        // again at the moment of typing, of the system itself, never an answer of a moment ago.
        ...shellChecks(
          () => this.host?.mainPane,
          () => this.inputSeq === this.lineEmptyAt,
        ),
        busy: () => {
          const pane = this.host?.mainPane;
          return !!pane && pane.runningCommand !== null; // (a command the marks gave no line for runs all the same)
        },
        lastInputAt: () => this.lastInputAt,
        // (nothing is resumed by itself: only a request the person made, Restart Claude Code's (`restartPrompt`), starts anything. An old
        // config's `session.autoResume` is kept in the file and read by nothing.)
        stopping: () => this.stopping,
        // straight to the shell: this is not the person typing (no `lastInputAt`) and not an answer to Claude (no `userAnswered`); until
        // the shell runs it, its line is not empty
        type: (text) => {
          try {
            this.inputSeq++;
            this.host?.mainPane?.write(text);
          } catch (e) {
            this.log(`auto-resume: could not type: ${errMsg(e)}`);
          }
        },
        emit: (e) => {
          this.autoNotice = e.state === 'pending' ? e : null; // typed or cancelled: no notice runs any more
          if (e.state !== 'pending' && this.restartHold?.armed) this.releaseRestartHold(); // the request has had its answer
          this.rpc.broadcast('claude.autoresume', e);
        },
        setTimer: (fn, ms) => {
          const t = setTimeout(fn, ms);
          t.unref?.();
          return t;
        },
        clearTimer: (t) => clearTimeout(t as NodeJS.Timeout),
      },
      autoResumeTiming(),
    );
    this.keepRunning = new KeepRunning({
      agent: new LaunchAgent({ launchctl: execLaunchctl(), uid: process.getuid?.() ?? -1, fs }),
      plan: () => this.agentPlan(),
      files: () => {
        const i = this.agentInput();
        return i && isDefaultHome(this.paths.home) ? agentFiles(i) : null;
      },
      launchd: opts.launchd === true,
      keepRunning: () => this.config.get().session.keepRunning,
      setKeepRunning: (on) => {
        if (this.config.get().session.keepRunning !== on) this.config.patch({ session: { keepRunning: on } });
      },
      later: (fn, ms) => void setTimeout(() => void fn(), ms), // (not unref'd: it must run)
      log: this.log,
    });
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
    // after a restart the conversation that was running is offered back (the Resume button): nothing is typed by itself
    this.log(`jafferd ${this.version} listening on ${this.paths.socket}`);
    // The login agent agrees with the switch (files refreshed after an update or a move; taken away when it is off). Only now that the
    // socket listens: launchd's instance must find this daemon there, and taking the agent away from a daemon launchd runs ends it.
    void this.keepRunning
      .reconcileAtStart()
      .then((s) => s.state !== 'not-installed' && s.state !== 'refused' && this.log(`keep running: ${s.state}`))
      .catch((e) => this.log(`keep running: ${errMsg(e)}`));
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.stopStayAwake(); // first: nothing below may keep the Mac awake
    this.releaseRestartHold();
    if (this.foregroundTimer) clearTimeout(this.foregroundTimer);
    this.foregroundTimer = null;
    this.autoResume.endNotice(); // nothing is typed while stopping: a notice that is running ends now, and the window is told
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

  // ------------------------------------------------------------------ keep running (the login agent)

  /**
   * What the login agent would be made of. Its `defaultHome` is the real `~/.jaffer` of the user running this (not `os.homedir()`, which a
   * `HOME` set to a temporary folder moves), so any other home is refused; null when the user cannot be told.
   */
  private agentInput(): PlanInput | null {
    try {
      return {
        home: this.paths.home,
        defaultHome: path.join(os.userInfo().homedir, '.jaffer'),
        userHome: this.userHome,
        uid: process.getuid!(),
        platform: process.platform,
        execPath: process.execPath,
        daemonScript: this.opts.daemonScript ?? process.argv[1] ?? '',
        electron: !!process.versions.electron,
      };
    } catch {
      return null;
    }
  }

  /** The agent for this daemon, or why there can be none. Both the plan and `isDefaultHome` must say this is the person's own home. */
  private agentPlan(): AgentPlan | { refused: string } {
    const i = this.agentInput();
    if (!i) return { refused: REFUSED_OTHER_HOME };
    const plan = planAgent(i);
    if ('refused' in plan) return plan;
    return isDefaultHome(this.paths.home) ? plan : { refused: REFUSED_OTHER_HOME };
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
        if (e.lifecycle === 'spawned') this.lineEmptyAt = this.inputSeq; // a new shell: its line is empty, whatever was typed before it
        this.rpc.broadcast('session.lifecycle', e, this.attached);
        this.refreshStayAwake(); // (a new shell runs nothing)
        return;
      }
      this.sendPty(e.pane, e.event);
      if (e.event.type === 'start') this.lineEmptyAt = this.inputSeq; // a command began: the keys so far were the command itself
      // a command began or ended, or the shell is gone: a long one holds the Mac awake, and none holds nothing
      if (e.event.type === 'start' || e.event.type === 'command' || e.event.type === 'exit') this.refreshStayAwake();
      // A command line comes from the shell's marks, which any output in the terminal can forge, at any length: only its start is
      // read to tell what it was (memory gets it whole, through its own redaction)
      const head = e.event.type === 'command' ? e.event.cmd.slice(0, COMMAND_HEAD) : '';
      // where the shell is, and whether it is busy, decide whether a conversation can be offered back
      if (e.event.type === 'cwd' || e.event.type === 'start' || e.event.type === 'command') this.pushResume();
      // The shell is gone and took its Claude with it: no conversation is running any more. The resume point stays (a dying shell is
      // not the person ending the conversation), and a daemon that is stopping leaves everything as it is.
      if (e.event.type === 'exit' && !this.stopping) {
        this.lastShellExitAt = Date.now();
        // a notice that is running (Restart Claude Code's) was for the shell that is gone: it ends here, and only a request the person
        // made goes ahead in the new shell (nothing is resumed by itself)
        this.autoResume.endNotice();
        this.claudeWatcher.endAll();
        this.pushResume();
      }
      // at its prompt again (a new shell, a command finished): the moment a Restart Claude Code the person asked for goes ahead (and
      // nothing else: see `restartPrompt`). What can be offered also depends on the shell having the terminal, which no mark tells (see
      // `resumeOffer`): the window is told here too.
      if (e.event.type === 'prompt') {
        this.restartPrompt();
        this.pushResume();
        this.settleAfterPrompt();
      }
      if (e.event.type === 'command') {
        const ev = e.event;
        // The `claude` in the terminal finished (or crashed): whatever its hooks last said is over. Not when it was only
        // stopped (Ctrl+Z reports 128 + a stop signal): it comes back with `fg`.
        if (!stoppedExit(ev.exit) && isClaudeCommand(head)) {
          this.claudeWatcher.endAll();
          // quit on purpose (exit 0, or Ctrl+C): nothing to offer afterwards. A crash or a kill leaves the offer, and a daemon that is
          // stopping must not take it away (the shell dying with it is not the person ending the conversation). `claude -p` answered
          // once and is gone, however it ended: a failing one must not leave an offer that starts an interactive Claude by itself.
          const quit = (ev.exit === 0 || ev.exit === 130) && endsConversation(head);
          if (!this.stopping && (quit || isPrintMode(head))) this.resume.forget();
          this.pushResume();
        }
        const proj = resolveProject(ev.cwd, this.userHome);
        if (ev.cmd.trim()) this.memory.observeCommand({ cmd: ev.cmd, exit: ev.exit, cwd: ev.cwd, project: proj.root, branch: proj.branch, durMs: ev.durMs, out: ev.output });
      }
    });
    this.claudeWatcher.changes.on((sessions) => {
      this.refreshStayAwake();
      this.pushClaudeState();
      this.watchForRejections(sessions);
      this.pushResume();
    });
    this.memory.events.on((e) => this.rpc.broadcast('memory.event', e));
    this.config.onChange.on((c) => {
      this.rpc.broadcast('config.changed', c);
      if (!c.session.resumeClaude) this.resume.forget(); // off forgets it, as Settings says: nothing of the conversation stays on disk
      this.pushResume(); // (and a notice that is running ends with the offer)
      this.refreshStayAwake(); // (the switch for staying awake)
      this.memory.syncExports();
      this.startIngest();
      // Keep my session running: the agent follows the switch however it changed (Settings, `jaffer service`, `jaffer config set`), with
      // every guard of install and remove (a refused home is not touched; in the daemon launchd runs, the bootout comes after the reply).
      // What install and remove set themselves is already in line (null).
      const on = c.session.keepRunning;
      void this.keepRunning
        .switchChanged(on)
        .then((s) => s && this.log(`keep running: switched ${on ? 'on' : 'off'}: ${s.state === 'refused' ? `refused (${s.reason})` : s.state}`))
        .catch((e) => this.log(`keep running: ${errMsg(e)}`));
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
    if (o.hook_event_name === 'SessionEnd') {
      // a Claude that died with its shell did not end the conversation on purpose: its resume point stays. Nor did one whose reason is
      // `other`: Claude Code was stopped from outside (a logout or a shutdown that reached it before this daemon), and it should be
      // offered again after the reboot. `prompt_input_exit` (/exit, Ctrl+D), `clear`, `logout` and a SessionEnd with no reason (an older Claude) forget it.
      const fromOutside = o.reason === 'other';
      if (!fromOutside && Date.now() - this.lastShellExitAt > SHELL_EXIT_GRACE_MS) this.resume.forget(id);
    } else if (this.config.get().session.resumeClaude && !this.printRunning()) {
      this.resume.note({ id, cwd: typeof o.cwd === 'string' ? o.cwd : undefined, transcriptPath: typeof o.transcript_path === 'string' ? o.transcript_path : undefined, starts: o.hook_event_name === 'SessionStart' });
    }
    this.pushResume();
  }

  /**
   * A `claude -p` runs in the shell. Its hooks fire like any Claude's, but it answers once and is gone, never a conversation to resume
   * (one that ends is forgotten, R11): what they say is not kept, so a shell or a daemon that goes while it runs leaves nothing that
   * would start an interactive Claude by itself afterwards. (Only the start of the command line is read: see `COMMAND_HEAD`.)
   */
  private printRunning(): boolean {
    const head = this.host?.mainPane?.runningCommand?.slice(0, COMMAND_HEAD) ?? '';
    return head !== '' && isClaudeCommand(head) && isPrintMode(head);
  }

  /**
   * The conversation that can be resumed now (the Resume button, and what Restart Claude Code types): the saved one, with nothing running in the
   * shell. "Nothing running" is what the marks say and what the terminal's foreground says: a program (ssh into a server whose shell
   * prints marks of its own) can make the marks say "a prompt, nothing running". A shell that is gone is not asked (a new one comes).
   * Whatever the shell is called (`/bin/sh` runs bash): its pid leading the terminal's foreground is the test. (A decision: the answer
   * of up to 250 ms ago will do, unless the terminal printed something since. `fresh` asks the system again: a click about to type.)
   */
  private resumeOffer(opts: { fresh?: boolean } = {}): ResumeOffer | null {
    const offer = this.savedOffer();
    const pane = this.host?.mainPane;
    return offer && pane?.alive && !pane.foregroundIsShell({ fresh: opts.fresh === true }) ? null : offer;
  }

  /** The same, by the marks alone. */
  private savedOffer(): ResumeOffer | null {
    const pane = this.host?.mainPane;
    return this.resume.offer({
      shellCwd: pane?.cwd,
      active: this.claudeWatcher.sessions().some((s) => s.state !== 'ended'),
      busy: !!pane && pane.runningCommand !== null,
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
    // Restart Claude Code's notice, if one runs: an offer that went or is another conversation now (a command began, "Not now", the
    // offer switched off) ends it. The same conversation seen again (a later time) leaves it running. Nothing else is asked: an offer
    // that comes is the Resume button, never typed by itself.
    if (this.autoNotice && offer?.id !== this.autoNotice.id) this.autoResume.endNotice();
  }

  /**
   * The person typed. That holds Restart Claude Code's typing off for a quiet moment, and the key may now sit in the shell's line (see
   * `inputSeq`), unless a running interactive `claude` takes it: its own prompt reads what is typed into it. `claude update`,
   * `claude --version`, `claude mcp ...` and `claude -p` read nothing from the terminal: what is typed while they run waits in the
   * shell's line like behind any other command.
   */
  private noteKeystroke(): void {
    this.lastInputAt = Date.now();
    const head = this.host?.mainPane?.runningCommand?.slice(0, COMMAND_HEAD) ?? '';
    if (head && isClaudeCommand(head) && endsConversation(head) && !isPrintMode(head)) return;
    this.inputSeq++;
  }

  /**
   * A prompt of the main shell: the resumer is asked only for a Restart Claude Code the person asked for (`restartCheck`). Nothing
   * else ever makes it type: a prompt with a conversation to offer shows the Resume button, and a click on it is the person typing.
   */
  private restartPrompt(): void {
    if (this.restartCheck().explicit) this.autoResume.check({ explicit: true });
  }

  /**
   * What Restart Claude Code left to do: the person asked, so the first prompt of the new shell is the conversation's cue. The request
   * is repeated at each prompt of that shell until it is typed or cancelled (or it is stale): the resumer itself forgets the request
   * the first time it has to wait for a prompt. A prompt of the shell it was asked in is not the cue.
   */
  private restartCheck(): { explicit?: boolean } {
    const hold = this.restartHold;
    const pane = this.host?.mainPane;
    if (!hold || !pane || pane === hold.from) return {};
    // the conversation it was asked for, and no other: with that one gone, or another offered since, there is nothing the person asked for
    if (this.savedOffer()?.id !== hold.id) {
      this.releaseRestartHold();
      return {};
    }
    // a prompt a program printed (ssh, typed ahead into the new shell) is not the new shell's: the request waits for the shell's own
    if (!pane.foregroundIsShell()) return {};
    hold.armed = true;
    return { explicit: true };
  }

  /**
   * The prompt mark comes a moment before the shell has finished its prompt: bash runs the person's own PROMPT_COMMAND after it, which may
   * run a program in the foreground for a moment. While there is something to resume and the marks say "a prompt" but the shell does not
   * have the terminal (yet), it is looked at again a few times, and the prompt's checks are made once it has. (A program that prints
   * marks of its own keeps it looking for about two seconds, nothing more.)
   */
  private settleAfterPrompt(tries = FOREGROUND_SETTLE_TRIES): void {
    if (this.foregroundTimer) clearTimeout(this.foregroundTimer);
    this.foregroundTimer = null;
    const pane = this.host?.mainPane;
    if (this.stopping || tries <= 0 || !pane?.alive || !pane.promptReady) return;
    if ((!this.restartHold && !this.savedOffer()) || pane.foregroundIsShell()) return;
    this.foregroundTimer = setTimeout(() => {
      this.foregroundTimer = null;
      if (this.stopping || this.host?.mainPane !== pane || !pane.alive || !pane.promptReady) return;
      // looking again is the point: the system is asked, not the answer of the last look (200 ms ago, within the 250 ms it is kept)
      if (!pane.foregroundIsShell({ fresh: true })) return this.settleAfterPrompt(tries - 1);
      this.restartPrompt();
      this.pushResume();
    }, FOREGROUND_SETTLE_MS);
    this.foregroundTimer.unref?.();
  }

  /** The request is over (answered, stale, replaced or the daemon is stopping): no later prompt makes it again. */
  private releaseRestartHold(): void {
    if (!this.restartHold) return;
    clearTimeout(this.restartHold.timer);
    this.restartHold = null;
  }

  /** Waits for the next shell's prompt on behalf of a Restart Claude Code. A request before it is replaced by this one. */
  private holdRestart(id: string, from: PtySession | undefined): void {
    this.releaseRestartHold();
    const timer = setTimeout(() => {
      if (this.restartHold?.timer === timer) this.restartHold = null; // (a notice that already began finishes on its own)
    }, restartHoldMs());
    timer.unref?.();
    this.restartHold = { id, from, armed: false, timer };
  }

  /**
   * What a Restart Claude Code would do now: would a conversation come back in the new shell (the one that would be offered once
   * nothing runs: an open Claude that has a saved point counts, and nothing does when the offer is off), and is Claude working or
   * waiting for the person. Read before the shell is restarted: its exit ends the watcher's sessions. A shell that prints none of
   * Jaffer's marks (any shell besides zsh, bash and fish) never says that the new shell's prompt is there, which is when the conversation
   * is typed: nothing would come back by itself, so it is a plain shell restart, said so, and the Resume button offers the conversation.
   */
  private restartPlan(): { resumable: boolean; busy: boolean; id?: string } {
    const pane = this.host.mainPane;
    const marks = pane?.shellKind !== 'other';
    const offer = marks ? this.resume.offer({ shellCwd: pane?.cwd, active: false, busy: false, enabled: this.config.get().session.resumeClaude }) : null;
    const busy = this.claudeWatcher.sessions().some((s) => s.state === 'working' || s.state === 'needs-you');
    return { resumable: offer !== null, busy, ...(offer ? { id: offer.id } : {}) };
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
      // typing while Claude waits for them means they are answering; the terminal's own replies and focus reports do not. Typing also
      // holds off Restart Claude Code's typing for a moment (see `noteKeystroke`).
      if (!isTerminalReport(String(p.data))) {
        this.claudeWatcher.userAnswered();
        this.noteKeystroke();
      }
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
    // Restart Claude Code (to use an update): `plan` is what the window's question is about; `claude.restart` restarts the shell, in the
    // same folder, and the new shell's first prompt takes the same conversation up (see `restartCheck`). With no conversation it is a
    // plain shell restart.
    r.handle('claude.restart.plan', () => {
      const { resumable, busy } = this.restartPlan();
      return { resumable, busy };
    });
    r.handle('claude.restart', async () => {
      const { resumable, id } = this.restartPlan(); // before the shell goes: its exit ends the watcher's sessions
      if (id !== undefined) this.holdRestart(id, this.host.mainPane);
      else this.releaseRestartHold();
      await this.host.restartMain();
      return { resumable };
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
    r.handle('claude.resume', (p?: { fresh?: boolean }) => {
      // What a window has just been told is what the next change is measured against. A click on the Resume button asks with `fresh`
      // and types only if this answer is the conversation it showed (`resumeClaude`): in a shell that prints no marks nothing pushes the
      // offer again when a program starts, so the button can be from before it. The foreground is then read now, not reused.
      const offer = this.resumeOffer({ fresh: p?.fresh === true });
      this.lastOffer = JSON.stringify(offer);
      return offer;
    });
    r.handle('claude.resume.dismiss', () => {
      this.resume.forget();
      this.pushResume();
      return true;
    });
    // the window's Cancel on the "Resuming Claude" notice: nothing is typed, and the Resume button is left
    r.handle('claude.autoresume.cancel', () => {
      this.autoResume.cancel();
      return true;
    });
    // the notice that is running ({ state: 'pending', id, typesAt }) or null: for a window that connected after it was announced
    r.handle('claude.autoresume.state', () => this.autoNotice);

    // ---- keep running in the background (the login agent; refused, and nothing touched, in any home but the person's own ~/.jaffer)
    r.handle('service.status', () => this.keepRunning.status());
    r.handle('service.install', () => this.keepRunning.install());
    r.handle('service.remove', () => this.keepRunning.remove());

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

    // `forgetConversation`: the person ends the session (Quit and End Session), so the Claude Code conversation is not resumed at
    // the next start. An update, Restart session or `jaffer daemon stop` shut down plainly: the conversation comes back (Reset removes the file it is in).
    r.handle('app.shutdown', (p: { forgetConversation?: boolean } | undefined) => {
      if (p?.forgetConversation === true) {
        this.resume.forget();
        this.pushResume(); // (and a notice that is running ends with it)
      }
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

/** A command that was stopped, not ended (Ctrl+Z: the shell reports 128 + a stop signal, 145 to 150 on macOS and Linux). */
function stoppedExit(exit: number | null): boolean {
  return exit != null && exit >= 145 && exit <= 150;
}

/** The notice and the quiet moment of Restart Claude Code: the real ones, or (tests only, `JAFFER_TEST_AUTORESUME_FAST=1`) the same in milliseconds. */
function autoResumeTiming(): AutoResumeTiming {
  return process.env.JAFFER_TEST_AUTORESUME_FAST === '1' ? AUTO_RESUME_TEST : AUTO_RESUME;
}

/** How long a Restart Claude Code waits for the new shell's prompt: 30 s, or (tests only) a few seconds. */
function restartHoldMs(): number {
  return process.env.JAFFER_TEST_AUTORESUME_FAST === '1' ? RESTART_HOLD_TEST_MS : RESTART_HOLD_MS;
}

/** Housekeeping cadence. Overridable so tests can watch memory evolve in seconds instead of minutes. */
function tickMs(): number {
  const v = Number(process.env.JAFFER_TICK_MS);
  return Number.isFinite(v) && v >= 100 ? v : 30_000;
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
