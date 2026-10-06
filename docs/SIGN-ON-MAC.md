# Sign and notarize Jaffer on your Mac (v0.1.0)

Goal: replace the **unsigned** pre-release `v0.1.0` on GitHub with builds signed by your Apple Developer ID and
notarized by Apple, so people can open Jaffer without Gatekeeper warnings. Everything happens on your Mac, with the
certificate already in your keychain. No secrets go to GitHub or into chat.

This file is written so a Claude Code session on your Mac can follow it, and so you can follow it by hand.

## 0. What you need (once)

| Need | How to check / get it |
|---|---|
| A paid **Apple Developer Program** membership | developer.apple.com/account. Note your **Team ID** (Membership details, 10 characters). |
| Xcode, or just its command line tools | `xcode-select --install` |
| **Node.js 22 or newer** | `node -v` (install: `brew install node@22`, or nvm) |
| A **Developer ID Application** certificate in your login keychain | `security find-identity -v -p codesigning` must print a line containing `Developer ID Application: Your Name (TEAMID)`. If not: Xcode → Settings → Accounts → your team → Manage Certificates → **+** → **Developer ID Application**. (Not "Apple Development" or "Mac App Distribution": those cannot ship outside the App Store.) |
| An **app-specific password** for notarization | appleid.apple.com → Sign-In and Security → App-Specific Passwords → create one named `jaffer-notary`. It is not your Apple ID password. |
| The **GitHub CLI**, logged in with write access to `jafforgehq/jaffer` | `brew install gh && gh auth login`, then `gh repo view jafforgehq/jaffer` |

Store the notarization login in your keychain once (Apple's own prompt asks for the password; it never appears in your
shell history):

```bash
xcrun notarytool store-credentials jaffer-notary --apple-id YOU@EXAMPLE.COM --team-id YOURTEAMID
```

## 1. Get the code, at the released commit

```bash
git clone https://github.com/jafforgehq/jaffer && cd jaffer     # or: cd jaffer && git pull
git fetch --tags
git checkout v0.1.0            # build exactly what was released; the tag points at the commit CI built
```

## 2. Quick check (about 3 to 5 minutes, signs but does not notarize)

```bash
scripts/release-mac.sh --skip-notarize --arch arm64
```

You should see `using: Developer ID Application: ...`, then `codesign` verification lines and `SMOKE OK`. If it stops,
fix that first (see Troubleshooting). Nothing is published by this step.

## 3. The real thing (about 10 to 20 minutes, mostly waiting for Apple)

```bash
scripts/release-mac.sh --publish
```

It builds arm64 and x64, signs with the hardened runtime and the entitlements in `build/entitlements.mac.plist`,
submits to Apple's notary service, staples the tickets, verifies everything (`codesign`, `spctl`, `stapler`), launches
the signed app once as a self-test, writes `SHA256SUMS.txt`, and then **publishes**:
the existing `v0.1.0` release gets the signed `.dmg` and `.zip` files (replacing the unsigned ones), is no longer marked
as a pre-release, becomes the latest release, and gets the "signed and notarized" notes.

Good output ends with lines like:

```
source=Notarized Developer ID
The validate action worked!
SMOKE OK
https://github.com/jafforgehq/jaffer/releases/tag/v0.1.0
```

Afterwards: `git checkout main`.

## 4. Check the result like a user would

1. Open the release page. The files are `Jaffer-0.1.0-arm64.dmg/.zip`, `Jaffer-0.1.0-x64.dmg/.zip` and `SHA256SUMS.txt`; it
   is **not** marked "Pre-release".
2. Download the arm64 `.dmg` **in a browser** (so it is quarantined like a real download), open it, drag Jaffer to
   Applications and start it. It should open with no "unidentified developer" or "damaged" dialog and no `xattr` step.
3. In Terminal:
   ```bash
   spctl -a -vv /Applications/Jaffer.app      # accepted, source=Notarized Developer ID
   codesign -dv --verbose=4 /Applications/Jaffer.app 2>&1 | grep -E "Authority|Runtime|TeamIdentifier"
   ```

## 5. Try the app (nobody has run it on a real Mac yet; please look for these)

- One window, one terminal; the sidebar on the left (session card, Claude entry, recent commands), toolbar at the top,
  status bar at the bottom. Traffic-light buttons should sit inside the top-left of the window; the window may be
  slightly see-through (vibrancy). Note anything overlapping or clipped.
- Shortcuts: `⌘B` sidebar, `⌘J` Claude panel, `⇧⌘M` memory, `⌘P` palette, `⇧⌘C` run Claude Code in the terminal,
  `⌘W` hides the window, `⌘Q` quits the app **but the session keeps running**: open Jaffer again and the same shell
  and screen are there. There must be no way to open a second terminal or split.
- Claude: run `claude` in the terminal and type `/login` if you are not signed in. Then Settings (`⌘,`) → Claude should say
  "Claude Code: found". Ask Claude something in the panel (for example "what is in this folder?"); it should run the
  command **in your terminal** and ask before changing anything.
- Memory: run a few commands, tell Claude "from now on always use tabs"; the Memory panel (`⇧⌘M`) should show it soon.

Write down anything wrong (screenshot, what you did, what you expected) and give it to Claude Code to fix.

## Troubleshooting

| Message | What to do |
|---|---|
| `no valid "Developer ID Application" certificate found` | Create the certificate (section 0). `security find-identity -v -p codesigning` lists what macOS accepts. |
| `several Developer ID Application certificates found` | `CSC_NAME="Your Name (TEAMID)" scripts/release-mac.sh --publish` |
| `no working notarytool profile named "jaffer-notary"` | Run the `store-credentials` command in section 0 (use the app-specific password). |
| Notarization status `Invalid` | `xcrun notarytool log <submission-id> --keychain-profile jaffer-notary` shows why (usually an unsigned nested binary). Send the log text (no secrets in it) to Claude Code. |
| `HTTP 401` / `Invalid credentials` from notarytool | The app-specific password or Apple ID is wrong; run `store-credentials` again. Check that your Developer Program membership is active and its agreements are accepted at developer.apple.com. |
| `Node.js 22+ is required` | `brew install node@22` and open a new terminal. |
| `gh: command not found` or not logged in | `brew install gh && gh auth login` |
| `HTTP 403` / `Resource not accessible` when publishing | Your GitHub login needs write access to `jafforgehq/jaffer` (`gh auth status`). |
| The signed app crashes at launch | Run `release/mac-arm64/Jaffer.app/Contents/MacOS/Jaffer` in Terminal to see the error, then send it to Claude Code. The entitlements are in `build/entitlements.mac.plist`. |
| Gatekeeper still blocks the download | The build was not notarized (you used `--skip-notarize`), or you are testing the unsigned asset. |

## Later: releasing new versions

- Bump `version` in `package.json` and push to `main`. CI then publishes that version automatically as an **unsigned
  pre-release**. Run `scripts/release-mac.sh --publish` on your Mac afterwards to swap in the signed files.
- To have CI sign and notarize by itself, add the Apple secrets to the repository (`docs/SIGNING.md`, section B). Type
  each value at the `gh secret set` prompt; never paste a secret into a chat.

## Rules for the agent following this file

- Never ask for, print or store a password, app-specific password, `.p12` file or token. Apple's and GitHub's own prompts
  collect them.
- Do not change the CI workflow, the entitlements or the signing configuration to make a step pass; report the error.
- Do not run `--publish` until the quick check in section 2 passed and the user said to go ahead.
