// Regression tests for the QA fixes to WP-FOOT: solid props and buildings (collider interface), backing away from a
// watching bear, the bluff charge played out before the fade, retreat beside the skiff, bear-aware landings, the
// landing cutscene ending on dry ground, and viewpoint perches that have to be earned.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FOOT_RULES, findLanding, bearPenalty, besideBow, perchPoint, onSummit, PERCH } from '../src/entities/player/rules.js';
import { FOOT_TUNING, createFootState, stepFoot, colliderContact, blocksWalker } from '../src/entities/player/controller.js';
import { createAnimator, createPose, animate, stepLength } from '../src/entities/player/anim.js';
import { fakeCtx } from './contract.test.mjs';
import { STUBS } from '../src/systems/stubs.js';
import { SYSTEMS } from '../src/systems/registry.js';
import { resolve } from '../src/data/places.js';

const near = (a, b, eps) => Math.abs(a - b) <= eps;
const R = FOOT_TUNING.radius;

function run(heightAt, s, cmd, seconds, env = {}, each = null, dt = 1 / 60) {
  for (let t = 0; t < seconds; t += dt) {
    stepFoot(s, typeof cmd === 'function' ? cmd(s, t) : cmd, { heightAt, dt, ...env });
    each?.(s, t);
  }
}
const inside = (c, s, slack = 0.02) => blocksWalker(c, s.y) && colliderContact(c, s.x, s.z, R - slack);

// ------------------------------------------------------------------------------------------------ colliders
test('colliders: a turbine tower (circle) stops the walker at its surface', () => {
  const flat = () => 3;
  const tower = { kind: 'circle', x: 10, z: 0, r: 1.3, y0: 0, y1: 60 };
  const s = createFootState(0, 0, Math.PI / 2, flat);
  let hit = false;
  run(flat, s, { mx: 1, mz: 0, run: true }, 6, { colliders: [tower] }, (st) => {
    assert.ok(!inside(tower, st), `inside the tower at x ${st.x.toFixed(2)}`);
    hit ||= st.touching;
  });
  assert.ok(hit, 'reported the contact');
  assert.ok(near(s.x, 10 - 1.3 - R, 0.05), `stopped at x ${s.x.toFixed(2)}`);
});

test('colliders: walking into a wall at an angle slides along it', () => {
  const flat = () => 1;
  const wall = { kind: 'box', x: 5, z: 0, hx: 0.2, hz: 30, rot: 0, y0: -2, y1: 6 };
  const s = createFootState(0, 0, 0, flat);
  run(flat, s, { mx: 0.8, mz: -0.6 }, 5, { colliders: [wall] }, (st) => assert.ok(!inside(wall, st)));
  assert.ok(near(s.x, 5 - 0.2 - R, 0.05), `against the wall x ${s.x.toFixed(2)}`);
  assert.ok(s.z < -4, `slid north along it (z ${s.z.toFixed(2)})`);
  assert.ok(s.speed > 0.8, 'keeps moving along the wall');
});

test('colliders: rotated buildings (heading convention) block from every side', () => {
  const flat = () => 0.5;
  // A 6 x 10 m house turned 40° clockwise from north.
  const house = { kind: 'box', x: 0, z: 0, hx: 3, hz: 5, rot: 40 * (Math.PI / 180), y0: -2, y1: 7 };
  // Local +x of the box is (cos rot, sin rot): a point 3.2 m along it is just outside the east wall.
  const ex = Math.cos(house.rot);
  const ez = Math.sin(house.rot);
  assert.equal(colliderContact(house, ex * 3.5, ez * 3.5, R), false);
  assert.ok(colliderContact(house, ex * 3.1, ez * 3.1, R));
  const c = { nx: 0, nz: 0, depth: 0 };
  colliderContact(house, ex * 3.1, ez * 3.1, R, c);
  assert.ok(near(c.nx, ex, 1e-6) && near(c.nz, ez, 1e-6), 'normal points out of the east wall');
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    const s = createFootState(Math.sin(a) * 14, -Math.cos(a) * 14, 0, flat);
    run(flat, s, (st) => ({ mx: -st.x, mz: -st.z }), 8, { colliders: [house] }, (st) => assert.ok(!inside(house, st), `approach ${k}`));
  }
});

test('colliders: low driftwood is jumped, knee-high logs block walking, overhangs are walked under', () => {
  const flat = () => 2;
  const log = { kind: 'box', x: 6, z: 0, hx: 0.3, hz: 3, rot: 0, y0: 1.8, y1: 2.45 };
  const s = createFootState(0, 0, Math.PI / 2, flat);
  run(flat, s, { mx: 1, mz: 0 }, 5, { colliders: [log] });
  assert.ok(s.x < 6, `a 0.45 m log blocks a walk (x ${s.x.toFixed(2)})`);
  // A jump clears it.
  const j = createFootState(0, 0, Math.PI / 2, flat);
  let jumped = false;
  run(flat, j, (st) => {
    const jump = !jumped && st.x > 4.6;
    jumped ||= jump;
    return { mx: 1, mz: 0, run: true, jump };
  }, 2.5, { colliders: [log] });
  assert.ok(j.x > 7, `jumped over (x ${j.x.toFixed(2)})`);
  // A pebble-height ridge is stepped over.
  const ridge = { ...log, y1: 2.15 };
  const p = createFootState(0, 0, Math.PI / 2, flat);
  run(flat, p, { mx: 1, mz: 0 }, 5, { colliders: [ridge] });
  assert.ok(p.x > 8, 'stepped over');
  // A pier deck 3 m up is walked under.
  const deck = { kind: 'box', x: 6, z: 0, hx: 2, hz: 3, rot: 0, y0: 5, y1: 5.5 };
  const u = createFootState(0, 0, Math.PI / 2, flat);
  run(flat, u, { mx: 1, mz: 0 }, 6, { colliders: [deck] });
  assert.ok(u.x > 10, 'walked under');
});

test('colliders: a fast slide cannot tunnel through a thin wall; a gap narrower than the body is not squeezed through', () => {
  const flat = () => 0;
  const fence = { kind: 'box', x: 0.7, z: 0, hx: 0.04, hz: 5, rot: 0, y0: -1, y1: 2 };
  const T = { ...FOOT_TUNING, runSpeed: 9, accel: 400 };
  const s = createFootState(0, 0, Math.PI / 2, flat);
  for (let i = 0; i < 20; i++) stepFoot(s, { mx: 1, mz: 0, run: true }, { heightAt: flat, dt: 0.1, colliders: [fence] }, T);
  assert.ok(s.x < 0.7, `stayed on the near side (x ${s.x.toFixed(2)})`);
  // Two boulders 0.5 m apart (surface to surface): the 0.68 m wide walker stops at the gap.
  const a = { kind: 'circle', x: 5, z: -1.05, r: 0.8, y0: -1, y1: 2 };
  const b = { kind: 'circle', x: 5, z: 1.05, r: 0.8, y0: -1, y1: 2 };
  const w = createFootState(0, 0, Math.PI / 2, flat);
  run(flat, w, { mx: 1, mz: 0 }, 6, { colliders: [a, b] }, (st) => assert.ok(!inside(a, st) && !inside(b, st)));
  assert.ok(w.x < 5, `did not squeeze through (x ${w.x.toFixed(2)})`);
});

test('colliders: accepts a query function (x, z, r) and tolerates malformed entries', () => {
  const flat = () => 0;
  const calls = [];
  const query = (x, z, r) => {
    calls.push(r);
    return [null, { kind: 'circle', x: NaN, z: 0, r: 1 }, { kind: 'mystery' }, { kind: 'circle', x: 6, z: 0, r: 1, y0: -1, y1: 3 }];
  };
  const s = createFootState(0, 0, Math.PI / 2, flat);
  run(flat, s, { mx: 1, mz: 0 }, 5, { colliders: query });
  assert.ok(calls.length > 0 && calls.every((r) => r === FOOT_TUNING.colliderReach));
  assert.ok(near(s.x, 6 - 1 - R, 0.05), `stopped by the valid circle (x ${s.x.toFixed(2)})`);
});

// ------------------------------------------------------------------------------------------------ backing away
test('backing away: facing held, capped speed, gait in reverse with footfalls matching the distance', () => {
  const flat = () => 1;
  const s = createFootState(0, 0, Math.PI / 2, flat); // facing east, at a bear to the east
  run(flat, s, { mx: -1, mz: 0, face: Math.PI / 2, maxSpeed: 1.3 }, 3);
  assert.ok(near(s.heading, Math.PI / 2, 0.02), `still facing the bear (${s.heading.toFixed(2)})`);
  assert.ok(near(s.speed, 1.3, 0.05) && s.x < -3, `backed off at ${s.speed.toFixed(2)} m/s`);
  assert.equal(s.reverse, true);
  // Running ignores nothing here: without `face` the walker turns to go.
  run(flat, s, { mx: -1, mz: 0, run: true }, 2);
  assert.ok(near(Math.abs(s.heading), Math.PI / 2, 0.05) && s.heading < 0 && s.reverse === false, 'turned his back to run');
  const a = createAnimator(0.2);
  const pose = createPose();
  const dt = 1 / 60;
  let dist = 0;
  for (let i = 0; i < 600; i++) {
    animate(a, pose, { dt, speed: 1.3, onGround: true, reverse: true, mode: 'wary' }, () => 0);
    dist += 1.3 * dt;
  }
  const expected = dist / stepLength(1.3);
  assert.ok(Math.abs(a.steps - expected) <= 2, `steps ${a.steps} vs ${expected.toFixed(1)}`);
});

// ------------------------------------------------------------------------------------------------ rules
test('landing search scores beaches near a bear down, but still lands when there is nothing else', () => {
  const beach = (x) => (x - 100) * 0.12; // straight coast at x = 100
  const plain = findLanding(0, 0, { heightAt: beach });
  assert.ok(plain.ok);
  const bear = { x: plain.landing.x + 2, z: plain.landing.z + 20 };
  const pen = (x, z) => bearPenalty(Math.hypot(x - bear.x, z - bear.z));
  const r = findLanding(0, 0, { heightAt: beach, penalty: pen });
  assert.ok(r.ok);
  assert.ok(Math.hypot(r.landing.x - bear.x, r.landing.z - bear.z) >= 50, `landed ${Math.hypot(r.landing.x - bear.x, r.landing.z - bear.z).toFixed(1)} m from the bear`);
  assert.equal(bearPenalty(80), 0);
  assert.ok(bearPenalty(22) > bearPenalty(40) && bearPenalty(40) > 0);
  // A single small cove with a bear on it: still a landing.
  const cove = (x, z) => (Math.abs(z) < 6 ? (x - 100) * 0.12 : (x - 100) * 3);
  const c = findLanding(0, 0, { heightAt: cove, penalty: () => 90 });
  assert.ok(c.ok);
});

test('beside the bow: a dry spot within the board radius, never out of depth', () => {
  const beach = (x) => (x - 10) * 0.08; // gentle: dry (>= 0.15) only from x ≈ 11.9
  const p = besideBow(beach, 10.4, 0, 1, 0);
  assert.ok(p, 'found');
  const d = Math.hypot(p.x - 10.4, p.z);
  assert.ok(d <= 3.4 + 1e-9, `within the radius (${d.toFixed(2)} m)`);
  assert.ok(beach(p.x) >= 0.15, 'on dry beach');
  // All water ahead: no spot deeper than wading allows.
  const deep = besideBow(() => -1, 0, 0, 1, 0);
  assert.equal(deep, null);
  const wet = besideBow((x) => -0.1 - x * 0.01, 0, 0, 1, 0);
  assert.ok(wet && -((x) => -0.1 - x * 0.01)(wet.x) <= FOOT_RULES.kneeDepth);
});

test('viewpoint perches: the marked spot (~18 m) or its local high point, not 37 m away on the beach', () => {
  // A headland: the marker on its crown, a beach 37 m off.
  const land = (x, z) => 12 * Math.exp(-(x * x + z * z) / 900) - 0.02 * Math.hypot(x, z);
  const vp = perchPoint(land, { kind: 'viewpoint', x: 0, z: 0, radius: 200 });
  assert.equal(vp.radius, PERCH.viewRadius);
  assert.ok(!onSummit(37, land(37, 0), 0, vp), 'not from the landing 37 m away');
  assert.ok(onSummit(10, land(10, 0), 0, vp), 'on the marked spot');
  // A marker on the beach below a knoll: the knoll top counts too.
  const knoll = (x, z) => 20 * Math.exp(-((x - 30) ** 2 + z * z) / 300);
  const v2 = perchPoint(knoll, { kind: 'viewpoint', x: 0, z: 0, radius: 150 });
  assert.ok(v2.alt && near(v2.alt.x, 30, 3), `high point at ${v2.alt?.x.toFixed(1)}`);
  assert.ok(onSummit(30, knoll(30, 0), 0, v2));
  assert.ok(!onSummit(30, knoll(30, 0) - 8, 0, v2), 'below it does not count');
});

// ------------------------------------------------------------------------------------------------ the system
async function buildWorld() {
  const ctx = fakeCtx();
  ctx.game = {
    setMode(m) {
      const prev = ctx.state.mode;
      ctx.state.mode = m;
      ctx.events.emit('game:mode', { mode: m, prev });
    },
    avatar() {
      const onFoot = ctx.state.control === 'foot' && ctx.systems.player?.active;
      const src = onFoot ? ctx.systems.player : ctx.systems.seiner;
      return { x: src.position.x, y: src.position.y, z: src.position.z, heading: src.heading ?? 0, object3d: src.object3d, control: ctx.state.control };
    },
  };
  const offers = [];
  ctx.interact = { current: {}, offer: (o) => offers.push(o) };
  const radio = [];
  ctx.events.on('ui:radio', (r) => radio.push(r));
  const { create } = await import('../src/entities/player.js');
  for (const { name } of SYSTEMS) {
    if (name === 'terrain') continue; // falls back to the heightmap
    ctx.systems[name] = name === 'player' ? await create(ctx) : STUBS[name](ctx);
  }
  const shakes = [];
  ctx.systems.cameraRig.shake = (a) => shakes.push({ a, t: ctx.time.elapsed });
  const frame = (n = 1, dt = 1 / 30, each = null) => {
    for (let i = 0; i < n; i++) {
      offers.length = 0;
      ctx.time.elapsed += dt;
      for (const { name } of SYSTEMS) ctx.systems[name]?.update?.(dt);
      for (const { name } of SYSTEMS) ctx.systems[name]?.lateUpdate?.(dt);
      each?.();
    }
  };
  const R0 = resolve(ctx.geo);
  const fort = R0.places.find((p) => p.id === 'fort-abercrombie');
  const w = ctx.heightmap.nearestWater(fort.landing.x, fort.landing.z, { minShore: 60 });
  ctx.systems.seiner.setPose(w.x, w.z, 0);
  frame(2);
  return { ctx, offers, radio, frame, shakes, player: ctx.systems.player, anchorage: w };
}

// A scripted bear for the system tests: it stands at (x, z) and bluff-charges the deckhand on demand, pulling up 4 m
// short like land.js does.
function fakeWildlife(ctx, bear) {
  return {
    bears: [bear],
    whales: [],
    birds: [],
    encounter: null,
    nearestBear: (x, z) => ({ bear, distance: Math.hypot(bear.position.x - x, bear.position.z - z) }),
    update(dt) {
      if (bear.state !== 'charge') return;
      const p = ctx.systems.player.position;
      const dx = p.x - bear.position.x;
      const dz = p.z - bear.position.z;
      const d = Math.hypot(dx, dz);
      bear.speed = d > 4.05 ? Math.min(9, bear.speed + 12 * dt) : Math.max(0, bear.speed - 30 * dt);
      const step = Math.min(bear.speed * dt, Math.max(0, d - 4));
      bear.position.x += (dx / d) * step;
      bear.position.z += (dz / d) * step;
    },
  };
}

test('player: the landing cutscene ends with the deckhand on dry beach, clear of the bow', async () => {
  const { ctx, frame, player } = await buildWorld();
  assert.ok(player.goAshore());
  let t = 0;
  while (player.phase !== 'foot' && t < 60) {
    frame(1);
    t += 1 / 30;
  }
  assert.equal(player.phase, 'foot');
  const h = ctx.heightmap.heightAt(player.position.x, player.position.z);
  assert.ok(h >= 0.1, `standing on dry ground (height ${h.toFixed(2)})`);
  assert.equal(player.wading, false);
});

test('player: a bluff charge plays out (lunge, stop short, shake) before the fade; back within reach of the skiff', async () => {
  const { ctx, frame, radio, shakes, player, offers } = await buildWorld();
  assert.ok(player.debugAshore());
  frame(2);
  // Somewhere dry and level 60-100 m from the beached skiff, so the bear is well clear of the landing.
  frame(90);
  const skiffPos = ctx.systems.skiff.position.clone();
  const hm = ctx.heightmap;
  let spot = null;
  for (let r = 60; r <= 100 && !spot; r += 5) {
    for (let k = 0; k < 24 && !spot; k++) {
      const a = (k / 24) * Math.PI * 2;
      const x = skiffPos.x + Math.sin(a) * r;
      const z = skiffPos.z - Math.cos(a) * r;
      const ok = [0, 1, 2, 3].every((j) => hm.heightAt(x + Math.sin(j * 1.57) * 12, z - Math.cos(j * 1.57) * 12) > 0.3) && Math.abs(hm.heightAt(x + 12, z) - hm.heightAt(x, z)) < 3;
      if (ok) spot = { x, z };
    }
  }
  assert.ok(spot, 'a spot inland');
  assert.ok(player.placeAt(spot.x, spot.z, 90));
  frame(15);
  const p = player.position;
  const bear = { id: 'bear-x', kind: 'bear', age: 'boar', position: p.clone().add({ x: 9.5, y: 0, z: 0 }), heading: 0, state: 'watch', speed: 0 };
  ctx.systems.wildlife = fakeWildlife(ctx, bear);
  ctx.events.emit('bear:encounter', { stage: 'watch', bearId: bear.id, x: bear.position.x, z: bear.position.z });
  frame(20);
  bear.state = 'charge';
  ctx.events.emit('bear:encounter', { stage: 'charge', bearId: bear.id, x: bear.position.x, z: bear.position.z });
  assert.equal(ctx.state.mode, 'cutscene');
  const t0 = ctx.time.elapsed;
  let fadeAt = null;
  let minGap = Infinity;
  frame(150, 1 / 30, () => {
    minGap = Math.min(minGap, Math.hypot(bear.position.x - p.x, bear.position.z - p.z));
    if (fadeAt === null && player.debugState().fade > 0.01) fadeAt = ctx.time.elapsed - t0;
  });
  assert.ok(fadeAt !== null, 'faded eventually');
  assert.ok(fadeAt >= 1.2 && fadeAt <= 1.8, `the fade waits for the charge (${fadeAt.toFixed(2)} s)`);
  assert.ok(minGap < 5, 'the bear visibly closed in before the fade');
  assert.ok(shakes.some((s) => s.t - t0 > 0.3 && s.t - t0 < fadeAt + 0.05), 'camera shake as it pulls up');
  bear.state = 'retreat';
  frame(40);
  assert.equal(player.phase, 'foot');
  assert.equal(ctx.state.mode, 'play');
  const q = radio.find((r) => r.from === 'Skiffman');
  assert.ok(q && /skiff|beach|bluff|close|brush/i.test(q.text), 'shore quip');
  frame(1);
  assert.ok(offers.some((o) => o.id === 'board-skiff'), 'standing inside the "Back to the boat" radius');
  assert.ok(ctx.heightmap.heightAt(p.x, p.z) > -FOOT_RULES.kneeDepth);
});

test('player: a bear at the landing puts the deckhand aboard, with its own quip', async () => {
  const { ctx, frame, radio, player } = await buildWorld();
  assert.ok(player.debugAshore());
  frame(2);
  const p = player.position;
  const bear = { id: 'bear-y', kind: 'bear', age: 'sow', position: p.clone().add({ x: 8, y: 0, z: 0 }), heading: 0, state: 'charge', speed: 0 };
  ctx.systems.wildlife = fakeWildlife(ctx, bear);
  ctx.events.emit('bear:encounter', { stage: 'charge', bearId: bear.id, x: bear.position.x, z: bear.position.z });
  frame(150);
  assert.equal(player.active, false);
  assert.equal(ctx.state.control, 'boat');
  assert.equal(ctx.state.mode, 'play');
  const q = radio.find((r) => r.from === 'Skiffman');
  assert.ok(q && /aboard|another|landing/i.test(q.text) && !/back to the skiff|by the skiff/i.test(q.text), `aboard quip: ${q?.text}`);
});

test('player: walking away from a watching bear backs off facing it; running turns his back', async () => {
  const { ctx, frame, player } = await buildWorld();
  assert.ok(player.debugAshore());
  frame(2);
  const p = player.position;
  const bear = { id: 'bear-z', kind: 'bear', age: 'boar', position: p.clone().add({ x: 20, y: 0, z: 0 }), heading: 0, state: 'watch', speed: 0 };
  ctx.systems.wildlife = fakeWildlife(ctx, bear);
  ctx.events.emit('bear:encounter', { stage: 'watch', bearId: bear.id, x: bear.position.x, z: bear.position.z });
  // Directly away (west), and 45° off it: backs away facing the bear, slowly.
  for (const dir of [{ mx: -1, mz: 0 }, { mx: -0.7, mz: 0.7 }]) {
    player.debugDrive(dir);
    frame(45);
    const toBear = Math.atan2(bear.position.x - p.x, -(bear.position.z - p.z));
    const off = Math.abs(Math.atan2(Math.sin(player.heading - toBear), Math.cos(player.heading - toBear)));
    assert.ok(off < 1.45, `faces the bear (${((off * 180) / Math.PI).toFixed(0)}° off)`);
    assert.ok(player.velocity.length() <= 1.35, `slowly (${player.velocity.length().toFixed(2)} m/s)`);
  }
  // Shift: turns and runs.
  player.debugDrive({ mx: -1, mz: 0, run: true });
  frame(45);
  assert.ok(player.velocity.length() > 3, 'running');
  const toBear = Math.atan2(bear.position.x - p.x, -(bear.position.z - p.z));
  const off = Math.abs(Math.atan2(Math.sin(player.heading - toBear), Math.cos(player.heading - toBear)));
  assert.ok(off > 2.5, 'back turned to the bear');
  player.debugDrive(null);
});

test('player: props and buildings from places/terrain collidersNear block the deckhand', async () => {
  const { ctx, frame, player } = await buildWorld();
  assert.ok(player.debugAshore());
  frame(2);
  const p0 = player.position.clone();
  // A driftwood-sized stump and a shed wall straight inland; one from each provider.
  const skiffPos = ctx.systems.skiff.position;
  const ux = p0.x - skiffPos.x;
  const uz = p0.z - skiffPos.z;
  const ul = Math.hypot(ux, uz) || 1;
  const cx = p0.x + (ux / ul) * 4;
  const cz = p0.z + (uz / ul) * 4;
  const wall = { kind: 'box', x: cx, z: cz, hx: 6, hz: 0.3, rot: Math.atan2(ux, -uz), y0: -5, y1: 60 };
  let asked = 0;
  ctx.systems.places.collidersNear = (x, z, r) => {
    asked++;
    return Math.hypot(x - cx, z - cz) < r + 8 ? [wall] : [];
  };
  ctx.systems.terrain = { heightAt: (x, z) => ctx.heightmap.heightAt(x, z), collidersNear: () => { throw new Error('in progress'); } };
  const warn = console.warn;
  const warned = [];
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    player.debugDrive({ mx: ux / ul, mz: uz / ul, run: true });
    frame(120);
  } finally {
    console.warn = warn;
    player.debugDrive(null);
  }
  assert.ok(asked > 0, 'queried places');
  assert.equal(warned.length, 1, 'a failing provider is reported once, not every frame');
  const along = (player.position.x - p0.x) * (ux / ul) + (player.position.z - p0.z) * (uz / ul);
  assert.ok(along < 4 - 0.3 - FOOT_TUNING.radius + 0.05, `stopped at the wall (${along.toFixed(2)} m inland)`);
  assert.ok(player.active && player.phase === 'foot');
});

test('player: a viewpoint perch needs a few seconds up at the spot, after the place is discovered', async () => {
  const { ctx, frame, player } = await buildWorld();
  const perches = [];
  ctx.systems.discovery.addPerch = (id) => perches.push({ id, t: ctx.time.elapsed });
  assert.ok(player.debugAshore());
  // A viewpoint 37 m inland of the landing (the Termination Point case).
  const p0 = player.position.clone();
  const skiffPos = ctx.systems.skiff.position;
  const ul = Math.hypot(p0.x - skiffPos.x, p0.z - skiffPos.z) || 1;
  const vp = { id: 'test-vp', name: 'Test Point', kind: 'viewpoint', x: p0.x + ((p0.x - skiffPos.x) / ul) * 37, z: p0.z + ((p0.z - skiffPos.z) / ul) * 37, radius: 120 };
  ctx.systems.places.list.push(vp);
  frame(30 * 6);
  assert.equal(perches.length, 0, 'nothing from the beach');
  assert.ok(player.placeAt(vp.x, vp.z));
  frame(30 * 3);
  assert.equal(perches.length, 0, 'not before the place is discovered');
  ctx.systems.discovery.discover(vp.id);
  const t0 = ctx.time.elapsed;
  frame(30 * 4);
  assert.equal(perches.length, 1);
  assert.equal(perches[0].id, vp.id);
  assert.ok(perches[0].t - t0 <= PERCH.dwell + 0.6, 'soon after discovery once dwelt');
  ctx.systems.places.list.pop();
});
