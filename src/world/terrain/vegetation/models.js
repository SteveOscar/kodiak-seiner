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
    const w = size * 0.4 * Math.sin(Math.PI * Math.min(1, t * 1.2 + 0.06)) ** 0.8 * (1 - 0.45 * t) * (1 + 0.16 * Math.sin(t * 47));
    g.lineTo(size * (0.02 + 0.9 * t), cy - w);
  }
  for (let i = N; i >= 0; i--) {
    const t = i / N;
    const w = size * 0.4 * Math.sin(Math.PI * Math.min(1, t * 1.2 + 0.06)) ** 0.8 * (1 - 0.45 * t) * (1 + 0.16 * Math.sin(t * 41 + 1.7));
    g.lineTo(size * (0.02 + 0.9 * t), cy + w);
  }
  g.closePath();
  g.fill();
  const needle = (x, y, ang, len, fresh, shade) => {
    const c = fresh ? [96, 140, 78] : [36, 70, 48];
    g.strokeStyle = `rgb(${Math.round(c[0] * shade)},${Math.round(c[1] * shade)},${Math.round(c[2] * shade)})`;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    g.stroke();
  };
  // Side branchlets alternate along the main twig, longest a third of the way out.
  const twigLen = size * 0.96;
  const nb = 15;
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
      const w = len * (0.85 + 0.25 * r());
      const droop = len * (0.35 + 0.25 * r());
      const root = [dx * 0.004, y + 0.006, dz * 0.004];
      const tip = [dx * len, y - droop, dz * len];
      // Outward-leaning normals (inner end more upward) give the crown a rounded, soft light.
      const nIn = norm([dx * 0.35, 1, dz * 0.35]);
      const nOut = norm([dx, 0.55, dz]);
      const shadeIn = 0.62 + 0.18 * f;
      const shadeOut = (0.92 + 0.25 * r()) * (0.85 + 0.2 * f);
      const cIn = new THREE.Color(shadeIn, shadeIn, shadeIn);
      const cOut = new THREE.Color(shadeOut, shadeOut, shadeOut);
      // Card A: near-horizontal spray. Card B: the same spray tilted ~65° about the branch axis.
      for (const tilt of [0.12 * (r() - 0.5), 1.1 + 0.3 * (r() - 0.5)]) {
        const ct = Math.cos(tilt);
        const st = Math.sin(tilt);
        // Side vector: horizontal perpendicular (-dz, 0, dx) rotated by `tilt` about the branch axis.
        const sx = -dz * ct * w * 0.5;
        const sy = st * w * 0.5;
        const sz = dx * ct * w * 0.5;
        quad(
          [root[0] - sx * 0.25, root[1] - sy * 0.25, root[2] - sz * 0.25],
          [tip[0] - sx, tip[1] - sy, tip[2] - sz],
          [tip[0] + sx, tip[1] + sy, tip[2] + sz],
          [root[0] + sx * 0.25, root[1] + sy * 0.25, root[2] + sz * 0.25],
          nIn,
          nOut,
          cIn,
          cOut,
          uvs,
        );
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

// Canvas texture of a mass of alder leaves (broad, toothed ovals in several greens, sunlit and shaded), with gaps
// cut out so bush silhouettes are ragged. Albedo is near white-green so vertex colours set the overall shade.
export function leafTexture(size = 256) {
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size });
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, size, size);
  const r = mulberry(7);
  const leaf = (x, y, len, ang, shade, hue) => {
    g.save();
    g.translate(x, y);
    g.rotate(ang);
    g.fillStyle = `rgb(${Math.round((150 + hue * 40) * shade)},${Math.round(215 * shade)},${Math.round((120 - hue * 30) * shade)})`;
    g.beginPath();
    g.ellipse(0, 0, len, len * 0.62, 0, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = `rgba(40,60,30,0.35)`;
    g.lineWidth = Math.max(1, len * 0.08);
    g.beginPath();
    g.moveTo(-len * 0.9, 0);
    g.lineTo(len * 0.9, 0);
    g.stroke();
    g.restore();
  };
  // Draw with wrap-around so the texture tiles.
  for (let k = 0; k < 520; k++) {
    const x = r() * size;
    const y = r() * size;
    const len = size * (0.03 + 0.03 * r());
    const ang = r() * Math.PI;
    const shade = 0.45 + 0.55 * r() * r() + 0.2 * (k / 520);
    const hue = r();
    for (const dx of [-size, 0, size]) for (const dy of [-size, 0, size]) if (x + dx > -len * 2 && x + dx < size + len * 2 && y + dy > -len * 2 && y + dy < size + len * 2) leaf(x + dx, y + dy, len, ang, Math.min(1, shade), hue);
  }
  return canvas;
}

// Alder / salmonberry clump: several lumpy leaf masses with soft outward normals (so it lights like foliage, not
// facets), darker underneath and inside, fresher on top. Height ~1, width ~1.6.
export function shrubGeometry(seed = 1, { blobs = 6, colors = ['#27501f', '#44762f', '#16301a'] } = {}) {
  const r = mulberry(seed);
  const b = new Builder();
  const [cMid, cTop, cBot] = colors.map(lin);
  const ico = new THREE.IcosahedronGeometry(1, 0);
  const pos = ico.attributes.position;
  for (let k = 0; k < blobs; k++) {
    const ang = r() * Math.PI * 2;
    const dist = k === 0 ? 0 : 0.25 + r() * 0.4;
    const cx = Math.cos(ang) * dist;
    const cz = Math.sin(ang) * dist;
    const rad = (k === 0 ? 0.5 : 0.28 + r() * 0.2) * (1 - dist * 0.35);
    const cy = k === 0 ? 0.42 : rad * (0.9 + r() * 0.5) + 0.1 * (1 - dist);
    const phase = r() * 10;
    for (let i = 0; i < pos.count; i += 3) {
      const pts = [];
      const ns = [];
      const cs = [];
      const uvsT = [];
      for (let j = 0; j < 3; j++) {
        const v = [pos.getX(i + j), pos.getY(i + j), pos.getZ(i + j)];
        const d = 1 + 0.2 * lump(v, phase);
        const p = [cx + v[0] * rad * 1.2 * d, Math.max(0, cy + v[1] * rad * 0.95 * d), cz + v[2] * rad * 1.2 * d];
        pts.push(p);
        uvsT.push([(Math.atan2(v[2], v[0]) / Math.PI + 1) * 1.5, (Math.acos(Math.max(-1, Math.min(1, v[1]))) / Math.PI) * 1.5 + k * 0.37]);
        // Normal: blob direction bent away from the clump centre.
        const n = norm([v[0] + p[0] * 0.8, v[1] + 0.35, v[2] + p[2] * 0.8]);
        ns.push(n);
        const up = n[1];
        const c = (up > 0.55 ? cTop : up < 0 ? cBot : cMid).clone().lerp(cMid, 0.35);
        c.multiplyScalar(0.85 + 0.3 * (0.5 + 0.5 * Math.sin(v[0] * 7.1 + v[2] * 5.3 + phase)));
        cs.push(c);
      }
      // Keep the three uvs on one side of the atan2 seam.
      const us = uvsT.map((t) => t[0]);
      if (Math.max(...us) - Math.min(...us) > 1.5) for (const t of uvsT) if (t[0] < 1.5) t[0] += 3;
      for (let j = 0; j < 3; j++) b.vert(pts[j], ns[j], cs[j], uvsT[j]);
    }
  }
  ico.dispose();
  return b.geometry();
}

// Grass tuft: a fountain of tapered single-triangle blades bending outward. Height 1.
export function grassGeometry(seed = 1, { blades = 14 } = {}) {
  const r = mulberry(seed);
  const b = new Builder();
  const cBase = lin('#3f7331');
  const cTip = lin('#9cc062');
  const cDry = lin('#bdb374');
  for (let k = 0; k < blades; k++) {
    const a = r() * Math.PI * 2;
    const rad = Math.sqrt(r()) * 0.16;
    const ox = Math.cos(a) * rad;
    const oz = Math.sin(a) * rad;
    const lean = 0.18 + r() * 0.4;
    const h = 0.5 + r() * 0.5;
    const w = 0.02 + r() * 0.016;
    const dx = Math.cos(a + (r() - 0.5));
    const dz = Math.sin(a + (r() - 0.5));
    const px = -dz * w;
    const pz = dx * w;
    const tip = [ox + dx * lean * h, h, oz + dz * lean * h];
    const n = norm([dx * 0.3, 1, dz * 0.3]);
    const tipC = r() < 0.2 ? cDry : cTip.clone().multiplyScalar(0.85 + 0.3 * r());
    b.tri([ox - px, 0, oz - pz], tip, [ox + px, 0, oz + pz], n, norm([dx * 0.6, 1, dz * 0.6]), n, cBase, tipC, cBase);
  }
  return b.geometry();
}

// Fireweed (Chamaenerion angustifolium): tall stem, narrow leaves, a magenta raceme opening from the bottom. Height 1.
export function fireweedGeometry(seed = 1) {
  const r = mulberry(seed);
  const b = new Builder();
  const stem = lin('#5a3a3a');
  const leaf = lin('#3c6a2c');
  const bloom = lin('#c9307e');
  const bud = lin('#8a2e5c');
  const up = [0, 1, 0];
  const w = 0.012;
  b.tri([-w, 0, 0], [0, 1, 0], [w, 0, 0], [0, 0, 1], null, null, stem);
  b.tri([0, 0, -w], [0, 1, 0], [0, 0, w], [1, 0, 0], null, null, stem);
  for (let i = 0; i < 6; i++) {
    const y = 0.12 + i * 0.07;
    const a = i * 2.4 + r();
    const L = 0.13 - i * 0.012;
    const d = [Math.cos(a), 0, Math.sin(a)];
    const s = [-d[2] * 0.018, 0, d[0] * 0.018];
    b.tri([s[0], y, s[2]], [d[0] * L, y + 0.05, d[2] * L], [-s[0], y, -s[2]], up, null, null, leaf);
  }
  for (let i = 0; i < 10; i++) {
    const y = 0.58 + i * 0.042;
    const a = i * 2.39 + r() * 0.5;
    const L = 0.055 * (1 - i / 14);
    const d = [Math.cos(a), 0, Math.sin(a)];
    const c = i > 7 ? bud : bloom;
    b.tri([0, y - 0.02, 0], [d[0] * L - d[2] * L * 0.6, y + 0.01, d[2] * L + d[0] * L * 0.6], [d[0] * L + d[2] * L * 0.6, y + 0.01, d[2] * L - d[0] * L * 0.6], norm([d[0], 0.6, d[2]]), null, null, c);
  }
  return b.geometry();
}

// Nootka lupine: palmate leaves at the base, a violet-blue flower spike. Height 1.
export function lupineGeometry(seed = 1) {
  const r = mulberry(seed);
  const b = new Builder();
  const leaf = lin('#3f6e39');
  const flower = lin('#5a4fc4');
  const pale = lin('#b9b2e6');
  const up = [0, 1, 0];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + r() * 0.4;
    const d = [Math.cos(a), 0, Math.sin(a)];
    const s = [-d[2] * 0.04, 0, d[0] * 0.04];
    b.tri([0, 0.28, 0], [d[0] * 0.22 + s[0], 0.3, d[2] * 0.22 + s[2]], [d[0] * 0.22 - s[0], 0.3, d[2] * 0.22 - s[2]], up, null, null, leaf);
  }
  const w = 0.01;
  b.tri([-w, 0, 0], [0, 0.95, 0], [w, 0, 0], [0, 0, 1], null, null, leaf);
  for (let i = 0; i < 12; i++) {
    const y = 0.5 + i * 0.038;
    const a = i * 2.39 + r() * 0.4;
    const L = 0.06 * (1 - i / 15);
    const d = [Math.cos(a), 0, Math.sin(a)];
    const c = i > 9 ? pale : flower;
    b.tri([0, y - 0.015, 0], [d[0] * L - d[2] * L * 0.7, y + 0.012, d[2] * L + d[0] * L * 0.7], [d[0] * L + d[2] * L * 0.7, y + 0.012, d[2] * L - d[0] * L * 0.7], norm([d[0], 0.5, d[2]]), null, null, c);
  }
  return b.geometry();
}

// Beach/field boulder: a smooth, lumpy, flat-bottomed stone with lichen on top and a dark wet foot. Radius ~1.
export function boulderGeometry(seed = 1) {
  const r = mulberry(seed);
  const ico = new THREE.IcosahedronGeometry(1, 1);
  const pos = ico.attributes.position;
  const b = new Builder();
  const grey = lin('#6a6a67');
  const dark = lin('#363735');
  const lichen = lin('#8d9178');
  const orange = lin('#a3743a');
  const phase = r() * 10;
  const squash = 0.62 + r() * 0.25;
  const stretch = 0.85 + r() * 0.35;
  const disp = (v) => {
    const d = 1 + 0.16 * lump(v, phase) + 0.05 * Math.sin(9 * v[0] + 7 * v[2] + phase);
    const p = [v[0] * d * stretch, v[1] * d * squash, v[2] * d];
    p[1] = Math.max(p[1], -0.3);
    return p;
  };
  const colorAt = (v, p) => {
    const t = 0.5 + 0.5 * Math.sin(v[0] * 5.7 + v[2] * 4.1 + phase * 3);
    if (p[1] < -0.18) return dark.clone().lerp(grey, 0.25);
    if (v[1] > 0.45 && t > 0.55) return t > 0.93 ? orange : lichen.clone().lerp(grey, 0.3);
    return grey.clone().multiplyScalar(0.82 + 0.3 * t);
  };
  for (let i = 0; i < pos.count; i += 3) {
    const vs = [0, 1, 2].map((j) => norm([pos.getX(i + j), pos.getY(i + j), pos.getZ(i + j)]));
    const ps = vs.map(disp);
    // Smooth shading: normal from the (squashed) sphere direction.
    const ns = vs.map((v) => norm([v[0] / stretch, v[1] / squash, v[2]]));
    const cs = vs.map((v, j) => colorAt(v, ps[j]));
    b.tri(ps[0], ps[1], ps[2], ns[0], ns[1], ns[2], cs[0], cs[1], cs[2]);
  }
  ico.dispose();
  return b.geometry();
}

// Driftwood log along +x (length 1, radius 1; instances scale x by length and y/z by radius): sea-bleached silver
// with darker checks along the grain, a gentle bend, a snapped end, and optionally a root wad at the -x end.
export function driftwoodGeometry(seed = 1, { rootWad = false } = {}) {
  const r = mulberry(seed);
  const b = new Builder();
  const light = lin('#b3aca1');
  const mid = lin('#958d82');
  const check = lin('#5f5850');
  const end = lin('#c2b69f');
  const sides = 8;
  const segs = 6;
  const bend = (r() - 0.5) * 0.25;
  const flat = 0.8 + r() * 0.2;
  const grain = [];
  for (let i = 0; i < sides; i++) grain.push(r() < 0.3 ? check : r() < 0.5 ? mid : light);
  const ring = (t) => {
    const taper = 1 - 0.4 * t;
    const off = Math.sin(t * Math.PI) * bend;
    const pts = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      const wob = 0.92 + 0.12 * Math.sin(a * 3 + t * 9 + bend * 20);
      pts.push([t - 0.5, Math.sin(a) * taper * wob * flat, Math.cos(a) * taper * wob + off]);
    }
    return pts;
  };
  const rings = [];
  for (let s = 0; s <= segs; s++) rings.push(ring(s / segs));
  // Snapped far end: jagged.
  for (let i = 0; i < sides; i++) rings[segs][i][0] += (r() - 0.3) * 0.05;
  for (let s = 0; s < segs; s++) {
    for (let i = 0; i < sides; i++) {
      const a = rings[s][i];
      const bq = rings[s][(i + 1) % sides];
      const c = rings[s + 1][i];
      const d = rings[s + 1][(i + 1) % sides];
      const n0 = norm([0, a[1], a[2] - Math.sin((s / segs) * Math.PI) * bend]);
      const n1 = norm([0, bq[1], bq[2] - Math.sin((s / segs) * Math.PI) * bend]);
      const col = grain[i];
      const col2 = grain[(i + 1) % sides];
      b.tri(a, c, bq, n0, n0, n1, col, col, col2);
      b.tri(bq, c, d, n1, n0, n1, col2, col, col2);
    }
  }
  for (const [s, dir] of [
    [0, -1],
    [segs, 1],
  ]) {
    const cx = s / segs - 0.5;
    const ctr = [cx + dir * 0.01, 0, Math.sin((s / segs) * Math.PI) * bend];
    for (let i = 0; i < sides; i++) {
      const a = rings[s][i];
      const bq = rings[s][(i + 1) % sides];
      if (dir < 0) b.tri(ctr, a, bq, [-1, 0, 0], null, null, end);
      else b.tri(ctr, bq, a, [1, 0, 0], null, null, end);
    }
  }
  if (rootWad) {
    const roots = 9;
    for (let k = 0; k < roots; k++) {
      const a = (k / roots) * Math.PI * 2 + r() * 0.4;
      const len = 1.6 + r() * 1.6;
      const tipP = [-0.5 - 0.05 - r() * 0.12, Math.sin(a) * len, Math.cos(a) * len];
      const w = 0.25;
      const p0 = [-0.5, Math.sin(a - w) * 0.8, Math.cos(a - w) * 0.8];
      const p1 = [-0.5, Math.sin(a + w) * 0.8, Math.cos(a + w) * 0.8];
      const n = norm([-0.6, Math.sin(a), Math.cos(a)]);
      b.tri(p0, tipP, p1, n, null, null, mid);
      b.tri(p1, tipP, p0, [-n[0], -n[1], -n[2]], null, null, mid);
    }
  }
  return b.geometry();
}
