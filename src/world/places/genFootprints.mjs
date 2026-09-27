// Node tool: rebuilds the places layout headlessly and rewrites FOOTPRINTS in src/data/places.js so terrain keeps
// vegetation off every structure. Run after changing any settlement layout:
//   node src/world/places/genFootprints.mjs
// Sites are clustered on a 45 m grid; each cluster becomes one circle covering all of its sites.

import { readFileSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { PNG } from 'pngjs';
import { config, QUALITY } from '../../core/config.js';
import { createGeo } from '../../core/geo.js';
import { createRng } from '../../core/rng.js';
import { createUniforms } from '../../core/uniforms.js';
import { createHeightmap } from '../heightmap.js';

const root = new URL('../../../', import.meta.url);
const png = PNG.sync.read(readFileSync(new URL('public/terrain/kodiak_height.png', root)));
const meta = JSON.parse(readFileSync(new URL('public/terrain/kodiak_meta.json', root), 'utf8'));

export async function buildLayoutHeadless() {
  const heightmap = createHeightmap({ size: png.width, pixels: png.data, meta, config });
  const ctx = {
    THREE,
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    renderer: null,
    pipeline: { beforeRender: () => () => {}, afterRender: () => () => {}, onResize() {} },
    config,
    quality: QUALITY.high,
    geo: createGeo(config.world.half),
    rng: createRng(1),
    uniforms: createUniforms(),
    heightmap,
    systems: {},
    clock: { hours: 12, day: 0 },
    time: { elapsed: 0 },
  };
  const { create } = await import('../places.js');
  return { sys: await create(ctx), ctx };
}

export function clusterSites(sites, cell = 45) {
  const cells = new Map();
  for (const s of sites) {
    const k = `${Math.floor(s.x / cell)},${Math.floor(s.z / cell)}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(s);
  }
  const out = [];
  for (const list of cells.values()) {
    const cx = list.reduce((a, s) => a + s.x, 0) / list.length;
    const cz = list.reduce((a, s) => a + s.z, 0) / list.length;
    let r = 0;
    for (const s of list) r = Math.max(r, Math.hypot(s.x - cx, s.z - cz) + s.r);
    out.push({ x: cx, z: cz, r: Math.ceil(r) });
  }
  return out.sort((a, b) => a.x - b.x || a.z - b.z);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { sys, ctx } = await buildLayoutHeadless();
  const circles = clusterSites(sys.layout.sites);
  const kinds = ['town', 'village', 'cannery', 'hatchery', 'landmark', 'history', 'harbor', 'lighthouse', 'peak', 'viewpoint', 'cape'];
  const counts = {};
  const r5 = (v) => Math.round(v * 1e5) / 1e5;
  const lines = circles.map((c) => {
    const id = sys.nearest(c.x, c.z, (p) => kinds.includes(p.kind))?.place.id ?? 'site';
    counts[id] = (counts[id] ?? 0) + 1;
    const ll = ctx.geo.toLatLon(c.x, c.z);
    return `  { id: '${id}-${counts[id]}', lat: ${r5(ll.lat)}, lon: ${r5(ll.lon)}, radius: ${c.r} },`;
  });
  const file = new URL('src/data/places.js', root);
  const src = readFileSync(file, 'utf8');
  const a = src.indexOf('export const FOOTPRINTS = [');
  const b = src.indexOf('];', a);
  if (a < 0 || b < 0) throw new Error('FOOTPRINTS array not found');
  const next = `${src.slice(0, a)}export const FOOTPRINTS = [\n${lines.join('\n')}\n${src.slice(b)}`;
  writeFileSync(file, next);
  console.log(`sites ${sys.layout.sites.length} -> footprints ${lines.length}`);
}
