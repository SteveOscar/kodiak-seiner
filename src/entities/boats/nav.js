// Water navigation for ambient vessels: a coarse grid of the sea (shore clearance + depth per cell) and an
// incremental A* that spreads its work over frames, then string-pulls the result into a few waypoints.
// Pure (heightmap in, numbers out); tested under Node with the real DEM.

export function buildNavGrid(heightmap, { cell = 50, half = 8000, margin = 7450 } = {}) {
  const n = Math.ceil((2 * half) / cell);
  const shore = new Float32Array(n * n);
  const depth = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = -half + (i + 0.5) * cell;
      const z = -half + (j + 0.5) * cell;
      const k = j * n + i;
      if (Math.abs(x) > margin || Math.abs(z) > margin) {
        shore[k] = -1;
        depth[k] = 0;
        continue;
      }
      shore[k] = heightmap.shoreDistance(x, z);
      depth[k] = heightmap.depthAt(x, z);
    }
  }
  const grid = {
    n,
    cell,
    half,
    shore,
    depth,
    cellOf(x, z) {
      const i = Math.floor((x + half) / cell);
      const j = Math.floor((z + half) / cell);
      if (i < 0 || j < 0 || i >= n || j >= n) return -1;
      return j * n + i;
    },
    centre(k, out = { x: 0, z: 0 }) {
      out.x = -half + ((k % n) + 0.5) * cell;
      out.z = -half + (Math.floor(k / n) + 0.5) * cell;
      return out;
    },
    ok(k, clearance, minDepth) {
      return k >= 0 && shore[k] >= clearance && depth[k] >= minDepth;
    },
    // Straight run between two points stays in cells with the given clearance (sampled every half cell).
    lineClear(ax, az, bx, bz, clearance, minDepth) {
      const len = Math.hypot(bx - ax, bz - az);
      const steps = Math.max(1, Math.ceil(len / (cell * 0.5)));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const k = grid.cellOf(ax + (bx - ax) * t, az + (bz - az) * t);
        if (!grid.ok(k, clearance, minDepth)) return false;
      }
      return true;
    },
    // Nearest cell meeting the clearance, searching outward in square rings (null if none within maxRing).
    nearestOk(x, z, clearance, minDepth, maxRing = 40) {
      const k0 = grid.cellOf(x, z);
      if (grid.ok(k0, clearance, minDepth)) return k0;
      const i0 = Math.floor((x + half) / cell);
      const j0 = Math.floor((z + half) / cell);
      for (let r = 1; r <= maxRing; r++) {
        let best = -1;
        let bestD = Infinity;
        for (let dj = -r; dj <= r; dj++) {
          for (let di = -r; di <= r; di++) {
            if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
            const i = i0 + di;
            const j = j0 + dj;
            if (i < 0 || j < 0 || i >= n || j >= n) continue;
            const k = j * n + i;
            if (!grid.ok(k, clearance, minDepth)) continue;
            const d = di * di + dj * dj;
            if (d < bestD) {
              bestD = d;
              best = k;
            }
          }
        }
        if (best >= 0) return best;
      }
      return -1;
    },
  };
  return grid;
}

// Binary min-heap of cell indices keyed by f-score.
function createHeap(cap) {
  let keys = new Int32Array(cap);
  let pri = new Float32Array(cap);
  let size = 0;
  return {
    get size() {
      return size;
    },
    push(k, p) {
      if (size >= keys.length) {
        const nk = new Int32Array(keys.length * 2);
        nk.set(keys);
        keys = nk;
        const np = new Float32Array(pri.length * 2);
        np.set(pri);
        pri = np;
      }
      let i = size++;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (pri[parent] <= p) break;
        keys[i] = keys[parent];
        pri[i] = pri[parent];
        i = parent;
      }
      keys[i] = k;
      pri[i] = p;
    },
    pop() {
      const top = keys[0];
      const lk = keys[--size];
      const lp = pri[size];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= size) break;
        if (c + 1 < size && pri[c + 1] < pri[c]) c++;
        if (pri[c] >= lp) break;
        keys[i] = keys[c];
        pri[i] = pri[c];
        i = c;
      }
      keys[i] = lk;
      pri[i] = lp;
      return top;
    },
  };
}

const DIRS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

// Incremental A*. step(budget) expands up to `budget` cells and returns 'running' | 'done' | 'failed'.
// On 'done', search.path is [{x, z}, ...] from `from` to `to` (smoothed).
export function createSearch(grid, from, to, { clearance = 40, minDepth = 3, shorePenalty = 60 } = {}) {
  const { n, shore } = grid;
  const start = grid.nearestOk(from.x, from.z, clearance, minDepth);
  const goal = grid.nearestOk(to.x, to.z, clearance, minDepth);
  const search = { status: 'running', path: null, expanded: 0 };
  if (start < 0 || goal < 0) {
    search.status = 'failed';
    search.step = () => 'failed';
    return search;
  }
  const g = new Float32Array(n * n).fill(Infinity);
  const came = new Int32Array(n * n).fill(-1);
  const closed = new Uint8Array(n * n);
  const heap = createHeap(4096);
  const gi = goal % n;
  const gj = Math.floor(goal / n);
  const h = (k) => {
    const dx = Math.abs((k % n) - gi);
    const dz = Math.abs(Math.floor(k / n) - gj);
    return (dx + dz + (Math.SQRT2 - 2) * Math.min(dx, dz));
  };
  g[start] = 0;
  heap.push(start, h(start));

  function finish() {
    const cells = [];
    for (let k = goal; k >= 0; k = came[k]) {
      cells.push(k);
      if (k === start) break;
    }
    cells.reverse();
    const pts = cells.map((k) => grid.centre(k));
    pts[0] = { x: from.x, z: from.z };
    pts[pts.length - 1] = { x: to.x, z: to.z };
    // String pulling: keep only the points needed for clear straight runs.
    const out = [pts[0]];
    let a = 0;
    while (a < pts.length - 1) {
      let b = pts.length - 1;
      while (b > a + 1 && !grid.lineClear(pts[a].x, pts[a].z, pts[b].x, pts[b].z, clearance * 0.8, minDepth * 0.8)) b--;
      out.push(pts[b]);
      a = b;
    }
    search.path = out;
    search.status = 'done';
  }

  search.step = (budget = 2000) => {
    if (search.status !== 'running') return search.status;
    for (let it = 0; it < budget; it++) {
      if (heap.size === 0) {
        search.status = 'failed';
        return 'failed';
      }
      const k = heap.pop();
      if (closed[k]) continue;
      closed[k] = 1;
      search.expanded++;
      if (k === goal) {
        finish();
        return 'done';
      }
      const i = k % n;
      const j = Math.floor(k / n);
      for (const [di, dj, cost] of DIRS) {
        const ii = i + di;
        const jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
        const kk = jj * n + ii;
        if (closed[kk] || !grid.ok(kk, clearance, minDepth)) continue;
        // Mild preference for open water keeps routes off the beaches.
        const pen = 1 + shorePenalty / Math.max(shorePenalty, shore[kk]);
        const ng = g[k] + cost * pen;
        if (ng < g[kk]) {
          g[kk] = ng;
          came[kk] = k;
          heap.push(kk, ng + h(kk) * 1.02);
        }
      }
    }
    return 'running';
  };
  return search;
}

// Point at `dist` metres along a polyline, plus the segment heading. Returns {x, z, heading, done}.
export function alongPath(path, dist, out = { x: 0, z: 0, heading: 0, done: false }) {
  let d = Math.max(0, dist);
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (d <= len || i === path.length - 2) {
      const t = len > 0 ? Math.min(1, d / len) : 1;
      out.x = a.x + (b.x - a.x) * t;
      out.z = a.z + (b.z - a.z) * t;
      out.heading = Math.atan2(b.x - a.x, -(b.z - a.z));
      out.done = i === path.length - 2 && d >= len;
      return out;
    }
    d -= len;
  }
  const p = path[path.length - 1] ?? { x: 0, z: 0 };
  out.x = p.x;
  out.z = p.z;
  out.done = true;
  return out;
}

export function pathLength(path) {
  let L = 0;
  for (let i = 0; i < path.length - 1; i++) L += Math.hypot(path[i + 1].x - path[i].x, path[i + 1].z - path[i].z);
  return L;
}
