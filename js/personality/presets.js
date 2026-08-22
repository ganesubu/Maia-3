// Preset weights + engine-level traits, ported verbatim from the
// reference project's personality/presets.py. Weights are 0..5 per
// dimension; traits are the engine-level persona properties (contempt,
// per-phase Elo shift, plan consistency, opening
// repertoire) that aren't shaped like per-move scores.

import { Chess } from "../chess.esm.js";
import { DIMENSION_IDS } from "./dimensions.js";

export const PRESETS = {
  PositionalGenius: {
    aggressive: 2, tactical: 2, positional: 3, strategic: 3,
    defensive: 2, solid: 2, gambiteer: 0, sacrificial: 1,
    endgame_specialist: 2, initiative: 2, risk_taking: 1,
    materialistic: 2, counterattacking: 1, trappy: 1, human_like: 3,
  },
  TheAttacker: {
    aggressive: 5, tactical: 5, positional: 0, strategic: 0,
    defensive: 0, solid: 0, gambiteer: 2, sacrificial: 4,
    endgame_specialist: 0, initiative: 5, risk_taking: 4,
    materialistic: 0, counterattacking: 1, trappy: 2, human_like: 1,
  },
  TheWall: {
    aggressive: 0, tactical: 0, positional: 2, strategic: 1,
    defensive: 5, solid: 5, gambiteer: 0, sacrificial: 0,
    endgame_specialist: 1, initiative: 0, risk_taking: 0,
    materialistic: 3, counterattacking: 1, trappy: 0, human_like: 2,
  },
  Trickster: {
    aggressive: 2, tactical: 4, positional: 1, strategic: 0,
    defensive: 0, solid: 0, gambiteer: 2, sacrificial: 3,
    endgame_specialist: 0, initiative: 3, risk_taking: 3,
    materialistic: 0, counterattacking: 1, trappy: 5, human_like: 1,
  },
  Hoarder: {
    aggressive: 0, tactical: 1, positional: 1, strategic: 0,
    defensive: 1, solid: 2, gambiteer: 0, sacrificial: 0,
    endgame_specialist: 1, initiative: 0, risk_taking: 2,
    materialistic: 5, counterattacking: 0, trappy: 0, human_like: 2,
  },
  TheSwindler: {
    aggressive: 2, tactical: 4, positional: 0, strategic: 0,
    defensive: 1, solid: 0, gambiteer: 1, sacrificial: 3,
    endgame_specialist: 0, initiative: 3, risk_taking: 4,
    materialistic: 0, counterattacking: 5, trappy: 5, human_like: 0,
  },
  TheTiltTrigger: {
    aggressive: 0, tactical: 0, positional: 3, strategic: 2,
    defensive: 3, solid: 4, gambiteer: 0, sacrificial: 0,
    endgame_specialist: 1, initiative: 0, risk_taking: 0,
    materialistic: 1, counterattacking: 1, trappy: 2, human_like: 0,
  },
};

export const PRESET_TRAITS = {
  PositionalGenius: {
    contempt: 0, consistency: 0.3,
    elo_shift: { opening: 0, middlegame: 0, endgame: 0 },
    book: ["d4 d5 c4", "d4 Nf6 c4 e6 Nf3", "e4 e5 Nf3 Nc6 Bb5", "e4 c5 Nf3 d6 d4"],
  },
  TheAttacker: {
    contempt: 5, consistency: 0.8,
    elo_shift: { opening: -40, middlegame: 60, endgame: -20 },
    book: [
      "e4 e5 Nf3 Nc6 Bc4 Bc5 b4",
      "e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5",
      "e4 c5 d4",
      "d4 d5 c4 e6 Nc3 Nf6 Bg5",
      "e4 e6 d4 d5 e5",
    ],
  },
  TheWall: {
    contempt: -5, consistency: 0.6,
    elo_shift: { opening: 20, middlegame: -30, endgame: 40 },
    book: ["e4 c6 d4 d5", "d4 d5 c4 e6", "e4 e6 d4 d5 Nd2", "d4 Nf6 c4 e6 Nf3 d5"],
  },
  Trickster: {
    contempt: 4, consistency: 0.4,
    elo_shift: { opening: -30, middlegame: 50, endgame: -20 },
    book: ["e4 e5 Nf3 Nc6 Bc4 Bc5 b4", "d4 d5 c4 e5", "e4 e5 f4", "e4 d5", "d4 Nf6 c4 e5"],
  },
  Hoarder: {
    contempt: -2, consistency: 0.5,
    elo_shift: { opening: -20, middlegame: 0, endgame: 40 },
    book: [
      "d4 d5 c4 dxc4",
      "e4 e5 Nf3 Nc6 Bc4 Bc5 b4 Bxb4",
      "e4 e5 f4 exf4",
      "d4 Nf6 c4 e6 Nc3 Bb4",
    ],
  },
  TheSwindler: {
    contempt: 5, consistency: 0.3,
    elo_shift: { opening: -40, middlegame: 40, endgame: 20 },
    book: [
      "e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 g6",
      "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6",
      "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6",
      "e4 d6 d4 Nf6 Nc3 g6",
    ],
  },
  TheTiltTrigger: {
    contempt: -4, consistency: 0.7,
    elo_shift: { opening: 10, middlegame: -20, endgame: 20 },
    book: ["d4 d5 Nf3 Nf6 e3", "e4 e5 Nf3 Nc6 d3", "d4 Nf6 Nf3 e6 e3", "e4 c6 d3"],
  },
};

export const DEFAULT_TRAITS = {
  contempt: 0,
  consistency: 0.0,
  elo_shift: {},
  book: [],
};

// UI-facing list. `null` id = vanilla Maia (personality layer bypassed).
export const PERSONALITY_MENU = [
  { id: null, label: "Vanilla Maia (no personality)" },
  { id: "PositionalGenius", label: "Positional Genius" },
  { id: "TheAttacker", label: "The Attacker" },
  { id: "TheWall", label: "The Wall" },
  { id: "Trickster", label: "Trickster" },
  { id: "Hoarder", label: "Hoarder" },
  { id: "TheSwindler", label: "The Swindler" },
  { id: "TheTiltTrigger", label: "The Tilt Trigger" },
];

export const DEFAULT_PRESET = "PositionalGenius";

export function weightsFor(presetId) {
  return PRESETS[presetId] || null;
}

export function traitsFor(presetId) {
  return { ...DEFAULT_TRAITS, ...(PRESET_TRAITS[presetId] || {}) };
}

// Same key the reference uses: position identity without move counters.
export function positionKey(chess) {
  return chess.fen().split(" ").slice(0, 4).join(" ");
}

const _bookCache = new Map();

// Expand a preset's SAN lines into { positionKey: [uci, ...] }. Any
// illegal SAN in a line simply truncates that line instead of throwing,
// so a bad book entry can never stop the engine from moving.
export function buildBook(presetId) {
  if (_bookCache.has(presetId)) return _bookCache.get(presetId);
  const book = new Map();
  const lines = traitsFor(presetId).book || [];
  for (const line of lines) {
    const replay = new Chess();
    for (const san of line.split(/\s+/).filter(Boolean)) {
      const key = positionKey(replay);
      let mv;
      try {
        mv = replay.move(san);
      } catch {
        break;
      }
      if (!mv) break;
      const uci = mv.from + mv.to + (mv.promotion || "");
      if (!book.has(key)) book.set(key, []);
      if (!book.get(key).includes(uci)) book.get(key).push(uci);
    }
  }
  _bookCache.set(presetId, book);
  return book;
}

// Fail-fast equivalent of validate_presets(): every preset must carry a
// weight for every registered dimension. Returns a list of problems.
export function validatePresets() {
  const problems = [];
  for (const [name, weights] of Object.entries(PRESETS)) {
    for (const id of DIMENSION_IDS) {
      if (typeof weights[id] !== "number") problems.push(`${name} is missing weight for '${id}'`);
    }
    for (const id of Object.keys(weights)) {
      if (!DIMENSION_IDS.includes(id)) problems.push(`${name} has unknown dimension '${id}'`);
    }
    if (!PRESET_TRAITS[name]) problems.push(`${name} has no traits entry`);
  }
  return problems;
}
