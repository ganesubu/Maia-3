
import assert from "node:assert/strict";
import fs from "node:fs";

const model = fs.readFileSync("js/model.js", "utf8");
const engine = fs.readFileSync("js/engine.js", "utf8");
const androidModel = fs.readFileSync("android-build/www/js/model.js", "utf8");
const androidEngine = fs.readFileSync("android-build/www/js/engine.js", "utf8");

assert.match(model, /this\._tensorCache = new Map\(\)/);
assert.match(model, /for \(const \[name, tensor\] of weights\.tensors\.entries\(\)\)/);
assert.match(model, /this\._tensorCache\.get\(name\)/);
assert.doesNotMatch(model, /getTensor\(this\.w, name\)\.data/);
assert.match(engine, /_adaptiveChunkSize\(\)/);
assert.match(engine, /Math\.max\(2, Math\.min\(8/);
assert.match(engine, /const chunkSize = this\._adaptiveChunkSize\(\)/);
assert.match(androidModel, /this\._tensorCache\.get\(name\)/);
assert.match(androidEngine, /_adaptiveChunkSize\(\)/);

console.log("cpu-micro-optimization-test: 8/8 passed");
