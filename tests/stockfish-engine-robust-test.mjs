
import assert from "node:assert/strict";
import { Chess } from "../js/chess.esm.js";
import { StockfishAnalysisEngine } from "../js/stockfish-engine.js";

class HealthyWorker {
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

class CrashWorker {
  constructor() { this.onmessage=null; this.onerror=null; this.onmessageerror=null; }
  postMessage(cmd) {
    if (cmd === "uci") queueMicrotask(() => this.onerror?.({message:"synthetic worker crash"}));
  }
  terminate() {}
}

class TimeoutWorker {
  constructor() { this.onmessage=null; this.onerror=null; this.onmessageerror=null; }
  postMessage(cmd) {
    queueMicrotask(() => {
      if (cmd === "uci") this.onmessage?.({data:"uciok"});
      else if (cmd === "isready") this.onmessage?.({data:"readyok"});
    });
  }
  terminate() {}
}

const board = new Chess();

const healthy = new StockfishAnalysisEngine({workerFactory:()=>new HealthyWorker(),depth:15,timeoutMs:100});
const ok = await healthy.evaluate(board,{topK:2});
assert.equal(ok.moves[0].uci,"e2e4");
assert.equal(ok.moves[0].cp,304);
assert.equal(ok.moves[1].cp,125);

const crash = new StockfishAnalysisEngine({workerFactory:()=>new CrashWorker(),depth:15,timeoutMs:100});
await assert.rejects(() => crash.ensureReady(), /synthetic worker crash/i);

const timeout = new StockfishAnalysisEngine({workerFactory:()=>new TimeoutWorker(),depth:15,timeoutMs:30});
await assert.rejects(() => timeout.evaluate(board), /timed out/i);

console.log("stockfish-engine-robust-test: 3/3 passed");
