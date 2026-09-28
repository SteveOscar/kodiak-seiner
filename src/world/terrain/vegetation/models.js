// Procedural low-poly models for the vegetation and beach layers. All unit-sized (base at y = 0); instances scale
// them. Vertex colours are linear albedo. Deterministic for a given seed.

import * as THREE from 'three';

const lin = (hex) => new THREE.Color(hex);

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Tiny mesh builder: non-indexed triangles with per-vertex normal and colour.
class Builder {
  constructor() {
    this.p = [];
    this.n = [];
    this.c = [];
    this.uv = [];
  }
  vert(p, n, c, uv = [0, 0]) {
    this.p.push(p[0], p[1], p[2]);
    this.n.push(n[0], n[1], n[2]);
    this.c.push(c.r, c.g, c.b);
    this.uv.push(uv[0], uv[1]);
  }
  tri(a, b, c, na, nb, nc, ca, cb, cc) {
    this.vert(a, na, ca);
    this.vert(b, nb ?? na, cb ?? ca);
    this.vert(c, nc ?? na, cc ?? ca);
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.computeBoundingSphere();
    return g;
  }
}

const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const faceN = (a, b, c) => {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  return norm([u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]);
};

// Canvas texture of a Sitka spruce branch spray seen from above: a pinnate spray (central twig, side branchlets
// each clothed in short stiff needles), dark blue-green inside, fresher at the tips, with a ragged, see-through
// outline. The branch runs along +u (u = 0 at the trunk).
export function spruceBranchTexture(size = 256) {
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size });
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, size, size);
  const r = mulberry(99);
  const cy = size / 2;
  g.lineCap = 'round';
  // Backing silhouette: the dense inner foliage, ragged at the edge (lobes = branchlets).
  g.fillStyle = 'rgb(30,58,40)';
  g.beginPath();
  g.moveTo(size * 0.02, cy);
  const N = 40;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const w = size * 0.24 * Math.sin(Math.PI * Math.min(1, t * 1.2 + 0.06)) ** 0.8 * (1 - 0.45 * t) * (1 + 0.22 * Math.sin(t * 47));
    g.lineTo(size * (0.02 + 0.9 * t), cy - w);
  }
  for (let i = N; i >= 0; i--) {
    const t = i / N;
    const w = size * 0.24 * Math.sin(Math.PI * Math.min(1, t * 1.2 + 0.06)) ** 0.8 * (1 - 0.45 * t) * (1 + 0.22 * Math.sin(t * 41 + 1.7));
    g.lineTo(size * (0.02 + 0.9 * t), cy + w);
  }
  g.closePath();
  g.fill();
  const needle = (x, y, ang, len, fresh, shade) => {
    const c = fresh ? [74, 112, 72] : [34, 64, 46];
    g.strokeStyle = `rgb(${Math.round(c[0] * shade)},${Math.round(c[1] * shade)},${Math.round(c[2] * shade)})`;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    g.stroke();
  };
  // Side branchlets alternate along the main twig, longest a third of the way out.
  const twigLen = size * 0.96;
  const nb = 21;
  for (let k = 0; k < nb; k++) {
    const t = (k + 0.5) / nb;
    const x0 = size * 0.02 + twigLen * t;
    const side = k % 2 ? 1 : -1;
    const L = size * 0.5 * Math.sin(Math.PI * Math.min(1, t * 1.15 + 0.08)) * (0.75 + 0.35 * r()) * (1 - 0.4 * t);
    const ang = side * (0.95 + 0.25 * r()) - 0.35 * side * t;
    const ex = x0 + Math.cos(ang - side * 0.9) * L * 0.55;
    const ey = cy + Math.sin(ang) * L;
    // Needles along the branchlet.
    const steps = Math.max(6, Math.round(L / (size * 0.012)));
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      const px = x0 + (ex - x0) * u;
      const py = cy + (ey - cy) * u;
      const fresh = u > 0.55 && t > 0.35 && r() < 0.7;
      const shade = 0.75 + 0.5 * r();
      g.lineWidth = size * 0.0075;
      for (let q = 0; q < 3; q++) {
        const a2 = Math.atan2(ey - cy, ex - x0) + (q - 1) * 1.1 + (r() - 0.5) * 0.5;
        needle(px, py, a2, size * (0.02 + 0.018 * r()) * (1 - 0.4 * u), fresh, shade);
      }
    }
    g.lineWidth = size * 0.008;
    g.strokeStyle = 'rgb(64,52,36)';
    g.beginPath();
    g.moveTo(x0, cy);
    g.lineTo(ex, ey);
    g.stroke();
  }
  // Needles along the main twig and a slightly lighter leader tip.
  for (let i = 0; i < 70; i++) {
    const u = i / 70;
    const px = size * 0.02 + twigLen * u;
    for (let q = 0; q < 2; q++) needle(px, cy, (q ? 1 : -1) * (0.9 + r() * 0.5), size * 0.03, u > 0.8, 0.8 + 0.4 * r());
  }
  g.lineWidth = size * 0.012;
  g.strokeStyle = 'rgb(62,48,34)';
  g.beginPath();
  g.moveTo(0, cy);
  g.lineTo(size * 0.7, cy);
  g.stroke();
  return canvas;
}

// Sitka spruce, height 1: a slim dark core wrapped in whorls of drooping branches. Each branch is a pair of textured
// cards crossed along the branch axis (one near-horizontal, one tilted ~65°), so it reads as a feathery spray from
// the side as well as from above; normals lean outward from the trunk for soft, volumetric light. uv.y < 0 marks the
// untextured core and trunk.
export function spruceGeometry(seed = 1, { tiers = 14, perTier = 7, width = 0.19 } = {}) {
  const r = mulberry(seed);
  const b = new Builder();
  const core = lin('#1d3a24');
  const bark = lin('#4b3d30');
  const noUv = [0, -1];
  const quad = (p0, p1, p2, p3, n0, n1, c0, c1, uv) => {
    b.vert(p0, n0, c0, uv ? uv[0] : noUv);
    b.vert(p1, n1, c1, uv ? uv[1] : noUv);
    b.vert(p2, n1, c1, uv ? uv[2] : noUv);
    b.vert(p0, n0, c0, uv ? uv[0] : noUv);
    b.vert(p2, n1, c1, uv ? uv[2] : noUv);
    b.vert(p3, n0, c0, uv ? uv[3] : noUv);
  };
  const ring = (y, rad, a) => [Math.cos(a) * rad, y, Math.sin(a) * rad];
  for (let i = 0; i < 5; i++) {
    const a0 = (i / 5) * Math.PI * 2;
    const a1 = ((i + 1) / 5) * Math.PI * 2;
    quad(ring(0, 0.014, a0), ring(0, 0.014, a1), ring(0.6, 0.004, a1), ring(0.6, 0.004, a0), [Math.cos(a0), 0, Math.sin(a0)], [Math.cos(a1), 0, Math.sin(a1)], bark, bark);
  }
  const base = 0.07 + r() * 0.04;
  const cs = 6;
  const coreR = width * 0.14;
  for (let i = 0; i < cs; i++) {
    const a0 = (i / cs) * Math.PI * 2;
    const a1 = ((i + 1) / cs) * Math.PI * 2;
    const n0 = norm([Math.cos(a0), 0.35, Math.sin(a0)]);
    const n1 = norm([Math.cos(a1), 0.35, Math.sin(a1)]);
    quad(ring(base, coreR, a0), ring(base, coreR, a1), ring(0.6, coreR * 0.5, a1), ring(0.6, coreR * 0.5, a0), n0, n1, core, core);
    quad(ring(0.6, coreR * 0.5, a0), ring(0.6, coreR * 0.5, a1), ring(0.97, 0.002, a1), ring(0.97, 0.002, a0), n0, n1, core, core);
  }
  const uvs = [
    [0, 0.3],
    [1, 0],
    [1, 1],
    [0, 0.7],
  ];
  for (let t = 0; t < tiers; t++) {
    const f = (t + 0.25 * r()) / tiers;
    const y0 = base + (0.97 - base) * f * 0.94;
    // Crown profile: widest low down, slightly convex, narrowing to a spire.
    const prof = Math.pow(1 - f, 0.85);
    const R = width * prof * (0.92 + 0.22 * r()) + 0.02;
    const rot = r() * Math.PI * 2;
    const n = Math.max(4, Math.round(perTier * (0.7 + 0.45 * prof)));
    for (let i = 0; i < n; i++) {
      const a = rot + ((i + (r() - 0.5) * 0.6) / n) * Math.PI * 2;
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      const y = y0 + ((r() - 0.5) * (1 - base)) / tiers;
      const len = R * (0.85 + 0.35 * r());
      const w = len * (0.62 + 0.2 * r());
      const droop = len * (0.35 + 0.25 * r());
      const root = [dx * 0.004, y + 0.006, dz * 0.004];
      const tip = [dx * len, y - droop, dz * len];
      // Outward-leaning normals (inner end more upward) give the crown a rounded, soft light.
      const nIn = norm([dx * 0.35, 1, dz * 0.35]);
      const nOut = norm([dx, 0.55, dz]);
      const shadeIn = 0.7 + 0.15 * f;
      const shadeOut = (0.92 + 0.25 * r()) * (0.85 + 0.2 * f);
      const cIn = new THREE.Color(shadeIn, shadeIn, shadeIn);
      const cOut = new THREE.Color(shadeOut, shadeOut, shadeOut);
      // Card A: near-horizontal spray. Card B: the same spray tilted ~65° about the branch axis. Each card bends at
      // 55% of its length so the outer half droops like a Sitka spruce bough.
      const mid = [dx * len * 0.55, y - droop * 0.25, dz * len * 0.55];
      const nMid = norm([dx * 0.7, 0.8, dz * 0.7]);
      const cMid = cIn.clone().lerp(cOut, 0.55);
      for (const tilt of [0.12 * (r() - 0.5), 1.1 + 0.3 * (r() - 0.5)]) {
        const ct = Math.cos(tilt);
        const st = Math.sin(tilt);
        // Side vector: horizontal perpendicular (-dz, 0, dx) rotated by `tilt` about the branch axis.
        const sx = -dz * ct * w * 0.5;
        const sy = st * w * 0.5;
        const sz = dx * ct * w * 0.5;
        const P = (c, k) => [c[0] + sx * k, c[1] + sy * k, c[2] + sz * k];
        quad(P(root, -0.25), P(mid, -0.85), P(mid, 0.85), P(root, 0.25), nIn, nMid, cIn, cMid, [
          [0, 0.3],
          [0.55, 0.08],
          [0.55, 0.92],
          [0, 0.7],
        ]);
        quad(P(mid, -0.85), P(tip, -1), P(tip, 1), P(mid, 0.85), nMid, nOut, cMid, cOut, [
          [0.55, 0.08],
          [1, 0],
          [1, 1],
          [0.55, 0.92],
        ]);
      }
    }
  }
  const lc = lin('#284c2e');
  b.vert([-0.006, 0.92, 0], [0, 0, 1], lc, noUv);
  b.vert([0.006, 0.92, 0], [0, 0, 1], lc, noUv);
  b.vert([0, 1.0, 0], [0, 0, 1], lc, noUv);
  return b.geometry();
}

// Deterministic smooth lumpiness on the unit sphere (same value for shared vertices, so no cracks).
function lump(v, k) {
  return Math.sin(3.1 * v[0] + 1.7 * v[1] + k) * Math.sin(2.3 * v[2] - 1.1 * v[0] + 1.9 * k) + 0.5 * Math.sin(5.3 * v[1] + 2.9 * v[2] - k);
}

function makeCanvas(size) {
  return typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size });
}

// Canvas texture of a leafy spray for foliage cards: twigs radiating from the centre, each clothed in broad, toothed
// leaves (Sitka alder: ovate, serrate; salmonberry: paler, trifoliate tips), darker leaves drawn first so the sunlit
// ones sit on top, transparent between them so card edges read as ragged foliage.
export function leafTexture(size = 256, { kind = 'alder' } = {}) {
  const canvas = makeCanvas(size);
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, size, size);
  const r = mulberry(kind === 'alder' ? 7 : 19);
  const c = size / 2;
  const base = kind === 'alder' ? [70, 122, 50] : [86, 128, 56];
  const leaf = (x, y, len, ang, shade) => {
    g.save();
    g.translate(x, y);
    g.rotate(ang);
    const [rr, gg, bb] = base.map((v, i) => Math.round(Math.min(255, v * shade * (i === 1 ? 1 : 0.9 + 0.2 * r()))));
    g.fillStyle = `rgb(${rr},${gg},${bb})`;
    g.beginPath();
    const teeth = 9;
    for (let i = 0; i <= teeth * 2; i++) {
      const a = (i / (teeth * 2)) * Math.PI * 2;
      // Ovate outline (broadest below the middle) with serrated teeth.
      const rx = len * (0.5 + 0.5 * Math.cos(a));
      const w = len * 0.36 * Math.sin(a) * (1 - 0.35 * Math.cos(a));
      const tooth = i % 2 ? 1.1 : 0.94;
      g.lineTo(rx, w * tooth);
    }
    g.closePath();
    g.fill();
    g.strokeStyle = `rgba(${Math.round(rr * 0.62)},${Math.round(gg * 0.78)},${Math.round(bb * 0.62)},0.8)`;
    g.lineWidth = Math.max(1, len * 0.05);
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(len * 0.95, 0);
    for (let v = 1; v < 5; v++) {
      g.moveTo(len * v * 0.19, 0);
      g.lineTo(len * (v * 0.19 + 0.12), len * 0.2);
      g.moveTo(len * v * 0.19, 0);
      g.lineTo(len * (v * 0.19 + 0.12), -len * 0.2);
    }
    g.stroke();
    g.restore();
  };
  // Twigs radiate from the centre; leaves alternate along them, pointing outward.
  const twigs = kind === 'alder' ? 7 : 6;
  const items = [];
  for (let t = 0; t < twigs; t++) {
    const a0 = (t / twigs) * Math.PI * 2 + r() * 0.5;
    const L = size * (0.3 + 0.13 * r());
    const curve = (r() - 0.5) * 0.6;
    g.strokeStyle = 'rgb(92,78,62)';
    g.lineWidth = size * 0.008;
    g.beginPath();
    g.moveTo(c, c);
    const n = kind === 'alder' ? 7 : 5;
    for (let i = 1; i <= n; i++) {
      const u = i / n;
      const a = a0 + curve * u;
      const x = c + Math.cos(a) * L * u;
      const y = c + Math.sin(a) * L * u;
      g.lineTo(x, y);
      const side = i % 2 ? 1 : -1;
      const len = size * (kind === 'alder' ? 0.085 : 0.1) * (0.75 + 0.5 * r()) * (1.1 - 0.3 * u);
      items.push({ x, y, len, ang: a + side * (0.7 + 0.3 * r()), shade: 0.55 + 0.6 * r() });
      if (kind !== 'alder' && i === n) for (const d of [-0.6, 0, 0.6]) items.push({ x, y, len: len * 1.15, ang: a + d, shade: 0.7 + 0.5 * r() });
    }
    g.stroke();
  }
  for (let k = 0; k < 10; k++) {
    const a = r() * Math.PI * 2;
    const d = r() * size * 0.14;
    items.push({ x: c + Math.cos(a) * d, y: c + Math.sin(a) * d, len: size * 0.08 * (0.8 + 0.4 * r()), ang: a, shade: 0.45 + 0.4 * r() });
  }
  items.sort((p, q) => p.shade - q.shade);
  for (const it of items) leaf(it.x, it.y, it.len, it.ang, it.shade);
  return canvas;
}

// Alder / salmonberry bush from foliage cards: a few crooked stems sprawling out of the ground and a canopy of leafy
// cards scattered through a flattened dome, biased to its shell. Normals point out of the dome (blended a little
// toward each card's facing) so the bush lights as one soft volume; vertex shade darkens the underside and interior.
// Height ~1, width ~1.6. uv.y < 0 marks the untextured stems.
export function shrubGeometry(seed = 1, { cards = 34, stems = 4, cardSize = 0.5, shape = [0.78, 0.44, 0.72], centerY = 0.56 } = {}) {
  const r = mulberry(seed);
  const b = new Builder();
  const bark = lin('#3f3833');
  const noUv = [0, -1];
  const [ex, ey, ez] = shape;
  for (let k = 0; k < stems; k++) {
    const a = (k / stems) * Math.PI * 2 + r() * 0.8;
    const top = [Math.cos(a) * ex * 0.55, centerY + ey * (0.1 + 0.4 * r()), Math.sin(a) * ez * 0.55];
    const bot = [Math.cos(a) * 0.05, 0, Math.sin(a) * 0.05];
    for (let i = 0; i < 4; i++) {
      const a0 = (i / 4) * Math.PI * 2;
      const a1 = ((i + 1) / 4) * Math.PI * 2;
      const n0 = norm([Math.cos(a0), 0.2, Math.sin(a0)]);
      const n1 = norm([Math.cos(a1), 0.2, Math.sin(a1)]);
      const A = [bot[0] + Math.cos(a0) * 0.035, 0, bot[2] + Math.sin(a0) * 0.035];
      const B = [bot[0] + Math.cos(a1) * 0.035, 0, bot[2] + Math.sin(a1) * 0.035];
      const C = [top[0] + Math.cos(a1) * 0.012, top[1], top[2] + Math.sin(a1) * 0.012];
      const D = [top[0] + Math.cos(a0) * 0.012, top[1], top[2] + Math.sin(a0) * 0.012];
      b.vert(A, n0, bark, noUv);
      b.vert(B, n1, bark, noUv);
      b.vert(C, n1, bark, noUv);
      b.vert(A, n0, bark, noUv);
      b.vert(C, n1, bark, noUv);
      b.vert(D, n0, bark, noUv);
    }
  }
  for (let k = 0; k < cards; k++) {
    let d;
    do {
      d = [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1];
    } while (d[0] * d[0] + d[1] * d[1] + d[2] * d[2] > 1 || d[1] < -0.75);
    const rr = Math.hypot(d[0], d[1], d[2]) || 1;
    const shell = 0.55 + 0.45 * Math.sqrt(rr);
    const dn = [d[0] / rr, d[1] / rr, d[2] / rr];
    const c = [dn[0] * ex * shell, centerY + dn[1] * ey * shell, dn[2] * ez * shell];
    // Card facing: outward and up, jittered.
    const f = norm([dn[0] * 0.7 + (r() - 0.5) * 0.9, dn[1] * 0.5 + 0.55 + (r() - 0.5) * 0.6, dn[2] * 0.7 + (r() - 0.5) * 0.9]);
    const helper = Math.abs(f[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    const t0 = norm([helper[1] * f[2] - helper[2] * f[1], helper[2] * f[0] - helper[0] * f[2], helper[0] * f[1] - helper[1] * f[0]]);
    const t1 = [f[1] * t0[2] - f[2] * t0[1], f[2] * t0[0] - f[0] * t0[2], f[0] * t0[1] - f[1] * t0[0]];
    const spin = r() * Math.PI * 2;
    const cs = Math.cos(spin);
    const sn = Math.sin(spin);
    const tu = t0.map((v, i) => v * cs + t1[i] * sn);
    const tv = t1.map((v, i) => -t0[i] * sn + v * cs);
    const hs = cardSize * (0.75 + 0.5 * r()) * 0.5;
    const nrm = norm([dn[0] * 0.8 + f[0] * 0.25, dn[1] * 0.8 + f[1] * 0.25 + 0.25, dn[2] * 0.8 + f[2] * 0.25]);
    const outward = 0.5 + 0.5 * dn[1];
    const shade = (0.5 + 0.5 * outward) * (0.55 + 0.45 * shell) * (0.9 + 0.2 * r());
    const col = new THREE.Color(shade, shade, shade);
    const P = (a, q) => [c[0] + (tu[0] * a + tv[0] * q) * hs, c[1] + (tu[1] * a + tv[1] * q) * hs, c[2] + (tu[2] * a + tv[2] * q) * hs];
    const p00 = P(-1, -1);
    const p10 = P(1, -1);
    const p11 = P(1, 1);
    const p01 = P(-1, 1);
    b.vert(p00, nrm, col, [0, 0]);
    b.vert(p10, nrm, col, [1, 0]);
    b.vert(p11, nrm, col, [1, 1]);
    b.vert(p00, nrm, col, [0, 0]);
    b.vert(p11, nrm, col, [1, 1]);
    b.vert(p01, nrm, col, [0, 1]);
  }
  return b.geometry();
}

// Grass clump (bluejoint reedgrass and fescue): a fountain of curved, tapering blades, each two segments and a tip
// (3 triangles), arching outward with a lean that grows toward the tip. Normals lean up and out so the clump lights
// softly from any side (back faces keep the front normal in the foliage material). Vertex colour runs from a dark,
// occluded base to fresh tips, with some dry straw blades. uv.y = height fraction along the blade. Height 1.
export function grassGeometry(seed = 1, { blades = 18, spread = 0.14, dry = 0.14 } = {}) {
  const r = mulberry(seed);
  const b = new Builder();
  const cBase = lin('#23461f');
  const cMid = lin('#4a7a35');
  const cTip = lin('#86ad55');
  const cDry = lin('#b5ad72');
  const cBlue = lin('#4f7d4c');
  for (let k = 0; k < blades; k++) {
    const a = r() * Math.PI * 2;
    const rad = Math.sqrt(r()) * spread;
    const ox = Math.cos(a) * rad;
    const oz = Math.sin(a) * rad;
    const h = 0.45 + r() * 0.55;
    const w = (0.012 + r() * 0.012) * (1.2 - 0.4 * h);
    const lean = (0.12 + r() * 0.45) * (0.6 + rad / spread);
    const dir = a + (r() - 0.5) * 1.2;
    const dx = Math.cos(dir);
    const dz = Math.sin(dir);
    const px = -dz;
    const pz = dx;
    const twist = (r() - 0.5) * 0.8;
    const pt = (t) => {
      const bend = lean * t * t;
      return [ox + dx * bend * h, h * t * (1 - 0.25 * lean * t), oz + dz * bend * h];
    };
    const kind = r();
    const tipC = kind < dry ? cDry : kind < dry + 0.2 ? cBlue : cTip.clone().multiplyScalar(0.85 + 0.3 * r());
    const midC = kind < dry ? cDry.clone().lerp(cMid, 0.5) : cMid;
    const n0 = norm([dx * 0.35, 1, dz * 0.35]);
    const n1 = norm([dx * 0.6, 1, dz * 0.6]);
    const levels = [0, 0.55, 1];
    const widths = [w, w * 0.72, 0];
    const cols = [cBase, midC, tipC];
    const ns = [n0, n1, n1];
    const verts = [];
    for (let i = 0; i < 3; i++) {
      const c = pt(levels[i]);
      const ww = widths[i];
      const tw = twist * levels[i];
      const sx = (px * Math.cos(tw) - dx * Math.sin(tw)) * ww;
      const sz = (pz * Math.cos(tw) - dz * Math.sin(tw)) * ww;
      verts.push([[c[0] - sx, c[1], c[2] - sz], [c[0] + sx, c[1], c[2] + sz]]);
    }
    const V = (lv, side) => verts[lv][side];
    const push = (lv, side) => b.vert(V(lv, side), ns[lv], cols[lv], [side, levels[lv]]);
    // Base quad (two triangles) and the tip triangle.
    push(0, 0); push(1, 0); push(0, 1);
    push(0, 1); push(1, 0); push(1, 1);
    push(1, 0); push(2, 0); push(1, 1);
  }
  return b.geometry();
}

// Fireweed (Chamaenerion angustifolium): a reddish stem with narrow willow-like leaves spiralling up it and a tapering
// raceme on top, open magenta four-petalled flowers below and dark buds toward the nodding tip. Height 1.
export function fireweedGeometry(seed = 1) {
  const r = mulberry(seed);
  const b = new Builder();
  const stem = lin('#6a3a3c');
  const leaf = lin('#3d6a2f');
  const leafPale = lin('#5c7f43');
  const petal = lin('#d23c8e');
  const petalPale = lin('#e274b0');
  const bud = lin('#7e2a55');
  const up = [0, 1, 0];
  const lean = (y) => [0.03 * y * y, 0.02 * y * y];
  const at = (y) => {
    const l = lean(y);
    return [l[0], y, l[1]];
  };
  // Stem: two crossed tapering blades.
  for (const [ax, az] of [
    [1, 0],
    [0, 1],
  ]) {
    const w = 0.011;
    const p0 = at(0);
    const p1 = at(0.97);
    b.tri([p0[0] - ax * w, 0, p0[2] - az * w], [p1[0], p1[1], p1[2]], [p0[0] + ax * w, 0, p0[2] + az * w], [az, 0, ax], null, null, stem);
  }
  // Leaves: lanceolate diamonds, angled up and out, shrinking toward the flowers.
  for (let i = 0; i < 9; i++) {
    const y = 0.08 + i * 0.055;
    const a = i * 2.4 + r() * 0.5;
    const L = (0.13 - i * 0.005) * (0.85 + 0.3 * r());
    const d = [Math.cos(a), 0.45, Math.sin(a)];
    const s = [-Math.sin(a) * 0.022, 0, Math.cos(a) * 0.022];
    const base = at(y);
    const mid = [base[0] + d[0] * L * 0.45, base[1] + d[1] * L * 0.45, base[2] + d[2] * L * 0.45];
    const tip = [base[0] + d[0] * L, base[1] + d[1] * L * 0.8, base[2] + d[2] * L];
    const n = norm([d[0] * 0.3, 1, d[2] * 0.3]);
    const c = r() < 0.5 ? leaf : leafPale;
    b.tri(base, [mid[0] + s[0], mid[1], mid[2] + s[2]], tip, n, null, null, c);
    b.tri(base, tip, [mid[0] - s[0], mid[1], mid[2] - s[2]], n, null, null, c);
  }
  // Raceme: open flowers from 0.58 to 0.84 (flat four-petalled crosses facing out and up, pale at the centre), buds
  // above.
  const eye = lin('#f0b8d8');
  for (let i = 0; i < 10; i++) {
    const y = 0.58 + i * 0.026;
    const a = i * 2.39 + r() * 0.4;
    const out = 0.05 * (1 - i / 20);
    const c0 = at(y);
    const c = [c0[0] + Math.cos(a) * out, c0[1], c0[2] + Math.sin(a) * out];
    const f = norm([Math.cos(a), 0.9, Math.sin(a)]);
    const t1 = norm([-Math.sin(a), 0, Math.cos(a)]);
    const t2 = [f[1] * t1[2] - f[2] * t1[1], f[2] * t1[0] - f[0] * t1[2], f[0] * t1[1] - f[1] * t1[0]];
    const sz = 0.046 * (1 - i / 20) * (0.85 + 0.3 * r());
    const col = r() < 0.3 ? petalPale : petal;
    const petalAt = (k) => {
      const ang = (k / 4) * Math.PI * 2 + a;
      const u = Math.cos(ang) * sz;
      const v = Math.sin(ang) * sz;
      return [c[0] + t1[0] * u + t2[0] * v, c[1] + t1[1] * u + t2[1] * v, c[2] + t1[2] * u + t2[2] * v];
    };
    for (let k = 0; k < 4; k++) b.tri(c, petalAt(k), petalAt(k + 1), f, null, null, eye, col, col);
  }
  for (let i = 0; i < 5; i++) {
    const y = 0.86 + i * 0.022;
    const a = i * 2.39;
    const c0 = at(y);
    const L = 0.022 * (1 - i / 10);
    const d = [Math.cos(a), 0, Math.sin(a)];
    b.tri([c0[0], y - 0.012, c0[2]], [c0[0] + d[0] * L - d[2] * L * 0.5, y + 0.012, c0[2] + d[2] * L + d[0] * L * 0.5], [c0[0] + d[0] * L + d[2] * L * 0.5, y + 0.012, c0[2] + d[2] * L - d[0] * L * 0.5], up, null, null, bud);
  }
  return b.geometry();
}

// Nootka lupine: palmate leaves at the base, a dense violet-blue spike of pea flowers paling toward the tip. Height 1.
export function lupineGeometry(seed = 1) {
  const r = mulberry(seed);
  const b = new Builder();
  const leaf = lin('#3f6e39');
  const leafPale = lin('#6a8f5a');
  const flower = lin('#5448c0');
  const flower2 = lin('#7a64d6');
  const pale = lin('#c3bdea');
  const up = [0, 1, 0];
  // Palmate leaves: 3 leaves of 7 leaflets.
  for (let k = 0; k < 3; k++) {
    const cy = 0.22 + k * 0.06;
    const ca = k * 2.1 + r();
    const cx = Math.cos(ca) * 0.08;
    const cz = Math.sin(ca) * 0.08;
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + r() * 0.3;
      const d = [Math.cos(a), 0, Math.sin(a)];
      const s = [-d[2] * 0.022, 0, d[0] * 0.022];
      const L = 0.12 + r() * 0.04;
      b.tri([cx, cy, cz], [cx + d[0] * L * 0.5 + s[0], cy + 0.012, cz + d[2] * L * 0.5 + s[2]], [cx + d[0] * L, cy + 0.02, cz + d[2] * L], up, null, null, i % 2 ? leaf : leafPale);
      b.tri([cx, cy, cz], [cx + d[0] * L, cy + 0.02, cz + d[2] * L], [cx + d[0] * L * 0.5 - s[0], cy + 0.012, cz + d[2] * L * 0.5 - s[2]], up, null, null, i % 2 ? leaf : leafPale);
    }
  }
  const w = 0.01;
  b.tri([-w, 0, 0], [0, 0.95, 0], [w, 0, 0], [0, 0, 1], null, null, leaf);
  b.tri([0, 0, -w], [0, 0.95, 0], [0, 0, w], [1, 0, 0], null, null, leaf);
  for (let i = 0; i < 13; i++) {
    const y = 0.46 + i * 0.037;
    const a = i * 2.39 + r() * 0.4;
    const L = 0.066 * (1 - i / 17);
    const d = [Math.cos(a), 0, Math.sin(a)];
    const c = i > 10 ? pale : i % 3 ? flower : flower2;
    b.tri([0, y - 0.018, 0], [d[0] * L - d[2] * L * 0.7, y + 0.012, d[2] * L + d[0] * L * 0.7], [d[0] * L + d[2] * L * 0.7, y + 0.012, d[2] * L - d[0] * L * 0.7], norm([d[0], 0.5, d[2]]), null, null, c);
  }
  return b.geometry();
}

// Beach/field boulder: a rounded, faceted, flat-bottomed greywacke stone. Normals blend the smooth sphere with the
// facet so it reads as stone rather than a blob; colour is grey-brown with speckled grain, pale crustose-lichen
// spots and the odd orange Xanthoria patch on top, and a dark, damp foot. Radius ~1.
export function boulderGeometry(seed = 1, { detail = 1 } = {}) {
  const r = mulberry(seed);
  const ico = new THREE.IcosahedronGeometry(1, detail);
  const pos = ico.attributes.position;
  const b = new Builder();
  const grey = lin('#77726a');
  const blue = lin('#686b6c');
  const dark = lin('#34332f');
  const lichen = lin('#9ea38c');
  const orange = lin('#b37d38');
  const phase = r() * 10;
  const squash = 0.6 + r() * 0.25;
  const stretch = 0.85 + r() * 0.35;
  // Two planar cuts give the stone a couple of broken faces.
  const cuts = [0, 1].map(() => {
    const a = r() * Math.PI * 2;
    const e = (r() - 0.2) * 0.9;
    return { n: norm([Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e)]), d: 0.72 + r() * 0.12 };
  });
  const disp = (v) => {
    let d = 1 + 0.14 * lump(v, phase) + 0.04 * Math.sin(9 * v[0] + 7 * v[2] + phase) + 0.025 * Math.sin(17 * v[1] + 13 * v[0] - phase) * Math.sin(15 * v[2] + phase);
    for (const c of cuts) {
      const k = v[0] * c.n[0] + v[1] * c.n[1] + v[2] * c.n[2];
      if (k * d > c.d) d = c.d / k;
    }
    const p = [v[0] * d * stretch, v[1] * d * squash, v[2] * d];
    p[1] = Math.max(p[1], -0.3);
    return p;
  };
  const hash3 = (p) => {
    const h = Math.sin(p[0] * 127.1 + p[1] * 311.7 + p[2] * 74.7 + phase) * 43758.5453;
    return h - Math.floor(h);
  };
  const colorAt = (v, p) => {
    const grain = hash3(v);
    let c = grey.clone().lerp(blue, 0.5 + 0.5 * Math.sin(v[0] * 3.1 + v[1] * 2.3 + phase)).multiplyScalar(0.8 + 0.35 * grain);
    if (p[1] < -0.12) return c.lerp(dark, Math.min(1, (-0.12 - p[1]) * 6));
    if (v[1] > 0.3) {
      const spot = hash3([v[0] * 1.7, v[1] * 2.3, v[2] * 1.3]);
      if (spot > 0.975) c = c.lerp(orange, 0.55);
      else if (spot > 0.62) c = c.lerp(lichen, 0.5);
    }
    return c;
  };
  for (let i = 0; i < pos.count; i += 3) {
    const vs = [0, 1, 2].map((j) => norm([pos.getX(i + j), pos.getY(i + j), pos.getZ(i + j)]));
    const ps = vs.map(disp);
    const fn = faceN(ps[0], ps[1], ps[2]);
    const ns = vs.map((v) => {
      const sn = norm([v[0] / stretch, v[1] / squash, v[2]]);
      const k = detail > 1 ? 0.18 : 0.45;
      return norm([sn[0] * (1 - k) + fn[0] * k, sn[1] * (1 - k) + fn[1] * k, sn[2] * (1 - k) + fn[2] * k]);
    });
    const cs = vs.map((v, j) => colorAt(v, ps[j]));
    b.tri(ps[0], ps[1], ps[2], ns[0], ns[1], ns[2], cs[0], cs[1], cs[2]);
  }
  ico.dispose();
  return b.geometry();
}

// Driftwood log along +x (length 1, radius DRIFT_R0 at the butt; instances scale uniformly by length and y/z by
// radius / (length * DRIFT_R0)): a sea-bleached silver spruce trunk with dark checks along the grain, bulges and
// knots, a crook, snapped branch stubs, a splintered tip, a damp sandy underside, and optionally a root wad at the
// butt (-x end).
export const DRIFT_R0 = 0.035;
export function driftwoodGeometry(seed = 1, { rootWad = false } = {}) {
  const r = mulberry(seed);
  const b = new Builder();
  const silver = lin('#a29b90');
  const pale = lin('#bdb6aa');
  const check = lin('#4e4841');
  const damp = lin('#6b645a');
  const heart = lin('#b59f80');
  const sides = 9;
  const segs = 12;
  const R0 = DRIFT_R0;
  const bend = (r() - 0.5) * 0.05;
  const phase = r() * 10;
  const checks = [];
  for (let i = 0; i < sides; i++) checks.push(r() < 0.35 ? 0.25 + r() * 0.5 : -1);
  const center = (t) => [t - 0.5, 0, Math.sin(t * Math.PI) * bend + Math.sin(t * 7 + phase) * 0.004];
  const radius = (t, a) => {
    const taper = 1 - 0.38 * t;
    const bulge = 1 + 0.07 * Math.sin(t * 13 + phase) + 0.05 * Math.sin(t * 29 + phase * 2) + (rootWad ? 0.35 * Math.max(0, 1 - t * 6) ** 2 : 0);
    const wob = 1 + 0.06 * Math.sin(a * 3 + t * 11 + phase) + 0.04 * Math.sin(a * 5 - t * 7);
    return R0 * taper * bulge * wob;
  };
  const colorAt = (t, i, a) => {
    const down = -Math.sin(a);
    let c = silver.clone().lerp(pale, 0.5 + 0.5 * Math.sin(t * 23 + i * 2.1 + phase));
    if (checks[i] > 0 && Math.abs(Math.sin(t * 9 + i)) < checks[i]) c = c.lerp(check, 0.55);
    if (down > 0.3) c = c.lerp(damp, Math.min(1, (down - 0.3) * 1.4));
    return c;
  };
  const rings = [];
  for (let s = 0; s <= segs; s++) {
    const t = s / segs;
    const ctr = center(t);
    const ring = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      const rad = radius(t, a);
      // Slightly flattened: logs settle onto their broad side.
      ring.push({ p: [ctr[0], Math.sin(a) * rad * 0.88, ctr[2] + Math.cos(a) * rad], n: norm([0, Math.sin(a), Math.cos(a)]), c: colorAt(t, i, a) });
    }
    rings.push(ring);
  }
  // Splintered tip.
  for (let i = 0; i < sides; i++) rings[segs][i].p[0] += (r() - 0.3) * 0.03;
  for (let s = 0; s < segs; s++) {
    for (let i = 0; i < sides; i++) {
      const A = rings[s][i];
      const B = rings[s][(i + 1) % sides];
      const C = rings[s + 1][i];
      const D = rings[s + 1][(i + 1) % sides];
      b.tri(A.p, C.p, B.p, A.n, C.n, B.n, A.c, C.c, B.c);
      b.tri(B.p, C.p, D.p, B.n, C.n, D.n, B.c, C.c, D.c);
    }
  }
  // End caps: pale heartwood at the snapped tip, darker at the butt.
  for (const [s, dir] of [
    [0, -1],
    [segs, 1],
  ]) {
    const c0 = center(s / segs);
    const ctr = [c0[0] + dir * 0.004, 0, c0[2]];
    const col = dir > 0 ? heart : silver.clone().lerp(check, 0.3);
    for (let i = 0; i < sides; i++) {
      const A = rings[s][i].p;
      const B = rings[s][(i + 1) % sides].p;
      if (dir < 0) b.tri(ctr, A, B, [-1, 0, 0], null, null, col);
      else b.tri(ctr, B, A, [1, 0, 0], null, null, col);
    }
  }
  // Snapped branch stubs: short tapered prisms out of the upper half.
  const stubs = 2 + Math.floor(r() * 3);
  for (let k = 0; k < stubs; k++) {
    const t = 0.25 + r() * 0.6;
    const a = Math.PI * (0.15 + 0.7 * r());
    const ctr = center(t);
    const rad = radius(t, a);
    const dirv = norm([0.35 * (r() - 0.3), Math.sin(a), Math.cos(a)]);
    const base = [ctr[0], Math.sin(a) * rad * 0.8, ctr[2] + Math.cos(a) * rad * 0.8];
    const len = R0 * (0.8 + r() * 1.3);
    const tip = [base[0] + dirv[0] * len, base[1] + dirv[1] * len, base[2] + dirv[2] * len];
    const w = R0 * 0.22;
    const ax = norm([1, 0, 0]);
    const side = norm([dirv[1] * ax[2] - dirv[2] * ax[1], dirv[2] * ax[0] - dirv[0] * ax[2], dirv[0] * ax[1] - dirv[1] * ax[0]]);
    const pts = [0, 1, 2].map((j) => {
      const ang = (j / 3) * Math.PI * 2;
      return [base[0] + (ax[0] * Math.cos(ang) + side[0] * Math.sin(ang)) * w, base[1] + (ax[1] * Math.cos(ang) + side[1] * Math.sin(ang)) * w, base[2] + (ax[2] * Math.cos(ang) + side[2] * Math.sin(ang)) * w];
    });
    for (let j = 0; j < 3; j++) {
      const P = pts[j];
      const Q = pts[(j + 1) % 3];
      const n = faceN(P, Q, tip);
      b.tri(P, Q, tip, n, null, null, silver, silver, pale);
    }
  }
  if (rootWad) {
    // Root wad: tapered, crooked roots flaring from the butt.
    const roots = 8 + Math.floor(r() * 4);
    for (let k = 0; k < roots; k++) {
      const a = (k / roots) * Math.PI * 2 + r() * 0.5;
      const len = R0 * (2.2 + r() * 2.6);
      const out = [-0.25 - r() * 0.3, Math.sin(a), Math.cos(a)];
      const base = [-0.5 + 0.01, Math.sin(a) * R0 * 0.9, Math.cos(a) * R0 * 0.9];
      const mid = [base[0] + out[0] * len * 0.5, base[1] + out[1] * len * 0.5 + (r() - 0.5) * R0, base[2] + out[2] * len * 0.5];
      const tip = [base[0] + out[0] * len, base[1] + out[1] * len * (0.8 + 0.3 * r()), base[2] + out[2] * len];
      const w0 = R0 * (0.22 + r() * 0.12);
      const seg = (P0, P1, wa, wb) => {
        const d = norm([P1[0] - P0[0], P1[1] - P0[1], P1[2] - P0[2]]);
        const up = Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
        const s1 = norm([d[1] * up[2] - d[2] * up[1], d[2] * up[0] - d[0] * up[2], d[0] * up[1] - d[1] * up[0]]);
        const s2 = [d[1] * s1[2] - d[2] * s1[1], d[2] * s1[0] - d[0] * s1[2], d[0] * s1[1] - d[1] * s1[0]];
        for (let j = 0; j < 3; j++) {
          const a0 = (j / 3) * Math.PI * 2;
          const a1 = ((j + 1) / 3) * Math.PI * 2;
          const off = (ang, w) => [(s1[0] * Math.cos(ang) + s2[0] * Math.sin(ang)) * w, (s1[1] * Math.cos(ang) + s2[1] * Math.sin(ang)) * w, (s1[2] * Math.cos(ang) + s2[2] * Math.sin(ang)) * w];
          const o0 = off(a0, wa);
          const o1 = off(a1, wa);
          const q0 = off(a0, wb);
          const q1 = off(a1, wb);
          const A = [P0[0] + o0[0], P0[1] + o0[1], P0[2] + o0[2]];
          const B = [P0[0] + o1[0], P0[1] + o1[1], P0[2] + o1[2]];
          const C = [P1[0] + q1[0], P1[1] + q1[1], P1[2] + q1[2]];
          const D = [P1[0] + q0[0], P1[1] + q0[1], P1[2] + q0[2]];
          const nA = norm(o0);
          const nB = norm(o1);
          b.tri(A, B, C, nA, nB, nB, silver, silver, pale);
          b.tri(A, C, D, nA, nB, nA, silver, pale, pale);
        }
      };
      seg(base, mid, w0, w0 * 0.55);
      seg(mid, tip, w0 * 0.55, w0 * 0.08);
    }
  }
  return b.geometry();
}

// Shadow proxy for a conifer crown: a closed cone from the crown base to the tip (the detailed tree's cards would cost
// ~60x the triangles in the shadow pass for a silhouette the soft shadow map cannot resolve anyway). Height 1.
export function crownProxyGeometry({ sides = 7, radius = 0.17, base = 0.1 } = {}) {
  const b = new Builder();
  const c = new THREE.Color(1, 1, 1);
  const tip = [0, 1, 0];
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2;
    const a1 = ((i + 1) / sides) * Math.PI * 2;
    const p0 = [Math.cos(a0) * radius, base, Math.sin(a0) * radius];
    const p1 = [Math.cos(a1) * radius, base, Math.sin(a1) * radius];
    b.tri(p0, tip, p1, faceN(p0, tip, p1), null, null, c);
    b.tri(p1, [0, base, 0], p0, [0, -1, 0], null, null, c);
  }
  return b.geometry();
}

// Canvas texture of a fern frond (lady fern): a rachis along +u with paired, tapering pinnae, each a row of toothed
// pinnules; fresh green, transparent between the leaflets.
export function fernTexture(size = 256) {
  const canvas = makeCanvas(size);
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, size, size);
  const r = mulberry(31);
  const cy = size / 2;
  g.lineCap = 'round';
  const pinnae = 17;
  for (let k = 0; k < pinnae; k++) {
    const t = (k + 0.6) / pinnae;
    const x0 = size * (0.04 + 0.9 * t);
    // Pinnae longest a third of the way up the frond.
    const L = size * 0.44 * Math.sin(Math.PI * Math.min(1, t * 1.15 + 0.06)) ** 0.9 * (1 - 0.35 * t);
    for (const side of [-1, 1]) {
      const ang = side * (1.3 - 0.35 * t);
      const ex = x0 + Math.cos(ang) * L * 0.45;
      const ey = cy + Math.sin(ang) * L;
      const n = Math.max(3, Math.round(L / (size * 0.025)));
      for (let i = 0; i < n; i++) {
        const u = (i + 0.5) / n;
        const px = x0 + (ex - x0) * u;
        const py = cy + (ey - cy) * u;
        const w = size * 0.022 * (1 - 0.7 * u);
        const shade = 0.8 + 0.4 * r();
        g.fillStyle = `rgb(${Math.round(74 * shade)},${Math.round(122 * shade)},${Math.round(50 * shade)})`;
        g.beginPath();
        g.ellipse(px, py, w * 1.15, w * 1.5, Math.atan2(ey - cy, ex - x0), 0, Math.PI * 2);
        g.fill();
      }
      g.strokeStyle = 'rgb(70,104,46)';
      g.lineWidth = size * 0.006;
      g.beginPath();
      g.moveTo(x0, cy);
      g.lineTo(ex, ey);
      g.stroke();
    }
  }
  g.strokeStyle = 'rgb(96,128,60)';
  g.lineWidth = size * 0.007;
  g.beginPath();
  g.moveTo(0, cy);
  g.lineTo(size * 0.9, cy);
  g.stroke();
  return canvas;
}

// Fern clump: fronds arching up and out from a crown, each a textured card bent in three segments (uv.x runs from
// the crown to the tip). Normals lean up and out. Height ~1 (fronds ~1.1 long).
export function fernGeometry(seed = 1, { fronds = 7 } = {}) {
  const r = mulberry(seed);
  const b = new Builder();
  for (let k = 0; k < fronds; k++) {
    const a = (k / fronds) * Math.PI * 2 + r() * 0.6;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    const len = 0.85 + r() * 0.35;
    const rise = 0.75 + r() * 0.25;
    const w = 0.2 + r() * 0.06;
    // Arch: the frond leaves the crown ~55° up and bends over to ~25° down at the tip.
    const pts = [[0, 0, 0]];
    const e0 = (0.8 + 0.3 * r()) * rise;
    let px = 0;
    let py = 0;
    for (let i = 0; i < 3; i++) {
      const el = e0 - (i + 0.5) * 0.45;
      px += Math.cos(el) * len / 3;
      py += Math.sin(el) * len / 3;
      pts.push([dx * px, py, dz * px]);
    }
    const sx = -dz * w * 0.5;
    const sz = dx * w * 0.5;
    const n = norm([dx * 0.4, 1, dz * 0.4]);
    const c0 = new THREE.Color(0.55, 0.55, 0.55);
    const c1 = new THREE.Color(1, 1, 1);
    for (let i = 0; i < 3; i++) {
      const p0 = pts[i];
      const p1 = pts[i + 1];
      const u0 = i / 3;
      const u1 = (i + 1) / 3;
      const k0 = 0.35 + 0.65 * Math.sin(Math.min(1, u0 * 1.4 + 0.1) * Math.PI * 0.95);
      const k1 = 0.35 + 0.65 * Math.sin(Math.min(1, u1 * 1.4 + 0.1) * Math.PI * 0.95);
      const A = [p0[0] - sx * k0, p0[1], p0[2] - sz * k0];
      const B = [p1[0] - sx * k1, p1[1], p1[2] - sz * k1];
      const C = [p1[0] + sx * k1, p1[1], p1[2] + sz * k1];
      const D = [p0[0] + sx * k0, p0[1], p0[2] + sz * k0];
      const ca = c0.clone().lerp(c1, u0);
      const cb = c0.clone().lerp(c1, u1);
      b.vert(A, n, ca, [u0, 0]);
      b.vert(B, n, cb, [u1, 0]);
      b.vert(C, n, cb, [u1, 1]);
      b.vert(A, n, ca, [u0, 0]);
      b.vert(C, n, cb, [u1, 1]);
      b.vert(D, n, ca, [u0, 1]);
    }
  }
  return b.geometry();
}
