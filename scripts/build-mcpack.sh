#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "JSON.parse(require('fs').readFileSync('$ROOT/LevelUp_BP/manifest.json','utf8')).header.version.join('.')")"
OUT="$ROOT/LevelUp_v${VERSION}.mcpack"
echo "Building $OUT from LevelUp_BP/ (v$VERSION)..."
rm -f "$ROOT"/LevelUp_v*.mcpack
( cd "$ROOT/LevelUp_BP" && zip -r "$OUT" manifest.json scripts pack_icon.png 2>/dev/null || zip -r "$OUT" manifest.json scripts )
echo "Done: $(ls -lh "$OUT")"
# verify parity
if unzip -p "$OUT" scripts/main.js | diff - "$ROOT/LevelUp_BP/scripts/main.js" >/dev/null; then
  echo "verify: pack scripts/main.js matches source ✓"
else
  echo "verify FAILED: pack does not match source" >&2
  exit 1
fi
