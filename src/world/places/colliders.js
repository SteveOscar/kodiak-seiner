// Solid volumes for the built world, published as places.collidersNear(x, z, radius) (cross-package interface):
//   { kind: 'circle', x, z, r, y0, y1 }
//   { kind: 'box', x, z, hx, hz, rot, y0, y1 }
// World metres; y0..y1 is the vertical extent. A box's rot uses the heading convention (SPEC §3: 0 = north, clockwise
// positive): its local x axis points along (cos rot, sin rot) and its local z axis along (-sin rot, cos rot) in world
// x/z, so a point's local coordinates are lx = dx cos + dz sin, lz = -dx sin + dz cos.
//
// Builders push a collider next to the geometry it stands for, from the same frame and dimensions (kit.js frames use
// rot = Object3D.rotation.y, hence the sign flip). A coarse uniform grid built once at create answers queries in
// microseconds.

import { Builder } from './kit.js';

const _p = [0, 0, 0];

// Box in a kit frame f centred on local (lx, lz), w along local x and d along local z.
export function colBox(S, f, lx, lz, w, d, y0, y1) {
  if (!S.colliders || !(w > 0) || !(d > 0) || !(y1 > y0)) return;
  Builder.xf({ x: f.x, z: f.z, rot: f.rot ?? 0, y: 0 }, lx, 0, lz, _p);
  S.colliders.push({ kind: 'box', x: _p[0], z: _p[2], hx: w / 2, hz: d / 2, rot: -(f.rot ?? 0), y0, y1 });
}

// Vertical cylinder of radius r at world (x, z).
export function colCircle(S, x, z, r, y0, y1) {
  if (!S.colliders || !(r > 0) || !(y1 > y0)) return;
  S.colliders.push({ kind: 'circle', x, z, r, y0, y1 });
}

// Horizontal distance from (x, z) to a collider's footprint (0 inside).
export function colliderDistance(c, x, z) {
  const dx = x - c.x;
  const dz = z - c.z;
  if (c.kind === 'circle') return Math.max(0, Math.hypot(dx, dz) - c.r);
  const cs = Math.cos(c.rot);
  const sn = Math.sin(c.rot);
  const lx = Math.abs(dx * cs + dz * sn) - c.hx;
  const lz = Math.abs(-dx * sn + dz * cs) - c.hz;
  return Math.hypot(Math.max(lx, 0), Math.max(lz, 0));
}

// Uniform grid over a fixed collider list. near(x, z, radius, out?) returns the colliders whose footprint lies
// within `radius` of the point (exact for circles and boxes), each at most once.
export function createColliderGrid(list, cell = 24) {
  const items = list.map((c) => Object.freeze({ ...c }));
  const cells = new Map();
  const key = (i, j) => (i + 32768) * 65536 + (j + 32768);
  const reach = new Float64Array(items.length);
  let ci0 = Infinity;
  let ci1 = -Infinity;
  let cj0 = Infinity;
  let cj1 = -Infinity;
  items.forEach((c, n) => {
    const e = c.kind === 'circle' ? c.r : Math.hypot(c.hx, c.hz);
    reach[n] = e;
    const i0 = Math.floor((c.x - e) / cell);
    const i1 = Math.floor((c.x + e) / cell);
    const j0 = Math.floor((c.z - e) / cell);
    const j1 = Math.floor((c.z + e) / cell);
    ci0 = Math.min(ci0, i0);
    ci1 = Math.max(ci1, i1);
    cj0 = Math.min(cj0, j0);
    cj1 = Math.max(cj1, j1);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = key(i, j);
        let a = cells.get(k);
        if (!a) cells.set(k, (a = []));
        a.push(n);
      }
    }
  });
  const stamp = new Uint32Array(items.length);
  let query = 0;
  let maxReach = 0;
  for (const e of reach) maxReach = Math.max(maxReach, e);
  return {
    items,
    cellCount: cells.size,
    maxReach,
    near(x, z, radius = 0, out = []) {
      out.length = 0;
      if (!(Number.isFinite(x) && Number.isFinite(z))) return out;
      const r = Math.max(0, radius || 0);
      query = (query + 1) >>> 0;
      if (query === 0) {
        stamp.fill(0);
        query = 1;
      }
      const i0 = Math.max(ci0, Math.floor((x - r) / cell));
      const i1 = Math.min(ci1, Math.floor((x + r) / cell));
      const j0 = Math.max(cj0, Math.floor((z - r) / cell));
      const j1 = Math.min(cj1, Math.floor((z + r) / cell));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const a = cells.get(key(i, j));
          if (!a) continue;
          for (let q = 0; q < a.length; q++) {
            const n = a[q];
            if (stamp[n] === query) continue;
            stamp[n] = query;
            const c = items[n];
            const dx = x - c.x;
            const dz = z - c.z;
            const e = reach[n] + r;
            if (dx * dx + dz * dz > e * e) continue;
            if (colliderDistance(c, x, z) <= r) out.push(c);
          }
        }
      }
      return out;
    },
  };
}
