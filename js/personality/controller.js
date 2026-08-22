// Ties the ported pieces together: per-game personality state (E8
// momentum), phase-shifted Elo (E6), opening repertoire lookup (E7), and
// the candidate re-ranking itself.
//
// This layer never generates moves. It only re-ranks candidates that
// Maia's own policy head already proposed, and every candidate it sees
// came out of chess.js legal move generation, so no personality choice can
// ever be illegal.

import { computeMoveFeatures, positionContext, gamePhase, sqIndex } from "./features.js";
import { rankCandidates, sampleMove } from "./scoring.js";
import { buildBook, positionKey, traitsFor, weightsFor } from "./presets.js";

export const MOMENTUM_DECAY = 0.85;
export const TRAP_REPLY_BREADTH = 4;
export const TRAP_CANDIDATE_LIMIT = 3;
export const TRAP_NORMALIZE = 250.0;

function flankOfSquare(name) {
  const f = sqIndex(name) % 8;
  if (f === 3 || f === 4) return 0;
  return f < 3 ? -1 : 1;
}

export class PersonalityController {
  constructor() {
    this.reset();
  }

  // Called on New Game / board reset / model reload so a plan committed in
  // one game can never bias the next one.
  reset() {
    this.flankCommitment = 0;
    this.pliesThisGame = 0;
  }

  momentumAlignment(toSquare) {
    if (Math.abs(this.flankCommitment) < 0.15) return 0;
    const moveFlank = flankOfSquare(toSquare);
    if (moveFlank === 0) return 0;
    return Math.max(-1, Math.min(1, moveFlank * this.flankCommitment));
  }

  updateMomentum(toSquare) {
    const contribution = flankOfSquare(toSquare);
    this.flankCommitment = Math.max(
      -1,
      Math.min(1, this.flankCommitment * MOMENTUM_DECAY + contribution * (1 - MOMENTUM_DECAY))
    );
    this.pliesThisGame += 1;
  }

  // E6: per-phase shift of the SelfElo actually fed to the network.
  phaseShiftedElo(chess, selfElo, presetId) {
    const shifts = traitsFor(presetId).elo_shift || {};
    if (!shifts || Object.keys(shifts).length === 0) return selfElo;
    const phase = gamePhase(chess);
    const shifted = selfElo + (shifts[phase] || 0);
    return Math.max(500, Math.min(3000, shifted));
  }

  /**
   * Re-rank Maia's candidates.
   * @param {Chess}  chess       current position (mover to move)
   * @param {Array}  candidates  [{ move (chess.js verbose), uci, prob, cp, childChess, trapValue }]
   * @param {object} opts        { presetId, strength (0..1), temperature, topP, drawProb }
   */
  chooseMove(chess, candidates, opts = {}) {
    const {
      presetId,
      strength = 1,
      temperature = 1.0,
      topP = 1.0,
      drawProb = 0,
      explain = true,
      useBook = true,
      maxOverrideNats,
    } = opts;
    const weights = weightsFor(presetId);
    if (!weights || !candidates.length) return null;
    const traits = traitsFor(presetId);
    // The opening director may already be steering the first plies; when it
    // is, the persona's own repertoire bonus is suppressed so the two
    // systems can't fight over the same move.
    const bookMoves = useBook
      ? new Set(buildBook(presetId).get(positionKey(chess)) || [])
      : new Set();

    const ctx = positionContext(chess);

    const featureList = candidates.map((c) =>
      computeMoveFeatures(chess, c.move, c.childChess, {
        ...ctx,
        policyProb: c.prob,
        modelCp: c.cp === undefined ? null : c.cp,
        drawProb,
        trapValue: c.trapValue || 0,
        momentumAlignment: this.momentumAlignment(c.move.to),
      })
    );

    const ranked = rankCandidates(featureList, weights, {
      traits,
      bookMoves,
      personaScale: strength,
      maxOverrideNats,
      explain,
    });

    const chosen = sampleMove(ranked, temperature, topP) || ranked[0];
    this.updateMomentum(chosen.features.move.to);

    return { chosen, ranked, weights, traits, bookMoves };
  }
}

// Turn the raw reply values of one candidate into a normalised trap value.
// values are from OUR perspective; probs are the human opponent's own
// policy probabilities at THEIR Elo.
export function trapValueFromReplies(values, probs) {
  if (!values || values.length < 2) return 0;
  const totalP = probs.reduce((a, b) => a + b, 0) || 1;
  let expected = 0;
  for (let i = 0; i < values.length; i++) expected += values[i] * probs[i];
  expected /= totalP;
  const bestForThem = Math.min(...values);
  return Math.max(-1, Math.min(1, (expected - bestForThem) / TRAP_NORMALIZE));
}
