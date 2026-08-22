// Post-game analysis.
//
// Analysis is Stockfish-only. The playing engine remains Maia-3; Maia's
// human-move WDL/value head is never treated as an objective analysis score.
//
// Lichess's analysis model is position-based: each Info represents the
// evaluation AFTER a move, and move quality compares consecutive evaluations
// after converting them to winning chances. The displayed graph therefore
// uses the actual Stockfish evaluation of each position. Move loss is a
// separate statistic and must never be added to the graph a second time.
//
// The Win% mapping uses the published Lichess logistic with a ±1000 cp clamp.
// Per-move accuracy and the judgement thresholds follow the current Lichess
// analysis code as closely as practical for this five-tier UI.

import { Chess } from "./chess.esm.js";

export const ANALYSIS_ELO = 2600;

// Lichess's cp -> win% sigmoid constant.
const WIN_K = 0.00368208;
const CP_CLAMP = 1000;

// stockfish-engine.js's parseScore reports a UCI "score mate N" line as a
// flat +-100000 cp sentinel (mate distance is intentionally not carried
// through, since Lichess's own accuracy math also treats every forced mate
// as the same +-1000 cp ceiling; see winPctFromCp/CP_CLAMP above). A real
// Stockfish centipawn evaluation never approaches this magnitude, so it is
// a safe, unambiguous way to detect "this position/line is a forced mate"
// without needing the exact distance.
const MATE_SCORE_THRESHOLD = 50000;

/** win/draw/loss probabilities -> win% in [0, 100], side-to-move's POV. */
export function winPctFromWdl(wdl) {
  if (!wdl) return 50;
  return 100 * Math.max(0, Math.min(1, wdl.win + wdl.draw / 2));
}

/** Centipawns -> win% (Lichess). cp is side-to-move relative. */
export function winPctFromCp(cp) {
  if (cp === null || cp === undefined) return 50;
  const c = Math.max(-CP_CLAMP, Math.min(CP_CLAMP, cp));
  return 100 / (1 + Math.exp(-WIN_K * c));
}

/**
 * Win% -> centipawns, the exact inverse of the above.
 *
 * Win% is a logistic in cp, so cp = ln(W / (1 - W)) / k. Saturating win%
 * would give an infinite cp, so it is clamped a hair inside [0, 1] and the
 * result clamped to +-CP_CLAMP; a bar reading "+10" is already "winning"
 * as far as anyone is concerned.
 */
export function cpFromWinPct(winPct) {
  const w = Math.max(0.001, Math.min(0.999, winPct / 100));
  return Math.max(-CP_CLAMP, Math.min(CP_CLAMP, Math.round(Math.log(w / (1 - w)) / WIN_K)));
}

// Lichess judgement thresholds are expressed as winning-chance deltas:
// 10 percentage points = Inaccuracy, 20 = Mistake, 30 = Blunder.
export const INACCURACY_DROP = 10;
export const MISTAKE_DROP = 20;
export const BLUNDER_DROP = 30;
export const BEST_EPS = 0;

export const CLASSES = ["best", "good", "inaccuracy", "mistake", "blunder"];
export const CLASS_LABEL = {
  best: "Best",
  good: "Good",
  inaccuracy: "Inaccuracy",
  mistake: "Mistake",
  blunder: "Blunder",
};

/**
 * Lichess-style move judgement from consecutive position Win% values.
 * `winBefore` and `winAfter` are from the mover's point of view.
 * Exact engine-best moves are still labelled Best for the app's five-tier UI,
 * but the displayed graph itself is never forced flat: it shows the actual
 * Stockfish evaluation of each resulting position.
 */
export function classify(winBefore, winAfter, isBest = false, mateInfo = null) {
  // Delivering checkmate is always the strongest possible move. It must never
  // be judged by the ordinary win% drop thresholds: a player can already be
  // overwhelmingly winning before the mating move, and the finishing move
  // should still be Best rather than a Blunder.
  if (mateInfo?.created) return "best";

  if (mateInfo?.lost) {
    if (winAfter >= 99.99) return "inaccuracy";
    if (winAfter >= 70) return "mistake";
    return "blunder";
  }
  const drop = Math.max(0, winBefore - winAfter);
  if (isBest && drop < 1e-9) return "best";
  if (drop >= BLUNDER_DROP) return "blunder";
  if (drop >= MISTAKE_DROP) return "mistake";
  if (drop >= INACCURACY_DROP) return "inaccuracy";
  return isBest ? "best" : "good";
}

/** Lichess per-move accuracy formula, including its uncertainty bonus. */
export function moveAccuracy(winBefore, winAfter) {
  if (winAfter >= winBefore) return 100;
  const diff = winBefore - winAfter;
  const raw = 103.1668100711649 * Math.exp(-0.04354415386753951 * diff) - 3.166924740191411;
  return Math.max(0, Math.min(100, raw + 1));
}

export function aggregateAccuracy(list) {
  if (!list.length) return 100;
  return list.reduce((a, b) => a + b, 0) / list.length;
}

/**
 * Analyse a game into a per-position timeline.
 *
 * Returns { nodes, summary, cancelled, error }.
 *
 * nodes[k] describes the position reached after k plies:
 *   fen, evalWhite (cp, White's POV), winWhite, turn, moveNumber
 * and, for every node except the last, the move played FROM it:
 *   ply, san, uci, bestUci, bestSan, classification, winBefore, winAfter,
 *   drop, accuracy, alternatives
 *
 * Storing bestUci/uci here is what lets the analysis board draw its arrows
 * instantly while stepping through: nothing has to be recomputed.
 */
export async function analyseGame(engine, sanHistory, opts = {}) {
  const { onProgress, shouldStop } = opts;
  const board = new Chess();
  const nodes = [];
  let error = null;
  let cancelled = false;
  let evaluation = null;

  const childWithMove = (position, move) => {
    const child = new Chess();
    for (const san of position.history()) child.move(san);
    child.move({
      from: move.from,
      to: move.to,
      promotion: move.promotion || undefined,
    });
    return child;
  };

  const whiteCpFromRoot = (position, rootCp) =>
    position.turn() === "w" ? rootCp : -rootCp;

  const pushDisplayNode = (chessAt, cpWhite, mate = false) => {
    const rawCpWhite = Number(cpWhite) || 0;
    // Lichess uses the capped score only for the Win% curve. The displayed engine
    // score itself remains the actual Stockfish score for this position.
    const safeWinWhite = mate ? (rawCpWhite > 0 ? 100 : 0) : winPctFromCp(rawCpWhite);
    nodes.push({
      index: nodes.length,
      fen: chessAt.fen(),
      turn: chessAt.turn(),
      moveNumber: Number(chessAt.fen().split(" ")[5]) || 1,
      winWhite: safeWinWhite,
      evalWhite: rawCpWhite,
      rawEvalWhite: rawCpWhite,
      bestPositionCp: rawCpWhite,
      terminal: mate,
      mate: mate,
    });
    return nodes[nodes.length - 1];
  };

  // Lichess analysis stores a score for each position after each move. Move
  // quality is then computed from consecutive scores. Reuse the just-evaluated
  // child as the next iteration's current position: one engine search per
  // distinct position, rather than a best-move + best-reply double search.
  try {
    evaluation = await engine.evaluate(board, { topK: 3, shouldStop });
  } catch (err) {
    return { nodes, cancelled: true, error: err, summary: summarise(nodes) };
  }

  const initialCpWhite = whiteCpFromRoot(board, evaluation.positionCp ?? 0);
  pushDisplayNode(board, initialCpWhite, false);

  for (let i = 0; i < sanHistory.length; i++) {
    if (shouldStop?.()) { cancelled = true; break; }
    if (board.isGameOver()) break;

    const san = sanHistory[i];
    const verbose = board.moves({ verbose: true }).find((m) => m.san === san);
    if (!verbose) {
      error = new Error(`Move ${san} is not legal in the recorded position.`);
      break;
    }
    const uci = verbose.from + verbose.to + (verbose.promotion || "");
    const best = evaluation.moves?.[0] || null;
    const played = evaluation.moves?.find((m) => m.uci === uci) || null;
    const mover = board.turn();
    const beforeCpWhite = whiteCpFromRoot(board, evaluation.positionCp ?? best?.cp ?? 0);
    const beforeWinMover = mover === "w" ? winPctFromCp(beforeCpWhite) : 100 - winPctFromCp(beforeCpWhite);
    const isBest = !!best && best.uci === uci;

    // Did the mover already have a forced mate on the board before playing?
    // best.cp is mover-relative (UCI convention), so a forced mate for the
    // mover is reported as the large positive sentinel.
    const hadForcedMate = !!best && best.cp >= MATE_SCORE_THRESHOLD;

    const child = childWithMove(board, verbose);
    let childEvaluation = null;
    let afterCpWhite;
    let mateInfo = null;

    if (child.isCheckmate()) {
      afterCpWhite = child.turn() === "w" ? -CP_CLAMP : CP_CLAMP;
      mateInfo = { created: child.turn() !== mover };
    } else if (child.isGameOver()) {
      afterCpWhite = 0;
      // A mate that was on the board a move ago and is now a draw (e.g. a
      // blundered stalemate) is exactly the "mate lost" case below.
      if (hadForcedMate && !isBest) mateInfo = { lost: true };
    } else {
      try {
        childEvaluation = await engine.evaluate(child, { topK: 3, shouldStop });
      } catch (err) {
        error = err;
        cancelled = true;
        break;
      }
      afterCpWhite = whiteCpFromRoot(child, childEvaluation.positionCp ?? childEvaluation.moves?.[0]?.cp ?? 0);

      // "Mate lost": the position before this move had a forced mate for the
      // mover, and the resulting position (evaluated from the opponent's
      // side to move) no longer shows a forced loss for the opponent. This
      // is the transition Lichess's Advice.scala always grades at least a
      // Mistake, even when the win% barely moves (still hugely winning,
      // just no longer *forced* mate) -- classify()'s mateInfo.lost branch
      // already implements that graduated floor; it just needs this signal.
      // The isBest guard prevents ever flagging the engine's own top choice
      // as a mistake, in case shallow search disagrees with itself between
      // the two positions.
      if (hadForcedMate && !isBest) {
        const childBest = childEvaluation.moves?.[0] || null;
        const stillForcedMate = !!childBest && childBest.cp <= -MATE_SCORE_THRESHOLD;
        if (!stillForcedMate) mateInfo = { lost: true };
      }
    }

    const afterWinWhite = child.isCheckmate()
      ? (afterCpWhite > 0 ? 100 : 0)
      : winPctFromCp(afterCpWhite);
    const afterWinMover = mover === "w" ? afterWinWhite : 100 - afterWinWhite;
    const drop = Math.max(0, beforeWinMover - afterWinMover);

    const node = nodes[nodes.length - 1];
    node.ply = i + 1;
    node.san = san;
    node.uci = uci;
    node.color = mover;
    node.bestUci = best?.uci || null;
    node.bestSan = best?.san || null;
    node.isBest = isBest;
    node.winBefore = beforeWinMover;
    node.winAfter = afterWinMover;
    node.drop = drop;
    node.classification = classify(beforeWinMover, afterWinMover, isBest, mateInfo);
    node.accuracy = moveAccuracy(beforeWinMover, afterWinMover);
    node.playedPositionCp = afterCpWhite;
    node.bestPositionCp = beforeCpWhite;
    node.alternatives = (evaluation.moves || []).slice(0, 3).map((m) => ({
      san: m.san,
      uci: m.uci,
      cp: m.cp,
      winPct: winPctFromCp(m.cp),
    }));

    board.move(san);

    // Lichess's graph is position-based: the node after this move shows the
    // actual Stockfish evaluation of the resulting position. Whether the move
    // was Best is a separate judgement and must not rewrite the graph value.
    const nextNode = pushDisplayNode(board, afterCpWhite, child.isCheckmate());
    nextNode.bestPositionCp = beforeCpWhite;

    if (child.isCheckmate()) {
      nextNode.mate = true;
      nextNode.evalWhite = afterCpWhite;
      nextNode.rawEvalWhite = afterCpWhite;
      nextNode.winWhite = afterWinWhite;
    }

    if (onProgress) onProgress({ done: i + 1, total: sanHistory.length, node });

    evaluation = childEvaluation;
    if (!evaluation && !board.isGameOver()) {
      evaluation = await engine.evaluate(board, { topK: 3, shouldStop });
    }
  }

  return { nodes, cancelled, error, summary: summarise(nodes) };
}

export function summarise(nodes) {
  const blank = () => ({
    best: 0,
    good: 0,
    inaccuracy: 0,
    mistake: 0,
    blunder: 0,
    accuracy: 100,
    moves: 0,
    averageDrop: 0,
  });
  const out = { w: blank(), b: blank() };
  const acc = { w: [], b: [] };
  const drops = { w: [], b: [] };
  for (const n of nodes) {
    if (!n.classification || !n.color) continue;
    const side = out[n.color];
    side[n.classification] += 1;
    side.moves += 1;
    acc[n.color].push(n.accuracy);
    drops[n.color].push(n.drop);
  }
  const startWhite = nodes.length ? true : true;
  for (const c of ["w", "b"]) {
    out[c].accuracy = lichessGameAccuracy(nodes, c === "w", startWhite);
    out[c].averageDrop = drops[c].length ? drops[c].reduce((a, b) => a + b, 0) / drops[c].length : 0;
  }
  return out;
}

function harmonicMean(values) {
  const xs = values.filter((v) => Number.isFinite(v) && v > 0);
  if (!xs.length) return 100;
  return xs.length / xs.reduce((sum, v) => sum + 1 / v, 0);
}

function weightedMean(pairs) {
  const valid = pairs.filter(([v, w]) => Number.isFinite(v) && Number.isFinite(w) && w > 0);
  if (!valid.length) return 100;
  const wsum = valid.reduce((s, [, w]) => s + w, 0);
  return valid.reduce((s, [v, w]) => s + v * w, 0) / wsum;
}

function stddev(values) {
  if (!values.length) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((s, x) => s + (x - mean) ** 2, 0) / values.length);
}

function lichessGameAccuracy(nodes, forWhite) {
  const allWinPercents = nodes.map((n) => n.winWhite);
  if (allWinPercents.length < 2) return 100;
  const cpCount = allWinPercents.length - 1;
  const windowSize = Math.max(2, Math.min(8, Math.floor(cpCount / 10)));
  const windows = [];
  const prefixCount = Math.max(0, Math.min(windowSize, allWinPercents.length) - 2);
  for (let i = 0; i < prefixCount; i++) windows.push(allWinPercents.slice(0, windowSize));
  for (let i = 0; i + windowSize <= allWinPercents.length; i++) windows.push(allWinPercents.slice(i, i + windowSize));
  const weights = windows.map((w) => Math.max(0.5, Math.min(12, stddev(w))));
  const weightedByColor = { w: [], b: [] };
  const rawByColor = { w: [], b: [] };
  for (let i = 0; i < allWinPercents.length - 1; i++) {
    // Ply i is White's move iff i is even -- this is a fixed fact about the
    // game (analyseGame always starts from the standard position, White to
    // move first) and must NOT depend on forWhite, which only selects which
    // side's aggregate this call returns below. Tying it to forWhite meant
    // the forWhite=false call inverted every ply's color, so "Black's"
    // aggregate was silently built from White's own per-move accuracies.
    const color = (i % 2 === 0) ? "w" : "b";
    const beforeWhite = allWinPercents[i];
    const afterWhite = allWinPercents[i + 1];
    const before = color === "w" ? beforeWhite : 100 - beforeWhite;
    const after = color === "w" ? afterWhite : 100 - afterWhite;
    const accValue = moveAccuracy(before, after);
    rawByColor[color].push(accValue);
    weightedByColor[color].push([accValue, weights[i] ?? 1]);
  }
  const out = {};
  for (const color of ["w", "b"]) {
    const wm = weightedMean(weightedByColor[color]);
    const hm = harmonicMean(rawByColor[color]);
    out[color] = (wm + hm) / 2;
  }
  return forWhite ? out.w : out.b;
}

// ---- interactive exploration ------------------------------------------

/**
 * Exploration on top of a played game.
 *
 * The played game is an immutable SAN list. `board` is a scratch position;
 * `basePly` is where exploration started and `variation` is anything played
 * beyond it. The played game can never be modified from here.
 */
export class VariationSession {
  constructor(sanHistory) {
    this.gameHistory = sanHistory.slice();
    this.basePly = sanHistory.length;
    this.variation = [];
    this.board = new Chess();
    this._rebuild();
  }

  _rebuild() {
    this.board = new Chess();
    for (let i = 0; i < this.basePly; i++) {
      try {
        this.board.move(this.gameHistory[i]);
      } catch {
        break;
      }
    }
    for (const san of this.variation) {
      try {
        this.board.move(san);
      } catch {
        break;
      }
    }
  }

  get inVariation() {
    return this.variation.length > 0;
  }

  get fen() {
    return this.board.fen();
  }

  goToPly(ply) {
    this.basePly = Math.max(0, Math.min(ply, this.gameHistory.length));
    this.variation = [];
    this._rebuild();
  }

  stepBack() {
    if (this.variation.length) {
      this.variation.pop();
      this._rebuild();
      return true;
    }
    if (this.basePly > 0) {
      this.basePly -= 1;
      this._rebuild();
      return true;
    }
    return false;
  }

  stepForward() {
    if (this.variation.length) return false;
    if (this.basePly >= this.gameHistory.length) return false;
    this.basePly += 1;
    this._rebuild();
    return true;
  }

  backToGame() {
    this.variation = [];
    this._rebuild();
  }

  play({ from, to, promotion }) {
    let move;
    try {
      move = this.board.move({ from, to, promotion });
    } catch {
      return null;
    }
    if (!move) return null;
    if (
      !this.variation.length &&
      this.basePly < this.gameHistory.length &&
      this.gameHistory[this.basePly] === move.san
    ) {
      this.basePly += 1;
      return { move, onGameLine: true };
    }
    this.variation.push(move.san);
    return { move, onGameLine: false };
  }

  describe() {
    if (!this.inVariation) {
      return this.basePly === 0
        ? "Starting position"
        : `After ${plyLabel(this.basePly, this.gameHistory[this.basePly - 1])}`;
    }
    return `Variation: ${this.variation.join(" ")}`;
  }
}

export function plyLabel(ply, san) {
  const moveNumber = Math.ceil(ply / 2);
  const isWhite = ply % 2 === 1;
  return `${moveNumber}${isWhite ? "." : "..."} ${san}`;
}

// ---- display helpers ---------------------------------------------------

/** Share of the bar White occupies, straight from win% -- no extra curve. */
export function evalToWhiteShare(winWhite) {
  if (winWhite === null || winWhite === undefined) return 0.5;
  return Math.max(0, Math.min(1, winWhite / 100));
}

export function formatEval(cpWhite, { mate = false, winWhite = null } = {}) {
  if (mate) return "#";
  if (cpWhite === null || cpWhite === undefined) return "—";
  // Only a genuine forced result shows "#". A near-certain win is still an
  // evaluation, and labelling it "#" would claim a mate that isn't there;
  // terminal nodes set win% to exactly 0 or 100, so this stays exact.
  if (winWhite === 0 || winWhite === 100) return "#";
  const pawns = cpWhite / 100;
  if (Math.abs(pawns) >= 10) return (pawns > 0 ? "+" : "−") + "10";
  const sign = pawns > 0 ? "+" : pawns < 0 ? "−" : "";
  return `${sign}${Math.abs(pawns).toFixed(1)}`;
}

// ---- PGN ---------------------------------------------------------------

function pgnDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}

function escapeTag(value) {
  return String(value == null ? "" : value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Export a played game as PGN.
 *
 * With `nodes` from analyseGame, Numeric Annotation Glyphs are attached to
 * the moves that earned them, so the file opens in Lichess/ChessBase/SCID
 * with the same verdicts this app showed.
 */
export function toPgn({
  sanHistory,
  white = "Player",
  black = "Player",
  result = "*",
  event = "Maia3",
  site = "Maia3 (offline)",
  round = "-",
  date = pgnDate(),
  extraTags = {},
  nodes = null,
  includeAnnotations = true,
  startFen = null,
} = {}) {
  const NAG = { inaccuracy: "$6", mistake: "$2", blunder: "$4", best: "", good: "" };
  const STANDARD = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  const tags = [
    ["Event", event],
    ["Site", site],
    ["Date", date],
    ["Round", round],
    ["White", white],
    ["Black", black],
    ["Result", result],
    ...Object.entries(extraTags),
  ];
  // A game that did not start from the initial array is unreadable without
  // these two tags -- any viewer would reject the very first move.
  if (startFen && startFen !== STANDARD) {
    tags.push(["SetUp", "1"], ["FEN", startFen]);
  }
  const header = tags.map(([k, v]) => `[${k} "${escapeTag(v)}"]`).join("\n");

  const byPly = new Map();
  if (nodes) for (const n of nodes) if (n.ply) byPly.set(n.ply, n);

  // Move numbering follows the starting position, so a game set up from a
  // mid-game FEN is numbered the way that position actually is.
  let firstMoveNumber = 1;
  let whiteToStart = true;
  if (startFen) {
    const parts = startFen.split(" ");
    whiteToStart = parts[1] !== "b";
    firstMoveNumber = Number(parts[5]) || 1;
  }

  const tokens = [];
  for (let i = 0; i < sanHistory.length; i++) {
    const isWhiteMove = whiteToStart ? i % 2 === 0 : i % 2 === 1;
    const moveNo = firstMoveNumber + Math.floor((i + (whiteToStart ? 0 : 1)) / 2);
    if (isWhiteMove) tokens.push(`${moveNo}.`);
    else if (i === 0) tokens.push(`${moveNo}...`);
    let token = sanHistory[i];
    const node = byPly.get(i + 1);
    if (includeAnnotations && node) {
      const nag = NAG[node.classification];
      if (nag) token += ` ${nag}`;
      if (node.classification === "mistake" || node.classification === "blunder") {
        if (node.bestSan && node.bestSan !== node.san) token += ` {${node.bestSan} was better}`;
      }
    }
    tokens.push(token);
  }
  tokens.push(result);

  // Wrap at 80 columns, which is what the PGN standard asks for and what
  // keeps the file readable in any viewer.
  const lines = [];
  let line = "";
  for (const t of tokens) {
    if (line.length + t.length + 1 > 80) {
      lines.push(line);
      line = "";
    }
    line += (line ? " " : "") + t;
  }
  if (line) lines.push(line);

  return `${header}\n\n${lines.join("\n")}\n`;
}

/** PGN Result tag for a finished (or abandoned) game. */
export function resultOf(chess, { resigned = null } = {}) {
  if (resigned === "w") return "0-1";
  if (resigned === "b") return "1-0";
  if (!chess.isGameOver()) return "*";
  if (chess.isCheckmate()) return chess.turn() === "w" ? "0-1" : "1-0";
  return "1/2-1/2";
}
