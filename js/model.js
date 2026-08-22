import { getTensor } from "./weights-format.js";
import {
  linear,
  linearVec,
  geluInPlace,
  reluInPlace,
  layerNorm,
  rmsNorm,
  meanRows,
  dot,
  addInPlace,
} from "./linalg.js";
import { NUM_MOVES } from "./movemap.js";

// Faithful port of maia3/models.py::MAIA3Model.forward for a single
// position (batch size 1). Input is the (64, 12*history) tensor produced
// by tokenize.js (the time-info column the Python side appends is always
// sliced away when include_time_info=False, which holds for every
// released Maia3 size, so it's omitted on both sides).
export class Maia3Model {
  constructor(weights) {
    this.w = weights;
    // Resolve weight tensors once at model load. Forward passes are extremely
    // hot; avoiding repeated Map lookups and template-string construction keeps
    // the math identical while reducing JS bookkeeping overhead.
    this._tensorCache = new Map();
    for (const [name, tensor] of weights.tensors.entries()) {
      this._tensorCache.set(name, tensor.data);
    }
    // Own shallow copy -- weights.config also gets sent back to the main
    // thread via postMessage(), so this class must never attach anything
    // (functions, class instances, etc.) onto the *same* object reference,
    // or structured-clone will throw a DataCloneError when that message
    // is posted. (This is exactly what the previous `this.cfg._t = t`
    // line here did -- it mutated the shared config object with a
    // function property. Removed; forward()/runBlock() each already
    // build their own local tensor-accessor closures and never used
    // `cfg._t` at all, so this was dead code with a real side effect.)
    this.cfg = { ...weights.config };
  }

  // selfElo/oppoElo: integers 0-5000.
  // opts.wantPolicy / opts.wantValue allow callers doing value-only or
  // policy-only passes to skip the unused output head without changing the
  // requested output. The root pass requests both, so normal behavior is unchanged.
  forward(historyTokens64xD, selfElo, oppoElo, opts = {}) {
    const wantPolicy = opts.wantPolicy !== false;
    const wantValue = opts.wantValue !== false;
    const cfg = this.cfg;
    const t = (name) => this._tensorCache.get(name);
    const dimVit = cfg.dim_vit;
    const dimEmb = cfg.dim_emb;
    const nHeads = cfg.num_heads;
    const headDim = dimVit / nHeads;
    const historyDim = 12 * cfg.history;

    // ---- Elo interpolation embeddings ----
    const eloLow = t("elo_embedding_low"); // (dimEmb,)
    const eloHigh = t("elo_embedding_high");
    const selfEmb = interpolateElo(selfElo, eloLow, eloHigh, dimEmb);
    const oppoEmb = interpolateElo(oppoElo, eloLow, eloHigh, dimEmb);

    // ---- Build per-square embedding input: [historyTokens(historyDim) | selfElo(dimEmb) | oppoElo(dimEmb)] ----
    const inDim = historyDim + 2 * dimEmb;
    const embs = new Float32Array(64 * inDim);
    for (let s = 0; s < 64; s++) {
      const rowOff = s * inDim;
      embs.set(historyTokens64xD.subarray(s * historyDim, s * historyDim + historyDim), rowOff);
      embs.set(selfEmb, rowOff + historyDim);
      embs.set(oppoEmb, rowOff + historyDim + dimEmb);
    }

    // token_projection: (64, inDim) -> (64, dimVit)
    let x = linear(embs, 64, inDim, t("token_projection.weight"), dimVit, t("token_projection.bias"));

    // no absolute PE for any released size (use_absolute_pe=False)

    for (let blk = 0; blk < cfg.num_blocks; blk++) {
      x = this.runBlock(blk, x, dimVit, nHeads, headDim);
    }

    // final transformer norm (always plain LayerNorm)
    x = layerNorm(x, 64, dimVit, t("final_norm.weight"), t("final_norm.bias"));

    let moveLogits = null;
    if (wantPolicy) {
      // ---- Move (policy) head ----
      const headHid = cfg.head_hid_dim;
      const sqFrom = linear(x, 64, dimVit, t("proj_sq_from.weight"), headHid, null);
      const sqTo = linear(x, 64, dimVit, t("proj_sq_to.weight"), headHid, null);

      const scale = 1 / Math.sqrt(headHid);
      const scoresFlat = new Float32Array(64 * 64);
      for (let i = 0; i < 64; i++) {
        for (let j = 0; j < 64; j++) {
          scoresFlat[i * 64 + j] = dot(sqFrom, i * headHid, sqTo, j * headHid, headHid) * scale;
        }
      }

      // Promotions: rank7 (idx 6) -> rank8 (idx 7), files a-h, mover's frame.
      const promoBiasProjW = t("promo_bias_proj.weight"); // (4, headHid)
      const promoLogits = new Float32Array(8 * 8 * 4);
      let pIdx = 0;
      for (let fromFile = 0; fromFile < 8; fromFile++) {
        const fromSq = 6 * 8 + fromFile; // rank index 6 = "rank 7"
        for (let toFile = 0; toFile < 8; toFile++) {
          const toSq = 7 * 8 + toFile; // rank index 7 = "rank 8"
          const base = scoresFlat[fromSq * 64 + toSq];
          for (let piece = 0; piece < 4; piece++) {
            const bias = dot(promoBiasProjW, piece * headHid, sqTo, toSq * headHid, headHid) * Math.sqrt(headHid);
            promoLogits[pIdx++] = base + bias;
          }
        }
      }

      moveLogits = new Float32Array(NUM_MOVES);
      moveLogits.set(scoresFlat, 0);
      moveLogits.set(promoLogits, 64 * 64);
    }

    let valueLogits = null;
    if (wantValue) {
      // ---- Value head ----
      const headHid = cfg.head_hid_dim;
      let pooled = meanRows(x, 64, dimVit);
      pooled = layerNorm(pooled, 1, dimVit, t("last_ln.weight"), t("last_ln.bias"));
      let vh = linearVec(pooled, dimVit, t("fc_value_hid.weight"), headHid, t("fc_value_hid.bias"));
      reluInPlace(vh);
      valueLogits = linearVec(vh, headHid, t("fc_value.weight"), 3, t("fc_value.bias"));
    }

    return { moveLogits, valueLogits };
  }

  // Batched inference API. It intentionally preserves the exact single-position
  // model math by running each position through the existing forward() path.
  // The worker pool already parallelizes these calls across workers; this API
  // provides a stable seam for future fused linear kernels without changing
  // semantics in the current CPU implementation.
  forwardBatch(batch, selfElo, oppoElo, opts = {}) {
    const wantPolicy = opts.wantPolicy !== false;
    const wantValue = opts.wantValue !== false;
    const values = [];
    const policies = [];
    for (const tokens of batch) {
      const out = this.forward(tokens, selfElo, oppoElo, { wantPolicy, wantValue });
      if (wantValue) values.push(out.valueLogits);
      if (wantPolicy) policies.push(out.moveLogits);
    }
    return { values, policies };
  }

  runBlock(blk, x, dimVit, nHeads, headDim) {
    const t = (name) => this._tensorCache.get(name);
    const p = `transformer.layers.${blk}`;
    const cfg = this.cfg;

    // ---- Geometric Attention Bias (GAB): per-block small MLP -> shared projection ----
    const gabGenSize = cfg.gab_gen_size;
    const gabIntermediate = cfg.gab_intermediate_dim;
    const perSquareDim = cfg.gab_per_square_dim;
    const gabShared = t("gab_shared_weight"); // (4096, gabGenSize)

    let y; // (gabIntermediate-input length before sm2, i.e. either dimVit or 64*perSquareDim)
    if (perSquareDim > 0) {
      const sm1W = t(`${p}.sm1.weight`);
      const sm1B = t(`${p}.sm1.bias`);
      const perSq = linear(x, 64, dimVit, sm1W, perSquareDim, sm1B); // (64, perSquareDim)
      y = perSq; // already flattened row-major = (64*perSquareDim,)
    } else {
      y = meanRows(x, 64, dimVit); // (dimVit,)
    }
    let g = linearVec(y, y.length, t(`${p}.sm2.weight`), gabIntermediate, t(`${p}.sm2.bias`));
    geluInPlace(g);
    g = layerNorm(g, 1, gabIntermediate, t(`${p}.ln1.weight`), t(`${p}.ln1.bias`));
    let g2 = linearVec(g, gabIntermediate, t(`${p}.sm3.weight`), nHeads * gabGenSize, t(`${p}.sm3.bias`));
    geluInPlace(g2);
    g2 = layerNorm(g2, 1, nHeads * gabGenSize, t(`${p}.ln2.weight`), t(`${p}.ln2.bias`));

    // bias[h] (64x64) = gabShared (4096, gabGenSize) @ g2[h] (gabGenSize,)
    // gabShared row-major: row o (0..4095) = query*64+key, columns = gabGenSize
    const biasPerHead = new Array(nHeads);
    for (let h = 0; h < nHeads; h++) {
      const yh = g2.subarray(h * gabGenSize, (h + 1) * gabGenSize);
      const bias = new Float32Array(4096);
      for (let o = 0; o < 4096; o++) {
        bias[o] = dot(gabShared, o * gabGenSize, yh, 0, gabGenSize);
      }
      biasPerHead[h] = bias; // indexed [query*64+key]
    }

    // ---- Multi-head self-attention with GAB bias added to scores ----
    const inProjW = t(`${p}.mha.in_proj_weight`); // (3*dimVit, dimVit)
    const Wq = inProjW.subarray(0, dimVit * dimVit);
    const Wk = inProjW.subarray(dimVit * dimVit, 2 * dimVit * dimVit);
    const Wv = inProjW.subarray(2 * dimVit * dimVit, 3 * dimVit * dimVit);
    const Q = linear(x, 64, dimVit, Wq, dimVit, null);
    const K = linear(x, 64, dimVit, Wk, dimVit, null);
    const V = linear(x, 64, dimVit, Wv, dimVit, null);

    const attnOut = new Float32Array(64 * dimVit);
    const scale = 1 / Math.sqrt(headDim);
    const scores = new Float32Array(64);
    for (let h = 0; h < nHeads; h++) {
      const hOff = h * headDim;
      const bias = biasPerHead[h];
      for (let qi = 0; qi < 64; qi++) {
        let max = -Infinity;
        for (let ki = 0; ki < 64; ki++) {
          const s = dot(Q, qi * dimVit + hOff, K, ki * dimVit + hOff, headDim) * scale + bias[qi * 64 + ki];
          scores[ki] = s;
          if (s > max) max = s;
        }
        let sum = 0;
        for (let ki = 0; ki < 64; ki++) {
          const e = Math.exp(scores[ki] - max);
          scores[ki] = e;
          sum += e;
        }
        const outOff = qi * dimVit + hOff;
        for (let d = 0; d < headDim; d++) {
          let acc = 0;
          for (let ki = 0; ki < 64; ki++) acc += scores[ki] * V[ki * dimVit + hOff + d];
          attnOut[outOff + d] = acc / sum;
        }
      }
    }

    const saOut = linear(attnOut, 64, dimVit, t(`${p}.mha.out_proj.weight`), dimVit, null);
    addInPlace(saOut, x); // residual (in place into saOut to avoid extra alloc)
    const normFn = cfg.use_rms_norm ? rmsNorm : layerNorm;
    let x1 = cfg.use_rms_norm
      ? rmsNorm(saOut, 64, dimVit, t(`${p}.norm1.weight`))
      : layerNorm(saOut, 64, dimVit, t(`${p}.norm1.weight`), t(`${p}.norm1.bias`));

    // ---- Feed-forward ----
    const mlpDim = Math.round(dimVit * cfg.mlp_ratio);
    let ff = linear(x1, 64, dimVit, t(`${p}.linear1.weight`), mlpDim, t(`${p}.linear1.bias`));
    geluInPlace(ff); // all released sizes use activation="gelu"
    ff = linear(ff, 64, mlpDim, t(`${p}.linear2.weight`), dimVit, t(`${p}.linear2.bias`));
    addInPlace(ff, x1);
    let x2 = cfg.use_rms_norm
      ? rmsNorm(ff, 64, dimVit, t(`${p}.norm2.weight`))
      : layerNorm(ff, 64, dimVit, t(`${p}.norm2.weight`), t(`${p}.norm2.bias`));

    return x2;
  }
}

function interpolateElo(elo, embLow, embHigh, dim) {
  const clamped = Math.max(0, Math.min(5000, elo));
  const wLow = clamped / 5000;
  const wHigh = 1 - wLow;
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) out[i] = wLow * embLow[i] + wHigh * embHigh[i];
  return out;
}
