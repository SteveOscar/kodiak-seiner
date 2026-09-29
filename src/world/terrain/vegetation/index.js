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
  DRIFT_R0,
  crownProxyGeometry,
  fernTexture,
  fernGeometry,
} from './models.js';
import { bakeImpostors, createImpostorMaterial, createImpostorTile } from './impostor.js';
import { createKelpLayer } from './kelp.js';
import { smoothstep } from '../landcover.js';
import { createPlacement, TREE_CELL, BOULDER_CELL, DRIFT_CELL } from './placement.js';

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

export function createVegetation({ ctx, surface, landcover, heightmap, demAt, texel, isDeveloped, sunScale, seed, placement = null }) {
  const { scene, camera, uniforms, quality, renderer } = ctx;
  const q = quality?.vegetation ?? 1;
  // Spruce, boulders and driftwood come from the shared placement (the terrain colliders use the same one).
  const place = placement ?? createPlacement({ surface, landcover, heightmap, demAt, texel, isDeveloped, seed, q });
  const rand = cellRandom(seed);
  const dev = (x, z) => (isDeveloped ? isDeveloped(x, z) : false);
  const group = new THREE.Group();
  group.name = 'vegetation';
  scene.add(group);
  const layers = [];

  // ---- Sitka spruce: one placement function shared by the 3D and impostor layers so they swap in place.
  const spruceRange = { near: 48 * Math.min(1.15, 0.75 + 0.25 * q), far: q < 0.5 ? 1500 : 2300 };
  const spruceAt = place.spruceAt;

  const branchMap = new THREE.CanvasTexture(spruceBranchTexture(256));
  branchMap.colorSpace = THREE.SRGBColorSpace;
  branchMap.wrapS = branchMap.wrapT = THREE.ClampToEdgeWrapping;
  branchMap.anisotropy = 4;
  const spruceVariants = [1, 2, 3, 4].map((s, i) => spruceGeometry(seed + s * 101, { tiers: 12 + (i % 3), perTier: 6, width: 0.15 + 0.02 * (i % 3) }));
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
    lambert: true,
    translucency: 0.2,
    standard: { side: THREE.DoubleSide, map: branchMap, alphaTest: 0.5 },
  });
  const spruceLayers = spruceVariants.map((g, i) => {
    const L = createInstancedLayer({ geometry: g, material: spruceNearMat.material, capacity: 1200, name: `spruce-${i}`, castShadow: false });
    group.add(L.mesh);
    return L;
  });
  // Sun shadows come from a cone per tree, drawn only in the shadow pass (instanceCount is zeroed for camera passes).
  const proxyMat = createInstancedMaterial({ uniforms, sunScale, fade: [0, 0, spruceRange.near - 22, spruceRange.near], fadeMode: 'dither', name: 'spruce-shadow', lambert: true });
  const spruceShadow = createInstancedLayer({ geometry: crownProxyGeometry(), material: proxyMat.material, depthMaterial: proxyMat.depthMaterial, capacity: 4800, name: 'spruce-shadow', castShadow: true });
  spruceShadow.mesh.receiveShadow = false;
  spruceShadow.mesh.onBeforeRender = (r, sc, cam, geom) => {
    geom.instanceCount = 0;
  };
  spruceShadow.mesh.onBeforeShadow = (r, obj, cam, shadowCam, geom) => {
    geom.instanceCount = spruceShadow.mesh.userData.count ?? 0;
  };
  group.add(spruceShadow.mesh);
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
      spruceShadow.upload(d, spruceScatter.count, 8);
      spruceShadow.mesh.userData.count = spruceShadow.count;
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

  // ---- Alder and salmonberry thickets (salmonberry lighter, at forest edges and scattered through the alder).
  // Thickets near the camera only: beyond ~100 m the terrain's alder canopy shading carries them. Bushes beyond
  // SHRUB_NEAR use a coarser card set (re-split whenever the camera moves a few metres).
  const shrubR = 78 * Math.sqrt(Math.min(1.2, Math.max(0.4, q)));
  const SHRUB_NEAR = 30;
  const shrubMaps = ['alder', 'salmonberry'].map((kind) => {
    const map = new THREE.CanvasTexture(leafTexture(256, { kind }));
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = 4;
    return map;
  });
  const shrubKinds = [
    { name: 'shrubs-alder', kind: 0, geo: shrubGeometry(seed + 7, { cards: 44, stems: 4, cardSize: 0.62 }) },
    { name: 'shrubs-alder-far', kind: 0, geo: shrubGeometry(seed + 7, { cards: 24, stems: 0, cardSize: 1.0 }) },
    { name: 'shrubs-salmonberry', kind: 1, geo: shrubGeometry(seed + 8, { cards: 30, stems: 3, cardSize: 0.56, shape: [0.66, 0.46, 0.62], centerY: 0.55 }) },
    { name: 'shrubs-salmonberry-far', kind: 1, geo: shrubGeometry(seed + 8, { cards: 18, stems: 0, cardSize: 0.9, shape: [0.66, 0.46, 0.62], centerY: 0.55 }) },
  ].map((k) => {
    const m = createInstancedMaterial({ uniforms, sunScale, fade: [0, 0, shrubR - 35, shrubR], fadeMode: 'shrink', wind: 0.025, windStiff: 1.5, tintAmount: 0.2, name: k.name, cardMap: true, foliage: true, lambert: true, translucency: 0.3, standard: { map: shrubMaps[k.kind], alphaTest: 0.45, side: THREE.DoubleSide } });
    const L = createInstancedLayer({ geometry: k.geo, material: m.material, capacity: 3000, name: k.name, castShadow: false });
    group.add(L.mesh);
    return L;
  });
  const SHRUB_CELL = 3.2;
  const shrubScatter = createTileScatter({
    name: 'shrubs',
    tileSize: 48,
    radius: shrubR,
    stride: 8,
    capacity: 6000,
    generate(tx, tz, x0, z0, size, push) {
      for (let iz = Math.floor(z0 / SHRUB_CELL); iz < Math.floor((z0 + size) / SHRUB_CELL); iz++) {
        for (let ix = Math.floor(x0 / SHRUB_CELL); ix < Math.floor((x0 + size) / SHRUB_CELL); ix++) {
          const r0 = rand(ix, iz, 11);
          if (r0 > 0.85 * q) continue;
          const x = (ix + rand(ix, iz, 12)) * SHRUB_CELL;
          const z = (iz + rand(ix, iz, 13)) * SHRUB_CELL;
          const s = landcover.sample(x, z);
          if (s.h < 1.8 || s.dev > 0.5) continue;
          const fd = landcover.forestFrom(x, z, s.h, s.s, s.sd, s.spruce, s.dev);
          const ad = Math.max(landcover.alderFrom(x, z, s.h, s.s, fd, s.dev, s.wet), landcover.rillAlderFrom(s.h, landcover.rillAt(x, z, s.gx, s.gz), fd, s.dev));
          const edge = fd > 0.08 && fd < 0.6 ? 0.3 : 0;
          const scattered = 0.025 * (1 - smoothstep(90, 140, s.h));
          const p = Math.max(smoothstep(0.2, 0.7, ad) * 0.95, edge, scattered);
          if (r0 > p * 0.85 * q) continue;
          if (landcover.rockScore(x, z, s.h, s.s, s.sd, 0) > 1.45) continue;
          if (dev(x, z)) continue;
          const salmon = edge > 0 || rand(ix, iz, 14) < 0.22;
          const size = salmon ? 1.2 + rand(ix, iz, 15) * 0.9 : 2.1 + rand(ix, iz, 15) * 1.7 * (0.6 + 0.4 * ad);
          const yaw = rand(ix, iz, 16) * Math.PI * 2;
          const tint = (rand(ix, iz, 17) - 0.5) * 1.2;
          push(x, surface.heightAt(x, z) - 0.2, z, size, Math.cos(yaw), Math.sin(yaw), tint, salmon ? 1 : 0);
        }
      }
    },
  });
  const shrubSplit = shrubKinds.map(() => new Float32Array(3000 * 8));
  const shrubAt = { x: NaN, z: NaN };
  function splitShrubs(cx, cz) {
    shrubAt.x = cx;
    shrubAt.z = cz;
    const d = shrubScatter.data;
    const n = [0, 0, 0, 0];
    const near2 = SHRUB_NEAR * SHRUB_NEAR;
    for (let i = 0; i < shrubScatter.count; i++) {
      const o = i * 8;
      const dx = d[o] - cx;
      const dz = d[o + 2] - cz;
      const k = (d[o + 7] > 0.5 ? 2 : 0) + (dx * dx + dz * dz > near2 ? 1 : 0);
      if (n[k] >= 3000) continue;
      shrubSplit[k].set(d.subarray(o, o + 8), n[k] * 8);
      n[k]++;
    }
    shrubKinds.forEach((L, k) => L.upload(shrubSplit[k], n[k], 8));
  }
  layers.push({
    scatter: shrubScatter,
    upload: () => splitShrubs(camera.position.x, camera.position.z),
    tick(cx, cz) {
      if (Math.hypot(cx - shrubAt.x, cz - shrubAt.z) > 6) splitShrubs(cx, cz);
    },
  });

  // ---- Grass clumps and beach rye near the camera: dense within a few metres, thinning and shrinking into the
  // terrain's meadow texture by grassR.
  const grassR = 18 * Math.sqrt(Math.min(1.2, Math.max(0.4, q)));
  const grassMat = createInstancedMaterial({ uniforms, sunScale, fade: [0, 0, grassR * 0.55, grassR], fadeMode: 'shrink', wind: 0.12, windStiff: 1.8, tintAmount: 0.22, name: 'grass', foliage: true, dryTint: true, lambert: true, translucency: 0.6, standard: { side: THREE.DoubleSide } });
  const grassGeo = grassGeometry(seed + 21, { blades: 10 });
  const grassLayer = createInstancedLayer({ geometry: grassGeo, material: grassMat.material, capacity: 16000, name: 'grass' });
  group.add(grassLayer.mesh);
  const GRASS_CELL = 0.6 / Math.sqrt(Math.min(1.3, Math.max(0.3, q)));
  layers.push({
    layer: grassLayer,
    scatter: createTileScatter({
      name: 'grass',
      tileSize: 16,
      radius: grassR,
      stride: 8,
      capacity: 16000,
      generate(tx, tz, x0, z0, size, push) {
        // One site sample per 4x4 m block keeps generation cheap; heights stay exact per clump.
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
            const density = (beach ? 0.5 : 0.9) * (1 - 0.55 * alpine) * (1 - smoothstep(1.2, 1.42, rock));
            const lush = 1 - smoothstep(20, 70, s.h);
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
                // Meadow patches: tall swards and short turf, a few metres across.
                const sward = landcover.noise(x / 5.3 + 0.7, z / 5.3 - 3.1);
                const tall = beach ? 0.75 + rand(ix, iz, 34) * 0.45 : (0.4 + rand(ix, iz, 34) * 0.3 + lush * 0.35 + s.wet * 0.3) * (0.55 + 0.7 * sward) * (1 - 0.55 * alpine);
                const yaw = rand(ix, iz, 35) * Math.PI * 2;
                const tint = beach ? 0.25 + rand(ix, iz, 36) * 0.3 : (rand(ix, iz, 36) - 0.5) * 1.1 - alpine * 0.4;
                const dry = beach ? 0.55 + rand(ix, iz, 37) * 0.35 : Math.min(1, alpine * 0.7 + (1 - lush) * 0.15 + (rand(ix, iz, 37) < 0.12 ? 0.4 : 0));
                push(x, y - 0.05, z, tall, Math.cos(yaw), Math.sin(yaw), tint, dry);
              }
            }
          }
        }
      },
    }),
  });

  // ---- Ferns: lady and shield fern carpeting the spruce forest floor, and in the damp gullies and forest edges.
  const fernR = 28 * Math.sqrt(Math.min(1.2, Math.max(0.4, q)));
  const fernMap = new THREE.CanvasTexture(fernTexture(256));
  fernMap.colorSpace = THREE.SRGBColorSpace;
  fernMap.anisotropy = 4;
  const fernMat = createInstancedMaterial({ uniforms, sunScale, fade: [0, 0, fernR - 12, fernR], fadeMode: 'shrink', wind: 0.04, windStiff: 1.6, tintAmount: 0.2, name: 'ferns', cardMap: true, foliage: true, lambert: true, translucency: 0.4, standard: { map: fernMap, alphaTest: 0.4, side: THREE.DoubleSide } });
  const fernLayer = createInstancedLayer({ geometry: fernGeometry(seed + 29), material: fernMat.material, capacity: 4000, name: 'ferns' });
  group.add(fernLayer.mesh);
  const FERN_CELL = 1.7;
  layers.push({
    layer: fernLayer,
    scatter: createTileScatter({
      name: 'ferns',
      tileSize: 24,
      radius: fernR,
      stride: 8,
      capacity: 4000,
      generate(tx, tz, x0, z0, size, push) {
        for (let bz = 0; bz < size; bz += 6) {
          for (let bx = 0; bx < size; bx += 6) {
            const cx = x0 + bx + 3;
            const cz = z0 + bz + 3;
            const s = landcover.sample(cx, cz);
            if (s.h < 2.5 || s.h > 110 || s.dev > 0.5) continue;
            const fd = landcover.forestFrom(cx, cz, s.h, s.s, s.sd, s.spruce, s.dev);
            const p = Math.max(fd * 0.55, smoothstep(0.2, 0.5, s.wet) * 0.18 * (1 - smoothstep(60, 100, s.h)));
            if (p < 0.02 || landcover.rockScore(cx, cz, s.h, s.s, s.sd, 0) > 1.4) continue;
            for (let iz = Math.floor((z0 + bz) / FERN_CELL); iz < Math.floor((z0 + bz + 6) / FERN_CELL); iz++) {
              for (let ix = Math.floor((x0 + bx) / FERN_CELL); ix < Math.floor((x0 + bx + 6) / FERN_CELL); ix++) {
                const x = (ix + rand(ix, iz, 121)) * FERN_CELL;
                const z = (iz + rand(ix, iz, 122)) * FERN_CELL;
                const patchy = smoothstep(0.3, 0.6, landcover.noise(x / 6.3 + 4.1, z / 6.3 - 2.2));
                if (rand(ix, iz, 123) > p * patchy * 1.6 * q) continue;
                if (dev(x, z)) continue;
                const yaw = rand(ix, iz, 124) * Math.PI * 2;
                const size = 0.55 + rand(ix, iz, 125) * 0.55 + fd * 0.25;
                push(x, surface.heightAt(x, z) - 0.03, z, size, Math.cos(yaw), Math.sin(yaw), (rand(ix, iz, 126) - 0.5) * 1.2, 0);
              }
            }
          }
        }
      },
    }),
  });

  // ---- Fireweed and lupine patches.
  const flowerR = 48 * Math.sqrt(Math.min(1.2, Math.max(0.4, q)));
  const flowerLayers = [
    { geo: mergeVariants([fireweedGeometry(seed + 41), fireweedGeometry(seed + 42)]), name: 'fireweed', ch: 0, size: [1.0, 1.7] },
    { geo: mergeVariants([lupineGeometry(seed + 43), lupineGeometry(seed + 44)]), name: 'lupine', ch: 1, size: [0.55, 0.85] },
  ].map((f) => {
    const m = createInstancedMaterial({ uniforms, sunScale, fade: [0, 0, flowerR - 20, flowerR], fadeMode: 'shrink', wind: 0.07, windStiff: 1.6, tintAmount: 0.15, name: f.name, foliage: true, lambert: true, translucency: 0.35, standard: { side: THREE.DoubleSide } });
    const L = createInstancedLayer({ geometry: f.geo, material: m.material, capacity: 6000, name: f.name });
    group.add(L.mesh);
    return { ...f, layer: L };
  });
  const FLOWER_CELL = 1.3;
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
                  const x = (ix + rand(ix, iz, salt + 1)) * FLOWER_CELL;
                  const z = (iz + rand(ix, iz, salt + 2)) * FLOWER_CELL;
                  // Stands a few metres across inside the patch, dense at their hearts.
                  const stand = smoothstep(0.34, 0.66, landcover.noise(x / 7.5 + 3.1 * f.ch, z / 7.5 - 1.7));
                  if (rand(ix, iz, salt) > m * stand * 1.25 * q) continue;
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
  const boulderMat = createInstancedMaterial({ uniforms, sunScale, fade: [0, 0, 220, 270], fadeMode: 'shrink', nonUniform: true, underwater: true, tintAmount: 0.2, name: 'boulder', lambert: true, grain: [3.2, 0.3] });
  // Near boulders (within BOULDER_NEAR) use a finer mesh; the split is refreshed as the camera moves.
  const BOULDER_NEAR = 45;
  const boulderLayers = [boulderGeometry(seed + 61, { detail: 3 }), boulderGeometry(seed + 61, { detail: 1 })].map((g, i) => {
    const L = createInstancedLayer({ geometry: g, material: boulderMat.material, depthMaterial: boulderMat.depthMaterial, capacity: 5000, name: i ? 'boulders-far' : 'boulders-near', nonUniform: true, castShadow: true });
    group.add(L.mesh);
    return L;
  });
  const boulderSplit = [new Float32Array(5000 * 11), new Float32Array(5000 * 11)];
  const boulderAt = { x: NaN, z: NaN };
  function splitBoulders(cx, cz) {
    boulderAt.x = cx;
    boulderAt.z = cz;
    const d = boulderScatter.data;
    const n = [0, 0];
    for (let i = 0; i < boulderScatter.count; i++) {
      const o = i * 11;
      const k = Math.hypot(d[o] - cx, d[o + 2] - cz) > BOULDER_NEAR ? 1 : 0;
      boulderSplit[k].set(d.subarray(o, o + 11), n[k] * 11);
      n[k]++;
    }
    boulderLayers.forEach((L, k) => L.upload(boulderSplit[k], n[k], 11));
  }
  const boulderScatter = createTileScatter({
      name: 'boulders',
      tileSize: 64,
      radius: 270,
      stride: 11,
      capacity: 5000,
      generate(tx, tz, x0, z0, size, push) {
        for (let iz = Math.floor(z0 / BOULDER_CELL); iz < Math.floor((z0 + size) / BOULDER_CELL); iz++) {
          for (let ix = Math.floor(x0 / BOULDER_CELL); ix < Math.floor((x0 + size) / BOULDER_CELL); ix++) place.boulderAt(ix, iz, push);
        }
      },
  });
  layers.push({
    scatter: boulderScatter,
    upload: () => splitBoulders(camera.position.x, camera.position.z),
    tick(cx, cz) {
      if (Math.hypot(cx - boulderAt.x, cz - boulderAt.z) > 8) splitBoulders(cx, cz);
    },
  });

  // ---- Driftwood on the storm line of gravel and sand beaches, lying with the shore (placement.js driftAt).
  const driftMat = createInstancedMaterial({ uniforms, sunScale, fade: [0, 0, 220, 270], fadeMode: 'shrink', nonUniform: true, tintAmount: 0.25, name: 'driftwood', lambert: true, grain: [2.5, 0.18, 0.08, 1, 1] });
  const driftLayers = [driftwoodGeometry(seed + 81), driftwoodGeometry(seed + 82, { rootWad: true })].map((g, i) => {
    const L = createInstancedLayer({ geometry: g, material: driftMat.material, depthMaterial: driftMat.depthMaterial, capacity: 2500, name: `driftwood-${i}`, nonUniform: true, castShadow: true });
    group.add(L.mesh);
    return L;
  });
  const grad = { x: 0, z: 0 };
  const driftScatter = createTileScatter({
    name: 'driftwood',
    tileSize: 64,
    radius: 270,
    stride: 11,
    capacity: 5000,
    generate(tx, tz, x0, z0, size, push) {
      for (let iz = Math.floor(z0 / DRIFT_CELL); iz < Math.floor((z0 + size) / DRIFT_CELL); iz++) {
        for (let ix = Math.floor(x0 / DRIFT_CELL); ix < Math.floor((x0 + size) / DRIFT_CELL); ix++) place.driftAt(ix, iz, push);
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
  const kelp = createKelpLayer({ ctx, sunScale, capacity: 3000 });
  group.add(kelp.mesh);
  const KELP_CELL = 1.7;
  const kelpScatter = createTileScatter({
    name: 'kelp',
    tileSize: 64,
    radius: 420,
    stride: 8,
    capacity: 3000,
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
          // Beds are dense floating mats (the 14 m noise) inside larger patches along the reef (70 m).
          const bed = smoothstep(0.5, 0.64, landcover.noise(x / 70 + 3.3, z / 70 - 8.1)) * smoothstep(0.42, 0.6, landcover.noise(x / 14, z / 14));
          if (bed <= 0 || r0 > bed * 1.3) continue;
          const h = surface.heightAt(x, z);
          if (h > -2.2 || h < -15 || dev(x, z)) continue;
          const s = landcover.sample(x, z);
          // Rocky reefs: a steep seabed, or a steep coast just shoreward.
          heightmap.shoreGradient(x, z, grad);
          const cx = x - grad.x * (sd + 25);
          const cz = z - grad.z * (sd + 25);
          const coast = landcover.sample(cx, cz);
          const rocky = Math.max(smoothstep(0.06, 0.2, s.s), smoothstep(0.55, 1.2, coast.s));
          if (rocky < 0.3) continue;
          const yaw = rand(ix, iz, 104) * Math.PI * 2;
          push(x, 0, z, (2.8 + rand(ix, iz, 105) * 3.2) * (0.7 + 0.3 * bed), Math.cos(yaw), Math.sin(yaw), 0, rand(ix, iz, 106));
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
        } else if (L.tick) {
          L.tick(cam.x, cam.z);
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
