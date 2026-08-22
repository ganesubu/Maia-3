// Move vocabulary + perspective mirroring for Maia3.
//
// Maia3 always "sees" the board as if it were White to move: when it is
// Black's turn, the board is mirrored vertically (rank r -> 7-r, file
// unchanged) and every piece's color is swapped before encoding, and the
// model's output move indices are in that same mirrored frame. This file
// builds the exact 4352-entry move vocabulary CSSLab uses and the
// mirroring helpers needed to translate between "mover's frame" and the
// real board.
//
// Vocabulary layout (must match maia3/utils.py get_all_possible_moves):
//   [0 .. 4095]   every (fromSquare, toSquare) pair, fromSquare/toSquare
//                 iterated as rank-major (rank 0..7 outer, file 0..7 inner),
//                 i.e. index = fromSquare*64 + toSquare with
//                 square = rank*8 + file (standard 0=a1 .. 63=h8).
//   [4096..4351]  promotions, always from rank7->rank8 (mover's frame),
//                 nested as fromFile(8) x toFile(8) x piece(4: q,r,b,n).

export const NUM_SQUARE_MOVES = 64 * 64; // 4096
export const NUM_PROMO_MOVES = 8 * 8 * 4; // 256
export const NUM_MOVES = NUM_SQUARE_MOVES + NUM_PROMO_MOVES; // 4352

const FILES = "abcdefgh";
const PROMO_PIECES = ["q", "r", "b", "n"];

function squareName(file, rank) {
  return FILES[file] + String(rank + 1);
}

function buildAllMoves() {
  const moves = new Array(NUM_MOVES);
  let idx = 0;
  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const fromName = squareName(file, rank);
      for (let tRank = 0; tRank < 8; tRank++) {
        for (let tFile = 0; tFile < 8; tFile++) {
          moves[idx++] = fromName + squareName(tFile, tRank);
        }
      }
    }
  }
  for (let fFrom = 0; fFrom < 8; fFrom++) {
    for (let fTo = 0; fTo < 8; fTo++) {
      for (let p = 0; p < PROMO_PIECES.length; p++) {
        moves[idx++] = `${FILES[fFrom]}7${FILES[fTo]}8${PROMO_PIECES[p]}`;
      }
    }
  }
  return moves;
}

export const ALL_MOVES = buildAllMoves();

export const MOVE_INDEX = (() => {
  const map = new Map();
  for (let i = 0; i < ALL_MOVES.length; i++) map.set(ALL_MOVES[i], i);
  return map;
})();

export function mirrorSquare(sq) {
  // sq like "e4" -> file unchanged, rank flipped (rank' = 9 - rank)
  const file = sq[0];
  const rank = 9 - parseInt(sq[1], 10);
  return file + String(rank);
}

export function mirrorMoveUci(uci) {
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promo = uci.length > 4 ? uci.slice(4) : "";
  return mirrorSquare(from) + mirrorSquare(to) + promo;
}

// From/to square index helpers (0=a1 .. 63=h8), used by the model output head.
export function squareIndex(file, rank) {
  return rank * 8 + file;
}
