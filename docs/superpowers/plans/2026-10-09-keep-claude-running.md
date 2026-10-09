# Keep the session and Claude running: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After an update, a crash or a reboot the one session comes back by itself and Claude Code resumes the same conversation; the Mac stays awake while Claude works; and the person can restart Claude onto a new version in one action.

**Architecture:** Pure, injected-dependency controllers in `src/core` (`AutoResumer`, `StayAwake`, `LaunchAgent`) driven by the daemon's existing events (`prompt`, `command`, `exit`, `claude.state`, config changes), with thin renderer and main-process pieces (toasts, switches, a native confirmation). launchd, `caffeinate` and the pty are reached only through injected runners, so every decision is unit-tested without touching the machine.

**Tech Stack:** TypeScript, Node (daemon, `launchctl`/`caffeinate` through `execFile`), Electron main, Preact signals, vitest (unit, real-PTY daemon tests), Playwright-core UI tests.

**Spec:** `docs/superpowers/specs/2026-10-08-keep-claude-running-design.md` (approved). The spec wins over this plan on any conflict.

## Global Constraints

- The only things Jaffer types into the shell are `claude` (⇧⌘C, first-run switch) and, after this change, `claude --resume <id>` (a click, auto-resume, or Restart Claude). The id is `isSessionId`-checked where kept and again where typed. `runCommand` stays absent. Claude Code's own questions are never answered.
- Nothing is typed after a deliberate end (`claude` exit 0 or 130, `SessionEnd`), when `session.resumeClaude` is off, or while the daemon is stopping.
- One session, one terminal: no new panes, tabs or windows; no new panels in the calm window (toasts, Settings and the command palette only). Colours are theme tokens; no new global CSS class that is also a layout utility or an existing standalone selector.
- Config: every new key has a default of the right kind (`conform` keeps it): `session.autoResume` true, `session.keepRunning` false, `session.stayAwake` true.
- A LaunchAgent exists only with the person's switch, only for the default home (`~/.jaffer`), is refused from `/AppTranslocation/` and `/Volumes/` paths, and is removed by Settings → Reset and `jaffer reset`. **No test may touch the real `~/Library/LaunchAgents` or run the real `launchctl`/`caffeinate`**: tests use temp homes (refused) and injected runners.
- Never ask for, print or store a password. No change to CI workflows, entitlements or signing config.
- Anything the window shows about a command goes through `safeCommand()`; nothing new reaches memory, episodes or a model.
- Constants live in `src/shared/keep-running.ts` (one place): notice 3 s, quiet 2 s, 3 attempts in 10 min with waits 3 s / 20 s / 2 min, healthy run 30 s; stay-awake command threshold 30 s, release delay 15 s, command cap 6 h.
- Verify with `npm run typecheck && npm test`; UI with `JAFFER_CHROME=… npm run test:e2e`. Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. `mkdir -p docs/releases` before writing a release note after a `git rm` there.

## Review Focus

Failure modes the tasks' obvious tests would not catch; each has a pinned test in the owning task.

1. **Typing into the wrong place:** auto-resume must not type when the shell is busy, not at a prompt, the person typed in the last 2 s, the offer is for another folder or has gone, or the id is not an id. (Task 3, 4)
2. **Resume loops:** a daemon restarted in a loop by launchd must not resume forever; the attempt times survive the restart. (Task 2, 3)
3. **launchd ownership:** two daemons (launchd's and a detached one), a plist left behind after the app is deleted or moved, a translocated app path, and tests touching the real LaunchAgents. (Task 8, 9)
4. **Exit codes:** `app.shutdown` must still exit 0 (launchd must not restart a deliberate end) while `SIGTERM`/`SIGINT` exit non-zero after saving state. (Task 8)
5. **Stay-awake leaks and flapping:** a `caffeinate` left running when the daemon dies or the setting goes off; flapping between Claude's tool calls; an idle `ssh` or `vim` holding the Mac awake all day. (Task 7)

---

### Task 1: A shell that dies takes Claude with it, and the resume point stays

**Files:**
- Modify: `src/daemon/service.ts` (`wireEvents`)
- Test: `test/daemon.test.ts` (inside `describe('Claude Code that was running when Jaffer stopped')`)

**Interfaces:**
- Produces: when the main pane emits a pty `exit` event and the daemon is not stopping, every watcher session is ended (`claudeWatcher.endAll()`), the resume point is **not** forgotten, and `pushResume()` runs. Later tasks rely on `resumeOffer()` being non-null after a shell restart.

- [ ] **Step 1: Write the failing test** `'a shell that is restarted takes Claude with it, and the conversation can be resumed afterwards'`: use `inFolder('resume-h')`, its own session id (`OTHER`-style; the home is shared by these tests and a conversation keeps the folder it began in), `hook(c,'SessionStart',id)`, `hook(c,'UserPromptSubmit',id,{prompt:'go'})`, then `c.call('session.restart',{})`. Assert with `waitUntil`: the pane pid changed (`session.info`), `claude.state` has no session with state other than `ended`, `claude.resume` returns `{id}` for that folder, and `claude.json` still exists.
- [ ] **Step 2: Run it** `npx vitest run test/daemon.test.ts -t "restarted takes Claude"` after `npm run build`. Expected: FAIL (`claude.resume` is `null`: the old session still counts as active).
- [ ] **Step 3: Implement** in `wireEvents`: for `e.event.type === 'exit'`, `if (!this.stopping) { this.claudeWatcher.endAll(); this.pushResume(); }`. Do not touch the resume store.
- [ ] **Step 4: Run it again, then the whole resume describe.** Expected: PASS, and the existing resume tests still pass.
- [ ] **Step 5: Commit** `git add src/daemon/service.ts test/daemon.test.ts && git commit -m "daemon: a shell that exits ends the watcher's sessions but keeps the resume point"`.

### Task 2: Foundations: config keys, constants, attempt times in the resume file

**Files:**
- Create: `src/shared/keep-running.ts`
- Modify: `src/shared/config.ts` (`JafferConfig.session`, `DEFAULT_CONFIG.session`), `src/core/claude/resume.ts`
- Test: `test/config.test.ts`, `test/claude-resume.test.ts`

**Interfaces:**
- Produces `src/shared/keep-running.ts`: `export const AUTO_RESUME = { noticeMs: 3_000, quietMs: 2_000, maxAttempts: 3, windowMs: 600_000, waitsMs: [3_000, 20_000, 120_000], healthyMs: 30_000 } as const;` and `export const STAY_AWAKE = { commandAfterMs: 30_000, releaseDelayMs: 15_000, commandCapMs: 21_600_000 } as const;` and `export const AGENT_LABEL = 'com.jafforge.jaffer.daemon';`
- Produces config: `session: { restoreScreen: boolean; resumeClaude: boolean; autoResume: boolean; keepRunning: boolean; stayAwake: boolean }`.
- Produces on `ResumeStore`: `attempts(id: string): number[]` (times within `AUTO_RESUME.windowMs` of now), `recordAttempt(id: string): void`, `clearAttempts(id: string): void`; persisted in `claude.json` as `{ version: 1, point, attempts?: { id: string; at: number[] } }`; `forget()` that empties the point removes the file as today.

- [ ] **Step 1: Write failing tests.** Config: defaults are `autoResume` true, `keepRunning` false, `stayAwake` true, also for a file saved before they existed, and `{session:{autoResume:'yes'}}` keeps true (the `conform` rule). Resume store: `recordAttempt` three times then `attempts(ID)` returns three times; an attempt older than 10 minutes (injected clock) is not returned; a **new `ResumeStore` on the same file** returns the same attempts (survives a restart); `clearAttempts` empties them; `attempts` for another id is empty; a bad or missing `attempts` block in the file is ignored; `forget()` of the only point removes the file.
- [ ] **Step 2: Run** `npx vitest run test/config.test.ts test/claude-resume.test.ts`. Expected: FAIL (keys and methods missing).
- [ ] **Step 3: Implement** the constants file, the three config defaults, and the three `ResumeStore` methods (keep attempts for one id only; reading validates `Array.isArray` of finite numbers; writing goes through the existing `write()`).
- [ ] **Step 4: Run** the same tests plus `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `"config and resume store: autoResume, keepRunning, stayAwake, and attempt times that survive a restart"`.

### Task 3: `AutoResumer`: when to type `claude --resume <id>` (pure decision + driver)

**Files:**
- Create: `src/core/claude/auto-resume.ts`
- Test: `test/auto-resume.test.ts`

**Interfaces:**
- Consumes: `AUTO_RESUME` (Task 2), `resumeCommand`, `isSessionId` (`src/shared/claude-resume.ts`).
- Produces:
```ts
export interface AutoResumeInput { now: number; offer: { id: string } | null; promptReady: boolean; busy: boolean; lastInputAt: number; enabled: boolean; stopping: boolean; attempts: number[]; pendingSince?: number; cancelled: boolean }
export type AutoResumeStep = { kind: 'idle' } | { kind: 'announce'; typesAt: number } | { kind: 'wait'; until: number } | { kind: 'type'; id: string } | { kind: 'give-up' }
export function nextStep(i: AutoResumeInput): AutoResumeStep
export function waitBefore(attempts: number[]): number   // waitsMs[min(attempts.length, 2)]
export type AutoResumeEvent = { state: 'pending'; id: string; typesAt: number } | { state: 'typed' | 'cancelled' | 'gave-up'; id: string }
export interface AutoResumeDeps { now(): number; offer(): { id: string } | null; promptReady(): boolean; busy(): boolean; lastInputAt(): number; enabled(): boolean; stopping(): boolean; attempts(id: string): number[]; recordAttempt(id: string): void; clearAttempts(id: string): void; type(text: string): void; emit(e: AutoResumeEvent): void; setTimer(fn: () => void, ms: number): unknown; clearTimer(t: unknown): void }
export class AutoResumer { constructor(d: AutoResumeDeps); check(opts?: { explicit?: boolean }): void; cancel(): void; claudeEnded(info: { exit: number | null; durMs: number }): void }
```
`explicit: true` (Restart Claude) ignores `enabled()` but never the other conditions.

- [ ] **Step 1: Write failing tests** for `nextStep` (a table): idle when no offer, not `enabled`, `stopping`, `cancelled`, a non-`isSessionId` id; `announce` with `typesAt = now + noticeMs` when everything holds; `wait` until `lastInputAt + quietMs` when the person typed 1 s ago; idle (not `wait`) when `busy` or not `promptReady`; `type` once `pendingSince + waitBefore(attempts)` has passed; `give-up` when `attempts.length >= 3`. For the class (fake clock and timers, a recording `type`): one `check()` emits `pending` and types exactly `claude --resume <id>\r` after 3 s, records one attempt and emits `typed`; a second `check()` while pending does not announce twice; `cancel()` before the time emits `cancelled`, types nothing, and a further `check()` for the same offer stays quiet until the offer changes; typing at 2.5 s delays it to 2 s after the last input; the person typing while it waits is never overridden; a second automatic try after a crash waits 20 s, a third 2 min, a fourth is `gave-up` with one `gave-up` event and no typing; `claudeEnded({exit:1,durMs:5_000})` after typing keeps the attempts, `claudeEnded({exit:1,durMs:60_000})` (a healthy run) calls `clearAttempts` and `check()` retries; `explicit` types even with `enabled()` false; nothing is typed when `stopping()` turns true during the wait.
- [ ] **Step 2: Run** `npx vitest run test/auto-resume.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `nextStep` and `waitBefore` as pure functions, then `AutoResumer` over them (one pending timer at most; `cancel()` marks the current offer id cancelled; the cancelled mark clears when `offer()` changes id or null).
- [ ] **Step 4: Run** the tests and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `"AutoResumer: when to type claude --resume, as a pure decision with an injected driver"`.

### Task 4: Auto-resume in the daemon, the notice, the Settings switch

**Files:**
- Modify: `src/daemon/service.ts` (own an `AutoResumer`; call `check()` on start, on a main-pane `prompt` event, after a non-deliberate `claude` exit, on config change; track `lastInputAt` in the `pty.write` handler for data that is not a terminal report; `claude.autoresume.cancel` RPC; `claudeEnded` from the `command` handler when the command is `claude`); `src/main/main.ts` (a native notification for `gave-up`); `src/renderer/state.ts` (toast with a **Cancel** action on `pending`, dismissed on `typed`/`cancelled`); `src/renderer/components/Overlays.tsx` (switch *Resume Claude automatically* under *Offer to resume Claude Code*, disabled while that is off)
- Test: `test/daemon.test.ts`, `test/e2e/ui.test.ts`

**Interfaces:**
- Consumes: `AutoResumer` (Task 3), `ResumeStore.attempts/recordAttempt/clearAttempts` (Task 2), the Task 1 behaviour.
- Produces: event `claude.autoresume` (`AutoResumeEvent`), RPC `claude.autoresume.cancel` → `true`. `type()` writes to the main pane directly (it is not the person answering: it must not call `claudeWatcher.userAnswered()` and must not set `lastInputAt`).

- [ ] **Step 1: Write failing daemon tests** (shell-function stand-in, e.g. `claude() { echo "RESUMED: $*"; }`, own session id, a restart through `app.shutdown`): after a restart the terminal text contains `RESUMED: --resume <id>` once, only after the 3 s notice, and `claude.autoresume` pushed `pending` then `typed`; with `session.autoResume` false nothing is typed and `claude.resume` still offers; `claude.autoresume.cancel` during the wait types nothing; a deliberate `claude` exit (stand-in returning 0) and a `SessionEnd` are never resumed; a stand-in returning 1 (crash) is retried and, after three failures inside 10 minutes (injected via a short `AUTO_RESUME` override only in this test through `JAFFER_TEST_AUTORESUME_FAST=1` read in `service.ts`), `gave-up` is pushed and typing stops; typing by the person within 2 s of the prompt delays it. UI tests: with `__event('claude.autoresume', {state:'pending', id, typesAt})` a toast "Resuming Claude" with a **Cancel** button appears and clicking it calls `claude.autoresume.cancel`; the switch exists, is on by default, writes `session.autoResume`, and is disabled while *Offer to resume* is off.
- [ ] **Step 2: Run** (`npm run build` first for daemon tests). Expected: FAIL.
- [ ] **Step 3: Implement** the wiring and UI above. `enabled()` is `session.autoResume && session.resumeClaude`. In test mode only (`JAFFER_TEST_AUTORESUME_FAST=1`) the constants are scaled to milliseconds; production reads `AUTO_RESUME` unchanged.
- [ ] **Step 4: Run** the daemon tests, the full UI file, `npm run typecheck`, `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `"auto-resume: the daemon resumes the recorded conversation by itself, announced and cancellable"`.

### Task 5: Restart Claude

**Files:**
- Modify: `src/daemon/service.ts` (`claude.restart.plan`, `claude.restart`), `src/main/main.ts` (`ipcMain.handle('jaffer:restart-claude')` with the native confirmation, same `trusted(e)` check as `jaffer:reset`), `src/main/preload.ts` and `src/renderer/global.d.ts` (`restartClaude(): Promise<{ cancelled: boolean; resumable?: boolean }>`), `src/renderer/actions.ts` (palette action `restart-claude`, title *Restart Claude Code, to use an update*, section Terminal, keywords `update claude code new version`), `src/renderer/components/Overlays.tsx` (a *Restart Claude Code* button in Settings → Claude Code)
- Test: `test/daemon.test.ts`, `test/e2e/ui.test.ts`

**Interfaces:**
- Consumes: Task 1 (`resumeOffer()` after a shell restart), `AutoResumer.check({ explicit: true })` (Task 3).
- Produces: `claude.restart.plan` → `{ resumable: boolean; busy: boolean }` (`resumable`: `resumeOffer()` is non-null or an active watcher session has a saved point; `busy`: a session is `working` or `needs-you`); `claude.restart` → `{ resumable: boolean }`: restarts the main shell (`host.restartMain()`), then on the next prompt calls `autoResume.check({ explicit: true })` once. Dialog text per the spec; with `busy` the extra line "Claude is working right now: that work stops"; with `!resumable` "No Claude Code conversation is running; this only restarts the shell".

- [ ] **Step 1: Write failing tests.** Daemon: with a recorded conversation and the stand-in `claude`, `claude.restart.plan` is `{resumable:true,busy:false}`; `claude.restart` gives a new pane pid in the same folder, then the terminal shows `RESUMED: --resume <id>`, **also with `session.autoResume` false**; Cancel during the notice stops it; with no conversation it only restarts the shell and returns `{resumable:false}`; with `session.resumeClaude` false it never types. UI: the palette lists the action; clicking the Settings button opens the native dialog through a stubbed `window.jaffer.restartClaude` (the dev bridge has no `dialog`; it returns what the test sets) and the dialog text for the three cases is produced by a pure `restartClaudeText({ resumable, busy })` in `src/shared/restart-claude.ts` that is unit-tested directly.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** the RPCs, the pure text function, the IPC handler (plan, dialog, restart), the preload and type entries, the palette action and the button. The dev bridge (`src/dev/bridge.ts`) gets a `restartClaude` that calls `claude.restart` directly (tests only).
- [ ] **Step 4: Run** daemon, UI, typecheck and `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `"Restart Claude: restart the shell in the same folder and resume the same conversation after an update"`.

### Task 6: A second Claude conversation gets a notice

**Files:**
- Create: `src/shared/one-claude.ts`
- Modify: `src/renderer/state.ts` (on `claude.state`)
- Test: `test/one-claude.test.ts`, `test/e2e/ui.test.ts`

**Interfaces:**
- Produces: `export function twoRunning(sessions: { id: string; state: string }[], told: Set<string>): string | null`: when two or more sessions are not `ended`, the sorted ids joined by `+` if it is not already in `told`, else `null`. Background agents are not sessions.

- [ ] **Step 1: Write failing tests.** Unit: one active session → `null`; two active → a key; the same two again with that key in `told` → `null`; an `ended` one does not count; three active gives one key for all three; ids are sorted so order does not matter. UI: `__event('claude.state', …)` with two active sessions shows one toast "Two Claude conversations are running. After a restart Jaffer resumes the newest.", a second identical event shows no second toast, and nothing is ended.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** the pure function and the renderer hook (a module-level `told` set).
- [ ] **Step 4: Run** the unit test, UI file, typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `"a notice, never a kill, when two Claude conversations run"`.

### Task 7: Stay awake while something works

**Files:**
- Create: `src/core/session/stay-awake.ts`
- Modify: `src/daemon/service.ts` (feed `StayAwake` from `claudeWatcher.changes`, pane `start`/`command` events and a 5 s ticker while a command runs; `stop()` releases), `src/renderer/components/Overlays.tsx` (switch *Keep my Mac awake while Claude works* in Appearance, with the spec's hint)
- Test: `test/stay-awake.test.ts`, `test/e2e/ui.test.ts`

**Interfaces:**
- Consumes: `STAY_AWAKE` (Task 2).
- Produces:
```ts
export function isInteractiveCommand(cmd: string): boolean   // ssh mosh vim nvim vi less man top htop tmux screen watch claude, and `tail -f`
export interface StayAwakeDeps { platform: string; pid: number; hold(args: string[]): { release(): void }; now(): number; setTimer(fn: () => void, ms: number): unknown; clearTimer(t: unknown): void }
export interface Work { enabled: boolean; claude: boolean; command: { cmd: string; since: number } | null }
export class StayAwake { constructor(d: StayAwakeDeps); update(w: Work): void; stop(): void; get holding(): boolean }
```
`hold` is called with `['-i', '-w', String(pid)]` for `/usr/bin/caffeinate`; the real implementation in `service.ts` is `execFile('/usr/bin/caffeinate', args)` and `release()` kills the child.

- [ ] **Step 1: Write failing tests** (fake `hold`, clock, timers). Claude working starts exactly one hold; a second `update` does not start another; idle for 15 s releases, idle for 10 s then working again does not release or restart (no flapping); `enabled: false` releases at once; `stop()` releases; platform other than `darwin` never holds; a plain command holds only after 30 s and an interactive one (`ssh host`, `vim x`, `tail -f log`, `claude`) never does; a command-only hold is released at 6 h but a working Claude is not capped; `needs-you` is not work (the daemon passes `claude: false` for it, pinned in the daemon wiring test); `hold` throwing leaves it not holding and does not throw out of `update`. UI: the switch exists, is on by default, writes `session.stayAwake`, and its hint contains "closed-display".
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `StayAwake` and the daemon wiring (`claude` is true when any session is `working` or a subagent runs).
- [ ] **Step 4: Run** unit, UI, typecheck, `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `"stay awake while Claude or a long command works (idle-sleep hold, no admin rights)"`.

### Task 8: The LaunchAgent module and the daemon's exit codes

**Files:**
- Create: `src/core/service/launch-agent.ts`
- Modify: `src/daemon/main.ts` (`SIGTERM` exits 143 and `SIGINT` 130 after saving state; the `rpc` shutdown stays 0)
- Test: `test/launch-agent.test.ts`, `test/daemon.test.ts` (exit codes)

**Interfaces:**
- Consumes: `AGENT_LABEL` (Task 2).
- Produces:
```ts
export interface PlanInput { home: string; defaultHome: string; userHome: string; uid: number; platform: string; execPath: string; daemonScript: string; electron: boolean }
export interface AgentPlan { plistPath: string; wrapperPath: string; plist: string; wrapper: string }
export function planAgent(i: PlanInput): AgentPlan | { refused: string }
export interface Launchctl { run(args: string[]): Promise<{ code: number; out: string }> }
export type AgentStatus = { state: 'not-installed' } | { state: 'running'; pid: number } | { state: 'not-loaded' } | { state: 'refused'; reason: string }
export class LaunchAgent { constructor(d: { launchctl: Launchctl; uid: number; fs: Pick<typeof import('node:fs'), 'writeFileSync' | 'mkdirSync' | 'rmSync' | 'existsSync' | 'chmodSync' | 'readFileSync'> }); status(plan: AgentPlan | { refused: string }): Promise<AgentStatus>; install(plan: AgentPlan): Promise<void>; remove(plan: AgentPlan): Promise<void>; reconcile(want: boolean, plan: AgentPlan | { refused: string }): Promise<AgentStatus>; kickstart(): Promise<boolean> }
```
`plist` has `Label`, `RunAtLoad` true, `KeepAlive` `{SuccessfulExit: false}`, `ThrottleInterval` 5, `LimitLoadToSessionType` Aqua, `ProgramArguments` `[wrapperPath]`, `EnvironmentVariables` `{JAFFER_HOME}`, stdout/stderr to `<home>/run/jafferd.log`. `wrapper` is a `#!/bin/sh` script that, when `execPath` is missing, runs `launchctl bootout gui/<uid>/<label>`, removes plist and wrapper, exits 0; else `exec`s with `ELECTRON_RUN_AS_NODE=1` when `electron`. Refusals: platform not `darwin`; `home !== defaultHome`; `execPath` containing `/AppTranslocation/` or starting with `/Volumes/`.

- [ ] **Step 1: Write failing tests.** `planAgent` refuses each of the three cases with a human reason and plans a normal `/Applications/Jaffer.app/Contents/MacOS/Jaffer` path; the plist text contains each required key and value and no secret; the wrapper contains the existence check and the self-removal; `LaunchAgent` with a recording `Launchctl` and an in-memory fs: `install` writes both files (wrapper mode 0755) and runs `bootstrap gui/<uid> <plist>`, `remove` runs `bootout` and deletes both (and is silent when nothing is installed), `reconcile(true)` with a stale plist rewrites it, with a current one does nothing, `reconcile(false)` with a plist present removes it, `status` maps `launchctl print` output to `running` with the pid / `not-loaded` / `not-installed`, `kickstart` runs `kickstart gui/<uid>/<label>` and returns whether it exited 0. `plutil -lint` of a generated plist passes on macOS (`it.skipIf(process.platform !== 'darwin')`, via `execFileSync`, on a temp file only). Daemon: a real daemon (bundled) gets `SIGTERM` and exits with code 143 after writing its state; `app.shutdown` still exits 0 (`SIGINT` 130 covered by the same helper).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** the module and the signal exit codes (`shutdown(why, code)` in `daemon/main.ts`).
- [ ] **Step 4: Run** the new tests, `npm test`, typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `"LaunchAgent module (plan, install, remove, reconcile, status) and non-zero exit for a killed daemon"`.

### Task 9: Always on: wiring, CLI, Reset, Settings and first run

**Files:**
- Modify: `src/daemon/service.ts` (RPC `service.status|install|remove`; reconcile at `start()` when `session.keepRunning`; refresh on every start while on), `src/core/daemon-client.ts` (`launchDaemon` uses `kickstart` when the agent is installed and loaded, else the detached spawn as today), `src/cli/main.ts` (`jaffer service install|remove|status`), `src/core/reset.ts` (remove the agent first; the runner is injectable), `src/renderer/components/Overlays.tsx` (Settings → Appearance switch *Keep my session running in the background* with the status line; the first-run switch)
- Test: `test/daemon.test.ts`, `test/reset.test.ts`, `test/launch-agent.test.ts`, `test/e2e/ui.test.ts`

**Interfaces:**
- Consumes: `LaunchAgent`, `planAgent` (Task 8), `session.keepRunning` (Task 2).
- Produces: RPCs `service.status` → `AgentStatus`, `service.install` / `service.remove` → `AgentStatus` (they set `session.keepRunning` to match); in a temp home all three report `refused` and touch nothing. First-run: the switch (copy: "Keep my session running in the background: restart it automatically after a crash or a reboot") is on by default in the Claude path and **off in the plain-terminal path** (ruling: that path promises it installs nothing); it writes `session.keepRunning` through `service.install` only when on.

- [ ] **Step 1: Write failing tests.** Daemon (temp home): `service.status` is `refused` with the reason; `service.install` is refused and `<test user home>/Library/LaunchAgents` is never created; `jaffer service status` prints the state and `install` in a temp home exits non-zero with the reason. `launchDaemon`: with a fake loaded agent it calls `kickstart` and does not spawn; with none it spawns detached as before (unit test with injected `spawn`/`launchctl`). Reset: `resetJaffer` with a fake `Launchctl` and a planned agent calls `bootout` and deletes the plist and wrapper before the folder is removed, and is a no-op without an agent. UI: the Appearance switch shows the status line and the refusal reason in the test home (switch disabled with "Move Jaffer to Applications first" style text from the reason), the first-run step shows the switch on in the Claude path and off in the plain path, and a plain-terminal first run still installs and starts nothing.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** the wiring, the CLI group, the Reset step and both switches.
- [ ] **Step 4: Run** the daemon/CLI/reset tests, the full UI file, `npm test`, typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `"always on: the LaunchAgent switch, jaffer service, Reset removes it"`.

### Task 10: Rules, docs, release

**Files:**
- Modify: `CLAUDE.md` (typing rule: the daemon also types `claude --resume <id>` under the guard; persistent configuration outside `~/.jaffer`: a LaunchAgent only with the switch, default home only, removed by Reset; the daemon owns the shell is stronger with the agent), `docs/ARCHITECTURE.md` (auto-resume, restart, stay awake, launchd ownership and exit codes), `README.md` (a short section; the honest lid-closed sentence from the Settings hint; the by-hand list under "Not verified here"), `package.json` and `package-lock.json` (0.5.0), `docs/releases/v0.5.0.md` (`git rm docs/releases/v0.4.1.md`, `mkdir -p docs/releases` first)
- Test: none new; full verification

- [ ] **Step 1: Write the docs and the release notes** (what changed, what is by hand: the spec's list; no claim beyond what was verified).
- [ ] **Step 2: Run everything:** `npm run typecheck && npm test`, `node scripts/gen-shell.mjs --check`, `npm run build`, the full UI file with `JAFFER_CHROME`, the screenshots test with a short `TMPDIR` (regenerate only the Settings shot that changed).
- [ ] **Step 3: Commit** `"Release 0.5.0: Jaffer keeps the session and Claude running"`. Do **not** push, tag or publish without the owner's say-so in chat.
- [ ] **Step 4: By hand on the owner's Mac, only with their say-so (it touches `~/Library/LaunchAgents`):** install the agent, `kill -9` the daemon and watch it return in about 5 s with the screen and a resumed Claude; log out and in; reboot; update with the agent on; `bootout` and uninstall; `pmset -g assertions` shows the stay-awake hold while Claude works and not after; what a closed lid does with and without power and an external display. Report what was and was not verified.
