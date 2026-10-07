# Updates: Jaffer asks before it updates itself

Date: 2026-10-07 · Status: approved in conversation (the ask-first policy, chosen by the product owner: "Ask first, with a clear warning"); the rest follows from it.

## Why

New versions are published as signed, notarized GitHub releases, and the only way to get one is to notice it, download it and
drag it over the old app. Jaffer should notice by itself and **ask**. Asking matters more here than in most apps: the app is
a terminal, and replacing it ends the session (the daemon is part of the app), so everything running in the shell stops,
Claude Code included.

## Behaviour

1. **Check** shortly after launch (15 s) and every 6 hours while the app is open, against the GitHub releases of
   `jafforgehq/jaffer`. Only the latest **non-prerelease** counts; the unsigned preview builds CI makes are prereleases and
   carry no update manifest, so they can never be offered.
2. **Download in the background** (`autoDownload`), without asking: it only fetches a file.
3. **Ask when it is ready**, with a native dialog: *"Jaffer 0.2.0 is ready"*, a plain warning that updating restarts Jaffer and
   ends the terminal session (programs running in it stop, memory is kept, the shell comes back in the same folder), and
   an extra line when Claude is working or waiting at that moment. Buttons: **Update and restart** / **Later**.
4. **Later** means later: the same version is not offered again until the next launch (or a manual check). Nothing installs
   on its own, not even on quit (`autoInstallOnAppQuit` is off): a quit never replaces the app behind a running session.
5. **Update and restart** ends the session through the daemon (`app.shutdown`, the same path as *Quit and End Session*),
   then `quitAndInstall`; the new version starts a fresh daemon and restores the folder and screen as it does after any
   restart.
6. **Manual**: *Jaffer → Check for Updates…* and Settings → Updates → *Check now* always answer: up to date, downloading
   (it asks when ready), the prompt above, or what went wrong with an *Open releases page* button.
7. **Settings → Updates**: *Check automatically* (default on, `updates.auto`), the current version, the status line
   (*Up to date* / *Downloading 0.2.0* / *0.2.0 is ready* / the last error) and *Check now*. With auto off nothing is
   checked in the background; manual checks still work.

## Safety rules

- **Only a Developer ID signed app updates itself.** At startup the app inspects its own signature
  (`codesign -dvv` on its bundle). Ad-hoc or unsigned builds (local builds, CI previews) and anything not `app.isPackaged`
  never check, because macOS would refuse to install the update anyway and the user would be asked for nothing useful.
  Squirrel.Mac additionally verifies that the new app is signed by the same identity.
- Errors never interrupt: a failed background check is logged (`~/.jaffer/updater.log`, capped) and shown in Settings, not
  in a dialog. Only a manual check shows an error.
- The prompt text and the status text are built from the version string the feed returns, so they are clipped to a
  version-like token before they reach a dialog.
- `JAFFER_UPDATE_URL` (a generic-provider base URL) overrides the feed. It exists to test the whole flow against a local
  server; it does not weaken anything because the update must still be signed by the installed app's identity.
- The one-session rules in CLAUDE.md are untouched: no new window; the prompt is a native dialog.

## Release pipeline

- `electron-builder.yml` gets `publish: { provider: github, owner: jafforgehq, repo: jaffer }` so the build writes
  `latest-mac.yml` (both architectures) next to the zips and embeds `app-update.yml` in the app.
- `scripts/release-mac.sh --publish` uploads the dmgs, zips, blockmaps and checksums first, **then** `latest-mac.yml`, then
  flips the release to latest: a client can never see a manifest that points at a file that is not there yet. It refuses to
  publish if the manifest does not list both zips or names another version.
- CI keeps uploading only dmg, zip and checksums: an unsigned preview is never an update source.

## Where it lives

- `src/shared/update-policy.ts` (pure): prompt wording, the ask-or-not rule, the signature parser.
- `src/main/updates.ts` (`UpdateController`, no Electron imports; the updater, dialog and session shutdown are injected).
- `src/main/main.ts` wires the real `electron-updater`, the menu item, IPC (`jaffer:update-state`, `jaffer:update-check`) and
  the `update.state` event; `preload.ts` and `global.d.ts` expose `window.jaffer.updates`.
- Renderer: an `updateState` signal and the Settings → Updates section.

## Testing

- Policy: wording with and without Claude busy, version clipping, the ask rule, signature parsing (Developer ID, ad-hoc,
  unsigned, garbage).
- Controller with a fake updater: disabled when unsigned/unpackaged, timers respect `updates.auto`, one prompt per version
  per launch, a manual check asks again, accept runs `prepareInstall` before `quitAndInstall`, a failing dialog or updater
  never throws, concurrent checks share one run.
- Config: `updates.auto` defaults on, also for a config saved before the setting existed.
- UI end to end: the Settings section, the switch, and *Check now* against the bridge stub.
- Release: the packaged build contains `app-update.yml` and a `latest-mac.yml` listing both zips; **a real round trip**: a
  signed build of one version updates to a signed build of the next from a local server (`JAFFER_UPDATE_URL`), including
  the prompt, the session ending, and the new version coming back up.

## Not in scope

Release notes inside the dialog, delta updates beyond what electron-updater does by itself, a beta channel, downgrade, and
Windows/Linux (the app is macOS only).
