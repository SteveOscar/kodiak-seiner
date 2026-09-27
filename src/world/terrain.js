// WP-TERRAIN: the Kodiak archipelago and the Alaska Peninsula backdrop (SPEC §6.4).
//
//   geometry    CDLOD quadtree of instanced 32x32 grid quadrants displaced on the GPU from a despiked copy of the DEM
//               (terrain/quadtree.js, terrain/material.js); heightAt() returns exactly the finest-level surface.
//   material    slope/height/aspect/shore splatting, triplanar rock, detail normals, lakes, seabed with caustics and
//               kodiak_underwater; direct sun = uSunColor x uTerrainShadow.
//   shadow      GPU raymarched terrain sun shadow published as uniforms.uTerrainShadow (terrain/shadowPass.js) and
//               the matching CPU sunVisibilityAt() (terrain/sunvis.js).
//   vegetation  spruce forests with impostors, alder and salmonberry, grass and wildflowers, beach boulders and
//               driftwood, bull kelp (terrain/vegetation/*).

import * as THREE from 'three';
import { despike } from './terrain/despike.js';
import { createSurface, createCurvature, L0, latticeRGBA, LATTICE_N } from './terrain/surface.js';
import { createBounds, createSelector, morphParams, QUAD, DEFAULT_RANGES, ROOT_LEVEL } from './terrain/quadtree.js';
import { buildRegion, createLandcover, REGION_SIZE } from './terrain/landcover.js';
import { createSunVisibility } from './terrain/sunvis.js';
import { computeDrainage, createWetnessSampler, drainageR8 } from './terrain/drainage.js';
import { createPassRunner, createHeightTexture, createInfoTextures, createDetailTextures, createCoverTextures, passMaterial } from './terrain/gpuPrep.js';
import { TK_NOISE, TK_HEIGHT, TK_DETAIL } from './terrain/glsl.js';
import { createShadowPass } from './terrain/shadowPass.js';
import { createTerrainMaterial } from './terrain/material.js';
import { createVegetation } from './terrain/vegetation/index.js';

const MAX_INSTANCES = 4096;

// One quadrant: (QUAD+1)^2 grid vertices plus a skirt ring. position = (i, skirt, j).
function createPatchGeometry() {
  const n = QUAD + 1;
  const pos = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) pos.push(i, 0, j);
  const border = [];
  for (let i = 0; i < QUAD; i++) border.push([i, 0]);
  for (let j = 0; j < QUAD; j++) border.push([QUAD, j]);
  for (let i = QUAD; i > 0; i--) border.push([i, QUAD]);
  for (let j = QUAD; j > 0; j--) border.push([0, j]);
  const skirtBase = pos.length / 3;
  for (const [i, j] of border) pos.push(i, 1, j);
  const idx = [];
  for (let j = 0; j < QUAD; j++) {
    for (let i = 0; i < QUAD; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  for (let k = 0; k < border.length; k++) {
    const [i0, j0] = border[k];
    const [i1, j1] = border[(k + 1) % border.length];
    const t0 = j0 * n + i0;
    const t1 = j1 * n + i1;
    const s0 = skirtBase + k;
    const s1 = skirtBase + ((k + 1) % border.length);
    idx.push(t0, s0, t1, t1, s0, s1, t0, t1, s0, t1, s1, s0);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

export async function create(ctx) {
  const { renderer, scene, camera, uniforms, heightmap, geo, pipeline, quality } = ctx;
  const size = heightmap.size;
  const half = heightmap.half;

  // ---- CPU data
  const { heights, fixed: despiked } = despike(heightmap.game, size);
  const surface = createSurface({ game: heights, size, half });
  const bounds = createBounds(heights, size, half);
  const placesMod = await import('../data/places.js').catch((err) => {
    console.warn('[terrain] places.js unavailable; vegetation ignores developed footprints', err?.message ?? err);
    return null;
  });
  const isDeveloped = placesMod?.isDeveloped ? (x, z) => placesMod.isDeveloped(x, z, geo) : null;
  const region = buildRegion({ geo, half, isDeveloped });
  const curvatureAt = createCurvature(heights, size, half);
  const drainage = computeDrainage(heights, size, size >> 1);
  const wetnessAt = createWetnessSampler(drainage, half);
  const landcover = createLandcover({ surface, heightmap, region, half, isDeveloped, curvatureAt, wetnessAt });

  // Bilinear despiked DEM for rays (cheap; the CR surface differs by centimetres at this scale).
  const T = (2 * half) / size;
  function demAt(x, z) {
    const fx = Math.min(size - 1.001, Math.max(0, (x + half) / T - 0.5));
    const fz = Math.min(size - 1.001, Math.max(0, (z + half) / T - 0.5));
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const k = j * size + i;
    return (heights[k] * (1 - tx) + heights[k + 1] * tx) * (1 - tz) + (heights[k + size] * (1 - tx) + heights[k + size + 1] * tx) * tz;
  }
  const sunNorm = new THREE.Vector3();
  const readSun = () => sunNorm.copy(uniforms.uSunDir.value).normalize();
  const sunvis = createSunVisibility({ sampleHeight: demAt, surfaceHeight: demAt, half, getSun: readSun });

  // ---- GPU resources
  const runner = createPassRunner(renderer);
  const heightTex = createHeightTexture(heights, size);
  const anisoParam = Number(new URLSearchParams(globalThis.location?.search ?? '').get('tkaniso') ?? 4);
  const info = createInfoTextures(renderer, runner, heightTex, size, half, anisoParam);
  const detail = createDetailTextures(renderer, runner, 512, anisoParam);
  const regionTex = new THREE.DataTexture(region, REGION_SIZE, REGION_SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  regionTex.minFilter = THREE.LinearFilter;
  regionTex.magFilter = THREE.LinearFilter;
  regionTex.wrapS = regionTex.wrapT = THREE.ClampToEdgeWrapping;
  regionTex.colorSpace = THREE.NoColorSpace;
  regionTex.needsUpdate = true;
  const drainTex = new THREE.DataTexture(drainageR8(drainage), drainage.n, drainage.n, THREE.RedFormat, THREE.UnsignedByteType);
  drainTex.minFilter = drainTex.magFilter = THREE.LinearFilter;
  drainTex.colorSpace = THREE.NoColorSpace;
  drainTex.needsUpdate = true;
  const cover = createCoverTextures(renderer, runner, { heightTex, info: info.texture, region: regionTex, drain: drainTex, heightMap: uniforms.uHeightMap.value, size, half, anisotropy: anisoParam });
  drainTex.dispose();
  const latticeTex = new THREE.DataTexture(latticeRGBA(), LATTICE_N, LATTICE_N, THREE.RGBAFormat, THREE.UnsignedByteType);
  latticeTex.minFilter = latticeTex.magFilter = THREE.NearestFilter;
  latticeTex.colorSpace = THREE.NoColorSpace;
  latticeTex.needsUpdate = true;
  const shadowSize = quality.name === 'low' ? 1024 : 2048;
  const shadow = createShadowPass({ runner, heightTex, half, size: shadowSize, bands: shadowSize >= 2048 ? 16 : 8 });
  shadow.update(readSun(), 0);
  uniforms.uTerrainShadow.value = shadow.texture;

  // ---- LOD mesh
  const lodUniform = { value: [] };
  let selector = null;
  function setRanges(scale) {
    const ranges = DEFAULT_RANGES.map((r) => r * scale);
    lodUniform.value = morphParams(ranges).map((m) => new THREE.Vector4(m.start, m.inv, m.spacing, m.skirt));
    selector = createSelector({ bounds, ranges, maxInstances: MAX_INSTANCES });
  }
  setRanges(quality.name === 'low' ? 0.7 : 1);
  const geometry = createPatchGeometry();
  const nodeData = new Float32Array(MAX_INSTANCES * 4);
  const nodeAttr = new THREE.InstancedBufferAttribute(nodeData, 4);
  nodeAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('tkNode', nodeAttr);
  geometry.instanceCount = 0;
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  geometry.boundingBox = new THREE.Box3(new THREE.Vector3(-1e5, -100, -1e5), new THREE.Vector3(1e5, 1000, 1e5));
  const material = createTerrainMaterial({
    uniforms,
    textures: { info: info.texture, coverA: cover.a.texture, coverB: cover.b.texture, coverC: cover.c.texture, lattice: latticeTex, region: regionTex, rock: detail.rock.texture, cliff: detail.cliff.texture, ground: detail.ground.texture, gravel: detail.gravel.texture },
    lodUniform,
    heightTex,
    size,
    half,
    getEnvDefines: () => ctx.systems.sky?.envMapDefines ?? null,
  });
  const dbg = new URLSearchParams(globalThis.location?.search ?? '').get('tkdbg');
  if (dbg) {
    material.defines = material.defines ?? {};
    for (const d of dbg.split('.')) material.defines[`TK_DBG_${d.toUpperCase()}`] = 1;
  }
  material.userData.textures = { info: info.texture, coverA: cover.a.texture, coverB: cover.b.texture, coverC: cover.c.texture, lattice: latticeTex, region: regionTex, rock: detail.rock.texture, cliff: detail.cliff.texture, ground: detail.ground.texture, gravel: detail.gravel.texture };
  material.defines = material.defines ?? {};
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'terrain';
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.matrixAutoUpdate = false;
  mesh.layers.enable(1);
  scene.add(mesh);

  // ---- vegetation
  let vegetation = null;
  try {
    const rng = ctx.rng.fork('terrain');
    vegetation = createVegetation({
      ctx,
      surface,
      landcover,
      heightmap,
      demAt,
      texel: T,
      isDeveloped,
      sunScale: material.userData.tk.tkSunScale,
      seed: Math.floor(rng.next() * 1e9),
    });
  } catch (err) {
    console.error('[terrain] vegetation failed to build', err);
  }

  const frustum = new THREE.Frustum();
  const projView = new THREE.Matrix4();
  let instances = 0;
  let selectMs = 0;
  let debugMaxInstances = MAX_INSTANCES;

  // Near quadrants first so early depth rejection skips the hills hidden behind them.
  const order = new Uint16Array(MAX_INSTANCES);
  const keys = new Float32Array(MAX_INSTANCES);
  const scratch = new Float32Array(MAX_INSTANCES * 4);
  function sortFrontToBack(n) {
    const cx = camera.position.x;
    const cz = camera.position.z;
    for (let i = 0; i < n; i++) {
      const k = i * 4;
      const hs = nodeData[k + 2] * 0.5;
      const dx = nodeData[k] + hs - cx;
      const dz = nodeData[k + 1] + hs - cz;
      keys[i] = Math.max(0, Math.hypot(dx, dz) - hs * 1.41);
      order[i] = i;
    }
    const idx = Array.from(order.subarray(0, n)).sort((a, b) => keys[a] - keys[b]);
    scratch.set(nodeData.subarray(0, n * 4));
    for (let i = 0; i < n; i++) {
      const src = idx[i] * 4;
      nodeData[i * 4] = scratch[src];
      nodeData[i * 4 + 1] = scratch[src + 1];
      nodeData[i * 4 + 2] = scratch[src + 2];
      nodeData[i * 4 + 3] = scratch[src + 3];
    }
  }

  function selectLod() {
    const t0 = performance.now();
    camera.updateMatrixWorld();
    projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projView, camera.coordinateSystem, camera.reversedDepth);
    instances = Math.min(debugMaxInstances, selector.select(camera.position, frustum.planes, nodeData));
    sortFrontToBack(instances);
    geometry.instanceCount = instances;
    nodeAttr.clearUpdateRanges();
    nodeAttr.addUpdateRange(0, instances * 4);
    nodeAttr.needsUpdate = true;
    selectMs += (performance.now() - t0 - selectMs) * 0.05;
  }

  // WP-SKY writes uSunColor as key irradiance / pi (unshadowed), so three.js light units are uSunColor * pi. The core
  // stub sky keeps uSunColor at unit chroma and only scales its DirectionalLight.
  function sunScale() {
    const sky = ctx.systems.sky;
    if (sky?.trueSunDirection) return Math.PI;
    return Math.max(0.2, sky?.sunLight?.intensity ?? 2.4);
  }

  let vegFailed = false;
  // Camera-following work (SPEC §5): runs after the camera is final. Pipeline hooks are not isolated by core, so
  // failures are caught here. Its CPU time is reported in debugState().cpuMs (perf().systemsMs only sees update()).
  let hookErrors = 0;
  let hookMs = 0;
  pipeline.beforeRender((realDt) => {
    const t0 = performance.now();
    try {
      selectLod();
      shadow.update(readSun(), realDt ?? 0.016);
      material.userData.tk.tkSunScale.value = sunScale();
    } catch (err) {
      if (!hookErrors++) console.error('[terrain] per-frame update failed', err);
    }
    if (vegetation && !vegFailed) {
      try {
        vegetation.beforeRender(realDt ?? 0.016);
      } catch (err) {
        vegFailed = true;
        console.error('[terrain] vegetation update failed', err);
      }
    }
    hookMs += (performance.now() - t0 - hookMs) * 0.05;
  });

  const normalTmp = { x: 0, y: 1, z: 0 };
  const sys = {
    mesh,
    material,
    surface,
    landcover,
    heights,

    heightAt: (x, z) => surface.heightAt(x, z),
    surfaceAt: (x, z) => landcover.surfaceAt(x, z),
    forestDensity: (x, z) => landcover.forestDensity(x, z),
    sunVisibilityAt: (x, z) => sunvis.at(x, z),

    // Extras for neighbours.
    alderDensity: (x, z) => landcover.alderDensity(x, z),
    normalAt: (x, z, out = new THREE.Vector3()) => {
      surface.normalAt(x, z, normalTmp);
      return out.set(normalTmp.x, normalTmp.y, normalTmp.z);
    },
    slopeAt(x, z) {
      surface.normalAt(x, z, normalTmp);
      return Math.acos(Math.min(1, normalTmp.y));
    },
    isLake: (x, z) => landcover.isLake(x, z),
    // First hit of a ray (origin/dir THREE.Vector3, dir unit) with the terrain, or -1.
    raycast(origin, dir, maxDist = 5000) {
      let prevT = 0;
      let prevGap = origin.y - surface.heightAt(origin.x, origin.z);
      if (prevGap < 0) return 0;
      let step = Math.max(0.5, Math.min(8, prevGap * 0.5));
      for (let t = step; t <= maxDist; t += step) {
        const gap = origin.y + dir.y * t - surface.heightAt(origin.x + dir.x * t, origin.z + dir.z * t);
        if (gap < 0) return prevT + (t - prevT) * (prevGap / (prevGap - gap));
        prevT = t;
        prevGap = gap;
        step = Math.max(0.5, Math.min(16, gap * 0.5, step * 1.3));
      }
      return -1;
    },

    // Evaluates the vertex shader's height function (tkSmooth + tkDetail, i.e. level-0 geometry) on the GPU at n x n
    // random points, inside and beyond the world square, and compares it with the CPU surface. Smoke runs assert
    // maxErr < 0.02 m so heightAt() provably equals the rendered full-detail terrain.
    verifyGpuParity(n = 64) {
      const pts = new Float32Array(n * n * 4);
      let seed = 12345;
      const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
      for (let k = 0; k < n * n; k++) {
        pts[k * 4] = (rnd() * 2 - 1) * (half + 600);
        pts[k * 4 + 1] = (rnd() * 2 - 1) * (half + 600);
      }
      const ptTex = new THREE.DataTexture(pts, n, n, THREE.RGBAFormat, THREE.FloatType);
      ptTex.minFilter = ptTex.magFilter = THREE.NearestFilter;
      ptTex.needsUpdate = true;
      const rt = new THREE.WebGLRenderTarget(n, n, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false });
      const mat = passMaterial(
        `${TK_NOISE}\n${TK_HEIGHT}\n${TK_DETAIL}
uniform highp sampler2D tkPts;
void main() {
  vec2 p = texelFetch( tkPts, ivec2( gl_FragCoord.xy ), 0 ).xy;
  vec3 s = tkSmooth( p );
  gl_FragColor = vec4( s.x + tkDetail( p, s.x, s.yz ).z, s.x, 0.0, 1.0 );
}`,
        { tkHeight: { value: heightTex }, tkSize: { value: size }, tkHalf: { value: half }, tkLattice: { value: latticeTex }, tkPts: { value: ptTex } },
      );
      const out = new Float32Array(n * n * 4);
      try {
        runner.run(mat, rt);
        renderer.readRenderTargetPixels(rt, 0, 0, n, n, out);
      } finally {
        mat.dispose();
        rt.dispose();
        ptTex.dispose();
      }
      let maxErr = 0;
      let sum = 0;
      let worst = null;
      for (let k = 0; k < n * n; k++) {
        const x = pts[k * 4];
        const z = pts[k * 4 + 1];
        const cpu = surface.full(x, z);
        const e = Math.abs(out[k * 4] - cpu);
        sum += e;
        if (e > maxErr) {
          maxErr = e;
          worst = { x: +x.toFixed(2), z: +z.toFixed(2), gpu: out[k * 4], cpu };
        }
      }
      return { points: n * n, maxErr, meanErr: sum / (n * n), worst };
    },

    update() {
      sunvis.refresh();
    },
    // Debug switches for profiling: { flat, noDetail, hidden, veg: { name: bool }, defines: { NAME: bool }, maxInstances }.
    setDebug({ flat, noDetail, hidden, veg, defines, maxInstances, rangeScale } = {}) {
      if (maxInstances !== undefined) debugMaxInstances = maxInstances ?? MAX_INSTANCES;
      if (rangeScale !== undefined) setRanges(rangeScale);
      if (defines) {
        material.defines = material.defines ?? {};
        for (const [k, v] of Object.entries(defines)) {
          if (v) material.defines[k] = 1;
          else delete material.defines[k];
        }
      }
      if (veg) for (const [k, v] of Object.entries(veg)) vegetation?.setVisible(k, v);
      material.defines = material.defines ?? {};
      if (flat !== undefined) {
        if (flat) material.defines.TK_DEBUG_FLAT = 1;
        else delete material.defines.TK_DEBUG_FLAT;
      }
      if (noDetail !== undefined) {
        if (noDetail) material.defines.TK_DEBUG_NODETAIL = 1;
        else delete material.defines.TK_DEBUG_NODETAIL;
      }
      if (hidden !== undefined) mesh.visible = !hidden;
      material.needsUpdate = true;
    },
    debugSelect: () => selectLod(),
    debugState() {
      return {
        instances,
        triangles: instances * (QUAD * QUAD * 2 + QUAD * 16),
        cpuMs: +hookMs.toFixed(3),
        selectMs: +selectMs.toFixed(3),
        shadowComputations: shadow.computations,
        despiked,
        vegetation: vegetation?.debugState() ?? null,
      };
    },
    serialize() {
      return undefined;
    },
    restore() {},
    reset() {},
  };
  return sys;
}

export const TERRAIN_INFO = { L0, ROOT_LEVEL };
