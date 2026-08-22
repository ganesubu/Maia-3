
import assert from "node:assert/strict";
import fs from "node:fs";

const model = fs.readFileSync("js/model.js","utf8");
const worker = fs.readFileSync("js/worker.js","utf8");
const androidModel = fs.readFileSync("android-build/www/js/model.js","utf8");
const androidWorker = fs.readFileSync("android-build/www/js/worker.js","utf8");

assert.match(model,/forwardBatch\(batch, selfElo, oppoElo/);
assert.match(model,/this\.forward\(tokens, selfElo, oppoElo/);
assert.match(worker,/model\.forwardBatch\(/);
assert.match(worker,/for \(const valueLogits of values\)/);
assert.match(androidModel,/forwardBatch\(batch, selfElo, oppoElo/);
assert.match(androidWorker,/model\.forwardBatch\(/);

console.log("forward-batch-stage-test: 6/6 passed");
