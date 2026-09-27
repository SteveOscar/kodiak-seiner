// Water routes for fast travel: Dijkstra over a coarse navigability grid built from the heightmap's shore distance,
// then string-pulled into an any-angle polyline. Pure module (takes any object with shoreDistance(x, z)).

const NARROW_COST = 1.6;

class MinHeap {
  constructor() {
    this.k = [];
    this.v = [];
  }
  get size() {
    return this.k.length;
  }
  push(key, val) {
    const k = this.k;
    const v = this.v;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p];
      v[i] = v[p];
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }
  pop() {
    const k = this.k;
    const v = this.v;
    const topV = v[0];
    const lastK = k.pop();
    const lastV = v.pop();
    const n = k.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lastK) break;
        k[i] = k[c];
        v[i] = v[c];
        i = c;
      }
      k[i] = lastK;
      v[i] = lastV;
    }
    return topV;
  }
}

export function createRoutePlanner(heightmap, { half = 8000, cells = 320, minShore = 10, boundary = 7600 } = {}) {
  const n = cells;
  const size = (2 * half) / n;
  let nav = null;
  let cache = null;

  const cx = (i) => -half + (i + 0.5) * size;
  const idx = (i, j) => j * n + i;

  // 2 = open water, 1 = a narrow pass (some water in the cell but close to shore), 0 = land. Narrow passes are
  // allowed at a cost so routes can thread straits like Whale Passage when there is no other way round.
  function build() {
    nav = new Uint8Array(n * n);
    const o = size / 3;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = cx(i);
        const z = cx(j);
        if (Math.abs(x) > boundary || Math.abs(z) > boundary) continue;
        const c = heightmap.shoreDistance(x, z);
        if (c >= minShore) {
          nav[idx(i, j)] = 2;
          continue;
        }
        const m = Math.max(c, heightmap.shoreDistance(x - o, z), heightmap.shoreDistance(x + o, z), heightmap.shoreDistance(x, z - o), heightmap.shoreDistance(x, z + o));
        nav[idx(i, j)] = m > 0 ? 1 : 0;
      }
    }
  }

  function cellAt(x, z) {
    const i = Math.max(0, Math.min(n - 1, Math.floor((x + half) / size)));
    const j = Math.max(0, Math.min(n - 1, Math.floor((z + half) / size)));
    return [i, j];
  }

  function nearestNav(x, z) {
    if (!nav) build();
    const [i0, j0] = cellAt(x, z);
    let best = -1;
    let bd = Infinity;
    for (let r = 0; r <= 8 && best < 0; r++) {
      for (let j = j0 - r; j <= j0 + r; j++) {
        for (let i = i0 - r; i <= i0 + r; i++) {
          if (i < 0 || j < 0 || i >= n || j >= n) continue;
          if (Math.max(Math.abs(i - i0), Math.abs(j - j0)) !== r) continue;
          if (nav[idx(i, j)] !== 2) continue;
          const d = (cx(i) - x) ** 2 + (cx(j) - z) ** 2;
          if (d < bd) {
            bd = d;
            best = idx(i, j);
          }
        }
      }
    }
    return best;
  }

  function solve(start) {
    if (cache && cache.start === start) return cache;
    const dist = new Float32Array(n * n).fill(Infinity);
    const prev = new Int32Array(n * n).fill(-1);
    const heap = new MinHeap();
    dist[start] = 0;
    heap.push(0, start);
    const D = Math.SQRT2 * size;
    while (heap.size) {
      const u = heap.pop();
      const du = dist[u];
      const ui = u % n;
      const uj = (u / n) | 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const i = ui + di;
          const j = uj + dj;
          if (i < 0 || j < 0 || i >= n || j >= n) continue;
          const v = idx(i, j);
          if (!nav[v]) continue;
          // No corner cutting past land.
          if (di && dj && (!nav[idx(ui + di, uj)] || !nav[idx(ui, uj + dj)])) continue;
          const nd = du + (di && dj ? D : size) * (nav[v] === 1 ? NARROW_COST : 1);
          if (nd < dist[v]) {
            dist[v] = nd;
            prev[v] = u;
            heap.push(nd, v);
          }
        }
      }
    }
    cache = { start, dist, prev };
    return cache;
  }

  function clearLine(ax, az, bx, bz) {
    const len = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.ceil(len / (size * 0.5)));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const [i, j] = cellAt(ax + (bx - ax) * t, az + (bz - az) * t);
      if (nav[idx(i, j)] !== 2) return false;
    }
    return true;
  }

  return {
    cellSize: size,
    // → { reachable, distance (m), straight (m), path: [{x, z}] }
    route(fromX, fromZ, toX, toZ) {
      if (!nav) build();
      const straight = Math.hypot(toX - fromX, toZ - fromZ);
      const a = nearestNav(fromX, fromZ);
      const b = nearestNav(toX, toZ);
      if (a < 0 || b < 0) return { reachable: false, distance: straight * 1.4, straight, path: [{ x: fromX, z: fromZ }, { x: toX, z: toZ }] };
      const { dist, prev } = solve(a);
      if (!Number.isFinite(dist[b])) return { reachable: false, distance: straight * 1.4, straight, path: [{ x: fromX, z: fromZ }, { x: toX, z: toZ }] };
      const cellsPath = [];
      for (let c = b; c >= 0; c = prev[c]) {
        cellsPath.push({ x: cx(c % n), z: cx((c / n) | 0) });
        if (c === a) break;
      }
      cellsPath.reverse();
      const pts = [{ x: fromX, z: fromZ }, ...cellsPath, { x: toX, z: toZ }];
      // String pulling: walk ahead while the straight line stays in clear water (tolerating short blocked runs).
      const path = [pts[0]];
      let k = 0;
      while (k < pts.length - 1) {
        let far = k + 1;
        let misses = 0;
        for (let m = k + 2; m < pts.length && misses < 6; m++) {
          if (clearLine(pts[k].x, pts[k].z, pts[m].x, pts[m].z)) {
            far = m;
            misses = 0;
          } else misses++;
        }
        path.push(pts[far]);
        k = far;
      }
      let distance = 0;
      for (let i = 1; i < path.length; i++) distance += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
      return { reachable: true, distance, straight, path };
    },
    invalidate() {
      cache = null;
    },
  };
}
