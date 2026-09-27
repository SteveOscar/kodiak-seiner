// Parametric displacement hull: a loft of stations from the stem (t = 0, -z) to the transom (t = 1, +z).
// The form gives the sheer, keel, half-beam and section shape; builders produce the shell (with atlas UVs or
// vertex-colour paint bands), the transom, the inner bulwarks, cap rails, decks and the water occluder.

import * as THREE from 'three';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

export const SEINER_FORM = Object.freeze({
  length: 17.7,
  beam: 6.3,
  sheerStern: 2.05,
  sheerRise: 0.35, // linear rise toward the bow
  sheerBow: 1.85, // extra rise concentrated at the bow (the high flared bow)
  sheerPow: 4,
  keel: -1.7,
  forefoot: -0.25, // keel height at the stem
  forefootEnd: 0.28,
  keelStern: -0.45,
  runStart: 0.7,
  maxBeamAt: 0.5,
  entryPow: 2.6, // larger = fuller bow
  sternBeam: 0.9, // transom half-beam fraction
  flareBow: 0.5,
  flareMid: 0.07,
  vBow: 0.38, // how far aft the bow sections stay V-shaped
  bilge: 0.34, // height fraction of the round bilge
  rake: 1.35, // m the forefoot sits aft of the stem head
  rakeLen: 0.22,
  transomRake: 0.35,
  deckAft: 1.15,
  deckFwd: 2.35,
  focsleEnd: 0.27,
  bowBulwark: 1.0, // the foc'sle deck follows the sheer this far below it near the stem
});

export function createHullForm(params = {}) {
  const P = { ...SEINER_FORM, ...params };
  const L = P.length;
  const half = P.beam / 2;
  const form = {
    P,
    L,
    halfBeam: half,
    tOfZ: (z) => (z + L / 2) / L,
    zOfT: (t) => -L / 2 + t * L,
    sheer(t) {
      const f = 1 - t;
      return P.sheerStern + P.sheerRise * f + P.sheerBow * Math.pow(f, P.sheerPow);
    },
    keel(t) {
      if (t < P.forefootEnd) {
        const k = 1 - t / P.forefootEnd;
        return P.keel + (P.forefoot - P.keel) * k * k;
      }
      if (t > P.runStart) return P.keel + (P.keelStern - P.keel) * Math.pow((t - P.runStart) / (1 - P.runStart), 1.6);
      return P.keel;
    },
    beamAt(t) {
      if (t <= P.maxBeamAt) {
        const k = (P.maxBeamAt - t) / P.maxBeamAt;
        return half * (1 - Math.pow(k, P.entryPow));
      }
      const k = (t - P.maxBeamAt) / (1 - P.maxBeamAt);
      return half * (1 - (1 - P.sternBeam) * k * k);
    },
    // Width fraction of the section at height fraction u (0 keel, 1 sheer).
    width(t, u) {
      const ub = P.bilge;
      const round = u < ub ? Math.sqrt(Math.max(0, 1 - (1 - u / ub) ** 2)) : 1;
      const vee = Math.pow(u, 0.9);
      const vb = Math.pow(clamp(1 - t / P.vBow, 0, 1), 1.4);
      const base = round + (vee - round) * vb;
      const flare = P.flareMid + (P.flareBow - P.flareMid) * Math.pow(clamp(1 - t / 0.45, 0, 1), 1.6);
      return base * (1 - flare * Math.pow(1 - u, 1.6));
    },
    // Longitudinal offset of a section point (stem rake near the keel, transom rake at the stern).
    zShift(t, u) {
      let dz = 0;
      if (t < P.rakeLen) dz += P.rake * Math.pow(1 - u, 1.25) * (1 - t / P.rakeLen) ** 2;
      if (t > 0.9) dz += P.transomRake * (u - 0.35) * ((t - 0.9) / 0.1) ** 2;
      return dz;
    },
    point(t, u, out = new THREE.Vector3()) {
      const k = form.keel(t);
      const s = form.sheer(t);
      out.y = k + (s - k) * u;
      out.x = form.beamAt(t) * form.width(t, u);
      out.z = form.zOfT(t) + form.zShift(t, u);
      return out;
    },
    // Half-width of the outer shell at height y for station t (clamped to the section).
    halfWidthAt(t, y) {
      const k = form.keel(t);
      const s = form.sheer(t);
      const u = clamp((y - k) / (s - k), 0, 1);
      return form.beamAt(t) * form.width(t, u);
    },
    deckAt(t) {
      return t < P.focsleEnd ? Math.max(P.deckFwd, form.sheer(t) - P.bowBulwark) : P.deckAft;
    },
  };
  return form;
}

// Row heights (as u fractions) for a station: denser at the bilge and the sheer, plus band rows at fixed heights.
function rowsFor(form, t, rows, bandYs = [], bandSheer = []) {
  const k = form.keel(t);
  const s = form.sheer(t);
  const us = [];
  for (let i = 0; i <= rows; i++) {
    const a = i / rows;
    us.push(0.5 - 0.5 * Math.cos(Math.PI * Math.pow(a, 0.9)));
  }
  for (const y of bandYs) us.push(clamp((y - k) / (s - k), 0.001, 0.999));
  for (const d of bandSheer) us.push(clamp((s - d - k) / (s - k), 0.001, 0.999));
  us.sort((a, b) => a - b);
  return us;
}

// Outer shell, both sides. opts:
//   stations, rows          loft resolution
//   uv: 'atlas' | 'none'    atlas: port side u = 0.5 t, starboard u = 0.5 + 0.5 (1 - t); v from world y
//   atlasY: [y0, y1], atlasV: [v0, v1]
//   paint(t, y, sheerY) -> [r, g, b] sRGB for vertex colours (optional)
//   bandYs, bandSheer       extra rows at absolute heights / depths below the sheer (crisp paint bands)
export function buildShell(form, opts = {}) {
  const stations = opts.stations ?? 56;
  const rows = opts.rows ?? 22;
  const [y0, y1] = opts.atlasY ?? [-2.5, 4.5];
  const [v0, v1] = opts.atlasV ?? [0.25, 1];
  const positions = [];
  const uvs = [];
  const colors = [];
  const indices = [];
  const p = new THREE.Vector3();
  const col = new THREE.Color();
  let rowCount = 0;
  const ts = [];
  for (let i = 0; i < stations; i++) ts.push(Math.pow(i / (stations - 1), 1.25));
  for (const side of [-1, 1]) {
    const base = positions.length / 3;
    for (let i = 0; i < stations; i++) {
      const t = ts[i];
      const us = rowsFor(form, t, rows, opts.bandYs, opts.bandSheer);
      rowCount = us.length;
      const sh = form.sheer(t);
      for (const u of us) {
        form.point(t, u, p);
        positions.push(p.x * side, p.y, p.z);
        const v = v0 + ((p.y - y0) / (y1 - y0)) * (v1 - v0);
        const uu = side < 0 ? 0.5 * t : 0.5 + 0.5 * (1 - t);
        uvs.push(uu, v);
        if (opts.paint) {
          const c = opts.paint(t, p.y, sh);
          col.setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
          colors.push(col.r, col.g, col.b);
        } else {
          colors.push(1, 1, 1);
        }
      }
    }
    for (let i = 0; i < stations - 1; i++) {
      for (let j = 0; j < rowCount - 1; j++) {
        const a = base + i * rowCount + j;
        const b = a + rowCount;
        if (side > 0) indices.push(a, a + 1, b, b, a + 1, b + 1);
        else indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

// Flat transom filling the last station's outline. uvRect maps x/y into an atlas region [u0, v0, u1, v1].
export function buildTransom(form, opts = {}) {
  const rows = opts.rows ?? 22;
  const us = rowsFor(form, 1, rows, opts.bandYs, opts.bandSheer);
  const outline = [];
  const p = new THREE.Vector3();
  for (const u of us) {
    form.point(1, u, p);
    outline.push(p.clone());
  }
  const [u0, v0, u1, v1] = opts.uvRect ?? [0, 0, 0.5, 0.25];
  const xMax = form.beamAt(1) * 1.05;
  const yMin = form.keel(1) - 0.1;
  const yMax = form.sheer(1) + 0.1;
  const positions = [];
  const uvs = [];
  const colors = [];
  const indices = [];
  const col = new THREE.Color();
  const push = (x, y, z) => {
    positions.push(x, y, z);
    uvs.push(u0 + ((x + xMax) / (2 * xMax)) * (u1 - u0), v0 + ((y - yMin) / (yMax - yMin)) * (v1 - v0));
    if (opts.paint) {
      const c = opts.paint(1, y, form.sheer(1));
      col.setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
      colors.push(col.r, col.g, col.b);
    } else colors.push(1, 1, 1);
    return positions.length / 3 - 1;
  };
  // Strips between the port and starboard edges, row by row.
  const left = outline.map((q) => push(-q.x, q.y, q.z));
  const right = outline.map((q) => push(q.x, q.y, q.z));
  for (let j = 0; j < outline.length - 1; j++) {
    indices.push(left[j], right[j], left[j + 1], right[j], right[j + 1], left[j + 1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

// Inside face of the bulwarks from the deck to the sheer, plus the cap rail joining it to the shell.
// Returns { inner, cap } geometries (inner faces inward, cap faces up).
export function buildBulwarks(form, { stations = 40, thickness = 0.1, capWidth = 0.2, tStart = 0.02 } = {}) {
  const inner = { positions: [], indices: [] };
  const cap = { positions: [], indices: [] };
  const ts = [];
  for (let i = 0; i < stations; i++) ts.push(tStart + (1 - tStart) * Math.pow(i / (stations - 1), 1.15));
  for (const side of [-1, 1]) {
    const bi = inner.positions.length / 3;
    const bc = cap.positions.length / 3;
    for (const t of ts) {
      const s = form.sheer(t);
      const d = form.deckAt(t);
      const z = form.zOfT(t) + form.zShift(t, 1);
      const xo = form.halfWidthAt(t, s);
      const xd = form.halfWidthAt(t, Math.min(d, s - 0.05));
      const xi = Math.max(0.05, xo - thickness);
      const xid = Math.max(0.05, xd - thickness);
      inner.positions.push(side * xid, d - 0.02, z, side * xi, s, z);
      const cw = Math.min(capWidth, xo);
      cap.positions.push(side * (xo + 0.035), s + 0.07, z, side * Math.max(0, xo - cw), s + 0.07, z, side * (xo + 0.035), s - 0.02, z, side * Math.max(0, xo - cw), s - 0.02, z);
    }
    for (let i = 0; i < ts.length - 1; i++) {
      const a = bi + i * 2;
      const b = a + 2;
      if (side > 0) inner.indices.push(a, b, a + 1, b, b + 1, a + 1);
      else inner.indices.push(a, a + 1, b, b, a + 1, b + 1);
      const c = bc + i * 4;
      const e = c + 4;
      // top
      if (side > 0) cap.indices.push(c, c + 1, e, e, c + 1, e + 1);
      else cap.indices.push(c, e, c + 1, e, e + 1, c + 1);
      // outer edge
      if (side > 0) cap.indices.push(c + 2, c, e + 2, e + 2, c, e);
      else cap.indices.push(c + 2, e + 2, c, e + 2, e, c);
    }
  }
  const mk = (o) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(o.positions, 3));
    g.setIndex(o.indices);
    g.computeVertexNormals();
    return g;
  };
  return { inner: mk(inner), cap: mk(cap) };
}

// Deck surfaces (foc'sle + main deck) inside the bulwarks, with UVs u = across the beam, v = along the length.
export function buildDecks(form, { stations = 40, thickness = 0.1, focsleStep = true } = {}) {
  const positions = [];
  const uvs = [];
  const indices = [];
  const halfB = form.halfBeam + 0.2;
  const addStrip = (t0, t1, yOf, n) => {
    const base = positions.length / 3;
    for (let i = 0; i <= n; i++) {
      const t = t0 + (t1 - t0) * (i / n);
      const y = yOf(t);
      const z = form.zOfT(t);
      const x = Math.max(0.02, form.halfWidthAt(t, y) - thickness);
      positions.push(-x, y, z, x, y, z);
      uvs.push(0.5 - x / (2 * halfB), 1 - t, 0.5 + x / (2 * halfB), 1 - t);
    }
    for (let i = 0; i < n; i++) {
      const a = base + i * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  };
  const P = form.P;
  addStrip(0.015, P.focsleEnd - 1e-4, (t) => form.deckAt(t), Math.ceil(stations * P.focsleEnd * 1.5));
  addStrip(P.focsleEnd, 0.995, () => P.deckAft, Math.ceil(stations * (1 - P.focsleEnd)));
  if (focsleStep) {
    // Vertical face at the foc'sle break.
    const t = P.focsleEnd;
    const z = form.zOfT(t);
    const x0 = Math.max(0.02, form.halfWidthAt(t, P.deckAft) - thickness);
    const x1 = Math.max(0.02, form.halfWidthAt(t, P.deckFwd) - thickness);
    const b = positions.length / 3;
    positions.push(-x0, P.deckAft, z, x0, P.deckAft, z, -x1, P.deckFwd, z, x1, P.deckFwd, z);
    uvs.push(0, 1 - t, 1, 1 - t, 0, 1 - t + 0.01, 1, 1 - t + 0.01);
    indices.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

// Closed volume inside the hull from the keel up to `topY(t)` (deck level for decked boats, gunwale for open
// skiffs), slightly inset so it never shows through the shell. For water.addOccluder.
export function buildOccluder(form, { stations = 24, inset = 0.08, topY = null } = {}) {
  const positions = [];
  const indices = [];
  const ts = [];
  for (let i = 0; i < stations; i++) ts.push(0.02 + 0.97 * (i / (stations - 1)));
  const top = topY ?? ((t) => form.deckAt(t) - 0.03);
  const cols = 8;
  for (const t of ts) {
    const k = form.keel(t);
    const s = form.sheer(t);
    const yTop = top(t);
    for (let c = 0; c <= cols; c++) {
      // Around the section: port top -> keel -> starboard top.
      const a = c / cols;
      const side = a < 0.5 ? -1 : 1;
      const u = Math.abs(a - 0.5) * 2;
      const y = k + 0.05 + (yTop - k - 0.05) * u;
      const x = Math.max(0, form.halfWidthAt(t, y) - inset) * side;
      // Follow the raked stem and transom (the shell's zShift); anything ahead of the stem would punch a hole in
      // the water surface in front of the bow.
      const uf = clamp((y - k) / (s - k), 0, 1);
      const z = form.zOfT(t) + form.zShift(t, uf) + (t < 0.5 ? inset : -inset);
      positions.push(x, y, z);
    }
  }
  const n = cols + 1;
  for (let i = 0; i < ts.length - 1; i++) {
    for (let c = 0; c < cols; c++) {
      const a = i * n + c;
      const b = a + n;
      indices.push(a, a + 1, b, b, a + 1, b + 1);
    }
    // Lid across the top.
    const a0 = i * n;
    const b0 = a0 + n;
    indices.push(a0, b0, a0 + cols, b0, b0 + cols, a0 + cols);
  }
  // End caps (fan).
  for (const [i, flip] of [[0, true], [ts.length - 1, false]]) {
    const base = i * n;
    for (let c = 1; c < cols; c++) {
      if (flip) indices.push(base, base + c + 1, base + c);
      else indices.push(base, base + c, base + c + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

export { smooth, clamp };
