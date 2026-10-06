#!/usr/bin/env bash
# Build, sign, notarize, verify and (optionally) publish Jaffer from YOUR Mac, using the Developer ID certificate that
# is already in your login keychain. Nothing secret leaves your machine: no .p12 export, no GitHub secrets.
#
#   scripts/release-mac.sh                 build + sign + notarize + verify into ./release
#   scripts/release-mac.sh --publish       ...and upload to the GitHub release for the version in package.json
#   scripts/release-mac.sh --skip-notarize sign only (fast; Gatekeeper will still warn on other Macs)
#   scripts/release-mac.sh --arch arm64    build one architecture only (arm64 | x64 | both, default both)
#
# One-time setup (see docs/SIGNING.md):
#   1. A "Developer ID Application" certificate in your keychain (Xcode > Settings > Accounts > Manage Certificates).
#   2. Notarization credentials stored in the keychain (the password is typed into Apple's own prompt):
#        xcrun notarytool store-credentials jaffer-notary --apple-id YOU@EXAMPLE.COM --team-id TEAMID
#
# Environment: NOTARY_PROFILE (default jaffer-notary), CSC_NAME (pick a certificate if you have several).
set -euo pipefail
cd "$(dirname "$0")/.."

PROFILE="${NOTARY_PROFILE:-jaffer-notary}"
PUBLISH=0
NOTARIZE=1
ARCH=both

while [ $# -gt 0 ]; do
  case "$1" in
    --publish) PUBLISH=1 ;;
    --skip-notarize) NOTARIZE=0 ;;
    --arch) shift; ARCH="${1:-}" ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
case "$ARCH" in arm64|x64|both) ;; *) echo "--arch must be arm64, x64 or both" >&2; exit 2 ;; esac

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die()  { printf '\n\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || die "this script signs a Mac app, so it has to run on macOS (you are on $(uname -s))."
command -v xcrun >/dev/null || die "Xcode command line tools are missing. Run: xcode-select --install"
command -v node  >/dev/null || die "Node.js 22+ is required."
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || die "Node.js 22+ is required (found $(node -v))."

VERSION="$(node -p "require('./package.json').version")"
TAG="v$VERSION"

# ---- 1. certificate ---------------------------------------------------------------------------------------------
say "Looking for a Developer ID Application certificate in your keychain"
IDENTITIES="$(security find-identity -v -p codesigning | grep 'Developer ID Application' || true)"
[ -n "$IDENTITIES" ] || die "no valid \"Developer ID Application\" certificate found.
  Create one in Xcode > Settings > Accounts > (your team) > Manage Certificates > + > Developer ID Application,
  or at developer.apple.com > Certificates. Then run this script again.
  (security find-identity -v -p codesigning  lists what macOS currently considers valid.)"
COUNT="$(printf '%s\n' "$IDENTITIES" | wc -l | tr -d ' ')"
if [ "$COUNT" -gt 1 ] && [ -z "${CSC_NAME:-}" ]; then
  printf '%s\n' "$IDENTITIES"
  die "several Developer ID Application certificates found. Pick one: CSC_NAME=\"Your Name (TEAMID)\" $0 $*"
fi
printf '%s\n' "$IDENTITIES" | sed 's/^ *[0-9]*) [0-9A-F]* /  using: /'
unset CSC_LINK CSC_KEY_PASSWORD

# ---- 2. notarization credentials ---------------------------------------------------------------------------------
if [ "$NOTARIZE" = 1 ]; then
  say "Checking notarization credentials (keychain profile \"$PROFILE\")"
  if ! xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1; then
    die "no working notarytool profile named \"$PROFILE\". Create it once (Apple asks for the password itself):
  xcrun notarytool store-credentials $PROFILE --apple-id YOU@EXAMPLE.COM --team-id YOURTEAMID
  Use an app-specific password from appleid.apple.com, not your Apple ID password.
  To skip notarization for now: $0 --skip-notarize"
  fi
  export APPLE_KEYCHAIN_PROFILE="$PROFILE"
fi

# ---- 3. build ---------------------------------------------------------------------------------------------------
say "Installing dependencies and building"
npm ci
V="$(node -p "require('./node_modules/@lydell/node-pty/package.json').version")"
npm install --no-save --force --no-audit --no-fund "@lydell/node-pty-darwin-arm64@$V" "@lydell/node-pty-darwin-x64@$V"
npm run build

say "Packaging, signing$([ "$NOTARIZE" = 1 ] && echo ' and notarizing the apps') (this takes a few minutes)"
rm -rf release
CONFIG="electron-builder.signed.yml"
TMPCONFIG=""
if [ "$NOTARIZE" = 0 ]; then
  TMPCONFIG=".electron-builder.nonotarize.yml"
  printf 'extends: ./electron-builder.signed.yml\nmac:\n  notarize: false\n' > "$TMPCONFIG"
  trap 'rm -f "$TMPCONFIG"' EXIT
  CONFIG="$TMPCONFIG"
fi
ARCHFLAGS=(--arm64 --x64)
[ "$ARCH" = arm64 ] && ARCHFLAGS=(--arm64)
[ "$ARCH" = x64 ] && ARCHFLAGS=(--x64)
npx electron-builder --mac "${ARCHFLAGS[@]}" --publish never --config "$CONFIG"

# ---- 4. verify --------------------------------------------------------------------------------------------------
say "Verifying signatures"
APPS=()
[ "$ARCH" != x64 ] && APPS+=(release/mac-arm64/Jaffer.app)
[ "$ARCH" != arm64 ] && APPS+=(release/mac/Jaffer.app)
for APP in "${APPS[@]}"; do
  echo "--- $APP"
  codesign --verify --deep --strict --verbose=2 "$APP"
  codesign -dv "$APP" 2>&1 | grep -q runtime || die "$APP is missing the hardened runtime flag"
  codesign -d --entitlements :- "$APP" 2>/dev/null | grep -q allow-jit || die "$APP lost its entitlements"
  if [ "$NOTARIZE" = 1 ]; then
    spctl --assess --type execute --verbose=4 "$APP"
    xcrun stapler validate "$APP"
  fi
done

if [ "$NOTARIZE" = 1 ]; then
  say "Notarizing and stapling the disk images"
  for DMG in release/*.dmg; do
    echo "--- $DMG"
    xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait
    xcrun stapler staple "$DMG"
    xcrun stapler validate "$DMG"
  done
fi
for DMG in release/*.dmg; do codesign --verify --verbose=2 "$DMG"; done

# ---- 5. run it --------------------------------------------------------------------------------------------------
if [ "$(uname -m)" = arm64 ] && [ -d release/mac-arm64/Jaffer.app ]; then
  say "Launching the signed app once (self-test: daemon, shell, renderer)"
  JAFFER_HOME="$(mktemp -d)/jaffer-home" JAFFER_SMOKE=1 release/mac-arm64/Jaffer.app/Contents/MacOS/Jaffer 2>&1 | tee release/smoke.log
  grep -q "SMOKE OK" release/smoke.log || die "the signed app failed its self-test"
  rm -f release/smoke.log
fi

say "Checksums"
(cd release && shasum -a 256 *.dmg *.zip | tee SHA256SUMS.txt)

# ---- 6. publish -------------------------------------------------------------------------------------------------
if [ "$PUBLISH" = 1 ]; then
  command -v gh >/dev/null || die "the GitHub CLI is needed to publish: brew install gh && gh auth login"
  [ "$NOTARIZE" = 1 ] || die "refusing to publish a build that is not notarized (drop --skip-notarize)."
  say "Publishing $TAG to GitHub"
  NOTES="Signed with an Apple Developer ID and **notarized by Apple**: opens without Gatekeeper warnings.

**Which file?** Apple Silicon (M1 and later): \`arm64\`. Intel Macs: \`x64\`. Use the \`.dmg\` (drag to Applications) or the \`.zip\`. Verify downloads with \`SHA256SUMS.txt\`."
  FILES=(release/*.dmg release/*.zip release/SHA256SUMS.txt)
  if gh release view "$TAG" >/dev/null 2>&1; then
    gh release upload "$TAG" "${FILES[@]}" --clobber
    gh release edit "$TAG" --prerelease=false --latest --notes "$NOTES"
  else
    gh release create "$TAG" "${FILES[@]}" --title "Jaffer $VERSION" --notes "$NOTES" --generate-notes --latest
  fi
  gh release view "$TAG" --json url -q .url
fi

say "Done. Signed builds are in ./release"
ls -lh release/*.dmg release/*.zip
