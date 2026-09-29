// WP-SKY: physically based sky, sun/moon/stars/aurora, clouds, weather, fog contract, lights, shadows, env map,
// rain and low cloud / mist banks. SPEC §4.3, §6.1. Sub-modules live in ./sky/.
//
// Public surface (superset of the stub and REQUIRED): sunDirection (= uniforms.uSunDir.value, the key light: the sun
// by day, the moon or the twilight glow by night), trueSunDirection, moonDirection, sunLight, hemiLight,
// shadowFocus, daylight, sunElevationDeg, moonElevationDeg, moonIllumination, moonPhase, isNight, envMap,
// envMapDefines, weather, setWeather(preset, seconds = 20), sunTimes(day?), lightning.

import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { skyAstronomy, sunTimes as astroSunTimes } from './sky/astro.js';
import { createAtmosphere } from './sky/atmosphere.js';
import { createLightModel, SKY_TUNING } from './sky/lightModel.js';
import { createWeather, fogDensityForVisibility, PRESETS } from './sky/weather.js';
import { cloudNoise2D, mistNoise3D, sampleNoise2D } from './sky/noise.js';
import { createFogUniforms, installFogChunks } from './sky/fogChunks.js';
import { SKYVIEW_VERT, skyViewFrag, DOME_VERT, domeFrag, CLOUD_LAYER, GAME_TO_REAL_KM } from './sky/shaders.js';
import { createEnvCapture } from './sky/envCapture.js';
import { shouldCaptureEnv } from './sky/envPolicy.js';
import { createRain } from './sky/rain.js';
import { createMist } from './sky/mist.js';
import { runFogCheck } from './sky/fogCheck.js';

const DEG = Math.PI / 180;
const SHADOW_HALF = 150; // m, half-size of the single shadow cascade around shadowFocus
const SUN_DISC_GAIN = 42;
const MOON_DISC = new THREE.Color(1.05, 1.02, 0.95).multiplyScalar(0.42);
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function lutTexture(lut) {
  const half = new Uint16Array(lut.data.length);
  for (let i = 0; i < lut.data.length; i++) half[i] = THREE.DataUtils.toHalfFloat(lut.data[i]);
  const t = new THREE.DataTexture(half, lut.width, lut.height, THREE.RGBAFormat, THREE.HalfFloatType);
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

export async function create(ctx) {
  const { scene, uniforms, clock, renderer, camera, pipeline, events, quality } = ctx;
  const rng = ctx.rng.fork('sky');

  // Fog contract first: every material compiled from here on uses these chunks.
  const fogUniforms = createFogUniforms();
  installFogChunks(THREE, fogUniforms);
  scene.fog = new THREE.FogExp2(uniforms.uFogColor.value.clone(), uniforms.uFogDensity.value);
  scene.background = new THREE.Color().copy(uniforms.uHorizonColor.value);

  // Atmosphere model and its LUTs (identical data on CPU and GPU).
  const atmosphere = createAtmosphere();
  const lightModel = createLightModel(atmosphere);
  const transmittanceTex = lutTexture(atmosphere.transmittanceLUT);
  const multiScatterTex = lutTexture(atmosphere.msLUT);

  // Procedural noise.
  const cloudField = cloudNoise2D(256, 1 + Math.floor(rng.fork('clouds').next() * 1000));
  const cloudTex = new THREE.DataTexture(cloudField.data, cloudField.size, cloudField.size, THREE.RGBAFormat);
  cloudTex.wrapS = cloudTex.wrapT = THREE.RepeatWrapping;
  cloudTex.minFilter = THREE.LinearMipmapLinearFilter;
  cloudTex.magFilter = THREE.LinearFilter;
  cloudTex.generateMipmaps = true;
  cloudTex.colorSpace = THREE.NoColorSpace;
  cloudTex.anisotropy = 4;
  cloudTex.needsUpdate = true;
  const mistField = mistNoise3D(32, 5 + Math.floor(rng.fork('mistNoise').next() * 1000));
  const mistTex = new THREE.Data3DTexture(mistField.data, mistField.size, mistField.size, mistField.size);
  mistTex.format = THREE.RGFormat;
  mistTex.type = THREE.UnsignedByteType;
  mistTex.wrapS = mistTex.wrapT = mistTex.wrapR = THREE.RepeatWrapping;
  mistTex.minFilter = THREE.LinearFilter;
  mistTex.magFilter = THREE.LinearFilter;
  mistTex.unpackAlignment = 1;
  mistTex.needsUpdate = true;

  // Sky-view LUT (display radiance per direction), re-rendered when the sun or moon moves.
  const skyViewTarget = new THREE.WebGLRenderTarget(256, 128, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    generateMipmaps: false,
  });
  skyViewTarget.texture.name = 'sky.skyView';
  const skyViewMaterial = new THREE.ShaderMaterial({
    name: 'sky-view-lut',
    uniforms: {
      uTransmittanceLUT: { value: transmittanceTex },
      uMultiScatterLUT: { value: multiScatterTex },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uSunScale: { value: 1 },
      uSunTint: { value: new THREE.Vector3(1, 1, 1) },
      uMoonScale: { value: 0 },
      uAirglow: { value: new THREE.Vector3() },
      uViewAlt: { value: atmosphere.params.viewAltitude },
    },
    vertexShader: SKYVIEW_VERT,
    fragmentShader: skyViewFrag(),
    depthTest: false,
    depthWrite: false,
  });
  const skyViewQuad = new FullScreenQuad(skyViewMaterial);

  // Dome (main view) and its env-capture variant share uniforms.
  const trueSun = new THREE.Vector3(0, 1, 0);
  const moonDirection = new THREE.Vector3(0, -1, 0);
  const domeUniforms = {
    ...fogUniforms,
    uSkyView: { value: skyViewTarget.texture },
    uTransmittanceLUT: { value: transmittanceTex },
    uMultiScatterLUT: { value: multiScatterTex },
    uCloudNoise: { value: cloudTex },
    uSunDirTrue: { value: trueSun },
    uMoonDir: { value: moonDirection },
    uSunDisc: { value: new THREE.Vector3() },
    uSunLightScale: { value: 1 },
    uSunWarm: { value: new THREE.Vector3(1, 1, 1) },
    uMoonLight: { value: new THREE.Vector3() },
    uMoonDisc: { value: new THREE.Vector3() },
    uCloudCover: { value: 0.3 },
    uCloudOffset: { value: new THREE.Vector4() },
    uCloudEvolve: { value: 0 },
    uCirrus: { value: 0 },
    uScud: { value: 0 },
    uCloudAmbient: { value: new THREE.Vector3() },
    uCloudBase: { value: new THREE.Vector3() },
    uStarRot: { value: new THREE.Matrix3() },
    uStarVis: { value: 0 },
    uTime: uniforms.uTime,
    uAurora: { value: 0 },
    uLightning: { value: 0 },
    uLightningDir: { value: new THREE.Vector3(0, 1, 0) },
    uGroundColor: { value: new THREE.Vector3() },
    uFogColor: uniforms.uFogColor,
    uFogDensity: uniforms.uFogDensity,
    uFogBoost: { value: new THREE.Vector2() },
  };
  const domeMaterial = new THREE.ShaderMaterial({
    name: 'sky-dome',
    uniforms: domeUniforms,
    vertexShader: DOME_VERT,
    fragmentShader: domeFrag(),
    depthWrite: false,
    depthTest: false,
  });
  const envDomeMaterial = new THREE.ShaderMaterial({
    name: 'sky-dome-env',
    uniforms: domeUniforms,
    defines: { ENV_CAPTURE: '' },
    vertexShader: DOME_VERT,
    fragmentShader: domeFrag(),
    depthWrite: false,
    depthTest: false,
  });
  const domeGeo = new THREE.BufferGeometry();
  domeGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const dome = new THREE.Mesh(domeGeo, domeMaterial);
  dome.name = 'sky-dome';
  dome.frustumCulled = false;
  dome.renderOrder = -1000;
  dome.layers.enable(1);
  scene.add(dome);

  // Lights.
  const sunLight = new THREE.DirectionalLight(0xffffff, 3);
  sunLight.name = 'sky-sun';
  sunLight.castShadow = !!quality.shadows;
  const mapSize = quality.shadowMapSize ?? 2048;
  sunLight.shadow.mapSize.set(mapSize, mapSize);
  const sc = sunLight.shadow.camera;
  sc.left = sc.bottom = -SHADOW_HALF;
  sc.right = sc.top = SHADOW_HALF;
  sc.near = 1;
  sc.far = 2200;
  sc.updateProjectionMatrix();
  sunLight.shadow.bias = 0.0002;
  sunLight.shadow.normalBias = 0.035;
  sunLight.shadow.radius = 2.5;
  scene.add(sunLight, sunLight.target);
  const hemiLight = new THREE.HemisphereLight(0xbfd8ff, 0x3d4a33, 1);
  hemiLight.name = 'sky-hemi';
  scene.add(hemiLight);
  const shadowFocus = new THREE.Vector3();

  // Environment map.
  const env = createEnvCapture(renderer, envDomeMaterial);
  scene.environment = env.texture;
  scene.environmentIntensity = SKY_TUNING.ambientGain;

  const rain = createRain(ctx, rng.fork('rain'));
  const mist = createMist(ctx, rng.fork('mist'), mistTex, fogUniforms, cloudTex);

  const weatherCtl = createWeather('partly');
  const weather = weatherCtl.weather;

  // ---------------------------------------------------------------------------------------------------------------
  // State
  const st = {
    astro: null,
    lightAt: -1e9,
    lastSunForLight: new THREE.Vector3(0, -2, 0),
    lastSunForLUT: new THREE.Vector3(0, -2, 0),
    lastMoonForLUT: new THREE.Vector3(0, -2, 0),
    lutScale: -1,
    lutDirty: true,
    envAt: -1e9,
    envSun: new THREE.Vector3(0, -2, 0),
    envMoon: new THREE.Vector3(0, -2, 0),
    envCover: -1,
    envFog: -1,
    envKeyIsSun: null,
    envCaptures: 0,
    lutRenders: 0,
    realTime: 0,
    cloudDrift: new THREE.Vector2(rng.next() * 200, rng.next() * 200),
    cirrusDrift: new THREE.Vector2(rng.next() * 500, rng.next() * 500),
    evolve: rng.next() * 100,
    sunVis: 1,
    sunVisAt: -1e9,
    sunCloudAlpha: 0,
    lightning: 0,
    lightningTimer: 4 + rng.next() * 8,
    lightningRng: rng.fork('lightning'),
    snap: true,
    fogBoost: 0,
    aurora: 0,
    starVis: 0,
  };
  const L = lightModel.out;
  const tmpV = new THREE.Vector3();
  const tmpV2 = new THREE.Vector3();
  const tmpV3 = new THREE.Vector3();
  const moonT = [0, 0, 0];
  const mistEnv = { mist: 0, fog: 0, cloudCover: 0, cloudBase: 300, hours: 12, day: 0, windSpeed: 0, windX: 0, windZ: 0 };
  const keyColor = new THREE.Color();

  const sky = {
    sunDirection: uniforms.uSunDir.value,
    trueSunDirection: trueSun,
    moonDirection,
    sunLight,
    hemiLight,
    shadowFocus,
    daylight: 1,
    sunElevationDeg: 40,
    moonElevationDeg: -30,
    moonIllumination: 0,
    moonPhase: 0,
    isNight: false,
    get envMap() {
      return env.texture;
    },
    envMapDefines: env.envMapDefines,
    weather,
    lightning: 0,
    golden: 0,
    // Luminance of a white horizontal surface under the current natural light (display units): postfx exposure.
    sceneKey: 1,

    setWeather(preset, transitionSeconds = 20) {
      if (!PRESETS[preset]) {
        console.warn(`[sky] unknown weather preset "${preset}"`);
        return false;
      }
      const changed = preset !== weather.preset;
      weatherCtl.set(preset, transitionSeconds);
      if (!(transitionSeconds > 0)) {
        weatherCtl.update(0, ctx.time.elapsed);
        st.snap = true;
      }
      st.lightAt = -1e9;
      if (changed || !(transitionSeconds > 0)) events.emit('weather:change', { preset });
      return true;
    },

    // Sunrise/sunset/noon in game-clock hours for a day index (default: today).
    sunTimes(day = clock.day) {
      return astroSunTimes(clock.dayOfYear(day));
    },

    update(dt) {
      st.realTime += ctx.time.realDt;
      const A = skyAstronomy(clock.dayOfYear(), clock.hours);
      st.astro = A;
      trueSun.fromArray(A.sun.dir);
      moonDirection.fromArray(A.moon.dir);
      sky.sunElevationDeg = A.sun.elevation;
      sky.moonElevationDeg = A.moon.elevation;
      sky.moonIllumination = A.moon.illumination;
      sky.moonPhase = A.moon.phase;
      const m = A.starRotation;
      domeUniforms.uStarRot.value.set(m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]);

      weatherCtl.update(dt, ctx.time.elapsed);
      const sunJump = trueSun.angleTo(st.lastSunForLight) > 3 * DEG;
      if (sunJump) st.snap = true;

      // Clouds drift with the wind (a little faster than real time for life) and parallax with the boat.
      const wx = Math.sin(weather.windDir) * weather.windSpeed;
      const wz = -Math.cos(weather.windDir) * weather.windSpeed;
      st.cloudDrift.x -= wx * dt * 0.003;
      st.cloudDrift.y -= wz * dt * 0.003;
      st.cirrusDrift.x -= wx * dt * 0.006;
      st.cirrusDrift.y -= wz * dt * 0.006;
      st.evolve += dt * 0.35;
      const cam = camera.position;
      domeUniforms.uCloudOffset.value.set(
        st.cloudDrift.x + cam.x * GAME_TO_REAL_KM,
        st.cloudDrift.y + cam.z * GAME_TO_REAL_KM,
        st.cirrusDrift.x + cam.x * GAME_TO_REAL_KM,
        st.cirrusDrift.y + cam.z * GAME_TO_REAL_KM,
      );
      domeUniforms.uCloudEvolve.value = st.evolve;
      domeUniforms.uCloudCover.value = weather.cloudCover;
      domeUniforms.uCirrus.value = cirrusAmount(clock.day) * (1 - weather.cloudCover * 0.8);
      domeUniforms.uScud.value = Math.min(1, weather.rain * 0.9 + weather.darkness * 0.8);
      st.sunCloudAlpha = cloudAlphaAt(trueSun);

      // Natural light (throttled; immediate on jumps).
      const needLight =
        st.snap ||
        weatherCtl.transitioning ||
        trueSun.angleTo(st.lastSunForLight) > 0.08 * DEG ||
        st.realTime - st.lightAt > 1;
      if (needLight && (st.snap || st.realTime - st.lightAt > 0.08)) {
        st.lightAt = st.realTime;
        st.lastSunForLight.copy(trueSun);
        lightModel.evaluate({
          sunDir: A.sun.dir,
          sunElevationDeg: A.sun.elevation,
          moonDir: A.moon.dir,
          moonElevationDeg: A.moon.elevation,
          moonIllumination: A.moon.illumination,
          weather,
          sunCloudAlpha: st.sunCloudAlpha,
        });
      }
      applyLight(dt);
      updateLightning(dt);

      // Mist banks and in-bank fog boost.
      mistEnv.mist = weather.mist;
      mistEnv.fog = weather.fog;
      mistEnv.cloudCover = weather.cloudCover;
      mistEnv.cloudBase = weather.cloudBase;
      mistEnv.hours = clock.hours;
      mistEnv.day = clock.day;
      mistEnv.windSpeed = weather.windSpeed;
      mistEnv.windX = wx;
      mistEnv.windZ = wz;
      if (st.snap) mist.refreshTargets(mistEnv);
      mist.update(dt, st.realTime, mistEnv, camera);
      if (st.snap) mist.snapPresence();
      st.fogBoost += (mist.insideFog - st.fogBoost) * Math.min(1, ctx.time.realDt * 1.5);

      // Fog (single writer: scene.fog mirrors uFogColor/uFogDensity).
      // Inside a mist bank the fog closes in to ~300 m (never thins an already thicker fog).
      const baseDensity = fogDensityForVisibility(weather.visibility);
      const boostDensity = Math.max(0, fogDensityForVisibility(300) - baseDensity) * st.fogBoost;
      const density = baseDensity + boostDensity;
      uniforms.uFogDensity.value = density;
      domeUniforms.uFogBoost.value.set(boostDensity, mist.insideTop);
      scene.fog.density = density;
      scene.fog.color.copy(uniforms.uFogColor.value);
      scene.background.copy(uniforms.uFogColor.value);
      const fogP = fogUniforms.kodiakFogParams.value;
      fogP.x = 215 - 145 * weather.fog - 35 * weather.rain;
      fogP.y = Math.max(0.06, 0.34 + 0.14 * weather.rain - 0.26 * weather.fog);
      // Marine fog is a shallow layer: the sky (and the sun's glow) shows through overhead.
      fogP.z = 1500 - 1150 * weather.fog;
      // The sun's glow in the haze narrows once the sun is down, so twilight stays a horizon band.
      fogP.w = 7 + 26 * smoothstep(1, -6, sky.sunElevationDeg);
      const deck = fogUniforms.kodiakFogDeck.value;
      // Crow's-nest view: the ragged deck base never dips between the overhead camera and the sea below it.
      deck.x = Math.max(weather.cloudBase, (camera.position.y + 45) * mist.overhead);
      deck.y = 0.0095 * smoothstep(0.72, 0.97, weather.cloudCover) * (1 + weather.rain * 0.5);
      deck.z = 38;

      // Shared weather uniforms.
      uniforms.uWindDir.value.set(Math.sin(weather.windDir), -Math.cos(weather.windDir));
      uniforms.uWindSpeed.value = weather.windSpeed;
      uniforms.uRain.value = weather.rain;
      uniforms.uCloudCover.value = weather.cloudCover;

      rain.update(weather.rain, wx, wz, uniforms.uSkyColor.value, uniforms.uSunColor.value, st.lightning, ctx.time.elapsed);
      if (st.qaOff) rain.mesh.visible = false;
      st.snap = false;
    },

    debugState() {
      return {
        preset: weather.preset,
        transition: +weather.transition.toFixed(2),
        cloudCover: +weather.cloudCover.toFixed(2),
        visibility: Math.round(weather.visibility),
        sunEl: +sky.sunElevationDeg.toFixed(2),
        moonEl: +sky.moonElevationDeg.toFixed(1),
        moonIllum: +sky.moonIllumination.toFixed(2),
        daylight: +sky.daylight.toFixed(3),
        isNight: sky.isNight,
        key: L.keyIsSun ? 'sun' : 'night',
        lift: +L.lift.toFixed(1),
        sceneKey: +sky.sceneKey.toFixed(4),
        stars: +st.starVis.toFixed(2),
        aurora: +st.aurora.toFixed(2),
        mistBanks: mist.activeCount,
        fogBoost: +st.fogBoost.toFixed(2),
        envCaptures: st.envCaptures,
        lutRenders: st.lutRenders,
        sunVis: +st.sunVis.toFixed(2),
      };
    },

    // QA helper: GPU time of each sky component in isolation (EXT_disjoint_timer_query_webgl2; resolves async).
    async debugTimings(n = 30) {
      const gl = renderer.getContext();
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      const target = new THREE.WebGLRenderTarget(renderer.domElement.width, renderer.domElement.height, { type: THREE.HalfFloatType, depthBuffer: true });
      const prev = renderer.getRenderTarget();
      const prevAuto = renderer.autoClear;
      const queries = {};
      const jobs = [];
      const measure = (name, fn) => {
        queries[name] = [];
        jobs.push([name, fn]);
      };
      const run = () => {
        for (let i = 0; i < n; i++) {
          for (const [name, fn] of jobs) {
            const q = ext ? gl.createQuery() : null;
            if (q) gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
            fn();
            if (q) {
              gl.endQuery(ext.TIME_ELAPSED_EXT);
              queries[name].push(q);
            }
          }
        }
      };
      const only = (obj) => () => {
        const s2 = new THREE.Scene();
        s2.fog = scene.fog;
        const parent = obj.parent;
        s2.add(obj);
        renderer.setRenderTarget(target);
        renderer.clear();
        renderer.render(s2, camera);
        parent.add(obj);
      };
      renderer.autoClear = false;
      measure('clear', () => {
        renderer.setRenderTarget(target);
        renderer.clear();
      });
      measure('dome', only(dome));
      measure('mist', only(mist.mesh));
      measure('rain', only(rain.mesh));
      measure('skyViewLUT', () => renderSkyView());
      measure('envCapture', () => env.capture());
      run();
      renderer.setRenderTarget(prev);
      renderer.autoClear = prevAuto;
      if (!ext) return { error: 'no timer query' };
      const out = {};
      for (let tries = 0; tries < 200; tries++) {
        await new Promise((r) => setTimeout(r, 30));
        const all = Object.values(queries).flat();
        if (all.every((q) => gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE))) break;
      }
      for (const [k, qs] of Object.entries(queries)) {
        const ms = qs.map((q) => (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) ? gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6 : NaN));
        ms.sort((a, b) => a - b);
        // The minimum approximates the uncontended cost on a GPU shared with other processes.
        out[k] = +ms[0].toFixed(3);
        for (const q of qs) gl.deleteQuery(q);
      }
      target.dispose();
      return out;
    },

    // QA helper: switches off every GPU cost the sky adds (dome, mist, rain, sky-view LUT, env capture) so a single
    // page can A/B the frame's GPU time on a shared GPU. Lights, fog and uniforms keep updating.
    debugSetActive(on) {
      st.qaOff = !on;
      dome.visible = !!on;
      mist.mesh.visible = !!on && mist.activeCount > 0;
      if (!on) rain.mesh.visible = false;
      return !st.qaOff;
    },

    // QA helper: compiles every material kind with the fog chunks and checks near/far fogging (see fogCheck.js).
    debugFogCheck() {
      return runFogCheck(renderer, fogUniforms);
    },

    // QA helper: currently drawn mist banks.
    debugMist(force) {
      if (force !== undefined) mist.debugForce(force);
      return mist.debugActive();
    },

    // QA helper: statistics of the PMREM env map (finite/NaN counts, max and mean luminance of mip 0).
    debugEnvStats() {
      const t = env.target;
      const w = t.width;
      const h = t.height;
      const buf = new Uint16Array(w * h * 4);
      renderer.readRenderTargetPixels(t, 0, 0, w, h, buf);
      let nan = 0;
      let max = 0;
      let sum = 0;
      let n = 0;
      for (let i = 0; i < buf.length; i += 4) {
        const r = THREE.DataUtils.fromHalfFloat(buf[i]);
        const g = THREE.DataUtils.fromHalfFloat(buf[i + 1]);
        const b = THREE.DataUtils.fromHalfFloat(buf[i + 2]);
        if (!Number.isFinite(r + g + b)) {
          nan++;
          continue;
        }
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        max = Math.max(max, l);
        sum += l;
        n++;
      }
      return { w, h, nan, max: +max.toFixed(4), mean: +(sum / Math.max(1, n)).toFixed(4) };
    },

    serialize() {
      return { preset: weather.preset };
    },
    restore(data) {
      if (data?.preset && !ctx.debug.weatherPinned) sky.setWeather(data.preset, 0);
    },
    reset() {
      if (!ctx.debug.weatherPinned) sky.setWeather('partly', 0);
      st.snap = true;
    },
  };

  // Cirrus amount varies by day (some days streaked with mares' tails, some clean).
  function cirrusAmount(day) {
    const h = Math.sin((day + 3.7) * 91.345) * 43758.5453;
    const r = h - Math.floor(h);
    return r < 0.35 ? 0 : 0.25 + 0.75 * (r - 0.35) / 0.65;
  }

  // CPU mirror of the dome's cumulus layer at a direction (0..1 opacity): dims the sun when a cloud crosses it.
  function cloudAlphaAt(dir) {
    const cover = weather.cloudCover;
    if (dir.y <= 0.005 || cover < 0.01) return dir.y <= 0.005 ? Math.min(1, cover * 1.1) : 0;
    const r0 = atmosphere.params.bottom + 0.05;
    const rc = atmosphere.params.bottom + CLOUD_LAYER.altitude;
    const b = r0 * dir.y;
    const t = -b + Math.sqrt(Math.max(0, b * b + rc * rc - r0 * r0));
    const off = domeUniforms.uCloudOffset.value;
    const u = (dir.x * t + off.x) / CLOUD_LAYER.tile;
    const v = (dir.z * t + off.y) / CLOUD_LAYER.tile;
    const a = sampleNoise2D(cloudField, u, v, 0);
    const bu = u * CLOUD_LAYER.detailScale + 0.37 + st.evolve * 0.013;
    const bv = v * CLOUD_LAYER.detailScale + 0.61 - st.evolve * 0.009;
    const shape = a * 0.62 + sampleNoise2D(cloudField, bu, bv, 1) * 0.38 - (sampleNoise2D(cloudField, bu, bv, 3) - 0.5) * 0.16;
    const th = 0.76 + (0.06 - 0.76) * cover;
    let d = Math.min(1, Math.max(0, (shape - th) / 0.2));
    d = d * d * (3 - 2 * d);
    return 1 - Math.exp(-d * (3.5 + 5 * cover));
  }

  function applyLight(dt) {
    // Key light (sun by day, moon/twilight glow by night); uSunDir is the key direction.
    uniforms.uSunDir.value.fromArray(L.keyDir).normalize();
    const kc = L.keyColor;
    const kmax = Math.max(kc[0], kc[1], kc[2], 1e-6);
    keyColor.setRGB(kc[0] / kmax, kc[1] / kmax, kc[2] / kmax);
    // Terrain occlusion of the key light at the focus (boats darken in mountain shadow).
    if (st.realTime - st.sunVisAt > 0.1 || st.snap) {
      st.sunVisAt = st.realTime;
      let v = 1;
      try {
        const fn = ctx.systems.terrain?.sunVisibilityAt;
        if (typeof fn === 'function') v = Number(fn(shadowFocus.x, shadowFocus.z));
      } catch {
        v = 1;
      }
      st.sunVisTarget = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
    }
    const target = st.sunVisTarget ?? 1;
    st.sunVis = st.snap ? target : st.sunVis + (target - st.sunVis) * Math.min(1, ctx.time.realDt * 2.5);
    sunLight.color.copy(keyColor);
    sunLight.intensity = kmax * st.sunVis;
    sunLight.shadow.radius = L.keyIsSun ? 2.5 : 4.5;
    uniforms.uSunColor.value.setRGB(kc[0] / Math.PI, kc[1] / Math.PI, kc[2] / Math.PI);

    const amb = L.skyAmbient;
    uniforms.uSkyColor.value.setRGB(amb[0], amb[1], amb[2]);
    uniforms.uHorizonColor.value.setRGB(L.horizon[0], L.horizon[1], L.horizon[2]);
    uniforms.uFogColor.value.setRGB(L.fogColor[0], L.fogColor[1], L.fogColor[2]);
    hemiLight.color.setRGB(amb[0] * Math.PI * 0.3, amb[1] * Math.PI * 0.3, amb[2] * Math.PI * 0.3);
    hemiLight.groundColor.setRGB(L.groundBounce[0] * Math.PI * 0.6, L.groundBounce[1] * Math.PI * 0.6, L.groundBounce[2] * Math.PI * 0.6);
    hemiLight.intensity = 1;

    sky.daylight = L.daylight;
    uniforms.uDaylight.value = L.daylight;
    sky.isNight = L.daylight < 0.2 || sky.sunElevationDeg < -4;
    sky.sceneKey = L.sceneKey;
    sky.golden = L.golden;

    // Fog inscatter toward the sun (twilight glow on the haze, lit marine fog).
    const fs = fogUniforms.kodiakFogSun.value;
    fs.x = trueSun.x;
    fs.y = trueSun.y;
    fs.z = trueSun.z;
    fs.w = 1;
    const fsc = fogUniforms.kodiakFogSunColor.value;
    fsc.r = L.fogSunColor[0];
    fsc.g = L.fogSunColor[1];
    fsc.b = L.fogSunColor[2];

    // Sky-view LUT inputs.
    const svu = skyViewMaterial.uniforms;
    svu.uSunDir.value.copy(trueSun);
    svu.uMoonDir.value.copy(moonDirection);
    svu.uSunScale.value = L.sunScale;
    svu.uSunTint.value.fromArray(L.skyTint);
    svu.uMoonScale.value = L.moonScale;
    svu.uAirglow.value.fromArray(L.airglow);
    if (
      trueSun.angleTo(st.lastSunForLUT) > 0.04 * DEG ||
      moonDirection.angleTo(st.lastMoonForLUT) > 0.2 * DEG ||
      Math.abs(L.sunScale - st.lutScale) > st.lutScale * 0.002
    ) {
      st.lutDirty = true;
    }

    // Dome inputs.
    const T = L.sunTransmittance;
    const sunE = SKY_TUNING.sunIlluminance * L.lift;
    const discAtt = (1 - 0.97 * Math.min(1, weather.cloudCover ** 1.5)) * (1 - 0.8 * weather.fog);
    domeUniforms.uSunDisc.value.set(
      Math.min(400, sunE * T[0] * SUN_DISC_GAIN * discAtt),
      Math.min(400, sunE * T[1] * SUN_DISC_GAIN * discAtt),
      Math.min(400, sunE * T[2] * SUN_DISC_GAIN * discAtt),
    );
    domeUniforms.uSunLightScale.value = sunE;
    domeUniforms.uSunWarm.value.fromArray(L.warm);
    const moonUp = smoothstep(-1, 3, sky.moonElevationDeg);
    const r0 = atmosphere.params.bottom + atmosphere.params.viewAltitude;
    const mt = atmosphere.transmittance(r0, Math.max(0.01, moonDirection.y), moonT);
    const mtl = Math.max(1e-6, lum(mt));
    for (let c = 0; c < 3; c++) moonT[c] = 0.35 + 0.65 * (mt[c] / mtl);
    const moonVis = moonUp * (1 - 0.95 * Math.min(1, weather.cloudCover ** 2)) * (1 - weather.fog * 0.9);
    domeUniforms.uMoonDisc.value.set(MOON_DISC.r * moonT[0] * moonVis, MOON_DISC.g * moonT[1] * moonVis, MOON_DISC.b * moonT[2] * moonVis);
    const ml = SKY_TUNING.moonKey * sky.moonIllumination ** 1.2 * moonUp * L.nightFactor;
    domeUniforms.uMoonLight.value.set(ml * 0.62, ml * 0.74, ml);
    domeUniforms.uCloudAmbient.value.fromArray(L.clearAmbient).multiplyScalar(1.15);
    domeUniforms.uCloudBase.value.fromArray(L.cloudBase);
    domeUniforms.uGroundColor.value.fromArray(L.groundBounce);
    const zl = lum(L.zenith);
    st.starVis = (1 - smoothstep(0.0012, 0.009, zl)) * (1 - smoothstep(0.35, 0.8, weather.cloudCover) * 0.85) * (1 - weather.fog);
    domeUniforms.uStarVis.value = st.starVis;
    st.aurora = auroraStrength();
    domeUniforms.uAurora.value = st.aurora;
  }

  function auroraStrength() {
    const day = clock.day;
    const h = Math.sin((day + 11.3) * 57.77) * 43758.5453;
    const nightly = 0.55 + 0.45 * (h - Math.floor(h));
    const season = smoothstep(26, 40, day);
    const dark = smoothstep(-8, -14, sky.sunElevationDeg);
    const clear = 1 - smoothstep(0.35, 0.75, weather.cloudCover);
    const moon = 1 - 0.5 * smoothstep(0, 15, sky.moonElevationDeg) * sky.moonIllumination;
    const t = clock.hours + clock.day * 24;
    const pulse = 0.7 + 0.3 * Math.sin(t * 2.1) * Math.sin(t * 0.73 + 1.3);
    return season * nightly * dark * clear * moon * pulse * (1 - weather.fog);
  }

  function updateLightning(dt) {
    const storm = smoothstep(0.7, 1, weather.rain) * smoothstep(0.4, 0.62, weather.darkness);
    st.lightning = Math.max(0, st.lightning - dt * 6);
    if (storm > 0 && dt > 0) {
      st.lightningTimer -= dt * storm;
      if (st.lightningTimer <= 0) {
        const r = st.lightningRng;
        st.lightningTimer = 6 + r.next() * 22;
        st.lightning = 0.6 + r.next() * 0.4;
        st.lightningFlicker = 2 + Math.floor(r.next() * 3);
        const a = r.next() * Math.PI * 2;
        const dist = 1500 + r.next() * 5000;
        const cam = camera.position;
        // Where the strike lights the deck: its azimuth, higher in the sky the closer it is.
        domeUniforms.uLightningDir.value.set(Math.cos(a) * dist, 900, Math.sin(a) * dist).normalize();
        events.emit('sky:lightning', { x: cam.x + Math.cos(a) * dist, z: cam.z + Math.sin(a) * dist, distance: dist, intensity: st.lightning });
      } else if (st.lightningFlicker > 0 && st.lightning < 0.25 && st.lightningRng.next() < 0.3) {
        st.lightningFlicker--;
        st.lightning = 0.35 + st.lightningRng.next() * 0.5;
      }
    }
    sky.lightning = st.lightning;
    domeUniforms.uLightning.value = st.lightning * (sky.daylight < 0.5 ? 0.55 : 0.3);
    if (st.lightning > 0) {
      const f = st.lightning * 0.6;
      uniforms.uSkyColor.value.r += f * 0.18;
      uniforms.uSkyColor.value.g += f * 0.19;
      uniforms.uSkyColor.value.b += f * 0.24;
      hemiLight.color.r += f * 0.5;
      hemiLight.color.g += f * 0.52;
      hemiLight.color.b += f * 0.62;
    }
  }

  // Shadow cascade: ±SHADOW_HALF around shadowFocus, texel-snapped in light space so it never shimmers.
  function placeShadow() {
    const key = uniforms.uSunDir.value;
    const zAxis = tmpV.copy(key);
    const xAxis = tmpV2.set(0, 1, 0).cross(zAxis);
    if (xAxis.lengthSq() < 1e-6) xAxis.set(1, 0, 0);
    xAxis.normalize();
    const yAxis = tmpV3.crossVectors(zAxis, xAxis);
    const texel = (2 * SHADOW_HALF) / sunLight.shadow.mapSize.x;
    const fx = shadowFocus.dot(xAxis);
    const fy = shadowFocus.dot(yAxis);
    const dx = Math.round(fx / texel) * texel - fx;
    const dy = Math.round(fy / texel) * texel - fy;
    sunLight.target.position.copy(shadowFocus).addScaledVector(xAxis, dx).addScaledVector(yAxis, dy);
    sunLight.position.copy(sunLight.target.position).addScaledVector(zAxis, 1100);
    sunLight.target.updateMatrixWorld();
    sunLight.updateMatrixWorld();
  }

  function renderSkyView() {
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(skyViewTarget);
    skyViewQuad.render(renderer);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
    st.lastSunForLUT.copy(trueSun);
    st.lastMoonForLUT.copy(moonDirection);
    st.lutScale = L.sunScale;
    st.lutDirty = false;
    st.lutRenders++;
  }

  function maybeCaptureEnv() {
    const capture = shouldCaptureEnv({
      since: st.realTime - st.envAt,
      captures: st.envCaptures,
      sunMovedDeg: trueSun.angleTo(st.envSun) / DEG,
      moonMovedDeg: moonDirection.angleTo(st.envMoon) / DEG,
      keyIsSun: L.keyIsSun,
      keyFlip: st.envKeyIsSun !== L.keyIsSun,
      transitioning: weatherCtl.transitioning,
      coverDelta: weather.cloudCover - st.envCover,
      fogDelta: weather.fog - st.envFog,
    });
    if (!capture) return;
    env.capture();
    st.envAt = st.realTime;
    st.envSun.copy(trueSun);
    st.envMoon.copy(moonDirection);
    st.envCover = weather.cloudCover;
    st.envFog = weather.fog;
    st.envKeyIsSun = L.keyIsSun;
    st.envCaptures++;
  }

  pipeline.beforeRender(() => {
    if (st.qaOff) return;
    try {
      placeShadow();
      if (st.lutDirty) renderSkyView();
      maybeCaptureEnv();
      mist.prepare(camera);
    } catch (err) {
      if (!st.beforeRenderErrored) console.error('[sky] beforeRender failed', err);
      st.beforeRenderErrored = true;
    }
  });

  events.on('time:skip', () => {
    st.snap = true;
    st.lightAt = -1e9;
  });

  // Prime everything so the first frame (and envMap) is valid.
  sky.update(0);
  renderSkyView();
  env.capture();
  st.envCaptures = 0;
  return sky;
}
