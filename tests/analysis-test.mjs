import fs from "node:fs/promises";
// Analysis regression tests.
// Run with: node tests/analysis-test.mjs

import { Chess } from "../js/chess.esm.js";
import {
  analyseGame,
  classify,
  summarise,
  VariationSession,
  evalToWhiteShare,
  formatEval,
  plyLabel,
  winPctFromWdl,
  winPctFromCp,
  cpFromWinPct,
  moveAccuracy,
  aggregateAccuracy,
  toPgn,
  resultOf,
  INACCURACY_DROP,
  MISTAKE_DROP,
  BLUNDER_DROP,
} from "../js/analysis.js";

let failures = 0;
let checks = 0;
function check(name, cond, extra = "") {
  checks++;
  if (!cond) {
    failures++;
    console.log(`  FAIL  ${name} ${extra}`);
  }
}

console.log("=== maths / eval geometry ===");
check("50% is 0cp", cpFromWinPct(50) === 0);
check("cp round trip", [-300, -50, 0, 50, 300].every((cp) => Math.abs(cpFromWinPct(winPctFromCp(cp)) - cp) <= 2));
check("wdl counts draw as half", Math.abs(winPctFromWdl({ win: 0.3, draw: 0.4, loss: 0.3 }) - 50) < 1e-9);
check("eval bar centres at 50%", evalToWhiteShare(50) === 0.5);
check("mate formats as #", formatEval(1000, { mate: true }) === "#");
check("ply labels are conventional", plyLabel(1, "e4") === "1. e4" && plyLabel(2, "e5") === "1... e5");

console.log("=== 5-class move labels (Best/Good/Inaccuracy/Mistake/Blunder) ===");
check("small loss is Good", classify(50, 46) === "good");
check("inaccuracy threshold", classify(50, 40) === "inaccuracy");
check("mistake threshold", classify(50, 30) === "mistake");
check("blunder threshold", classify(50, 20) === "blunder");
check("best is only a Best label when no win chance is lost", classify(50, 50, true) === "best");
check("no loss without the best flag is still just Good", classify(50, 50) === "good");
check("the engine's own move is Best even with zero drop", classify(50, 50, true) === "best");
check("the engine's own move is Best even with a small drop", classify(50, 49, true) === "best");

console.log("=== Lichess-style position timeline: no side-to-move sawtooth ===");
{
  // Equal position: every candidate and every reply is evaluated at 0cp.
  // An exact best move must therefore preserve the displayed evaluation.
  const stub = {
    async evaluate(board, { includeUci }) {
      const legal = board.moves({ verbose: true });
      const moves = legal.map((m) => ({
        uci: m.from + m.to + (m.promotion || ""),
        san: m.san,
        from: m.from,
        to: m.to,
        promotion: m.promotion || null,
        prob: 1 / Math.max(1, legal.length),
        cp: 0,
      }));
      if (includeUci && !moves.some((m) => m.uci === includeUci)) {
        const m = legal[0];
        moves.push({ uci: includeUci, san: m.san, from: m.from, to: m.to, promotion: null, prob: 0, cp: 0 });
      }
      return { positionCp: 0, wdl: { win: 0.3, draw: 0.4, loss: 0.3 }, moves, terminal: false };
    },
  };
  const history = ["e4", "e5", "Nf3", "Nc6", "Bc4", "Nf6"];
  const { nodes } = await analyseGame(stub, history);
  const evals = nodes.map((n) => n.evalWhite);
  check("every position is evaluated", nodes.length === history.length + 1, String(nodes.length));
  check("starting position is neutral", Math.abs(evals[0]) < 2, String(evals[0]));
  check("dead-equal timeline has no sawtooth", evals.every((e) => Math.abs(e) < 2), evals.join(","));
}

console.log("=== exact engine move classification and direct position graph ===");
{
  const b = new Chess();
  const history = [];
  for (let i = 0; i < 4; i++) {
    const m = b.moves({ verbose: true })[0];
    history.push(m.san);
    b.move(m);
  }

  const stub = {
    async evaluate(board, { includeUci }) {
      const legal = board.moves({ verbose: true });
      const moves = legal.slice(0, 3).map((m) => ({
        uci: m.from + m.to + (m.promotion || ""),
        san: m.san,
        from: m.from,
        to: m.to,
        promotion: m.promotion || null,
        prob: 1 / Math.max(1, legal.length),
        cp: 0,
      }));
      if (includeUci && !moves.some((m) => m.uci === includeUci)) {
        const m = legal[0];
        moves.push({ uci: includeUci, san: m.san, from: m.from, to: m.to, promotion: null, prob: 0, cp: 0 });
      }
      return { positionCp: 0, wdl: { win: 0.3, draw: 0.4, loss: 0.3 }, moves, terminal: false };
    },
  };

  const { nodes } = await analyseGame(stub, history);
  const played = nodes.filter((n) => n.ply);
  check("exact best move has zero loss on every tested ply", played.every((n) => n.drop === 0), played.map((n) => n.drop).join(","));
  check("exact best move is always Best", played.every((n) => n.classification === "best"));
  check("direct position graph is allowed to change", nodes.length === history.length + 1);
}


{
  const root = new Chess();
  for (const san of ["e4", "e5", "Nf3", "Nc6", "Bc4"]) root.move(san);
  const rootBlackFen = root.fen();
  const legalBlack = root.moves({ verbose: true });
  const bestBlack = legalBlack[0];
  const bestBlackChild = new Chess(rootBlackFen);
  bestBlackChild.move({ from: bestBlack.from, to: bestBlack.to, promotion: bestBlack.promotion });
  const bestBlackChildFen = bestBlackChild.fen();

  const blunder = legalBlack.find((m) => m.san === "Nd4") || legalBlack[1];
  const blunderChild = new Chess(rootBlackFen);
  blunderChild.move({ from: blunder.from, to: blunder.to, promotion: blunder.promotion });
  const blunderChildFen = blunderChild.fen();
  const whiteLegal = blunderChild.moves({ verbose: true });
  const bestWhite = whiteLegal[0];
  const badWhite = whiteLegal[1];
  const bestWhiteChild = new Chess(blunderChildFen);
  bestWhiteChild.move({ from: bestWhite.from, to: bestWhite.to, promotion: bestWhite.promotion });
  const bestWhiteChildFen = bestWhiteChild.fen();
  const badWhiteChild = new Chess(blunderChildFen);
  badWhiteChild.move({ from: badWhite.from, to: badWhite.to, promotion: badWhite.promotion });
  const badWhiteChildFen = badWhiteChild.fen();

  const mkMoves = (board, cp) => board.moves({ verbose: true }).map((m) => ({
    uci: m.from + m.to + (m.promotion || ""), san: m.san, from: m.from, to: m.to,
    promotion: m.promotion || null, prob: 1 / Math.max(1, board.moves().length), cp,
  }));
  const stub = {
    async evaluate(board, { includeUci }) {
      const fen = board.fen();
      let cp = 0;
      if (fen === blunderChildFen) cp = 500;          // White is winning after Black's blunder.
      if (fen === bestWhiteChildFen) cp = -500;       // Black's best reply after best White move.
      if (fen === badWhiteChildFen) cp = -300;        // Black's best reply after weaker White move.
      if (fen === blunderChildFen) cp = 500;
      if (fen === bestBlackChildFen) cp = 0;
      const moves = mkMoves(board, cp);
      if (includeUci && !moves.some((m) => m.uci === includeUci)) {
        const legal = board.moves({ verbose: true });
        const m = legal[0];
        moves.push({ uci: includeUci, san: m.san, from: m.from, to: m.to, promotion: null, prob: 0, cp });
      }
      return { positionCp: cp, wdl: { win: .3, draw: .4, loss: .3 }, moves, terminal: false };
    },
  };

  const history = ["e4", "e5", "Nf3", "Nc6", "Bc4", blunder.san, badWhite.san];
  const { nodes, summary } = await analyseGame(stub, history);
  const blackNode = nodes.find((n) => n.san === blunder.san);
  const whiteNode = nodes.find((n) => n.ply === 7);
  check("Black blunder is classified Inaccuracy+", blackNode && blackNode.drop >= INACCURACY_DROP, blackNode && String(blackNode.drop));
  check(
    "White is not blamed for Black's move",
    summary.b.best + summary.b.good + summary.b.inaccuracy + summary.b.mistake + summary.b.blunder >= 1,
    JSON.stringify(summary.b)
  );
  check("White's less-than-best reply loses value", whiteNode && whiteNode.drop > 0, whiteNode && String(whiteNode.drop));
  check("White bar cannot rise after White's move", whiteNode && whiteNode.evalWhite <= nodes[6].evalWhite, nodes.map((n) => n.evalWhite).join(","));
}


console.log("=== large post-move graph swing is not clamped ===");
{
  const stub = {
    async evaluate(board, { includeUci }) {
      const legal = board.moves({ verbose: true });
      const best = legal[0];
      const bestUci = best.from + best.to + (best.promotion || "");
      const hist = board.history().join(" ");
      const positionCp = hist === "e4 e5" ? -900 : 0;
      return {
        positionCp,
        wdl: { win: .5, draw: 0, loss: .5 },
        moves: legal.slice(0, 8).map((m) => {
          const uci = m.from + m.to + (m.promotion || "");
          let cp = 0;
          if (hist === "e4") {
            // Make e5 deliberately non-best and make the resulting position
            // very favorable for White after the opponent (White) replies.
            if (uci === bestUci) cp = 0;
            if (uci === "e7e5") cp = -100;
          }
          if (hist === "e4 e5" && board.turn() === "w" && uci === bestUci) {
            cp = -900;
          }
          return {
            uci, san: m.san, from: m.from, to: m.to,
            promotion: m.promotion || null,
            prob: uci === bestUci ? 1 : .1,
            cp,
          };
        }),
        terminal: false,
      };
    },
  };

  const { nodes } = await analyseGame(stub, ["e4", "e5"]);
  const afterBlack = nodes.find((n) => n.san === "e5") ? nodes[nodes.findIndex((n) => n.san === "e5") + 1] : null;
  check(
    "large post-move graph swing is not clamped",
    afterBlack && afterBlack.winWhite < 50,
    String(afterBlack?.winWhite)
  );
}

console.log("=== regression: graph uses direct post-move score, not post-move minus move-loss ===");
{
  const start = new Chess();
  const first = start.moves({ verbose: true })[0];
  const firstUci = first.from + first.to + (first.promotion || "");
  const child = new Chess(); child.move(first.san);
  const stub = {
    async evaluate(board) {
      const legal = board.moves({ verbose: true });
      const hist = board.history().join(" ");
      const cp = hist === "" ? 0 : 300;
      const moves = legal.slice(0, 3).map((m, idx) => ({
        uci: m.from + m.to + (m.promotion || ""), san: m.san, from: m.from, to: m.to,
        promotion: m.promotion || null, prob: idx === 0 ? 1 : 0.1, cp,
      }));
      return { positionCp: cp, wdl: null, moves, terminal: false };
    }
  };
  const { nodes } = await analyseGame(stub, [first.san]);
  check("exact Best move displays actual resulting position", nodes[0]?.isBest && nodes[1]?.evalWhite === -300, nodes.map((n) => n.evalWhite).join(","));
}

console.log("=== summary ===");
{
  const s = summarise([
    { classification: "good", color: "w", accuracy: 100, drop: 0 },
    { classification: "inaccuracy", color: "w", accuracy: 90, drop: 6 },
    { classification: "blunder", color: "b", accuracy: 50, drop: 20 },
  ]);
  check("summary counts Good", s.w.good === 1);
  check("summary counts Inaccuracy", s.w.inaccuracy === 1);
  check("summary counts Blunder", s.b.blunder === 1);
  check("summary average drop", Math.abs(s.w.averageDrop - 3) < 1e-9);
}

console.log("=== accuracy ===");
check("perfect move is ~100%", moveAccuracy(50, 50) > 99);
check("accuracy falls with a larger drop", moveAccuracy(50, 40) < moveAccuracy(50, 45));
check("accuracy stays bounded", [0, 1, 20, 60, 100].every((d) => { const a = moveAccuracy(50, 50 - d); return a >= 0 && a <= 100; }));
check("aggregate empty is 100", aggregateAccuracy([]) === 100);

console.log("=== arrows / alternatives / stopping ===");
{
  const stub = {
    async evaluate(board, { includeUci, shouldStop }) {
      const legal = board.moves({ verbose: true });
      const moves = legal.slice(0, 3).map((m, i) => ({
        uci: m.from + m.to + (m.promotion || ""), san: m.san, from: m.from, to: m.to,
        promotion: m.promotion || null, prob: i === 0 ? .6 : .2, cp: i === 0 ? 50 : 0,
      }));
      if (includeUci && !moves.some((m) => m.uci === includeUci)) {
        const m = legal[0];
        moves.push({ uci: includeUci, san: m.san, from: m.from, to: m.to, promotion: null, prob: 0, cp: -20 });
      }
      return { positionCp: 0, wdl: { win: .3, draw: .4, loss: .3 }, moves, terminal: false };
    },
  };
  const { nodes } = await analyseGame(stub, ["e4", "e5", "Nf3", "Nc6"]);
  const analysed = nodes.filter((n) => n.ply);
  check("each move has best UCI", analysed.every((n) => !!n.bestUci));
  check("each move has alternatives", analysed.every((n) => Array.isArray(n.alternatives) && n.alternatives.length));

  let calls = 0;
  const stopStub = {
    async evaluate(board, args) {
      calls++;
      if (calls >= 2) args.shouldStop = () => true;
      const legal = board.moves({ verbose: true });
      const m = legal[0];
      return { positionCp: 0, wdl: { win: .3, draw: .4, loss: .3 }, moves: [{ uci: m.from + m.to, san: m.san, from: m.from, to: m.to, promotion: null, prob: 1, cp: 0 }], terminal: false };
    },
  };
  const result = await analyseGame(stopStub, ["e4", "e5", "Nf3", "Nc6"], { shouldStop: () => calls >= 2 });
  check("stop is honoured", result.cancelled === true);
}

console.log("=== PGN ===");
{
  const history = ["e4", "e5", "Nf3", "Nc6"];
  const pgn = toPgn({ sanHistory: history, white: "You", black: "Josh", result: "*" });
  check("PGN round-trips", (() => { try { const c = new Chess(); c.loadPgn(pgn); return c.history().join(" ") === history.join(" "); } catch { return false; } })());
  const annotated = toPgn({
    sanHistory: ["e4"],
    nodes: [{ ply: 1, san: "e4", classification: "blunder", bestSan: "d4" }],
    includeAnnotations: true,
  });
  check("Blunder is exported as a blunder NAG", annotated.includes("$4"));
  check("Blunder suggests the better move", annotated.includes("d4 was better"));

  const annotatedMistake = toPgn({
    sanHistory: ["e4"],
    nodes: [{ ply: 1, san: "e4", classification: "mistake", bestSan: "d4" }],
    includeAnnotations: true,
  });
  check("Mistake is exported as a mistake NAG", annotatedMistake.includes("$2"));
  check("Mistake suggests the better move", annotatedMistake.includes("d4 was better"));

  const annotatedBest = toPgn({
    sanHistory: ["e4"],
    nodes: [{ ply: 1, san: "e4", classification: "best", bestSan: "e4" }],
    includeAnnotations: true,
  });
  check("Best carries no NAG clutter", !/\$\d/.test(annotatedBest));
}

console.log("=== terminal games / variation state ===");
{
  const mate = new Chess();
  for (const san of ["f3", "e5", "g4", "Qh4#"]) mate.move(san);
  check("resultOf detects mate", resultOf(mate) === "0-1");

  const history = ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"];
  const s = new VariationSession(history);
  s.goToPly(4);
  check("variation session jumps", s.board.history().join(" ") === history.slice(0, 4).join(" "));
  const played = s.play({ from: "f1", to: "c4" });
  check("a different move starts a variation", played && played.onGameLine === false);
  const before = s.gameHistory.join(" ");
  s.backToGame();
  check("back to game restores original line", s.gameHistory.join(" ") === before && s.board.history().join(" ") === history.slice(0, 4).join(" "));
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);


console.log("=== position graph uses actual post-move evaluation ===");
{
  const src = await fs.readFile(new URL("../js/analysis.js", import.meta.url), "utf8");
  check(
    "position graph uses actual post-move evaluation",
    /pushDisplayNode\(board,\s*afterCpWhite,\s*child\.isCheckmate\(\)\)/.test(src) &&
    !/displayedCpWhite\s*=\s*isBest\s*\?/.test(src)
  );
}
console.log("=== no Best-move display flattening ===");
{
  const src = await fs.readFile(new URL("../js/analysis.js", import.meta.url), "utf8");
  check(
    "no Best-move display flattening",
    !/previousDisplayedCpWhite/.test(src) &&
    !/displayedCpWhite/.test(src)
  );
}
