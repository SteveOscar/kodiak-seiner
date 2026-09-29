// Boot: renderer -> heightmap -> systems (registry order) -> frame loop. See SPEC.md §4, §5.

import * as THREE from 'three';
import { config, QUALITY } from './core/config.js';
import { createEvents } from './core/events.js';
import { createInput } from './core/input.js';
import { createClock } from './core/clock.js';
import { createGeo } from './core/geo.js';
import { createRng } from './core/rng.js';
import { createUniforms } from './core/uniforms.js';
import { createInteract } from './core/interact.js';
import { createTide } from './core/tide.js';
import { loadHeightmap } from './world/heightmap.js';
import { createRenderer } from './render/renderer.js';
import { registerShaderChunks } from './render/shaderChunks.js';
import { SYSTEMS } from './systems/registry.js';
import { STUBS } from './systems/stubs.js';
import { missingMembers } from './systems/contract.js';

const SAVE_VERSION = 1;
const params = new URLSearchParams(location.search);
const flags = {
  debug: params.has('debug'),
  autostart: params.has('autostart'),
  skip: new Set((params.get('skip') ?? '').split(',').filter(Boolean)),
  only: params.has('only') ? new Set(params.get('only').split(',').filter(Boolean)) : null,
  seed: Number(params.get('seed') ?? 1985),
  time: params.has('time') ? Number(params.get('time')) : null,
  day: params.has('day') ? Number(params.get('day')) : null,
  weather: params.get('weather'),
  at: params.get('at'), // "x,z[,headingDegrees]"
  quality: params.get('quality'),
  explore: params.has('explore'),
  fixedRes: params.has('fixedres'),
};

const errors = [];
const warnings = [];
const origError = console.error.bind(console);
const origWarn = console.warn.bind(console);
const fmt = (a) => a.map((x) => (x instanceof Error ? `${x.message}\n${x.stack}` : String(x))).join(' ');
console.error = (...a) => {
  errors.push(fmt(a));
  origError(...a);
};
console.warn = (...a) => {
  warnings.push(fmt(a));
  origWarn(...a);
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
  registerShaderChunks();
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
    onProgress: (f) => bootStatus(`Charting Kodiak Island… ${Math.round(f * 100)}%`),
  });
  uniforms.uHeightMap.value = heightmap.texture;
  uniforms.uWorldHalf.value = config.world.half;

  const state = {
    mode: 'loading', // 'loading' | 'title' | 'play' | 'paused' | 'map' | 'photo' | 'cutscene'
    control: 'boat', // 'boat' | 'foot' — written only by the player system
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
    tide: null,
    systems,
    state,
    flags,
    time: { elapsed: 0, dt: 0, realDt: 0, frame: 0 },
    game: null,
    debug: { cameraOverride: null, weatherPinned: !!flags.weather },
  };
  ctx.tide = createTide(clock, heightmap, () => systems.sky?.weather);

  const order = [];
  const each = (fn) => {
    for (const sys of order) {
      try {
        fn(sys);
      } catch (err) {
        console.error(`[systems] ${sys.name} hook threw:`, err);
      }
    }
  };

  function spawnPoint() {
    if (flags.at) {
      const [x, z, hd] = flags.at.split(',').map(Number);
      return { x, z, heading: ((hd || 0) * Math.PI) / 180 };
    }
    const p = systems.places?.spawn;
    if (p) return p;
    const k = geo.toWorld(config.spawn.lat, config.spawn.lon);
    const w = heightmap.nearestWater(k.x, k.z, { minShore: config.spawn.minShore }) ?? k;
    return { x: w.x, z: w.z, heading: config.spawn.heading };
  }

  ctx.game = {
    setMode(mode) {
      const prev = state.mode;
      if (prev === mode) return;
      state.mode = mode;
      clock.frozen = mode !== 'play';
      input.gameplayBlocked = mode !== 'play';
      input.consume();
      interact.clear();
      events.emit('game:mode', { mode, prev });
    },

    // Enter gameplay. newGame resets every system (sys.reset) and places the boat at the spawn, or at startAt
    // ({ x, z, heading }: the start location the player picked on the title screen).
    start({ newGame = true, freeExplore = flags.explore, startAt = null } = {}) {
      state.freeExplore = freeExplore;
      if (newGame) {
        state.control = 'boat';
        clock.set(flags.time ?? config.time.startHours, flags.day ?? config.time.startDay);
        each((sys) => sys.reset?.());
        const s = startAt && Number.isFinite(startAt.x) && Number.isFinite(startAt.z) && !flags.at ? { heading: 0, ...startAt } : spawnPoint();
        ctx.game.teleport(s.x, s.z, s.heading, { reason: 'start' });
      }
      ctx.game.setMode('play');
      events.emit('game:start', { newGame, freeExplore });
    },

    pause() {
      if (state.mode === 'play') ctx.game.setMode('paused');
    },
    resume() {
      if (state.mode !== 'play' && state.mode !== 'title' && state.mode !== 'loading') ctx.game.setMode('play');
    },

    // Returns to the title screen (WP-GAME autosaves on 'game:toTitle' before the mode changes).
    toTitle() {
      events.emit('game:toTitle', {});
      state.control = 'boat';
      ctx.game.setMode('title');
    },

    // Moves the seiner instantly. Listeners snap cameras, abort sets, bring the player aboard.
    teleport(x, z, heading = systems.seiner?.heading ?? 0, { reason = 'teleport' } = {}) {
      systems.seiner?.setPose?.(x, z, heading);
      events.emit('boat:teleport', { x, z, heading, reason });
    },

    // Where "the player" is: the person on foot, otherwise the seiner.
    avatar() {
      const onFoot = state.control === 'foot' && systems.player?.active;
      const src = onFoot ? systems.player : systems.seiner;
      const p = src?.position ?? camera.position;
      return { x: p.x, y: p.y, z: p.z, heading: src?.heading ?? 0, object3d: src?.object3d ?? null, control: state.control };
    },

    // JSON save of the whole game, or null when the game is not in a saveable state (mid-set, ashore, menus).
    snapshot() {
      if (state.mode !== 'play' && state.mode !== 'paused') return null;
      if (state.control !== 'boat') return null;
      // 'report' is after the catch is in the hold; net, skiff and fish are not saved (they stow/reseed on load).
      const fishingState = systems.fishing?.state ?? 'idle';
      if (fishingState !== 'idle' && fishingState !== 'report') return null;
      if (fishingState === 'idle' && (systems.skiff?.state ?? 'stowed') !== 'stowed') return null;
      const out = {
        version: SAVE_VERSION,
        seed: flags.seed,
        freeExplore: state.freeExplore,
        clock: { day: clock.day, hours: clock.hours },
        systems: {},
      };
      for (const sys of order) {
        if (typeof sys.serialize !== 'function') continue;
        try {
          const d = sys.serialize();
          if (d !== undefined) out.systems[sys.name] = d;
        } catch (err) {
          console.error(`[save] ${sys.name}.serialize threw`, err);
        }
      }
      return out;
    },

    // Restores a snapshot and enters play.
    load(data) {
      if (!data || data.version !== SAVE_VERSION) return false;
      state.control = 'boat';
      state.freeExplore = !!data.freeExplore;
      each((sys) => sys.reset?.());
      clock.set(data.clock.hours, data.clock.day);
      each((sys) => data.systems?.[sys.name] !== undefined && sys.restore?.(data.systems[sys.name]));
      const s = systems.seiner;
      if (s) events.emit('boat:teleport', { x: s.position.x, z: s.position.z, heading: s.heading, reason: 'load' });
      ctx.game.start({ newGame: false, freeExplore: state.freeExplore });
      return true;
    },
  };

  // Create systems in registry order; fall back to stubs on failure.
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
    if (sys && systemStatus[entry.name] === 'ok') {
      const missing = missingMembers(entry.name, sys);
      if (missing.length) {
        console.warn(`[contract] ${entry.name} is missing required members: ${missing.join(', ')}`);
        systemStatus[entry.name] = `ok (missing: ${missing.join(', ')})`;
      }
    }
    if (!sys) sys = STUBS[entry.name](ctx);
    sys.name = entry.name;
    systems[entry.name] = sys;
    order.push(sys);
  }

  // Per-system CPU timing (EMA, ms) and whole-frame GPU timing.
  const cpu = {};
  for (const sys of order) cpu[sys.name] = { update: 0, lateUpdate: 0, frame: 0 };
  const safe = (sys, fn, arg) => {
    const t0 = performance.now();
    try {
      sys[fn](arg);
    } catch (err) {
      if (!sys.__errored) console.error(`[systems] ${sys.name}.${fn} threw:`, err);
      sys.__errored = (sys.__errored ?? 0) + 1;
    }
    const c = cpu[sys.name];
    c[fn] += (performance.now() - t0 - c[fn]) * 0.05;
  };
  const gl = renderer.getContext();
  const timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const gpuQueries = [];
  let gpuMs = null;

  const frameTimes = [];
  let last = performance.now();
  let prevMode = state.mode;

  // Dynamic resolution: drop the pixel ratio in steps when frames run long, restore it after a steady stretch at the
  // display rate. Only gameplay/title frames count (menus and the chart are cheap and would mislead it).
  const baseRatio = renderer.getPixelRatio();
  const minRatio = Math.max(0.75, baseRatio * 0.6);
  const dyn = { ratio: baseRatio, ema: 16.7, slow: 0, steady: 0, cooldown: 3 };
  function dynamicResolution(realDt) {
    if (flags.fixedRes || (state.mode !== 'play' && state.mode !== 'title')) return;
    const ms = realDt * 1000;
    if (ms <= 0 || ms > 100) return;
    dyn.ema += (ms - dyn.ema) * 0.05;
    dyn.cooldown -= realDt;
    dyn.slow = dyn.ema > 21 ? dyn.slow + realDt : 0;
    dyn.steady = dyn.ema < 17.8 ? dyn.steady + realDt : 0;
    if (dyn.cooldown > 0) return;
    let next = dyn.ratio;
    if (dyn.slow > 1.5 && dyn.ratio > minRatio) next = Math.max(minRatio, dyn.ratio - 0.125);
    else if (dyn.steady > 8 && dyn.ratio < baseRatio) next = Math.min(baseRatio, dyn.ratio + 0.125);
    if (next !== dyn.ratio) {
      dyn.ratio = next;
      dyn.slow = dyn.steady = 0;
      dyn.cooldown = 3;
      pipeline.setPixelRatio(next);
    }
  }

  function frame(now) {
    requestAnimationFrame(frame);
    const realDt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    frameTimes.push(realDt * 1000);
    if (frameTimes.length > 240) frameTimes.shift();
    renderer.info.reset();

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
    // Offers resolve only in steady play (never on the first frame after a mode change).
    if (state.mode === 'play' && prevMode === 'play') interact.resolve();
    else interact.clear();
    prevMode = state.mode;
    for (const sys of order) if (sys.frame) safe(sys, 'frame', realDt);

    const ov = ctx.debug.cameraOverride;
    if (ov) {
      camera.position.fromArray(ov.pos);
      camera.lookAt(new THREE.Vector3().fromArray(ov.look));
    }
    uniforms.uCameraPos.value.copy(camera.position);
    camera.updateMatrixWorld();

    // The chart is opaque and full-screen: redraw the world behind it only occasionally.
    const skipWorld = state.mode === 'map' && ctx.time.frame % 20 !== 0;
    if (skipWorld) {
      input.endFrame();
      return;
    }

    let q = null;
    if (timerExt && gpuQueries.length < 4) {
      q = gl.createQuery();
      gl.beginQuery(timerExt.TIME_ELAPSED_EXT, q);
    }
    pipeline.frame(realDt);
    if (q) {
      gl.endQuery(timerExt.TIME_ELAPSED_EXT);
      gpuQueries.push(q);
    }
    while (gpuQueries.length && gl.getQueryParameter(gpuQueries[0], gl.QUERY_RESULT_AVAILABLE)) {
      const done = gpuQueries.shift();
      if (!gl.getParameter(timerExt.GPU_DISJOINT_EXT)) {
        const ms = gl.getQueryParameter(done, gl.QUERY_RESULT) / 1e6;
        gpuMs = gpuMs === null ? ms : gpuMs + (ms - gpuMs) * 0.05;
      }
      gl.deleteQuery(done);
    }
    input.endFrame();
    dynamicResolution(realDt);
  }

  // Debug / test API (used by tools/smoke.mjs). Keep stable; see SPEC.md §10.
  window.__KODIAK__ = {
    ctx,
    systems,
    systemStatus,
    errors,
    warnings,
    flags,
    start: (opts) => ctx.game.start(opts),
    setTime: (h, day) => clock.set(h, day),
    setWeather(p, secs = 0) {
      ctx.debug.weatherPinned = true;
      systems.sky?.setWeather?.(p, secs);
    },
    teleport(x, z, headingDeg = 0) {
      ctx.game.teleport(x, z, (headingDeg * Math.PI) / 180, { reason: 'debug' });
    },
    teleportTo(lat, lon, headingDeg = 0, minShore = 60) {
      const k = geo.toWorld(lat, lon);
      const w = heightmap.nearestWater(k.x, k.z, { minShore }) ?? k;
      ctx.game.teleport(w.x, w.z, (headingDeg * Math.PI) / 180, { reason: 'debug' });
      return w;
    },
    camera(pos, look) {
      ctx.debug.cameraOverride = pos ? { pos, look } : null;
    },
    perf() {
      const sorted = [...frameTimes].sort((a, b) => a - b);
      const avg = frameTimes.reduce((a, b) => a + b, 0) / Math.max(1, frameTimes.length);
      const info = renderer.info;
      const systemsMs = {};
      for (const [name, c] of Object.entries(cpu)) {
        const total = c.update + c.lateUpdate + c.frame;
        if (total > 0.005) systemsMs[name] = +total.toFixed(3);
      }
      return {
        fps: Math.round(1000 / Math.max(1, avg)),
        frameMsAvg: +avg.toFixed(2),
        frameMsP95: +(sorted[Math.floor(sorted.length * 0.95)] ?? 0).toFixed(2),
        gpuMs: gpuMs === null ? null : +gpuMs.toFixed(2),
        drawCalls: info.render.calls,
        triangles: info.render.triangles,
        programs: info.programs?.length ?? 0,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
        pixelRatio: +renderer.getPixelRatio().toFixed(3),
        systemsMs,
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
        warnings: warnings.length,
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

  window.addEventListener('pointerdown', () => systems.audio?.unlock?.());
  window.addEventListener('keydown', () => systems.audio?.unlock?.());

  // Wiring that needs every system happens on game:ready.
  const s0 = spawnPoint();
  ctx.game.teleport(s0.x, s0.z, s0.heading, { reason: 'boot' });
  events.emit('game:ready', {});
  if (flags.time !== null || flags.day !== null) clock.set(flags.time ?? clock.hours, flags.day ?? clock.day);
  if (flags.weather) systems.sky?.setWeather?.(flags.weather, 0);

  document.getElementById('boot')?.classList.add('hidden');
  ctx.game.setMode('title');
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
