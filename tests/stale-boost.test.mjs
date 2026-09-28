// Regression guard for the stale-health_boost fix. This one cannot live in
// main.test.mjs: the bug only shows on a *fresh* script session, where the
// module-level `maxHpWritable` probe flag is still `undefined`. By the time the
// shared suite reaches it, earlier tests have already flipped that flag to
// `false` and the buggy `if (maxHpWritable === false)` guard would pass anyway.
// So it runs in its own process, with its own module registry and its own mock.
import assert from "node:assert";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./loader.mjs", pathToFileURL(import.meta.filename));
const { harness, advance } = await import("@minecraft/server");
await import("../LevelUp_BP/scripts/main.js");

// The only player has 0 durability but is still carrying a health_boost left
// over from a previous build / stat reset. Nothing in this session has ever
// probed `effectiveMax`, so `maxHpWritable` is still undefined.
const p = new harness.Player("stale");
harness.players.push(p);
p.addEffect("health_boost", 200, { amplifier: 3 }); // a phantom +16 max HP
const maxBefore = p.getComponent("health").effectiveMax;

advance(130); // past the 100-tick upkeep loop

assert.ok(maxBefore > 20, "precondition: the stale boost should inflate max HP");
assert.strictEqual(p.getComponent("health").effectiveMax, 20,
    "phantom max HP survived the upkeep loop");
assert.strictEqual(p.getEffect("health_boost"), undefined, "stale boost never cleared");
console.log("OK  stale health_boost is dropped on a fresh session with no durability");
