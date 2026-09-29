// WP-BOATS: handling maths, owner maps, mooring semantics, skiff state machine, navigation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOwnerMap } from '../src/entities/boats/ownerMap.js';
import {
  SEINER_TUNING, createHullState, stepHull, targetSpeed, rudderAuthority, waveAttitude, hullExtent, segmentDistance, wrapAngle,
} from '../src/entities/boats/handling.js';
import { createSeinerController } from '../src/entities/boats/seinerController.js';
import { createSkiffController } from '../src/entities/boats/skiffController.js';
import { buildNavGrid, createSearch, pathLength, alongPath } from '../src/entities/boats/nav.js';
import { fakeCtx } from './contract.test.mjs';

const deep = () => 40;
const calm = { current: { x: 0, z: 0 }, wind: { x: 0, z: 0 }, depthAt: deep, wave: { heave: 0, pitch: 0, roll: 0 } };
const run = (s, cmd, env, seconds, dt = 1 / 60) => {
  const events = [];
  for (let t = 0; t < seconds; t += dt) events.push(...stepHull(s, cmd, env, dt));
  return events;
};
const cmd = (o = {}) => ({ throttle: 0, steer: 0, maxSpeed: 12, reverseSpeed: 3, speedLimit: null, held: false, anchor: null, ...o });

test('owner map: per-owner values, min over owners, clearing with null/false', () => {
  const m = createOwnerMap();
  assert.equal(m.min(), null);
  m.set('fishing', 7);
  m.set('fuel', 2);
  assert.equal(m.min(), 2);
  m.set('fuel', null);
  assert.equal(m.min(), 7);
  m.set('fishing', 9);
  assert.equal(m.min(), 9, 'an owner overwrites only its own entry');
  m.set('mooring', 0);
  assert.equal(m.min(), 0, 'zero is a real limit');
  m.set('mooring', false);
  m.set('fishing', undefined);
  assert.equal(m.size(), 0);
  m.set('player', true);
  m.set('cutscene', true);
  m.set('player', false);
  assert.deepEqual(m.owners(), ['cutscene']);
});

test('throttle reaches max speed with weight, and respects the speed limit', () => {
  const s = createHullState();
  run(s, cmd({ throttle: 1 }), calm, 3);
  assert.ok(s.speed > 3 && s.speed < 9, `after 3 s: ${s.speed}`);
  run(s, cmd({ throttle: 1 }), calm, 40);
  assert.ok(Math.abs(s.speed - 12) < 0.2, `top speed ${s.speed}`);
  run(s, cmd({ throttle: 1, speedLimit: 7 }), calm, 12);
  assert.ok(s.speed <= 7.2, `limited ${s.speed}`);
  assert.equal(targetSpeed(1, 12, 3, 1.5), 1.5);
  assert.equal(targetSpeed(-1, 12, 3, 1.5), -1.5);
  assert.equal(targetSpeed(-1, 12, 3, null), -3);
  assert.equal(targetSpeed(0.5, 12, 3, 0), 0);
});

test('coasting is slower than braking astern', () => {
  const a = createHullState();
  const b = createHullState();
  a.speed = b.speed = 10;
  run(a, cmd({ throttle: 0 }), calm, 4);
  run(b, cmd({ throttle: -1 }), calm, 4);
  assert.ok(a.speed > b.speed + 2, `coast ${a.speed} brake ${b.speed}`);
});

test('rudder needs way on; prop wash kicks the bow round at low speed', () => {
  assert.equal(rudderAuthority(0, 0, SEINER_TUNING), 0);
  assert.ok(rudderAuthority(0, 1, SEINER_TUNING) > 0.3, 'kick ahead');
  assert.ok(rudderAuthority(8, 0, SEINER_TUNING) > 0.95);
  assert.ok(rudderAuthority(-3, 0, SEINER_TUNING) < 0, 'reversed going astern');
  const still = createHullState();
  run(still, cmd({ steer: 1 }), calm, 3);
  assert.ok(Math.abs(still.heading) < 0.01, 'no turn dead in the water without throttle');
  const moving = createHullState();
  moving.speed = 10;
  run(moving, cmd({ throttle: 0.85, steer: 1 }), calm, 3);
  assert.ok(moving.heading > 0.5, `turned to starboard: ${moving.heading}`);
});

test('turning heels the hull outboard and slips the stern', () => {
  const s = createHullState();
  s.speed = 11;
  run(s, cmd({ throttle: 1, steer: 1 }), calm, 4);
  assert.ok(s.yawRate > 0.2);
  assert.ok(s.roll < -0.02, `starboard turn heels to port: ${s.roll}`);
  assert.ok(s.sway < 0, 'slips to port');
});

test('buoyancy: the hull adopts the sea slope with inertia', () => {
  const s = createHullState();
  const wave = waveAttitude(1.0, -1.0, 0.3, -0.3, 0, 17.7, 6.2);
  assert.ok(wave.pitch > 0 && wave.roll > 0);
  run(s, cmd(), { ...calm, wave }, 0.2);
  assert.ok(s.pitch < wave.pitch * 0.5, 'does not snap to the wave');
  run(s, cmd(), { ...calm, wave }, 10);
  assert.ok(Math.abs(s.pitch - wave.pitch * SEINER_TUNING.waveFollow) < 0.02, `settles ${s.pitch}`);
});

test('drift: carried by the current; wind leeway only when slow', () => {
  const s = createHullState();
  run(s, cmd(), { ...calm, current: { x: 0.4, z: 0 } }, 20);
  assert.ok(s.x > 4, `drifted east ${s.x}`);
  const a = createHullState();
  const b = createHullState();
  b.speed = 10;
  run(a, cmd(), { ...calm, wind: { x: 10, z: 0 } }, 10);
  run(b, cmd({ throttle: 0.84 }), { ...calm, wind: { x: 10, z: 0 } }, 10);
  assert.ok(a.driftX > 0.2 && Math.abs(b.driftX) < 0.05, `leeway ${a.driftX} vs ${b.driftX}`);
});

test('grounding stops the boat, emits one collision, and backing off is allowed', () => {
  const shallowNorth = (x, z) => (z < -60 ? 1 : 30);
  const s = createHullState();
  s.speed = 8;
  const ev = run(s, cmd({ throttle: 0.7 }), { ...calm, depthAt: shallowNorth }, 12);
  assert.equal(ev.filter((e) => e.type === 'ground').length, 1);
  assert.ok(s.grounded);
  assert.ok(s.z > -60 + 8, `bow stopped at the bank: ${s.z}`);
  run(s, cmd({ throttle: -1 }), { ...calm, depthAt: shallowNorth }, 10);
  assert.ok(!s.grounded, 'backed off');
});

test('a boat stranded in shallows can still move toward deeper water', () => {
  const slope = (x, z) => 1 + Math.max(0, z) * 0.05; // deeper to the south
  const s = createHullState(0, 0, Math.PI);
  run(s, cmd({ throttle: 0.5 }), { ...calm, depthAt: slope }, 10);
  assert.ok(s.z > 5, `escaped south ${s.z}`);
});

test('soft boundary pushes back inside', () => {
  const s = createHullState(7700, 0, Math.PI / 2);
  run(s, cmd(), calm, 20);
  assert.ok(s.x < 7700);
  assert.ok(s.beyondBoundary || s.x <= 7600);
});

test('capsule collision with a moored tender stops the hull and reports once', () => {
  const tender = { id: 't', x: 0, z: -40, heading: Math.PI / 2, halfLength: 12, radius: 4 };
  const s = createHullState();
  s.speed = 5;
  const ev = run(s, cmd({ throttle: 0.4 }), { ...calm, obstacles: [tender] }, 10);
  assert.equal(ev.filter((e) => e.type === 'boat').length, 1);
  assert.ok(s.z > -40 + 4 + 3.1 + 5.5 - 0.5, `kept off the tender: ${s.z}`);
  const d = segmentDistance(0, 0, 0, 10, 5, 5, 15, 5);
  assert.ok(Math.abs(Math.sqrt(d.d2) - 5) < 1e-6);
  assert.ok(Math.abs(hullExtent(8, 3, 0) - 8) < 1e-9 && Math.abs(hullExtent(8, 3, Math.PI / 2) - 3) < 1e-9);
});

test('controller: lever notches, holds, and stops at neutral', () => {
  const c = createSeinerController();
  c.helm({ up: true, upPressed: true, dt: 0.016 });
  assert.equal(c.lever, 0.1);
  c.helm({ up: false, dt: 0.016 });
  c.helm({ up: true, upPressed: true, dt: 0.016 });
  assert.equal(c.lever, 0.2);
  for (let i = 0; i < 120; i++) c.helm({ up: true, dt: 1 / 60 });
  assert.ok(c.lever > 0.9);
  c.helm({ up: false, dt: 0.016 });
  for (let i = 0; i < 300; i++) c.helm({ down: true, downPressed: i === 0, dt: 1 / 60 });
  assert.equal(c.lever, 0, 'stops at neutral while S is held');
  c.helm({ down: false, dt: 0.016 });
  c.helm({ down: true, downPressed: true, dt: 0.016 });
  assert.equal(c.lever, -0.1, 'astern after pressing again');
  c.helm({ pad: 0.55, dt: 0.016 });
  assert.equal(c.lever, 0.55, 'gamepad drives the lever directly');
});

test('controller: owner-keyed limits and locks; locks zero the lever', () => {
  const c = createSeinerController();
  c.setSpeedLimit('fishing', 7);
  c.setSpeedLimit('fuel', 2);
  assert.equal(c.speedLimit, 2);
  c.setSpeedLimit('fuel', null);
  assert.equal(c.speedLimit, 7);
  c.setSpeedLimit('fishing', null);
  assert.equal(c.speedLimit, null);
  c.helm({ pad: 0.8 });
  c.lockControls('fishing', true);
  c.lockControls('cutscene', true);
  assert.equal(c.controlsEnabled, false);
  assert.equal(c.lever, 0);
  c.lockControls('fishing', false);
  assert.equal(c.controlsEnabled, false, 'still locked by the cutscene');
  c.lockControls('cutscene', false);
  assert.equal(c.controlsEnabled, true);
});

test('controller: mooring semantics (events, limit, throttle clears it, dock holds position)', () => {
  const emitted = [];
  const c = createSeinerController({ emit: (name, p) => emitted.push([name, p]) });
  c.setPose(100, 100, 0);
  c.setMooring({ kind: 'anchor' });
  assert.deepEqual(emitted.at(-1), ['boat:mooring', { mooring: { kind: 'anchor' } }]);
  assert.equal(c.anchored, true);
  assert.equal(c.speedLimit, 0, 'mooring owner limit');
  c.setMooring({ kind: 'anchor' });
  assert.equal(emitted.length, 1, 'no event without a change');
  // Locked controls: throttle does not weigh anchor.
  c.lockControls('player', true);
  c.helm({ up: true, upPressed: true, allowed: c.controlsEnabled });
  assert.equal(c.anchored, true);
  c.lockControls('player', false);
  c.helm({ up: true, upPressed: true, allowed: c.controlsEnabled });
  assert.equal(c.anchored, false, 'throttle with controls unlocked clears the mooring');
  assert.deepEqual(emitted.at(-1), ['boat:mooring', { mooring: null }]);
  assert.equal(c.speedLimit, null);
  c.setMooring({ kind: 'dock', placeId: 'kodiak' });
  assert.deepEqual(c.mooring, { kind: 'dock', placeId: 'kodiak' });
  const env = { ...calm, current: { x: 0.5, z: 0.2 } };
  for (let i = 0; i < 600; i++) c.step(1 / 60, env, { allowed: true });
  assert.ok(Math.hypot(c.hull.x - 100, c.hull.z - 100) < 0.5, 'a docked boat does not drift');
  c.setMooring(null);
  c.setMooring({ kind: 'bogus' });
  assert.equal(c.mooring, null);
});

test('controller: an anchored boat swings to lie bow into the current', () => {
  const c = createSeinerController();
  c.setPose(0, 0, Math.PI / 2); // heading east
  c.setMooring({ kind: 'anchor' });
  const env = { ...calm, current: { x: 0, z: -0.45 } }; // stream sets north: bow should come round to face south
  for (let i = 0; i < 60 * 150; i++) c.step(1 / 60, env, { allowed: true });
  const h = wrapAngle(c.hull.heading);
  assert.ok(Math.abs(Math.abs(h) - Math.PI) < 0.35, `lying to the anchor facing south: ${h}`);
  const a = c.anchorPoint;
  const bow = { x: c.hull.x + Math.sin(h) * 8, z: c.hull.z - Math.cos(h) * 8 };
  assert.ok(Math.hypot(a.x - bow.x, a.z - bow.z) <= SEINER_TUNING.anchorScope + 2, 'held by the rode');
});

test('controller: tow pull moves the seiner while locked', () => {
  const c = createSeinerController();
  c.lockControls('fishing', true);
  for (let i = 0; i < 300; i++) {
    c.applyTow(0.5, 0);
    c.step(1 / 60, calm, { allowed: c.controlsEnabled });
  }
  assert.ok(c.hull.x > 2, `pulled ${c.hull.x}`);
});

function skiffEnv(seiner, over = {}) {
  return {
    seiner,
    current: () => ({ x: 0.2, z: 0 }),
    depthAt: () => 20,
    ...over,
  };
}
function seinerAt(x, z, heading = 0) {
  const fx = Math.sin(heading);
  const fz = -Math.cos(heading);
  return {
    x, z, heading, vx: 0, vz: 0,
    stern: { x: x - fx * 8.8, z: z - fz * 8.8 },
    mount: { x: x - fx * 6.5, z: z - fz * 6.5 },
    bitt: (side) => ({ x: x + Math.cos(heading) * (side === 'port' ? -3 : 3), z: z + Math.sin(heading) * (side === 'port' ? -3 : 3) }),
  };
}
const stepSkiff = (k, env, seconds) => {
  for (let t = 0; t < seconds; t += 1 / 60) k.step(1 / 60, env);
};

test('skiff: release drops off the ramp with a splash, then holds its end against the current', () => {
  const events = [];
  const k = createSkiffController({ emit: (n, p) => events.push(n) });
  const sn = seinerAt(0, 0, 0);
  const env = skiffEnv(sn);
  k.step(1 / 60, env);
  assert.equal(k.s.state, 'stowed');
  assert.ok(k.release(env));
  assert.equal(k.s.state, 'released');
  assert.ok(k.busy);
  stepSkiff(k, env, 2);
  assert.ok(events.includes('skiff:splash'));
  assert.equal(k.s.state, 'holding');
  assert.ok(k.s.z > 8, 'behind the stern');
  const x0 = k.s.x;
  stepSkiff(k, env, 30);
  assert.ok(Math.abs(k.s.x - x0) < 1.5, `held against the stream: ${k.s.x - x0}`);
});

test('skiff: commands during the drop are applied after it lands', () => {
  const k = createSkiffController();
  const env = skiffEnv(seinerAt(0, 0, 0));
  k.release(env);
  k.holdAt(50, 50);
  stepSkiff(k, env, 30);
  assert.equal(k.s.state, 'holding');
  assert.ok(Math.hypot(k.s.x - 50, k.s.z - 50) < 3);
});

test('skiff: towToward strains and creeps; tieOff stops at the beach', () => {
  const k = createSkiffController();
  const sn = seinerAt(0, 0, 0);
  const shallowEast = (x) => (x > 60 ? 0.2 : 10);
  const env = skiffEnv(sn, { depthAt: shallowEast, current: () => ({ x: 0, z: 0 }) });
  k.release(env);
  stepSkiff(k, env, 2);
  k.towToward(0, 100, 1);
  stepSkiff(k, env, 5);
  assert.equal(k.s.state, 'towing');
  assert.ok(k.s.strain > 0.7 && k.s.effort > 0.7);
  k.tieOff({ x: 90, z: 20 }, env);
  stepSkiff(k, env, 40);
  assert.equal(k.s.state, 'tied');
  assert.ok(k.s.x <= 61 && k.s.x > 45, `nosed into the beach at ${k.s.x}`);
});

test('skiff: closeTo fires once, towOff pulls, returnTo winches back to stowed', () => {
  const k = createSkiffController();
  let sn = seinerAt(0, 0, 0);
  const env = skiffEnv(sn);
  k.release(env);
  stepSkiff(k, env, 2);
  k.holdAt(-60, 40);
  stepSkiff(k, env, 30);
  let arrived = 0;
  k.closeTo(() => ({ x: sn.x - 3.5, z: sn.z + 6 }), () => arrived++);
  assert.ok(k.busy);
  stepSkiff(k, env, 40);
  assert.equal(arrived, 1);
  assert.equal(k.busy, false);
  k.towOff('port', sn.heading);
  stepSkiff(k, env, 20);
  const pull = k.towPull();
  assert.ok(pull && pull.x < -0.3, 'pulls to port (west)');
  k.setTowHeading(Math.PI);
  stepSkiff(k, env, 20);
  assert.ok(k.towPull().z > 0.3, 'aimed south');
  let back = 0;
  k.returnTo(() => back++);
  stepSkiff(k, env, 60);
  assert.equal(k.s.state, 'stowed');
  assert.equal(back, 1);
});

test('skiff: ferry lands at the water line and waits', () => {
  const k = createSkiffController();
  const env = skiffEnv(seinerAt(0, 0, 0), { depthAt: (x) => (x > 100 ? -2 : 5) });
  let ok = 0;
  k.ferry({ x: 0, z: 0 }, { x: 140, z: 0 }, () => ok++, env);
  assert.ok(k.busy);
  stepSkiff(k, env, 60);
  assert.equal(ok, 1);
  assert.equal(k.s.state, 'ferry');
  assert.ok(k.s.x < 101 && k.s.x > 90, `landed at ${k.s.x}`);
  k.stow();
  assert.equal(k.s.state, 'stowed');
});

test('nav: A* finds a water route around Kodiak and string-pulls it', () => {
  const ctx = fakeCtx();
  const grid = buildNavGrid(ctx.heightmap, { cell: 50 });
  const a = ctx.geo.toWorld(57.72, -152.32); // Chiniak Bay
  const b = { x: 1373, z: 5514 }; // Sitkalidak Strait off Old Harbor
  const s = createSearch(grid, a, b, { clearance: 40, minDepth: 3 });
  let status = 'running';
  let frames = 0;
  while (status === 'running' && frames < 5000) {
    status = s.step(3000);
    frames++;
  }
  assert.equal(status, 'done');
  const L = pathLength(s.path);
  assert.ok(L > Math.hypot(a.x - b.x, a.z - b.z) * 1.05, 'longer than the crow flies (around the capes)');
  assert.ok(s.path.length < 60, `smoothed to ${s.path.length} points`);
  for (let d = 0; d < L; d += 25) {
    const p = alongPath(s.path, d);
    assert.ok(ctx.heightmap.heightAt(p.x, p.z) < 0, `on water at ${d} m`);
  }
});

// ------------------------------------------------------------------------------------------------ hull occluder
import { createHullForm, buildOccluder, SEINER_FORM } from '../src/entities/boats/hull.js';
import { SKIFF_FORM } from '../src/entities/boats/skiffModel.js';

test('occluder stays inside the raked stem and transom (a protrusion punches a hole in the water)', () => {
  for (const [name, P, top] of [['seiner', SEINER_FORM, null], ['skiff', SKIFF_FORM, (f) => (t) => f.sheer(t) - 0.04]]) {
    const form = createHullForm(P);
    const g = buildOccluder(form, { stations: 24, inset: 0.05, topY: top ? top(form) : null });
    const pos = g.attributes.position;
    const endZ = (t, y) => {
      const k = form.keel(t);
      const u = Math.min(1, Math.max(0, (y - k) / (form.sheer(t) - k)));
      return form.zOfT(t) + form.zShift(t, u);
    };
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const z = pos.getZ(i);
      assert.ok(z >= endZ(0, y) - 1e-6, `${name}: occluder vertex ${i} ahead of the stem (z ${z.toFixed(2)} < ${endZ(0, y).toFixed(2)} at y ${y.toFixed(2)})`);
      assert.ok(z <= endZ(1, y) + 1e-6, `${name}: occluder vertex ${i} abaft the transom`);
      const t = form.tOfZ(z);
      if (t > 0.03 && t < 0.97) assert.ok(Math.abs(pos.getX(i)) <= form.halfWidthAt(t, y) + 0.05, `${name}: vertex ${i} outside the shell`);
    }
  }
});

test('an anchored boat starts weathervaning to the stream at once, and holds at slack', () => {
  const c = createSeinerController();
  c.setPose(0, 0, Math.PI / 2);
  c.setMooring({ kind: 'anchor' });
  const env = { ...calm, current: { x: 0, z: -0.35 } };
  for (let i = 0; i < 60 * 60; i++) c.step(1 / 60, env, { allowed: true });
  // Heading east with the stream setting north: within a minute the bow has come well round toward south (it lies
  // fully to the stream once the rode has swung the hull downstream of the anchor; see the 150 s test above).
  assert.ok(wrapAngle(c.hull.heading) > Math.PI / 2 + 0.7, `swinging bow-into the stream: ${c.hull.heading}`);
  // Slack water: no swing.
  const d = createSeinerController();
  d.setPose(0, 0, 1);
  d.setMooring({ kind: 'anchor' });
  for (let i = 0; i < 60 * 30; i++) d.step(1 / 60, calm, { allowed: true });
  assert.ok(Math.abs(d.hull.heading - 1) < 0.05, 'holds heading at slack');
});

// ------------------------------------------------------------------------------------------------ camera maths
import { damp, smoothDamp, orbitPosition, occlusionFraction, crowsnestHeight, shakeOffsets, lookAngles } from '../src/render/camera/rigMath.js';

test('camera maths: damping, orbit placement, occlusion pull-in, framing, shake', () => {
  let v = 0;
  for (let i = 0; i < 300; i++) v = damp(v, 10, 0.5, 1 / 60);
  assert.ok(Math.abs(v - 10) < 1e-3, 'damp converges');
  assert.ok(Math.abs(damp(0, 10, 0.5, 1 / 30) - damp(damp(0, 10, 0.5, 1 / 60), 10, 0.5, 1 / 60)) < 1e-9, 'frame-rate independent');
  const st = { v: 0 };
  let x = 0;
  let max = 0;
  for (let i = 0; i < 600; i++) {
    x = smoothDamp(x, 5, st, 0.3, 1 / 60);
    max = Math.max(max, x);
  }
  assert.ok(Math.abs(x - 5) < 1e-3 && max <= 5 + 1e-6, 'smoothDamp settles without overshoot');
  const o = orbitPosition(0, 4, 0, 0, 0.3, 30);
  assert.ok(o.z > 25 && Math.abs(o.x) < 1e-9 && o.y > 4, 'yaw 0 looks north: camera sits south of the focus, above it');
  const a = lookAngles(o.x, o.y, o.z, 0, 4, 0);
  assert.ok(Math.abs(a.yaw) < 1e-9 && Math.abs(a.pitch - 0.3) < 1e-9, 'lookAngles inverts orbitPosition');
  const hill = (px, pz) => (pz > 10 && pz < 20 ? 30 : -5);
  assert.ok(occlusionFraction(0, 4, 0, o.x, o.y, o.z, hill) < 0.5, 'a ridge between focus and camera pulls the camera in');
  assert.equal(occlusionFraction(0, 4, 0, o.x, o.y, o.z, () => -5), 1, 'clear view');
  assert.ok(crowsnestHeight(68, 400) > crowsnestHeight(68, 100) && crowsnestHeight(68, 10) === 68, 'crow’s nest rises to frame the set');
  const s0 = shakeOffsets(1.2, 0);
  assert.ok(s0.yaw === 0 && s0.y === 0, 'no trauma, no shake');
  for (let t = 0; t < 5; t += 0.013) {
    const s = shakeOffsets(t, 1);
    assert.ok(Math.abs(s.yaw) <= 0.036 && Math.abs(s.roll) <= 0.051 && Math.abs(s.y) <= 0.351, 'shake is bounded');
  }
});

// ------------------------------------------------------------------------------------------------ light pools
import { createLightPools } from '../src/entities/boats/fx.js';

test('light pools pack only the lit slots, keeping each slot’s colour', () => {
  const ctx = fakeCtx();
  const pools = createLightPools(ctx, 4, { color: 0xffffff, intensity: 1 });
  pools.set(0, 1, 0, 1, 10, true, 1);
  pools.set(1, 2, 0, 2, 10, false);
  pools.set(2, 3, 0, 3, 12, true, 0.5);
  pools.commit();
  const geo = pools.mesh.geometry;
  assert.equal(geo.instanceCount, 2);
  const p = geo.attributes.aPool.array;
  const c = geo.attributes.aColor.array;
  assert.deepEqual([p[0], p[3], p[4], p[7]], [1, 10, 3, 12]);
  assert.ok(Math.abs(c[0] - 1) < 1e-6 && Math.abs(c[3] - 0.5) < 1e-6, 'colours follow their slots');
  pools.set(0, 0, 0, 0, 0, false);
  pools.commit();
  assert.equal(geo.instanceCount, 1);
  assert.ok(Math.abs(geo.attributes.aColor.array[0] - 0.5) < 1e-6);
});

// ------------------------------------------------------------------------------------------------ QA fixes
import { hullWaypoint, hullClearance } from '../src/entities/boats/hullRoute.js';

// Runs the skiff until `done()` and returns the closest its centre came to the seiner's hull surface.
function closestPass(k, env, seconds, done = () => false) {
  const hull = { x: env.seiner.x, z: env.seiner.z, heading: env.seiner.heading, halfLength: 9.3, halfBeam: 3.2 };
  let min = Infinity;
  for (let t = 0; t < seconds && !done(); t += 1 / 60) {
    k.step(1 / 60, env);
    min = Math.min(min, hullClearance(k.s.x, k.s.z, hull));
  }
  return min;
}

test('skiff: the ferry goes round an anchored seiner lying bow-on to the beach, out and back', () => {
  const k = createSkiffController();
  const sn = seinerAt(0, 0, 0); // bow north, the beach dead ahead
  const env = skiffEnv(sn, { current: () => ({ x: 0, z: 0 }), depthAt: (x, z) => (z < -80 ? -2 : 8) });
  let landed = 0;
  k.ferry({ x: 0, z: 14.5 }, { x: 0, z: -95 }, () => landed++, env);
  const out = closestPass(k, env, 60, () => landed > 0);
  assert.equal(landed, 1, 'landed');
  assert.ok(out > 1.2, `kept clear of the hull on the way in: ${out.toFixed(2)} m`);
  assert.ok(k.s.z < -70, `at the beach: ${k.s.z.toFixed(1)}`);
  let back = 0;
  k.ferry(null, { x: 0, z: 16 }, () => back++, env);
  const home = closestPass(k, env, 60, () => back > 0);
  assert.equal(back, 1, 'back astern');
  assert.ok(home > 1.2, `kept clear of the hull on the way back: ${home.toFixed(2)} m`);
  let stowed = 0;
  k.returnTo(() => stowed++);
  closestPass(k, env, 30, () => stowed > 0);
  assert.equal(k.s.state, 'stowed');
});

test('skiff: closing to the far quarter goes round the stern, and returnTo from ahead goes round the hull', () => {
  const k = createSkiffController();
  const sn = seinerAt(0, 0, Math.PI / 2); // heading east
  const env = skiffEnv(sn, { current: () => ({ x: 0, z: 0 }) });
  k.release(env);
  stepSkiff(k, env, 2);
  k.holdAt(0, -40); // off the port side
  stepSkiff(k, env, 30);
  let arrived = 0;
  // Starboard quarter: 6.5 m aft, 4.6 m out to starboard (south when heading east).
  const pass = (() => {
    k.closeTo({ x: -6.5, z: 4.6 }, () => arrived++);
    return closestPass(k, env, 40, () => arrived > 0);
  })();
  assert.equal(arrived, 1);
  assert.ok(pass > 1.0, `closing kept off the hull: ${pass.toFixed(2)} m`);
  k.holdAt(40, 0); // dead ahead
  stepSkiff(k, env, 30);
  let back = 0;
  k.returnTo(() => back++);
  const ret = closestPass(k, env, 60, () => k.s.phase === 'winch');
  assert.ok(ret > 1.0, `returnTo kept off the hull: ${ret.toFixed(2)} m`);
  stepSkiff(k, env, 5);
  assert.equal(back, 1);
});

test('hull route: direct when clear, a waypoint on one side when the run crosses the hull, sticky side', () => {
  const hull = { x: 0, z: 0, heading: 0, halfLength: 9.3, halfBeam: 3.2 };
  assert.equal(hullWaypoint(20, 30, 20, -30, hull), null, 'a run well off the side is direct');
  const st = { side: 0 };
  const wp = hullWaypoint(0, 20, 0, -60, hull, { state: st });
  assert.ok(wp && Math.abs(wp.x) > 6, `detours abeam: ${JSON.stringify(wp)}`);
  assert.ok(st.side === 1 || st.side === -1);
  const again = hullWaypoint(0.4 * -st.side, 19, 0, -60, hull, { state: st });
  assert.equal(Math.sign(again.x), Math.sign(wp.x), 'keeps its side when the choice is close');
  assert.ok(hullWaypoint(-5.5, 6, 5.5, 6, hull), 'crossing under the stern quarter is blocked');
  assert.equal(hullWaypoint(-12, 7, -4.6, 6.5, hull), null, 'coming alongside the quarter from outboard is direct');
});

test('world boundary: full ahead past the soft line turns the boat back inside instead of pinning it on the wall', () => {
  const s = createHullState(-4500, 7650, Math.PI); // heading south toward the edge
  s.speed = 12;
  let maxZ = s.z;
  const T = { ...SEINER_TUNING, boundary: 7850, boundaryHard: 7950 };
  for (let t = 0; t < 90; t += 1 / 60) {
    stepHull(s, cmd({ throttle: 1 }), calm, 1 / 60, T);
    maxZ = Math.max(maxZ, s.z);
  }
  assert.ok(maxZ < 7950 - 5, `never reached the hard wall: ${maxZ.toFixed(1)}`);
  assert.ok(s.z < 7850, `back inside the chart: ${s.z.toFixed(1)}`);
  assert.ok(Math.cos(s.heading) > 0.3, `heading back north-ish: ${((s.heading * 180) / Math.PI).toFixed(0)} deg`);
  assert.ok(s.speed > 6, 'still under way, and moving: the speed readout matches the motion');
  const vz = s.vz;
  assert.ok(vz < -3, `moving inward at ${vz.toFixed(2)} m/s`);
});

test('world boundary: a boat put past the hard wall has no way on into it', () => {
  const s = createHullState(0, 7990, Math.PI);
  s.speed = 10;
  const T = { ...SEINER_TUNING, boundary: 7850, boundaryHard: 7950 };
  stepHull(s, cmd({ throttle: 1 }), calm, 1 / 60, T);
  assert.ok(s.z <= 7950 && s.vz <= 0, `clamped and not moving out: z ${s.z.toFixed(1)} vz ${s.vz.toFixed(2)}`);
});

import { crowsnestFrame, crowsnestCeiling, clearOrbit, insideCollider } from '../src/render/camera/rigMath.js';

test('crow’s nest: framing a wide set stays under the cloud deck by tilting and widening, never climbing', () => {
  assert.equal(crowsnestCeiling(300), 115, "partly: under the mist banks");
  assert.equal(crowsnestCeiling(114), 94, 'overcast: 20 m under the deck');
  assert.equal(crowsnestCeiling(undefined), 115, "no sky: the plain cap");
  assert.equal(crowsnestCeiling(40), 45, 'never below 45 m');
  const small = crowsnestFrame({ across: 60, along: 60, pitch: 0.9, ceiling: 115, floor: 60 });
  assert.ok(Math.abs(small.height - 60) < 1 && small.pitch === 0.9 && small.fov === 55, 'a small set keeps the default pose');
  for (const [across, along] of [[200, 200], [320, 150], [500, 300]]) {
    for (const ceiling of [115, 94, 72]) {
      const f = crowsnestFrame({ across, along, pitch: 0.9, fovDeg: 55, aspect: 16 / 9, ceiling, floor: 60 });
      assert.ok(f.height <= ceiling + 1e-6, `${across}x${along} under ${ceiling}: ${f.height.toFixed(1)}`);
      assert.ok(f.pitch >= 0.52 - 1e-9 && f.pitch <= 0.9 && f.fov >= 55 && f.fov <= 70, 'tilt and zoom in range');
    }
  }
  const wide = crowsnestFrame({ across: 320, along: 150, pitch: 0.9, ceiling: 94, floor: 60 });
  assert.ok(wide.pitch < 0.9, 'tilts toward the horizon first');
  // The same set framed without a ceiling would climb.
  assert.ok(crowsnestFrame({ across: 320, along: 150, pitch: 0.9, ceiling: 1e4, floor: 60 }).height > 94);
  // A long straight line laid away from the camera: the oblique view puts the look point nearer than its middle.
  const line = crowsnestFrame({ across: 40, along: 300, pitch: 0.9, ceiling: 94, floor: 60 });
  assert.ok(line.height <= 94 && line.shift < 0, `line: h ${line.height.toFixed(0)} shift ${line.shift.toFixed(0)}`);
  // A player who zoomed out past the ceiling keeps their own height.
  assert.ok(crowsnestFrame({ across: 50, along: 50, pitch: 0.9, ceiling: 94, floor: 200 }).height >= 199);
});

test('foot camera: lifts over (or pulls in from) solid things along the orbit; colliders by shape', () => {
  const box = { kind: 'box', x: 0, z: 6, hx: 3, hz: 1, rot: 0, y0: 0, y1: 4 };
  assert.ok(insideCollider(box, 2.5, 1, 6.5) && !insideCollider(box, 0, 5, 6) && !insideCollider(box, 0, 1, 9), 'box extents');
  const turned = { ...box, rot: Math.PI / 2 };
  assert.ok(insideCollider(turned, 0.5, 1, 8.5) && !insideCollider(turned, 2.5, 1, 6), 'box rotation follows the heading');
  assert.ok(insideCollider({ kind: 'circle', x: 0, z: 0, r: 1, y0: 0, y1: 2 }, 0.9, 1, 0) && !insideCollider({ kind: 'circle', x: 0, z: 0, r: 1, y0: 0, y1: 2 }, 0.9, 3, 0));
  // Camera orbit looking north (yaw 0) sits south (+z) of the focus: a wall 6 m behind the person.
  const blocked = (x, y, z) => insideCollider(box, x, y, z, 0.3);
  const lifted = clearOrbit(0, 1.6, 0, 0, 0.3, 10, blocked);
  assert.ok(lifted.pitch > 0.3 && lifted.frac === 1, `lifted over the wall: ${lifted.pitch.toFixed(2)}`);
  const tall = { ...box, y1: 40 };
  const pulled = clearOrbit(0, 1.6, 0, 0, 0.3, 10, (x, y, z) => insideCollider(tall, x, y, z, 0.3));
  assert.ok(pulled.frac < 0.6 && pulled.pitch === 0.3, `pulled in before a tall wall: ${pulled.frac}`);
  const free = clearOrbit(0, 1.6, 0, 0, 0.3, 10, () => false);
  assert.ok(free.frac === 1 && free.pitch === 0.3, 'clear view unchanged');
});
