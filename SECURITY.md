# Security

## Reporting a vulnerability

Please report it privately through GitHub: https://github.com/jafforgehq/jaffer/security/advisories/new

Do not open a public issue for it. Say what you found, the version of Jaffer and of macOS, and how to reproduce it. We answer on the advisory.

## Supported versions

Only the latest release gets security fixes. The app asks before it updates; a version older than 0.2 has no updater, so install the latest from the releases page once.

## What Jaffer protects

Jaffer is a terminal for one person on their own Mac. The model is local trust:

- **The window is sandboxed.** The page runs with `sandbox`, `contextIsolation` and no Node access, under a strict Content Security Policy, and can show only its own page. It reaches the rest of the app through a short list of IPC channels, each of which checks that the sender is that page. It may call only the terminal-host methods it uses, and it gets no web permission (camera, microphone, notifications, clipboard reads) except writing the clipboard. That list and those switches are defense in depth against a compromised page: they are not a boundary against another program of yours (below).
- **Nothing printed in the terminal is run or opened by itself.** A path is revealed in Finder or handed to an editor link; a link opens in the browser only on ⌘-click, and only `http(s)`. A program may write the clipboard (OSC 52), never read it.
- **Jaffer types into the shell only what the person asked for** (`claude`, or the line that resumes a past conversation, at an idle prompt). It never answers Claude Code's own questions, and an "Allow" from the notification needs a real click on a request shown in full.
- **Claude Code's files are read narrowly.** Every read of a transcript is confined to Claude Code's `projects` folder: a link that leads outside it is refused, a link inside it is followed, and only regular `.jsonl` files are opened. Always on: ids, folders, times, token counts (with the cost shown) and a title. Some features read more, keep it nowhere and show only what they say:
  - *Explain* (opt-in): Claude's last reply.
  - *Deep search* (opt-in): the text of the messages, scanned for the words you typed.
  - The stop-line scan (while Claude works): the line Claude Code writes when you decline a prompt or press Esc.
- Claude Code's login (`~/.claude.json`, the keychain) is never read. The only write is moving conversations the person picked to the Trash, after a question.
- **Secrets are redacted** before anything from a command or a hook is shown, and a sensitive command is not named at all.
- **No telemetry.** Jaffer keeps no command history, output or transcript text on disk.

## What leaves the Mac

- Jaffer's own update check, to GitHub (only the signed release checks; nothing installs without a click).
- What Claude Code itself does when Jaffer runs it for you:
  - asking it whether you are signed in;
  - *Check MCP servers*, which connects to your servers;
  - the *Explain* helper's model call, which sends Claude's last reply through your own Claude Code.
- Whatever the programs in the terminal send, Claude Code included: that is theirs, not Jaffer's.

## What Jaffer does not protect against

- **Other programs of the same user.** Any process running as you can talk to Jaffer's terminal host on its socket (`~/.jaffer/run`, private to your account) and type into the shell, as it could into any terminal. The folder and socket are private to your user account, not to Jaffer.
- **Someone with your account or an administrator.** They can read your files, Claude Code's included.
- **Claude Code itself, and the commands you run.** Jaffer shows what Claude Code's hooks report; what Claude Code or a command does is up to them and to you.
- **A malicious repository's own tooling.** Jaffer's git status refuses repositories that set filter drivers, but a repository you trust and build can still run code.

## Out of scope

- Findings that need another program already running as your user, or root.
- The macOS entitlements and Electron fuses of the signed app (known; listed in the README's limits as work for a later release).
- Denial of service by a local process of the same user.
- Bugs in Claude Code, Electron or macOS themselves (report those upstream; tell us if Jaffer makes one worse).
