// Geometry assembly for procedural boats: primitives are transformed, vertex-coloured, box-UV'd and merged per
// material bucket so a whole boat draws in a handful of calls.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _c = new THREE.Color();
const _nm = new THREE.Matrix3();

// Strip to position/normal/uv/color and make indexed so any primitive merges with any other.
function normalise(g) {
  for (const k of Object.keys(g.attributes)) {
    if (k !== 'position' && k !== 'normal' && k !== 'uv' && k !== 'color') g.deleteAttribute(k);
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  const count = g.attributes.position.count;
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  if (!g.index) {
    const idx = new (count > 65535 ? Uint32Array : Uint16Array)(count);
    for (let i = 0; i < count; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  g.morphAttributes = {};
  g.clearGroups();
  return g;
}

export function createBuilder() {
  const buckets = new Map();
  const b = {
    // opts: { p: [x,y,z], r: [x,y,z] (Euler XYZ), s: [x,y,z] | number, m: Matrix4, color: hex|Color|[r,g,b] (sRGB),
    //         uv: 'box' (world-scale box projection, uvScale per metre) | 'keep', uvScale }
    add(bucket, geometry, opts = {}) {
      const g = normalise(geometry.clone());
      if (opts.m) {
        _m.copy(opts.m);
      } else {
        _p.fromArray(opts.p ?? [0, 0, 0]);
        _e.set(...(opts.r ?? [0, 0, 0]));
        _q.setFromEuler(_e);
        if (typeof opts.s === 'number') _s.setScalar(opts.s);
        else _s.fromArray(opts.s ?? [1, 1, 1]);
        _m.compose(_p, _q, _s);
      }
      g.applyMatrix4(_m);
      const count = g.attributes.position.count;
      const col = new Float32Array(count * 3);
      const src = g.attributes.color;
      if (opts.color !== undefined || !src) {
        const c = opts.color;
        if (Array.isArray(c)) _c.setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
        else _c.set(c ?? 0xffffff);
        for (let i = 0; i < count; i++) {
          col[i * 3] = _c.r;
          col[i * 3 + 1] = _c.g;
          col[i * 3 + 2] = _c.b;
        }
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      }
      if (opts.uv !== 'keep') {
        const sc = opts.uvScale ?? 0.5;
        const pos = g.attributes.position;
        const nor = g.attributes.normal;
        const uv = g.attributes.uv;
        for (let i = 0; i < count; i++) {
          const x = pos.getX(i);
          const y = pos.getY(i);
          const z = pos.getZ(i);
          const ax = Math.abs(nor.getX(i));
          const ay = Math.abs(nor.getY(i));
          const az = Math.abs(nor.getZ(i));
          if (ax >= ay && ax >= az) uv.setXY(i, z * sc, y * sc);
          else if (ay >= az) uv.setXY(i, x * sc, z * sc);
          else uv.setXY(i, x * sc, y * sc);
        }
        uv.needsUpdate = true;
      }
      if (!buckets.has(bucket)) buckets.set(bucket, []);
      buckets.get(bucket).push(g);
      return g;
    },
    has: (bucket) => buckets.has(bucket) && buckets.get(bucket).length > 0,
    buckets: () => [...buckets.keys()],
    build(bucket) {
      const list = buckets.get(bucket);
      if (!list || !list.length) return null;
      const g = list.length === 1 ? list[0] : mergeGeometries(list, false);
      for (const x of list) if (x !== g) x.dispose();
      buckets.delete(bucket);
      g.computeBoundingSphere();
      g.computeBoundingBox();
      return g;
    },
  };
  return b;
}

// Common shapes (unit-ish, positioned by the builder).
export const shapes = {
  box: (w, h, d) => new THREE.BoxGeometry(w, h, d),
  rbox: (w, h, d, r = 0.06, seg = 2) => new RoundedBoxGeometry(w, h, d, seg, r),
  cyl: (rt, rb, h, seg = 12, open = false) => new THREE.CylinderGeometry(rt, rb, h, seg, 1, open),
  sphere: (r, ws = 12, hs = 8) => new THREE.SphereGeometry(r, ws, hs),
  torus: (r, tube, rs = 8, ts = 20, arc = Math.PI * 2) => new THREE.TorusGeometry(r, tube, rs, ts, arc),
};

// A cylinder between two points (pipes, rails, rigging).
export function addTube(builder, bucket, a, b, radius, opts = {}) {
  const A = new THREE.Vector3().fromArray(a);
  const B = new THREE.Vector3().fromArray(b);
  const dir = new THREE.Vector3().subVectors(B, A);
  const len = dir.length();
  if (len < 1e-4) return;
  const g = new THREE.CylinderGeometry(opts.radiusB ?? radius, radius, len, opts.seg ?? 8, 1, opts.open ?? true);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  const m = new THREE.Matrix4().compose(A.clone().add(B).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
  builder.add(bucket, g, { ...opts, m });
}

// A sagging line (catenary-ish parabola) as a chain of tubes.
export function addRope(builder, bucket, a, b, radius, sag = 0.2, segs = 8, opts = {}) {
  let prev = a;
  for (let i = 1; i <= segs; i++) {
    const t = i / segs;
    const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t), a[2] + (b[2] - a[2]) * t];
    addTube(builder, bucket, prev, p, radius, opts);
    prev = p;
  }
}

// Extrude a 2-D profile (points in the (z, y) side plane) across x; returns a geometry centred on x.
export function sideProfileExtrude(points, width, bevel = 0.04) {
  const shape = new THREE.Shape();
  points.forEach(([z, y], i) => (i ? shape.lineTo(z, y) : shape.moveTo(z, y)));
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: width - bevel * 2,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 4,
  });
  // Shape x -> world z, shape y -> world y, extrusion (z) -> world x.
  const m = new THREE.Matrix4().set(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1);
  g.applyMatrix4(m);
  g.translate(-(width - bevel * 2) / 2, 0, 0);
  // The mirroring matrix flips winding; restore it so faces point outward.
  const idx = g.index;
  if (idx) {
    for (let i = 0; i < idx.count; i += 3) {
      const t = idx.getX(i + 1);
      idx.setX(i + 1, idx.getX(i + 2));
      idx.setX(i + 2, t);
    }
  } else {
    const pos = g.attributes.position;
    const nor = g.attributes.normal;
    const uv = g.attributes.uv;
    for (let i = 0; i < pos.count; i += 3) {
      for (const a of [pos, nor, uv]) {
        if (!a) continue;
        for (let c = 0; c < a.itemSize; c++) {
          const t = a.getComponent(i + 1, c);
          a.setComponent(i + 1, c, a.getComponent(i + 2, c));
          a.setComponent(i + 2, c, t);
        }
      }
    }
  }
  return g;
}

export { _n as tmpNormal, _nm as tmpNormalMatrix };
