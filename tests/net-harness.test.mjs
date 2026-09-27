// Test harness for WP-NET: a Node-side game with stub neighbours, the real net and fishing systems, scriptable
// input and a real interact arbiter. Imported by tests/net-fishing.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCtx } from './contract.test.mjs';
import { STUBS } from '../src/systems/stubs.js';
import { SYSTEMS } from '../src/systems/registry.js';
import { createInteract } from '../src/core/interact.js';
import { create as createNet } from '../src/entities/net.js';
import { create as createFishing } from '../src/game/fishing.js';

// Deep open water east of Kodiak (26 m), clear of islands for a 60 m circle to the north.
export const OPEN = { x: 5850, z: -520 };

export async function makeGame({ freeExplore = true, overrides = {} } = {}) {
  const ctx = fakeCtx();
  const held = new Set();
  const edges = new Set();
  const raw = new Set();
  let steer = 0;
  ctx.input = {
    action: (n) => held.has(n),
    pressed: (n) => edges.has(n),
    released: () => false,
    axis: (n) => (n === 'steer' ? steer : 0),
    keyDown: (c) => raw.has(c),
    keyPressed: () => false,
    mouse: { dx: 0, dy: 0, wheel: 0, buttons: 0 },
  };
  ctx.interact = createInteract(ctx.input);
  ctx.state.freeExplore = freeExplore;
  const events = [];
  const origEmit = ctx.events.emit;
  ctx.events.emit = (name, payload) => {
    events.push({ name, payload });
    return origEmit.call(ctx.events, name, payload);
  };
  for (const { name } of SYSTEMS) {
    let sys;
    if (overrides[name]) sys = overrides[name](ctx);
    else if (name === 'net') sys = await createNet(ctx);
    else if (name === 'fishing') sys = await createFishing(ctx);
    else sys = STUBS[name](ctx);
    sys.name = name;
    ctx.systems[name] = sys;
  }
  ctx.events.emit('game:ready', {});
  const order = SYSTEMS.map((s) => ctx.systems[s.name]);
  const dt = 1 / 30;
  const game = {
    ctx,
    events,
    held,
    raw,
    dt,
    get fishing() {
      return ctx.systems.fishing;
    },
    get net() {
      return ctx.systems.net;
    },
    get seiner() {
      return ctx.systems.seiner;
    },
    setSteer(v) {
      steer = v;
    },
    frame(fn) {
      ctx.time.dt = dt;
      ctx.time.elapsed += dt;
      ctx.time.frame++;
      ctx.clock.update(dt);
      fn?.();
      for (const s of order) s.update?.(dt);
      for (const s of order) s.lateUpdate?.(dt);
      ctx.interact.resolve();
      edges.clear();
    },
    run(seconds, fn) {
      const n = Math.round(seconds / dt);
      for (let i = 0; i < n; i++) game.frame(fn);
    },
    // Runs until pred() or the timeout; returns seconds taken (Infinity on timeout).
    until(pred, timeout = 120, fn) {
      const n = Math.round(timeout / dt);
      for (let i = 0; i < n; i++) {
        if (pred()) return i * dt;
        game.frame(fn);
      }
      return pred() ? timeout : Infinity;
    },
    press(action) {
      edges.add(action);
      game.frame();
    },
    offer(key) {
      return ctx.interact.current[key] ?? null;
    },
    named(name) {
      return events.filter((e) => e.name === name).map((e) => e.payload);
    },
    // Drives the stub seiner around a circle (centre cx, cz; radius r) at `speed`, counter-clockwise on the chart.
    // The stern point follows, so the net pays out along the path. Stops after `turns`.
    circle({ cx, cz, r = 60, speed = 7, turns = 1, startAngle = null, stopWhen = null }) {
      const s = ctx.systems.seiner;
      let a = startAngle ?? Math.atan2(s.position.z - cz, s.position.x - cx);
      const w = speed / r;
      const total = turns * Math.PI * 2;
      let swept = 0;
      while (swept < total) {
        if (stopWhen?.()) break;
        a -= w * dt;
        swept += w * dt;
        const x = cx + Math.cos(a) * r;
        const z = cz + Math.sin(a) * r;
        // Tangent for decreasing angle: (sin a, -cos a) → heading atan2(vx, -vz).
        const vx = Math.sin(a);
        const vz = -Math.cos(a);
        const h = Math.atan2(vx, -vz);
        s.position.set(x, 0, z);
        s.heading = h;
        s.speed = 0; // position is scripted; keep the stub's own integration still
        game.frame();
      }
    },
  };
  return game;
}

test('harness builds a game with the real net and fishing systems', async () => {
  const g = await makeGame();
  assert.equal(g.fishing.state, 'idle');
  assert.equal(g.net.state, 'stowed');
  g.seiner.setPose(OPEN.x, OPEN.z, Math.PI / 2);
  g.run(0.2);
  assert.equal(g.offer('action')?.id, 'fishing-letgo');
});
