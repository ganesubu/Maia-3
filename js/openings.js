// A small, deliberately shallow opening database, plus the director that
// applies it.
//
// WHY IT IS SHAPED THIS WAY. Maia at a fixed rating is a distribution, and
// distributions repeat: left alone it steers a large share of games into
// the same handful of structures. The director's job is to break that up
// WITHOUT playing nonsense, so:
//
//   * choosing an opening fixes only the FIRST move of the game;
//   * the following two plies are drawn at random from that same opening's
//     own common continuations;
//   * after three plies the director retires completely and Maia +
//     personality run the rest of the game.
//
// The randomness is opening-aware, never blind: every continuation below is
// a real, common line, and the director only ever offers a move that is
// legal in the actual position AND consistent with the moves already
// played. If the human plays something outside the chosen opening, the
// director drops out immediately rather than trying to force the line.
//
// Groupings are honest about a three-ply horizon: at ply three "Ruy Lopez"
// and "Italian" are the same position, so families are named by what is
// actually distinguishable that early.

export const OPENINGS = [
  {
    id: "open-game",
    name: "Open Game",
    eco: "C20–C59",
    first: "e4",
    note: "1.e4 e5 — the classical battleground.",
    weight: 16,
    continuations: [
      ["e5", "Nf3"], // Ruy Lopez / Italian / Scotch complex
      ["e5", "Nc3"], // Vienna
      ["e5", "Bc4"], // Bishop's Opening
      ["e5", "f4"], // King's Gambit
      ["e5", "d4"], // Centre Game
    ],
  },
  {
    id: "sicilian",
    name: "Sicilian Defence",
    eco: "B20–B99",
    first: "e4",
    note: "1.e4 c5 — the most popular answer to the king's pawn.",
    weight: 18,
    continuations: [
      ["c5", "Nf3"], // Open Sicilian
      ["c5", "Nc3"], // Closed Sicilian
      ["c5", "c3"], // Alapin
      ["c5", "d4"], // Smith–Morra
      ["c5", "Bc4"], // Bowdler
    ],
  },
  {
    id: "french",
    name: "French Defence",
    eco: "C00–C19",
    first: "e4",
    note: "1.e4 e6 — solid, cramped, and full of plans.",
    weight: 9,
    continuations: [
      ["e6", "d4"],
      ["e6", "Nc3"],
      ["e6", "d3"], // King's Indian Attack
      ["e6", "Nf3"],
    ],
  },
  {
    id: "caro-kann",
    name: "Caro-Kann Defence",
    eco: "B10–B19",
    first: "e4",
    note: "1.e4 c6 — solid without the French's bad bishop.",
    weight: 8,
    continuations: [
      ["c6", "d4"],
      ["c6", "Nc3"],
      ["c6", "Nf3"],
      ["c6", "d3"],
      ["c6", "c4"], // Accelerated Panov
    ],
  },
  {
    id: "scandinavian",
    name: "Scandinavian Defence",
    eco: "B01",
    first: "e4",
    note: "1.e4 d5 — immediate central confrontation.",
    weight: 5,
    continuations: [
      ["d5", "exd5"],
      ["d5", "Nc3"],
      ["d5", "e5"],
      ["d5", "d4"],
    ],
  },
  {
    id: "pirc-modern",
    name: "Pirc & Modern",
    eco: "B06–B09",
    first: "e4",
    note: "1.e4 d6/g6 — hand over the centre, then attack it.",
    weight: 5,
    continuations: [
      ["d6", "d4"],
      ["g6", "d4"],
      ["d6", "Nf3"],
      ["g6", "Nc3"],
      ["g6", "Nf3"],
    ],
  },
  {
    id: "alekhine",
    name: "Alekhine's Defence",
    eco: "B02–B05",
    first: "e4",
    note: "1.e4 Nf6 — provoke the pawns forward and undermine them.",
    weight: 3,
    continuations: [
      ["Nf6", "e5"],
      ["Nf6", "Nc3"],
      ["Nf6", "d3"],
    ],
  },
  {
    id: "closed-game",
    name: "Closed Game",
    eco: "D00–D69",
    first: "d4",
    note: "1.d4 d5 — Queen's Gambit, London, and the slow systems.",
    weight: 15,
    continuations: [
      ["d5", "c4"], // Queen's Gambit
      ["d5", "Nf3"],
      ["d5", "Bf4"], // London
      ["d5", "e3"], // Colle
      ["d5", "Nc3"], // Richter–Veresov
      ["d5", "Bg5"], // Levitsky
    ],
  },
  {
    id: "indian",
    name: "Indian Defence",
    eco: "A45–E99",
    first: "d4",
    note: "1.d4 Nf6 — Nimzo, King's Indian, Grünfeld and friends.",
    weight: 15,
    continuations: [
      ["Nf6", "c4"],
      ["Nf6", "Nf3"],
      ["Nf6", "Bg5"], // Trompowsky
      ["Nf6", "Bf4"], // London vs Indian
      ["Nf6", "Nc3"],
    ],
  },
  {
    id: "dutch",
    name: "Dutch Defence",
    eco: "A80–A99",
    first: "d4",
    note: "1.d4 f5 — unbalanced from the very first move.",
    weight: 4,
    continuations: [
      ["f5", "c4"],
      ["f5", "Nf3"],
      ["f5", "g3"],
      ["f5", "Bg5"], // Hopton
    ],
  },
  {
    id: "benoni-benko",
    name: "Benoni & Benko",
    eco: "A43–A79",
    first: "d4",
    note: "1.d4 c5 — asymmetric counterplay straight away.",
    weight: 3,
    continuations: [
      ["c5", "d5"],
      ["c5", "Nf3"],
      ["c5", "e3"],
    ],
  },
  {
    id: "english",
    name: "English Opening",
    eco: "A10–A39",
    first: "c4",
    note: "1.c4 — flank pressure, often transposing everywhere.",
    weight: 8,
    continuations: [
      ["e5", "Nc3"], // Reversed Sicilian
      ["c5", "Nf3"], // Symmetrical
      ["Nf6", "Nc3"],
      ["e6", "Nc3"],
      ["g6", "Nc3"],
      ["Nf6", "Nf3"],
    ],
  },
  {
    id: "reti",
    name: "Réti Opening",
    eco: "A04–A09",
    first: "Nf3",
    note: "1.Nf3 — keep every option open for one more move.",
    weight: 6,
    continuations: [
      ["d5", "c4"],
      ["Nf6", "c4"],
      ["d5", "g3"], // King's Indian Attack
      ["Nf6", "g3"],
      ["c5", "c4"],
    ],
  },
  {
    id: "bird",
    name: "Bird's Opening",
    eco: "A02–A03",
    first: "f4",
    note: "1.f4 — a reversed Dutch, and rarely quiet.",
    weight: 2,
    continuations: [
      ["d5", "Nf3"],
      ["e5", "fxe5"], // From's Gambit accepted
      ["Nf6", "Nf3"],
      ["d5", "e3"],
    ],
  },
  {
    id: "nimzo-larsen",
    name: "Nimzo-Larsen Attack",
    eco: "A01",
    first: "b3",
    note: "1.b3 — long diagonal first, everything else later.",
    weight: 2,
    continuations: [
      ["e5", "Bb2"],
      ["d5", "Bb2"],
      ["Nf6", "Bb2"],
    ],
  },
];

export const OPENING_CHOICES = [
  { id: "none", name: "No preference", note: "Maia and the character open however they like." },
  { id: "random", name: "Random opening", note: "A different opening each game, weighted by popularity." },
  ...OPENINGS.map((o) => ({ id: o.id, name: o.name, note: o.note, eco: o.eco })),
];

export function openingById(id) {
  return OPENINGS.find((o) => o.id === id) || null;
}

// Weighted pick, so 1.b3 doesn't turn up as often as the Sicilian.
export function pickWeightedOpening(rng = Math.random) {
  const total = OPENINGS.reduce((a, o) => a + o.weight, 0);
  let r = rng() * total;
  for (const o of OPENINGS) {
    r -= o.weight;
    if (r <= 0) return o;
  }
  return OPENINGS[0];
}

/**
 * Applies one opening to the first three plies of a game.
 *
 * The director holds every 3-ply line belonging to the chosen opening and
 * narrows that set as moves are actually played. It supplies a move only
 * when the game so far still matches at least one line, and only for plies
 * 1–3. After that — or the moment the human leaves the opening — it retires
 * and `isActive()` goes false for the rest of the game.
 */
export class OpeningDirector {
  /**
   * @param {string} openingId  an OPENINGS id, "random", or "none"
   * @param {function} rng      injectable for deterministic tests
   */
  constructor(openingId, rng = Math.random) {
    this.rng = rng;
    this.retired = false;
    this.opening = null;
    this.lines = [];

    if (!openingId || openingId === "none") {
      this.retired = true;
      return;
    }
    this.opening = openingId === "random" ? pickWeightedOpening(rng) : openingById(openingId);
    if (!this.opening) {
      this.retired = true;
      return;
    }
    // Every line is [firstMove, ply2, ply3]; the first move is what makes
    // this opening that opening, the other two are the controlled variety.
    this.lines = this.opening.continuations.map((cont) => [this.opening.first, ...cont]);
    // Shuffle once so ties between equally-matching lines don't always
    // resolve to the same continuation.
    for (let i = this.lines.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [this.lines[i], this.lines[j]] = [this.lines[j], this.lines[i]];
    }
  }

  get name() {
    return this.opening ? this.opening.name : null;
  }

  isActive() {
    return !this.retired && this.lines.length > 0;
  }

  // Called after any move (by either side) to keep the candidate lines in
  // sync with what was really played.
  observe(chess) {
    if (this.retired) return;
    const played = chess.history();
    if (played.length >= 3) {
      this.retired = true;
      return;
    }
    this.lines = this.lines.filter((line) => played.every((san, i) => line[i] === san));
    if (!this.lines.length) this.retired = true; // left the opening: stand down
  }

  /**
   * The SAN the director wants played in this position, or null.
   * Always verified legal before it is returned, so the director can never
   * hand the game an impossible move.
   */
  moveFor(chess) {
    if (this.retired) return null;
    const played = chess.history();
    if (played.length >= 3) {
      this.retired = true;
      return null;
    }
    const viable = this.lines.filter((line) => played.every((san, i) => line[i] === san));
    if (!viable.length) {
      this.retired = true;
      return null;
    }
    const ply = played.length;
    // Distinct candidate moves at this ply, so the choice is between real
    // alternatives rather than weighted by how many lines share a prefix.
    const options = [...new Set(viable.map((line) => line[ply]))];
    const legal = new Set(chess.moves());
    const playable = options.filter((san) => legal.has(san));
    if (!playable.length) {
      this.retired = true;
      return null;
    }
    return playable[Math.floor(this.rng() * playable.length)];
  }
}
