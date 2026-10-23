# Security

## Reporting a vulnerability

Please report it privately through GitHub: https://github.com/jafforgehq/jaffer/security/advisories/new

Do not open a public issue for it. Say what you found, the version of Jaffer and of macOS, and how to reproduce it. We answer on the advisory.

## Supported versions

Only the latest release gets security fixes. The app asks before it updates; a version older than 0.2 has no updater, so install the latest from the releases page once.

## What Jaffer protects

Jaffer is a terminal for one person on their own Mac. The model is local trust:

- **The window is sandboxed.** The page runs with `sandbox`, `contextIsolation` and no Node access, under a strict Content Security Policy, and can show only its own page. It reaches the rest of the app through a short list of IPC channels, each of which checks that the sender is that page. It may call only the terminal-host methods it uses, and it gets no web permission (camera, notifications, clipboard reads) except writing the clipboard and, only while the voice switch is on, the microphone (audio only; Jaffer opens it only in voice mode while the window and the voice terminal have the focus, closes it when the window loses the focus, and a recording ends after at most 65 seconds or when the microphone goes away). Since 1.6.0 the window's session also cancels every `http(s)`, `ws(s)` and `ftp` request, from the page and from the voice worker, so neither can fetch, load or open a web socket to anything on the network (main's own model download, the updater and the browser links you click are separate and listed below). One exception: WebRTC (`RTCPeerConnection`) sends its traffic outside those requests, and the Content Security Policy's `webrtc 'block'` is not recognised by the bundled Chromium (checked on Electron 44.5.1), so a compromised page could still use it; Jaffer's own code never does. That list and those switches are defense in depth against a compromised page: they are not a boundary against another program of yours (below).
- **Nothing printed in the terminal is run or opened by itself.** A path is revealed in Finder or handed to an editor link; a link opens in the browser only on ⌘-click, and only `http(s)`. A program may write the clipboard (OSC 52), never read it.
- **Jaffer types into the shell only what the person asked for** (`claude`, the line that resumes a past conversation at an idle prompt, and, with voice mode on, the words you dictated: only into the terminal where voice started, only while you are still in it and Claude Code is idle there, never starting with `/`, `!` or `#`, and never with Enter). Limits: Claude Code can be idle but showing a menu of its own, which would receive the text, and a Claude that has just exited can still look idle for a moment. It never answers Claude Code's own questions. With the opt-in permission prompts, *Allow* exists only in the side panel's Now card, needs a real click and a request shown in full; the notification offers *Show* and *Deny* only.
- **Claude Code's files are read narrowly.** Every read of a transcript is confined to Claude Code's `projects` folder: a link that leads outside it is refused, a link inside it is followed, and only regular `.jsonl` files are opened. Always on: ids, folders, times, token counts (with the cost shown) and a title. Some features read more, keep it nowhere and show only what they say:
  - *Explain* (opt-in): Claude's last reply.
  - *Voice* (opt-in): Claude's last reply (the beginning of a long one, up to 6000 characters), read on this Mac by a speech model so it can be spoken. It is not sent anywhere.
  - *Deep search* (opt-in): the text of the messages, scanned for the words you typed.
  - The stop-line scan (while Claude works): the line Claude Code writes when you decline a prompt or press Esc.
- Claude Code's login (`~/.claude.json`, the keychain) is never read. **The only write to Claude Code's conversation files is moving the conversations you picked to the Trash, after a question** (never a permanent delete).
- **Jaffer writes its own hooks into Claude Code's `~/.claude/settings.json`**: from the first-run switch, *Settings → Connect*, `jaffer setup claude` (the page's `setup.claude.install`), and the permission-request hook whenever that switch changes. Only entries tagged as Jaffer's own are ever changed. *Disconnect*, *Reset* and the first-start clean-up of an older install remove what Jaffer wrote: its hooks, its block in `~/.claude/CLAUDE.md`, the skills it published, and its MCP server (`claude mcp remove jaffer`); never your own settings.
- **Secrets are redacted** before anything from a command or a hook is shown, and a sensitive command is not named at all.
- **No telemetry.** Jaffer keeps no command history, output or transcript text on disk.

## What leaves the Mac

- Jaffer's own update check, to GitHub (only the signed release checks; nothing installs without a click; the feed is not changeable by an environment variable).
- What Claude Code itself does when Jaffer runs it for you:
  - asking it whether you are signed in, and the *Sign in* button (`claude auth login`, which opens your browser);
  - *Check MCP servers* (only on your click), which connects to your servers. Since 1.4.2 it runs with the `PATH` your focused terminal's shell reported; that report is signed with a random value the shell keeps in an unexported variable (zsh and bash take it out of the environment before your startup files run, fish after `config.fish`), so text a program prints in the terminal cannot change it. Only absolute folders of that `PATH` are used, so the check never runs a program from the folder it checks (a cloned repository's own `./npx`). Servers a project names in its `.mcp.json` and you have not approved are not started by Claude Code (checked on 2.1.302). Settings can approve them in advance: a repository's own `.claude/settings.json` or `settings.local.json`, or your own user-level ones (`enableAllProjectMcpServers`, `enabledMcpjsonServers`). When any of them does, and the folder has a `.mcp.json`, Jaffer runs the check from your home folder instead and says so;
  - the *Explain* helper's model call, which sends Claude's last reply through your own Claude Code.
- **Voice (opt-in), once:** the speech models, downloaded by Jaffer's main process over https from `huggingface.co` or a host ending `.hf.co` (no user name, no port, at most three redirects), only after you turned voice on and confirmed, into `~/.jaffer/voice/` (private to your account). Every file is checked against a SHA-256 pinned in the app and thrown away if it differs. Nothing else about voice leaves the Mac: the microphone is open only while Jaffer listens, the audio stays in memory for one recording and is dropped after it is turned into text, and neither audio, transcripts nor Claude's text are written to disk or logged.
- Whatever the programs in the terminal send, Claude Code included: that is theirs, not Jaffer's.

## What Jaffer does not protect against

- **Other programs of the same user.** Any process running as you can talk to Jaffer's terminal host on its socket (`~/.jaffer/run`, private to your account) and type into the shell, as it could into any terminal. The folder and socket are private to your user account, not to Jaffer.
- **Someone with your account or an administrator.** They can read your files, Claude Code's included.
- **Claude Code itself, and the commands you run.** Jaffer shows what Claude Code's hooks report; what Claude Code or a command does is up to them and to you.
- **A malicious repository's own tooling.** Jaffer's git status refuses repositories that set filter drivers, but a repository you trust and build can still run code.

## Licence

Jaffer is GPL-3.0-or-later since 1.6.0, because voice mode bundles espeak-ng (GPL-3.0-or-later). The licence text and the third-party notices ship with the app (`LICENSE`, `THIRD-PARTY-NOTICES.md`).

## Out of scope

- Findings that need another program already running as your user, or root.
- The macOS entitlements and Electron fuses of the signed app (known; listed in the README's limits as work for a later release).
- Denial of service by a local process of the same user.
- Bugs in Claude Code, Electron or macOS themselves (report those upstream; tell us if Jaffer makes one worse).
