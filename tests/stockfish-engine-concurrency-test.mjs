
import assert from "node:assert/strict";
import { Chess } from "../js/chess.esm.js";
import { StockfishAnalysisEngine } from "../js/stockfish-engine.js";
import { EngineCancelledError } from "../js/engine.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));

class FakeWorker {
  static seq = 0;
  constructor() {
    this.id = ++FakeWorker.seq;
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
    this.stopped = false;
    this.lastFen = null;
  }
  postMessage(cmd) {
    if (cmd.startsWith("position fen ")) { this.lastFen = cmd.slice(13); }
    queueMicrotask(() => {
      if (this.stopped) return;
      if (cmd === "uci") this.onmessage?.({data:"uciok"});
      else if (cmd === "isready") this.onmessage?.({data:"readyok"});
      else if (cmd.startsWith("go depth")) {
        const isB = this.lastFen === new Chess("4k3/8/8/8/8/8/8/4K2R w K - 0 1").fen();
        const delay = isB ? 35 : 5;
        const move = isB ? "h1h8" : "a2a3";
        const cp = isB ? 700 : -900;
        setTimeout(() => {
          if (this.stopped) return;
          this.onmessage?.({data:`info depth 15 multipv 1 score cp ${cp} pv ${move}`});
          this.onmessage?.({data:`bestmove ${move}`});
        }, delay);
      }
    });
  }
  terminate() { this.stopped = true; }
}

const posA = new Chess();
const posB = new Chess("4k3/8/8/8/8/8/8/4K2R w K - 0 1");
const engine = new StockfishAnalysisEngine({
  workerFactory: () => new FakeWorker(),
  depth: 15,
  timeoutMs: 1000,
});
await engine.ensureReady();

const a = engine.evaluate(posA, {topK:1});
await sleep(2);
const started = Date.now();
const b = engine.evaluate(posB, {topK:1});

await assert.rejects(() => a, EngineCancelledError);
const rb = await b;
const elapsed = Date.now() - started;

assert.equal(rb.moves.length, 1);
assert.equal(rb.moves[0].uci, "h1h8");
assert.ok(elapsed >= 25, `B resolved too early (${elapsed}ms), likely stale A output`);

class DepthWorker extends FakeWorker {
  postMessage(cmd) {
    if (cmd.startsWith("go depth")) {
      setTimeout(() => this.onmessage?.({data:"info depth 12 multipv 1 score cp 80 pv a2a4"}), 4);
      setTimeout(() => this.onmessage?.({data:"info depth 4 multipv 1 score cp -999 pv a2a3"}), 8);
      setTimeout(() => this.onmessage?.({data:"bestmove a2a4"}), 12);
      return;
    }
    super.postMessage(cmd);
  }
}
const depthEngine = new StockfishAnalysisEngine({workerFactory:()=>new DepthWorker(),depth:15,timeoutMs:1000});
const d = await depthEngine.evaluate(new Chess(), {topK:1});
assert.equal(d.moves[0].cp, 80);
assert.equal(d.moves[0].depth, 12);

console.log("stockfish-engine-concurrency-test: 5/5 passed");
