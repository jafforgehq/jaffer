# 0.6.0: a plain terminal with the companion

Date: 2026-10-10 · Status: scope decided by the product owner in conversation (answers to four questions, "remove restoring sessions after update", "remove memory management", "keep it simple terminal with that cool animations when Claude is doing something", "after you are done push everything, increase version, sign and upload"). This document records the decisions and the rulings taken on the open points, for the plan.

## Why

A restored screen replays the old program's terminal modes into a new shell (mouse reports typed into zsh after an update: the saved screen carried `?1003h`, and every snapshot saved it again). Around that feature grew a stack: saved screens, a resume offer, Restart Claude Code, a login agent, a background daemon that outlives the app, and a self-evolving memory. The owner wants a simple terminal with the companion animations. Everything that exists only to bring a session back, or to remember things, goes.

## Decisions (owner)

- **Remove:** the saved screen above a new shell; **Resume Claude** and **Restart Claude Code**; the launchd login agent (*Keep my session running*, `jaffer service`); the background daemon's outliving the app (**quitting the app ends the shell and any Claude in it**); the whole **memory** part, **including its data on disk**; the **Safety** edges (protected-branch amber edge, ssh red edge).
- **Keep:** the terminal (PTY, xterm.js, themes, palette, find, text size, hotkey); the companion scenes and everything that feeds them (Claude Code hooks, `ClaudeWatcher`, a helper per background agent); notifications (Claude needs you, a long turn finished, a long command finished); the cost figure; **stay-awake**; the updater (ask first; an update now just relaunches); Reset; the first-run flow minus the removed options.
- One release: **0.6.0**, signed, notarized, published.

## Rulings on the open points

- **Process model (A).** `jafferd` stays as code but is started by the app as a **child process** (not detached) that exits when the app quits or dies; the app is its only client. This keeps every black-box test, keeps the PTY/xterm work off the main thread, and the Claude hooks still reach it over the same unix socket (`~/.jaffer/run/jafferd.sock`, the names stay). The parent-exit watch is **opt-in** (set only by the app), because tests and `ensureDaemon` start the daemon with `stdio: 'ignore'`. Merging the daemon into Electron's main process stays a later option, not part of this release.
- **Old daemon on first launch** (a drag-in install over a running 0.x session): the app asks once with a native dialog (*An older Jaffer session is still running in the background. Jaffer no longer keeps sessions running. End it and start a fresh terminal?* **End it** / **Quit**), then asks it to shut down (`app.shutdown`, available on every old version) and waits for the socket to go.
- **Order of the first start:** (1) remove the login agent (bootout, plist, wrapper) so launchd cannot restart anything, (2) end an old daemon, (3) start the app's own child, (4) run the one-time migration. The wrapper installed on people's Macs still names `dist/daemon/jafferd.cjs`: that file does not move (a leftover agent would otherwise crash-loop).
- **Shell exit** (the person types `exit`): a fresh shell is spawned in the same folder, **without** replaying the old screen.
- **Quit:** `⌘Q` quits the app and ends the session. When Claude is working or a command is running a native dialog asks first (*Quit Jaffer? Claude Code is running and will stop.* **Quit** / **Cancel**); `⌘W` still hides the window (the hotkey brings it back); *Quit and End Session* (`⌥⌘Q`) and *Quit Jaffer (session keeps running)* are removed.
- **Two Claude conversations notice** goes with Resume (its text is about which one Resume offers).
- **Memory data deletion:** everything under `~/.jaffer/memory`, `~/.jaffer/session` and `~/.jaffer/bin/jafferd` is deleted on the first start. The two files the person wrote, `memory/NOTES.md` and `memory/POLICY.md`, are first **copied to `~/.jaffer-memory-backup/`** when they exist and are not empty (a deliberate softening of "delete the data": two small text files are not worth losing; the release notes say where they are and that the folder can be deleted).
- **Claude Code side, once** (only entries Jaffer wrote): the user-scope MCP server `jaffer` (`claude mcp remove jaffer -s user`, when `claude` is found), the marked block in `~/.claude/CLAUDE.md`, `~/.claude/skills/jaffer-*` whose `SKILL.md` carries Jaffer's marker; the live hooks stay and are rewritten at the start (`# jaffer-managed` entries only; **SessionStart and Stop become async and guarded** like the other eight: they no longer print memory and the companion/cost need both). The same cleanup runs in Reset. Done without asking: it removes only Jaffer's own entries.
- **Already-onboarded people** are not shown the first-run flow again.
- **CLI** keeps `hook`, `config`, `setup claude` (hooks only), `status`/`doctor`, `reset`, and the palette's *Install the jaffer command*; `remember`, `recall`, `forget`, `context`, `memory`, `mcp`, `service`, `daemon start`'s launchd branch go.
- **Dead config keys** (`memory.*`, `ingest.*`, `export.*`, `safety.*`, `session.restoreScreen`, `session.resumeClaude`, `session.keepRunning`, `session.autoResume`) are pruned from `config.json` by the migration; unknown keys elsewhere are still kept.

## What the person sees

| | Before | 0.6.0 |
|---|---|---|
| Quit the app | The session keeps running | The shell and Claude end (a confirmation when something runs) |
| Update | Session ended, old screen replayed, **Resume Claude** | Session ended, a fresh terminal |
| Title bar | folder, branch, ring, cost, **Memory** button, **Resume Claude** | folder, branch, ring, cost |
| Settings | Appearance, Claude Code (memory, resume, restart), Memory, Updates, Reset | Appearance, Claude Code (connect, notifications, cost), Updates, Reset |
| Terminal modes of a dead program | Replayed into the new shell | Nothing is replayed |

## Removal map (details: the inventory in the plan's workspace)

About 26 source files (about 4,500 lines) and 18 test files (about 3,900 lines) are deleted, and 12 test files are cut: `daemon.test.ts` loses about 1,900 of 2,700 lines, `e2e/ui.test.ts` about 850 of 1,850. Slim replacements: `exports.ts` (the exact `BEGIN`/`END` block text, `applyBlock(file, null)`, `pruneSkills` with its marker) for the cleanup and Reset; `launch-agent.ts` (bootout, remove plist and wrapper) for the legacy cleanup. Splits first: `COMMAND_HEAD`, the wrapper-option tables and `STAY_AWAKE` move to kept modules before their old homes are deleted.

## Testing

- Tests of removed behaviour are removed deliberately and listed per task; every other test keeps its name (name diff against the base commit per task, reported).
- New tests: the child daemon exits when its parent pipe closes (with the flag) and keeps running without it; a seeded old home (memory, session, claude.json, wrapper, settings.json with old hooks and an old CLAUDE.md block and skill) is migrated once and the migration is idempotent; the legacy agent cleanup against a fake `launchctl`; the quit confirmation decision; SessionStart/Stop hooks are async and guarded; the old-daemon takeover.
- **No test and no run may call the real `launchctl`, touch `~/Library/LaunchAgents`, or run the real `caffeinate`** (`JAFFER_NO_LAUNCHCTL=1` stays for the cleanup's tests). The repo's `release/` folder holds the owner's running app: never removed by a test or build.

## Release

Version 0.6.0. `docs/releases/v0.6.0.md` replaces v0.5.1.md (`mkdir -p docs/releases` after the `git rm`); README, ARCHITECTURE and CLAUDE.md rewritten for a plain terminal (the rules about the daemon owning the shell, memory, resume, the login agent and Safety go; the rules about redaction, the single session and terminal, hooks, cost, window policy and staying awake stay); screenshots regenerated (01, 02, 03, 07, 12, 13, 15; 04 deleted). Built, signed, notarized from a separate checkout, uploaded in the safe order (files, manifest last), compared with GitHub. The mouse-garbage bug is fixed by the removal of the replay; it is named in the release notes.

## Out of scope

- Merging the daemon into the main process; Linux/Windows; new features; anything automatic that types into the shell.

## Open points for review

- The real-Mac behaviour of the first start (`launchctl bootout` of an installed agent, Claude's `mcp remove`, the child exiting when the app is killed with SIGKILL) is tested against stand-ins only and is documented as not verified until the owner checks it.
- The owner's running 0.5.1 session ends when 0.6.0 is installed (the update prompt already says so).
