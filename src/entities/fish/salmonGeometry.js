// Procedural salmon: a lofted fusiform body (superellipse sections, arched back, flatter belly, pointed snout, slim
// caudal peduncle) with a forked caudal fin, dorsal, adipose, anal, pelvic and pectoral fins. Unit length along z:
// snout at z = −0.5 (the model faces −z, SPEC §3), fork tips at z = +0.5. Attribute aPart: 0 body, 1 median fins,
// 2 caudal fin, 3 paired fins. Fins are two-sided by duplicated faces so the material can cull back faces.
// detail: 'high' (~580 triangles: jumpers, close-ups), 'mid' (~330: school fish near the camera), 'low' (~84).

import * as THREE from 'three';

// s (0 snout → 1 caudal base), top and bottom half-heights, half-width, centre-line height. Fractions of length.
const PROFILE = [
  [0.0, 0.0, 0.0, 0.0, -0.008],
  [0.018, 0.02, 0.016, 0.014, -0.007],
  [0.05, 0.043, 0.034, 0.03, -0.005],
  [0.1, 0.07, 0.056, 0.046, -0.003],
  [0.17, 0.092, 0.073, 0.057, -0.001],
  [0.26, 0.107, 0.085, 0.063, 0.0],
  [0.36, 0.112, 0.088, 0.063, 0.001],
  [0.46, 0.106, 0.083, 0.058, 0.002],
  [0.56, 0.093, 0.072, 0.05, 0.003],
  [0.66, 0.075, 0.057, 0.04, 0.003],
  [0.76, 0.056, 0.042, 0.029, 0.003],
  [0.85, 0.039, 0.03, 0.018, 0.002],
  [0.92, 0.036, 0.029, 0.012, 0.002],
  [1.0, 0.042, 0.035, 0.008, 0.002],
];
const BODY_LEN = 0.82;
const zOf = (s) => -0.5 + s * BODY_LEN;

function sample(s) {
  for (let i = 1; i < PROFILE.length; i++) {
    if (s <= PROFILE[i][0]) {
      const a = PROFILE[i - 1];
      const b = PROFILE[i];
      const t = (s - a[0]) / (b[0] - a[0]);
      const e = t * t * (3 - 2 * t);
      return { top: a[1] + (b[1] - a[1]) * e, bot: a[2] + (b[2] - a[2]) * e, hw: a[3] + (b[3] - a[3]) * e, yc: a[4] + (b[4] - a[4]) * e };
    }
  }
  const l = PROFILE[PROFILE.length - 1];
  return { top: l[1], bot: l[2], hw: l[3], yc: l[4] };
}

const topAt = (s) => {
  const p = sample(s);
  return p.yc + p.top;
};
const botAt = (s) => {
  const p = sample(s);
  return p.yc - p.bot;
};

export function createSalmonGeometry({ detail = 'high' } = {}) {
  const high = detail !== 'low';
  const stations =
    detail === 'high'
      ? [0.0, 0.012, 0.03, 0.055, 0.09, 0.14, 0.2, 0.27, 0.35, 0.43, 0.51, 0.59, 0.67, 0.74, 0.8, 0.86, 0.91, 0.955, 1.0]
      : detail === 'mid'
        ? [0.0, 0.02, 0.06, 0.12, 0.2, 0.3, 0.42, 0.54, 0.66, 0.77, 0.86, 0.93, 1.0]
        : [0.0, 0.06, 0.2, 0.4, 0.62, 0.84, 1.0];
  const sides = detail === 'high' ? 14 : detail === 'mid' ? 10 : 6;
  const n = 2.35; // superellipse exponent: a slightly slab-sided section

  const pos = [];
  const part = [];
  const idx = [];
  // Snout tip.
  pos.push(0, sample(0).yc, zOf(0));
  part.push(0);
  for (let i = 1; i < stations.length; i++) {
    const s = stations[i];
    const p = sample(s);
    for (let k = 0; k < sides; k++) {
      const th = (k / sides) * Math.PI * 2 + (high ? 0 : Math.PI / sides);
      const c = Math.cos(th);
      const sn = Math.sin(th);
      const x = p.hw * Math.sign(c) * Math.abs(c) ** (2 / n);
      const y = p.yc + (sn >= 0 ? p.top : p.bot) * Math.sign(sn) * Math.abs(sn) ** (2 / n);
      pos.push(x, y, zOf(s));
      part.push(0);
    }
  }
  const ring = (i) => 1 + (i - 1) * sides; // first vertex of station i (i ≥ 1)
  for (let k = 0; k < sides; k++) idx.push(0, ring(1) + ((k + 1) % sides), ring(1) + k);
  for (let i = 1; i < stations.length - 1; i++) {
    const a = ring(i);
    const b = ring(i + 1);
    for (let k = 0; k < sides; k++) {
      const k1 = (k + 1) % sides;
      idx.push(a + k, a + k1, b + k);
      idx.push(a + k1, b + k1, b + k);
    }
  }
  // Close the peduncle end.
  const endC = pos.length / 3;
  const last = sample(1);
  pos.push(0, last.yc, zOf(1) + 0.004);
  part.push(0);
  const le = ring(stations.length - 1);
  for (let k = 0; k < sides; k++) idx.push(le + k, le + ((k + 1) % sides), endC);

  const body = new THREE.BufferGeometry();
  body.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  body.setIndex(idx);
  body.computeVertexNormals();
  const bodyNormals = Array.from(body.getAttribute('normal').array);
  // Orient: body normals should point away from the centre line. Flip winding if the loft came out inside-out.
  const probe = ring(Math.floor(stations.length / 2)) * 3;
  const out = pos[probe] * bodyNormals[probe] + (pos[probe + 1] - sample(0.5).yc) * bodyNormals[probe + 1];
  if (out < 0) {
    for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
    for (let i = 0; i < bodyNormals.length; i++) bodyNormals[i] = -bodyNormals[i];
  }

  const P = [...pos];
  const N = [...bodyNormals];
  const PART = [...part];
  const I = [...idx];
  const v = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  // Two-sided triangle with a flat normal.
  function tri(a, b, c, partId) {
    e1.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    e2.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    v.crossVectors(e1, e2).normalize();
    for (const [verts, sgn] of [
      [[a, b, c], 1],
      [[a, c, b], -1],
    ]) {
      const base = P.length / 3;
      for (const q of verts) {
        P.push(q[0], q[1], q[2]);
        N.push(v.x * sgn, v.y * sgn, v.z * sgn);
        PART.push(partId);
      }
      I.push(base, base + 1, base + 2);
    }
  }
  // Flat two-sided fan (planar fins): one shared vertex set per side, indexed.
  function fan(centre, ring, partId) {
    e1.set(ring[0][0] - centre[0], ring[0][1] - centre[1], ring[0][2] - centre[2]);
    e2.set(ring[1][0] - centre[0], ring[1][1] - centre[1], ring[1][2] - centre[2]);
    v.crossVectors(e1, e2).normalize();
    for (const sgn of [1, -1]) {
      const base = P.length / 3;
      for (const q of [centre, ...ring]) {
        P.push(q[0], q[1], q[2]);
        N.push(v.x * sgn, v.y * sgn, v.z * sgn);
        PART.push(partId);
      }
      for (let i = 0; i < ring.length - 1; i++) {
        if (sgn > 0) I.push(base, base + 1 + i, base + 2 + i);
        else I.push(base, base + 2 + i, base + 1 + i);
      }
    }
  }

  // Caudal fin (forked), in the x = 0 plane.
  const zb = zOf(1) - 0.012;
  const caudal = high
    ? [
        [0, topAt(0.99) - 0.004, zb],
        [0, 0.07, 0.385],
        [0, 0.118, 0.44],
        [0, 0.15, 0.482],
        [0, 0.156, 0.5],
        [0, 0.118, 0.482],
        [0, 0.07, 0.458],
        [0, 0.03, 0.437],
        [0, 0.0, 0.43],
        [0, -0.03, 0.437],
        [0, -0.065, 0.458],
        [0, -0.11, 0.482],
        [0, -0.146, 0.5],
        [0, -0.142, 0.482],
        [0, -0.11, 0.44],
        [0, -0.064, 0.385],
        [0, botAt(0.99) + 0.004, zb],
      ]
    : [
        [0, topAt(0.99), zb],
        [0, 0.156, 0.5],
        [0, 0.0, 0.43],
        [0, -0.146, 0.5],
        [0, botAt(0.99), zb],
      ];
  fan([0, 0, zb + 0.03], caudal, 2);

  if (high) {
    // Dorsal fin: leading edge rising steeply, trailing edge falling to a short free rear tip.
    const dorsal = [
      [0, topAt(0.4) - 0.004, zOf(0.4)],
      [0, topAt(0.42) + 0.045, zOf(0.425)],
      [0, topAt(0.44) + 0.074, zOf(0.455)],
      [0, topAt(0.46) + 0.07, zOf(0.475)],
      [0, topAt(0.5) + 0.04, zOf(0.51)],
      [0, topAt(0.56) + 0.012, zOf(0.565)],
      [0, topAt(0.55) - 0.004, zOf(0.55)],
    ];
    fan([0, topAt(0.47) - 0.004, zOf(0.47)], dorsal, 1);
    // Adipose fin: small fleshy lobe.
    const adi = [
      [0, topAt(0.775) - 0.003, zOf(0.775)],
      [0, topAt(0.79) + 0.014, zOf(0.795)],
      [0, topAt(0.81) + 0.021, zOf(0.818)],
      [0, topAt(0.84) + 0.012, zOf(0.845)],
      [0, topAt(0.845) - 0.003, zOf(0.845)],
    ];
    fan([0, topAt(0.81) - 0.003, zOf(0.81)], adi, 1);
    // Anal fin.
    const anal = [
      [0, botAt(0.655) + 0.004, zOf(0.655)],
      [0, botAt(0.67) - 0.042, zOf(0.685)],
      [0, botAt(0.7) - 0.046, zOf(0.71)],
      [0, botAt(0.75) - 0.02, zOf(0.765)],
      [0, botAt(0.77) - 0.006, zOf(0.785)],
      [0, botAt(0.765) + 0.004, zOf(0.765)],
    ];
    fan([0, botAt(0.71) + 0.004, zOf(0.71)], anal, 1);
    for (const sx of [-1, 1]) {
      // Pectoral fins: low on the flanks behind the gill cover, swept back and out.
      const py = sample(0.2).yc - 0.05;
      tri([sx * 0.048, py + 0.006, zOf(0.185)], [sx * 0.097, py - 0.036, zOf(0.315)], [sx * 0.046, py - 0.008, zOf(0.225)], 3);
      tri([sx * 0.097, py - 0.036, zOf(0.315)], [sx * 0.083, py - 0.042, zOf(0.29)], [sx * 0.046, py - 0.008, zOf(0.225)], 3);
      // Pelvic fins.
      const by = botAt(0.5) + 0.008;
      tri([sx * 0.022, by, zOf(0.49)], [sx * 0.052, by - 0.03, zOf(0.585)], [sx * 0.026, by + 0.002, zOf(0.535)], 3);
    }
  } else {
    fan(
      [0, topAt(0.47), zOf(0.47)],
      [
        [0, topAt(0.4) - 0.004, zOf(0.4)],
        [0, topAt(0.44) + 0.074, zOf(0.455)],
        [0, topAt(0.55) + 0.01, zOf(0.565)],
      ],
      1,
    );
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(PART, 1));
  g.setIndex(I);
  g.computeBoundingSphere();
  body.dispose();
  return g;
}
