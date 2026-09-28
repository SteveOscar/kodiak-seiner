// Downloads AWS Terrain Tiles (Terrarium encoding) covering the Kodiak archipelago, reprojects them to the game's
// local equirectangular grid and writes public/terrain/kodiak_height.png plus kodiak_meta.json.
//
// Usage: node tools/fetch-dem.mjs [--size=2048] [--zoom=10] [--out=public/terrain]
// Tiles are cached under .cache/tiles/ so re-runs are offline.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const SIZE = Number(args.size ?? 2048);
const ZOOM = Number(args.zoom ?? 10);
const OUT_DIR = path.resolve(ROOT, args.out ?? 'public/terrain');

// Channels the ~1:11.75 compression closes up, re-opened so every seining district is reachable by boat. Each is a
// polyline (lat, lon) following the real waterway, carved `width` game metres wide to `depth` real metres, with
// banks blending back to the source terrain over `bank` game metres. Paths come from a least-cost search over the
// source terrain (they follow the real low ground), recorded here so the asset is reproducible.
const CHANNELS = [
  {
    name: 'Kupreanof Strait',
    width: 110,
    bank: 45,
    depth: 30,
    points: [
      [57.9711, -153.0687], [57.9678, -153.0533], [57.9629, -153.0378], [57.9546, -153.0224], [57.953, -153.007],
      [57.953, -152.9916], [57.953, -152.9762], [57.9546, -152.9608], [57.9579, -152.9454], [57.9596, -152.93],
      [57.9645, -152.9146], [57.9612, -152.8991], [57.9678, -152.8837], [57.9761, -152.8714], [57.9777, -152.856],
      [57.981, -152.8406], [57.9827, -152.8252], [57.9827, -152.8098], [57.9827, -152.7944], [57.9827, -152.7789],
      [57.9893, -152.7635], [57.9975, -152.7481], [57.9992, -152.745],
    ],
  },
  {
    name: 'Akhiok harbor entrance',
    width: 70,
    bank: 30,
    depth: 20,
    points: [[56.9290, -154.1400], [56.9310, -154.1443], [56.9343, -154.1567], [56.9360, -154.1610]],
  },
];

// Geographic frame: a square ~188 km on a side, centred on the island.
const LAT0 = 57.65;
const LON0 = -153.4;
const HALF_KM = 94;
const KM_PER_DEG_LAT = 111.2;
const KM_PER_DEG_LON = 111.32 * Math.cos((LAT0 * Math.PI) / 180);
const WORLD_HALF = 8000; // game metres; +x east, -z north
const HEIGHT_OFFSET = 1000; // encoded = round((h + offset) * scale)
const HEIGHT_SCALE = 4;

const tileX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const tileY = (lat, z) => ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z;

const latMin = LAT0 - HALF_KM / KM_PER_DEG_LAT;
const latMax = LAT0 + HALF_KM / KM_PER_DEG_LAT;
const lonMin = LON0 - HALF_KM / KM_PER_DEG_LON;
const lonMax = LON0 + HALF_KM / KM_PER_DEG_LON;

const tx0 = Math.floor(tileX(lonMin, ZOOM));
const tx1 = Math.floor(tileX(lonMax, ZOOM));
const ty0 = Math.floor(tileY(latMax, ZOOM));
const ty1 = Math.floor(tileY(latMin, ZOOM));
const W = (tx1 - tx0 + 1) * 256;
const H = (ty1 - ty0 + 1) * 256;
const mosaic = new Float32Array(W * H);

await mkdir(path.join(ROOT, '.cache/tiles'), { recursive: true });
let fetched = 0;
for (let ty = ty0; ty <= ty1; ty++) {
  for (let tx = tx0; tx <= tx1; tx++) {
    const file = path.join(ROOT, `.cache/tiles/${ZOOM}_${tx}_${ty}.png`);
    if (!existsSync(file)) {
      const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${ZOOM}/${tx}/${ty}.png`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: ${res.status}`);
      await writeFile(file, Buffer.from(await res.arrayBuffer()));
      fetched++;
    }
    const png = PNG.sync.read(await readFile(file));
    const ox = (tx - tx0) * 256;
    const oy = (ty - ty0) * 256;
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        const i = (y * 256 + x) * 4;
        const h = png.data[i] * 256 + png.data[i + 1] + png.data[i + 2] / 256 - 32768;
        mosaic[(oy + y) * W + ox + x] = h;
      }
    }
  }
}
console.log(`tiles ${tx1 - tx0 + 1}x${ty1 - ty0 + 1} at z${ZOOM} (${fetched} downloaded)`);

function sampleMosaic(px, py) {
  const x = Math.min(W - 1.001, Math.max(0, px));
  const y = Math.min(H - 1.001, Math.max(0, py));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const a = mosaic[y0 * W + x0];
  const b = mosaic[y0 * W + x0 + 1];
  const c = mosaic[(y0 + 1) * W + x0];
  const d = mosaic[(y0 + 1) * W + x0 + 1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

// Supersample 3x3 per output texel to avoid aliasing the higher-resolution source.
const out = new PNG({ width: SIZE, height: SIZE, colorType: 2, inputHasAlpha: false });
const heights = new Float32Array(SIZE * SIZE);
let hMin = Infinity;
let hMax = -Infinity;
for (let j = 0; j < SIZE; j++) {
  for (let i = 0; i < SIZE; i++) {
    let acc = 0;
    for (let sj = 0; sj < 3; sj++) {
      for (let si = 0; si < 3; si++) {
        const u = (i + (si + 0.5) / 3) / SIZE; // 0 = west
        const v = (j + (sj + 0.5) / 3) / SIZE; // 0 = north
        const lon = lonMin + u * (lonMax - lonMin);
        const lat = latMax - v * (latMax - latMin);
        acc += sampleMosaic((tileX(lon, ZOOM) - tx0) * 256, (tileY(lat, ZOOM) - ty0) * 256);
      }
    }
    const h = acc / 9;
    heights[j * SIZE + i] = h;
    hMin = Math.min(hMin, h);
    hMax = Math.max(hMax, h);
  }
}

// Carve channels (after resampling, before the shore-distance transform so the coast follows them).
{
  const gameMetresPerDegLat = (WORLD_HALF / HALF_KM) * KM_PER_DEG_LAT;
  const gameMetresPerDegLon = (WORLD_HALF / HALF_KM) * KM_PER_DEG_LON;
  const texelWorld = (2 * WORLD_HALF) / SIZE;
  let carved = 0;
  for (const ch of CHANNELS) {
    const pts = ch.points.map(([lat, lon]) => ({
      x: (lon - LON0) * gameMetresPerDegLon,
      z: -(lat - LAT0) * gameMetresPerDegLat,
    }));
    const reach = ch.width / 2 + ch.bank;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x - reach); maxX = Math.max(maxX, p.x + reach);
      minZ = Math.min(minZ, p.z - reach); maxZ = Math.max(maxZ, p.z + reach);
    }
    const i0 = Math.max(0, Math.floor((minX + WORLD_HALF) / texelWorld));
    const i1 = Math.min(SIZE - 1, Math.ceil((maxX + WORLD_HALF) / texelWorld));
    const j0 = Math.max(0, Math.floor((minZ + WORLD_HALF) / texelWorld));
    const j1 = Math.min(SIZE - 1, Math.ceil((maxZ + WORLD_HALF) / texelWorld));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = -WORLD_HALF + (i + 0.5) * texelWorld;
        const z = -WORLD_HALF + (j + 0.5) * texelWorld;
        let d = Infinity;
        for (let k = 0; k < pts.length - 1; k++) {
          const a = pts[k], b = pts[k + 1];
          const vx = b.x - a.x, vz = b.z - a.z;
          const t = Math.max(0, Math.min(1, ((x - a.x) * vx + (z - a.z) * vz) / (vx * vx + vz * vz)));
          d = Math.min(d, Math.hypot(x - a.x - vx * t, z - a.z - vz * t));
        }
        if (d >= reach) continue;
        const k = j * SIZE + i;
        const inner = ch.width / 2;
        const target = d <= inner ? -ch.depth : -ch.depth + (heights[k] + ch.depth) * smooth((d - inner) / ch.bank);
        if (target < heights[k]) {
          heights[k] = target;
          carved++;
        }
      }
    }
  }
  console.log(`carved ${carved} texels across ${CHANNELS.length} channel(s)`);
}
function smooth(t) {
  const u = Math.max(0, Math.min(1, t));
  return u * u * (3 - 2 * u);
}

// Remove single-feature spikes (source artefacts, e.g. a 3.2 km needle on Afognak): a texel far above every texel on
// the surrounding radius-3 ring is replaced by that ring's maximum. Real peaks stay well inside the margin.
{
  const R = 3;
  const MARGIN = 450;
  const fixed = heights.slice();
  let spikes = 0;
  for (let j = R; j < SIZE - R; j++) {
    for (let i = R; i < SIZE - R; i++) {
      const h = heights[j * SIZE + i];
      if (h < 300) continue;
      let ringMax = -Infinity;
      for (let o = -R; o <= R; o++) {
        ringMax = Math.max(ringMax, heights[(j - R) * SIZE + i + o], heights[(j + R) * SIZE + i + o],
          heights[(j + o) * SIZE + i - R], heights[(j + o) * SIZE + i + R]);
      }
      if (h > ringMax + MARGIN) { fixed[j * SIZE + i] = ringMax; spikes++; }
    }
  }
  heights.set(fixed);
  hMax = -Infinity;
  for (let k = 0; k < SIZE * SIZE; k++) hMax = Math.max(hMax, heights[k]);
  console.log(`despiked ${spikes} texels`);
}

// Signed distance to the coastline in texels (positive offshore, negative inland), via an exact Euclidean distance
// transform (Felzenszwalb & Huttenlocher) run separately on the land and water masks.
function edt(isFeature) {
  const INF = 1e20;
  const f = new Float64Array(SIZE * SIZE);
  for (let k = 0; k < SIZE * SIZE; k++) f[k] = isFeature(k) ? 0 : INF;
  const d = new Float64Array(SIZE);
  const v = new Int32Array(SIZE);
  const z = new Float64Array(SIZE + 1);
  const line = new Float64Array(SIZE);
  const pass = (get, set) => {
    for (let q = 0; q < SIZE; q++) line[q] = get(q);
    let k = 0;
    v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < SIZE; q++) {
      let s = ((line[q] + q * q) - (line[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((line[q] + q * q) - (line[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < SIZE; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + line[v[k]]; }
    for (let q = 0; q < SIZE; q++) set(q, d[q]);
  };
  for (let x = 0; x < SIZE; x++) pass((q) => f[q * SIZE + x], (q, val) => { f[q * SIZE + x] = val; });
  for (let y = 0; y < SIZE; y++) pass((q) => f[y * SIZE + q], (q, val) => { f[y * SIZE + q] = val; });
  return f;
}
const distToLand = edt((k) => heights[k] > 0);
const distToWater = edt((k) => heights[k] <= 0);

out.data = Buffer.alloc(SIZE * SIZE * 3);
for (let k = 0; k < SIZE * SIZE; k++) {
  const e = Math.max(0, Math.min(65535, Math.round((heights[k] + HEIGHT_OFFSET) * HEIGHT_SCALE)));
  const signed = heights[k] > 0 ? -Math.sqrt(distToWater[k]) : Math.sqrt(distToLand[k]);
  out.data[k * 3] = e >> 8;
  out.data[k * 3 + 1] = e & 255;
  out.data[k * 3 + 2] = Math.max(0, Math.min(255, Math.round(128 + signed)));
}
await mkdir(OUT_DIR, { recursive: true });
const pngBuf = PNG.sync.write(out, { colorType: 2, inputColorType: 2, inputHasAlpha: false });
await writeFile(path.join(OUT_DIR, 'kodiak_height.png'), pngBuf);

const meta = {
  source: 'AWS Terrain Tiles (Terrarium), Mapzen/Linux Foundation; see THIRD_PARTY_NOTICES.md',
  size: SIZE,
  zoom: ZOOM,
  worldHalf: WORLD_HALF,
  lat0: LAT0,
  lon0: LON0,
  latMin, latMax, lonMin, lonMax,
  kmPerDegLat: KM_PER_DEG_LAT,
  kmPerDegLon: KM_PER_DEG_LON,
  encoding: { offset: HEIGHT_OFFSET, scale: HEIGHT_SCALE, note: 'metres = (R*256 + G) / scale - offset; B = 128 + signed distance to coast in texels (positive offshore, clamped); row 0 = north, col 0 = west' },
  realMinMetres: Math.round(hMin),
  realMaxMetres: Math.round(hMax),
};
await writeFile(path.join(OUT_DIR, 'kodiak_meta.json'), JSON.stringify(meta, null, 2) + '\n');

// Preview: hillshaded land, depth-tinted sea. Written to .cache (not shipped).
const PREV = 1024;
const prev = new PNG({ width: PREV, height: PREV });
const step = SIZE / PREV;
const hAt = (i, j) => heights[Math.min(SIZE - 1, Math.max(0, j)) * SIZE + Math.min(SIZE - 1, Math.max(0, i))];
for (let j = 0; j < PREV; j++) {
  for (let i = 0; i < PREV; i++) {
    const si = Math.floor(i * step);
    const sj = Math.floor(j * step);
    const h = hAt(si, sj);
    const dx = hAt(si + 1, sj) - hAt(si - 1, sj);
    const dy = hAt(si, sj + 1) - hAt(si, sj - 1);
    const shade = Math.max(0, Math.min(1, 0.6 + (-dx - dy) * 0.004));
    const k = (j * PREV + i) * 4;
    let r, g, b;
    if (h > 0) {
      const t = Math.min(1, h / 1200);
      r = (70 + 150 * t) * shade; g = (120 + 100 * t) * shade; b = (60 + 150 * t) * shade;
    } else {
      const t = Math.min(1, -h / 300);
      r = 60 - 40 * t; g = 150 - 90 * t; b = 190 - 60 * t;
    }
    prev.data[k] = r; prev.data[k + 1] = g; prev.data[k + 2] = b; prev.data[k + 3] = 255;
  }
}
await writeFile(path.join(ROOT, '.cache/preview.png'), PNG.sync.write(prev));
console.log(`wrote ${path.relative(ROOT, OUT_DIR)}/kodiak_height.png (${(pngBuf.length / 1024).toFixed(0)} KB), range ${Math.round(hMin)}..${Math.round(hMax)} m`);
