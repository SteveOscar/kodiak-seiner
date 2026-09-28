// Nautical chart maths (DOM-free): the pan/zoom view, the raster (land tint + hillshade + contours, depth tints +
// depth contours, coastline) built once from the heightmap, sounding selection and greedy label placement.

// ---------------------------------------------------------------- view

// World (x, z) <-> screen pixels for a chart panel of width × height CSS pixels. scale = px per game metre.
export function createChartView({ half = 8000, width = 800, height = 600, margin = 28, maxZoom = 6 } = {}) {
  const v = {
    half,
    width,
    height,
    margin,
    cx: 0,
    cz: 0,
    scale: 1,
    minScale: 1,
    maxScale: 1,
    get zoom() {
      return v.scale / v.minScale;
    },
    resize(w, h) {
      const z = v.minScale > 0 ? v.scale / v.minScale : 1;
      v.width = Math.max(1, w);
      v.height = Math.max(1, h);
      v.minScale = Math.min((v.width - 2 * margin) / (2 * half), (v.height - 2 * margin) / (2 * half));
      v.maxScale = v.minScale * maxZoom;
      v.scale = v.minScale * z;
      v.clamp();
      return v;
    },
    fit() {
      v.cx = 0;
      v.cz = 0;
      v.scale = v.minScale;
      return v;
    },
    clamp() {
      v.scale = Math.min(v.maxScale, Math.max(v.minScale, v.scale));
      // Keep the view centre over the chart; at minimum zoom the whole chart is centred.
      const hx = Math.max(0, half - (v.width / 2 - margin) / v.scale);
      const hz = Math.max(0, half - (v.height / 2 - margin) / v.scale);
      v.cx = Math.min(hx, Math.max(-hx, v.cx));
      v.cz = Math.min(hz, Math.max(-hz, v.cz));
      return v;
    },
    toScreen(x, z, out = { x: 0, y: 0 }) {
      out.x = v.width / 2 + (x - v.cx) * v.scale;
      out.y = v.height / 2 + (z - v.cz) * v.scale;
      return out;
    },
    toWorld(px, py, out = { x: 0, z: 0 }) {
      out.x = v.cx + (px - v.width / 2) / v.scale;
      out.z = v.cz + (py - v.height / 2) / v.scale;
      return out;
    },
    // Zoom by `factor` keeping the world point under (px, py) fixed.
    zoomAt(px, py, factor) {
      const before = v.toWorld(px, py);
      v.scale = Math.min(v.maxScale, Math.max(v.minScale, v.scale * factor));
      v.cx = before.x - (px - v.width / 2) / v.scale;
      v.cz = before.z - (py - v.height / 2) / v.scale;
      return v.clamp();
    },
    pan(dx, dy) {
      v.cx -= dx / v.scale;
      v.cz -= dy / v.scale;
      return v.clamp();
    },
    centerOn(x, z, scale = v.scale) {
      v.scale = scale;
      v.cx = x;
      v.cz = z;
      return v.clamp();
    },
    visibleWorld() {
      const a = v.toWorld(0, 0);
      const b = v.toWorld(v.width, v.height);
      return { x0: a.x, z0: a.z, x1: b.x, z1: b.z };
    },
  };
  return v.resize(width, height).fit();
}

// ---------------------------------------------------------------- palette (sRGB)

const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];

export const CHART_COLORS = {
  landLow: hex('#efe3c0'),
  landHigh: hex('#e6dcc6'),
  shadow: hex('#8c7a5c'),
  contour: hex('#9a7446'),
  coast: hex('#2f3a3c'),
  depthContour: hex('#5d8fa8'),
  // Depth bands in game metres: can't set (< 6 m), leads on bottom (< 16 m), mid, deep.
  bands: [
    { max: 6, color: hex('#9ccbe0') },
    { max: 16, color: hex('#bddcea') },
    { max: 40, color: hex('#d9ecf2') },
    { max: Infinity, color: hex('#eef5f5') },
  ],
};

export const DEPTH_CONTOURS = [6, 16, 40];
export const LAND_CONTOUR = 20; // game metres (100 m real)
export const LAND_INDEX = 100; // every fifth contour (500 m real) is an index contour

// Builds rows [y0, y1) of the chart raster into `out` (RGBA bytes, n × n), sampling the heightmap with an integer
// stride (hm.size / n). Row 0 = north, matching the heightmap.
export function buildChartRows(hm, n, y0, y1, out) {
  const S = hm.size;
  const stride = Math.max(1, Math.round(S / n));
  const game = hm.game;
  const shore = hm.shore;
  const cell = (2 * hm.half) / n; // metres per output pixel
  const C = CHART_COLORS;
  const L = normalize3(-1, 1.35, -1); // light from the north-west, 45°-ish
  const flat = L[1];
  // Sub-sea-level pits inside the land (the shore field calls them land) are charted as low ground, not specks of sea.
  const at = (i, j) => {
    const ii = i < 0 ? 0 : i >= n ? n - 1 : i;
    const jj = j < 0 ? 0 : j >= n ? n - 1 : j;
    const k = jj * stride * S + ii * stride;
    const h = game[k];
    return h <= 0 && shore && shore[k] <= 0 ? 0.5 : h;
  };
  for (let j = y0; j < y1; j++) {
    for (let i = 0; i < n; i++) {
      const h = at(i, j);
      const hl = at(i - 1, j);
      const hr = at(i + 1, j);
      const hu = at(i, j - 1);
      const hd = at(i, j + 1);
      const gx = (hr - hl) / (2 * cell);
      const gz = (hd - hu) / (2 * cell);
      const gpx = Math.max(1e-4, Math.hypot(hr - hl, hd - hu) / 2); // metres per pixel
      let r;
      let g;
      let b;
      if (h > 0) {
        // Hillshade with the terrain's own exaggeration softened; flat ground = 1.
        const nx = -gx * 0.55;
        const nz = -gz * 0.55;
        const inv = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
        const dot = (nx * L[0] + L[1] + nz * L[2]) * inv;
        const s = Math.max(0, Math.min(1.25, dot / flat));
        const t = Math.min(1, h / 260);
        const base0 = C.landLow[0] + (C.landHigh[0] - C.landLow[0]) * t;
        const base1 = C.landLow[1] + (C.landHigh[1] - C.landLow[1]) * t;
        const base2 = C.landLow[2] + (C.landHigh[2] - C.landLow[2]) * t;
        const k = s < 1 ? (1 - s) * 0.55 : 0;
        const lift = s > 1 ? (s - 1) * 0.35 : 0;
        r = base0 + (C.shadow[0] - base0) * k + (255 - base0) * lift;
        g = base1 + (C.shadow[1] - base1) * k + (255 - base1) * lift;
        b = base2 + (C.shadow[2] - base2) * k + (255 - base2) * lift;
        // Contours (anti-aliased by distance to the level in pixels).
        const f = h / LAND_CONTOUR;
        const dl = Math.abs(f - Math.round(f)) * LAND_CONTOUR;
        const isIndex = Math.abs(Math.round(f) * LAND_CONTOUR) % LAND_INDEX < 1e-3;
        const w = isIndex ? 0.75 : 0.45;
        const a = Math.max(0, Math.min(1, w + 0.5 - dl / gpx)) * (isIndex ? 0.5 : 0.28) * Math.min(1, h / 6);
        r += (C.contour[0] - r) * a;
        g += (C.contour[1] - g) * a;
        b += (C.contour[2] - b) * a;
      } else {
        const depth = -h;
        let band = C.bands[C.bands.length - 1];
        let prevMax = 0;
        for (const bd of C.bands) {
          if (depth < bd.max) {
            band = bd;
            break;
          }
          prevMax = bd.max;
        }
        // Within a band, slightly deeper = slightly lighter, for a hand-tinted feel.
        const span = Number.isFinite(band.max) ? band.max - prevMax : 60;
        const tt = Math.min(1, (depth - prevMax) / span) * 0.06;
        r = band.color[0] + (255 - band.color[0]) * tt;
        g = band.color[1] + (255 - band.color[1]) * tt;
        b = band.color[2] + (255 - band.color[2]) * tt;
        for (const lv of DEPTH_CONTOURS) {
          const a = Math.max(0, Math.min(1, 0.95 - Math.abs(depth - lv) / gpx)) * 0.55;
          if (a > 0) {
            r += (C.depthContour[0] - r) * a;
            g += (C.depthContour[1] - g) * a;
            b += (C.depthContour[2] - b) * a;
          }
        }
      }
      // Coastline: the 0 m level, drawn a touch heavier.
      const ca = Math.max(0, Math.min(1, 1.25 - Math.abs(h) / gpx));
      if (ca > 0) {
        r += (C.coast[0] - r) * ca * 0.9;
        g += (C.coast[1] - g) * ca * 0.9;
        b += (C.coast[2] - b) * ca * 0.9;
      }
      const o = (j * n + i) * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = 255;
    }
  }
  return out;
}

function normalize3(x, y, z) {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

// Incremental raster builder: step(maxRows) returns true once complete.
export function createChartBuilder(hm, n = hm.size) {
  const data = new Uint8ClampedArray(n * n * 4);
  let row = 0;
  return {
    n,
    data,
    get done() {
      return row >= n;
    },
    get progress() {
      return row / n;
    },
    step(rows = 16) {
      if (row >= n) return true;
      const end = Math.min(n, row + rows);
      buildChartRows(hm, n, row, end, data);
      row = end;
      return row >= n;
    },
    finish() {
      if (row < n) buildChartRows(hm, n, row, n, data);
      row = n;
      return true;
    },
  };
}

// ---------------------------------------------------------------- soundings

// Sounding points (game metres) on jittered grids: level 0 at `spacing`, level 1 at spacing/2, level 2 at spacing/4.
// Only open water well off the beach.
export function selectSoundings(hm, { spacing = 1400, minShore = 90, minDepth = 3 } = {}) {
  const out = [];
  const half = hm.half;
  const seen = new Set();
  for (let level = 0; level < 3; level++) {
    const sp = spacing / 2 ** level;
    for (let z = -half + sp / 2; z < half; z += sp) {
      for (let x = -half + sp / 2; x < half; x += sp) {
        const key = `${Math.round(x)}:${Math.round(z)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // Deterministic jitter so the numbers do not sit on a visible grid.
        const jx = (hash2(x, z) - 0.5) * sp * 0.6;
        const jz = (hash2(z + 17.3, x - 5.1) - 0.5) * sp * 0.6;
        const px = x + jx;
        const pz = z + jz;
        if (Math.abs(px) > half - 150 || Math.abs(pz) > half - 150) continue;
        if (hm.shoreDistance(px, pz) < minShore) continue;
        const d = hm.depthAt(px, pz);
        if (d < minDepth) continue;
        out.push({ x: px, z: pz, depth: Math.round(d), level });
      }
    }
  }
  return out;
}

function hash2(a, b) {
  const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

// ---------------------------------------------------------------- labels

// Greedy label placement. items: [{ id, x, y (screen anchor), w, h, priority (higher first), anchor: 'point'|'center',
// gap, cands? ([[ox, oy], ...] offsets of the label's top-left from the anchor, tried in order) }]. Labels stay inside
// [left, width] × [top, height]. Returns the placed
// items with { lx, ly } = label top-left; skipped items are omitted. `blocked` is an optional list of rects
// {x, y, w, h} to avoid (the boat, the legend); `out.rects` receives every occupied rect when given.
export function placeLabels(items, { left = 0, top = 0, width = Infinity, height = Infinity, blocked = [], pad = 2, out = null } = {}) {
  const placed = [];
  const rects = blocked.map((r) => ({ ...r }));
  const sorted = [...items].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  for (const it of sorted) {
    const gap = it.gap ?? 5;
    const cands = it.cands ??
      (it.anchor === 'center'
        ? [[-it.w / 2, -it.h / 2]]
        : [
            [gap, -it.h / 2],
            [-it.w - gap, -it.h / 2],
            [-it.w / 2, -it.h - gap],
            [-it.w / 2, gap],
          ]);
    for (const [ox, oy] of cands) {
      const r = { x: it.x + ox, y: it.y + oy, w: it.w, h: it.h };
      if (r.x < left || r.y < top || r.x + r.w > width || r.y + r.h > height) continue;
      if (rects.some((q) => overlap(q, r, pad))) continue;
      rects.push(r);
      placed.push({ ...it, lx: r.x, ly: r.y });
      break;
    }
  }
  if (out) out.rects = rects;
  return placed;
}

function overlap(a, b, pad) {
  return a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
}

// Water features get italic labels on the chart.
export const WATER_KINDS = new Set(['bay', 'strait', 'river', 'lake', 'harbor']);

export function labelPriority(kind) {
  return (
    {
      town: 100,
      village: 80,
      strait: 72,
      bay: 70,
      cannery: 60,
      harbor: 55,
      hatchery: 50,
      cape: 48,
      island: 46,
      peak: 44,
      lake: 42,
      river: 40,
      lighthouse: 30,
      history: 34,
      landmark: 32,
      wildlife: 30,
      viewpoint: 28,
    }[kind] ?? 20
  );
}
