# Architecture

```
┌────────────────────────── Jaffer.app (Electron) ───────────────────────────┐
│ main process: window, menu, dock, notifications, global hotkey, IPC relay   │
│ renderer: Preact + xterm.js (WebGL) · mole · memory drawer · palette        │
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

## One Claude, and a quiet reflection of it

There is one Claude in Jaffer: the `claude` running in the terminal. Jaffer has no chat of its own and runs no model of its own (memory curation goes through `claude -p`, on the user's Claude login). The mole, the title-bar ring and a desktop notification reflect what Claude Code is doing, fed by Claude Code's own hooks. There is no panel and no chat.

- **Events in.** `jaffer setup claude` (or the first-run consent, or a daemon start with an older install) registers hooks in `~/.claude/settings.json`: SessionStart and Stop (which feed memory, so Claude Code waits for them) and, `async`, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, SubagentStart, SubagentStop, Notification, SessionEnd. Each runs `jaffer hook <event>`, which does nothing unless `JAFFER_SESSION=1` (the shell Jaffer hosts exports it), forwards the JSON payload to the daemon as `claude.event`, prints nothing and exits 0 on every path, so Claude Code behaves exactly as without Jaffer when the daemon is down or slow.
- **State.** `ClaudeWatcher` (`src/core/claude/watcher.ts`) is a pure state machine per `session_id`: `idle`, `working`, `needs-you` or `ended`, the tool being run, the last 30 tool calls of the turn, subagents, a redacted prompt preview and last reply. Hooks are asynchronous and can arrive out of order, so only UserPromptSubmit and PreToolUse move a session to `working`, and a permission Notification only counts while a tool is pending. Everything it keeps passes `redact.ts`; sensitive commands show only the tool name.
- **Staleness.** Declining a prompt or pressing Esc in the terminal fires no hook (and Esc no `Stop`), so while a session is `working` or `needs-you` the daemon reads the tail of its transcript (`transcript-watch.ts`) for the person's own "User rejected tool use" / "[Request interrupted by user" entry (`isStopLine`: the user side only, text starting with the marker, so the same words in code or command output do not count) and calls `ClaudeWatcher.interrupted`. A sweep every 30 s is the safety net for a turn that ended with no signal at all: `working` with no hook for 5 minutes (30 with a tool running) and a transcript that is not growing becomes idle; `needs-you` is never swept. The `claude` command finishing in the shell ends every session, which also covers a crashed Claude Code.
- **Cost.** When `claude.showCost` is on, the daemon notes the size of the transcript at `UserPromptSubmit` and, at `Stop`, reads what was written since (`core/claude/cost.ts`, up to the end it measured, so a response Claude gives later without a prompt is measured from there). `shared/claude-cost.ts` sums the `usage` of each model response once per message id (Claude Code writes one line per content block, all carrying the same usage) and prices it from a table of Anthropic's list prices (cache reads and 5-minute and 1-hour cache writes separately; fast mode and US-only inference where the model has them). A model id the table does not know exactly (a dated snapshot is fine, `claude-opus-5-6` is not `claude-opus-5`) gets tokens and no dollars, never the nearest price. Only numbers are kept: `ClaudeSession.cost` holds the last answer's tokens and dollars and the session total; no text from the transcript reaches memory, the state or the UI. Background agents' own usage is not in the main transcript's totals. The title bar shows it (`CostChip`); the price table is the one thing to update when Anthropic changes prices or adds a model.
- **Surface.** RPC `claude.event` (from hooks), `claude.state` (snapshot) and the pushed event `claude.state` (throttled to one per 100 ms). The state lives in the daemon, so it survives quitting the app. When a session newly needs the user and the window is not in front, the main process shows a notification (`notify-policy.ts`), unless a terminal notification was just shown.
- **Not built yet:** answering Claude Code's permission prompts from Jaffer (a blocking permission hook, allow only after a click, any failure leaving Claude Code's own dialog in charge), and diffs from the transcript.

## Memory

See the README for the lifecycle. Storage is plain files under `~/.jaffer/memory`: `items.jsonl` (source of truth), `skills.jsonl`, `journal.jsonl` (every mutation with before/after), `episodes/YYYY-MM-DD.jsonl` (raw, pruned after 45 days), generated `MEMORY.md` and per-skill markdown, and your `NOTES.md` / `POLICY.md`.

Ranking = confidence × time-decay (half-life per kind) × usage × scope relevance (global vs the project you are in) × BM25 match to the current request.

## Process boundaries and trust

The renderer is sandboxed (`contextIsolation`, no Node) and only reaches the daemon through the preload bridge; the main process checks the sender frame. Hook payloads and everything fed to memory or a model are redacted first.

## Updates

`src/main/updates.ts` (`UpdateController`) drives `electron-updater` against the GitHub releases and decides nothing about the outside world itself: the updater, the dialog and ending the session are injected, so it is tested with fakes (`test/update-controller.test.ts`). `src/shared/update-policy.ts` holds the pure parts (prompt wording, when to ask, version checks, reading `codesign` output). The flow is check → download in the background → **ask** (native dialog) → on yes, end the session through the daemon (`app.shutdown`) and `quitAndInstall`. `autoInstallOnAppQuit` is off on purpose: quitting must never replace the app behind a running session. Only a packaged, Developer ID signed app checks (the bundle's signature is read at startup), only non-prerelease releases count, and errors are logged to `~/.jaffer/updater.log` and shown in Settings, never as a dialog unless the user asked. The release side is `scripts/release-mac.sh`: it checks `latest-mac.yml` and uploads it after everything it names.

## The window

The renderer is a terminal card on a canvas, with a thin title bar above (folder, branch, what is running, a Memory button) and, on demand, one drawer on the right: memory. Colours come from layered tokens derived from the active theme (`themes.ts`): `--chrome` is the canvas, `--surface` the card on it, `--raised` things on that. A theme change repaints the whole app.

- The title bar reads `session.info` (folder, branch) and keeps itself live from `pty.start`, `pty.command` and `pty.cwd` events. The ring beside the folder is `processBadge` (`src/shared/process-badge.ts`): an ordinary command spins while it runs; Claude Code spins only while its hooks say it is working.
- The mole (`Pet.tsx`, `src/shared/pet-mood.ts`) is an SVG in a corner of the terminal card. Every pose is a `[data-mood]` state (sleep, rest, dig, alert, cheer), so it is right with Animations off too; the motion is added only under `:root:not([data-motion='off'])` and stops under macOS Reduce motion. It ignores pointer events. A helper mole stands for each running subagent (`ClaudeSession.subagents`, at most three, `src/shared/pet-crew.ts`); a helper whose agent finished cheers for a moment and leaves. Effort grows with time (`src/shared/pet-effort.ts`: 30 s, 2 min, 5 min since the turn or the command started, or since the helper's own `SubagentStart`; `ClaudeSubagent.startedAt`, `info.busySince`): `data-effort` 0–3 sets the digging tempo (`--t`) and adds the sweat drop, the hard hat and a bigger pile, all static under Animations off. Background agents outlive the turn that started them, so `Stop` does not end them: `SubagentStop`, the session ending, or half an hour of silence does.
- Memory notices (`src/shared/memory-toast.ts`) interrupt only for something new learned or a memory the person asked for; housekeeping stays in the drawer's Activity log.
