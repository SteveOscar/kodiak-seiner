// Landmarks: the Pacific Spaceport launch complex on Narrow Cape, Fort Abercrombie's gun emplacements, light towers,
// ADF&G closed-waters markers at stream mouths, and the channel buoy list.

import { Builder, WIN, col } from './kit.js';
import { block, skeletonTower, regMarker, tank } from './structures.js';
import { faceRot, findLots, marchToWater } from './sites.js';

// Launch Pad 1 with its rolling service structure and umbilical tower, a rocket on the stand, the integration and
// processing facility, lightning-protection masts and range lights.
export function buildSpaceport(S, place) {
  const { b } = S;
  const [pad] = findLots(S, place.x, place.z, { n: 1, R: 160, maxSd: -40, maxSlope: 12, spacing: 10, face: 'offshore', score: (x, z) => Math.abs(S.hm.shoreDistance(x, z) + 80) });
  const p = pad ?? { x: place.x, z: place.z, rot: 0 };
  const g = Math.max(S.H(p.x, p.z), 0.5);
  const f = { x: p.x, z: p.z, rot: p.rot, y: g };
  const concrete = col('#b3b1aa');
  S.sites.push({ x: p.x, z: p.z, r: 34 });
  // pad with a flame trench leading away from the stand
  b.box({ ...f, y: g - 2.5 }, 0, 0, 0, 44, 2.9, 40, concrete);
  b.box(f, 0, 0.4, 0, 10, 0.4, 10, col('#6f6e6a'));
  b.box(f, 0, 0.36, 12, 5, 0.1, 16, col('#3b3a38'), { top: true });
  // umbilical/launch tower: four columns painted in red and white bands, X-braced faces, work platforms, a
  // hammerhead crane and a lightning mast (46 m to the crane beam)
  const TH = 46;
  const tx = -9;
  const hw = 3;
  const steel = col('#d0d3d4');
  const white = col('#f4f4f2');
  const red = col('#c43a2c');
  const dark = col('#3d4144');
  const P = (x, y, z) => Builder.xf(f, x, y, z, [0, 0, 0]);
  const band = 5.75;
  for (const [cx, cz] of [[-hw, -hw], [hw, -hw], [hw, hw], [-hw, hw]]) {
    for (let k = 0; k * band < TH; k++) {
      const h0 = k * band;
      const h1 = Math.min(TH, h0 + band);
      b.box(f, tx + cx, 0.4 + h0, cz, 0.8, h1 - h0, 0.8, k % 2 ? white : red, { top: false });
    }
  }
  const faces = [
    [[-hw, -hw], [hw, -hw]],
    [[hw, -hw], [hw, hw]],
    [[hw, hw], [-hw, hw]],
    [[-hw, hw], [-hw, -hw]],
  ];
  for (let k = 0; k * band < TH - 1; k++) {
    const y0 = 0.4 + k * band;
    const y1 = y0 + band;
    for (const [[ax, az], [bx, bz]] of faces) {
      b.beam(P(tx + ax, y0, az), P(tx + bx, y1, bz), 0.2, steel);
      b.beam(P(tx + bx, y0, bz), P(tx + ax, y1, az), 0.2, steel);
    }
    b.box(f, tx, y1 - 0.25, 0, 2 * hw + 1.2, 0.35, 2 * hw + 1.2, k % 2 ? red : steel);
  }
  // hammerhead crane and lightning mast
  b.box(f, tx, TH + 0.4, 0, 2.2, 2.4, 2.2, dark);
  b.box(f, tx + 3, TH + 2.8, 0, 16, 1.1, 1.2, red);
  b.box(f, tx - 4.5, TH + 1.5, 0, 2.6, 1.3, 2.2, dark);
  b.beam(P(tx + 9, TH + 2.8, 0), P(tx + 9, TH - 6, 0), 0.08, dark);
  b.cylinder(f, tx, TH + 3.9, 0, 0.18, 0.06, 9, 5, steel);
  S.glows.push(...[P(tx, TH + 13, 0), P(tx + 10.8, TH + 3.6, 0)].map((q) => ({ x: q[0], y: q[1], z: q[2], color: '#ff2a1a', intensity: 7, size: 1.6, period: 3, flashes: 1, phase: 1.2 })));
  // swing arms to the rocket
  for (const y of [12, 19, 25]) b.box(f, tx + 5.5, y, 0, 5.8, 0.7, 1.4, red);
  // rocket on the stand
  b.cylinder(f, 0, 0.8, 0, 1.25, 1.25, 20, 12, white, { top: false });
  b.cylinder(f, 0, 20.8, 0, 1.3, 1.3, 4.5, 12, white, { top: false });
  b.lathe(f, 0, 25.3, 0, [[1.3, 0], [1.1, 2.2], [0.6, 4], [0, 5]], 12, white);
  b.cylinder(f, 0, 7, 0, 1.27, 1.27, 1.1, 12, col('#222'), { top: false });
  b.cylinder(f, 0, 16, 0, 1.27, 1.27, 0.5, 12, col('#222'), { top: false });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    b.box(f, Math.cos(a) * 1.4, 0.8, Math.sin(a) * 1.4, 0.18, 3, 1.1, col('#333'));
  }
  // rolling service structure parked back on its rails
  b.box({ ...f, y: g + 0.4 }, 0, 0, -30, 18, 32, 16, col('#e3e5e4'), { win: WIN.none });
  b.box({ ...f, y: g + 0.4 }, 0, 0, -21.9, 14, 26, 0.2, col('#9aa3a8'), { top: false });
  for (let i = -3; i <= 3; i++) b.box({ ...f, y: g + 0.4 }, i * 2.6, 0, -38.05, 0.35, 32, 0.12, col('#b9bdbf'), { top: false });
  b.box({ ...f, y: g + 29 }, 0, 0, -21.85, 18.2, 1.2, 0.12, col('#2c5aa0'), { top: false });
  for (const s of [-6, 6]) b.box({ ...f, y: g + 0.2 }, s, 0, -12, 0.6, 0.3, 36, col('#55595c'));
  S.sites.push({ x: P(0, 0, -30)[0], z: P(0, 0, -30)[2], r: 18 });
  // gravel road from the pad back to the processing facility
  for (let i = 0; i < 6; i++) {
    const q = P(-6, 0, -46 - i * 7);
    b.box({ x: q[0], z: q[2], rot: p.rot, y: S.H(q[0], q[2]) - 2.2 }, 0, 0, 0, 6, 2.3, 7.4, col('#9d978b'));
  }
  // lightning masts with red obstruction lights
  for (const [mx, mz] of [[20, 18], [-20, 18], [20, -40], [-20, -40]]) {
    const q = P(mx, 0, mz);
    const gy = S.H(q[0], q[2]);
    S.sites.push({ x: q[0], z: q[2], r: 5 });
    b.cylinder({ x: q[0], z: q[2], rot: 0, y: gy - 2.2 }, 0, 0, 0, 0.35, 0.12, 49.2, 6, steel);
    S.glows.push({ x: q[0], y: gy + 47.5, z: q[2], color: '#ff2a1a', intensity: 6, size: 1.6, period: 3, flashes: 1, phase: 0 });
  }
  // integration and processing facility + range control
  const ip = P(-12, 0, -78);
  block(S, ip[0], ip[2], p.rot, { w: 36, d: 24, floors: 5, wall: '#e8e8e4', trim: '#2c5aa0', store: false, win: WIN.none });
  const rc = P(42, 0, -70);
  block(S, rc[0], rc[2], p.rot, { w: 18, d: 12, floors: 2, wall: '#c9cdd0', store: false });
  tank(S, P(-34, 0, 20)[0], P(-34, 0, 20)[2], 3, 6, '#dfe2e2');
  tank(S, P(-34, 0, 30)[0], P(-34, 0, 30)[2], 3, 6, '#dfe2e2');
  // pad floodlights
  for (const [lx, lz] of [[22, 0], [-22, 0]]) {
    const q = P(lx, 0, lz);
    b.box({ x: q[0], z: q[2], rot: p.rot, y: g }, 0, 0, 0, 0.4, 16, 0.4, steel);
    S.glows.push({ x: q[0], y: g + 16.3, z: q[2], color: '#fff2da', intensity: 5, size: 2.2 });
  }
  return { pad: p };
}

// Fort Abercrombie on Miller Point: two 8-inch gun emplacements and the ready-ammunition bunker (the museum).
export function buildFort(S, place) {
  const { b } = S;
  // The batteries stand on the first rise behind the beach, where the guns command the sea; clearings keep the
  // spruce off them so they read from the water.
  const lots = findLots(S, place.x, place.z, { n: 3, R: 170, minH: 2.2, maxSd: -45, maxSlope: 26, spacing: 36, face: 'offshore', rotJitter: 10, score: (x, z) => Math.abs(S.hm.shoreDistance(x, z) + 68) * 1.2 - Math.min(S.hm.heightAt(x, z), 8) * 2 + Math.hypot(x - place.x, z - place.z) * 0.12 });
  const conc = col('#8f8e87');
  for (const l of lots) S.sites.push({ x: l.x, z: l.z, r: 20 });
  lots.slice(0, 2).forEach((l) => {
    const g = S.H(l.x, l.z);
    const f = { x: l.x, z: l.z, rot: l.rot, y: g - 2 };
    // circular pit: ring wall
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      const a2 = ((i + 1) / 14) * Math.PI * 2;
      const r = 7;
      const p0 = Builder.xf(f, Math.cos(a) * r, 0, Math.sin(a) * r, [0, 0, 0]);
      const p1 = Builder.xf(f, Math.cos(a2) * r, 0, Math.sin(a2) * r, [0, 0, 0]);
      b.box({ x: (p0[0] + p1[0]) / 2, z: (p0[2] + p1[2]) / 2, rot: faceRot(p1[0] - p0[0], p1[2] - p0[2]), y: g - 2 }, 0, 0, 0, 0.9, 3.1, 3.2, conc);
    }
    b.cylinder(f, 0, 0, 0, 6.5, 6.5, 2.2, 14, col('#6d6c66'));
    // gun: carriage + 8-inch barrel pointing seaward
    b.box(f, 0, 2.2, 0, 3.2, 1.6, 4.2, col('#4d5249'));
    b.box(f, 0, 2.6, 1.9, 3.8, 2.4, 0.3, col('#56604f'));
    const q0 = Builder.xf(f, 0, 4.4, 0.2, [0, 0, 0]);
    const q1 = Builder.xf(f, 0, 5.4, 10.5, [0, 0, 0]);
    b.beam(q0, q1, 0.6, col('#3f443d'));
    b.beam(Builder.xf(f, 0, 5.3, 9.6, [0, 0, 0]), q1, 0.72, col('#3a3e38'));
  });
  if (lots[2]) {
    const l = lots[2];
    const g = S.H(l.x, l.z);
    const f = { x: l.x, z: l.z, rot: l.rot, y: g - 2.2 };
    // earth-covered concrete bunker with a dark doorway
    b.box(f, 0, 0, 0, 16, 5.6, 11, conc);
    b.gable({ ...f, y: 0 }, 0, g + 3.4, 0, 18, 13, 2.2, col('#4e7a3c'), col('#4e7a3c'), { overhang: 0.6, soffit: false });
    b.box(f, 0, 2.2, 5.52, 2.6, 2.8, 0.06, col('#1c1c1a'), { top: false });
  }
}

// Light tower for a lighthouse place: skeleton tower on the headland with its flashing light.
export function buildLight(S, place) {
  const [l] = findLots(S, place.x, place.z, { n: 1, R: 60, maxSd: -5, minH: 0.8, maxSlope: 40, spacing: 5, face: 'offshore', score: (x, z) => Math.abs(S.hm.shoreDistance(x, z) + 10) + Math.hypot(x - place.x, z - place.z) * 0.2 });
  const p = l ?? { x: place.x, z: place.z, rot: 0 };
  const lantern = skeletonTower(S, p.x, p.z, p.rot, 14);
  const L = place.light ?? { color: '#ffffff', period: 6, flashes: 1 };
  S.glows.push({ x: lantern.x, y: lantern.y, z: lantern.z, color: L.color, intensity: 10, size: 4.5, period: L.period, flashes: L.flashes, phase: (place.x * 0.37) % L.period });
  // lighthouse keepers' shed at the foot of the tower
  S.b.box({ x: p.x, z: p.z, rot: p.rot, y: S.H(p.x, p.z) - 2 }, 0, 0, -4.5, 3.2, 4.6, 2.6, col('#e9e6dc'));
  return lantern;
}

// Two regulatory markers where the stream's closed-waters circle meets the shore on either side of the mouth.
export function buildMarkers(S, stream) {
  const g = S.hm.shoreGradient(stream.x, stream.z);
  const ang0 = Math.atan2(g.z, g.x);
  const out = [];
  for (const side of [1, -1]) {
    // walk around the circle from the offshore direction until we find land near the shoreline
    let found = null;
    for (let da = 0.2; da <= Math.PI; da += 0.05) {
      const a = ang0 + side * da;
      const x = stream.x + Math.cos(a) * stream.closedRadius;
      const z = stream.z + Math.sin(a) * stream.closedRadius;
      const sd = S.hm.shoreDistance(x, z);
      if (sd < -3 && S.hm.heightAt(x, z) > 0.3) {
        // step back toward the waterline
        const gg = S.hm.shoreGradient(x, z);
        const w = marchToWater(S, x, z, gg.x, gg.z, 40, 1);
        found = w ? { x: w.x - gg.x * 5, z: w.z - gg.z * 5, rot: faceRot(gg.x, gg.z) } : { x, z, rot: faceRot(gg.x, gg.z) };
        break;
      }
    }
    if (found) {
      regMarker(S, found.x, found.z, found.rot);
      out.push(found);
    }
  }
  return out;
}

// Channel buoys (world x, z; red nun 'R' even / green can 'G' odd); lit buoys flash at night.
export const BUOYS = [
  // Kodiak harbour channel approach (red to starboard returning: red on the east side)
  { x: 5215, z: -965, c: 'R', lit: true }, { x: 5120, z: -975, c: 'G', lit: true },
  { x: 5230, z: -1035, c: 'R' }, { x: 5135, z: -1045, c: 'G' },
  { x: 5260, z: -905, c: 'R', lit: true }, { x: 5145, z: -905, c: 'G' },
  // Chiniak Bay: Woody Island channel shoal and approach bell
  { x: 5470, z: -900, c: 'R', lit: true }, { x: 5330, z: -760, c: 'G', lit: true },
  { x: 5620, z: -1180, c: 'R' },
  // Womens Bay channel
  { x: 4905, z: -810, c: 'G', lit: true }, { x: 4950, z: -760, c: 'R', lit: true },
  // Spruce Cape reefs / north approach
  { x: 5520, z: -1680, c: 'G', lit: true }, { x: 5560, z: -1540, c: 'R' },
  // Port Lions / Kizhuyak
  { x: 3470, z: -2660, c: 'G' }, { x: 3520, z: -2560, c: 'R', lit: true },
  // Ouzinkie
  { x: 4360, z: -2820, c: 'R', lit: true },
  // Old Harbor approach
  { x: 100, z: 5900, c: 'G', lit: true }, { x: 180, z: 5980, c: 'R' },
  // Larsen Bay / Uyak
  { x: -2760, z: 760, c: 'G', lit: true },
  // Kitoi Bay entrance
  { x: 5790, z: -4950, c: 'R', lit: true },
];

