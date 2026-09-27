// Merged low-poly geometry builder for places (flat-shaded faces, linear vertex colours, facade coordinates).
//
// Every vertex carries aFacade = (u, v, code, seed): u/v are metres along/up a wall (windows are drawn from them in
// the shader), code = windowType * 100 + halfWidth of the wall (0 = no windows), seed varies lit windows per
// building. Frames are { x, y, z, rot } with rot = yaw (radians, counter-clockwise seen from above, like
// Object3D.rotation.y); local +z is "front".

import * as THREE from 'three';

export const WIN = { none: 0, house: 1, shed: 2, church: 3, office: 4, lamp: 9 };

const _c = new THREE.Color();

// sRGB hex/string -> linear THREE.Color (cached per string).
const colorCache = new Map();
export function col(hex) {
  let c = colorCache.get(hex);
  if (!c) {
    c = new THREE.Color(hex);
    colorCache.set(hex, c);
  }
  return c;
}

// Linear colour with a brightness jitter (0.9..1.1 typical).
export function shade(hex, k) {
  return _c.copy(col(hex)).multiplyScalar(k).clone();
}

export class Builder {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.clr = [];
    this.fac = [];
    this.seed = 0;
  }

  get vertexCount() {
    return this.pos.length / 3;
  }

  // Local -> world for a frame.
  static xf(f, lx, ly, lz, out) {
    const c = Math.cos(f.rot ?? 0);
    const s = Math.sin(f.rot ?? 0);
    out[0] = f.x + lx * c + lz * s;
    out[1] = (f.y ?? 0) + ly;
    out[2] = f.z - lx * s + lz * c;
    return out;
  }

  // Triangle in world space with flat normal. Colour c (linear THREE.Color); facade per vertex [u, v] (optional).
  tri(a, b, c, color, fa, fb, fc, code = 0) {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    for (const [p, f] of [[a, fa], [b, fb], [c, fc]]) {
      this.pos.push(p[0], p[1], p[2]);
      this.nrm.push(nx, ny, nz);
      this.clr.push(color.r, color.g, color.b);
      this.fac.push(f ? f[0] : 0, f ? f[1] : 0, code, this.seed);
    }
  }

  // Quad a-b-c-d (counter-clockwise seen from the front).
  quad(a, b, c, d, color, fa, fb, fc, fd, code = 0) {
    this.tri(a, b, c, color, fa, fb, fc, code);
    this.tri(a, c, d, color, fa, fc, fd, code);
  }

  // Axis box in a frame: centred on (lx, lz), from ly to ly + h. opts: { win: WIN.x, top, bottom, colors: {top, side} }
  box(f, lx, ly, lz, w, h, d, color, opts = {}) {
    const P = (x, y, z) => Builder.xf(f, lx + x, ly + y, lz + z, [0, 0, 0]);
    const hw = w / 2;
    const hd = d / 2;
    const p000 = P(-hw, 0, -hd);
    const p100 = P(hw, 0, -hd);
    const p010 = P(-hw, h, -hd);
    const p110 = P(hw, h, -hd);
    const p001 = P(-hw, 0, hd);
    const p101 = P(hw, 0, hd);
    const p011 = P(-hw, h, hd);
    const p111 = P(hw, h, hd);
    const win = opts.win ?? 0;
    const base = opts.v0 ?? 0;
    const side = opts.side ?? color;
    const cw = win ? win * 100 + Math.min(99, hw) : 0;
    const cd = win ? win * 100 + Math.min(99, hd) : 0;
    // front (+z), back (-z), right (+x), left (-x)
    this.quad(p001, p101, p111, p011, side, [-hw, base], [hw, base], [hw, base + h], [-hw, base + h], cw);
    this.quad(p100, p000, p010, p110, side, [-hw, base], [hw, base], [hw, base + h], [-hw, base + h], cw);
    this.quad(p101, p100, p110, p111, side, [-hd, base], [hd, base], [hd, base + h], [-hd, base + h], cd);
    this.quad(p000, p001, p011, p010, side, [-hd, base], [hd, base], [hd, base + h], [-hd, base + h], cd);
    if (opts.top !== false) this.quad(p011, p111, p110, p010, opts.topColor ?? color);
    if (opts.bottom) this.quad(p000, p100, p101, p001, color);
  }

  // Gable roof over a w x d footprint at height y0 (ridge along local x), pitch = rise / half-depth, eave overhang o.
  gable(f, lx, y0, lz, w, d, rise, roofColor, wallColor, opts = {}) {
    const o = opts.overhang ?? 0.4;
    const P = (x, y, z) => Builder.xf(f, lx + x, y, lz + z, [0, 0, 0]);
    const hw = w / 2 + o;
    const hd = d / 2 + o;
    const drop = (rise * o) / (d / 2);
    const ea = P(-hw, y0 - drop, -hd);
    const eb = P(hw, y0 - drop, -hd);
    const ec = P(hw, y0 - drop, hd);
    const ed = P(-hw, y0 - drop, hd);
    const ra = P(-hw, y0 + rise, 0);
    const rb = P(hw, y0 + rise, 0);
    this.quad(ed, ec, rb, ra, roofColor);
    this.quad(eb, ea, ra, rb, roofColor);
    // gable ends (walls up to the ridge)
    const win = opts.win ?? 0;
    const hwall = w / 2;
    const g1 = P(-hwall, y0, -d / 2);
    const g2 = P(-hwall, y0, d / 2);
    const g3 = P(-hwall, y0 + rise, 0);
    const g4 = P(hwall, y0, d / 2);
    const g5 = P(hwall, y0, -d / 2);
    const g6 = P(hwall, y0 + rise, 0);
    const vb = opts.v0 ?? 0;
    const code = win ? win * 100 + Math.min(99, d / 2) : 0;
    this.tri(g1, g2, g3, wallColor, [-d / 2, vb], [d / 2, vb], [0, vb + rise], code);
    this.tri(g4, g5, g6, wallColor, [-d / 2, vb], [d / 2, vb], [0, vb + rise], code);
    // soffits
    if (opts.soffit !== false) {
      this.quad(ea, eb, P(hw, y0 - drop, -d / 2 + 0.01), P(-hw, y0 - drop, -d / 2 + 0.01), wallColor);
    }
  }

  // Shed/lean-to roof (single slope rising toward -z).
  shedRoof(f, lx, y0, lz, w, d, rise, roofColor, wallColor) {
    const P = (x, y, z) => Builder.xf(f, lx + x, y, lz + z, [0, 0, 0]);
    const hw = w / 2 + 0.3;
    const hd = d / 2 + 0.3;
    this.quad(P(-hw, y0, hd), P(hw, y0, hd), P(hw, y0 + rise, -hd), P(-hw, y0 + rise, -hd), roofColor);
    this.tri(P(-w / 2, y0, d / 2), P(-w / 2, y0 + rise, -d / 2), P(-w / 2, y0, -d / 2), wallColor);
    this.tri(P(w / 2, y0, -d / 2), P(w / 2, y0 + rise, -d / 2), P(w / 2, y0, d / 2), wallColor);
    this.quad(P(w / 2, y0, -d / 2), P(-w / 2, y0, -d / 2), P(-w / 2, y0 + rise, -d / 2), P(w / 2, y0 + rise, -d / 2), wallColor);
  }

  // Vertical prism/cylinder (n sides) with radius r0 at bottom and r1 at top.
  cylinder(f, lx, ly, lz, r0, r1, h, n, color, opts = {}) {
    const P = (x, y, z) => Builder.xf(f, lx + x, ly + y, lz + z, [0, 0, 0]);
    const a0 = opts.phase ?? 0;
    const ring = (r, y) => {
      const out = [];
      for (let i = 0; i < n; i++) {
        const a = a0 + (i / n) * Math.PI * 2;
        out.push(P(Math.cos(a) * r, y, Math.sin(a) * r));
      }
      return out;
    };
    const lo = ring(r0, 0);
    const hi = ring(r1, h);
    const circ = 2 * Math.PI * r0;
    const code = opts.win ? opts.win * 100 + Math.min(99, circ / n / 2) : 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const seg = circ / n;
      this.quad(lo[j], lo[i], hi[i], hi[j], color, [-seg / 2, 0], [seg / 2, 0], [seg / 2, h], [-seg / 2, h], code);
    }
    if (opts.top !== false && r1 > 0.001) {
      const c = P(0, h, 0);
      for (let i = 0; i < n; i++) this.tri(hi[(i + 1) % n], hi[i], c, opts.topColor ?? color);
    }
    if (opts.bottom) {
      const c = P(0, 0, 0);
      for (let i = 0; i < n; i++) this.tri(lo[i], lo[(i + 1) % n], c, color);
    }
  }

  // Lathe from a profile [[r, y], ...] (bottom to top) around a vertical axis.
  lathe(f, lx, ly, lz, profile, n, color) {
    const P = (x, y, z) => Builder.xf(f, lx + x, ly + y, lz + z, [0, 0, 0]);
    for (let k = 0; k < profile.length - 1; k++) {
      const [r0, y0] = profile[k];
      const [r1, y1] = profile[k + 1];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const b = ((i + 1) / n) * Math.PI * 2;
        const A = P(Math.cos(a) * r0, y0, Math.sin(a) * r0);
        const B = P(Math.cos(b) * r0, y0, Math.sin(b) * r0);
        const C = P(Math.cos(b) * r1, y1, Math.sin(b) * r1);
        const D = P(Math.cos(a) * r1, y1, Math.sin(a) * r1);
        if (r1 < 1e-4) this.tri(B, A, D, color);
        else if (r0 < 1e-4) this.tri(A, D, C, color);
        else this.quad(B, A, D, C, color);
      }
    }
  }

  // Onion dome (Russian Orthodox cupola) of max radius r and height h on a drum, with a cross above.
  onion(f, lx, ly, lz, r, h, domeColor, crossColor) {
    const prof = [
      [r * 0.62, 0],
      [r * 0.95, h * 0.18],
      [r, h * 0.32],
      [r * 0.9, h * 0.48],
      [r * 0.62, h * 0.64],
      [r * 0.3, h * 0.8],
      [r * 0.1, h * 0.92],
      [0, h],
    ];
    this.lathe(f, lx, ly, lz, prof, 10, domeColor);
    const cy = ly + h;
    const cw = Math.max(0.08, r * 0.08);
    this.box(f, lx, cy, lz, cw, r * 1.3, cw, crossColor, { top: true });
    this.box(f, lx, cy + r * 0.8, lz, r * 0.7, cw, cw, crossColor);
    this.box(f, lx, cy + r * 0.45, lz, r * 0.45, cw, cw, crossColor);
  }

  // Beam between two world points (square section s).
  beam(a, b, s, color) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    const d = new THREE.Vector3(dx / len, dy / len, dz / len);
    const up = Math.abs(d.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const u = new THREE.Vector3().crossVectors(d, up).normalize().multiplyScalar(s / 2);
    const v = new THREE.Vector3().crossVectors(u, d).normalize().multiplyScalar(s / 2);
    const corner = (p, su, sv) => [p[0] + u.x * su + v.x * sv, p[1] + u.y * su + v.y * sv, p[2] + u.z * su + v.z * sv];
    const A = [corner(a, -1, -1), corner(a, 1, -1), corner(a, 1, 1), corner(a, -1, 1)];
    const B = [corner(b, -1, -1), corner(b, 1, -1), corner(b, 1, 1), corner(b, -1, 1)];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      this.quad(A[j], A[i], B[i], B[j], color);
    }
  }

  // Merge another builder's arrays.
  append(o) {
    this.pos.push(...o.pos);
    this.nrm.push(...o.nrm);
    this.clr.push(...o.clr);
    this.fac.push(...o.fac);
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.clr, 3));
    g.setAttribute('aFacade', new THREE.Float32BufferAttribute(this.fac, 4));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}
