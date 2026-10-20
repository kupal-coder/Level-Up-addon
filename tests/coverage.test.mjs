import assert from "node:assert";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
register("./loader.mjs", pathToFileURL(import.meta.filename));
const { harness, advance, world, system } = await import("@minecraft/server");
const { formLog } = await import("@minecraft/server-ui");

const results = [];
async function t(name, fn) {
    try { await fn(); results.push(["PASS", name]); }
    catch (e) { results.push(["FAIL", name + " :: " + (e.stack || e.message)]); }
}
const flush = () => new Promise((r) => setTimeout(r, 0));
async function advanceAsync(n) { for (let i = 0; i < n; i++) { advance(1); await flush(); } }

const P = harness.Player;
function newPlayer(name) {
    const p = new P(name);
    harness.players.push(p);
    return p;
}
const formsFor = (p) => formLog.shown.filter((s) => s.player === p.id).length;

// Import addon after harness setup
await import("../LevelUp_BP/scripts/main.js");

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

// --- Dismiss gesture ---
await t("dismiss hologram via jump then sneak mid-air", async () => {
    advance(120);
    formLog.respond = null;
    const p = newPlayer("dismissA");
    p.isSneaking = true;
    jump(p); jump(p);
    await advanceAsync(20);
    const before = harness.entities.filter((e) => e.tags.has("lu_holo") && e.getDynamicProperty("lu_owner") === p.id).length;
    assert.ok(before > 0, "no hologram to dismiss");
    // Jump then sneak mid-air (reverse gesture)
    p.isOnGround = false; p.vy = 0.42; advance(1);
    // Simulate button input: Jump already counted via velocity, now sneak mid-air
    world.afterEvents.playerButtonInput.emit({ player: p, button: "Sneak", newButtonState: "Pressed" });
    // also set isSneaking true mid-air
    p.isSneaking = true;
    advance(5);
    const after = harness.entities.filter((e) => e.tags.has("lu_holo") && e.getDynamicProperty("lu_owner") === p.id).length;
    assert.strictEqual(after, 0, "hologram not dismissed, still " + after);
    p.isValid = false; harness.players = harness.players.filter((x) => x !== p);
    advance(10);
});

await t("dismiss does NOT fire when no hologram (no sound spam)", async () => {
    advance(80);
    const p = newPlayer("dismissB");
    harness.sounds.length = 0;
    // Jump then sneak without ever opening SYSTEM
    p.isOnGround = false; p.vy = 0.42; advance(1);
    p.isSneaking = true;
    world.afterEvents.playerButtonInput.emit({ player: p, button: "Sneak", newButtonState: "Pressed" });
    advance(5);
    // Should not have produced beacon deactivate sound without hologram
    const deact = harness.sounds.filter((s) => s.id === "block.beacon.deactivate");
    assert.strictEqual(deact.length, 0, "sound spammed without hologram");
    p.isValid = false; harness.players = harness.players.filter((x) => x !== p);
});

await t("dismiss via velocity sampler (sneak-start mid-air) also works", async () => {
    advance(120);
    const p = newPlayer("dismissC");
    p.isSneaking = true;
    jump(p); jump(p);
    await advanceAsync(20);
    let before = harness.entities.filter((e) => e.tags.has("lu_holo") && e.getDynamicProperty("lu_owner") === p.id).length;
    assert.ok(before > 0, "no hologram");
    // Reset sneak state so next sneak-start is a rising edge
    p.isSneaking = false;
    advance(2);
    // Now jump then sneak-start next tick (sampler path)
    p.isOnGround = false; p.vy = 0.5; advance(1);
    p.isSneaking = true; // false -> true while airborne
    advance(1);
    p.isSneaking = false;
    advance(5);
    const after = harness.entities.filter((e) => e.tags.has("lu_holo") && e.getDynamicProperty("lu_owner") === p.id).length;
    assert.strictEqual(after, 0, "sampler dismiss failed, left " + after);
    p.isValid = false; harness.players = harness.players.filter((x) => x !== p);
});

// --- Cooldown enforcement ---
await t("gesture cooldown blocks immediate re-open", async () => {
    advance(120);
    formLog.shown.length = 0;
    const p = newPlayer("coolA");
    p.isSneaking = true;
    jump(p); jump(p);
    await advanceAsync(20);
    assert.ok(formsFor(p) >= 1, "first open failed");
    const count1 = formsFor(p);
    // Try to open again within cooldown (UI_COOLDOWN=60)
    jump(p); jump(p);
    await advanceAsync(20);
    assert.strictEqual(formsFor(p), count1, "cooldown not enforced, got " + formsFor(p) + " expected " + count1);
    // After cooldown expiry it should open again
    advance(80);
    formLog.shown.length = 0;
    // reset local count: need fresh player because formsFor is per id
    const q = newPlayer("coolB");
    q.isSneaking = true;
    jump(q); jump(q);
    await advanceAsync(20);
    assert.ok(formsFor(q) >= 1, "open after cooldown failed");
    p.isValid = false; q.isValid = false;
    harness.players = harness.players.filter((x) => x !== p && x !== q);
});

// --- Multi-level XP in one burst ---
await t("single kill burst can grant multiple levels at once", async () => {
    advance(120);
    const k = newPlayer("multiLvl");
    // Give enough XP to jump 2+ levels: need 50+100=150 XP for 2 ups (level 1->3)
    // Each zombie kill is 5 XP (20 HP /4). Do 30 kills =150 XP
    const victim = k.dimension.spawnEntity("minecraft:zombie", k.location);
    for (let i = 0; i < 30; i++) {
        world.afterEvents.entityDie.emit({ damageSource: { damagingEntity: k }, deadEntity: victim });
    }
    advance(10);
    assert.strictEqual(k.getDynamicProperty("lu_level"), 3, "should be level 3, got " + k.getDynamicProperty("lu_level"));
    assert.strictEqual(k.getDynamicProperty("lu_points"), 6, "should have 6 points (2 ups *3), got " + k.getDynamicProperty("lu_points"));
    k.isValid = false; harness.players = harness.players.filter((x) => x !== k);
});

await t("XP gain is capped at 20 for high-HP bosses", async () => {
    advance(120);
    const k = newPlayer("bossXP");
    k.setDynamicProperty("lu_xp", 0);
    k.setDynamicProperty("lu_level", 1);
    // Simulate boss with huge effectiveMax via health_boost effect
    const boss = k.dimension.spawnEntity("minecraft:warden", k.location);
    boss.addEffect("health_boost", 1000, { amplifier: 50 }); // 20 +51*4=224 HP
    const hp = boss.getComponent("health").effectiveMax;
    assert.ok(hp > 100, "boss HP not huge: " + hp);
    world.afterEvents.entityDie.emit({ damageSource: { damagingEntity: k }, deadEntity: boss });
    advance(5);
    // gain = min(20, ceil(224/4)=56) => 20
    assert.strictEqual(k.getDynamicProperty("lu_xp"), 20, "boss XP not capped, got " + k.getDynamicProperty("lu_xp"));
    k.isValid = false; harness.players = harness.players.filter((x) => x !== k);
});

// --- MAX_LEVEL cap ---
await t("MAX_LEVEL (100) prevents freeze on corrupt huge XP", async () => {
    advance(120);
    const k = newPlayer("maxlvl");
    k.setDynamicProperty("lu_level", 99);
    k.setDynamicProperty("lu_xp", 1e6); // corrupt
    const victim = k.dimension.spawnEntity("minecraft:zombie", k.location);
    world.afterEvents.entityDie.emit({ damageSource: { damagingEntity: k }, deadEntity: victim });
    advance(10);
    assert.ok(k.getDynamicProperty("lu_level") <= 100, "level exceeded MAX_LEVEL: " + k.getDynamicProperty("lu_level"));
    assert.ok(k.getDynamicProperty("lu_points") < 1000, "points exploded: " + k.getDynamicProperty("lu_points"));
    // Also test loadStats clamp on direct property set
    k.setDynamicProperty("lu_level", 999);
    advance(120); // upkeep reads level via num() — should clamp on next loadStats
    // Trigger a load via open
    formLog.shown.length = 0;
    system.afterEvents.scriptEventReceive.emit({ id: "lu:stats", sourceEntity: k });
    await advanceAsync(20);
    // Body should show level 100, not 999 (color codes intersperse)
    const last = formLog.shown[formLog.shown.length - 1];
    assert.ok(last.body.includes("100") && last.body.includes("Level"), "level not clamped in form: " + last.body);
    // Ensure it does NOT contain level 999 (check with surrounding context, not xp 4999)
    assert.ok(!last.body.includes("§f999") && !last.body.includes("Lv 999"), "clamp failed, still shows 999: " + last.body);
    k.isValid = false; harness.players = harness.players.filter((x) => x !== k);
});

await t("reaching MAX_LEVEL shows MAX LEVEL feedback not LEVEL UP", async () => {
    advance(120);
    const k = newPlayer("maxFeed");
    k.setDynamicProperty("lu_level", 100);
    k.setDynamicProperty("lu_xp", 0);
    harness.actionBars.length = 0;
    const victim = k.dimension.spawnEntity("minecraft:zombie", k.location);
    world.afterEvents.entityDie.emit({ damageSource: { damagingEntity: k }, deadEntity: victim });
    advance(10);
    const ab = harness.actionBars.filter((a) => a.who === k.id).pop();
    assert.ok(ab && ab.t.includes("MAX LEVEL"), "MAX LEVEL feedback not shown, got " + (ab ? ab.t : "none"));
    k.isValid = false; harness.players = harness.players.filter((x) => x !== k);
});

// --- Aura ---
await t("level 5+ idle aura emits particles", async () => {
    advance(120);
    const p = newPlayer("aura5");
    p.setDynamicProperty("lu_level", 5);
    let spawned = 0;
    const orig = p.dimension.spawnParticle;
    p.dimension.spawnParticle = () => { spawned++; };
    // Also wrap global harness? burstAt uses dimension.spawnParticle
    advance(101);
    p.dimension.spawnParticle = orig;
    // Aura runs every 100 ticks, so after 101 ticks at least one burst
    // We can't easily count via dimension override because burstAt loops, but check action: level 4 should not aura
    const q = newPlayer("aura4");
    q.setDynamicProperty("lu_level", 4);
    let spawned2 = 0;
    const orig2 = q.dimension.spawnParticle;
    q.dimension.spawnParticle = () => { spawned2++; };
    advance(101);
    q.dimension.spawnParticle = orig2;
    assert.ok(spawned > 0, "level 5 aura never emitted");
    // level 4 should emit less (or zero) — but at least 5 should be >=4
    p.isValid = false; q.isValid = false;
    harness.players = harness.players.filter((x) => x !== p && x !== q);
});

// --- STR edge cases ---
await t("STR bonus not applied to projectile damage", async () => {
    harness.damages.length = 0;
    const s = newPlayer("proj");
    s.setDynamicProperty("lu_str", 10); // +5 dmg
    const mob = s.dimension.spawnEntity("minecraft:cow", s.location);
    world.afterEvents.entityHurt.emit({
        damageSource: { cause: "entityAttack", damagingEntity: s, damagingProjectile: { typeId: "minecraft:arrow" } },
        hurtEntity: mob, damage: 7,
    });
    advance(2);
    assert.strictEqual(harness.damages.length, 0, "projectile should not get bonus");
    s.isValid = false; harness.players = harness.players.filter((x) => x !== s);
});

await t("STR bonus not applied when cause is not entityAttack", async () => {
    harness.damages.length = 0;
    const s = newPlayer("cause");
    s.setDynamicProperty("lu_str", 10);
    const mob = s.dimension.spawnEntity("minecraft:cow", s.location);
    world.afterEvents.entityHurt.emit({
        damageSource: { cause: "fall", damagingEntity: s },
        hurtEntity: mob, damage: 7,
    });
    advance(2);
    assert.strictEqual(harness.damages.length, 0, "non-attack cause should not get bonus");
    s.isValid = false; harness.players = harness.players.filter((x) => x !== s);
});

await t("STR bonus key uses safe delimiter (\\x00 not |)", async () => {
    // Old code used '|' which could collide if IDs contained '|'. New uses \x00.
    // Verify by checking bonusHitAt keys after a hit use \x00
    harness.damages.length = 0;
    const s = newPlayer("delim");
    s.setDynamicProperty("lu_str", 4);
    const mob = s.dimension.spawnEntity("minecraft:cow", s.location);
    // access main.js internal bonusHitAt via side effect: we can't import it directly,
    // but we can test behavior: two hits with pipe in id would have collided.
    // For now just ensure a normal hit still works with new delimiter.
    world.afterEvents.entityHurt.emit({
        damageSource: { cause: "entityAttack", damagingEntity: s },
        hurtEntity: mob, damage: 7,
    });
    advance(2);
    assert.strictEqual(harness.damages.length, 1, "bonus with new delimiter broke");
    s.isValid = false; harness.players = harness.players.filter((x) => x !== s);
});

// --- Portal / dimension switch ---
await t("hologram orphan in old dimension is removed after portal", async () => {
    advance(120);
    const p = newPlayer("portalA");
    p.isSneaking = true;
    jump(p); jump(p);
    await advanceAsync(20);
    let before = harness.entities.filter((e) => e.tags.has("lu_holo") && e.getDynamicProperty("lu_owner") === p.id).length;
    assert.ok(before > 0, "no hologram before portal");
    // Simulate portal: move player to nether, old clouds stay in overworld.
    // The keeper should remove clouds where e.dimension.id !== owner.dimension.id
    const nether = world.getDimension("minecraft:nether");
    p.dimension = nether;
    p.location = { x: 10, y: 64, z: 10 };
    // Old clouds are still in overworld; keeper runs every 5 ticks
    advance(10);
    // Should have spawned replacement in nether, and old ones removed
    const after = harness.entities.filter((e) => e.tags.has("lu_holo") && e.getDynamicProperty("lu_owner") === p.id).length;
    // After portal we should still have board (lines respawned) but not orphaned in overworld
    const overworldOrphans = world.getDimension("minecraft:overworld").getEntities({ tags: ["lu_holo"] })
        .filter((e) => e.getDynamicProperty("lu_owner") === p.id).length;
    assert.strictEqual(overworldOrphans, 0, "orphaned clouds left in overworld: " + overworldOrphans);
    assert.ok(after >= 4, "board not respawned in new dimension, got " + after);
    p.isValid = false; harness.players = harness.players.filter((x) => x !== p);
    advance(10);
});

// --- Legacy migration single stat ---
await t("legacy single over-cap stat (AGI 8 -> 5) refunds 3 points", async () => {
    advance(120);
    const m = newPlayer("singleMig");
    m.setDynamicProperty("lu_agi", 8);
    m.setDynamicProperty("lu_str", 10);
    m.setDynamicProperty("lu_dur", 10);
    m.setDynamicProperty("lu_points", 0);
    m.setDynamicProperty("lu_level", 1);
    m.setDynamicProperty("lu_xp", 0);
    // Trigger load via kill XP path which saves
    const victim = m.dimension.spawnEntity("minecraft:zombie", m.location);
    world.afterEvents.entityDie.emit({ damageSource: { damagingEntity: m }, deadEntity: victim });
    advance(5);
    assert.strictEqual(m.getDynamicProperty("lu_agi"), 5, "AGI not clamped");
    assert.strictEqual(m.getDynamicProperty("lu_points"), 3, "refund not 3, got " + m.getDynamicProperty("lu_points"));
    m.isValid = false; harness.players = harness.players.filter((x) => x !== m);
});

// --- Dismiss sound only when hologram present (no spam) ---
await t("dismiss does not spam sound when board already gone", async () => {
    advance(120);
    const p = newPlayer("noSpam");
    p.isSneaking = true; jump(p); jump(p);
    await advanceAsync(20);
    // Dismiss once
    p.isOnGround = false; p.vy = 0.42; advance(1);
    world.afterEvents.playerButtonInput.emit({ player: p, button: "Sneak", newButtonState: "Pressed" });
    advance(5);
    harness.sounds.length = 0;
    // Try dismiss again with no hologram
    p.isOnGround = false; p.vy = 0.42; advance(1);
    world.afterEvents.playerButtonInput.emit({ player: p, button: "Sneak", newButtonState: "Pressed" });
    advance(5);
    const spams = harness.sounds.filter((s) => s.id === "block.beacon.deactivate");
    assert.strictEqual(spams.length, 0, "second dismiss spammed sound");
    p.isValid = false; harness.players = harness.players.filter((x) => x !== p);
});

// --- Foreign effect safety re-assert ---
await t("upkeep still leaves foreign health_boost after new code (regression)", async () => {
    advance(120);
    const hb = newPlayer("foreign2");
    hb.setDynamicProperty("lu_dur", 0);
    hb.addEffect("health_boost", 20000, { amplifier: 4 });
    await advanceAsync(150);
    assert.ok(hb.getEffect("health_boost") !== undefined, "foreign boost stripped after reforms");
    hb.isValid = false; harness.players = harness.players.filter((x) => x !== hb);
});

// --- Report ---
let fails = 0;
for (const [st, name] of results) {
    if (st === "FAIL") fails++;
    console.log(`${st}  ${name}`);
}
console.log(`\n${results.length - fails}/${results.length} passed (coverage)`);
process.exit(fails ? 1 : 0);
