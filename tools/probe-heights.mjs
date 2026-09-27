import { PNG } from 'pngjs';
import fs from 'node:fs';
const root = new URL('..', import.meta.url).pathname;
const { createHeightmap } = await import(root + '/src/world/heightmap.js');
const { config } = await import(root + '/src/core/config.js');
const { createGeo } = await import(root + '/src/core/geo.js');
const png = PNG.sync.read(fs.readFileSync(root + '/public/terrain/kodiak_height.png'));
const meta = JSON.parse(fs.readFileSync(root + '/public/terrain/kodiak_meta.json'));
const hm = createHeightmap({ size: png.width, pixels: png.data, meta, config });
const geo = createGeo(config.world.half);
const pts = { kodiakCity: [57.79, -152.407], stPaulHarbor: [57.788, -152.40], chiniakBayOff: [57.77, -152.33], nearIsland: [57.785, -152.39], larsenBay: [57.54, -153.98], karluk: [57.57, -154.46], oldHarbor: [57.203, -153.30], akhiok: [56.945, -154.17], portLions: [57.867, -152.88], ouzinkie:[57.924,-152.50], koniag: [57.39, -153.57] };
for (const [k, [lat, lon]] of Object.entries(pts)) {
  const w = geo.toWorld(lat, lon);
  console.log(k.padEnd(14), 'x', w.x.toFixed(0).padStart(6), 'z', w.z.toFixed(0).padStart(6), 'h', hm.heightAt(w.x, w.z).toFixed(1).padStart(7), 'real', hm.realAt(w.x,w.z).toFixed(0).padStart(6), 'shore', hm.shoreDistance(w.x, w.z).toFixed(0));
}
const k = geo.toWorld(57.79, -152.407);
console.log('nearest water to Kodiak city (60 m offshore):', hm.nearestWater(k.x, k.z, { minShore: 60 }));
const w = hm.nearestWater(k.x, k.z, { minShore: 60 });
console.log('at that point h=', hm.heightAt(w.x, w.z).toFixed(1), 'll=', geo.toLatLon(w.x, w.z));
