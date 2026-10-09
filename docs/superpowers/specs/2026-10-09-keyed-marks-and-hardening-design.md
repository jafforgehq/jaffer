# Keyed prompt marks, and the 0.5.1 hardening pass

Date: 2026-10-09 · Status: scope approved in conversation ("yes", and "if there are some additional issues please fix them also"); this document is the written spec, for review before a plan is written.

## Why

Jaffer decides what the shell is doing from invisible terminal marks that its shell integration prints: `OSC 133;A` (prompt start), `133;C` (command start), `133;D;<exit>` (command end), `633;E;<command line>` and `633;P;Cwd=<dir>`. **Any program can print the same bytes.** 0.5.0 closed the biggest case (an `ssh` session whose remote shell prints the marks) by also requiring the terminal's foreground process to be the shell itself. Two cases remain, reproduced in real bash and zsh in the final review of 0.5.0:

1. A background job prints `133;C`, `133;D;0` and `133;A` while the person has a half-typed line: the daemon sees "command finished, empty prompt", the dirty line counts as clean, and after 2 s of quiet and the 3 s notice `claude --resume <id>` is added to the line.
2. A function or sourced script prints `D` and `A` and then reads input: the text Jaffer types lands in the script's `read`.

The product promise is that Jaffer never types where it should not. This release closes the cause, not another symptom: a mark only counts if it carries a secret that only Jaffer's own integration knows. It also fixes the cheap items left from the 0.5.0 reviews, and checks the launchd and power behaviour on a real Mac, which has so far only been tested against stand-ins.

## Decisions (made with the product owner)

- Fix by a **per-shell secret on every Jaffer mark** (the approach VS Code uses for its 633 marks).
- Take the **cheap deferred items** into the same release, and fix **any further issue the review of this work finds**.
- **Verify launchd, Login Items and power on the owner's Mac** after the release is installed, with the owner present and saying yes at that point (it touches the LaunchAgents folder).
- Ship as **0.5.1**.

## The design: keyed marks

### Protocol
- The daemon generates a random key for every shell it spawns (`crypto.randomBytes(16)`, hex, 32 characters) and keeps it in the `PtySession`. It is never persisted, never logged and never put in an RPC event.
- Every mark the integration scripts print ends with a `;jk=<key>` field: `133;A;jk=K`, `133;C;jk=K`, `133;D;<exit>;jk=K`, `633;E;<escaped command>;jk=K`, `633;P;Cwd=<escaped dir>;jk=K`. The command text and the directory are already escaped so that `;` cannot occur inside them (`\x3b`), so the last field is unambiguous. Other terminals ignore unknown trailing fields on 133.
- The parser (`registerOscHandler(133)` and `(633)` in `src/core/session/terminal.ts`) accepts a mark **only if its last field is exactly `jk=<this shell's key>`**, before it changes any state or emits any event. A mark with no key, a wrong key or a malformed field is ignored completely. This covers marks from a background job, from `ssh`, from `docker exec`, from fish 4's and other terminals' own integrations, and from a hostile file shown with `cat`.
- **Fail safe.** If the integration never loaded, or the key is lost, no mark is accepted: auto-resume, Restart Claude's hold and the Resume button never see a prompt and do nothing. Features that read the same marks (command history for memory, the "something is running" cue, the title bar's folder) degrade to what they do in a plain terminal; the folder still follows through `OSC 7` where the shell sends it. Nothing types.

### Delivering the key without leaking it
- At spawn the key goes into the shell's environment as `JAFFER_MARK_KEY`. The very first thing each integration entry point does is copy it into a **non-exported shell variable** and `unset` the environment variable, **before the user's own startup files run**:
  - zsh: the `.zshenv` shim (`resources/shell/zsh/.zshenv`) runs first (only `/etc/zshenv` precedes it).
  - bash: the first line of `jaffer-bash-init.sh`, before it sources `/etc/profile`, `~/.bash_profile` or `~/.bashrc`.
  - fish: the `-C` command runs after `config.fish`, so a program started by the person's own `config.fish` can see the variable. Fish integration is documented as experimental; the exposure is stated in the docs.
- Programs the shell starts later (background jobs, `ssh`, `docker`, a `claude` run) therefore do not inherit the key.
- `JAFFER_MARK_KEY` is added to the environment strip list so it never reaches anything else the daemon spawns (the existing `STRIP_ENV` mechanism).

### What it closes and what it does not
- Closes: any **program** that prints marks, whether in the foreground, in the background, or on a remote machine. This includes the two reproduced cases when the forging code is an external program or job.
- Does not close: **code run by the shell itself**, a function, a sourced script or a subshell, which can read the shell variable. That code is as trusted as the person's shell (it could type into the line directly). The README's limitation shrinks to exactly this sentence.
- The 0.5.0 foreground-process check stays as a second layer.

## Hardening items taken from the 0.5.0 reviews

Each is small; each gets a failing test first.

1. **Fewer `ps` calls.** About 6 synchronous `/bin/ps` calls run per command while an offer is pending (about 4 ms each on the daemon thread, up to 2 s if `ps` hangs). The foreground check is cached per event (a prompt, a command start) and bounded by a 500 ms timeout.
2. **Pasted text after a newline.** One `pty.write` with a command, a newline and more text (bash 3.2 has no bracketed paste) leaves the extra text uncounted. Text after the last newline of a write that is not a bracketed paste marks the line as started across the next command start.
3. **Resume button with a non-standard shell.** `SHELL=/bin/sh` on macOS runs bash, and a wrapper shell has another name; the name comparison hides the button. The terminal's foreground process group (`tpgid` equal to the shell's pid) is the authority; the name check is dropped.
4. **`jaffer service remove` inside the launchd-run session** ends the terminal it was typed in. When `JAFFER_SESSION=1` and the status is `running`, it asks for `--yes` (and prints the warning first).
5. **The config flag and the agent agree.** `jaffer config set session.keepRunning ...` flips only the flag; the agent is reconciled on the next start. A change of `session.keepRunning` now reconciles the agent (with every existing guard: default home, refusals, confirmation rules) so the two cannot disagree for a whole session.
6. **Old-daemon messages.** Restart Claude and `jaffer service` against a pre-0.5 daemon show a raw "unknown method". They say what Settings already says: restart the session to use this.
7. **`ensureDaemon` during launchd's throttle.** If `kickstart` lands while the old daemon is still exiting, launchd starts nothing and `ensureDaemon` waits 12 s and throws once. It re-kickstarts inside the wait loop.
8. **Small user-facing items.** The Settings status line is refreshed after a Cancel. End Session's two sequential 30 s calls get 5 s timeouts, so a hung daemon cannot delay quitting by a minute. The first-run switch's copy says what is true: the agent is active from the next login or restart. The README row for End Session says launchd starts a fresh session at the next login.
9. **`caffeinate` that dies by itself.** The stay-awake controller notices the child's exit and re-holds with a short backoff, logging a spawn error once, instead of believing it still holds.
10. **`isInteractiveCommand` through wrapper options.** `sudo -u deploy vim`, `nice -n 10 top` and `env -u FOO ssh` are recognised as interactive, using the same option tables as `sshHost`.

## Verification on the owner's Mac (after the release is installed in /Applications)

Only with the owner present and saying yes at that moment, because the agent touches `~/Library/LaunchAgents`. The owner turns the switch on in Settings; Claude runs read-only checks and the one `kill -9`:
- `launchctl print gui/<uid>/com.jafforge.jaffer.daemon` shows the job and its program, and Login Items → Allow in the Background lists Jaffer (not an unidentified item).
- A `kill -9` of the daemon: it is running again within about 5 s, the shell is back in the same folder with the last saved screen, and Claude is resumed (auto-resume on).
- `kickstart` on the running job and during the throttle, `bootout` from inside the job (turning the switch off while launchd runs the session), logging out and in, and an update with the agent on.
- `pmset -g assertions` shows the hold while Claude works and not 15 s after; a closed lid with and without power and an external display.
- A real `claude --resume` of a real conversation, and a native notification.
Each result is written into the release notes and the README's "Not verified here" list as verified or as still open, with what was seen. Anything that fails becomes a fix in 0.5.1 or a documented limitation.

## Testing
- **Keyed marks (real processes):** forged marks from a background external program, from a stand-in `ssh`, and from a file shown with `cat`, none changes `promptReady`, `busy`, the command events or `lineEmptyAt`; the shell's own keyed marks still do; a shell whose integration was not loaded accepts nothing and nothing is typed; the key is not in the environment of a program started from the shell (`env` in the shell shows no `JAFFER_MARK_KEY`) and not in the environment of a program started by the person's `.zshrc` / `.bashrc`; bash, zsh and (where `fish` is installed) fish; a pasted or typed command containing `;jk=` text does not confuse the parser; the key never appears in an event, RPC reply or log.
- **Unit:** the mark parser accepts exactly the keyed form and rejects every other form (missing, wrong, truncated, duplicated field, mark inside a mark); the key generation; the `STRIP_ENV` entry.
- **Each hardening item** has its own test as listed above; the existing suites keep passing; the final whole-branch review runs again on the diff and must find no Critical item before release.

## Release
Version 0.5.1 in `package.json` and `package-lock.json`; `docs/releases/v0.5.1.md` replaces v0.5.0.md (`mkdir -p docs/releases` before writing after a `git rm`); README, ARCHITECTURE and CLAUDE.md updated (the known limitation shrinks; the mark protocol and the loading order are documented; a rule that every new mark carries the key); a signed, notarized build from a separate checkout (never from the repo folder, which holds the owner's running app), uploaded in the safe order (files, manifest, Latest) and compared with GitHub.

## Out of scope
- Defending against code the shell itself runs.
- Changing the marks other tools read (`OSC 7`, `OSC 9`, `OSC 777` notifications).
- Fish's exposure window beyond documenting it.
- Linux and Windows.

## Open points for the review
- Fish: the key is visible to programs started by `config.fish` (the `-C` hook runs afterwards). Accepted and documented, since fish integration is experimental; say if fish should instead refuse to emit marks without a key.
- Commands, folders and the "something is running" cue now depend on the keyed marks too. A shell where the integration cannot load degrades to a plain terminal for those. Say if that is acceptable (it is the safe direction).
