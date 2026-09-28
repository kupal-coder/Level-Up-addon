import { world, system, EntityDamageCause } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";

// ---- Tuning knobs ----
const POINTS_PER_LEVEL = 3;
const STR_DMG_PER_POINT = 0.5; // bonus melee damage per STR
const HP_PER_DUR = 2; // +1 heart per DUR (20 = 10 hearts base)
const GESTURE_WINDOW = 60; // ticks to land both jumps while sneaking
const DISMISS_WINDOW = 40; // ticks after a jump that a mid-air sneak banishes the board
const JUMP_DEBOUNCE = 6; // ticks; one physical jump must only ever count once
const SNEAK_GRACE = 12; // ticks a crouch still counts after jumping breaks it
const UI_COOLDOWN = 60; // ticks after opening before gesture works again
const MAX_STAT = 50;
// Speed has exactly five tiers, and every point has to buy one. An earlier model
// used `floor(agi / 5)`, which made 4 of every 5 Agility points a no-op (only
// agi 1/5/10/15/20 changed anything) and let the form sell the rest for nothing
// while still printing "Speed 5". One point per tier removes the banding; the
// price is a cap of 5 instead of 20.
const AGI_CAP = 5;
const AURA_MIN_LEVEL = 5; // level at which players get an idle wisp aura

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
    };
    if (s.level < 1) s.level = 1;
    return s;
}

function saveStats(player, s) {
    try {
        // A half-written block would leave `lu_points` decremented without the
        // matching stat bump, i.e. a silently destroyed point.
        if (!player.isValid) return;
        player.setDynamicProperty("lu_level", s.level);
        player.setDynamicProperty("lu_xp", s.xp);
        player.setDynamicProperty("lu_points", s.points);
        player.setDynamicProperty("lu_str", s.str);
        player.setDynamicProperty("lu_dur", s.dur);
        player.setDynamicProperty("lu_agi", s.agi);
    } catch { /* player left mid-write */ }
}

// Highest value of `key` that still changes something. Agility saturates early;
// Strength and Durability scale all the way to MAX_STAT.
function statCap(key) {
    return key === "agi" ? AGI_CAP : MAX_STAT;
}

// Is there anywhere left to put a point? A re-open is only worth it if the player
// has an unspent point AND a stat that will take it. When everything is capped
// there is nothing to strand, and re-opening anyway traps them: every tap just
// re-opened the form, so Close was the only way out.
function anySpendable(s) {
    return s.points > 0 &&
        (s.str < statCap("str") || s.dur < statCap("dur") || s.agi < statCap("agi"));
}

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

// health_boost grants +4 max HP per amplifier level (amplifier 0 == +4), so the
// fallback can only step in 4s. Round to the nearest step instead of always
// rounding up, and report the real number in the UI (see maxHpOf) rather than
// the ideal one, so the form never promises hearts the player does not have.
function healthBoostAmplifier(dur) {
    const steps = Math.max(1, Math.round((dur * HP_PER_DUR) / 4));
    return Math.max(0, Math.min(255, steps - 1));
}

// Real max HP if the engine will tell us, otherwise the intended value.
function maxHpOf(player, s) {
    try {
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
                    player.setDynamicProperty(BOOST_AMP_PROP);
                }
            } catch { /* ignore */ }
            return;
        }

        if (maxHpWritable === undefined) {
            // Never probe while our own health_boost is up: its inflated effectiveMax
            // would read back as "the write worked" after a script reload.
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
function applyAgility(player) {
    try {
        const agi = num(player.getDynamicProperty("lu_agi"));
        if (agi <= 0) return;
        const want = agiAmplifier(agi);
        // A beacon pyramid or a potion grants speed too, and addEffect "adds or
        // updates" — so writing unconditionally downgraded a stronger speed to ours
        // every upkeep pass. Leave a strictly stronger effect alone; equality still
        // refreshes our duration, which is what stops the effect blinking out.
        const cur = player.getEffect("speed");
        if (cur !== undefined && cur.amplifier > want) return;
        player.addEffect("speed", 200, { amplifier: want, showParticles: false });
    } catch { /* effect unavailable */ }
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
function spiralUp(player, total) {
    try {
        const dim = player.dimension;
        const cx = player.location.x, cy = player.location.y, cz = player.location.z;
        let step = 0;
        const per = 3;
        const runId = system.runInterval(() => {
            try {
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

// A script-spawned area_effect_cloud carries the vanilla `Duration` component
// (30 ticks) and the engine despawns it on its own; stable 2.0.0 has no
// `setComponent` to stretch that, so the board used to blink out after ~1.5s
// instead of the documented 12s no matter what the keeper did. Each line is
// therefore rotated a few ticks before the engine would eat it, which keeps every
// line continuously on screen instead of respawning it only once it is already gone.
const AEC_LIFETIME_TICKS = 30; // engine-side: vanilla `Duration` on a spawned cloud
const AEC_ROTATE_TICKS = AEC_LIFETIME_TICKS - 5; // our margin; must stay below the above
const holoBoards = new Map(); // playerId -> { lines: string[], until: number }

// Holo lines must be findable from *any* dimension: a player can leave through a
// portal (or log out) with a board up, and those clouds would otherwise linger
// forever in a dimension nobody scans.
function holoEntities() {
    const out = [];
    for (const id of DIMENSION_IDS) {
        try {
            for (const e of world.getDimension(id).getEntities({ tags: [HOLO_TAG] })) out.push(e);
        } catch { /* dimension not loaded */ }
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
        try { if (e.getDynamicProperty("lu_owner") === id) e.remove(); } catch { /* ignore */ }
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
        "§l§bS Y S T E M",
        `§fLv ${s.level} §8• §e${s.points} stat points`,
        `§cSTR ${s.str} §8• §aDUR ${s.dur} §8• §bAGI ${s.agi}`,
        "§7defeat mobs to level up",
    ];
}

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
        const live = new Map(); // `${ownerId}|${slot}` -> entity still on the board
        for (const e of holoEntities()) {
            try {
                const ownerId = e.getDynamicProperty("lu_owner");
                const owner = typeof ownerId === "string" ? online.get(ownerId) : undefined;
                if (!owner || !owner.isValid) { e.remove(); continue; }
                if (now > num(e.getDynamicProperty("lu_until"), 0)) { e.remove(); continue; }
                if (e.dimension.id !== owner.dimension.id) { e.remove(); continue; }
                live.set(`${ownerId}|${num(e.getDynamicProperty("lu_slot"), 0)}`, e);
            } catch { try { e.remove(); } catch { /* gone */ } }
        }
        for (const [id, board] of holoBoards) {
            const owner = online.get(id);
            if (!owner || !owner.isValid) { holoBoards.delete(id); continue; }
            if (now > board.until) { clearHologram(owner); continue; }
            board.lines.forEach((text, slot) => {
                const e = live.get(`${id}|${slot}`);
                if (!e) { spawnHoloLine(owner, text, slot, board.until); return; }
                // Rotate before the engine despawns this cloud. Spawning the
                // replacement first means the slot is never empty, so the board
                // does not blink once per line per AEC_LIFETIME_TICKS.
                if (now - num(e.getDynamicProperty("lu_born"), 0) < AEC_ROTATE_TICKS) {
                    try { e.teleport(holoAnchor(owner, slot)); } catch { /* moved on */ }
                } else {
                    spawnHoloLine(owner, text, slot, board.until);
                    try { e.remove(); } catch { /* already gone */ }
                }
            });
        }
    } catch { /* ignore */ }
}, 5);

// ---- LEVEL UP cinematic (~2.5s): shake + fade + spiral + ARISE + title ----
function levelUpCinematic(player, level, pointsGained) {
    safeCommand(player, `camerashake add @s 0.35 1.2 rotational`);
    safeCommand(player, `camera @s fade time 0.2 1.0 0.6 color 12 4 32`);
    safeSound(player, "mob.enderdragon.growl", { pitch: 0.5, volume: 0.8 });
    ringBurst(player, 10 + pointsGained * 2);
    spiralUp(player, 20 + pointsGained * 4);
    try { showHologram(player, ["§l§eLEVEL UP", `§fLevel ${level}`, `§e+${pointsGained} stat points`], 160); } catch { /* cosmetic */ }

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
                    subtitle: `§7Level ${level}  •  §e+${pointsGained} stat points`,
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
            `§7Level: §f${s.level}  §8(${s.xp}/${need} XP)\n` +
            `§7Stat points: §e${s.points}\n\n` +
            `§c⚔ Strength: §f${s.str} §8(+${(s.str * STR_DMG_PER_POINT).toFixed(1)} dmg)\n` +
            `§a❤ Durability: §f${s.dur} §8(${maxHpOf(player, s)} max HP)\n` +
            `§b➶ Agility: §f${s.agi} §8(${s.agi > 0 ? "Speed " + (agiAmplifier(s.agi) + 1) : "no bonus"}${s.agi >= AGI_CAP ? " (max)" : ""})\n\n` +
            `§8Tap a stat to spend 1 point.`
        )
        .button("§c⚔ Strength +1")
        .button("§a❤ Durability +1")
        .button("§b➶ Agility +1")
        .button("§8Close");

    form.show(player).then((res) => {
        if (res.canceled) {
            // Player busy with another dialog: retry once shortly after.
            if (res.cancelationReason === "UserBusy" && retry > 0) {
                system.runTimeout(() => openSystem(player, retry - 1), 20);
            }
            return;
        }
        if (res.selection === 3 || res.selection === undefined) return; // Close
        const st = loadStats(player);
        if (st.points <= 0) {
            tell(player, "§b[SYSTEM] §7No stat points. Level up by defeating mobs.");
            safeSound(player, "block.beacon.deactivate", { pitch: 0.7, volume: 0.5 });
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
            if (anySpendable(st)) system.runTimeout(() => openSystem(player, 1), 10);
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
        // Re-open so points can be spent in a row. 10 ticks: reopening too fast
        // lands while the old form is still closing and comes back UserBusy.
        system.runTimeout(() => openSystem(player, 1), 10);
    }).catch(() => { /* player offline / in another UI */ });
}

// Animated entrance before the form: materialize FX, then open.
function openSystemAnimated(player, retry = 1) {
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
            g.cooldownUntil = now + UI_COOLDOWN;
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
try {
    world.afterEvents.playerLeave.subscribe((ev) => {
        gesture.delete(ev.playerId);
        holoBoards.delete(ev.playerId);
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
        s.xp += gain;
        let ups = 0;
        while (s.xp >= xpNext(s.level)) {
            s.xp -= xpNext(s.level);
            s.level += 1;
            s.points += POINTS_PER_LEVEL;
            ups += 1;
        }
        saveStats(killer, s);
        if (ups > 0) {
            levelUpCinematic(killer, s.level, ups * POINTS_PER_LEVEL);
            tell(killer, `§b[SYSTEM] §7Level §f${s.level}§7! Sneak + double-jump to open your status.`);
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
const bonusHitAt = new Map(); // "victim|hitter" -> tick of last bonus damage (anti-recursion)

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
        const key = `${target.id}|${hitter.id}`;
        // Our own applyDamage re-fires this event; never let the bonus compound.
        if (now - (bonusHitAt.get(key) ?? -100) < 5) return;
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
            if (ev.player.isValid) { applyAgility(ev.player); applyDurability(ev.player); }
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
        const g = gestureState(player);
        g.cooldownUntil = system.currentTick + UI_COOLDOWN;
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
