# 1.0.0: forty features for the best terminal on macOS

Date: 2026-10-13 · Status: the owner asked for all forty ideas from the conversation ("do all 40, implement, commit, push, upload new build and release it with major version bumped"), with no review stop ("I don't want to review, start implementing"). This document turns the list into rules an implementer can follow and records the rulings where an idea meets an existing rule. Facts about the code: the feature map in the plan's workspace (`feature-map.md`).

## Owner's ask overrides two old rules, deliberately
- The calm-window rule ("no command stripes, no status bar") is relaxed by this ask for exactly these additions: command blocks with a gutter mark, a 2 px tool strip under the title bar, a sticky command header, up to three pinned lines, an opt-in resource strip in the title bar, chips in the title bar. Still forbidden: sidebars, drawers, panels, tabs, splits, second windows, a chat box.
- The watcher's privacy rule ("no file names") is narrowed: the watcher may keep, **in memory only and for the current session**, the paths of files Claude Code **edits or writes** (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`: `tool_input.file_path` / `notebook_path`), redacted by `redactText`, and never a path that `isSensitivePath` (new, bounded) flags (`.ssh/`, `.gnupg/`, `.aws/`, `.env*`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `credentials*`, `*.keychain*`, `.netrc`, `.npmrc`, `.pypirc`). It may keep tool **names**, per-turn call counts and timings, and whether a call failed. Still never: prompts, replies, commands' text, tool arguments other than that one path, agent descriptions.
- Nothing new is written to `~/.jaffer` except keys in `config.json`. Command history, pinned lines, the sparkline, the daily cost and the hook-health table live in memory and end with the app.
- The only thing Jaffer types into the shell stays `claude`. Every new action that "re-runs", "opens" or "pastes" works through the clipboard, Finder, the browser, an editor URL or a save dialog.

## The forty features (numbering from the conversation; where a feature is changed or dropped, the ruling says why)

### Companion and title bar
1. **Companion reacts to the tool.** The mole and every scene get a `data-tool` category from the live session's tool: `shell` (Bash), `read` (Read, Grep, Glob, LS, NotebookRead), `write` (Edit, Write, MultiEdit, NotebookEdit), `web` (WebFetch, WebSearch), `agent` (Task, Agent), `other`. The mole shows a prop per category (digging, a book, a hammer, an antenna); scenes change hue or rhythm. Pure mapping function `toolCategory(name)` with tests.
2. **Turn progress on the ring.** While Claude works, the ring fills against the typical turn length (`claude.typicalTurnMs`, a running median kept in config: updated after each finished turn, ignoring turns under 3 s). No typical length yet: plain spin. Past it: the ring stays full and pulses.
3. **Live token ticker.** While a turn runs and `claude.showCost` is on, the daemon reads the transcript usage from the turn start every 2 s (existing `readTurnCost`, bounded) and puts `live: {input, output, usd?}` on the session; the cost chip shows it greyed ("≈ $0.03 so far"), with the estimate wording.
4. **Subagent lanes.** Helpers stay as today (max 3, wave off on stop). When a hook payload inside a subagent carries `agent_id`, its tool name is attributed to that subagent and the helper shows the category prop. The ring tooltip lists running agents with elapsed time.
5. **Idle dozing.** After 10 minutes with no Claude activity and no command, the companion dozes (dimmer, slower: `data-idle="doze"`); any activity wakes it.
6. **Tool strip.** A 2 px strip under the title bar shows the current turn's tool calls as segments coloured by category (failure: danger colour), widths by duration; hover a segment: tool name and duration. Cleared at the next prompt. `claude.toolStrip` switch.
7. **Command blocks.** The renderer parses the shell marks (OSC 133 A/C/D, 633 E) on its own xterm parser and keeps a block per command: prompt line, output start and end markers, command text (shown only through `safeCommand`), exit code, start and end time. Hovering a block's gutter mark highlights its output; ⌘↑ / ⌘↓ jump between prompts; a click on the gutter mark selects the output. **Ruling:** collapsing output is dropped (xterm has no folding). Blocks exist for output received since the window attached; after a re-attach or reset they start again (snapshots carry no marks).
8. **Exit-code gutter.** A thin mark left of each block's prompt line: `--ok` for exit 0, `--danger` for non-zero, `--faint` while running or unknown. Right-click: Copy command (the raw text to the person's own clipboard; not offered for a command `isSensitiveCommand` flags), Copy output, Save output… (feature 22), Copy as Markdown (feature 27).
9. **Long command, back at the window.** When the window regains focus and a command of 30 s or more finished while it was away, a toast: `make finished in 4m 12s (exit 0)` (command through `safeCommand`).
10. **Paste guard.** Pasting two or more lines shows a one-line bar over the terminal: "Paste 14 lines?" with the first line (clipped to 80 chars), **Paste** (Enter) / **Cancel** (Esc). `terminal.pasteGuard` switch (default on). Drag-and-drop of files is unchanged.
11. **Clickable paths.** A link provider finds `path`, `path:line` and `path:line:col` (absolute, `~/`, or relative to the block's or the session's folder) in the visible lines (bounded per line). ⌘-click: when `terminal.editorUrl` is set (a template like `vscode://file/{path}:{line}:{col}`; allowed schemes: vscode, vscode-insiders, cursor, windsurf, zed, idea, subl, txmt) the app opens that URL; otherwise it reveals the file in Finder. Never `shell.openPath` on a printed path (a printed path to a script must not run).
12. **Inline images.** The image addon (sixel, iTerm IIP) stays on; a `terminal.images` switch turns it off. Kitty graphics are not supported (the addon has none): documented.

### Claude Code
13. **Needs-you in the title bar.** While a session needs you, the pill shows the tool name and the notice (already redacted, clipped to 60 chars) beside an alert dot. Read-only: Jaffer never answers.
14. **What Claude touched.** At the end of a turn the summary toast (feature 31) lists the files edited or written in that turn (basenames, up to 5, "+N more"); clicking one reveals it in Finder.
15. **Cost budget.** `claude.dailyBudgetUsd` (0 = off). The daemon keeps today's estimated total in memory (resets at local midnight and when the app quits); the chip turns `--warn` past 80 % and `--danger` past 100 %, and its tooltip says "today ≈ $x of $y (an estimate at API list prices; a subscription is not billed per token)".
16. **Turn sparkline.** Hovering the cost chip shows the last 20 turns as two small sparklines (duration, cost), drawn in SVG from memory.

### Visual polish
17. **Theme follows macOS or the time of day.** `appearance.autoTheme`: `off` | `system` (follows `prefers-color-scheme`) | `time` (light 07:00–19:00 local). Light uses `appearance.lightTheme` (default `jaffer-light`), dark uses `appearance.theme`. Crossfade 1 s (none with animations off or reduced motion).
18. **Window glow.** A soft inner glow on the window edge: pulse `--warn` while Claude needs you, steady `--ok`-tinted while working, one `--accent` flash when a turn finishes. `appearance.glow` switch; off with animations off.
19. **Folder pill morph.** When the folder changes, the old name slides out and the new one in (200 ms); none with animations off.
20. **Fixed it!** When a command that failed three or more times in a row (same command text, this session) now exits 0, a short particle burst plays in the companion corner (CSS only; none with animations off or reduced motion).

### Terminal power
21. **Search hit-map.** The find bar shows "3 of 41", ⌘G / ⇧⌘G go to the next and previous match (also while the bar is closed, for the last query), and matches are marked on the terminal's overview ruler (`overviewRuler.width` set).
22. **Save output.** From the gutter menu: a save dialog (main process, new trusted IPC `jaffer:save-text`) writes that block's output as plain text to the file the person picks. Max 32 MB; Jaffer keeps nothing.
23. **Recent commands (⌘R).** A palette-like list of this session's commands (up to 200, newest first, from `pty.command`, through `safeCommand`, sensitive ones left out, never written to disk). Enter copies the chosen command to the clipboard and says so; nothing is typed.
24. **Times on hover.** Hovering a gutter mark shows the start time and the duration.
25. **Column ruler.** `terminal.ruler`: 0 (off), 80, 100 or 120: a faint vertical line at that column. **Ruling:** the soft-wrap toggle is dropped (xterm always wraps; there is no horizontal scroll).
26. **Sticky command header.** When scrolled up into a block's output, the block's command (through `safeCommand`) and its exit mark stay pinned at the top of the terminal card; click scrolls to the prompt.
27. **Copy as Markdown.** ⌥⌘C copies the selection inside a fenced code block; when the selection is inside one block, the first line is `$ <command>` (through `safeCommand`). A toast says "Copied as Markdown".
28. **Bell.** A bell makes the companion flinch and, when the window is not focused, bounces the Dock icon once (informational). The terminal flash stays.

### Claude Code, more
29. **Approval memory hint.** In the needs-you title-bar badge: how many times this session a prompt for that tool was answered ("Bash · 4th time"). Memory only.
30. **Editing chip.** While Claude runs `Edit`/`Write`/`MultiEdit`/`NotebookEdit`, the title bar shows the file's basename beside the ring; a click reveals the file in Finder (`jaffer:reveal-path`: an existing absolute path, `shell.showItemInFolder` only, which never opens or runs a file).
31. **Turn summary.** When a turn ends (not cut short, at least 10 s long): a toast "Claude finished in 1m 12s · 3 reads, 2 edits, 1 shell · ≈ $0.04" (cost part only with `claude.showCost`), plus feature 14's files. `claude.turnSummary` switch.
32. **Compacting.** On `PreCompact` (a new hook event: the eleventh) the session gets `compacting: true` until the next `SessionStart` with `source: compact`, `UserPromptSubmit`, `PreToolUse`, `Stop` or `SessionEnd`; the ring turns dotted and a toast says "Claude is compacting its context".
33. **Session clock.** The ring's tooltip: "Claude · 42 min · 9 turns · ≈ $1.20" (cost part only with `showCost`), plus running agents.
34. **Hook health.** Settings → Claude Code lists the eleven hook events with "last seen 3 min ago" / "not seen yet" from a new daemon RPC `claude.hooks` (in memory since the app started), and warns when `SessionStart` was seen but no `Stop` for an hour while a session is not working.

### Awareness and system
35. **Resource strip (opt-in).** `appearance.systemStats` (default off): three small bars at the right of the title bar for CPU (all cores, from `os.cpus()` deltas), memory in use (`os.totalmem/freemem`) and battery (`navigator.getBattery()`, hidden on a desktop); the main process sends CPU and memory every 5 s only while enabled.
36. **Git status in the pill.** After each prompt the daemon runs `git status --porcelain=v2 --branch` in the folder's repository (execFile with an argv array, 1 s timeout, output cap 1 MB, skipped when no repository) and adds `git: {staged, changed, untracked, ahead, behind}` to `session.info`; the pill shows `+2 ~3 ?1 ↑1 ↓0` (zeros left out).
37. **Ports.** When the output of the running command shows `localhost:<port>`, `127.0.0.1:<port>` or `0.0.0.0:<port>` (bounded scan per chunk), the pill gets a chip ":5173 ↗"; a click opens `http://localhost:<port>` in the browser. The chip goes when the command ends. `terminal.portLinks` switch.
38. **Focus mode (⌃⌘F).** Title bar, strip and companion fade to 15 %, and notifications are held; leaving focus mode shows one summary notification ("While you were focused: Claude finished twice, 1 command failed") when anything was held. Session state only.
39. **Pin a line (⇧⌘L).** Pins the current selection (first line, 200 chars) under the title bar; up to 3; each has a ×. Memory only.
40. **Blur.** `appearance.blur` (default on): the window's vibrancy on or off at runtime (`win.setVibrancy`); the existing opacity slider stays.

## Settings
- Appearance: Theme, *Follow macOS / time of day* (`appearance.autoTheme`) and *Light theme* (`appearance.lightTheme`), Window opacity, *Blur behind the window* (`appearance.blur`), *Window glow* (`appearance.glow`), *System stats in the title bar* (`appearance.systemStats`), the existing fields.
- A new section **Terminal**: *Command blocks* (`terminal.blocks`), *Ask before pasting several lines* (`terminal.pasteGuard`), *Column ruler* (`terminal.ruler`), *Open file links in* (`terminal.editorUrl`, empty = reveal in Finder), *Inline images* (`terminal.images`), *Links to local servers* (`terminal.portLinks`).
- Claude Code: the existing fields plus *Live cost while Claude works* (`claude.liveCost`), *Daily budget* (`claude.dailyBudgetUsd`), *Tool strip* (`claude.toolStrip`), *Turn summary* (`claude.turnSummary`), and the hook-health list.
- Every new key has a default of the right kind in `DEFAULT_CONFIG` (`claude.typicalTurnMs` 0 is internal, not shown).

## Keys
⌘↑ / ⌘↓ previous / next prompt · ⌘R recent commands · ⌘G / ⇧⌘G next / previous match · ⌥⌘C copy as Markdown · ⌃⌘F focus mode · ⇧⌘L pin selection. Each is also a palette action and, where it fits, a menu item.

## Testing
- Pure logic gets unit tests: `toolCategory`, the median, block parsing from marks, the path and port finders (with 1 MB / 8 MB timing tests: they run over untrusted text), `isSensitivePath`, the git status parser, the budget colour, the quit-unrelated focus-mode summary, the editor URL builder (scheme allow-list, encoding).
- The watcher's privacy test is changed deliberately: it now pins that only tool names, counts, timings, failure flags and non-sensitive edited paths are kept.
- Daemon tests for the new RPCs and fields (`claude.hooks`, `live`, git status, `compacting`); UI e2e tests per visible feature (DOM renderer); the calm-window test changed deliberately to the new allowed set; screenshots regenerated.
- THE PERSON'S REAL MAC: no test reaches the real `launchctl`, `caffeinate` or `~/.jaffer`; git status tests use temp repositories.

## Release
1.0.0 (major). `docs/releases/v1.0.0.md` replaces v0.6.0.md. README, ARCHITECTURE and CLAUDE.md describe the new features and the narrowed rules above. Built, signed, notarized from a separate checkout; uploaded files first, manifest last; Latest.

## Out of scope
Tabs, splits, a second window, a chat or prompt box, anything that types into the shell, command history on disk, Kitty graphics, output folding, horizontal scrolling.
