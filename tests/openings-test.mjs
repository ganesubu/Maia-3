// Opening database + director tests.
//   node tests/openings-test.mjs

import { Chess } from "../js/chess.esm.js";
import { OPENINGS, OPENING_CHOICES, OpeningDirector, pickWeightedOpening, openingById } from "../js/openings.js";

let failures = 0;
let checks = 0;
function check(name, cond, extra = "") {
  checks++;
  if (!cond) {
    failures++;
    console.log(`  FAIL  ${name} ${extra}`);
  }
}

// Deterministic RNG so a failure is reproducible.
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

console.log("=== 1. every line in the database is legal chess ===");
for (const o of OPENINGS) {
  check(`${o.name} has at least 3 continuations`, o.continuations.length >= 3, String(o.continuations.length));
  for (const cont of o.continuations) {
    const line = [o.first, ...cont];
    const board = new Chess();
    let ok = true;
    for (const san of line) {
      try {
        if (!board.move(san)) ok = false;
      } catch {
        ok = false;
      }
      if (!ok) break;
    }
    check(`${o.name}: ${line.join(" ")} is legal`, ok);
    check(`${o.name}: ${line.join(" ")} is exactly 3 plies`, line.length === 3);
  }
  // The defining property: one opening, one first move.
  check(`${o.name} continuations all follow the same first move`, typeof o.first === "string" && o.first.length > 0);
}

console.log("=== 2. opening identity: first move fixed, next two plies vary ===");
for (const o of OPENINGS) {
  const seconds = new Set(o.continuations.map((c) => c[0]));
  const thirds = new Set(o.continuations.map((c) => c[1]));
  check(`${o.name} varies at ply 2 or ply 3`, seconds.size > 1 || thirds.size > 1, `${seconds.size}/${thirds.size}`);
}

console.log("=== 3. director plays the chosen opening's first move ===");
for (const o of OPENINGS) {
  const board = new Chess();
  const d = new OpeningDirector(o.id, seeded(11));
  const san = d.moveFor(board);
  check(`${o.name} first move is ${o.first}`, san === o.first, String(san));
  check(`${o.name} first move is legal`, board.moves().includes(san));
}

console.log("=== 4. plies 2-3 vary across games, and only within the opening ===");
for (const o of OPENINGS) {
  const seen = new Set();
  for (let trial = 0; trial < 60; trial++) {
    const board = new Chess();
    const d = new OpeningDirector(o.id, seeded(trial * 7919 + 3));
    const played = [];
    for (let ply = 0; ply < 3; ply++) {
      const san = d.moveFor(board);
      if (!san) break;
      check(`${o.name} offered a legal move at ply ${ply + 1}`, board.moves().includes(san), san);
      board.move(san);
      played.push(san);
      d.observe(board);
    }
    check(`${o.name} produced 3 plies`, played.length === 3, played.join(" "));
    check(`${o.name} ply 1 is always ${o.first}`, played[0] === o.first);
    // Whatever it produced must be one of the database's own lines: this is
    // what makes the randomness opening-aware rather than blind.
    const isKnown = o.continuations.some((c) => c[0] === played[1] && c[1] === played[2]);
    check(`${o.name} played a real line of this opening (${played.join(" ")})`, isKnown);
    seen.add(played.join(" "));
  }
  const distinct = Math.min(o.continuations.length, 3);
  check(`${o.name} produced varied lines (${seen.size} distinct)`, seen.size >= Math.min(2, distinct), String(seen.size));
}

console.log("=== 5. director retires after 3 plies ===");
{
  const board = new Chess();
  const d = new OpeningDirector("sicilian", seeded(5));
  for (let i = 0; i < 3; i++) {
    const san = d.moveFor(board);
    board.move(san);
    d.observe(board);
  }
  check("director is inactive after 3 plies", !d.isActive());
  check("director offers nothing after 3 plies", d.moveFor(board) === null);
  // And it must stay retired for the rest of the game.
  board.move(board.moves()[0]);
  d.observe(board);
  check("director stays retired", d.moveFor(board) === null && !d.isActive());
}

console.log("=== 6. director stands down when the human leaves the opening ===");
{
  // Choose the Sicilian, then answer 1.e4 with 1...e5 instead of 1...c5.
  const board = new Chess();
  const d = new OpeningDirector("sicilian", seeded(9));
  board.move(d.moveFor(board)); // e4
  d.observe(board);
  board.move("e5"); // human departs from the Sicilian
  d.observe(board);
  check("director retires when the line is abandoned", !d.isActive());
  check("director forces nothing afterwards", d.moveFor(board) === null);
}

console.log("=== 7. director follows the human INSIDE the opening ===");
{
  // Open Game offers several white third moves after 1.e4 e5. Whichever the
  // human plays as Black, the director must still supply a valid ply 3.
  let supplied = 0;
  for (let trial = 0; trial < 20; trial++) {
    const board = new Chess();
    const d = new OpeningDirector("open-game", seeded(trial + 100));
    board.move(d.moveFor(board)); // e4
    d.observe(board);
    board.move("e5"); // consistent with the opening
    d.observe(board);
    const san = d.moveFor(board);
    if (san) {
      check("ply 3 is legal", board.moves().includes(san), san);
      const known = openingById("open-game").continuations.some((c) => c[0] === "e5" && c[1] === san);
      check(`ply 3 (${san}) belongs to the Open Game`, known);
      supplied++;
    }
  }
  check("director supplied ply 3 in every trial", supplied === 20, String(supplied));
}

console.log("=== 8. 'none' and 'random' ===");
{
  const d = new OpeningDirector("none", seeded(1));
  check("'none' is inactive immediately", !d.isActive());
  check("'none' never supplies a move", d.moveFor(new Chess()) === null);

  const names = new Set();
  for (let i = 0; i < 200; i++) {
    const r = new OpeningDirector("random", seeded(i * 131 + 7));
    check("random always resolves to a real opening", !!r.opening);
    names.add(r.opening.id);
    const board = new Chess();
    const san = r.moveFor(board);
    check("random opening's first move is legal", board.moves().includes(san), String(san));
  }
  check("random covers many openings", names.size >= 6, `${names.size} distinct`);

  // Weighting: the Sicilian (18) must come up far more than 1.b3 (2).
  const counts = new Map();
  const rng = seeded(4242);
  for (let i = 0; i < 4000; i++) {
    const o = pickWeightedOpening(rng);
    counts.set(o.id, (counts.get(o.id) || 0) + 1);
  }
  const sic = counts.get("sicilian") || 0;
  const nl = counts.get("nimzo-larsen") || 0;
  check("popular openings are picked more often than obscure ones", sic > nl * 2, `sicilian ${sic} vs nimzo-larsen ${nl}`);
}

console.log("=== 9. an unknown id degrades safely ===");
{
  const d = new OpeningDirector("not-a-real-opening", seeded(3));
  check("unknown opening retires instead of throwing", !d.isActive() && d.moveFor(new Chess()) === null);
}

console.log("=== 10. menu integrity ===");
check("menu offers none + random + every opening", OPENING_CHOICES.length === OPENINGS.length + 2);
check("menu ids are unique", new Set(OPENING_CHOICES.map((c) => c.id)).size === OPENING_CHOICES.length);

console.log("");
console.log(`${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILURES`);
  process.exitCode = 1;
}
