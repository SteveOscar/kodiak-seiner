// CPU sun visibility (0 = in mountain shadow, 1 = sunlit) by marching the DEM toward the sun, with the same soft
// penumbra as the GPU shadow pass (shadowPass.js). Results are cached on a 256² grid and invalidated when the sun
// moves more than CACHE_DEG, so per-frame queries (sky's shadow focus, boats) cost a few lookups. DOM-free.

export const PENUMBRA = 0.024; // tan of the half-width of the soft shadow edge (~1.4°)
export const RAY_LIFT = 1.2; // metres above the surface (or the sea) where rays start
export const RAY_START = 10;
export const RAY_GROW = 1.07;
export const RAY_ADD = 3;
export const RAY_STEPS = 80;
export const MAX_TERRAIN = 445;
const CACHE_N = 256;
const CACHE_DEG = 0.25;

export function marchSun(sampleHeight, x, z, sun, surfaceY) {
  const hl = Math.hypot(sun.x, sun.z);
  if (sun.y <= -0.03) return 0;
  if (hl < 1e-4) return 1;
  const dx = sun.x / hl;
  const dz = sun.z / hl;
  const tanE = sun.y / hl;
  const y0 = Math.max(surfaceY, 0) + RAY_LIFT;
  let minM = 1;
  let t = RAY_START;
  for (let i = 0; i < RAY_STEPS; i++) {
    const ry = y0 + t * tanE;
    if (ry > MAX_TERRAIN) break;
    const m = (ry - sampleHeight(x + dx * t, z + dz * t)) / t;
    if (m < minM) minM = m;
    if (minM < -PENUMBRA) break;
    t = t * RAY_GROW + RAY_ADD;
  }
  const s = Math.min(1, Math.max(0, (minM + PENUMBRA) / (2 * PENUMBRA)));
  const horizon = Math.min(1, Math.max(0, (sun.y + 0.03) / 0.06));
  return s * s * (3 - 2 * s) * horizon;
}

export function createSunVisibility({ sampleHeight, surfaceHeight, half, getSun }) {
  const cell = (2 * half) / CACHE_N;
  const value = new Float32Array(CACHE_N * CACHE_N);
  const stamp = new Uint32Array(CACHE_N * CACHE_N);
  let generation = 1;
  const last = { x: 0, y: -1, z: 0 };
  const cosLimit = Math.cos((CACHE_DEG * Math.PI) / 180);

  function refresh() {
    const s = getSun();
    const dot = s.x * last.x + s.y * last.y + s.z * last.z;
    if (dot < cosLimit) {
      last.x = s.x;
      last.y = s.y;
      last.z = s.z;
      generation++;
    }
    return last;
  }

  function cellValue(i, j) {
    const k = j * CACHE_N + i;
    if (stamp[k] !== generation) {
      const x = -half + (i + 0.5) * cell;
      const z = -half + (j + 0.5) * cell;
      value[k] = marchSun(sampleHeight, x, z, last, surfaceHeight(x, z));
      stamp[k] = generation;
    }
    return value[k];
  }

  return {
    // Bilinear over the cached grid; call refresh() once per frame (terrain.update does).
    at(x, z) {
      const fx = Math.min(CACHE_N - 1.0001, Math.max(0, (x + half) / cell - 0.5));
      const fz = Math.min(CACHE_N - 1.0001, Math.max(0, (z + half) / cell - 0.5));
      const i = Math.floor(fx);
      const j = Math.floor(fz);
      const tx = fx - i;
      const tz = fz - j;
      const a = cellValue(i, j);
      const b = cellValue(i + 1, j);
      const c = cellValue(i, j + 1);
      const d = cellValue(i + 1, j + 1);
      return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
    },
    // Exact (uncached) value at a point.
    exact(x, z) {
      return marchSun(sampleHeight, x, z, getSun(), surfaceHeight(x, z));
    },
    refresh,
    get generation() {
      return generation;
    },
  };
}
