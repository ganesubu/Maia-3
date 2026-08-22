import { Chess } from "./chess.esm.js";
import { Board } from "./board.js";
import { Maia3Engine, WeightsFetchError, EngineCancelledError } from "./engine.js";
import { StockfishAnalysisEngine } from "./stockfish-engine.js";
import * as idb from "./idb.js";
import {
  CHARACTERS,
  PEOPLE,
  VANILLA_CHARACTER,
  ELO_CHOICES,
  characterById,
  characterFor,
  charactersFor,
  formatAge,
  portraitSvg,
} from "./characters.js";
import { OPENING_CHOICES, OpeningDirector, openingById } from "./openings.js";
import {
  analyseGame,
  VariationSession,
  CLASSES,
  CLASS_LABEL,
  ANALYSIS_ELO,
  evalToWhiteShare,
  formatEval,
  plyLabel,
  winPctFromWdl,
  winPctFromCp,
  toPgn,
  resultOf,
} from "./analysis.js";

const MODEL_CATALOG = [
  { id: "maia3-5m", label: "Maia-3 5M", file: "./weights/maia3-5m.bin", note: "fastest — best on phones" },
  { id: "maia3-23m", label: "Maia-3 23M", file: "./weights/maia3-23m.bin", note: "slower" },
  { id: "maia3-79m", label: "Maia-3 79M", file: "./weights/maia3-79m.bin", note: "slowest — desktop" },
];
const LAST_MODEL_KEY = "maia3:last-model";
const PREFS_KEY = "maia3:prefs";

const $ = (id) => document.getElementById(id);

// ---- application state ------------------------------------------------

const engine = new Maia3Engine();
const analysisEngine = new StockfishAnalysisEngine({ depth: 15 });
const chess = new Chess();

const state = {
  screen: "select",
  selectedPersonId: PEOPLE[0].id,
  character: null, // the chosen character (or VANILLA_CHARACTER)
  openingId: "random",
  colourChoice: "white", // white | black | random
  humanIsWhite: true,
  engineEnabled: true,
  awaitingEngine: false,
  director: null,
  gameOver: false,
  moveBudgetMs: 2500,
  temperature: 1.0,
  trapSearch: true,
  showThinking: false,
  oppoElo: 1500,
  analysis: null, // { nodes, summary }
  analysisCancel: false,
  analysisRunning: false,
  analysisPhase: "idle", // idle | running | stopping | done
  stopWatchdog: null,
  resigned: null,
  selectedElo: 1500,
  startFen: null,
  session: null, // VariationSession
  showArrows: true,
  evalCache: new Map(), // history + fen -> evaluate() result
  variationReviewCache: new Map(), // review-timeline state keyed by complete history
  pendingEvalToken: 0,
  gameReviewPly: null, // null = live/current position; integer = historical ply
};

// ---- boards -----------------------------------------------------------

const board = new Board($("board"), {
  onUserMove: handleUserMove,
  announce,
});
board.bindInteraction(chess, {
  isMyTurn: () => {
    if (state.gameReviewPly !== null) return false;
    if (state.awaitingEngine || state.gameOver) return false;
    if (!state.engineEnabled) return true;
    return isHumanTurn() && engine.ready;
  },
});
board.render(chess);

let analysisBoard = null; // built lazily when analysis first opens

function announce(msg) {
  $("live-region").textContent = msg;
}

// ---- screens ----------------------------------------------------------

function showScreen(name) {
  state.screen = name;
  for (const [id, key] of [
    ["screen-select", "select"],
    ["screen-game", "game"],
    ["screen-analysis", "analysis"],
  ]) {
    $(id).hidden = name !== key;
  }
  window.scrollTo(0, 0);
}

// ---- screen 1: opponent selection ------------------------------------

function renderRoster() {
  const el = $("roster");
  el.textContent = "";
  const entries = [...PEOPLE, { id: "vanilla", name: "Maia", archetypeLabel: "No personality", palette: VANILLA_CHARACTER.palette, ages: [] }];
  for (const person of entries) {
    const sample =
      person.id === "vanilla" ? VANILLA_CHARACTER : charactersFor(person.id)[1] || charactersFor(person.id)[0];
    const card = document.createElement("button");
    card.type = "button";
    card.className = "roster-card";
    card.setAttribute("role", "listitem");
    card.dataset.person = person.id;
    card.setAttribute("aria-pressed", String(state.selectedPersonId === person.id));
    const art = document.createElement("div");
    art.className = "roster-portrait";
    art.innerHTML = portraitSvg(sample, 72);
    const name = document.createElement("div");
    name.className = "roster-name";
    name.textContent = person.name;
    const arch = document.createElement("div");
    arch.className = "roster-arch";
    arch.textContent = person.archetypeLabel;
    card.append(art, name, arch);
    card.addEventListener("click", () => selectPerson(person.id));
    el.appendChild(card);
  }
}

function selectPerson(personId) {
  state.selectedPersonId = personId;
  for (const card of document.querySelectorAll(".roster-card")) {
    card.setAttribute("aria-pressed", String(card.dataset.person === personId));
  }
  applyRating();
  $("chooser").hidden = false;
  savePrefs();
}

// One place that turns (person, rating) into the selected character, so the
// dropdown and the roster can never drift out of step.
function applyRating() {
  const personId = state.selectedPersonId;
  state.character =
    personId === "vanilla"
      ? { ...VANILLA_CHARACTER, elo: state.selectedElo }
      : characterFor(personId, state.selectedElo);
  syncRatingSelect();
  renderChooser();
}

function populateRatingSelect() {
  const sel = $("rating-select");
  sel.textContent = "";
  for (const elo of ELO_CHOICES) {
    const opt = document.createElement("option");
    opt.value = String(elo);
    // Age and rating are the same number seen two ways (100 Elo per year,
    // so a half-year is exactly one 50-point step). Showing both on one
    // line avoids two controls that could contradict each other.
    opt.textContent = `${formatAge(elo / 100)} years old — ${elo} Elo`;
    sel.appendChild(opt);
  }
  sel.value = String(state.selectedElo);
}

function syncRatingSelect() {
  const sel = $("rating-select");
  sel.value = String(state.selectedElo);
  const isVanilla = state.selectedPersonId === "vanilla";
  $("rating-note").textContent = isVanilla
    ? "Vanilla Maia plays like a human of this rating, with no personality layer."
    : "Younger is looser and more insistent on its own style; older is stronger and more disciplined.";
}

function renderChooser() {
  const c = state.character;
  if (!c) return;
  $("chooser-portrait").innerHTML = portraitSvg(c, 108);
  $("chooser-name").textContent = c.name;
  $("chooser-age").textContent = c.age === null ? "Maia-3" : `${c.ageLabel} years old`;
  $("chooser-elo").textContent = `${c.elo} Elo`;
  $("chooser-archetype").textContent = c.archetypeLabel;
  $("chooser-blurb").textContent = c.blurb;
  $("chooser-bio").textContent = c.bio || "";
  const list = $("chooser-tendencies");
  list.textContent = "";
  for (const t of c.tendencies) {
    const li = document.createElement("li");
    li.textContent = t;
    list.appendChild(li);
  }
}

function populateOpeningSelect() {
  const sel = $("opening-select");
  sel.textContent = "";
  for (const o of OPENING_CHOICES) {
    const opt = document.createElement("option");
    opt.value = o.id;
    opt.textContent = o.eco ? `${o.name} (${o.eco})` : o.name;
    sel.appendChild(opt);
  }
  sel.value = state.openingId;
  syncOpeningNote();
}

function syncOpeningNote() {
  const choice = OPENING_CHOICES.find((o) => o.id === $("opening-select").value);
  $("opening-note").textContent = choice ? choice.note : "";
}

$("rating-select").addEventListener("change", () => {
  state.selectedElo = Number($("rating-select").value);
  applyRating();
  savePrefs();
});

$("opening-select").addEventListener("change", () => {
  state.openingId = $("opening-select").value;
  syncOpeningNote();
  savePrefs();
});

for (const [id, value] of [["pick-white", "white"], ["pick-black", "black"], ["pick-random", "random"]]) {
  $(id).addEventListener("click", () => {
    state.colourChoice = value;
    for (const [otherId, otherValue] of [["pick-white", "white"], ["pick-black", "black"], ["pick-random", "random"]]) {
      $(otherId).setAttribute("aria-pressed", String(otherValue === value));
    }
    savePrefs();
  });
}

$("play-btn").addEventListener("click", async () => {
  if (!engine.ready) {
    const ok = await ensureModelLoaded();
    if (!ok) {
      $("select-status").textContent =
        "No model is loaded yet — open Advanced (⚙) and load one first.";
      $("advanced-dialog").showModal();
      return;
    }
  }
  startGame();
});

// ---- screen 2: the game ----------------------------------------------

function isHumanTurn() {
  return (chess.turn() === "w") === state.humanIsWhite;
}

function startGame() {
  chess.reset();
  engine.cancelPending("new game");
  engine.personality.reset();
  state.gameOver = false;
  state.awaitingEngine = false;
  state.resigned = null;
  state.analysis = null;
  state.session = null;
  state.evalCache.clear();
  state.gameReviewPly = null;

  state.humanIsWhite =
    state.colourChoice === "random" ? Math.random() < 0.5 : state.colourChoice === "white";

  state.director = new OpeningDirector(state.openingId);

  board.setLastMove(null, null);
  board.setCheckSquare(null);
  board.setArrows([]);
  board.setFlipped(!state.humanIsWhite);
  renderGamePosition();

  $("gameover-panel").hidden = true;
  $("opening-played").textContent = state.director.name ? state.director.name : "";
  renderMoveList();
  renderOpponentStrip();
  refreshStatus();
  showScreen("game");
  announce(`New game against ${state.character.name}. You are ${state.humanIsWhite ? "White" : "Black"}.`);
  maybeEngineMove();
}

function renderOpponentStrip() {
  const c = state.character;
  $("game-portrait").innerHTML = portraitSvg(c, 44);
  $("game-name").textContent = c.name;
  $("game-sub").textContent =
    c.age === null
      ? `${c.elo} Elo · no personality`
      : `${c.ageLabel} yrs · ${c.elo} Elo · ${c.archetypeLabel}`;
}

function statusText() {
  if (chess.isCheckmate()) return `Checkmate — ${chess.turn() === "w" ? "Black" : "White"} wins.`;
  if (chess.isStalemate()) return "Draw — stalemate.";
  if (chess.isThreefoldRepetition()) return "Draw — threefold repetition.";
  if (chess.isDrawByFiftyMoves()) return "Draw — fifty-move rule.";
  if (chess.isInsufficientMaterial()) return "Draw — insufficient material.";
  if (chess.isDraw()) return "Draw.";
  if (state.gameOver) return "Game over.";
  if (!state.engineEnabled) return `Engine off — ${chess.turn() === "w" ? "White" : "Black"} to move.`;
  if (!engine.ready) return "No model loaded.";
  if (state.awaitingEngine) return `${state.character.name} is thinking…`;
  return `${chess.turn() === "w" ? "White" : "Black"} to move${chess.isCheck() ? " — check" : ""}.`;
}

function displayedGamePly() {
  const len = chess.history().length;
  return state.gameReviewPly === null ? len : state.gameReviewPly;
}

function historicalPositionAtPly(ply) {
  const view = new Chess();
  const hist = chess.history();
  for (const san of hist.slice(0, ply)) {
    try { view.move(san); } catch { break; }
  }
  return view;
}

function renderGamePosition() {
  if (state.gameReviewPly === null) {
    board.bindInteraction(chess, {
      isMyTurn: () => {
        if (state.gameReviewPly !== null) return false;
        if (state.awaitingEngine || state.gameOver) return false;
        if (!state.engineEnabled) return true;
        return isHumanTurn() && engine.ready;
      },
    });
    const hist = chess.history({ verbose: true });
    const last = hist[hist.length - 1];
    board.setLastMove(last ? last.from : null, last ? last.to : null);
    updateCheckHighlight(chess);
    board.render(chess);
    return;
  }

  const view = historicalPositionAtPly(state.gameReviewPly);
  board.bindInteraction(view, { isMyTurn: () => false });
  const hist = view.history({ verbose: true });
  const last = hist[hist.length - 1];
  board.setLastMove(last ? last.from : null, last ? last.to : null);
  updateCheckHighlight(view);
  board.render(view);
}

function setGameReviewPly(ply) {
  const len = chess.history().length;
  if (!len) {
    state.gameReviewPly = null;
    renderGamePosition();
    return;
  }
  const clamped = Math.max(0, Math.min(len, Number.isFinite(ply) ? ply : len));
  state.gameReviewPly = clamped >= len ? null : clamped;
  renderGamePosition();
  renderMoveList();
  refreshStatus();
  updateGameNavControls();
}

function stepGameReview(delta) {
  const len = chess.history().length;
  const current = state.gameReviewPly === null ? len : state.gameReviewPly;
  setGameReviewPly(current + delta);
}

function updateGameNavControls() {
  const len = chess.history().length;
  const ply = displayedGamePly();
  const disabled = state.awaitingEngine || len === 0;
  $("game-nav-start").disabled = disabled || ply === 0;
  $("game-nav-prev").disabled = disabled || ply === 0;
  $("game-nav-next").disabled = disabled || ply >= len;
  $("game-nav-end").disabled = disabled || ply >= len;
}

function refreshStatus() {
  $("status-line").textContent = state.gameReviewPly !== null
    ? `Reviewing move ${state.gameReviewPly} of ${chess.history().length} — use the arrows below the board to return to the current game.`
    : statusText();
  $("status-line").classList.toggle("thinking", state.awaitingEngine);
  $("undo-move").disabled = chess.history().length === 0 || state.awaitingEngine || state.gameOver || state.gameReviewPly !== null;
  $("resign-btn").disabled = state.gameOver || state.gameReviewPly !== null;
  updateGameNavControls();
}

function updateCheckHighlight(position = chess) {
  if (position.isCheck()) {
    const mover = position.turn();
    let kingSq = null;
    for (const row of position.board()) {
      for (const cell of row) {
        if (cell && cell.type === "k" && cell.color === mover) kingSq = cell.square;
      }
    }
    board.setCheckSquare(kingSq);
  } else {
    board.setCheckSquare(null);
  }
}

function renderMoveList() {
  const hist = chess.history({ verbose: true });
  const el = $("move-list");
  el.textContent = "";
  const frag = document.createDocumentFragment();
  const selectedPly = displayedGamePly();
  for (let i = 0; i < hist.length; i += 2) {
    const num = document.createElement("span");
    num.className = "mv-num";
    num.textContent = i / 2 + 1 + ".";
    frag.appendChild(num);
    for (const [offset, ply] of [[0, hist[i]], [1, hist[i + 1]]]) {
      const plyIndex = i + offset + 1;
      const span = document.createElement("span");
      span.className = "mv";
      if (ply) {
        span.textContent = ply.san;
        if (plyIndex === selectedPly) span.classList.add("current");
      }
      frag.appendChild(span);
    }
  }
  el.appendChild(frag);
  if (state.gameReviewPly !== null) {
    const current = el.querySelector(".current");
    if (current) {
      const top = current.offsetTop - el.offsetTop;
      const bottom = top + current.offsetHeight;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
    }
  } else {
    el.scrollTop = el.scrollHeight;
  }
}

async function handleUserMove({ from, to, promotion }) {
  if (state.gameOver || state.gameReviewPly !== null) return;
  let move;
  try {
    move = chess.move({ from, to, promotion });
  } catch {
    announce("Illegal move.");
    return;
  }
  if (state.director) state.director.observe(chess);
  state.gameReviewPly = null;
  board.setLastMove(from, to);
  updateCheckHighlight(chess);
  board.render(chess);
  board.animateMove(from, to);
  renderMoveList();
  refreshStatus();
  announce(`You played ${move.san}.`);
  if (checkGameEnd()) return;
  await maybeEngineMove();
}

async function maybeEngineMove() {
  if (state.gameOver || chess.isGameOver() || isHumanTurn() || !engine.ready || !state.engineEnabled) return;
  state.awaitingEngine = true;
  refreshStatus();

  try {
    // The opening director gets first refusal for the first three plies.
    // It only ever offers a move that is legal here and consistent with
    // what has actually been played, so this cannot derail the game.
    let chosen = null;
    let viaBook = false;
    if (state.director && state.director.isActive()) {
      const san = state.director.moveFor(chess);
      if (san) {
        const verbose = chess.moves({ verbose: true }).find((m) => m.san === san);
        if (verbose) {
          chosen = { from: verbose.from, to: verbose.to, promotion: verbose.promotion, uci: verbose.from + verbose.to + (verbose.promotion || "") };
          viaBook = true;
        }
      }
    }

    let result = null;
    if (!chosen) {
      const c = state.character;
      const style = c.style;
      result = await engine.requestMove(chess, {
        selfElo: c.elo,
        oppoElo: state.oppoElo,
        temperature: state.temperature,
        topP: 1.0,
        multiPv: 5,
        presetId: c.archetype,
        strength: style.strength,
        breadth: style.breadth,
        maxOverrideNats: style.overrideNats,
        trapSearch: state.trapSearch && style.trapSearch,
        budgetMs: state.moveBudgetMs,
        // While the director is steering, the persona's own repertoire must
        // stand down so the two openings systems can't fight.
        usePresetBook: !(state.director && state.director.isActive()),
      });
      chosen = result.move;
    }

    if (!chosen) {
      state.awaitingEngine = false;
      refreshStatus();
      checkGameEnd();
      return;
    }

    const mv = chess.move({ from: chosen.from, to: chosen.to, promotion: chosen.promotion });
    if (!mv) throw new Error(`Engine proposed an illegal move: ${chosen.uci}`);
    if (state.director) state.director.observe(chess);
    state.gameReviewPly = null;
    board.setLastMove(chosen.from, chosen.to);
    updateCheckHighlight(chess);
    board.render(chess);
    board.animateMove(chosen.from, chosen.to);
    renderMoveList();
    renderThinkingNote(viaBook, result);
    announce(`${state.character.name} played ${mv.san}.`);
  } catch (err) {
    if (err instanceof EngineCancelledError) return; // a new game superseded this
    console.error(err);
    announce("The engine hit an error: " + err.message);
    $("status-line").textContent = "Engine error: " + err.message;
  } finally {
    state.awaitingEngine = false;
    refreshStatus();
    checkGameEnd();
  }
}

function renderThinkingNote(viaBook, result) {
  const note = $("thinking-note");
  if (!state.showThinking) {
    note.hidden = true;
    return;
  }
  if (viaBook) {
    note.textContent = `Opening: ${state.director.name} (book move)`;
    note.hidden = false;
    return;
  }
  const report = engine.lastMoveReport || {};
  const info = result && result.personality;
  const bits = [`${Math.round(report.ms || 0)}ms`, report.mode];
  if (info) {
    bits.push(`Maia #${info.policyRank}`);
    bits.push(`pull ${info.pull >= 0 ? "+" : ""}${info.pull.toFixed(2)}`);
    bits.push(`gate ${info.soundness.toFixed(2)}`);
    if (info.inBook) bits.push("repertoire");
    if (info.trapValue) bits.push(`trap ${info.trapValue.toFixed(2)}`);
    if (info.top && info.top.length) bits.push(info.top.map((d) => d.id).join("/"));
  } else if (report.reason) {
    bits.push(report.reason);
  }
  note.textContent = bits.join(" · ");
  note.hidden = false;
}

function checkGameEnd() {
  if (!chess.isGameOver()) return false;
  state.gameOver = true;
  refreshStatus();
  let title = "Game over";
  let detail = statusText();
  if (chess.isCheckmate()) {
    const humanWon = (chess.turn() === "w") !== state.humanIsWhite ? false : true;
    // chess.turn() is the side that is mated.
    const matedIsHuman = (chess.turn() === "w") === state.humanIsWhite;
    title = matedIsHuman ? `${state.character.name} wins` : "You win";
    detail = `Checkmate. ${matedIsHuman ? state.character.name + " delivered mate." : "You delivered mate."}`;
    void humanWon;
  } else {
    title = "Draw";
  }
  $("gameover-title").textContent = title;
  $("gameover-detail").textContent = detail;
  $("gameover-panel").hidden = false;
  announce(title);
  return true;
}

$("new-game").addEventListener("click", () => startGame());
$("rematch-btn").addEventListener("click", () => startGame());
$("change-opponent-btn").addEventListener("click", () => {
  engine.cancelPending("left game");
  showScreen("select");
});
$("back-to-select").addEventListener("click", () => {
  engine.cancelPending("left game");
  showScreen("select");
});
$("flip-board").addEventListener("click", () => board.setFlipped(!board.flipped));
$("resign-btn").addEventListener("click", () => {
  if (state.gameOver) return;
  state.gameOver = true;
  state.resigned = state.humanIsWhite ? "w" : "b";
  $("gameover-title").textContent = `${state.character.name} wins`;
  $("gameover-detail").textContent = "You resigned.";
  $("gameover-panel").hidden = false;
  refreshStatus();
});
$("engine-toggle").addEventListener("click", () => {
  state.engineEnabled = !state.engineEnabled;
  $("engine-toggle").setAttribute("aria-pressed", String(state.engineEnabled));
  $("engine-toggle").textContent = "Engine: " + (state.engineEnabled ? "On" : "Off");
  refreshStatus();
  if (state.engineEnabled) maybeEngineMove();
});
$("undo-move").addEventListener("click", () => {
  if (state.awaitingEngine || state.gameOver) return;
  const toUndo = !isHumanTurn() ? 1 : 2;
  for (let i = 0; i < toUndo && chess.history().length > 0; i++) chess.undo();
  // The director is a function of the moves actually on the board, so it is
  // rebuilt rather than rewound — no stale opening state can survive.
  if (state.director && state.director.opening) {
    state.director = new OpeningDirector(state.director.opening.id);
    state.director.observe(chess);
  }
  board.setLastMove(null, null);
  updateCheckHighlight();
  board.render(chess);
  renderMoveList();
  $("thinking-note").hidden = true;
  refreshStatus();
  announce("Move undone.");
});
$("show-thinking").addEventListener("change", () => {
  state.showThinking = $("show-thinking").checked;
  if (!state.showThinking) $("thinking-note").hidden = true;
  savePrefs();
});
$("oppo-elo").addEventListener("input", () => {
  state.oppoElo = Number($("oppo-elo").value);
  $("oppo-elo-val").textContent = state.oppoElo;
  savePrefs();
});
$("open-game-settings").addEventListener("click", () => {
  const d = $("game-settings");
  d.open = !d.open;
  if (typeof d.scrollIntoView === "function") {
    try {
      d.scrollIntoView({ block: "nearest" });
    } catch {
      /* ignore */
    }
  }
});

// ---- screen 3: analysis ----------------------------------------------

$("analyze-btn").addEventListener("click", () => startAnalysis());
$("analysis-back").addEventListener("click", () => leaveAnalysis());
$("analysis-close").addEventListener("click", () => leaveAnalysis());
$("analysis-cancel").addEventListener("click", () => stopAnalysis());

// ---- analysis phase: ONE writer for the progress panel -----------------
//
// The panel used to be written from several places independently, and
// stopAnalysis() wrote "Stopping…" and disabled the button unconditionally
// -- even when no run was in progress. That left the panel permanently
// showing "Stopping…" with a dead Stop button and no way back, which is
// exactly the stuck state that was reported.
//
// Now every transition goes through setAnalysisPhase(), so the panel can
// only ever show a state the app is actually in.
function setAnalysisPhase(phase, text = "") {
  state.analysisPhase = phase;
  const progress = $("analysis-progress");
  const cancel = $("analysis-cancel");
  const label = $("analysis-progress-text");
  switch (phase) {
    case "running":
      progress.hidden = false;
      cancel.disabled = false;
      cancel.textContent = "Stop";
      label.textContent = text || "Analysing…";
      break;
    case "stopping":
      progress.hidden = false;
      cancel.disabled = true;
      label.textContent = "Stopping…";
      break;
    case "done":
    case "idle":
    default:
      progress.hidden = true;
      cancel.disabled = false;
      cancel.textContent = "Stop";
      label.textContent = "";
      break;
  }
}

// Stop must be immediate. Setting a flag alone was not enough: the run was
// parked inside a batch of worker calls, so the flag was only noticed at
// the end of the position (seconds later, on a slow phone). Cancelling the
// in-flight engine calls unblocks it at once, and the flag then stops the
// loop before it starts another position.
function stopAnalysis() {
  state.analysisCancel = true;
  engine.cancelPending("analysis stopped");

  // Nothing running? Then there is nothing to stop, and showing "Stopping…"
  // would strand the panel in a state the app can never leave.
  if (!state.analysisRunning) {
    setAnalysisPhase("done");
    return;
  }

  setAnalysisPhase("stopping");

  // Watchdog. Cancelling should settle the run within a moment, but if the
  // engine is wedged badly enough that it never does, the UI must still
  // come back rather than sit on "Stopping…" forever.
  clearTimeout(state.stopWatchdog);
  state.stopWatchdog = setTimeout(() => {
    if (!state.analysisRunning) return;
    console.warn("Analysis did not settle after Stop; forcing the UI back.");
    state.analysisRunning = false;
    engine.restart().catch(() => {});
    setAnalysisPhase("done");
    $("analysis-body").hidden = false;
  }, 4000);
}

function leaveAnalysis() {
  stopAnalysis();
  showScreen("game");
}

function ensureAnalysisBoard() {
  if (analysisBoard) return analysisBoard;
  analysisBoard = new Board($("analysis-board"), {
    onUserMove: handleVariationMove,
    announce,
  });
  analysisBoard.bindInteraction(new Chess(), { isMyTurn: () => true });
  return analysisBoard;
}

async function startAnalysis() {
  try {
    await analysisEngine.ensureReady();
  } catch (err) {
    console.error(err);
    announce("Stockfish could not be loaded. Run the desktop launcher once to download the local engine, or rebuild the APK so the engine is bundled.");
    return;
  }
  const sanHistory = chess.history();
  if (!sanHistory.length) {
    announce("Nothing to analyse yet.");
    return;
  }
  if (state.analysisRunning) return;

  clearTimeout(state.stopWatchdog);
  state.analysisCancel = false;
  state.analysisRunning = true;
  state.analysis = null;
  state.evalCache.clear();
  showScreen("analysis");
  $("analysis-body").hidden = true;
  $("analysis-fill").style.width = "0%";
  $("analysis-sub").textContent = "Stockfish 18 • depth 15";
  setAnalysisPhase("running", `Analysing 0 / ${sanHistory.length}…`);

  let result;
  try {
    result = await analyseGame(analysisEngine, sanHistory, {
      elo: ANALYSIS_ELO,
      shouldStop: () => state.analysisCancel,
      onProgress: ({ done, total }) => {
        $("analysis-fill").style.width = (done / total) * 100 + "%";
        // Only relabel while genuinely running: once Stop has been pressed
        // the panel says "Stopping…" and must not flicker back.
        if (state.analysisPhase === "running") {
          $("analysis-progress-text").textContent = `Analysing ${done} / ${total}…`;
        }
      },
    });
  } catch (err) {
    console.error(err);
    result = { nodes: [], cancelled: true, error: err, summary: null };
  } finally {
    // Whatever happened -- finished, stopped, or threw -- the run is over
    // and the panel must reflect that. This is the only place that clears
    // `analysisRunning`, so it cannot be left set.
    state.analysisRunning = false;
    clearTimeout(state.stopWatchdog);
    setAnalysisPhase("done");
    $("analysis-body").hidden = false;
  }

  state.analysis = result;

  if (result.error && !(result.error instanceof EngineCancelledError)) {
    announce("Analysis stopped early: " + result.error.message);
  }
  if (!result.nodes.length) {
    // Nothing usable (stopped immediately, or the engine failed on ply 1).
    $("context-label").textContent = "Analysis stopped before any position was evaluated.";
    return;
  }
  if (result.cancelled) {
    const done = result.nodes.filter((n) => n.classification).length;
    $("analysis-sub").textContent = `Stopped after ${done} of ${sanHistory.length} moves`;
  }

  state.session = new VariationSession(sanHistory);
  state.variationReviewCache.clear();
  state.session.goToPly(0); // start at move 1, the way a game review opens
  ensureAnalysisBoard();
  analysisBoard.setFlipped(!state.humanIsWhite);
  renderSummary();
  renderAnalysisMoveList();
  await refreshAnalysisView();
}

const nodeAt = (ply) => {
  const nodes = (state.analysis && state.analysis.nodes) || [];
  return nodes[ply] || null;
};

function renderSummary() {
  const s = (state.analysis && state.analysis.summary) || null;
  const accRow = $("accuracy-row");
  accRow.textContent = "";
  const grid = $("summary-grid");
  grid.textContent = "";
  if (!s) return;

  const labelFor = (side) =>
    side === "w"
      ? state.humanIsWhite ? "You (White)" : `${state.character.name} (White)`
      : state.humanIsWhite ? `${state.character.name} (Black)` : "You (Black)";

  for (const side of ["w", "b"]) {
    const card = document.createElement("div");
    card.className = "accuracy-card";
    const who = document.createElement("div");
    who.className = "accuracy-who";
    who.textContent = labelFor(side);
    const val = document.createElement("div");
    val.className = "accuracy-value";
    val.textContent = s[side].moves ? `${s[side].accuracy.toFixed(1)}%` : "—";
    const sub = document.createElement("div");
    sub.className = "accuracy-sub";
    sub.textContent = s[side].moves ? `accuracy · ${s[side].moves} moves` : "no moves";
    card.append(who, val, sub);
    accRow.appendChild(card);
  }

  // Header row of class names, then one row per side.
  const corner = document.createElement("div");
  corner.className = "summary-name";
  grid.appendChild(corner);
  for (const kind of CLASSES) {
    const h = document.createElement("div");
    h.className = "summary-head cls-" + kind;
    h.textContent = CLASS_LABEL[kind];
    grid.appendChild(h);
  }
  for (const side of ["w", "b"]) {
    const name = document.createElement("div");
    name.className = "summary-name";
    name.textContent = side === "w" ? "White" : "Black";
    grid.appendChild(name);
    for (const kind of CLASSES) {
      const cell = document.createElement("div");
      cell.className = "summary-cell cls-" + kind;
      cell.textContent = String(s[side][kind] || 0);
      grid.appendChild(cell);
    }
  }
}

function renderAnalysisMoveList() {
  const el = $("analysis-move-list");
  el.textContent = "";
  const nodes = ((state.analysis && state.analysis.nodes) || []).filter((n) => n.ply);
  const frag = document.createDocumentFragment();
  for (let i = 0; i < nodes.length; i += 2) {
    const num = document.createElement("span");
    num.className = "mv-num";
    num.textContent = i / 2 + 1 + ".";
    frag.appendChild(num);
    for (const n of [nodes[i], nodes[i + 1]]) {
      const span = document.createElement("span");
      span.className = "mv";
      if (n) {
        span.textContent = n.san;
        span.classList.add("cls-" + n.classification);
        span.dataset.ply = String(n.ply);
        span.title = `${CLASS_LABEL[n.classification]} · ${n.accuracy.toFixed(0)}% accurate`;
        span.tabIndex = 0;
        span.setAttribute("role", "button");
        const jump = () => {
          state.session.goToPly(n.ply);
          refreshAnalysisView();
        };
        span.addEventListener("click", jump);
        span.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            jump();
          }
        });
      }
      frag.appendChild(span);
    }
  }
  el.appendChild(frag);
}

function handleVariationMove({ from, to, promotion }) {
  if (!state.session) return;
  const played = state.session.play({ from, to, promotion });
  if (!played) {
    announce("Illegal move.");
    return;
  }

  // Analysis exploration is deliberately HUMAN-CONTROLLED. Playing a move
  // in a variation must NEVER make the engine play the opponent's move.
  // Instead, refresh the position and show the engine's best reply as an
  // arrow/evaluation only. The original game line remains immutable.
  refreshAnalysisView();
}

// The game engine and the analysis engine are the same local Maia worker, but
// analysis must remain usable even though the game itself is over. A game-over
// state must never be treated as "engine off" for analysis purposes. If a
// worker was recovered/restarted between the review pass and a later variation,
// transparently bring the selected model back before evaluating the position.
async function ensureAnalysisEngineReady() {
  // Do not trust the UI/game `engineEnabled` flag or the cached `ready` bit.
  // Analysis is an independent capability and must remain available after a
  // finished game. First verify the actual worker+model are alive.
  if (engine.ready && !engine.needsRecovery) {
    const healthy = await engine.healthCheck();
    if (healthy) return true;
    console.warn("Analysis worker health check failed; recovering the engine.");
  }

  if (engine.needsRecovery || !engine.ready) {
    try {
      const recovered = await engine.restart();
      if (recovered && engine.ready && (await engine.healthCheck())) return true;
    } catch (err) {
      console.warn("Could not recover the analysis engine:", err);
    }
  }

  try {
    const loaded = await ensureModelLoaded();
    if (!loaded || !engine.ready) return false;
    return await engine.healthCheck();
  } catch (err) {
    console.warn("Could not reload the analysis model:", err);
    return false;
  }
}

// Evaluations are cached by position AND complete Maia history. A bare FEN is
// not sufficient because Maia-3 is history-conditioned: the same board reached
// through different move histories can legitimately have different inputs.
async function evaluateCached(board) {
  const fen = board.fen();
  const historyKey = board.history().join(" ");
  const cacheKey = historyKey + "\n" + fen;
  if (state.evalCache.has(cacheKey)) return state.evalCache.get(cacheKey);
  if (!(await analysisEngine.healthCheck())) {
    throw new Error("The Stockfish analysis engine is not available.");
  }
  const result = await analysisEngine.evaluate(board, {
    topK: 3,
    depth: 15,
    shouldStop: () => state.analysisCancel,
  });
  state.evalCache.set(cacheKey, result);
  return result;
}

function historyCacheKey(board) {
  return board.history().join(" ") + "\n" + board.fen();
}

function rebuildFromHistory(history) {
  const board = new Chess();
  for (const san of history) board.move(san);
  return board;
}

async function evaluateVariationMove(parentBoard, move, parentState) {
  // Parent evaluation: best move + opponent best reply, exactly the same
  // horizon used by the game-analysis pipeline.
  let parentEval = parentState?.evaluation || null;
  let parentBestUci = parentState?.bestUci || null;
  let parentBestPositionCp = parentState?.bestPositionCp ?? null;
  let parentBestChildEval = parentState?.bestChildEval || null;
  let parentBestChild = parentState?.bestChild || null;

  if (!parentEval) {
    parentEval = await evaluateCached(parentBoard);
    const best = parentEval.moves?.[0];
    parentBestUci = best?.uci || null;
    if (best) {
      parentBestChild = rebuildFromHistory(parentBoard.history());
      parentBestChild.move({
        from: best.from,
        to: best.to,
        promotion: best.promotion || undefined,
      });
      if (parentBestChild.isCheckmate()) {
        parentBestPositionCp = 1000;
        parentBestChildEval = null;
      } else if (parentBestChild.isGameOver()) {
        parentBestPositionCp = 0;
        parentBestChildEval = null;
      } else {
        parentBestChildEval = await evaluateCached(parentBestChild);
        const replyCp = parentBestChildEval.moves?.[0]?.cp ?? 0;
        parentBestPositionCp = -replyCp;
      }
    }
  }

  const moveUci = move.from + move.to + (move.promotion || "");
  const isBest = !!parentBestUci && moveUci === parentBestUci;

  let child = rebuildFromHistory(parentBoard.history());
  child.move({
    from: move.from,
    to: move.to,
    promotion: move.promotion || undefined,
  });

  let childEval = null;
  let childReplyCp = null;

  if (child.isCheckmate()) {
    childReplyCp = 1000;
  } else if (child.isGameOver()) {
    childReplyCp = 0;
  } else {
    // This result is also the best-reply probe for the NEW current position,
    // so we can immediately cache its best move/value for the next variation
    // ply.
    if (isBest && parentBestChildEval) {
      childEval = parentBestChildEval;
    } else {
      childEval = await evaluateCached(child);
    }
    childReplyCp = childEval.moves?.[0]?.cp ?? 0;
  }

  // Lichess-style position analysis: compare the actual Stockfish score of the
  // current position with the actual Stockfish score of the resulting position.
  // The engine's #1 move is used only to classify the move / draw the arrow; it
  // must not substitute a best-continuation score for either position.
  const playedPositionCp = child.isCheckmate()
    ? (child.turn() === "w" ? -1000 : 1000)
    : child.isGameOver()
      ? 0
      : -childReplyCp;

  const parentPositionCp = parentEval?.positionCp ?? 0;
  const winBeforeStm = winPctFromCp(parentPositionCp);
  const winAfterStm = winPctFromCp(playedPositionCp);
  const drop = Math.max(0, winBeforeStm - winAfterStm);

  const mover = parentBoard.turn();
  const bestWinWhite = mover === "w" ? winBeforeStm : 100 - winBeforeStm;
  const rawPostMoveWinWhite = mover === "w" ? winAfterStm : 100 - winAfterStm;
  // The variation graph is position-based just like the main review:
  // always show the actual resulting position's Win%.
  const nextTimelineWinWhite = rawPostMoveWinWhite;

  // Prepare the review state for the NEXT variation ply.
  //
  // `childEval` is an evaluation OF THE CURRENT VARIATION POSITION. Its top
  // move is the next engine arrow, but `bestChildEval` must be the evaluation
  // AFTER THAT top move. The previous implementation stored `child` itself as
  // `bestChild`, which made the next ply reuse the previous position's
  // evaluation. That is why the arrow became stuck after the second
  // variation move.
  let nextBestUci = null;
  let nextBestPositionCp = null;
  let nextBestChildEval = null;
  let nextBestChild = null;

  if (!child.isGameOver() && childEval?.moves?.[0]) {
    const nextBest = childEval.moves[0];
    nextBestUci = nextBest.uci;

    nextBestChild = rebuildFromHistory(child.history());
    nextBestChild.move({
      from: nextBest.from,
      to: nextBest.to,
      promotion: nextBest.promotion || undefined,
    });

    if (nextBestChild.isCheckmate()) {
      nextBestPositionCp = 1000;
      nextBestChildEval = null;
    } else if (nextBestChild.isGameOver()) {
      nextBestPositionCp = 0;
      nextBestChildEval = null;
    } else {
      nextBestChildEval = await evaluateCached(nextBestChild);
      const nextReplyCp = nextBestChildEval.moves?.[0]?.cp ?? 0;
      nextBestPositionCp = -nextReplyCp;
    }
  }

  return {
    evaluation: childEval || parentEval,
    bestUci: nextBestUci,
    bestPositionCp: nextBestPositionCp,
    bestChildEval: nextBestChildEval,
    bestChild: nextBestChild,
    timelineWinWhite: nextTimelineWinWhite,
    moveDrop: drop,
    isBest,
    child,
  };
}

async function refreshAnalysisView() {
  const session = state.session;
  if (!session) return;
  const b = ensureAnalysisBoard();
  b.bindInteraction(session.board, { isMyTurn: () => true });
  b.render(session.board);
  updateAnalysisCheckHighlight();

  $("context-label").textContent = session.describe();
  $("back-to-game-line").hidden = !session.inVariation;
  $("analysis-board").closest(".board-with-bar").classList.toggle("exploring", session.inVariation);
  highlightCurrentPly();

  if (!session.inVariation) {
    const node = nodeAt(session.basePly);
    if (node) {
      setEvalBar(node.evalWhite, node.winWhite, node.mate);
      renderStoredArrows(node);
      renderMoveDetail(node);
      state.pendingEvalToken++;
      return;
    }
  }

  const token = ++state.pendingEvalToken;
  setEvalBarPending();

  try {
    if (session.board.isCheckmate()) {
      const cpWhite = session.board.turn() === "w" ? -1000 : 1000;
      const winWhite = cpWhite > 0 ? 100 : 0;
      if (token === state.pendingEvalToken) setEvalBar(cpWhite, winWhite, true);
      renderLiveArrows({ moves: [] });
      renderVariationDetail({ moves: [] });
      return;
    }

    const evaluation = await evaluateCached(session.board);
    if (token !== state.pendingEvalToken || state.screen !== "analysis") return;

    const cpSide = evaluation.positionCp ?? evaluation.moves?.[0]?.cp ?? 0;
    const rawCpWhite = session.board.turn() === "w" ? cpSide : -cpSide;
    const displayWinWhite = winPctFromCp(rawCpWhite);
    const displayCpWhite = rawCpWhite;
    setEvalBar(displayCpWhite, displayWinWhite, false);
    renderLiveArrows(evaluation);
    renderVariationDetail(evaluation);
  } catch (err) {
    if (!(err instanceof EngineCancelledError)) {
      console.warn("Analysis variation evaluation failed:", err);
      setEvalBar(null, 50, false);
      renderLiveArrows({ moves: [] });
      renderVariationDetail({ moves: [] });
    }
  }
}

function updateAnalysisCheckHighlight() {
  const b = analysisBoard;
  const g = state.session.board;
  if (g.isCheck()) {
    const mover = g.turn();
    let kingSq = null;
    for (const row of g.board()) {
      for (const cell of row) {
        if (cell && cell.type === "k" && cell.color === mover) kingSq = cell.square;
      }
    }
    b.setCheckSquare(kingSq);
  } else {
    b.setCheckSquare(null);
  }
}

function setEvalBar(cpWhite, winWhite, mate = false) {
  const share = evalToWhiteShare(winWhite);
  $("eval-white").style.height = share * 100 + "%";
  $("eval-bar").classList.remove("pending");
  $("eval-number").textContent = formatEval(cpWhite, { mate, winWhite });
  $("eval-number").classList.toggle("black-ahead", winWhite < 50);
}

function setEvalBarPending() {
  $("eval-bar").classList.add("pending");
}

// Two arrows, straight from the timeline: green for the engine's move,
// yellow for the move actually played. When they are the same move only
// the green one is drawn, since a doubled arrow just reads as a mistake.
function renderStoredArrows(node) {
  if (!state.showArrows || !node || !node.uci) {
    analysisBoard.setArrows([]);
    return;
  }
  const arrows = [];
  if (node.bestUci) {
    arrows.push({ from: node.bestUci.slice(0, 2), to: node.bestUci.slice(2, 4), kind: "best" });
  }
  if (node.uci && node.uci !== node.bestUci) {
    arrows.push({ from: node.uci.slice(0, 2), to: node.uci.slice(2, 4), kind: "played" });
  }
  analysisBoard.setArrows(arrows);
}

function renderLiveArrows(evaluation) {
  if (!state.showArrows || !evaluation || !evaluation.moves.length) {
    analysisBoard.setArrows([]);
    return;
  }
  const best = evaluation.moves[0];
  analysisBoard.setArrows([{ from: best.from, to: best.to, kind: "best" }]);
}

function renderMoveDetail(node) {
  const el = $("detail-grid");
  el.textContent = "";
  const add = (label, value, cls) => {
    const l = document.createElement("span");
    l.className = "detail-label";
    l.textContent = label;
    const v = document.createElement("span");
    v.className = "detail-value" + (cls ? " " + cls : "");
    v.textContent = value;
    el.append(l, v);
  };

  const session = state.session;
  if (session.basePly === 0 && !node.ply) {
    add("Position", "Start of the game");
    return;
  }
  // The move played FROM the position now on the board.
  if (node.ply) {
    add("Move", plyLabel(node.ply, node.san));
    add("Verdict", CLASS_LABEL[node.classification], "cls-" + node.classification);
    add("Accuracy", `${node.accuracy.toFixed(0)}%`);
    if (node.bestSan && node.bestSan !== node.san) add("Engine plays", node.bestSan);
    if (node.drop >= 1) add("Win% lost", node.drop.toFixed(1));
    if (node.alternatives && node.alternatives.length) {
      add("Top moves", node.alternatives.map((a) => a.san).join(", "));
    }
  } else {
    // Final position: no outgoing move.
    const prev = nodeAt(session.basePly - 1);
    add("Position", "Final position");
    if (prev && prev.san) add("Last move", plyLabel(prev.ply, prev.san));
  }
}

function renderVariationDetail(evaluation) {
  const el = $("detail-grid");
  el.textContent = "";
  const add = (label, value) => {
    const l = document.createElement("span");
    l.className = "detail-label";
    l.textContent = label;
    const v = document.createElement("span");
    v.className = "detail-value";
    v.textContent = value;
    el.append(l, v);
  };
  add("Line", state.session.variation.join(" ") || "—");
  if (evaluation.moves.length) add("Engine plays", evaluation.moves.map((m) => m.san).join(", "));
}

function highlightCurrentPly() {
  const ply = state.session.basePly;
  let current = null;
  for (const el of document.querySelectorAll("#analysis-move-list .mv")) {
    el.classList.toggle("current", !state.session.inVariation && Number(el.dataset.ply) === ply);
    if (el.classList.contains("current")) current = el;
  }
  scrollMoveIntoView(current);
}

// Keep the current move visible INSIDE the move list, by moving that
// element's own scrollTop -- never with scrollIntoView().
//
// scrollIntoView scrolls every scrollable ancestor, including the page. The
// move list sits below the board, so pressing Next yanked the whole screen
// down to the list and the board disappeared off the top. Scrolling the
// container directly keeps the board exactly where it is.
function scrollMoveIntoView(el) {
  if (!el) return;
  const list = $("analysis-move-list");
  if (!list || typeof list.scrollTop !== "number") return;
  const top = el.offsetTop - list.offsetTop;
  const bottom = top + el.offsetHeight;
  if (top < list.scrollTop) {
    list.scrollTop = top;
  } else if (bottom > list.scrollTop + list.clientHeight) {
    list.scrollTop = bottom - list.clientHeight;
  }
}

$("game-nav-start").addEventListener("click", () => setGameReviewPly(0));
$("game-nav-prev").addEventListener("click", () => stepGameReview(-1));
$("game-nav-next").addEventListener("click", () => stepGameReview(1));
$("game-nav-end").addEventListener("click", () => setGameReviewPly(chess.history().length));

$("nav-start").addEventListener("click", () => {
  state.session.goToPly(0);
  refreshAnalysisView();
});
$("nav-prev").addEventListener("click", () => {
  state.session.stepBack();
  refreshAnalysisView();
});
$("nav-next").addEventListener("click", () => {
  state.session.stepForward();
  refreshAnalysisView();
});
$("nav-end").addEventListener("click", () => {
  state.session.goToPly(state.session.gameHistory.length);
  refreshAnalysisView();
});
$("back-to-game-line").addEventListener("click", () => {
  state.session.backToGame();
  refreshAnalysisView();
});
$("toggle-arrows").addEventListener("click", () => {
  state.showArrows = !state.showArrows;
  $("toggle-arrows").setAttribute("aria-pressed", String(state.showArrows));
  $("arrow-legend").hidden = !state.showArrows;
  refreshAnalysisView();
});

// Keyboard navigation, which is what anyone reviewing a game reaches for.
window.addEventListener("keydown", (ev) => {
  if (state.screen !== "analysis" || !state.session) return;
  if (ev.target && /^(INPUT|SELECT|TEXTAREA)$/.test(ev.target.tagName)) return;
  const map = {
    ArrowLeft: () => state.session.stepBack(),
    ArrowRight: () => state.session.stepForward(),
    Home: () => state.session.goToPly(0),
    End: () => state.session.goToPly(state.session.gameHistory.length),
  };
  const fn = map[ev.key];
  if (!fn) return;
  ev.preventDefault();
  fn();
  refreshAnalysisView();
});

// ---- PGN export -------------------------------------------------------

function currentPgn({ annotated = false } = {}) {
  const c = state.character;
  const you = "You";
  const them = c.age === null ? `Maia-3 ${c.elo}` : `${c.name} (${c.ageLabel}, ${c.elo})`;
  return toPgn({
    sanHistory: chess.history(),
    // Games always start from the initial array today, but passing it
    // explicitly means a future "set up a position" feature writes a
    // correct SetUp/FEN header instead of an unreadable file.
    startFen: state.startFen,
    white: state.humanIsWhite ? you : them,
    black: state.humanIsWhite ? them : you,
    result: resultOf(chess, { resigned: state.resigned }),
    event: c.age === null ? "Maia-3" : `Maia-3 vs ${c.name}`,
    extraTags: {
      WhiteElo: state.humanIsWhite ? String(state.oppoElo) : String(c.elo),
      BlackElo: state.humanIsWhite ? String(c.elo) : String(state.oppoElo),
      Opening: state.director && state.director.name ? state.director.name : "?",
      Annotator: annotated ? `Maia-3 ${ANALYSIS_ELO}` : "",
    },
    nodes: annotated && state.analysis ? state.analysis.nodes : null,
    includeAnnotations: annotated,
  });
}

// Share sheet where there is one (that is what a phone user expects), with
// a file download as the fallback, and a clipboard copy if neither works.
async function exportPgn({ annotated = false } = {}) {
  if (!chess.history().length) {
    announce("There are no moves to export yet.");
    return;
  }
  const pgn = currentPgn({ annotated });
  const name = `maia3-${new Date().toISOString().slice(0, 10)}${annotated ? "-analysed" : ""}.pgn`;

  try {
    const file = new File([pgn], name, { type: "application/x-chess-pgn" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: "Maia3 game" });
      announce("Game shared.");
      return;
    }
  } catch (err) {
    if (err && err.name === "AbortError") return; // the user dismissed the sheet
    console.info("Share unavailable, falling back to download:", err);
  }

  try {
    const url = URL.createObjectURL(new Blob([pgn], { type: "application/x-chess-pgn" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    announce("PGN saved.");
    return;
  } catch (err) {
    console.info("Download unavailable, falling back to clipboard:", err);
  }

  try {
    await navigator.clipboard.writeText(pgn);
    announce("PGN copied to the clipboard.");
  } catch {
    announce("Could not export the PGN on this device.");
  }
}

$("export-pgn-inline").addEventListener("click", () => exportPgn());

// ---- advanced dialog: models -----------------------------------------

function populateModelSelect() {
  const sel = $("model-select");
  sel.textContent = "";
  for (const m of MODEL_CATALOG) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = `${m.label} — ${m.note}`;
    sel.appendChild(opt);
  }
  const last = localStorage.getItem(LAST_MODEL_KEY);
  if (last && MODEL_CATALOG.some((m) => m.id === last)) sel.value = last;
}

const currentModel = () => MODEL_CATALOG.find((m) => m.id === $("model-select").value) || MODEL_CATALOG[0];

function setEngineStatus(text, ready) {
  $("engine-status").querySelector(".status-text").textContent = text;
  $("engine-status").classList.toggle("ready", !!ready);
}

function showProgress(loaded, total, indeterminate) {
  $("load-progress-track").hidden = false;
  const fill = $("load-progress-fill");
  if (indeterminate || !total) {
    fill.style.width = "100%";
    fill.classList.add("indeterminate");
  } else {
    fill.classList.remove("indeterminate");
    fill.style.width = Math.min(100, (loaded / total) * 100) + "%";
  }
}
function hideProgress() {
  $("load-progress-track").hidden = true;
  $("load-progress-fill").classList.remove("indeterminate");
}

const fmtMB = (bytes) => (bytes / (1024 * 1024)).toFixed(0) + " MB";

async function refreshStorageEstimate() {
  const est = await idb.estimateStorage();
  $("storage-estimate").textContent = est
    ? `${fmtMB(est.usage)} used of ${fmtMB(est.quota)} available.`
    : "Not reported by this browser.";
}

async function ensureModelLoaded() {
  if (engine.ready) return true;
  const model = currentModel();
  if (await engine.isCached(model.id)) {
    try {
      await engine.loadFromCache(model.id);
      onModelReady(model, true);
      return true;
    } catch (err) {
      console.warn(err);
    }
  }
  return false;
}

async function loadModel(model, { forceFile = false } = {}) {
  setEngineStatus("Loading…", false);
  $("load-model-btn").disabled = true;
  $("load-progress").textContent = "";
  try {
    if (engine.ready && engine.loadedModelId !== model.id) await engine.unload();

    if (!forceFile && (await engine.isCached(model.id))) {
      showProgress(0, 0, true);
      await engine.loadFromCache(model.id);
      hideProgress();
      onModelReady(model, true);
      return;
    }
    if (!forceFile) {
      try {
        const result = await engine.loadFromBundled(model.id, model.file, {
          onProgress: ({ loaded, total, indeterminate }) => showProgress(loaded, total, indeterminate),
        });
        hideProgress();
        onModelReady(model, result.cached);
        return;
      } catch (err) {
        if (!(err instanceof WeightsFetchError)) throw err;
        console.info(`${model.file} not found (${err.message}); offering the file picker.`);
      }
    }
    hideProgress();
    setEngineStatus("Model file missing", false);
    $("load-progress").textContent =
      `${model.label} isn't installed. ${model.file.replace("./", "")} is missing from this app's ` +
      `weights/ folder — copy it in, or pick the .bin from this device below.`;
    $("weights-file").click();
  } catch (err) {
    console.error(err);
    hideProgress();
    setEngineStatus("Load failed", false);
    $("load-progress").textContent = describeLoadError(err, model);
  } finally {
    $("load-model-btn").disabled = false;
  }
}

function describeLoadError(err, model) {
  const msg = String(err && err.message ? err.message : err);
  if (/allocat|out of memory|Array buffer|RangeError/i.test(msg)) {
    return `This device couldn't allocate enough memory for ${model.label}. Try Maia-3 5M — the app stays usable.`;
  }
  return `Could not load ${model.label}: ${msg}`;
}

function onModelReady(model, cached = true) {
  setEngineStatus(`${model.label} ready`, true);
  $("load-progress").textContent = cached
    ? `${model.label} is cached on this device and will load offline from now on.`
    : `${model.label} is ready for this session (it couldn't be cached).`;
  $("select-status").textContent = `${model.label} loaded.`;
  try {
    localStorage.setItem(LAST_MODEL_KEY, model.id);
  } catch {
    /* private mode */
  }
  refreshStorageEstimate();
  refreshStatus();
}

$("load-model-btn").addEventListener("click", () => loadModel(currentModel()));
$("open-advanced").addEventListener("click", () => $("advanced-dialog").showModal());
$("close-advanced").addEventListener("click", () => $("advanced-dialog").close());
$("weights-file").addEventListener("change", async () => {
  const file = $("weights-file").files[0];
  if (!file) return;
  const model = currentModel();
  setEngineStatus("Loading…", false);
  $("load-progress").textContent = `Reading ${file.name} (${fmtMB(file.size)})…`;
  try {
    if (engine.ready) await engine.unload();
    const result = await engine.loadFromFile(model.id, file, {
      onProgress: ({ loaded, total, indeterminate }) => showProgress(loaded, total, indeterminate),
    });
    hideProgress();
    onModelReady(model, result.cached);
  } catch (err) {
    console.error(err);
    hideProgress();
    setEngineStatus("Load failed", false);
    $("load-progress").textContent = describeLoadError(err, model);
  } finally {
    $("weights-file").value = "";
  }
});
$("clear-cache").addEventListener("click", async () => {
  const model = currentModel();
  await engine.clearCache(model.id);
  setEngineStatus("No engine loaded", false);
  $("load-progress").textContent = `Cleared ${model.label} from this device.`;
  refreshStorageEstimate();
});
$("force-refresh").addEventListener("click", async () => {
  $("load-progress").textContent = "Clearing the app cache and reloading…";
  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
  } finally {
    location.reload();
  }
});
$("temperature").addEventListener("input", () => {
  state.temperature = Math.max(0, Math.min(1, Number($("temperature").value)));
  $("temperature-val").textContent = state.temperature.toFixed(1);
  savePrefs();
});
$("move-budget").addEventListener("input", () => {
  state.moveBudgetMs = Number($("move-budget").value);
  $("move-budget-val").textContent = (state.moveBudgetMs / 1000).toFixed(1) + "s";
  savePrefs();
});
$("trap-search").addEventListener("change", () => {
  state.trapSearch = $("trap-search").checked;
  savePrefs();
});

// ---- preferences ------------------------------------------------------

function savePrefs() {
  try {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        personId: state.selectedPersonId,
        selectedElo: state.selectedElo,
        openingId: state.openingId,
        colourChoice: state.colourChoice,
        moveBudgetMs: state.moveBudgetMs,
        temperature: state.temperature,
        trapSearch: state.trapSearch,
        showThinking: state.showThinking,
        oppoElo: state.oppoElo,
      })
    );
  } catch {
    /* private mode: preferences simply don't persist */
  }
}

function loadPrefs() {
  let p = {};
  try {
    p = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") || {};
  } catch {
    p = {};
  }
  if (p.personId) state.selectedPersonId = p.personId;
  if (p.openingId) state.openingId = p.openingId;
  if (p.colourChoice) state.colourChoice = p.colourChoice;
  if (p.moveBudgetMs) state.moveBudgetMs = p.moveBudgetMs;
  if (p.temperature !== undefined && Number.isFinite(Number(p.temperature))) {
    state.temperature = Math.max(0, Math.min(1, Number(p.temperature)));
  }
  if (p.trapSearch !== undefined) state.trapSearch = !!p.trapSearch;
  if (p.showThinking !== undefined) state.showThinking = !!p.showThinking;
  if (p.oppoElo) state.oppoElo = p.oppoElo;
  if (p.selectedElo && ELO_CHOICES.includes(p.selectedElo)) state.selectedElo = p.selectedElo;
}

// ---- startup ----------------------------------------------------------

loadPrefs();
populateModelSelect();
populateOpeningSelect();
populateRatingSelect();
renderRoster();
selectPerson(state.selectedPersonId);
$("temperature").value = String(state.temperature);
$("temperature-val").textContent = state.temperature.toFixed(1);
$("move-budget").value = String(state.moveBudgetMs);
$("move-budget-val").textContent = (state.moveBudgetMs / 1000).toFixed(1) + "s";
$("trap-search").checked = state.trapSearch;
$("show-thinking").checked = state.showThinking;
$("oppo-elo").value = String(state.oppoElo);
$("oppo-elo-val").textContent = String(state.oppoElo);
for (const [id, value] of [["pick-white", "white"], ["pick-black", "black"], ["pick-random", "random"]]) {
  $(id).setAttribute("aria-pressed", String(state.colourChoice === value));
}
showScreen("select");

(async function start() {
  if (engine.workerError) {
    // Nothing else in the app can work without the worker, so say so
    // plainly and stop pretending a model could be loaded.
    setEngineStatus("Unsupported browser", false);
    $("select-status").textContent = engine.workerError;
    $("load-progress").textContent = engine.workerError;
    $("load-model-btn").disabled = true;
    return;
  }
  refreshStorageEstimate();
  idb.requestPersistentStorage();
  const last = localStorage.getItem(LAST_MODEL_KEY);
  const startModel = MODEL_CATALOG.find((m) => m.id === last) || MODEL_CATALOG[0];
  $("model-select").value = startModel.id;
  if (await engine.isCached(startModel.id)) {
    await loadModel(startModel);
  } else {
    setEngineStatus("No engine loaded", false);
    $("select-status").textContent = "Tap ⚙ to load a Maia-3 model before your first game.";
  }
})();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((err) => console.warn("Service worker failed:", err));
  });
}

// Exposed for the DOM-level test harness; harmless in the browser.
window.__maia = {
  state,
  engine,
  analysisEngine,
  chess,
  board,
  refreshAnalysisView,
  __test_pgn: (opts) => currentPgn(opts || {}),
};
