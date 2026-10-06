#!/usr/bin/env bash
# Build Jaffer from source and install it to /Applications.
# A locally built app is not quarantined by Gatekeeper, so it opens without any warnings.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname)" != "Darwin" ]]; then echo "This installs the macOS app; run it on a Mac." >&2; exit 1; fi
if ! command -v node >/dev/null 2>&1; then echo "Node.js 22+ is required: brew install node" >&2; exit 1; fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 22 )); then echo "Node.js 22+ is required (found $(node -v))." >&2; exit 1; fi

ARCH="$(uname -m)"; [[ "$ARCH" == "arm64" ]] && A=arm64 || A=x64
echo "→ installing dependencies"; npm ci --no-audit --no-fund
echo "→ building ($A)"; npm run build
npx electron-builder --dir "--$A" --publish never
APP="$(ls -d release/mac*/Jaffer.app | head -1)"
echo "→ installing $APP to /Applications"
rm -rf /Applications/Jaffer.app
cp -R "$APP" /Applications/Jaffer.app
xattr -cr /Applications/Jaffer.app 2>/dev/null || true
echo "✓ Done. Open Jaffer from Launchpad or: open -a Jaffer"
