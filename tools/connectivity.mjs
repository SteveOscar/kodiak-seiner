// Navigability check: flood-fills water deep enough for the seiner (inside the soft boundary) and reports which
// named places share the spawn's basin. Writes .cache/connectivity.png (components coloured; red = unreachable).
// Usage: node tools/connectivity.mjs [--res=1024] [--dir=public/terrain] [--minOpenDepth=8] [--boundary=7850]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { PNG } from 'pngjs';
import { config } from '../src/core/config.js';
import { createGeo } from '../src/core/geo.js';
import { createHeightmap } from '../src/world/heightmap.js';
import { PLACES, resolve } from '../src/data/places.js';

const arg = (name, dflt) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? dflt;
const res = Number(arg('res', 1024));
const dir = new URL(`../${arg('dir', 'public/terrain')}/`, import.meta.url);
if (arg('minOpenDepth')) config.world.minOpenDepth = Number(arg('minOpenDepth'));
if (arg('boundary')) config.world.boundary = Number(arg('boundary'));
const png = PNG.sync.read(readFileSync(new URL('kodiak_height.png', dir)));
const meta = JSON.parse(readFileSync(new URL('kodiak_meta.json', dir), 'utf8'));
const hm = createHeightmap({ size: png.width, pixels: png.data, meta, config });
const geo = createGeo(config.world.half);
const half = config.world.half;
const bound = config.world.boundary;
const cell = (2 * half) / res;
const minDepth = config.boat.groundingDepth + 0.3;

const nav = new Uint8Array(res * res);
for (let j = 0; j < res; j++)
  for (let i = 0; i < res; i++) {
    const x = -half + (i + 0.5) * cell;
    const z = -half + (j + 0.5) * cell;
    nav[j * res + i] = Math.abs(x) < bound && Math.abs(z) < bound && hm.heightAt(x, z) < -minDepth ? 1 : 0;
  }
const comp = new Int32Array(res * res).fill(-1);
const sizes = [];
for (let k = 0; k < res * res; k++) {
  if (!nav[k] || comp[k] >= 0) continue;
  const id = sizes.length;
  let n = 0;
  const stack = [k];
  comp[k] = id;
  while (stack.length) {
    const c = stack.pop();
    n++;
    const i = c % res;
    const j = (c / res) | 0;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ii = i + di;
      const jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= res || jj >= res) continue;
      const q = jj * res + ii;
      if (nav[q] && comp[q] < 0) {
        comp[q] = id;
        stack.push(q);
      }
    }
  }
  sizes.push(n);
}
const compAt = (x, z) => {
  // nearest navigable cell within 150 m
  for (let r = 0; r <= 10; r++)
    for (let dj = -r; dj <= r; dj++)
      for (let di = -r; di <= r; di++) {
        const i = Math.floor((x + half) / cell) + di;
        const j = Math.floor((z + half) / cell) + dj;
        if (i < 0 || j < 0 || i >= res || j >= res) continue;
        const c = comp[j * res + i];
        if (c >= 0) return c;
      }
  return -1;
};
const r = resolve(geo);
const spawn = r.places.find((p) => p.id === 'kodiak')?.dock ?? geo.toWorld(57.77, -152.38);
const main = compAt(spawn.x, spawn.z);
console.log(`components: ${sizes.length}; spawn basin #${main} (${((sizes[main] * cell * cell) / 1e6).toFixed(1)} km² game)`);
const big = sizes.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0]).slice(0, 6);
console.log('largest basins:', big.map(([s, i]) => `#${i}:${((s * cell * cell) / 1e6).toFixed(1)}km²`).join(' '));
const unreachable = [];
for (const p of r.places) {
  const target = p.dock ?? p;
  if (!['bay', 'strait', 'harbor', 'cannery', 'village', 'town', 'hatchery', 'cape'].includes(p.kind) && !p.dock) continue;
  const c = compAt(target.x, target.z);
  if (c !== main) unreachable.push(`${p.id}(${p.kind}) basin #${c}`);
}
console.log(`places not reachable from the spawn (${unreachable.length}):\n  ${unreachable.join('\n  ')}`);

const out = new PNG({ width: res, height: res });
const palette = [[40, 120, 200], [230, 60, 60], [230, 170, 40], [150, 60, 200], [40, 190, 120], [220, 100, 200]];
const rank = new Map(big.map(([, i], n) => [i, n]));
for (let k = 0; k < res * res; k++) {
  const c = comp[k];
  let col;
  if (c < 0) {
    const i = k % res;
    const j = (k / res) | 0;
    const h = hm.heightAt(-half + (i + 0.5) * cell, -half + (j + 0.5) * cell);
    col = h > 0 ? [120, 140, 100] : [170, 190, 200];
  } else col = c === main ? [40, 120, 200] : palette[1 + ((rank.get(c) ?? 5) % 5)];
  out.data.set([...col, 255], k * 4);
}
mkdirSync(new URL('../.cache/', import.meta.url), { recursive: true });
writeFileSync(new URL('../.cache/connectivity.png', import.meta.url), PNG.sync.write(out));

// --suggest: least-cost channel from each unreachable basin to the spawn basin (within 3 km), as a lat/lon polyline
// ready for CHANNELS in tools/fetch-dem.mjs.
if (process.argv.includes('--suggest')) {
  const seen = new Set();
  for (const p of r.places) {
    const target = p.dock ?? p;
    const c = compAt(target.x, target.z);
    if (c < 0 || c === main || seen.has(c)) continue;
    seen.add(c);
    const ci = Math.floor((target.x + half) / cell);
    const cj = Math.floor((target.z + half) / cell);
    const span = Math.ceil(Number(arg('span', 3000)) / cell);
    const [x0, y0, x1, y1] = [ci - span, cj - span, ci + span, cj + span].map((v) => Math.max(0, Math.min(res - 1, v)));
    const H = (k) => hm.heightAt(-half + ((k % res) + 0.5) * cell, -half + (((k / res) | 0) + 0.5) * cell);
    const cost = (k) => (nav[k] ? 1 : H(k) < 0 ? 3 : 40 + H(k) * 6);
    const dist = new Float64Array(res * res).fill(Infinity);
    const prev = new Int32Array(res * res).fill(-1);
    const heap = [];
    const push = (d, k) => {
      heap.push([d, k]);
      let i = heap.length - 1;
      while (i > 0) {
        const q = (i - 1) >> 1;
        if (heap[q][0] <= heap[i][0]) break;
        [heap[q], heap[i]] = [heap[i], heap[q]];
        i = q;
      }
    };
    const pop = () => {
      const top = heap[0];
      const last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const rr = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (rr < heap.length && heap[rr][0] < heap[m][0]) m = rr;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return top;
    };
    for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) if (comp[j * res + i] === c) (dist[j * res + i] = 0), push(0, j * res + i);
    let t = -1;
    while (heap.length) {
      const [d, k] = pop();
      if (d > dist[k]) continue;
      if (comp[k] === main) {
        t = k;
        break;
      }
      const i = k % res;
      const j = (k / res) | 0;
      for (const [di, dj, w] of [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]]) {
        const ii = i + di;
        const jj = j + dj;
        if (ii < x0 || jj < y0 || ii > x1 || jj > y1) continue;
        const q = jj * res + ii;
        const nd = d + w * cost(q);
        if (nd < dist[q]) (dist[q] = nd), (prev[q] = k), push(nd, q);
      }
    }
    if (t < 0) {
      console.log(`suggest ${p.id}: no route within 3 km`);
      continue;
    }
    const pts = [];
    for (let k = t; k >= 0; k = prev[k]) pts.push(k);
    const bad = pts.map((k) => !nav[k]);
    const a = Math.max(0, bad.indexOf(true) - 3);
    const b = Math.min(pts.length, bad.lastIndexOf(true) + 4);
    const seg = pts.slice(a, b);
    const ll = seg
      .filter((_, n) => n % 5 === 0 || n === seg.length - 1)
      .map((k) => geo.toLatLon(-half + ((k % res) + 0.5) * cell, -half + (((k / res) | 0) + 0.5) * cell))
      .map((q) => `[${q.lat.toFixed(4)}, ${q.lon.toFixed(4)}]`);
    console.log(`suggest ${p.id}: ${bad.filter(Boolean).length} blocked cells; points: [${ll.join(', ')}]`);
  }
}
