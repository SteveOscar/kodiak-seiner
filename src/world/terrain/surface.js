// The terrain's full-detail height function, shared bit-for-bit (up to float32 precision) by the CPU queries and the
// GPU vertex shader (see glsl.js). DOM-free and THREE-free so Node tests can use it.
//
//   smooth(x, z)     clamped Catmull-Rom interpolation of the DEM texels (C1, passes through every texel, never leaves
//                    the range of the four surrounding texels, so coastlines keep the heightmap's land/water split).
//                    Beyond the 16 km square the DEM is mirrored and sinks to the outside depth, so land cut by the
//                    world edge (the Alaska Peninsula, Shuyak) continues instead of ending in a wall.
//   detail(...)      procedural displacement: craggy smoothed-ridged noise on steep rock, low hummocks on gentle land.
//   full(x, z)       smooth + detail at any point.
//   heightAt(x, z)   the rendered full-detail surface: `full` sampled on the finest LOD lattice (spacing L0) and
//                    linearly interpolated over the same triangles the GPU draws (diagonal from (i+1, j) to (i, j+1)).
//
// World frame: +x east, -z north. Texel (i, j) centre = (-half + (i + 0.5) T, -half + (j + 0.5) T), T = 2 half / size.

export const L0 = 1.953125; // finest lattice spacing: a quarter DEM texel (7.8125 m / 4)
export const OUTSIDE_DEPTH = -60;
export const OUTSIDE_FALLOFF = 3200; // metres beyond the world edge over which mirrored land sinks to OUTSIDE_DEPTH

// Detail displacement parameters (mirrored in glsl.js; keep in sync).
export const DETAIL = {
  rockAmp: 1.7, // metres, smoothed-ridged noise on steep rock
  rockWave: 23, // metres, first octave wavelength (second octave is half)
  rockSlope0: 0.75, // |grad| where rock detail starts (~37°)
  rockSlope1: 1.35, // full rock detail (~54°)
  humpAmp: 0.22, // metres, gentle hummocks on low-slope land
  humpWave: 9.5,
};

// 32-bit integer hash -> [0, 1).
export function hash2(ix, iz) {
  let h = (Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iz | 0, 0x165667b1)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Value-noise lattice shared with the GPU: a 256² grid of random bytes, uploaded as an RGBA8 texture whose texel
// (i, j) holds the four cell corners (i, j), (i+1, j), (i, j+1), (i+1, j+1), so a shader noise costs one texelFetch.
// The pattern repeats every 256 cells, far beyond any wavelength's visible extent.
export const LATTICE_N = 256;
export const LATTICE = (() => {
  const v = new Uint8Array(LATTICE_N * LATTICE_N);
  for (let j = 0; j < LATTICE_N; j++) for (let i = 0; i < LATTICE_N; i++) v[j * LATTICE_N + i] = Math.floor(hash2(i, j) * 256);
  return v;
})();
export function latticeRGBA() {
  const n = LATTICE_N;
  const m = n - 1;
  const out = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = (j * n + i) * 4;
      out[k] = LATTICE[j * n + i];
      out[k + 1] = LATTICE[j * n + ((i + 1) & m)];
      out[k + 2] = LATTICE[((j + 1) & m) * n + i];
      out[k + 3] = LATTICE[((j + 1) & m) * n + ((i + 1) & m)];
    }
  }
  return out;
}

// Value noise in [0, 1] with quintic fade, wavelength 1. Optionally writes the gradient into g[0], g[1].
export function vnoise(x, z, g) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const i0 = ix & 255;
  const i1 = (ix + 1) & 255;
  const r0 = (iz & 255) << 8;
  const r1 = ((iz + 1) & 255) << 8;
  const a = LATTICE[r0 + i0] / 255;
  const b = LATTICE[r0 + i1] / 255;
  const c = LATTICE[r1 + i0] / 255;
  const d = LATTICE[r1 + i1] / 255;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  if (g) {
    const dux = 30 * fx * fx * (fx * (fx - 2) + 1);
    const duz = 30 * fz * fz * (fz * (fz - 2) + 1);
    g[0] = dux * (b - a + (a - b - c + d) * uz);
    g[1] = duz * (c - a + (a - b - c + d) * ux);
  }
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

// Smoothed ridge: 1 at the crest, falling to 0; the crest is rounded over |2n-1| < ~0.2 so it stays resolvable by
// the LOD lattice (a hard crease would alias between LOD levels).
function ridge(n) {
  const v = 2 * n - 1;
  return 1 - Math.sqrt(v * v + 0.04);
}

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function createSurface({ game, size, half }) {
  const T = (2 * half) / size;
  const invT = 1 / T;
  const last = size - 1;

  function idx(i) {
    if (i < 0) i = -1 - i;
    else if (i > last) i = 2 * size - 1 - i;
    return i < 0 ? 0 : i > last ? last : i;
  }

  // Clamped Catmull-Rom with the DEM mirrored beyond the edge (no falloff). out = [h, dh/dx, dh/dz] when given.
  function cr(x, z, out) {
    const fx = (x + half) * invT - 0.5;
    const fz = (z + half) * invT - 0.5;
    const i1 = Math.floor(fx);
    const j1 = Math.floor(fz);
    const tx = fx - i1;
    const tz = fz - j1;
    const tx2 = tx * tx;
    const tx3 = tx2 * tx;
    const tz2 = tz * tz;
    const tz3 = tz2 * tz;
    const wx0 = -0.5 * tx3 + tx2 - 0.5 * tx;
    const wx1 = 1.5 * tx3 - 2.5 * tx2 + 1;
    const wx2 = -1.5 * tx3 + 2 * tx2 + 0.5 * tx;
    const wx3 = 0.5 * tx3 - 0.5 * tx2;
    const wz0 = -0.5 * tz3 + tz2 - 0.5 * tz;
    const wz1 = 1.5 * tz3 - 2.5 * tz2 + 1;
    const wz2 = -1.5 * tz3 + 2 * tz2 + 0.5 * tz;
    const wz3 = 0.5 * tz3 - 0.5 * tz2;
    const c0 = idx(i1 - 1);
    const c1 = idx(i1);
    const c2 = idx(i1 + 1);
    const c3 = idx(i1 + 2);
    let r0 = idx(j1 - 1) * size;
    let r1 = idx(j1) * size;
    let r2 = idx(j1 + 1) * size;
    let r3 = idx(j1 + 2) * size;
    const a0 = wx0 * game[r0 + c0] + wx1 * game[r0 + c1] + wx2 * game[r0 + c2] + wx3 * game[r0 + c3];
    const h11 = game[r1 + c1];
    const h21 = game[r1 + c2];
    const h12 = game[r2 + c1];
    const h22 = game[r2 + c2];
    const a1 = wx0 * game[r1 + c0] + wx1 * h11 + wx2 * h21 + wx3 * game[r1 + c3];
    const a2 = wx0 * game[r2 + c0] + wx1 * h12 + wx2 * h22 + wx3 * game[r2 + c3];
    const a3 = wx0 * game[r3 + c0] + wx1 * game[r3 + c1] + wx2 * game[r3 + c2] + wx3 * game[r3 + c3];
    let h = wz0 * a0 + wz1 * a1 + wz2 * a2 + wz3 * a3;
    const lo = Math.min(h11, h21, h12, h22);
    const hi = Math.max(h11, h21, h12, h22);
    h = h < lo ? lo : h > hi ? hi : h;
    if (out) {
      const dx0 = -1.5 * tx2 + 2 * tx - 0.5;
      const dx1 = 4.5 * tx2 - 5 * tx;
      const dx2 = -4.5 * tx2 + 4 * tx + 0.5;
      const dx3 = 1.5 * tx2 - tx;
      const dz0 = -1.5 * tz2 + 2 * tz - 0.5;
      const dz1 = 4.5 * tz2 - 5 * tz;
      const dz2 = -4.5 * tz2 + 4 * tz + 0.5;
      const dz3 = 1.5 * tz2 - tz;
      const b0 = dx0 * game[r0 + c0] + dx1 * game[r0 + c1] + dx2 * game[r0 + c2] + dx3 * game[r0 + c3];
      const b1 = dx0 * game[r1 + c0] + dx1 * h11 + dx2 * h21 + dx3 * game[r1 + c3];
      const b2 = dx0 * game[r2 + c0] + dx1 * h12 + dx2 * h22 + dx3 * game[r2 + c3];
      const b3 = dx0 * game[r3 + c0] + dx1 * game[r3 + c1] + dx2 * game[r3 + c2] + dx3 * game[r3 + c3];
      out[0] = h;
      out[1] = (wz0 * b0 + wz1 * b1 + wz2 * b2 + wz3 * b3) * invT;
      out[2] = (dz0 * a0 + dz1 * a1 + dz2 * a2 + dz3 * a3) * invT;
    }
    return h;
  }

  // Beyond the world square, mirrored land sinks toward OUTSIDE_DEPTH. Returns the blend factor (0 inside).
  function outside(x, z) {
    const over = Math.max(Math.abs(x), Math.abs(z)) - half;
    return over <= 0 ? 0 : smoothstep(0, OUTSIDE_FALLOFF, over);
  }

  const tmp = [0, 0, 0];
  function smooth(x, z, out) {
    const h = cr(x, z, out);
    const f = outside(x, z);
    if (f === 0) return h;
    const r = h + (OUTSIDE_DEPTH - h) * f;
    if (out) {
      out[0] = r;
      out[1] *= 1 - f;
      out[2] *= 1 - f;
    }
    return r;
  }

  const ng = [0, 0];
  // Procedural displacement given the smooth height and its gradient.
  function detail(x, z, h, gx, gz) {
    const s = Math.sqrt(gx * gx + gz * gz);
    const rock = smoothstep(DETAIL.rockSlope0, DETAIL.rockSlope1, s);
    let d = 0;
    if (rock > 0) {
      const w = 1 / DETAIL.rockWave;
      const r1 = ridge(vnoise(x * w + 17.3, z * w - 4.1));
      const r2 = ridge(vnoise(x * w * 2.03 - 9.7, z * w * 2.03 + 31.2));
      d += rock * DETAIL.rockAmp * (0.68 * r1 + 0.32 * r2 - 0.55);
    }
    const land = smoothstep(0.6, 3.0, h) * (1 - rock);
    if (land > 0) {
      const w = 1 / DETAIL.humpWave;
      d += land * DETAIL.humpAmp * (vnoise(x * w + 3.7, z * w + 11.9, ng) * 2 - 1);
    }
    return d;
  }

  function full(x, z) {
    smooth(x, z, tmp);
    return tmp[0] + detail(x, z, tmp[0], tmp[1], tmp[2]);
  }

  // The L0 triangulated surface (what the GPU renders at full detail).
  function heightAt(x, z) {
    const gx = (x + half) / L0;
    const gz = (z + half) / L0;
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const fx = gx - i;
    const fz = gz - j;
    const x0 = -half + i * L0;
    const z0 = -half + j * L0;
    const hb = full(x0 + L0, z0);
    const hc = full(x0, z0 + L0);
    if (fx + fz <= 1) {
      const ha = full(x0, z0);
      return ha + (hb - ha) * fx + (hc - ha) * fz;
    }
    const hd = full(x0 + L0, z0 + L0);
    return hd + (hc - hd) * (1 - fx) + (hb - hd) * (1 - fz);
  }

  // Smooth-surface normal (unit, y up) including the detail gradient (numerically, 0.5 m).
  function normalAt(x, z, out = { x: 0, y: 1, z: 0 }) {
    const e = 0.5;
    const hx = full(x + e, z) - full(x - e, z);
    const hz = full(x, z + e) - full(x, z - e);
    const nx = -hx / (2 * e);
    const nz = -hz / (2 * e);
    const inv = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
    out.x = nx * inv;
    out.y = inv;
    out.z = nz * inv;
    return out;
  }

  return { T, half, size, cr, smooth, detail, full, heightAt, normalAt, outside };
}

// Curvature (mean of the surroundings minus the point: + in gullies, - on ridges) exactly as the GPU info pass bakes it
// per DEM texel (gpuPrep.js INFO_FRAG), bilinearly interpolated like the baked texture.
export function createCurvature(heights, size, half) {
  const n3 = size >> 3;
  const mip3 = new Float32Array(n3 * n3);
  for (let j = 0; j < n3; j++) {
    for (let i = 0; i < n3; i++) {
      let sum = 0;
      for (let b = 0; b < 8; b++) for (let a = 0; a < 8; a++) sum += heights[(j * 8 + b) * size + i * 8 + a];
      mip3[j * n3 + i] = sum / 64;
    }
  }
  const last = size - 1;
  const at = (i, j) => heights[Math.min(last, Math.max(0, j)) * size + Math.min(last, Math.max(0, i))];
  function mipAt(u, v) {
    const fx = Math.min(n3 - 1.0001, Math.max(0, u * n3 - 0.5));
    const fz = Math.min(n3 - 1.0001, Math.max(0, v * n3 - 0.5));
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const k = j * n3 + i;
    return (mip3[k] * (1 - tx) + mip3[k + 1] * tx) * (1 - tz) + (mip3[k + n3] * (1 - tx) + mip3[k + n3 + 1] * tx) * tz;
  }
  function texel(i, j) {
    i = Math.min(last, Math.max(0, i));
    j = Math.min(last, Math.max(0, j));
    const h = at(i, j);
    const ring =
      at(i + 2, j) + at(i - 2, j) + at(i, j + 2) + at(i, j - 2) + at(i + 2, j + 2) + at(i - 2, j + 2) + at(i + 2, j - 2) + at(i - 2, j - 2);
    const c2 = mipAt((i + 0.5) / size, (j + 0.5) / size) - h;
    return 0.55 * (ring / 8 - h) + 0.45 * c2 * 0.35;
  }
  const T = (2 * half) / size;
  return function curvatureAt(x, z) {
    const fx = (x + half) / T - 0.5;
    const fz = (z + half) / T - 0.5;
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    return (texel(i, j) * (1 - tx) + texel(i + 1, j) * tx) * (1 - tz) + (texel(i, j + 1) * (1 - tx) + texel(i + 1, j + 1) * tx) * tz;
  };
}
