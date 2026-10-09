# 0.5.1: resuming Claude is a click again, and a hardening pass

Date: 2026-10-09 · Status: scope decided by the product owner in conversation ("remove automatic typing completely"); this document replaces the earlier draft about keyed marks (not needed any more), for review before a plan is written.

## Why

0.5.0 added automatic resume: after an update, a crash or a reboot, the daemon types `claude --resume <id>` into the shell by itself. It is the only place where Jaffer writes into the terminal without a click, and it is the cause of every risky case the reviews found: deciding "the shell is at an empty prompt" from invisible marks that any program can forge, typed-ahead keys, a running `claude -p`, an `ssh` session, a background job that prints the marks. Making it safe cost most of a release and still left one narrow open case.

The click already works without any of it: a quiet **Resume Claude** button appears in the title bar, and a click is the person choosing to type. So 0.5.1 removes the automatic typing. What remains is simpler and cannot type anything the person did not ask for.

## Decision

- **Remove automatic typing completely.** After a restart the **Resume Claude** button is the way back (the same as 0.4.x). Nothing resumes by itself.
- **Keep Restart Claude** (palette and Settings): the person confirms in a native dialog, the shell restarts in the same folder, and the daemon types `claude --resume <id>` once in the new shell, announced with the 3-second notice and a **Cancel**. This is the person's explicit action in a brand-new shell, which has no old background jobs and no half-typed line to mislead it; the checks that already exist (the shell itself has the terminal; no keystroke since the shell started or its last command) stay for this path.
- **Keep everything else of 0.5.0**: the login agent that keeps the daemon alive, stay-awake, the two-Claude notice, End Session forgetting the conversation, the confirmation before turning the agent off, the bounded command-line helpers.
- **The key fix is dropped.** With no automatic typing there is nothing it protects.
- Take the **cheap items** from the 0.5.0 reviews that still matter, and fix **any further issue** the final review of this work finds.
- Verify the launchd, Login Items and power behaviour on the owner's Mac after the release is installed, with the owner present and saying yes at that moment.
- Ship as **0.5.1**.

## What is removed

- Automatic typing on every trigger: the daemon's start, a prompt appearing, a `claude` crash, an offer changing, a config change. The daemon never calls the resume check except for Restart Claude's explicit request.
- The setting `session.autoResume` and its Settings switch *Resume Claude automatically*. *Offer to resume Claude Code* (`session.resumeClaude`) stays: it controls whether the conversation is remembered and the button offered.
- What only served automatic retries: the crash retry, the three-attempts-in-ten-minutes loop guard and its persisted attempt times, the give-up state and its native "Claude keeps stopping" notification, the 20 s and 2 min waits. An old `claude.json` with an `attempts` block is read and the block is ignored.
- The automatic notice for a pending automatic resume. The notice for Restart Claude stays (same RPCs and toast, now only for the explicit request).
- The README, release-note and CLAUDE.md statements about automatic resume and the "Known limitation" paragraph (nothing automatic remains to describe; the one narrow case it described needs automatic typing). The typing rule in CLAUDE.md goes back to: Jaffer types `claude`, and `claude --resume <id>` after a click (the Resume button, or Restart Claude's confirmation).

## What the person sees

| After | Before 0.5.1 | In 0.5.1 |
|---|---|---|
| An update, crash or reboot | Claude resumed by itself after a notice | The **Resume Claude** button appears (when the conversation is known, nothing runs and the shell is in the same folder); one click resumes it |
| *Restart Claude Code* | Same | Same: confirm, shell restarts, the conversation resumes after the 3-second notice with Cancel |
| `/exit`, Ctrl+C, End Session, `claude -p` | Never resumed | Never offered (unchanged) |

## Cheap items from the 0.5.0 reviews that still apply

Each gets a failing test first.

1. **Resume button with a non-standard shell.** `SHELL=/bin/sh` on macOS runs bash and a wrapper shell has another name; the name comparison hides the button, and the button is now the main path. The terminal's foreground process group (`tpgid` equal to the shell's pid) becomes the authority; the name check is dropped.
2. **Fewer `ps` calls.** About 6 synchronous `/bin/ps` calls per command while an offer stands (about 4 ms each on the daemon thread, up to 2 s if `ps` hangs). The foreground check is cached per event and bounded by a 500 ms timeout.
3. **`jaffer service remove` inside the launchd-run session** ends the terminal it was typed in. When `JAFFER_SESSION=1` and the status is `running` it prints the warning and asks for `--yes`.
4. **The config flag and the agent agree.** A change of `session.keepRunning` (also via `jaffer config set`) reconciles the agent with every existing guard, so the two cannot disagree for a whole session.
5. **Old-daemon messages.** Restart Claude and `jaffer service` against a pre-0.5 daemon show a raw "unknown method"; they say what Settings already says: restart the session to use this.
6. **`ensureDaemon` during launchd's throttle.** If `kickstart` lands while the old daemon is still exiting, launchd starts nothing and `ensureDaemon` waits 12 s and throws once; it re-kickstarts inside the wait loop.
7. **Small user-facing items.** The Settings status line refreshes after a Cancel. End Session's two sequential 30 s calls get 5 s timeouts. The first-run switch says the agent is active from the next login or restart. The README row for End Session says launchd starts a fresh session at the next login.
8. **`caffeinate` that dies by itself.** The stay-awake controller notices the child's exit and re-holds with a short backoff, logging a spawn error once.
9. **`isInteractiveCommand` through wrapper options.** `sudo -u deploy vim`, `nice -n 10 top` and `env -u FOO ssh` are recognised as interactive, using the same option tables as `sshHost`.
10. **Settings and docs match the new behaviour** (no switch for automatic resume; the Claude Code section lists Offer to resume, Restart Claude Code and the cost switch).

Dropped because they only existed for automatic typing: pasted text after a newline in bash 3.2, the typed-during-notice decline, the shell-death mark rules, the give-up de-duplication, typing re-checks.

## Verification on the owner's Mac (after the release is installed in /Applications)

Only with the owner present and saying yes at that moment: the agent touches `~/Library/LaunchAgents`. The owner turns the switch on in Settings; Claude runs read-only checks and the one `kill -9`:
- `launchctl print gui/<uid>/com.jafforge.jaffer.daemon` shows the job and its program; Login Items → Allow in the Background lists Jaffer, not an unidentified item.
- A `kill -9` of the daemon: it is running again within about 5 s, the shell is back in the same folder with the last saved screen, and the **Resume Claude** button is offered.
- `kickstart` on the running job and during the throttle, `bootout` from inside the job (turning the switch off while launchd runs the session), logging out and in, an update with the agent on.
- `pmset -g assertions` shows the hold while Claude works and not 15 s after; a closed lid with and without power and an external display.
- A real `claude --resume` of a real conversation (the button and Restart Claude), and a native notification.
Each result goes into the release notes and the README's "Not verified here" list as verified or still open, with what was seen. A failure becomes a fix in 0.5.1 or a documented limitation.

## Testing
- Tests of removed behaviour are removed deliberately and listed in the implementer's report (automatic triggers, crash retry, loop guard, give-up, the automatic notice, the autoResume switch). Every other test keeps its name; the name diff against 2c71a49 is reported.
- New tests: after a restart, a crash, and a prompt appearing, the daemon types **nothing** with a recorded conversation (real-process test with the stand-in `claude`: the terminal never shows `RESUMED:`), and the Resume button is offered; Restart Claude still resumes after its confirmation; an old config with `session.autoResume: true` changes nothing; an old `claude.json` with an `attempts` block loads.
- Each cheap item has its own test as listed. The final whole-branch review runs again and must find no Critical item before release.

## Release
Version 0.5.1; `docs/releases/v0.5.1.md` replaces v0.5.0.md (`mkdir -p docs/releases` before writing after a `git rm`); README, ARCHITECTURE and CLAUDE.md updated (automatic resume and the known limitation removed; the typing rule restated); a signed, notarized build from a separate checkout (never from the repo folder, which holds the owner's running app), uploaded in the safe order (files, manifest, Latest) and compared with GitHub.

## Out of scope
- Any automatic typing, now or later, without a new decision by the owner.
- Keyed marks (not needed without automatic typing).
- Changing the marks other tools read, Linux, Windows.

## Open points for the review
- Existing 0.5.0 users have `session.autoResume` in their config. It is ignored and left in the file (config keeps keys it does not know).
- After a reboot with nobody at the Mac, the conversation now waits for a click instead of coming back. That is the intended trade.
