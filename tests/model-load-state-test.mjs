
import assert from "node:assert/strict";
import fs from "node:fs";
const e=fs.readFileSync("js/engine.js","utf8");
assert.match(e,/_loadIntoWorker\(buffer, modelId/);
assert.match(e,/await this\._loadIntoWorker\(entry\.buffer, modelId\);\s*this\.loadedModelId = modelId/);
assert.match(e,/await this\._loadIntoWorker\(buffer, modelId\);\s*this\.loadedModelId = modelId/);
console.log("model-load-state-test: 3/3 passed");
