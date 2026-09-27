// Wave exposure fields (pure; no THREE, no DOM).
//
// For every cell of a coarse grid over the world, `fetch` is the open-water distance toward 8 compass directions
// (0 = north, then clockwise every 45°). Waves arriving from a direction can only be as big as the fetch in that
// direction allows, so sheltered fjords and the lee of the island stay calm while exposed capes take the swell.
// The fields are blurred a little so wave energy wraps around headlands (a cheap stand-in for diffraction).
//
// Both the GPU (RGBA32F textures, hardware bilinear, clamp-to-edge) and the CPU (sampleFetch below) read the same
// Float32 data with the same texel-centre convention, so wave heights computed on either side agree.

export const FETCH_N = 256;
export const FETCH_MAX = 8000; // metres: "open ocean"
export const OUTSIDE_BLEND = 600; // metres beyond the world edge over which fields fade to open-ocean values
export const OUTSIDE_DEPTH = 60;
export const OUTSIDE_SHORE = 1000;

// Unit steps on the grid for the 8 directions (x east, z south). North = -z.
const DIRS = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];

// heightAt(x, z): terrain/seabed height in game metres (negative = water).
export function computeFetch({ heightAt, half, N = FETCH_N, maxFetch = FETCH_MAX, blurPasses = 3 }) {
  const cell = (2 * half) / N;
  const land = new Uint8Array(N * N);
  const q = cell * 0.3;
  for (let j = 0; j < N; j++) {
    const z = -half + (j + 0.5) * cell;
    for (let i = 0; i < N; i++) {
      const x = -half + (i + 0.5) * cell;
      // Any land in the cell blocks the fetch, so thin spits and islets still shelter what lies behind them.
      const h = Math.max(heightAt(x - q, z - q), heightAt(x + q, z - q), heightAt(x - q, z + q), heightAt(x + q, z + q), heightAt(x, z));
      land[j * N + i] = h > -0.25 ? 1 : 0;
    }
  }

  const fields = [];
  for (let d = 0; d < 8; d++) {
    const [dx, dz] = DIRS[d];
    const step = cell * Math.hypot(dx, dz);
    const f = new Float32Array(N * N);
    // Visit cells so that the neighbour toward the look direction is always computed first.
    const iStart = dx > 0 ? N - 1 : 0;
    const iEnd = dx > 0 ? -1 : N;
    const iInc = dx > 0 ? -1 : 1;
    const jStart = dz > 0 ? N - 1 : 0;
    const jEnd = dz > 0 ? -1 : N;
    const jInc = dz > 0 ? -1 : 1;
    for (let j = jStart; j !== jEnd; j += jInc) {
      for (let i = iStart; i !== iEnd; i += iInc) {
        const k = j * N + i;
        if (land[k]) {
          f[k] = 0;
          continue;
        }
        const ni = i + dx;
        const nj = j + dz;
        const next = ni < 0 || nj < 0 || ni >= N || nj >= N ? maxFetch : f[nj * N + ni];
        f[k] = Math.min(maxFetch, next + step);
      }
    }
    for (let p = 0; p < blurPasses; p++) blur(f, N);
    fields.push(f);
  }

  // Pack as two RGBA textures: A = directions 0..3, B = 4..7.
  const a = new Float32Array(N * N * 4);
  const b = new Float32Array(N * N * 4);
  for (let k = 0; k < N * N; k++) {
    for (let c = 0; c < 4; c++) {
      a[k * 4 + c] = fields[c][k];
      b[k * 4 + c] = fields[c + 4][k];
    }
  }
  return { N, half, cell, maxFetch, a, b, land };
}

// Separable 3-tap box blur with clamped edges.
function blur(f, N) {
  const t = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    const row = j * N;
    for (let i = 0; i < N; i++) {
      const l = f[row + (i > 0 ? i - 1 : 0)];
      const r = f[row + (i < N - 1 ? i + 1 : N - 1)];
      t[row + i] = (l + f[row + i] + r) / 3;
    }
  }
  for (let j = 0; j < N; j++) {
    const u = (j > 0 ? j - 1 : 0) * N;
    const d = (j < N - 1 ? j + 1 : N - 1) * N;
    const row = j * N;
    for (let i = 0; i < N; i++) f[row + i] = (t[u + i] + t[row + i] + t[d + i]) / 3;
  }
}

// Normalised weights over the 8 fetch directions for waves that come FROM compass heading `fromHeading` (radians,
// 0 = north, clockwise), with a cos^power angular spread. Writes 8 floats into out.
export function directionWeights(fromHeading, power, out = new Float32Array(8)) {
  let sum = 0;
  for (let d = 0; d < 8; d++) {
    const c = Math.cos((d * Math.PI) / 4 - fromHeading);
    const w = c > 0 ? Math.pow(c, power) : 0;
    out[d] = w;
    sum += w;
  }
  for (let d = 0; d < 8; d++) out[d] = sum > 0 ? out[d] / sum : 0.125;
  return out;
}
