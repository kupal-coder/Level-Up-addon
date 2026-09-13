# AGENTS.md

Level-Up-addon — Minecraft Bedrock (MCPE) stats addon. Solo-leveling SYSTEM window: sneak + double-jump opens level / stat-points / STR-DUR-AGI screen.

## Layout (source of truth)

- `LevelUp_BP/` — behavior pack. `manifest.json` (format_version 2, `@minecraft/server` 2.0.0 + `@minecraft/server-ui` 2.0.0, `min_engine_version` [1,21,0]).
- `LevelUp_BP/scripts/main.js` — entire logic: gesture detect, XP/levels, SYSTEM form, STR/DUR/AGI effects. Balance knobs at top (`POINTS_PER_LEVEL`, `STR_DMG_PER_POINT`, `HP_PER_DUR`, `MAX_STAT`).
- Physical SYSTEM hologram: named `area_effect_cloud`s tagged `lu_holo` (`lu_owner`/`lu_slot`/`lu_until` props), kept floating in front of the owner's view by a 5-tick interval. Cosmetic layer only — the form is the source of truth.
- No resource pack, no CI, no build step — plain JS loaded by the game.

## Verify

- `node --check LevelUp_BP/scripts/main.js` and JSON-parse `LevelUp_BP/manifest.json`. No toolchain beyond that; in-game load test is the real check.
- Keep Script API usage to stable 2.0.0 surface only (`world`, `system`, `ActionFormData`, dynamic properties, `health`/`speed`/`health_boost` effects) so `min_engine_version` [1,21,0] stays valid.
- `health.effectiveMax` is read-only: `applyDurability` probes write+readback once and falls back to a maintained `health_boost` effect. STR bonus damage has a per-victim 5-tick anti-recursion guard (`bonusHitAt`). Don't remove either without in-game proof.
- All FX helpers in `main.js` (`safeSound`, `safeCommand`, `burstAt`, `spiralUp`, `levelUpCinematic`) are best-effort try/catch — keep that pattern for any new juice. Particle ids fall back through candidate lists; camera shake/fade are `runCommand` and need cheats ON.
