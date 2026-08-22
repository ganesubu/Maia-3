
import assert from "node:assert/strict";
import { Chess } from "../js/chess.esm.js";
import { StockfishAnalysisEngine } from "../js/stockfish-engine.js";

class FakeWorker {
  constructor() { this.onmessage=null; this.onerror=null; this.onmessageerror=null; }
  postMessage(cmd) {
    queueMicrotask(() => {
      if (cmd === "uci") this.onmessage?.({data:"uciok"});
      else if (cmd === "isready") this.onmessage?.({data:"readyok"});
      else if (cmd.startsWith("go depth")) {
        this.onmessage?.({data:"info depth 15 multipv 1 score cp 304 pv e2e4 e7e5"});
        this.onmessage?.({data:"info depth 15 multipv 2 score cp 125 pv d2d4 d7d5"});
        this.onmessage?.({data:"bestmove e2e4"});
      }
    });
  }
  terminate() {}
}

const engine=new StockfishAnalysisEngine({workerFactory:()=>new FakeWorker(),depth:15});
assert.equal(await engine.ensureReady(),true);
const board=new Chess();
const result=await engine.evaluate(board,{topK:2});
assert.equal(result.moves[0].san,"e4");
assert.equal(result.moves[0].cp,304);
assert.equal(result.moves[1].san,"d4");
assert.equal(result.moves[1].cp,125);
assert.equal(result.depth,15);
console.log("stockfish-engine-test: 4/4 passed");
