// WP-TERRAIN: the Kodiak archipelago and the Alaska Peninsula backdrop (SPEC §6.4).
//
//   geometry    CDLOD quadtree of instanced 32x32 grid quadrants displaced on the GPU from a despiked copy of the DEM
//               (terrain/quadtree.js, terrain/lodMesh.js, terrain/material.js); heightAt() returns exactly the
//               finest-level surface. A second, coarser mesh with a cheap shader is drawn only by the planar water
//               reflection (camera layer 1).
//   material    slope/height/aspect/shore/drainage splatting, fall-line rills and alder fingers, triplanar rock,
//               detail normals, lakes, seabed with caustics and kodiak_underwater; direct sun = uSunColor x
//               uTerrainShadow.
//   shadow      GPU raymarched terrain sun shadow published as uniforms.uTerrainShadow (terrain/shadowPass.js) and
//               the matching CPU sunVisibilityAt() (terrain/sunvis.js).
//   vegetation  spruce forests with impostors and shadow proxies, alder and salmonberry, grass, ferns, fireweed and
//               lupine, beach boulders and driftwood, bull kelp (terrain/vegetation/*).

import * as THREE from 'three';
import { despike } from './terrain/despike.js';
import { createSurface, createCurvature, L0, latticeRGBA, LATTICE_N } from './terrain/surface.js';
import { createBounds, DEFAULT_RANGES, ROOT_LEVEL } from './terrain/quadtree.js';
import { createPatchGeometry, createLodMesh, TRIANGLES_PER_QUADRANT } from './terrain/lodMesh.js';
import { buildRegion, createLandcover, REGION_SIZE } from './terrain/landcover.js';
import { createSunVisibility } from './terrain/sunvis.js';
import { computeDrainage, createWetnessSampler, drainageR8 } from './terrain/drainage.js';
import { createPassRunner, createHeightTexture, createInfoTextures, createDetailTextures, createCoverTextures, passMaterial } from './terrain/gpuPrep.js';
import { TK_NOISE, TK_HEIGHT, TK_DETAIL } from './terrain/glsl.js';
import { createShadowPass } from './terrain/shadowPass.js';
import { createTerrainMaterial } from './terrain/material.js';
import { createVegetation } from './terrain/vegetation/index.js';

const MAX_INSTANCES = 4096;
// LOD ranges of the reflection mesh: about half the main view's detail (the planar reflection is half resolution and
// wave-distorted); every level still spans ~2 of its node sizes, and skirts cover the rest.
const REFLECTION_RANGES = [60, 360, 1100, 2200, 4200, 8000, 16000, 52000];

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

  // ---- LOD meshes: the main view (layer 0) and a coarser, cheaply shaded copy that only the planar water
  // reflection draws (layer 1). Both select land from the real camera; the reflection keeps what the mirror sees.
  const textures = { info: info.texture, coverA: cover.a.texture, coverB: cover.b.texture, coverC: cover.c.texture, lattice: latticeTex, region: regionTex, rock: detail.rock.texture, cliff: detail.cliff.texture, ground: detail.ground.texture, gravel: detail.gravel.texture };
  const matOpts = { uniforms, textures, heightTex, size, half, getEnvDefines: () => ctx.systems.sky?.envMapDefines ?? null };
  const lodUniform = { value: [] };
  const reflLodUniform = { value: [] };
  const material = createTerrainMaterial({ ...matOpts, lodUniform });
  const reflMaterial = createTerrainMaterial({ ...matOpts, lodUniform: reflLodUniform, cheap: true });
  reflMaterial.userData.tk.tkSunScale = material.userData.tk.tkSunScale;
  const dbg = new URLSearchParams(globalThis.location?.search ?? '').get('tkdbg');
  material.defines = material.defines ?? {};
  if (dbg) for (const d of dbg.split('.')) material.defines[`TK_DBG_${d.toUpperCase()}`] = 1;
  material.userData.textures = textures;
  const baseRangeScale = quality.name === 'low' ? 0.7 : 1;
  const patch = createPatchGeometry();
  const main = createLodMesh({ base: patch, bounds, ranges: DEFAULT_RANGES.map((r) => r * baseRangeScale), lodUniform, material, maxInstances: MAX_INSTANCES, name: 'terrain' });
  const refl = createLodMesh({ base: patch, bounds, ranges: REFLECTION_RANGES, lodUniform: reflLodUniform, material: reflMaterial, maxInstances: 2048, reflectOnly: true, name: 'terrain-reflection' });
  const mesh = main.mesh;
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.layers.set(0);
  scene.add(mesh);
  const reflMesh = refl.mesh;
  reflMesh.receiveShadow = true;
  reflMesh.castShadow = false;
  reflMesh.layers.set(1);
  scene.add(reflMesh);
  // The low preset has no planar reflection (WP-OCEAN), so its mesh is never drawn; skip its selection too.
  const reflectionsPossible = quality.name !== 'low';

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
  let selectMs = 0;
  // Selection depends only on the camera, so it is skipped while the camera holds still (paused, photo framing).
  const lastView = new Float64Array(32).fill(NaN);
  let forceSelect = true;
  function cameraChanged() {
    const a = camera.matrixWorld.elements;
    const b = camera.projectionMatrix.elements;
    let changed = forceSelect;
    for (let i = 0; i < 16; i++) {
      if (lastView[i] !== a[i] || lastView[16 + i] !== b[i]) {
        changed = true;
        lastView[i] = a[i];
        lastView[16 + i] = b[i];
      }
    }
    forceSelect = false;
    return changed;
  }
  function selectLod() {
    camera.updateMatrixWorld();
    if (!cameraChanged()) return;
    const t0 = performance.now();
    projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projView, camera.coordinateSystem, camera.reversedDepth);
    main.select(camera.position, frustum.planes);
    // The reflection is only rendered from above the sea surface.
    if (reflectionsPossible && camera.position.y > 0.05) refl.select(camera.position, frustum.planes);
    else refl.clear();
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
    reflectionMesh: reflMesh,
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
    // The camera is final here in play (cameraRig moves it in lateUpdate), and this runs before the water system's
    // beforeRender reflection pass, which draws the reflection mesh with this frame's selection. beforeRender selects
    // again only if the camera moved since (photo mode, debug camera).
    frame() {
      // A debug camera override is applied after frame(), so selecting here would be wasted work.
      if (ctx.debug?.cameraOverride) return;
      try {
        selectLod();
      } catch (err) {
        if (!hookErrors++) console.error('[terrain] LOD selection failed', err);
      }
    },
    // Debug switches for profiling: { flat, noDetail, hidden, veg: { name: bool }, defines: { NAME: bool }, maxInstances }.
    setDebug({ flat, noDetail, hidden, veg, defines, maxInstances, rangeScale, reflection } = {}) {
      if (maxInstances !== undefined) main.limit = maxInstances;
      if (rangeScale !== undefined) main.setRanges(DEFAULT_RANGES.map((r) => r * rangeScale));
      if (reflection !== undefined) reflMesh.visible = !!reflection;
      forceSelect = true;
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
      if (hidden !== undefined) mesh.visible = reflMesh.visible = !hidden;
      material.needsUpdate = true;
    },
    debugSelect: () => {
      forceSelect = true;
      selectLod();
    },
    debugState() {
      return {
        instances: main.instances,
        triangles: main.instances * TRIANGLES_PER_QUADRANT,
        reflectionInstances: refl.instances,
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
