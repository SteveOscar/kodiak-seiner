// Small-boat harbours: rubble breakwaters, floats with finger slips, guide piles and moored boats; plus piers.

import { Builder, col, shade } from './kit.js';
import { boat, float, guidePile, pileDeck, PALETTE } from './structures.js';
import { faceRot } from './sites.js';

// Rubble-mound breakwater along a world polyline [{x, z}, ...]; top at +2.8 m.
export function breakwater(S, pts, o = {}) {
  const { b, rng } = S;
  const top = o.top ?? 2.8;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const c = pts[i + 1];
    const len = Math.hypot(c.x - a.x, c.z - a.z);
    const rot = faceRot(c.x - a.x, c.z - a.z) - Math.PI / 2;
    const n = Math.max(1, Math.ceil(len / 10));
    for (let k = 0; k < n; k++) {
      const t0 = k / n;
      const t1 = (k + 1) / n;
      const mx = a.x + (c.x - a.x) * (t0 + t1) * 0.5;
      const mz = a.z + (c.z - a.z) * (t0 + t1) * 0.5;
      const seg = (len / n) * 1.06;
      const g = Math.min(S.H(mx, mz), 0) - 2.2;
      const rock = shade('#6f6b65', 0.85 + rng.next() * 0.3);
      const f = { x: mx, z: mz, rot, y: 0 };
      const hw = 3.2 + (top - g) * 0.9;
      // armour stone slopes
      const P = (x, y, z) => Builder.xf(f, x, y, z, [0, 0, 0]);
      b.quad(P(-seg / 2, g, hw), P(seg / 2, g, hw), P(seg / 2, top, 1.8), P(-seg / 2, top, 1.8), rock);
      b.quad(P(seg / 2, g, -hw), P(-seg / 2, g, -hw), P(-seg / 2, top, -1.8), P(seg / 2, top, -1.8), shade('#67635e', 0.9 + rng.next() * 0.2));
      b.quad(P(-seg / 2, top, 1.8), P(seg / 2, top, 1.8), P(seg / 2, top, -1.8), P(-seg / 2, top, -1.8), shade('#7b766f', 0.95 + rng.next() * 0.1));
      // a few boulders for texture
      for (let q = 0; q < 2; q++) {
        const bx = (rng.next() - 0.5) * seg;
        const bz = (rng.next() < 0.5 ? -1 : 1) * (1.9 + rng.next() * 1.2);
        b.box(f, bx, top - 0.9 - Math.abs(bz) * 0.25, bz, 1.4 + rng.next(), 1.1, 1.2 + rng.next(), shade('#77726b', 0.85 + rng.next() * 0.3));
      }
    }
  }
  if (o.lightAtEnd) {
    const e = pts[pts.length - 1];
    S.b.cylinder({ x: e.x, z: e.z, rot: 0, y: top }, 0, 0, 0, 0.35, 0.3, 4, 8, col(o.lightAtEnd === 'red' ? '#c8322a' : '#2f8a4a'));
    S.glows?.push({ x: e.x, y: top + 4.4, z: e.z, color: o.lightAtEnd === 'red' ? '#ff3b2f' : '#35ff6a', intensity: 6, size: 1.6, period: 4, flashes: 1, phase: rng.next() * 4 });
  }
}

// A float with finger slips and boats. Frame f: main float along local x centred at (0,0); slips toward +z
// (and -z when both). o: { len, fingerLen, pitch, both, fill (0..1), boatL: [min,max], big (crab boats) }
export function slips(S, f, o = {}) {
  const { rng } = S;
  const len = o.len ?? 80;
  const fl = o.fingerLen ?? 10;
  const pitch = o.pitch ?? 7.5;
  float(S, f, 0, 0, len, 2.6);
  const sides = o.both ? [1, -1] : [1];
  const n = Math.floor(len / pitch);
  for (const side of sides) {
    for (let i = 0; i <= n; i++) {
      const lx = -len / 2 + i * pitch;
      float(S, { ...f, rot: f.rot + Math.PI / 2 }, -side * (1.3 + fl / 2), lx, fl, 1.1);
      const pz = side * (1.3 + fl + 0.5);
      const p = Builder.xf(f, lx, 0, pz, [0, 0, 0]);
      if (i % 2 === 0) guidePile(S, p[0], p[2]);
      if (i < n && rng.next() < (o.fill ?? 0.8)) {
        const [a, c] = o.boatL ?? [9, 17];
        const L = Math.min(pitch * 2.4, a + rng.next() * (c - a));
        const bz = side * (1.6 + L / 2);
        const bf = { ...f, x: 0, z: 0 };
        const q = Builder.xf(f, lx + pitch / 2, 0, bz, [0, 0, 0]);
        bf.x = q[0];
        bf.z = q[2];
        bf.rot = f.rot + (side > 0 ? Math.PI : 0) + (rng.next() - 0.5) * 0.05;
        boat(S, bf, { L, B: Math.min(pitch - 1.6, L * 0.33), seine: rng.next() < 0.35 && L > 13 });
      }
    }
  }
  // lights along the float
  for (let lx = -len / 2 + 10; lx < len / 2; lx += 22) {
    const p = Builder.xf(f, lx, 2.4, 0, [0, 0, 0]);
    S.b.box({ x: p[0], z: p[2], rot: f.rot, y: 0.4 }, 0, 0, 0, 0.14, 2.1, 0.14, col('#44484a'));
    S.glows?.push({ x: p[0], y: p[1] + 0.1, z: p[2], color: '#ffd9a0', intensity: 3.2, size: 0.8 });
  }
}

// Pier on pilings from a shore point a to a water point c (width w, deck height y), with a lamp at the end.
export function pier(S, a, c, w = 5, y = 3.4, o = {}) {
  const len = Math.hypot(c.x - a.x, c.z - a.z);
  const rot = faceRot(c.x - a.x, c.z - a.z);
  const f = { x: (a.x + c.x) / 2, z: (a.z + c.z) / 2, rot };
  pileDeck(S, { ...f, rot: rot + Math.PI / 2 }, 0, 0, len + 4, w, y, { spacing: 6, deck: o.deck ?? PALETTE.deck });
  if (o.lamp !== false) {
    S.b.box({ x: c.x, z: c.z, rot, y }, 0, 0, 0, 0.16, 4.5, 0.16, col('#44484a'));
    S.glows?.push({ x: c.x, y: y + 4.6, z: c.z, color: '#ffcf8a', intensity: 3.5, size: 1.0 });
  }
  return { rot, len };
}
