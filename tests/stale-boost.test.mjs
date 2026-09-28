// Regression guard for the stale-health_boost fix, plus the narrowing that stopped it
// from stealing effects granted by anyone else.
//
// This one cannot live in main.test.mjs: the original bug only showed on a *fresh*
// script session, where the module-level `maxHpWritable` probe flag is still
// `undefined`. By the time the shared suite reaches it, earlier tests have already
// flipped that flag and the old `if (maxHpWritable === false)` guard would pass
// anyway. So it runs in its own process, with its own module registry and its own mock.
import assert from "node:assert";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./loader.mjs", pathToFileURL(import.meta.filename));
const { harness, advance } = await import("@minecraft/server");
await import("../LevelUp_BP/scripts/main.js");

// --- the boost we granted is ours to clean up ---
// The addon grants a health_boost for Durability and records the amplifier it used.
// lu_dur never falls on its own, so dur === 0 means a stat reset, and that recorded
// amplifier is the only reliable proof the boost on the player is ours.
const p = new harness.Player("stale");
harness.players.push(p);
p.setDynamicProperty("lu_dur", 6); // 6 * 2 = 12 HP -> 3 steps -> amplifier 2
advance(130); // past the 100-tick upkeep loop

const granted = p.getEffect("health_boost");
assert.ok(granted !== undefined, "precondition: the addon should have granted a boost");
assert.strictEqual(granted.amplifier, 2, "unexpected amplifier granted");
assert.strictEqual(p.getDynamicProperty("lu_boost_amp"), 2, "the granted amplifier was not recorded");
assert.strictEqual(p.getComponent("health").effectiveMax, 32, "precondition: max HP should be inflated");

p.setDynamicProperty("lu_dur", 0); // stat reset
advance(130);

assert.strictEqual(p.getEffect("health_boost"), undefined, "our own boost survived a stat reset");
assert.strictEqual(p.getComponent("health").effectiveMax, 20, "phantom max HP survived the upkeep loop");
console.log("OK  the addon's own health_boost is dropped when durability is reset");

// --- and a boost we never granted is none of our business ---
// The old fix called removeEffect unconditionally, which also destroyed a health_boost
// from /effect, a datapack or a second addon. lu_dur only ever falls on an explicit
// reset, so an unrecorded boost is somebody else's.
const q = new harness.Player("foreign");
harness.players.push(q);
q.setDynamicProperty("lu_dur", 0);
q.addEffect("health_boost", 20000, { amplifier: 3 });
advance(130);
assert.ok(q.getEffect("health_boost") !== undefined, "a health_boost we never granted was stripped");
assert.strictEqual(q.getComponent("health").effectiveMax, 36, "a foreign boost's max HP was lost");
console.log("OK  a health_boost from another source is left alone");
