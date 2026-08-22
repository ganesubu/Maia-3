
import assert from "node:assert/strict";
import fs from "node:fs";

const e = fs.readFileSync("js/engine.js", "utf8");
const w = fs.readFileSync("js/worker.js", "utf8");

assert.match(e, /this\._batchWorkers = \[\]/);
assert.match(e, /_desiredBatchPoolSize/);
assert.match(e, /_buildBatchWorkerPool/);
assert.match(e, /const workers = \[this\.primaryWorker, \.\.\.this\._batchWorkers\]/);
assert.match(e, /chunkIndex % workers\.length/);
assert.match(e, /Promise\.all\(chains\)/);
assert.match(e, /loadedModelId = modelId/);
assert.match(e, /const primaryBuffer = buffer\.slice\(0\)/);
assert.match(e, /const poolSource = buffer\.slice\(0\)/);
assert.match(w, /inferBatch/);

console.log("worker-pool-test: 9/9 passed");
