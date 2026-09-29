// Deterministic per-cell placement of the solid vegetation and shore props (Sitka spruce, boulders, driftwood), shared
// by the rendered scatter layers (vegetation/index.js) and the collision tiles (terrain/colliders.js) so both always
// agree. DOM-free: the Node tests build it from the CPU surface and land cover.
//
// push(x, y, z, scale, cos(yaw), sin(yaw), tint, aux [, sx, sy, sz]) — the instance layout of common.js.

import { cellRandom } from './scatter.js';
import { smoothstep, COVER } from '../landcover.js';
import { vnoise } from '../surface.js';
import { DRIFT_R0 } from './models.js';

export const TREE_CELL = 7;
export const BOULDER_CELL = 5.5;
export const DRIFT_CELL = 6;

// Driftwood lies on the storm line of gravel and sand beaches: within DRIFT_SHORE metres of the waterline (the dry
// upper beach of this compressed world is 10-30 m wide), below the height where the terrain shader's beach band gives
// way to grass, and never on or beside developed ground.
export const DRIFT_SHORE = 30;
export const DRIFT_TOP = COVER.beachTop - 0.4;
export const DRIFT_DEV_MARGIN = 10;

export function createPlacement({ surface, landcover, heightmap, demAt, texel, isDeveloped, seed, q = 1 }) {
  const rand = cellRandom(seed);
  const dev = (x, z) => (isDeveloped ? isDeveloped(x, z) : false);
  const grad = { x: 0, z: 0 };

  // Sitka spruce in cell (ix, iz). exact: full-detail ground (3D near trees, colliders); else the cheap DEM
  // (impostors). Density follows quality.vegetation (q), as rendered.
  function spruceAt(ix, iz, push, exact) {
    const x = (ix + 0.12 + 0.76 * rand(ix, iz, 1)) * TREE_CELL;
    const z = (iz + 0.12 + 0.76 * rand(ix, iz, 2)) * TREE_CELL;
    const fd = landcover.forestFast(x, z, demAt, texel);
    if (fd <= 0.02) return;
    if (rand(ix, iz, 3) > fd * Math.min(1, 0.6 + 0.4 * q) * 0.94) return;
    if (dev(x, z)) return;
    const hgt = (8.5 + 8.5 * rand(ix, iz, 4)) * (0.5 + 0.5 * fd) * (rand(ix, iz, 9) < 0.08 ? 0.5 : 1);
    const y = exact ? surface.heightAt(x, z) - 0.25 : demAt(x, z) - 0.6;
    if (y < 0.4) return;
    const yaw = rand(ix, iz, 5) * Math.PI * 2;
    push(x, y, z, hgt, Math.cos(yaw), Math.sin(yaw), (rand(ix, iz, 6) - 0.5) * 2, rand(ix, iz, 7));
  }

  // Boulders: beaches and rocky shores (some awash), erratics in the meadows, talus below crags.
  function boulderAt(ix, iz, push) {
    const r0 = rand(ix, iz, 71);
    if (r0 > 0.35) return;
    const x = (ix + rand(ix, iz, 72)) * BOULDER_CELL;
    const z = (iz + rand(ix, iz, 73)) * BOULDER_CELL;
    const sd = heightmap.shoreDistance(x, z);
    if (sd > 40 || sd < -400) return;
    const s = landcover.sample(x, z);
    let p = 0;
    let big = 1;
    if (s.h > -2.8 && s.h < 2.4 && sd > -30) {
      const rocky = smoothstep(0.08, 0.5, s.s);
      p = 0.05 + 0.3 * rocky;
      big = 0.7 + rocky;
    } else if (s.h >= 2.4) {
      const score = landcover.rockScore(x, z, s.h, s.s, s.sd, 0);
      p = 0.006 + 0.08 * smoothstep(1.1, 1.4, score) * (1 - smoothstep(1.5, 1.7, score));
    }
    if (r0 > p || dev(x, z)) return;
    const r = (0.35 + Math.pow(rand(ix, iz, 74), 2.2) * 1.6) * big;
    const yaw = rand(ix, iz, 75) * Math.PI * 2;
    const y = surface.heightAt(x, z) - r * 0.28;
    push(x, y, z, r, Math.cos(yaw), Math.sin(yaw), (rand(ix, iz, 76) - 0.5) * 1.6, 0, 0.8 + rand(ix, iz, 77) * 0.5, 0.7 + rand(ix, iz, 78) * 0.4, 0.8 + rand(ix, iz, 79) * 0.5);
  }

  // Driftwood logs lying with the shore on the dry upper beach.
  function driftAt(ix, iz, push) {
    const r0 = rand(ix, iz, 91);
    if (r0 > 0.6) return;
    const x = (ix + rand(ix, iz, 92)) * DRIFT_CELL;
    const z = (iz + rand(ix, iz, 93)) * DRIFT_CELL;
    const sd = heightmap.shoreDistance(x, z);
    if (sd > 1.5 || sd < -DRIFT_SHORE) return;
    const h = surface.heightAt(x, z);
    // The shader's beach band (material.js step 6) with its 17 m noise: logs only where it is fully gravel/sand.
    const bn = vnoise(x / 17 + 4.4, z / 17 + 1.9);
    if (h < 0.7 || h > COVER.beachTop - 0.15 || h + (bn - 0.5) * 0.9 > DRIFT_TOP) return;
    const s = landcover.sample(x, z);
    if (s.s > 0.4 || s.dev > 0.02 || dev(x, z)) return;
    if (landcover.rockFrom(x, z, s.h, s.s, s.sd, landcover.curvatureAt(x, z)) > 0.25) return;
    // Logs pile up on the storm line, most thickly below the spruce forests they came from.
    const p = 0.26 + 0.34 * s.spruce;
    if (r0 > p) return;
    heightmap.shoreGradient(x, z, grad);
    const along = Math.atan2(-grad.x, grad.z);
    const yaw = along + (rand(ix, iz, 94) - 0.5) * 0.9;
    const len = 3.5 + rand(ix, iz, 95) ** 1.5 * 10;
    // Keep the whole log (and a margin) off developed ground: town beaches sit right below the houses.
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    for (const t of [len / 2, len / 2 + DRIFT_DEV_MARGIN]) if (dev(x + cy * t, z + sy * t) || dev(x - cy * t, z - sy * t)) return;
    if (dev(x - grad.x * DRIFT_DEV_MARGIN, z - grad.z * DRIFT_DEV_MARGIN)) return;
    const k = 0.6 + rand(ix, iz, 96) * 0.8;
    const rad = len * DRIFT_R0 * k;
    const wad = rand(ix, iz, 97) < 0.25 ? 1 : 0;
    // Half-settled into the gravel.
    push(x, h + rad * 0.45, z, len, Math.cos(yaw), Math.sin(yaw), (rand(ix, iz, 98) - 0.5) * 1.2, wad, 1, k, k);
  }

  return { rand, dev, spruceAt, boulderAt, driftAt };
}
