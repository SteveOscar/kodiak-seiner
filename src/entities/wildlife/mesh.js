// Procedural mesh toolkit for the wildlife models: closed tube lofts along arbitrary paths, ring lofts, ellipsoids,
// per-vertex colour and rig channels, automatic outward winding, merged into one BufferGeometry with attributes
// position, normal, color (linear), aRig (vec4) and aPivot (vec4). Node-safe (no DOM).

import * as THREE from 'three';

const TAU = Math.PI * 2;
const _c = new THREE.Color();

// sRGB hex -> linear [r, g, b] (THREE.Color performs the conversion under ColorManagement).
export function lin(hex) {
  _c.set(hex);
  return [_c.r, _c.g, _c.b];
}
export const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const scale3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];

// Deterministic 3D value noise in [0, 1] for fur/skin mottling baked into vertex colours.
function h3(x, y, z) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 1440662683);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export function vnoise(x, y, z) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const fx = x - xi;
  const fy = y - yi;
  const fz = z - zi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const w = fz * fz * (3 - 2 * fz);
  const l = (a, b, t) => a + (b - a) * t;
  return l(
    l(l(h3(xi, yi, zi), h3(xi + 1, yi, zi), u), l(h3(xi, yi + 1, zi), h3(xi + 1, yi + 1, zi), u), v),
    l(l(h3(xi, yi, zi + 1), h3(xi + 1, yi, zi + 1), u), l(h3(xi, yi + 1, zi + 1), h3(xi + 1, yi + 1, zi + 1), u), v),
    w,
  );
}

// Superellipse ring coefficient: exponent p = 2 is an ellipse, larger is boxier, smaller is pinched.
const se = (v, p) => Math.sign(v) * Math.abs(v) ** (2 / p);

// Catmull-Rom interpolation of keyed profiles: keys = [{t, ...numbers}], returns the values at t.
export function sampleKeys(keys, t) {
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1].t < t) i++;
  const k0 = keys[Math.max(0, i - 1)];
  const k1 = keys[i];
  const k2 = keys[i + 1];
  const k3 = keys[Math.min(keys.length - 1, i + 2)];
  const s = Math.min(1, Math.max(0, (t - k1.t) / Math.max(1e-6, k2.t - k1.t)));
  const out = {};
  for (const name of Object.keys(k1)) {
    if (name === 't') continue;
    const p0 = k0[name] ?? k1[name];
    const p1 = k1[name];
    const p2 = k2[name] ?? p1;
    const p3 = k3[name] ?? p2;
    const s2 = s * s;
    const s3 = s2 * s;
    out[name] = 0.5 * (2 * p1 + (-p0 + p2) * s + (2 * p0 - 5 * p1 + 4 * p2 - p3) * s2 + (-p0 + 3 * p1 - 3 * p2 + p3) * s3);
  }
  out.t = t;
  return out;
}

// One closed part under construction.
class Part {
  constructor() {
    this.pos = [];
    this.meta = []; // per-vertex info handed to colour/rig callbacks
    this.idx = [];
  }
  vert(x, y, z, meta) {
    this.pos.push(x, y, z);
    this.meta.push(meta);
    return this.pos.length / 3 - 1;
  }
  tri(a, b, c) {
    this.idx.push(a, b, c);
  }
  // Signed volume (positive = outward-facing counter-clockwise winding for a closed surface).
  volume() {
    const p = this.pos;
    let v = 0;
    for (let i = 0; i < this.idx.length; i += 3) {
      const a = this.idx[i] * 3;
      const b = this.idx[i + 1] * 3;
      const c = this.idx[i + 2] * 3;
      v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
    }
    return v / 6;
  }
  orient() {
    if (this.volume() < 0) {
      for (let i = 0; i < this.idx.length; i += 3) {
        const t = this.idx[i + 1];
        this.idx[i + 1] = this.idx[i + 2];
        this.idx[i + 2] = t;
      }
    }
    return this;
  }
}

// Lofts consecutive rings (arrays of [x, y, z], equal length) into a closed tube with fan caps at both ends.
export function ringLoft(rings, metaFn = () => ({}), { capStart = null, capEnd = null } = {}) {
  const part = new Part();
  const n = rings[0].length;
  const ids = rings.map((ring, i) =>
    ring.map((p, k) => part.vert(p[0], p[1], p[2], { i, k, u: i / (rings.length - 1), a: (k / n) * TAU, ...metaFn(i, k, p) })),
  );
  for (let i = 0; i < rings.length - 1; i++) {
    for (let k = 0; k < n; k++) {
      const a = ids[i][k];
      const b = ids[i + 1][k];
      const c = ids[i][(k + 1) % n];
      const d = ids[i + 1][(k + 1) % n];
      part.tri(a, c, b);
      part.tri(c, d, b);
    }
  }
  const cap = (ring, idRow, i, sign, at) => {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const p of ring) {
      cx += p[0];
      cy += p[1];
      cz += p[2];
    }
    if (at) {
      cx = at[0] * n;
      cy = at[1] * n;
      cz = at[2] * n;
    }
    const c = part.vert(cx / n, cy / n, cz / n, { i, k: -1, u: i / (rings.length - 1), a: 0, cap: sign, ...metaFn(i, -1, [cx / n, cy / n, cz / n]) });
    for (let k = 0; k < n; k++) {
      if (sign < 0) part.tri(c, idRow[(k + 1) % n], idRow[k]);
      else part.tri(c, idRow[k], idRow[(k + 1) % n]);
    }
  };
  cap(rings[0], ids[0], 0, -1, capStart);
  cap(rings[rings.length - 1], ids[rings.length - 1], rings.length - 1, 1, capEnd);
  return part.orient();
}

// Tube along a path. nodes = [{p: [x, y, z], rx, ry, pw?}] where rx spans the "side" axis (up x tangent) and ry the
// ring's own up. `up` is the reference up vector for the ring frames. Returns a closed Part.
export function tube(nodes, { segs = 12, up = [0, 1, 0], metaFn } = {}) {
  const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);
  const upV = V(up).normalize();
  const rings = nodes.map((node, i) => {
    const prev = V(nodes[Math.max(0, i - 1)].p);
    const next = V(nodes[Math.min(nodes.length - 1, i + 1)].p);
    const T = next.sub(prev).normalize();
    let N = new THREE.Vector3().crossVectors(upV, T);
    if (N.lengthSq() < 1e-8) N = new THREE.Vector3().crossVectors(new THREE.Vector3(1, 0, 0), T);
    N.normalize();
    const B = new THREE.Vector3().crossVectors(T, N).normalize();
    const pw = node.pw ?? 2;
    const ring = [];
    for (let k = 0; k < segs; k++) {
      const a = (k / segs) * TAU + (node.twist ?? 0);
      const cx = se(Math.cos(a), pw) * node.rx;
      const cy = se(Math.sin(a), pw) * node.ry;
      ring.push([node.p[0] + N.x * cx + B.x * cy, node.p[1] + N.y * cx + B.y * cy, node.p[2] + N.z * cx + B.z * cy]);
    }
    return ring;
  });
  return ringLoft(rings, (i, k, p) => ({ node: nodes[Math.min(i, nodes.length - 1)], ...(metaFn ? metaFn(i, k, p) : {}) }));
}

// Horizontal body along z (front = -z): keys [{t: 0..1, cy, rx, ry, pw?, cx?}] over z in [z0, z1].
export function bodyLoft(keys, { z0, z1, rings = 24, segs = 16, metaFn } = {}) {
  const out = [];
  for (let i = 0; i < rings; i++) {
    const t = i / (rings - 1);
    const k = sampleKeys(keys, t);
    const z = z0 + (z1 - z0) * t;
    const ring = [];
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * TAU;
      ring.push([(k.cx ?? 0) + se(Math.cos(a), k.pw ?? 2) * Math.max(1e-4, k.rx), k.cy + se(Math.sin(a), k.pw ?? 2) * Math.max(1e-4, k.ry), z]);
    }
    out.push(ring);
  }
  return ringLoft(out, (i, s, p) => ({ t: i / (rings - 1), ...(metaFn ? metaFn(i, s, p) : {}) }));
}

// Ellipsoid centred at c with radii r (optionally rotated by a small Euler [rx, ry, rz]).
export function ellipsoid(c, r, { rings = 8, segs = 10, rot = null, metaFn } = {}) {
  const m = rot ? new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot[0], rot[1], rot[2], 'YXZ')) : null;
  const v = new THREE.Vector3();
  const out = [];
  for (let i = 1; i < rings; i++) {
    const th = (i / rings) * Math.PI;
    const ring = [];
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * TAU;
      v.set(Math.sin(th) * Math.cos(a) * r[0], Math.sin(th) * Math.sin(a) * r[1], -Math.cos(th) * r[2]);
      if (m) v.applyMatrix4(m);
      ring.push([c[0] + v.x, c[1] + v.y, c[2] + v.z]);
    }
    out.push(ring);
  }
  const pole = (sgn) => {
    v.set(0, 0, sgn * r[2]);
    if (m) v.applyMatrix4(m);
    return [c[0] + v.x, c[1] + v.y, c[2] + v.z];
  };
  return ringLoft(out, metaFn, { capStart: pole(-1), capEnd: pole(1) });
}

// A thin closed blade (wing, fin, fluke) described by span stations. Each station: {s (span position along `axis`),
// lead, trail (chord coordinates along `chordAxis`), t (thickness), off: [dx, dy, dz] extra offset}. The blade lies in
// the plane spanned by axis and chordAxis; thickness is along their cross product. `chords` = chordwise divisions.
export function blade(stations, { axis = [1, 0, 0], chordAxis = [0, 0, 1], chords = 4, origin = [0, 0, 0], camber = 0, metaFn } = {}) {
  const A = new THREE.Vector3(...axis).normalize();
  const C = new THREE.Vector3(...chordAxis).normalize();
  const T = new THREE.Vector3().crossVectors(C, A).normalize();
  const rings = stations.map((st) => {
    const ring = [];
    // Loop: top surface lead -> trail, then bottom trail -> lead (shared edge points are separate but coincident).
    for (let j = 0; j <= chords; j++) {
      const f = j / chords;
      const th = st.t * 0.5 * Math.sin(Math.PI * Math.min(1, f * 1.15 + 0.02)) ** 0.8;
      const cb = camber * st.t * Math.sin(Math.PI * f);
      const ch = st.lead + (st.trail - st.lead) * f;
      ring.push(pt(st, ch, th + cb));
    }
    for (let j = chords - 1; j >= 1; j--) {
      const f = j / chords;
      const th = st.t * 0.5 * Math.sin(Math.PI * Math.min(1, f * 1.15 + 0.02)) ** 0.8;
      const cb = camber * st.t * Math.sin(Math.PI * f);
      const ch = st.lead + (st.trail - st.lead) * f;
      ring.push(pt(st, ch, -th + cb));
    }
    return ring;
  });
  function pt(st, ch, th) {
    const o = st.off ?? [0, 0, 0];
    return [
      origin[0] + A.x * st.s + C.x * ch + T.x * th + o[0],
      origin[1] + A.y * st.s + C.y * ch + T.y * th + o[1],
      origin[2] + A.z * st.s + C.z * ch + T.z * th + o[2],
    ];
  }
  const nTop = chords + 1;
  return ringLoft(rings, (i, k, p) => ({ station: stations[Math.min(i, stations.length - 1)], top: k >= 0 && k < nTop ? 1 : 0, ...(metaFn ? metaFn(i, k, p) : {}) }));
}

// Collects parts with colour and rig callbacks and builds one indexed BufferGeometry. Each part gets smooth normals
// within itself (hard seams between parts).
export class ModelBuilder {
  constructor() {
    this.parts = [];
  }
  add(part, { color, rig = () => [0, 0, 0, 0], pivot = () => [0, 0, 0, 0], noise = 0.06, noiseScale = 9 } = {}) {
    this.parts.push({ part, color, rig, pivot, noise, noiseScale });
    return this;
  }
  build() {
    const pos = [];
    const nrm = [];
    const col = [];
    const rig = [];
    const piv = [];
    const idx = [];
    for (const { part, color, rig: rigFn, pivot: pivFn, noise, noiseScale } of this.parts) {
      const base = pos.length / 3;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(part.pos, 3));
      g.setIndex(part.idx);
      g.computeVertexNormals();
      const n = g.attributes.normal.array;
      for (let v = 0; v < part.pos.length / 3; v++) {
        const x = part.pos[v * 3];
        const y = part.pos[v * 3 + 1];
        const z = part.pos[v * 3 + 2];
        const meta = { ...part.meta[v], x, y, z, nx: n[v * 3], ny: n[v * 3 + 1], nz: n[v * 3 + 2] };
        const c = typeof color === 'function' ? color(meta) : color;
        const k = noise > 0 ? 1 + noise * (vnoise(x * noiseScale, y * noiseScale, z * noiseScale) * 2 - 1) : 1;
        pos.push(x, y, z);
        nrm.push(n[v * 3], n[v * 3 + 1], n[v * 3 + 2]);
        col.push(c[0] * k, c[1] * k, c[2] * k);
        rig.push(...rigFn(meta));
        piv.push(...pivFn(meta));
      }
      for (const i of part.idx) idx.push(base + i);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setAttribute('aRig', new THREE.Float32BufferAttribute(rig, 4));
    geo.setAttribute('aPivot', new THREE.Float32BufferAttribute(piv, 4));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return geo;
  }
}
