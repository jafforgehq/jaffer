# Keep the session and Claude running

Date: 2026-10-08 · Status: design approved in conversation (auto-resume every time; a LaunchAgent that keeps the daemon alive; a notice, never a kill, for a second Claude conversation; stay awake while something works). This document is the written spec, for review before a plan is written.

## Why

The product promise is one session that never ends. Today it survives the app quitting or being killed, but not a daemon crash, a reboot or an update, and Claude Code does not come back with it:

1. The daemon is started only by the app (or the CLI). If it crashes, or after a reboot, nothing runs until the person opens Jaffer. *Open at login* exists but is off by default and does not supervise a crashed daemon.
2. Nobody supervises `claude`. If it crashes or the shell restarts, it stays down.
3. Resuming is a click (`Resume Claude`), and only when a list of conditions holds, so after an update or a reboot the person lands in a fresh shell and has to notice and click.
4. Nothing says when a second Claude conversation has started, which is the case that makes "resume the right one" ambiguous.

5. Closing the lid or walking away puts the Mac to sleep, and while it sleeps nothing runs: a long Claude task simply pauses (and a network connection can drop meanwhile).

The goal, in the person's words: the Claude session is resumed every time, there is only one session, it cannot be killed, and it keeps working when the laptop is left alone or closed. The honest form of the last part: **it cannot be lost by accident** (app quit or kill, daemon crash or `kill -9`, update, reboot). It still ends when the person ends it on purpose, and when a power cut or an administrator removes the launchd job. Nothing in this design claims more.

## Decisions (made with the product owner)

- **Auto-resume, every time**, replacing click-only. This relaxes a rule in `CLAUDE.md` ("Jaffer never types by itself"); see Rules.
- **launchd owns the daemon**, installed with the person's consent. Nothing is installed silently.
- **Two Claude conversations: tell, do not kill.** Jaffer never ends a process the person started.
- **Stay awake while something works**, with no admin rights: an idle-sleep assertion, on by default. Not the `pmset disablesleep` route (it needs a password, and a closed laptop under load overheats), not a remote daemon (a separate project).
- One terminal stays one terminal; this adds no panes, tabs or second sessions.

## Behaviour

### 1. Always on: a LaunchAgent that owns the daemon

- Setting `session.keepRunning` (boolean, default **false**): *Settings → Appearance → Keep my session running in the background*, next to *Keep the screen for a restart*. First run gets the same switch in the consent step, on by default and worded plainly ("restart my session automatically after a crash or a reboot"), like the existing *Start Claude Code in the terminal now*. Existing users get nothing installed until they turn it on; there is no nag.
- When on, the daemon writes `~/Library/LaunchAgents/com.jafforge.jaffer.daemon.plist` and loads it (`launchctl bootstrap gui/<uid>`). The label is `com.jafforge.jaffer.daemon`. Contents: `RunAtLoad` true; `KeepAlive` = `{ SuccessfulExit: false }`; `ThrottleInterval` 5; `LimitLoadToSessionType` Aqua; stdout and stderr to `~/.jaffer/run/jafferd.log`; `ProgramArguments` = the wrapper below; `EnvironmentVariables` = `JAFFER_HOME` only. The plist holds no secrets.
- **Wrapper** `~/.jaffer/bin/jafferd` (a shell script, written with the plist, mode 0755): if the app binary it was written for is gone (the app was deleted or moved) it removes the agent (`launchctl bootout`, plist, wrapper) and exits 0; otherwise `exec`s the app's own binary with `ELECTRON_RUN_AS_NODE=1` on the daemon script. A daemon that cannot start therefore cleans up after itself instead of failing forever.
- **Exit codes decide whether launchd restarts it.** A deliberate end (`app.shutdown`: Quit and End Session, Update and restart, Reset, `jaffer service remove`) exits **0**: not restarted. `SIGTERM` and `SIGINT` currently exit 0; they change to exit 143 and 130 (still saving state first). A crash exits non-zero. So `kill`, `kill -9` and a crash are restarted within the throttle interval (5 s), while launchd's own stop at logout, shutdown or `bootout` is not restarted by launchd. Reboot: launchd starts the agent at login.
- **One owner at a time.** While the agent is installed and loaded, the app and the CLI start the daemon with `launchctl kickstart gui/<uid>/com.jafforge.jaffer.daemon` instead of spawning it detached. If the agent is not loaded (a person ran `launchctl bootout`), they fall back to the detached spawn as today and Settings says the agent is not running. The socket-in-use check (`assertFree`) still guards against a second daemon.
- **Refreshed on every daemon start** while the setting is on: the plist and wrapper are rewritten when their content differs (the app moved, a new version), so an update keeps working with no action. After an update the new app's daemon is started the same way as after any restart.
- **Refused where it would break**: when the app runs from a translocated or mounted path (`/AppTranslocation/`, `/Volumes/`), or when `JAFFER_HOME` is not the default `~/.jaffer` (tests and development homes must never touch the real LaunchAgents). The switch then says why ("Move Jaffer to Applications first") and stays off.
- **Removal**: turning the switch off, *Settings → Reset* and `jaffer reset` run `bootout` and delete the plist and the wrapper. `jaffer service install | remove | status` do the same from the command line; `status` says: not installed, installed and running (pid), installed but not loaded, or refused (and why).
- Truth comes from launchd and the plist on disk, not from the config flag alone: at daemon start the flag and the plist are reconciled (flag on and plist missing or stale: write and load; flag off and plist present: remove).

### 2. Claude comes back by itself

- Setting `session.autoResume` (boolean, default **true**): *Settings → Claude Code → Resume Claude automatically*, shown under *Offer to resume Claude Code*; it is disabled while that offer is off. The *Resume Claude* button remains, as the fallback and as what a person sees when auto-resume gives up or is cancelled.
- **Trigger.** The daemon types `claude --resume <id>` and Enter into the main pane when all of these hold: a resume offer exists (the existing `ResumeStore.offer` conditions: nothing running, shell in the folder it ran in, under two weeks old, transcript exists, offer enabled), the shell is at a prompt (the OSC 133 `prompt` event; `promptReady`), nothing is running in the shell, and the person has typed nothing for 2 seconds (`lastInputAt`, set by keystrokes written through `pty.write`). It happens once after a daemon start, and again when `claude` crashes (non-zero exit that is not Ctrl+C, 130, and not a stop, 145 to 150).
- **Never** after a deliberate end: exit 0 or Ctrl+C of `claude`, `SessionEnd`, the "ended" tombstones in `ResumeStore`, or the setting off; and never while the daemon is stopping. The id is the validated one (`isSessionId` where it is kept and again where it is typed). The only thing typed is `claude --resume <id>`.
- **Visible and cancellable.** The daemon pushes `claude.autoresume` `{ state: 'pending', id, typesAt }` and waits 3 seconds before typing. The window shows a toast, *Resuming Claude in 3 s*, with a **Cancel** action (`claude.autoresume.cancel`); Cancel drops this attempt and leaves the button. With no window open (a reboot) nothing waits for a click: it proceeds after the 3 seconds, so Claude is back when the person opens Jaffer.
- **Loop guard.** At most **3 attempts per conversation in any 10 minutes**, with waits of 3 s, 20 s and 2 min before each. The attempt times are saved in the resume file (`claude.json`, mode 0600) so the limit also holds when the daemon itself is restarting in a loop. A resumed Claude that exits non-zero within 30 seconds of being started counts as a failed attempt. After the third, or when the guard trips, it stops, leaves the button, and sends one notification ("Claude keeps stopping; resume it from the button when you are ready").
- **What stays the person's.** Claude Code's own questions (trust, permissions) appear in the terminal and Jaffer answers none of them. Jaffer does not choose a model, flags or a conversation: `--resume <id>` of the one it recorded.

### 3. One Claude

- The terminal stays single: `SessionHost` spawns only `main`, and the daemon has no RPC to create another (unchanged, and still tested).
- When a second Claude conversation becomes active while another is, a toast says so once per pair of conversations: *Two Claude conversations are running. After a restart Jaffer resumes the newest.* "Newest" is the conversation whose hooks were seen last, which is the one `ResumeStore` already keeps. Background agents are not conversations and do not count. Nothing is ended.

### 4. Stay awake while something works

- Setting `session.stayAwake` (boolean, default **true**): *Settings → Appearance → Keep my Mac awake while Claude works*. Its hint says what it does and what it does not: "While Claude or a long command works, your Mac does not go to sleep on its own (the screen still can). A laptop with its lid closed still sleeps unless it is plugged in with an external display and a keyboard or mouse (macOS's closed-display mode)."
- **What counts as work.** A Claude session `working`, or a background agent running; or an ordinary shell command that has run for 30 seconds or more and is not an interactive program (`ssh`, `mosh`, `vim`, `nvim`, `less`, `man`, `top`, `htop`, `tmux`, `screen`, `watch`, `tail -f`, and `claude` itself, which is covered by its own state). A Claude that waits for the person (`needs-you`) is not work. A command-only hold is capped at 6 hours; a Claude that is working is not capped, because it ends when Claude does.
- **How.** The daemon (so it works with no window open and under launchd) runs `/usr/bin/caffeinate -i -w <daemon pid>` while there is work and ends it when there is none: `-i` holds off idle system sleep, never the display, and `-w` makes the hold end by itself if the daemon dies. Release is delayed by 15 seconds after the work stops, so Claude pausing between tool calls does not make it flap. Turning the setting off, the daemon stopping and a non-macOS platform all release or do nothing at once. Never more than one `caffeinate` at a time.
- **What it does not do.** It does not override the lid. On a MacBook that is on its own, closing the lid still sleeps the Mac and everything pauses, then resumes on wake, as today. In macOS's closed-display setup (power, external display, keyboard or mouse) the Mac stays awake by itself and this keeps it from sleeping when idle, so work continues with the lid closed. How far the assertion goes on a given model and macOS version is **to be verified by hand** on the owner's Mac before the README says more than the hint above.
- Visible where macOS already shows it (the battery menu names `caffeinate` as preventing sleep); Jaffer adds no indicator to the calm window.

### 5. What the person gets

| What happens | Result |
|---|---|
| The app quits or is killed | nothing changes (as today) |
| The daemon crashes or is killed | back in about 5 s: same folder, screen restored, Claude resumed |
| The Mac reboots | back at login, Claude resumed |
| An update | the new version starts the daemon, Claude resumed |
| The person walks away mid-task | the Mac stays awake while Claude works, then sleeps normally |
| The lid is closed on a laptop on its own | sleeps and pauses as today, resumes on wake; with power, an external display and a keyboard it keeps working |
| *End Session*, Reset, `claude` exited normally, a power cut, an administrator removing the job | ends, stays ended (no restart, no resume after a deliberate one) |

## Interfaces

- **Config** (`src/shared/config.ts`, with defaults so `conform` keeps them the right kind): `session.keepRunning: boolean` (false), `session.autoResume: boolean` (true), `session.stayAwake: boolean` (true).
- **RPC**: `service.status`, `service.install`, `service.remove` (daemon; also behind `jaffer service`), `claude.autoresume.cancel`. **Events**: `claude.autoresume` `{ state: 'pending' | 'typed' | 'cancelled' | 'gave-up', id?, typesAt? }`.
- **Code**: `src/core/service/launch-agent.ts` (plist and wrapper text, paths, refusal rules; `launchctl` through an injected runner), `src/core/claude/auto-resume.ts` (the decision as a pure function of state and time; the daemon supplies prompt, busy, input and clock), `src/core/session/stay-awake.ts` (the controller: work in, hold on or off out; the process spawner and clock are injected), `ResumeStore` keeps `attempts` (times) beside the point. Renderer: toasts in `state.ts`, two switches in `Overlays.tsx`, the first-run switch.
- `src/daemon/main.ts`: `SIGTERM` exits 143 and `SIGINT` 130 after saving state; `app.shutdown` stays 0. `src/core/daemon-client.ts`: `launchDaemon` uses `kickstart` when the agent is loaded. `src/core/reset.ts`: removes the agent first.

## Rules this changes (`CLAUDE.md`, ARCHITECTURE, README)

- Typing: the daemon now also types `claude --resume <id>` by itself after a restart, for the recorded conversation, under the guard above, never for a deliberate end, always announced with a way to cancel. It still types nothing else; `runCommand` stays absent.
- Persistent configuration outside `~/.jaffer` (a LaunchAgent) is allowed only with the person's switch, only for the default home, and must be removed by Reset and `jaffer reset`.
- "The daemon owns the shell: never make the app a requirement for a running session" gets stronger: with the agent on, neither the app nor a login is.

## Testing

- **Unit (no real launchd):** plist and wrapper text; the refusal rules (translocated path, non-default home); the reconcile table (flag × plist present or stale); exit codes for `app.shutdown`, `SIGTERM`, `SIGINT`; the auto-resume decision table (offer present or not, prompt ready or not, busy, typing in the last 2 s, tombstoned, setting off, daemon stopping, retries and waits, the 30-second failure rule, the loop guard across a restart); the second-conversation rule; the stay-awake controller (starts on the first work, one hold only, the 15-second delayed release, the 6-hour cap for commands only, the interactive-program list, `needs-you` is not work, setting off and daemon stop release, no hold off macOS).
- **Daemon (real processes, the shell-function stand-in for `claude` that echoes its arguments):** after a restart the typed line is exactly `claude --resume <id>` and only for a non-ended conversation; Cancel stops it; a crashed `claude` is resumed up to three times and then not; a deliberate exit is never resumed; a person typing delays it.
- **UI (Chromium against the real daemon):** the toast and its Cancel action, the two switches (and `autoResume` disabled while the offer is off), the first-run switch, the two-conversations notice, the stay-awake switch and its hint.
- **Not testable in CI, to be checked by hand on a Mac, with the owner's say-so before any LaunchAgent is touched:** install the agent, `kill -9` the daemon and watch it return in about 5 s with the screen and a resumed Claude; log out and in; reboot; update with the agent on; `bootout` and uninstall; and stay-awake: that `pmset -g assertions` shows the hold while Claude works and not after, and what a closed lid does with and without power and an external display. On macOS CI a `plutil -lint` of the generated plist is the one automatic check.

## Out of scope

- Overriding the lid on a laptop on its own (`pmset disablesleep` needs admin rights; Jaffer neither runs it nor asks for a password); running the daemon on another machine; ending or limiting Claude processes the person started; answering Claude Code's prompts; any other agent than Claude Code; resuming conversations Jaffer's hooks did not see (a `claude` in another terminal); keeping a running program alive across a reboot or an update (impossible); surviving an administrator who removes the launchd job; Linux and Windows.

## Open points for the review

- First run turns *Keep my session running* **on** by default (the consent step is where the person says so), and existing users keep it **off** until they choose. Say if first run should be off too.
- The 3-second wait before typing, the 3 attempts in 10 minutes and the 2 seconds of quiet are chosen numbers; they are constants in one place and easy to change. So are the 30 seconds before a plain command counts as work, the 15-second release delay and the 6-hour cap.
- Stay awake is **on** by default, because it only holds while Claude or a long command works and can cost battery then; say if it should be off until chosen.
