import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore, type DeepPartial, type JafferConfig } from '../shared/config';
import { makePaths, type JafferPaths } from '../shared/paths';
import { ensureDir, errMsg, nowIso, writeFileAtomic } from '../shared/util';
import { RpcError, RpcServer, type ServerConn } from '../core/rpc';
import { SessionHost } from '../core/session/host';
import { resolveProject } from '../core/session/project';
import { claudeStatus, findClaude, HOOK_EVENTS, hooksPointAt, installHooks, setupClaude, teardownClaude } from '../core/integrations/claude';
import { ClaudeWatcher } from '../core/claude/watcher';
import { approvalDetail, approvalTool, APPROVAL_WAIT_MS, type ApprovalView } from '../core/claude/approvals';
import { transcriptActive, watchInterruption } from '../core/claude/transcript-watch';
import { pickCommand, StayAwake, type Work } from '../core/session/stay-awake';
import { STAY_AWAKE } from '../shared/stay-awake-config';
import { caffeinateHold } from '../core/session/caffeinate';
import { isTerminalReport } from '../shared/terminal-reports';
import { isClaudeCommand } from '../shared/process-badge';
import { readTurn, STOP_AFTER_END_GRACE_MS, transcriptSize } from '../core/claude/cost';
import { conversationStorage, listConversations, OLD_DAYS, oldConversations } from '../core/claude/history';
import { searchConversations, searchQuery } from '../core/claude/search';
import { recentUsage } from '../core/claude/usage-window';
import { readSetup } from '../core/claude/setup';
import { runMcpList, type McpCheck } from '../core/claude/mcp';
import { buildExplainPrompt, explainSupported, lastReply, runExplain, type ExplainResult } from '../core/claude/explain';
import { contextWindow, dayTotal, type DayTotal } from '../shared/claude-cost';
import { rollWeek } from '../shared/usage-week';
import { nextTypicalTurnMs } from '../shared/turn-median';
import { readGitStatus, type GitStatus } from '../core/session/git-status';
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

/** While Claude works, what its answer has cost so far is read this often. */
const LIVE_COST_MS = 2000;

/** At most this many permission prompts wait for a click at once; one more gets no answer (Claude Code's own prompt). */
const MAX_APPROVALS = 5;

/** The shell can draw its prompt more than once in a row: the repository is looked at once it settles. */
const GIT_DEBOUNCE_MS = 300;

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
  /** When each of Jaffer's hook events was last heard (Settings shows whether the hooks work). In memory, since this daemon started. */
  private hookSeen = new Map<string, number>();
  private rejectionWatches = new Map<string, () => void>();
  /** Where each session's transcript stood when its current prompt was sent: the answer is what was written after. */
  private turnStart = new Map<string, number>();
  private costTimers = new Set<NodeJS.Timeout>();
  /** Where the answer whose cost was counted last began, per session: a Stop heard twice is still one answer. */
  private counted = new Map<string, number>();
  /** What the answers finished today cost and how long they took, in memory only: it starts again at local midnight and when the app quits. */
  private today: DayTotal = dayTotal(undefined, Date.now());
  /** Reads the answers being written every 2 s while a session works; the transcript's size at the last read, so an unchanged one is not read again. */
  private liveTimer: NodeJS.Timeout | null = null;
  private liveSize = new Map<string, number>();
  /** The lengths of the last turns Claude finished (at most 15): their median is `claude.typicalTurnMs`. */
  private recentTurns: number[] = [];
  /** Per terminal: the repository of its shell's folder as `git status` saw it at its last prompt (for the folder pill). */
  private git = new Map<string, { timer: NodeJS.Timeout | null; seq: number; value?: { root: string; status: GitStatus } }>();
  /** Permission prompts waiting for a click on Allow or Deny (`claude.approvals`), in memory only: what is shown of each, never its input. */
  private approvals = new Map<string, { view: ApprovalView; done: (decision: 'allow' | 'deny' | null) => void }>();
  private claudePushTimer: NodeJS.Timeout | null = null;
  /** (1.4.0) The one `claude mcp list` under way (a second ask while it runs gets the same answer). */
  private mcpCheck: Promise<McpCheck> | null = null;
  /** (1.4.0) The one Explain under way, when each session's last one ended (5 s between two), and whether this `claude` can run the helper. */
  private explaining: Promise<ExplainResult> | null = null;
  private explainedAt = new Map<string, number>();
  private explainOk: { bin: string | null; ok: boolean } | null = null;
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
  /** How long a command must run before it holds the Mac awake: 30 s (`JAFFER_TEST_STAY_AWAKE_AFTER_MS`, a test hook inert unless set, can only shorten it). */
  private commandAfterMs = Math.min(STAY_AWAKE.commandAfterMs, Number(process.env.JAFFER_TEST_STAY_AWAKE_AFTER_MS) || STAY_AWAKE.commandAfterMs);

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
      commandAfterMs: this.commandAfterMs,
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
      // (and the approvals hook while that setting is on)
      if (hooksPointAt(this.cliWrapper, this.userHome)) installHooks(this.cliWrapper, this.userHome, { approvals: this.config.get().claude.approvals });
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
    this.timers.push(
      setInterval(() => {
        this.claudeWatcher.sweep((s) => transcriptActive(s.transcriptPath, s.tool ? 30 * 60_000 : 5 * 60_000));
        // past midnight today's total starts again, and the window hears it also when nothing else happens
        const today = dayTotal(this.today, Date.now());
        if (today.date !== this.today.date) {
          this.today = today;
          this.pushClaudeState();
        }
      }, 30_000),
    );
    this.timers[this.timers.length - 1]!.unref?.();
    this.log(`jafferd ${this.version} listening on ${this.paths.socket}`);
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.stopStayAwake(); // first: nothing below may keep the Mac awake
    this.endApprovals();
    for (const t of this.timers) clearInterval(t);
    for (const stop of this.rejectionWatches.values()) stop();
    this.rejectionWatches.clear();
    for (const t of this.costTimers) clearTimeout(t);
    this.costTimers.clear();
    if (this.liveTimer) clearInterval(this.liveTimer);
    for (const g of this.git.values()) if (g.timer) clearTimeout(g.timer);
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

  private terminalInfo(id = this.host.firstId) {
    const pane = this.host.get(id);
    const cwd = pane?.cwd ?? this.userHome;
    const proj = resolveProject(cwd, this.userHome);
    const seen = this.git.get(id)?.value;
    const git = proj.root && seen?.root === proj.root ? seen.status : undefined;
    return { cwd, project: proj.root, branch: proj.branch, git, busy: pane?.runningCommand ?? null, busySince: pane?.runningSince ?? null };
  }

  /**
   * The shell is back at its prompt: what changed in its folder's repository since (staged, changed, untracked, ahead, behind), for the
   * folder pill. `session.info` carries it; outside a repository, or when git is missing or slow, there is none.
   */
  private refreshGit(pane: string): void {
    const g = this.git.get(pane) ?? { timer: null, seq: 0 };
    this.git.set(pane, g);
    if (g.timer) clearTimeout(g.timer);
    g.timer = setTimeout(() => {
      g.timer = null;
      const seq = ++g.seq;
      const root = resolveProject(this.host.get(pane)?.cwd ?? this.userHome, this.userHome).root;
      if (!root) return void (g.value = undefined);
      void readGitStatus(root).then((status) => {
        if (seq === g.seq) g.value = status && { root, status }; // (an answer overtaken by a newer prompt's is dropped)
      });
    }, GIT_DEBOUNCE_MS);
    g.timer.unref?.();
  }

  // ------------------------------------------------------------------ events

  /** Per connection: the terminals it shows (`session.attach`), and those it fell too far behind on (`stale`: resynced once it drains). */
  private panesOf = (c: ServerConn, key: 'attached' | 'stale'): Set<string> => (c.meta[key] ??= new Set<string>()) as Set<string>;
  private attachedTo = (pane: string) => (c: ServerConn) => this.panesOf(c, 'attached').has(pane);
  private attachedAny = (c: ServerConn) => this.panesOf(c, 'attached').size > 0;

  private sendPty(pane: string, event: PtyEvent): void {
    const base = { pane };
    if (event.type === 'data') {
      for (const c of this.rpc.conns) {
        const stale = this.panesOf(c, 'stale');
        if (!this.panesOf(c, 'attached').has(pane) || stale.has(pane)) continue;
        if (c.backlog > MAX_BACKLOG) {
          // Too far behind: stop feeding it this terminal, resync it from a snapshot once its socket drains.
          stale.add(pane);
          c.socket.once('drain', () => void this.resync(c, pane));
          continue;
        }
        c.send({ event: 'pty.data', data: { ...base, data: event.data, seq: event.seq } });
      }
      return;
    }
    const name = `pty.${event.type}`;
    this.rpc.broadcast(name, { ...base, ...event }, this.attachedTo(pane));
  }

  private async resync(c: ServerConn, pane: string): Promise<void> {
    const p = this.host.get(pane);
    if (!p || !c.alive) return;
    const snapshot = await p.consistentSnapshot();
    if (!this.attachedTo(pane)(c)) return; // (it let go of that terminal meanwhile: no snapshot it did not ask for)
    this.panesOf(c, 'stale').delete(pane);
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
      if (this.attachedTo(pane)(c) && !this.panesOf(c, 'stale').has(pane) && c.alive) c.send({ event: 'pty.reset', data: { pane, snapshot } });
    }
  }

  private wireEvents(): void {
    this.host.events.on((e) => {
      if ('lifecycle' in e) {
        // (to every window that shows a terminal: a new one is there to attach to, a closed one to take away)
        this.rpc.broadcast('session.lifecycle', e, this.attachedAny);
        if (e.lifecycle === 'restarted') void this.resyncAttached(e.pane);
        if (e.lifecycle === 'closed') this.forgetPane(e.pane);
        this.refreshStayAwake(); // (a new shell runs nothing, a closed one nothing any more)
        return;
      }
      this.sendPty(e.pane, e.event);
      // a command began or ended, or the shell is gone: a long one holds the Mac awake, and none holds nothing
      if (e.event.type === 'start' || e.event.type === 'command' || e.event.type === 'exit') this.refreshStayAwake();
      if (e.event.type === 'prompt') this.refreshGit(e.pane);
      // The shell is gone and took its Claude with it: that terminal's conversation is not running any more (another terminal's goes
      // on; a daemon that is stopping leaves it as it is).
      if (e.event.type === 'exit' && !this.stopping) this.claudeWatcher.endPane(e.pane);
      // The `claude` in that terminal finished (or crashed): whatever its hooks last said is over. Not when it was only stopped (Ctrl+Z
      // reports 128 + a stop signal): it comes back with `fg`. (The command line comes from the shell's marks, which any output can forge
      // at any length: `isClaudeCommand` reads only its start.)
      if (e.event.type === 'command' && !stoppedExit(e.event.exit) && isClaudeCommand(e.event.cmd)) this.claudeWatcher.endPane(e.pane);
    });
    this.claudeWatcher.changes.on((sessions) => {
      this.refreshStayAwake();
      this.pushClaudeState();
      this.watchForRejections(sessions);
      this.refreshLive();
    });
    // a turn Claude finished: how long a turn typically takes (the ring's progress), kept across starts
    this.claudeWatcher.finished.on((ms) => {
      const prev = this.config.get().claude.typicalTurnMs;
      const typical = nextTypicalTurnMs(prev, ms, this.recentTurns);
      if (typical !== prev) this.config.patch({ claude: { typicalTurnMs: typical } });
      this.today = dayTotal(this.today, Date.now(), 0, ms); // (before the Stop's own push: the window hears it with the state)
      this.addToWeek(0, ms);
    });
    let approvals = this.config.get().claude.approvals;
    this.config.onChange.on((c) => {
      this.rpc.broadcast('config.changed', c);
      if (c.claude.approvals !== approvals) {
        approvals = c.claude.approvals;
        if (!approvals) this.endApprovals(); // (Claude Code's own prompts again, at once)
        try {
          if (hooksPointAt(this.cliWrapper, this.userHome)) installHooks(this.cliWrapper, this.userHome, { approvals });
        } catch {
          /* the user's settings are theirs */
        }
      }
      this.refreshStayAwake(); // (the switch for staying awake)
      this.refreshLive(); // (the switches for the cost)
    });
  }

  /** A terminal the person closed: no window shows it any more (its id may come back with a new shell), its repository and its Claude are over. */
  private forgetPane(pane: string): void {
    for (const c of this.rpc.conns) {
      this.panesOf(c, 'attached').delete(pane);
      this.panesOf(c, 'stale').delete(pane);
    }
    const g = this.git.get(pane);
    if (g?.timer) clearTimeout(g.timer);
    this.git.delete(pane);
    if (!this.stopping) this.claudeWatcher.endPane(pane);
  }

  // ------------------------------------------------------------------ stay awake

  /**
   * What works now. Claude: a session is working, or a background agent runs (a Claude that waits for the person is not work, and an
   * ended session has nothing running). A command: of those running in the terminals whose shells are alive (a shell that died
   * mid-command never reported its end), the one that has run longest, a program a person sits in or one past the cap only when there is
   * no other (so neither hides a build in another terminal).
   */
  private stayAwakeWork(): Work {
    const claude = this.claudeWatcher.sessions().some((s) => s.state !== 'ended' && (s.state === 'working' || s.subagents.some((a) => a.status === 'running')));
    const running = (this.host?.list() ?? []).map((p) => ({ alive: p.alive, cmd: p.busy, since: this.host.get(p.id)?.runningSince ?? null }));
    return { enabled: this.config.get().session.stayAwake, claude, command: pickCommand(running, Date.now()) };
  }

  /** Tells `StayAwake` what works now, and keeps a look on a running command (it counts once it has run half a minute, with no event to say so). */
  private refreshStayAwake(): void {
    if (this.stopping) return;
    try {
      const work = this.stayAwakeWork();
      this.stayAwake.update(work);
      const ticking = work.enabled && work.command !== null;
      if (ticking && !this.commandTicker) {
        this.commandTicker = setInterval(() => this.refreshStayAwake(), Math.min(STAY_AWAKE_TICK_MS, this.commandAfterMs));
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
    this.rpc.broadcast('claude.state', this.claudeState());
    this.claudePushTimer = setTimeout(() => {
      this.claudePushTimer = null;
      if (this.claudePushPending) {
        this.claudePushPending = false;
        this.pushClaudeState();
      }
    }, 100);
    this.claudePushTimer.unref?.();
  }

  /** What the window may know about the terminal's Claude: its sessions, and what the answers finished today cost. */
  private claudeState() {
    return { sessions: this.claudeWatcher.view(), today: dayTotal(this.today, Date.now()) };
  }

  /**
   * While a session works, and the cost figure with its live part is on: what the answer has cost so far, read every 2 s from where its
   * prompt began (the same bounded read as at Stop). Not while Claude waits for the person: the last figure stays until it works again.
   */
  private refreshLive(): void {
    const c = this.config.get().claude;
    const on = !this.stopping && c.showCost && c.liveCost && this.claudeWatcher.sessions().some((s) => s.state === 'working');
    if (on && !this.liveTimer) {
      this.liveTimer = setInterval(() => this.readLive(), LIVE_COST_MS);
      this.liveTimer.unref?.();
    } else if (!on && this.liveTimer) {
      clearInterval(this.liveTimer);
      this.liveTimer = null;
      this.liveSize.clear();
    }
  }

  private readLive(): void {
    for (const s of this.claudeWatcher.sessions()) {
      const start = this.turnStart.get(s.id);
      if (s.state !== 'working' || start === undefined || !s.transcriptPath) continue;
      const size = transcriptSize(s.transcriptPath);
      if (size === this.liveSize.get(s.id)) continue; // nothing new was written
      this.liveSize.set(s.id, size);
      const { cost: turn, context } = readTurn(s.transcriptPath, start, size);
      if (turn) this.claudeWatcher.setLive(s.id, { input: turn.input + turn.cacheRead + turn.cacheWrite, output: turn.output, usd: turn.usd });
      if (context) this.setContext(s.id, context);
    }
  }

  /** (1.4.0) The context meter: the latest response's input tokens and its model's window (the model's id stays here). */
  private setContext(id: string, c: { tokens: number; model?: string }): void {
    this.claudeWatcher.setContext(id, { tokens: c.tokens, window: contextWindow(c.model ?? '') });
  }

  /** (1.4.0) A counted answer's cost or a finished turn's time, added to this week's numbers in `config.json` (the weekly digest). */
  private addToWeek(usd: number, workMs: number): void {
    const prev = this.config.get().usage;
    const next = rollWeek(prev, Date.now(), usd, workMs);
    if (JSON.stringify(next) !== JSON.stringify(prev)) this.config.patch({ usage: next });
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
      // the cost switch also covers the context meter: off, nothing of the transcript is read
      if (!this.config.get().claude.showCost) {
        this.turnStart.set(id, transcriptSize(file));
        return;
      }
      // a response Claude gives without a new prompt (a background agent finished) is measured from where the last one ended
      const read = (retry: boolean): void => {
        if (this.counted.get(id) === start || !this.config.get().claude.showCost) return; // its Stop came twice: the answer was counted already (or the switch went off meanwhile)
        const end = transcriptSize(file);
        const { cost: turn, context } = readTurn(file, start, end);
        if (context) this.setContext(id, context);
        if (turn) {
          this.counted.set(id, start);
          if (this.counted.size > 20) this.counted.delete(this.counted.keys().next().value!);
          if (this.turnStart.has(id)) this.turnStart.set(id, end); // (a session forgotten since, after its end, is not brought back)
          this.today = dayTotal(this.today, Date.now(), turn.usd ?? 0);
          this.addToWeek(turn.usd ?? 0, 0);
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

  // ------------------------------------------------------------------ approvals

  /** The app's own connection (its `hello` said so): the one that shows the notification, and the only one whose answer counts. */
  private isApp = (c: ServerConn) => c.meta.app === true && c.alive;

  private pushApprovals(answered?: { sessionId: string; tool: string }): void {
    this.rpc.broadcast('claude.approvals', { items: [...this.approvals.values()].map((a) => a.view), ...(answered ? { answered } : {}) });
  }

  /**
   * A permission prompt from the blocking hook (`jaffer hook permission-request`): waits up to 20 s for a click on Allow or Deny in the app.
   * Null (Claude Code shows its own prompt) when the setting is off, no app is there to ask, five already wait, the time runs out, the app's
   * connection goes, the hook's own goes (Claude Code gave up on it) or the daemon stops. The payload's input is read for the one line
   * shown and dropped; the watcher never sees it.
   */
  private askApproval(p: unknown, from: ServerConn): Promise<{ decision: 'allow' | 'deny' | null }> {
    const o = p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
    if (this.stopping || !this.config.get().claude.approvals || this.approvals.size >= MAX_APPROVALS || ![...this.rpc.conns].some(this.isApp)) return Promise.resolve({ decision: null });
    const tool = approvalTool(o.tool_name);
    const wait = Math.min(APPROVAL_WAIT_MS, Number(process.env.JAFFER_TEST_APPROVAL_WAIT_MS) || APPROVAL_WAIT_MS); // (a test hook, inert unless set)
    const detail = approvalDetail(tool, o.tool_input, { cwd: typeof o.cwd === 'string' ? o.cwd : undefined, home: this.userHome });
    const view: ApprovalView = { id: randomUUID(), sessionId: typeof o.session_id === 'string' ? o.session_id.slice(0, 80) : '', tool, detail: detail.text, allowable: detail.complete, expiresAt: Date.now() + wait };
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(null), wait);
      timer.unref?.();
      const off = from.closed.on(() => done(null));
      const done = (decision: 'allow' | 'deny' | null) => {
        if (!this.approvals.delete(view.id)) return;
        clearTimeout(timer);
        off();
        resolve({ decision });
        this.pushApprovals(decision ? { sessionId: view.sessionId, tool: view.tool } : undefined);
      };
      this.approvals.set(view.id, { view, done });
      this.pushApprovals();
    });
  }

  /** Every waiting prompt goes back to Claude Code's own. */
  private endApprovals(): void {
    for (const a of [...this.approvals.values()]) a.done(null);
  }

  // ------------------------------------------------------------------ rpc

  private registerMethods(): void {
    const r = this.rpc;
    // a request names its terminal (`pane`), or means the first one (what a window of 1.3 and the CLI send)
    const paneId = (p: { pane?: unknown } | null | undefined): string => (typeof p?.pane === 'string' ? p.pane : this.host.firstId);
    const pane = (p: { pane?: unknown } | null | undefined) => {
      const s = this.host.get(paneId(p));
      if (!s) throw new RpcError('No such pane', 'ENOPANE');
      return s;
    };

    r.handle('hello', (p: { client?: string; protocol?: number }, conn) => {
      if (p?.client === 'app' && !conn.meta.app) {
        conn.meta.app = true;
        // the app is gone: no click can come any more
        conn.closed.on(() => ![...this.rpc.conns].some(this.isApp) && this.endApprovals());
      }
      return { version: this.version, protocol: PROTOCOL, pid: process.pid, startedAt: this.startedAt, home: this.paths.home, platform: process.platform, client: p?.client };
    });

    // ---- terminal
    r.handle('session.attach', async (p: { cols?: number; rows?: number; pane?: string }, conn) => {
      const id = paneId(p);
      const s = pane(p);
      if (p.cols && p.rows) s.resize(p.cols, p.rows);
      const snapshot = await s.consistentSnapshot();
      this.panesOf(conn, 'attached').add(id);
      this.panesOf(conn, 'stale').delete(id);
      return { pane: id, panes: this.host.list(), snapshot };
    });
    // one terminal (`pane`) or, with none, all of them (a window of 1.3 detached the whole connection)
    r.handle('session.detach', (p: { pane?: unknown } | null, conn) => {
      for (const key of ['attached', 'stale'] as const) {
        if (typeof p?.pane === 'string') this.panesOf(conn, key).delete(p.pane);
        else this.panesOf(conn, key).clear();
      }
      return true;
    });
    r.handle('session.snapshot', async (p: { pane?: string }) => pane(p).consistentSnapshot());
    r.handle('pty.write', (p: { pane?: string; data: string }) => {
      pane(p).write(String(p.data));
      // typing while Claude waits for them means they are answering (the Claude of that terminal); the terminal's own replies and focus reports do not
      if (!isTerminalReport(String(p.data))) this.claudeWatcher.userAnswered(paneId(p));
      return true;
    });
    r.handle('pty.resize', (p: { pane?: string; cols: number; rows: number }) => {
      pane(p).resize(p.cols, p.rows);
      return true;
    });
    r.handle('pane.list', () => this.host.list());
    // 1.4.0: up to four terminals, only by the person's split: a fresh shell in the folder given, else that of the terminal it splits
    r.handle('pane.split', (p: { pane?: unknown; cwd?: unknown; cols?: unknown; rows?: unknown } | null) => {
      const base = pane(p);
      const num = (v: unknown, d: number) => (typeof v === 'number' ? v : d);
      return this.host.split({ cwd: typeof p?.cwd === 'string' && isDir(p.cwd) ? p.cwd : base.cwd, cols: num(p?.cols, base.cols), rows: num(p?.rows, base.rows) });
    });
    // ends that terminal's shell for good (it must be named; the last one is refused: `session.restart` it)
    r.handle('pane.close', (p: { pane?: unknown } | null) => {
      if (typeof p?.pane !== 'string' || !this.host.get(p.pane)) throw new RpcError('No such pane', 'ENOPANE');
      this.host.close(p.pane);
      return true;
    });
    r.handle('session.restart', async (p: { pane?: unknown } | null) => {
      pane(p);
      await this.host.restart(paneId(p));
      return true;
    });
    r.handle('session.info', (p: { pane?: unknown } | null) => {
      if (typeof p?.pane === 'string') pane(p);
      return { ...this.terminalInfo(paneId(p)), panes: this.host.list(), startedAt: this.startedAt, version: this.version };
    });

    // ---- the terminal's Claude, live (events come from `jaffer hook` inside Jaffer's own shell)
    r.handle('claude.event', (p: unknown) => {
      const ev = (p as { hook_event_name?: unknown } | null)?.hook_event_name;
      if (typeof ev === 'string' && HOOK_EVENTS.includes(ev)) this.hookSeen.set(ev, Date.now());
      this.claudeWatcher.handle(p);
      this.trackCost(p);
      return { ok: true };
    });
    r.handle('claude.state', () => this.claudeState());
    // Approvals (1.2.0, opt-in): a waiting hook asks, the app's click answers (strictly 'allow', 'deny' or 'ask', for an id that waits; else ignored)
    r.handle('claude.approval', (p: unknown, conn) => this.askApproval(p, conn));
    // ('ask': "Answer in terminal", Show: the hook lets go now and Claude Code's own prompt appears; 'allow' only for a request shown whole)
    r.handle('claude.approval.answer', (p: { id?: unknown; decision?: unknown } | null, conn) => {
      const a = typeof p?.id === 'string' ? this.approvals.get(p.id) : undefined;
      const d = p?.decision;
      if (!a || !this.isApp(conn) || (d !== 'allow' && d !== 'deny' && d !== 'ask') || (d === 'allow' && !a.view.allowable)) return { ok: false };
      a.done(d === 'ask' ? null : d);
      return { ok: true };
    });
    r.handle('claude.approvals', () => ({ items: [...this.approvals.values()].map((a) => a.view) }));
    r.handle('claude.hooks', () => ({ events: Object.fromEntries(HOOK_EVENTS.map((e) => [e, this.hookSeen.get(e) ?? null])) }));
    // Past conversations, from Claude Code's own transcripts: ids, folders, times, titles for the 30 newest (redacted) and (with showCost) token counts, read on request, kept nowhere;
    // `include`: the pinned ones' ids (checked there), listed even when older than the 50 newest
    // (1.4.0) The last 5 hours: the token counts and times of the responses in the transcripts written in that window, as numbers; with the
    // cost switched off nothing is read
    r.handle('claude.usage5h', () => (this.config.get().claude.showCost ? recentUsage(process.env.CLAUDE_CONFIG_DIR || path.join(this.userHome, '.claude'), Date.now()) : { tokens: 0, files: 0 }));
    r.handle('claude.history', async (p: { include?: unknown } | null) => ({
      items: await listConversations({ claudeDir: process.env.CLAUDE_CONFIG_DIR || path.join(this.userHome, '.claude'), limit: 50, withCost: this.config.get().claude.showCost, include: p?.include }),
    }));
    // (1.4.0) What the transcripts take on disk (sizes, ids, the folder and end of the 10 biggest, a title only when the list has it), and
    // Remove… → Older than 30/60/90 days (ids by when the file was last written); both read names and sizes, no text
    r.handle('claude.storage', () => conversationStorage(process.env.CLAUDE_CONFIG_DIR || path.join(this.userHome, '.claude')));
    r.handle('claude.old', (p: { days?: unknown } | null) => {
      if (!OLD_DAYS.includes(p?.days as number)) throw new RpcError('The days must be 30, 60 or 90.', 'EINVAL');
      return oldConversations(process.env.CLAUDE_CONFIG_DIR || path.join(this.userHome, '.claude'), p!.days);
    });
    // (1.4.0) Deep search, only while permissions.deepSearch is on: the ids of the conversations whose message text holds q, and how often; never the text
    r.handle('claude.search', (p: { q?: unknown } | null) => {
      if (!this.config.get().permissions.deepSearch) throw new RpcError('Searching the text of past conversations is off in Settings → Privacy and permissions.', 'EPERM');
      if (!searchQuery(p?.q)) throw new RpcError('Search for 3 to 64 characters, without control characters.', 'EINVAL');
      return searchConversations(process.env.CLAUDE_CONFIG_DIR || path.join(this.userHome, '.claude'), p!.q);
    });

    // (1.4.0) The side panel's Setup list: what Claude Code is set up with in a folder (skills, plugins, rules, subagents, hook counts, the
    // names in .mcp.json), from its files only; never ~/.claude.json, never a hook's command
    r.handle('claude.setup', (p: { cwd?: unknown } | null) => readSetup({ home: this.userHome, claudeDir: process.env.CLAUDE_CONFIG_DIR || path.join(this.userHome, '.claude'), cwd: this.setupFolder(p?.cwd) }));
    // (1.4.0) Only on the person's click (*Check MCP servers*): `claude mcp list` starts their servers to ask them; names and states come back
    r.handle('claude.mcp', (p: { cwd?: unknown } | null) => {
      const cwd = this.setupFolder(p?.cwd);
      this.mcpCheck ??= this.probeClaude()
        .then(() => runMcpList(this.claudeBin, cwd, this.claudeEnv()))
        .finally(() => (this.mcpCheck = null));
      return this.mcpCheck;
    });

    // (1.4.0) Explain, only while this daemon's own permissions.explain is on (never the page's word): the latest answer of a session it
    // tracks (the one named, else the newest that has not ended) goes to one helper `claude -p` without tools; its answer goes back to the
    // caller only. Nothing of either is logged or kept. One at a time: a second ask while one runs gets the same answer.
    r.handle('claude.explain', (p: { session?: unknown } | null): Promise<ExplainResult> | ExplainResult => {
      if (this.config.get().permissions.explain !== true) return { ok: false, reason: 'off' };
      return (this.explaining ??= this.explain(p?.session).finally(() => (this.explaining = null)));
    });

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
      const res = await setupClaude(this.cliWrapper, { home: this.userHome, env: this.userEnv(), approvals: this.config.get().claude.approvals });
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

  private async explain(id: unknown): Promise<ExplainResult> {
    const live = this.claudeWatcher.sessions();
    const s = id === undefined || id === null ? live.find((x) => x.state !== 'ended') : live.find((x) => x.id === id);
    if (!s?.transcriptPath) return { ok: false, reason: 'no-reply' };
    const now = Date.now();
    for (const [k, t] of this.explainedAt) if (now - t >= EXPLAIN_COOLDOWN_MS) this.explainedAt.delete(k);
    if (this.explainedAt.has(s.id)) return { ok: false, reason: 'busy' };
    await this.probeClaude();
    const env = this.claudeEnv();
    if (this.explainOk?.bin !== this.claudeBin) this.explainOk = { bin: this.claudeBin, ok: await explainSupported(this.claudeBin, env) };
    if (!this.explainOk.ok) return { ok: false, reason: 'unavailable' };
    if (this.config.get().permissions.explain !== true) return { ok: false, reason: 'off' }; // (switched off meanwhile: read nothing)
    const text = await lastReply(s.transcriptPath, process.env.CLAUDE_CONFIG_DIR || path.join(this.userHome, '.claude'));
    if (!text) return { ok: false, reason: 'no-reply' };
    try {
      return await runExplain({ claudeBin: this.claudeBin, prompt: buildExplainPrompt(text), env });
    } finally {
      this.explainedAt.set(s.id, Date.now());
    }
  }

  /** The folder the window named for the Setup list: an existing absolute folder of at most 4096 characters without control characters, else the home folder. */
  private setupFolder(cwd: unknown): string {
    return typeof cwd === 'string' && cwd.length <= 4096 && path.isAbsolute(cwd) && !/\p{Cc}/u.test(cwd) && isDir(cwd) ? cwd : this.userHome;
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

/** The least time between two Explains of one session (a double click is not two helper runs). */
const EXPLAIN_COOLDOWN_MS = 5000;

/** A command that was stopped, not ended (Ctrl+Z: the shell reports 128 + a stop signal, 145 to 150 on macOS and Linux). */
function stoppedExit(exit: number | null): boolean {
  return exit != null && exit >= 145 && exit <= 150;
}

/** An existing folder (a file, a missing path or one too long for the system is not). */
function isDir(p: string): boolean {
  try {
    return fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;
  } catch {
    return false;
  }
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
