# Level Up (MCPE Addon)

Solo-leveling style stats system for Minecraft Bedrock.

- **Sneak + jump twice** (while crouching, within ~3 seconds) → the **SYSTEM** window opens in front of you showing level, XP, stat points, and 3 attributes.
- The SYSTEM is **physically there**: glowing stat-lines materialize ~2 blocks in front of your face and follow your view for ~12 seconds. The popup menu opens on top for spending points.
- Dismiss it early with the reverse move: **jump, then sneak mid-air**.
- `/scriptevent lu:stats` opens it too — the reliable fallback on every platform.
  (Typing `stats` / `system` in chat also works, but only on builds whose Script
  API exposes chat events; stable `@minecraft/server` 2.0.0 does not.)

## Stats

| Attribute | Effect |
|---|---|
| ⚔ Strength | +0.5 melee damage per point |
| ❤ Durability | +2 max HP (+1 heart) per point — granted in steps of 4 HP, see note |
| ➶ Agility | Speed effect tier grows every 5 points |

Killing mobs grants XP (stronger mobs = more XP). Each level-up gives **3 stat points**.

> Max HP can't be written directly by the Script API, so Durability is granted with a
> maintained `health_boost` effect, which only moves in **4 HP steps**. Your real max HP
> is rounded to the nearest step and the SYSTEM window always shows the true number.

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
