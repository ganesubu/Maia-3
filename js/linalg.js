// Tiny linear-algebra kernels for running Maia3 in plain JS. Everything
// operates on flat Float32Arrays in row-major order to keep this fast and
// GC-friendly on mobile devices.

// out[r, o] = bias[o] + sum_i x[r, i] * W[o, i]   (W is PyTorch nn.Linear layout: [out, in])
export function linear(x, rows, inDim, W, outDim, bias) {
  const out = new Float32Array(rows * outDim);
  for (let r = 0; r < rows; r++) {
    const xOff = r * inDim;
    const outOff = r * outDim;
    for (let o = 0; o < outDim; o++) {
      let sum = bias ? bias[o] : 0;
      const wOff = o * inDim;
      for (let i = 0; i < inDim; i++) {
        sum += x[xOff + i] * W[wOff + i];
      }
      out[outOff + o] = sum;
    }
  }
  return out;
}

// Single-row convenience wrapper.
export function linearVec(x, inDim, W, outDim, bias) {
  return linear(x, 1, inDim, W, outDim, bias);
}

export function geluInPlace(a) {
  // Exact (erf-based) GELU, matching torch.nn.GELU() default ('none' approximate mode).
  for (let i = 0; i < a.length; i++) {
    a[i] = a[i] * 0.5 * (1 + erf(a[i] / Math.SQRT2));
  }
  return a;
}

export function reluInPlace(a) {
  for (let i = 0; i < a.length; i++) if (a[i] < 0) a[i] = 0;
  return a;
}

// Abramowitz-Stegun erf approximation (max error ~1.5e-7), plenty for fp32 weights.
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592,
    a2 = -0.284496736,
    a3 = 1.421413741,
    a4 = -1.453152027,
    a5 = 1.061405429,
    p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

// LayerNorm over the last dim, applied per row. weight/bias length = dim.
export function layerNorm(x, rows, dim, weight, bias, eps = 1e-5) {
  const out = new Float32Array(rows * dim);
  for (let r = 0; r < rows; r++) {
    const off = r * dim;
    let mean = 0;
    for (let i = 0; i < dim; i++) mean += x[off + i];
    mean /= dim;
    let vari = 0;
    for (let i = 0; i < dim; i++) {
      const d = x[off + i] - mean;
      vari += d * d;
    }
    vari /= dim;
    const invStd = 1 / Math.sqrt(vari + eps);
    for (let i = 0; i < dim; i++) {
      const norm = (x[off + i] - mean) * invStd;
      out[off + i] = norm * weight[i] + (bias ? bias[i] : 0);
    }
  }
  return out;
}

// RMSNorm over the last dim (no mean-subtraction, no bias), per row.
export function rmsNorm(x, rows, dim, weight, eps = 1e-6) {
  const out = new Float32Array(rows * dim);
  for (let r = 0; r < rows; r++) {
    const off = r * dim;
    let ss = 0;
    for (let i = 0; i < dim; i++) ss += x[off + i] * x[off + i];
    const invRms = 1 / Math.sqrt(ss / dim + eps);
    for (let i = 0; i < dim; i++) {
      out[off + i] = x[off + i] * invRms * weight[i];
    }
  }
  return out;
}

export function addInPlace(a, b) {
  for (let i = 0; i < a.length; i++) a[i] += b[i];
  return a;
}

export function meanRows(x, rows, dim) {
  const out = new Float32Array(dim);
  for (let r = 0; r < rows; r++) {
    const off = r * dim;
    for (let i = 0; i < dim; i++) out[i] += x[off + i];
  }
  for (let i = 0; i < dim; i++) out[i] /= rows;
  return out;
}

export function dot(a, aOff, b, bOff, len) {
  let s = 0;
  for (let i = 0; i < len; i++) s += a[aOff + i] * b[bOff + i];
  return s;
}

export function softmax(a) {
  let max = -Infinity;
  for (let i = 0; i < a.length; i++) if (a[i] > max) max = a[i];
  const out = new Float32Array(a.length);
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const e = Math.exp(a[i] - max);
    out[i] = e;
    sum += e;
  }
  for (let i = 0; i < a.length; i++) out[i] /= sum;
  return out;
}
