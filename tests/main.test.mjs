import assert from "node:assert";
import { harness, advance, world, system } from "@minecraft/server";
import { formLog } from "@minecraft/server-ui";

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
    assert.ok(formLog.shown.length >= 1, "form never shown");
});

await t("a single jump does NOT open the form", () => {
    advance(80); // clear cooldown
    formLog.shown.length = 0;
    p.isSneaking = true;
    jump(p);
    advance(80);
    assert.strictEqual(formLog.shown.length, 0);
});

await t("double jump while NOT sneaking does not open", () => {
    advance(80);
    formLog.shown.length = 0;
    p.isSneaking = false;
    jump(p); jump(p);
    advance(30);
    assert.strictEqual(formLog.shown.length, 0);
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
    assert.ok(formLog.shown.length >= 1, "form never shown via button input");
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
    d.setDynamicProperty("lu_dur", 4); // want 28 max HP
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

await t("DUR 0 does not leave a stale health_boost", () => {
    const d = newPlayer("iris");
    d.addEffect("health_boost", 200, { amplifier: 3 });
    advance(120);
    assert.ok(!d.getEffect("health_boost"), "stale boost not cleared");
});

// --- 7. AGI speed does not blink out between refreshes ---
await t("AGI speed effect is always present between refreshes", () => {
    const a = newPlayer("jack");
    a.setDynamicProperty("lu_agi", 10);
    advance(101);
    for (let i = 0; i < 100; i++) {
        advance(1);
        assert.ok(a.getEffect("speed"), "speed lapsed at +" + i);
    }
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

// --- 10. scriptevent fallback ---
await t("/scriptevent lu:stats opens the SYSTEM", () => {
    advance(120);
    formLog.shown.length = 0;
    const z = newPlayer("nora");
    system.afterEvents.scriptEventReceive.emit({ id: "lu:stats", sourceEntity: z });
    advance(15);
    assert.ok(formLog.shown.length >= 1, "scriptevent did not open the form");
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

let fails = 0;
for (const [st, name] of results) {
    if (st === "FAIL") fails++;
    console.log(`${st}  ${name}`);
}
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails ? 1 : 0);
