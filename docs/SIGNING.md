# Signing, notarizing and releasing

> A step-by-step version to follow on a Mac (certificate, notarization login, signing and checking the result) is in [SIGN-ON-MAC.md](SIGN-ON-MAC.md).

A Mac app that is not signed with an Apple **Developer ID** and **notarized** is blocked by Gatekeeper on other people's
Macs ("Jaffer can't be opened because Apple cannot check it for malicious software"). There are two ways to produce a
signed release. Pick one; both use the same electron-builder configuration (`electron-builder.yml` plus the
`electron-builder.signed.yml` layer) and run the same verification.

| | A. On your Mac (recommended to start) | B. In GitHub Actions |
|---|---|---|
| Certificate lives in | your login keychain, never exported | a GitHub secret (base64 `.p12`) |
| Setup | one command to store notary credentials | add 5 secrets |
| Release | `scripts/release-mac.sh --publish` | push a `v*` tag |
| Good for | the first releases, solo maintainer | every release, no Mac needed |

You need an Apple Developer Program membership and a **Developer ID Application** certificate (not "Apple Development",
not "Mac App Distribution").

## A. Sign and publish from your Mac

```bash
# once: a Developer ID Application certificate in your keychain.
#   Xcode > Settings > Accounts > your team > Manage Certificates > + > Developer ID Application
security find-identity -v -p codesigning        # should list "Developer ID Application: Your Name (TEAMID)"

# once: let notarytool keep your credentials in the keychain. Apple prompts for the password itself.
#   Use an app-specific password from https://appleid.apple.com > Sign-In and Security > App-Specific Passwords
xcrun notarytool store-credentials jaffer-notary --apple-id you@example.com --team-id YOURTEAMID

# every release
scripts/release-mac.sh --publish
```

The script builds both architectures, signs everything with the hardened runtime and the entitlements in
`build/entitlements.mac.plist`, submits the apps and disk images to Apple's notary service, staples the tickets, checks
`codesign`, `spctl` and `stapler`, launches the signed app once for a self-test, writes `SHA256SUMS.txt` and uploads to
the GitHub release for the version in `package.json` (creating it if needed). Notarization usually takes a few minutes.

Useful flags: `--skip-notarize` (sign only), `--arch arm64`, and `CSC_NAME="Your Name (TEAMID)"` when your keychain has
more than one Developer ID certificate. `--publish` refuses to upload anything that is not notarized.

## B. Sign in GitHub Actions

The workflow in `.github/workflows/ci.yml` signs and notarizes automatically as soon as these repository secrets exist
(Settings > Secrets and variables > Actions > New repository secret, or `gh secret set NAME < file`):

| Secret | What |
|---|---|
| `MAC_CERT_P12_BASE64` | your Developer ID Application certificate and private key, exported as `.p12` and base64 encoded |
| `MAC_CERT_PASSWORD` | the password you chose when exporting the `.p12` |
| `APPLE_ID` | your Apple ID e-mail |
| `APPLE_APP_SPECIFIC_PASSWORD` | an app-specific password for that Apple ID |
| `APPLE_TEAM_ID` | the 10-character team id (developer.apple.com > Membership) |

Instead of the last three you can use an App Store Connect API key: `APPLE_API_KEY_P8_BASE64` (the `.p8`, base64),
`APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.

Export the certificate: Keychain Access > My Certificates > right-click "Developer ID Application: ..." > Export...
(`.p12`, choose a password). Then:

```bash
base64 -i DeveloperID.p12 | gh secret set MAC_CERT_P12_BASE64
gh secret set MAC_CERT_PASSWORD
gh secret set APPLE_ID
gh secret set APPLE_APP_SPECIFIC_PASSWORD
gh secret set APPLE_TEAM_ID
```

(`gh secret set NAME` with no input prompts for the value, so nothing ends up in your shell history.) Delete the `.p12`
afterwards. Then push a tag:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

You do not have to: CI also releases by itself. A push to `main` that passes the tests and the Mac build publishes the
release for the `version` in `package.json` (and does nothing if that version already has one), so bumping the version is
the whole release step. *Actions → CI → Run workflow* with a *release_tag* is a third way. Set the repository variable
`REQUIRE_SIGNED_RELEASE=true` to make CI refuse to publish anything that is not signed.

The first step of the build job, **Signing preflight**, prints `present` or `MISSING` for every secret (never the value)
and says whether this run will be unsigned, signed, or signed and notarized. The release is published as a
**pre-release marked unsigned** when no certificate is available, so an unsigned build can never be mistaken for a
signed one.

To make a missing certificate a hard failure for tag builds, create a repository variable (Settings > Secrets and
variables > Actions > Variables) named `REQUIRE_SIGNED_RELEASE` with the value `true`.

### What CI proves without your credentials

The **Signing dry run** job generates a throwaway self-signed "Developer ID Application" identity, builds with the real
signing configuration, and checks that every Mach-O file (including the native terminal addon) is signed, that the
hardened runtime and entitlements are present, that the disk image is signed, and that the signed app still starts its
daemon and shell. That validates the configuration; only Apple can validate trust and notarization, which needs your
real credentials.

## Troubleshooting

- **"skipped macOS application code signing ... 0 identities found"**: no certificate reached electron-builder. Locally,
  run `security find-identity -v -p codesigning`; in CI, check the preflight output.
- **Notarization status `Invalid`**: fetch the log with `xcrun notarytool log <submission-id> --keychain-profile jaffer-notary`.
  The usual cause is an unsigned or non-hardened nested binary; the verification steps above catch that earlier.
- **`errSecInternalComponent` while signing in CI**: the `.p12` password is wrong or the base64 was line-wrapped
  incorrectly; re-export and re-encode with `base64 -i file.p12` (macOS) or `base64 -w0 file.p12` (Linux).
- **The app signs but crashes at launch with the hardened runtime**: check the entitlements in
  `build/entitlements.mac.plist` (JIT and unsigned executable memory are needed by V8, library validation is relaxed for
  the native addon).
- **Downloaded app says it is damaged**: the build was not notarized. For unsigned preview builds run
  `xattr -dr com.apple.quarantine /Applications/Jaffer.app` once.
