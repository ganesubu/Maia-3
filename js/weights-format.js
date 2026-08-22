// Reads the flat weight container written by convert_weights.py:
//   bytes[0:8]      little-endian uint64 header length (N)
//   bytes[8:8+N]    UTF-8 JSON header: { config: {...}, tensors: { name: {shape, offset, length} } }
//   bytes[8+N:]     all tensors' float32 data, back to back, at the byte
//                    offsets recorded in the header (offset is in *floats*
//                    from the start of the data section... see below).

// Thrown when the chosen file plainly isn't a converted Maia3 container.
// It exists so the file picker can say something useful instead of a raw
// JSON or RangeError -- on Android the picker offers every file type (see
// the note on the file input in index.html), so picking the wrong file is
// an expected mistake rather than an exceptional one.
export class NotAWeightsFileError extends Error {}

export function parseWeights(arrayBuffer) {
  if (!arrayBuffer || arrayBuffer.byteLength < 64) {
    throw new NotAWeightsFileError(
      "That file is too small to be a Maia3 model. Pick the converted .bin file (tens to hundreds of MB)."
    );
  }
  const view = new DataView(arrayBuffer);
  const headerLen = Number(view.getBigUint64(0, true));
  // A real container's JSON header is a few hundred KB at most. Anything
  // else means the first 8 bytes weren't a header length at all.
  if (!Number.isFinite(headerLen) || headerLen <= 0 || headerLen > 8 * 1024 * 1024 || headerLen + 8 > arrayBuffer.byteLength) {
    throw new NotAWeightsFileError(
      "That doesn't look like a converted Maia3 model file. Pick maia3-5m.bin, maia3-23m.bin or maia3-79m.bin."
    );
  }
  const headerBytes = new Uint8Array(arrayBuffer, 8, headerLen);
  const headerJson = new TextDecoder("utf-8").decode(headerBytes);
  let header;
  try {
    header = JSON.parse(headerJson);
  } catch {
    throw new NotAWeightsFileError(
      "That doesn't look like a converted Maia3 model file (its header could not be read)."
    );
  }
  if (!header || !header.config || !header.tensors) {
    throw new NotAWeightsFileError("That file is missing the Maia3 model header. Pick a converted .bin file.");
  }

  // Float32Array views must start on a 4-byte boundary, and 8+headerLen
  // has no such guarantee (JSON text length is arbitrary), so copy the
  // data section into a fresh, aligned ArrayBuffer once at load time.
  const dataStart = 8 + headerLen;
  const dataView = new Float32Array(arrayBuffer.slice(dataStart));

  // meta.offset is a *byte* offset within the data section (see convert_weights.py).
  const tensors = new Map();
  for (const [name, meta] of Object.entries(header.tensors)) {
    const floatOffset = meta.offset / 4;
    tensors.set(name, {
      shape: meta.shape,
      data: dataView.subarray(floatOffset, floatOffset + meta.length),
    });
  }

  return { config: header.config, tensors };
}

export function getTensor(weights, name) {
  const t = weights.tensors.get(name);
  if (!t) throw new Error(`Missing tensor in weights file: ${name}`);
  return t;
}
