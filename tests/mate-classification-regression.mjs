
import assert from "node:assert/strict";
import { classify } from "../js/analysis.js";

const cases = [
  [97.5, 100, false, { created: true }, "already-winning checkmate is Best"],
  [50, 100, false, { created: true }, "equal-position checkmate is Best"],
  [1, 100, false, { created: true }, "unlikely tactical checkmate is still Best"],
];

for (const [before, after, isBest, mateInfo, label] of cases) {
  assert.equal(classify(before, after, isBest, mateInfo), "best", label);
}

// Non-mate classifications retain the existing 10/20/30-point thresholds.
assert.equal(classify(50, 46), "good");
assert.equal(classify(50, 40), "inaccuracy");
assert.equal(classify(50, 30), "mistake");
assert.equal(classify(50, 20), "blunder");

// Mate-loss branch remains untouched.
assert.equal(classify(0, 100, false, { lost: true }), "inaccuracy");
assert.equal(classify(30, 100, false, { lost: true }), "inaccuracy");
assert.equal(classify(29, 100, false, { lost: true }), "inaccuracy");
assert.equal(classify(50, 100, false, { lost: true }), "inaccuracy");
assert.equal(classify(10, 50, false, { lost: true }), "blunder");

console.log("mate-classification-regression: 13/13 passed");
