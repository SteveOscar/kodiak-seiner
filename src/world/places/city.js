// The City of Kodiak on the game DEM: downtown on the west shore of the harbour channel, St. Paul Harbor behind its
// breakwater, cannery row on pilings, the Near Island bridge across the channel head, St. Herman Harbor and the
// Fisheries Research Center on the east side, the cathedral on its rise, houses climbing toward Pillar Mountain.
// Each district goes into its own Builder so the chunks cull independently.

import { Builder, WIN, col } from './kit.js';
import { house, block, church, shed, pileDeck, tank, boat, PALETTE } from './structures.js';
import { findLots, faceRot, marchToWater } from './sites.js';
import { breakwater, slips, pier } from './harbor.js';
import { colBox, colCircle } from './colliders.js';

// Harbour-front axes: A runs NE along the west shore, N points seaward (SE).
const A = { x: 0.85, z: -0.53 };
const N = { x: 0.53, z: 0.85 };
const M = { x: 4962, z: -1024 }; // shore point at the middle of St. Paul Harbor
const at = (s, t) => ({ x: M.x + A.x * s + N.x * t, z: M.z + A.z * s + N.z * t });
const ROT_SEA = faceRot(N.x, N.z);

export const KODIAK_LAYOUT = {
  dock: at(104, 68), // city pier head; the player's tie-up (places.js data) lies alongside it
  bridge: [{ x: 5122, z: -1193 }, { x: 5240, z: -1189 }],
  cathedral: { x: 5036, z: -1238 },
  ridge: [{ x: 4790, z: -1292 }, { x: 4985, z: -1392 }],
};

export function buildKodiak(S, chunks) {
  const { rng } = S;
  const glowsBefore = S.glows.length;

  // ---------------------------------------------------------------- St. Paul Harbor
  S.b = chunks('kodiak-harbor');
  breakwater(S, [at(-66, 6), at(-58, 66), at(58, 70)], { lightAtEnd: 'green' });
  slips(S, { ...at(-4, 18), rot: ROT_SEA }, { len: 96, fingerLen: 10, pitch: 7.2, fill: 0.85 });
  slips(S, { ...at(-2, 44), rot: ROT_SEA }, { len: 92, fingerLen: 9, pitch: 7.0, both: true, fill: 0.8, boatL: [8, 15] });
  // gangways
  for (const s of [-30, 24]) {
    const a = at(s, -2);
    const c = at(s, 17);
    S.b.beam([a.x, 1.6, a.z], [c.x, 0.5, c.z], 1.3, col('#8e8c85'));
    colBox(S, { x: (a.x + c.x) / 2, z: (a.z + c.z) / 2, rot: ROT_SEA }, 0, 0, 1.3, 19, -0.15, 2.25);
  }
  // harbormaster office and boat-grid shed on the shore
  block(S, at(-20, -16).x, at(-20, -16).z, ROT_SEA, { w: 16, d: 10, floors: 2, wall: '#6f8f9f' });
  // city pier + ferry terminal
  const pierShore = at(104, -2);
  const d = KODIAK_LAYOUT.dock;
  pier(S, pierShore, { x: d.x - N.x * 6, z: d.z - N.z * 6 }, 12, 3.6);
  block(S, at(92, -14).x, at(92, -14).z, ROT_SEA, { w: 22, d: 12, floors: 2, wall: '#d9d4c7', trim: '#2f5d7a' });
  for (let i = 0; i < 3; i++) tank(S, at(118 + i * 8, -22).x, at(118 + i * 8, -22).z, 3.2, 7);

  // ---------------------------------------------------------------- cannery row (pilings along the west shore)
  S.b = chunks('kodiak-canneries');
  const plants = [
    { z: -1103, w: 30, wall: PALETTE.metalWhite, roof: '#8b3a2e' },
    { z: -1133, w: 28, wall: PALETTE.metalBlue, roof: PALETTE.galvanized },
    { z: -1162, w: 26, wall: '#e6e2d8', roof: '#5d6c73' },
  ];
  for (const p of plants) {
    const w = marchToWater(S, 5020, p.z, 1, 0, 300, 1.5);
    if (!w) continue;
    const g = S.hm.shoreGradient(w.x, w.z);
    const rot = faceRot(g.x, g.z);
    const depth = 40;
    const f = { x: w.x + g.x * 12, z: w.z + g.z * 12, rot, y: 3.8 };
    pileDeck(S, f, 0, 0, p.w, depth, 3.8, { spacing: 4.2 });
    shed(S, f, 0, -depth * 0.12, p.w - 3, depth * 0.62, 10, { wall: p.wall, roof: p.roof, doors: 2 });
    shed(S, f, -p.w * 0.2, depth * 0.3, p.w * 0.45, depth * 0.24, 6, { wall: '#d4d0c6', roof: '#6b7478', doors: 1 });
    const sp = Builder.xf(f, p.w * 0.3, 13.8, -depth * 0.2, [0, 0, 0]);
    S.b.cylinder({ x: sp[0], z: sp[2], rot: 0, y: 13.8 }, 0, 0, 0, 0.6, 0.5, 6, 10, col('#8a3d30'));
    S.smoke.push({ x: sp[0], y: 20, z: sp[2], kind: 'steam', phase: rng.next(), strength: 1 });
    for (const lx of [-p.w * 0.4, p.w * 0.4]) {
      const q = Builder.xf(f, lx, 10.5, depth / 2 - 0.8, [0, 0, 0]);
      S.b.box({ x: q[0], z: q[2], rot, y: 3.8 }, 0, 0, 0, 0.18, 6.8, 0.18, col('#44484a'));
      colCircle(S, q[0], q[2], 0.12, 3.8, 10.6);
      S.glows.push({ x: q[0], y: q[1], z: q[2], color: '#ffd7a0', intensity: 4.5, size: 1.4 });
    }
    // a tender unloading
    const bp = Builder.xf(f, 0, 0, depth / 2 + 5, [0, 0, 0]);
    if (p.z !== -1162) boat(S, { x: bp[0], z: bp[2], rot: rot + Math.PI / 2 }, { L: 26, B: 7.5, mastH: 11, hull: rng.next() < 0.5 ? '#2a2a2a' : '#1f3b5a' });
    // cold storage + bunkhouse behind, on land
    const bh = { x: w.x - g.x * 24, z: w.z - g.z * 24 };
    block(S, bh.x, bh.z, rot, { w: p.w - 4, d: 12, floors: 2, wall: '#bfc6c8', store: false, win: WIN.shed });
  }

  // ---------------------------------------------------------------- downtown (commercial waterfront + grid)
  S.b = chunks('kodiak-downtown');
  const taken = [];
  const place = (x, z, r) => {
    for (const t of taken) if ((t.x - x) ** 2 + (t.z - z) ** 2 < (t.r + r) ** 2) return false;
    taken.push({ x, z, r });
    return true;
  };
  taken.push({ x: KODIAK_LAYOUT.cathedral.x, z: KODIAK_LAYOUT.cathedral.z, r: 22 });
  for (let s = -44; s <= 124; s += 19) {
    for (const t of [-24, -44, -64, -84]) {
      const p = at(s + (rng.next() - 0.5) * 5, t + (rng.next() - 0.5) * 4);
      if (S.hm.heightAt(p.x, p.z) < 0.8 || S.hm.shoreDistance(p.x, p.z) > -8) continue;
      if (!place(p.x, p.z, 9.5)) continue;
      if (t === -26 || rng.next() < 0.55) block(S, p.x, p.z, ROT_SEA + (rng.next() - 0.5) * 0.04, { floors: t === -26 ? 2 + Math.floor(rng.next() * 2) : 2 });
      else house(S, p.x, p.z, ROT_SEA + (rng.next() - 0.5) * 0.2, { floors: 2 });
    }
  }
  // Holy Resurrection Cathedral on its rise, facing the harbour
  {
    const c = KODIAK_LAYOUT.cathedral;
    church(S, c.x, c.z, faceRot(0.35, 0.94), { scale: 1.05, dome: '#2f63c0', roof: '#4d5d68', tower: 'tall', domes: 'cathedral' });
  }
  // streetlights along the waterfront and up the main street
  for (let s = -50; s <= 150; s += 20) {
    const p = at(s, -9);
    if (S.hm.heightAt(p.x, p.z) < 0.3) continue;
    const g = S.H(p.x, p.z);
    S.b.box({ x: p.x, z: p.z, rot: ROT_SEA, y: g - 2.2 }, 0, 0, 0, 0.16, 8.7, 0.16, col('#4a4d50'));
    colCircle(S, p.x, p.z, 0.12, g - 2.2, g + 6.5);
    S.glows.push({ x: p.x, y: g + 6.6, z: p.z, color: '#ffb35c', intensity: 5, size: 1.5 });
  }
  for (let t = -20; t >= -160; t -= 22) {
    const p = at(52, t);
    if (S.hm.heightAt(p.x, p.z) < 0.3) continue;
    const g = S.H(p.x, p.z);
    S.b.box({ x: p.x, z: p.z, rot: ROT_SEA, y: g - 2.2 }, 0, 0, 0, 0.16, 8.7, 0.16, col('#4a4d50'));
    colCircle(S, p.x, p.z, 0.12, g - 2.2, g + 6.5);
    S.glows.push({ x: p.x, y: g + 6.6, z: p.z, color: '#ffb35c', intensity: 5, size: 1.5 });
  }

  // ---------------------------------------------------------------- residential hills (west knoll, north slopes)
  S.b = chunks('kodiak-west');
  const hillAvoid = taken.map((t) => ({ x: t.x, z: t.z, r: t.r + 4 }));
  const west = findLots(S, 4925, -1205, { n: 96, R: 130, minH: 1.2, maxH: 48, maxSlope: 34, spacing: 12, avoid: hillAvoid, score: (x, z) => Math.hypot(x - 4970, z + 1170) * 0.25 });
  for (const l of west) {
    house(S, l.x, l.z, l.rot);
    taken.push({ x: l.x, z: l.z, r: 6 });
  }
  S.b = chunks('kodiak-north');
  const north = findLots(S, 5120, -1330, { n: 120, R: 145, minH: 1.2, maxH: 46, maxSlope: 33, spacing: 12, avoid: taken.map((t) => ({ x: t.x, z: t.z, r: t.r + 3 })), face: { x: 5140, z: -1100 }, rotJitter: 30 });
  for (const l of north) {
    house(S, l.x, l.z, l.rot);
    taken.push({ x: l.x, z: l.z, r: 6 });
  }
  const east = findLots(S, 5345, -1420, { n: 60, R: 115, minH: 1.2, maxH: 40, maxSlope: 32, spacing: 12.5, avoid: taken.map((t) => ({ x: t.x, z: t.z, r: t.r + 3 })), face: { x: 5300, z: -1200 }, rotJitter: 35 });
  for (const l of east) house(S, l.x, l.z, l.rot);
  // a few streetlights among the houses
  for (let i = 0; i < north.length; i += 6) {
    const l = north[i];
    const g = S.H(l.x + 7, l.z + 5);
    S.b.box({ x: l.x + 7, z: l.z + 5, rot: 0, y: g - 2.2 }, 0, 0, 0, 0.14, 8.2, 0.14, col('#4a4d50'));
    colCircle(S, l.x + 7, l.z + 5, 0.1, g - 2.2, g + 6);
    S.glows.push({ x: l.x + 7, y: g + 6, z: l.z + 5, color: '#ffb35c', intensity: 4, size: 1.2 });
  }

  // ---------------------------------------------------------------- Near Island bridge
  S.b = chunks('kodiak-bridge');
  buildBridge(S, KODIAK_LAYOUT.bridge[0], KODIAK_LAYOUT.bridge[1]);

  // ---------------------------------------------------------------- Near Island: St. Herman Harbor, research centre
  S.b = chunks('kodiak-near-island');
  {
    // east shore float line with larger boats (crabbers, tenders)
    const w0 = marchToWater(S, 5330, -1085, -1, 0, 200, 1.5);
    if (w0) {
      const g = S.hm.shoreGradient(w0.x, w0.z);
      const rot = faceRot(g.x, g.z);
      slips(S, { x: w0.x + g.x * 12, z: w0.z + g.z * 12, rot }, { len: 70, fingerLen: 14, pitch: 9.5, fill: 0.9, boatL: [14, 28] });
      // an outer float of limit seiners and gillnetters, fingers on both sides
      slips(S, { x: w0.x + g.x * 47 - g.z * 6, z: w0.z + g.z * 47 + g.x * 6, rot }, { len: 96, fingerLen: 10, pitch: 7.4, both: true, fill: 0.85, boatL: [10, 18] });
      // boatyard: travel-lift shed and hauled-out boats
      const yard = { x: w0.x - g.x * 30, z: w0.z - g.z * 30 };
      shed(S, { x: yard.x, z: yard.z, rot, y: Math.max(0.5, S.H(yard.x, yard.z)) }, 0, 0, 34, 22, 12, { wall: '#c6cdd0', roof: '#5d6c73', doors: 2, below: 2.5 });
      for (let i = 0; i < 3; i++) {
        const bx = yard.x - g.z * (26 + i * 9);
        const bz = yard.z + g.x * (26 + i * 9);
        S.sites.push({ x: bx, z: bz, r: 11 });
        boat(S, { x: bx, z: bz, rot: rot + 0.1 * i, y: S.H(bx, bz) + 2.2 }, { L: 14 + i * 3, B: 5 });
        S.b.box({ x: bx, z: bz, rot, y: S.H(bx, bz) - 2.2 }, 0, 0, 0, 3, 4.4, 8, col('#5a4f45'));
        colBox(S, { x: bx, z: bz, rot }, 0, 0, 3, 8, S.H(bx, bz) - 2.2, S.H(bx, bz) + 2.2);
      }
    }
    // Kodiak Fisheries Research Center
    const rc = { x: 5332, z: -1150 };
    const rrot = faceRot(-0.8, 0.6);
    block(S, rc.x, rc.z, rrot, { w: 58, d: 18, floors: 3, wall: '#d8d6cc', trim: '#6c7f7a', store: false });
    block(S, rc.x + 18, rc.z - 20, rrot, { w: 22, d: 14, floors: 2, wall: '#a9b4b9', store: false });
  }

  // ---------------------------------------------------------------- Pillar Mountain wind turbines (bases)
  const turbines = ridgeSites(S, KODIAK_LAYOUT.ridge[0], KODIAK_LAYOUT.ridge[1], 6, 40);
  S.b = chunks('kodiak-turbines');
  for (const t of turbines) turbineBase(S, t);
  return { turbines, glows: S.glows.length - glowsBefore };
}

// Highest point within +-reach across the line at n evenly spaced stations.
export function ridgeSites(S, a, c, n, reach) {
  const dx = c.x - a.x;
  const dz = c.z - a.z;
  const len = Math.hypot(dx, dz);
  const px = -dz / len;
  const pz = dx / len;
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    let best = null;
    for (let o = -reach; o <= reach; o += 3) {
      const x = a.x + dx * t + px * o;
      const z = a.z + dz * t + pz * o;
      const h = S.hm.heightAt(x, z);
      if (!best || h > best.h) best = { x, z, h };
    }
    best.h = S.H(best.x, best.z);
    out.push(best);
  }
  return out;
}

// Turbine scale: towers and rotors are shown at ~43% of the real GE 1.5 MW (80 m hub, 77 m rotor) so they sit on the
// 1:11.75-compressed ridge without dwarfing it. Rotors are instanced and animated by the system.
export const TURBINE = { hub: 34, rotor: 16.5, towerR0: 1.15, towerR1: 0.75 };

function turbineBase(S, t) {
  const g = t.h;
  const f = { x: t.x, z: t.z, rot: 0, y: g - 2.5 };
  S.sites.push({ x: t.x, z: t.z, r: 12 });
  S.b.cylinder(f, 0, 0, 0, 4.2, 4.2, 2.9, 10, col(PALETTE.concrete));
  S.b.cylinder(f, 0, 2.5, 0, TURBINE.towerR0, TURBINE.towerR1, TURBINE.hub - 0.3, 14, col('#eef0f0'), { top: false });
  // plinth (a knee-high step) and the tower up to the nacelle
  colCircle(S, t.x, t.z, 4.2, f.y, f.y + 2.9);
  colCircle(S, t.x, t.z, TURBINE.towerR0, f.y, g + TURBINE.hub + 1.2);
  S.b.box({ x: t.x, z: t.z, rot: 0, y: g }, 0, 0, TURBINE.towerR0 + 0.02, 0.9, 2.1, 0.05, col('#56606a'), { top: false });
}

// Two-lane concrete girder bridge with approach ramps between two shore points.
function buildBridge(S, a, c) {
  const { b } = S;
  const len = Math.hypot(c.x - a.x, c.z - a.z);
  const ux = (c.x - a.x) / len;
  const uz = (c.z - a.z) / len;
  const rot = faceRot(ux, uz) - Math.PI / 2; // local x along the span
  const deckY = 9.5;
  const ramp = 34;
  const concrete = col('#a7a6a0');
  for (const [e, sgn] of [[a, -1], [c, 1]]) S.sites.push({ x: e.x + ux * sgn * ramp * 0.6, z: e.z + uz * sgn * ramp * 0.6, r: ramp * 0.6 });
  const dark = col('#6d6c68');
  const segs = 24;
  const total = len + 2 * ramp;
  const yAt = (s) => {
    if (s < ramp) return Math.max(S.H(a.x - ux * (ramp - s), a.z - uz * (ramp - s)), 0) + (deckY - Math.max(S.H(a.x, a.z), 0)) * (s / ramp);
    if (s > ramp + len) return Math.max(S.H(c.x + ux * (s - ramp - len), c.z + uz * (s - ramp - len)), 0) + (deckY - Math.max(S.H(c.x, c.z), 0)) * ((total - s) / ramp);
    return deckY;
  };
  for (let i = 0; i < segs; i++) {
    const s0 = (i / segs) * total;
    const s1 = ((i + 1) / segs) * total;
    const x0 = a.x - ux * ramp + ux * s0;
    const z0 = a.z - uz * ramp + uz * s0;
    const x1 = a.x - ux * ramp + ux * s1;
    const z1 = a.z - uz * ramp + uz * s1;
    const y0 = yAt(s0);
    const y1 = yAt(s1);
    const hw = 5.5;
    const px = -uz * hw;
    const pz = ux * hw;
    const P = (x, y, z) => [x, y, z];
    // deck top and underside/edges
    b.quad(P(x0 - px, y0, z0 - pz), P(x0 + px, y0, z0 + pz), P(x1 + px, y1, z1 + pz), P(x1 - px, y1, z1 - pz), col('#5c5e60'));
    b.quad(P(x0 + px, y0 - 1.4, z0 + pz), P(x0 - px, y0 - 1.4, z0 - pz), P(x1 - px, y1 - 1.4, z1 - pz), P(x1 + px, y1 - 1.4, z1 + pz), dark);
    colBox(S, { x: (x0 + x1) / 2, z: (z0 + z1) / 2, rot }, 0, 0, s1 - s0, 2 * hw, Math.min(y0, y1) - 1.4, Math.max(y0, y1) + 1.0);
    for (const sgn of [1, -1]) {
      const ex = sgn * px;
      const ez = sgn * pz;
      const a0 = P(x0 + ex, y0 - 1.4, z0 + ez);
      const a1 = P(x1 + ex, y1 - 1.4, z1 + ez);
      const t0 = P(x0 + ex, y0 + 1.0, z0 + ez);
      const t1 = P(x1 + ex, y1 + 1.0, z1 + ez);
      if (sgn > 0) b.quad(a0, a1, t1, t0, concrete);
      else b.quad(a1, a0, t0, t1, concrete);
    }
    // piers under the span every other segment
    const sm = (s0 + s1) / 2;
    if (i % 3 === 1) {
      const xm = (x0 + x1) / 2;
      const zm = (z0 + z1) / 2;
      const gy = S.H(xm, zm) - 2;
      const ym = yAt(sm);
      if (ym - gy > 3) {
        b.box({ x: xm, z: zm, rot, y: gy }, 0, 0, 0, 1.8, ym - 1.4 - gy, 7.5, concrete, { top: false });
        colBox(S, { x: xm, z: zm, rot }, 0, 0, 1.8, 7.5, gy, ym - 1.4);
      }
    }
    // lamps
    if (i % 5 === 2) {
      const xm = (x0 + x1) / 2 + px * 0.95;
      const zm = (z0 + z1) / 2 + pz * 0.95;
      const ym = yAt(sm);
      b.box({ x: xm, z: zm, rot, y: ym }, 0, 0, 0, 0.16, 7.5, 0.16, col('#4a4d50'));
      colCircle(S, xm, zm, 0.12, ym, ym + 7.5);
      S.glows.push({ x: xm, y: ym + 7.6, z: zm, color: '#ffb35c', intensity: 5, size: 1.5 });
    }
  }
}

// Coast Guard Base Kodiak: hangars, barracks, the long cutter pier into Womens Bay and a moored cutter.
export function buildCoastGuard(S, place) {
  const { rng } = S;
  const x0 = place.x;
  const z0 = place.z;
  const w = marchToWater(S, x0 - 40, z0 - 30, 1, 0, 300, 1.5) ?? { x: x0 + 20, z: z0 - 30 };
  const g = S.hm.shoreGradient(w.x, w.z);
  const rot = faceRot(g.x, g.z);
  // cutter pier
  const end = { x: w.x + g.x * 170, z: w.z + g.z * 170 };
  pier(S, { x: w.x - g.x * 4, z: w.z - g.z * 4 }, end, 16, 3.8, { deck: '#9a9892' });
  // cutter alongside (white hull, orange racing stripe), bow seaward
  const cf = { x: w.x + g.x * 118 - g.z * 16, z: w.z + g.z * 118 + g.x * 16, rot };
  cutter(S, cf);
  // hangars (air station) and base buildings
  const inland = (d, s) => ({ x: w.x - g.x * d + g.z * s, z: w.z - g.z * d - g.x * s });
  for (const [d, s] of [[70, -60], [70, -5]]) {
    const p = inland(d, s);
    const y = Math.max(0.5, S.H(p.x, p.z));
    const fr = { x: p.x, z: p.z, rot, y: 0 };
    S.b.box(fr, 0, y - 2.5, 0, 46, 2.8, 40, col(PALETTE.concrete), { top: false });
    colBox(S, fr, 0, 0, 46, 40, y - 2.5, y + 0.3);
    shed(S, { ...fr, y: y + 0.3 }, 0, 0, 44, 38, 13, { wall: '#e4e6e3', roof: '#8e979b', rise: 3.5, doors: 3, doorColor: '#6b7680' });
  }
  for (const [d, s, ww] of [[40, 50, 40], [70, 58, 36], [100, 40, 44], [110, -30, 30]]) {
    const p = inland(d, s);
    block(S, p.x, p.z, rot, { w: ww, d: 14, floors: 3, wall: rng.next() < 0.5 ? '#d9d2c0' : '#e3e1d9', store: false });
  }
  // helipad apron + helicopter-orange markers
  const ap = inland(28, -32);
  S.sites.push({ x: ap.x, z: ap.z, r: 34 });
  S.b.box({ x: ap.x, z: ap.z, rot, y: Math.max(0.2, S.H(ap.x, ap.z)) - 2 }, 0, 0, 0, 60, 2.3, 26, col('#77777a'));
  colBox(S, { x: ap.x, z: ap.z, rot }, 0, 0, 60, 26, Math.max(0.2, S.H(ap.x, ap.z)) - 2, Math.max(0.2, S.H(ap.x, ap.z)) + 0.3);
  for (let i = 0; i < 2; i++) {
    const hp = inland(28, -50 + i * 26);
    helicopter(S, { x: hp.x, z: hp.z, rot: rot + Math.PI / 2, y: Math.max(0.2, S.H(ap.x, ap.z)) + 0.3 });
  }
  for (let i = 0; i < 3; i++) {
    const p = inland(24, 70 + i * 9);
    tank(S, p.x, p.z, 3.4, 8);
  }
  // radio mast
  const rm = inland(140, 10);
  const rmy = S.H(rm.x, rm.z);
  S.sites.push({ x: rm.x, z: rm.z, r: 5 });
  S.b.cylinder({ x: rm.x, z: rm.z, rot: 0, y: rmy - 2.2 }, 0, 0, 0, 0.5, 0.15, 43.2, 4, col('#d0463a'));
  colCircle(S, rm.x, rm.z, 0.5, rmy - 2.2, rmy + 41);
  S.glows.push({ x: rm.x, y: rmy + 41.5, z: rm.z, color: '#ff2a1a', intensity: 6, size: 1.6, period: 2, flashes: 1 });
  return { pierEnd: end };
}

// Coast Guard medium-endurance cutter (~86 m), white with the orange racing stripe. Frame: bow toward +z.
function cutter(S, f) {
  const { b } = S;
  const L = 86;
  const B = 12;
  const white = col('#f2f2ef');
  const pts = [[-B / 2, -L / 2], [B / 2, -L / 2], [B / 2, L * 0.18], [B * 0.3, L * 0.4], [0, L / 2], [-B * 0.3, L * 0.4], [-B / 2, L * 0.18]];
  const P = (x, y, z) => Builder.xf(f, x, y, z, [0, 0, 0]);
  colBox(S, f, 0, 0, B, L, -3.6, 18.8);
  // hull
  for (let i = 0; i < pts.length; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[(i + 1) % pts.length];
    b.quad(P(bx, -3, bz), P(ax, -3, az), P(ax, 5, az), P(bx, 5, bz), white);
    b.quad(P(bx, -3.6, bz), P(ax, -3.6, az), P(ax, -3, az), P(bx, -3, bz), col('#1d2226'));
  }
  const c = P(0, 5, 0);
  for (let i = 0; i < pts.length; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[(i + 1) % pts.length];
    b.tri(P(bx, 5, bz), P(ax, 5, az), c, col('#9ea3a6'));
  }
  // racing stripe (orange wide + blue thin), slanted, both sides
  for (const s of [1, -1]) {
    const x = s * (B / 2 + 0.03);
    const quad = (z0, z1, dz, color) => {
      const q = [P(x, -1, z0), P(x, -1, z1), P(x, 4.6, z1 + dz), P(x, 4.6, z0 + dz)];
      if (s > 0) b.quad(q[1], q[0], q[3], q[2], color);
      else b.quad(q[0], q[1], q[2], q[3], color);
    };
    quad(L * 0.16, L * 0.22, -3, col('#e8541e'));
    quad(L * 0.225, L * 0.245, -3, col('#1c3d7a'));
  }
  // superstructure, bridge, mast, stack
  b.box(f, 0, 5, L * 0.02, B * 0.72, 7, L * 0.3, white, { win: WIN.none });
  b.box(f, 0, 12, L * 0.08, B * 0.66, 3.2, L * 0.1, white);
  b.box(f, 0, 13.7, L * 0.13 + 0.05, B * 0.6, 1.1, 0.1, col('#1b2328'), { top: false });
  b.box(f, 0, 12, -L * 0.1, 3, 6, 5, white);
  b.box(f, 0, 18, -L * 0.1, 3.4, 0.8, 5.4, col('#222'));
  b.box(f, 0, 15.2, L * 0.03, 0.5, 14, 0.5, white);
  b.box(f, 0, 25, L * 0.03, 5, 0.3, 0.3, white);
  // deck gun + flight deck marks
  b.cylinder(f, 0, 5, L * 0.32, 1.2, 1.0, 1.3, 8, col('#b8bcbe'));
  b.box(f, 0, 5.8, L * 0.36, 0.3, 0.3, 4, col('#8d9194'));
  b.box(f, 0, 5.02, -L * 0.33, 0.4, 0.02, 14, col('#f4f4f0'));
  const mt = P(0, 29.5, L * 0.03);
  S.glows?.push({ x: mt[0], y: mt[1], z: mt[2], color: '#fff4e0', intensity: 3, size: 0.8 });
}

// MH-60 Jayhawk-ish helicopter parked on the apron (white and orange).
function helicopter(S, f) {
  const { b } = S;
  const o = col('#e8541e');
  const w = col('#f2f2ef');
  // fuselage and tail boom (the rotor disc is overhead)
  colBox(S, f, 0, -3.8, 2.4, 16.4, f.y ?? 0, (f.y ?? 0) + 3.5);
  b.box(f, 0, 0.9, 0, 2.4, 2.4, 8, w);
  b.box(f, 0, 0.9, 3.8, 2.2, 1.9, 1.2, o);
  b.box(f, 0, 2.2, -7.5, 0.6, 1.0, 8, o);
  b.box(f, 0, 2.2, -11.3, 0.3, 3.2, 1.5, w);
  b.box(f, 0, 3.4, 0, 0.8, 0.5, 0.8, col('#555'));
  b.box(f, 0, 3.9, 0, 16, 0.08, 0.5, col('#2a2a2a'));
  b.box(f, 0, 3.9, 0, 0.5, 0.08, 16, col('#2a2a2a'));
}
