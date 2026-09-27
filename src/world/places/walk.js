// On-foot reachability over the heightmap (pure; no THREE, no DOM). Mirrors the walking rules of SPEC §6.14: full
// speed up to 35°, slowing linearly to 50°, scrambling at 30% speed up to 58°, sliding above; wading only to knee
// depth. Used by the places data tests (every onFoot place is reachable from its landing beach) and available to
// WP-FOOT for route hints.

export const FOOT_RULES = { fullDeg: 35, slowDeg: 50, scrambleDeg: 58, scrambleSpeed: 0.3, wadeDepth: 0.5 };

// Relative walking speed (0..1) on a slope in degrees; 0 = impassable (slide).
export function footSpeed(slopeDeg, rules = FOOT_RULES) {
  if (slopeDeg <= rules.fullDeg) return 1;
  if (slopeDeg <= rules.slowDeg) {
    const t = (slopeDeg - rules.fullDeg) / (rules.slowDeg - rules.fullDeg);
    return 1 - (1 - rules.scrambleSpeed) * t;
  }
  if (slopeDeg <= rules.scrambleDeg) return rules.scrambleSpeed;
  return 0;
}

// Steepest slope (degrees) met walking straight from a to b, checked at `probes` sub-steps.
export function segmentSlope(heightAt, ax, az, bx, bz, probes = 3) {
  let prev = heightAt(ax, az);
  let worst = 0;
  const len = Math.hypot(bx - ax, bz - az);
  const step = len / probes;
  for (let i = 1; i <= probes; i++) {
    const t = i / probes;
    const h = heightAt(ax + (bx - ax) * t, az + (bz - az) * t);
    const deg = (Math.atan2(Math.abs(h - prev), step) * 180) / Math.PI;
    if (deg > worst) worst = deg;
    prev = h;
  }
  return worst;
}

// Binary min-heap keyed by f.
function heap() {
  const keys = [];
  const vals = [];
  return {
    get size() {
      return keys.length;
    },
    push(k, v) {
      keys.push(k);
      vals.push(v);
      let i = keys.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (keys[p] <= keys[i]) break;
        [keys[p], keys[i]] = [keys[i], keys[p]];
        [vals[p], vals[i]] = [vals[i], vals[p]];
        i = p;
      }
    },
    pop() {
      const v = vals[0];
      const lk = keys.pop();
      const lv = vals.pop();
      if (keys.length) {
        keys[0] = lk;
        vals[0] = lv;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < keys.length && keys[l] < keys[m]) m = l;
          if (r < keys.length && keys[r] < keys[m]) m = r;
          if (m === i) break;
          [keys[m], keys[i]] = [keys[i], keys[m]];
          [vals[m], vals[i]] = [vals[i], vals[m]];
          i = m;
        }
      }
      return v;
    },
  };
}

// Grid A* from `from` to `to` ({x, z}) over heightAt(x, z). Returns
// { ok, path: [{x, z}], length (m), time (m at full speed), maxSlope (deg), expanded }.
export function findFootPath(heightAt, from, to, opts = {}) {
  const { cell = 8, margin = 400, maxNodes = 600000, rules = FOOT_RULES } = opts;
  const minX = Math.min(from.x, to.x) - margin;
  const minZ = Math.min(from.z, to.z) - margin;
  const nx = Math.ceil((Math.max(from.x, to.x) + margin - minX) / cell) + 1;
  const nz = Math.ceil((Math.max(from.z, to.z) + margin - minZ) / cell) + 1;
  const px = (i) => minX + i * cell;
  const pz = (j) => minZ + j * cell;
  const walkable = (x, z) => heightAt(x, z) > -rules.wadeDepth;
  const si = Math.round((from.x - minX) / cell);
  const sj = Math.round((from.z - minZ) / cell);
  const ti = Math.round((to.x - minX) / cell);
  const tj = Math.round((to.z - minZ) / cell);
  const n = nx * nz;
  const g = new Float32Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const open = heap();
  const start = sj * nx + si;
  const goal = tj * nx + ti;
  const hDist = (i, j) => Math.hypot(i - ti, j - tj) * cell;
  g[start] = 0;
  open.push(hDist(si, sj), start);
  const dirs = [
    [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
    [2, 1], [1, 2], [-2, 1], [-1, 2], [2, -1], [1, -2], [-2, -1], [-1, -2],
  ];
  let expanded = 0;
  while (open.size && expanded < maxNodes) {
    const k = open.pop();
    if (closed[k]) continue;
    closed[k] = 1;
    expanded++;
    if (k === goal) break;
    const i = k % nx;
    const j = (k - i) / nx;
    const x0 = px(i);
    const z0 = pz(j);
    for (const [di, dj] of dirs) {
      const a = i + di;
      const b = j + dj;
      if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
      const t = b * nx + a;
      if (closed[t]) continue;
      const x1 = px(a);
      const z1 = pz(b);
      if (!walkable(x1, z1)) continue;
      const slope = segmentSlope(heightAt, x0, z0, x1, z1, Math.abs(di) + Math.abs(dj) > 2 ? 4 : 3);
      const speed = footSpeed(slope, rules);
      if (speed <= 0) continue;
      const d = Math.hypot(di, dj) * cell;
      const ng = g[k] + d / speed;
      if (ng < g[t]) {
        g[t] = ng;
        came[t] = k;
        open.push(ng + hDist(a, b), t);
      }
    }
  }
  if (!Number.isFinite(g[goal])) return { ok: false, path: [], length: 0, time: Infinity, maxSlope: 0, expanded };
  const path = [];
  for (let k = goal; k >= 0; k = came[k]) {
    const i = k % nx;
    path.push({ x: px(i), z: pz((k - i) / nx) });
    if (k === start) break;
  }
  path.reverse();
  let length = 0;
  let maxSlope = 0;
  for (let q = 1; q < path.length; q++) {
    const a = path[q - 1];
    const b = path[q];
    length += Math.hypot(b.x - a.x, b.z - a.z);
    maxSlope = Math.max(maxSlope, segmentSlope(heightAt, a.x, a.z, b.x, b.z));
  }
  return { ok: true, path, length, time: g[goal], maxSlope, expanded };
}
