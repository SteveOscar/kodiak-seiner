// Building blocks for settlements, written into a Builder. S = { b: Builder, H(x, z) ground height, rng, depth(x, z)
// seabed height, smoke: [], glows: [] }. Everything that stands on land gets a foundation skirt reaching >= 2 m
// below its lowest corner (terrain LOD error, SPEC §3). rot follows kit.js (front = local +z).

import { Builder, WIN, col, shade } from './kit.js';

export const PALETTE = {
  houseWalls: ['#c9d1d4', '#e8e2d2', '#8fa8b6', '#5b7b95', '#a4443b', '#d3ae4e', '#6d8a58', '#f0eee6', '#b7c4a6', '#7a5d4b', '#3e5b6d', '#c47e4f', '#9b6f8e', '#e3c9a0'],
  roofs: ['#474f54', '#6a2e2a', '#2e4a3a', '#33475c', '#7d8589', '#874a30', '#2a2e32', '#5b6a73'],
  trim: '#f1f0ea',
  concrete: '#8d8c87',
  darkConcrete: '#6d6c68',
  piling: '#3a3029',
  deck: '#6f665b',
  float: '#b9b7ad',
  door: '#2a2724',
  metalWhite: '#dfe3e3',
  metalBlue: '#9eb4c2',
  metalBeige: '#cbc5b6',
  metalRust: '#8a3d30',
  galvanized: '#7c8387',
  hulls: ['#f3f3ee', '#1f3b5a', '#8b2a22', '#2f5d3a', '#2a2a2a', '#3f7ea6', '#dcd6c8', '#b45a2a'],
  churchWhite: '#f4f2eb',
  domeBlue: '#2f63b8',
  domeGreen: '#3d7d62',
  gold: '#e3c46a',
};

const pick = (rng, arr) => arr[Math.floor(rng.next() * arr.length) % arr.length];

// Heights at a rotated rectangle's corners and centre: { min, max }.
export function footprintHeights(H, x, z, rot, w, d) {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  let min = Infinity;
  let max = -Infinity;
  for (const [lx, lz] of [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2], [0, 0]]) {
    const h = H(x + lx * c + lz * s, z - lx * s + lz * c);
    if (h < min) min = h;
    if (h > max) max = h;
  }
  return { min, max };
}

// Concrete foundation from below the lowest corner up to floor level; returns floor y.
function foundation(S, f, w, d, extraTop = 0.35) {
  const { min, max } = footprintHeights(S.H, f.x, f.z, f.rot, w, d);
  const floor = Math.max(max, 0.4) + extraTop;
  const bottom = Math.min(min, 0) - 2.3;
  S.b.box({ ...f, y: 0 }, 0, bottom, 0, w + 0.3, floor - bottom, d + 0.3, col(PALETTE.concrete), { top: false });
  return floor;
}

// Detached house (1-2 storeys, gable roof). Returns { floor, top }.
export function house(S, x, z, rot, o = {}) {
  const { b, rng } = S;
  const w = o.w ?? 7.5 + rng.next() * 3.5;
  const d = o.d ?? 6.5 + rng.next() * 2.5;
  const floors = o.floors ?? (rng.next() < 0.45 ? 2 : 1);
  const f = { x, z, rot, y: 0 };
  b.seed = rng.next() * 100;
  const floor = foundation(S, f, w, d);
  S.sites?.push({ x, z, r: Math.hypot(w, d) / 2 + 3 });
  const wallH = floors * 2.75 + 0.2;
  const wall = shade(o.wall ?? pick(rng, PALETTE.houseWalls), 0.92 + rng.next() * 0.14);
  const roof = shade(o.roof ?? pick(rng, PALETTE.roofs), 0.9 + rng.next() * 0.2);
  b.box({ ...f, y: floor }, 0, 0, 0, w, wallH, d, wall, { win: WIN.house, top: false });
  const rise = (d / 2) * (0.45 + rng.next() * 0.35);
  b.gable({ ...f, y: 0 }, 0, floor + wallH, 0, w, d, rise, roof, wall, { win: WIN.house, v0: wallH });
  // door + stoop on the front
  const door = col(PALETTE.door);
  b.box({ ...f, y: floor }, w * 0.18, 0, d / 2 + 0.02, 1.0, 2.05, 0.06, door, { top: false });
  b.box({ ...f, y: 0 }, w * 0.18, floor - 0.9, d / 2 + 0.8, 1.8, 0.9, 1.5, col(PALETTE.deck));
  // trim band under the eaves
  b.box({ ...f, y: floor + wallH - 0.25 }, 0, 0, 0, w + 0.08, 0.25, d + 0.08, col(PALETTE.trim), { top: false });
  let chimney = null;
  if (o.chimney ?? rng.next() < 0.55) {
    const cx = (rng.next() - 0.5) * w * 0.5;
    const cz = -d * 0.12;
    const ch = rise + 1.3;
    b.box(f, cx, floor + wallH, cz, 0.6, ch, 0.6, col(rng.next() < 0.5 ? '#6a6660' : '#8a4a3a'));
    const p = Builder.xf(f, cx, floor + wallH + ch + 0.3, cz, [0, 0, 0]);
    chimney = { x: p[0], y: p[1], z: p[2] };
    S.smoke?.push({ ...chimney, kind: 'smoke', phase: rng.next(), strength: 0.6 + rng.next() * 0.5 });
  }
  if (o.porchLight !== false && rng.next() < 0.5) {
    const p = Builder.xf(f, w * 0.18 + 0.9, floor + 2.3, d / 2 + 0.25, [0, 0, 0]);
    S.glows?.push({ x: p[0], y: p[1], z: p[2], color: '#ffc47a', intensity: 2.2, size: 0.45 });
  }
  return { floor, top: floor + wallH + rise, chimney };
}

// Flat-roofed commercial / civic block with parapet and office windows.
export function block(S, x, z, rot, o = {}) {
  const { b, rng } = S;
  const w = o.w ?? 14 + rng.next() * 8;
  const d = o.d ?? 11 + rng.next() * 5;
  const floors = o.floors ?? 2 + Math.floor(rng.next() * 2);
  const f = { x, z, rot };
  b.seed = rng.next() * 100;
  const floor = foundation(S, f, w, d, 0.2);
  S.sites?.push({ x, z, r: Math.hypot(w, d) / 2 + 3 });
  const h = floors * 3.3;
  const wall = shade(o.wall ?? pick(rng, ['#d9d4c7', '#c2c7c9', '#a9b4b9', '#e6e1d6', '#9c6b54', '#7f8f96', '#c9b79c']), 0.95 + rng.next() * 0.1);
  b.box({ ...f, y: floor }, 0, 0, 0, w, h, d, wall, { win: o.win ?? WIN.office, topColor: col('#5d6266') });
  b.box({ ...f, y: floor + h }, 0, 0, 0, w + 0.3, 0.7, d + 0.3, shade(o.trim ?? '#e9e7e0', 1), { top: false });
  // storefront band
  if (o.store !== false) b.box({ ...f, y: floor + 3.0 }, 0, 0, 0, w + 0.5, 0.45, d + 0.5, col(pick(rng, ['#2f4a5c', '#7a2f2a', '#39523d', '#40403f'])));
  // rooftop unit
  b.box({ ...f, y: floor + h }, w * 0.2, 0, -d * 0.15, 2.2, 1.4, 1.8, col('#9aa0a3'));
  return { floor, top: floor + h };
}

// Long metal industrial shed (cannery, hangar, warehouse) standing at y0 (deck or ground).
export function shed(S, f, lx, lz, w, d, h, o = {}) {
  const { b, rng } = S;
  b.seed = rng.next() * 100;
  const wall = shade(o.wall ?? PALETTE.metalWhite, 0.94 + rng.next() * 0.1);
  const roof = shade(o.roof ?? PALETTE.galvanized, 0.9 + rng.next() * 0.15);
  const y0 = f.y ?? 0;
  const c = Builder.xf(f, lx, 0, lz, [0, 0, 0]);
  S.sites?.push({ x: c[0], z: c[2], r: Math.hypot(w, d) / 2 + 3 });
  b.box({ ...f, y: y0 }, lx, 0, lz, w, h, d, wall, { win: o.win ?? WIN.shed, top: false });
  b.gable({ ...f, y: 0 }, lx, y0 + h, lz, w, d, o.rise ?? d * 0.12, roof, wall, { win: WIN.none, overhang: 0.5 });
  // roll-up doors on the front
  const doors = o.doors ?? Math.max(1, Math.floor(w / 14));
  for (let i = 0; i < doors; i++) {
    const dx = lx - w / 2 + ((i + 0.5) * w) / doors;
    b.box({ ...f, y: y0 }, dx, 0, lz + d / 2 + 0.03, 3.8, 4.2, 0.08, col(o.doorColor ?? '#55606a'), { top: false });
  }
}

// Pile-supported deck (wharf / cannery floor) over water or beach. Frame f at deck-top height fy.
export function pileDeck(S, f, lx, lz, w, d, fy, o = {}) {
  const { b } = S;
  const deckC = shade(o.deck ?? PALETTE.deck, 1);
  b.box({ ...f, y: fy - 0.6 }, lx, 0, lz, w, 0.6, d, deckC);
  const sp = o.spacing ?? 4.5;
  const pc = col(PALETTE.piling);
  const nx = Math.max(2, Math.round(w / sp) + 1);
  const nz = Math.max(2, Math.round(d / sp) + 1);
  const c = Math.cos(f.rot);
  const s = Math.sin(f.rot);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      if (o.edgeOnly && i > 0 && j > 0 && i < nx - 1 && j < nz - 1 && (i + j) % 2) continue;
      const px = lx - w / 2 + (i * w) / (nx - 1);
      const pz = lz - d / 2 + (j * d) / (nz - 1);
      const wx = f.x + px * c + pz * s;
      const wz = f.z - px * s + pz * c;
      const g = S.H(wx, wz) - 2.2;
      if (g > fy - 0.8) continue;
      b.box({ x: wx, z: wz, rot: f.rot, y: g }, 0, 0, 0, 0.42, fy - 0.6 - g, 0.42, pc, { top: false });
    }
  }
  // fender line / cap on the water face
  b.box({ ...f, y: fy - 1.1 }, lx, 0, lz + d / 2 + 0.2, w, 1.1, 0.35, col('#2b2622'));
}

// Floating dock segment (main float), at water level. Frame f; runs along local x.
export function float(S, f, lx, lz, len, width = 2.4) {
  S.b.box({ ...f, y: -0.25 }, lx, 0, lz, len, 0.75, width, col(PALETTE.float), { side: col('#8e8c85') });
}

// Steel guide pile standing out of the water at (x, z).
export function guidePile(S, x, z) {
  const g = S.H(x, z) - 2.2;
  S.b.cylinder({ x, z, rot: 0, y: g }, 0, 0, 0, 0.28, 0.28, 3.8 - g, 6, col('#3c3e40'));
}

// Moored boat (seiner / gillnetter / skiff-sized), afloat at y 0; hull length L along local z (bow = +z).
export function boat(S, f, o = {}) {
  const { b, rng } = S;
  const L = o.L ?? 10 + rng.next() * 8;
  const B = o.B ?? L * 0.32;
  const hull = shade(o.hull ?? pick(rng, PALETTE.hulls), 0.95 + rng.next() * 0.1);
  const free = o.freeboard ?? 1.3 + L * 0.03;
  // hull: stern corners, shoulders, bow point; the sheer rises toward the bow
  const pts = [
    [-B / 2, -L / 2],
    [B / 2, -L / 2],
    [B / 2, L * 0.12],
    [B * 0.32, L * 0.36],
    [0, L / 2],
    [-B * 0.32, L * 0.36],
    [-B / 2, L * 0.12],
  ];
  const rise = o.bowRise ?? 0.6 + L * 0.045;
  const top = (z) => free + Math.max(0, (z + L * 0.1) / (L * 0.6)) ** 1.6 * rise;
  hull3(b, f, pts, -1.1, top, hull, col('#3a2a24'));
  hull3(b, f, pts.map(([px, pz]) => [px * 1.012, pz * 1.006]), -1.12, (z) => -0.2, col('#6b2a22'), false);
  const stripe = col(pick(rng, ['#b52a22', '#1e4b7a', '#2f6b3a', '#e0b030', '#f2f2ee']));
  hull3(b, f, pts.map(([px, pz]) => [px * 1.01, pz * 1.005]), null, (z) => top(z) - 0.12, stripe, false, 0.3);
  const white = col(o.house ?? '#f2f1ec');
  const hl = L * 0.26;
  const hz = o.houseAft ? -L * 0.18 : L * 0.08;
  const hy = top(hz);
  b.box(f, 0, hy - 0.3, hz, B * 0.62, 2.5, hl, white, { win: WIN.none });
  b.box(f, 0, hy + 1.35, hz, B * 0.62 + 0.06, 0.62, hl + 0.06, col('#1b252b'), { top: false });
  b.box(f, 0, hy + 2.2, hz - hl * 0.1, B * 0.5, 0.18, hl * 0.7, white);
  b.box(f, 0, hy + 2.38, hz - hl * 0.2, 0.9, 0.35, 0.9, col('#e8e8e2'));
  if (o.mast !== false) {
    const mh = o.mastH ?? 6 + L * 0.35;
    const mz = hz - hl * 0.55;
    b.box(f, 0, free, mz, 0.24, mh, 0.24, col('#d8d8d4'));
    // boom sloping aft
    const a = Builder.xf(f, 0, free + mh * 0.55, mz, [0, 0, 0]);
    const e = Builder.xf(f, 0, free + 1.4, -L / 2 + 0.5, [0, 0, 0]);
    b.beam(a, e, 0.16, col('#cfcfca'));
    // cross-trees + antennas
    b.box(f, 0, free + mh * 0.85, mz, B * 0.6, 0.12, 0.12, col('#d8d8d4'));
    if (S.glows && rng.next() < 0.6) {
      const t = Builder.xf(f, 0, free + mh + 0.2, mz, [0, 0, 0]);
      S.glows.push({ x: t[0], y: t[1], z: t[2], color: '#fff4e0', intensity: 2.5, size: 0.35 });
    }
  }
  if (o.seine) {
    b.box(f, 0, free, -L * 0.36, B * 0.7, 1.1, L * 0.18, col('#20352c'));
    b.box(f, 0, free + 1.1, -L * 0.36, B * 0.72, 0.18, L * 0.19, col('#e8c43a'));
  }
}

// Extruded polygon (xz points in local frame, star-shaped from the centroid) from y0 to y1.
export function prism(b, f, pts, y0, y1, color, bottomColor = null, top = true) {
  const n = pts.length;
  const P = (x, y, z) => Builder.xf(f, x, y, z, [0, 0, 0]);
  let cx = 0;
  let cz = 0;
  for (const [x, z] of pts) {
    cx += x / n;
    cz += z / n;
  }
  for (let i = 0; i < n; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[(i + 1) % n];
    b.quad(P(bx, y0, bz), P(ax, y0, az), P(ax, y1, az), P(bx, y1, bz), color);
  }
  if (top) {
    const c = P(cx, y1, cz);
    for (let i = 0; i < n; i++) {
      const [ax, az] = pts[i];
      const [bx, bz] = pts[(i + 1) % n];
      b.tri(P(bx, y1, bz), P(ax, y1, az), c, color);
    }
  }
}

// Hull band: sides from y0 (or top(z) - band) up to top(z) around a star-shaped outline; optional deck fan.
function hull3(b, f, pts, y0, top, color, deck = true, band = 0) {
  const n = pts.length;
  const P = (x, y, z) => Builder.xf(f, x, y, z, [0, 0, 0]);
  let cx = 0;
  let cz = 0;
  for (const [x, z] of pts) {
    cx += x / n;
    cz += z / n;
  }
  for (let i = 0; i < n; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[(i + 1) % n];
    const ya = top(az);
    const yb = top(bz);
    const a0 = y0 ?? ya - band;
    const b0 = y0 ?? yb - band;
    b.quad(P(bx, b0, bz), P(ax, a0, az), P(ax, ya, az), P(bx, yb, bz), color);
  }
  if (deck) {
    const c = P(cx, top(cz) - 0.05, cz);
    const dc = col('#8f8a80');
    for (let i = 0; i < n; i++) {
      const [ax, az] = pts[i];
      const [bx, bz] = pts[(i + 1) % n];
      b.tri(P(bx, top(bz) - 0.05, bz), P(ax, top(az) - 0.05, az), c, dc);
    }
  }
}

// Russian Orthodox church: nave along local z (entrance/bell tower at +z, apse at -z).
// o: { scale, wall, roof, dome, cross, tower: 'tall'|'short'|'none', domes: 'one'|'three'|'cathedral' }
export function church(S, x, z, rot, o = {}) {
  const { b, rng } = S;
  const k = o.scale ?? 1;
  const f = { x, z, rot };
  b.seed = rng.next() * 100;
  const W = 7 * k;
  const D = 12 * k;
  const floor = foundation(S, f, W + 1, D + 7 * k);
  S.sites?.push({ x, z, r: (D + 7 * k) / 2 + 6 });
  const wall = col(o.wall ?? PALETTE.churchWhite);
  const roof = col(o.roof ?? '#56636b');
  const dome = col(o.dome ?? PALETTE.domeBlue);
  const gold = col(o.cross ?? PALETTE.gold);
  const wallH = 5.2 * k;
  // nave
  b.box({ ...f, y: floor }, 0, 0, 0, W, wallH, D, wall, { win: WIN.church, top: false });
  b.gable({ ...f, rot: rot + Math.PI / 2, y: 0 }, 0, floor + wallH, 0, D, W, W * 0.42, roof, wall, { overhang: 0.35 });
  // apse
  b.box({ ...f, y: floor }, 0, 0, -D / 2 - 1.6 * k, W * 0.6, wallH * 0.8, 3.2 * k, wall, { win: WIN.church, topColor: roof });
  // central drum + dome
  const ridge = floor + wallH + W * 0.42;
  const drumR = (o.domes === 'cathedral' ? 2.4 : 1.5) * k;
  b.cylinder(f, 0, ridge - 0.6 * k, -D * 0.12, drumR, drumR, 2.6 * k, 8, wall, { win: WIN.church, topColor: roof });
  b.onion(f, 0, ridge + 2.0 * k, -D * 0.12, drumR * 1.25, drumR * 2.6, dome, gold);
  if (o.domes === 'three' || o.domes === 'cathedral') {
    for (const sx of [-1, 1]) {
      b.cylinder(f, sx * W * 0.34, ridge - 1.4 * k, D * 0.28, 0.7 * k, 0.7 * k, 1.8 * k, 8, wall, { topColor: roof });
      b.onion(f, sx * W * 0.34, ridge + 0.4 * k, D * 0.28, 0.95 * k, 2.0 * k, dome, gold);
    }
  }
  // bell tower over the entrance
  if (o.tower !== 'none') {
    const tw = 3.4 * k;
    const tz = D / 2 + tw / 2 - 0.2;
    const th = (o.tower === 'short' ? 8.5 : 11.5) * k;
    b.box({ ...f, y: floor }, 0, 0, tz, tw, th, tw, wall, { win: WIN.church, top: false });
    // open belfry: four posts and a cap
    const bh = 2.6 * k;
    for (const [px, pz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) b.box(f, (px * tw) / 2.4, floor + th, tz + (pz * tw) / 2.4, 0.4 * k, bh, 0.4 * k, wall);
    b.box(f, 0, floor + th + bh, tz, tw + 0.4, 0.5 * k, tw + 0.4, roof);
    b.cylinder(f, 0, floor + th + bh + 0.5 * k, tz, tw * 0.42, tw * 0.3, 1.4 * k, 8, roof);
    b.onion(f, 0, floor + th + bh + 1.8 * k, tz, tw * 0.33, tw * 0.9, dome, gold);
    // bell (dark)
    b.box(f, 0, floor + th + 0.6 * k, tz, 0.9 * k, 1.1 * k, 0.9 * k, col('#3a3326'));
    // door
    b.box({ ...f, y: floor }, 0, 0, tz + tw / 2 + 0.03, 1.4 * k, 2.6 * k, 0.08, col('#5a3b28'), { top: false });
  }
  return { floor, top: ridge + drumR * 2.6 + 2 };
}

// Vertical storage tank.
export function tank(S, x, z, r, h, color = '#e9ebe8') {
  const g = S.H(x, z);
  S.sites?.push({ x, z, r: r + 3 });
  S.b.cylinder({ x, z, rot: 0, y: Math.min(g, 0.5) - 2.2 }, 0, 0, 0, r, r, h + Math.max(0, g) + 2.2, 12, col(color), { topColor: col('#b9bdbd') });
}

// Skeleton light tower (4 legs + braces + daymark); returns the lantern position.
export function skeletonTower(S, x, z, rot, h = 10, daymark = ['#c8322a', '#f2f2ee']) {
  const { b } = S;
  const g = S.H(x, z);
  const f = { x, z, rot, y: g - 2.2 };
  S.sites?.push({ x, z, r: 9 });
  const base = 2.2;
  const topw = 0.7;
  const H = h + 2.2;
  const legs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const steel = col('#7c8084');
  const P = (lx, ly, lz) => Builder.xf(f, lx, ly, lz, [0, 0, 0]);
  for (const [sx, sz] of legs) b.beam(P(sx * base, 0, sz * base), P(sx * topw, H, sz * topw), 0.24, steel);
  for (let lvl = 0; lvl < 4; lvl++) {
    const t0 = lvl / 4;
    const t1 = (lvl + 1) / 4;
    const w0 = base + (topw - base) * t0;
    const w1 = base + (topw - base) * t1;
    for (let i = 0; i < 4; i++) {
      const [ax, az] = legs[i];
      const [bx, bz] = legs[(i + 1) % 4];
      b.beam(P(ax * w0, H * t0, az * w0), P(bx * w1, H * t1, bz * w1), 0.12, steel);
    }
  }
  // daymark diamond (two coloured halves) facing local +z
  const dy = H * 0.72;
  const dz = topw + 0.6;
  const d = 1.8;
  b.tri(P(-d, dy, dz), P(0, dy - d, dz), P(0, dy + d, dz), col(daymark[0]));
  b.tri(P(0, dy - d, dz), P(d, dy, dz), P(0, dy + d, dz), col(daymark[1]));
  b.tri(P(0, dy - d, dz - 0.05), P(-d, dy, dz - 0.05), P(0, dy + d, dz - 0.05), col(daymark[1]));
  b.tri(P(d, dy, dz - 0.05), P(0, dy - d, dz - 0.05), P(0, dy + d, dz - 0.05), col(daymark[0]));
  // platform + lantern
  b.box(f, 0, H, 0, 2.0, 0.2, 2.0, steel);
  b.cylinder(f, 0, H + 0.2, 0, 0.45, 0.45, 0.9, 8, col('#2f3336'), { topColor: col('#202224') });
  const p = P(0, H + 0.7, 0);
  return { x: p[0], y: p[1], z: p[2] };
}

// ADF&G closed-waters regulatory marker: post with an orange-bordered white board facing `rot` front.
export function regMarker(S, x, z, rot) {
  const { b } = S;
  const g = S.H(x, z);
  const f = { x, z, rot, y: g - 2.2 };
  S.sites?.push({ x, z, r: 4 });
  b.box(f, 0, 0, 0, 0.2, 5.9, 0.2, col('#8a7a62'));
  b.box(f, 0, 4.8, 0.14, 1.5, 1.2, 0.06, col('#f06a1a'));
  b.box(f, 0, 4.95, 0.18, 1.2, 0.9, 0.04, col('#f5f3ec'));
  b.box(f, 0, 5.3, 0.21, 0.9, 0.14, 0.02, col('#f06a1a'));
}
