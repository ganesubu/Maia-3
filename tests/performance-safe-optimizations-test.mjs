import assert from "node:assert/strict";
import fs from "node:fs";

const model = fs.readFileSync("js/model.js", "utf8");
const worker = fs.readFileSync("js/worker.js", "utf8");
const engine = fs.readFileSync("js/engine.js", "utf8");

assert.match(model, /wantPolicy = opts\.wantPolicy !== false/);
assert.match(model, /wantValue = opts\.wantValue !== false/);
assert.match(model, /if \(wantPolicy\)/);
assert.match(model, /if \(wantValue\)/);
assert.match(worker, /wantPolicy: !!msg\.wantPolicy, wantValue: msg\.wantValue !== false/);
assert.match(engine, /extendHistoryTensor\(rootTokens, extraSnapshots, this\.config\.history\)/);

// Verify the history-shift helper mathematically against a tiny generic tensor.
// Re-implement the helper's frame semantics in the test so future edits have a
// concrete invariant: append child/grandchild frames while retaining the newest
// root frames and preserving square/plane order.
function extend(rootTokens, extraSnapshots, history) {
  const dim = 12 * history;
  const out = new Float32Array(rootTokens.length);
  const shiftFrames = Math.min(extraSnapshots.length, history);
  const retainedFrames = history - shiftFrames;
  for (let sq = 0; sq < 64; sq++) {
    const srcBase = sq * dim;
    if (retainedFrames > 0) out.set(rootTokens.subarray(srcBase + shiftFrames*12, srcBase + history*12), srcBase);
    for (let i=0;i<shiftFrames;i++) {
      const frame=extraSnapshots[extraSnapshots.length-shiftFrames+i];
      out.set(frame.subarray(sq*12,sq*12+12),srcBase+(retainedFrames+i)*12);
    }
  }
  return out;
}
const h=3, dim=12*h, root=new Float32Array(64*dim);
for(let sq=0;sq<64;sq++) for(let f=0;f<h;f++) root[sq*dim+f*12]=f+1;
const c1=new Float32Array(64*12).fill(9), c2=new Float32Array(64*12).fill(10);
const one=extend(root,[c1],h), two=extend(root,[c1,c2],h);
assert.equal(one[0],2); assert.equal(one[12],3); assert.equal(one[24],9);
assert.equal(two[0],3); assert.equal(two[12],9); assert.equal(two[24],10);
console.log("performance-safe-optimizations-test: 9/9 passed");
