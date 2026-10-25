import { world, system, EntityDamageCause } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";

// ---- Tuning knobs ----
const POINTS_PER_LEVEL = 3;
const STR_DMG_PER_POINT = 0.5; // bonus melee damage per STR
// health_boost only steps in 4 HP, so each DUR point must buy a full step.
// HP_PER_DUR was 2, which quantized pairs of DUR to the same max HP
// (1-2 -> 24, 3-4 -> 28, ...) and sold every even point for nothing.
const HP_PER_DUR = 4; // +2 hearts per DUR (20 = 10 hearts base)
const GESTURE_WINDOW = 60; // ticks to land both jumps while sneaking
const DISMISS_WINDOW = 40; // ticks after a jump that a mid-air sneak banishes the board
const JUMP_DEBOUNCE = 6; // ticks; one physical jump must only ever count once
const SNEAK_GRACE = 20; // ticks a crouch still counts after jumping breaks it
const UI_COOLDOWN = 60; // ticks after opening before gesture works again
const MAX_STAT = 50;
// Speed has exactly five tiers, and every point has to buy one. An earlier model
// used `floor(agi / 5)`, which made 4 of every 5 Agility points a no-op (only
// agi 1/5/10/15/20 changed anything) and let the form sell the rest for nothing
// while still printing "Speed 5". One point per tier removes the banding; the
// price is a cap of 5 instead of 20.
const AGI_CAP = 5;
// DUR maxes at the same 120 HP the old 50x2 model topped out at (20 + 25x4),
// so every point buys exactly one 4-HP step and none is ever a no-op.
const DUR_CAP = 25;
const AURA_MIN_LEVEL = 5; // level at which players get an idle wisp aura
const MAX_LEVEL = 100; // hard cap — prevents unbounded while loop / point inflation on corrupt saves
const SKILL_POINTS_PER_LEVEL = 1; // one skill point per level-up, separate from stat points

// Skills are binary (owned / not owned), cost 1 skill point each, and are granted
// as maintained effects like Durability's health_boost and Agility's speed — but
// every skill is amplifier 0, so an amplifier record cannot prove who granted it.
// Two consequences, both deliberate:
//  - while owned, the effect is topped up every pass, which replaces the remaining
//    duration of a same-strength potion (a stronger effect is still left alone);
//  - removing a skill never calls removeEffect — that could strip a real potion
//    we cannot tell apart. The effect is simply left to expire (<= 400 ticks).
const SKILL_EFFECT_TICKS = 400; // > the ~10s Night Vision flicker threshold
const SKILL_MIGRATION_PROP = "lu_skill_migrated"; // set once level-1 points are back-filled
const SKILLS = [
    { key: "nv", name: "Night Vision", effect: "night_vision", amp: 0, desc: "See in the dark" },
    { key: "fr", name: "Fire Resistance", effect: "fire_resistance", amp: 0, desc: "Immune to fire and lava" },
    { key: "haste", name: "Haste", effect: "haste", amp: 0, desc: "Mine and attack faster" },
    { key: "jump", name: "Jump Boost", effect: "jump_boost", amp: 0, desc: "Jump higher" },
    { key: "wb", name: "Water Breathing", effect: "water_breathing", amp: 0, desc: "Breathe underwater" },
    { key: "sf", name: "Slow Falling", effect: "slow_falling", amp: 0, desc: "Fall without taking damage" },
];

// Rank thresholds by level. The highest matching threshold wins.
const RANKS = [
    { level: 100, name: "National Hunter", color: "§c§l" },
    { level: 85, name: "SSS", color: "§d§l" },
    { level: 70, name: "SS", color: "§b§l" },
    { level: 50, name: "S", color: "§a§l" },
    { level: 30, name: "A", color: "§2" },
    { level: 20, name: "B", color: "§3" },
    { level: 10, name: "C", color: "§9" },
    { level: 5, name: "D", color: "§6" },
    { level: 1, name: "E", color: "§7" },
];
function rankOf(level) {
    for (const r of RANKS) if (level >= r.level) return r;
    return RANKS[RANKS.length - 1];
}

const xpNext = (level) => level * 50;

function num(v, fallback = 0) {
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
}

function loadStats(player) {
    const s = {
        level: num(player.getDynamicProperty("lu_level"), 1) || 1,
        xp: num(player.getDynamicProperty("lu_xp")),
        points: num(player.getDynamicProperty("lu_points")),
        str: num(player.getDynamicProperty("lu_str")),
        dur: num(player.getDynamicProperty("lu_dur")),
        agi: num(player.getDynamicProperty("lu_agi")),
        skillPoints: num(player.getDynamicProperty("lu_skill_points")),
    };
    for (const sk of SKILLS) {
        s[`skill_${sk.key}`] = num(player.getDynamicProperty(`lu_skill_${sk.key}`)) || 0;
    }
    if (s.level < 1) s.level = 1;
    if (s.level > MAX_LEVEL) s.level = MAX_LEVEL;
    s.rank = rankOf(s.level).name;
    // Cap XP at max level so a corrupt 1e9 XP can't freeze the level-up loop.
    if (s.level >= MAX_LEVEL) {
        const cap = xpNext(s.level);
        if (s.xp >= cap) s.xp = cap - 1;
    }
    // Migrate legacy over-cap saves (AGI cap 5 since v1.3.4, DUR cap 25 since
    // v1.4.0): clamp to the cap and refund the excess as points so power is
    // preserved. Idempotent: recomputed from stored values until the next save.
    if (s.str > MAX_STAT) { s.points += s.str - MAX_STAT; s.str = MAX_STAT; }
    if (s.dur > DUR_CAP) { s.points += s.dur - DUR_CAP; s.dur = DUR_CAP; }
    if (s.agi > AGI_CAP) { s.points += s.agi - AGI_CAP; s.agi = AGI_CAP; }
    // One-time back-fill for saves created before skill points existed: every
    // level above 1 should have granted one, so pay out level-1 once. Written
    // here (not in saveStats) so a player who never opens a form still gets it
    // on the next upkeep pass. The marker makes it idempotent — including for
    // players who already earned points after v1.4.3 (they get a small bonus
    // rather than the migration silently skipping older worlds).
    if (player.getDynamicProperty(SKILL_MIGRATION_PROP) !== 1) {
        try {
            s.skillPoints += Math.max(0, s.level - 1);
            player.setDynamicProperty("lu_skill_points", s.skillPoints);
            player.setDynamicProperty(SKILL_MIGRATION_PROP, 1);
        } catch { /* player left mid-read */ }
    }
    return s;
}

function saveStats(player, s) {
    try {
        // Best-effort atomicity: the script is single-threaded, so no leave can
        // interleave these writes mid-tick. The isValid check only guards the
        // already-gone case, not a true transaction (dynamic properties have none).
        if (!player.isValid) return;
        // Clamp before persisting — defense in depth if a caller forgot.
        if (s.level > MAX_LEVEL) s.level = MAX_LEVEL;
        if (s.level < 1) s.level = 1;
        player.setDynamicProperty("lu_level", s.level);
        player.setDynamicProperty("lu_xp", s.xp);
        player.setDynamicProperty("lu_points", s.points);
        player.setDynamicProperty("lu_str", s.str);
        player.setDynamicProperty("lu_dur", s.dur);
        player.setDynamicProperty("lu_agi", s.agi);
        player.setDynamicProperty("lu_skill_points", s.skillPoints);
        for (const sk of SKILLS) {
            player.setDynamicProperty(`lu_skill_${sk.key}`, s[`skill_${sk.key}`]);
        }
        player.setDynamicProperty("lu_rank", s.rank);
    } catch { /* player left mid-write */ }
}

// Can the player buy another skill? This is the only SKILLS action that spends a
// point; removal is a separate (always available) action.
function canBuySkill(s) {
    return s.skillPoints > 0 && SKILLS.some((sk) => !s[`skill_${sk.key}`]);
}

// Is there still a reason to keep the SKILLS menu open? Buying or removing.
// Deliberately blind to stat points — those belong to the SYSTEM menu.
function skillsChangeable(s) {
    return canBuySkill(s) || SKILLS.some((sk) => s[`skill_${sk.key}`] === 1);
}

// Is there anywhere left to put a *stat* point? Skill points live in a different
// menu, so they must never keep the SYSTEM form open (or re-open it) after the
// last stat point is spent.
function statsSpendable(s) {
    return s.points > 0 &&
        (s.str < statCap("str") || s.dur < statCap("dur") || s.agi < statCap("agi"));
}

// Highest value of `key` that still changes something. Agility saturates early;
// Durability saturates at DUR_CAP (same 120 max HP as the old 50x2 model);
// Strength scales all the way to MAX_STAT.
function statCap(key) {
    if (key === "agi") return AGI_CAP;
    if (key === "dur") return DUR_CAP;
    return MAX_STAT;
}

// A stat re-open is only worth it if the player has an unspent point AND a stat
// that will take it. When everything is capped there is nothing to strand, and
// re-opening anyway trapped them: every tap just re-opened the form, so Close was
// the only way out. (Skill points are handled by canBuySkill/skillsChangeable.)

// ---- DUR -> max HP ----
// On @minecraft/server 2.0.0 every EntityAttributeComponent member is read-only:
// `health.effectiveMax = n` throws in strict mode (modules are strict) and
// `health.currentValue = n` silently does nothing. So max HP is granted with a
// maintained health_boost effect, and healing goes through setCurrentValue().
// The direct write is still probed once in case a future engine allows it.
let maxHpWritable = undefined; // undefined = not probed yet, false = use health_boost
// Records the health_boost amplifier we last granted, so cleanup can tell our own
// effect apart from one granted by /effect, a datapack or another addon.
const BOOST_AMP_PROP = "lu_boost_amp";

// health_boost grants +4 max HP per amplifier level (amplifier 0 == +4), and
// HP_PER_DUR is 4, so every DUR point is exactly one step. Report the real
// number in the UI (see maxHpOf) rather than the ideal one, so the form never
// promises hearts the player does not have.
function healthBoostAmplifier(dur) {
    const steps = Math.max(1, Math.round((dur * HP_PER_DUR) / 4));
    return Math.max(0, Math.min(255, steps - 1));
}

// Real max HP if the engine will tell us and the boost is ours, otherwise the
// intended value. A foreign health_boost (/effect, datapack, another addon)
// would otherwise inflate the DUR line (e.g. DUR 0 showing 40 max HP).
function maxHpOf(player, s) {
    try {
        const cur = player.getEffect("health_boost");
        const mine = num(player.getDynamicProperty(BOOST_AMP_PROP), -1);
        if (cur !== undefined && !(mine >= 0 && cur.amplifier === mine)) {
            return 20 + s.dur * HP_PER_DUR;
        }
        const v = player.getComponent("health")?.effectiveMax;
        if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.round(v);
    } catch { /* unreadable */ }
    return 20 + s.dur * HP_PER_DUR;
}

function healUpTo(hp, heal, cap) {
    if (heal <= 0) return;
    try {
        const target = Math.min(hp.currentValue + heal, cap);
        if (target > hp.currentValue) hp.setCurrentValue(target);
    } catch { /* out of bounds / entity gone */ }
}

function applyDurability(player, heal = 0) {
    try {
        if (!player.isValid) return;
        const s = loadStats(player);
        const hp = player.getComponent("health");
        if (!hp) return;
        const want = 20 + s.dur * HP_PER_DUR;

        // Probe writability early — even when dur is 0 — so a fresh world with
        // only DUR-0 players still learns the engine can't write effectiveMax.
        // Skipped while our own boost is active, or its inflated effectiveMax
        // would read back as success after a reload.
        if (maxHpWritable === undefined) {
            let boosted = false;
            try { boosted = player.getEffect("health_boost") !== undefined; } catch { /* ignore */ }
            if (boosted) {
                maxHpWritable = false;
            } else {
                let wrote = true;
                try { hp.effectiveMax = want; } catch { wrote = false; }
                let readback = 0;
                try { readback = hp.effectiveMax; } catch { readback = 0; }
                maxHpWritable = wrote && readback >= want - 0.001;
            }
        }

        if (s.dur <= 0) {
            // Nothing to grant. Drop a boost we applied earlier, but only when the
            // amplifier matches the one we recorded: removeEffect is unconditional, so
            // calling it blindly also destroys a health_boost from /effect or another
            // addon. lu_dur never falls on its own, so dur === 0 means a stat reset —
            // and the amplifier we wrote is the only reliable proof the boost is ours.
            try {
                const cur = player.getEffect("health_boost");
                const mine = num(player.getDynamicProperty(BOOST_AMP_PROP), -1);
                if (cur !== undefined && mine >= 0 && cur.amplifier === mine) {
                    player.removeEffect("health_boost");
                    player.setDynamicProperty(BOOST_AMP_PROP, undefined);
                }
            } catch { /* ignore */ }
            return;
        }

        if (maxHpWritable === true) {
            try { hp.effectiveMax = want; } catch { maxHpWritable = false; }
            if (maxHpWritable === true) {
                healUpTo(hp, heal, want);
                return;
            }
        }

        // Fallback: health_boost, refreshed by the 100-tick upkeep loop below.
        // addEffect is documented as "adds or updates", so writing unconditionally
        // would clobber a stronger boost from another source. Maintain ours only when
        // nothing stronger is active; equality still refreshes our duration.
        const wantAmp = healthBoostAmplifier(s.dur);
        try {
            const cur = player.getEffect("health_boost");
            if (cur === undefined || cur.amplifier <= wantAmp) {
                player.addEffect("health_boost", 200, { amplifier: wantAmp, showParticles: false });
                player.setDynamicProperty(BOOST_AMP_PROP, wantAmp);
            }
        } catch { /* ignore */ }
        let cap = want;
        try { cap = hp.effectiveMax; } catch { /* ignore */ }
        healUpTo(hp, heal, cap);
    } catch { /* player left mid-tick */ }
}

// One Agility point == one Speed tier, so no purchase is ever a no-op.
function agiAmplifier(agi) {
    return Math.max(0, Math.min(4, agi - 1));
}

// Single place that (re)grants the AGI speed effect, so joining/respawning and the
// upkeep loop can never drift apart. 200 ticks > the 100-tick refresh, so the effect
// is always present between passes and never blinks out.
// Records the amplifier like the DUR boost, so an AGI reset only removes our own
// speed and never a beacon/potion speed from another source.
const SPEED_AMP_PROP = "lu_speed_amp";
function applyAgility(player) {
    try {
        // loadStats clamps legacy over-cap AGI and refunds it, so read through it.
        const agi = loadStats(player).agi;
        if (agi <= 0) {
            try {
                const cur = player.getEffect("speed");
                const mine = num(player.getDynamicProperty(SPEED_AMP_PROP), -1);
                if (cur !== undefined && mine >= 0 && cur.amplifier === mine) {
                    player.removeEffect("speed");
                    player.setDynamicProperty(SPEED_AMP_PROP, undefined);
                }
            } catch { /* ignore */ }
            return;
        }
        const want = agiAmplifier(agi);
        // A beacon pyramid or a potion grants speed too, and addEffect "adds or
        // updates" — so writing unconditionally downgraded a stronger speed to ours
        // every upkeep pass. Leave a strictly stronger effect alone; equality still
        // refreshes our duration, which is what stops the effect blinking out.
        const cur = player.getEffect("speed");
        if (cur !== undefined && cur.amplifier > want) return;
        player.addEffect("speed", 200, { amplifier: want, showParticles: false });
        try { player.setDynamicProperty(SPEED_AMP_PROP, want); } catch { /* ignore */ }
    } catch { /* effect unavailable */ }
}

// Grant or top up each owned skill as a maintained effect. Amplifier 0 is
// indistinguishable from a potion's, so removal deliberately does nothing: the
// unused effect expires on its own instead of risking a real potion being
// stripped. A strictly stronger foreign effect (beacon Haste II, /effect) is
// never downgraded; equality is refreshed so ours cannot lapse between passes.
function applySkills(player) {
    try {
        const s = loadStats(player);
        for (const sk of SKILLS) {
            if (s[`skill_${sk.key}`] !== 1) continue; // not owned -> let it expire
            try {
                const cur = player.getEffect(sk.effect);
                if (cur !== undefined && cur.amplifier > sk.amp) continue;
                player.addEffect(sk.effect, SKILL_EFFECT_TICKS, { amplifier: sk.amp, showParticles: false });
            } catch { /* effect unavailable */ }
        }
    } catch { /* ignore */ }
}

// ============================================================
// FX — all best-effort, never allowed to break the tick loop.
// Camera commands need cheats ON; particles/sounds/titles do not.
// ============================================================
function safeSound(player, id, opts) {
    try { player.playSound(id, opts); } catch { /* unknown sound on this version */ }
}

function safeCommand(player, cmd) {
    try { player.runCommand(cmd); } catch { /* cheats off or unknown command */ }
}

function tell(player, text) {
    try { player.sendMessage(text); } catch { /* player left */ }
}

function setActionBar(player, text) {
    try { player.onScreenDisplay.setActionBar(text); } catch { /* HUD unavailable */ }
}

// First working particle id wins and is cached per effect key.
const particleCache = {};
function burstAt(dimension, loc, key, ids, count, spread = 0.6) {
    try {
        const id = particleCache[key];
        const candidates = id ? [id] : ids;
        for (const cand of candidates) {
            try {
                for (let i = 0; i < count; i++) {
                    dimension.spawnParticle(cand, {
                        x: loc.x + (Math.random() - 0.5) * spread * 2,
                        y: loc.y + Math.random() * 0.8,
                        z: loc.z + (Math.random() - 0.5) * spread * 2,
                    });
                }
                particleCache[key] = cand;
                return;
            } catch { /* try next candidate */ }
        }
    } catch { /* dimension unloaded */ }
}

function ringBurst(player, count) {
    try {
        burstAt(player.dimension, player.location, "ring",
            ["minecraft:totem_particle", "minecraft:mobspell_emitter", "minecraft:villager_happy"],
            count, 0.9);
    } catch { /* ignore */ }
}

// Rising spiral around the player for ~1.2s. Pure juice.
// Auto-cleans if the player logs out mid-animation to avoid orphan intervals.
function spiralUp(player, total) {
    try {
        const dim = player.dimension;
        const cx = player.location.x, cy = player.location.y, cz = player.location.z;
        let step = 0;
        const per = 3;
        const runId = system.runInterval(() => {
            try {
                if (!player.isValid) { system.clearRun(runId); return; }
                for (let k = 0; k < per; k++) {
                    const t = step * per + k;
                    const a = t * 0.55;
                    const r = 1.1 - t * 0.02;
                    burstAt(dim, { x: cx + Math.cos(a) * r, y: cy + t * 0.12, z: cz + Math.sin(a) * r },
                        "trail", ["minecraft:enchanting_table_particle", "minecraft:mobspell_emitter"], 1, 0.1);
                }
                step += 1;
                if (step * per >= total) system.clearRun(runId);
            } catch {
                try { system.clearRun(runId); } catch { /* already cleared */ }
            }
        }, 2);
        // Extra safety: if player leaves, the interval is cleared via playerLeave below.
        // Store runId on the player object transiently for that handler (non-persisted).
        try { player.__luSpiralIds = player.__luSpiralIds || []; player.__luSpiralIds.push(runId); } catch { /* ignore */ }
    } catch { /* ignore */ }
}

// Puff of particles 2 blocks in front of the player's face:
// the SYSTEM materializing before them.
function facePuff(player) {
    try {
        const dir = player.getViewDirection();
        const head = player.getHeadLocation();
        burstAt(player.dimension,
            { x: head.x + dir.x * 2, y: head.y + dir.y * 2, z: head.z + dir.z * 2 },
            "ring", ["minecraft:totem_particle", "minecraft:mobspell_emitter", "minecraft:villager_happy"], 6, 0.4);
    } catch { /* ignore */ }
}

// ---- Physical SYSTEM: floating stat-lines anchored in front of the player ----
// Invisible area_effect_clouds with glowing nametags. Nameplates billboard to
// the camera, so they read as a real floating window. Fully cosmetic: if they
// ever fail to render on some version, the form UI still carries the feature.
const HOLO_TAG = "lu_holo";
const HOLO_TICKS = 240; // 12s per summon
const HOLO_GAP = 0.32; // vertical gap between lines
const DIMENSION_IDS = ["minecraft:overworld", "minecraft:nether", "minecraft:the_end"];
// Custom dimensions are not part of stable 2.0.0; if a beta exposes them, the
// entity-scan below would miss them. `holoSpawned` is a secondary index so
// cleanup never depends solely on dimension enumeration.

const AEC_LIFETIME_TICKS = 30; // engine-side: vanilla `Duration` on a spawned cloud
const AEC_ROTATE_TICKS = AEC_LIFETIME_TICKS - 5; // our margin; must stay below the above
const holoBoards = new Map(); // playerId -> { lines: string[], until: number }
const holoSpawned = new Set(); // all live holo entities we created (fallback index)

// Holo lines must be findable from *any* dimension: a player can leave through a
// portal (or log out) with a board up, and those clouds would otherwise linger
// forever in a dimension nobody scans.
function holoEntities() {
    const out = [];
    const seen = new Set();
    for (const id of DIMENSION_IDS) {
        try {
            for (const e of world.getDimension(id).getEntities({ tags: [HOLO_TAG] })) {
                if (!seen.has(e.id)) { seen.add(e.id); out.push(e); }
            }
        } catch { /* dimension not loaded */ }
    }
    // Fallback: entities we spawned but whose dimension isn't in DIMENSION_IDS
    // (e.g. future custom dimension) — prevents orphan leaks.
    for (const e of holoSpawned) {
        if (!seen.has(e.id) && e.isValid) out.push(e);
        else if (!e.isValid) holoSpawned.delete(e);
    }
    return out;
}

function holoAnchor(player, slot) {
    const dir = player.getViewDirection();
    const head = player.getHeadLocation();
    // Never sink the board below waist height (e.g. looking straight down).
    const y = Math.max(head.y + dir.y * 2.4 + 0.5 - slot * HOLO_GAP, head.y - 1.0);
    return {
        x: head.x + dir.x * 2.4,
        y,
        z: head.z + dir.z * 2.4,
    };
}

function clearHologram(player) {
    const id = player?.id;
    if (id === undefined) return;
    holoBoards.delete(id);
    for (const e of holoEntities()) {
        try { if (e.getDynamicProperty("lu_owner") === id) { try { e.remove(); } catch { /* gone */ } holoSpawned.delete(e); } } catch { /* ignore */ }
    }
}

function spawnHoloLine(player, text, slot, until) {
    try {
        const e = player.dimension.spawnEntity("minecraft:area_effect_cloud", holoAnchor(player, slot));
        e.nameTag = text;
        e.addTag(HOLO_TAG);
        e.setDynamicProperty("lu_owner", player.id);
        e.setDynamicProperty("lu_slot", slot);
        e.setDynamicProperty("lu_until", until);
        e.setDynamicProperty("lu_born", system.currentTick);
        holoSpawned.add(e);
        return e;
    } catch { return undefined; }
}

function showHologram(player, lines, duration = HOLO_TICKS) {
    try {
        if (!player.isValid) return;
        clearHologram(player);
        const until = system.currentTick + duration;
        holoBoards.set(player.id, { lines, until });
        lines.forEach((text, slot) => { spawnHoloLine(player, text, slot, until); });
    } catch { /* ignore */ }
}

function hasHologram(player) {
    if (holoBoards.has(player.id)) return true;
    for (const e of holoEntities()) {
        try { if (e.getDynamicProperty("lu_owner") === player.id) return true; } catch { /* ignore */ }
    }
    return false;
}

// Banish the board: poof where it was, then clear. Only fires if one is up,
// so random jump-sneaking never spams sound.
function dismissHologram(player) {
    try {
        if (!hasHologram(player)) return;
        for (const e of holoEntities()) {
            try {
                if (e.getDynamicProperty("lu_owner") === player.id) {
                    burstAt(e.dimension, e.location, "ring",
                        ["minecraft:totem_particle", "minecraft:mobspell_emitter"], 8, 0.8);
                    break;
                }
            } catch { /* ignore */ }
        }
        clearHologram(player);
        safeSound(player, "block.beacon.deactivate", { pitch: 1.3, volume: 0.6 });
        setActionBar(player, "§7「 SYSTEM DISMISSED 」");
    } catch { /* ignore */ }
}

function statusHoloLines(s) {
    return [
        `§f[${s.rank}] §l§bS Y S T E M`,
        `§fLv ${s.level} §8• §e${s.points} stat points §7• §e${s.skillPoints} skill points`,
        `§cSTR ${s.str} §8• §aDUR ${s.dur} §8• §bAGI ${s.agi}`,
        "§7defeat mobs to level up",
    ];
}

// Sentinel that never appears in Bedrock entity IDs (UUIDs are hex + dashes).
const HIT_KEY_SEP = "\x00";

// Keeper, every 5 ticks: expire old lines, re-create lines the engine despawned,
// and keep the rest floating in front of their owner's view. The entity sweep
// (rather than a player list) is what cleans up boards whose owner logged out or
// walked through a portal, so that half stays entity-driven.
system.runInterval(() => {
    try {
        const now = system.currentTick;
        const online = new Map();
        for (const p of world.getPlayers()) {
            try { online.set(p.id, p); } catch { /* ignore */ }
        }
        const live = new Map(); // `${ownerId}\x00${slot}` -> entity still on the board
        for (const e of holoEntities()) {
            try {
                const ownerId = e.getDynamicProperty("lu_owner");
                const owner = typeof ownerId === "string" ? online.get(ownerId) : undefined;
                if (!owner || !owner.isValid) { try { e.remove(); } catch { /* gone */ } holoSpawned.delete(e); continue; }
                if (now > num(e.getDynamicProperty("lu_until"), 0)) { try { e.remove(); } catch { /* gone */ } holoSpawned.delete(e); continue; }
                if (e.dimension.id !== owner.dimension.id) { try { e.remove(); } catch { /* gone */ } holoSpawned.delete(e); continue; }
                live.set(`${ownerId}${HIT_KEY_SEP}${num(e.getDynamicProperty("lu_slot"), 0)}`, e);
            } catch { try { e.remove(); holoSpawned.delete(e); } catch { /* gone */ } }
        }
        for (const [id, board] of holoBoards) {
            const owner = online.get(id);
            if (!owner || !owner.isValid) { holoBoards.delete(id); continue; }
            if (now > board.until) { clearHologram(owner); continue; }
            board.lines.forEach((text, slot) => {
                const e = live.get(`${id}${HIT_KEY_SEP}${slot}`);
                if (!e) { spawnHoloLine(owner, text, slot, board.until); return; }
                // Rotate before the engine despawns this cloud. Spawning the
                // replacement first means the slot is never empty, so the board
                // does not blink once per line per AEC_LIFETIME_TICKS.
                if (now - num(e.getDynamicProperty("lu_born"), 0) < AEC_ROTATE_TICKS) {
                    try { e.teleport(holoAnchor(owner, slot)); } catch { /* moved on */ }
                } else {
                    spawnHoloLine(owner, text, slot, board.until);
                    try { e.remove(); holoSpawned.delete(e); } catch { /* already gone */ }
                }
            });
        }
    } catch { /* ignore */ }
}, 5);

// ---- LEVEL UP cinematic (~2.5s): shake + fade + spiral + ARISE + title ----
function levelUpCinematic(player, level, pointsGained, skillPointsGained = 0) {
    safeCommand(player, `camerashake add @s 0.35 1.2 rotational`);
    safeCommand(player, `camera @s fade time 0.2 1.0 0.6 color 12 4 32`);
    safeSound(player, "mob.enderdragon.growl", { pitch: 0.5, volume: 0.8 });
    ringBurst(player, 10 + pointsGained * 2);
    spiralUp(player, 20 + pointsGained * 4);
    try { showHologram(player, ["§l§eLEVEL UP", `§fLevel ${level}`, `§e+${pointsGained} stat points`, `§e+${skillPointsGained} skill points`], 160); } catch { /* cosmetic */ }

    system.runTimeout(() => {
        try {
            if (!player.isValid) return;
            safeSound(player, "block.beacon.activate", { pitch: 1.2 });
            setActionBar(player, "§d§l✦ A R I S E ✦");
        } catch { /* ignore */ }
    }, 12);

    system.runTimeout(() => {
        try {
            if (!player.isValid) return;
            try {
                player.onScreenDisplay.setTitle("§l§eLEVEL UP!", {
                    subtitle: `§7Level ${level}  •  §e+${pointsGained} stat pts  •  §c+${skillPointsGained} skill pts`,
                    fadeInDuration: 5, stayDuration: 45, fadeOutDuration: 12,
                });
            } catch { /* HUD unavailable */ }
            safeSound(player, "random.levelup");
            safeSound(player, "random.totem", { pitch: 1.1, volume: 0.7 });
            safeCommand(player, `camerashake add @s 0.25 0.8 positional`);
            ringBurst(player, 14);
        } catch { /* ignore */ }
    }, 26);
}

// ---- SYSTEM window ----
function openSystem(player, retry = 1) {
    let s;
    try {
        if (!player.isValid) return;
        s = loadStats(player);
    } catch { return; }
    const need = xpNext(s.level);
    const form = new ActionFormData()
        .title("§l§bS Y S T E M")
        .body(
            `§7Rank: §f${s.rank} §8(Level ${s.level} • ${s.xp}/${need} XP)\n` +
            `§7Stat points: §e${s.points}  §7Skill points: §e${s.skillPoints}\n\n` +
            `§c⚔ Strength: §f${s.str} §8(+${(s.str * STR_DMG_PER_POINT).toFixed(1)} dmg${s.str >= statCap("str") ? " (max)" : ""})\n` +
            `§a❤ Durability: §f${s.dur} §8(${maxHpOf(player, s)} max HP${s.dur >= statCap("dur") ? " (max)" : ""})\n` +
            `§b➶ Agility: §f${s.agi} §8(${s.agi > 0 ? "Speed " + (agiAmplifier(s.agi) + 1) : "no bonus"}${s.agi >= statCap("agi") ? " (max)" : ""})\n\n` +
            `§8Tap a stat to spend 1 point.`
        )
        .button("§c⚔ Strength +1")
        .button("§a❤ Durability +1")
        .button("§b➶ Agility +1")
        .button("§eSKILLS")
        .button("§8Close");

    form.show(player).then((res) => {
        if (res.canceled) {
            // Player busy with another dialog: retry once shortly after.
            if (res.cancelationReason === "UserBusy" && retry > 0) {
                system.runTimeout(() => openSystem(player, retry - 1), 20);
            }
            return;
        }
        if (res.selection === 4 || res.selection === undefined) return; // Close
        if (res.selection === 3) {
            system.runTimeout(() => openSystemSkills(player, 1), 10);
            return;
        }
        const st = loadStats(player);
        if (st.points <= 0) {
            const hasSkillPoint = canBuySkill(st);
            tell(player, hasSkillPoint
                ? "§b[SYSTEM] §7No stat points — but you still have skill points to spend."
                : "§b[SYSTEM] §7No stat points. Level up by defeating mobs.");
            safeSound(player, "block.beacon.deactivate", { pitch: 0.7, volume: 0.5 });
            // Skill points live in a different menu. Closing here stranded them
            // until the player redid the whole gesture.
            if (hasSkillPoint) system.runTimeout(() => openSystemSkills(player, 1), 10);
            return;
        }
        const key = res.selection === 0 ? "str" : res.selection === 1 ? "dur" : "agi";
        const names = { str: "Strength", dur: "Durability", agi: "Agility" };
        if (st[key] >= statCap(key)) {
            tell(player, `§b[SYSTEM] §7${names[key]} is maxed (${statCap(key)}).`);
            safeSound(player, "block.beacon.deactivate", { pitch: 0.7, volume: 0.5 });
            // Re-open only if the points are still theirs to spend somewhere else.
            // Returning here without a form would strand them, but re-opening when
            // nothing is spendable just traps them in a form they cannot tap out of.
            // If only skill points are left, hand them to the SKILLS menu instead.
            if (statsSpendable(st)) system.runTimeout(() => openSystem(player, 1), 10);
            else if (canBuySkill(st)) system.runTimeout(() => openSystemSkills(player, 1), 10);
            return;
        }
        st[key] += 1;
        st.points -= 1;
        saveStats(player, st);
        if (key === "dur") applyDurability(player, HP_PER_DUR);
        if (key === "agi") applyAgility(player);
        // Spend FX: pitch climbs with the new value, spark burst, action bar flash.
        safeSound(player, "random.orb", { pitch: 0.7 + Math.min(st[key], 25) * 0.03, volume: 0.8 });
        ringBurst(player, 4);
        setActionBar(player, `§e${names[key]} §7→ §f${st[key]}`);
        tell(player, `§b[SYSTEM] §f${names[key]} §7→ §f${st[key]} §8(${st.points} points left)`);
        try { showHologram(player, statusHoloLines(loadStats(player))); } catch { /* cosmetic */ }
        // Re-open so points can be spent in a row (only while a *stat* point is
        // still spendable — otherwise the last spend pops an empty form). 10 ticks:
        // reopening too fast lands while the old form is still closing (UserBusy).
        if (statsSpendable(st)) system.runTimeout(() => openSystem(player, 1), 10);
    }).catch(() => { /* player offline / in another UI */ });
}

// ---- SKILLS window ----
// Buy a skill for 1 skill point, or remove an owned skill to refund the point.
// applySkills() maintains the effects; see its comment for the (deliberately
// conservative) ownership rule at amplifier 0.
function openSystemSkills(player, retry = 1) {
    let s;
    try {
        if (!player.isValid) return;
        s = loadStats(player);
    } catch { return; }
    const form = new ActionFormData()
        .title("§l§bS Y S T E M — SKILLS")
        .body(
            `§7Skill points: §e${s.skillPoints}\n\n` +
            SKILLS.map((sk) => `§8${s[`skill_${sk.key}`] === 1 ? "§a✔" : "•"} §f${sk.name}§8 — ${sk.desc}`).join("\n") +
            `\n\n§7Tap a skill to buy (1 pt) or remove (refund 1 pt).`
        );
    for (const sk of SKILLS) {
        const owned = s[`skill_${sk.key}`] === 1;
        form.button(owned ? `§a✔ ${sk.name}` : `§e+ ${sk.name} §7(1 pt)`);
    }
    form.button("§8Close");

    form.show(player).then((res) => {
        if (res.canceled) {
            if (res.cancelationReason === "UserBusy" && retry > 0) {
                system.runTimeout(() => openSystemSkills(player, retry - 1), 20);
            }
            return;
        }
        if (res.selection === SKILLS.length || res.selection === undefined) return; // Close
        const sk = SKILLS[res.selection];
        const st = loadStats(player);
        const owned = st[`skill_${sk.key}`] === 1;
        if (owned) {
            st[`skill_${sk.key}`] = 0;
            st.skillPoints += 1;
        } else {
            if (st.skillPoints <= 0) {
                tell(player, "§b[SYSTEM] §7No skill points. Level up to earn more.");
                safeSound(player, "block.beacon.deactivate", { pitch: 0.7, volume: 0.5 });
                // The player may still remove an owned skill for a refund; closing
                // the menu here would hide that action until they reopened it.
                if (skillsChangeable(st)) system.runTimeout(() => openSystemSkills(player, 1), 10);
                return;
            }
            st[`skill_${sk.key}`] = 1;
            st.skillPoints -= 1;
        }
        saveStats(player, st);
        applySkills(player);
        tell(player, `§b[SYSTEM] §7${sk.name} §f${owned ? "removed" : "learned"}.`);
        safeSound(player, "random.orb", { pitch: owned ? 0.6 : 1.2, volume: 0.8 });
        try { showHologram(player, statusHoloLines(loadStats(player))); } catch { /* cosmetic */ }
        // Re-open only while a skills action is left — stat points live in the
        // SYSTEM menu and must not keep this one alive.
        if (skillsChangeable(st)) system.runTimeout(() => openSystemSkills(player, 1), 10);
    }).catch(() => { /* player offline / in another UI */ });
}

// Animated entrance before the form: materialize FX, then open.
// Centralizes UI cooldown so every entry path (gesture, scriptevent, chat) is
// throttled even if a caller forgot to set it.
function openSystemAnimated(player, retry = 1) {
    try {
        const g = gestureState(player);
        const now = system.currentTick;
        if (now < g.cooldownUntil) return;
        g.cooldownUntil = now + UI_COOLDOWN;
    } catch { /* ignore — still show FX even if gesture state unavailable */ }
    safeSound(player, "block.beacon.activate", { pitch: 1.6, volume: 0.6 });
    facePuff(player);
    setActionBar(player, "§b「 ACCESSING SYSTEM 」");
    try { showHologram(player, statusHoloLines(loadStats(player))); } catch { /* cosmetic */ }
    system.runTimeout(() => {
        try { if (player.isValid) openSystem(player, retry); } catch { /* ignore */ }
    }, 8);
}

// ---- Gesture: sneaking + 2 jumps ----
const gesture = new Map(); // playerId -> gesture state

function gestureState(player) {
    let g = gesture.get(player.id);
    if (!g) {
        g = {
            jumps: 0,
            windowStart: 0,
            lastVy: 0,
            cooldownUntil: 0,
            wasSneaking: false,
            wasOnGround: true,
            lastJumpTick: -1000,
            lastSneakTick: -1000,
            airJumpTick: -1000,
        };
        gesture.set(player.id, g);
    }
    return g;
}

// Single funnel for every jump source (button event + velocity sampling), so a
// jump seen twice still only counts once.
function registerJump(player, now) {
    try {
        const g = gestureState(player);
        if (now - g.lastJumpTick < JUMP_DEBOUNCE) return;
        g.lastJumpTick = now;
        g.airJumpTick = now;
        let sneaking = false;
        try { sneaking = player.isSneaking === true; } catch { /* ignore */ }
        if (sneaking) g.lastSneakTick = now;
        // Jumping out of a crouch drops isSneaking for a few ticks even though the
        // player is still holding the button, so a strict `isSneaking` test threw
        // away the second jump of the gesture. The grace only *continues* a gesture
        // that a real crouched jump started — it can never start one, so releasing
        // sneak and then double-jumping does nothing.
        if (!sneaking) {
            const continuing = g.jumps > 0 && now - g.lastSneakTick <= SNEAK_GRACE;
            if (!continuing) { g.jumps = 0; return; }
        }
        if (now < g.cooldownUntil) { g.jumps = 0; return; }
        if (g.jumps === 0 || now - g.windowStart > GESTURE_WINDOW) {
            g.jumps = 1;
            g.windowStart = now;
        } else {
            g.jumps += 1;
        }
        if (g.jumps >= 2) {
            g.jumps = 0;
            // cooldown is set inside openSystemAnimated; set here too for immediate feedback
            openSystemAnimated(player);
        }
    } catch { /* player mid-teleport */ }
}

// Dismiss = the reverse of open: jump first, then sneak mid-air.
function registerSneakStart(player, now, airborne) {
    try {
        const g = gestureState(player);
        if (!airborne) return;
        if (now - g.airJumpTick > DISMISS_WINDOW) return;
        dismissHologram(player);
    } catch { /* ignore */ }
}

// Preferred input source: exact button presses, unaffected by tick sampling.
// Stable in @minecraft/server 2.0.0; guarded so an older engine still loads.
try {
    world.afterEvents.playerButtonInput?.subscribe((ev) => {
        try {
            if (ev.newButtonState !== "Pressed") return;
            const now = system.currentTick;
            if (ev.button === "Jump") {
                registerJump(ev.player, now);
            } else if (ev.button === "Sneak") {
                let airborne = false;
                try { airborne = !ev.player.isOnGround; } catch { /* ignore */ }
                registerSneakStart(ev.player, now, airborne);
            }
        } catch { /* ignore */ }
    });
} catch { /* event unavailable on this version */ }

// Fallback input source, every tick. The old 2-tick loop with a `vy > 0.35`
// threshold missed most jumps outright: jump velocity decays below 0.35 within
// one tick, so a sample taken on the wrong tick never saw a jump at all.
system.runInterval(() => {
    const now = system.currentTick;
    for (const player of world.getPlayers()) {
        try {
            if (!player.isValid) continue;
            const g = gestureState(player);

            let vy = 0;
            try { vy = player.getVelocity()?.y ?? 0; } catch { vy = 0; }
            let onGround = true;
            try { onGround = player.isOnGround; } catch { onGround = true; }
            let sneaking = false;
            try { sneaking = player.isSneaking === true; } catch { sneaking = false; }

            // Left the ground moving up, or a clean upward spike while airborne.
            const leftGround = g.wasOnGround && !onGround && vy > 0.05;
            const spike = !g.wasOnGround && g.lastVy <= 0.2 && vy > 0.35;
            if (leftGround || spike) registerJump(player, now);

            if (sneaking) g.lastSneakTick = now;
            if (sneaking && !g.wasSneaking) registerSneakStart(player, now, !onGround);

            g.lastVy = vy;
            g.wasOnGround = onGround;
            g.wasSneaking = sneaking;

            // Drop stale progress once the window has passed.
            if (g.jumps > 0 && now - g.windowStart > GESTURE_WINDOW) g.jumps = 0;
        } catch { /* skip players mid-teleport */ }
    }
}, 1);

// Gesture state is per-player; drop it when they leave instead of letting the
// map grow until it happens to pass an arbitrary size threshold.
// Declared here (before first use) so the leave handler can also drop STR
// anti-recursion keys for the departed player.
const bonusHitAt = new Map(); // "victim\x00hitter" -> tick of last bonus damage (anti-recursion)
try {
    world.afterEvents.playerLeave.subscribe((ev) => {
        gesture.delete(ev.playerId);
        holoBoards.delete(ev.playerId);
        // Clean up any spiral intervals orphaned by this player
        try {
            for (const p of world.getPlayers()) {
                // No-op: world.getPlayers no longer contains departed player.
                // The isValid check inside spiralUp handles it; this is belt-and-suspenders.
            }
        } catch { /* ignore */ }
        try {
            for (const k of [...bonusHitAt.keys()]) {
                const sep = k.indexOf(HIT_KEY_SEP);
                if (sep === -1) { // legacy '|' keys from old saves — purge
                    if (k === ev.playerId || k.startsWith(ev.playerId + "|") || k.endsWith("|" + ev.playerId)) bonusHitAt.delete(k);
                    else bonusHitAt.delete(k);
                    continue;
                }
                const victim = k.slice(0, sep);
                const hitter = k.slice(sep + 1);
                if (victim === ev.playerId || hitter === ev.playerId) bonusHitAt.delete(k);
            }
        } catch { /* ignore */ }
        // Purge holoSpawned entries owned by departed player
        try {
            for (const e of [...holoSpawned]) {
                try { if (e.getDynamicProperty("lu_owner") === ev.playerId) { try { e.remove(); } catch { /* gone */ } holoSpawned.delete(e); } } catch { /* ignore */ }
            }
        } catch { /* ignore */ }
    });
} catch { /* ignore */ }

// ---- XP from kills -> level ups -> stat points ----
world.afterEvents.entityDie.subscribe((ev) => {
    try {
        const killer = ev.damageSource?.damagingEntity;
        if (!killer || killer.typeId !== "minecraft:player") return;
        const victim = ev.deadEntity;
        if (!victim || victim.typeId === "minecraft:player") return;
        let maxHp = 20;
        try { maxHp = victim.getComponent("health")?.effectiveMax ?? 20; } catch { /* default */ }
        const gain = Math.max(2, Math.min(20, Math.ceil(maxHp / 4)));

        const s = loadStats(killer);
        // If already max level, don't feed the while loop — just show cap feedback.
        if (s.level >= MAX_LEVEL) {
            setActionBar(killer, `§7MAX LEVEL §8(${s.xp}/${xpNext(s.level)} XP)`);
            return;
        }
        s.xp += gain;
        let ups = 0;
        const oldLevel = s.level;
        // Guarded by MAX_LEVEL — prevents freeze on corrupt 1e9 XP.
        while (s.xp >= xpNext(s.level) && s.level < MAX_LEVEL) {
            s.xp -= xpNext(s.level);
            s.level += 1;
            s.points += POINTS_PER_LEVEL;
            s.skillPoints += SKILL_POINTS_PER_LEVEL;
            ups += 1;
            // Extra safety: if something else corrupted xpNext, break after 200 ups
            if (ups > 200) break;
        }
        // Clamp XP at max level so next kill doesn't re-enter loop with huge remainder
        if (s.level >= MAX_LEVEL) {
            const cap = xpNext(s.level);
            if (s.xp >= cap) s.xp = cap - 1;
        }
        s.rank = rankOf(s.level).name;
        saveStats(killer, s);
        if (ups > 0) {
            const gainedStat = ups * POINTS_PER_LEVEL;
            const gainedSkill = ups * SKILL_POINTS_PER_LEVEL;
            levelUpCinematic(killer, s.level, gainedStat, gainedSkill);
            tell(killer, `§b[SYSTEM] §7Level §f${s.level}§7! §e+${gainedStat} stat §7and §c+${gainedSkill} skill §7points. Sneak + double-jump to spend them.`);
            // Rank up announcement — only when the rank bracket actually changes.
            const oldRank = rankOf(oldLevel).name;
            if (s.rank !== oldRank) {
                setActionBar(killer, `§d§lRANK UP: ${s.rank}`);
                // The ARISE action bar replaces this one 12 ticks later, so the
                // headline also goes to chat where it is not stamped over.
                tell(killer, `§d§lRANK UP: §f${s.rank}`);
                safeSound(killer, "block.beacon.activate", { pitch: 1.4, volume: 0.8 });
            }
        } else {
            // Kill feedback: XP blip on the action bar + orb sound.
            setActionBar(killer, `§b+${gain} XP §8(${s.xp}/${xpNext(s.level)})`);
            safeSound(killer, "random.orb", { pitch: 0.9, volume: 0.35 });
        }
    } catch { /* ignore */ }
});

// ---- STR: bonus damage on melee hits (with crit spark) ----
// This used to hang off entityHitEntity and call applyDamage(bonus). That never
// dealt anything: the victim is inside its post-hit invulnerability window, and
// damage arriving during i-frames is ignored unless it is LARGER than the hit
// that started them — in which case only the difference lands. So the fix is to
// re-apply (originalDamage + bonus): the engine subtracts the damage already
// taken and the net result is exactly the STR bonus, still credited to the
// player so kills award XP. entityHurt is used because it reports the real,
// post-armor damage number that the i-frame window is holding.
// Known limitation: the re-applied (dealt + bonus) goes through armor a second
// time, so against heavily armored targets the net can shrink below the full
// bonus (unarmored mobs — the common case — land exactly the bonus). There is
// no armor-value API in stable 2.0.0 to compensate, and a direct HP write would
// lose kill credit/XP, so entityAttack re-apply stays the correct trade-off.
world.afterEvents.entityHurt.subscribe((ev) => {
    try {
        const source = ev.damageSource;
        if (!source || source.cause !== EntityDamageCause.entityAttack) return;
        if (source.damagingProjectile) return; // melee only
        const hitter = source.damagingEntity;
        if (!hitter || hitter.typeId !== "minecraft:player") return;
        const target = ev.hurtEntity;
        if (!target || !target.isValid || target.id === hitter.id) return;
        const bonus = num(hitter.getDynamicProperty("lu_str")) * STR_DMG_PER_POINT;
        if (bonus <= 0) return;
        const dealt = ev.damage;
        if (!Number.isFinite(dealt) || dealt <= 0) return;

        const now = system.currentTick;
        const key = `${target.id}${HIT_KEY_SEP}${hitter.id}`;
        // Our own applyDamage re-fires this event next tick; never let the bonus
        // compound. Window is 2 ticks (own re-fire is +1) so legit spam hits 2+
        // ticks apart still land their bonus.
        if (now - (bonusHitAt.get(key) ?? -100) < 2) return;
        bonusHitAt.set(key, now);
        if (bonusHitAt.size > 200) {
            for (const [k, t] of bonusHitAt) if (now - t > 20) bonusHitAt.delete(k);
        }

        system.run(() => {
            try {
                if (!target.isValid) return;
                target.applyDamage(dealt + bonus, { cause: EntityDamageCause.entityAttack, damagingEntity: hitter });
                try {
                    burstAt(target.dimension, target.location, "hit",
                        ["minecraft:critical_hit_emitter", "minecraft:mobspell_emitter"], 3, 0.4);
                } catch { /* particles unavailable */ }
            } catch { /* target despawned */ }
        });
    } catch { /* ignore */ }
});

// ---- DUR: re-apply max HP on join / respawn ----
world.afterEvents.playerSpawn.subscribe((ev) => {
    system.runTimeout(() => {
        try {
            // AGI too: without this the upkeep loop was the only thing granting speed,
            // so a respawn left the player walking at base speed for up to 5s.
            // Skills too: night vision, fire resistance, etc. should come back
            // immediately on respawn rather than waiting for the upkeep pass.
            if (ev.player.isValid) { applyAgility(ev.player); applyDurability(ev.player); applySkills(ev.player); }
        } catch { /* ignore */ }
    }, 10);
});

// ---- AGI speed refresh + DUR upkeep + high-level idle aura ----
system.runInterval(() => {
    for (const player of world.getPlayers()) {
        try {
            if (!player.isValid) continue;
            applyAgility(player);
            // Keep the health_boost fallback alive (and grant it the first time round).
            if (maxHpWritable !== true) applyDurability(player);
            // Maintain owned skill effects.
            applySkills(player);
            const level = num(player.getDynamicProperty("lu_level"), 1);
            if (level >= AURA_MIN_LEVEL) {
                try {
                    const head = player.getHeadLocation();
                    burstAt(player.dimension, { x: head.x, y: head.y + 0.4, z: head.z },
                        "aura", ["minecraft:obsidian_glow_particle", "minecraft:enchanting_table_particle"], 2, 0.5);
                } catch { /* ignore */ }
            }
        } catch { /* ignore */ }
    }
}, 100);

// ---- Fallbacks for opening the SYSTEM without the gesture ----
function openFromCommand(player) {
    try {
        if (!player?.isValid) return;
        // openSystemAnimated now enforces cooldown itself, so we don't need to
        // duplicate the check here — but keep a fast-path to avoid FX spam.
        const g = gestureState(player);
        if (system.currentTick < g.cooldownUntil) return;
        openSystemAnimated(player);
    } catch { /* ignore */ }
}

// `/scriptevent lu:stats` — always available, works on every platform.
try {
    system.afterEvents.scriptEventReceive.subscribe((ev) => {
        if (ev.id !== "lu:stats" && ev.id !== "lu:system") return;
        const player = ev.sourceEntity;
        if (!player || player.typeId !== "minecraft:player") return;
        openFromCommand(player);
    }, { namespaces: ["lu"] });
} catch { /* ignore */ }

// Chat fallback ("stats" / "system"). chatSend is NOT part of stable
// @minecraft/server 2.0.0 — reading `.subscribe` off it used to throw a
// TypeError at the top level of this module, which aborted the whole script
// and silently disabled the entire addon. Guarded, so it is now a bonus on
// engines/betas that do expose it.
try {
    const chatSend = world.beforeEvents?.["chatSend"];
    if (chatSend && typeof chatSend.subscribe === "function") {
        chatSend.subscribe((ev) => {
            const msg = (ev.message ?? "").trim().toLowerCase();
            if (msg === "stats" || msg === ".stats" || msg === "system" || msg === ".system" || msg === "status") {
                ev.cancel = true;
                const sender = ev.sender;
                system.run(() => openFromCommand(sender));
            }
        });
    }
} catch { /* chat events unavailable */ }

console.warn("[LevelUp] loaded: sneak + double-jump opens the SYSTEM (or /scriptevent lu:stats).");
