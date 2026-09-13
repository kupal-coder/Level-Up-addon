import { world, system } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";

// ---- Tuning knobs ----
const POINTS_PER_LEVEL = 3;
const STR_DMG_PER_POINT = 0.5; // bonus melee damage per STR
const HP_PER_DUR = 2; // +1 heart per DUR (20 = 10 hearts base)
const XP_WINDOW_NOTE = 60; // ticks to land both jumps while sneaking
const UI_COOLDOWN = 60; // ticks after opening before gesture works again
const MAX_STAT = 50;

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

function applyDurability(player, heal = 0) {
    try {
        const s = loadStats(player);
        const hp = player.getComponent("health");
        if (!hp) return;
        hp.effectiveMax = 20 + s.dur * HP_PER_DUR;
        if (heal > 0) hp.currentValue = Math.min(hp.currentValue + heal, hp.effectiveMax);
    } catch { /* player left mid-tick */ }
}

function agiAmplifier(agi) {
    return Math.min(4, Math.floor(agi / 5));
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
        player.sendMessage(`§b[SYSTEM] §f${names[key]} §7→ §f${st[key]} §8(${st.points} points left)`);
        system.runTimeout(() => openSystem(player, 0), 5);
    }).catch(() => { /* player offline / in another UI */ });
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
                g = { jumps: 0, windowStart: 0, lastVy: 0, cooldownUntil: 0 };
                gesture.set(player.id, g);
            }
            let vy = 0;
            try { vy = player.getVelocity()?.y ?? 0; } catch { vy = 0; }
            const rising = g.lastVy <= 0.3 && vy > 0.35;
            g.lastVy = vy;

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
                    openSystem(player);
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
            try {
                killer.onScreenDisplay.setTitle(`§l§eLEVEL UP!`, {
                    subtitle: `§7Level ${s.level}  •  §e+${ups * POINTS_PER_LEVEL} stat points`,
                    fadeInDuration: 5, stayDuration: 40, fadeOutDuration: 10,
                });
            } catch { /* HUD unavailable */ }
            try { killer.playSound("random.levelup"); } catch { /* no sound */ }
            killer.sendMessage(`§b[SYSTEM] §7Level §f${s.level}§7! Sneak + double-jump to open your status.`);
        }
    } catch { /* ignore */ }
});

// ---- STR: bonus damage on melee hits ----
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
                if (target.isValid) target.applyDamage(bonus, { damagingEntity: hitter });
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

// ---- AGI: refresh Speed effect ----
system.runInterval(() => {
    for (const player of world.getPlayers()) {
        try {
            if (!player.isValid) continue;
            const agi = num(player.getDynamicProperty("lu_agi"));
            if (agi <= 0) continue;
            player.addEffect("speed", 140, { amplifier: agiAmplifier(agi), showParticles: false });
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
                openSystem(ev.sender);
            } catch { /* ignore */ }
        });
    }
});

console.warn("[LevelUp] loaded: sneak + double-jump opens the SYSTEM.");
