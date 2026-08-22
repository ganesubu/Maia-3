
import { Chess } from "./chess.esm.js";
import { EngineCancelledError } from "./engine.js";

const STOCKFISH_JS = new URL("../stockfish/stockfish-18-lite-single.js", import.meta.url);
const STOCKFISH_VERSION = "18.0.8";

function uciToMove(board, uci) {
  if (!uci || uci.length < 4) return null;
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotion = uci[4] || undefined;
  return board.moves({ verbose: true }).find(
    (m) => m.from === from && m.to === to && (m.promotion || undefined) === promotion
  ) || null;
}

function parseScore(tokens) {
  const i = tokens.indexOf("score");
  if (i < 0) return null;
  const type = tokens[i + 1];
  const value = Number(tokens[i + 2]);
  if (!Number.isFinite(value)) return null;
  if (type === "cp") return value;
  if (type === "mate") return value > 0 ? 100000 : -100000;
  return null;
}

export class StockfishAnalysisEngine {
  constructor({ depth = 15, workerFactory = null, timeoutMs = 120000 } = {}) {
    this.depth = depth;
    this.timeoutMs = timeoutMs;
    this.workerFactory = workerFactory || ((url) => new Worker(url));
    this.worker = null;
    this.ready = false;
    this._waiters = [];
    this._search = null;
  }

  async ensureReady() {
    if (this.ready) return true;
    if (!this.worker) {
      // The workflow bundles this exact file for Android. The desktop launcher
      // downloads it into ./stockfish before the local server starts.
      this.worker = this.workerFactory(STOCKFISH_JS);
      this.worker.onmessage = (event) => this._onLine(String(event.data ?? "").trim());
      this.worker.onerror = (event) => {
        const err = new Error(`Stockfish worker failed: ${event.message || "unknown error"}`);
        this.ready = false;
        this._rejectWaiters(err);
        this._rejectSearch(err);
      };
      this.worker.onmessageerror = () => {
        const err = new Error("Stockfish worker returned an unreadable message.");
        this.ready = false;
        this._rejectWaiters(err);
        this._rejectSearch(err);
      };
    }

    const uciok = this._waitForLine((line) => line === "uciok", 30000);
    this.worker.postMessage("uci");
    await uciok;

    const readyok = this._waitForLine((line) => line === "readyok", 30000);
    this.worker.postMessage("setoption name Threads value 1");
    this.worker.postMessage("setoption name Hash value 32");
    this.worker.postMessage("isready");
    await readyok;

    this.ready = true;
    return true;
  }

  _rejectWaiters(error) {
    for (const waiter of this._waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  _waitForLine(predicate, timeoutMs) {
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      waiter.timer = setTimeout(() => {
        const i = this._waiters.indexOf(waiter);
        if (i >= 0) this._waiters.splice(i, 1);
        reject(new Error("Timed out waiting for Stockfish."));
      }, timeoutMs);
      this._waiters.push(waiter);
    });
  }

  _onLine(line) {
    if (!line) return;

    for (let i = this._waiters.length - 1; i >= 0; i--) {
      const waiter = this._waiters[i];
      if (waiter.predicate(line)) {
        this._waiters.splice(i, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(line);
      }
    }

    const search = this._search;
    if (!search) return;

    if (line.startsWith("info ")) {
      const tokens = line.split(/\s+/);
      const multipv = Math.max(1, Number(tokens[tokens.indexOf("multipv") + 1]) || 1);
      const depth = Number(tokens[tokens.indexOf("depth") + 1]) || 0;
      const cp = parseScore(tokens);
      const pv = tokens.indexOf("pv");
      if (cp !== null && pv >= 0 && tokens[pv + 1]) {
        const previous = search.lines.get(multipv);
        // Stockfish normally reports iterative-deepening updates in increasing
        // depth order. Keep the deepest result seen for each MultiPV rank so a
        // stale/lower-depth line can never overwrite a better one.
        if (!previous || depth >= previous.depth) {
          search.lines.set(multipv, {
            cp,
            depth,
            uci: tokens[pv + 1],
            pv: tokens.slice(pv + 1),
          });
        }
      }
      return;
    }

    if (line.startsWith("bestmove ")) {
      this._finish(line.split(/\s+/)[1] || null);
    }
  }

  _finish(bestmove) {
    const search = this._search;
    if (!search) return;

    this._search = null;
    clearInterval(search.poll);
    clearTimeout(search.timeout);

    if (search.cancelled) {
      search.reject(new EngineCancelledError("Stockfish analysis cancelled."));
      return;
    }

    let records = [...search.lines.values()].sort((a, b) => b.depth - a.depth);
    const byRank = new Map();
    for (const rec of records) {
      const key = rec.uci;
      const previous = byRank.get(key);
      if (!previous || rec.depth >= previous.depth) byRank.set(key, rec);
    }
    records = [...byRank.values()].sort((a, b) => b.depth - a.depth);

    // Preserve MultiPV rank order when possible.
    records.sort((a, b) => {
      const am = [...search.lines.entries()].find(([,v]) => v === a)?.[0] ?? 99;
      const bm = [...search.lines.entries()].find(([,v]) => v === b)?.[0] ?? 99;
      return am - bm;
    });

    if (!records.length && bestmove) {
      records = [{
        cp: 0,
        depth: this.depth,
        uci: bestmove,
        pv: [bestmove],
      }];
    }

    const moves = records.map((rec) => {
      const move = uciToMove(search.board, rec.uci);
      if (!move) return null;
      return {
        uci: rec.uci,
        san: move.san,
        from: move.from,
        to: move.to,
        promotion: move.promotion || null,
        cp: rec.cp,
        prob: 0,
        depth: rec.depth,
        pv: rec.pv,
      };
    }).filter(Boolean);

    search.resolve({
      positionCp: moves[0]?.cp ?? 0,
      wdl: null,
      moves,
      terminal: false,
      depth: Math.max(0, ...moves.map((m) => m.depth || 0)),
    });
  }

  _rejectSearch(error) {
    const search = this._search;
    if (!search) return;
    this._search = null;
    clearInterval(search.poll);
    clearTimeout(search.timeout);
    search.reject(error);
  }

  async evaluate(board, { topK = 3, shouldStop = null, depth = this.depth } = {}) {
    // This engine owns one Stockfish worker and one active search at a time.
    // A new request supersedes the old one. The old worker is terminated before
    // a replacement is created, so late bestmove/info lines from search A can
    // never be mistaken for search B's result.
    if (this._search) {
      this.cancelPending();
    }
    await this.ensureReady();

    // Stockfish is position-based and does not need move history. Rebuild from
    // the complete FEN so a Chess object created directly from a FEN is evaluated
    // as that position too, while preserving side-to-move, castling and en-passant.
    const position = new Chess(board.fen());

    return new Promise((resolve, reject) => {
      const search = {
        board: position,
        lines: new Map(),
        resolve,
        reject,
        cancelled: false,
        poll: null,
        timeout: null,
      };
      this._search = search;

      search.timeout = setTimeout(() => {
        this._rejectSearch(new Error(`Stockfish timed out after ${this.timeoutMs} ms.`));
      }, this.timeoutMs);

      search.poll = setInterval(() => {
        if (shouldStop?.()) {
          search.cancelled = true;
          this.worker.postMessage("stop");
        }
      }, 50);

      try {
        this.worker.postMessage("stop");
        this.worker.postMessage("ucinewgame");
        this.worker.postMessage(`setoption name MultiPV value ${Math.max(1, Math.min(5, topK))}`);
        this.worker.postMessage(`position fen ${position.fen()}`);
        this.worker.postMessage(`go depth ${Math.max(8, Math.min(24, depth))}`);
      } catch (error) {
        this._rejectSearch(error);
      }
    });
  }

  async healthCheck() {
    return this.ensureReady();
  }

  cancelPending() {
    const search = this._search;
    if (!search) return;

    search.cancelled = true;
    // Reject immediately so callers never remain suspended behind a superseded
    // request. Then destroy the worker so any already-queued UCI output from
    // the old search is physically unable to resolve the next search.
    this._search = null;
    clearInterval(search.poll);
    clearTimeout(search.timeout);

    const worker = this.worker;
    this.worker = null;
    this.ready = false;

    try { worker?.postMessage("stop"); } catch {}
    try { worker?.terminate(); } catch {}

    search.reject(new EngineCancelledError("Stockfish analysis cancelled."));
  }

  dispose() {
    this.cancelPending();
    try { this.worker?.terminate(); } catch {}
    this.worker = null;
    this.ready = false;
  }
}

export const STOCKFISH_VERSION_USED = STOCKFISH_VERSION;
