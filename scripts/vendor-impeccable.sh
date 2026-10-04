#!/bin/sh
# Re-pull Impeccable's prebuilt in-page detector into server/vendor/impeccable at a pinned commit.
# Usage: scripts/vendor-impeccable.sh [commit]  — then update the commit and checksums in that folder's README.
set -eu
COMMIT=${1:-e103efe779e2dd01274dabae83531fef00bf2563}
BASE="https://raw.githubusercontent.com/pbakaus/impeccable/$COMMIT"
DEST="$(cd "$(dirname "$0")/.." && pwd)/server/vendor/impeccable"
curl -fsSL "$BASE/crates/live/assets/detect-antipatterns-browser.js" -o "$DEST/detect-antipatterns-browser.js"
curl -fsSL "$BASE/crates/live/assets/antipatterns.json" -o "$DEST/antipatterns.json"
curl -fsSL "$BASE/LICENSE" -o "$DEST/LICENSE"
shasum -a 256 "$DEST/detect-antipatterns-browser.js" "$DEST/antipatterns.json" "$DEST/LICENSE"
