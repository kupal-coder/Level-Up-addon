# Contributing

Thanks for looking at Level Up!

## Quick start

```sh
npm test                 # 35 core + stale-boost isolation
node tests/coverage.test.mjs
npm run check            # JS syntax + manifest JSON
```

To type-check against real Bedrock types (catches read-only `effectiveMax` writes etc.):

```sh
npm pack @minecraft/server@2.0.0
npx tsc --allowJs --checkJs --noEmit --target ES2022 --module ESNext LevelUp_BP/scripts/main.js
```

## What to know before you change `main.js`

Read `AGENTS.md` — it's the source of truth. Highlights:

- Balance knobs at top (`POINTS_PER_LEVEL`, `STR_DMG_PER_POINT`, `HP_PER_DUR`, `MAX_STAT`, `DUR_CAP`, `AGI_CAP`, `MAX_LEVEL`). Keep `HP_PER_DUR` a multiple of 4.
- Hologram board is `area_effect_cloud`s with `lu_holo` tag; engine despawns after ~30 ticks (`AEC_LIFETIME_TICKS`) so we rotate at `AEC_ROTATE_TICKS=25` spawning replacement before removing old — don't simplify to `if (missing) spawn`.
- Gesture funnels through `registerJump` (debounced `JUMP_DEBOUNCE=6`); velocity sampler must stay 1-tick with `vy>0.35` rising-edge, and `SNEAK_GRACE=20` only continues a crouched gesture.
- `applyDurability`/`applyAgility` only remove `health_boost`/`speed` when amplifier matches recorded `lu_boost_amp`/`lu_speed_amp`.
- `bonusHitAt` anti-recursion 2-tick guard prevents own `applyDamage` re-fire from compounding.
- Chat fallback must stay feature-detected — `world.beforeEvents.chatSend` doesn't exist on stable 2.0.0.

## Adding a test

1. Add assertion to `tests/coverage.test.mjs` or `tests/main.test.mjs`.
2. Verify it's not vacuous: run suite against *previous* `main.js` and confirm new assertion fails there.
3. `harness.tick` is global — use `advance(n)` and `flush()` for promise callbacks. `formLog.shown` is global, filter by `player.id`.

## Release

1. Bump all three together: `LevelUp_BP/manifest.json` header `name` (`Level Up vX.Y.Z`), header `version` `[X,Y,Z]`, and `LevelUp_vX.Y.Z.mcpack` filename. Only one current `.mcpack` in repo.
2. `bash scripts/build-mcpack.sh` — zips `LevelUp_BP/manifest.json` + `scripts/` + `pack_icon.png` and verifies parity.
3. CI checks: syntax, `npm test`, `coverage.test.mjs`, pack parity, single-pack count.

## PR checklist

- [ ] No stable 2.0.0 API outside `world`/`system`/`ActionFormData`/dynamic properties/effects listed in `AGENTS.md`.
- [ ] Balance change updates `README.md` tuning table + `AGENTS.md` if needed.
- [ ] New FX helper stays `try/catch` (like `safeSound`/`burstAt`).
- [ ] `CHANGELOG.md` updated.
