// CDLOD quadtree selection (Strugar 2009) over a 32 km root centred on the world, so land cut by the world edge
// continues into the mirrored fringe. DOM-free.
//
// Level L has lattice spacing L0 * 2^L and node size NODE_QUADS * spacing. Every selected region is emitted as
// quadrant instances (half a node, QUAD x QUAD quads) so one instanced grid draws the whole terrain in one call.
// A level-L node is used where it intersects the sphere of radius ranges[L] around the camera; its vertices morph
// toward the level L+1 lattice over the last MORPH_FRACTION of the band, reaching it exactly at ranges[L], so
// neighbouring levels meet without cracks or pops.
//
// Nodes entirely deeper than DEEP_Y are never refined below DEEP_LEVEL: that seabed is invisible under the water
// column, and deep skirts cover the mismatch at their borders. Likewise the shelf below SHALLOW_Y stops at SHALLOW_LEVEL.

import { L0, OUTSIDE_DEPTH, DETAIL } from './surface.js';

export const QUAD = 32; // quads per side of an emitted quadrant
export const NODE_QUADS = QUAD * 2;
export const ROOT_LEVEL = 8;
export const ROOT_SIZE = NODE_QUADS * L0 * 2 ** ROOT_LEVEL; // 32000 m
export const ROOT_ORIGIN = -ROOT_SIZE / 2;
export const MORPH_FRACTION = 0.3;
export const DEEP_Y = -26;
export const DEEP_LEVEL = 5;
// The shelf seabed is a smooth profile seen through a metres-thick water column: below SHALLOW_Y it needs no finer
// lattice than SHALLOW_LEVEL (the per-pixel gravel and caustics carry the detail). The boat camera is always over
// water, so this spares the finest levels right where they are most expensive.
export const SHALLOW_Y = -5;
export const SHALLOW_LEVEL = 2;

// Default LOD ranges (3D distance, metres) for levels 0..ROOT_LEVEL-1. Terrain GPU cost scales with triangle density
// (Apple GPUs pay per vertex in the tiler and heavily for quad overshading of small triangles, which with this
// fragment shader dominates), so the bands are as coarse as the error budget allows, measured on the real DEM over
// ground under 20° (where things get placed): within 600 m the p99 deviation from heightAt is 0.19 m (level 1, just
// starting to morph); within 3 km it is 2.7 m (level 3, 15.6 m lattice, 0.6 px at that distance). SPEC §3 asks for
// 2 m, which needs level 2 out to ~3.3 km: measured at +1.4 ms GPU in the boat view on an M4, far outside the 3.5 ms
// terrain budget (documented deviation, notes/WP-TERRAIN.md). Procedural detail is displaced on levels 0-1 only
// (fading across level 1's morph band); further out the fragment shader carries it as normal detail.
export const DEFAULT_RANGES = [240, 720, 2200, 4000, 7000, 13000, 26000, 52000];
// Highest level that carries the procedural detail displacement (it fades out across this level's morph band).
export const DETAIL_LEVEL = 1;

// Coarsest geometry that can render a vertex at distance d: { level, morph } (morph 0 = that level's own lattice,
// 1 = fully collapsed onto the next level's). A level-L node is only emitted beyond ranges[L - 1], so a vertex at d
// is drawn at most by the level whose band contains d.
export function coarsestAt(d, ranges = DEFAULT_RANGES) {
  const m = morphParams(ranges);
  let level = 0;
  while (level < ranges.length && ranges[level] < d) level++;
  const p = m[level];
  return { level, morph: Math.min(1, Math.max(0, (d - p.start) * p.inv)) };
}

export const spacing = (L) => L0 * 2 ** L;
export const nodeSize = (L) => NODE_QUADS * spacing(L);

// Per-level morph parameters [start, 1 / (end - start)] and skirt depth. Level 0 morphs toward level 1 like the rest.
export function morphParams(ranges) {
  const out = [];
  for (let L = 0; L <= ROOT_LEVEL; L++) {
    const end = L < ranges.length ? ranges[L] : 1e9;
    const prev = L === 0 ? 0 : ranges[L - 1];
    const start = end - MORPH_FRACTION * (end - prev);
    out.push({ start, inv: 1 / Math.max(1e-3, end - start), spacing: spacing(L), skirt: 4 + 1.5 * spacing(L) });
  }
  return out;
}

// Min/max height pyramid over the DEM (starting at 4x4 texel blocks) with mirrored-edge handling.
export function createBounds(heights, size, half) {
  const T = (2 * half) / size;
  const levels = [];
  let n = size >> 2;
  let lo = new Float32Array(n * n);
  let hi = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let a = Infinity;
      let b = -Infinity;
      for (let q = 0; q < 4; q++) {
        const row = (j * 4 + q) * size + i * 4;
        for (let p = 0; p < 4; p++) {
          const v = heights[row + p];
          if (v < a) a = v;
          if (v > b) b = v;
        }
      }
      lo[j * n + i] = a;
      hi[j * n + i] = b;
    }
  }
  levels.push({ n, lo, hi, shift: 2 });
  while (n > 1) {
    const m = n >> 1;
    const lo2 = new Float32Array(m * m);
    const hi2 = new Float32Array(m * m);
    for (let j = 0; j < m; j++) {
      for (let i = 0; i < m; i++) {
        const k = 2 * j * n + 2 * i;
        lo2[j * m + i] = Math.min(lo[k], lo[k + 1], lo[k + n], lo[k + n + 1]);
        hi2[j * m + i] = Math.max(hi[k], hi[k + 1], hi[k + n], hi[k + n + 1]);
      }
    }
    lo = lo2;
    hi = hi2;
    n = m;
    levels.push({ n, lo, hi, shift: levels[levels.length - 1].shift + 1 });
  }

  const last = size - 1;
  const mirror = (i) => {
    if (i < 0) i = -1 - i;
    else if (i > last) i = 2 * size - 1 - i;
    return i < 0 ? 0 : i > last ? last : i;
  };
  // Texel index interval touched by the Catmull-Rom stencil over world [a, b], after mirroring.
  function interval(a, b) {
    const i0 = Math.floor((a + half) / T - 0.5) - 1;
    const i1 = Math.floor((b + half) / T - 0.5) + 2;
    if (i1 - i0 >= size) return [0, last];
    let lo = Math.min(mirror(i0), mirror(i1));
    let hi = Math.max(mirror(i0), mirror(i1));
    if (i0 < 0 && i1 >= 0) lo = 0;
    if (i0 <= last && i1 > last) hi = last;
    return [lo, hi];
  }

  const margin = DETAIL.rockAmp * 0.6 + DETAIL.humpAmp + 0.1;
  const out = [0, 0];
  // [minY, maxY] of the full-detail surface over the square [x0, x0 + s] x [z0, z0 + s].
  function query(x0, z0, s, res = out) {
    const [ia, ib] = interval(x0, x0 + s);
    const [ja, jb] = interval(z0, z0 + s);
    const span = Math.max(ib - ia, jb - ja) + 1;
    let li = 0;
    while (li < levels.length - 1 && 1 << levels[li].shift < span) li++;
    const lv = levels[li];
    const ca = ia >> lv.shift;
    const cb = ib >> lv.shift;
    const ra = ja >> lv.shift;
    const rb = jb >> lv.shift;
    let a = Infinity;
    let b = -Infinity;
    for (let r = ra; r <= rb; r++) {
      for (let c = ca; c <= cb; c++) {
        const k = r * lv.n + c;
        if (lv.lo[k] < a) a = lv.lo[k];
        if (lv.hi[k] > b) b = lv.hi[k];
      }
    }
    if (Math.max(Math.abs(x0), Math.abs(x0 + s), Math.abs(z0), Math.abs(z0 + s)) > half) {
      a = Math.min(a, OUTSIDE_DEPTH);
      b = Math.max(b, OUTSIDE_DEPTH);
    }
    res[0] = a - margin;
    res[1] = b + margin;
    return res;
  }

  return { query };
}

// planes: array of 6 { normal: {x,y,z}, constant } (THREE.Frustum.planes) or null to disable culling.
function boxInFrustum(planes, x0, y0, z0, x1, y1, z1) {
  for (let p = 0; p < 6; p++) {
    const { normal: n, constant } = planes[p];
    const px = n.x > 0 ? x1 : x0;
    const py = n.y > 0 ? y1 : y0;
    const pz = n.z > 0 ? z1 : z0;
    if (n.x * px + n.y * py + n.z * pz + constant < 0) return false;
  }
  return true;
}

function boxDist2(c, x0, y0, z0, x1, y1, z1) {
  const dx = c.x < x0 ? x0 - c.x : c.x > x1 ? c.x - x1 : 0;
  const dy = c.y < y0 ? y0 - c.y : c.y > y1 ? c.y - y1 : 0;
  const dz = c.z < z0 ? z0 - c.z : c.z > z1 ? c.z - z1 : 0;
  return dx * dx + dy * dy + dz * dz;
}

// Returns a selector: select(camera {x,y,z}, planes, out Float32Array (4 per instance)) -> instance count.
// Each instance = [x0, z0, size, level]. `reflect` also keeps land boxes visible in the camera mirrored in y = 0;
// `reflectOnly` keeps only those (the dedicated reflection mesh: land above the sea, seen in the mirror).
export function createSelector({ bounds, ranges = DEFAULT_RANGES, maxInstances = 4096, reflect = true, reflectOnly = false }) {
  const r2 = ranges.map((r) => r * r);
  const b = [0, 0];
  let out = null;
  let count = 0;
  let planes = null;
  let cam = null;
  let visits = 0;

  function visible(x0, z0, s, y0, y1) {
    if (reflectOnly && y1 <= 0) return false;
    if (!planes) return true;
    if (!reflectOnly && boxInFrustum(planes, x0, y0, z0, x0 + s, y1, z0 + s)) return true;
    return (reflect || reflectOnly) && y1 > 0 && boxInFrustum(planes, x0, -y1, z0, x0 + s, -Math.max(0, y0), z0 + s);
  }

  function emit(x0, z0, s, L) {
    if (count >= maxInstances) return;
    const [y0, y1] = bounds.query(x0, z0, s, b);
    if (!visible(x0, z0, s, y0, y1)) return;
    const k = count * 4;
    out[k] = x0;
    out[k + 1] = z0;
    out[k + 2] = s;
    out[k + 3] = L;
    count++;
  }

  function emitNode(x0, z0, s, L) {
    const h = s / 2;
    emit(x0, z0, h, L);
    emit(x0 + h, z0, h, L);
    emit(x0, z0 + h, h, L);
    emit(x0 + h, z0 + h, h, L);
  }

  // Returns false when the node lies outside its level's range (the caller then covers it at the coarser level).
  function node(x0, z0, s, L) {
    visits++;
    const [y0, y1] = bounds.query(x0, z0, s, b);
    const d2 = boxDist2(cam, x0, y0, z0, x0 + s, y1, z0 + s);
    if (L < ROOT_LEVEL && d2 > r2[L]) return false;
    if (!visible(x0, z0, s, y0, y1)) return true;
    if (L === 0 || (y1 < DEEP_Y && L <= DEEP_LEVEL) || (y1 < SHALLOW_Y && L <= SHALLOW_LEVEL) || d2 > r2[L - 1]) {
      emitNode(x0, z0, s, L);
      return true;
    }
    const h = s / 2;
    if (!node(x0, z0, h, L - 1)) emit(x0, z0, h, L);
    if (!node(x0 + h, z0, h, L - 1)) emit(x0 + h, z0, h, L);
    if (!node(x0, z0 + h, h, L - 1)) emit(x0, z0 + h, h, L);
    if (!node(x0 + h, z0 + h, h, L - 1)) emit(x0 + h, z0 + h, h, L);
    return true;
  }

  return {
    ranges,
    select(camera, frustumPlanes, buffer) {
      out = buffer;
      count = 0;
      visits = 0;
      planes = frustumPlanes;
      cam = camera;
      node(ROOT_ORIGIN, ROOT_ORIGIN, ROOT_SIZE, ROOT_LEVEL);
      return count;
    },
    get visits() {
      return visits;
    },
  };
}
