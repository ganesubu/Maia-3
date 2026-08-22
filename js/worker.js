import { parseWeights } from "./weights-format.js";
import { Maia3Model } from "./model.js";

let model = null;

// Only plain JSON-safe values ever cross this boundary for "ready"
// messages; typed-array payloads for "result" messages go through the
// transfer list separately. This function exists so a future accidental
// mutation elsewhere (attaching a function/class instance to a shared
// object, say) fails loudly and clearly here instead of surfacing as a
// cryptic browser-level DataCloneError.
function toPlainConfig(config) {
  const plain = {};
  for (const [k, v] of Object.entries(config)) {
    const t = typeof v;
    if (v === null || t === "string" || t === "number" || t === "boolean") {
      plain[k] = v;
    } else {
      console.warn(`worker.js: dropping non-cloneable config field "${k}" (${t}) before postMessage`);
    }
  }
  return plain;
}

function safePost(payload, transfer) {
  try {
    self.postMessage(payload, transfer || []);
  } catch (err) {
    // A DataCloneError here means something non-cloneable snuck into
    // `payload` -- report it plainly instead of letting the browser's
    // generic error bubble up unexplained.
    self.postMessage({
      type: "error",
      id: payload.id,
      message:
        "Internal error: tried to send a non-cloneable value from the worker " +
        `(${err.name}: ${err.message}). This is a bug in worker.js/model.js, not your weights file.`,
    });
  }
}

self.onmessage = (e) => {
  const msg = e.data;
  try {
    if (msg.type === "ping") {
      // Lightweight readiness probe: verifies the worker event loop and its
      // loaded model are both alive without running neural inference.
      if (!model) throw new Error("Engine not loaded yet");
      safePost({ type: "pong", id: msg.id });
    } else if (msg.type === "load") {
      const weights = parseWeights(msg.buffer);
      model = new Maia3Model(weights);
      safePost({ type: "ready", id: msg.id, config: toPlainConfig(weights.config) });
    } else if (msg.type === "infer") {
      if (!model) throw new Error("Engine not loaded yet");
      const { moveLogits, valueLogits } = model.forward(msg.tokens, msg.selfElo, msg.oppoElo, { wantPolicy: msg.wantPolicy !== false, wantValue: msg.wantValue !== false });
      const transfer = [];
      if (moveLogits) transfer.push(moveLogits.buffer);
      if (valueLogits) transfer.push(valueLogits.buffer);
      safePost({ type: "result", id: msg.id, moveLogits, valueLogits }, transfer);
    } else if (msg.type === "inferBatch") {
      // One message, many positions: used for candidate values, opponent
      // reply policies and trap-search grandchild values. Only typed
      // arrays cross the boundary, all of them transferred, so nothing
      // here can reintroduce a DataCloneError.
      if (!model) throw new Error("Engine not loaded yet");
      const transfer = [];
      const batched = model.forwardBatch(
        msg.tokens,
        msg.selfElo,
        msg.oppoElo,
        { wantPolicy: !!msg.wantPolicy, wantValue: msg.wantValue !== false }
      );
      const values = batched.values || [];
      const policies = batched.policies || [];
      for (const valueLogits of values) transfer.push(valueLogits.buffer);
      for (const moveLogits of policies) transfer.push(moveLogits.buffer);
      safePost({ type: "result", id: msg.id, values, policies }, transfer);
    } else if (msg.type === "unload") {
      model = null;
      safePost({ type: "unloaded", id: msg.id });
    }
  } catch (err) {
    safePost({ type: "error", id: msg.id, message: err.message + "\n" + (err.stack || "") });
  }
};
