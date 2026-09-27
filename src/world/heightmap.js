// Real Kodiak archipelago elevation, loaded from public/terrain/kodiak_height.png (see tools/fetch-dem.mjs).
//
// All public queries take world (x, z) in game metres and return game metres:
//   heightAt(x, z)          terrain/seabed height (sea level 0; land scaled by vertScale; seabed depth is the smaller
//                           of depthScale * real depth and the shelf profile shelfBase + shelfSlope * shore distance)
//   realAt(x, z)            source elevation in real metres (for labels: "Koniag Peak 1,360 m")
//   shoreDistance(x, z)     signed distance to the coastline (positive offshore, negative inland), clamped to ±~990 m
//   shoreGradient(x, z, o)  unit vector (o.x, o.z) pointing away from the nearest coast (offshore direction)
//   normalAt(x, z, o)       terrain normal (THREE.Vector3)
//   isWater(x, z)           heightAt < 0
//   depthAt(x, z)           max(0, -heightAt)
//   raymarch(o, d, max)     first terrain hit distance along a ray, or -1
//
// GPU: heightmap.texture is an RG float DataTexture (R = game height, G = signed shore distance), row 0 = north.
// Sample it at uv = ((x + half) / (2 * half), (z + half) / (2 * half)). Published as ctx.uniforms.uHeightMap.

import * as THREE from 'three';

export async function loadHeightmap({ url, metaUrl, config }) {
  const meta = await (await fetch(metaUrl)).json();
  const blob = await (await fetch(url)).blob();
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const size = bitmap.width;
  const canvas = new OffscreenCanvas(size, size);
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.drawImage(bitmap, 0, 0);
  const px = g.getImageData(0, 0, size, size).data;
  bitmap.close?.();
  return createHeightmap({ size, pixels: px, meta, config });
}

// pixels: RGBA bytes (size * size * 4) as decoded from the PNG. Exported separately so Node tests can build one.
export function createHeightmap({ size, pixels, meta, config }) {
  const { offset, scale } = meta.encoding;
  const half = config.world.half;
  const vert = config.world.vertScale;
  const depthScale = config.world.depthScale;
  const outside = config.world.outsideDepth;
  const texel = (2 * half) / size;

  const real = new Float32Array(size * size);
  const game = new Float32Array(size * size);
  const shore = new Float32Array(size * size);
  const { shelfBase, shelfSlope } = config.world;
  for (let k = 0; k < size * size; k++) {
    const h = (pixels[k * 4] * 256 + pixels[k * 4 + 1]) / scale - offset;
    const sd = (pixels[k * 4 + 2] - 128) * texel;
    real[k] = h;
    shore[k] = sd;
    // Underwater, the source bathymetry is coarse near the coast, so depth is also capped by a designed shelf that
    // deepens with distance offshore. This guarantees a shallow band along every beach and deep water mid-bay.
    game[k] = h > 0 ? h * vert : -Math.min(-h * depthScale, shelfBase + Math.max(0, sd) * shelfSlope);
  }

  const texData = new Float32Array(size * size * 2);
  for (let k = 0; k < size * size; k++) {
    texData[k * 2] = game[k];
    texData[k * 2 + 1] = shore[k];
  }
  const texture = new THREE.DataTexture(texData, size, size, THREE.RGFormat, THREE.FloatType);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  // Bilinear sample of a field at world (x, z). Outside the map, fades to `outsideValue` over 600 m.
  function sample(field, x, z, outsideValue) {
    const fx = ((x + half) / (2 * half)) * size - 0.5;
    const fz = ((z + half) / (2 * half)) * size - 0.5;
    const cx = Math.min(size - 1.001, Math.max(0, fx));
    const cz = Math.min(size - 1.001, Math.max(0, fz));
    const x0 = Math.floor(cx);
    const z0 = Math.floor(cz);
    const tx = cx - x0;
    const tz = cz - z0;
    const i = z0 * size + x0;
    const v =
      (field[i] * (1 - tx) + field[i + 1] * tx) * (1 - tz) + (field[i + size] * (1 - tx) + field[i + size + 1] * tx) * tz;
    if (outsideValue === undefined) return v;
    const over = Math.max(Math.abs(x), Math.abs(z)) - half;
    if (over <= 0) return v;
    const f = Math.min(1, over / 600);
    return v + (outsideValue - v) * f;
  }

  const hm = {
    meta,
    size,
    half,
    texel,
    real,
    game,
    shore,
    texture,

    heightAt: (x, z) => sample(game, x, z, outside),
    realAt: (x, z) => sample(real, x, z, outside / depthScale),
    shoreDistance: (x, z) => sample(shore, x, z, 1000),
    isWater: (x, z) => sample(game, x, z, outside) < 0,
    depthAt: (x, z) => Math.max(0, -sample(game, x, z, outside)),

    normalAt(x, z, out = new THREE.Vector3()) {
      const e = texel;
      const hL = hm.heightAt(x - e, z);
      const hR = hm.heightAt(x + e, z);
      const hD = hm.heightAt(x, z - e);
      const hU = hm.heightAt(x, z + e);
      return out.set(hL - hR, 2 * e, hD - hU).normalize();
    },

    shoreGradient(x, z, out = { x: 0, z: 0 }) {
      const e = texel * 2;
      const gx = hm.shoreDistance(x + e, z) - hm.shoreDistance(x - e, z);
      const gz = hm.shoreDistance(x, z + e) - hm.shoreDistance(x, z - e);
      const len = Math.hypot(gx, gz) || 1;
      out.x = gx / len;
      out.z = gz / len;
      return out;
    },

    // Marches a ray (origin THREE.Vector3, unit direction THREE.Vector3) against the terrain. Returns hit distance or -1.
    raymarch(origin, dir, maxDist = 5000, step = texel) {
      let prevT = 0;
      let prevGap = origin.y - hm.heightAt(origin.x, origin.z);
      if (prevGap < 0) return 0;
      for (let t = step; t <= maxDist; t += step) {
        const x = origin.x + dir.x * t;
        const y = origin.y + dir.y * t;
        const z = origin.z + dir.z * t;
        const gap = y - hm.heightAt(x, z);
        if (gap < 0) return prevT + (t - prevT) * (prevGap / (prevGap - gap));
        prevT = t;
        prevGap = gap;
        step *= 1.02;
      }
      return -1;
    },

    // Nearest point to (x, z) that is open water at least `minShore` metres offshore, searching outward in rings.
    // Returns { x, z } or null. Used for spawns (boats, tenders, schools) near a named place.
    nearestWater(x, z, { minShore = 40, maxRadius = 4000 } = {}) {
      if (hm.shoreDistance(x, z) >= minShore) return { x, z };
      const step = texel * 2;
      for (let r = step; r <= maxRadius; r += step) {
        const n = Math.max(8, Math.ceil((2 * Math.PI * r) / step));
        let best = null;
        let bestD = -Infinity;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          const px = x + Math.cos(a) * r;
          const pz = z + Math.sin(a) * r;
          const d = hm.shoreDistance(px, pz);
          if (d >= minShore && d > bestD) {
            bestD = d;
            best = { x: px, z: pz };
          }
        }
        if (best) return best;
      }
      return null;
    },

    // World (x, z) -> texture uv (row 0 = north).
    uv(x, z) {
      return { u: (x + half) / (2 * half), v: (z + half) / (2 * half) };
    },
  };
  return hm;
}
