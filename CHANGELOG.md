# Changelog

Follows semver for behavior-pack version (`LevelUp_BP/manifest.json` header `name` + `version` + `LevelUp_vX.Y.Z.mcpack` filename — see `AGENTS.md` release convention).

## v1.4.4

**Bug fixes**
- Skill effects were only re-granted once they had *expired* (`cur.amplifier !== mine`); unlike Agility/Durability there was no refresh when the amplifier already matched. Renew every upkeep pass, while still leaving a strictly stronger foreign effect (beacon Haste II, `/effect`) alone. Regression test asserts the effect's remaining duration grows on the next pass instead of resetting only after a lapse.
- Tapping a stat with 0 stat points but unspent skill points closed the form and stranded the skill point until the player redid the gesture. The "No stat points" path now routes straight to the **SKILLS** menu when a skill is still affordable, and says so in the message.
- Level-up announcements (cinematic hologram, title subtitle, chat line) only mentioned stat points; the 1 skill point per level was granted silently. All three now report both.
- The `RANK UP` action bar was replaced by the `A R I S E` flash 12 ticks later. Rank-up is now also sent to chat so it is not lost.
- Tapping a locked skill with 0 points closed the **SKILLS** menu even when an owned skill could still be removed (refund). It now re-opens while any skills action is available (`skillsChangeable`).
- **SKILLS** body now lists every skill and its effect, instead of an empty-looking "tap a skill" line, and the status hologram refreshes after a buy/remove.

**Tests**
- 5 new tests (49 core total), each verified to fail against the v1.4.3 script.

## v1.4.3

**New features**
- Skill points: each level-up now grants 1 skill point (`lu_skill_points`) in addition to the 3 stat points. Open the SYSTEM and tap **SKILLS** to buy passive skills (Night Vision, Fire Resistance, Haste, Jump Boost, Water Breathing, Slow Falling) for 1 point each. Skills are granted as maintained effects; removing a skill refunds its point. Foreign effects from beacons/potions/`/effect` are never stripped (same ownership rules as Durability/Agility).
- Rank / title system: level brackets E → D → C → B → A → S → SS → SSS → National Hunter. Rank is stored in `lu_rank`, shown on the SYSTEM hologram and form, and announced on the action bar when the bracket changes.

**Tests**
- 8 new tests: skill point grant, buy/remove/refund, upkeep maintenance, foreign-effect safety, rank clamping, E→D→C progression, rank-up announcement. Suite is now 44 core + 16 coverage + stale-boost isolation.

## v1.4.2
- SYSTEM form body rendered as a single line: the body was written with `\\n` (an escaped backslash), so every line break stayed literal "\n" text instead of a newline. Now real `\n`, so Level/XP, stat points, and the STR/DUR/AGI lines stack into readable paragraphs. Regression test added (`main.test.mjs` — "SYSTEM form body renders real newlines").

**Docs / DX**
- `scripts/mkzip.sh` — bash-only `.mcpack` builder used by `build-mcpack.sh` when the `zip` tool is unavailable (e.g. Termux). Emits STORED (method 0) entries with CRC-32 taken from the gzip trailer; the result is validated by `verify-pack.sh` like any other pack.

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
