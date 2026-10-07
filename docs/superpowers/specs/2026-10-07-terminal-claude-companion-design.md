# One Claude: the terminal's Claude, with a live companion panel

Date: 2026-10-07 · Status: approved in conversation (design), written spec follows the user's go-ahead to build.

## Why

Jaffer has two ways to talk to Claude: the real `claude` in the terminal and a separate chat in the side panel, run by
a background `claude -p` process. They are two unrelated conversations, which reads as "two Claudes". Jaffer is a
terminal for Claude Code, so there should be exactly one Claude: the one in the terminal. The panel stops being a
second chat and becomes a **live companion** to the terminal's Claude.

Decisions made with the product owner:

1. **No prompt box.** You talk to Claude only in the terminal. The panel is read-only.
2. **Delete the panel's chat machinery** (not dormant): chat UI, the background Claude process, the API-key engine,
   `jaffer ask`, the palette "ask Claude" row, the terminal-typing MCP tools, the `agent.*` RPCs and settings.
3. **First release = status and notifications.** Approval cards (answering the terminal Claude's permission prompts
   from the panel) and usage/diffs come in later releases.
4. Subscription only (already shipped on this branch): no API key anywhere.

## What the panel shows (v1)

A companion for the Claude running in Jaffer's one terminal:

- **Status pill** in the panel header and the sidebar row: `Working`, `Idle`, `Needs you`, or `No session`.
- **Now**: the tool being run (`Bash · npm test`, `Edit · src/a.ts`).
- **Needs you** banner with Claude Code's own notification message, when it is waiting on a permission prompt.
- **Activity**: the last 30 tool calls of the current turn (name, short summary, running/done/failed, duration).
- **Subagents** that are running or finished.
- **Last reply**: the end of Claude's last message (trimmed, redacted).
- **No session**: "Claude Code isn't running. Run `claude` in the terminal (⇧⌘C)."
- Existing banners stay: not installed (install command), signed out (Sign in).
- Desktop notification when Claude needs you and the window is not focused.

There is no composer, no thread, no slash commands. The right-hand area still toggles between this panel and Memory.

## How it knows: Claude Code hooks

Jaffer already installs two hooks (SessionStart, Stop) into `~/.claude/settings.json` when the user connects Claude Code
(reversible with `jaffer setup claude --remove`). v1 extends the same mechanism with more events.

**Events** (all `async: true`, so Claude Code never waits for them): SessionStart, UserPromptSubmit, PreToolUse,
PostToolUse, PostToolUseFailure, SubagentStart, SubagentStop, Notification, Stop, SessionEnd. SessionStart and Stop keep
their current behaviour (memory injection, transcript ingestion) and also report.

**`jaffer hook <event>`** (src/cli/main.ts), for the new events:

- does nothing unless `JAFFER_SESSION=1` (the shell Jaffer hosts exports it), so a `claude` run in another terminal is
  never reported, and does nothing when `JAFFER_NO_HOOKS` is set;
- reads the JSON payload from stdin, forwards it to the daemon as RPC `claude.event` with a short timeout;
- prints nothing and exits 0 on every path (daemon down, bad JSON, timeout): Claude Code behaves exactly as it does
  without Jaffer. It must stay fast (measured ~90 ms without a daemon).

**Payload facts** (observed against Claude Code 2.1.292; the docs differ in places, so parse defensively and ignore
unknown fields). Every event has `session_id`, `hook_event_name`, `cwd`, `transcript_path`, and mostly `prompt_id`:
`UserPromptSubmit.prompt`; `PreToolUse` / `PostToolUse` `tool_name`, `tool_input`, `tool_use_id`, PostToolUse also
`tool_response`, `duration_ms`; `SubagentStart/Stop` `agent_id`, `agent_type`; `Stop.last_assistant_message`;
`Notification.message` (the permission notification is "Claude needs your permission", fired about 6 s after the
dialog appears, so it is a nudge, not an instant signal; an idle notification fires 60 s after Stop).

## Daemon: `ClaudeWatcher` (src/core/claude/watcher.ts)

Pure state machine plus a small event emitter, no I/O of its own, so it is unit-testable with captured payloads.

State per `session_id`: `{ id, cwd, model?, state, since, prompt?, tool?, activity[], subagents[], lastReply?, notice? }`
with `state ∈ idle | working | needs-you | ended`. All text that leaves the watcher is redacted
(`src/shared/redact.ts`); commands are shown through the same rules as `safeCommand()`, and sensitive commands
(`isSensitiveCommand`) show only the tool name. Prompts that start with `<task-notification>` are ignored.

Transitions:

| Event | Effect |
|---|---|
| SessionStart | create or reset the session, `idle`, record `model` |
| UserPromptSubmit | `working`; keep a ≤120 char redacted prompt preview; clear `notice` |
| PreToolUse | `working`; set `tool`; push an activity entry `running` |
| PostToolUse | entry → `done` (duration); clear `tool`; clear `notice` |
| PostToolUseFailure | entry → `failed` |
| Notification | permission-type message → `needs-you` with `notice`; idle-type → stays `idle`; others ignored |
| SubagentStart / Stop | add / finish a subagent entry |
| Stop | `idle`; `lastReply` = trimmed redacted `last_assistant_message`; clear `tool`, `notice` |
| SessionEnd | `ended` |

**Staleness.** A `needs-you` state must not stick when the user answers in the terminal, because declining a prompt
fires no hook (observed). `needs-you` therefore also clears on: the next PreToolUse/PostToolUse/Stop/UserPromptSubmit,
and, while in `needs-you`, a transcript line recording the rejection (`User rejected tool use` or
`[Request interrupted by user`), found by polling the session's `transcript_path` every 500 ms (only in that state).
All sessions become `ended` when the shell reports that the `claude` command finished (existing `pty.command` event),
which also covers a crashed Claude Code. Ended sessions are dropped after 5 minutes; at most 5 sessions are kept.

**Surface.** RPC `claude.event` (from hooks), RPC `claude.state` (current snapshot, for a freshly attached app) and
event `claude.state` (pushed on every change, throttled to one per 100 ms). The state survives quitting the app because
the daemon owns it; it is not persisted across a daemon restart (a restart ends the shell too).

**Notifications.** When a session enters `needs-you` and the window is not focused, the main process shows a desktop
notification ("Claude needs you", the notice text), unless a terminal (OSC 9) notification was shown in the previous
10 s, so the user never gets two for one event.

## Renderer

- `ClaudePanel.tsx` replaces `AgentPanel.tsx` (chat, composer, slash commands, approval cards for the old engine all
  go). The sign-in and install banners move over unchanged.
- State in `state.ts`: `claudeLive` signal fed by `claude.state`; a status line in the sidebar's Claude row and the
  status bar. No class named after a state is added to a global selector (state lives in `data-state`).
- Memory panel, sidebar, command palette (minus "ask Claude"), first-run flow and Settings stay; Settings loses the
  panel-only options (approvals, run commands, model) and keeps the Claude Code integration section.

## Deleted

`ClaudeCodeEngine` and `claude-engine.ts`, `AgentRuntime`, `AnthropicProvider`/`anthropic.ts`, `AgentHub`, the thread
store, `prompt.ts`, `permissions.ts`/`tools.ts` (the terminal-typing tools; `assess.ts` stays for later approval
cards), `jaffer mcp --session` and its `run_command` / `read_terminal` tools, the `agent.*` and `secrets.*` RPCs,
`src/shared/secrets.ts`, `jaffer ask`, the `agent` config block (except what the integration still needs), the
renderer chat code, and the tests of all of that. Kept: memory engine and panel, `jaffer mcp` (memory tools for
Claude Code), ingestion, `ClaudeCliLlm` curation, sign-in (`claude-auth.ts`), first run, the hooks, `assess.ts`,
`redact.ts`. Old saved chat files in `~/.jaffer` are left on disk, not deleted.

## Migration

Existing installs get the new hook events without any click: when Claude Code is connected, the daemon re-runs the
idempotent `installHooks` at startup, replacing only Jaffer's own marked entries. Configs that still carry `agent.*`
keys keep loading; unused keys are ignored.

## Rules this changes (CLAUDE.md)

The rules about the panel's Claude Code engine answering `can_use_tool`, never auto-allowing, and the terminal tools no
longer apply (the engine is gone). They are replaced by: hooks report only inside a Jaffer session, never block Claude
Code, and print nothing; nothing Jaffer shows from a hook payload skips redaction; and (for the approvals release)
Jaffer only ever answers a permission prompt **allow** after a human click, **deny** is always safe, and any failure
leaves Claude Code's own prompt in charge.

## Testing

- **Watcher**: table-driven tests using real payloads captured in the spike (stored as fixtures), covering every
  transition, redaction, `<task-notification>` prompts, sensitive commands, the staleness rules and the caps.
- **Hook CLI**: the real built `jaffer hook` binary with and without `JAFFER_SESSION`, with a dead daemon (silent,
  fast, exit 0), with garbage stdin.
- **Daemon**: events sent through the real `jaffer hook` reach `claude.state`; shell `claude` exit ends sessions.
- **Installer**: `installHooks` adds all events, keeps the user's own hooks, is idempotent, and `removeHooks` undoes it.
- **Real Claude Code**: the existing real-`claude` + mock API setup, hooks installed in an isolated config, one turn
  with a tool call, asserting the state sequence idle → working → idle.
- **UI end to end**: the panel goes `No session` → `Working` → `Needs you` → `Idle` from injected events, shows the
  activity and the notice, has no composer, and the first-run, Settings and sign-in tests still pass.
- Deleted code takes its tests with it; the rule tests (one session, one terminal) stay.

## Later releases

2. Approval cards: a blocking permission hook that shows the real, redacted request in the panel and answers allow or
   deny only after a click (spike: works, the user can still answer in the terminal first, any failure leaves Claude
   Code's dialog). 3. Usage, cost and diffs from the transcript. Streaming text is only paragraph-level, so it is not
   planned.

## Not verified (from the spike)

Behaviour against the real Anthropic API (the spike used a mock), "Always allow" persistence, Edit-tool diffs, prompts
inside subagents, auto/bypass permission modes.

## Changes made while building

- `assess.ts` was deleted with the panel's tools (it only knew their names); `permissions.ts` (the generic command and path risk rules) stays and now owns the `Risk` type. `resolvePath` was not kept.
- The lapsed-login banner is re-checked at startup and when the window regains focus (always while signed out, at most once a minute while signed in; `src/shared/auth-recheck.ts`), because there are no panel turns any more.
- `Last reply` keeps the start of the reply (a preview), not its tail. A late `PostToolUse` never turns an idle session back to `working`, and a permission `Notification` only counts while a tool is pending, because async hooks can arrive out of order.
- File paths in the panel are shown relative to the session's working directory, abbreviated when long and elsewhere (`src/shared/short-path.ts`), with the full path on hover.
- The `@anthropic-ai/sdk` dependency was removed; model curation runs only through `claude -p`.
- Esc fires no hook, and no `Stop` either, so a turn the person interrupted used to stay `Working` for ever. The daemon now reads the session's transcript while it is `working` (not only while it is `needs-you`) for the person's own "[Request interrupted by user" / declined-prompt entry (`isStopLine`: user side only, text must start with the marker, so the same words in code or command output do not count). A sweep every 30 s is the safety net: `working` with no hook for 5 minutes (30 with a tool running) and a transcript that is not growing becomes idle, and rows still `running` when a turn ends are settled (done at `Stop`, failed when interrupted).
- The README screenshots were regenerated as one set (`02-companion.png`, `03-needs-you.png`, `12-claude-code-settings.png` replace the chat images).

