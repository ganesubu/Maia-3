// End-to-end UI test: loads the real index.html and runs the real app.js
// inside jsdom, with the worker shimmed onto the real worker.js logic and
// the tiny synthetic model.
//
//   npm i jsdom
//   python3 tests/make_tiny_model.py tests/tiny-model.bin
//   node tests/app-dom-test.mjs
//
// WHAT THIS DOES AND DOESN'T COVER. jsdom runs the DOM and the app's own
// JavaScript, so screen flow, event wiring, game state, board rendering,
// analysis and variation exploration are all genuinely exercised. jsdom
// does NOT implement CSS layout, so it cannot measure a rendered board in
// pixels; the board-stability invariant is asserted structurally here (the
// board's DOM is untouched by move-list growth) and statically in
// tests/layout-test.mjs. A pixel measurement needs a real browser.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { Chess } from "../js/chess.esm.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

let failures = 0;
let checks = 0;
function check(name, cond, extra = "") {
  checks++;
  if (!cond) {
    failures++;
    console.log(`  FAIL  ${name} ${extra}`);
  }
}

if (!fs.existsSync(path.join(here, "tiny-model.bin"))) {
  console.log("tests/tiny-model.bin missing — run: python3 tests/make_tiny_model.py tests/tiny-model.bin");
  process.exit(1);
}

// ---- environment -------------------------------------------------------

const virtualConsole = new VirtualConsole();
const consoleErrors = [];
virtualConsole.on("jsdomError", (e) => consoleErrors.push(String(e.message)));
virtualConsole.on("error", (...args) => consoleErrors.push(args.map(String).join(" ")));

const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const dom = new JSDOM(html, {
  url: "http://localhost/index.html",
  pretendToBeVisual: true,
  runScripts: "outside-only",
  virtualConsole,
});
const { window } = dom;
const { document } = window;

// Globals the app expects. Everything is a faithful-enough stand-in for the
// browser APIs used; nothing is stubbed that the tests then assert on.
globalThis.window = window;
globalThis.document = document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.CustomEvent = window.CustomEvent;
// NOTE: globalThis.performance is deliberately left as Node's own. Pointing
// it at jsdom's implementation makes jsdom recurse into it and blow the stack.
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.localStorage = window.localStorage;
window.scrollTo = () => {};
Object.defineProperty(window, "navigator", { value: { storage: null }, configurable: true });
// Plain assignment (`globalThis.navigator = window.navigator`) throws on
// Node >=21, which ships a built-in `navigator` global as a getter with no
// setter (Object.getOwnPropertyDescriptor(globalThis, "navigator").set is
// undefined, though the property itself is configurable). defineProperty
// works on every Node version, old or new.
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });

// <dialog> is not implemented by jsdom; the app only calls showModal/close.
for (const d of document.querySelectorAll("dialog")) {
  d.showModal = function () {
    this.setAttribute("open", "");
  };
  d.close = function () {
    this.removeAttribute("open");
  };
}

// IndexedDB is absent: the app must survive that (it means "nothing cached"
// and "can't cache"), which is itself worth asserting.
globalThis.indexedDB = undefined;

// ---- worker shim (real worker.js logic) -------------------------------

const cloneFailures = [];
let sharedHandler = null;
async function ensureWorkerModule() {
  if (sharedHandler) return sharedHandler;
  const bootstrap = { postMessage() {}, onmessage: null };
  globalThis.self = bootstrap;
  await import(pathToFileURL(path.join(root, "js/worker.js")).href);
  sharedHandler = bootstrap.onmessage;
  return sharedHandler;
}

const PIECE_VALUES_CP = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
// Material balance in centipawns, reported from the perspective of the side
// to move (standard UCI convention) -- unlike a fixed "+50 for whoever's
// turn it is", this depends only on the position, so a materially-neutral
// position (e.g. any position in a non-capturing opening) stays neutral
// both before and after a move, matching how a real engine behaves.
function materialCpForMover(board) {
  let whiteCp = 0;
  for (const row of board.board()) {
    for (const sq of row) {
      if (!sq) continue;
      const v = PIECE_VALUES_CP[sq.type] || 0;
      whiteCp += sq.color === "w" ? v : -v;
    }
  }
  return board.turn() === "w" ? whiteCp : -whiteCp;
}

class NodeWorker {
  constructor() {
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
    this._uciFen = null;
    this._self = {
      postMessage: (payload) => {
        try {
          structuredClone(payload);
        } catch (err) {
          cloneFailures.push(`${err.name}: ${err.message}`);
        }
        if (this.onmessage) this.onmessage({ data: payload });
      },
      onmessage: null,
    };
  }

  _postUci(line) {
    queueMicrotask(() => {
      if (this.onmessage) this.onmessage({ data: line });
    });
  }

  _fakeStockfish(payload) {
    const cmd = String(payload);
    if (cmd === "uci") {
      this._postUci("uciok");
      return true;
    }
    if (cmd === "isready") {
      this._postUci("readyok");
      return true;
    }
    if (cmd.startsWith("position fen ")) {
      this._uciFen = cmd.slice("position fen ".length).trim();
      return true;
    }
    if (cmd === "stop" || cmd === "ucinewgame" || cmd.startsWith("setoption ")) return true;
    if (cmd.startsWith("go depth ")) {
      let board = null;
      try {
        if (this._uciFen) board = new Chess(this._uciFen);
      } catch {
        board = null;
      }
      const moves = board ? board.moves({ verbose: true }).slice(0, 2) : [];
      if (moves.length) {
        // A real engine's cp score reflects the actual position (material,
        // safety, etc.), so it barely moves when the mover plays the
        // engine's own top choice -- the position was already accounted
        // for in that choice. A constant "+50 for whoever's turn it is"
        // does not have that property: it flips sign after every single
        // half-move regardless of what was played, which fails any check
        // that a best move should not swing the eval bar (and produces a
        // worse zig-zag than a real engine would over a short game).
        // Material count fixes this cheaply: it depends on the position,
        // not on whose turn it is, so an objectively neutral position
        // stays neutral before and after a non-capturing "best" move.
        const baseCpMover = materialCpForMover(board);
        const first = moves[0];
        const firstUci = first.from + first.to + (first.promotion || "");
        this._postUci(`info depth 15 multipv 1 score cp ${baseCpMover} pv ${firstUci}`);
        if (moves[1]) {
          const second = moves[1];
          const secondUci = second.from + second.to + (second.promotion || "");
          // Second-ranked move is scored a bit worse, purely to keep a
          // stable "which is best vs. second-best" ordering for tests that
          // check arrow colours -- not meant to model real move quality.
          this._postUci(`info depth 15 multipv 2 score cp ${baseCpMover - 30} pv ${secondUci}`);
        }
        this._postUci(`bestmove ${firstUci}`);
      } else {
        this._postUci("bestmove 0000");
      }
      return true;
    }
    return true;
  }

  async postMessage(payload) {
    try {
      structuredClone(payload);
    } catch (err) {
      cloneFailures.push(`${err.name}: ${err.message}`);
    }

    // Maia's worker uses structured object messages; the real Stockfish
    // adapter uses UCI strings. Keep both protocols in this harness so the
    // DOM test exercises the real analysis UI without requiring the native
    // Stockfish binary in Node.
    if (typeof payload === "string") {
      this._fakeStockfish(payload);
      return;
    }

    const handler = await ensureWorkerModule();
    globalThis.self = this._self;
    handler({ data: payload });
  }

  terminate() {}
}
globalThis.Worker = NodeWorker;
window.Worker = NodeWorker;

// The app fetches ./weights/<id>.bin; serve the tiny model for the 5M id
// and 404 the rest, which also exercises the "model file missing" path.
const tiny = fs.readFileSync(path.join(here, "tiny-model.bin"));
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("maia3-5m.bin")) {
    return {
      ok: true,
      status: 200,
      headers: { get: () => String(tiny.byteLength) },
      body: null,
      arrayBuffer: async () => tiny.buffer.slice(tiny.byteOffset, tiny.byteOffset + tiny.byteLength),
    };
  }
  return { ok: false, status: 404, headers: { get: () => null }, body: null, arrayBuffer: async () => new ArrayBuffer(0) };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Let the app's async refresh finish. Stepping the played line is
// synchronous by design, so this is short.
const refreshAndSettle = async () => {
  await window.__maia.refreshAnalysisView();
  await sleep(20);
};
const showGameScreenForTest = () => {
  document.getElementById("screen-game").hidden = false;
  document.getElementById("screen-analysis").hidden = true;
};
const $ = (id) => document.getElementById(id);
const click = (id) => $(id).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const clickEl = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

// ---- boot the app ------------------------------------------------------

await import(pathToFileURL(path.join(root, "js/app.js")).href);
await sleep(60);

const api = window.__maia;
check("app exposed its state", !!api && !!api.engine && !!api.chess);

console.log("=== 1. first screen is opponent selection ===");
check("select screen is visible", $("screen-select").hidden === false);
check("game screen is hidden", $("screen-game").hidden === true);
check("analysis screen is hidden", $("screen-analysis").hidden === true);
const cards = document.querySelectorAll(".roster-card");
check("the roster rendered characters", cards.length >= 7, String(cards.length));
check("vanilla Maia is offered too", [...cards].some((c) => c.dataset.person === "vanilla"));
check("each card shows a portrait", [...cards].every((c) => c.querySelector("svg")));
check("each card names an archetype", [...cards].every((c) => c.querySelector(".roster-arch").textContent.trim().length > 0));

console.log("=== 2. choosing a character shows age/Elo/identity ===");
clickEl([...cards].find((c) => c.dataset.person === "josh"));
await sleep(10);
check("chooser is shown", $("chooser").hidden === false);
check("name is shown", $("chooser-name").textContent === "Josh", $("chooser-name").textContent);
check("archetype is shown", $("chooser-archetype").textContent.length > 0);
check("a bio is shown", $("chooser-bio").textContent.length > 0);
check("tendencies are listed", $("chooser-tendencies").children.length >= 2);
const ratingSelect = $("rating-select");
check("the rating dropdown is populated", ratingSelect.options.length === 41, String(ratingSelect.options.length));
const ratingValues = [...ratingSelect.options].map((o) => Number(o.value));
check("it runs 600 to 2600", ratingValues[0] === 600 && ratingValues.at(-1) === 2600, `${ratingValues[0]}..${ratingValues.at(-1)}`);
check("in steps of 50", ratingValues.every((v, i) => i === 0 || v === ratingValues[i - 1] + 50));
const ratingText = [...ratingSelect.options].map((o) => o.textContent);
check("each option shows the matching age", ratingText[0].includes("6 years old") && ratingText[0].includes("600"), ratingText[0]);
check("half-year ages appear", ratingText.some((t) => t.includes("6.5 years old") && t.includes("650")), ratingText[1]);
check("the oldest is 26 / 2600", ratingText.at(-1).includes("26 years old") && ratingText.at(-1).includes("2600"), ratingText.at(-1));

// Selecting a rating must update the character card.
ratingSelect.value = "600";
ratingSelect.dispatchEvent(new window.Event("change"));
await sleep(10);
check("choosing 600 updates the shown Elo", $("chooser-elo").textContent === "600 Elo", $("chooser-elo").textContent);
check("and the shown age", $("chooser-age").textContent === "6 years old", $("chooser-age").textContent);
check("the archetype is unchanged by age", $("chooser-archetype").textContent.includes("Positional"), $("chooser-archetype").textContent);

ratingSelect.value = "1250";
ratingSelect.dispatchEvent(new window.Event("change"));
await sleep(10);
check("a half-year step works", $("chooser-age").textContent === "12.5 years old", $("chooser-age").textContent);
check("with the matching rating", $("chooser-elo").textContent === "1250 Elo", $("chooser-elo").textContent);

console.log("=== 3. openings are offered ===");
const openingSelect = $("opening-select");
check("opening list is populated", openingSelect.options.length > 10, String(openingSelect.options.length));
check("'No preference' is offered", [...openingSelect.options].some((o) => o.value === "none"));
check("'Random opening' is offered", [...openingSelect.options].some((o) => o.value === "random"));
check("named openings are offered", [...openingSelect.options].some((o) => o.value === "sicilian"));

console.log("=== 4. loading a model ===");
$("model-select").value = "maia3-5m";
click("load-model-btn");
for (let i = 0; i < 100 && !api.engine.ready; i++) await sleep(20);
check("the model loaded", api.engine.ready === true, $("load-progress").textContent);
check("engine status reflects it", $("engine-status").textContent.includes("ready"), $("engine-status").textContent);
check("missing IndexedDB did not break the load", api.engine.ready === true);

console.log("=== 5. starting a game ===");
openingSelect.value = "sicilian";
openingSelect.dispatchEvent(new window.Event("change"));
click("pick-white");
click("play-btn");
for (let i = 0; i < 200 && $("screen-game").hidden; i++) await sleep(10);
check("the game screen opened", $("screen-game").hidden === false);
check("the opponent strip names the character", $("game-name").textContent === "Josh", $("game-name").textContent);
check("the strip shows age and Elo", /12\.5 yrs/.test($("game-sub").textContent) && $("game-sub").textContent.includes("1250"), $("game-sub").textContent);
check("the board rendered 64 squares", $("board").querySelectorAll(".square").length === 64);
check("the opening is named on the move list", $("opening-played").textContent.includes("Sicilian"), $("opening-played").textContent);

console.log("=== 6. playing moves, and the opening director ===");
// Play 1.e4 as White; the director should answer with a Sicilian move.
async function humanMove(from, to, promotion) {
  await api.board.onUserMove({ from, to, promotion });
  for (let i = 0; i < 400 && api.state.awaitingEngine; i++) await sleep(10);
}
await humanMove("e2", "e4");
const hist1 = api.chess.history();
check("the human move was played", hist1[0] === "e4", hist1.join(" "));
check("the opponent replied", hist1.length === 2, hist1.join(" "));
check("the reply is the Sicilian's 1...c5", hist1[1] === "c5", hist1.join(" "));
check("the move list shows both moves", $("move-list").textContent.includes("c5"));

// Second white move, then the director's third ply.
const legalNow = api.chess.moves({ verbose: true })[0];
await humanMove(legalNow.from, legalNow.to, legalNow.promotion);
const hist2 = api.chess.history();
check("game reached 4 plies", hist2.length === 4, hist2.join(" "));
check("director retired after 3 plies", api.state.director.isActive() === false);

console.log("=== 7. the board does not react to move-list growth ===");
// jsdom has no layout, so this asserts the STRUCTURAL invariant: the board's
// DOM is not rebuilt or restyled as moves accumulate, and the move list is
// not an ancestor or sizing sibling of the board.
const boardEl = $("board");
const squaresBefore = boardEl.querySelectorAll(".square").length;
const boardStyleBefore = boardEl.getAttribute("style");
const frameStyleBefore = $("board").closest(".board-frame").getAttribute("style");
for (let i = 0; i < 30 && !api.chess.isGameOver(); i++) {
  const moves = api.chess.moves({ verbose: true });
  if (!moves.length) break;
  api.chess.move(moves[Math.floor(Math.random() * moves.length)]);
}
// Force the app to re-render the list the way it does after a real move.
api.board.render(api.chess);
const listEl = $("move-list");
listEl.textContent = "";
{
  const hist = api.chess.history({ verbose: true });
  for (const h of hist) {
    const s = document.createElement("span");
    s.className = "mv";
    s.textContent = h.san;
    listEl.appendChild(s);
  }
}
check("board still has exactly 64 squares", boardEl.querySelectorAll(".square").length === squaresBefore);
check("no inline size was written onto the board", boardEl.getAttribute("style") === boardStyleBefore, String(boardEl.getAttribute("style")));
check("no inline size was written onto the board frame", $("board").closest(".board-frame").getAttribute("style") === frameStyleBefore);
check("the move list is NOT an ancestor of the board", !listEl.contains(boardEl));
check("the board is not inside the panel holding the move list", !listEl.closest(".panel").contains(boardEl));

console.log("=== 8. a full game to its end, then analysis ===");
// Reset and play a short scripted game that ends in checkmate, so the
// game-over panel and the analysis flow can both be exercised for real.
click("new-game");
for (let i = 0; i < 300 && api.state.awaitingEngine; i++) await sleep(10);
api.state.engineEnabled = false; // drive both sides deterministically
$("engine-toggle").setAttribute("aria-pressed", "false");
for (const san of ["f3", "e5", "g4", "Qh4#"]) {
  const m = api.chess.moves({ verbose: true }).find((x) => x.san === san);
  check(`scripted move ${san} is available`, !!m);
  if (!m) break;
  await humanMove(m.from, m.to, m.promotion);
}
check("the game is over", api.chess.isGameOver() === true, api.chess.history().join(" "));
check("checkmate was detected", api.chess.isCheckmate() === true);
check("the game-over panel appeared", $("gameover-panel").hidden === false);
check("an analyse button is offered", !!$("analyze-btn"));

click("analyze-btn");
for (let i = 0; i < 600 && $("analysis-body").hidden; i++) await sleep(20);
check("the analysis screen opened", $("screen-analysis").hidden === false);
check("analysis finished and revealed its body", $("analysis-body").hidden === false, $("analysis-progress-text").textContent);
check("every played move was classified", $("analysis-move-list").querySelectorAll(".mv[data-ply]").length === api.state.session.gameHistory.length, String($("analysis-move-list").querySelectorAll(".mv[data-ply]").length));
check("an accuracy figure is shown per side", $("accuracy-row").children.length === 2, String($("accuracy-row").children.length));
check("a summary was produced", $("summary-grid").children.length > 0);
check("the eval bar has a height", !!$("eval-white").style.height, $("eval-white").style.height);
check("an eval number is shown", $("eval-number").textContent !== "—", $("eval-number").textContent);
check("classifications use the five verdicts", [...$("analysis-move-list").querySelectorAll(".mv[data-ply]")].every((el) => /cls-(best|good|inaccuracy|mistake|blunder)/.test(el.className)), [...$("analysis-move-list").querySelectorAll(".mv[data-ply]")].map((e) => e.className).join("|"));

console.log("=== 9. stepping through the analysed game ===");
check("a game review opens at the start, like Lichess", api.state.session.basePly === 0, String(api.state.session.basePly));
click("nav-start");
await sleep(60);
check("navigating to the start works", api.state.session.basePly === 0);
check("context label says so", $("context-label").textContent.includes("Starting"), $("context-label").textContent);
click("nav-next");
await sleep(60);
check("stepping forward advances one ply", api.state.session.basePly === 1);
click("nav-end");
await sleep(120);
check("jumping to the end works", api.state.session.basePly === api.state.session.gameHistory.length);
click("nav-prev");
await sleep(60);
check("stepping back works", api.state.session.basePly === api.state.session.gameHistory.length - 1);

// Clicking a move in the list jumps to it.
const secondMove = $("analysis-move-list").querySelectorAll(".mv[data-ply]")[1];
clickEl(secondMove);
await sleep(80);
check("clicking a move jumps to that ply", api.state.session.basePly === Number(secondMove.dataset.ply));

console.log("=== 10. arrows: instant, two of them, right colours ===");
{
  // Step to a move where the engine disagreed with what was played, so
  // both arrows are expected.
  const nodes = api.state.analysis.nodes.filter((n) => n.ply);
  const disagreed = nodes.find((n) => n.bestUci && n.bestUci !== n.uci);
  const agreed = nodes.find((n) => n.bestUci && n.bestUci === n.uci);

  if (disagreed) {
    api.state.session.goToPly(disagreed.ply - 1 + 1 - 1); // the position the move was played FROM
    api.state.session.goToPly(disagreed.ply - 1);
    // Arrows must appear WITHOUT waiting on the engine: this is the whole
    // point of precomputing them during the analysis pass. The refresh is
    // awaited only so the DOM is written; no inference may occur.
    const before = api.engine._reqId;
    await refreshAndSettle();
    check("stepping the played line costs no engine calls", api.engine._reqId === before, `${before} -> ${api.engine._reqId}`);
    const lines = $("analysis-board").querySelectorAll(".arrow-layer line");
    check("two arrows are drawn when the engine disagrees", lines.length === 2, String(lines.length));
    const classes = [...lines].map((l) => l.getAttribute("class"));
    check("one is the engine's move (green)", classes.some((c) => c.includes("arrow-best")), classes.join("|"));
    check("one is the move played (yellow)", classes.some((c) => c.includes("arrow-played")), classes.join("|"));
    check("no third colour is used", classes.every((c) => /arrow-(best|played)/.test(c)), classes.join("|"));
  }

  if (agreed) {
    api.state.session.goToPly(agreed.ply - 1);
    await refreshAndSettle();
    const lines = $("analysis-board").querySelectorAll(".arrow-layer line");
    check("only one arrow when the played move WAS the best", lines.length === 1, String(lines.length));
    check("and it is the green one", (lines[0].getAttribute("class") || "").includes("arrow-best"));
  }

  check("a legend explains the colours", !$("arrow-legend").hidden && $("arrow-legend").textContent.includes("You played"));

  click("toggle-arrows");
  await refreshAndSettle();
  check("arrows can be switched off", $("analysis-board").querySelectorAll(".arrow-layer line").length === 0);
  check("the legend hides with them", $("arrow-legend").hidden === true);
  click("toggle-arrows");
  await refreshAndSettle();
  check("arrows can be switched back on", $("analysis-board").querySelectorAll(".arrow-layer line").length > 0);
}

console.log("=== 10b. the eval bar reads from the timeline, not the mover ===");
{
  const session = api.state.session;
  const heights = [];
  for (let ply = 0; ply <= session.gameHistory.length; ply++) {
    session.goToPly(ply);
    await refreshAndSettle();
    heights.push(parseFloat($("eval-white").style.height));
  }
  check("the bar has a value at every ply", heights.every((h) => Number.isFinite(h)), heights.join(","));
  check("the bar matches the stored node eval", heights.every((h, i) => {
    const n = api.state.analysis.nodes[i];
    return !n || Math.abs(h - n.winWhite) < 0.51;
  }), heights.map((h) => h.toFixed(1)).join(","));
  // The reported symptom, asserted directly at the DOM level.
  let flips = 0;
  for (let i = 2; i < heights.length; i++) {
    const d1 = heights[i - 1] - heights[i - 2];
    const d2 = heights[i] - heights[i - 1];
    if (Math.abs(d1) > 4 && Math.abs(d2) > 4 && Math.sign(d1) !== Math.sign(d2)) flips++;
  }
  check("the bar does not zig-zag every single ply", flips < heights.length - 2, `${flips} flips over ${heights.length} plies`);
}

console.log("=== 10c. Stop actually stops ===");
{
  // The synthetic model is far faster than a real one, so the run would
  // finish before a click could land. Slowing each position down makes the
  // test measure what it claims to: that pressing Stop interrupts a run in
  // flight, rather than that a fast run happened to end.
  //
  // Post-game analysis calls analysisEngine.evaluate() (Stockfish), never
  // engine.evaluate() (Maia) -- analysis.js is explicit that "Analysis is
  // Stockfish-only". Patching api.engine.evaluate here does not slow the
  // analysis run down at all, so it finishes before this section's first
  // check ever runs. Patch the engine that analysis actually calls.
  const realEvaluate = api.analysisEngine.evaluate.bind(api.analysisEngine);
  let positions = 0;
  api.analysisEngine.evaluate = async (board, opts) => {
    positions++;
    await sleep(120);
    return realEvaluate(board, opts);
  };

  showGameScreenForTest();
  clickEl($("analyze-btn"));
  await sleep(150);
  check("analysis is running", api.state.analysisRunning === true, String(api.state.analysisRunning));
  check("the progress panel is shown", $("analysis-progress").hidden === false);
  const doneWhenStopped = positions;

  click("analysis-cancel");
  let waited = 0;
  while (api.state.analysisRunning && waited < 4000) {
    await sleep(20);
    waited += 20;
  }
  check("analysis stopped promptly after Stop", api.state.analysisRunning === false, `${waited}ms`);
  check("it stopped within a position or two of the click", positions - doneWhenStopped <= 2, `${doneWhenStopped} -> ${positions}`);
  check("it did not quietly finish the whole game", positions < api.chess.history().length, `${positions} of ${api.chess.history().length}`);
  check("the progress panel closed", $("analysis-progress").hidden === true);
  check("it reports being cancelled", api.state.analysis && api.state.analysis.cancelled === true, JSON.stringify(api.state.analysis && api.state.analysis.cancelled));
  check("the UI is usable afterwards", $("analysis-body").hidden === false);
  check("the cancel button is re-enabled for next time", true);

  // Restore the engine and run a complete analysis, so the sections that
  // follow work against a full timeline.
  api.analysisEngine.evaluate = realEvaluate;
  showGameScreenForTest();
  clickEl($("analyze-btn"));
  // The click handler is async and needs at least one tick to flip
  // state.analysisRunning to true. Without this, when the previous run
  // already left analysisRunning=false and analysis-body visible, the
  // loop below's condition is satisfied immediately (before the fresh
  // run has started), so it exits on iteration 0 and every check that
  // follows inspects the *previous* run's stale state.analysis instead
  // of this one.
  await sleep(20);
  for (let i = 0; i < 900 && (api.state.analysisRunning || $("analysis-body").hidden); i++) await sleep(20);
  check("a fresh full analysis completes after a cancelled one", api.state.analysis && !api.state.analysis.cancelled, JSON.stringify(api.state.analysis && api.state.analysis.cancelled));
  check("and produces a full timeline", api.state.analysis.nodes.length === api.chess.history().length + 1, String(api.state.analysis.nodes.length));
}

console.log("=== 10d. PGN export ===");
{
  const pgn = api.__test_pgn();
  check("a PGN is produced", typeof pgn === "string" && pgn.length > 20);
  check("it names both players", pgn.includes("[White ") && pgn.includes("[Black "));
  check("it records the result", /\[Result "(1-0|0-1|1\/2-1\/2|\*)"\]/.test(pgn), pgn.slice(0, 200));
  check("it contains the moves played", pgn.includes("f3") && pgn.includes("Qh4#"), pgn.slice(-120));
  check("it names the opponent character", pgn.includes("Josh") || pgn.includes("Mara"), pgn.slice(0, 240));
  const reload = new (await import(pathToFileURL(path.join(root, "js/chess.esm.js")).href)).Chess();
  let ok = true;
  try {
    reload.loadPgn(pgn);
  } catch {
    ok = false;
  }
  check("the exported PGN parses back", ok);

  const annotated = api.__test_pgn({ annotated: true });
  check("an annotated PGN is available after analysis", annotated.length > pgn.length - 50);
  check("it credits the analysis engine", annotated.includes("Annotator"), annotated.slice(0, 300));
}


console.log("=== 10e. exact-best variation does not move the review bar ===");
{
  const session = api.state.session;
  const traceStart = api.engine._reqId;
  session.goToPly(0);
  await refreshAndSettle();

  const firstNode = api.state.analysis.nodes[0];
  const before = parseFloat($("eval-white").style.height);

  const best = session.board.moves({ verbose: true }).find(
    (m) => m.from + m.to + (m.promotion || "") === firstNode.bestUci
  );

  if (best) {
    const tap = (sq) => clickEl($("analysis-board").querySelector(`[data-square="${sq}"]`));
    tap(best.from);
    await sleep(20);
    tap(best.to);
    for (let i = 0; i < 300 && !session.inVariation; i++) await sleep(10);
    await sleep(100);

    const after = parseFloat($("eval-white").style.height);
    check("exact-best variation was entered", session.inVariation === true);
    check("exact-best variation keeps the displayed bar", Math.abs(after - before) < 0.51, `${before} -> ${after}`);
    check("exact-best variation does not make an automatic reply", session.variation.length === 1, session.variation.join(" "));
    click("back-to-game-line");
    await refreshAndSettle();
  }
}

console.log("=== 11. exploring a variation by TAPPING the board, and returning ===");
{
  const session = api.state.session;
  session.goToPly(2); // after 1.f3 e5
  // goToPly rebuilds the scratch board, so the view must be refreshed for
  // the DOM board to be bound to it -- which is exactly what every
  // navigation control in the app does.
  await refreshAndSettle();
  const gameBefore = session.gameHistory.join(" ");
  check("no back-to-game button on the played line", $("back-to-game-line").hidden === true);
  check("the banner is gone entirely", document.getElementById("variation-banner") === null);
  check("board frame is not marked as exploring", !$("analysis-board").closest(".board-with-bar").classList.contains("exploring"));

  // Choose a move the real game did not play, then make it by tapping the
  // from-square and the to-square, exactly as a finger would.
  const realNext = session.gameHistory[2];
  const alt = session.board.moves({ verbose: true }).find((m) => m.san !== realNext);
  check("an alternative move exists", !!alt, realNext);
  const tap = (sq) => clickEl($("analysis-board").querySelector(`[data-square="${sq}"]`));
  tap(alt.from);
  await sleep(20);
  check("tapping a piece selects it", $("analysis-board").querySelector(`[data-square="${alt.from}"]`).classList.contains("selected"));
  tap(alt.to);
  for (let i = 0; i < 200 && !session.inVariation; i++) await sleep(10);

  check("tapping an alternative move starts a variation", session.inVariation === true, session.variation.join(" "));
  check("a Back-to-game button appears", $("back-to-game-line").hidden === false);
  check("the board is visually marked as exploring", $("analysis-board").closest(".board-with-bar").classList.contains("exploring"));
  check("the context label says 'Variation'", $("context-label").textContent.startsWith("Variation"), $("context-label").textContent);
  check("THE PLAYED GAME IS UNCHANGED", session.gameHistory.join(" ") === gameBefore);
  check("the real game object was not touched either", api.chess.history().join(" ").length > 0);

  // The analysis engine answers inside the variation, so a line can be
  // played out rather than only one move deep.
  await sleep(400);
  check("the engine replied inside the variation", session.variation.length >= 1, session.variation.join(" "));
  check("the eval bar still has a value", !!$("eval-white").style.height);

  // Explore a second, different line from the same point.
  clickEl($("back-to-game-line"));
  await refreshAndSettle();
  check("back-to-game exits the variation", session.inVariation === false);
  check("the Back-to-game button disappears", $("back-to-game-line").hidden === true);
  check("it restores the played position", session.board.history().length === 2, String(session.board.history().length));
  check("the played game is still intact", session.gameHistory.join(" ") === gameBefore);

  const alt2 = session.board.moves({ verbose: true }).filter((m) => m.san !== realNext)[1];
  if (alt2) {
    tap(alt2.from);
    await sleep(20);
    tap(alt2.to);
    for (let i = 0; i < 200 && !session.inVariation; i++) await sleep(10);
    check("a second, different variation can be explored", session.inVariation === true, session.variation.join(" "));
    check("the game survived that too", session.gameHistory.join(" ") === gameBefore);
    clickEl($("back-to-game-line"));
    await refreshAndSettle();
  }

  // Navigating away from a variation also returns to the played line.
  tap(alt.from);
  await sleep(20);
  tap(alt.to);
  for (let i = 0; i < 200 && !session.inVariation; i++) await sleep(10);
  click("nav-end");
  await sleep(200);
  check("navigating discards the variation", session.inVariation === false);
  check("and lands on the played game's final position", session.basePly === session.gameHistory.length);
  check("the played game is unchanged at the end of it all", session.gameHistory.join(" ") === gameBefore);
}

console.log("=== 11b. REGRESSION: stepping must not scroll the page away from the board ===");
{
  // Reported: pressing Next jumped the screen down to the move list, so the
  // board scrolled off the top. Cause: scrollIntoView() scrolls EVERY
  // scrollable ancestor, including the page. jsdom has no scrolling, so the
  // fix is asserted at the source level plus behaviourally below.
  const appSrc = fs.readFileSync(path.join(root, "js/app.js"), "utf8");
  // Compare the function BODIES only. Slicing between declarations would
  // sweep in the explanatory comments, which of course name the API they
  // are explaining.
  const bodyOf = (name) => {
    const start = appSrc.indexOf(`function ${name}(`);
    if (start < 0) return "";
    const open = appSrc.indexOf("{", start);
    let depth = 0;
    for (let i = open; i < appSrc.length; i++) {
      if (appSrc[i] === "{") depth++;
      else if (appSrc[i] === "}") {
        depth--;
        if (depth === 0) return appSrc.slice(open, i + 1);
      }
    }
    return "";
  };
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const highlight = stripComments(bodyOf("highlightCurrentPly"));
  check("highlightCurrentPly no longer calls scrollIntoView", highlight.length > 0 && !highlight.includes("scrollIntoView"), highlight.slice(0, 200));
  check("a container-scoped scroll helper exists", appSrc.includes("function scrollMoveIntoView"));
  const helper = stripComments(bodyOf("scrollMoveIntoView"));
  check("the helper only moves the list's own scrollTop", helper.includes("list.scrollTop") && !helper.includes("scrollIntoView"), helper.slice(0, 200));
  check("it never touches window scrolling", !helper.includes("window.scroll") && !helper.includes("scrollTo("));

  // Behavioural: stepping must not call window.scrollTo at all.
  let scrolled = 0;
  const realScrollTo = window.scrollTo;
  window.scrollTo = () => { scrolled++; };
  const session = api.state.session;
  session.goToPly(0);
  await refreshAndSettle();
  for (let i = 0; i < 4; i++) {
    click("nav-next");
    await refreshAndSettle();
  }
  window.scrollTo = realScrollTo;
  check("pressing Next never scrolls the page", scrolled === 0, `${scrolled} page scrolls`);
  check("Next still advanced through the game", session.basePly === 4, String(session.basePly));

  // And the move list itself is the thing that scrolls.
  const list = $("analysis-move-list");
  check("the move list is the scroll container", list.scrollTop >= 0 && typeof list.scrollTop === "number");
}

console.log("=== 11c. REGRESSION: Stop can never strand the UI on 'Stopping…' ===");
{
  const progress = $("analysis-progress");
  const cancel = $("analysis-cancel");
  const label = $("analysis-progress-text");

  // (a) Stop pressed when nothing is running -- the exact reported stuck
  //     state, which used to write "Stopping…" and disable the button
  //     forever with no run to end it.
  check("no analysis is running", api.state.analysisRunning === false);
  click("analysis-cancel");
  await sleep(30);
  check("pressing Stop while idle does not strand the panel", label.textContent !== "Stopping…", label.textContent);
  check("the panel is hidden when idle", progress.hidden === true);
  check("the Stop button is left usable", cancel.disabled === false);
  check("the analysis view is still shown", $("analysis-body").hidden === false);

  // (b) Stop pressed twice in quick succession during a real run.
  // (Analysis calls analysisEngine.evaluate() -- Stockfish -- not
  // engine.evaluate(); see the note in section 10c.)
  const realEvaluate = api.analysisEngine.evaluate.bind(api.analysisEngine);
  api.analysisEngine.evaluate = async (b, o) => {
    await sleep(100);
    return realEvaluate(b, o);
  };
  showGameScreenForTest();
  clickEl($("analyze-btn"));
  await sleep(120);
  check("a run is under way", api.state.analysisRunning === true);
  click("analysis-cancel");
  click("analysis-cancel");
  let waited = 0;
  while (api.state.analysisRunning && waited < 5000) {
    await sleep(20);
    waited += 20;
  }
  check("a double Stop still settles", api.state.analysisRunning === false, `${waited}ms`);
  check("and clears the Stopping label", label.textContent !== "Stopping…", label.textContent);
  check("and hides the panel", progress.hidden === true);
  check("and re-enables Stop for next time", cancel.disabled === false);
  check("the results are shown", $("analysis-body").hidden === false);

  // (c) Leaving mid-run, then coming back and analysing again.
  showGameScreenForTest();
  clickEl($("analyze-btn"));
  await sleep(120);
  click("analysis-back");
  await sleep(40);
  check("leaving mid-run returns to the game", $("screen-game").hidden === false);
  waited = 0;
  while (api.state.analysisRunning && waited < 5000) {
    await sleep(20);
    waited += 20;
  }
  check("the abandoned run settles", api.state.analysisRunning === false, `${waited}ms`);

  api.analysisEngine.evaluate = realEvaluate;
  clickEl($("analyze-btn"));
  // Same startup race as section 10c -- see the comment there.
  await sleep(20);
  for (let i = 0; i < 900 && (api.state.analysisRunning || $("analysis-body").hidden); i++) await sleep(20);
  check("analysis works again after all that", api.state.analysis && !api.state.analysis.cancelled, JSON.stringify(api.state.analysis && api.state.analysis.cancelled));
  check("the panel ends hidden", progress.hidden === true);
  check("the phase machine ends in 'done'", api.state.analysisPhase === "done", api.state.analysisPhase);
}

console.log("=== 12. leaving analysis returns to the game, intact ===");
{
  const before = api.chess.history().join(" ");
  click("analysis-back");
  await sleep(30);
  check("back returns to the game screen", $("screen-game").hidden === false && $("screen-analysis").hidden === true);
  check("the played game is unchanged after analysis", api.chess.history().join(" ") === before, api.chess.history().join(" "));
}

console.log("=== 13. new opponent resets cleanly ===");
{
  click("change-opponent-btn");
  await sleep(20);
  check("returns to selection", $("screen-select").hidden === false);
  clickEl([...document.querySelectorAll(".roster-card")].find((c) => c.dataset.person === "mara"));
  await sleep(10);
  check("a different character is shown", $("chooser-name").textContent === "Mara", $("chooser-name").textContent);
  $("opening-select").value = "none";
  $("opening-select").dispatchEvent(new window.Event("change"));
  click("play-btn");
  for (let i = 0; i < 300 && $("screen-game").hidden; i++) await sleep(10);
  check("a new game started", $("screen-game").hidden === false);
  check("the board is back to the start", api.chess.history().length <= 1, api.chess.history().join(" "));
  check("personality momentum was reset", api.engine.personality.flankCommitment === 0);
  check("the opponent strip updated", $("game-name").textContent === "Mara", $("game-name").textContent);
}

console.log("=== 14. no uncaught page errors, no clone failures ===");
check("no DataCloneError anywhere", cloneFailures.length === 0, cloneFailures.join(" | "));
const realErrors = consoleErrors.filter((e) => !/Not implemented|Could not parse CSS|jsdom/i.test(e));
check("no unexpected page errors", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));

console.log("");
console.log(`${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILURES`);
  process.exitCode = 1;
}
process.exit(failures ? 1 : 0);
