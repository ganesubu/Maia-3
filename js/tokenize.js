// Encodes chess.js positions into Maia3's input planes.
//
// Maia3 always encodes from the mover's point of view: if it's Black to
// move, the position is mirrored vertically (rank -> 7-rank) and every
// piece's color is flipped, so "plane 0-5" is always *my* pieces and
// "plane 6-11" is always the opponent's, regardless of actual color.
// This must match maia3/dataset.py::tokenize_board exactly.

const PIECE_BASE = { p: 1, n: 2, b: 3, r: 4, q: 5, k: 6 }; // pawn..king, 1-indexed

const FILES = "abcdefgh";
function squareName(file, rank) {
  return FILES[file] + String(rank + 1);
}

// Returns a Float32Array(64 * 12), squares in rank-major order (a1..h1, a2..h2, ... a8..h8),
// matching python-chess's chess.SQUARES iteration (square = rank*8 + file).
export function tokenizeBoard(chess) {
  const tokens = new Float32Array(64 * 12);
  const mover = chess.turn(); // 'w' or 'b'
  const mirror = mover === "b";

  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const sqIdx = rank * 8 + file; // output row, mover's frame
      // Which real-board square feeds this output row?
      const srcRank = mirror ? 7 - rank : rank;
      const srcFile = file;
      const piece = chess.get(squareName(srcFile, srcRank));
      if (!piece) continue;
      const base = PIECE_BASE[piece.type];
      let effectiveColor = piece.color;
      if (mirror) effectiveColor = piece.color === "w" ? "b" : "w";
      const plane = base - 1 + (effectiveColor === "b" ? 6 : 0);
      tokens[sqIdx * 12 + plane] = 1;
    }
  }
  return tokens;
}

// Builds the (64, 12*history) input tensor from a chronological (oldest
// first) array of tokenizeBoard() snapshots, padding by repeating the
// oldest snapshot when the game is shorter than `history` plies, exactly
// matching maia3/dataset.py::get_historical_tokens (the trailing
// time-info column it appends is always sliced off by the model when
// include_time_info=False, which is true for every released Maia3 size,
// so it's omitted here entirely).
export function buildHistoryTensor(historySnapshots, history) {
  const padCount = Math.max(0, history - historySnapshots.length);
  const used = historySnapshots.slice(Math.max(0, historySnapshots.length - history));
  const framesOldestFirst = [];
  for (let i = 0; i < padCount; i++) framesOldestFirst.push(historySnapshots[0]);
  for (const f of used) framesOldestFirst.push(f);

  const dim = 12 * history;
  const out = new Float32Array(64 * dim);
  for (let sq = 0; sq < 64; sq++) {
    for (let h = 0; h < history; h++) {
      const frame = framesOldestFirst[h];
      for (let p = 0; p < 12; p++) {
        out[sq * dim + h * 12 + p] = frame[sq * 12 + p];
      }
    }
  }
  return out;
}
