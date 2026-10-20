# Changelog

Follows semver for behavior-pack version (`LevelUp_BP/manifest.json` header `name` + `version` + `LevelUp_vX.Y.Z.mcpack` filename — see `AGENTS.md` release convention).

## v1.4.1

**Bug fixes**
- Clamp `MAX_LEVEL=100` — prevents `while (xp >= xpNext)` freeze on corrupt huge `lu_xp` (e.g. `1e6`). Clamps `lu_level`/`lu_xp` in `loadStats`/`saveStats` and caps `MAX LEVEL` feedback in `entityDie`.
- Fix `setDynamicProperty(id, undefined)` clear — `lu_boost_amp`/`lu_speed_amp` were cleared with one arg, which can throw on some Bedrock builds and mis-classify foreign effects.
- Move `maxHpWritable` probe before `dur<=0` early return — fresh world with only DUR 0 players still learns engine can't write `effectiveMax`.
- Fix `bonusHitAt` key `victim|hitter` → `victim\x00hitter` — pipe appears in some ID schemes; null byte never does. Cleaner `playerLeave` purge handles both old `|` and new `\x00`.
- Fix `spiralUp` orphan interval — now checks `player.isValid` each tick and clears on leave.
- Fix hologram fallback index `holoSpawned` — custom dimensions (beta) no longer leak `area_effect_cloud`s. `holoEntities()` unions dimension scan + spawned set.
- Centralize SYSTEM cooldown in `openSystemAnimated` — every entry path (gesture, `/scriptevent`, chat) throttles, no stacked forms on spam.
- Keep `health_boost`/`speed` ownership strict — only remove when recorded amplifier matches; foreign beacon/potion boosts never downgraded.

**Docs / DX**
- Remove stale `LevelUp_v1.3.5.mcpack`; single current `LevelUp_v1.4.1.mcpack` now verified in CI.
- Add `package.json` (`npm test`, `npm run check`), `tsconfig.json`, `.editorconfig`, `.gitignore`, `.gitattributes`, `scripts/build-mcpack.sh`/`verify-pack.sh`, `.github/workflows/ci.yml`.
- Add `LevelUp_BP/pack_icon.png` (was missing).
- Add 16-test `tests/coverage.test.mjs` (dismiss, cooldown, multi-level, boss cap, MAX_LEVEL, aura, projectile exclusion, portal, legacy refund).
- Update `README.md` with install/update, troubleshooting, tuning table, contributor links. Add `CHANGELOG.md`.

## v1.4.0
- Durability: `HP_PER_DUR=4`, `DUR_CAP=25` — every point buys one 4-HP step (no no-op pairs).
- Fix stale `health_boost` after DUR reset vs foreign boost (own-process regression `stale-boost.test.mjs`).
- Fix agility: 1 point = 1 Speed tier, `AGI_CAP=5`.
- Fix STR i-frames via `entityHurt` re-apply `dealt+bonus`.
- Fix hologram 1.5 s blink — rotate `AEC_ROTATE_TICKS=25` before engine despawns.
- Fix gesture sampler: 1-tick loop + `SNEAK_GRACE`, `JUMP_DEBOUNCE`.
- Fix chatSend crash guard, form re-open trapping.

## v1.3.5 (prior)
- Initial solo-leveling SYSTEM: sneak+double-jump, XP/levels, STR/DUR/AGI, SYSTEM form, hologram board.
