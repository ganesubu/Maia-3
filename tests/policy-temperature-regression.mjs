import assert from "node:assert/strict";
import fs from "node:fs";
import { Chess } from "../js/chess.esm.js";
import { styleForElo } from "../js/characters.js";
import { PRESET_TRAITS, traitsFor } from "../js/personality/presets.js";

const engine = fs.readFileSync("js/engine.js", "utf8");
const presets = fs.readFileSync("js/personality/presets.js", "utf8");

assert.ok(!/policy_temp/.test(presets), "per-personality policy_temp is removed");
assert.ok(!/policy_temp/.test(engine), "engine no longer reshapes Maia logits by personality policy_temp");
for (const id of Object.keys(PRESET_TRAITS)) assert.equal(Object.hasOwn(traitsFor(id), "policy_temp"), false);
for (const elo of [600, 1200, 1800, 2600]) assert.equal(Object.hasOwn(styleForElo(elo), "temperature"), false);

// The global setting is the only sampling temperature supplied at the engine call site.
const app = fs.readFileSync("js/app.js", "utf8");
assert.match(app, /temperature:\s*state\.temperature/);

console.log("policy-temperature-regression: 10/10 passed");
