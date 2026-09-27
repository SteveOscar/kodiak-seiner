// WP-OCEAN: the sea (SPEC §6.3, §4.3).
//
// A camera/focus-following LOD grid displaced by a sum of Gerstner waves (long SW swell, wind sea, chop) whose
// amplitudes follow sky.weather and shrink in shallow water and sheltered bays. Every formula is mirrored on the CPU
// (water/waves.js) so heightAt/sample/velocityAt match the rendered surface. Shading: thin transparent layer over the
// kodiak_underwater-attenuated seabed, fresnel sky reflection (sky.envMap, CubeUV), two-lobe sun specular (glitter
// path), crest subsurface tint, detail normals, whitecaps, stamp foam/wakes/ripples, shore foam and wash, rain rings,
// mountain shadow, fog. An opaque abyss plane at y = -40 sits under everything.

import * as THREE from 'three';
import { computeFetch } from './water/fetch.js';
import { buildBank, createWaveModel, seaStateFromWeather, smoothSeaState, packWaveUniforms, MAX_WAVES, TAU } from './water/waves.js';
import { buildGrid, fadeRangeFor } from './water/grid.js';
import { createStampQueue } from './water/stamps.js';
import { SURFACE_VERTEX, SURFACE_FRAGMENT, ABYSS_VERTEX, ABYSS_FRAGMENT, VERIFY_VERTEX, VERIFY_FRAGMENT, VEIL_VERTEX, VEIL_FRAGMENT } from './water/glsl.js';
import { bakeTextures, placeholderTextures } from './water/textures.js';
import { createFoamField } from './water/foamField.js';
import { createReflection } from './water/reflection.js';
import { patchUnderwater } from '../render/shaderChunks.js';

const FIELD_SIZE = 1024;
// Cells per level half-side at waterSegments = 1. Components too short for the lattice are shaded per pixel, which
// is cheaper than more vertices (each vertex sums every resolved component).
const GRID_CELLS = 64;
const REFLECTION_INTERVAL = 3; // frames between planar reflection renders while the camera moves smoothly
const ABYSS_Y = -40;

// Palette (sRGB hexes, converted to linear by THREE.Color).
const DEEP = new THREE.Color('#11485a');
const DEEP_NIGHT = new THREE.Color('#06141c');
const SHELF = new THREE.Color('#2b8a86');
const SSS = new THREE.Color('#3fbf9f');
const FOAM = new THREE.Color('#f2f6f7');
const SLATE = new THREE.Color('#2a3d3f');

export async function create(ctx) {
  const { scene, uniforms, heightmap, config } = ctx;
  const rng = ctx.rng.fork('water');
  const half = config.world.half;
  const quality = ctx.quality ?? {};

  // --- Fields and wave model -------------------------------------------------------------------------------------
  const fetch = computeFetch({ heightAt: heightmap.heightAt, half });
  const hmFields = { size: heightmap.size, half, game: heightmap.game, shore: heightmap.shore };
  let cellsHalf = gridCellsFor(quality.waterSegments);
  let fade = fadeRangeFor(cellsHalf);
  const bank = buildBank(rng.fork('waves'));
  const model = createWaveModel({ bank, fields: { fetch, hm: hmFields }, fadeStart: fade.start, fadeEnd: fade.end });
  const sea = seaStateFromWeather(ctx.systems.sky?.weather);
  const seaTarget = { ...sea };
  model.update(sea, ctx.time.elapsed);

  // --- Textures --------------------------------------------------------------------------------------------------
  const fetchTexA = new THREE.DataTexture(fetch.a, fetch.N, fetch.N, THREE.RGBAFormat, THREE.FloatType);
  const fetchTexB = new THREE.DataTexture(fetch.b, fetch.N, fetch.N, THREE.RGBAFormat, THREE.FloatType);
  for (const t of [fetchTexA, fetchTexB]) {
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.generateMipmaps = false;
    t.colorSpace = THREE.NoColorSpace;
    t.needsUpdate = true;
  }
  const ph = placeholderTextures(THREE);

  // --- Surface ---------------------------------------------------------------------------------------------------
  let grid = buildGrid({ cellsHalf });
  const makeGeometry = () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(grid.positions, 3));
    g.setIndex(new THREE.BufferAttribute(grid.indices, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    return g;
  };
  const geometry = makeGeometry();

  const waveA = new Float32Array(MAX_WAVES * 4);
  const waveB = new Float32Array(MAX_WAVES * 4);
  const waveC = new Float32Array(MAX_WAVES * 4);
  const waveUniforms = {
    uWaveA: { value: waveA },
    uWaveB: { value: waveB },
    uWaveC: { value: waveC },
    uWaveCount: { value: 0 },
    uWaveFade: { value: new THREE.Vector4(fade.start, fade.end, 0, 0) },
    uGridCentre: { value: new THREE.Vector2() },
    uSurge: { value: new THREE.Vector4() },
    uHeightMap: uniforms.uHeightMap,
    uWorldHalf: uniforms.uWorldHalf,
    uFetchA: { value: fetchTexA },
    uFetchB: { value: fetchTexB },
    uSwellW0: { value: new THREE.Vector4().fromArray(model.swellW, 0) },
    uSwellW1: { value: new THREE.Vector4().fromArray(model.swellW, 4) },
    uWindW0: { value: new THREE.Vector4() },
    uWindW1: { value: new THREE.Vector4() },
  };

  const surfaceUniforms = {
    ...THREE.UniformsLib.fog,
    ...waveUniforms,
    uCellsHalf: { value: cellsHalf },
    uS0: { value: grid.s0 },
    uMaxFade: { value: fade.end * 240 },
    uMaxLambda: { value: 240 },
    uPixelAngle: { value: 0.0013 },
    uTerrainShadow: uniforms.uTerrainShadow,
    uSunDir: uniforms.uSunDir,
    uSunColor: uniforms.uSunColor,
    uSkyColor: uniforms.uSkyColor,
    uHorizonColor: uniforms.uHorizonColor,
    uDaylight: uniforms.uDaylight,
    uWindDir: uniforms.uWindDir,
    uWindSpeed: uniforms.uWindSpeed,
    uRain: uniforms.uRain,
    uCloudCover: uniforms.uCloudCover,
    uTime: uniforms.uTime,
    uWaterScatter: uniforms.uWaterScatter,
    uWaterAbsorb: uniforms.uWaterAbsorb,
    uDetail: { value: ph.detail },
    uFoamNoise: { value: ph.foamNoise },
    uFoamField: { value: ph.zero },
    uRippleField: { value: ph.zero },
    uFieldInfo: { value: new THREE.Vector4(FIELD_SIZE, 0, 0, 0) },
    uRippleInfo: { value: new THREE.Vector4(512, 0, 0, 0) },
    uShelfColor: { value: SHELF.clone() },
    uSSSColor: { value: SSS.clone() },
    uFoamColor: { value: FOAM.clone() },
    uSea: { value: new THREE.Vector4() },
    uWindSteep: { value: 0 },
    uLight: { value: new THREE.Vector4(2.5, 1, 0, 1) },
    uEnvMap: { value: null },
    uCamUnder: { value: 0 },
    uReflTex: { value: ph.zero },
    uReflDepth: { value: ph.zero },
    uReflMatrix: { value: new THREE.Matrix4() },
    uRefl: { value: new THREE.Vector4(0, 1, 0.6, 0) },
  };

  const material = new THREE.ShaderMaterial({
    name: 'water-surface',
    vertexShader: SURFACE_VERTEX,
    fragmentShader: SURFACE_FRAGMENT,
    uniforms: surfaceUniforms,
    transparent: true,
    depthWrite: true,
    side: THREE.DoubleSide,
    forceSinglePass: true,
    fog: true,
    dithering: true,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'water';
  mesh.frustumCulled = false;
  mesh.renderOrder = 0;
  mesh.matrixAutoUpdate = false;
  mesh.receiveShadow = false;
  mesh.castShadow = false;
  scene.add(mesh);

  // --- Abyss -----------------------------------------------------------------------------------------------------
  const abyssMat = new THREE.ShaderMaterial({
    name: 'water-abyss',
    vertexShader: ABYSS_VERTEX,
    fragmentShader: ABYSS_FRAGMENT,
    uniforms: { ...THREE.UniformsLib.fog, uWaterScatter: uniforms.uWaterScatter },
    fog: true,
  });
  const abyss = new THREE.Mesh(new THREE.PlaneGeometry(90000, 90000, 1, 1).rotateX(-Math.PI / 2), abyssMat);
  abyss.name = 'water-abyss';
  abyss.position.y = ABYSS_Y;
  abyss.frustumCulled = false;
  abyss.renderOrder = 0;
  scene.add(abyss);

  // --- Underwater veil (fallback when a camera ends up below the surface) ---------------------------------------
  const veilUniforms = {
    ...THREE.UniformsLib.fog,
    uWaterScatter: uniforms.uWaterScatter,
    uWaterAbsorb: uniforms.uWaterAbsorb,
    uInvViewProj: { value: new THREE.Matrix4() },
    uDepth: { value: 0 },
  };
  const veil = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({
      name: 'water-underwater-veil',
      vertexShader: VEIL_VERTEX,
      fragmentShader: VEIL_FRAGMENT,
      uniforms: veilUniforms,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      fog: true,
    }),
  );
  veil.name = 'water-underwater-veil';
  veil.frustumCulled = false;
  veil.renderOrder = 440;
  veil.visible = false;
  scene.add(veil);

  // --- Occluders -------------------------------------------------------------------------------------------------
  const occluderMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true });
  occluderMat.name = 'water-occluder';
  const occluders = new Set();

  // --- Stamps and GPU field (created lazily with the renderer) ---------------------------------------------------
  const queue = createStampQueue({ fieldSize: FIELD_SIZE });
  let field = null;
  let baked = null;
  // Planar reflection: ultra/high at half resolution, medium at a third, off on low.
  const reflScale = { ultra: 0.5, high: 0.5, medium: 0.34 }[quality.name] ?? 0;
  let reflection = null;
  let reflEnabled = reflScale > 0;
  let fieldDt = 0;

  // --- State -----------------------------------------------------------------------------------------------------
  const tmpDir = new THREE.Vector3();
  const centre = { x: 0, z: 0 };
  const gridCentre = { x: 0, z: 0 };
  const deepCol = new THREE.Color();
  const night = DEEP_NIGHT.clone();
  let envTex = null;
  let lastWeatherPreset = null;
  let firstUpdate = true;

  // Where the dense part of the grid (and the wave distance fade) is centred: the camera focus (the boat) in normal
  // play, drifting to a point just ahead of the camera when the camera is far from the focus (vistas, debug shots).
  function desiredCentre(out) {
    const ov = ctx.debug?.cameraOverride;
    let cx;
    let cy;
    let cz;
    if (ov) {
      cx = ov.pos[0];
      cy = ov.pos[1];
      cz = ov.pos[2];
      tmpDir.set(ov.look[0] - cx, ov.look[1] - cy, ov.look[2] - cz).normalize();
    } else {
      cx = ctx.camera.position.x;
      cy = ctx.camera.position.y;
      cz = ctx.camera.position.z;
      ctx.camera.getWorldDirection(tmpDir);
    }
    const hl = Math.hypot(tmpDir.x, tmpDir.z) || 1;
    const ahead = Math.min(Math.max(0, cy) * 1.2 + 8, 60);
    const ax = cx + (tmpDir.x / hl) * ahead;
    const az = cz + (tmpDir.z / hl) * ahead;
    const f = ctx.systems.cameraRig?.focus;
    let t = 1;
    if (f && Number.isFinite(f.x) && Number.isFinite(f.z) && !ov) {
      const d = Math.hypot(f.x - cx, f.z - cz);
      t = smooth(80, 300, d);
      out.x = f.x + (ax - f.x) * t;
      out.z = f.z + (az - f.z) * t;
    } else {
      out.x = ax;
      out.z = az;
    }
    return out;
  }

  function fieldCentre(out) {
    const f = ctx.systems.cameraRig?.focus;
    if (f && Number.isFinite(f.x) && Number.isFinite(f.z)) {
      out.x = f.x;
      out.z = f.z;
    } else {
      out.x = ctx.camera.position.x;
      out.z = ctx.camera.position.z;
    }
    return out;
  }

  let seaOverride = null;
  function readWeather(dt) {
    const w0 = ctx.systems.sky?.weather;
    const w = seaOverride ? { ...w0, ...seaOverride } : w0;
    Object.assign(seaTarget, seaStateFromWeather(w));
    const key = seaOverride ? JSON.stringify(seaOverride) : w?.preset;
    const presetChanged = key !== lastWeatherPreset;
    lastWeatherPreset = key;
    // Snap on the first frame and on debug weather pins (instant screenshots); otherwise ease.
    if (firstUpdate || (presetChanged && ctx.debug?.weatherPinned)) Object.assign(sea, seaTarget);
    else smoothSeaState(sea, seaTarget, dt);
  }

  function writeSharedUniforms() {
    const U = sea.windSpeed;
    const hs = Math.hypot(sea.swellHs, sea.windHs);
    uniforms.uWaveState.value.set(hs / 2, sea.choppiness - 1, sea.whitecaps, hs);
    // Water column: scatter follows daylight (and greys under heavy cloud); absorption is clear coastal water.
    const day = THREE.MathUtils.clamp(uniforms.uDaylight.value ?? 1, 0, 1);
    const cloud = THREE.MathUtils.clamp(uniforms.uCloudCover.value ?? 0, 0, 1);
    const lum = 0.03 + 0.97 * Math.pow(day, 1.15);
    // Heavy cloud and wind turn the Gulf from teal-navy to dark slate.
    deepCol.copy(DEEP).lerp(SLATE, Math.min(0.85, cloud * 0.55 + Math.min(1, U / 20) * 0.25));
    deepCol.multiplyScalar(lum);
    uniforms.uWaterScatter.value.copy(night).multiplyScalar(1 - lum).add(deepCol);
    uniforms.uWaterAbsorb.value.set(0.42 + 0.1 * cloud, 0.085 + 0.02 * cloud, 0.075 + 0.03 * cloud);
  }
  const tmpColor = new THREE.Color();

  function writeWaveUniforms() {
    const cx = gridCentre.x;
    const cz = gridCentre.z;
    waveUniforms.uWaveCount.value = packWaveUniforms(model, cx, cz, waveA, waveB, waveC);
    waveUniforms.uGridCentre.value.set(cx, cz);
    waveUniforms.uWaveFade.value.set(fade.start, fade.end, model.state.fadeX - cx, model.state.fadeZ - cz);
    waveUniforms.uSurge.value.set(model.state.surgeAmp, model.state.surgePhase, 0, 0);
    let steep = 0;
    for (let i = 0; i < model.act.count; i++) steep += model.act.ww[i] * model.act.k[i] * model.act.amp[i];
    surfaceUniforms.uWindSteep.value = steep;
    const ww = model.windW;
    waveUniforms.uWindW0.value.set(ww[0], ww[1], ww[2], ww[3]);
    waveUniforms.uWindW1.value.set(ww[4], ww[5], ww[6], ww[7]);
  }

  function hookEnvMap() {
    const sky = ctx.systems.sky;
    const env = sky?.envMap ?? null;
    if (env === envTex) return;
    envTex = env;
    const defs = material.defines;
    delete defs.ENVMAP_TYPE_CUBE_UV;
    delete defs.CUBEUV_TEXEL_WIDTH;
    delete defs.CUBEUV_TEXEL_HEIGHT;
    delete defs.CUBEUV_MAX_MIP;
    if (env) {
      let d = sky.envMapDefines;
      if (!d || d.CUBEUV_MAX_MIP === undefined) {
        const h = env.image?.height ?? 256;
        const maxMip = Math.log2(h) - 2;
        d = {
          ENVMAP_TYPE_CUBE_UV: '',
          CUBEUV_TEXEL_WIDTH: 1 / (3 * Math.max(Math.pow(2, maxMip), 7 * 16)),
          CUBEUV_TEXEL_HEIGHT: 1 / h,
          CUBEUV_MAX_MIP: `${maxMip}.0`,
        };
      }
      Object.assign(defs, d);
      defs.ENVMAP_TYPE_CUBE_UV = '';
      surfaceUniforms.uEnvMap.value = env;
    } else {
      surfaceUniforms.uEnvMap.value = null;
    }
    material.needsUpdate = true;
  }

  function writeLightUniforms() {
    const sky = ctx.systems.sky;
    // Key-light irradiance = uSunColor * pi with WP-SKY (uSunColor is irradiance / pi, unshadowed; the water shadows
    // itself per pixel with uTerrainShadow). The core stub keeps uSunColor at unit chroma and scales the light.
    const real = !!sky?.trueSunDirection;
    const sunI = real ? Math.PI : Math.max(0.2, sky?.sunLight?.intensity ?? 2.4);
    surfaceUniforms.uLight.value.set(sunI, 1, 0, 1);
    const hs = Math.hypot(sea.swellHs, sea.windHs);
    surfaceUniforms.uSea.value.set(sea.whitecaps, sea.detail, sea.choppiness, hs);
  }

  // Patch the core terrain stub's seabed so the thin-surface look is right while the real terrain is absent.
  ctx.events.on('game:ready', () => {
    const t = ctx.systems.terrain;
    if (t?.mesh?.name === 'terrain-stub' && t.mesh.material && !t.mesh.material.userData.kodiakUnderwater) {
      t.mesh.material.userData.kodiakUnderwater = true;
      patchUnderwater(t.mesh.material, uniforms);
    }
    hookEnvMap();
  });

  // --- Per-frame GPU work (camera is final here) --------------------------------------------------------------------
  ctx.pipeline.beforeRender(() => {
    const cam = ctx.camera.position;
    // Grid: snapped (rigid, world-fixed lattice between snaps).
    const c = desiredCentre(tmpC);
    const S = grid.snap;
    gridCentre.x = Math.round(c.x / S) * S;
    gridCentre.z = Math.round(c.z / S) * S;
    writeWaveUniforms();
    const dbs = ctx.renderer?.getDrawingBufferSize?.(tmpV2);
    const hPx = Math.max(1, dbs?.y || 720);
    surfaceUniforms.uPixelAngle.value = (2 * Math.tan(THREE.MathUtils.degToRad(ctx.camera.fov) / 2)) / (hPx * (ctx.camera.zoom || 1));
    const surfaceY = model.heightAt(cam.x, cam.z);
    surfaceUniforms.uCamUnder.value = cam.y < surfaceY ? 1 : 0;
    veil.visible = cam.y < surfaceY - 0.05;
    if (veil.visible) {
      veilUniforms.uDepth.value = surfaceY - cam.y;
      veilUniforms.uInvViewProj.value.multiplyMatrices(ctx.camera.projectionMatrix, ctx.camera.matrixWorldInverse).invert();
    }
    abyss.position.set(Math.round(cam.x / 64) * 64, ABYSS_Y, Math.round(cam.z / 64) * 64);
    abyss.updateMatrixWorld();
    hookEnvMap();

    const renderer = ctx.renderer;
    if (!renderer) return;
    try {
      if (!baked) {
        baked = bakeTextures({ THREE, renderer, rng: rng.fork('textures') });
        surfaceUniforms.uDetail.value = baked.detail;
        surfaceUniforms.uFoamNoise.value = baked.foamNoise;
      }
      if (!field) {
        field = createFoamField({ THREE, renderer, size: FIELD_SIZE });
        surfaceUniforms.uFoamField.value = field.foamTexture;
        surfaceUniforms.uRippleField.value = field.rippleTexture;
      }
      const fc = fieldCentre(tmpF);
      if (debugToggles.field) field.render(fc.x, fc.z, queue, fieldDt);
      renderReflection(renderer);
      fieldDt = 0;
      surfaceUniforms.uFieldInfo.value.set(FIELD_SIZE, field.state.centreX, field.state.centreZ, 1);
      surfaceUniforms.uRippleInfo.value.set(field.rippleSize, field.state.rippleCentreX, field.state.rippleCentreZ, 1);
    } catch (err) {
      if (!gpuFailed) console.error('[water] GPU field pass failed', err);
      gpuFailed = true;
    }
    queue.endFrame();
  });
  const tmpC = { x: 0, z: 0 };
  const tmpV2 = new THREE.Vector2();
  const tmpF = { x: 0, z: 0 };
  let gpuFailed = false;
  const debugToggles = { field: true, bake: true };

  // Reflections only pay off on calm-to-moderate water in some light; above ~10 m/s they are unreadable.
  function renderReflection(renderer) {
    const u = surfaceUniforms.uRefl.value;
    const day = uniforms.uDaylight.value ?? 1;
    const amount = reflEnabled ? (1 - smooth(6, 10.5, sea.windSpeed)) * smooth(0.02, 0.12, day) : 0;
    if (amount <= 0.01 || surfaceUniforms.uCamUnder.value > 0.5) {
      u.x = 0;
      reflValid = false;
      return;
    }
    if (!reflection) {
      reflection = createReflection({ THREE, renderer, scene, camera: ctx.camera, scale: reflScale });
      surfaceUniforms.uReflTex.value = reflection.texture;
      surfaceUniforms.uReflDepth.value = reflection.depthTexture;
      ctx.pipeline.onResize(() => reflection?.resize());
    }
    // Every third frame: the shader projects through the matrix the image was rendered with, so an older reflection
    // stays registered under camera rotation, and a few frames of camera travel are ~1 px of parallax against
    // terrain hundreds of metres away (only terrain and the sky dome are reflected). Cuts, teleports and fast pans
    // (> ~3 degrees or 2 m since the last render) re-render at once.
    const camM = ctx.camera.matrixWorld.elements;
    let moved = 0;
    for (let i = 0; i < 16; i++) moved = Math.max(moved, Math.abs(camM[i] - lastReflCam[i]) * (i >= 12 ? 0.5 : 20));
    reflFrame++;
    if (reflValid && moved < 1 && reflFrame % REFLECTION_INTERVAL !== 0) {
      u.x = amount;
      return;
    }
    const sky = ctx.systems.sky;
    const ok = reflection.render([sky?.sunLight, sky?.hemiLight]);
    reflValid = ok;
    for (let i = 0; i < 16; i++) lastReflCam[i] = camM[i];
    u.x = ok ? amount : 0;
    u.y = renderer.state?.buffers?.depth?.getReversed?.() ? 1 : 0;
    surfaceUniforms.uReflMatrix.value.copy(reflection.textureMatrix);
  }
  const lastReflCam = new Float64Array(16);
  let reflFrame = 0;
  let reflValid = false;

  const sys = {
    mesh,
    abyss,
    model,
    sea,

    update(dt) {
      readWeather(dt);
      firstUpdate = false;
      const c = desiredCentre(centre);
      model.setFadeCentre(c.x, c.z);
      model.update(sea, ctx.time.elapsed);
      queue.now = ctx.time.elapsed;
      fieldDt += dt;
      writeSharedUniforms();
      writeLightUniforms();
    },

    // Height of the water surface (waves included) at world (x, z).
    heightAt(x, z) {
      calls.heightAt++;
      return model.heightAt(x, z);
    },

    // { height, normal } of the water surface at world (x, z).
    sample(x, z, out) {
      calls.sample++;
      const o = out ?? { height: 0, normal: new THREE.Vector3() };
      if (!o.normal) o.normal = new THREE.Vector3();
      o.height = model.sample(x, z, o.normal);
      return o;
    },

    // Surface water velocity (m/s): wave orbital motion plus the tidal/wind current.
    velocityAt(x, z, out = new THREE.Vector3()) {
      calls.velocityAt++;
      model.velocityAt(x, z, out);
      const cur = ctx.tide?.currentAt?.(x, z, tmpCur);
      if (cur) {
        out.x += cur.x;
        out.z += cur.z;
      }
      return out;
    },

    // Local significant wave height (m) including shelter and depth.
    seaStateAt(x, z) {
      return model.localHs(x, z);
    },

    stamp(x, z, radius = 2, strength = 1, kind = 'foam') {
      return queue.stamp(x, z, radius, strength, kind);
    },

    addOccluder(m) {
      if (!m || !m.isMesh) return;
      m.material = occluderMat;
      m.renderOrder = 900;
      m.castShadow = false;
      m.receiveShadow = false;
      m.layers.set(0);
      m.visible = true;
      occluders.add(m);
    },

    removeOccluder(m) {
      if (!m) return;
      if (occluders.delete(m)) m.visible = false;
    },

    // GPU vs CPU agreement check (debug/QA): renders the displaced position of n random points near (x, z) with the
    // real vertex-shader code and compares heightAt at the displaced xz. Returns error stats in metres.
    verify(n = 256, x = centre.x, z = centre.z, radius = 150) {
      const renderer = ctx.renderer;
      if (!renderer) return null;
      const pts = new Float32Array(n * 3);
      const index = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * TAU;
        const r = Math.sqrt(Math.random()) * radius;
        pts[i * 3] = x + Math.cos(a) * r;
        pts[i * 3 + 2] = z + Math.sin(a) * r;
        index[i] = i;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
      geo.setAttribute('aIndex', new THREE.BufferAttribute(index, 1));
      const mat = new THREE.ShaderMaterial({
        vertexShader: VERIFY_VERTEX,
        fragmentShader: VERIFY_FRAGMENT,
        uniforms: { ...waveUniforms, uCount: { value: n } },
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      });
      const pts3 = new THREE.Points(geo, mat);
      pts3.frustumCulled = false;
      const rt = new THREE.WebGLRenderTarget(n, 1, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false });
      const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(rt);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, false, false);
      renderer.render(pts3, cam);
      const buf = new Float32Array(n * 4);
      renderer.readRenderTargetPixels(rt, 0, 0, n, 1, buf);
      renderer.setRenderTarget(prev);
      let max = 0;
      let sum = 0;
      let maxFwd = 0;
      const fwd = { x: 0, y: 0, z: 0 };
      for (let i = 0; i < n; i++) {
        const px = buf[i * 4] + gridCentre.x;
        const py = buf[i * 4 + 1];
        const pz = buf[i * 4 + 2] + gridCentre.z;
        const e = Math.abs(model.heightAt(px, pz) - py);
        model.forward(pts[i * 3], pts[i * 3 + 2], fwd);
        maxFwd = Math.max(maxFwd, Math.abs(fwd.y - py), Math.abs(fwd.x - px), Math.abs(fwd.z - pz));
        max = Math.max(max, e);
        sum += e;
      }
      geo.dispose();
      mat.dispose();
      rt.dispose();
      return { n, maxError: max, meanError: sum / n, maxForwardError: maxFwd, waves: model.act.count };
    },

    // Debug/QA: pin sea-state inputs ({ windSpeed, windDir, swell, rain }) over sky.weather; null releases.
    overrideSea(o) {
      seaOverride = o && typeof o === 'object' ? { ...o } : null;
    },

    // QA: toggle the planar reflection pass (on by default where the quality preset allows it).
    setReflections(on) {
      reflEnabled = !!on && reflScale > 0;
      if (!reflEnabled) surfaceUniforms.uRefl.value.x = 0;
    },

    // QA: rebuild the surface lattice with another density (cells per level half-side, multiple of 4).
    setGridCells(n) {
      cellsHalf = Math.max(16, Math.round(n / 4) * 4);
      fade = fadeRangeFor(cellsHalf);
      grid = buildGrid({ cellsHalf });
      mesh.geometry.dispose();
      mesh.geometry = makeGeometry();
      model.state.fadeStart = fade.start;
      model.state.fadeEnd = fade.end;
      surfaceUniforms.uCellsHalf.value = cellsHalf;
      surfaceUniforms.uMaxFade.value = fade.end * 240;
      return { cellsHalf, triangles: grid.indices.length / 3, vertices: grid.positions.length / 3 };
    },

    // QA: false-colour views of shading terms (a compile-time define; a runtime branch costs several ms).
    debugView(mode) {
      const modes = [null, 'foam', 'normal', 'spec', 'shadow', 'rough', 'alpha', 'detail', 'refl', 'fresnel', 'premult', 'col'];
      const i = Math.max(0, modes.indexOf(mode ?? null));
      if (i > 0) material.defines.DEBUG_VIEW = i;
      else delete material.defines.DEBUG_VIEW;
      material.needsUpdate = true;
    },

    debugState() {
      return {
        swellHs: +sea.swellHs.toFixed(2),
        windSea: +sea.windHs.toFixed(2),
        wind: +sea.windSpeed.toFixed(1),
        waves: model.act.count,
        cells: cellsHalf,
        triangles: grid.indices.length / 3,
        ripples: queue.liveRipples(),
        stamps: field?.state.stampsDrawn ?? 0,
        centre: [Math.round(gridCentre.x), Math.round(gridCentre.z)],
        env: !!envTex,
        reflection: +surfaceUniforms.uRefl.value.x.toFixed(2),
      };
    },

    serialize() {
      return undefined;
    },
    restore() {},
    reset() {
      queue.clear();
      field?.reset();
      fieldDt = 0;
    },
  };
  const tmpCur = { x: 0, z: 0 };
  // Per-frame query counters (debugState reports the previous frame's totals).
  const calls = { heightAt: 0, sample: 0, velocityAt: 0 };
  const lastCalls = { heightAt: 0, sample: 0, velocityAt: 0 };
  sys.debugToggles = debugToggles;
  // QA: direct access to the secondary passes (timing probes).
  sys.qaPasses = {
    field: () => field && field.render(fieldCentre(tmpF).x, fieldCentre(tmpF).z, queue, 1 / 60),
    reflection: () => reflection && reflection.render([ctx.systems.sky?.sunLight, ctx.systems.sky?.hemiLight]),
  };
  ctx.pipeline.afterRender(() => {
    Object.assign(lastCalls, calls);
    calls.heightAt = calls.sample = calls.velocityAt = 0;
  });
  sys.queryCounts = lastCalls;
  return sys;
}

// Lattice density (cells per level half-side) for quality.waterSegments.
export function gridCellsFor(segments = 1) {
  return Math.max(32, Math.min(128, Math.round((GRID_CELLS * segments) / 4) * 4));
}

function smooth(a, b, x) {
  let t = (x - a) / (b - a);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}
