// Port of the reference project's personality/features.py to chess.js.
//
// One MoveFeatures bundle is computed ONCE per candidate move and every
// personality dimension in dimensions.js just reads plain fields off it.
// Nothing in this file touches the neural network; all Maia-derived
// numbers (policy_prob, model_cp, draw_prob, trap_value) are supplied by
// the caller (engine.js), exactly as in the Python reference.

import { Chess } from "../chess.esm.js";

export const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };

const FILES = "abcdefgh";
export function sqIndex(name) {
  return (Number(name[1]) - 1) * 8 + FILES.indexOf(name[0]);
}
export function sqName(idx) {
  return FILES[idx % 8] + String(Math.floor(idx / 8) + 1);
}
const fileOf = (idx) => idx % 8;
const rankOf = (idx) => Math.floor(idx / 8);

// ---- position snapshots (index 0 = a1 .. 63 = h8) ----------------------

export function snapshot(chess) {
  const arr = new Array(64).fill(null);
  const rows = chess.board(); // rows[0] = rank 8
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const cell = rows[r][f];
      if (cell) arr[(7 - r) * 8 + f] = cell; // {square,type,color}
    }
  }
  return arr;
}

const KNIGHT_D = [
  [1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2],
];
const KING_D = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];
const BISHOP_D = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ROOK_D = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// Squares a piece standing on `from` attacks in `snap` (python-chess
// Board.attacks equivalent: includes occupied squares, ignores pins).
export function attacksFrom(snap, from) {
  const piece = snap[from];
  if (!piece) return [];
  const f = fileOf(from);
  const r = rankOf(from);
  const out = [];
  const push = (nf, nr) => {
    if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) out.push(nr * 8 + nf);
  };
  if (piece.type === "p") {
    const dr = piece.color === "w" ? 1 : -1;
    push(f - 1, r + dr);
    push(f + 1, r + dr);
    return out;
  }
  if (piece.type === "n") {
    for (const [df, dr] of KNIGHT_D) push(f + df, r + dr);
    return out;
  }
  if (piece.type === "k") {
    for (const [df, dr] of KING_D) push(f + df, r + dr);
    return out;
  }
  const dirs =
    piece.type === "b" ? BISHOP_D : piece.type === "r" ? ROOK_D : BISHOP_D.concat(ROOK_D);
  for (const [df, dr] of dirs) {
    let nf = f + df;
    let nr = r + dr;
    while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
      const idx = nr * 8 + nf;
      out.push(idx);
      if (snap[idx]) break;
      nf += df;
      nr += dr;
    }
  }
  return out;
}

// ---- Static Exchange Evaluation ---------------------------------------
// Textbook SEE: resolve the capture sequence on one square, least
// valuable attacker first, either side free to stop recapturing. Legality
// of every simulated recapture is checked through chess.js, so pinned
// defenders are handled correctly (same scope/limitations as the Python
// reference: single target square, no zwischenzug, no discovered attacks).

function leastValuableAttacker(chess, square, color) {
  let bestSq = null;
  let bestVal = null;
  for (const sq of chess.attackers(square, color)) {
    const piece = chess.get(sq);
    if (!piece) continue;
    const val = PIECE_VALUES[piece.type] || 0;
    if (bestVal === null || val < bestVal) {
      bestVal = val;
      bestSq = sq;
    }
  }
  return bestSq;
}

function tryMove(chess, from, to, promotion) {
  try {
    return chess.move(promotion ? { from, to, promotion } : { from, to });
  } catch {
    return null;
  }
}

function seeRecursive(work, target, side, pieceValueOnSquare) {
  const attackerSq = leastValuableAttacker(work, target, side);
  if (!attackerSq) return 0;
  const attacker = work.get(attackerSq);
  const attackerValue = PIECE_VALUES[attacker.type] || 0;
  const promo =
    attacker.type === "p" && (target[1] === "8" || target[1] === "1") ? "q" : undefined;
  if (!tryMove(work, attackerSq, target, promo)) return 0;
  const opponentBest = seeRecursive(work, target, side === "w" ? "b" : "w", attackerValue);
  work.undo();
  return Math.max(0, pieceValueOnSquare - opponentBest);
}

// `move` is a chess.js verbose move object (or {from,to,promotion,flags}).
export function staticExchangeEval(chess, move) {
  const isCapture = move.flags.includes("c") || move.flags.includes("e");
  const other = chess.turn() === "w" ? "b" : "w";
  if (!isCapture) {
    if (!move.promotion) return 0;
    const work = new Chess(chess.fen());
    const gain = (PIECE_VALUES[move.promotion] || 0) - PIECE_VALUES.p;
    if (!tryMove(work, move.from, move.to, move.promotion)) return 0;
    const loss = seeRecursive(work, move.to, other, PIECE_VALUES[move.promotion] || 0);
    return gain - loss;
  }
  const work = new Chess(chess.fen());
  const isEp = move.flags.includes("e");
  const firstGain = isEp ? PIECE_VALUES.p : PIECE_VALUES[move.captured] || 0;
  let movingValue = PIECE_VALUES[move.piece] || 0;
  let promoGain = 0;
  if (move.promotion) {
    promoGain = (PIECE_VALUES[move.promotion] || 0) - PIECE_VALUES.p;
    movingValue = PIECE_VALUES[move.promotion] || 0;
  }
  if (!tryMove(work, move.from, move.to, move.promotion)) return 0;
  const opponentBest = seeRecursive(work, move.to, other, movingValue);
  return firstGain + promoGain - opponentBest;
}

// ---- misc helpers ------------------------------------------------------

function centerDistance(idx) {
  const f = fileOf(idx);
  const r = rankOf(idx);
  return Math.max(Math.abs(f - 3), Math.abs(f - 4)) + Math.max(Math.abs(r - 3), Math.abs(r - 4));
}

export function gamePhase(chess) {
  const snap = snapshot(chess);
  let material = 0;
  for (const piece of snap) {
    if (!piece) continue;
    if (piece.type === "n" || piece.type === "b" || piece.type === "r" || piece.type === "q") {
      material += PIECE_VALUES[piece.type];
    }
  }
  if (material <= 20) return "endgame";
  const fullmove = Number(chess.fen().split(" ")[5]) || 1;
  if (fullmove <= 10 && material >= 60) return "opening";
  return "middlegame";
}

function kingZone(snap, color) {
  let kingSq = -1;
  for (let i = 0; i < 64; i++) {
    if (snap[i] && snap[i].type === "k" && snap[i].color === color) kingSq = i;
  }
  if (kingSq < 0) return [];
  const f = fileOf(kingSq);
  const r = rankOf(kingSq);
  const zone = [];
  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      const nf = f + df;
      const nr = r + dr;
      if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) zone.push(nr * 8 + nf);
    }
  }
  return zone;
}

function attackersInZone(chess, attackerColor, zone) {
  let count = 0;
  for (const idx of zone) count += chess.attackers(sqName(idx), attackerColor).length;
  return count;
}

function isPassedPawn(snap, idx, color) {
  const file = fileOf(idx);
  const rank = rankOf(idx);
  for (let i = 0; i < 64; i++) {
    const piece = snap[i];
    if (!piece || piece.type !== "p" || piece.color === color) continue;
    const ef = fileOf(i);
    const er = rankOf(i);
    if (Math.abs(ef - file) > 1) continue;
    const ahead = color === "w" ? er > rank : er < rank;
    if (ahead) return false;
  }
  return true;
}

function pawnFiles(snap, color) {
  const counts = new Array(8).fill(0);
  for (let i = 0; i < 64; i++) {
    const piece = snap[i];
    if (piece && piece.type === "p" && piece.color === color) counts[fileOf(i)] += 1;
  }
  return counts;
}
function doubledCount(files) {
  let n = 0;
  for (const c of files) if (c > 1) n += c - 1;
  return n;
}
function isolatedCount(files) {
  let n = 0;
  for (let f = 0; f < 8; f++) {
    if (!files[f]) continue;
    const left = f > 0 ? files[f - 1] : 0;
    const right = f < 7 ? files[f + 1] : 0;
    if (!left && !right) n += files[f];
  }
  return n;
}
function relativeRank(idx, color) {
  const r = rankOf(idx);
  return color === "w" ? r : 7 - r;
}
function space(snap, color) {
  let n = 0;
  for (let i = 0; i < 64; i++) {
    const piece = snap[i];
    if (piece && piece.type === "p" && piece.color === color && relativeRank(i, color) >= 4) n += 1;
  }
  return n;
}
function flankOf(idx) {
  const f = fileOf(idx);
  if (f === 3 || f === 4) return 0;
  return f < 3 ? -1 : 1;
}

export function materialBalanceOf(chess, color) {
  const snap = snapshot(chess);
  let total = 0;
  for (const piece of snap) {
    if (!piece || piece.type === "k") continue;
    const v = PIECE_VALUES[piece.type] || 0;
    total += piece.color === color ? v : -v;
  }
  return total;
}

export function countAvailableCaptures(chess) {
  let n = 0;
  for (const m of chess.moves({ verbose: true })) {
    if (m.flags.includes("c") || m.flags.includes("e")) n += 1;
  }
  return n;
}

// Legal move count for a side that is NOT currently to move (needed for
// opp_mobility_before). Flips the turn on a copy loaded without
// validation, exactly like the reference's probe board.
export function mobilityForSide(chess, color) {
  if (chess.turn() === color) return chess.moves().length;
  const parts = chess.fen().split(" ");
  parts[1] = color;
  parts[3] = "-";
  try {
    const probe = new Chess();
    probe.load(parts.join(" "), { skipValidation: true });
    return probe.moves().length;
  } catch {
    return null;
  }
}

// "Is something of `victimColor`'s hanging" - the reference's
// _has_undefended_or_underdefended_piece, including its turn-flip fix.
export function isUnderPressure(chess, victimColor) {
  const attackerColor = victimColor === "w" ? "b" : "w";
  if (chess.turn() === victimColor && chess.isCheck()) return true;

  let probe = chess;
  if (chess.turn() !== attackerColor) {
    const parts = chess.fen().split(" ");
    parts[1] = attackerColor;
    parts[3] = "-";
    try {
      probe = new Chess();
      probe.load(parts.join(" "), { skipValidation: true });
    } catch {
      return false;
    }
    try {
      if (probe.isCheck()) return true;
    } catch {
      return false;
    }
  }

  const snap = snapshot(probe);
  for (let i = 0; i < 64; i++) {
    const piece = snap[i];
    if (!piece || piece.color !== victimColor || piece.type === "k") continue;
    const name = sqName(i);
    if (!probe.isAttacked(name, attackerColor)) continue;
    const attackerSq = leastValuableAttacker(probe, name, attackerColor);
    if (!attackerSq) continue;
    const attacker = probe.get(attackerSq);
    const promo =
      attacker && attacker.type === "p" && (name[1] === "8" || name[1] === "1") ? "q" : undefined;
    let verbose = null;
    for (const m of probe.moves({ square: attackerSq, verbose: true })) {
      if (m.to === name && (!promo || m.promotion === promo)) {
        verbose = m;
        break;
      }
    }
    if (!verbose) continue;
    if (staticExchangeEval(probe, verbose) > 0) return true;
  }
  return false;
}

// ---- the feature bundle -----------------------------------------------

/**
 * @param {Chess} before          position with the mover to move
 * @param {object} move           chess.js verbose move for the candidate
 * @param {Chess} after           `before` with `move` already played
 * @param {object} ctx            position-level facts computed once per turn
 */
export function computeMoveFeatures(before, move, after, ctx = {}) {
  const mover = before.turn();
  const opponent = mover === "w" ? "b" : "w";
  const snapBefore = ctx.snapBefore || snapshot(before);
  const snapAfter = snapshot(after);
  const fromIdx = sqIndex(move.from);
  const toIdx = sqIndex(move.to);

  const isEp = move.flags.includes("e");
  const isCapture = move.flags.includes("c") || isEp;
  const capturedValue = isEp ? PIECE_VALUES.p : isCapture ? PIECE_VALUES[move.captured] || 0 : 0;
  const see = staticExchangeEval(before, move);

  const movedPieceType = move.piece;
  let materialDelta = isCapture || move.promotion ? see : 0;
  let isSacrifice = (isCapture || !!move.promotion) && see < -1;

  if (!isCapture && !move.promotion) {
    // A quiet move walking somewhere it can be won for less than its
    // worth is also an offer of material.
    const attackerSq = leastValuableAttacker(after, move.to, opponent);
    if (attackerSq) {
      let verbose = null;
      for (const m of after.moves({ square: attackerSq, verbose: true })) {
        if (m.to === move.to) {
          verbose = m;
          break;
        }
      }
      if (verbose) {
        const loss = staticExchangeEval(after, verbose);
        if (loss > 0) {
          isSacrifice = true;
          materialDelta = -loss;
        }
      }
    }
  }

  const givesCheck = after.isCheck();
  const isCastle = move.flags.includes("k") || move.flags.includes("q");
  const isPawnPush = movedPieceType === "p" && !isCapture;
  const isPassedPawnPush = isPawnPush && isPassedPawn(snapAfter, toIdx, mover);

  const mobilityDelta = attacksFrom(snapAfter, toIdx).length - attacksFrom(snapBefore, fromIdx).length;
  const centerDistanceDelta = centerDistance(toIdx) - centerDistance(fromIdx);

  const phase = ctx.phase || gamePhase(before);
  const kingCentralizing = movedPieceType === "k" && centerDistanceDelta < 0;

  const ownZoneBefore = kingZone(snapBefore, mover);
  const ownZoneAfter = kingZone(snapAfter, mover);
  const oppZoneBefore = kingZone(snapBefore, opponent);
  const oppZoneAfter = kingZone(snapAfter, opponent);
  const ownKingPressureDelta =
    attackersInZone(after, opponent, ownZoneAfter) - attackersInZone(before, opponent, ownZoneBefore);
  const oppKingPressureDelta =
    attackersInZone(after, mover, oppZoneAfter) - attackersInZone(before, mover, oppZoneBefore);

  const wasUnderPressureBefore =
    ctx.wasUnderPressureBefore !== undefined
      ? ctx.wasUnderPressureBefore
      : isUnderPressure(before, mover);
  const createsThreat = isUnderPressure(after, opponent);

  const destRel = relativeRank(toIdx, mover);
  const fromRel = relativeRank(fromIdx, mover);
  const developsMinor = (movedPieceType === "n" || movedPieceType === "b") && fromRel === 0 && destRel > 0;
  const retreats = !isCastle && destRel < fromRel;

  const filesBefore = pawnFiles(snapBefore, mover);
  const filesAfter = pawnFiles(snapAfter, mover);
  const createsDoubledPawn = doubledCount(filesAfter) > doubledCount(filesBefore);
  const createsIsolatedPawn = isolatedCount(filesAfter) > isolatedCount(filesBefore);
  const rookToOpenFile =
    (movedPieceType === "r" || movedPieceType === "q") && filesAfter[fileOf(toIdx)] === 0;
  const spaceDelta = space(snapAfter, mover) - space(snapBefore, mover);

  // `after` has the opponent to move, so its own move list is exactly the
  // opponent's mobility, and its captures are their forcing replies.
  const afterMoves = after.moves({ verbose: true });
  const oppMobilityBefore =
    ctx.oppMobilityBefore !== null && ctx.oppMobilityBefore !== undefined
      ? ctx.oppMobilityBefore
      : afterMoves.length;
  const oppMobilityDelta = afterMoves.length - oppMobilityBefore;
  const isProphylactic = oppMobilityDelta <= -3 && !isCapture && !givesCheck;

  const materialBalance =
    ctx.materialBalance !== undefined ? ctx.materialBalance : materialBalanceOf(before, mover);

  const capturedPieceType = isEp ? "p" : isCapture ? move.captured : null;
  const tradesQueens = movedPieceType === "q" && capturedPieceType === "q";
  const initiatesTrade = isCapture && after.isAttacked(move.to, opponent);

  const capturesBefore =
    ctx.capturesAvailableBefore !== undefined
      ? ctx.capturesAvailableBefore
      : countAvailableCaptures(before);
  const releasesTension = isCapture && capturesBefore > 0;
  const maintainsTension = !isCapture && capturesBefore > 0;

  let volatility = 0;
  for (const m of afterMoves) if (m.flags.includes("c") || m.flags.includes("e")) volatility += 1;
  if (givesCheck) volatility += 2;

  return {
    move,
    uci: move.from + move.to + (move.promotion || ""),
    policy_prob: ctx.policyProb || 0,
    model_cp: ctx.modelCp === undefined ? null : ctx.modelCp,

    is_capture: isCapture,
    captured_value: capturedValue,
    see,
    is_sacrifice: isSacrifice,

    gives_check: givesCheck,
    is_castle: isCastle,
    is_pawn_push: isPawnPush,
    is_passed_pawn_push: isPassedPawnPush,

    material_delta: materialDelta,
    mobility_delta: mobilityDelta,
    center_distance_delta: centerDistanceDelta,

    phase,
    king_centralizing: kingCentralizing,
    own_king_pressure_delta: ownKingPressureDelta,
    opp_king_pressure_delta: oppKingPressureDelta,
    was_under_pressure_before: wasUnderPressureBefore,
    creates_threat: createsThreat,

    moved_piece_type: movedPieceType,
    develops_minor: developsMinor,
    retreats,
    flank: flankOf(toIdx),
    creates_doubled_pawn: createsDoubledPawn,
    creates_isolated_pawn: createsIsolatedPawn,
    rook_to_open_file: rookToOpenFile,
    space_delta: spaceDelta,
    opp_mobility_delta: oppMobilityDelta,
    is_prophylactic: isProphylactic,

    material_balance: materialBalance,
    initiates_trade: initiatesTrade,
    trades_queens: tradesQueens,
    releases_tension: releasesTension,
    maintains_tension: maintainsTension,
    volatility,

    draw_prob: ctx.drawProb || 0,
    trap_value: ctx.trapValue || 0,
    momentum_alignment: ctx.momentumAlignment || 0,
  };
}

// Position-level facts that are identical for every candidate this turn -
// computed once by the caller and threaded into computeMoveFeatures.
export function positionContext(chess) {
  const mover = chess.turn();
  return {
    snapBefore: snapshot(chess),
    phase: gamePhase(chess),
    wasUnderPressureBefore: isUnderPressure(chess, mover),
    materialBalance: materialBalanceOf(chess, mover),
    capturesAvailableBefore: countAvailableCaptures(chess),
    oppMobilityBefore: mobilityForSide(chess, mover === "w" ? "b" : "w"),
  };
}
