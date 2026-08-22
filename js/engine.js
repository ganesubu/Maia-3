// Maia3 engine facade.
//
// ARCHITECTURE — why this is shaped the way it is.
//
// The previous personality implementation could freeze mid-game. The cause
// was structural, not a missing null check: personality work was a chain of
// awaited worker round-trips with (a) no timeout, (b) no error path for a
// worker that dies without answering, (c) no bound on how much work a
// single move could request, and (d) no answer that could be returned if
// any step failed. Any one stall therefore left the UI awaiting a promise
// that could never settle — which looks exactly like "the app froze while
// Maia was in check", because check positions are where the candidate/reply
// expansion behaved least predictably.
//
// The redesign makes a freeze structurally impossible:
//
//   1. VANILLA FIRST. The root forward pass alone already determines a
//      legal, human-like move. That move is computed and held as a
//      guaranteed answer BEFORE any personality work starts. Everything
//      after it is refinement that may be abandoned at any point.
//   2. EVERY worker call is timeout-guarded, and a timeout tears down and
//      respawns the worker rather than leaving it wedged.
//   3. Worker `onerror` / `onmessageerror` reject every in-flight call, so
//      a dead worker fails loudly and instantly instead of silently.
//   4. All batched work is CHUNKED (<= CHUNK positions per message), so the
//      worker returns to its event loop constantly, in-flight work is
//      bounded, and cancellation is granular.
//   5. A per-move TIME BUDGET, measured against the observed cost of a
//      single forward pass, decides how much refinement is affordable. When
//      the budget runs out, the work stops where it is.
//   6. The whole refinement path is wrapped: any throw, timeout or
//      cancellation degrades to the vanilla move and reports why.
//
// Personality is never disabled around checks. It runs normally there; it
// is simply bounded like everything else.

import { Chess } from "./chess.esm.js";
import { tokenizeBoard, buildHistoryTensor } from "./tokenize.js";
import { ALL_MOVES, MOVE_INDEX, mirrorMoveUci, NUM_MOVES } from "./movemap.js";
import * as idb from "./idb.js";
import {
  PersonalityController,
  trapValueFromReplies,
  TRAP_CANDIDATE_LIMIT,
  TRAP_REPLY_BREADTH,
} from "./personality/controller.js";
import { traitsFor, weightsFor } from "./personality/presets.js";
import { cpFromWinPct } from "./analysis.js";

export class WeightsFetchError extends Error {}
export class EngineTimeoutError extends Error {}
export class EngineCancelledError extends Error {}

// Positions per worker message. Small on purpose: bounds in-flight work,
// keeps the worker's event loop live, and makes cancellation granular.
const CHUNK = 4;
// Timeout per worker message: generous (a 79M forward pass on a slow phone
// is not fast) but finite, which is the entire point.
const TIMEOUT_PER_FORWARD_MS = 20000;
const TIMEOUT_BASE_MS = 15000;

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export class Maia3Engine {
  constructor() {
    this.ready = false;
    this.config = null;
    this.loadedModelId = null;
    this.personality = new PersonalityController();
    // Observed cost of one forward pass, used to decide what a move's time
    // budget can afford. Seeded pessimistically and refined by measurement.
    this.msPerForward = 120;
    this.lastMoveReport = null;

    this._reqId = 0;
    this._pending = new Map();
    this._generation = 0;
    this._snapKey = null;
    this._snaps = [];
    this._batchWorkers = [];
    this._batchPoolTarget = 1;
    this._spawnWorker();
  }

  // ---- worker lifecycle ------------------------------------------------

  _makeWorker(kind) {
    try {
      const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
      const record = { worker, kind, pending: new Set(), queue: Promise.resolve(), dead: false };
      worker.onmessage = (e) => this._onMessage(e.data);
      worker.onerror = (e) => {
        const err = new Error("The engine worker crashed: " + (e.message || "unknown error"));
        this._handleWorkerFailure(record, err);
      };
      worker.onmessageerror = () => {
        this._handleWorkerFailure(
          record,
          new Error("The engine worker sent a message that could not be decoded.")
        );
      };
      return record;
    } catch (err) {
      if (kind === "primary") {
        this.workerError =
          "This browser can't run the engine: it doesn't support module Web Workers. " +
          "On Android, update Android System WebView and Chrome from the Play Store, then reopen the app.";
        console.error(this.workerError, err);
      }
      return null;
    }
  }

  _spawnWorker() {
    const record = this._makeWorker("primary");
    this.primaryWorker = record;
    this.worker = record?.worker || null;
    if (!record) return;
    this.workerError = null;
  }

  _handleWorkerFailure(record, err) {
    record.dead = true;
    for (const id of record.pending) {
      const p = this._pending.get(id);
      if (!p) continue;
      clearTimeout(p.timer);
      this._pending.delete(id);
      p.reject(err);
    }
    record.pending.clear();

    if (record.kind === "primary") {
      this.ready = false;
      this.config = null;
      this.needsRecovery = true;
    } else {
      this._batchWorkers = this._batchWorkers.filter((r) => r !== record && !r.dead);
      // Do not make an auxiliary worker crash take down a healthy primary.
      // A future model load/restart can rebuild the pool.
    }

    try { record.worker.terminate(); } catch {}
  }

  _onMessage(msg) {
    const p = this._pending.get(msg.id);
    if (!p) return; // stale/cancelled request: drop it
    clearTimeout(p.timer);
    this._pending.delete(msg.id);
    p.record?.pending.delete(msg.id);
    if (msg.type === "error") p.reject(new Error(msg.message));
    else p.resolve(msg);
  }

  _callOnRecord(record, payload, transfer, forwards = 1) {
    if (!record || record.dead) {
      return Promise.reject(new Error("The requested engine worker is unavailable."));
    }
    const id = ++this._reqId;
    const timeoutMs = TIMEOUT_BASE_MS + forwards * TIMEOUT_PER_FORWARD_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        record.pending.delete(id);
        reject(new EngineTimeoutError(
          `The engine did not answer within ${Math.round(timeoutMs / 1000)}s.`
        ));
        // A wedged worker is not trusted again. Rebuild the engine so the
        // caller still receives the same safe recovery behavior as before.
        this.restart().catch(() => {});
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer, record });
      record.pending.add(id);
      try {
        record.worker.postMessage({ ...payload, id }, transfer || []);
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        record.pending.delete(id);
        reject(err);
      }
    });
  }

  _call(payload, transfer, forwards = 1) {
    return this._callOnRecord(this.primaryWorker, payload, transfer, forwards);
  }

  _terminateBatchWorkers() {
    for (const record of this._batchWorkers) {
      record.dead = true;
      try { record.worker.terminate(); } catch {}
    }
    this._batchWorkers = [];
    this._batchPoolTarget = 1;
  }

  _desiredBatchPoolSize(modelId = this.loadedModelId) {
    const cores = Number(
      typeof navigator !== "undefined" && navigator.hardwareConcurrency
        ? navigator.hardwareConcurrency
        : 2
    );
    const deviceMemory = Number(
      typeof navigator !== "undefined" && navigator.deviceMemory
        ? navigator.deviceMemory
        : 0
    );

    // One primary worker is always retained. Add one auxiliary worker for
    // the large 79M model only on devices with enough CPU/RAM to justify the
    // extra model copy. Smaller models can safely use up to three auxiliaries.
    const is79 = /79m/i.test(String(modelId || ""));
    if (is79) {
      if (deviceMemory > 0 && deviceMemory < 8) return 1;
      return cores >= 4 ? 2 : 1;
    }

    const maxTotal = cores >= 8 ? 4 : cores >= 4 ? 3 : 2;
    if (deviceMemory > 0 && deviceMemory < 4) return Math.min(2, maxTotal);
    return maxTotal;
  }

  async _buildBatchWorkerPool(weightBuffer, modelId) {
    this._terminateBatchWorkers();
    const target = this._desiredBatchPoolSize(modelId);
    this._batchPoolTarget = target;
    if (target <= 1 || !weightBuffer) return;

    // Each worker owns its own immutable model instance. Make a fresh copy
    // for every auxiliary worker; the primary worker already owns the buffer
    // transferred by _loadIntoWorker().
    for (let i = 1; i < target; i++) {
      const record = this._makeWorker("batch");
      if (!record) continue;
      try {
        const copy = weightBuffer.slice(0);
        await this._callOnRecord(record, { type: "load", buffer: copy }, [copy], 1);
        this._batchWorkers.push(record);
      } catch (err) {
        record.dead = true;
        try { record.worker.terminate(); } catch {}
        console.warn("Auxiliary Maia worker could not load; continuing with fewer workers.", err);
      }
    }

    if (this._batchWorkers.length) {
      console.info(
        `Maia personality inference: using ${1 + this._batchWorkers.length} worker(s) ` +
        `for independent batch positions.`
      );
    }
  }

  _failAll(err) {
    for (const [id, p] of this._pending) {
      clearTimeout(p.timer);
      p.record?.pending.delete(id);
      p.reject(err);
    }
    this._pending.clear();
    this.primaryWorker?.pending.clear?.();
    for (const r of this._batchWorkers) r.pending.clear();
    this.ready = false;
    this.config = null;
    this.needsRecovery = true;
  }

  // Abandon everything in flight. The workers may still be mid-forward-pass,
  // but their answers are now unclaimed and dropped.
  cancelPending(reason = "cancelled") {
    this._generation += 1;
    for (const [id, p] of this._pending) {
      clearTimeout(p.timer);
      p.record?.pending.delete(id);
      p.reject(new EngineCancelledError(reason));
    }
    this._pending.clear();
  }

  // Tear down and rebuild the worker(s), then put the weights back if they
  // are cached on the device. Used after a timeout or crash.
  async restart() {
    try { this.primaryWorker?.worker.terminate(); } catch {}
    this._terminateBatchWorkers();
    this.primaryWorker = null;
    this.worker = null;
    this._failAll(new EngineCancelledError("engine restarted"));
    this._spawnWorker();
    this.needsRecovery = true;
    if (this.loadedModelId) {
      try {
        await this.loadFromCache(this.loadedModelId);
        this.needsRecovery = false;
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  // ---- loading ---------------------------------------------------------

  async _loadIntoWorker(buffer, modelId = this.loadedModelId) {
    // Keep one untouched copy long enough to initialize the auxiliary workers.
    // The primary worker receives its own transferred copy.
    const poolSource = buffer.slice(0);
    const primaryBuffer = buffer.slice(0);
    const msg = await this._call({ type: "load", buffer: primaryBuffer }, [primaryBuffer], 1);
    this.ready = true;
    this.needsRecovery = false;
    this.config = msg.config;
    await this._buildBatchWorkerPool(poolSource, modelId);
    return this.config;
  }

  async unload() {
    if (!this.ready) return;
    this._terminateBatchWorkers();
    try {
      await this._call({ type: "unload" }, [], 1);
    } catch {
      /* a failed unload is not worth blocking a model switch */
    }
    this.ready = false;
    this.config = null;
    this.loadedModelId = null;
  }

  async isCached(modelId) {
    try {
      return !!(await idb.loadWeights(modelId));
    } catch {
      return false;
    }
  }

  async loadFromCache(modelId) {
    const entry = await idb.loadWeights(modelId);
    if (!entry) return null;
    await this._loadIntoWorker(entry.buffer, modelId);
    this.loadedModelId = modelId;
    return entry.meta || null;
  }

  async loadFromBundled(modelId, filePath, { onProgress } = {}) {
    let res;
    try {
      res = await fetch(filePath, { cache: "no-store" });
    } catch (err) {
      throw new WeightsFetchError(`Could not reach ${filePath}: ${err.message}`);
    }
    if (!res.ok) throw new WeightsFetchError(`${filePath} responded with HTTP ${res.status}`);
    const buffer = await readResponseWithProgress(res, onProgress);
    await this._loadIntoWorker(buffer, modelId);
    this.loadedModelId = modelId;
    let cached = true;
    try {
      await idb.saveWeights(modelId, buffer, { label: modelId, source: "bundled" });
    } catch (err) {
      cached = false;
      console.warn("Loaded, but could not cache for offline reuse:", err);
    }
    return { cached };
  }

  async loadFromFile(modelId, file, { onProgress } = {}) {
    const buffer = await readFileWithProgress(file, onProgress);
    await this._loadIntoWorker(buffer, modelId);
    this.loadedModelId = modelId;
    let cached = true;
    try {
      await idb.saveWeights(modelId, buffer, { label: file.name, source: "file" });
    } catch (err) {
      cached = false;
      console.warn("Loaded, but could not cache for offline reuse:", err);
    }
    return { cached };
  }

  async clearCache(modelId) {
    await idb.deleteWeights(modelId);
    if (this.loadedModelId === modelId) await this.unload();
  }

  // ---- position history ------------------------------------------------
  //
  // Maia3 conditions on the last `history` positions. Rather than keeping a
  // mutable running buffer in sync with the UI (a permanent source of
  // desync bugs on undo / variation exploration), snapshots are derived
  // from whatever Chess instance is handed in, memoised by move prefix so
  // the common "one more move than last time" case is incremental.

  _snapshotsFor(chess) {
    const sanHistory = chess.history();
    const key = sanHistory.join(" ");
    if (key === this._snapKey) return this._snaps;
    if (this._snapKey !== null && key.startsWith(this._snapKey) && this._snaps.length) {
      // Extension of the previous line: replay only the new plies.
      const prevCount = this._snapKey === "" ? 0 : this._snapKey.split(" ").length;
      const replay = new Chess();
      for (let i = 0; i < sanHistory.length; i++) replay.move(sanHistory[i]);
      // (Replaying from scratch is a handful of microseconds; what matters
      // is that the snapshot ARRAY is rebuilt correctly, so this stays
      // simple and correct rather than clever.)
      void prevCount;
      this._snaps = snapshotsOf(sanHistory);
      this._snapKey = key;
      return this._snaps;
    }
    this._snaps = snapshotsOf(sanHistory);
    this._snapKey = key;
    return this._snaps;
  }

  _tokensFor(chess, extraSnapshots = []) {
    const root = this._snapshotsFor(chess);
    if (!extraSnapshots.length) return buildHistoryTensor(root, this.config.history);
    const rootTokens = buildHistoryTensor(root, this.config.history);
    return extendHistoryTensor(rootTokens, extraSnapshots, this.config.history);
  }

  // ---- low-level inference --------------------------------------------

  buildLegalMask(chess) {
    const mover = chess.turn();
    const legalIdx = [];
    for (const m of chess.moves({ verbose: true })) {
      let uci = m.from + m.to + (m.promotion || "");
      if (mover === "b") uci = mirrorMoveUci(uci);
      const idx = MOVE_INDEX.get(uci);
      if (idx !== undefined) legalIdx.push(idx);
    }
    return legalIdx;
  }

  async _inferOne(tokens, selfElo, oppoElo, wantPolicy = true, wantValue = true) {
    const t0 = now();
    const res = await this._call({ type: "infer", tokens, selfElo, oppoElo, wantPolicy, wantValue }, [tokens.buffer], 1);
    this._recordTiming(now() - t0, 1);
    return res;
  }

  _adaptiveChunkSize() {
    // Keep the existing safety property, but avoid a fixed CHUNK=4 for models
    // whose forward-pass latency is much smaller. Target roughly 100 ms of work
    // per message, clamped so cancellation/timeout responsiveness never gets
    // lost.
    const targetMs = 100;
    const per = Math.max(1, this.msPerForward);
    return Math.max(2, Math.min(8, Math.round(targetMs / per)));
  }

  // Batched inference, chunked so no single message can monopolise the
  // worker and so a budget can be re-checked between chunks.
  async _inferBatch(tokensList, selfElo, oppoElo, wantPolicy, deadline, shouldStop, wantValue = !wantPolicy) {
    const chunks = [];
    const chunkSize = this._adaptiveChunkSize();
    for (let i = 0; i < tokensList.length; i += chunkSize) {
      if (deadline && now() > deadline) break;
      if (shouldStop && shouldStop()) break;
      chunks.push(tokensList.slice(i, i + chunkSize));
    }
    if (!chunks.length) return { values: [], policies: [] };

    const workers = [this.primaryWorker, ...this._batchWorkers].filter((r) => r && !r.dead);
    const valuesByChunk = new Array(chunks.length);
    const policiesByChunk = new Array(chunks.length);

    // Each worker receives one queued chain. Chains run in parallel across
    // workers, while a given worker processes its own chunks serially. This
    // preserves worker/event-loop safety without ever putting two expensive
    // model forwards on the same worker at once.
    const chains = workers.map((record, workerIndex) => {
      const assigned = chunks
        .map((slice, chunkIndex) => ({ slice, chunkIndex }))
        .filter((_, chunkIndex) => chunkIndex % workers.length === workerIndex);

      return assigned.reduce(
        (chain, { slice, chunkIndex }) =>
          chain.then(async () => {
            if (deadline && now() > deadline) return;
            if (shouldStop && shouldStop()) return;
            const t0 = now();
            const res = await this._callOnRecord(
              record,
              {
                type: "inferBatch",
                tokens: slice,
                selfElo,
                oppoElo,
                wantPolicy: !!wantPolicy,
                wantValue,
              },
              slice.map((t) => t.buffer),
              slice.length
            );
            this._recordTiming(now() - t0, slice.length);
            valuesByChunk[chunkIndex] = res.values || [];
            policiesByChunk[chunkIndex] = res.policies || [];
          }),
        Promise.resolve()
      );
    });

    try {
      await Promise.all(chains);
    } catch (err) {
      // Preserve the existing safety contract: an engine problem causes
      // personality refinement to abandon cleanly rather than hanging.
      throw err;
    }

    const values = [];
    const policies = [];
    // Results must remain position-aligned with tokensList. If a later chunk
    // finishes but an earlier chunk was cut off by the deadline/worker failure,
    // never slide the later answers left onto the wrong candidate.
    for (let i = 0; i < chunks.length; i++) {
      if (!valuesByChunk[i] && !policiesByChunk[i]) break;
      if (valuesByChunk[i]) values.push(...valuesByChunk[i]);
      if (policiesByChunk[i]) policies.push(...policiesByChunk[i]);
    }
    return { values, policies };
  }

  _recordTiming(ms, forwards) {
    if (!forwards) return;
    const per = ms / forwards;
    // Exponential moving average, so one slow first call (JIT warm-up)
    // doesn't permanently pessimise the budget.
    this.msPerForward = this.msPerForward * 0.7 + per * 0.3;
  }

  // ---- move selection --------------------------------------------------

  /**
   * opts:
   *   selfElo, oppoElo         Maia conditioning
   *   temperature, topP        sampling over the final ranking
   *   multiPv                  how many policy entries to report back
   *   presetId, strength       personality (null preset = vanilla)
   *   breadth                  max Maia candidates personality may rank
   *   trapSearch               allow the bounded opponent-model search
   *   budgetMs                 wall-clock budget for personality refinement
   *   bookMove                 a UCI/SAN forced by the opening book, if any
   */
  async requestMove(chess, opts = {}) {
    const {
      selfElo = 1500,
      oppoElo = 1500,
      temperature = 1.0,
      topP = 1.0,
      multiPv = 5,
      presetId = null,
      strength = 1,
      breadth = 5,
      trapSearch = true,
      budgetMs = 2500,
      usePresetBook = true,
      maxOverrideNats,
    } = opts;

    if (!this.ready) throw new Error("Engine weights are not loaded yet.");
    if (chess.isGameOver()) return { move: null, topMoves: [], wdl: null };

    const started = now();
    const legalIdx = this.buildLegalMask(chess);
    if (!legalIdx.length) return { move: null, topMoves: [], wdl: null };

    const weights = presetId ? weightsFor(presetId) : null;
    const mover = chess.turn();
    const effSelfElo = weights ? this.personality.phaseShiftedElo(chess, selfElo, presetId) : selfElo;

    // ---- step 1: the guaranteed answer -------------------------------
    const rootTokens = this._tokensFor(chess);
    const root = await this._inferOne(rootTokens, effSelfElo, oppoElo);

    const masked = new Float32Array(NUM_MOVES).fill(-Infinity);
    for (const idx of legalIdx) masked[idx] = root.moveLogits[idx];

    // Personality must not secretly alter Maia's policy temperature.
    // Elo determines Maia's baseline strength; personality re-ranking happens
    // on top of the same Elo-conditioned policy for every character. Global
    // Temperature controls only final move sampling.
    const policyLogits = masked;
    const probs = softmax(policyLogits);
    const w = softmax3(root.valueLogits);
    const wdl = { loss: w[0], draw: w[1], win: w[2] };

    const ordered = legalIdx
      .map((idx) => ({ idx, prob: probs[idx] }))
      .sort((a, b) => b.prob - a.prob);
    const topMoves = ordered
      .slice(0, Math.min(multiPv, ordered.length))
      .map(({ idx, prob }) => ({ uci: decodeMove(idx, mover).uci, prob }));

    const fallbackMove = decodeMove(sampleFromLogits(policyLogits, temperature, topP), mover);
    const vanillaResult = () => ({ move: fallbackMove, topMoves, wdl, personality: null });

    if (!weights || legalIdx.length === 1) {
      this.lastMoveReport = { mode: weights ? "forced" : "vanilla", ms: now() - started };
      return vanillaResult();
    }

    // ---- step 2: bounded refinement ----------------------------------
    try {
      const refined = await this._personalityMove(chess, {
        ordered,
        probs,
        mover,
        weights,
        presetId,
        strength,
        breadth,
        trapSearch,
        temperature,
        topP,
        maxOverrideNats,
        effSelfElo,
        oppoElo,
        drawProb: wdl.draw,
        usePresetBook,
        deadline: started + budgetMs,
        started,
      });
      if (!refined) {
        this.lastMoveReport = { mode: "vanilla-fallback", reason: "no affordable candidates", ms: now() - started };
        return vanillaResult();
      }
      this.lastMoveReport = { mode: "personality", ms: now() - started, ...refined.report };
      return { move: refined.move, topMoves, wdl, personality: refined.info };
    } catch (err) {
      // Timeout, cancellation, worker crash or a bug in the personality
      // code: the game continues with Maia's own move rather than hanging.
      console.warn("Personality refinement abandoned:", err);
      this.lastMoveReport = {
        mode: "vanilla-fallback",
        reason: err instanceof EngineTimeoutError ? "timeout" : err.name || "error",
        detail: err.message,
        ms: now() - started,
      };
      if (err instanceof EngineCancelledError) throw err; // caller wants to know
      return vanillaResult();
    }
  }

  async _personalityMove(chess, o) {
    const remaining = () => o.deadline - now();
    // How many extra forward passes the remaining budget can pay for, using
    // the observed cost of one. This is what makes the same code sensible on
    // both a 5M model on a fast phone and a 79M model on a slow one.
    const affordable = Math.floor(Math.max(0, remaining()) / Math.max(1, this.msPerForward));
    if (affordable < 2) return null;

    const wanted = Math.max(2, Math.min(o.breadth, affordable, o.ordered.length));
    const fenBefore = chess.fen();
    const byUci = new Map();
    for (const m of chess.moves({ verbose: true })) byUci.set(m.from + m.to + (m.promotion || ""), m);

    const candidates = [];
    for (const { idx, prob } of o.ordered) {
      if (candidates.length >= wanted) break;
      const dec = decodeMove(idx, o.mover);
      const move = byUci.get(dec.uci);
      if (!move) continue;
      const childChess = new Chess(fenBefore);
      try {
        childChess.move({ from: move.from, to: move.to, promotion: move.promotion });
      } catch {
        continue;
      }
      candidates.push({ idx, prob, uci: dec.uci, move, childChess, trapValue: 0 });
    }
    if (candidates.length < 2) return null;

    // ---- 1-ply values: the soundness gate's input --------------------
    const needsValue = [];
    const valueTokens = [];
    for (const c of candidates) {
      if (c.childChess.isCheckmate()) {
        c.cp = 1000;
      } else if (c.childChess.isGameOver()) {
        c.cp = 0;
      } else {
        needsValue.push(c);
        valueTokens.push(this._tokensFor(chess, [tokenizeBoard(c.childChess)]));
      }
    }
    if (valueTokens.length) {
      const batch = await this._inferBatch(valueTokens, o.effSelfElo, o.oppoElo, false, o.deadline, null, true);
      const count = Math.min(batch.values.length, needsValue.length);
      if (batch.values.length > needsValue.length) {
        console.warn("Engine returned more value results than requested; ignoring extras to preserve candidate alignment.");
      }
      for (let i = 0; i < count; i++) {
        const v = softmax3(batch.values[i]);
        // The child has the OPPONENT to move, so the value head speaks for
        // them; negate for our own perspective. Units are win-permille minus
        // loss-permille, the scale SOUNDNESS_TOLERANCE/BLUNDER_THRESHOLD use.
        needsValue[i].cp = -Math.round((v[2] - v[0]) * 1000);
      }
    }

    // Candidates the budget ran out on have no value, so the soundness gate
    // has nothing to judge them by. Dropping them is the safe choice:
    // keeping them would let personality promote an ungated move.
    const gated = candidates.filter((c) => typeof c.cp === "number");
    if (gated.length < 2) return null;

    // ---- trap search: strictly optional, strictly bounded -------------
    let trapRan = false;
    if (o.trapSearch && (o.weights.trappy || 0) > 0) {
      const canAfford = Math.floor(Math.max(0, remaining()) / Math.max(1, this.msPerForward));
      if (canAfford >= 4) {
        try {
          await this._attachTrapValues(chess, gated.slice(0, TRAP_CANDIDATE_LIMIT), o);
          trapRan = true;
        } catch (err) {
          if (err instanceof EngineCancelledError) throw err;
          console.warn("Trap search skipped:", err);
        }
      }
    }

    const decision = this.personality.chooseMove(chess, gated, {
      presetId: o.presetId,
      strength: o.strength,
      temperature: o.temperature,
      topP: o.topP,
      drawProb: o.drawProb,
      useBook: o.usePresetBook,
      maxOverrideNats: o.maxOverrideNats,
    });
    if (!decision) return null;

    const chosen = decision.chosen;
    const f = chosen.features;
    const info = {
      presetId: o.presetId,
      uci: f.uci,
      pull: chosen.pull,
      soundness: chosen.soundness,
      inBook: chosen.inBook,
      trapValue: f.trap_value,
      phase: f.phase,
      momentum: this.personality.flankCommitment,
      policyRank: 1 + o.ordered.findIndex((x) => decodeMove(x.idx, o.mover).uci === f.uci),
      top: (chosen.breakdown || [])
        .slice()
        .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
        .slice(0, 3)
        .map((d) => ({ id: d.id, value: d.contribution })),
      candidates: decision.ranked.map((r) => ({
        uci: r.features.uci,
        san: r.features.move.san,
        prob: r.features.policy_prob,
        cp: r.features.model_cp,
        score: r.score,
      })),
    };

    return {
      move: {
        from: f.move.from,
        to: f.move.to,
        promotion: f.move.promotion || undefined,
        uci: f.uci,
      },
      info,
      report: { candidates: gated.length, trapRan, breadth: wanted },
    };
  }

  async _attachTrapValues(chess, candidates, o) {
    const usable = candidates.filter((c) => !c.childChess.isGameOver());
    if (!usable.length) return;

    const replyTokens = usable.map((c) => this._tokensFor(chess, [tokenizeBoard(c.childChess)]));
    const replyBatch = await this._inferBatch(replyTokens, o.oppoElo, o.effSelfElo, true, o.deadline, null, false);
    if (!replyBatch.policies.length) return;

    const jobs = [];
    for (let i = 0; i < replyBatch.policies.length; i++) {
      const child = usable[i];
      const childChess = child.childChess;
      const legal = this.buildLegalMask(childChess);
      if (legal.length < 2) continue; // forced reply: nothing to go wrong with
      const logits = replyBatch.policies[i];
      const maskedReply = new Float32Array(NUM_MOVES).fill(-Infinity);
      for (const idx of legal) maskedReply[idx] = logits[idx];
      const rProbs = softmax(maskedReply);
      const replyBy = new Map();
      for (const m of childChess.moves({ verbose: true })) {
        replyBy.set(m.from + m.to + (m.promotion || ""), m);
      }
      const childFen = childChess.fen();
      const replies = [];
      for (const { idx, prob } of legal
        .map((idx) => ({ idx, prob: rProbs[idx] }))
        .sort((a, b) => b.prob - a.prob)
        .slice(0, TRAP_REPLY_BREADTH)) {
        const dec = decodeMove(idx, childChess.turn());
        const rm = replyBy.get(dec.uci);
        if (!rm) continue;
        const gc = new Chess(childFen);
        try {
          gc.move({ from: rm.from, to: rm.to, promotion: rm.promotion });
        } catch {
          continue;
        }
        replies.push({ prob, gc });
      }
      if (replies.length >= 2) jobs.push({ child, replies });
    }

    const gcTokens = [];
    const gcSlots = [];
    for (const job of jobs) {
      for (const r of job.replies) {
        if (r.gc.isCheckmate()) r.value = -1000;
        else if (r.gc.isGameOver()) r.value = 0;
        else {
          gcSlots.push(r);
          gcTokens.push(
            this._tokensFor(chess, [tokenizeBoard(job.child.childChess), tokenizeBoard(r.gc)])
          );
        }
      }
    }
    if (gcTokens.length) {
      const batch = await this._inferBatch(gcTokens, o.effSelfElo, o.oppoElo, false, o.deadline, null, true);
      for (let i = 0; i < batch.values.length; i++) {
        const v = softmax3(batch.values[i]);
        // The grandchild has US to move, so the value head already speaks
        // for us.
        gcSlots[i].value = Math.round((v[2] - v[0]) * 1000);
      }
    }

    for (const job of jobs) {
      // Only score a trap whose replies were all actually evaluated.
      if (job.replies.some((r) => typeof r.value !== "number")) continue;
      job.child.trapValue = trapValueFromReplies(
        job.replies.map((r) => r.value),
        job.replies.map((r) => r.prob)
      );
    }
  }

  // Lightweight health probe used by post-game analysis/variation review.
  // `ready === true` alone is not sufficient: the worker may have died or
  // become wedged while the flag still reflects the last successful load.
  async healthCheck() {
    if (!this.ready || !this.worker) return false;
    try {
      const msg = await this._call({ type: "ping" }, [], 1);
      return msg && msg.type === "pong";
    } catch {
      return false;
    }
  }

  // ---- analysis --------------------------------------------------------

  /**
   * Evaluate one position with a fixed (strong) Elo configuration.
   *
   * Returns:
   *   wdl          win/draw/loss for the SIDE TO MOVE at this position
   *   positionCp   this position's own value, side-to-move POV. This is
   *                what an eval bar must show. It deliberately does NOT
   *                use the best child's value: that is a 1-ply search
   *                result and is biased toward whoever is on move, which
   *                makes the bar lurch every ply regardless of whether
   *                anyone actually erred.
   *   moves        top-K moves, each with its own 1-ply value (used to
   *                judge move quality WITHIN this position, where the
   *                bias cancels because every entry carries it equally)
   *
   * `shouldStop` is polled between chunks so a user pressing Stop is
   * obeyed within one chunk rather than at the end of the position.
   */
  async evaluate(chess, { elo = 2600, topK = 4, includeUci = null, shouldStop = null } = {}) {
    if (!this.ready) throw new Error("Engine weights are not loaded yet.");
    if (chess.isGameOver()) {
      // A finished game has a known result, not a predicted one. The three
      // probabilities must still be a valid distribution: an earlier
      // version computed a "draw" term that made them sum to 2, which fed a
      // nonsense win% into the eval bar on the final position.
      const mated = chess.isCheckmate();
      return {
        positionCp: mated ? -1000 : 0,
        wdl: mated ? { win: 0, draw: 0, loss: 1 } : { win: 0, draw: 1, loss: 0 },
        moves: [],
        terminal: true,
        mate: mated,
      };
    }
    const legalIdx = this.buildLegalMask(chess);
    if (!legalIdx.length) return { positionCp: 0, wdl: null, moves: [], terminal: true };

    const mover = chess.turn();
    const root = await this._inferOne(this._tokensFor(chess), elo, elo);
    const masked = new Float32Array(NUM_MOVES).fill(-Infinity);
    for (const idx of legalIdx) masked[idx] = root.moveLogits[idx];
    const probs = softmax(masked);
    const w = softmax3(root.valueLogits);
    const wdl = { loss: w[0], draw: w[1], win: w[2] };
    // Win% -> cp via the inverse of Lichess's sigmoid, so the number on the
    // bar means what it means everywhere else in chess.
    const positionCp = cpFromWinPct(100 * (wdl.win + wdl.draw / 2));

    if (shouldStop && shouldStop()) {
      return { positionCp, wdl, moves: [], terminal: false, stopped: true };
    }

    const byUci = new Map();
    for (const m of chess.moves({ verbose: true })) byUci.set(m.from + m.to + (m.promotion || ""), m);

    const ordered = legalIdx
      .map((idx) => ({ idx, prob: probs[idx] }))
      .sort((a, b) => b.prob - a.prob);

    const picked = [];
    const seen = new Set();
    for (const { idx, prob } of ordered) {
      if (picked.length >= topK) break;
      const uci = decodeMove(idx, mover).uci;
      const move = byUci.get(uci);
      if (!move || seen.has(uci)) continue;
      seen.add(uci);
      picked.push({ uci, prob, move });
    }
    // The move actually played is always evaluated, even when Maia's policy
    // never proposed it -- otherwise a bad move could never be scored.
    if (includeUci && !seen.has(includeUci) && byUci.has(includeUci)) {
      const mirrored = mover === "b" ? mirrorMoveUci(includeUci) : includeUci;
      const idx = MOVE_INDEX.get(mirrored);
      picked.push({ uci: includeUci, prob: idx === undefined ? 0 : probs[idx] || 0, move: byUci.get(includeUci) });
      seen.add(includeUci);
    }

    const fen = chess.fen();
    const tokens = [];
    const slots = [];
    for (const p of picked) {
      const child = new Chess(fen);
      try {
        child.move({ from: p.move.from, to: p.move.to, promotion: p.move.promotion });
      } catch {
        continue;
      }
      p.child = child;
      if (child.isCheckmate()) p.cp = 1000;
      else if (child.isGameOver()) p.cp = 0;
      else {
        slots.push(p);
        tokens.push(this._tokensFor(chess, [tokenizeBoard(child)]));
      }
    }
    if (tokens.length) {
      const batch = await this._inferBatch(tokens, elo, elo, false, null, shouldStop);
      for (let i = 0; i < batch.values.length; i++) {
        const v = softmax3(batch.values[i]);
        // The child has the OPPONENT to move, so its win% speaks for them;
        // 100 - that is the mover's win% after this move.
        const childWin = 100 * (v[2] + v[1] / 2);
        slots[i].cp = cpFromWinPct(100 - childWin);
      }
    }

    const moves = picked
      .filter((p) => typeof p.cp === "number")
      .map((p) => ({
        uci: p.uci,
        san: p.move.san,
        from: p.move.from,
        to: p.move.to,
        promotion: p.move.promotion || null,
        prob: p.prob,
        cp: p.cp,
      }))
      .sort((a, b) => b.cp - a.cp);

    return { positionCp, wdl, moves, terminal: false };
  }
}

// ---- helpers -----------------------------------------------------------

function extendHistoryTensor(rootTokens, extraSnapshots, history) {
  const frameSize = 64 * 12;
  const dim = 12 * history;
  const out = new Float32Array(rootTokens.length);
  const shiftFrames = Math.min(extraSnapshots.length, history);
  const retainedFrames = history - shiftFrames;
  for (let sq = 0; sq < 64; sq++) {
    const srcBase = sq * dim;
    const dstBase = sq * dim;
    if (retainedFrames > 0) {
      out.set(
        rootTokens.subarray(srcBase + shiftFrames * 12, srcBase + history * 12),
        dstBase
      );
    }
    for (let i = 0; i < shiftFrames; i++) {
      const frame = extraSnapshots[extraSnapshots.length - shiftFrames + i];
      out.set(frame.subarray(sq * 12, sq * 12 + 12), dstBase + (retainedFrames + i) * 12);
    }
  }
  return out;
}

function snapshotsOf(sanHistory) {
  const replay = new Chess();
  const snaps = [tokenizeBoard(replay)];
  for (const san of sanHistory) {
    try {
      replay.move(san);
    } catch {
      break;
    }
    snaps.push(tokenizeBoard(replay));
  }
  return snaps;
}

async function readResponseWithProgress(res, onProgress) {
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body || !total) {
    onProgress && onProgress({ loaded: 0, total: 0, indeterminate: true });
    return await res.arrayBuffer();
  }
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress && onProgress({ loaded, total, indeterminate: false });
  }
  const buffer = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer.buffer;
}

function readFileWithProgress(file, onProgress) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (e) => {
      if (onProgress) onProgress({ loaded: e.loaded, total: e.total || file.size, indeterminate: !e.lengthComputable });
    };
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Could not read file"));
    reader.readAsArrayBuffer(file);
  });
}

export function decodeMove(idx, mover) {
  let uci = ALL_MOVES[idx];
  if (mover === "b") uci = mirrorMoveUci(uci);
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.length > 4 ? uci.slice(4) : undefined,
    uci,
  };
}

function softmax(a) {
  let max = -Infinity;
  for (let i = 0; i < a.length; i++) if (a[i] > max) max = a[i];
  const out = new Float32Array(a.length);
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const v = a[i] === -Infinity ? 0 : Math.exp(a[i] - max);
    out[i] = v;
    sum += v;
  }
  if (sum > 0) for (let i = 0; i < a.length; i++) out[i] /= sum;
  return out;
}

function softmax3(a) {
  const max = Math.max(a[0], a[1], a[2]);
  const e0 = Math.exp(a[0] - max);
  const e1 = Math.exp(a[1] - max);
  const e2 = Math.exp(a[2] - max);
  const s = e0 + e1 + e2;
  return [e0 / s, e1 / s, e2 / s];
}

function sampleFromLogits(logits, temperature, topP) {
  if (temperature <= 0) {
    let best = -1;
    let bestVal = -Infinity;
    for (let i = 0; i < logits.length; i++) {
      if (logits[i] > bestVal) {
        bestVal = logits[i];
        best = i;
      }
    }
    return best;
  }
  const scaled = new Float32Array(logits.length);
  for (let i = 0; i < logits.length; i++) scaled[i] = logits[i] / temperature;
  const probs = softmax(scaled);
  if (topP < 1) {
    const order = Array.from(probs.keys()).sort((a, b) => probs[b] - probs[a]);
    let cum = 0;
    const keep = [];
    for (const idx of order) {
      cum += probs[idx];
      keep.push(idx);
      if (cum > topP) break;
    }
    let sum = 0;
    for (const idx of keep) sum += probs[idx];
    let r = Math.random() * sum;
    for (const idx of keep) {
      r -= probs[idx];
      if (r <= 0) return idx;
    }
    return keep[keep.length - 1];
  }
  let r = Math.random();
  for (let i = 0; i < probs.length; i++) {
    r -= probs[i];
    if (r <= 0) return i;
  }
  return probs.length - 1;
}
