# Level Up (MCPE Addon)

Solo-leveling style stats system for Minecraft Bedrock **1.21.90+** (stable `@minecraft/server` 2.0.0 — no experiments, no cheats needed for core features).

- **Sneak + jump twice** (while crouching, within ~3 seconds) → the **SYSTEM** window opens in front of you showing level, XP, stat points, and 3 attributes.
- The SYSTEM is **physically there**: glowing stat-lines materialize ~2 blocks in front of your face and follow your view for ~12 seconds. The popup menu opens on top for spending points.
- Banish the floating board early with the reverse move: **jump, then sneak mid-air**. This clears the stat-lines only — Minecraft's Script API has no way to close a form the script opened, so the popup itself is dismissed with its **Close** button.
- `/scriptevent lu:stats` opens it too — the reliable fallback on every platform. (Typing `stats` / `system` in chat also works, but only on builds whose Script API exposes chat events; stable `@minecraft/server` 2.0.0 does not.)

> **Developer deep-dive:** See [`AGENTS.md`](./AGENTS.md) for architecture, hologram lifecycle, gesture quirks, and every fix that landed in v1.4.x. It is the source of truth for contributors.

## Stats

| Attribute | Effect | Cap |
|---|---|---|
| ⚔ Strength | +0.5 melee damage per point | 50 |
| ❤ Durability | +4 max HP per point (1 step of `health_boost`) | 25 |
| ➶ Agility | +1 Speed tier per point — Speed I to Speed V | 5 |

Killing mobs grants XP (stronger mobs = more XP, capped at 20 XP per kill). Each level-up gives **3 stat points**. Max level is **100** — after that you keep the power you earned.

> Agility is capped at 5 because Speed only has five tiers. An earlier build scored Agility as "a tier every 5 points", which meant 4 of every 5 points bought nothing at all while the window still read "Speed 5" — so every point now buys exactly one tier.

> Max HP can't be written directly by the Script API, so Durability is granted with a maintained `health_boost` effect, which only moves in **4 HP steps**. Each Durability point therefore buys exactly one step (+4 max HP, up to 120 at DUR 25), so no point is ever a no-op. The SYSTEM window shows the real number (foreign `health_boost` effects from `/effect` or another addon are ignored in the display).

## Cinematic touches

- **Level up:** screen shake + dark fade, rising particle spiral, deep growl → *✦ ARISE ✦* → LEVEL UP title with fanfare.
- **Opening the SYSTEM:** beacon sound, particles materializing in front of your face, *ACCESSING SYSTEM* flash.
- **Spending a point:** pitch-climbing orb chime, spark burst, action-bar flash.
- **Every kill:** +XP action-bar blip with orb sound.
- **Level 5+:** idle wisp aura.

> Camera shake/fade are commands, so they need **cheats ON**. Everything else (particles, sounds, titles) works with cheats off — the cinematic just degrades gracefully.

## Install

1. Copy `LevelUp_BP` to your `development_behavior_packs` folder (or zip it as `.mcpack`).
2. New world → Behavior Packs → activate **Level Up** v1.4.3. No experiments required.
3. Kill mobs, then sneak + double-jump to spend points.

Requires Minecraft Bedrock **1.21.90+** (`min_engine_version` [1,21,90], stable `@minecraft/server` 2.0.0). Using an older engine advertises an API the engine can't provide — the addon will fail to load.

**From a zip:** Import `LevelUp_v1.4.3.mcpack` directly — Minecraft installs `LevelUp_BP` for you.

**Updating:** Deactivate the old pack, import the new `.mcpack`, re-activate. Your level/stats live in dynamic properties and survive updates. Downgrading across a cap change (e.g. DUR 25) auto-refunds excess as points.

## Troubleshooting

| Symptom | Fix |
|---|---|
| SYSTEM never opens | Try `/scriptevent lu:stats` (works everywhere). If that works, your gesture is off: hold **sneak**, then **two quick jumps** within 3 s. Don't release sneak between jumps — `SNEAK_GRACE` only continues a gesture started crouched. |
| Floaty stat-lines linger | Jump then sneak mid-air to dismiss, or wait 12 s. They are `area_effect_cloud`s — engine despawns them after ~1.5 s and the keeper rotates them to hide the blink. |
| No camera shake on level-up | Needs **cheats ON** (it's a `camerashake` command). Everything else still plays. |
| Stats reset after world copy | Dynamic properties (`lu_level`, `lu_xp`, etc.) copy with the world, but some tools strip them. Re-import via `.mcpack` preserves them. |
| Another addon broke my HP/Speed | We only remove `health_boost`/`speed` if the amplifier we recorded matches (`lu_boost_amp`/`lu_speed_amp`). Foreign effects are never touched — but we can't protect you from an addon that overwrites the same amplifiers. |
| I set `lu_xp` to a huge number and froze | Fixed in v1.4.1 — `MAX_LEVEL=100` caps the loop. If you already corrupted a save, opening the SYSTEM once clamps it. |

## For contributors

- `npm test` — 44 core + `stale-boost` isolation test (see `tests/`).
- `node tests/coverage.test.mjs` — 16 extra regression checks (dismiss, cooldown, portal, aura, MAX_LEVEL, boss XP cap, etc.).
- `npm run check` — syntax + manifest JSON check.
- `npm pack @minecraft/server@2.0.0 && npx tsc --allowJs --checkJs --noEmit` — type-check against real Bedrock types.
- `bash scripts/build-mcpack.sh` — rebuild `LevelUp_vX.Y.Z.mcpack` from `LevelUp_BP/` and verify it matches source. CI fails if pack and source diverge or if more than one `LevelUp_v*.mcpack` is present.
- Full change history and gotchas: [`AGENTS.md`](./AGENTS.md) and [`CHANGELOG.md`](./CHANGELOG.md).

## Tuning

All balance numbers live at the top of `LevelUp_BP/scripts/main.js`:

| Knob | Default | Notes |
|---|---|---|
| `POINTS_PER_LEVEL` | `3` | per level-up |
| `STR_DMG_PER_POINT` | `0.5` | bonus melee dmg |
| `HP_PER_DUR` | `4` | must be multiple of 4 (health_boost granularity) |
| `MAX_STAT` | `50` | STR cap |
| `DUR_CAP` | `25` | = 120 max HP same as old 50×2 model |
| `AGI_CAP` | `5` | one tier per point, Speed I-V |
| `MAX_LEVEL` | `100` | hard cap, prevents huge-XP freeze |

## License

MIT — see [LICENSE](./LICENSE).
