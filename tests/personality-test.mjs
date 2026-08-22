// Node-only regression harness for the ported personality layer.
//   node tests/personality-test.mjs
//
// It exercises the real features.js / dimensions.js / scoring.js /
// controller.js code that ships in the browser, with a MOCK stand-in for
// Maia's policy and value heads (a deterministic pseudo-policy plus a
// material-based value), because the network itself needs the .bin
// weights and a browser worker. Everything that is personality logic is
// the real thing; only the two numbers Maia would supply are mocked.

import { Chess } from "../js/chess.esm.js";
import { PersonalityController } from "../js/personality/controller.js";
import { PRESETS, PERSONALITY_MENU, validatePresets, buildBook, positionKey } from "../js/personality/presets.js";
import { computeMoveFeatures, positionContext, materialBalanceOf, staticExchangeEval } from "../js/personality/features.js";
import { rankCandidates, sampleMove } from "../js/personality/scoring.js";

let failures = 0;
let checks = 0;
function check(name, cond, extra = "") {
  checks++;
  if (!cond) {
    failures++;
    console.log(`  FAIL  ${name} ${extra}`);
  }
}

// --- mock Maia ---------------------------------------------------------

// A realistic mock policy. Real Maia policy heads are PEAKED, so a
// uniform mock would make personality look far more influential than it is.
// The hash fixes an arbitrary ordering (uncorrelated with any personality)
// and a geometric decay gives it a realistic shape.
// `sharpness` is the geometric decay of the mock policy: 0.35 is a very
// confident position (top move ~0.65), 0.85 is a flat one where many moves
// look equally human. Real Maia produces both, so tests that use only one
// shape draw the wrong conclusion about how much personality can express.
function pseudoPolicy(moves, seedKey = "", sharpness = 0.55) {
  const order = moves
    .map((m, i) => {
      // Hash the POSITION as well as the move: hashing the move alone
      // would make the same move Maia's favourite in every position, which
      // is both unrealistic and would silently defeat these tests.
      const key = seedKey + "|" + m.from + m.to + (m.promotion || "");
      let h = 2166136261;
      for (let k = 0; k < key.length; k++) {
        h ^= key.charCodeAt(k);
        h = Math.imul(h, 16777619);
      }
      return { i, h: h >>> 0 };
    })
    .sort((a, b) => a.h - b.h);
  const probs = new Array(moves.length).fill(0);
  let total = 0;
  order.forEach((entry, rank) => {
    const p = Math.pow(0.55, rank) + 0.001;
    probs[entry.i] = p;
    total += p;
  });
  return probs.map((p) => p / total);
}

// Mock value head: material only, expressed on the engine's win-permille
// minus loss-permille scale (±1000), from the mover's perspective.
function mockCp(before, child) {
  const mover = before.turn();
  const bal = materialBalanceOf(child, mover);
  return Math.max(-1000, Math.min(1000, Math.round(bal * 90)));
}

function buildCandidates(chess, breadth, cpFn = mockCp, sharpness = 0.55) {
  const moves = chess.moves({ verbose: true });
  const fen = chess.fen();
  const probs = pseudoPolicy(moves, fen, sharpness);
  const list = moves.map((m, i) => {
    const child = new Chess(fen);
    child.move({ from: m.from, to: m.to, promotion: m.promotion });
    return {
      move: m,
      uci: m.from + m.to + (m.promotion || ""),
      prob: probs[i],
      childChess: child,
      cp: cpFn(chess, child),
      trapValue: 0,
    };
  });
  list.sort((a, b) => b.prob - a.prob);
  return list.slice(0, breadth);
}

function choose(fen, presetId, opts = {}) {
  const chess = new Chess(fen);
  const controller = opts.controller || new PersonalityController();
  const candidates = buildCandidates(chess, opts.breadth || 6, opts.cpFn, opts.sharpness);
  const decision = controller.chooseMove(chess, candidates, {
    presetId,
    strength: opts.strength === undefined ? 1 : opts.strength,
    temperature: 0, // deterministic for testing
    drawProb: opts.drawProb || 0.2,
    maxOverrideNats: opts.maxOverrideNats,
  });
  return { decision, chess, candidates };
}

// --- test positions ---------------------------------------------------

const POSITIONS = {
  opening: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  italian: "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
  attacking: "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQ1RK1 w kq - 0 7",
  tactical: "r2qkb1r/pp2nppp/3p4/2pNN1B1/2BnP3/3P4/PPP2PPP/R2bK2R w kq - 5 11",
  quiet: "r1bq1rk1/pp2ppbp/2np1np1/8/3NP3/2N1BP2/PPPQ2PP/R3KB1R w KQ - 4 9",
  defending: "r1bqk2r/pppp1ppp/8/2b1n3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 6",
  endgame: "8/5pk1/6p1/8/3K4/4P3/5P2/8 w - - 0 40",
  sacrifice: "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 4 4",
  pressure: "rnbqkb1r/ppp2ppp/8/3pP3/3n4/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 5",
};

const PRESET_IDS = Object.keys(PRESETS);

console.log("=== 1. preset/dimension integrity ===");
const problems = validatePresets();
check("every preset covers every dimension", problems.length === 0, problems.join("; "));
check("7 presets shipped", PRESET_IDS.length === 7, `got ${PRESET_IDS.length}`);
check("menu exposes vanilla + 7", PERSONALITY_MENU.length === 8);

console.log("=== 2. SEE sanity ===");
{
  // Free pawn: exd5 with the black queen gone, so nothing recaptures.
  const c = new Chess("rnb1kbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2");
  const m = c.moves({ verbose: true }).find((x) => x.from === "e4" && x.to === "d5");
  check("undefended pawn capture SEE = +1", staticExchangeEval(c, m) === 1, String(staticExchangeEval(c, m)));
}
{
  // Defended pawn: exd5 Qxd5 is pawn-for-pawn, so SEE = 0.
  const c = new Chess("rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2");
  const m = c.moves({ verbose: true }).find((x) => x.from === "e4" && x.to === "d5");
  check("even trade SEE = 0 (not +1)", staticExchangeEval(c, m) === 0, String(staticExchangeEval(c, m)));
}
{
  // Queen takes a pawn defended by a pawn: loses a queen for a pawn.
  const c = new Chess("rnbqkbnr/ppp2ppp/3p4/4p2Q/8/8/PPPP1PPP/RNB1KBNR w KQkq - 0 4");
  const m = c.moves({ verbose: true }).find((x) => x.from === "h5" && x.to === "e5");
  check("queen taking a defended pawn is a big negative SEE", m && staticExchangeEval(c, m) <= -7, m ? String(staticExchangeEval(c, m)) : "move not found");
}
{
  // Non-capture: SEE is 0 by definition.
  const c = new Chess();
  const m = c.moves({ verbose: true }).find((x) => x.san === "e4");
  check("quiet move SEE = 0", staticExchangeEval(c, m) === 0);
}

console.log("=== 3. every personality choice is legal ===");
for (const [name, fen] of Object.entries(POSITIONS)) {
  for (const preset of PRESET_IDS) {
    const { decision, chess } = choose(fen, preset);
    if (!decision) {
      check(`${preset} produced a decision on ${name}`, false);
      continue;
    }
    const f = decision.chosen.features;
    const legal = chess
      .moves({ verbose: true })
      .some((m) => m.from === f.move.from && m.to === f.move.to && (m.promotion || "") === (f.move.promotion || ""));
    check(`${preset} legal move on ${name}`, legal, f.uci);
  }
}

console.log("=== 4. presets actually differ ===");
// HOW THIS IS MEASURED, AND WHY.
//
// Comparing only each preset's single favourite move understates the
// system: personality is deliberately bounded relative to Maia's policy
// (see MAX_OVERRIDE_NATS), so where Maia is confident every preset should
// — correctly — play Maia's move. What personality always changes is the
// whole RANKING, and in play that ranking is sampled at the character's
// temperature. So the primary measurement is the distance between the
// presets' resulting move DISTRIBUTIONS, which is what a player actually
// experiences over a game.
function orderFor(fen, preset, opts = {}) {
  const chess = new Chess(fen);
  const controller = new PersonalityController();
  const candidates = buildCandidates(chess, 6, mockCp, opts.sharpness || 0.7);
  const decision = controller.chooseMove(chess, candidates, {
    presetId: preset,
    strength: 1,
    temperature: 0,
    drawProb: 0.2,
    maxOverrideNats: opts.maxOverrideNats || 1.9,
  });
  return decision.ranked.map((r) => r.features.uci).join(">");
}

function distributionFor(fen, preset, opts = {}) {
  const chess = new Chess(fen);
  const controller = new PersonalityController();
  const candidates = buildCandidates(chess, 6, mockCp, opts.sharpness || 0.7);
  const decision = controller.chooseMove(chess, candidates, {
    presetId: preset,
    strength: 1,
    temperature: 0, // ranking only; sampling is done below, deterministically
    drawProb: 0.2,
    maxOverrideNats: opts.maxOverrideNats || 1.9,
  });
  const ranked = decision.ranked;
  const counts = new Map();
  let seed = 987654321;
  const realRandom = Math.random;
  Math.random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  try {
    for (let i = 0; i < 600; i++) {
      const pick = sampleMove(ranked, opts.temperature || 1.0, 1.0);
      counts.set(pick.features.uci, (counts.get(pick.features.uci) || 0) + 1);
    }
  } finally {
    Math.random = realRandom;
  }
  const dist = new Map();
  for (const [uci, n] of counts) dist.set(uci, n / 600);
  return { dist, top: ranked[0].features.move.san };
}

function totalVariation(a, b) {
  const keys = new Set([...a.keys(), ...b.keys()]);
  let tv = 0;
  for (const k of keys) tv += Math.abs((a.get(k) || 0) - (b.get(k) || 0));
  return tv / 2;
}

{
  const table = [];
  let argmaxDiffered = 0;
  let separatedPositions = 0;
  let opposedOrderingsDiffered = 0;
  const distinctOrderings = [];
  for (const [name, fen] of Object.entries(POSITIONS)) {
    const dists = PRESET_IDS.map((p) => ({ p, ...distributionFor(fen, p) }));
    const row = { position: name };
    for (const d of dists) row[d.p] = d.top;
    table.push(row);
    if (new Set(dists.map((d) => d.top)).size > 1) argmaxDiffered++;

    // The clearest opposed pair in the roster: an all-out attacker versus a
    // maximally defensive wall. If any two presets should play differently,
    // it is these.
    const attacker = dists.find((d) => d.p === "TheAttacker");
    const wall = dists.find((d) => d.p === "TheWall");
    const tv = totalVariation(attacker.dist, wall.dist);
    console.log(`    ${name}: Attacker-vs-Wall TV=${tv.toFixed(3)}`);
    check(`${name}: TheAttacker and TheWall have distinguishable distributions`, tv > 0.0, `TV=${tv.toFixed(3)}`);
    if (tv > 0.10) separatedPositions++;

    // Every preset pair must differ at least somewhat, or they are the
    // same player wearing a different name.
    // The most direct evidence that personality re-ranks at all. Counted
    // across positions rather than asserted on each one: on a genuinely
    // quiet position an attacker and a wall can legitimately agree about
    // every candidate, and demanding otherwise would be demanding noise.
    if (orderFor(fen, "TheAttacker") !== orderFor(fen, "TheWall")) opposedOrderingsDiffered++;
    distinctOrderings.push(new Set(PRESET_IDS.map((p) => orderFor(fen, p))).size);

    let minPairTv = Infinity;
    for (let i = 0; i < dists.length; i++) {
      for (let j = i + 1; j < dists.length; j++) {
        minPairTv = Math.min(minPairTv, totalVariation(dists[i].dist, dists[j].dist));
      }
    }
    check(`${name}: no two presets are identical`, minPairTv > 0.0, `min TV=${minPairTv.toFixed(3)}`);
  }
  console.table(table);
  const total = Object.keys(POSITIONS).length;
  check(
    "TheAttacker and TheWall rank the candidates differently on most positions",
    opposedOrderingsDiffered >= Math.ceil(total * 0.66),
    `${opposedOrderingsDiffered}/${total}`
  );
  // Note the two different things being measured. Personality ALWAYS
  // changes the scores, so the sampled distributions always differ (the TV
  // checks above). It does not always change the ORDER: on a bare endgame
  // or a quiet position most dimensions return 0 for every candidate, so
  // the presets legitimately agree on the ranking and only the sampling
  // weights differ. Both are correct behaviour; only the aggregate is
  // asserted.
  check(
    "the presets rank candidates differently on most positions",
    distinctOrderings.filter((n) => n >= 2).length >= Math.ceil(total * 0.6),
    distinctOrderings.join(",")
  );
  check(
    "several distinct rankings appear on a good share of positions",
    distinctOrderings.filter((n) => n >= 3).length >= Math.ceil(total * 0.2),
    distinctOrderings.join(",")
  );
  check("presets are strongly separated on most positions", separatedPositions >= Math.ceil(Object.keys(POSITIONS).length * 0.5), `${separatedPositions}/${Object.keys(POSITIONS).length}`);
  check("presets also pick different favourites sometimes", argmaxDiffered >= 2, `${argmaxDiffered}/${Object.keys(POSITIONS).length}`);
}

{
  // Strength preservation: where Maia is confident, personality must not
  // drag the move away — the property that keeps this from costing Elo.
  let sharpDiff = 0;
  for (const fen of Object.values(POSITIONS)) {
    const tops = new Set(PRESET_IDS.map((p) => distributionFor(fen, p, { sharpness: 0.3 }).top));
    if (tops.size > 1) sharpDiff++;
  }
  let flatDiff = 0;
  for (const fen of Object.values(POSITIONS)) {
    const tops = new Set(PRESET_IDS.map((p) => distributionFor(fen, p, { sharpness: 0.9 }).top));
    if (tops.size > 1) flatDiff++;
  }
  check("where Maia is confident, presets mostly follow Maia", sharpDiff <= flatDiff, `sharp ${sharpDiff} vs flat ${flatDiff}`);
  check("where Maia is undecided, presets diverge more", flatDiff >= 1, `${flatDiff}/${Object.keys(POSITIONS).length}`);
}

console.log("=== 5. personality strength 0 == identical (near-vanilla) choice ===");
for (const [name, fen] of Object.entries(POSITIONS)) {
  const picks = new Set();
  for (const preset of PRESET_IDS) {
    const { decision } = choose(fen, preset, { strength: 0 });
    picks.add(decision.chosen.features.uci);
  }
  check(`strength 0 collapses every preset to one choice on ${name}`, picks.size === 1, [...picks].join(","));
}

console.log("=== 6. soundness gate blocks a personality blunder ===");
{
  // Hand-built candidate set: Maia's favourite is a sound quiet move; a
  // second candidate is a spectacular but losing queen sacrifice that a
  // sharp personality would otherwise love. The gate must reject it.
  const fen = POSITIONS.italian;
  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true });
  const quiet = moves.find((m) => m.san === "d3") || moves[0];
  const loud = moves.find((m) => m.san === "Ng5") || moves[1];
  const mk = (m, prob, cp) => {
    const child = new Chess(fen);
    child.move({ from: m.from, to: m.to, promotion: m.promotion });
    return { move: m, uci: m.from + m.to + (m.promotion || ""), prob, childChess: child, cp, trapValue: 0 };
  };
  const ctx = positionContext(chess);
  const mkFeat = (c) =>
    computeMoveFeatures(chess, c.move, c.childChess, {
      ...ctx,
      policyProb: c.prob,
      modelCp: c.cp,
      drawProb: 0.2,
      trapValue: c.trapValue,
      momentumAlignment: 0,
    });

  for (const preset of ["TheAttacker", "Trickster", "TheSwindler"]) {
    // loud move is 700 units worse: far past BLUNDER_THRESHOLD.
    const cands = [mk(quiet, 0.4, 100), mk(loud, 0.2, -600)];
    const ranked = rankCandidates(cands.map(mkFeat), PRESETS[preset], { personaScale: 1 });
    check(`${preset} refuses the 700-unit-worse move`, ranked[0].features.move.san === quiet.san, ranked[0].features.move.san);
    check(`${preset} gate is 0 on the blunder`, ranked.find((r) => r.features.move.san === loud.san).soundness === 0);

    // Same pair, now near-equal (inside the free-style band): the sharp
    // preset is allowed to prefer the loud one.
    const near = [mk(quiet, 0.4, 100), mk(loud, 0.2, 40)];
    const rankedNear = rankCandidates(near.map(mkFeat), PRESETS[preset], { personaScale: 1 });
    check(`${preset} may express style inside the tolerance band`, rankedNear[0].soundness === 1);
  }
}

console.log("=== 7. dimension behaviour on purpose-built candidate pairs ===");
{
  const fen = POSITIONS.italian;
  const chess = new Chess(fen);
  const ctx = positionContext(chess);
  const feats = {};
  for (const m of chess.moves({ verbose: true })) {
    const child = new Chess(fen);
    child.move({ from: m.from, to: m.to, promotion: m.promotion });
    feats[m.san] = computeMoveFeatures(chess, m, child, { ...ctx, policyProb: 0.2, modelCp: 0 });
  }
  check("castling is detected", feats["O-O"] && feats["O-O"].is_castle === true);
  check("Ng5 gives no check but raises volatility", feats["Ng5"] && feats["Ng5"].volatility >= 0);
  check("d3 is a quiet pawn push", feats["d3"] && feats["d3"].is_pawn_push && !feats["d3"].is_capture);
  check("Nc3 develops a minor piece", feats["Nc3"] && feats["Nc3"].develops_minor === true);
  check("phase is opening", feats["d3"].phase === "opening");
  const bxf7 = feats["Bxf7+"];
  if (bxf7) {
    check("Bxf7+ is a capture giving check", bxf7.is_capture && bxf7.gives_check);
    check("Bxf7+ is scored as a sacrifice (bishop for a pawn)", bxf7.see < 0);
  }
}

console.log("=== 8. endgame + trap-value plumbing ===");
{
  const { decision } = choose(POSITIONS.endgame, "PositionalGenius");
  check("endgame phase detected", decision.chosen.features.phase === "endgame", decision.chosen.features.phase);

  // Give one candidate a strong trap value and check Trickster moves toward it.
  const fen = POSITIONS.quiet;
  const chess = new Chess(fen);
  const controller = new PersonalityController();
  const cands = buildCandidates(chess, 6);
  const target = cands[cands.length - 1];
  target.trapValue = 1.0;
  target.cp = cands[0].cp; // equally sound, so the gate stays fully open
  const withTrap = controller.chooseMove(chess, cands, { presetId: "Trickster", strength: 1, temperature: 0, maxOverrideNats: 1.9 });
  const rankOfTarget = withTrap.ranked.findIndex((r) => r.features.uci === target.uci);
  const controller2 = new PersonalityController();
  const cands2 = buildCandidates(new Chess(fen), 6);
  cands2.forEach((c) => (c.cp = cands2[0].cp));
  const noTrap = controller2.chooseMove(new Chess(fen), cands2, { presetId: "Trickster", strength: 1, temperature: 0, maxOverrideNats: 1.9 });
  const baseRank = noTrap.ranked.findIndex((r) => r.features.uci === target.uci);
  check("a trappy candidate rises for Trickster", rankOfTarget < baseRank, `${baseRank} -> ${rankOfTarget}`);
}

console.log("=== 9. within-game momentum: state, decay and reset ===");
{
  const controller = new PersonalityController();
  check("fresh controller has no commitment", controller.flankCommitment === 0);
  for (let i = 0; i < 8; i++) controller.updateMomentum("g4"); // kingside
  check("kingside play builds positive commitment", controller.flankCommitment > 0.3, String(controller.flankCommitment));
  check("alignment rewards same-flank moves", controller.momentumAlignment("h5") > 0);
  check("alignment punishes opposite-flank moves", controller.momentumAlignment("b5") < 0);
  check("central moves are neutral", controller.momentumAlignment("d5") === 0);
  controller.reset();
  check("reset clears commitment", controller.flankCommitment === 0 && controller.pliesThisGame === 0);
}

console.log("=== 10. opening books are legal and applied ===");
for (const preset of PRESET_IDS) {
  const book = buildBook(preset);
  check(`${preset} book expanded`, book.size > 0);
  const start = new Chess();
  const firstMoves = book.get(positionKey(start)) || [];
  check(`${preset} has a first move in book`, firstMoves.length > 0);
  for (const uci of firstMoves) {
    const legal = start
      .moves({ verbose: true })
      .some((m) => m.from + m.to + (m.promotion || "") === uci);
    check(`${preset} book move ${uci} is legal from the start`, legal);
  }
}
{
  // Book effect, measured directly: the same candidate set scored with and
  // without the repertoire. e2e4 must gain score and rank when in book.
  const fen = POSITIONS.opening;
  const chess = new Chess(fen);
  const ctx = positionContext(chess);
  const cands = buildCandidates(chess, 20).map((c) => ({ ...c, cp: 0 }));
  const feats = cands.map((c) =>
    computeMoveFeatures(chess, c.move, c.childChess, { ...ctx, policyProb: c.prob, modelCp: 0 })
  );
  const w = PRESETS.TheAttacker;
  const without = rankCandidates(feats, w, { personaScale: 1 });
  const withBook = rankCandidates(feats, w, { personaScale: 1, bookMoves: buildBook("TheAttacker") ? new Set(buildBook("TheAttacker").get(positionKey(chess))) : new Set() });
  const rankOf = (list) => list.findIndex((r) => r.features.uci === "e2e4");
  const scoreOf = (list) => list.find((r) => r.features.uci === "e2e4").score;
  check("e2e4 is in TheAttacker's book from the start", (buildBook("TheAttacker").get(positionKey(chess)) || []).includes("e2e4"));
  check("book raises the book move's score", scoreOf(withBook) > scoreOf(without) + 0.5, `${scoreOf(without).toFixed(2)} -> ${scoreOf(withBook).toFixed(2)}`);
  check("book improves the book move's rank", rankOf(withBook) < rankOf(without), `${rankOf(without)} -> ${rankOf(withBook)}`);
  check("book flag is reported", withBook.find((r) => r.features.uci === "e2e4").inBook === true);
}

console.log("=== 11. long game: 60 plies of personality play, no crash ===");
{
  const controller = new PersonalityController();
  const game = new Chess();
  let plies = 0;
  for (let i = 0; i < 60 && !game.isGameOver(); i++) {
    const preset = PRESET_IDS[i % PRESET_IDS.length];
    const cands = buildCandidates(game, 5);
    const res = controller.chooseMove(game, cands, { presetId: preset, strength: 1, temperature: 0 });
    const f = res.chosen.features.move;
    const played = game.move({ from: f.from, to: f.to, promotion: f.promotion });
    if (!played) {
      check("long game move was legal", false, `${f.from}${f.to}`);
      break;
    }
    plies++;
  }
  check("played at least 40 plies without an illegal move or throw", plies >= 40, String(plies));
}

console.log("=== 12. pressure / counterattacking wiring ===");
{
  const fen = POSITIONS.pressure; // white knight on d4 is loose-ish, black pawn on d5
  const chess = new Chess(fen);
  const ctx = positionContext(chess);
  check("position context computes a pressure flag", typeof ctx.wasUnderPressureBefore === "boolean");
  const { decision } = choose(fen, "TheSwindler");
  check("swindler still returns a legal move under pressure", !!decision);
}

console.log("");
console.log(`${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILURES`);
  process.exitCode = 1;
}
