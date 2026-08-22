// Regression test for the interactive Maia-3 variation history bug.
import { Chess } from "../js/chess.esm.js";
import fs from "node:fs/promises";

let failures = 0;
let checks = 0;
function check(name, condition, detail = "") {
  checks++;
  if (!condition) {
    failures++;
    console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`);
  }
}

const history = [
  "e4", "e5", "Nf3", "Nc6", "Bc4", "Nf6",
  "d3", "Bc5", "c3", "d6", "O-O", "O-O",
  "Re1", "a6", "Bb3", "Ba7", "h3", "h6",
  "Nbd2", "Be6"
];

const boardWithHistory = new Chess();
for (const san of history) boardWithHistory.move(san);
const boardFromFen = new Chess(boardWithHistory.fen());

check(
  "replayed board retains complete history",
  boardWithHistory.history().length === history.length,
  String(boardWithHistory.history().length)
);

check(
  "FEN reconstruction discards history",
  boardFromFen.history().length === 0
);

const appSource = await fs.readFile(new URL("../js/app.js", import.meta.url), "utf8");
const engineSource = await fs.readFile(new URL("../js/engine.js", import.meta.url), "utf8");


check(
  "game analysis passes Stockfish analysis engine",
  /analyseGame\(analysisEngine,\s*sanHistory/.test(appSource)
);
check(
  "evaluateCached accepts a Chess board",
  /async function evaluateCached\(board\)/.test(appSource)
);

check(
  "variation evaluator operates on a real Chess board with history",
  /evaluateCached\((?:session\.board|parentBoard|board)\)/.test(appSource)
);

const fnStart = appSource.indexOf("async function evaluateCached(board)");
const fnEnd = appSource.indexOf("async function refreshAnalysisView()", fnStart);
const fn = appSource.slice(fnStart, fnEnd);

const fnCode = fn.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
check(
  "variation evaluator does not reconstruct Chess from FEN",
  !fnCode.includes("new Chess(fen)")
);

check(
  "variation evaluator uses the supplied Chess board",
  /analysisEngine\.evaluate\(board,\s*\{/.test(appSource) ||
  /analysisEngine\.evaluate\(parentBoard,\s*\{/.test(appSource) ||
  /evaluateCached\((?:session\.board|parentBoard|board)\)/.test(appSource)
);

check(
  "evaluation cache key includes full history",
  /const historyKey = board\.history\(\)\.join\(" "\);/.test(fn) &&
  /const cacheKey = historyKey \+ "\\n" \+ fen;/.test(fn)
);

check(
  "engine snapshots are history-driven",
  /const sanHistory = chess\.history\(\);/.test(engineSource) &&
  /snapshotsOf\(sanHistory\)/.test(engineSource)
);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);


console.log("=== variation uses consecutive position evaluations ===");
{
  const src = await fs.readFile(new URL("../js/app.js", import.meta.url), "utf8");
  check(
    "variation uses consecutive position evaluations",
    /const parentPositionCp = parentEval\?\.positionCp \?\? 0/.test(src) &&
    /const playedPositionCp = child\.isCheckmate\(\)/.test(src) &&
    /const nextTimelineWinWhite = rawPostMoveWinWhite/.test(src) &&
    !/playedPositionCp\s*=\s*isBest\s*\?/.test(src) &&
    !/nextTimelineWinWhite\s*=\s*isBest\s*\?/.test(src)
  );
}
