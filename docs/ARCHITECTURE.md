# Architecture

```
┌────────────────────────── Jaffer.app (Electron) ───────────────────────────┐
│ main process: window, menu, dock, notifications, global hotkey, IPC relay   │
│ renderer: Preact + xterm.js (WebGL) · Claude panel · memory panel · palette │
└───────────────▲─────────────────────────────────────────────────────────────┘
                │ unix socket (NDJSON RPC + events), ~/.jaffer/run/jafferd.sock
┌───────────────┴────────── jafferd (detached, survives the app) ─────────────┐
│ SessionHost ── PtySession ── node-pty ── your login shell (zsh/bash/fish)   │
│     │             └ headless xterm: screen snapshots, OSC 133/633 parsing    │
│ MemoryEngine ── EpisodeLog → heuristics / model reflector → MemoryStore     │
│     │              (journal, decay, consolidate, skills, exports)            │
│ ClaudeWatcher ── live state of the terminal's Claude, from its hook events   │
│ ClaudeIngestor · ClaudeLogin / claudeAuth · config                           │
└───────────────▲─────────────────────────────────────────────────────────────┘
                │ same RPC
   jaffer CLI ──┴── jaffer mcp (stdio MCP server for Claude Code) ── hooks
```

## Why a daemon

The shell must outlive the window. `jafferd` is spawned detached by the app (the app's own binary with `ELECTRON_RUN_AS_NODE=1`, so no separate Node install is needed). The app, the CLI, the MCP server and Claude Code hooks are all just clients of one socket (mode 0600 in a 0700 directory).

## One session

There is one shell, and the code makes it the only one: `SessionHost` runs a single `PtySession` (`main`), refuses to spawn any other, and ignores extra panes an older state file might list; the daemon has no RPC to open or close one (`pane.list` only reports it). The UI has no tabs, splits or extra windows. If the shell exits (`exit`, a crash, *Restart Shell*) the host starts a fresh one in the same folder with the previous screen restored. Only *Quit and End Session* (`⌥⌘Q`) ends it, on purpose.

## Terminal fidelity and re-attach

PTY output is parsed by a headless xterm.js in the daemon *before* it is emitted to clients. A client attaches with `session.attach`, which waits for the write queue to drain and returns `serialize()` output (screen + scrollback + alt-screen + modes) plus a sequence number; every later `pty.data` event carries `seq`, so the renderer drops anything already covered by the snapshot and re-attaches on any gap. Slow clients are resynchronised from a snapshot instead of buffering without bound.

Shell integration scripts (`resources/shell`, embedded into `src/generated`) hook zsh (`ZDOTDIR` shim that sources your real dotfiles), bash (`--init-file`, bash 3.2 compatible) and fish. They emit OSC 133 (`A` prompt, `C` output start, `D;<exit>`) and OSC 633 (`E` command line, `P;Cwd=`). From those the daemon knows when the shell is idle, what ran, with what exit code and output, and can type a command into the live shell and wait for it.

## One Claude, and a live panel for it

There is one Claude in Jaffer: the `claude` running in the terminal. Jaffer has no chat of its own and runs no model of its own (memory curation goes through `claude -p`, on the user's Claude login). The right-hand panel is a read-only companion fed by Claude Code's **hooks**.

- **Events in.** `jaffer setup claude` (or the first-run consent, or a daemon start with an older install) registers hooks in `~/.claude/settings.json`: SessionStart and Stop (which feed memory, so Claude Code waits for them) and, `async`, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, SubagentStart, SubagentStop, Notification, SessionEnd. Each runs `jaffer hook <event>`, which does nothing unless `JAFFER_SESSION=1` (the shell Jaffer hosts exports it), forwards the JSON payload to the daemon as `claude.event`, prints nothing and exits 0 on every path, so Claude Code behaves exactly as without Jaffer when the daemon is down or slow.
- **State.** `ClaudeWatcher` (`src/core/claude/watcher.ts`) is a pure state machine per `session_id`: `idle`, `working`, `needs-you` or `ended`, the tool being run, the last 30 tool calls of the turn, subagents, a redacted prompt preview and last reply. Hooks are asynchronous and can arrive out of order, so only UserPromptSubmit and PreToolUse move a session to `working`, and a permission Notification only counts while a tool is pending. Everything it keeps passes `redact.ts`; sensitive commands show only the tool name.
- **Staleness.** Declining a prompt or pressing Esc in the terminal fires no hook (and Esc no `Stop`), so while a session is `working` or `needs-you` the daemon reads the tail of its transcript (`transcript-watch.ts`) for the person's own "User rejected tool use" / "[Request interrupted by user" entry (`isStopLine`: the user side only, text starting with the marker, so the same words in code or command output do not count) and calls `ClaudeWatcher.interrupted`. A sweep every 30 s is the safety net for a turn that ended with no signal at all: `working` with no hook for 5 minutes (30 with a tool running) and a transcript that is not growing becomes idle; `needs-you` is never swept. The `claude` command finishing in the shell ends every session, which also covers a crashed Claude Code.
- **Surface.** RPC `claude.event` (from hooks), `claude.state` (snapshot) and the pushed event `claude.state` (throttled to one per 100 ms). The state lives in the daemon, so it survives quitting the app. When a session newly needs the user and the window is not in front, the main process shows a notification (`notify-policy.ts`), unless a terminal notification was just shown.
- **Not built yet:** answering Claude Code's permission prompts from the panel (a blocking permission hook, allow only after a click, any failure leaving Claude Code's own dialog in charge), and usage and diffs from the transcript.

## Memory

See the README for the lifecycle. Storage is plain files under `~/.jaffer/memory`: `items.jsonl` (source of truth), `skills.jsonl`, `journal.jsonl` (every mutation with before/after), `episodes/YYYY-MM-DD.jsonl` (raw, pruned after 45 days), generated `MEMORY.md` and per-skill markdown, and your `NOTES.md` / `POLICY.md`.

Ranking = confidence × time-decay (half-life per kind) × usage × scope relevance (global vs the project you are in) × BM25 match to the current request.

## Process boundaries and trust

The renderer is sandboxed (`contextIsolation`, no Node) and only reaches the daemon through the preload bridge; the main process checks the sender frame. Hook payloads and everything fed to memory or a model are redacted first. `permissions.ts` keeps the command and path risk rules (read-only / ordinary / risky / blocked) for the approval cards of a later release.

## Updates

`src/main/updates.ts` (`UpdateController`) drives `electron-updater` against the GitHub releases and decides nothing about the outside world itself: the updater, the dialog and ending the session are injected, so it is tested with fakes (`test/update-controller.test.ts`). `src/shared/update-policy.ts` holds the pure parts (prompt wording, when to ask, version checks, reading `codesign` output). The flow is check → download in the background → **ask** (native dialog) → on yes, end the session through the daemon (`app.shutdown`) and `quitAndInstall`. `autoInstallOnAppQuit` is off on purpose: quitting must never replace the app behind a running session. Only a packaged, Developer ID signed app checks (the bundle's signature is read at startup), only non-prerelease releases count, and errors are logged to `~/.jaffer/updater.log` and shown in Settings, never as a dialog unless the user asked. The release side is `scripts/release-mac.sh`: it checks `latest-mac.yml` and uploads it after everything it names.

## The window

The renderer is three layers on a canvas: a **session rail** (left), the **terminal card** (centre) and the **inspector** (right: the Claude panel or memory), with a toolbar above and a status bar below. Colours come from layered tokens derived from the active theme (`themes.ts`): `--chrome` is the canvas, `--surface` the cards on it, `--raised` cards on those. A theme change therefore repaints the whole app.

- The rail reads `session.info` (project, branch, uptime, and the daemon's ring of recent commands, which is redacted and omits sensitive commands) and keeps itself live from `pty.start`, `pty.command` and `pty.cwd` events. Because the daemon owns this state, the rail looks the same after you quit and reopen the app.
- Command stripes are xterm decorations created from the OSC 133 sequences the shell integration already emits (`A` prompt, `C` output, `D;exit`). They live in the renderer only; the daemon's snapshots and the scrollback are untouched.
- The Claude panel renders `claude.state` only: no prompt box, no thread. File paths are shown relative to where Claude is working (`shortToolPath`).
