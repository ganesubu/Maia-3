// Accuracy-calculation regression tests.
// Run with: node tests/accuracy-formula-regression.mjs
//
// These tests do two things:
//
// 1. Lock the win%/accuracy math to known reference values, computed by hand
//    from Lichess's own published/source-verified formulas (scalachess
//    eval.scala, lila AccuracyPercent.scala), so a future edit that
//    accidentally drifts the constants or the formula shape is caught.
// 2. Exercise the "mate lost" fix end-to-end through analyseGame(): before
//    this fix, a move that squandered a forced mate (but stayed completely
//    winning) was silently graded "good" because the win% barely moved.
//    classify() already had the correct graduated floor for this
//    (mateInfo.lost), it was just never wired up from analyseGame().

import assert from "node:assert/strict";
import { Chess } from "../js/chess.esm.js";
import {
  analyseGame,
  classify,
  summarise,
  winPctFromCp,
  moveAccuracy,
} from "../js/analysis.js";

let failures = 0;
let checks = 0;
function check(name, cond, extra = "") {
  checks++;
  if (!cond) {
    failures++;
    console.log(`  FAIL  ${name} ${extra}`);
  }
}
function near(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

// ---------------------------------------------------------------------
// 1. winPctFromCp reference values (Lichess: 100 / (1 + exp(-0.00368208*cp)),
//    cp ceiled to +-1000 -- verified against lichess-org/scalachess eval.scala)
// ---------------------------------------------------------------------
console.log("=== winPctFromCp reference values ===");
check("0cp is exactly 50%", winPctFromCp(0) === 50);
check("+1000cp ceiling", near(winPctFromCp(1000), 97.54474363414323, 1e-9));
check("-1000cp ceiling", near(winPctFromCp(-1000), 2.455256365856777, 1e-9));
check("beyond the ceiling clamps identically", winPctFromCp(100000) === winPctFromCp(1000));
check("beyond the ceiling clamps identically (losing side)", winPctFromCp(-100000) === winPctFromCp(-1000));
check("monotonically increasing", winPctFromCp(-200) < winPctFromCp(-50) && winPctFromCp(-50) < winPctFromCp(50) && winPctFromCp(50) < winPctFromCp(200));

// ---------------------------------------------------------------------
// 2. moveAccuracy reference values (Lichess: 103.1668100711649 *
//    exp(-0.04354415386753951 * winDiff) - 3.166924740191411, +1
//    "uncertainty bonus" -- verified against lila AccuracyPercent.scala)
// ---------------------------------------------------------------------
console.log("=== moveAccuracy reference values ===");
check("no win% loss is always 100 (perfect/best move)", moveAccuracy(50, 50) === 100);
check("a win% gain is always 100", moveAccuracy(40, 55) === 100);
check("a 10-point drop", near(moveAccuracy(70, 60), 64.57982845372067, 1e-6));
check("a 60-point drop (severe blunder)", near(moveAccuracy(90, 30), 5.399328234910814, 1e-6));
check("accuracy is always within [0, 100]", [1, 5, 20, 50, 80, 99].every((d) => {
  const a = moveAccuracy(80, 80 - d);
  return a >= 0 && a <= 100;
}));
check(
  "monotonic: a bigger win% drop never scores higher accuracy than a smaller one",
  [0, 5, 10, 15, 20, 30, 40, 60, 80].every((d, i, arr) => {
    if (i === 0) return true;
    return moveAccuracy(90, 90 - arr[i]) <= moveAccuracy(90, 90 - arr[i - 1]) + 1e-9;
  })
);

// ---------------------------------------------------------------------
// 3. Known-position sanity: the model must not produce absurd results.
//    Reference cp/win%/accuracy values from the worked examples on
//    https://lichess.org/page/accuracy and its own design rationale
//    ("300cp in an equal position is a blunder; 300cp in an already-won
//    position is irrelevant").
// ---------------------------------------------------------------------
console.log("=== known positions: no absurd results ===");
{
  // Equal position, +200cp -> -50cp: a real, meaningful swing.
  const before = winPctFromCp(200);
  const after = winPctFromCp(-50);
  const acc = moveAccuracy(before, after);
  check("equal-position blunder drops win% by >20 points", before - after > 20, String(before - after));
  check("equal-position blunder scores well under 50% accuracy (not 95-99%)", acc < 50, String(acc));
  check("equal-position blunder is classified at least Mistake", classify(before, after) === "mistake" || classify(before, after) === "blunder");
}
{
  // Crushingly winning, +800cp -> +550cp: same 250cp swing, irrelevant in practice.
  const before = winPctFromCp(800);
  const after = winPctFromCp(550);
  const acc = moveAccuracy(before, after);
  check("winning->still-winning 250cp swing is classified Good, not worse", classify(before, after) === "good");
  check("winning->still-winning move is not punished like a blunder (accuracy > 60%)", acc > 60, String(acc));
}
{
  // Already losing badly, -500cp -> -700cp: another loss barely matters.
  const before = winPctFromCp(-500);
  const after = winPctFromCp(-700);
  const acc = moveAccuracy(before, after);
  check("losing->more-lost is classified Good, not worse", classify(before, after) === "good");
  check("losing->more-lost move still scores a high accuracy (already-lost positions are forgiving)", acc > 60, String(acc));
}
{
  // A genuinely strong / only move must never score low.
  check("an exact best move always scores 100, whatever the position", moveAccuracy(3, 3) === 100 && moveAccuracy(97, 99) === 100);
}
{
  // Being mated: win% collapses to the losing-side ceiling.
  const before = 50;
  const after = winPctFromCp(-100000); // clamps like a real mate score
  check("walking into being mated from equal is a Blunder", classify(before, after) === "blunder");
  check("walking into being mated from equal scores very low accuracy", moveAccuracy(before, after) < 15, String(moveAccuracy(before, after)));
}

// ---------------------------------------------------------------------
// 4. classify() unit coverage: perfect, small inaccuracy, mistake, blunder.
//    (Existing thresholds -- unchanged by this patch, re-asserted here so a
//    regression in analysis.js's core thresholds fails loudly in this file
//    that specifically targets the accuracy calculation.)
// ---------------------------------------------------------------------
console.log("=== classify(): five-tier thresholds ===");
check("perfect/only move is Best", classify(50, 50, true) === "best");
check("small loss (<10) is Good", classify(50, 42) === "good");
check("10-point drop is Inaccuracy", classify(50, 40) === "inaccuracy");
check("20-point drop is Mistake", classify(50, 30) === "mistake");
check("30-point drop is Blunder", classify(50, 20) === "blunder");
check("delivering checkmate is always Best", classify(10, 0, false, { created: true }) === "best");

// ---------------------------------------------------------------------
// 5. THE FIX: analyseGame() must actually detect "mate lost" and pass it
//    through to classify(), instead of leaving that branch dead code.
// ---------------------------------------------------------------------
console.log("=== mate-lost detection (the fix under test) ===");

function mkMoves(board, cp, overrides = {}) {
  return board.moves({ verbose: true }).map((m) => {
    const uci = m.from + m.to + (m.promotion || "");
    return {
      uci,
      san: m.san,
      from: m.from,
      to: m.to,
      promotion: m.promotion || null,
      prob: 1 / Math.max(1, board.moves().length),
      cp: overrides[uci] ?? cp,
    };
  });
}

{
  // Root: White to move, "best" per the engine is e4 with a forced mate
  // found (the +100000 sentinel stockfish-engine.js reports for any "score
  // mate N" line). d4 is a legal, much weaker (non-mate) alternative.
  const root = new Chess();
  const rootFen = root.fen();

  const afterD4 = new Chess(root.fen());
  afterD4.move("d4");
  const afterD4Fen = afterD4.fen();

  const afterE4 = new Chess(root.fen());
  afterE4.move("e4");
  const afterE4Fen = afterE4.fen();

  // Scenario A: White plays d4 (not the engine's mate line). The resulting
  // position is still hugely better for White (+600) but is no longer a
  // forced mate. This is exactly "mate lost": before this fix it silently
  // graded as Good because a 97.5% -> 90.1% win% drop is under 10 points.
  {
    const stub = {
      async evaluate(board) {
        const fen = board.fen();
        if (fen === rootFen) {
          const moves = mkMoves(board, 100000, { d2d4: 100000 });
          // e4 must be first/"best": put it at cp 100000 (mate) and ensure
          // it is ranked first by placing it at the front.
          const e4 = moves.find((m) => m.uci === "e2e4");
          const rest = moves.filter((m) => m.uci !== "e2e4");
          const ordered = [e4, ...rest];
          return { positionCp: 100000, wdl: null, moves: ordered, terminal: false };
        }
        if (fen === afterD4Fen) {
          // Black to move; Black is losing badly (+600 for White) but it is
          // NOT a forced mate for Black (well under the sentinel magnitude).
          const moves = mkMoves(board, -600);
          return { positionCp: -600, wdl: null, moves, terminal: false };
        }
        return { positionCp: 0, wdl: null, moves: mkMoves(board, 0), terminal: false };
      },
    };
    const { nodes } = await analyseGame(stub, ["d4"]);
    const node = nodes.find((n) => n.ply === 1);
    check("mate-lost move is found and evaluated", !!node);
    check(
      "mate-lost move is NOT silently graded Good",
      node && node.classification !== "good" && node.classification !== "best",
      node && node.classification
    );
    check("mate-lost move is graded at least Mistake", node && (node.classification === "mistake" || node.classification === "blunder"), node && node.classification);
  }

  // Scenario B (no false positive): White again plays d4 (not the engine's
  // mate line), but the resulting position is STILL a forced mate for
  // White (Stockfish just found a different/longer mating line). This must
  // NOT trigger the "mate lost" floor.
  {
    const stub = {
      async evaluate(board) {
        const fen = board.fen();
        if (fen === rootFen) {
          const moves = mkMoves(board, 100000);
          const e4 = moves.find((m) => m.uci === "e2e4");
          const rest = moves.filter((m) => m.uci !== "e2e4");
          return { positionCp: 100000, wdl: null, moves: [e4, ...rest], terminal: false };
        }
        if (fen === afterD4Fen) {
          // Black to move, still a forced loss (mate) for Black.
          const moves = mkMoves(board, -100000);
          return { positionCp: -100000, wdl: null, moves, terminal: false };
        }
        return { positionCp: 0, wdl: null, moves: mkMoves(board, 0), terminal: false };
      },
    };
    const { nodes } = await analyseGame(stub, ["d4"]);
    const node = nodes.find((n) => n.ply === 1);
    check(
      "mate preserved (different line) is not flagged as mate-lost",
      node && node.classification === "good",
      node && node.classification
    );
    check("mate preserved shows zero win% drop", node && near(node.drop, 0, 1e-6), node && String(node.drop));
  }

  // Scenario C (isBest guard): the engine's own top choice (e4, the actual
  // mating line) must always stay Best, even in this mate-heavy setup.
  {
    const stub = {
      async evaluate(board) {
        const fen = board.fen();
        if (fen === rootFen) {
          const moves = mkMoves(board, 100000);
          const e4 = moves.find((m) => m.uci === "e2e4");
          const rest = moves.filter((m) => m.uci !== "e2e4");
          return { positionCp: 100000, wdl: null, moves: [e4, ...rest], terminal: false };
        }
        if (fen === afterE4Fen) {
          const moves = mkMoves(board, -100000);
          return { positionCp: -100000, wdl: null, moves, terminal: false };
        }
        return { positionCp: 0, wdl: null, moves: mkMoves(board, 0), terminal: false };
      },
    };
    const { nodes } = await analyseGame(stub, ["e4"]);
    const node = nodes.find((n) => n.ply === 1);
    check("the engine's own mating line is always Best", node && node.classification === "best", node && node.classification);
  }
}

// ---------------------------------------------------------------------
// 6. Checkmate delivered on the board still short-circuits to Best, even
//    with a forced-mate score already on the clock beforehand (guards
//    against the new mate-lost branch ever firing on the mating move
//    itself -- that path is a separate, mutually-exclusive `if`).
// ---------------------------------------------------------------------
console.log("=== checkmate delivered stays Best (existing behaviour, unaffected) ===");
{
  const stub = {
    async evaluate(board) {
      const moves = mkMoves(board, 100000);
      return { positionCp: 100000, wdl: null, moves, terminal: false };
    },
  };
  const { nodes } = await analyseGame(stub, ["f3", "e5", "g4", "Qh4#"]);
  const mateNode = nodes.find((n) => n.san === "Qh4#");
  check("delivering checkmate is Best", mateNode && mateNode.classification === "best", mateNode && mateNode.classification);
  check("the final position's win% is the exact terminal value", nodes[nodes.length - 1].winWhite === 0);
}

// ---------------------------------------------------------------------
// 7. Aggregation: game-level accuracy must stay within the bounds of the
//    per-move accuracies that feed it (a weighted mean and a harmonic mean
//    of a set of values are each always within [min, max] of that set, so
//    their average is too -- an absurd aggregate is structurally impossible
//    if this holds).
// ---------------------------------------------------------------------
console.log("=== aggregation (summarise / game accuracy) ===");
{
  const root = new Chess();
  const history = ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "O-O", "Nf6"];
  const b = new Chess();
  const fens = [b.fen()];
  const turns = [b.turn()];
  for (const san of history) { b.move(san); fens.push(b.fen()); turns.push(b.turn()); }

  // Values expressed in White's POV, then converted to the mover-relative
  // convention analyseGame actually expects (matching whiteCpFromRoot: cp is
  // relative to whoever is on move at that position) -- computed from each
  // fen's real side-to-move rather than hand-derived, to avoid sign errors.
  function moverRelative(whitePovValues) {
    return whitePovValues.map((v, i) => (turns[i] === "w" ? v : -v));
  }
  function makeStub(whitePovValues) {
    const cps = moverRelative(whitePovValues);
    return {
      async evaluate(board) {
        const idx = fens.indexOf(board.fen());
        const cp = idx >= 0 ? cps[idx] : 0;
        return { positionCp: cp, wdl: null, moves: mkMoves(board, cp), terminal: false };
      },
    };
  }

  // Clean game: mild, roughly-balanced fluctuation throughout (White POV).
  const cleanWhitePov = [20, 15, 25, 20, 15, 20, 15, 10, 15];
  const { nodes, summary } = await analyseGame(makeStub(cleanWhitePov), history);
  const whiteMoves = nodes.filter((n) => n.color === "w").map((n) => n.accuracy);
  const blackMoves = nodes.filter((n) => n.color === "b").map((n) => n.accuracy);
  check("white game accuracy is within the range of white's own move accuracies",
    summary.w.accuracy >= Math.min(...whiteMoves) - 1e-6 && summary.w.accuracy <= Math.max(...whiteMoves) + 1e-6,
    `${summary.w.accuracy} vs [${Math.min(...whiteMoves)}, ${Math.max(...whiteMoves)}]`);
  check("black game accuracy is within the range of black's own move accuracies",
    summary.b.accuracy >= Math.min(...blackMoves) - 1e-6 && summary.b.accuracy <= Math.max(...blackMoves) + 1e-6,
    `${summary.b.accuracy} vs [${Math.min(...blackMoves)}, ${Math.max(...blackMoves)}]`);
  check("game accuracy is bounded [0,100]", summary.w.accuracy >= 0 && summary.w.accuracy <= 100 && summary.b.accuracy >= 0 && summary.b.accuracy <= 100);

  // Same game, but Black's last move (Nf6, ply 8) hangs badly: White POV
  // jumps from +15 to +260 right on that move -- a real, sustained blunder,
  // not a shifting/transient one (the position stays bad afterwards).
  const blunderWhitePov = [20, 15, 25, 20, 15, 20, 15, 15, 600];
  const { nodes: nodes2, summary: summary2 } = await analyseGame(makeStub(blunderWhitePov), history);
  const blunderNode = nodes2.find((n) => n.san === "Nf6");
  check("the blunder move itself is classified Blunder", blunderNode && blunderNode.classification === "blunder", blunderNode && blunderNode.classification);
  check("a real, sustained blunder measurably lowers game accuracy below a clean game's",
    summary2.b.accuracy < summary.b.accuracy - 5,
    `${summary2.b.accuracy} vs ${summary.b.accuracy}`);
  check("the blunder does not affect White's own reported accuracy",
    near(summary2.w.accuracy, summary.w.accuracy, 0.5),
    `${summary2.w.accuracy} vs ${summary.w.accuracy}`);
}

// ---------------------------------------------------------------------
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
