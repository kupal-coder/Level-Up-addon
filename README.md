# Level Up (MCPE Addon)

Solo-leveling style stats system for Minecraft Bedrock.

- **Sneak + jump twice** (while crouching, within ~3 seconds) → the **SYSTEM** window opens in front of you showing level, XP, stat points, and 3 attributes.
- The SYSTEM is **physically there**: glowing stat-lines materialize ~2 blocks in front of your face and follow your view for ~12 seconds. The popup menu opens on top for spending points.
- Banish the floating board early with the reverse move: **jump, then sneak mid-air**. This clears the
  stat-lines only — Minecraft's Script API has no way to close a form the script opened, so the
  popup itself is dismissed with its **Close** button.
- `/scriptevent lu:stats` opens it too — the reliable fallback on every platform.
  (Typing `stats` / `system` in chat also works, but only on builds whose Script
  API exposes chat events; stable `@minecraft/server` 2.0.0 does not.)

## Stats

| Attribute | Effect | Cap |
|---|---|---|
| ⚔ Strength | +0.5 melee damage per point | 50 |
| ❤ Durability | max HP, granted in 4 HP steps (see note) | 50 |
| ➶ Agility | +1 Speed tier per point — Speed I to Speed V | 5 |

Killing mobs grants XP (stronger mobs = more XP). Each level-up gives **3 stat points**.

> Agility is capped at 5 because Speed only has five tiers. An earlier build scored Agility as
> "a tier every 5 points", which meant 4 of every 5 points bought nothing at all while the window
> still read "Speed 5" — so every point now buys exactly one tier.

> Max HP can't be written directly by the Script API, so Durability is granted with a
> maintained `health_boost` effect, which only moves in **4 HP steps**. Odd Durability values
> therefore round *up* (1 Durability = 24 max HP, not 22); even values land exactly on
> `+2 HP per point`. The SYSTEM window always shows the real number, never the ideal one.

## Cinematic touches

- **Level up:** screen shake + dark fade, rising particle spiral, deep growl → *✦ ARISE ✦* → LEVEL UP title with fanfare.
- **Opening the SYSTEM:** beacon sound, particles materializing in front of your face, *ACCESSING SYSTEM* flash.
- **Spending a point:** pitch-climbing orb chime, spark burst, action-bar flash.
- **Every kill:** +XP action-bar blip with orb sound.
- **Level 5+:** idle wisp aura.

> Camera shake/fade are commands, so they need **cheats ON**. Everything else
> (particles, sounds, titles) works with cheats off — the cinematic just
> degrades gracefully.

## Install

1. Copy `LevelUp_BP` to your `development_behavior_packs` folder (or zip it as `.mcpack`).
2. New world → Behavior Packs → activate **Level Up**. No experiments, no cheats needed.
   Requires Minecraft Bedrock **1.21.90+** (stable `@minecraft/server` 2.0.0).
3. Kill mobs, then sneak + double-jump to spend points.

## Tuning

All balance numbers live at the top of `LevelUp_BP/scripts/main.js` (`POINTS_PER_LEVEL`, `STR_DMG_PER_POINT`, `HP_PER_DUR`, `MAX_STAT`).
