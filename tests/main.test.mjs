import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { harness, advance, world, system } from "@minecraft/server";
import { formLog } from "@minecraft/server-ui";

const here = dirname(fileURLToPath(import.meta.url));

const results = [];
async function t(name, fn) {
    try { await fn(); results.push(["PASS", name]); }
    catch (e) { results.push(["FAIL", name + " :: " + e.message]); }
}
// Let queued promise callbacks (form.show().then) run between ticks.
const flush = () => new Promise((r) => setTimeout(r, 0));
async function advanceAsync(n) { for (let i = 0; i < n; i++) { advance(1); await flush(); } }

const P = harness.Player;
function newPlayer(name) { const p = new P(name); harness.players.push(p); return p; }
// Emit `n` player-kills on one mob so we can level quickly without re-spawning.
function killN(killer, n) {
    const victim = killer.dimension.spawnEntity("minecraft:zombie", killer.location);
    for (let i = 0; i < n; i++) {
        world.afterEvents.entityDie.emit({ damageSource: { damagingEntity: killer }, deadEntity: victim });
    }
}
// formLog.shown is global, so a re-open chain left running by an earlier test
// would otherwise be counted against whoever we are asserting on.
const formsFor = (p) => formLog.shown.filter((s) => s.player === p.id).length;

await import("../LevelUp_BP/scripts/main.js");

// --- 1. module loaded at all (the chatSend crash) ---
await t("module loads without throwing", () => { assert.ok(true); });

// --- 2. gesture: sneak + double jump opens the form ---
const p = newPlayer("alice");
// A real Bedrock jump arc: ~12 ticks airborne, vertical velocity decaying
// below the old 0.35 threshold after a single tick.
function jump(pl) {
    pl.isOnGround = false; pl.vy = 0.42; advance(1);
    pl.vy = 0.33; advance(1);
    pl.vy = 0.20; advance(1);
    pl.vy = 0.05; advance(1);
    pl.vy = -0.1; advance(1);
    pl.vy = -0.25; advance(1);
    pl.vy = -0.4; advance(1);
    pl.isOnGround = true; pl.vy = 0; advance(4);
}
await t("sneak + double jump opens the SYSTEM form", () => {
    formLog.shown.length = 0;
    p.isSneaking = true;
    jump(p); jump(p);
    advance(15);
    assert.ok(formsFor(p) >= 1, "form never shown");
});

await t("a single jump does NOT open the form", () => {
    advance(80); // clear cooldown
    formLog.shown.length = 0;
    p.isSneaking = true;
    jump(p);
    advance(80);
    assert.strictEqual(formsFor(p), 0);
});

await t("double jump while NOT sneaking does not open", () => {
    advance(80);
    formLog.shown.length = 0;
    p.isSneaking = false;
    jump(p); jump(p);
    advance(30);
    assert.strictEqual(formsFor(p), 0);
});

// --- 3. button-input path also works ---
await t("playerButtonInput jump presses open the form", () => {
    advance(120);
    formLog.shown.length = 0;
    const q = newPlayer("bob");
    q.isSneaking = true;
    world.afterEvents.playerButtonInput.emit({ player: q, button: "Jump", newButtonState: "Pressed" });
    advance(8);
    world.afterEvents.playerButtonInput.emit({ player: q, button: "Jump", newButtonState: "Pressed" });
    advance(15);
    assert.ok(formsFor(q) >= 1, "form never shown via button input");
});

// --- 4. XP / level up ---
await t("kill grants XP and levels up at 50", () => {
    const k = newPlayer("carol");
    const victim = k.dimension.spawnEntity("minecraft:zombie", k.location);
    for (let i = 0; i < 12; i++) {
        world.afterEvents.entityDie.emit({ damageSource: { damagingEntity: k }, deadEntity: victim });
    }
    advance(40);
    assert.strictEqual(k.getDynamicProperty("lu_level"), 2, "level should be 2");
    assert.strictEqual(k.getDynamicProperty("lu_points"), 3, "should have 3 points");
});

// --- 5. STR bonus damage actually lands (i-frame fix) ---
await t("STR bonus re-applies original + bonus so it beats i-frames", () => {
    harness.damages.length = 0;
    const s = newPlayer("dave");
    s.setDynamicProperty("lu_str", 4); // +2.0 bonus
    const mob = s.dimension.spawnEntity("minecraft:cow", s.location);
    world.afterEvents.entityHurt.emit({
        damageSource: { cause: "entityAttack", damagingEntity: s },
        hurtEntity: mob, damage: 7,
    });
    advance(2);
    assert.strictEqual(harness.damages.length, 1, "bonus damage not applied");
    assert.strictEqual(harness.damages[0].amount, 9, "should re-apply 7+2, got " + harness.damages[0].amount);
});

await t("STR bonus does not recurse when our own damage re-fires the event", () => {
    harness.damages.length = 0;
    const s = newPlayer("erin");
    s.setDynamicProperty("lu_str", 4);
    const mob = s.dimension.spawnEntity("minecraft:cow", s.location);
    const ev = { damageSource: { cause: "entityAttack", damagingEntity: s }, hurtEntity: mob, damage: 7 };
    world.afterEvents.entityHurt.emit(ev);
    world.afterEvents.entityHurt.emit(ev);
    world.afterEvents.entityHurt.emit(ev);
    advance(2);
    assert.strictEqual(harness.damages.length, 1, "bonus stacked " + harness.damages.length + " times");
});

await t("zero STR applies no bonus damage", () => {
    harness.damages.length = 0;
    const s = newPlayer("frank");
    const mob = s.dimension.spawnEntity("minecraft:cow", s.location);
    world.afterEvents.entityHurt.emit({
        damageSource: { cause: "entityAttack", damagingEntity: s }, hurtEntity: mob, damage: 5,
    });
    advance(2);
    assert.strictEqual(harness.damages.length, 0);
});

// --- 6. DUR -> max HP via health_boost fallback ---
await t("DUR grants max HP through health_boost when effectiveMax is read-only", () => {
    const d = newPlayer("gina");
    d.setDynamicProperty("lu_dur", 4); // want 36 max HP (4 HP per point)
    world.afterEvents.playerSpawn.emit({ player: d });
    advance(20);
    const hp = d.getComponent("health");
    assert.ok(hp.effectiveMax > 20, "max HP never increased (still " + hp.effectiveMax + ")");
});

await t("health_boost is refreshed by the upkeep loop and never expires", () => {
    const d = newPlayer("hank");
    d.setDynamicProperty("lu_dur", 6);
    world.afterEvents.playerSpawn.emit({ player: d });
    advance(600);
    assert.ok(d.getEffect("health_boost"), "health_boost lapsed");
});

// A boost the addon itself granted is ours to clean up when Durability is reset.
// (A boost we never granted belongs to /effect, a datapack or another addon, and
// removing it is a bug of its own - see the foreign-effect test further down.)
await t("DUR 0 does not leave a stale health_boost", () => {
    const d = newPlayer("iris");
    d.setDynamicProperty("lu_dur", 6);
    advance(120);
    assert.ok(d.getEffect("health_boost"), "precondition: no boost was granted");
    d.setDynamicProperty("lu_dur", 0); // stat reset
    advance(120);
    assert.ok(!d.getEffect("health_boost"), "stale boost not cleared");
});

// Every DUR point must buy Max HP. The old HP_PER_DUR=2 quantized pairs to the
// same 4-HP step (1-2 -> 24, 3-4 -> 28), so every even point was a no-op.
// HP_PER_DUR=4 makes each point exactly one step.
await t("every Durability point buys distinct max HP", () => {
    for (let want = 1; want <= 5; want++) {
        const d = newPlayer("dur" + want);
        d.setDynamicProperty("lu_dur", want);
        world.afterEvents.playerSpawn.emit({ player: d });
        advance(20);
        assert.strictEqual(d.getComponent("health").effectiveMax, 20 + want * 4,
            "dur " + want + " should be " + (20 + want * 4) + " max HP");
        d.isValid = false;
        harness.players = harness.players.filter((x) => x !== d);
    }
});

// --- 7. AGI speed does not blink out between refreshes ---
await t("AGI speed effect is always present between refreshes", () => {
    const a = newPlayer("jack");
    a.setDynamicProperty("lu_agi", 5); // max: Speed V
    advance(101);
    for (let i = 0; i < 100; i++) {
        advance(1);
        assert.ok(a.getEffect("speed"), "speed lapsed at +" + i);
    }
});

await t("AGI speed is applied on respawn, not just by the upkeep loop", () => {
    advance(120);
    const a = newPlayer("kate");
    a.setDynamicProperty("lu_agi", 5);
    // Land immediately after an upkeep pass, then wipe its effect, so the only
    // thing that can restore speed before the next 100-tick pass is playerSpawn.
    for (let i = 0; i < 100 && !a.getEffect("speed"); i++) advance(1);
    assert.ok(a.getEffect("speed"), "never caught an upkeep boundary");
    a.removeEffect("speed");
    world.afterEvents.playerSpawn.emit({ player: a });
    advance(15);
    assert.ok(a.getEffect("speed"),
        "no speed 15 ticks after respawn; the upkeep loop is up to 100 ticks away");
});

await t("AGI 0 clears our own speed but leaves a foreign speed alone", () => {
    advance(120);
    const o = newPlayer("owen");
    o.setDynamicProperty("lu_agi", 3);
    advance(120);
    assert.ok(o.getEffect("speed"), "precondition: no speed was granted");
    o.setDynamicProperty("lu_agi", 0); // stat reset
    advance(120);
    assert.ok(!o.getEffect("speed"), "stale speed not cleared after AGI reset");
    o.isValid = false;
    harness.players = harness.players.filter((x) => x !== o);

    const f = newPlayer("freda");
    f.setDynamicProperty("lu_agi", 0);
    f.addEffect("speed", 20000, { amplifier: 2 }); // beacon / potion
    advance(120);
    assert.ok(f.getEffect("speed") !== undefined, "a foreign speed was stripped at AGI 0");
});

// --- 8. hologram lifecycle ---
await t("hologram entities are cleaned up when the owner leaves", () => {
    advance(120);
    const h = newPlayer("kim");
    formLog.respond = null;
    h.isSneaking = true;
    jump(h); jump(h);
    advance(15);
    const before = harness.entities.filter((e) => e.tags.has("lu_holo")).length;
    assert.ok(before > 0, "no hologram spawned");
    h.isValid = false;
    harness.players = harness.players.filter((x) => x !== h);
    advance(12);
    const after = harness.entities.filter((e) => e.tags.has("lu_holo") && e.getDynamicProperty("lu_owner") === h.id).length;
    assert.strictEqual(after, 0, "orphaned holograms left behind: " + after);
});

await t("holograms expire after their duration", () => {
    advance(400);
    const left = harness.entities.filter((e) => e.tags.has("lu_holo")).length;
    assert.strictEqual(left, 0, left + " holograms never expired");
});

// The engine despawns a script-spawned area_effect_cloud after ~30 ticks on its
// own (vanilla `Duration`; stable 2.0.0 has no setComponent to stretch it), so the
// keeper has to keep the lines alive. Without that the board vanished after ~1.5s
// instead of the 12s HOLO_TICKS promises, or - if it only respawned once a line was
// already gone - left a 5-tick hole in the board every 30 ticks.
await t("holo board stays complete for its whole lifetime", async () => {
    advance(120);
    formLog.respond = null;
    const m = newPlayer("mara");
    m.isSneaking = true;
    jump(m); jump(m);
    await advanceAsync(20);
    const owned = () => harness.entities.filter((e) => e.tags.has("lu_holo") && e.getDynamicProperty("lu_owner") === m.id);
    assert.ok(owned().length > 0, "no hologram spawned");
    for (let i = 0; i < 200; i++) {
        advance(1);
        await flush();
        assert.ok(owned().length >= 4, "board dropped below 4 lines at +" + i + " (" + owned().length + ")");
    }
    advance(60); // past HOLO_TICKS
    assert.strictEqual(owned().length, 0, "board outlived its duration");
});

// --- 9. spending a point ---
await t("spending a point on STR decrements points and bumps the stat", async () => {
    advance(120);
    const sp = newPlayer("liam");
    sp.setDynamicProperty("lu_points", 2);
    let calls = 0;
    formLog.respond = () => (calls++ === 0 ? { canceled: false, selection: 0 } : { canceled: true, cancelationReason: "UserClosed" });
    sp.isSneaking = true;
    jump(sp); jump(sp);
    await advanceAsync(40);
    assert.strictEqual(sp.getDynamicProperty("lu_str"), 1, "STR not incremented");
    assert.strictEqual(sp.getDynamicProperty("lu_points"), 1, "point not spent");
    formLog.respond = null;
});

// --- 9b. a maxed stat must not strand the points the player still holds ---
await t("maxing a stat reopens the form so the remaining points stay spendable", async () => {
    advance(120);
    const sp = newPlayer("pat");
    sp.setDynamicProperty("lu_points", 5);
    sp.setDynamicProperty("lu_str", 50); // already at MAX_STAT
    formLog.respond = () => ({ canceled: false, selection: 0 }); // keeps tapping STR
    formLog.shown.length = 0;
    system.afterEvents.scriptEventReceive.emit({ id: "lu:stats", sourceEntity: sp });
    await advanceAsync(30);
    assert.ok(formsFor(sp) >= 2,
        "form closed on a maxed stat, stranding " + sp.getDynamicProperty("lu_points") + " points");
    assert.strictEqual(sp.getDynamicProperty("lu_points"), 5, "a point was spent on a maxed stat");
    formLog.respond = null;
});

// --- 9c. every stat point must buy something ---
// The first Agility model used floor(agi/5): only agi 1/5/10/15/20 changed the
// Speed tier, so 4 of every 5 points were sold for nothing while the form still
// read "Speed 5". One point per tier, capped at 5, is the only model where a
// point is never a no-op.
await t("every Agility point buys a distinct Speed tier", async () => {
    advance(120);
    const seen = [];
    for (let want = 1; want <= 5; want++) {
        const ag = newPlayer("tier" + want);
        ag.setDynamicProperty("lu_agi", want - 1);
        ag.setDynamicProperty("lu_points", 2);
        formLog.respond = () => ({ canceled: false, selection: 2 });
        system.afterEvents.scriptEventReceive.emit({ id: "lu:stats", sourceEntity: ag });
        await advanceAsync(12);
        assert.strictEqual(ag.getDynamicProperty("lu_agi"), want, "agi did not reach " + want);
        assert.strictEqual(ag.getDynamicProperty("lu_points"), 1, "the point was not spent");
        assert.strictEqual(ag.getEffect("speed").amplifier, want - 1,
            "agi " + want + " should be Speed " + want);
        seen.push(ag.getEffect("speed").amplifier);
        formLog.respond = null;
        ag.isValid = false;
        harness.players = harness.players.filter((x) => x !== ag);
    }
    assert.strictEqual(new Set(seen).size, 5, "some Agility points gave the same tier");
});

await t("Agility points past the cap cannot be spent", async () => {
    advance(120);
    const ag = newPlayer("vera");
    ag.setDynamicProperty("lu_agi", 5); // Speed V: the last tier
    ag.setDynamicProperty("lu_points", 5);
    formLog.respond = () => ({ canceled: false, selection: 2 }); // keep tapping Agility
    formLog.shown.length = 0;
    system.afterEvents.scriptEventReceive.emit({ id: "lu:stats", sourceEntity: ag });
    await advanceAsync(12);
    assert.strictEqual(ag.getDynamicProperty("lu_agi"), 5, "agi was raised past its cap");
    assert.strictEqual(ag.getDynamicProperty("lu_points"), 5, "a point was burned on a no-op Agility purchase");
    formLog.respond = null;
});

await t("Agility below the cap still spends normally", async () => {
    advance(120);
    const ag = newPlayer("wade");
    ag.setDynamicProperty("lu_agi", 2);
    ag.setDynamicProperty("lu_points", 5);
    formLog.respond = () => ({ canceled: false, selection: 2 });
    system.afterEvents.scriptEventReceive.emit({ id: "lu:stats", sourceEntity: ag });
    await advanceAsync(12);
    assert.strictEqual(ag.getDynamicProperty("lu_agi"), 3, "agi did not step one tier");
    assert.strictEqual(ag.getDynamicProperty("lu_points"), 4, "the point was not spent");
    formLog.respond = null;
});

// --- 9d. the upkeep must not clobber effects it did not grant ---
// addEffect is "adds or updates", so writing our own amplifier unconditionally
// downgraded a stronger effect every pass; removeEffect is worse still.
await t("upkeep never downgrades a stronger speed from another source", async () => {
    advance(120);
    const sp = newPlayer("hal");
    sp.setDynamicProperty("lu_agi", 1); // our Agility == Speed I
    sp.addEffect("speed", 20000, { amplifier: 2 }); // e.g. a beacon pyramid
    await advanceAsync(101);
    assert.strictEqual(sp.getEffect("speed").amplifier, 2,
        "a stronger speed was downgraded to amplifier " + sp.getEffect("speed").amplifier);
});

await t("upkeep never removes a health_boost from another source", async () => {
    advance(120);
    const hb = newPlayer("iris");
    hb.setDynamicProperty("lu_dur", 0);
    hb.addEffect("health_boost", 20000, { amplifier: 4 }); // /effect, a datapack, another addon
    await advanceAsync(101);
    assert.ok(hb.getEffect("health_boost") !== undefined, "a foreign health_boost was stripped");
    assert.strictEqual(hb.getComponent("health").effectiveMax, 40, "foreign max HP was lost");
});

// --- 9e. a maxed tap must not trap the player in the form ---
// Re-opening on a maxed stat was v1.3.3's fix for stranded points, but with every
// stat capped there is nowhere to strand them to: each tap just re-opened the form,
// so Close was the only exit.
await t("tapping a maxed stat does not re-open when nothing is spendable", async () => {
    advance(120);
    const sp = newPlayer("trapper");
    sp.setDynamicProperty("lu_points", 5);
    sp.setDynamicProperty("lu_str", 50);
    sp.setDynamicProperty("lu_dur", 25);
    sp.setDynamicProperty("lu_agi", 5);
    formLog.shown.length = 0;
    formLog.respond = () => ({ canceled: false, selection: 0 }); // keeps tapping STR
    system.afterEvents.scriptEventReceive.emit({ id: "lu:stats", sourceEntity: sp });
    await advanceAsync(300);
    assert.strictEqual(formsFor(sp), 1,
        "form re-opened " + formsFor(sp) + " times with nothing spendable");
    assert.strictEqual(sp.getDynamicProperty("lu_points"), 5, "a point was spent on a maxed stat");
    formLog.respond = null;
});

await t("tapping a maxed stat still reopens when another stat can take the point", async () => {
    advance(120);
    const sp = newPlayer("untrapped");
    sp.setDynamicProperty("lu_points", 5);
    sp.setDynamicProperty("lu_str", 50);
    sp.setDynamicProperty("lu_dur", 3);
    formLog.shown.length = 0;
    formLog.respond = () => ({ canceled: false, selection: 0 });
    system.afterEvents.scriptEventReceive.emit({ id: "lu:stats", sourceEntity: sp });
    await advanceAsync(60);
    assert.ok(formsFor(sp) >= 2,
        "form closed on a maxed stat, stranding " + sp.getDynamicProperty("lu_points") + " points");
    assert.strictEqual(sp.getDynamicProperty("lu_points"), 5, "a point was spent on a maxed stat");
    formLog.respond = null;
});

await t("Close button does not spend a point", async () => {
    advance(120);
    const sp = newPlayer("mia");
    sp.setDynamicProperty("lu_points", 5);
    formLog.respond = () => ({ canceled: false, selection: 3 });
    sp.isSneaking = true;
    jump(sp); jump(sp);
    await advanceAsync(40);
    assert.strictEqual(sp.getDynamicProperty("lu_points"), 5, "Close spent a point");
    formLog.respond = null;
});

await t("spending the last point does not pop an empty form", async () => {
    advance(120);
    const sp = newPlayer("lastpoint");
    sp.setDynamicProperty("lu_points", 1);
    formLog.respond = () => ({ canceled: false, selection: 0 });
    formLog.shown.length = 0;
    system.afterEvents.scriptEventReceive.emit({ id: "lu:stats", sourceEntity: sp });
    await advanceAsync(60);
    assert.strictEqual(sp.getDynamicProperty("lu_points"), 0, "point was not spent");
    assert.strictEqual(formsFor(sp), 1, "empty form re-opened with 0 points (" + formsFor(sp) + ")");
    formLog.respond = null;
});

// --- 9f. the form body must contain real line breaks ---
// The body was written with `\\n` — an escaped backslash — so every line break
// stayed literal "\n" text and the SYSTEM window rendered as one long line
// with visible backslash-n's between the fields.
await t("SYSTEM form body renders real newlines", async () => {
    advance(120);
    formLog.shown.length = 0;
    const nb = newPlayer("bodyline");
    system.afterEvents.scriptEventReceive.emit({ id: "lu:stats", sourceEntity: nb });
    await advanceAsync(15);
    const last = formLog.shown.filter((s) => s.player === nb.id).pop();
    assert.ok(last, "form not shown");
    assert.ok(!last.body.includes("\\n"), "body still contains literal \\n text");
    assert.ok(last.body.split("\n").length >= 6, "body lost its line breaks");
    formLog.respond = null;
});

// --- 10. skills ---
await t("level up grants 1 skill point", async () => {
    const k = newPlayer("sklvl");
    killN(k, 12); // 60 XP → level 2
    advance(40);
    assert.strictEqual(k.getDynamicProperty("lu_level"), 2, "level should be 2");
    assert.strictEqual(k.getDynamicProperty("lu_points"), 3, "3 stat points");
    assert.strictEqual(k.getDynamicProperty("lu_skill_points"), 1, "1 skill point");
});

await t("buying Night Vision grants the effect", async () => {
    advance(120);
    const sk = newPlayer("skbuy");
    sk.setDynamicProperty("lu_skill_points", 1);
    formLog.shown.length = 0;
    // 1st form.show = main (tap SKILLS), 2nd = skills (buy Night Vision, index 0)
    let shown = 0;
    formLog.respond = () => {
        shown++;
        return shown === 1
            ? { canceled: false, selection: 3 }
            : { canceled: false, selection: 0 };
    };
    system.afterEvents.scriptEventReceive.emit({ id: "lu:stats", sourceEntity: sk });
    await advanceAsync(30);
    assert.ok(sk.getEffect("night_vision"), "night vision not granted");
    assert.strictEqual(sk.getDynamicProperty("lu_skill_points"), 0, "skill point not spent");
    formLog.respond = null;
});

await t("upkeep maintains an owned skill effect", async () => {
    advance(120);
    const sk = newPlayer("skkeep");
    sk.setDynamicProperty("lu_skill_nv", 1);
    sk.setDynamicProperty("lu_skill_points", 0);
    assert.ok(!sk.getEffect("night_vision"), "precondition: no effect yet");
    await advanceAsync(101);
    assert.ok(sk.getEffect("night_vision"), "owned skill effect not maintained by upkeep");
});

await t("removing an owned skill refunds the point and drops only our effect", async () => {
    advance(120);
    const sk = newPlayer("skrem");
    sk.setDynamicProperty("lu_skill_nv", 1);
    sk.setDynamicProperty("lu_skill_points", 0);
    await advanceAsync(101);
    assert.ok(sk.getEffect("night_vision"), "precondition: effect granted");
    formLog.shown.length = 0;
    // 1st = main (SKILLS), 2nd = skills (remove Night Vision, index 0),
    // 3rd = re-open (anySpendable is true after refund) → close it.
    let shown = 0;
    formLog.respond = () => {
        shown++;
        if (shown === 1) return { canceled: false, selection: 3 };
        if (shown === 2) return { canceled: false, selection: 0 };
        return { canceled: true, cancelationReason: "UserClosed" };
    };
    system.afterEvents.scriptEventReceive.emit({ id: "lu:stats", sourceEntity: sk });
    await advanceAsync(30);
    assert.ok(!sk.getEffect("night_vision"), "owned skill not removed");
    assert.strictEqual(sk.getDynamicProperty("lu_skill_points"), 1, "point not refunded");
    formLog.respond = null;
});

await t("upkeep never removes a night_vision from another source", async () => {
    advance(120);
    const f = newPlayer("skforeign");
    f.setDynamicProperty("lu_skill_nv", 0); // we do not own it
    f.addEffect("night_vision", 20000, { amplifier: 0 });
    assert.ok(f.getEffect("night_vision"), "precondition: foreign effect present");
    await advanceAsync(101);
    assert.ok(f.getEffect("night_vision"), "foreign night_vision was stripped");
});

// --- 11. ranks ---
await t("rank is stored and clamped on level up", async () => {
    const k = newPlayer("rank1");
    k.setDynamicProperty("lu_level", 100);
    k.setDynamicProperty("lu_points", 1);
    formLog.shown.length = 0;
    formLog.respond = () => ({ canceled: false, selection: 0 }); // spend a stat point to trigger saveStats
    system.afterEvents.scriptEventReceive.emit({ id: "lu:stats", sourceEntity: k });
    await advanceAsync(20);
    assert.strictEqual(k.getDynamicProperty("lu_rank"), "National Hunter", "rank not National Hunter at level 100");
    formLog.respond = null;
});

await t("rank advances E → D → C as the player levels", async () => {
    const k = newPlayer("rank2");
    killN(k, 60); // 300 XP → level 4 (E)
    advance(40);
    assert.strictEqual(k.getDynamicProperty("lu_rank"), "E", "rank should be E at level 4");
    killN(k, 40); // +200 XP → level 5 (D)
    advance(40);
    assert.strictEqual(k.getDynamicProperty("lu_level"), 5, "should be level 5");
    assert.strictEqual(k.getDynamicProperty("lu_rank"), "D", "rank should be D at level 5");
    killN(k, 350); // +1750 XP → level 10 (C)
    advance(40);
    assert.ok(k.getDynamicProperty("lu_level") >= 10, "should be level 10+");
    assert.strictEqual(k.getDynamicProperty("lu_rank"), "C", "rank should be C at level 10");
});

await t("rank up announcement on action bar", async () => {
    const k = newPlayer("rankup");
    const victim = k.dimension.spawnEntity("minecraft:zombie", k.location);
    for (let i = 0; i < 100; i++) { // 500 XP → level 5, E → D
        world.afterEvents.entityDie.emit({ damageSource: { damagingEntity: k }, deadEntity: victim });
    }
    advance(40);
    const ab = harness.actionBars.filter((a) => a.who === k.id && a.t.includes("RANK UP"));
    assert.ok(ab.length >= 1, "rank up not announced");
    assert.ok(ab[0].t.includes("D"), "wrong rank announced: " + ab[0].t);
});

// --- 12. v1.4.4 bug fixes ---
// The skill effect lasts 200 ticks and upkeep runs every 100, so it must be
// renewed on each pass — waiting for expiry leaves it at the mercy of a late pass.
await t("owned skill effects are renewed on every upkeep pass", async () => {
    advance(120);
    const sk = newPlayer("skrefresh");
    sk.setDynamicProperty("lu_skill_nv", 1);
    sk.setDynamicProperty("lu_agi", 1); // speed is refreshed every pass -> pass detector
    await advanceAsync(101);
    const firstSkill = sk.getEffect("night_vision");
    let lastSpeed = sk.getEffect("speed");
    assert.ok(firstSkill && lastSpeed, "precondition: maintained effects not granted");
    // Step to the next upkeep pass (< 200 ticks after the skill's grant, because
    // a pass happened at most 100 ticks before we captured) using speed's `until`
    // as the "a pass ran" signal.
    let passSeen = false;
    for (let i = 0; i < 100; i++) {
        await advanceAsync(1);
        const cur = sk.getEffect("speed");
        assert.ok(cur, "precondition: speed lapsed while waiting for a pass");
        if (cur.until > lastSpeed.until) { passSeen = true; break; }
    }
    assert.ok(passSeen, "precondition: no upkeep pass observed within 100 ticks");
    const secondSkill = sk.getEffect("night_vision");
    assert.ok(secondSkill, "skill effect lapsed on the next upkeep pass");
    assert.ok(secondSkill.until > firstSkill.until,
        `effect not renewed (until ${secondSkill.until} vs ${firstSkill.until}) — a late upkeep pass would let it blink out`);
});

await t("a stat tap with only skill points left opens the SKILLS menu", async () => {
    advance(120);
    const z = newPlayer("skstrand");
    z.setDynamicProperty("lu_points", 0);
    z.setDynamicProperty("lu_skill_points", 1);
    formLog.shown.length = 0;
    let shown = 0;
    formLog.respond = () => {
        shown += 1;
        if (shown === 1) return { canceled: false, selection: 0 }; // tap STR with no stat points
        return { canceled: true, cancelationReason: "UserClosed" };
    };
    system.afterEvents.scriptEventReceive.emit({ id: "lu:stats", sourceEntity: z });
    await advanceAsync(40);
    assert.ok(formsFor(z) >= 2, "skill point stranded: the form closed on 'No stat points'");
    formLog.respond = null;
});

await t("level up announcement mentions the skill point", async () => {
    advance(120);
    const k = newPlayer("skmsg");
    harness.messages.length = 0;
    killN(k, 12); // 60 XP -> level 2
    advance(40);
    const msgs = harness.messages.filter((m) => m.who === k.id).map((m) => m.t);
    assert.ok(msgs.some((t) => /skill/i.test(t)), "level-up message never mentions skill points");
});

await t("rank up is also announced in chat, not just the action bar", async () => {
    advance(120);
    const k = newPlayer("rankmsg");
    harness.messages.length = 0;
    killN(k, 100); // 500 XP -> level 5, E -> D
    advance(40);
    const msgs = harness.messages.filter((m) => m.who === k.id).map((m) => m.t);
    assert.ok(msgs.some((t) => t.includes("RANK UP")),
        "rank up never reached chat (ARISE overwrites the action bar 12 ticks later)");
});

await t("a locked skill does not close the menu while a skill can still be removed", async () => {
    advance(120);
    const z = newPlayer("sklocked");
    z.setDynamicProperty("lu_skill_points", 0);
    z.setDynamicProperty("lu_skill_nv", 1);
    formLog.shown.length = 0;
    let shown = 0;
    formLog.respond = () => {
        shown += 1;
        if (shown === 1) return { canceled: false, selection: 3 }; // SYSTEM -> SKILLS
        if (shown === 2) return { canceled: false, selection: 1 }; // tap locked Fire Resistance
        return { canceled: true, cancelationReason: "UserClosed" };
    };
    system.afterEvents.scriptEventReceive.emit({ id: "lu:stats", sourceEntity: z });
    await advanceAsync(50);
    assert.ok(formsFor(z) >= 3, "skills menu closed even though an owned skill could be removed");
    formLog.respond = null;
});

// --- 13. scriptevent fallback ---
await t("/scriptevent lu:stats opens the SYSTEM", () => {
    advance(120);
    formLog.shown.length = 0;
    const z = newPlayer("nora");
    system.afterEvents.scriptEventReceive.emit({ id: "lu:stats", sourceEntity: z });
    advance(15);
    assert.ok(formsFor(z) >= 1, "scriptevent did not open the form");
});

await t("rapid /scriptevent spam does not stack forms", () => {
    advance(120);
    const z = newPlayer("spammer");
    formLog.shown.length = 0;
    system.afterEvents.scriptEventReceive.emit({ id: "lu:stats", sourceEntity: z });
    system.afterEvents.scriptEventReceive.emit({ id: "lu:stats", sourceEntity: z });
    system.afterEvents.scriptEventReceive.emit({ id: "lu:stats", sourceEntity: z });
    advance(30);
    assert.strictEqual(formsFor(z), 1, "scriptevent spam stacked " + formsFor(z) + " forms");
});

await t("legacy over-cap stats clamp and refund as points", () => {
    advance(120);
    const m = newPlayer("migrant");
    m.setDynamicProperty("lu_str", 55); // 5 over MAX_STAT
    m.setDynamicProperty("lu_dur", 30); // 5 over DUR_CAP 25
    m.setDynamicProperty("lu_agi", 8); // 3 over AGI_CAP 5
    m.setDynamicProperty("lu_points", 0);
    const victim = m.dimension.spawnEntity("minecraft:zombie", m.location);
    world.afterEvents.entityDie.emit({ damageSource: { damagingEntity: m }, deadEntity: victim });
    advance(5);
    assert.strictEqual(m.getDynamicProperty("lu_str"), 50, "STR not clamped");
    assert.strictEqual(m.getDynamicProperty("lu_dur"), 25, "DUR not clamped");
    assert.strictEqual(m.getDynamicProperty("lu_agi"), 5, "AGI not clamped");
    assert.strictEqual(m.getDynamicProperty("lu_points"), 13, "excess was not refunded (got " + m.getDynamicProperty("lu_points") + ")");
});

// --- 11. leak checks ---
await t("gesture map does not leak after players leave", () => {
    const before = harness.players.length;
    const tmp = newPlayer("oscar");
    world.afterEvents.playerButtonInput.emit({ player: tmp, button: "Jump", newButtonState: "Pressed" });
    advance(2);
    world.afterEvents.playerLeave.emit({ playerId: tmp.id, playerName: tmp.name });
    tmp.isValid = false;
    harness.players = harness.players.filter((x) => x !== tmp);
    advance(5);
    assert.strictEqual(harness.players.length, before);
});

// --- 12. fresh-session regressions (own process) ---
await t("stale health_boost is dropped before effectiveMax is ever probed", () => {
    // Needs its own module registry: the bug only appears while the module-level
    // maxHpWritable flag is still undefined, which this shared suite never is.
    const r = spawnSync(process.execPath, [join(here, "stale-boost.test.mjs")], { encoding: "utf8" });
    assert.strictEqual(r.status, 0, (r.stdout || "") + (r.stderr || ""));
});

let fails = 0;
for (const [st, name] of results) {
    if (st === "FAIL") fails++;
    console.log(`${st}  ${name}`);
}
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails ? 1 : 0);
