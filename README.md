<p align="center">
  <img src="build/icon.png" width="112" alt="Jaffer" />
</p>

<h1 align="center">Jaffer</h1>
<p align="center"><b>A calm macOS terminal with one session<br />and a companion that shows what Claude Code is doing.</b></p>

<p align="center">
  <a href="https://github.com/jafforgehq/jaffer/actions/workflows/ci.yml"><img src="https://github.com/jafforgehq/jaffer/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/jafforgehq/jaffer/releases/latest"><img src="https://img.shields.io/github/v/release/jafforgehq/jaffer?label=release" alt="Latest release" /></a>
  <img src="https://img.shields.io/badge/macOS-Apple%20Silicon%20%C2%B7%20Intel-lightgrey" alt="macOS, Apple Silicon and Intel" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license" /></a>
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#features">Features</a> ·
  <a href="#companions">Companions</a> ·
  <a href="#claude-code">Claude Code</a> ·
  <a href="#development">Development</a> ·
  <a href="docs/ARCHITECTURE.md">Architecture</a>
</p>

<p align="center">
  <img src="docs/screenshots/02-terminal.png" alt="Jaffer: a terminal with a thin title bar (folder, branch and a small cost figure) and a mole cheering in the bottom-right corner after a failing test was fixed." />
</p>

## Why Jaffer

- **One terminal.** No tabs of throw-away shells, no splits, no extra windows and no "new chat": one shell in a calm window with a thin title bar. Quitting Jaffer ends the shell and anything running in it (a question first when Claude Code or a command is running), and `⌘W` only hides the window. Nothing of the terminal is saved or replayed: the next start is a fresh shell.
- **Life when something happens.** A small animation in the corner works while a command or Claude works, sits up when Claude needs you and celebrates when a turn ends. Choose a mole, digital rain, an agent network, a starfield, a radar or a reactor core.
- **Claude Code, optional.** It runs inside Jaffer like anywhere else (real TTY, truecolor, mouse, `Shift+Enter`); connect it and the companion, the notifications and a per-answer cost figure follow it. A plain terminal is one click at first launch.

## Install

Download the `.dmg` for your Mac (Apple Silicon `arm64` or Intel `x64`) from [Releases](https://github.com/jafforgehq/jaffer/releases) and drag Jaffer to Applications. Releases are signed and notarized and come with a `SHA256SUMS.txt`; how they are built and published is in [docs/SIGNING.md](docs/SIGNING.md). An unsigned preview built by CI needs `xattr -dr com.apple.quarantine /Applications/Jaffer.app` once.

To build it yourself (a local build opens with no warnings): `./scripts/install-mac.sh` (Node 22+).

**Updates ask first.** The signed app checks for a new release, downloads it in the background and then asks *Update and restart* or *Later*. Updating ends your terminal session (the shell and anything running in it stop and a fresh terminal starts), so the prompt says so, and nothing installs without your yes, not even on quit. The background check can be switched off in *Settings → Updates*.

On first launch Jaffer asks what it may do: sign in to Claude or use a plain terminal, follow Claude Code (its hooks), start `claude` for you. Sign-in opens your browser and nothing more: nothing is installed or typed until you click *Get started*, and a plain terminal installs and types nothing at all.

**Coming from 0.5 or earlier?** 0.6.0 is a plain terminal: the memory, the saved screen, *Resume Claude* and *Restart Claude Code*, the login agent that kept a session running in the background and the Safety edges are gone, and quitting Jaffer ends the shell. The first start cleans up what they left on your Mac, once, and keeps a copy of the two memory files you wrote yourself, if there are any. What it removes and what stays is in the [0.6.0 release notes](docs/releases/v0.6.0.md).

## Features

| | |
|---|---|
| **Terminal** | A thin title bar (folder, branch, a ring that spins only while something really runs) and nothing else. Eleven themes that restyle the whole app, previewed live. Find, text size, a command palette and a global hotkey. |
| **Companion** | Six animated corner scenes that follow your commands and Claude Code, with a helper per background agent. [More below.](#companions) |
| **Claude Code** | A notification when Claude needs you and when a long turn finishes (how long it took and what it cost). A per-answer cost estimate. Sign-in help. [More below.](#claude-code) |
| **Awake** | While Claude works, or a command has run for 30 seconds, your Mac does not go to idle sleep (`caffeinate -i`: no password, no admin rights). [More below.](#awake-while-claude-works) |
| **Privacy** | Nothing of your terminal is written to disk: no screen, scrollback, command history, command output or transcript text. Notifications redact secrets and never name a command like `env` or `cat ~/.ssh/…`. No API key anywhere: Claude subscriptions only. |

**Keys:** `⌘P` command palette · `⇧⌘C` run Claude Code · `⌘K` clear · `⌘F` find · `⌘+` / `⌘-` text size · `⌘,` settings · `` ⌃` `` summon Jaffer from anywhere (changeable in *Settings*) · drag a file in to paste its path. `⌘W` hides the window; `⌘Q` quits Jaffer **and ends the session**, after asking when Claude Code is working or a command is running. There is exactly one session and one terminal, by design (use `tmux` inside it if you want panes).

**Settings** (`⌘,`): *Appearance* (themes, font and size, window opacity, cursor, Option as Meta, animations, the companion and which one, GPU rendering, the global hotkey, keeping the Mac awake while Claude works, opening at login), *Claude Code* (sign-in help, connect or disconnect the hooks, *Tell me when Claude finishes*, *Show what each answer cost*), *Updates* and *Reset*.

| | |
|---|---|
| ![Needs you](docs/screenshots/03-needs-you.png)<br><sub>**It tells you when it needs you.** The companion sits up with a `!`, and a notification follows if the window is behind.</sub> | ![Light](docs/screenshots/07-light.png)<br><sub>**Light theme**, same calm layout (one of eleven).</sub> |
| ![Settings](docs/screenshots/12-claude-code-settings.png)<br><sub>**Claude Code settings:** sign-in help, the hooks, the finished notification and the cost switch.</sub> | ![Updates](docs/screenshots/13-updates.png)<br><sub>**Updates ask first**, because updating ends your terminal session.</sub> |
| ![Welcome](docs/screenshots/01-welcome.png)<br><sub>**First launch.** Two switches, both yours; a plain terminal with no Claude at all is one click on the step before.</sub> | |

<sub>The screenshots are the real app, generated by `npm run screenshots` from a scripted demo session (real git repo, real zsh; only Claude Code's hook events and its token counts are scripted so the run is deterministic).</sub>

## Companions

Pick one in *Settings → Appearance* (each choice is shown live there), or switch the companion off.

| | | |
|---|---|---|
| ![Mole](docs/screenshots/companion-mole.png)<br><sub>**Mole.** Digs while something runs; a helper mole for every agent.</sub> | ![Matrix](docs/screenshots/companion-matrix.png)<br><sub>**Matrix.** Digital rain; every agent is a bright column.</sub> | ![Agent network](docs/screenshots/companion-agents.png)<br><sub>**Agent network.** Nodes passing data back and forth.</sub> |
| ![Warp](docs/screenshots/companion-warp.png)<br><sub>**Warp.** A starfield at speed, a wingman per agent.</sub> | ![Radar](docs/screenshots/companion-radar.png)<br><sub>**Radar.** A sweep and a blip per agent.</sub> | ![Reactor core](docs/screenshots/companion-core.png)<br><sub>**Reactor core.** Rings, energy bars and orbiting agents.</sub> |

<p align="center">
  <img src="docs/screenshots/15-companions.png" width="720" alt="Settings, Appearance: a Companion switch and six live previews to choose from (Mole, Matrix, Agent network, Warp, Radar, Reactor core)." />
</p>

All six behave the same way. They sleep when nothing runs, rest while Claude Code is open, work while a command or Claude works, sit up with an alert when Claude needs you, and celebrate when a turn ends. **The longer the work takes, the harder they go**: faster after 30 seconds, strained after 2 minutes, at full tilt after 5. **Every background agent brings a helper** (up to three) that celebrates when its agent finishes.

They are decoration only: they ignore the mouse, stand still with *Settings → Appearance → Animations* off or macOS *Reduce motion* on, take their colours from the theme, and never type or send anything.

## Claude Code

There is exactly one Claude: the `claude` in your terminal (`⇧⌘C`, or just type it). You talk to it there, with its own permission prompts; Jaffer adds no second chat or panel and answers none of Claude Code's questions. Claude Code reports what it does through hooks, and Jaffer turns that into the companion, the title-bar ring, the notifications and the cost figure. It follows only a `claude` running in Jaffer's own terminal, redacts everything it handles, and notices a declined prompt or `Esc` from the transcript (Claude Code fires no hook for those).

Jaffer runs on Claude **subscriptions** only: there is no API key anywhere (`ANTHROPIC_API_KEY` is ignored), and whether you are signed in comes from `claude auth status`. Sign-in opens your browser and nothing is typed into your terminal for it. The only thing Jaffer ever types into your terminal is `claude`, when you press `⇧⌘C` or leave *Start Claude Code in the terminal now* on at first launch.

- **The hooks.** *Settings → Claude Code → Connect* (or `jaffer setup claude`) adds Jaffer's hooks to `~/.claude/settings.json`: ten events (prompts, tool calls, background agents, notifications, the end of a turn, the start and end of a session), all asynchronous, so they never delay Claude, and all of them do nothing outside Jaffer's own terminal. Your own hooks and settings are never touched, only entries tagged `jaffer-managed`; *Disconnect* (or `--remove`) takes them out.
- **What each answer cost.** After every answer a figure like `≈ $0.04` appears in the title bar; hover for the tokens and the session total. It is an **estimate**: Jaffer adds up the token counts in Claude Code's own transcript (numbers only, never the words) at Anthropic's API list prices. On a subscription nothing is billed per token, so read it as what the work would be worth. A model without a known price shows tokens, not a guess, and background agents' own usage is not counted.
- **Notifications** while the window is in the background: Claude needs you, a long turn finished, a long command finished. *Tell me when Claude finishes* in *Settings → Claude Code* switches the finished-turn one off.
- **Awake while Claude works.** While Claude (or a background agent) works, or a command has run for 30 seconds or more (not an interactive program such as `ssh`, `vim` or `tail -f`; capped at 6 hours), Jaffer holds the Mac off idle sleep with `caffeinate -i`, no admin rights and no password, and lets go 15 seconds after the work stops. The screen can still sleep. **It does not override the lid:** a laptop on its own with the lid closed still sleeps, and everything pauses until it wakes. With power, an external display and a keyboard or mouse (macOS's closed-display mode) it keeps working; that has not been checked on a real Mac yet. *Settings → Appearance → Keep my Mac awake while Claude works* switches it off.

## The terminal and the command line

The app is a window onto `jafferd`, a process it starts as its own child: it owns your shell, a headless copy of the screen and what Claude Code is doing, and it ends with the app (quit, crash or kill). Re-attaching the window, after a page reload say, restores the exact screen, including full-screen programs. If your shell exits, a fresh one starts in the same folder with a blank screen.

```sh
jaffer status | doctor    jaffer setup claude [--remove|--status]
jaffer config get|set <dot.path> <json>    jaffer daemon [status|stop]
```

The command line talks to the running app (it never starts a terminal: with Jaffer closed it says so), and `daemon stop` ends the session, which quits the app with it. Inside Jaffer `jaffer` is already on your `PATH`; elsewhere run *Install the `jaffer` command* from the palette.

**Start over:** *Settings → Reset → Reset…*, or `jaffer reset` from another terminal (`--yes` skips the question, `--delete` skips the backup). It ends the session and removes `~/.jaffer` (moved aside as `~/.jaffer.backup-<time>` unless you delete it), Jaffer's hooks in Claude Code, the `jaffer` link and the app's data, together with anything an older Jaffer left behind (its login agent, its memory tools in Claude Code, the block it wrote into `~/.claude/CLAUDE.md`, the skills it published). Claude Code itself, its login and your own settings stay. If `~/.jaffer` is a link, Reset renames or removes the link, not what it points to. Then drag Jaffer.app to the Trash.

## Development

```sh
npm ci && npm run build        # esbuild: daemon, CLI, Electron main/preload, renderer
npm run dev                    # build + launch
npm run typecheck && npm test  # real PTYs (bash, zsh), the bundled daemon and CLI as processes, the real `claude` where it is installed
npm run test:e2e               # the real UI in headless Chromium against the real daemon (set JAFFER_CHROME)
npm run screenshots            # regenerate docs/screenshots; then python3 scripts/shrink-screenshots.py
scripts/release-mac.sh         # on your Mac: build, sign, notarize, verify; --publish uploads it
```

**Careful when you run the app from a checkout:** `npm run dev`, `npm start` and `npm run smoke` use your real `~/.jaffer`, and on a Mac that ran an older Jaffer the first start of 0.6.0 cleans it up for real (it deletes the old memory and saved session there). Give them a throwaway folder: `JAFFER_HOME=/tmp/jaffer-dev npm run dev` (the name must contain "jaffer"); with another home the app leaves your Claude Code files and launchd alone. The tests use temporary homes, and `JAFFER_NO_LAUNCHCTL=1` keeps them away from the real `launchctl`.

`src/core` has no Electron dependency, so nearly everything is tested as real processes. CI runs the suite on Linux and macOS, builds the `.app`, boots it in a smoke test (`JAFFER_SMOKE=1`) and checks signing end to end with a throwaway identity. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [CLAUDE.md](CLAUDE.md) for the layout and the rules that matter.

**Not verified here:**
- a real Claude sign-in (tests use the real `claude` binary against a mock API and a stand-in for the login page);
- the companions and the cost figure against a real Claude Code session (their inputs were checked against real hook payloads and transcript fields, then driven by scripted events);
- clicking *Update and restart* through to the new version;
- needing a person at a Mac: notifications, the global hotkey and the WebGL renderer on your GPU;
- **the first start of 0.6.0 on a Mac that ran an older Jaffer**, with its login agent, its Claude Code settings, its memory data and a session still running. The clean-up is tested on seeded temporary homes against a stand-in `launchctl` and a stand-in `claude`, because the real ones would touch your LaunchAgents and your Claude Code. Not checked on a real Mac: a real `launchctl bootout` of an installed agent, a real `claude mcp remove jaffer -s user` (its exit code and message when nothing was registered), and the dialog offering to end an older Jaffer's background session when a real one is still running;
- **the child ending when the app is killed:** quitting and crashing are tested with real processes, and a `SIGKILL` of the parent only with a Node stand-in for the app, not with the real Electron app;
- **the packaged app's own dialogs:** the quit question (`⌘Q` with Claude Code or a command running), the terminal-stopped dialog and a second copy of the app opened while one runs are type-checked and built, and their decisions are unit-tested, but the dialogs themselves have not been clicked on a real Mac (CI's smoke test boots the packaged app and checks that its terminal is the app's own child);
- **staying awake on a real Mac:** `pmset -g assertions` showing the hold while Claude works and not after, and a closed lid with and without power and an external display (the tests use a stand-in for `caffeinate`).

None of this counts as verified until the owner of the Mac has checked it there.

## Limitations

- macOS only. Fish integration is experimental (zsh and bash are tested).
- Jaffer keeps no session of its own: when it quits, updates or crashes, the shell and Claude Code end, and the next start is a fresh terminal. Claude Code's own `claude --resume` and `claude -c` still work, typed by you; Jaffer no longer offers them. (A `tmux` you start in it is yours, and works as anywhere.)
- No Claude panel by design: you answer Claude Code's permission prompts in the terminal.
- Built on xterm.js (WebGL): fast, but not a native GPU terminal like Ghostty.

## License

[MIT](LICENSE)
