// Land cover of summer Kodiak, shared by CPU queries (surfaceAt, forestDensity, vegetation placement) and the terrain
// shader (glsl.js mirrors every formula here; keep them in sync). DOM-free.
//
// Regional factors come from real geography and are baked into a small RGBA8 texture that both sides sample
// bilinearly:  R = Sitka spruce potential (NE Kodiak from Port Lions/Kizhuyak to Chiniak, Afognak, Shuyak, Raspberry,
// Spruce, Woody, Long, Near and Marmot islands; treeless to the south-west), G = developed ground (places.js
// footprints), B = Alaska Peninsula (more snow and bare volcanic ground across Shelikof Strait).
// Drainage (terrain/drainage.js) adds wetness: alder thickets and lush grass follow the gullies.

import { vnoise } from './surface.js';

export const REGION_SIZE = 512;

export function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// Tunables mirrored in glsl.js.
export const COVER = {
  treeline0: 44, // game m (~220 m real): spruce thins out from here
  treeline1: 74, // gone by here (~370 m real)
  forestSlope0: 0.85,
  forestSlope1: 1.35,
  forestShore0: 6, // metres inland where trees may start
  forestShore1: 22,
  beachTop: 1.7, // game m: gravel/sand beach up to about here
  snowLineKodiak: 214,
  snowLinePeninsula: 172,
  rock0: 1.56, // rock score where solid rock starts (score ~ gradient magnitude; 1.56 ~ 57° in game, ~34° real)
  rock1: 1.86,
  ledge0: 1.25, // rock ledges start breaking through the turf
};

// Signed distance (world m) from the directed line a->b; positive to the left of travel (x east, z south).
function sideOf(p, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz) || 1;
  return ((p.x - a.x) * dz - (p.z - a.z) * dx) / len;
}

// Regional texture bytes (RGBA, row 0 = north, like uHeightMap).
export function buildRegion({ geo, half, isDeveloped }) {
  const n = REGION_SIZE;
  const data = new Uint8Array(n * n * 4);
  const cell = (2 * half) / n;
  // Forest line across Kodiak Island: spruce grows north-east of Kizhuyak Bay -> Middle Bay; fades over ~500 m.
  const fa = geo.toWorld(57.9, -153.0);
  const fb = geo.toWorld(57.56, -152.33);
  const kodiak = geo.toWorld(57.79, -152.407);
  const fSign = Math.sign(sideOf(kodiak, fa, fb)) || 1;
  // Northern islands: everything north of Kupreanof Strait/Marmot Bay, east of Shelikof Strait's Kodiak side.
  const na = geo.toWorld(57.955, -153.3);
  const nb = geo.toWorld(57.935, -152.2);
  const afognak = geo.toWorld(58.15, -152.7);
  const nSign = Math.sign(sideOf(afognak, na, nb)) || 1;
  const westCut = geo.toWorld(58.1, -153.18).x;
  // Alaska Peninsula side of Shelikof Strait.
  const pa = geo.toWorld(58.62, -152.95);
  const pb = geo.toWorld(57.45, -155.3);
  const peninsula = geo.toWorld(58.2, -154.4);
  const pSign = Math.sign(sideOf(peninsula, pa, pb)) || 1;
  const south = geo.toWorld(57.5, -152.3).z;
  const p = { x: 0, z: 0 };
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      p.x = -half + (i + 0.5) * cell;
      p.z = -half + (j + 0.5) * cell;
      const ne = smoothstep(-260, 420, fSign * sideOf(p, fa, fb)) * (1 - smoothstep(south - 500, south + 300, p.z));
      const isl = smoothstep(-200, 300, nSign * sideOf(p, na, nb)) * smoothstep(westCut - 400, westCut + 400, p.x);
      const pen = smoothstep(-300, 600, pSign * sideOf(p, pa, pb));
      const spruce = Math.max(ne, isl) * (1 - pen);
      let dev = 0;
      if (isDeveloped) {
        for (let s = 0; s < 4; s++) {
          const ox = ((s & 1) - 0.5) * 0.5 * cell;
          const oz = ((s >> 1) - 0.5) * 0.5 * cell;
          if (isDeveloped(p.x + ox, p.z + oz)) dev += 0.25;
        }
      }
      const k = (j * n + i) * 4;
      data[k] = Math.round(spruce * 255);
      data[k + 1] = Math.round(dev * 255);
      data[k + 2] = Math.round(pen * 255);
      data[k + 3] = 255;
    }
  }
  return data;
}

// ---- Cover formulas (h game m, s = |gradient|, sd = signed shore distance (+ offshore), curv = mean of the
// surroundings minus the point (+ in gullies, - on crests, see gpuPrep INFO_FRAG), wet = drainage 0..1).

export function forestFrom(x, z, h, s, sd, spruce, dev) {
  if (spruce <= 0.001 || dev >= 0.999) return 0;
  const nt = vnoise(x / 160 + 41.7, z / 160 - 13.2);
  const elev = smoothstep(1.2, 4.0, h) * (1 - smoothstep(COVER.treeline0, COVER.treeline1, h + 22 * (nt - 0.5)));
  const steep = 1 - smoothstep(COVER.forestSlope0, COVER.forestSlope1, s);
  const shore = smoothstep(COVER.forestShore0, COVER.forestShore1, -sd);
  const c = spruce * elev * steep * shore * (1 - dev);
  const edge = vnoise(x / 230 - 7.1, z / 230 + 3.3);
  let d = smoothstep(0.42, 0.62, c + (edge - 0.5) * 0.55);
  const glade = vnoise(x / 95 + 19.4, z / 95 + 71.1);
  d *= smoothstep(0.1, 0.3, glade);
  return d;
}

// Sitka alder and salmonberry: thickets along drainages on mid slopes, plus scattered patches.
export function alderFrom(x, z, h, s, forest, dev, wet) {
  const band = smoothstep(4, 16, h) * (1 - smoothstep(92, 136, h));
  const slope = smoothstep(0.1, 0.34, s) * (1 - smoothstep(1.1, 1.45, s));
  const patchN = vnoise(x / 120 + 7.3, z / 120 - 3.9) * 0.7 + vnoise(x / 37 - 2.2, z / 37 + 5.1) * 0.3;
  const thicket = smoothstep(0.42, 0.66, patchN * 0.6 + smoothstep(0.08, 0.38, wet) * 0.62);
  return band * slope * thicket * (1 - forest) * (1 - dev);
}

export function snowFrom(x, z, h, gx, gz, s, pen, curv = 0) {
  const line0 = COVER.snowLineKodiak + (COVER.snowLinePeninsula - COVER.snowLineKodiak) * pen;
  const north = gz / (s + 0.05); // +1 on slopes facing north (-z)
  let line = line0 - 30 * north * smoothstep(0.1, 0.45, s) + 26 * (vnoise(x / 70 + 3.1, z / 70 - 8.4) - 0.5);
  line -= 7 * Math.min(4, Math.max(0, curv)); // snow lingers in gullies
  // Steep volcanic faces and ridges shed their snow (dark rock ribs through the snowfields).
  return smoothstep(line - 7, line + 7, h) * (1 - smoothstep(1.2 - 0.35 * pen, 1.7 - 0.3 * pen, s + 0.25 * pen * Math.max(0, -curv)));
}

// Rock score ~ gradient magnitude, raised on sharp crests, sea cliffs and with altitude (as a multiplier, so round
// summits stay tundra and only steep ground turns to rock). The terrain is vertically exaggerated ~2.35x: a 45° game
// slope is a vegetated ~23° real one, so most slopes stay green.
export function rockScore(x, z, h, s, sd, curv) {
  const crest = Math.min(4, Math.max(0, -curv)) * 0.09 * smoothstep(0.45, 0.9, s);
  const alt = 1 + 0.28 * smoothstep(80, 220, h);
  const sea = 0.3 * (1 - smoothstep(4, 40, -sd)) * smoothstep(0.5, 3, h) * smoothstep(0.35, 0.8, s);
  const n = (vnoise(x / 41 + 5.5, z / 41 - 2.7) - 0.5) * 0.22 + (vnoise(x / 13 - 3.1, z / 13 + 8.2) - 0.5) * 0.12;
  return s * alt + crest + sea + n;
}

export function rockFrom(x, z, h, s, sd, curv) {
  return smoothstep(COVER.rock0, COVER.rock1, rockScore(x, z, h, s, sd, curv));
}

// Scree and talus: loose stone on steep upper slopes and in the gullies below crags.
export function screeFrom(x, z, h, s, rock, wet) {
  const n = vnoise(x / 57 + 1.9, z / 57 - 6.6);
  const high = smoothstep(125, 175, h + 50 * (n - 0.5));
  const steep = smoothstep(0.8, 1.15, s);
  const chute = smoothstep(0.2, 0.45, wet) * smoothstep(0.85, 1.2, s) * smoothstep(80, 130, h);
  const patchy = smoothstep(0.3, 0.55, vnoise(x / 23 - 4.4, z / 23 + 2.8) * 0.6 + n * 0.4);
  return Math.min(1, high * steep * patchy + chute * 0.6) * (1 - rock);
}

// Fireweed / lupine meadow masks (mirror of the GPU cover bake, gpuPrep.js COVER_FRAG).
export function flowersFrom(x, z, h, s, forest, dev, out = [0, 0]) {
  const alpine = smoothstep(95, 150, h);
  const meadow = (1 - alpine) * (1 - smoothstep(0.35, 0.7, s)) * smoothstep(2.5, 5, h) * (1 - forest) * (1 - dev);
  out[0] = smoothstep(0.62, 0.8, vnoise(x / 64 + 12.1, z / 64 + 5.3)) * meadow;
  out[1] = smoothstep(0.7, 0.84, vnoise(x / 48 - 3.7, z / 48 + 22.9)) * meadow * (1 - smoothstep(12, 40, h));
  return out;
}

export function createLandcover({ surface, heightmap, region, half, isDeveloped, curvatureAt = null, wetnessAt = null }) {
  const n = REGION_SIZE;
  const g3 = [0, 0, 0];
  const out3 = [0, 0, 0];
  const curvAt = curvatureAt ?? (() => 0);
  const wetAt = wetnessAt ?? (() => 0);

  // Bilinear region sample (clamped), channels 0..2 in [0, 1] -> out3.
  function regionAt(x, z) {
    const fx = Math.min(n - 1.0001, Math.max(0, ((x + half) / (2 * half)) * n - 0.5));
    const fz = Math.min(n - 1.0001, Math.max(0, ((z + half) / (2 * half)) * n - 0.5));
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const k = (j * n + i) * 4;
    for (let c = 0; c < 3; c++) {
      const a = region[k + c];
      const b = region[k + 4 + c];
      const d = region[k + n * 4 + c];
      const e = region[k + n * 4 + 4 + c];
      out3[c] = ((a * (1 - tx) + b * tx) * (1 - tz) + (d * (1 - tx) + e * tx) * tz) / 255;
    }
    return out3;
  }

  function sample(x, z) {
    surface.smooth(x, z, g3);
    const h = surface.heightAt(x, z);
    const gx = g3[1];
    const gz = g3[2];
    const s = Math.hypot(gx, gz);
    const sd = heightmap.shoreDistance(x, z);
    const r = regionAt(x, z);
    return { h, gx, gz, s, sd, spruce: r[0], dev: Math.max(r[1], isDeveloped?.(x, z) ? 1 : 0), pen: r[2], wet: wetAt(x, z) };
  }

  const api = {
    regionAt,
    flowersFrom,
    noise: vnoise,
    forestFrom,
    alderFrom,
    snowFrom,
    rockFrom,
    rockScore,
    screeFrom,
    sample,
    wetnessAt: wetAt,
    curvatureAt: curvAt,

    // Forest density from a cheap height sampler (bilinear DEM): for far placement where exactness does not matter.
    forestFast(x, z, demAt, texel) {
      const r = regionAt(x, z);
      const spruce = r[0];
      const dev = r[1];
      if (spruce <= 0.001 || dev >= 0.999) return 0;
      const h = demAt(x, z);
      if (h < 1.2) return 0;
      const gx = (demAt(x + texel, z) - demAt(x - texel, z)) / (2 * texel);
      const gz = (demAt(x, z + texel) - demAt(x, z - texel)) / (2 * texel);
      return forestFrom(x, z, h, Math.hypot(gx, gz), heightmap.shoreDistance(x, z), spruce, dev);
    },

    forestDensity(x, z) {
      const q = sample(x, z);
      if (q.h < 0) return 0;
      return forestFrom(x, z, q.h, q.s, q.sd, q.spruce, q.dev);
    },

    alderDensity(x, z) {
      const q = sample(x, z);
      if (q.h < 0) return 0;
      return alderFrom(x, z, q.h, q.s, forestFrom(x, z, q.h, q.s, q.sd, q.spruce, q.dev), q.dev, q.wet);
    },

    // Lakes in the DEM are perfectly flat plateaus above sea level (Karluk, Frazer, Red, Akalura...).
    isLake(x, z, q = sample(x, z)) {
      return q.h > 1.2 && q.s < 0.004 && q.sd < -30;
    },

    surfaceAt(x, z) {
      const q = sample(x, z);
      if (q.h < 0 || api.isLake(x, z, q)) return 'water';
      const curv = curvAt(x, z);
      if (snowFrom(x, z, q.h, q.gx, q.gz, q.s, q.pen, curv) > 0.5) return 'snow';
      const rock = rockFrom(x, z, q.h, q.s, q.sd, curv);
      if (rock > 0.5) return 'rock';
      if (q.h < COVER.beachTop && q.sd > -45) {
        return q.s < 0.1 && vnoise(x / 60, z / 60) > 0.45 ? 'sand' : 'gravel';
      }
      if (screeFrom(x, z, q.h, q.s, rock, q.wet) > 0.5) return 'gravel';
      const f = forestFrom(x, z, q.h, q.s, q.sd, q.spruce, q.dev);
      if (f > 0.5) return 'forest';
      if (alderFrom(x, z, q.h, q.s, f, q.dev, q.wet) > 0.5) return 'alder';
      return 'grass';
    },
  };
  return api;
}
