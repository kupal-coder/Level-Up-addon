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
echo "Building $OUT from LevelUp_BP/ (v$VERSION)..."
rm -f "$ROOT"/LevelUp_v*.mcpack
if command -v zip >/dev/null 2>&1; then
    ( cd "$ROOT/LevelUp_BP" && zip -r "$OUT" manifest.json scripts pack_icon.png 2>/dev/null || zip -r "$OUT" manifest.json scripts )
else
    echo "zip not found — falling back to scripts/mkzip.sh (stored entries)"
    ( cd "$ROOT/LevelUp_BP" && "$ROOT/scripts/mkzip.sh" "$OUT" manifest.json pack_icon.png scripts/main.js )
fi
echo "Done: $(ls -lh "$OUT")"
# verify parity
if unzip -p "$OUT" scripts/main.js | diff - "$ROOT/LevelUp_BP/scripts/main.js" >/dev/null; then
  echo "verify: pack scripts/main.js matches source ✓"
else
  echo "verify FAILED: pack does not match source" >&2
  exit 1
fi
