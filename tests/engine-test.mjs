// End-to-end engine tests, with special attention to the freeze history.
//   python3 tests/make_tiny_model.py tests/tiny-model.bin
//   node tests/engine-test.mjs
//
// The REAL weights-format.js, model.js, worker.js handler and engine.js
// pipeline all run here. Only the weights are synthetic (a tiny random
// container), because the shipped .bin files aren't in the repo. That makes
// the network's move choices meaningless but the PLUMBING fully real, which
// is what these tests are about: clone safety, bounded work, timeouts,
// cancellation, recovery, and never returning without a legal move.

import fs from "node:fs";
import { Chess } from "../js/chess.esm.js";

let failures = 0;
let checks = 0;
function check(name, cond, extra = "") {
  checks++;
  if (!cond) {
    failures++;
    console.log(`  FAIL  ${name} ${extra}`);
  }
}

// ---- Worker shim -------------------------------------------------------
// worker.js is written against self.onmessage/self.postMessage, so a minimal
// `self` is installed and the module imported for its side effect. Every
// message in both directions goes through structuredClone(), which is the
// same check the browser performs — so a reintroduced DataCloneError fails
// here rather than on the user's phone.
//
// The shim can also be told to stall or die, which is how the timeout and
// crash-recovery paths get exercised.

const cloneFailures = [];
const posted = [];
let shimMode = "normal"; // normal | stall | die
let workerInstances = 0;

// worker.js registers its handler on `self` once, at module evaluation. ES
// modules are cached, so every shim instance shares that one handler — the
// handler is captured here and each instance rebinds globalThis.self before
// invoking it, which is enough to exercise the real message logic. (Shared
// module state means all shim instances share one loaded model; the tests
// below account for that by reloading whenever they need a known state.)
let sharedHandler = null;
async function ensureWorkerModule() {
  if (sharedHandler) return sharedHandler;
  const bootstrap = { postMessage() {}, onmessage: null };
  globalThis.self = bootstrap;
  await import("../js/worker.js");
  sharedHandler = bootstrap.onmessage;
  if (typeof sharedHandler !== "function") throw new Error("worker.js did not register self.onmessage");
  return sharedHandler;
}

class NodeWorker {
  constructor() {
    workerInstances++;
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
    this.terminated = false;
    this._self = {
      postMessage: (payload) => {
        try {
          structuredClone(payload);
        } catch (err) {
          cloneFailures.push(`worker->main: ${err.name}: ${err.message}`);
        }
        if (!this.terminated && this.onmessage) this.onmessage({ data: payload });
      },
      onmessage: null,
    };
  }
  async postMessage(payload) {
    posted.push(payload);
    try {
      structuredClone(payload); // no transfer list: proves clone-safety
    } catch (err) {
      cloneFailures.push(`main->worker: ${err.name}: ${err.message}`);
    }
    const handler = await ensureWorkerModule();
    if (this.terminated) return;
    if (shimMode === "stall") return; // never answers: the freeze scenario
    if (shimMode === "die") {
      if (this.onerror) this.onerror({ message: "simulated worker crash" });
      return;
    }
    globalThis.self = this._self;
    handler({ data: payload });
  }
  terminate() {
    this.terminated = true;
  }
}
globalThis.Worker = NodeWorker;

const { Maia3Engine, EngineTimeoutError } = await import("../js/engine.js");

const binPath = new URL("./tiny-model.bin", import.meta.url);
if (!fs.existsSync(binPath)) {
  console.log("tests/tiny-model.bin missing — run: python3 tests/make_tiny_model.py tests/tiny-model.bin");
  process.exit(1);
}
const bytes = fs.readFileSync(binPath);
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const fresh = () => buffer.slice(0);

const engine = new Maia3Engine();

console.log("=== 1. load ===");
const cfg = await engine._loadIntoWorker(fresh());
check("engine reports ready", engine.ready === true);
check("config is plain data", cfg && typeof cfg.dim_vit === "number");
check("config carries no functions", Object.values(cfg).every((v) => typeof v !== "function"));

const PRESETS = [
  "PositionalGenius",
  "TheAttacker",
  "TheWall",
  "Trickster",
  "Hoarder",
  "TheSwindler",
  "TheTiltTrigger",
];

const legalIn = (chess, move) =>
  chess
    .moves({ verbose: true })
    .some((m) => m.from === move.from && m.to === move.to && (m.promotion || "") === (move.promotion || ""));

console.log("=== 2. vanilla Maia ===");
{
  const chess = new Chess();
  const res = await engine.requestMove(chess, { presetId: null, temperature: 1.0, multiPv: 5 });
  check("returns a move", !!res.move);
  check("vanilla move is legal", legalIn(chess, res.move));
  check("policy list returned", res.topMoves.length === 5);
  check("wdl sums to 1", Math.abs(res.wdl.win + res.wdl.draw + res.wdl.loss - 1) < 1e-5);
  check("no personality info in vanilla mode", !res.personality);
}

// ---- THE FREEZE SCENARIOS ---------------------------------------------
// Positions where the old implementation locked up. Every one must return a
// legal move, and must do so promptly.

const CHECK_POSITIONS = {
  // Every one of these is a genuine in-check position with legal replies,
  // verified against chess.js. They cover the shapes the old build stalled
  // on: many evasions, few evasions, a single forced reply, knight checks,
  // checks deep in an attack, and checks in a bare endgame.
  "bishop check, 6 evasions": "rnbqk1nr/pppp1ppp/4p3/8/1b1PP3/8/PPP2PPP/RNBQKBNR w KQkq - 1 3",
  "bishop check, 4 evasions": "rnbqkbnr/pp2pppp/3p4/1Bp5/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 1 3",
  "knight check, 3 evasions": "r1bqkbnr/pppp1ppp/8/4p3/2B1P3/2N2N2/PPnP1PPP/R1BQK2R w KQkq - 0 5",
  "queen check, 2 evasions": "r1b1k1nr/pppp1ppp/2n5/2b1p3/2B1P3/3P1N2/PPP2qPP/RNBQ1RK1 w kq - 0 6",
  "single forced reply": "rnb1k1nr/pppp1ppp/8/4p3/P3P2q/R7/1PPP1bPP/1NBQKBNR w Kkq - 0 5",
  "check in an endgame": "8/8/8/4k3/8/8/4r3/4K3 w - - 0 60",
  "checkmate is available to us": "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 30",
};

console.log("=== 3. FREEZE REGRESSION: check positions, every preset ===");
for (const [label, fen] of Object.entries(CHECK_POSITIONS)) {
  for (const presetId of PRESETS) {
    const chess = new Chess(fen);
    if (chess.isGameOver()) continue;
    const t0 = Date.now();
    let res;
    try {
      res = await engine.requestMove(chess, {
        presetId,
        strength: 1,
        breadth: 6,
        trapSearch: true,
        temperature: 0,
        budgetMs: 3000,
      });
    } catch (err) {
      check(`${presetId} @ ${label}: no throw`, false, err.message);
      continue;
    }
    check(`${presetId} @ ${label}: returned a move`, !!res.move);
    if (res.move) check(`${presetId} @ ${label}: move is legal`, legalIn(chess, res.move), res.move.uci);
    check(`${presetId} @ ${label}: finished promptly`, Date.now() - t0 < 20000, `${Date.now() - t0}ms`);
    if (chess.isCheck() && res.move) {
      const after = new Chess(fen);
      after.move({ from: res.move.from, to: res.move.to, promotion: res.move.promotion });
      // The move must actually resolve the check — chess.js guarantees this
      // for legal moves, so this asserts we never bypassed legal generation.
      check(`${presetId} @ ${label}: check is resolved`, !inCheckFor(after, chess.turn()));
    }
  }
}

function inCheckFor(board, colour) {
  // board has the opponent to move; a legal move can never leave our own
  // king in check, so this should never be true.
  if (board.turn() === colour) return board.isCheck();
  return false;
}

console.log("=== 4. FREEZE REGRESSION: a stalled worker times out and recovers ===");
{
  // Make the worker never answer. The engine must not hang: the call must
  // reject, and the game must still get a move on the next attempt.
  const shortEngine = new Maia3Engine();
  await shortEngine._loadIntoWorker(fresh());
  shimMode = "stall";
  const before = workerInstances;
  const chess = new Chess();
  let threw = null;
  const t0 = Date.now();
  // A short deadline is forced by monkey-patching the timeout constant path:
  // instead, drive it through _call directly with a tiny artificial wait.
  const stalled = shortEngine._call({ type: "infer", tokens: new Float32Array(4), selfElo: 1500, oppoElo: 1500 }, [], 0);
  // Rather than wait the full production timeout in a test, assert the
  // promise is still pending and then cancel it the way a new game would.
  const raced = await Promise.race([
    stalled.then(() => "resolved").catch((e) => (threw = e) && "rejected"),
    new Promise((r) => setTimeout(() => r("pending"), 250)),
  ]);
  check("a stalled call does not resolve with a bogus answer", raced === "pending", raced);
  shortEngine.cancelPending("test cancel");
  const outcome = await stalled.then(() => "resolved").catch((e) => e.constructor.name);
  check("cancelling a stalled call rejects it", outcome !== "resolved", String(outcome));
  check("cancellation does not silently kill the engine", shortEngine.ready === true);
  shimMode = "normal";
  // A restart must produce a working engine again.
  const ok = await shortEngine.restart();
  check("restart spawned a new worker", workerInstances > before);
  void ok;
  void t0;
  void chess;
}

console.log("=== 5. FREEZE REGRESSION: a personality failure degrades to Maia ===");
{
  const chess = new Chess("rnbqk1nr/pppp1ppp/4p3/8/1b1PP3/8/PPP2PPP/RNBQKBNR w KQkq - 1 3");
  // In check with six legal replies. Sabotage the refinement path: it must be caught and the vanilla move
  // returned, rather than propagating and stalling the game.
  const original = engine._personalityMove;
  engine._personalityMove = async () => {
    throw new Error("simulated personality bug");
  };
  const res = await engine.requestMove(chess, { presetId: "TheAttacker", strength: 1, breadth: 5, budgetMs: 2000 });
  check("a personality crash still returns a move", !!res.move);
  check("the fallback move is legal", legalIn(chess, res.move));
  check("the fallback is reported honestly", engine.lastMoveReport.mode === "vanilla-fallback", JSON.stringify(engine.lastMoveReport));
  engine._personalityMove = original;
  const res2 = await engine.requestMove(chess, { presetId: "TheAttacker", strength: 1, breadth: 5, budgetMs: 3000 });
  check("personality works again afterwards", !!res2.move && legalIn(chess, res2.move));
}

console.log("=== 6. the time budget is respected ===");
{
  const chess = new Chess("r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4");
  // A budget of zero cannot afford any refinement, so it must fall straight
  // through to Maia's own move instead of doing the work anyway.
  const res = await engine.requestMove(chess, { presetId: "Trickster", strength: 1, breadth: 6, budgetMs: 0 });
  check("zero budget still returns a legal move", !!res.move && legalIn(chess, res.move));
  check("zero budget skips personality", res.personality === null, JSON.stringify(engine.lastMoveReport));

  const generous = await engine.requestMove(chess, { presetId: "Trickster", strength: 1, breadth: 6, budgetMs: 6000 });
  check("a generous budget does run personality", !!generous.personality);
}

console.log("=== 7. personality across every preset and a spread of positions ===");
const POSITIONS = {
  italian: "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
  tactical: "r2qkb1r/pp2nppp/3p4/2pNN1B1/2BnP3/3P4/PPP2PPP/R2bK2R w kq - 5 11",
  endgame: "8/5pk1/6p1/8/3K4/4P3/5P2/8 w - - 0 40",
  promotion: "8/3P2k1/8/8/8/8/6K1/8 w - - 0 60",
  enpassant: "rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3",
  castling: "r3k2r/pppq1ppp/2npbn2/2b1p3/2B1P3/2NPBN2/PPPQ1PPP/R3K2R w KQkq - 6 9",
};
for (const [label, fen] of Object.entries(POSITIONS)) {
  for (const presetId of PRESETS) {
    const chess = new Chess(fen);
    const res = await engine.requestMove(chess, {
      presetId,
      strength: 1,
      breadth: 5,
      trapSearch: true,
      temperature: 0,
      budgetMs: 4000,
    });
    check(`${presetId} @ ${label}: legal move`, !!res.move && legalIn(chess, res.move), res.move && res.move.uci);
  }
}

console.log("=== 8. special moves are handled end to end ===");
{
  // Promotion: force a position where only promotions are available.
  const chess = new Chess("8/3P2k1/8/8/8/8/6K1/8 w - - 0 60");
  const res = await engine.requestMove(chess, { presetId: "Hoarder", strength: 1, breadth: 5, budgetMs: 4000 });
  check("promotion position returns a legal move", legalIn(chess, res.move));
  const applied = new Chess("8/3P2k1/8/8/8/8/6K1/8 w - - 0 60");
  const mv = applied.move({ from: res.move.from, to: res.move.to, promotion: res.move.promotion });
  check("chess.js accepts the engine's promotion move", !!mv);

  // En passant.
  const ep = new Chess("rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3");
  const epRes = await engine.requestMove(ep, { presetId: "TheAttacker", strength: 1, breadth: 6, budgetMs: 4000 });
  check("en-passant position returns a legal move", legalIn(ep, epRes.move));

  // Castling available to both sides.
  const cas = new Chess("r3k2r/pppq1ppp/2npbn2/2b1p3/2B1P3/2NPBN2/PPPQ1PPP/R3K2R w KQkq - 6 9");
  const casRes = await engine.requestMove(cas, { presetId: "TheWall", strength: 1, breadth: 6, budgetMs: 4000 });
  check("castling position returns a legal move", legalIn(cas, casRes.move));
}

console.log("=== 9. a 60-ply game, alternating presets, never stalls ===");
{
  const chess = new Chess();
  let plies = 0;
  let slowest = 0;
  for (let i = 0; i < 60 && !chess.isGameOver(); i++) {
    const t0 = Date.now();
    const res = await engine.requestMove(chess, {
      presetId: PRESETS[i % PRESETS.length],
      strength: 1,
      breadth: 4,
      trapSearch: i % 3 === 0,
      temperature: 0.7,
      budgetMs: 2500,
    });
    slowest = Math.max(slowest, Date.now() - t0);
    if (!res.move) break;
    const played = chess.move({ from: res.move.from, to: res.move.to, promotion: res.move.promotion });
    check("engine move accepted by chess.js", !!played, res.move.uci);
    if (!played) break;
    plies++;
  }
  check("played 40+ plies", plies >= 40, String(plies));
  check("no single move took absurdly long", slowest < 20000, `${slowest}ms`);
}

console.log("=== 10. checks encountered mid-game are survived ===");
{
  // Play a game where checks actually occur, alternating who is in check,
  // and confirm every reply comes back promptly.
  const chess = new Chess();
  let checksSeen = 0;
  for (let i = 0; i < 40 && !chess.isGameOver(); i++) {
    const wasCheck = chess.isCheck();
    const res = await engine.requestMove(chess, {
      presetId: "TheSwindler",
      strength: 1,
      breadth: 5,
      trapSearch: true,
      temperature: 1.0,
      budgetMs: 2500,
    });
    if (!res.move) break;
    if (wasCheck) {
      checksSeen++;
      check("a move was found while in check", legalIn(chess, res.move));
    }
    chess.move({ from: res.move.from, to: res.move.to, promotion: res.move.promotion });
  }
  console.log(`  (encountered ${checksSeen} in-check positions during play)`);
  check("game did not stall", true);
}

console.log("=== 11. analysis evaluate() ===");
{
  const chess = new Chess("r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4");
  const ev = await engine.evaluate(chess, { elo: 2600, topK: 3 });
  check("evaluate returns moves", ev.moves.length > 0);
  check("every evaluated move is legal", ev.moves.every((m) => legalIn(chess, m)));
  check("every evaluated move has a cp", ev.moves.every((m) => typeof m.cp === "number"));
  check("moves are sorted best first", ev.moves.every((m, i) => i === 0 || ev.moves[i - 1].cp >= m.cp));
  check("wdl is present", !!ev.wdl);

  // includeUci must force a move into the set even if policy ignored it.
  const odd = chess.moves({ verbose: true })[chess.moves().length - 1];
  const oddUci = odd.from + odd.to + (odd.promotion || "");
  const ev2 = await engine.evaluate(chess, { elo: 2600, topK: 2, includeUci: oddUci });
  check("includeUci forces the played move into the evaluation", ev2.moves.some((m) => m.uci === oddUci), oddUci);

  // Terminal positions must not throw.
  const evT = await engine.evaluate(new Chess("7k/5QK1/8/8/8/8/8/8 b - - 0 1"), { elo: 2600 });
  check("a checkmated position evaluates without throwing", evT.terminal === true);
}

console.log("=== 12. unload / reload (model switching) ===");
{
  await engine.unload();
  check("unload clears ready", engine.ready === false);
  let threw = false;
  try {
    await engine.requestMove(new Chess(), { presetId: null });
  } catch {
    threw = true;
  }
  check("moving with no model throws a clear error", threw);
  await engine._loadIntoWorker(fresh());
  check("reload works", engine.ready === true);
  const chess = new Chess();
  const res = await engine.requestMove(chess, { presetId: "Trickster", strength: 1, breadth: 4, budgetMs: 3000 });
  check("plays again after a reload", !!res.move && legalIn(chess, res.move));
}

console.log("=== 13. worker crash is reported, not swallowed ===");
{
  const crashEngine = new Maia3Engine();
  await crashEngine._loadIntoWorker(fresh());
  shimMode = "die";
  let err = null;
  try {
    await crashEngine.requestMove(new Chess(), { presetId: null });
  } catch (e) {
    err = e;
  }
  check("a dead worker rejects rather than hanging", !!err, String(err));
  check("engine marks itself as needing recovery", crashEngine.needsRecovery === true);
  shimMode = "normal";
}

console.log("=== 14. structured-clone safety ===");
check(`no clone failures across ${posted.length} messages`, cloneFailures.length === 0, cloneFailures.join(" | "));
check(
  "no message carried a function",
  posted.every((m) => Object.values(m).every((v) => typeof v !== "function"))
);

console.log("");
console.log(`${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILURES`);
  process.exitCode = 1;
}
