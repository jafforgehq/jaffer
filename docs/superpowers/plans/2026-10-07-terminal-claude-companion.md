# One Claude: companion panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `claude` in Jaffer's terminal the only Claude: replace the panel's separate chat with a live, read-only companion fed by Claude Code hooks, and delete the chat machinery.

**Architecture:** Async Claude Code hooks call `jaffer hook <event>`, which forwards the payload to the daemon (`claude.event`). A pure `ClaudeWatcher` state machine turns events into per-session state; the daemon broadcasts `claude.state`; a new `ClaudePanel` renders it. Then the old chat engine, API engine, key storage, `jaffer ask` and terminal-typing tools are deleted.

**Tech Stack:** TypeScript, Node (daemon, CLI), Electron main, Preact + signals (renderer), vitest, Playwright (e2e in Chrome).

**Spec:** `docs/superpowers/specs/2026-10-07-terminal-claude-companion-design.md` (read it first). Refinements made while planning, which this plan follows: `assess.ts` is deleted with the panel's tools while `permissions.ts` (generic risk rules) stays and receives `Risk` and `resolvePath`; the lapsed-login banner is re-checked at startup and when the window regains focus (at most once a minute), because there are no panel turns any more.

## Global Constraints

- Verify every task with `npm run typecheck && npm test`; UI tasks also `JAFFER_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npx vitest run --config vitest.e2e.config.ts test/e2e/ui.test.ts`. Known flaky on this Mac, also on `main`: the real-`claude` TUI test and some PTY "refuses to inject" tests; rerun, and report any failure by name.
- Subscription only: no API key anywhere. One session, one terminal: nothing may add a split, tab or window.
- Hooks are `async: true`, print nothing, exit 0 on every path, do nothing unless `JAFFER_SESSION=1` and not `JAFFER_NO_HOOKS`.
- Everything the watcher exposes passes `src/shared/redact.ts`; sensitive commands (`isSensitiveCommand`) show only the tool name.
- Limits: activity ≤ 30 entries per session; ≤ 5 sessions; ended sessions dropped after 5 minutes; prompt preview ≤ 120 chars; last reply ≤ 240 chars; `claude.state` pushes throttled to 1 per 100 ms; transcript polling every 500 ms and only while `needs-you`; desktop notification suppressed if a terminal notification was shown in the previous 10 s.
- CSS: state goes in `data-state`/`data-status`, never in a modifier class on a global selector; colours from theme tokens; new classes are prefixed `live-`.
- No prompt box, thread, slash commands or composer anywhere in the app.

## Review Focus

1. A `claude` run outside Jaffer's terminal (no `JAFFER_SESSION`) never appears: Tasks 2 and 3.
2. Payloads with missing/odd fields or huge text (1 MB prompt, `tool_input` as a string, no `session_id`) are ignored or truncated, never crash the daemon: Task 1.
3. A dead or slow daemon makes the hook silent, fast, exit 0: Task 2.
4. `/clear`, subagents and restarts create new session ids: sessions stay isolated and capped: Task 1.
5. An install with only the old two hooks gets the new ones on daemon start without touching the user's own hooks: Tasks 2 and 3.
6. A secret in a prompt or command never reaches the renderer: Tasks 1 and 5.

---

### Task 1: `ClaudeWatcher` state machine

**Files:**
- Create: `src/core/claude/watcher.ts`, `test/claude-watcher.test.ts`, `test/fixtures/claude-hooks/<Event>.json` (one real payload per event, copied from the spike's `hooks.jsonl`, paths and ids scrubbed; Notification and PostToolUseFailure written to the documented shape).

**Interfaces — Produces:**
```ts
export type ClaudeState = 'idle' | 'working' | 'needs-you' | 'ended';
export interface ClaudeActivity { id: string; name: string; summary: string; status: 'running' | 'done' | 'failed'; startedAt: number; durMs?: number }
export interface ClaudeSubagent { id: string; type: string; status: 'running' | 'done' }
export interface ClaudeSession { id: string; cwd: string; model?: string; state: ClaudeState; since: number; prompt?: string; tool?: { name: string; summary: string }; activity: ClaudeActivity[]; subagents: ClaudeSubagent[]; lastReply?: string; notice?: string; transcriptPath?: string }
export function summarizeTool(name: string, input: unknown): string   // Bash→command, Edit/Write/Read/NotebookEdit→file_path, Agent/Task→description, Grep/Glob→pattern, else ''
export class ClaudeWatcher {
  constructor(opts?: { now?: () => number })
  readonly changes: Emitter<ClaudeSession[]>      // Emitter from src/shared/util
  handle(payload: unknown): void                   // one hook payload; never throws
  endAll(): void                                   // every live session → 'ended'
  retractNotice(sessionId: string): void           // needs-you → idle, clears notice and tool
  sessions(): ClaudeSession[]                      // newest change first, after dropping stale ended ones
}
```

- [ ] **Step 1: Write the failing tests** in `test/claude-watcher.test.ts`, feeding the fixtures through `handle` with an injected clock. Tests (names are the spec): `SessionStart creates an idle session with the model`; `UserPromptSubmit → working with a ≤120 char redacted prompt, and ignores <task-notification> prompts`; `PreToolUse sets the tool and adds a running activity; PostToolUse completes it with the duration and keeps working`; `PostToolUseFailure marks the entry failed`; `permission Notification → needs-you with the message; idle Notification leaves idle`; `needs-you clears on PostToolUse, Stop, UserPromptSubmit and retractNotice`; `Stop → idle with the trimmed redacted last reply`; `SubagentStart/Stop track subagents`; `SessionEnd → ended, and ended sessions are dropped after 5 minutes`; `endAll ends every session`; `a secret in a prompt or in a Bash command is redacted (sk-ant-… token)`; `a sensitive command (cat ~/.ssh/id_rsa) shows only "Bash"`; `activity is capped at 30 and sessions at 5`; `garbage, unknown events, a missing session_id and a 1 MB prompt are ignored or truncated without throwing`; `changes emits the new snapshot only when something changed`.
- [ ] **Step 2: Run** `npx vitest run test/claude-watcher.test.ts`; expect FAIL (module missing).
- [ ] **Step 3: Implement** `watcher.ts` to the table in the spec. Parse defensively (`unknown` in, narrow by hand); truncate every string you keep; use `redactText` and `isSensitiveCommand`.
- [ ] **Step 4: Run** the same command; expect PASS, then `npm run typecheck`.
- [ ] **Step 5: Commit** `claude: watcher state machine for the terminal's Claude`.

### Task 2: Hooks report to the daemon; installer registers the new events

**Files:**
- Modify: `src/cli/main.ts` (`case 'hook'`), `src/core/integrations/claude.ts` (`EVENTS`, add `hooksConnected`)
- Test: `test/integrations.test.ts` (installer), `test/claude-hook-events.test.ts` (new, runs the built CLI)

**Interfaces — Produces:** `jaffer hook <arg>` with `arg ∈ session-start | user-prompt-submit | pre-tool-use | post-tool-use | post-tool-use-failure | subagent-start | subagent-stop | notification | stop | session-end`; `export function hooksConnected(home?: string): boolean` (true if any Jaffer-marked hook entry exists). Settings entries for the new events carry `async: true`; SessionStart and Stop stay synchronous.

- [ ] **Step 1: Write failing installer tests** in `test/integrations.test.ts`: `installHooks registers every event, async for the new ones, keeping the user's own hooks`; `is idempotent`; `an install with only SessionStart and Stop gets the new events and hooksInstalled turns true`; `removeHooks removes only Jaffer's entries`; `hooksConnected is true for an old two-hook install and false for none`.
- [ ] **Step 2: Write failing CLI tests** in `test/claude-hook-events.test.ts` (build the CLI like `daemon.test.ts` does): with `JAFFER_SESSION=1`, a payload on stdin and no daemon, `jaffer hook pre-tool-use` exits 0 with empty stdout in under 2 s; the same with garbage stdin; without `JAFFER_SESSION` and with `JAFFER_NO_HOOKS=1` it exits 0 and sends nothing (assert by pointing it at a tiny unix-socket server and checking no connection arrives).
- [ ] **Step 3: Run** both files; expect FAIL.
- [ ] **Step 4: Implement** the `EVENTS` list and `hooksConnected`; extend the `hook` case: forward `JSON.parse(stdin)` as `client.call('claude.event', payload, 800)` for every event when `JAFFER_SESSION === '1'` (SessionStart and Stop forward first, then keep their current memory/ingest behaviour); swallow every error.
- [ ] **Step 5: Run** both files and `npm run typecheck`; expect PASS. **Commit** `hooks: report the terminal Claude's events to the daemon`.

### Task 3: Daemon: `claude.event`, `claude.state`, staleness, startup refresh

**Files:**
- Create: `src/core/claude/transcript-watch.ts`, `test/transcript-watch.test.ts`, `test/claude-companion.test.ts`
- Modify: `src/daemon/service.ts`

**Interfaces — Consumes:** `ClaudeWatcher`, `hooksConnected`, `installHooks`. **Produces:** RPC `claude.event(payload)` → `{ ok: true }`; RPC `claude.state()` → `{ sessions: ClaudeSession[] }`; broadcast event `claude.state` with `{ sessions }`; `export function watchRejection(file: string, onRejected: () => void, opts?: { intervalMs?: number }): () => void` (returns a stop function; fires once when a new line containing `User rejected tool use` or `[Request interrupted by user` appears after the call).

- [ ] **Step 1: Write failing tests.** `transcript-watch.test.ts`: fires for each marker appended after start, not for lines already present, stops after the stop function. `claude-companion.test.ts` (bundled daemon, like the sign-in describe in `daemon.test.ts`; put it in that file's second `describe` if the build race matters): events sent through the real `jaffer hook` with `JAFFER_SESSION=1` move `claude.state` to working then idle; events from a hook without `JAFFER_SESSION` change nothing; defining `claude() { :; }` in the shell and running it ends all sessions (the `pty.command` rule); a permission Notification moves to `needs-you` and appending a rejection line to the payload's `transcript_path` returns it to idle; on daemon start an old two-hook `~/.claude/settings.json` gains the new events while the user's own hook survives.
- [ ] **Step 2: Run** both; expect FAIL.
- [ ] **Step 3: Implement** `watchRejection` (poll by size and tail). In `service.ts`: own a `ClaudeWatcher`; register the two RPCs; broadcast `claude.state` throttled to 1 per 100 ms; call `endAll()` when `pty.command` reports a command whose first word is `claude`; start `watchRejection` while a session is `needs-you` and `retractNotice` on a hit; at `start()`, if `hooksConnected(userHome)`, call `installHooks(cliWrapper, userHome)`.
- [ ] **Step 4: Run** the new tests, `npm run typecheck`, then the full `npm test`; expect PASS. **Commit** `daemon: live state of the terminal's Claude`.

### Task 4: Desktop notification when Claude needs you

**Files:**
- Create: `src/shared/notify-policy.ts`, `test/notify-policy.test.ts`
- Modify: `src/main/main.ts` (use it on the `claude.state` event)

**Interfaces — Produces:** `export function needsYouNotification(prev: ClaudeSession[], next: ClaudeSession[], ctx: { windowFocused: boolean; lastTerminalNotifyAt: number; now: number }): { title: string; body: string } | null` — non-null only when a session newly entered `needs-you`, the window is not focused, and `now - lastTerminalNotifyAt >= 10_000`; title `Claude needs you`, body the redacted notice.

- [ ] **Step 1: Write failing tests**: fires on the transition; not when already `needs-you`; not when focused; not within 10 s of a terminal notification; body is the notice.
- [ ] **Step 2: Run**; expect FAIL. **Step 3: Implement** the pure function; in `main.ts` record `lastTerminalNotifyAt` where `maybeNotify` handles `pty.notify`, keep the previous snapshot, call the policy on `claude.state` and show the notification with the existing `notify()` helper.
- [ ] **Step 4: Run** the test and `npm run typecheck`; expect PASS. **Commit** `notify: tell the user when Claude needs them`.

### Task 5: Companion panel replaces the chat panel

**Files:**
- Create: `src/renderer/components/ClaudePanel.tsx`
- Modify: `src/renderer/state.ts` (add `claudeLive`, `applyClaudeState`, focus re-check), `src/renderer/components/SessionRail.tsx` and `Chrome.tsx` (live status text), `src/renderer/styles.css` (`live-*`), the mount point of `AgentPanel` (find it in `src/renderer/app.tsx`), `test/e2e/ui.test.ts`
- Move: `SignedOutBanner` and `SetupBanner` (keyed on `claudeAuth.installed === false`, no key logic) out of `AgentPanel.tsx` into `ClaudePanel.tsx`

**Interfaces — Consumes:** RPC `claude.state` and event `claude.state` (Task 3), `claudeAuth` (existing). **Produces:** signal `claudeLive: Signal<ClaudeSession[]>`; DOM hooks for tests: `.live-pill[data-state]` (text Working / Idle / Needs you / No session), `.live-now`, `.live-needs`, `.live-activity .live-row[data-status]`, `.live-subagents`, `.live-reply`, `.live-empty`.

- [ ] **Step 1: Write failing e2e tests** (replacing the chat-driven ones that exercise the panel, listed in Task 6): inject events with `window.jaffer.call('claude.event', payload)` and assert: no session → `.live-empty` mentions running `claude`; UserPromptSubmit+PreToolUse → pill `Working` and `.live-now` shows `Bash` and the command; permission Notification → pill `Needs you` and `.live-needs` shows the message; PostToolUse+Stop → `Idle`, a `done` row, `.live-reply` text; a prompt containing `sk-ant-api03-xxxxxxxxxxxxxxxx` renders redacted; the panel has no `textarea` and no `.composer`; the sidebar's Claude row and the status bar show the live state; signed-out banner still appears at boot and after the window regains focus (dispatch `focus`) with the fake `claude` signed out.
- [ ] **Step 2: Run** the UI suite; expect FAIL on the new tests.
- [ ] **Step 3: Implement** the signals, the subscription (`claude.state` event + initial `claude.state` call in `init`), the panel and its CSS, and mount `ClaudePanel` where `AgentPanel` was. Keep `AgentPanel.tsx` in the repo for now (deleted in Task 6).
- [ ] **Step 4: Run** the UI suite and `npm run typecheck`; expect PASS. **Commit** `panel: live companion for the terminal's Claude`.

### Task 6: Remove the chat from the renderer

**Files:**
- Delete: `src/renderer/components/AgentPanel.tsx`
- Modify: `src/renderer/state.ts` (remove `thread`, `turn`, `agentStatus`, `agentUsage`, `agentEngine`, `agentReady`, `engines`, `applyAgentEvent`, `sendToAgent`, `loadThread`, `refreshKeyStatus`, the `agent.event` branch, the `LiveItem` type; replace `refreshKeyStatus` callers with `checkClaudeAuth`), `src/renderer/components/Overlays.tsx` (palette "ask" row and `sendToAgent`; the Settings `agent` section is removed and its account paragraph moves into the `Claude Code` section; onboarding `go()` no longer calls `refreshKeyStatus`), `src/renderer/actions.ts`, `Chrome.tsx`, `SessionRail.tsx`, `test/e2e/ui.test.ts`, `test/e2e/screenshots.test.ts`

- [ ] **Step 1: Update the e2e tests first.** Delete the tests that drive the chat (`talks to the agent…`, `asks for approval in the UI before writing a file…`, `the Claude panel runs on a Claude Code login…`, `a failed turn re-checks the login…`); edit `there is one Claude in the sidebar…` (one Claude row; the header button runs `claude`), `command palette runs actions…` (drop the free-text-to-agent part; assert the palette has no "ask Claude" row), `reconnecting the page…` (session and screen restored; drop the conversation part), `settings dialog…` (sections are `Appearance`, `Memory`, `Claude Code`; no `Claude` section, no key, no engine), the first-run test (drop the panel-caption assertion). Remove `JAFFER_API_ENGINE` from both bridges. Run the suite; expect FAIL where the UI still has the old pieces.
- [ ] **Step 2: Delete and edit** the files above until the suite passes; `npm run typecheck` must be clean (an unused import counts as a miss).
- [ ] **Step 3: Run** the UI suite; expect PASS. **Commit** `renderer: no chat, one Claude`.

### Task 7: Remove the chat machinery from the daemon, core, CLI and config

**Files:**
- Delete: `src/core/agent/{anthropic,assess,claude-engine,hub,prompt,runtime,thread,tools,types}.ts`, `src/shared/secrets.ts`, `test/{agent,claude-engine,provider,agent-hub,secrets}.test.ts`, `test/helpers/agent.ts`
- Modify: `src/core/agent/permissions.ts` (absorb `Risk` and `resolvePath` from `types.ts`/`tools.ts`), `src/daemon/service.ts` (remove the agent hub, engines, credentials, secrets, `toolEnv`, `agent.*` and `secrets.*` RPCs; memory `llm` becomes `this.cliLlm`), `src/cli/main.ts` (remove `ask` and the `agent.tool` branch of `mcp`; `jaffer status` unchanged), `src/core/mcp/server.ts` (remove `sessionTools` and the `session` option), `src/shared/config.ts` (remove the `agent` block and `JafferConfig['agent']` uses), `src/shared/paths.ts` (remove `thread`, `cliThread`, `secrets`; keep `agentDir`, used only to skip old panel transcripts), `test/daemon.test.ts` (delete the tests whose bodies call `agent.*` or the API engine; keep the non-agent assertions of the restart test), `test/integrations.test.ts` and `test/claude-hooks.test.ts` if they reference removed pieces
- Create: `test/permissions.test.ts` (move the permission and path-risk `describe` blocks out of `test/agent.test.ts` before deleting it)

- [ ] **Step 1: Move the permission tests** into `test/permissions.test.ts` and run them (they must pass against the current code, proving the move).
- [ ] **Step 2: Add the failing guard tests** in `test/daemon.test.ts`: the daemon has no `agent.send`, `agent.thread`, `secrets.status` methods (`unknown method`), and `jaffer ask` is an unknown command.
- [ ] **Step 3: Delete and edit** until `npm run typecheck` is clean; remove the dead `memory` code paths only if the compiler flags them (do not refactor memory).
- [ ] **Step 4: Run** `npm test` (twice, flaky list in Global Constraints) and the UI suite; expect PASS. **Commit** `core: remove the chat engine, the API engine and key storage`.

### Task 8: Docs, rules, and screenshots

**Files:**
- Modify: `README.md` (the panel, "Two Claudes" section → "One Claude", shortcuts, the verification section), `docs/ARCHITECTURE.md` (replace "Two engines behind one panel" with the companion architecture), `CLAUDE.md` (Layout and rules per the spec's "Rules this changes"), `docs/SIGN-ON-MAC.md` section 5 (the Claude checklist items), `docs/superpowers/specs/2026-10-07-terminal-claude-companion-design.md` (the two refinements), `test/e2e/screenshots.test.ts` (demo scenes driven by injected hook events instead of a scripted chat), `docs/screenshots/*.png`

- [ ] **Step 1: Rewrite the screenshots scenes** (first run, terminal with Working, Needs you, Memory, palette/themes/settings, long-running) using `claude.event` injection; run it with `TMPDIR=/tmp/jd` and the macOS shell path (temporary local edit, reverted) and confirm it passes.
- [ ] **Step 2: Regenerate** `docs/screenshots` as one consistent set, run `scripts/shrink-screenshots.py` as the README says, and check each image by eye.
- [ ] **Step 3: Edit the docs and rules**; `grep -rniE "api key|ask the built-in|chat|composer|/compact|jaffer ask" README.md docs CLAUDE.md` must show nothing stale.
- [ ] **Step 4: Commit** `docs: one Claude`.

### Task 9: Whole-branch verification

- [ ] **Step 1:** `npm run typecheck && npm test` three times; `JAFFER_CHROME=… npx vitest run --config vitest.e2e.config.ts test/e2e/ui.test.ts` once. Record every failure by name and whether it also fails on `main`.
- [ ] **Step 2:** Real Claude Code acceptance, in an isolated HOME with the mock API: connect hooks (`setup.claude.install`), run one turn with a read-only tool inside the daemon's shell, and watch `claude.state` go idle → working → idle (add as a skip-if-no-`claude` test in `test/claude-companion.test.ts` if Task 3 could not).
- [ ] **Step 3:** Report to the user what was verified, what was not (real API behaviour, the real macOS window), and wait for their decision on the release.
