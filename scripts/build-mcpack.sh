#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Node-free MANIFEST_VERSION scrape: JSON spans lines, so strip all whitespace
# first, then take the text after the first `"version":[` — in this manifest only
# header.version matches that (`format_version`/`min_engine_version`/dependency
# "2.0.0" pins don't).
manifest_version() {
    local flat nums
    flat=$(tr -d '[:space:]' < "$ROOT/LevelUp_BP/manifest.json")
    nums=${flat#*\"version\":\[}
    nums=${nums%%]*} # everything from the first `]` onward
    printf '%s' "$nums" | tr ',' '.'
}
VERSION="$(manifest_version)"
OUT="$ROOT/LevelUp_v${VERSION}.mcpack"
# Build into a temp file and only replace the published pack after it verifies.
# Deleting the old pack up front meant any failure (missing icon, disk full,
# interrupted zip) left the repo with no installable pack at all.
TMP="$ROOT/.LevelUp_v${VERSION}.mcpack.tmp"
cleanup() { rm -f "$TMP"; }
trap cleanup EXIT
rm -f "$TMP"
echo "Building $OUT from LevelUp_BP/ (v$VERSION)..."
if command -v zip >/dev/null 2>&1; then
    ( cd "$ROOT/LevelUp_BP" && zip -qr "$TMP" manifest.json scripts pack_icon.png ) || {
        rm -f "$TMP"
        ( cd "$ROOT/LevelUp_BP" && zip -qr "$TMP" manifest.json scripts )
    }
else
    echo "zip not found — falling back to scripts/mkzip.sh (stored entries)"
    ( cd "$ROOT/LevelUp_BP" && "$ROOT/scripts/mkzip.sh" "$TMP" manifest.json pack_icon.png scripts/main.js )
fi
# Full parity check before publishing — including the icon, which the old
# post-build check skipped.
if unzip -p "$TMP" manifest.json | diff - "$ROOT/LevelUp_BP/manifest.json" >/dev/null &&
   unzip -p "$TMP" scripts/main.js | diff - "$ROOT/LevelUp_BP/scripts/main.js" >/dev/null &&
   unzip -p "$TMP" pack_icon.png | cmp - "$ROOT/LevelUp_BP/pack_icon.png" >/dev/null; then
    rm -f "$ROOT"/LevelUp_v*.mcpack
    mv "$TMP" "$OUT"
    trap - EXIT
    echo "Done: $(ls -lh "$OUT")"
    echo "verify: manifest.json, scripts/main.js, pack_icon.png match source ✓"
else
    echo "verify FAILED: build does not match source; existing pack left untouched" >&2
    exit 1
fi
