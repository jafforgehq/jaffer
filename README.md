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
  <img src="docs/screenshots/02-terminal.png" alt="Jaffer: a terminal with a thin title bar (folder, branch, git counts and a small cost figure), a mark in the gutter beside every command and a mole cheering in the bottom-right corner after a failing test was fixed; the strip under the title bar is this turn's tool calls." />
</p>

## Why Jaffer

- **One terminal.** No tabs of throw-away shells, no splits, no extra windows and no "new chat": one shell in a calm window with a thin title bar. Quitting Jaffer ends the shell and anything running in it: `⌘Q` (the menu's *Quit Jaffer*) asks first when Claude Code or a command is running, while a logout, restart or shutdown, or *Quit* in the Dock's menu, end the session without asking. `⌘W` only hides the window. Nothing of the terminal is saved or replayed: the next start is a fresh shell.
- **Life when something happens.** A small animation in the corner works while a command or Claude works, sits up when Claude needs you and celebrates when a turn ends. Choose a mole, digital rain, an agent network, a starfield, a radar or a reactor core.
- **Claude Code, optional.** It runs inside Jaffer like anywhere else (real TTY, truecolor, mouse, `Shift+Enter`); connect it and the companion, the notifications and a per-answer cost figure follow it. A plain terminal is one click at first launch.

## Install

Download the `.dmg` for your Mac (Apple Silicon `arm64` or Intel `x64`) from [Releases](https://github.com/jafforgehq/jaffer/releases) and drag Jaffer to Applications. Releases are signed and notarized and come with a `SHA256SUMS.txt`; how they are built and published is in [docs/SIGNING.md](docs/SIGNING.md). An unsigned preview built by CI needs `xattr -dr com.apple.quarantine /Applications/Jaffer.app` once.

To build it yourself (a local build opens with no warnings): `./scripts/install-mac.sh` (Node 22+).

**Updates ask first.** The signed app checks for a new release, downloads it in the background and then asks *Update and restart* or *Later*. Updating ends your terminal session (the shell and anything running in it stop and a fresh terminal starts), so the prompt says so, and nothing installs without your yes, not even on quit. The background check can be switched off in *Settings → Updates*.

On first launch Jaffer asks what it may do: sign in to Claude or use a plain terminal, follow Claude Code (its hooks), start `claude` for you. Sign-in opens your browser and nothing more: nothing is installed or typed until you click *Get started*, and a plain terminal installs and types nothing at all.

**Coming from 0.5 or earlier?** Jaffer has been a plain terminal since 0.6.0: the memory, the saved screen, *Resume Claude* and *Restart Claude Code*, the login agent that kept a session running in the background and the Safety edges are gone, and quitting Jaffer ends the shell. The first start cleans up what they left on your Mac, once, and keeps a copy of the two memory files you wrote yourself, if there are any. What it removes and what stays is in the [1.0.0 release notes](docs/releases/v1.0.0.md).

## Features

| | |
|---|---|
| **Terminal** | A thin title bar: the folder, the git branch and its counts (`+2 ~3 ?1 ↑1`), the command that is running (a ring beside it spins only while something really runs) and, once Claude Code has answered, what the answer cost. A mark beside every command (green when it worked, red when it failed, with its start time and how long it took on hover); right-click it to copy the command or its output, save the output to a file or copy it as Markdown; ⌘↑ / ⌘↓ jump between prompts; scrolled up into long output, the command stays pinned at the top. Pins for up to three lines. Find with a match counter and marks on the scroll bar. Pasting several lines asks first. ⌘-click on a file path (`src/app.ts:12`) shows it in Finder or opens it in your editor; a running dev server gets a `:5173 ↗` chip. Recent commands to copy. Eleven themes that restyle the whole app, previewed live, that can follow macOS or the time of day. A global hotkey and a command palette. |
| **Companion** | Six animated corner scenes that follow your commands and Claude Code, with a helper per background agent. It shows what kind of tool Claude is using (reading, writing, the web, an agent), dozes after ten quiet minutes, celebrates when a command that failed three times finally works and flinches at the bell. [More below.](#companions) |
| **Claude Code** | A notification when Claude needs you and when a long turn finishes. A ring that fills against how long a turn usually takes, a thin strip of this turn's tool calls, the file Claude is editing, what a prompt is asking and how often you have answered that tool, a summary when a turn ends (how long, what it did, which files, what it cost), and a cost estimate that grows while Claude works, with today's total and an optional daily budget. [More below.](#claude-code) |
| **Awake** | While Claude works, or a command has run for 30 seconds, your Mac does not go to idle sleep (`caffeinate -i`: no password, no admin rights). [More below.](#claude-code) |
| **Quiet** | Focus mode (`⌥⌘F`) fades the chrome and holds notifications until you leave it. An optional glow on the window's edge, an optional strip of CPU, memory and battery in the title bar, and blur behind the window that you can switch off. |
| **Privacy** | Nothing of your terminal is written to disk: no screen, scrollback, command history, command output or transcript text. What Jaffer keeps **in memory** while it runs, and loses when it quits: the commands behind the marks and the recent-commands list, pinned lines, the tool calls, counts and timings of Claude's current session, the names of the files Claude edited (never a key, a credential or an `.env` file), today's estimated cost and when each hook was last seen. Notifications and everything shown redact secrets and never name a command like `env` or `cat ~/.ssh/…`. No API key anywhere: Claude subscriptions only. |

**Keys:** `⌘P` command palette · `⇧⌘C` run Claude Code · `⌘K` clear · `⌘F` find, `⌘G` / `⇧⌘G` next and previous match · `⌘↑` / `⌘↓` previous and next prompt · `⌘R` recent commands · `⇧⌘L` pin the selected line · `⌥⌘C` copy the selection as Markdown · `⌥⌘F` focus mode · `⌘+` / `⌘-` text size · `⌘,` settings · `` ⌃` `` summon Jaffer from anywhere (changeable in *Settings*) · drag a file in to paste its path. `⌘W` hides the window; `⌘Q` (*Quit Jaffer*) quits Jaffer **and ends the session**, after asking when Claude Code is working or a command is running (the question's default button is Cancel, and Esc cancels). Only that item asks: a logout, restart or shutdown, an AppleScript quit and *Quit* in the Dock's menu end the session **without asking**, and a running Claude Code or command stops. There is exactly one session and one terminal, by design (use `tmux` inside it if you want panes).

**Settings** (`⌘,`): *Appearance* (themes, following macOS or the time of day with a light theme, font and size, window opacity, blur, window glow, system stats in the title bar, cursor, Option as Meta, animations, the companion and which one, GPU rendering, the global hotkey, keeping the Mac awake while Claude works, opening at login), *Terminal* (command blocks, asking before pasting several lines, a column ruler, the editor link for file paths, inline images, links to local servers), *Claude Code* (sign-in help, connect or disconnect the hooks, *Tell me when Claude finishes*, *Show what each answer cost*, live cost, a daily budget, the tool strip, the turn summary, and which of the eleven hook events Claude Code has sent and when), *Updates* and *Reset*.

| | |
|---|---|
| ![Needs you](docs/screenshots/03-needs-you.png)<br><sub>**It tells you when it needs you.** The companion sits up with a `!`, the title bar names the tool and what it asks, and a notification follows if the window is behind.</sub> | ![Light](docs/screenshots/07-light.png)<br><sub>**Light theme**, same calm layout (one of eleven).</sub> |
| ![Settings](docs/screenshots/12-claude-code-settings.png)<br><sub>**Claude Code settings:** sign-in help, the hooks, the finished notification, the cost switches, a daily budget, the tool strip and the turn summary.</sub> | ![Updates](docs/screenshots/13-updates.png)<br><sub>**Updates ask first**, because updating ends your terminal session.</sub> |
| ![Welcome](docs/screenshots/01-welcome.png)<br><sub>**First launch.** Two switches, both yours; a plain terminal with no Claude at all is one click on the step before.</sub> | ![Command blocks](docs/screenshots/16-command-blocks.png)<br><sub>**Command blocks.** A mark beside each command (green, red or still running), one block lit under the pointer and a pinned line at the top.</sub> |

<p align="center">
  <img src="docs/screenshots/17-title-bar.png" width="720" alt="The top of the window while Claude works: the folder with its git counts, a ring about two thirds full beside the running command, a pencil chip with the file being edited, a thin strip of this turn's tool calls (reads, writes and shell commands, one failed) and a cost figure that reads 'so far' because it is still growing." />
</p>

<sub>The screenshots are the real app, generated by `npm run screenshots` from a scripted demo session (real git repo, real zsh; only Claude Code's hook events, its token counts and, in the title-bar picture, a stand-in for `claude` that just waits are scripted, so the run is deterministic).</sub>

## Companions

Pick one in *Settings → Appearance* (each choice is shown live there), or switch the companion off.

| | | |
|---|---|---|
| ![Mole](docs/screenshots/companion-mole.png)<br><sub>**Mole.** Digs while something runs; a helper mole for every agent.</sub> | ![Matrix](docs/screenshots/companion-matrix.png)<br><sub>**Matrix.** Digital rain; every agent is a bright column.</sub> | ![Agent network](docs/screenshots/companion-agents.png)<br><sub>**Agent network.** Nodes passing data back and forth.</sub> |
| ![Warp](docs/screenshots/companion-warp.png)<br><sub>**Warp.** A starfield at speed, a wingman per agent.</sub> | ![Radar](docs/screenshots/companion-radar.png)<br><sub>**Radar.** A sweep and a blip per agent.</sub> | ![Reactor core](docs/screenshots/companion-core.png)<br><sub>**Reactor core.** Rings, energy bars and orbiting agents.</sub> |

<p align="center">
  <img src="docs/screenshots/15-companions.png" width="720" alt="Settings, Appearance: a Companion switch and six live previews to choose from (Mole, Matrix, Agent network, Warp, Radar, Reactor core)." />
</p>

All six behave the same way. They sleep when nothing runs, rest while Claude Code is open, work while a command or Claude works, sit up with an alert when Claude needs you, and celebrate when a turn ends. **The longer the work takes, the harder they go**: faster after 30 seconds, strained after 2 minutes, at full tilt after 5. **Every background agent brings a helper** (up to three) that celebrates when its agent finishes. **They notice the tool:** the mole shows a book while Claude reads, a hammer while it writes, an antenna for the web and a hard hat for agents (a helper mole shows its own agent's tool), and the scenes change colour or rhythm. After ten minutes of nothing they doze (dimmer, slower) and wake at any activity. When a command that failed three times in a row finally exits 0, a short burst of sparks says so, and a bell makes the companion flinch (and, with the window behind, bounces the Dock icon once).

They are decoration only: they ignore the mouse, stand still with *Settings → Appearance → Animations* off or macOS *Reduce motion* on, take their colours from the theme, and never type or send anything.

## Claude Code

There is exactly one Claude: the `claude` in your terminal (`⇧⌘C`, or just type it). You talk to it there, with its own permission prompts; Jaffer adds no second chat or panel and answers none of Claude Code's questions. Claude Code reports what it does through hooks, and Jaffer turns that into the companion, the title-bar ring, the notifications and the cost figure. It follows only a `claude` running in Jaffer's own terminal, redacts everything it handles, and notices a declined prompt or `Esc` from the transcript (Claude Code fires no hook for those).

Jaffer runs on Claude **subscriptions** only: there is no API key anywhere (`ANTHROPIC_API_KEY` is ignored), and whether you are signed in comes from `claude auth status`. Sign-in opens your browser and nothing is typed into your terminal for it. The only thing Jaffer ever types into your terminal is `claude`, when you press `⇧⌘C` or leave *Start Claude Code in the terminal now* on at first launch.

- **The hooks.** *Settings → Claude Code → Connect* (or `jaffer setup claude`) adds Jaffer's hooks to `~/.claude/settings.json`: eleven events (prompts, tool calls, background agents, notifications, the end of a turn, the start and end of a session, and the moment before Claude compacts its context), all asynchronous, so they never delay Claude, and all of them do nothing outside Jaffer's own terminal. Your own hooks and settings are never touched, only entries tagged `jaffer-managed`; *Disconnect* (or `--remove`) takes them out.
- **What each answer cost.** After every answer a figure like `≈ $0.04` appears in the title bar; while Claude works it grows, greyed (`≈ $0.03 so far`, read from the token counts every 2 seconds; *Settings → Claude Code → Live cost* turns that off). Hover for the tokens, the session total, **today's total** and the cost and length of the last 20 turns as two small lines. Set a *Daily budget* and the figure turns yellow at 80 % of it and red past it (nothing is stopped). It is an **estimate**: Jaffer adds up the token counts in Claude Code's own transcript (numbers only, never the words) at Anthropic's API list prices. On a subscription nothing is billed per token, so read it as what the work would be worth. A model without a known price shows tokens, not a guess, and background agents' own usage is not counted. Today's total and the turn history live in memory and start again when Jaffer quits.
- **What Claude is doing.** While it works, the ring beside the folder fills against how long a turn usually takes (the median of your last ones; before there is one it just spins, and past it the ring stays full and pulses); it turns dotted while Claude compacts its context. Hover it for the session clock (`Claude · 42 min · 9 turns · ≈ $1.20`) and each running agent's time. A 2 pixel strip under the title bar shows this turn's tool calls as segments coloured by kind (red when one failed) and as wide as they took. A pencil chip names the file Claude is editing (click to show it in Finder), and when it needs you the title bar says which tool and what it asks, and "2nd time" when you have already answered a prompt for that tool in this session. **You still answer in the terminal: Jaffer answers nothing.**
- **When a turn ends** (10 seconds or more, not cut short) a toast says how long it took, what it did (`3 reads, 2 edits, 1 shell`), the cost, and lists the files it edited (up to five, each a button that shows it in Finder). *Settings → Claude Code → Turn summary* turns it off. Claude's edited files are remembered by name for the session only, never a path that looks like a key or a credential, and nothing else about the files.
- **Notifications** while the window is in the background: Claude needs you, a long turn finished, a long command finished. *Tell me when Claude finishes* in *Settings → Claude Code* switches the finished-turn one off. In **focus mode** (`⌥⌘F`; `⌃⌘F` is macOS's own full screen) they are held, and when you leave it one notification says what you missed (`While you were focused: Claude finished twice, 1 command failed`). A command that finished while the window was behind also gets a toast when you come back.
- **Quitting stops it.** Claude Code runs in Jaffer's terminal, so it ends with it. `⌘Q` asks first while Claude is working or a command runs; a logout, restart, shutdown or the Dock's *Quit* do not (macOS takes a question at logout as the app refusing to quit and cancels the logout), so save your work before you log out with Claude running.
- **Awake while Claude works.** While Claude (or a background agent) works, or a command has run for 30 seconds or more (not an interactive program such as `ssh`, `vim` or `tail -f`; capped at 6 hours), Jaffer holds the Mac off idle sleep with `caffeinate -i`, no admin rights and no password, and lets go 15 seconds after the work stops. The screen can still sleep. **It does not override the lid:** a laptop on its own with the lid closed still sleeps, and everything pauses until it wakes. With power, an external display and a keyboard or mouse (macOS's closed-display mode) it keeps working; that has not been checked on a real Mac yet. *Settings → Appearance → Keep my Mac awake while Claude works* switches it off.

## The terminal and the command line

**What the terminal adds.** *Command blocks* read the shell's own marks (zsh, bash and fish, as Jaffer's shell integration emits them) on the window's side: after a re-attach or a clear they start again, and a program in the full-screen mode (`vim`, `claude`) is one block. They do not fold output (the terminal has no folding). *Pasting several lines* asks first (*Paste* or *Cancel*), and dropping a file still pastes its path. A *file path* that a program prints is clickable with ⌘ (`path`, `path:line`, `path:line:col`; absolute, `~/` or relative to your folder): it shows the file in Finder, or opens it in the editor you choose in *Settings → Terminal* (`vscode://file/{path}:{line}:{col}`; only editor links such as VS Code, Cursor, Windsurf, Zed, IntelliJ, Sublime and TextMate are allowed). Jaffer never opens or runs a path a program printed. *Recent commands* (`⌘R`) lists this session's commands and **copies** the one you pick: nothing is typed for you. *Images* in the terminal (sixel and iTerm2 inline images) work and can be switched off; **Kitty graphics are not supported**. *Git counts* come from `git status` after each prompt (1 second at most, no lock taken; a repository whose own config names a filter program, as Git LFS can when configured locally, shows no counts, and on a Mac without the developer tools git is not run). A running server's `localhost:5173` gets a chip in the title bar.

The app is a window onto `jafferd`, a process it starts as its own child: it owns your shell, a headless copy of the screen and what Claude Code is doing, and it ends with the app (quit, crash or kill). Re-attaching the window, after a page reload say, restores the exact screen, including full-screen programs. If your shell exits, a fresh one starts in the same folder with a blank screen.

```sh
jaffer status | doctor    jaffer setup claude [--remove|--status]
jaffer config get|set <dot.path> <json>    jaffer daemon [status|stop]
```

The command line talks to the running app and never starts a terminal. With Jaffer closed, `status` and `doctor` say it is not running and `daemon start` fails (*Jaffer is not running. Open Jaffer and run this again.*); `setup claude` fails the same way only when `~/.jaffer/bin/jaffer`, the wrapper the app writes when it starts, is missing, while `setup claude --status` and `--remove` always work; `config get|set` fall back to `config.json`. `daemon stop` ends the session, which quits the app with it. Inside Jaffer `jaffer` is already on your `PATH`; elsewhere run *Install the `jaffer` command* from the palette.

**Start over:** *Settings → Reset → Reset…*, or `jaffer reset` from another terminal (`--yes` skips the question, `--delete` skips the backup). It ends the session and removes `~/.jaffer` (moved aside as `~/.jaffer.backup-<time>` unless you delete it), Jaffer's hooks in Claude Code, the `jaffer` link and the app's data, together with anything an older Jaffer left behind (its login agent, its memory tools in Claude Code, the block it wrote into `~/.claude/CLAUDE.md`, the skills it published). Claude Code itself, its login and your own settings stay. If `~/.jaffer` is a link, Reset renames or removes the link, not what it points to. Then drag Jaffer.app to the Trash.

## Development

```sh
npm ci && npm run build        # esbuild: daemon, CLI, Electron main/preload, renderer
npm run dev                    # build + launch
npm run typecheck && npm test  # real PTYs (bash, zsh), the bundled daemon and CLI as processes, the real `claude` where it is installed
npm run test:e2e               # the real UI in headless Chromium against the real daemon (set JAFFER_CHROME)
npm run screenshots            # regenerate docs/screenshots (temp homes; needs a short TMPDIR and JAFFER_CHROME); then python3 scripts/shrink-screenshots.py
scripts/release-mac.sh         # on your Mac: build, sign, notarize, verify; --publish uploads it
```

**Careful when you run the app from a checkout:** `npm run dev`, `npm start` and `npm run smoke` use your real `~/.jaffer`, and on a Mac that ran an older Jaffer (0.5 or earlier) the first start cleans it up for real (it deletes the old memory and saved session there). Give them a throwaway folder: `JAFFER_HOME=/tmp/jaffer-dev npm run dev` (the name must contain "jaffer"). That protects your Claude Code files and launchd from the first-start clean-up only (it touches `~/.claude`, the login agent and the MCP server only for the default home). A run with a throwaway `JAFFER_HOME` can still write hooks into your real `~/.claude/settings.json` (the first-run switch *Let Jaffer follow Claude Code* and *Settings → Claude Code → Connect*, pointing at that home's wrapper), and *Settings → Reset* or `jaffer reset` remove the real hooks, MCP server, `CLAUDE.md` block and skills of Jaffer's from your real `~/.claude`. *Settings → Reset* and `jaffer reset` also remove Jaffer's app data under your real `~/Library` (Application Support, Preferences, Saved Application State, Logs, Caches and the update cache), and the palette's *Install the `jaffer` command* links `~/.local/bin/jaffer` to that home. For experiments use a throwaway `HOME` as well, as the tests do: `HOME=/tmp/jaffer-x JAFFER_HOME=/tmp/jaffer-x/.jaffer npm run dev`. The tests use temporary homes, and `JAFFER_NO_LAUNCHCTL=1` keeps them away from the real `launchctl`.

`src/core` has no Electron dependency, so nearly everything is tested as real processes. CI runs the suite on Linux and macOS, builds the `.app`, boots it in a smoke test (`JAFFER_SMOKE=1`) and checks signing end to end with a throwaway identity. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [CLAUDE.md](CLAUDE.md) for the layout and the rules that matter.

**Not verified here:**
- a real Claude sign-in (tests use the real `claude` binary against a mock API and a stand-in for the login page);
- the companions and the cost figure against a real Claude Code session (their inputs were checked against real hook payloads and transcript fields, then driven by scripted events);
- clicking *Update and restart* through to the new version;
- needing a person at a Mac: notifications, the global hotkey and the WebGL renderer on your GPU;
- **the first start on a Mac that ran an older Jaffer (0.5 or earlier; the clean-up shipped in 0.6.0 and 1.0.0 repeats it)**, with its login agent, its Claude Code settings, its memory data and a session still running. The clean-up is tested on seeded temporary homes against a stand-in `launchctl` and a stand-in `claude`, because the real ones would touch your LaunchAgents and your Claude Code. Not checked on a real Mac: a real `launchctl bootout` of an installed agent, a real `claude mcp remove jaffer -s user` (its exit code and message when nothing was registered), and the dialog offering to end an older Jaffer's background session when a real one is still running;
- **the child ending when the app is killed:** quitting and crashing are tested with real processes, and a `SIGKILL` of the parent only with a Node stand-in for the app, not with the real Electron app;
- **the packaged app's own dialogs:** the quit question (`⌘Q` with Claude Code or a command running), the question about an older Jaffer's session and the terminal-stopped dialog are type-checked and built, and their decisions are unit-tested, but the dialogs themselves have not been clicked on a real Mac (CI's smoke test boots the packaged app and checks that its terminal is the app's own child). That includes what Return and Esc do in the first two, where one button is both the default and the cancel button (Cancel in the quit question, Quit in the other): they are meant to end nothing;
- **quitting without a question:** a logout, restart or shutdown with Claude Code or a command running (the session should end and the logout go on, without a question), the Dock's *Quit*, and an AppleScript quit;
- **Settings → Reset in the packaged app** (it stops the terminal, removes what it removes and relaunches the app);
- **starting 1.0.0 while the older Jaffer app is still open:** the second-instance guard should make the new app exit at once and bring the old window forward, so quit the older Jaffer first;
- **staying awake on a real Mac:** `pmset -g assertions` showing the hold while Claude works and not after, and a closed lid with and without power and an external display (the tests use a stand-in for `caffeinate`).

- **1.0.0's additions, checked only in headless Chromium (the real renderer against the real daemon) or with stand-ins, not in the packaged app on a Mac:**
  - the tooltips and clicks in the title bar under macOS's drag regions (the elements are marked no-drag and that is checked through computed style, not by hovering a real window);
  - `setVibrancy(null)` with *Blur* off, and the opaque colours that go with it;
  - `⌘↑`, `⌘↓`, `⌘G`, `⇧⌘G`, `⌘R`, `⇧⌘L`, `⌥⌘C` and `⌥⌘F` arriving through the real macOS menu (the tests call the same actions through a shim);
  - the resource strip and the battery on real hardware (a desktop Mac should show no battery; the Chromium run reports one), and the five-second sampling in the app's main process;
  - *Follow macOS / time of day* on a real Mac (the system's light and dark appearance and the clock; the tests emulate both) and the 1 second crossfade;
  - what the scroll bar's marks for search matches look like at your sizes;
  - ⌘-clicking a path into a real editor through its link (the tests check the link that is opened, and the Finder reveal, not the editor);
  - focus mode's held notifications and the one summary notification in the packaged app, and the Dock bounce for the bell and for *needs you* (not exercised: it needs a person and a Dock);
  - the git guard on a real Mac without the developer tools (`xcode-select -p` failing), and git status in repositories with unusual configuration;
  - the first start after updating: the hooks get their eleventh event (`PreCompact`) when the new app's terminal starts, tested on temporary homes, not on a real `~/.claude/settings.json`;
  - the sticky header, the gutter marks and the overview ruler with the WebGL renderer on a real GPU (the UI tests and the screenshots use the DOM renderer).

None of this counts as verified until the owner of the Mac has checked it there.

## Limitations

- macOS only. Fish integration is experimental (zsh and bash are tested).
- Jaffer keeps no session of its own: when it quits, updates or crashes, the shell and Claude Code end, and the next start is a fresh terminal. Claude Code's own `claude --resume` and `claude -c` still work, typed by you; Jaffer no longer offers them. (A `tmux` you start in it is yours, and works as anywhere.)
- Only the in-app *Quit Jaffer* (`⌘Q`) asks before it ends a running Claude Code or command. A logout, restart, shutdown, an AppleScript quit and the Dock's *Quit* end the session without asking.
- No Claude panel by design: you answer Claude Code's permission prompts in the terminal.
- Built on xterm.js (WebGL): fast, but not a native GPU terminal like Ghostty. No Kitty graphics, no folding of command output, no soft-wrap toggle (long lines always wrap), no horizontal scrolling.

## License

[MIT](LICENSE)
