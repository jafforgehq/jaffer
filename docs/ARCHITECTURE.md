# Architecture

```
┌────────────────────────── Jaffer.app (Electron) ───────────────────────────┐
│ main process: window, menu, dock, notifications, global hotkey, IPC relay   │
│ renderer: Preact + xterm.js (WebGL) · agent panel · memory panel · palette  │
└───────────────▲─────────────────────────────────────────────────────────────┘
                │ unix socket (NDJSON RPC + events), ~/.jaffer/run/jafferd.sock
┌───────────────┴────────── jafferd (detached, survives the app) ─────────────┐
│ SessionHost ── PtySession ── node-pty ── your login shell (zsh/bash/fish)   │
│     │             └ headless xterm: screen snapshots, OSC 133/633 parsing    │
│ MemoryEngine ── EpisodeLog → heuristics / model reflector → MemoryStore     │
│     │              (journal, decay, consolidate, skills, exports)            │
│ AgentRuntime ── Thread (append-only, compaction) ── Anthropic provider      │
│ ClaudeIngestor · secrets (Keychain) · config                                │
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

Shell integration scripts (`resources/shell`, embedded into `src/generated`) hook zsh (`ZDOTDIR` shim that sources your real dotfiles), bash (`--init-file`, bash 3.2 compatible) and fish. They emit OSC 133 (`A` prompt, `C` output start, `D;<exit>`) and OSC 633 (`E` command line, `P;Cwd=`). From those the daemon knows when the shell is idle, what ran, with what exit code and output, and can let the agent type a command into the live shell and wait for it.

## Agent

`AgentRuntime` drives the Messages API with streaming, adaptive thinking, eager tool-input streaming and server-side refusal fallback. History is **append-only**: the system prompt and tool list never change, memory arrives as `<jaffer-context>` deltas inside the new user turn, thinking blocks are dropped from completed turns, and compaction replaces the whole prefix with a briefing — so prompt caching and preserved-thinking checks keep working over months. Tools: `run_command` (in the live shell, falling back to an isolated subprocess), `read_terminal`, file read/write/edit, search, `recall`/`remember`/`forget`. Reads and read-only commands are automatic; everything else asks (or auto-approves in auto mode) — except `sudo`, force-push, recursive deletes, etc., which always ask, and catastrophic commands, which never run.

## Memory

See the README for the lifecycle. Storage is plain files under `~/.jaffer/memory`: `items.jsonl` (source of truth), `skills.jsonl`, `journal.jsonl` (every mutation with before/after), `episodes/YYYY-MM-DD.jsonl` (raw, pruned after 45 days), generated `MEMORY.md` and per-skill markdown, and your `NOTES.md` / `POLICY.md`.

Ranking = confidence × time-decay (half-life per kind) × usage × scope relevance (global vs the project you are in) × BM25 match to the current request.

## Process boundaries and trust

The renderer is sandboxed (`contextIsolation`, no Node) and only reaches the daemon through the preload bridge; the main process checks the sender frame. The agent's shell commands are classified (read-only / ordinary / risky / blocked) before they run, file writes to credentials and system paths always ask, and everything fed to memory or a model is redacted first.

## The window

The renderer is three layers on a canvas: a **session rail** (left), the **terminal card** (centre) and the **inspector** (right: agent or memory), with a toolbar above and a status bar below. Colours come from layered tokens derived from the active theme (`themes.ts`): `--chrome` is the canvas, `--surface` the cards on it, `--raised` cards on those. A theme change therefore repaints the whole app.

- The rail reads `session.info` (project, branch, uptime, and the daemon's ring of recent commands, which is redacted and omits sensitive commands) and keeps itself live from `pty.start`, `pty.command` and `pty.cwd` events. Because the daemon owns this state, the rail looks the same after you quit and reopen the app.
- Command stripes are xterm decorations created from the OSC 133 sequences the shell integration already emits (`A` prompt, `C` output, `D;exit`). They live in the renderer only; the daemon's snapshots and the scrollback are untouched.
- Approval cards preview what the agent is about to do (a diff for `edit_file`, the new contents for `write_file`, the command for `run_command`) from the tool input the daemon already sends.

## Two engines behind one panel (one is switched off)

The panel's conversation is served by `AgentHub`, which knows two engines. **For now only Claude Code is on: Jaffer runs on Claude subscriptions.** The API-key engine stays in the code but is unreachable unless the daemon is started with `JAFFER_API_ENGINE=1` (the tests do that, and a future release can). With it off, the hub always answers Claude Code, an API key (stored or in the environment) is ignored and the Keychain is not read, and there is no RPC or UI to store one. With it on, `agent.engine: auto` prefers an API key, otherwise Claude Code.

- `AgentRuntime` (API key, switched off): Jaffer's own loop over the Anthropic Messages API. Append-only history, its own tools.
- `ClaudeCodeEngine` (Claude Code login): one long-lived `claude -p --input-format stream-json --output-format stream-json --permission-mode manual --permission-prompt-tool stdio` process. It is started in a fixed directory (`~/.jaffer/agent`) so its session can always be resumed by id after a restart; stdout events (text, thinking, tool calls and results) are mapped onto the same `AgentEvent`s the UI already renders, and Claude Code's tool names are normalised (`Edit` → `edit_file`, …) so policy and previews are shared (`assess.ts`).

Safety properties, both enforced in code and covered by tests: every `can_use_tool` request is answered by Jaffer (auto, ask the UI, or deny) and never by Claude Code's defaults; shell commands are not Claude Code's `Bash` (disallowed) but `run_command` from `jaffer mcp --session`, which calls the daemon's `agent.tool` and types into the user's own pane; those tools are only in the MCP config of the panel's own process.

The panel engine keeps its own thread (`cli-thread.json`) for display; switching engines shows that engine's conversation. Learning from panel turns goes through `observeAgentTurn` with the real project, and the transcript ingestor skips the engine's working directory so nothing is learned twice or under the wrong project.
