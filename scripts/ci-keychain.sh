#!/usr/bin/env bash
# CI helper: import a code-signing certificate (.p12) into a temporary keychain and point electron-builder at it
# through CSC_KEYCHAIN. (electron-builder's own CSC_LINK import reuses the certificate password as the keychain password
# and fails on current macOS runners, so the keychain is created here instead.)
#
#   scripts/ci-keychain.sh <cert.p12> <p12 password>
#   scripts/ci-keychain.sh --remove
#
# Prints identities, never secrets. Appends CSC_KEYCHAIN to $GITHUB_ENV when that exists.
set -euo pipefail

KC="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/jaffer-signing.keychain-db"

if [ "${1:-}" = "--remove" ]; then
  security delete-keychain "$KC" 2>/dev/null || true
  exit 0
fi

P12="${1:?usage: ci-keychain.sh <cert.p12> <password>}"
PW="${2:-}"
KCPW="$(uuidgen)"

security create-keychain -p "$KCPW" "$KC"
security set-keychain-settings -lut 21600 "$KC"
security unlock-keychain -p "$KCPW" "$KC"
security import "$P12" -k "$KC" -P "$PW" -T /usr/bin/codesign -T /usr/bin/productbuild -T /usr/bin/security
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KCPW" "$KC" >/dev/null
# put it first in the search list, keeping the existing keychains
EXISTING="$(security list-keychains -d user | tr -d '"' | tr '\n' ' ')"
# shellcheck disable=SC2086
security list-keychains -d user -s "$KC" $EXISTING

echo "Identities available for code signing:"
LIST="$(security find-identity -v -p codesigning "$KC")"
echo "$LIST"
if ! echo "$LIST" | grep -Eq '^ *[0-9]+\) '; then
  echo "::error title=No valid signing identity::The certificate was imported but macOS does not consider it valid for code signing (wrong certificate type, expired, or missing its Apple intermediate certificate)."
  exit 1
fi

[ -n "${GITHUB_ENV:-}" ] && echo "CSC_KEYCHAIN=$KC" >> "$GITHUB_ENV"
echo "CSC_KEYCHAIN=$KC"
