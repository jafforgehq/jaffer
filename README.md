<p align="center">
  <img src="build/icon.png" width="128" alt="Jaffer" />
</p>

<h1 align="center">Jaffer</h1>
<p align="center"><b>A calm terminal with one session that never ends, a memory that keeps learning from you, and a little mole that shows when something is happening.</b></p>

Jaffer is a calm macOS terminal: just the terminal, no sidebars and no panels. Three things set it apart from Ghostty, Orca and friends:

1. **One session, always.** There are no tabs of throw-away shells and no "new chat". Your shell, its running processes and your scrollback live in a background daemon. Quit the app, close the lid — you come back to exactly where you were, with a running Claude Code still going. (After a reboot: same folder, same screen above a fresh shell.)
2. **A memory that evolves by itself.** Jaffer watches what you do, distils what is worth keeping — your preferences, each project's conventions, fixes that cost you an hour, routines you repeat — merges what repeats, lets stale things fade, and hands the result to Claude Code. You can see all of it, edit it, pin it, and **undo any change**.
3. **Life when something happens.** A little mole sits in a corner of the terminal: it sleeps when nothing runs, digs while a command or Claude is working, sits up with a `!` when Claude needs you, and cheers when a turn ends. A ring beside the folder in the title bar spins only while something works.

**Claude Code is optional, and it runs inside Jaffer like it would anywhere else**: real TTY, truecolor, mouse, bracketed paste, `Shift+Enter` for new lines, desktop notifications. Connect it and the mole and the notifications follow it. A running Claude Code session survives quitting the app.

<p align="center">
  <img src="docs/screenshots/02-terminal.png" alt="Jaffer: a terminal with the title bar above (folder and branch, a Memory button) and a little mole cheering in the bottom-right corner after a failing test was fixed and the suite passed." />
</p>
<p align="center"><sub>Just the terminal. The mole in the corner cheers because a turn just ended: Claude Code fixed the failing test and the suite is green.</sub></p>

## Install

**Download** the `.dmg` for your Mac (Apple Silicon: `arm64`, Intel: `x64`) from [Releases](https://github.com/jafforgehq/jaffer/releases) and drag Jaffer to Applications. Each release says whether it is **signed and notarized** or an **unsigned preview**. Unsigned previews are blocked by Gatekeeper on first launch; after copying the app run once:

```sh
xattr -dr com.apple.quarantine /Applications/Jaffer.app
```

Every release also ships `SHA256SUMS.txt`. How releases get signed and notarized (on your Mac with `scripts/release-mac.sh`, or in CI with repository secrets) is in [docs/SIGNING.md](docs/SIGNING.md).

**Updates** (from 0.2.0 on; older apps need one manual install). The signed app looks for new releases on GitHub (shortly after launch, then every few hours), downloads one in the background and then **asks**: *Update and restart* or *Later*. Updating restarts Jaffer and ends your terminal session, so the prompt says so, and says it again when Claude is working at that moment. Nothing is ever installed without your yes, not even when you quit. *Jaffer → Check for Updates…* answers on demand, and **Settings → Updates** turns the background check off. Unsigned builds (the previews CI makes, or one you built yourself) never update themselves.

**Latest build from `main`:** every push builds both Macs in CI. Open the newest run under *Actions → CI* and download the `Jaffer-macOS` artifact.

**Releases are automatic.** When a push to `main` passes the tests and the Mac build, CI publishes a release for the `version` in `package.json` (skipping it if that version already has one). To ship a new version, bump `version` and push. With Apple credentials configured the release is signed and notarized; without them it is published as a clearly marked unsigned pre-release. (Pushing a `vX.Y.Z` tag, or *Actions → CI → Run workflow* with a *release_tag*, works too.) A release made by CI is never marked *Latest*: installed apps follow the Latest release, which `scripts/release-mac.sh --publish` sets after it has uploaded the signed files and the update manifest.

**Or build it yourself** (a locally built app opens with no warnings):

```sh
git clone https://github.com/jafforgehq/jaffer && cd jaffer
./scripts/install-mac.sh        # needs Node 22+; builds and copies Jaffer.app to /Applications
```

On first launch Jaffer asks what it may do (sign in to Claude or use a plain terminal, learn from your sessions, let Jaffer follow Claude Code, and start Claude Code in the terminal for you). Nothing is on until you say so, and Claude Code's own questions (trust this folder, allow a tool) are always answered by you, in the terminal.

## What the window gives you

- **A terminal and nothing around it**: no sidebar, no status bar, no panels. A title bar shows the folder, the branch and what is running.
- **A little mole**: it sleeps when nothing runs, digs (dirt flying) while a command or Claude is working, sits up with a `!` when Claude needs you, and cheers when a turn ends. **Every background agent Claude starts brings a helper mole** (up to three) that digs on its own molehill beside the main one and cheers when its agent finishes; they outlive the turn that started them, like the agents do. Pure decoration that ignores clicks; switch it off in *Settings → Appearance → Pet*.
- **Motion that means something**: the ring in the title bar spins only while something is actually working (Claude Code open and idle is a calm dot). One switch turns all motion off (*Settings → Appearance → Animations*), and macOS *Reduce motion* does too.
- **Memory you can read** (`⇧⌘M`, or the *Memory* button): cards with kind, confidence, source and age; pinned items; a log of every change you can undo. Jaffer only interrupts you for something new it learned, never for housekeeping.
- **A notification when Claude needs you** (and when a long command finishes) while the window is in the background.
- **Eleven themes that restyle the whole app**, not just the terminal, picked from live previews in Settings.

## Screenshots

These are the real app, generated by `npm run screenshots` from a scripted demo session (a real git repo, a real zsh with Jaffer's shell integration and the memory engine; only the Claude Code hook events are scripted, so the run is deterministic). Nothing is a mock-up.

| | |
|---|---|
| ![Needs you](docs/screenshots/03-needs-you.png)<br><sub>**It tells you when it needs you.** The mole sits up with a `!`, and Jaffer sends a notification if the window is in the background.</sub> | ![Digging](docs/screenshots/03a-digging.png)<br><sub>**Alive while Claude works.** The mole digs, dirt flying. Off in *Settings → Appearance → Animations*, and still under macOS *Reduce motion*.</sub> |
| ![Running](docs/screenshots/11-running.png)<br><sub>**Always know what is running.** The ring in the title bar spins and the mole digs while a process runs. Claude Code itself only spins while it is actually working.</sub> | ![Memory](docs/screenshots/04-memory.png)<br><sub>**Memory you can see** (`⇧⌘M`). About you, per project, pinned items, confidence, and where each came from. Jaffer tells you only about what is new.</sub> |
| ![Activity](docs/screenshots/05-memory-activity.png)<br><sub>**Every change is logged and undoable.**</sub> | ![Palette](docs/screenshots/06-palette.png)<br><sub>**Command palette** (`⌘P`): every action in one place.</sub> |
| ![Light](docs/screenshots/07-light.png)<br><sub>**Light theme**, same calm layout.</sub> | ![Midnight](docs/screenshots/08-midnight.png)<br><sub>**Jaffer Midnight**, one of eleven themes.</sub> |
| ![Settings](docs/screenshots/12-claude-code-settings.png)<br><sub>**Claude Code settings.** Install and sign-in help, the hooks the mole and the notification follow, the memory tools (MCP), and what Jaffer learns and shares. Themes and more are in the other tabs.</sub> | ![Updates](docs/screenshots/13-updates.png)<br><sub>**Updates ask first.** Jaffer downloads a new signed release in the background and asks before installing it, because updating ends your terminal session.</sub> |
| ![Welcome](docs/screenshots/01-welcome.png)<br><sub>**First launch.** Nothing is on until you say so, including starting Claude Code for you (or skip Claude and use a plain terminal).</sub> | ![Crew](docs/screenshots/03b-crew.png)<br><sub>**Background agents get their own mole.** Three agents are running, so three helpers dig beside the main mole, a beat apart.</sub> |

## A 60-second tour

| | |
|---|---|
| `⇧⌘M` | Memory drawer — everything Jaffer has learned: *Learned*, *Skills*, *Activity* (every change, with Undo), *Notes* (yours). |
| `⌘P` | Command palette — every action in one place. |
| `⇧⌘C` | Run Claude Code in the current terminal. |
| `⌘K` · `⌘F` · `⌘+` `⌘-` | Clear · find · text size. `⌘←/→/⌫` edit the line like in Terminal.app. |
| `⌃`` ` | Global hotkey: summon Jaffer from anywhere (configurable). |
| drag a file in | pastes its escaped path — handy for Claude Code. |

Closing the window hides it (`⌘W`); `⌘Q` quits the app **but your session keeps running**. `⌥⌘Q` ends the session on purpose.

There is exactly **one session and one terminal**. Jaffer has no tabs, no splits and no second window, by design: everything you and Claude do happens in the same shell. (If a program needs its own screen, run it in that shell, or use `tmux` inside it.)

## Claude Code, if you want it

Claude is optional. The first run offers to sign you in to Claude, or to use Jaffer as a plain terminal (installs nothing, starts nothing, sends nothing to Claude; add Claude any time in *Settings → Claude Code*).

When you do connect Claude Code there is still exactly one Claude: the `claude` running in your terminal (`⇧⌘C`, or just type `claude`). You talk to it there, with the full Claude Code you already know, including its own permission prompts. Jaffer does not put a second chat, or a panel, next to it. Claude Code reports what it is doing through its hooks, and Jaffer turns that into three quiet things:

- **the mole**: digging while Claude works, up with a `!` when it needs you, cheering when a turn ends;
- **the ring in the title bar**: spinning only while Claude is actually working;
- **a desktop notification** when Claude is waiting for you and the window is in the background.

It only follows a `claude` running in Jaffer's own terminal, never one in another terminal app, and everything it handles is redacted first. If you answer a permission prompt in the terminal, or stop Claude with `Esc`, Jaffer notices that too (Claude Code fires no hook for either, so it reads the moment from the transcript; a turn that goes silent for minutes is shown as idle).

Jaffer runs on Claude subscriptions only: there is no API-key option, and an `ANTHROPIC_API_KEY` in your environment is ignored. Whether you are signed in comes from `claude auth status`; the sign-in (`claude auth login`) opens your browser and lives in the first run and in *Settings → Claude Code*. Nothing is typed into your terminal for it. The first run can also start `claude` in the terminal for you (a switch, on by default); Claude Code's own questions, such as trusting the folder or allowing a tool, are always yours to answer.

How it works: connecting adds hooks to `~/.claude/settings.json` that call `jaffer hook <event>`. They never delay Claude Code (they run asynchronously), print nothing, and do nothing when Claude Code is run outside Jaffer's terminal or when the daemon is not running.

## Claude Code, first class

```sh
jaffer setup claude        # or: Settings → Claude Code → Connect
```

The first run installs only the live hooks. `jaffer setup claude` (or *Settings → Claude Code → Add memory tools*) is the one reversible step (`jaffer setup claude --remove`) that wires Claude Code to Jaffer fully, in five ways:

- **MCP server** (`jaffer mcp`): `jaffer_context`, `jaffer_recall`, `jaffer_remember`, `jaffer_forget` — Claude can look things up and save lessons itself.
- **SessionStart hook**: every Claude Code session — including after `/compact` — starts with what Jaffer knows about *this project* and *you*.
- **Stop hook** + **transcript learning**: Jaffer reads Claude Code's local transcripts (read-only) and learns from them, whether you ran it in Jaffer or anywhere else.
- **Live hooks**: asynchronous hooks for prompts, tool calls, subagents, notifications and the end of a session feed the mole, the title-bar ring and the notification. They only report from Jaffer's own terminal.
- **Optional exports**: a clearly-marked block in `~/.claude/CLAUDE.md`, and learned routines published as real Claude Code **skills**.

Your own hooks and settings are never touched — only entries tagged `jaffer-managed` are added or removed.

## How the memory evolves

```
 what you do ──► episodes ──► reflect ──► memory items ──► consolidate ──► (decay / archive)
 commands, Claude    redacted      offline rules always;     preference · convention ·    merge duplicates,
 Code transcripts   local log     a model curates when      workflow · lesson · fact ·   cap sizes, fade what
                                 you allow it              project · environment        is never reinforced
                                      │                         │
                                      ▼                         ▼
                              skills (repeated routines)   injected into Claude Code as *deltas*
```

- **Observe.** Shell integration (OSC 133/633 marks injected without touching your dotfiles) records commands, exit codes and working directories. Claude Code transcripts are added. Everything is redacted for secrets before it is written.
- **Reflect** automatically — every ~20 events, or after you go idle. Deterministic rules always run (package manager per project, how to test/build, failure→fix pairs that recur, repeated routines → skills, directives like "always use pnpm"). With your consent, a model also curates: add, reinforce, update, merge, contradict, forget. Corrections ("no, use pnpm") are the strongest signal.
- **Consolidate** daily: merge near-duplicates, fade memories that are never reinforced (per-kind half-lives; pinned items never fade), enforce size caps.
- **Inject** without wasting context: Claude Code gets what is relevant to the project at the start of each session (SessionStart hook) and can ask for more through the MCP server.
- **Stay in control.** Every mutation is journaled with before/after state. `jaffer memory log`, `jaffer memory revert <run>`, or the Undo button. `~/.jaffer/memory/NOTES.md` is yours and never rewritten.

Privacy: memory lives in `~/.jaffer/memory` on your Mac. Secrets (API keys, tokens, private keys, passwords in flags/env/URLs, high-entropy blobs) are redacted before anything is stored or sent; commands like `env`, `cat ~/.ssh/…`, `security find-…` or lines starting with a space are never recorded. The only network traffic is what *you* enable: optional model curation of redacted summaries, both through your own Claude Code login (`claude -p`). Jaffer never stores an API key.

## One session, for real

The Jaffer app is a window onto a background **session daemon** (`jafferd`, a unix socket in `~/.jaffer/run`) that owns your shell, a headless copy of the terminal screen, what Claude Code is doing and the memory. Re-attaching restores the exact screen, including full-screen programs and Claude Code's UI. If the daemon itself restarts (update, reboot) the shell starts in the same folder with the previous screen above it.

## Command line

```
jaffer remember "Always run the linter before committing" --kind convention
jaffer recall linter          jaffer forget linter          jaffer context
jaffer memory [list|log|reflect|consolidate]    jaffer memory revert <runId>
jaffer status | doctor
jaffer setup claude [--remove|--status]
jaffer reset [--yes] [--delete]       # start over, see below
```

Inside Jaffer, `jaffer` is on your `PATH` automatically; elsewhere, run *Install the `jaffer` command* from the palette.

## Start over (a clean install)

**In the app:** *Settings → Reset → Reset…*. It asks first, then ends the session, removes what Jaffer put on your Mac and restarts as if freshly installed.

**From a terminal** (not Jaffer's own, the session would end under it): `jaffer reset` explains what it will do and asks you to type `reset`; `--yes` skips the question, `--delete` skips the backup. In a checkout without the app installed: `node dist/cli/jaffer.cjs reset`.

What goes: Jaffer's folder `~/.jaffer` (memory, settings, session; moved aside as `~/.jaffer.backup-<time>` unless you delete it), its hooks and memory tools in Claude Code, the block it wrote into `~/.claude/CLAUDE.md`, the skills it published, the `jaffer` command link in `~/.local/bin`, the update cache, and the app's own data. What stays: Claude Code itself, its login, your own hooks and settings, and everything else on your Mac. To finish a clean install, drag Jaffer.app to the Trash and install the latest release. (An old version may have left a Keychain item: `security delete-generic-password -s Jaffer -a anthropic-api-key`.)

## Development

```sh
npm ci
npm run build          # esbuild: daemon, CLI, Electron main/preload, renderer
npm run dev            # build + launch Electron
npm run typecheck && npm test
npm run test:e2e       # drives the real UI in headless Chromium against the real daemon (set JAFFER_CHROME)
npm run dist:mac       # dmg + zip for arm64 and x64 (ad-hoc signed; see docs/SIGNING.md for Developer ID)
npm run screenshots    # regenerates docs/screenshots from a scripted demo session
python3 scripts/shrink-screenshots.py   # (optional) quantize them, about 60% smaller
scripts/release-mac.sh # on your Mac: sign, notarize, verify and publish a release
```

`src/core` (session, memory, Claude Code integration, MCP) has no Electron dependency, so almost everything is tested as real processes: real PTYs with bash and zsh, the real `claude` binary (MCP registration and the TUI running in the PTY), the real `claude` against a mock Messages API, the bundled daemon and CLI as separate processes, and the renderer in headless Chromium. CI runs the whole suite on Linux **and macOS**, then builds the `.app`, boots the packaged app in a smoke test (`JAFFER_SMOKE=1`), and uploads the dmg/zip. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## What is verified, and how

| Claim | Evidence |
|---|---|
| Claude Code runs inside the terminal | the real `claude` TUI is started in a Jaffer PTY and receives keystrokes; the screen restores from a snapshot |
| Claude Code starts with your memory | the real `claude` binary, pointed at a mock API, fires the SessionStart hook and the model receives the memory |
| The MCP server works with Claude Code | `claude mcp add-json` + `claude mcp list` reports it connected |
| One session survives the app | black-box tests restart clients and the daemon: same shell PID, same screen, same cwd |
| Memory evolves without being asked | the bundled daemon learns from shell activity, a Claude Code transcript and a (mock) model pass, then the run is undone |
| zsh, bash 3.2 and bash 5 integration | tests run against real shells on Linux (gates a release) and on GitHub's macOS runners (advisory: shown in every run, but a flaky timing test there does not block a release) |
| The packaged `.app` boots on macOS | CI builds the `.app`, launches it (`JAFFER_SMOKE=1`) and checks daemon, shell, preload bridge and renderer |
| The UI works | Playwright tests drive the real UI against the real daemon |
| The mole follows the terminal's Claude | real Claude Code hook payloads drive a state machine; the real built `jaffer hook` reports to the bundled daemon (and stays silent and fast when it cannot, or outside Jaffer's terminal); the UI test watches the mole go digging, up, cheering; declining a prompt or pressing Esc in the terminal is noticed from the transcript (only the person's own entry counts, never the same words in code or command output), and a silent turn is swept to idle |
| Updates ask first and are safe to ship | the controller is tested with a fake updater (one prompt per version, Return means Later, a stuck check times out, nothing installs without a yes); a signed build checked and downloaded a newer signed build from a local server; `scripts/release-mac.sh` checks the manifest before it uploads and promotes the release last |
| Signing is configured correctly | CI's *Signing dry run* signs the app with a throwaway self-signed identity through the same electron-builder path as a release, then checks every nested binary (including the native terminal addon), the hardened runtime, the entitlements, the signed dmg, and that the signed app still starts its daemon and shell |

Not verified here: **a real Claude sign-in** (the Claude Code tests use the real `claude` binary but a mock model API, so your plan's limits are untested, and the first-run sign-in step is tested against a stand-in `claude` that answers `auth status` and `auth login`, not against Anthropic's real login page), the mole against a real Claude Code session on the real API (its hook events were observed against a mock API), and **Apple trust and notarization**, which need your Developer ID certificate (see [docs/SIGNING.md](docs/SIGNING.md)). Also not verified (needs a person at a Mac): clicking *Update and restart* through to the new version (the check, the download and the signature were exercised, the install itself was not watched), notifications, the global hotkey, vibrancy, and the look of the WebGL renderer on your GPU.

## Limitations

- macOS is the target. Releases are signed and notarized only when the maintainer has run `scripts/release-mac.sh` on a Mac with a Developer ID certificate or added the Apple credentials as repository secrets ([docs/SIGNING.md](docs/SIGNING.md)); otherwise they are published as unsigned pre-releases.
- fish integration is experimental; zsh and bash are tested in CI.
- There is no Claude panel by design. Jaffer shows when Claude works or needs you (the mole, the title-bar ring, a notification), once its hooks are connected (the first run does it, or `jaffer setup claude`), but you answer Claude Code's permission prompts in the terminal.
- Built on xterm.js (WebGL). It is fast, but not a native GPU terminal like Ghostty.

MIT licensed.
