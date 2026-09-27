// Boot: renderer -> heightmap -> systems (registry order) -> frame loop. See SPEC.md §Boot and §System contract.

import * as THREE from 'three';
import { config, QUALITY } from './core/config.js';
import { createEvents } from './core/events.js';
import { createInput } from './core/input.js';
import { createClock } from './core/clock.js';
import { createGeo } from './core/geo.js';
import { createRng } from './core/rng.js';
import { createUniforms } from './core/uniforms.js';
import { createInteract } from './core/interact.js';
import { loadHeightmap } from './world/heightmap.js';
import { createRenderer } from './render/renderer.js';
import { SYSTEMS } from './systems/registry.js';
import { STUBS } from './systems/stubs.js';

const params = new URLSearchParams(location.search);
const flags = {
  debug: params.has('debug'),
  autostart: params.has('autostart'),
  skip: new Set((params.get('skip') ?? '').split(',').filter(Boolean)),
  only: params.has('only') ? new Set(params.get('only').split(',').filter(Boolean)) : null,
  seed: Number(params.get('seed') ?? 1985),
  time: params.has('time') ? Number(params.get('time')) : null,
  weather: params.get('weather'),
  at: params.get('at'), // "x,z[,headingDegrees]"
  quality: params.get('quality'),
};

const errors = [];
const origError = console.error.bind(console);
console.error = (...a) => {
  errors.push(a.map((x) => (x instanceof Error ? `${x.message}\n${x.stack}` : String(x))).join(' '));
  origError(...a);
};
window.addEventListener('error', (e) => errors.push(`${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => errors.push(`unhandled rejection: ${e.reason?.message ?? e.reason}`));

const bootStatus = (text) => {
  const el = document.getElementById('boot-status');
  if (el) el.textContent = text;
};

function pickQuality() {
  const saved = (() => {
    try {
      return JSON.parse(localStorage.getItem('kodiak-seiner:settings') ?? '{}').quality;
    } catch {
      return null;
    }
  })();
  const name = flags.quality ?? saved ?? 'high';
  return QUALITY[name] ?? QUALITY.high;
}

async function boot() {
  const quality = pickQuality();
  const canvas = document.getElementById('gl');
  const { renderer, scene, camera, pipeline, resize } = createRenderer({ canvas, config, quality });
  const events = createEvents();
  const input = createInput(window);
  const clock = createClock(config, events);
  const geo = createGeo(config.world.half);
  const uniforms = createUniforms();
  const interact = createInteract(input);

  bootStatus('Charting Kodiak Island…');
  const heightmap = await loadHeightmap({
    url: './terrain/kodiak_height.png',
    metaUrl: './terrain/kodiak_meta.json',
    config,
  });
  uniforms.uHeightMap.value = heightmap.texture;
  uniforms.uWorldHalf.value = config.world.half;

  const state = {
    mode: 'loading', // 'loading' | 'title' | 'play' | 'paused' | 'map' | 'cutscene'
    control: 'boat', // 'boat' | 'foot'
    freeExplore: false,
  };

  const systems = {};
  const systemStatus = {};
  const ctx = {
    THREE,
    renderer,
    scene,
    camera,
    pipeline,
    config,
    quality,
    events,
    input,
    interact,
    clock,
    geo,
    rng: createRng(flags.seed),
    uniforms,
    heightmap,
    systems,
    state,
    flags,
    time: { elapsed: 0, dt: 0, frame: 0 },
    game: null,
    debug: { cameraOverride: null },
  };

  ctx.game = {
    setMode(mode) {
      const prev = state.mode;
      if (prev === mode) return;
      state.mode = mode;
      clock.frozen = mode !== 'play';
      input.gameplayBlocked = mode !== 'play';
      events.emit('game:mode', { mode, prev });
    },
    // Enter gameplay. newGame resets position/time; the UI calls this from the title screen.
    start({ newGame = true, freeExplore = false } = {}) {
      state.freeExplore = freeExplore;
      if (newGame) {
        clock.set(config.time.startHours, config.time.startDay);
        const s = spawnPoint();
        systems.seiner?.setPose?.(s.x, s.z, s.heading);
      }
      ctx.game.setMode('play');
      events.emit('game:start', { newGame, freeExplore });
    },
    pause() {
      if (state.mode === 'play') ctx.game.setMode('paused');
    },
    resume() {
      if (state.mode === 'paused' || state.mode === 'map') ctx.game.setMode('play');
    },
  };

  function spawnPoint() {
    if (flags.at) {
      const [x, z, hd] = flags.at.split(',').map(Number);
      return { x, z, heading: ((hd || 0) * Math.PI) / 180 };
    }
    const k = geo.toWorld(config.spawn.lat, config.spawn.lon);
    const w = heightmap.nearestWater(k.x, k.z, { minShore: config.spawn.minShore }) ?? k;
    return { x: w.x, z: w.z, heading: config.spawn.heading };
  }

  // Create systems in registry order; fall back to stubs on failure.
  const order = [];
  for (const entry of SYSTEMS) {
    bootStatus(`Rigging ${entry.name}…`);
    const forceStub = flags.skip.has(entry.name) || (flags.only && !flags.only.has(entry.name));
    let sys = null;
    if (!forceStub) {
      try {
        const mod = await entry.load();
        if (typeof mod.create === 'function') {
          sys = await mod.create(ctx);
          systemStatus[entry.name] = 'ok';
        } else {
          systemStatus[entry.name] = 'placeholder';
        }
      } catch (err) {
        console.error(`[systems] ${entry.name} failed to load/create:`, err);
        systemStatus[entry.name] = `failed: ${err?.message ?? err}`;
        sys = null;
      }
    } else {
      systemStatus[entry.name] = 'stub (flag)';
    }
    if (!sys) {
      sys = STUBS[entry.name](ctx);
      if (systemStatus[entry.name] === 'ok') systemStatus[entry.name] = 'stub';
    }
    sys.name = entry.name;
    systems[entry.name] = sys;
    order.push(sys);
  }

  // Place the boat at the spawn so title/cinematic cameras have something to look at.
  const s0 = spawnPoint();
  systems.seiner?.setPose?.(s0.x, s0.z, s0.heading);

  if (flags.time !== null) clock.set(flags.time);
  if (flags.weather) systems.sky?.setWeather?.(flags.weather, 0);

  // Frame loop.
  const frameTimes = [];
  let last = performance.now();
  const safe = (sys, fn, arg) => {
    try {
      sys[fn](arg);
    } catch (err) {
      if (!sys.__errored) console.error(`[systems] ${sys.name}.${fn} threw:`, err);
      sys.__errored = (sys.__errored ?? 0) + 1;
    }
  };

  function frame(now) {
    requestAnimationFrame(frame);
    const realDt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    frameTimes.push(realDt * 1000);
    if (frameTimes.length > 240) frameTimes.shift();

    const simulating = state.mode === 'play' || state.mode === 'title' || state.mode === 'cutscene';
    const dt = simulating ? realDt : 0;
    ctx.time.dt = dt;
    ctx.time.realDt = realDt;
    ctx.time.elapsed += dt;
    ctx.time.frame++;
    uniforms.uTime.value = ctx.time.elapsed;

    input.frame();
    if (state.mode === 'play') clock.update(dt);
    for (const sys of order) if (sys.update) safe(sys, 'update', dt);
    for (const sys of order) if (sys.lateUpdate) safe(sys, 'lateUpdate', dt);
    if (state.mode === 'play') interact.resolve();
    else interact.current = {};
    for (const sys of order) if (sys.frame) safe(sys, 'frame', realDt);

    const ov = ctx.debug.cameraOverride;
    if (ov) {
      camera.position.fromArray(ov.pos);
      camera.lookAt(new THREE.Vector3().fromArray(ov.look));
    }
    uniforms.uCameraPos.value.copy(camera.position);
    camera.updateMatrixWorld();

    pipeline.frame(realDt);
    input.endFrame();
  }

  // Debug / test API (used by tools/smoke.mjs). Keep stable; see SPEC.md §Debug API.
  window.__KODIAK__ = {
    ctx,
    systems,
    systemStatus,
    errors,
    flags,
    start: (opts) => ctx.game.start(opts),
    setTime: (h, day) => clock.set(h, day),
    setWeather: (p, secs = 0) => systems.sky?.setWeather?.(p, secs),
    teleport(x, z, headingDeg = 0) {
      systems.seiner?.setPose?.(x, z, (headingDeg * Math.PI) / 180);
    },
    teleportTo(lat, lon, headingDeg = 0, minShore = 60) {
      const k = geo.toWorld(lat, lon);
      const w = heightmap.nearestWater(k.x, k.z, { minShore }) ?? k;
      systems.seiner?.setPose?.(w.x, w.z, (headingDeg * Math.PI) / 180);
      return w;
    },
    camera(pos, look) {
      ctx.debug.cameraOverride = pos ? { pos, look } : null;
    },
    perf() {
      const sorted = [...frameTimes].sort((a, b) => a - b);
      const avg = frameTimes.reduce((a, b) => a + b, 0) / Math.max(1, frameTimes.length);
      const info = renderer.info;
      return {
        fps: Math.round(1000 / Math.max(1, avg)),
        frameMsAvg: +avg.toFixed(2),
        frameMsP95: +(sorted[Math.floor(sorted.length * 0.95)] ?? 0).toFixed(2),
        drawCalls: info.render.calls,
        triangles: info.render.triangles,
        programs: info.programs?.length ?? 0,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
      };
    },
    state() {
      const out = {
        mode: state.mode,
        control: state.control,
        day: clock.day,
        date: clock.date().label,
        hours: +clock.hours.toFixed(3),
        systemStatus,
        errors: errors.length,
      };
      for (const [name, sys] of Object.entries(systems)) {
        if (typeof sys.debugState === 'function') {
          try {
            out[name] = sys.debugState();
          } catch (err) {
            out[name] = `debugState threw: ${err.message}`;
          }
        }
      }
      return out;
    },
  };

  window.addEventListener('pointerdown', () => systems.audio?.unlock?.(), { once: false });
  window.addEventListener('keydown', () => systems.audio?.unlock?.(), { once: false });

  document.getElementById('boot')?.classList.add('hidden');
  ctx.game.setMode('title');
  clock.frozen = true;
  events.emit('game:ready', {});
  if (flags.autostart) ctx.game.start({ newGame: true });
  resize();
  requestAnimationFrame((t) => {
    last = t;
    frame(t);
  });
}

boot().catch((err) => {
  console.error('[boot] failed', err);
  bootStatus(`Failed to start: ${err.message}`);
});
