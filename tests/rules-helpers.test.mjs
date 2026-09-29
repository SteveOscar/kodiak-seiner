// Shared Node-side world for the WP-RULES tests: the real season/economy/discovery systems on fakeCtx(), stubs for
// every other system, a synthetic places system, captured offers/toasts/radio, and a mini ctx.game that mirrors
// src/main.js (start, teleport, avatar, snapshot, load, toTitle).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCtx } from './contract.test.mjs';
import { STUBS } from '../src/systems/stubs.js';
import { SYSTEMS } from '../src/systems/registry.js';
import { pointInPolygon } from '../src/data/places.js';
import * as seasonMod from '../src/game/season.js';
import * as economyMod from '../src/game/economy.js';
import * as discoveryMod from '../src/game/discovery.js';

const REAL = { season: seasonMod, economy: economyMod, discovery: discoveryMod };

export function memoryStorage() {
  const m = new Map();
  return {
    map: m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

// A places system over a synthetic list: [{ id, name, kind, x, z, radius, services?, dock?, onFoot?, memorial? }].
export function syntheticPlaces(ctx, { list = [], streams = [], districts = [], closedAreas = [], spawn = null } = {}) {
  const d2 = (p, x, z) => (p.x - x) ** 2 + (p.z - z) ** 2;
  const sp = spawn ?? (() => {
    const k = ctx.geo.toWorld(ctx.config.spawn.lat, ctx.config.spawn.lon);
    const w = ctx.heightmap.nearestWater(k.x, k.z, { minShore: 60 });
    return { x: w.x, z: w.z, heading: ctx.config.spawn.heading };
  })();
  return {
    list,
    streams,
    districts,
    closedAreas,
    spawn: sp,
    get: (id) => list.find((p) => p.id === id) ?? null,
    nearest(x, z, filter = () => true) {
      let best = null;
      let bd = Infinity;
      for (const p of list) {
        if (!filter(p)) continue;
        const d = d2(p, x, z);
        if (d < bd) {
          bd = d;
          best = p;
        }
      }
      return best ? { place: best, distance: Math.sqrt(bd) } : null;
    },
    within: (x, z, r, filter = () => true) => list.filter((p) => filter(p) && d2(p, x, z) <= r * r),
    districtAt(x, z) {
      const d = districts.find((q) => q.polygon.length > 2 && pointInPolygon(x, z, q.polygon));
      return d ? d.name : 'Northeast Kodiak';
    },
  };
}

function miniGame(ctx, order) {
  const each = (fn) => {
    for (const s of order) fn(s);
  };
  const game = {
    setMode(mode) {
      const prev = ctx.state.mode;
      if (prev === mode) return;
      ctx.state.mode = mode;
      ctx.clock.frozen = mode !== 'play';
      ctx.events.emit('game:mode', { mode, prev });
    },
    start({ newGame = true, freeExplore = false } = {}) {
      ctx.state.freeExplore = freeExplore;
      if (newGame) {
        ctx.state.control = 'boat';
        ctx.clock.set(ctx.config.time.startHours, ctx.config.time.startDay);
        each((s) => s.reset?.());
        const s = ctx.systems.places.spawn;
        game.teleport(s.x, s.z, s.heading, { reason: 'start' });
      }
      game.setMode('play');
      ctx.events.emit('game:start', { newGame, freeExplore });
    },
    toTitle() {
      ctx.events.emit('game:toTitle', {});
      ctx.state.control = 'boat';
      game.setMode('title');
    },
    teleport(x, z, heading = ctx.systems.seiner?.heading ?? 0, { reason = 'teleport' } = {}) {
      ctx.systems.seiner?.setPose?.(x, z, heading);
      ctx.events.emit('boat:teleport', { x, z, heading, reason });
    },
    avatar() {
      const onFoot = ctx.state.control === 'foot' && ctx.systems.player?.active;
      const src = onFoot ? ctx.systems.player : ctx.systems.seiner;
      const p = src?.position ?? { x: 0, y: 0, z: 0 };
      return { x: p.x, y: p.y, z: p.z, heading: src?.heading ?? 0, object3d: null, control: ctx.state.control };
    },
    snapshot() {
      if (ctx.state.mode !== 'play' && ctx.state.mode !== 'paused') return null;
      if (ctx.state.control !== 'boat') return null;
      if ((ctx.systems.fishing?.state ?? 'idle') !== 'idle') return null;
      if ((ctx.systems.skiff?.state ?? 'stowed') !== 'stowed') return null;
      const out = { version: 1, seed: 1, freeExplore: ctx.state.freeExplore, clock: { day: ctx.clock.day, hours: ctx.clock.hours }, systems: {} };
      for (const s of order) {
        if (typeof s.serialize !== 'function') continue;
        const d = s.serialize();
        if (d !== undefined) out.systems[s.name] = JSON.parse(JSON.stringify(d));
      }
      return out;
    },
    load(data) {
      if (!data || data.version !== 1) return false;
      ctx.state.control = 'boat';
      ctx.state.freeExplore = !!data.freeExplore;
      each((s) => s.reset?.());
      ctx.clock.set(data.clock.hours, data.clock.day);
      each((s) => data.systems?.[s.name] !== undefined && s.restore?.(data.systems[s.name]));
      game.start({ newGame: false, freeExplore: ctx.state.freeExplore });
      return true;
    },
  };
  return game;
}

// Builds the world. places: options for syntheticPlaces (default: a Kodiak harbor with services at the spawn).
export async function makeWorld({ places, storage = memoryStorage(), mode = 'title', start = true, freeExplore = false } = {}) {
  const ctx = fakeCtx();
  ctx.storage = storage;
  ctx.state.mode = mode;
  const offers = [];
  const toasts = [];
  const radio = [];
  const hints = [];
  ctx.interact = {
    current: {},
    offer(o) {
      if (o?.label) offers.push({ key: 'interact', priority: 0, ...o });
    },
    clear() {
      offers.length = 0;
    },
  };
  ctx.events.on('ui:toast', (e) => toasts.push(e));
  ctx.events.on('ui:radio', (e) => radio.push(e));
  ctx.events.on('ui:hint', (e) => hints.push(e));
  const order = [];
  for (const { name } of SYSTEMS) {
    let sys;
    if (REAL[name]) sys = await REAL[name].create(ctx);
    else if (name === 'places') sys = syntheticPlaces(ctx, places ?? defaultPlaces(ctx));
    else sys = STUBS[name](ctx);
    sys.name = name;
    ctx.systems[name] = sys;
    order.push(sys);
  }
  ctx.game = miniGame(ctx, order);
  ctx.events.emit('game:ready', {});
  if (start) ctx.game.start({ newGame: true, freeExplore });
  const w = {
    ctx,
    order,
    offers,
    toasts,
    radio,
    hints,
    storage,
    season: ctx.systems.season,
    economy: ctx.systems.economy,
    discovery: ctx.systems.discovery,
    // One frame of every system's update in registry order; offers are collected (not resolved).
    step(dt = 0.1) {
      offers.length = 0;
      for (const s of order) s.update?.(dt);
      for (const s of order) s.frame?.(dt);
    },
    best(key = 'interact') {
      let b = null;
      for (const o of offers) if (o.key === key && (!b || o.priority > b.priority)) b = o;
      return b;
    },
    offer(id) {
      return offers.find((o) => o.id === id) ?? null;
    },
  };
  return w;
}

export function defaultPlaces(ctx) {
  const k = ctx.geo.toWorld(ctx.config.spawn.lat, ctx.config.spawn.lon);
  const dock = ctx.heightmap.nearestWater(k.x, k.z, { minShore: 40 });
  return {
    list: [
      { id: 'kodiak', name: 'City of Kodiak', kind: 'town', x: k.x, z: k.z, radius: 450, services: ['sell', 'fuel', 'upgrades', 'ice', 'rest'], dock: { x: dock.x, z: dock.z, heading: 2.4 } },
    ],
    streams: [],
  };
}

test('rules helper world builds with the real WP-RULES systems', async () => {
  const w = await makeWorld();
  assert.equal(w.ctx.state.mode, 'play');
  assert.ok(w.season && w.economy && w.discovery);
  w.step(0.1);
});
