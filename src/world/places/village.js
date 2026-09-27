// Villages, remote canneries and hatcheries, laid out on the real terrain around each place's anchor.

import { Builder, WIN, col, shade } from './kit.js';
import { house, block, church, shed, pileDeck, tank, boat, float, PALETTE } from './structures.js';
import { findLots, marchToWater, faceRot } from './sites.js';
import { pier } from './harbor.js';

// Church styles per village (all Russian Orthodox; the domes differ).
export const CHURCHES = {
  ouzinkie: { scale: 0.95, dome: '#2f63b8', roof: '#3f5f7a', tower: 'tall', domes: 'one' }, // Nativity of Our Lord
  portLions: { scale: 0.85, dome: '#3e7fb8', roof: '#5a646b', tower: 'short', domes: 'one' },
  threeSaints: { scale: 0.95, dome: '#2f63b8', roof: '#40688a', tower: 'tall', domes: 'three' }, // Old Harbor
  larsen: { scale: 0.8, dome: '#3a78c0', roof: '#56636b', tower: 'short', domes: 'one' },
  akhiok: { scale: 0.8, dome: '#2f63b8', roof: '#3f5f7a', tower: 'short', domes: 'one' }, // Protection of the Theotokos
  karluk: { scale: 0.9, dome: '#3d7d62', roof: '#3d6a57', tower: 'tall', domes: 'one' }, // Ascension of Our Lord
};

// Nearest shore point from (x, z) toward the water (via the shore gradient), else null.
function shoreFrom(S, x, z) {
  const g = S.hm.shoreGradient(x, z);
  return marchToWater(S, x, z, g.x, g.z, 400, 2);
}

// Pier + float from the shore toward a dock point (world). Returns the shore anchor.
function dockWorks(S, dock, o = {}) {
  const { rng } = S;
  // shore point: walk back from the dock toward land
  const g = S.hm.shoreGradient(dock.x, dock.z);
  let a = null;
  for (let t = 0; t < 400; t += 2) {
    const px = dock.x - g.x * t;
    const pz = dock.z - g.z * t;
    if (S.hm.heightAt(px, pz) > 0.6) {
      a = { x: px, z: pz };
      break;
    }
  }
  if (!a) return null;
  const endX = dock.x - g.x * 8;
  const endZ = dock.z - g.z * 8;
  const { rot } = pier(S, a, { x: endX, z: endZ }, o.width ?? 5, 3.4);
  // float alongside the pier head with a couple of boats
  const f = { x: endX + g.x * 4, z: endZ + g.z * 4, rot: rot + Math.PI / 2 };
  float(S, f, 0, 0, o.floatLen ?? 26, 2.4);
  const nb = o.boats ?? 3;
  for (let i = 0; i < nb; i++) {
    const side = i % 2 ? 1 : -1;
    const p = Builder.xf(f, (rng.next() - 0.5) * 16, 0, side * 4.2, [0, 0, 0]);
    boat(S, { x: p[0], z: p[2], rot: f.rot + Math.PI / 2 + (rng.next() - 0.5) * 0.1 }, { L: 7 + rng.next() * 9, mast: rng.next() < 0.7 });
  }
  return { shore: a, rot, head: { x: endX, z: endZ } };
}

export function buildVillage(S, place, o = {}) {
  const { rng } = S;
  const cx = place.x;
  const cz = place.z;
  const avoid = [];
  let works = null;
  if (place.dock) {
    works = dockWorks(S, place.dock, { boats: o.boats ?? 3 });
    if (works) avoid.push({ ...works.shore, r: 16 });
  }
  // church: a little above the shore, near the centre
  const style = CHURCHES[place.church] ?? CHURCHES.ouzinkie;
  const [cl] = findLots(S, cx, cz, {
    n: 1, R: o.R ?? 110, maxSd: -30, maxSlope: 22, minH: 2, spacing: 30, face: 'offshore', rotJitter: 6,
    score: (x, z) => Math.abs(S.hm.shoreDistance(x, z) + 55) + Math.hypot(x - cx, z - cz) * 0.4 - Math.min(S.hm.heightAt(x, z), 14) * 2,
  });
  if (cl) {
    church(S, cl.x, cl.z, cl.rot, style);
    avoid.push({ x: cl.x, z: cl.z, r: 22 });
  }
  // houses facing the water
  const lots = findLots(S, cx, cz, {
    n: o.houses ?? 24, R: o.R ?? 110, maxSd: -12, maxSlope: 27, spacing: o.spacing ?? 13.5, face: 'offshore', avoid,
    score: (x, z) => Math.hypot(x - cx, z - cz) * 0.6 + Math.abs(S.hm.shoreDistance(x, z) + 40) * 0.5,
  });
  lots.forEach((l, i) => {
    if (i === 2 && o.school !== false) block(S, l.x, l.z, l.rot, { w: 20, d: 11, floors: 1, wall: '#c9bfa6', store: false });
    else if (i === 5 && o.store !== false) block(S, l.x, l.z, l.rot, { w: 12, d: 9, floors: 1, wall: '#a44a3a' });
    else house(S, l.x, l.z, l.rot, { floors: rng.next() < 0.25 ? 2 : 1 });
  });
  // fuel tanks by the pier
  if (works && (place.services ?? []).includes('fuel')) {
    const g = S.hm.shoreGradient(works.shore.x, works.shore.z);
    for (let i = 0; i < 3; i++) {
      const tx = works.shore.x - g.x * (14 + (i % 2) * 7) + g.z * (i * 7 - 7);
      const tz = works.shore.z - g.z * (14 + (i % 2) * 7) - g.x * (i * 7 - 7);
      tank(S, tx, tz, 2.6, 5.5);
    }
  }
  return { lots: lots.length };
}

// Cannery on pilings at the shore facing the dock, with bunkhouses and tanks behind.
export function buildCannery(S, place, o = {}) {
  const { rng } = S;
  const dock = place.dock ?? { x: place.x, z: place.z };
  const g = S.hm.shoreGradient(dock.x, dock.z);
  // shore anchor
  let a = null;
  for (let t = 0; t < 500; t += 2) {
    const px = dock.x - g.x * t;
    const pz = dock.z - g.z * t;
    if (S.hm.heightAt(px, pz) > 0.5) {
      a = { x: px, z: pz, t };
      break;
    }
  }
  if (!a) a = { x: place.x, z: place.z, t: 0 };
  const rot = faceRot(g.x, g.z); // front faces the water
  const deckY = 3.6;
  const W = o.width ?? 56;
  const D = o.depth ?? 34;
  // main deck straddling the shoreline: two thirds over the water
  const f = { x: a.x + g.x * (D * 0.3), z: a.z + g.z * (D * 0.3), rot, y: deckY };
  pileDeck(S, f, 0, 0, W, D, deckY);
  const walls = [PALETTE.metalWhite, PALETTE.metalBlue, PALETTE.metalBeige, '#e6e2d8'];
  const roofs = [PALETTE.galvanized, '#6b7478', '#8b3a2e', '#5d6c73'];
  shed(S, f, -W * 0.18, -D * 0.12, W * 0.6, D * 0.62, 9, { wall: walls[0], roof: roofs[rng.next() < 0.5 ? 0 : 2] });
  shed(S, f, W * 0.3, -D * 0.2, W * 0.36, D * 0.5, 7, { wall: walls[1 + Math.floor(rng.next() * 3)], roof: roofs[1] });
  shed(S, f, W * 0.28, D * 0.28, W * 0.3, D * 0.28, 5, { wall: walls[3], roof: roofs[3], doors: 1 });
  // stack with steam
  const sp = Builder.xf(f, -W * 0.35, deckY + 9, -D * 0.2, [0, 0, 0]);
  S.b.cylinder({ x: sp[0], z: sp[2], rot: 0, y: deckY + 9 }, 0, 0, 0, 0.7, 0.6, 7, 10, col('#8a3d30'));
  S.smoke?.push({ x: sp[0], y: deckY + 16.5, z: sp[2], kind: 'steam', phase: rng.next(), strength: 1 });
  // wharf lights
  for (const lx of [-W * 0.4, 0, W * 0.4]) {
    const p = Builder.xf(f, lx, deckY + 6.5, D / 2 - 1, [0, 0, 0]);
    S.b.box({ x: p[0], z: p[2], rot, y: deckY }, 0, 0, 0, 0.18, 6.5, 0.18, col('#44484a'));
    S.glows?.push({ x: p[0], y: p[1], z: p[2], color: '#ffd7a0', intensity: 4, size: 1.3 });
  }
  // pier out to the dock when the plant stops short of deep water
  const faceDist = a.t - D * 0.8;
  if (faceDist > 12) {
    const s0 = { x: a.x + g.x * D * 0.78, z: a.z + g.z * D * 0.78 };
    pier(S, s0, { x: dock.x - g.x * 6, z: dock.z - g.z * 6 }, 7, 3.6, { lamp: true });
  }
  // a tender or seiner at the wharf
  const bp = { x: dock.x + g.z * 6, z: dock.z - g.x * 6 };
  boat(S, { x: bp.x, z: bp.z, rot: rot + Math.PI / 2 }, { L: 22 + rng.next() * 8, B: 7, houseAft: false, seine: false, mastH: 10 });
  // bunkhouses and superintendent's house behind
  const lots = findLots(S, a.x - g.x * 40, a.z - g.z * 40, { n: o.bunkhouses ?? 8, R: 60, maxSd: -8, maxSlope: 26, spacing: 13, face: { x: dock.x, z: dock.z }, rotJitter: 8 });
  for (const l of lots) house(S, l.x, l.z, l.rot, { wall: rng.next() < 0.7 ? '#efece4' : '#c9d1d4', roof: rng.next() < 0.5 ? '#8a3a2e' : '#3f5a48', floors: rng.next() < 0.3 ? 2 : 1, w: 10 + rng.next() * 4, d: 6.5 });
  for (let i = 0; i < 3; i++) tank(S, a.x - g.x * 18 + g.z * (W * 0.55 + i * 7), a.z - g.z * 18 - g.x * (W * 0.55 + i * 7), 3, 6.5);
  return { anchor: a, rot };
}

// Hatchery: incubation building, raceways, and net pens in the bay.
export function buildHatchery(S, place, o = {}) {
  const { rng } = S;
  const [site] = findLots(S, place.x, place.z, { n: 1, R: 90, maxSd: -15, maxSlope: 18, spacing: 10, face: 'offshore', score: (x, z) => Math.hypot(x - place.x, z - place.z) });
  const s = site ?? { x: place.x, z: place.z, rot: 0 };
  block(S, s.x, s.z, s.rot, { w: 26, d: 14, floors: 1, wall: '#d8dcd6', store: false, win: WIN.office });
  const f = { x: s.x, z: s.z, rot: s.rot };
  const g = S.hm.shoreGradient(s.x, s.z);
  // raceways beside the building
  const rw = Builder.xf(f, 25, 0, 0, [0, 0, 0]);
  S.sites.push({ x: rw[0], z: rw[2], r: 16 });
  for (let i = 0; i < 5; i++) {
    const p = Builder.xf(f, 18 + i * 3.4, 0, 0, [0, 0, 0]);
    const h = S.H(p[0], p[2]);
    S.b.box({ x: p[0], z: p[2], rot: s.rot, y: h - 2.2 }, 0, 0, 0, 2.6, 3.0, 22, col('#9a9a94'));
    S.b.box({ x: p[0], z: p[2], rot: s.rot, y: h + 0.75 }, 0, 0, 0, 2.0, 0.1, 21, col('#2c5563'));
  }
  if (o.pens) {
    const w = marchToWater(S, s.x, s.z, g.x, g.z, 400, 2);
    if (w) {
      for (let i = 0; i < 4; i++) {
        const px = w.x + g.x * (30 + (i >> 1) * 16) + g.z * ((i & 1) * 16 - 8);
        const pz = w.z + g.z * (30 + (i >> 1) * 16) - g.x * ((i & 1) * 16 - 8);
        const pf = { x: px, z: pz, rot: s.rot };
        for (const [lx, lz, len, r] of [[0, -6, 13, 0], [0, 6, 13, 0], [-6, 0, 13, 1], [6, 0, 13, 1]]) {
          float(S, { ...pf, rot: s.rot + (r ? Math.PI / 2 : 0) }, r ? lz : lx, r ? -lx : lz, len, 1.0);
        }
      }
    }
  }
  house(S, s.x - g.z * 30, s.z + g.x * 30, s.rot, { wall: '#e8e2d2' });
  house(S, s.x - g.z * 44, s.z + g.x * 44, s.rot, { wall: '#8fa8b6' });
  void rng;
}
