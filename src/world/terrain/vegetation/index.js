// Vegetation and shore dressing: Sitka spruce (3D near, impostors to ~2.7 km), alder/salmonberry clumps, grass tufts,
// fireweed and lupine, beach boulders, driftwood and bull kelp. Placement is deterministic per world cell, reads the
// same land-cover functions as the terrain shader and never lands on developed ground (places.js isDeveloped).
// Density and ranges scale with quality.vegetation.

import * as THREE from 'three';
import { createTileScatter, cellRandom } from './scatter.js';
import { createInstancedMaterial, createInstancedLayer } from './common.js';
import {
  spruceBranchTexture,
  spruceGeometry,
  shrubGeometry,
  leafTexture,
  grassGeometry,
  fireweedGeometry,
  lupineGeometry,
  boulderGeometry,
  driftwoodGeometry,
} from './models.js';
import { bakeImpostors, createImpostorMaterial, createImpostorTile } from './impostor.js';
import { createKelpLayer } from './kelp.js';
import { smoothstep } from '../landcover.js';

const TREE_CELL = 7;

// Merge variant geometries (non-indexed, same attributes) into one, for single-draw layers.
function mergeVariants(list) {
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'color', 'uv']) {
    const arrays = list.map((g) => g.attributes[name]?.array).filter(Boolean);
    if (arrays.length !== list.length) continue;
    const total = arrays.reduce((a, b) => a + b.length, 0);
    const merged = new Float32Array(total);
    let o = 0;
    for (const a of arrays) {
      merged.set(a, o);
      o += a.length;
    }
    out.setAttribute(name, new THREE.BufferAttribute(merged, list[0].attributes[name].itemSize));
  }
  return out;
}

export function createVegetation({ ctx, surface, landcover, heightmap, demAt, texel, isDeveloped, sunScale, seed }) {
  const { scene, camera, uniforms, quality, renderer } = ctx;
  const q = quality?.vegetation ?? 1;
  const rand = cellRandom(seed);
  const dev = (x, z) => (isDeveloped ? isDeveloped(x, z) : false);
  const group = new THREE.Group();
  group.name = 'vegetation';
  scene.add(group);
  const layers = [];

  // ---- Sitka spruce: one placement function shared by the 3D and impostor layers so they swap in place.
  const spruceRange = { near: 72 * Math.min(1.15, 0.75 + 0.25 * q), far: q < 0.5 ? 1500 : 2300 };
  function spruceAt(ix, iz, push, exact) {
    const x = (ix + 0.12 + 0.76 * rand(ix, iz, 1)) * TREE_CELL;
    const z = (iz + 0.12 + 0.76 * rand(ix, iz, 2)) * TREE_CELL;
    const fd = landcover.forestFast(x, z, demAt, texel);
    if (fd <= 0.02) return;
    if (rand(ix, iz, 3) > fd * Math.min(1, 0.6 + 0.4 * q) * 0.94) return;
    if (dev(x, z)) return;
    const hgt = (8.5 + 8.5 * rand(ix, iz, 4)) * (0.5 + 0.5 * fd) * (rand(ix, iz, 9) < 0.08 ? 0.5 : 1);
    const y = exact ? surface.heightAt(x, z) - 0.25 : demAt(x, z) - 0.6;
    if (y < 0.4) return;
    const yaw = rand(ix, iz, 5) * Math.PI * 2;
    push(x, y, z, hgt, Math.cos(yaw), Math.sin(yaw), (rand(ix, iz, 6) - 0.5) * 2, rand(ix, iz, 7));
  }

  const branchMap = new THREE.CanvasTexture(spruceBranchTexture(256));
  branchMap.colorSpace = THREE.SRGBColorSpace;
  branchMap.wrapS = branchMap.wrapT = THREE.ClampToEdgeWrapping;
  branchMap.anisotropy = 4;
  const spruceVariants = [1, 2, 3, 4].map((s, i) => spruceGeometry(seed + s * 101, { tiers: 13 + (i % 3), perTier: 7, width: 0.15 + 0.02 * (i % 3) }));
  // 3D near trees: one instanced mesh per variant (the variant follows from the per-tree rank).
  const spruceNearMat = createInstancedMaterial({
    uniforms,
    sunScale,
    fade: [0, 0, spruceRange.near - 22, spruceRange.near],
    fadeMode: 'dither',
    wind: 0.012,
    windStiff: 1.6,
    tintAmount: 0.18,
    name: 'spruce',
    cardMap: true,
    foliage: true,
    standard: { roughness: 0.92, side: THREE.DoubleSide, map: branchMap, alphaTest: 0.5 },
  });
  const spruceLayers = spruceVariants.map((g, i) => {
    const L = createInstancedLayer({ geometry: g, material: spruceNearMat.material, depthMaterial: spruceNearMat.depthMaterial, capacity: 1200, name: `spruce-${i}`, castShadow: true });
    group.add(L.mesh);
    return L;
  });
  const spruceScatter = createTileScatter({
    name: 'spruce',
    tileSize: 40,
    radius: spruceRange.near + 10,
    stride: 8,
    capacity: 9000,
    generate(tx, tz, x0, z0, size, push) {
      const i0 = Math.floor(x0 / TREE_CELL);
      const i1 = Math.floor((x0 + size) / TREE_CELL);
      const j0 = Math.floor(z0 / TREE_CELL);
      const j1 = Math.floor((z0 + size) / TREE_CELL);
      for (let iz = j0; iz < j1; iz++) for (let ix = i0; ix < i1; ix++) spruceAt(ix, iz, push, true);
    },
  });
  const spruceSplit = spruceVariants.map(() => ({ data: new Float32Array(1200 * 8), n: 0 }));
  layers.push({
    scatter: spruceScatter,
    upload() {
      for (const s of spruceSplit) s.n = 0;
      const d = spruceScatter.data;
      for (let i = 0; i < spruceScatter.count; i++) {
        const v = Math.floor(d[i * 8 + 7] * 997) % spruceSplit.length;
        const s = spruceSplit[v];
        if (s.n >= 1200) continue;
        s.data.set(d.subarray(i * 8, i * 8 + 8), s.n * 8);
        s.n++;
      }
      spruceSplit.forEach((s, i) => spruceLayers[i].upload(s.data, s.n, 8));
    },
  });

  // Impostors: 512 m tiles generated incrementally, drawn per tile (frustum-culled by three).
  const atlas = bakeImpostors(renderer, spruceVariants, branchMap);
  const impostorMat = createImpostorMaterial({
    uniforms,
    sunScale,
    atlas,
    fade: { near: [spruceRange.near - 22, spruceRange.near], far: [spruceRange.far - 400, spruceRange.far], thin: [750, spruceRange.far - 200] },
  });
  const IMP_TILE = 512;
  const impTiles = new Map();
  let impJob = null;
  const impGroup = new THREE.Group();
  impGroup.name = 'spruce-impostors';
  group.add(impGroup);
  function impostorUpdate(cx, cz, deadline) {
    const R = spruceRange.far + IMP_TILE * 0.75;
    const t0x = Math.floor((cx - R) / IMP_TILE);
    const t1x = Math.floor((cx + R) / IMP_TILE);
    const t0z = Math.floor((cz - R) / IMP_TILE);
    const t1z = Math.floor((cz + R) / IMP_TILE);
    const wanted = [];
    for (let tz = t0z; tz <= t1z; tz++) {
      for (let tx = t0x; tx <= t1x; tx++) {
        const d = Math.hypot((tx + 0.5) * IMP_TILE - cx, (tz + 0.5) * IMP_TILE - cz);
        if (d < R) wanted.push({ tx, tz, d, k: `${tx},${tz}` });
      }
    }
    wanted.sort((a, b) => a.d - b.d);
    const keep = new Set(wanted.map((w) => w.k));
    for (const [k, t] of impTiles) {
      if (!keep.has(k) && !(impJob && impJob.k === k)) {
        if (t.mesh) {
          impGroup.remove(t.mesh);
          t.mesh.geometry.dispose();
        }
        impTiles.delete(k);
      }
    }
    while (performance.now() < deadline) {
      if (!impJob) {
        const next = wanted.find((w) => !impTiles.has(w.k));
        if (!next) return;
        // Skip tiles without any spruce potential cheaply.
        let any = false;
        for (let a = 0; a <= 4 && !any; a++) {
          for (let b = 0; b <= 4 && !any; b++) {
            if (landcover.regionAt((next.tx + a / 4) * IMP_TILE, (next.tz + b / 4) * IMP_TILE)[0] > 0.001) any = true;
          }
        }
        if (!any) {
          impTiles.set(next.k, { mesh: null });
          continue;
        }
        impJob = { ...next, row: Math.floor((next.tz * IMP_TILE) / TREE_CELL), data: [], n: 0 };
      }
      const j = impJob;
      const i0 = Math.floor((j.tx * IMP_TILE) / TREE_CELL);
      const i1 = Math.floor(((j.tx + 1) * IMP_TILE) / TREE_CELL);
      const rowEnd = Math.floor(((j.tz + 1) * IMP_TILE) / TREE_CELL);
      const push = (a, b, c, d, e, f, g, h) => {
        j.data.push(a, b, c, d, e, f, g, h);
        j.n++;
      };
      for (let r = 0; r < 4 && j.row < rowEnd; r++, j.row++) {
        for (let ix = i0; ix < i1; ix++) spruceAt(ix, j.row, push, false);
      }
      if (j.row >= rowEnd) {
        let mesh = null;
        if (j.n) {
          const idx = [...Array(j.n).keys()].sort((a, b) => j.data[a * 8 + 7] - j.data[b * 8 + 7]);
          const sorted = new Float32Array(j.n * 8);
          idx.forEach((src, dst) => sorted.set(j.data.slice(src * 8, src * 8 + 8), dst * 8));
          const c = { x: (j.tx + 0.5) * IMP_TILE, y: 60, z: (j.tz + 0.5) * IMP_TILE };
          mesh = createImpostorTile(impostorMat, sorted, j.n, 8, c, IMP_TILE * 0.75 + 60);
          impGroup.add(mesh);
        }
        impTiles.set(j.k, { mesh });
        impJob = null;
      }
    }
  }

  // ---- Alder and salmonberry thickets (salmonberry lighter, at forest edges and in gullies).
  // Thickets near the camera only: beyond ~170 m the terrain's alder canopy shading carries them.
  const shrubR = 125 * Math.sqrt(Math.min(1.2, Math.max(0.4, q)));
  const leafMap = new THREE.CanvasTexture(leafTexture(256));
  leafMap.colorSpace = THREE.SRGBColorSpace;
  leafMap.wrapS = leafMap.wrapT = THREE.RepeatWrapping;
  leafMap.anisotropy = 4;
  const shrubMat = createInstancedMaterial({ uniforms, sunScale, fade: [0, 0, shrubR - 45, shrubR], fadeMode: 'shrink', wind: 0.03, windStiff: 1.5, tintAmount: 0.22, name: 'shrub', cardMap: true, foliage: true, standard: { roughness: 0.9, map: leafMap, alphaTest: 0.4, side: THREE.DoubleSide } });
  const shrubGeo = shrubGeometry(seed + 7, { blobs: 6 });
  const shrubLayer = createInstancedLayer({ geometry: shrubGeo, material: shrubMat.material, depthMaterial: shrubMat.depthMaterial, capacity: 3000, name: 'shrubs', castShadow: false });
  group.add(shrubLayer.mesh);
  const SHRUB_CELL = 3.5;
  layers.push({
    layer: shrubLayer,
    scatter: createTileScatter({
      name: 'shrubs',
      tileSize: 48,
      radius: shrubR,
      stride: 8,
      capacity: 3000,
      generate(tx, tz, x0, z0, size, push) {
        for (let iz = Math.floor(z0 / SHRUB_CELL); iz < Math.floor((z0 + size) / SHRUB_CELL); iz++) {
          for (let ix = Math.floor(x0 / SHRUB_CELL); ix < Math.floor((x0 + size) / SHRUB_CELL); ix++) {
            const r0 = rand(ix, iz, 11);
            if (r0 > 0.8 * q) continue;
            const x = (ix + rand(ix, iz, 12)) * SHRUB_CELL;
            const z = (iz + rand(ix, iz, 13)) * SHRUB_CELL;
            const s = landcover.sample(x, z);
            if (s.h < 1.8 || s.dev > 0.5) continue;
            const fd = landcover.forestFrom(x, z, s.h, s.s, s.sd, s.spruce, s.dev);
            const ad = landcover.alderFrom(x, z, s.h, s.s, fd, s.dev, s.wet);
            const edge = fd > 0.08 && fd < 0.6 ? 0.3 : 0;
            const scattered = 0.02 * (1 - smoothstep(90, 140, s.h));
            const p = Math.max(smoothstep(0.2, 0.7, ad) * 0.95, edge, scattered);
            if (r0 > p * 0.8 * q) continue;
            if (landcover.rockScore(x, z, s.h, s.s, s.sd, 0) > 1.45) continue;
            if (dev(x, z)) continue;
            const salmon = edge > 0 || rand(ix, iz, 14) < 0.25;
            const size = salmon ? 1.1 + rand(ix, iz, 15) * 0.9 : 2.0 + rand(ix, iz, 15) * 1.8 * (0.6 + 0.4 * ad);
            const yaw = rand(ix, iz, 16) * Math.PI * 2;
            const tint = salmon ? 0.9 + rand(ix, iz, 17) * 0.4 : (rand(ix, iz, 17) - 0.6) * 1.2;
            push(x, surface.heightAt(x, z) - 0.15, z, size, Math.cos(yaw), Math.sin(yaw), tint, rand(ix, iz, 18));
          }
        }
      },
    }),
  });

  // ---- Grass tufts and beach rye near the camera.
  const grassR = 30 * Math.sqrt(Math.min(1.2, Math.max(0.4, q)));
  const grassMat = createInstancedMaterial({ uniforms, sunScale, fade: [0, 0, grassR - 14, grassR], fadeMode: 'shrink', wind: 0.1, windStiff: 1.8, tintAmount: 0.25, name: 'grass', foliage: true, standard: { roughness: 0.85, side: THREE.DoubleSide } });
  const grassGeo = grassGeometry(seed + 21, { blades: 14 });
  const grassLayer = createInstancedLayer({ geometry: grassGeo, material: grassMat.material, capacity: 20000, name: 'grass' });
  group.add(grassLayer.mesh);
  const GRASS_CELL = 0.64 / Math.sqrt(Math.min(1.3, Math.max(0.3, q)));
  layers.push({
    layer: grassLayer,
    scatter: createTileScatter({
      name: 'grass',
      tileSize: 16,
      radius: grassR,
      stride: 8,
      capacity: 20000,
      generate(tx, tz, x0, z0, size, push) {
        // One site sample per 4x4 m block keeps generation cheap; heights stay exact per tuft.
        for (let bz = 0; bz < size; bz += 4) {
          for (let bx = 0; bx < size; bx += 4) {
            const cx = x0 + bx + 2;
            const cz = z0 + bz + 2;
            const s = landcover.sample(cx, cz);
            if (s.h < 0.9 || s.dev > 0.5) continue;
            const fd = landcover.forestFrom(cx, cz, s.h, s.s, s.sd, s.spruce, s.dev);
            if (fd > 0.45) continue;
            const rock = landcover.rockScore(cx, cz, s.h, s.s, s.sd, 0);
            if (rock > 1.42 || landcover.snowFrom(cx, cz, s.h, s.gx, s.gz, s.s, s.pen) > 0.3) continue;
            const beach = s.h < 3.2 && s.sd > -60;
            const alpine = smoothstep(95, 150, s.h);
            const density = (beach ? 0.55 : 0.85) * (1 - 0.55 * alpine) * (1 - smoothstep(1.2, 1.42, rock));
            const i0 = Math.floor((x0 + bx) / GRASS_CELL);
            const j0 = Math.floor((z0 + bz) / GRASS_CELL);
            const i1 = Math.floor((x0 + bx + 4) / GRASS_CELL);
            const j1 = Math.floor((z0 + bz + 4) / GRASS_CELL);
            for (let iz = j0; iz < j1; iz++) {
              for (let ix = i0; ix < i1; ix++) {
                if (rand(ix, iz, 31) > density) continue;
                const x = (ix + rand(ix, iz, 32)) * GRASS_CELL;
                const z = (iz + rand(ix, iz, 33)) * GRASS_CELL;
                const y = surface.heightAt(x, z);
                if (y < (beach ? 1.5 : 0.9)) continue;
                if (dev(x, z)) continue;
                const lush = 1 - smoothstep(20, 70, s.h);
                const tall = beach ? 0.8 + rand(ix, iz, 34) * 0.45 : (0.35 + rand(ix, iz, 34) * 0.35 + lush * 0.3 + s.wet * 0.3) * (1 - 0.5 * alpine);
                const yaw = rand(ix, iz, 35) * Math.PI * 2;
                const tint = beach ? 0.6 + rand(ix, iz, 36) * 0.4 : (rand(ix, iz, 36) - 0.5) * 1.4 - alpine * 0.5;
                push(x, y - 0.05, z, tall, Math.cos(yaw), Math.sin(yaw), tint, rand(ix, iz, 37));
              }
            }
          }
        }
      },
    }),
  });

  // ---- Fireweed and lupine patches.
  const flowerR = 95 * Math.sqrt(Math.min(1.2, Math.max(0.4, q)));
  const flowerLayers = [
    { geo: mergeVariants([fireweedGeometry(seed + 41), fireweedGeometry(seed + 42)]), name: 'fireweed', ch: 0, size: [1.0, 1.7] },
    { geo: mergeVariants([lupineGeometry(seed + 43), lupineGeometry(seed + 44)]), name: 'lupine', ch: 1, size: [0.55, 0.85] },
  ].map((f) => {
    const m = createInstancedMaterial({ uniforms, sunScale, fade: [0, 0, flowerR - 20, flowerR], fadeMode: 'shrink', wind: 0.07, windStiff: 1.6, tintAmount: 0.15, name: f.name, foliage: true, standard: { roughness: 0.8, side: THREE.DoubleSide } });
    const L = createInstancedLayer({ geometry: f.geo, material: m.material, capacity: 6000, name: f.name });
    group.add(L.mesh);
    return { ...f, layer: L };
  });
  const FLOWER_CELL = 1.6;
  const fl = [0, 0];
  for (const f of flowerLayers) {
    layers.push({
      layer: f.layer,
      scatter: createTileScatter({
        name: f.name,
        tileSize: 24,
        radius: flowerR,
        stride: 8,
        capacity: 6000,
        generate(tx, tz, x0, z0, size, push) {
          for (let bz = 0; bz < size; bz += 6) {
            for (let bx = 0; bx < size; bx += 6) {
              const cx = x0 + bx + 3;
              const cz = z0 + bz + 3;
              const s = landcover.sample(cx, cz);
              if (s.h < 2.5) continue;
              const fd = landcover.forestFrom(cx, cz, s.h, s.s, s.sd, s.spruce, s.dev);
              landcover.flowersFrom(cx, cz, s.h, s.s, fd, s.dev, fl);
              const m = fl[f.ch];
              if (m < 0.05) continue;
              for (let iz = Math.floor((z0 + bz) / FLOWER_CELL); iz < Math.floor((z0 + bz + 6) / FLOWER_CELL); iz++) {
                for (let ix = Math.floor((x0 + bx) / FLOWER_CELL); ix < Math.floor((x0 + bx + 6) / FLOWER_CELL); ix++) {
                  const salt = 50 + f.ch * 10;
                  if (rand(ix, iz, salt) > m * 0.9 * q) continue;
                  const x = (ix + rand(ix, iz, salt + 1)) * FLOWER_CELL;
                  const z = (iz + rand(ix, iz, salt + 2)) * FLOWER_CELL;
                  if (dev(x, z)) continue;
                  const yaw = rand(ix, iz, salt + 3) * Math.PI * 2;
                  const sz = f.size[0] + (f.size[1] - f.size[0]) * rand(ix, iz, salt + 4);
                  push(x, surface.heightAt(x, z) - 0.03, z, sz, Math.cos(yaw), Math.sin(yaw), (rand(ix, iz, salt + 5) - 0.5) * 1.5, 0);
                }
              }
            }
          }
        },
      }),
    });
  }

  // ---- Boulders: beaches and rocky shores (some awash), erratics in the meadows, talus below crags.
  const boulderMat = createInstancedMaterial({ uniforms, sunScale, fade: [0, 0, 220, 270], fadeMode: 'shrink', nonUniform: true, underwater: true, tintAmount: 0.2, name: 'boulder', standard: { roughness: 0.85 } });
  const boulderGeo = boulderGeometry(seed + 61);
  const boulderLayer = createInstancedLayer({ geometry: boulderGeo, material: boulderMat.material, depthMaterial: boulderMat.depthMaterial, capacity: 5000, name: 'boulders', nonUniform: true, castShadow: true });
  group.add(boulderLayer.mesh);
  const BOULDER_CELL = 5.5;
  layers.push({
    layer: boulderLayer,
    stride: 11,
    scatter: createTileScatter({
      name: 'boulders',
      tileSize: 64,
      radius: 270,
      stride: 11,
      capacity: 5000,
      generate(tx, tz, x0, z0, size, push) {
        for (let iz = Math.floor(z0 / BOULDER_CELL); iz < Math.floor((z0 + size) / BOULDER_CELL); iz++) {
          for (let ix = Math.floor(x0 / BOULDER_CELL); ix < Math.floor((x0 + size) / BOULDER_CELL); ix++) {
            const r0 = rand(ix, iz, 71);
            if (r0 > 0.35) continue;
            const x = (ix + rand(ix, iz, 72)) * BOULDER_CELL;
            const z = (iz + rand(ix, iz, 73)) * BOULDER_CELL;
            const sd = heightmap.shoreDistance(x, z);
            if (sd > 40 || sd < -400) continue;
            const s = landcover.sample(x, z);
            let p = 0;
            let big = 1;
            if (s.h > -2.8 && s.h < 2.4 && sd > -30) {
              const rocky = smoothstep(0.08, 0.5, s.s);
              p = 0.05 + 0.3 * rocky;
              big = 0.7 + rocky;
            } else if (s.h >= 2.4) {
              const score = landcover.rockScore(x, z, s.h, s.s, s.sd, 0);
              p = 0.006 + 0.08 * smoothstep(1.1, 1.4, score) * (1 - smoothstep(1.5, 1.7, score));
            }
            if (r0 > p || dev(x, z)) continue;
            const r = (0.35 + Math.pow(rand(ix, iz, 74), 2.2) * 1.6) * big;
            const yaw = rand(ix, iz, 75) * Math.PI * 2;
            const y = surface.heightAt(x, z) - r * 0.28;
            push(x, y, z, r, Math.cos(yaw), Math.sin(yaw), (rand(ix, iz, 76) - 0.5) * 1.6, 0, 0.8 + rand(ix, iz, 77) * 0.5, 0.7 + rand(ix, iz, 78) * 0.4, 0.8 + rand(ix, iz, 79) * 0.5);
          }
        }
      },
    }),
  });

  // ---- Driftwood along the upper beach, lying with the shore.
  const driftMat = createInstancedMaterial({ uniforms, sunScale, fade: [0, 0, 220, 270], fadeMode: 'shrink', nonUniform: true, tintAmount: 0.2, name: 'driftwood', standard: { roughness: 0.95 } });
  const driftLayers = [driftwoodGeometry(seed + 81), driftwoodGeometry(seed + 82, { rootWad: true })].map((g, i) => {
    const L = createInstancedLayer({ geometry: g, material: driftMat.material, depthMaterial: driftMat.depthMaterial, capacity: 2500, name: `driftwood-${i}`, nonUniform: true, castShadow: true });
    group.add(L.mesh);
    return L;
  });
  const DRIFT_CELL = 6;
  const grad = { x: 0, z: 0 };
  const driftScatter = createTileScatter({
    name: 'driftwood',
    tileSize: 64,
    radius: 270,
    stride: 11,
    capacity: 5000,
    generate(tx, tz, x0, z0, size, push) {
      for (let iz = Math.floor(z0 / DRIFT_CELL); iz < Math.floor((z0 + size) / DRIFT_CELL); iz++) {
        for (let ix = Math.floor(x0 / DRIFT_CELL); ix < Math.floor((x0 + size) / DRIFT_CELL); ix++) {
          const r0 = rand(ix, iz, 91);
          if (r0 > 0.3) continue;
          const x = (ix + rand(ix, iz, 92)) * DRIFT_CELL;
          const z = (iz + rand(ix, iz, 93)) * DRIFT_CELL;
          const sd = heightmap.shoreDistance(x, z);
          if (sd > 2 || sd < -40) continue;
          const h = surface.heightAt(x, z);
          if (h < 0.75 || h > 2.4) continue;
          const s = landcover.sample(x, z);
          if (s.s > 0.4 || dev(x, z)) continue;
          const p = 0.12 + 0.18 * s.spruce;
          if (r0 > p) continue;
          heightmap.shoreGradient(x, z, grad);
          const along = Math.atan2(-grad.x, grad.z);
          const yaw = along + (rand(ix, iz, 94) - 0.5) * 0.9;
          const len = 3 + rand(ix, iz, 95) * 8;
          const rad = 0.14 + rand(ix, iz, 96) * 0.28;
          const wad = rand(ix, iz, 97) < 0.22 ? 1 : 0;
          push(x, h + rad * 0.55, z, 1, Math.cos(yaw), Math.sin(yaw), (rand(ix, iz, 98) - 0.5) * 1.2, wad, len, rad, rad);
        }
      }
    },
  });
  const driftSplit = [new Float32Array(2500 * 11), new Float32Array(2500 * 11)];
  layers.push({
    scatter: driftScatter,
    upload() {
      const d = driftScatter.data;
      const n = [0, 0];
      for (let i = 0; i < driftScatter.count; i++) {
        const w = d[i * 11 + 7] > 0.5 ? 1 : 0;
        if (n[w] >= 2500) continue;
        driftSplit[w].set(d.subarray(i * 11, i * 11 + 11), n[w] * 11);
        n[w]++;
      }
      driftLayers[0].upload(driftSplit[0], n[0], 11);
      driftLayers[1].upload(driftSplit[1], n[1], 11);
    },
  });

  // ---- Bull kelp beds in rocky nearshore shallows.
  const kelp = createKelpLayer({ ctx, sunScale, capacity: 2400 });
  group.add(kelp.mesh);
  const KELP_CELL = 2.7;
  const kelpScatter = createTileScatter({
    name: 'kelp',
    tileSize: 64,
    radius: 420,
    stride: 8,
    capacity: 2400,
    generate(tx, tz, x0, z0, size, push) {
      for (let iz = Math.floor(z0 / KELP_CELL); iz < Math.floor((z0 + size) / KELP_CELL); iz++) {
        for (let ix = Math.floor(x0 / KELP_CELL); ix < Math.floor((x0 + size) / KELP_CELL); ix++) {
          const r0 = rand(ix, iz, 101);
          if (r0 > 0.8) continue;
          const x = (ix + rand(ix, iz, 102)) * KELP_CELL;
          const z = (iz + rand(ix, iz, 103)) * KELP_CELL;
          const sd = heightmap.shoreDistance(x, z);
          if (sd < 14 || sd > 190) continue;
          // Beds: dense rafts (the 17 m noise) inside larger patches along the reef (75 m).
          const bed = smoothstep(0.46, 0.62, landcover.noise(x / 75 + 3.3, z / 75 - 8.1)) * smoothstep(0.3, 0.52, landcover.noise(x / 17, z / 17));
          if (bed <= 0 || r0 > bed * 0.8) continue;
          const h = surface.heightAt(x, z);
          if (h > -2.2 || h < -15) continue;
          const s = landcover.sample(x, z);
          // Rocky reefs: a steep seabed, or a steep coast just shoreward.
          heightmap.shoreGradient(x, z, grad);
          const cx = x - grad.x * (sd + 25);
          const cz = z - grad.z * (sd + 25);
          const coast = landcover.sample(cx, cz);
          const rocky = Math.max(smoothstep(0.06, 0.2, s.s), smoothstep(0.55, 1.2, coast.s));
          if (rocky < 0.3) continue;
          const yaw = rand(ix, iz, 104) * Math.PI * 2;
          push(x, 0, z, (3 + rand(ix, iz, 105) * 3) * (0.7 + 0.3 * bed), Math.cos(yaw), Math.sin(yaw), 0, rand(ix, iz, 106));
        }
      }
    },
  });

  // ---- per-frame
  let jumpFrames = 60;
  let lastCam = new THREE.Vector3(1e9, 0, 1e9);
  let genMs = 0;
  return {
    group,
    // Debug: show/hide a named part ('impostors', 'spruce', 'shrubs', 'grass', 'fireweed', 'lupine', 'boulders',
    // 'driftwood', 'kelp' or 'all').
    setVisible(name, on) {
      group.traverse((o) => {
        if (o === group) return;
        if (name === 'all' || o.name === name || o.name.startsWith(`${name}-`) || (name === 'impostors' && o.name === 'spruce-impostors')) o.visible = on;
      });
    },
    beforeRender(realDt) {
      const t0 = performance.now();
      const cam = camera.position;
      if (Math.hypot(cam.x - lastCam.x, cam.z - lastCam.z) > 250) jumpFrames = 45;
      lastCam.copy(cam);
      const budget = jumpFrames > 0 ? 7 : 1.1;
      if (jumpFrames > 0) jumpFrames--;
      const deadline = t0 + budget;
      for (const L of layers) {
        if (L.scatter.update(cam.x, cam.z, deadline)) {
          if (L.upload) L.upload();
          else L.layer.upload(L.scatter.data, L.scatter.count, L.stride ?? 8);
        }
      }
      if (kelpScatter.update(cam.x, cam.z, deadline)) kelp.setPlants(kelpScatter.data, kelpScatter.count, 8, cam.x, cam.z);
      impostorUpdate(cam.x, cam.z, Math.max(deadline, performance.now() + 0.3));
      // Far tiles draw only their lowest-ranked trees (the shader fades the rest of the kept fraction smoothly).
      const [th0, th1] = impostorMat.userData.im.imThin.value.toArray();
      for (const child of impGroup.children) {
        const c = child.geometry.boundingSphere.center;
        const d = Math.max(0, Math.hypot(c.x - cam.x, c.z - cam.z) - IMP_TILE * 0.7);
        const keep = 1 - 0.65 * smoothstep(th0, th1, d);
        child.geometry.instanceCount = Math.min(child.userData.total, Math.ceil(child.userData.total * (keep + 0.08)));
      }
      kelp.update(realDt);
      genMs += (performance.now() - t0 - genMs) * 0.05;
    },
    debugState() {
      const counts = {};
      for (const L of layers) counts[L.scatter.name] = L.scatter.count;
      counts.kelp = kelp.count;
      let imp = 0;
      let tiles = 0;
      for (const t of impTiles.values()) {
        if (t.mesh) {
          imp += t.mesh.userData.total;
          tiles++;
        }
      }
      counts.impostors = imp;
      counts.impostorTiles = tiles;
      return { counts, ms: +genMs.toFixed(3) };
    },
  };
}
