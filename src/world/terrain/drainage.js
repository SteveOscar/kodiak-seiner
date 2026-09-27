// Drainage: D8 flow accumulation over a downsampled copy of the DEM. Water from every land cell runs to its steepest
// downhill neighbour; the accumulated upslope area traces the gully and valley network, which the terrain uses for
// lush darker grass and alder thickets along drainages (Kodiak's alder grows in exactly these lines). DOM-free; the
// same array feeds the GPU cover bake (as a texture) and CPU land-cover queries, so both agree.

const DX = new Int32Array([1, -1, 0, 0, 1, -1, 1, -1]);
const DZ = new Int32Array([0, 0, 1, -1, 1, 1, -1, -1]);
const INV_D = new Float64Array([1, 1, 1, 1, Math.SQRT1_2, Math.SQRT1_2, Math.SQRT1_2, Math.SQRT1_2]);

// heights: size x size game metres (row 0 = north). Returns { n, wet } with wet (n x n, 0..1) = soft log-scaled
// upslope area: ~0 on ridges and open slopes, 0.3-0.6 in gullies, 1 along valley floors.
export function computeDrainage(heights, size, n = 1024) {
  const f = size / n;
  const h = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let b = 0; b < f; b++) for (let a = 0; a < f; a++) s += heights[(j * f + b) * size + i * f + a];
      h[j * n + i] = s / (f * f);
    }
  }
  // Highest cells first (counting sort on 5 cm bins; order within a bin does not matter).
  const LO = -80;
  const BIN = 0.05;
  const bins = Math.ceil((600 - LO) / BIN) + 1;
  const count = new Uint32Array(bins + 1);
  const binOf = (v) => Math.min(bins - 1, Math.max(0, Math.floor((v - LO) / BIN)));
  for (let k = 0; k < n * n; k++) count[bins - 1 - binOf(h[k])]++;
  for (let b = 1; b <= bins; b++) count[b] += count[b - 1];
  const order = new Uint32Array(n * n);
  for (let k = n * n - 1; k >= 0; k--) order[--count[bins - 1 - binOf(h[k])]] = k;

  const acc = new Float32Array(n * n).fill(1);
  for (let q = 0; q < n * n; q++) {
    const k = order[q];
    const hk = h[k];
    if (hk <= 0) continue;
    const i = k % n;
    const j = (k - i) / n;
    const edge = i === 0 || j === 0 || i === n - 1 || j === n - 1;
    let best = -1;
    let bestSlope = 0;
    for (let d = 0; d < 8; d++) {
      const x = i + DX[d];
      const z = j + DZ[d];
      if (edge && (x < 0 || z < 0 || x >= n || z >= n)) continue;
      const nk = z * n + x;
      const s = (hk - h[nk]) * INV_D[d];
      if (s > bestSlope) {
        bestSlope = s;
        best = nk;
      }
    }
    if (best >= 0) acc[best] += acc[k];
  }

  // Log scale (cells of (2 half / n)^2): 1 cell -> 0, ~20 cells (a gully head) -> ~0.35, ~3000 cells -> 1.
  const raw = new Float32Array(n * n);
  for (let k = 0; k < n * n; k++) raw[k] = h[k] > 0 ? Math.min(1, Math.log2(acc[k]) / 11.5) : 0;
  // Soften to thicket width (a 3x3 tent filter keeps the dendritic pattern but widens single-cell lines).
  const wet = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let s = 0;
      let w = 0;
      for (let b = -1; b <= 1; b++) {
        for (let a = -1; a <= 1; a++) {
          const x = Math.min(n - 1, Math.max(0, i + a));
          const z = Math.min(n - 1, Math.max(0, j + b));
          const t = (2 - Math.abs(a)) * (2 - Math.abs(b));
          s += raw[z * n + x] * t;
          w += t;
        }
      }
      wet[j * n + i] = Math.max(raw[j * n + i] * 0.8, s / w);
    }
  }
  return { n, wet };
}

// Bilinear sampler over the drainage grid (same texel convention as the heightmap: centre of cell i at
// -half + (i + 0.5) * 2 half / n).
export function createWetnessSampler({ n, wet }, half) {
  const cell = (2 * half) / n;
  return function wetnessAt(x, z) {
    const fx = Math.min(n - 1.0001, Math.max(0, (x + half) / cell - 0.5));
    const fz = Math.min(n - 1.0001, Math.max(0, (z + half) / cell - 0.5));
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const k = j * n + i;
    return (wet[k] * (1 - tx) + wet[k + 1] * tx) * (1 - tz) + (wet[k + n] * (1 - tx) + wet[k + n + 1] * tx) * tz;
  };
}

// R8 bytes for a GPU texture.
export function drainageR8({ n, wet }) {
  const out = new Uint8Array(n * n);
  for (let k = 0; k < n * n; k++) out[k] = Math.round(wet[k] * 255);
  return out;
}
