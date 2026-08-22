// Port of personality/scoring.py (the v3 log-odds + soundness-gate
// design). This is the only place a dimension's opinion is combined with a
// preset's weight for it.
//
// score = log(policy_prob)                      <- Maia's own ranking, log-odds
//       + MAX_OVERRIDE_NATS * tanh(persona / MAX_OVERRIDE_NATS)
//       + GROUNDING_LOGIT_SCALE * clamp(model_cp / 400)
//
// where `persona` = (dimension pull * PERSONALITY_LOGIT_SCALE
//                    + contempt + momentum + book bonus) * soundness.

import { DIMENSIONS } from "./dimensions.js";

export const PERSONALITY_LOGIT_SCALE = 2.5;
export const GROUNDING_LOGIT_SCALE = 0.25;
export const SOUNDNESS_TOLERANCE = 120.0;
export const BLUNDER_THRESHOLD = 500.0;
// The bound on how far personality may move a candidate against Maia's own
// policy ranking, in log-odds (nats). Applied as a SOFT saturation (tanh),
// so ordering is always preserved and only the magnitude is compressed.
//
// The reference project fixed this at 1.1 (~3x). Measured against a
// realistically PEAKED policy that turns out to be right for a strong
// player and too tight for a weak one: at 1.1 nats a persona can only
// reorder candidates Maia already rates within ~3x of each other, so with
// a sharp policy every character converges on Maia's favourite and the
// personalities stop being distinguishable.
//
// That is also true to life in one direction only. A 2600 player's style
// shows up as a choice between near-equal moves; a 1200 player really does
// play their pet plan over the move most humans would choose. So the cap is
// now a per-character parameter (see characters.js styleForElo): looser for
// weak characters, tightening to roughly the reference value at master
// strength. The soundness gate is unchanged and still governs everything,
// so a looser cap can still never promote a materially worse move.
export const MAX_OVERRIDE_NATS = 1.1;
export const CONTEMPT_LOGIT_SCALE = 0.6;
export const BOOK_LOGIT_BONUS = 1.4;
export const MOMENTUM_LOGIT_SCALE = 0.5;

const CP_NORMALIZE = 400.0;
const MIN_PROB = 1e-9;
const clamp = (v, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));

// Every active dimension's (preset-scaled) opinion of this candidate,
// combined into a single pull in (-1, 1).
//
// WHY tanh AND NOT A HARD CLAMP. The reference summed the weighted
// dimension scores and then clamped to [-1, 1], to stop several agreeing
// dimensions stacking past what one maxed-out dimension was meant to
// exert. That bound is right, but a hard clamp destroys gradation exactly
// where a strongly-styled preset needs it: a persona like TheAttacker has
// five dimensions weighted 4-5, so on a sharp position EVERY candidate's
// raw sum exceeds 1 and every candidate clamps to precisely 1.0. The
// personality term then becomes a constant offset that cancels out of the
// ranking, and the preset silently plays pure Maia policy — measured, this
// made TheAttacker and TheWall produce identical move distributions on
// tactical positions (tests/personality-test.mjs section 4).
//
// This is the same failure the reference itself hit and fixed elsewhere:
// its MAX_OVERRIDE_NATS cap was originally a hard clip and was changed to
// tanh for exactly this reason ("once several candidates all exceeded the
// limit they all clipped to the same value, so the persona could no longer
// rank them against each other").
//
// Soft-saturating the sum with tanh helps but is not enough on its own: a
// preset with five maxed dimensions still reaches tanh(4) = 0.9993 on most
// candidates, which is a hard clamp in all but name. The fix is to make the
// pull a WEIGHTED MEAN of the dimensions' opinions rather than their sum:
//
//     pull = SUM(weight_i * score_i) / SUM(weight_i)
//
// This is bounded in [-1, 1] by construction (a mean of values in [-1, 1]),
// so the anti-stacking property the reference wanted is preserved exactly --
// several agreeing dimensions still cannot exert more than one maxed-out
// dimension. But it never saturates, so candidates always stay orderable,
// and a preset's overall intensity is set where it belongs: by
// PERSONALITY_LOGIT_SCALE and the per-character cap, not by how many
// dimensions happen to be non-zero.
export function combinedPersonalityPull(features, weights, breakdown) {
  let total = 0;
  let weightSum = 0;
  for (const dim of DIMENSIONS) {
    const weight = weights[dim.id] || 0;
    if (weight <= 0) continue; // a zero weight contributes nothing at all
    const raw = dim.score(features);
    const contribution = (weight / 5) * raw;
    total += contribution;
    weightSum += weight / 5;
    if (breakdown && raw !== 0) breakdown.push({ id: dim.id, raw, contribution });
  }
  if (weightSum <= 0) return 0;
  return clamp(total / weightSum);
}

// How much room personality gets, given how SOUND this candidate is
// relative to the best candidate this turn. Units are the model's own
// win-permille minus loss-permille scale, not real centipawns.
export function soundnessFactor(modelCp, bestCp, tolerance) {
  if (modelCp === null || modelCp === undefined || bestCp === null || bestCp === undefined) return 1;
  const tol = tolerance === undefined || tolerance === null ? SOUNDNESS_TOLERANCE : tolerance;
  const hard = Math.max(tol + 50, BLUNDER_THRESHOLD);
  const drop = bestCp - modelCp;
  if (drop <= tol) return 1;
  if (drop >= hard) return 0;
  return 1 - (drop - tol) / (hard - tol);
}

/**
 * @param {object}  features
 * @param {object}  weights      dimension id -> 0..5
 * @param {object}  opts
 *   bestCp       highest 1-ply value among this turn's candidates
 *   traits       preset traits (contempt / consistency)
 *   inBook       is this candidate in the preset's repertoire
 *   styleScale   overrides PERSONALITY_LOGIT_SCALE
 *   tolerance    overrides SOUNDNESS_TOLERANCE
 *   personaScale 0..1 user "personality strength"; scales every persona
 *                term so 0 leaves only Maia's own ranking + grounding
 *   explain      collect a per-dimension breakdown for the UI
 */
export function scoreCandidate(features, weights, opts = {}) {
  const {
    bestCp = null,
    traits = null,
    inBook = false,
    styleScale = null,
    tolerance = null,
    personaScale = 1,
    maxOverrideNats = MAX_OVERRIDE_NATS,
    explain = false,
  } = opts;

  let total = Math.log(Math.max(features.policy_prob, MIN_PROB));
  const scale = styleScale === null ? PERSONALITY_LOGIT_SCALE : styleScale;
  const soundness = soundnessFactor(features.model_cp, bestCp, tolerance);

  const breakdown = explain ? [] : null;
  let persona = 0;

  const pull = combinedPersonalityPull(features, weights, breakdown);
  if (pull !== 0) persona += pull * scale * soundness;

  if (traits) {
    const contempt = traits.contempt || 0;
    if (contempt && features.draw_prob) {
      persona -= (contempt / 5) * CONTEMPT_LOGIT_SCALE * features.draw_prob * soundness;
    }
    const consistency = traits.consistency || 0;
    if (consistency && features.momentum_alignment) {
      persona += consistency * MOMENTUM_LOGIT_SCALE * clamp(features.momentum_alignment) * soundness;
    }
  }

  if (inBook) persona += BOOK_LOGIT_BONUS * soundness;

  persona *= personaScale;

  const cap = maxOverrideNats > 0 ? maxOverrideNats : MAX_OVERRIDE_NATS;
  total += cap * Math.tanh(persona / cap);

  if (features.model_cp !== null && features.model_cp !== undefined) {
    total += GROUNDING_LOGIT_SCALE * clamp(features.model_cp / CP_NORMALIZE);
  }

  return { score: total, pull, soundness, persona, breakdown, inBook };
}

// All candidates with their scores, best first. best_cp is the max 1-ply
// value across the whole list (not assumed to be the first entry), so
// every candidate is judged against the same bar.
export function rankCandidates(featureList, weights, opts = {}) {
  if (!featureList.length) return [];
  let bestCp = null;
  for (const f of featureList) {
    if (f.model_cp !== null && f.model_cp !== undefined) {
      if (bestCp === null || f.model_cp > bestCp) bestCp = f.model_cp;
    }
  }
  const book = opts.bookMoves || null;
  const scored = featureList.map((f) => {
    const res = scoreCandidate(f, weights, {
      ...opts,
      bestCp,
      inBook: !!(book && book.has && book.has(f.uci)),
    });
    return { features: f, ...res };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

// Temperature/top-p sampling over already-ranked candidates. temperature
// <= 0 is fully deterministic (plays ranked[0]). Because scores live in
// log-odds units, softmax at temperature 1 is close to a clean reweighting
// of Maia's own probabilities.
export function sampleMove(ranked, temperature, topP = 1.0) {
  if (!ranked.length) return null;
  if (!temperature || temperature <= 1e-9 || ranked.length === 1) return ranked[0];
  const top = ranked[0].score;
  let items = ranked;
  let weights = ranked.map((r) => Math.exp((r.score - top) / temperature));
  if (topP > 0 && topP < 1) {
    const total = weights.reduce((a, b) => a + b, 0);
    let cumulative = 0;
    let cutoff = weights.length;
    for (let i = 0; i < weights.length; i++) {
      cumulative += weights[i] / total;
      if (cumulative >= topP) {
        cutoff = i + 1;
        break;
      }
    }
    items = items.slice(0, cutoff);
    weights = weights.slice(0, cutoff);
  }
  const sum = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * sum;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}
