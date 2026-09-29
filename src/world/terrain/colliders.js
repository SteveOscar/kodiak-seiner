// Solid terrain props for terrain.collidersNear(x, z, radius): spruce trunks and boulders as circles, driftwood logs as
// oriented boxes (plus a circle for a root wad). Same shapes as places.collidersNear (see places/colliders.js):
//   { kind: 'circle', x, z, r, y0, y1 } | { kind: 'box', x, z, hx, hz, rot (heading convention), y0, y1 }
// Grass, ferns, flowers and alder/salmonberry shrubs are soft and have no colliders.
//
// Props come from vegetation/placement.js, the same per-cell functions (and seed and quality) the rendered layers use.
// The island holds millions of spruce cells, so instead of building the whole grid at create the 32 m grid tiles are
// filled on first touch (a fraction of a millisecond each), cached, and pre-warmed around the camera from
// beforeRender; a query over warm tiles costs a few microseconds.

import { TREE_CELL, BOULDER_CELL, DRIFT_CELL } from './vegetation/placement.js';
import { boulderGeometry, driftwoodGeometry } from './vegetation/models.js';

export const COLLIDER_TILE = 32;

// Unit-model extents measured from the rendered geometries.
function measure(geometry) {
  const p = geometry.attributes.position.array;
  let minY = Infinity;
  let maxY = -Infinity;
  let maxX = 0;
  let maxZ = 0;
  for (let i = 0; i < p.length; i += 3) {
    minY = Math.min(minY, p[i + 1]);
    maxY = Math.max(maxY, p[i + 1]);
    maxX = Math.max(maxX, Math.abs(p[i]));
    maxZ = Math.max(maxZ, Math.abs(p[i + 2]));
  }
  geometry.dispose?.();
  return { minY, maxY, maxX, maxZ };
}

// Log body half-width (z) and half-height (y) around the straight axis, crook included; the 98.5th percentile skips the
// thin snapped branch stubs. The root wad's radial reach is measured at the butt.
function measureLog(geometry) {
  const p = geometry.attributes.position.array;
  const zs = [];
  const ys = [];
  let wad = 0;
  let minX = Infinity;
  for (let i = 0; i < p.length; i += 3) {
    minX = Math.min(minX, p[i]);
    if (p[i] > -0.38) {
      zs.push(Math.abs(p[i + 2]));
      ys.push(Math.abs(p[i + 1]));
    } else wad = Math.max(wad, Math.hypot(p[i + 1], p[i + 2]));
  }
  geometry.dispose?.();
  const q = (a) => a.sort((u, v) => u - v)[Math.floor(a.length * 0.985)];
  return { trunkZ: q(zs), trunkY: q(ys), wad, minX };
}

export function propExtents(seed) {
  return {
    boulder: measure(boulderGeometry(seed + 61, { detail: 1 })),
    log: measureLog(driftwoodGeometry(seed + 81)),
    wadLog: measureLog(driftwoodGeometry(seed + 82, { rootWad: true })),
  };
}

// Spruce trunk radius for a tree of height hgt (bark cone 0.014 h plus the dark core ~0.025 h at the lowest whorl).
export const trunkRadius = (hgt) => Math.max(0.15, 0.022 * hgt);

export function createTerrainColliders({ placement, seed, extents = propExtents(seed), maxTiles = 3000 }) {
  const T = COLLIDER_TILE;
  const tiles = new Map();
  const key = (tx, tz) => (tx + 32768) * 65536 + (tz + 32768);
  // Farthest a collider's footprint reaches beyond the tile holding its prop's centre (the longest log's root wad).
  const reach = 10;
  let built = 0;
  let buildMs = 0;

  function buildTile(tx, tz) {
    const t0 = performance.now();
    const x0 = tx * T;
    const z0 = tz * T;
    const list = [];
    const inside = (x, z) => x >= x0 && x < x0 + T && z >= z0 && z < z0 + T;
    const { boulder, log, wadLog } = extents;
    const spruce = (x, y, z, hgt) => {
      if (inside(x, z)) list.push(Object.freeze({ kind: 'circle', x, z, r: trunkRadius(hgt), y0: y, y1: y + hgt }));
    };
    const rock = (x, y, z, r, c, s, tint, aux, sx, sy, sz) => {
      if (!inside(x, z)) return;
      const ex = boulder.maxX * r * sx;
      const ez = boulder.maxZ * r * sz;
      list.push(Object.freeze({ kind: 'circle', x, z, r: 0.46 * (ex + ez), y0: y + boulder.minY * r * sy, y1: y + boulder.maxY * r * sy }));
    };
    const drift = (x, y, z, len, c, s, tint, wad, sx, sy, sz) => {
      if (!inside(x, z)) return;
      const m = wad > 0.5 ? wadLog : log;
      // Local +x of the log model maps to world (cos yaw, sin yaw) = the heading-convention box axis for rot = yaw.
      list.push(Object.freeze({ kind: 'box', x, z, hx: len / 2, hz: m.trunkZ * len * sz, rot: Math.atan2(s, c), y0: y - m.trunkY * len * sy, y1: y + m.trunkY * len * sy }));
      if (wad > 0.5) {
        const wr = m.wad * len * sz;
        const bx = x + c * m.minX * len * 0.85;
        const bz = z + s * m.minX * len * 0.85;
        list.push(Object.freeze({ kind: 'circle', x: bx, z: bz, r: wr * 0.85, y0: y - wr, y1: y + wr }));
      }
    };
    const cells = (cell, fn) => {
      for (let iz = Math.floor(z0 / cell) - 1; iz <= Math.floor((z0 + T) / cell); iz++) {
        for (let ix = Math.floor(x0 / cell) - 1; ix <= Math.floor((x0 + T) / cell); ix++) fn(ix, iz);
      }
    };
    cells(TREE_CELL, (ix, iz) => placement.spruceAt(ix, iz, spruce, true));
    cells(BOULDER_CELL, (ix, iz) => placement.boulderAt(ix, iz, rock));
    cells(DRIFT_CELL, (ix, iz) => placement.driftAt(ix, iz, drift));
    built++;
    buildMs += performance.now() - t0;
    return list;
  }

  function tile(tx, tz) {
    const k = key(tx, tz);
    let t = tiles.get(k);
    if (t) return t;
    t = buildTile(tx, tz);
    if (tiles.size >= maxTiles) {
      // Forget the oldest half (insertion order); tiles are cheap to rebuild and deterministic.
      let n = tiles.size >> 1;
      for (const old of tiles.keys()) {
        if (n-- <= 0) break;
        tiles.delete(old);
      }
    }
    tiles.set(k, t);
    return t;
  }

  function distance(c, x, z) {
    const dx = x - c.x;
    const dz = z - c.z;
    if (c.kind === 'circle') return Math.max(0, Math.hypot(dx, dz) - c.r);
    const cs = Math.cos(c.rot);
    const sn = Math.sin(c.rot);
    const lx = Math.abs(dx * cs + dz * sn) - c.hx;
    const lz = Math.abs(-dx * sn + dz * cs) - c.hz;
    return Math.hypot(Math.max(lx, 0), Math.max(lz, 0));
  }

  return {
    near(x, z, radius = 0, out = []) {
      out.length = 0;
      if (!(Number.isFinite(x) && Number.isFinite(z))) return out;
      const r = Math.max(0, radius || 0);
      const tx0 = Math.floor((x - r - reach) / T);
      const tx1 = Math.floor((x + r + reach) / T);
      const tz0 = Math.floor((z - r - reach) / T);
      const tz1 = Math.floor((z + r + reach) / T);
      for (let tz = tz0; tz <= tz1; tz++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          const list = tile(tx, tz);
          for (let i = 0; i < list.length; i++) {
            const c = list[i];
            const e = (c.kind === 'circle' ? c.r : c.hx + c.hz) + r;
            const dx = x - c.x;
            const dz = z - c.z;
            if (dx * dx + dz * dz > e * e) continue;
            if (distance(c, x, z) <= r) out.push(c);
          }
        }
      }
      return out;
    },
    // Builds missing tiles within `radius` of (x, z) until performance.now() passes `deadline`.
    warm(x, z, radius, deadline) {
      const tx0 = Math.floor((x - radius) / T);
      const tx1 = Math.floor((x + radius) / T);
      const tz0 = Math.floor((z - radius) / T);
      const tz1 = Math.floor((z + radius) / T);
      for (let tz = tz0; tz <= tz1; tz++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          if (tiles.has(key(tx, tz))) continue;
          if (performance.now() > deadline) return false;
          tile(tx, tz);
        }
      }
      return true;
    },
    stats: () => ({ tiles: tiles.size, built, msPerTile: built ? +(buildMs / built).toFixed(3) : 0 }),
  };
}

