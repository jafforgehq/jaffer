# 0.5.1: resuming Claude is a click again, and a hardening pass: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jaffer never types `claude --resume <id>` by itself after a restart: the Resume Claude button (a click) and Restart Claude (a confirmed action) are the only ways, and the small items left from the 0.5.0 reviews are fixed.

**Architecture:** First stop the automatic behaviour (every trigger, the setting, its switch), then delete the code that only served it, so each step stays testable and Restart Claude keeps working throughout. The rest are independent small fixes in the daemon, the CLI, the stay-awake controller and the UI.

**Tech Stack:** TypeScript, Node (daemon), Electron main, Preact renderer, vitest (unit and real-process daemon tests), Playwright-core UI tests.

**Spec:** `docs/superpowers/specs/2026-10-09-resume-is-a-click-design.md` (approved). The spec wins over this plan on any conflict.

## Global Constraints

- The only things Jaffer types into the shell are `claude` (⇧⌘C, first-run switch) and `claude --resume <id>` after a click (the Resume button, or Restart Claude's native confirmation). **No automatic trigger may type**: not the daemon starting, a prompt appearing, a `claude` crash, an offer changing, a config change. The id is `isSessionId`-checked where kept and where typed. Restart Claude keeps its checks (the shell itself has the terminal, no keystroke since the shell started or its last command, the 3 s notice with Cancel).
- **No test and no run may call the real `launchctl`, touch `~/Library/LaunchAgents`, or run the real `caffeinate`.** `JAFFER_NO_LAUNCHCTL=1` is set for all test runs; temp homes are refused by the default-home guard. THIS IS THE PERSON'S REAL MAC.
- Test hygiene: tests of removed behaviour are removed deliberately and listed in the report; **every other test keeps its name**. After editing a test file diff its `it(`/`describe(` names against the base commit and report any missing one that is not on the removal list. Never truncate a test file's tail when editing by script.
- Old state stays readable: a 0.5.0 config with `session.autoResume` loads (the key is ignored and kept), and a `claude.json` with an `attempts` block loads (the block is ignored). Config values are conformed to the kind of their defaults (`conform`), and a new key needs a default of the right kind.
- The window stays calm (toasts, Settings, palette only); colours are theme tokens; no new global CSS class that collides with an existing selector.
- Never ask for, print or store a password. No change to CI workflows, entitlements or signing config.
- Verify with `npm run typecheck && npm test`; UI with `JAFFER_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npx vitest run --config vitest.e2e.config.ts test/e2e/ui.test.ts`. Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. `mkdir -p docs/releases` before writing a release note after a `git rm` there.

## Review Focus

1. **Nothing types by itself anywhere:** list every writer of `claude --resume` (the daemon's `type` dep, the renderer's Resume click, Restart Claude) and every caller that can reach the daemon's `type`; none may run without a click. (Task 1, 2)
2. **Restart Claude still works end to end after the deletions:** confirm, shell restarts, the notice with Cancel, the line rule, the foreground check, the hold, a second request, stop mid-hold. (Task 2)
3. **Old state and mixed versions:** a 0.5.0 config with `autoResume`, a `claude.json` with `attempts`, an old daemon with the new app, the new daemon with the old app's `claude.autoresume` listener. (Task 1, 2, 4)
4. **The Resume button across shells:** `/bin/sh` (runs bash), bash 3.2, zsh, a wrapper shell, `exec`ing into a program, ssh into a host that prints prompt marks (the button must not show while a program has the terminal). (Task 3)
5. **Deleted tests and docs:** only tests of removed behaviour are gone; no doc still promises automatic resume or the "Known limitation" it needed. (Task 7)

---

### Task 1: Stop automatic typing, and remove its setting and switch

**Files:**
- Modify: `src/daemon/service.ts` (the non-explicit triggers of the resume check), `src/shared/config.ts` (`session.autoResume`), `src/renderer/components/Overlays.tsx` (the *Resume Claude automatically* switch)
- Test: `test/daemon.test.ts`, `test/config.test.ts`, `test/e2e/ui.test.ts`

**Interfaces:**
- Produces: the daemon never calls `autoResume.check()` without `explicit: true` (Restart Claude's hold), and the `enabled()` dep of the non-explicit path is gone or constantly false; `JafferConfig.session` has no `autoResume`; Settings → Claude Code lists *Offer to resume Claude Code*, *Restart Claude Code* and the cost switch, not *Resume Claude automatically*. `claude.resume` and the Resume button are unchanged.

- [ ] **Step 1: Write failing tests (real processes, the stand-in `claude` on the shell's PATH, as in the existing auto-resume and Restart Claude daemon tests).** With a recorded conversation (`SessionStart`, `UserPromptSubmit` hooks, its own session id): (a) after `app.shutdown` and a restart, (b) after a `claude` crash (stand-in exits 1), (c) after a plain `session.restart` (the palette's Restart shell) and after a command returns to the prompt, the terminal never shows `RESUMED:` within a few seconds (use the fast test timing), no `claude.autoresume` event is pushed, and `claude.resume` still offers the conversation. Config: `DEFAULT_CONFIG.session` has no `autoResume`; a file with `{session:{autoResume:true}}` loads, the key is kept in the file after a patch of another key, and nothing reads it. UI: Settings → Claude Code has no switch labelled *Resume Claude automatically*; *Offer to resume Claude Code* and *Restart Claude Code* are still there.
- [ ] **Step 2: Run them.** Expected: FAIL (the daemon still resumes by itself; the key and the switch exist). `npm run build` first for daemon tests.
- [ ] **Step 3: Implement.** Remove the key from `JafferConfig`/`DEFAULT_CONFIG` and the switch from Overlays; remove every non-explicit `autoResume.check()` call in `service.ts` (daemon start, prompt, crash exit, offer change in `pushResume`, config change); keep the explicit path of Restart Claude (`restartCheck`, the hold, the stop-time call that ends a running notice).
- [ ] **Step 4: Remove tests of the removed behaviour** (the daemon tests that expect an automatic resume, the Settings test of the switch, the config test of its default): list each removed name in the report; keep every other test; fix any test that merely configured `autoResume`.
- [ ] **Step 5: Run** the new tests, the daemon file, the UI file, typecheck, `npm test`. Expected: PASS.
- [ ] **Step 6: Commit** `"resume is a click again: the daemon no longer types claude --resume by itself, and the setting and its switch are gone"`.

### Task 2: Delete the code that only served automatic resume

**Files:**
- Modify: `src/core/claude/auto-resume.ts`, `src/core/claude/resume.ts`, `src/shared/keep-running.ts` (`AUTO_RESUME`), `src/daemon/service.ts`, `src/main/main.ts` (the *gave-up* notification), `src/renderer/state.ts` (the *gave-up* handling)
- Test: `test/auto-resume.test.ts`, `test/claude-resume.test.ts`, `test/daemon.test.ts`, `test/e2e/ui.test.ts`

**Interfaces:**
- Produces: `AutoResumer` reduced to what Restart Claude needs (an explicit request, the notice with Cancel, the quiet and line rules, `cancel()`); no crash retry, no attempts, no give-up state, no `claudeEnded`/`shellDied`, no waits of 20 s or 2 min. `ResumeStore` loses `attempts`/`recordAttempt`/`clearAttempts`; reading ignores an `attempts` block. `AUTO_RESUME` keeps only the constants still used (the 3 s notice, the 2 s quiet). `AutoResumeEvent` has `pending`, `typed`, `cancelled`. No *gave-up* event, notification or toast.

- [ ] **Step 1: Write the failing tests** that pin the survivors: Restart Claude with a conversation resumes after the notice, also twice in a row (no attempt counting, no give-up); Cancel stops it; an old `claude.json` with an `attempts` block loads and its point is offered; the `claude.autoresume.state` replay for a late window still works; a `claude -p` and End Session still leave nothing to resume. These pass today; the new failing ones are the unit tests of the reduced module: `AutoResumer` has no `claudeEnded`/`shellDied` members, `AutoResumeEvent` has no `gave-up` (a type-level test with `// @ts-expect-error`), and `ResumeStore` has no `attempts` members.
- [ ] **Step 2: Run them.** Expected: FAIL on the reduced-interface tests only.
- [ ] **Step 3: Delete** crash retry, the attempt persistence and loop guard, the give-up mark and event, the 20 s and 2 min waits, `claudeEnded`/`shellDied`, the `gave-up` notification in `main.ts` and its renderer handling, the dead constants; simplify `nextStep` to the explicit request (keep the quiet and line rules and the notice). Update the daemon wiring that referenced them.
- [ ] **Step 4: Remove tests of the removed behaviour** (crash retry, loop guard, give-up, the waits, `shellDied`/`claudeEnded`, the gave-up notification): list each removed name; every survivor keeps its name; report the name diff against `2c71a49`.
- [ ] **Step 5: Run** the unit files, the daemon file, the UI file, typecheck, `npm test`. Expected: PASS.
- [ ] **Step 6: Commit** `"remove what only served automatic resume: crash retry, the loop guard, give-up and their notification"`.

### Task 3: The Resume button works with any shell, and the foreground check costs less

**Files:**
- Modify: `src/core/session/terminal.ts` (`foregroundIsShell`, `foregroundGroup`), `src/daemon/service.ts` (its callers)
- Test: `test/session.test.ts`, `test/daemon.test.ts`

**Interfaces:**
- Produces: `foregroundIsShell(opts?: { fresh?: boolean }): boolean` where the terminal's foreground process group equal to the shell's pid is the authority and the shell-name comparison is dropped; the result is cached for 250 ms unless `fresh: true` (the check made at the moment of typing for Restart Claude is always fresh); the `ps` call has a 500 ms timeout and a failure or timeout is "not the shell". The group reader is injectable for tests.

- [ ] **Step 1: Write failing tests.** Unit (injected group reader and clock): two calls within 250 ms read the group once, `fresh: true` always reads, a reader that times out or throws gives false, a group different from the pid gives false, a dead pane gives false. Daemon (real shells): with `SHELL=/bin/sh` (it runs bash on macOS, dash on Linux) a recorded conversation makes `claude.resume` offer it at the prompt (it does not today); while a stand-in `ssh` forges prompt marks and runs, the offer is null; `exec` into a stand-in program is documented in the test as the one case the name check used to hide (assert what the code now does, and that Restart Claude's typing in a fresh shell is unaffected).
- [ ] **Step 2: Run them.** Expected: FAIL (the name check hides the button; every call runs `ps`).
- [ ] **Step 3: Implement** as above; keep the process-group read a single `/bin/ps -o tpgid=` call.
- [ ] **Step 4: Run** the new tests, the session and daemon files, typecheck, `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `"the Resume button no longer depends on the shell's name; the foreground check is cached and bounded"`.

### Task 4: Service and daemon-start fixes

**Files:**
- Modify: `src/cli/main.ts` (`jaffer service remove`), `src/daemon/service.ts` and `src/daemon/keep-running.ts` (config change reconciles the agent), `src/core/daemon-client.ts` (`ensureDaemon`), `src/main/main.ts`, `src/renderer/actions.ts`, `src/cli/main.ts` (old-daemon messages)
- Test: `test/daemon.test.ts`, `test/daemon-client.test.ts` (or the existing launcher test file), `test/keep-running.test.ts`, `test/e2e/ui.test.ts`

**Interfaces:**
- Produces: `jaffer service remove` with `JAFFER_SESSION=1` and a `running` status prints the warning and requires `--yes`; a change of `session.keepRunning` (from Settings, `jaffer service`, or `jaffer config set`) reconciles the agent through `KeepRunning` with every existing guard (default home, refusals, the confirmation rule stays in the UI path); an `unknown method` from a pre-0.5 daemon on `claude.restart*`, `service.*` and `claude.autoresume.*` is shown as "Restart your session to use this" (one shared helper, CLI and window); `ensureDaemon` re-runs `kickstart` inside its wait loop (every ~2 s) when launchd was chosen and nothing answers.

- [ ] **Step 1: Write failing tests.** CLI: the warning and the `--yes` requirement in a session; a test home still refuses everything. Keep-running (fake launchd and in-memory fs): a `keepRunning` change from false to true in the default-home fake reconciles (files written, no bootstrap in a detached daemon per R20), true to false removes, both refused in a test home. Old-daemon message: a stubbed `unknown method: claude.restart.plan` becomes the friendly text in the CLI helper and in the Restart Claude toast. `ensureDaemon` (injected launchctl and clock): a first `kickstart` that starts nothing is followed by another within the wait, and the fallback to the detached spawn still happens.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** the four items; reuse the existing friendly string from Settings.
- [ ] **Step 4: Run** the new tests, the daemon and UI files, typecheck, `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `"service: warn before removing the running agent, keep the flag and the agent in step, friendly old-daemon messages, retry kickstart"`.

### Task 5: Small user-facing items, `caffeinate`, and interactive commands behind wrappers

**Files:**
- Modify: `src/renderer/components/Overlays.tsx` (status refresh after Cancel; first-run copy), `src/main/main.ts` (End Session timeouts), `src/core/session/caffeinate.ts` and `src/core/session/stay-awake.ts` (a hold that ends by itself), `src/core/session/stay-awake.ts` (`isInteractiveCommand`)
- Test: `test/stay-awake.test.ts`, `test/e2e/ui.test.ts`, `test/keep-running-off.test.ts` or the main-process helper test

**Interfaces:**
- Produces: the Settings status line is re-read after the person cancels the confirmation; End Session's `claude.resume.dismiss` and `app.shutdown` calls each time out after 5 s and are tolerated; the first-run switch copy says the agent is active from the next login or restart; `StayAwakeDeps.hold` returns `{ release(): void; onExit?(cb: () => void): void }`, and the controller re-holds after an unexpected exit with a backoff (1 s, doubling, capped at 30 s, reset by a clean period) and logs a spawn error once; `isInteractiveCommand` skips the options (and their values) of `sudo`, `env`, `nice`, `time`, `nohup` using the same tables as `sshHost` before looking at the program.

- [ ] **Step 1: Write failing tests.** Stay-awake (fake hold, clock, timers): a hold that reports its exit while work continues is re-held after 1 s, the second unexpected exit waits 2 s, a clean 60 s period resets it, a spawn error is reported once, `release()` of a dead hold is harmless, no re-hold after `stop()` or when the work stopped. Interactive: `sudo -u deploy vim`, `nice -n 10 top`, `env -u FOO ssh host`, `sudo -iu deploy ssh h`, `time -p vim` are interactive; `sudo -u deploy make` and `nice -n 10 make` are not; a 1 MB crafted line stays fast (the existing timing test style). UI: after Cancel in the switch-off confirmation the status line is refreshed (stubbed status changes meanwhile); the first-run switch copy contains "next login". End Session: a stubbed hung `claude.resume.dismiss` does not delay `app.shutdown` beyond 5 s each (fake timers on the helper).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** the items; the real `caffeinateHold` reports the child's `exit` through `onExit`.
- [ ] **Step 4: Run** the new tests, the UI file, typecheck, `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `"small fixes: status refresh, bounded End Session, first-run copy, caffeinate that ends by itself, interactive commands behind wrappers"`.

### Task 6: Rules, docs, release notes, version 0.5.1

**Files:**
- Modify: `CLAUDE.md`, `docs/ARCHITECTURE.md`, `README.md`, the spec files' amendments if needed, `package.json` and `package-lock.json` (0.5.1, the app's own entries only), `docs/releases/v0.5.1.md` (`git rm docs/releases/v0.5.0.md`; `mkdir -p docs/releases` first)
- Test: none new; full verification

- [ ] **Step 1: Write the docs.** CLAUDE.md: the typing rule back to `claude` and `claude --resume <id>` after a click (the Resume button, Restart Claude's confirmation), the line-rule and foreground rules now describe Restart Claude only, the bounded-text rule unchanged, no rule left that mentions automatic resume. ARCHITECTURE: remove the automatic-resume sections, the loop guard and the give-up; keep Restart Claude (hold, notice, line rule), the foreground check (now a process-group authority with a short cache), the agent, stay-awake. README: the Claude Code section (resume is the button; Restart Claude Code), the Keeps-running section (the table's rows say "the Resume Claude button appears"), remove "Resume Claude automatically", remove the *Known limitation* and the Limitations bullet about it, the End Session row says launchd starts a fresh session at the next login, the by-hand list keeps what is still unverified. Release notes: what changed for the person (resume is a click; why), what stays, what is by hand; "Updating from 0.2.x or later asks first, as always."
- [ ] **Step 2: Run everything:** `npm run typecheck`; `node scripts/gen-shell.mjs --check`; `npm run build`; `npm test`; the full UI file; the screenshots test with a short `TMPDIR` as before (`rm -rf /tmp/jx /tmp/jx-shots; mkdir -p /tmp/jx; TMPDIR=/tmp/jx/ JAFFER_SCREENSHOTS=/tmp/jx-shots JAFFER_CHROME=… npx vitest run --config vitest.e2e.config.ts test/e2e/screenshots.test.ts`); copy only `12-claude-code-settings.png` and `15-companions.png`, run `python3 scripts/shrink-screenshots.py`, then `git checkout --` every other screenshot it touched.
- [ ] **Step 3: Commit** `"Release 0.5.1: resuming Claude is a click again"`. Do **not** push, tag or publish.

### Task 7: Verification on the owner's Mac, then the release (controller and owner, not an implementer)

Not dispatched to an implementer: it touches `~/Library/LaunchAgents`, so it needs the owner present and saying yes at that moment.

- [ ] **Step 1: Owner installs the signed 0.5.0 (or later) DMG into `/Applications`** and opens it from there (not from the repo's `release/` folder).
- [ ] **Step 2: With the owner's yes, run the checks of the spec's "Verification on the owner's Mac"**: the owner turns the switch on in Settings; read-only `launchctl print gui/<uid>/com.jafforge.jaffer.daemon`; Login Items; one `kill -9` of the daemon and the time to return with the Resume button offered; `kickstart` on the running job and during the throttle; turning the switch off while launchd runs the session (the confirmation first); logout and login; `pmset -g assertions` while Claude works and 15 s after; a closed lid with and without power and a display; a real `claude --resume` (the button and Restart Claude); a native notification.
- [ ] **Step 3: Record each result** (verified, or what was seen) in the README's "Not verified here" list and the release notes; a failure becomes a fix in this release or a documented limitation (a small follow-up task through the same review loop).
- [ ] **Step 4: Release.** Final whole-branch review passed with no Critical item; merge to `main`; push; wait for CI; build, sign and notarize **from a separate checkout** (never the repo folder: the script runs `rm -rf release` and the owner's running app lives there); upload in the safe order (files, manifest, Latest); compare the published digests with the local files; delete the temporary checkout with the owner's yes.
