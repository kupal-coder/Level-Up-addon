#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACK="$(ls "$ROOT"/LevelUp_v*.mcpack 2>/dev/null | head -n1)"
[ -n "$PACK" ] || { echo "No LevelUp_v*.mcpack found" >&2; exit 1; }
echo "Verifying $PACK ..."
unzip -p "$PACK" manifest.json | diff - "$ROOT/LevelUp_BP/manifest.json" && echo "manifest.json ✓" || { echo "manifest mismatch"; exit 1; }
unzip -p "$PACK" scripts/main.js | diff - "$ROOT/LevelUp_BP/scripts/main.js" && echo "scripts/main.js ✓" || { echo "script mismatch"; exit 1; }
unzip -p "$PACK" pack_icon.png | cmp - "$ROOT/LevelUp_BP/pack_icon.png" && echo "pack_icon.png ✓" || { echo "icon mismatch"; exit 1; }
echo "All pack contents match source."
