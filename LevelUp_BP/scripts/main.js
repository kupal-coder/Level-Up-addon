import { world, system } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";

// ---- Tuning knobs ----
const POINTS_PER_LEVEL = 3;
const STR_DMG_PER_POINT = 0.5; // bonus melee damage per STR
const HP_PER_DUR = 2; // +1 heart per DUR (20 = 10 hearts base)
const XP_WINDOW_NOTE = 60; // ticks to land both jumps while sneaking
const UI_COOLDOWN = 60; // ticks after opening before gesture works again
const MAX_STAT = 50;
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
    player.setDynamicProperty("lu_level", s.level);
    player.setDynamicProperty("lu_xp", s.xp);
    player.setDynamicProperty("lu_points", s.points);
    player.setDynamicProperty("lu_str", s.str);
    player.setDynamicProperty("lu_dur", s.dur);
    player.setDynamicProperty("lu_agi", s.agi);
}

let maxHpWritable = undefined; // lazily probed: does effectiveMax assignment stick?

function applyDurability(player, heal = 0) {
    try {
        const s = loadStats(player);
        const hp = player.getComponent("health");
        if (!hp) return;
        const want = 20 + s.dur * HP_PER_DUR;
        if (maxHpWritable !== false) {
            try { hp.effectiveMax = want; } catch { maxHpWritable = false; }
            try {
                if (hp.effectiveMax >= want - 0.001) {
                    maxHpWritable = true;
                    if (heal > 0) hp.currentValue = Math.min(hp.currentValue + heal, hp.effectiveMax);
                    return;
                }
            } catch { /* readback failed */ }
            maxHpWritable = false;
        }
        // Fallback: health_boost effect (+4 max HP per level), kept alive by the 100-tick loop.
        if (s.dur > 0) {
            try {
                player.addEffect("health_boost", 140, {
                    amplifier: Math.max(0, Math.ceil(s.dur / 2) - 1),
                    showParticles: false,
                });
            } catch { /* ignore */ }
        }
    } catch { /* player left mid-tick */ }
}

function agiAmplifier(agi) {
    return Math.min(4, Math.floor(agi / 5));
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

function setActionBar(player, text) {
    try { player.onScreenDisplay.setActionBar(text); } catch { /* HUD unavailable */ }
}

// First working particle id wins and is cached per effect key.
const particleCache = {};
function burstAt(dimension, loc, key, ids, count, spread = 0.6) {
    try {
        let id = particleCache[key];
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

function holoAnchor(player, slot) {
    const dir = player.getViewDirection();
    const head = player.getHeadLocation();
    return {
        x: head.x + dir.x * 2.4,
        y: head.y + dir.y * 2.4 + 0.5 - slot * HOLO_GAP,
        z: head.z + dir.z * 2.4,
    };
}

function clearHologram(player) {
    try {
        for (const e of player.dimension.getEntities({ tags: [HOLO_TAG] })) {
            try { if (e.getDynamicProperty("lu_owner") === player.id) e.remove(); } catch { /* ignore */ }
        }
    } catch { /* ignore */ }
}

function showHologram(player, lines, duration = HOLO_TICKS) {
    try {
        if (!player.isValid) return;
        clearHologram(player);
        const until = system.currentTick + duration;
        lines.forEach((text, slot) => {
            try {
                const e = player.dimension.spawnEntity("minecraft:area_effect_cloud", holoAnchor(player, slot));
                e.nameTag = text;
                e.addTag(HOLO_TAG);
                e.setDynamicProperty("lu_owner", player.id);
                e.setDynamicProperty("lu_slot", slot);
                e.setDynamicProperty("lu_until", until);
            } catch { /* spawn failed */ }
        });
    } catch { /* ignore */ }
}

function hasHologram(player) {
    try {
        for (const e of player.dimension.getEntities({ tags: [HOLO_TAG] })) {
            try { if (e.getDynamicProperty("lu_owner") === player.id) return true; } catch { /* ignore */ }
        }
    } catch { /* ignore */ }
    return false;
}

// Banish the board: poof where it was, then clear. Only fires if one is up,
// so random jump-sneaking never spams sound.
function dismissHologram(player) {
    try {
        if (!hasHologram(player)) return;
        try {
            for (const e of player.dimension.getEntities({ tags: [HOLO_TAG] })) {
                try {
                    if (e.getDynamicProperty("lu_owner") === player.id) {
                        burstAt(player.dimension, e.location, "ring",
                            ["minecraft:totem_particle", "minecraft:mobspell_emitter"], 8, 0.8);
                        break;
                    }
                } catch { /* ignore */ }
            }
        } catch { /* ignore */ }
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

// Keeper, every 5 ticks: expire old lines + keep active ones floating in front
// of their owner's view. Scoped per online player, so no dimension-id guessing.
system.runInterval(() => {
    try {
        const now = system.currentTick;
        for (const owner of world.getPlayers()) {
            try {
                if (!owner.isValid) continue;
                let list = [];
                try { list = owner.dimension.getEntities({ tags: [HOLO_TAG] }); } catch { continue; }
                for (const e of list) {
                    try {
                        if (e.getDynamicProperty("lu_owner") !== owner.id) continue;
                        if (now > (e.getDynamicProperty("lu_until") ?? 0)) { e.remove(); continue; }
                        e.teleport(holoAnchor(owner, e.getDynamicProperty("lu_slot") ?? 0));
                    } catch { try { e.remove(); } catch { /* gone */ } }
                }
            } catch { /* skip this player */ }
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
        s = loadStats(player);
    } catch { return; }
    const need = xpNext(s.level);
    const form = new ActionFormData()
        .title("§l§bS Y S T E M")
        .body(
            `§7Level: §f${s.level}  §8(${s.xp}/${need} XP)\n` +
            `§7Stat points: §e${s.points}\n\n` +
            `§c⚔ Strength: §f${s.str} §8(+${(s.str * STR_DMG_PER_POINT).toFixed(1)} dmg)\n` +
            `§a❤ Durability: §f${s.dur} §8(${20 + s.dur * HP_PER_DUR} max HP)\n` +
            `§b➶ Agility: §f${s.agi} §8(${s.agi > 0 ? "Speed " + (agiAmplifier(s.agi) + 1) : "no bonus"})\n\n` +
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
        const st = loadStats(player);
        if (res.selection === 3) return; // Close
        if (st.points <= 0) {
            player.sendMessage("§b[SYSTEM] §7No stat points. Level up by defeating mobs.");
            safeSound(player, "block.beacon.deactivate", { pitch: 0.7, volume: 0.5 });
            return;
        }
        const key = res.selection === 0 ? "str" : res.selection === 1 ? "dur" : "agi";
        const names = { str: "Strength", dur: "Durability", agi: "Agility" };
        if (st[key] >= MAX_STAT) {
            player.sendMessage(`§b[SYSTEM] §7${names[key]} is maxed (${MAX_STAT}).`);
            return;
        }
        st[key] += 1;
        st.points -= 1;
        saveStats(player, st);
        if (key === "dur") applyDurability(player, HP_PER_DUR);
        // Spend FX: pitch climbs with the new value, spark burst, action bar flash.
        safeSound(player, "random.orb", { pitch: 0.7 + Math.min(st[key], 25) * 0.03, volume: 0.8 });
        ringBurst(player, 4);
        setActionBar(player, `§e${names[key]} §7→ §f${st[key]}`);
        player.sendMessage(`§b[SYSTEM] §f${names[key]} §7→ §f${st[key]} §8(${st.points} points left)`);
        system.runTimeout(() => openSystem(player, 0), 5);
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
const gesture = new Map(); // playerId -> { jumps, windowStart, lastVy, cooldownUntil }

system.runInterval(() => {
    const now = system.currentTick;
    for (const player of world.getPlayers()) {
        try {
            if (!player.isValid) continue;
            let g = gesture.get(player.id);
            if (!g) {
                g = { jumps: 0, windowStart: 0, lastVy: 0, cooldownUntil: 0, wasSneaking: false, airJumpTick: -1000 };
                gesture.set(player.id, g);
            }
            let vy = 0;
            try { vy = player.getVelocity()?.y ?? 0; } catch { vy = 0; }
            const rising = g.lastVy <= 0.3 && vy > 0.35;
            g.lastVy = vy;

            const sneaking = player.isSneaking;
            if (rising && !sneaking) g.airJumpTick = now;
            // Dismiss = the reverse of open: jump first, then sneak mid-air.
            // |vy| check keeps it mid-air only, so landing-then-sneaking won't banish.
            if (sneaking && !g.wasSneaking && now - g.airJumpTick < 40 && Math.abs(vy) > 0.05) {
                dismissHologram(player);
            }
            g.wasSneaking = sneaking;

            if (!player.isSneaking) {
                // Window expired while not sneaking: drop stale progress.
                if (g.jumps > 0 && now - g.windowStart > XP_WINDOW_NOTE) g.jumps = 0;
                continue;
            }
            if (now < g.cooldownUntil) { g.jumps = 0; continue; }
            if (rising) {
                if (g.jumps === 0 || now - g.windowStart > XP_WINDOW_NOTE) {
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
            } else if (g.jumps > 0 && now - g.windowStart > XP_WINDOW_NOTE) {
                g.jumps = 0;
            }
        } catch { /* skip players mid-teleport */ }
    }
    // Prune players who left.
    if (gesture.size > 60) {
        const online = new Set(world.getPlayers().map((p) => p.id));
        for (const id of gesture.keys()) if (!online.has(id)) gesture.delete(id);
    }
}, 2);

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
            killer.sendMessage(`§b[SYSTEM] §7Level §f${s.level}§7! Sneak + double-jump to open your status.`);
        } else {
            // Kill feedback: XP blip on the action bar + orb sound.
            setActionBar(killer, `§b+${gain} XP §8(${s.xp}/${xpNext(s.level)})`);
            safeSound(killer, "random.orb", { pitch: 0.9, volume: 0.35 });
        }
    } catch { /* ignore */ }
});

// ---- STR: bonus damage on melee hits (with crit spark) ----
const bonusHitAt = new Map(); // victimId -> tick of last bonus damage (anti-recursion)

world.afterEvents.entityHitEntity.subscribe((ev) => {
    try {
        const hitter = ev.damagingEntity;
        if (!hitter || hitter.typeId !== "minecraft:player") return;
        const bonus = num(hitter.getDynamicProperty("lu_str")) * STR_DMG_PER_POINT;
        if (bonus <= 0) return;
        const target = ev.hitEntity;
        if (!target || !target.isValid) return;
        system.run(() => {
            try {
                if (!target.isValid) return;
                const now = system.currentTick;
                // Guard: if applyDamage ever re-fires this event, never stack with our own bonus.
                if (now - (bonusHitAt.get(target.id) ?? -100) < 5) return;
                bonusHitAt.set(target.id, now);
                if (bonusHitAt.size > 200) {
                    for (const [id, t] of bonusHitAt) if (now - t > 20) bonusHitAt.delete(id);
                }
                target.applyDamage(bonus, { damagingEntity: hitter });
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
        try { if (ev.player.isValid) applyDurability(ev.player); } catch { /* ignore */ }
    }, 10);
});

// ---- AGI speed refresh + DUR fallback upkeep + high-level idle aura ----
system.runInterval(() => {
    for (const player of world.getPlayers()) {
        try {
            if (!player.isValid) continue;
            const agi = num(player.getDynamicProperty("lu_agi"));
            if (agi > 0) {
                try {
                    player.addEffect("speed", 140, { amplifier: agiAmplifier(agi), showParticles: false });
                } catch { /* effect unavailable */ }
            }
            // If direct max-HP writes are unsupported, re-apply DUR via health_boost here.
            if (maxHpWritable === false) applyDurability(player);
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

// ---- Chat fallback (mobile-friendly): "stats" / "system" ----
world.beforeEvents.chatSend.subscribe((ev) => {
    const msg = (ev.message ?? "").trim().toLowerCase();
    if (msg === "stats" || msg === ".stats" || msg === "system" || msg === ".system" || msg === "status") {
        ev.cancel = true;
        system.run(() => {
            try {
                const g = gesture.get(ev.sender.id);
                if (g) g.cooldownUntil = system.currentTick + UI_COOLDOWN;
                openSystemAnimated(ev.sender);
            } catch { /* ignore */ }
        });
    }
});

console.warn("[LevelUp] loaded: sneak + double-jump opens the SYSTEM.");
