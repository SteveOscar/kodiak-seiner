// WP-FOOT: on-foot slope/speed rules, the character controller, the landing search, summits, the animation maths, and
// the player system's ashore/return state machine under Node with the stub neighbours.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FOOT_RULES, slopeSpeed, slopeBand, wadeFactor, directionalSlope, gradientSlope, findLanding, stepOffPoint, dryPointAhead, findSummit, perchPoint, onSummit, isHilltop, losesFooting } from '../src/entities/player/rules.js';
import { FOOT_TUNING, createFootState, stepFoot, placeFoot, standable } from '../src/entities/player/controller.js';
import { createAnimator, createPose, animate, legIK, stepLength, SKELETON, BONE_NAMES } from '../src/entities/player/anim.js';
import { fakeCtx } from './contract.test.mjs';
import { STUBS } from '../src/systems/stubs.js';
import { SYSTEMS } from '../src/systems/registry.js';
import { missingMembers } from '../src/systems/contract.js';
import { resolve } from '../src/data/places.js';

const near = (a, b, eps) => Math.abs(a - b) <= eps;
const DEG = Math.PI / 180;

// ------------------------------------------------------------------------------------------------ slope rules
test('slope speed: full to 35°, linear to 30% at 50°, scramble to 58°, slide above', () => {
  assert.equal(slopeSpeed(0), 1);
  assert.equal(slopeSpeed(20), 1);
  assert.equal(slopeSpeed(35), 1);
  assert.ok(near(slopeSpeed(42.5), 0.65, 1e-9));
  assert.ok(near(slopeSpeed(50), 0.3, 1e-9));
  assert.equal(slopeSpeed(55), 0.3);
  assert.equal(slopeSpeed(58), 0.3);
  assert.equal(slopeSpeed(58.5), 0);
  assert.equal(slopeSpeed(80), 0);
  assert.equal(slopeSpeed(-42.5), slopeSpeed(42.5), 'symmetric');
  for (let d = 35; d < 50; d += 0.5) assert.ok(slopeSpeed(d + 0.5) <= slopeSpeed(d), 'monotonic');
  assert.equal(slopeBand(30), 'walk');
  assert.equal(slopeBand(45), 'steep');
  assert.equal(slopeBand(55), 'scramble');
  assert.equal(slopeBand(60), 'slide');
});

test('slope rules agree with the places reachability helper (walk.js) when present', async () => {
  const mod = await import('../src/world/places/walk.js').catch(() => null);
  if (!mod?.footSpeed) return;
  for (let d = 0; d <= 70; d += 0.5) assert.ok(near(mod.footSpeed(d), slopeSpeed(d), 1e-9), `footSpeed(${d})`);
});

test('wading: full speed in a splash, half at the knee, no deeper', () => {
  assert.equal(wadeFactor(0), 1);
  assert.equal(wadeFactor(-3), 1);
  assert.ok(wadeFactor(0.3) < 1 && wadeFactor(0.3) > 0.5);
  assert.ok(near(wadeFactor(FOOT_RULES.kneeDepth), 0.5, 1e-9));
  assert.equal(wadeFactor(FOOT_RULES.kneeDepth + 0.01), 0);
});

test('slope measures on ramps', () => {
  const ramp = (deg) => (x, z) => x * Math.tan(deg * DEG);
  assert.ok(near(directionalSlope(ramp(40), 0, 0, 1, 0), 40, 0.01));
  assert.ok(near(directionalSlope(ramp(40), 0, 0, -1, 0), -40, 0.01));
  assert.ok(near(directionalSlope(ramp(40), 0, 0, 0, 1), 0, 0.01), 'across the fall line');
  const g = gradientSlope(ramp(30), 5, 5);
  assert.ok(near(g.deg, 30, 0.01));
  assert.ok(near(g.dx, -1, 1e-6) && near(g.dz, 0, 1e-6), 'downhill is -x');
});

// ------------------------------------------------------------------------------------------------ controller
function run(heightAt, s, cmd, seconds, env = {}) {
  const dt = 1 / 60;
  let minClear = Infinity;
  for (let t = 0; t < seconds; t += dt) {
    stepFoot(s, typeof cmd === 'function' ? cmd(s, t) : cmd, { heightAt, dt, ...env });
    minClear = Math.min(minClear, s.y - heightAt(s.x, s.z));
  }
  return minClear;
}

test('walks and runs at tuned speeds on the flat, facing the way it goes', () => {
  const flat = () => 2;
  const s = createFootState(0, 0, 0, flat);
  run(flat, s, { mx: 1, mz: 0 }, 2);
  assert.ok(near(s.speed, FOOT_TUNING.walkSpeed, 0.05), `walk ${s.speed}`);
  assert.ok(near(s.heading, Math.PI / 2, 0.02), 'faces east');
  run(flat, s, { mx: 1, mz: 0, run: true }, 2);
  assert.ok(near(s.speed, FOOT_TUNING.runSpeed, 0.1), `run ${s.speed}`);
  run(flat, s, { mx: 0, mz: 0 }, 2);
  assert.ok(s.speed < 0.01, 'stops');
  assert.equal(s.y, 2);
});

test('slope rules shape the speed uphill', () => {
  for (const [deg, factor] of [[25, 1], [42.5, 0.65], [54, 0.3]]) {
    const ramp = (x) => x * Math.tan(deg * DEG);
    const s = createFootState(0, 0, Math.PI / 2, ramp);
    run(ramp, s, { mx: 1, mz: 0 }, 2.5);
    const horiz = FOOT_TUNING.walkSpeed * factor;
    assert.ok(near(s.speed, horiz, 0.06), `${deg}°: ${s.speed.toFixed(2)} vs ${horiz.toFixed(2)}`);
    assert.ok(!s.sliding, `${deg}° is climbable`);
  }
});

test('too steep: cannot climb, slides down, never sinks into the ground', () => {
  const deg = 64;
  const ramp = (x) => Math.max(0, x) * Math.tan(deg * DEG);
  const s = createFootState(20, 0, Math.PI / 2, ramp);
  const x0 = s.x;
  const clear = run(ramp, s, { mx: 1, mz: 0 }, 1.0);
  assert.ok(s.sliding || s.x < x0, 'slides');
  assert.ok(s.x < x0, `pushed back downhill (${s.x.toFixed(2)} < ${x0})`);
  assert.ok(clear >= -1e-9, 'never below ground');
  run(ramp, s, { mx: 0, mz: 0 }, 6);
  assert.ok(s.x < 1 && !s.sliding, `comes to rest at the foot (${s.x.toFixed(2)})`);
});

test('a slope too steep to stand on can be crossed while moving, but not stood on or climbed straight', () => {
  const deg = 62;
  const ramp = (x) => Math.max(0, x) * Math.tan(deg * DEG);
  const s = createFootState(30, 0, Math.PI, ramp);
  const x0 = s.x;
  run(ramp, s, { mx: 0, mz: 1 }, 1.5);
  assert.ok(!s.sliding, 'traverse holds');
  assert.ok(s.z > 0.5 && Math.abs(s.x - x0) < 0.3, `moved across (${s.z.toFixed(2)})`);
  run(ramp, s, { mx: 0, mz: 0 }, 1);
  assert.ok(s.sliding && s.x < x0 - 0.3, 'stopping slides');
  const t = createFootState(30, 0, Math.PI, (x) => Math.max(0, x) * Math.tan(70 * DEG));
  run((x) => Math.max(0, x) * Math.tan(70 * DEG), t, { mx: 0, mz: 1 }, 0.5);
  assert.ok(t.sliding, 'beyond the traverse limit slides even when moving');
  assert.equal(losesFooting(50, 20, false), false);
  assert.equal(losesFooting(62, 20, true), false);
  assert.equal(losesFooting(62, 55, true), true);
  assert.equal(losesFooting(62, 20, false), true);
  assert.equal(losesFooting(70, 0, true), true);
});

test('jumps with gravity and lands on uneven ground without sinking', () => {
  const bumpy = (x, z) => Math.sin(x * 0.7) * 0.4 + Math.cos(z * 0.53) * 0.3 + x * 0.2;
  const s = createFootState(0, 0, 0, bumpy);
  let apex = 0;
  let jumps = 0;
  let lands = 0;
  const clear = run(bumpy, s, (st, t) => ({ mx: Math.cos(t * 0.3), mz: Math.sin(t * 0.3), run: t % 4 > 2, jump: Math.floor(t * 60) % 50 === 0 }), 12);
  const s2 = createFootState(0, 0, 0, () => 0);
  stepFoot(s2, { jump: true }, { heightAt: () => 0, dt: 1 / 60 });
  for (let i = 0; i < 120; i++) {
    stepFoot(s2, {}, { heightAt: () => 0, dt: 1 / 60 });
    apex = Math.max(apex, s2.y);
    if (s2.landed) lands++;
  }
  jumps = 1;
  assert.ok(clear >= -1e-9, `never below ground (${clear})`);
  assert.ok(apex > 0.45 && apex < 0.8, `hop apex ${apex.toFixed(2)} m`);
  assert.equal(lands, jumps);
  assert.ok(s2.onGround && s2.y === 0);
});

test('wades to knee depth only, and slides along the waterline', () => {
  // Beach: land for x > 0, sea floor dropping 0.1 m per metre offshore (x < 0).
  const beach = (x) => x * 0.1;
  const s = createFootState(5, 0, -Math.PI / 2, beach);
  let maxDepth = 0;
  run(beach, s, (st) => {
    maxDepth = Math.max(maxDepth, -beach(st.x));
    return { mx: -1, mz: 0 };
  }, 12);
  assert.ok(maxDepth <= FOOT_RULES.kneeDepth + 1e-6, `max depth ${maxDepth.toFixed(3)}`);
  assert.ok(maxDepth > FOOT_RULES.kneeDepth - 0.08, 'gets close to the knee');
  assert.ok(!standable(beach, -8, 0) && standable(beach, -4, 0));
  // Diagonal push along the waterline keeps moving sideways.
  const z0 = s.z;
  run(beach, s, { mx: -0.7, mz: 0.7 }, 2);
  assert.ok(s.z > z0 + 1, 'deflects along the shore');
  assert.ok(-beach(s.x) <= FOOT_RULES.kneeDepth + 1e-6);
});

test('soft world boundary pushes the walker back', () => {
  const flat = () => 1;
  const s = createFootState(7590, 0, Math.PI / 2, flat);
  let maxX = 0;
  run(flat, s, (st) => {
    maxX = Math.max(maxX, st.x);
    return { mx: 1, mz: 0, run: true };
  }, 8, { boundary: 7600 });
  assert.ok(maxX < 7640, `held near the boundary (max ${maxX.toFixed(1)})`);
  assert.ok(s.x < 7620);
});

// ------------------------------------------------------------------------------------------------ landing search
test('landing search: a gentle beach within reach, none out of reach, cliffs rejected', () => {
  const beach = (x) => (x - 100) * 0.12; // coast at x = 100 running north-south
  const r = findLanding(0, 0, { heightAt: beach });
  assert.ok(r.ok, r.reason);
  assert.ok(near(r.landing.shoreX, 100, 0.2), `waterline ${r.landing.shoreX}`);
  assert.ok(r.landing.y >= 0.2 && r.landing.x > 100 && r.landing.x < 104);
  assert.ok(near(r.landing.heading, Math.PI / 2, 0.14), 'boat to beach is east');
  assert.ok(r.landing.distance <= 150);
  assert.deepEqual(findLanding(-100, 0, { heightAt: beach }), { ok: false, reason: 'none' });
  const cliff = (x) => (x - 100) * 3;
  assert.deepEqual(findLanding(0, 0, { heightAt: cliff }), { ok: false, reason: 'steep' });
  const banned = findLanding(0, 0, { heightAt: beach, exclude: () => true });
  assert.equal(banned.reason, 'excluded');
  // A cliff at the waterline with a beach off to one side: picks the beach.
  const mixed = (x, z) => (z > 30 ? (x - 100) * 0.1 : (x - 100) * 2.5);
  const m = findLanding(0, 40, { heightAt: mixed });
  assert.ok(m.ok && m.landing.z > 30, `picked the beach (z ${m.ok && m.landing.z.toFixed(1)})`);
  // Standing on land: nothing.
  assert.equal(findLanding(150, 0, { heightAt: beach }).ok, false);
});

test('landing search on the real Kodiak heightmap: every on-foot place is reachable from an anchorage', () => {
  const ctx = fakeCtx();
  const hm = ctx.heightmap;
  const R = resolve(ctx.geo);
  const onFoot = R.places.filter((p) => p.onFoot && p.landing);
  assert.ok(onFoot.length >= 5);
  for (const p of onFoot) {
    const w = hm.nearestWater(p.landing.x, p.landing.z, { minShore: 60 });
    const r = findLanding(w.x, w.z, { heightAt: hm.heightAt, shoreDistance: hm.shoreDistance });
    assert.ok(r.ok, `${p.id}: ${r.reason}`);
    assert.ok(r.landing.distance <= 150, `${p.id} within reach`);
    assert.ok(Math.hypot(r.landing.x - p.landing.x, r.landing.z - p.landing.z) < 160, `${p.id} lands near its beach`);
    assert.ok(hm.heightAt(r.landing.x, r.landing.z) >= 0.15, `${p.id} dry`);
  }
  // Mid Shelikof Strait: nothing in reach.
  const mid = ctx.geo.toWorld(57.9, -154.4);
  assert.equal(findLanding(mid.x, mid.z, { heightAt: hm.heightAt, shoreDistance: hm.shoreDistance }).ok, false);
});

test('step-off point: first wadeable spot ahead of the bow', () => {
  const beach = (x) => (x - 10) * 0.15;
  const p = stepOffPoint(beach, 0, 0, 1, 0);
  assert.ok(p && -beach(p.x) <= FOOT_RULES.kneeDepth * 0.8 + 1e-9 && p.x > 7 && p.x < 8.5, `x ${p?.x}`);
  assert.equal(stepOffPoint(() => -5, 0, 0, 1, 0), null);
});

test('dry point ahead: first dry beach beyond the bow, a step further when still dry', () => {
  const beach = (x) => (x - 10) * 0.15; // waterline at x = 10, dry (>= 0.15 m) from x = 11
  const p = dryPointAhead(beach, 0, 0, 1, 0);
  assert.ok(p && beach(p.x) >= 0.15 && p.x > 11 && p.x < 13, `x ${p?.x}`);
  const ledge = (x) => (x >= 11 && x < 11.6 ? 0.3 : x < 11 ? -1 : -0.2); // a dry sliver: no extra step onto the wet
  const q = dryPointAhead(ledge, 0, 0, 1, 0);
  assert.ok(q && ledge(q.x) >= 0.15, `sliver x ${q?.x}`);
  assert.equal(dryPointAhead(() => -2, 0, 0, 1, 0), null);
});

test('hilltops: summits and level ridge crests count, slopes and flats do not', () => {
  const hill = (x, z) => 60 * Math.exp(-(x * x + z * z) / 4000);
  assert.ok(isHilltop(hill, 0, 0, hill(0, 0)));
  assert.ok(!isHilltop(hill, 60, 0, hill(60, 0)), 'mid-slope');
  const ridge = (x) => 50 - Math.abs(x) * 0.8; // crest along z
  assert.ok(isHilltop(ridge, 0, 0, ridge(0)), 'ridge crest');
  assert.ok(!isHilltop(() => 30, 0, 0, 30), 'plateau');
});

test('summits: hill-climb finds the marked hill, not a higher neighbour; viewpoints perch in place', () => {
  const hills = (x, z) => 80 * Math.exp(-((x - 20) ** 2 + z ** 2) / 3000) + 140 * Math.exp(-((x - 400) ** 2 + z ** 2) / 6000);
  const s = findSummit(hills, 0, 0, 150);
  assert.ok(near(s.x, 20, 2) && near(s.z, 0, 2), `summit at ${s.x.toFixed(1)}, ${s.z.toFixed(1)}`);
  assert.ok(near(s.h, 80, 0.5));
  const peak = perchPoint(hills, { kind: 'peak', x: 5, z: 5, radius: 200 });
  assert.ok(near(peak.x, 20, 2));
  assert.ok(onSummit(peak.x + 10, peak.h - 1, peak.z, peak));
  assert.ok(!onSummit(peak.x + 60, peak.h, peak.z, peak));
  assert.ok(!onSummit(peak.x, peak.h - 20, peak.z, peak));
  const vp = perchPoint(hills, { kind: 'viewpoint', x: 300, z: 0, radius: 200 });
  assert.equal(vp.x, 300);
});

// ------------------------------------------------------------------------------------------------ animation
test('leg IK: straight leg at full reach, bends the knee as the foot comes up', () => {
  const L = SKELETON.thigh + SKELETON.shin;
  const a = legIK(0, L);
  assert.ok(a.thigh >= 0 && a.thigh < 0.04 && a.knee >= 0 && a.knee < 0.08, `straight: thigh ${a.thigh.toFixed(3)} knee ${a.knee.toFixed(3)}`);
  const b = legIK(0.1, 0.6);
  assert.ok(b.knee > 0.8 && b.thigh > 0.4, `bent: knee ${b.knee.toFixed(2)}`);
  // Forward kinematics lands the ankle on the target.
  const fx = Math.sin(b.thigh) * SKELETON.thigh + Math.sin(b.thigh - b.knee) * SKELETON.shin;
  const fy = Math.cos(b.thigh) * SKELETON.thigh + Math.cos(b.thigh - b.knee) * SKELETON.shin;
  assert.ok(near(fx, 0.1, 1e-3) && near(fy, 0.6, 1e-3), `fk ${fx.toFixed(3)}, ${fy.toFixed(3)}`);
  assert.ok(stepLength(5) > stepLength(2) && stepLength(2) > stepLength(0.5));
});

test('animation: finite pose in every mode; footfalls match the distance walked', () => {
  const a = createAnimator(0.3);
  const pose = createPose();
  const dt = 1 / 60;
  let dist = 0;
  const speed = 2;
  for (let i = 0; i < 600; i++) {
    animate(a, pose, { dt, speed, onGround: true }, () => 0);
    dist += speed * dt;
  }
  const expected = dist / stepLength(speed);
  assert.ok(Math.abs(a.steps - expected) <= 2, `steps ${a.steps} vs ${expected.toFixed(1)}`);
  const modes = [
    { speed: 0 }, { speed: 5.3 }, { speed: 1, slopeDeg: 50, scrambling: true }, { speed: 3, sliding: true },
    { speed: 0, onGround: false, vy: 3 }, { speed: 0.6, depth: 0.45 }, { mode: 'ride', boatRoll: 0.1 },
    { mode: 'startled' }, { mode: 'wary', lookYaw: 0.8, lookPitch: -0.3 }, { speed: 2, landed: true, landSpeed: 6 },
  ];
  for (const m of modes) {
    for (let i = 0; i < 30; i++) animate(a, pose, { dt, onGround: true, ...m }, (lat, fwd) => fwd * 0.3);
    for (const n of BONE_NAMES) for (const k of ['x', 'y', 'z']) assert.ok(Number.isFinite(pose.rot[n][k]), `${JSON.stringify(m)} ${n}.${k}`);
    assert.ok(pose.hips.y > 0.5 && pose.hips.y < 1.1, `hips ${pose.hips.y}`);
  }
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
  const modes = [];
  ctx.events.on('player:mode', (e) => modes.push(e.control));
  const steps = [];
  ctx.events.on('player:step', (e) => steps.push(e));
  const { create } = await import('../src/entities/player.js');
  for (const { name } of SYSTEMS) {
    if (name === 'terrain') continue; // falls back to the heightmap
    ctx.systems[name] = name === 'player' ? await create(ctx) : STUBS[name](ctx);
  }
  const frame = (n = 1, dt = 1 / 30) => {
    for (let i = 0; i < n; i++) {
      offers.length = 0;
      for (const { name } of SYSTEMS) ctx.systems[name]?.update?.(dt);
      for (const { name } of SYSTEMS) ctx.systems[name]?.lateUpdate?.(dt);
    }
  };
  return { ctx, offers, radio, modes, steps, frame, player: ctx.systems.player };
}

test('player system: contract, go ashore by skiff, walk, back aboard; teleport and bears', async () => {
  const { ctx, offers, radio, modes, steps, frame, player } = await buildWorld();
  assert.deepEqual(missingMembers('player', player), []);
  assert.equal(player.active, false);
  // Anchor the seiner ~60 m off Fort Abercrombie's beach.
  const R = resolve(ctx.geo);
  const fort = R.places.find((p) => p.id === 'fort-abercrombie');
  const w = ctx.heightmap.nearestWater(fort.landing.x, fort.landing.z, { minShore: 60 });
  ctx.systems.seiner.setPose(w.x, w.z, 0);
  frame(2);
  const chk = player.canGoAshore();
  assert.ok(chk.ok, chk.reason);
  assert.ok(offers.some((o) => o.id === 'go-ashore' && o.priority === 40 && o.key === 'interact'));
  // Not while moving or mid-set.
  ctx.systems.seiner.speed = 3;
  assert.equal(player.canGoAshore().ok, false);
  ctx.systems.seiner.speed = 0;
  ctx.systems.fishing.state = 'setting';
  assert.equal(player.canGoAshore().ok, false);
  ctx.systems.fishing.state = 'idle';
  // Out in the strait: no beach.
  const mid = ctx.geo.toWorld(57.9, -154.4);
  ctx.systems.seiner.setPose(mid.x, mid.z, 0);
  frame(1);
  assert.equal(player.canGoAshore().ok, false);
  ctx.systems.seiner.setPose(w.x, w.z, 0);
  frame(1);

  assert.equal(player.cameraFraming, null, 'no framing aboard');
  assert.ok(player.goAshore());
  assert.equal(player.cameraFraming?.kind, 'ferry', 'wide framing for the skiff run');
  assert.equal(ctx.state.mode, 'cutscene');
  assert.equal(ctx.state.control, 'foot');
  assert.deepEqual(modes, ['foot']);
  assert.ok(ctx.systems.seiner.anchored, 'seiner anchored');
  assert.equal(ctx.systems.seiner.controlsEnabled, false, 'controls locked');
  assert.ok(player.object3d.visible);
  assert.equal(ctx.game.avatar().object3d, player.object3d);
  let t = 0;
  while (player.phase !== 'foot' && t < 60) {
    frame(1);
    t += 1 / 30;
  }
  assert.equal(player.phase, 'foot', `reached the beach (phase ${player.phase})`);
  assert.equal(ctx.state.mode, 'play');
  const y = player.position.y;
  const g = ctx.heightmap.heightAt(player.position.x, player.position.z);
  assert.ok(Math.abs(y - g) < 1e-6 && g > -FOOT_RULES.kneeDepth, 'standing on the beach or in the shallows');
  frame(2);
  assert.ok(offers.some((o) => o.id === 'board-skiff'), 'offers "Back to the boat" beside the skiff');

  // Walk inland a little (input stubbed: drive the controller through the camera-relative command path).
  ctx.input.axis = (n) => (n === 'throttle' ? 1 : 0);
  ctx.camera.position.set(player.position.x - 10 * Math.sin(player.heading), 5, player.position.z + 10 * Math.cos(player.heading));
  ctx.camera.lookAt(player.position);
  ctx.camera.updateMatrixWorld();
  const p0 = player.position.clone();
  frame(60);
  ctx.input.axis = () => 0;
  assert.ok(player.position.distanceTo(p0) > 3, 'walked');
  assert.ok(steps.length > 3 && steps.every((s) => typeof s.surface === 'string'), 'footsteps');

  // Bear bluff charge: fade, back at the skiff, radio quip, still ashore.
  const hints = [];
  ctx.events.on('ui:hint', (h) => hints.push(h));
  ctx.events.emit('bear:encounter', { stage: 'watch', bearId: 'b1', x: player.position.x + 20, z: player.position.z });
  assert.ok(hints.some((h) => h.id === 'bear-watch' && /back away slowly/i.test(h.text)), 'back-away hint');
  ctx.events.emit('bear:encounter', { stage: 'charge', bearId: 'b1', x: player.position.x + 10, z: player.position.z });
  assert.equal(ctx.state.mode, 'cutscene');
  frame(120);
  assert.equal(ctx.state.mode, 'play');
  assert.equal(player.phase, 'foot');
  assert.ok(radio.some((r) => r.from === 'Skiffman'), 'radio quip');
  assert.ok(player.position.distanceTo(ctx.systems.skiff.position) < 22, 'back by the skiff');
  assert.ok(ctx.heightmap.heightAt(player.position.x, player.position.z) > -FOOT_RULES.kneeDepth, 'on the beach, not out of depth');

  // Back to the boat.
  frame(1);
  assert.ok(player.returnToBoat());
  t = 0;
  while (player.active && t < 90) {
    frame(1);
    t += 1 / 30;
  }
  assert.equal(player.active, false, `aboard (phase ${player.phase})`);
  assert.equal(ctx.state.control, 'boat');
  assert.equal(ctx.state.mode, 'play');
  assert.equal(ctx.systems.skiff.state, 'stowed');
  assert.ok(ctx.systems.seiner.controlsEnabled, 'controls unlocked');
  assert.deepEqual(modes, ['foot', 'boat']);

  // Teleport while ashore: instantly aboard.
  frame(1);
  assert.ok(player.debugAshore());
  assert.equal(ctx.state.control, 'foot');
  ctx.systems.seiner.setPose(mid.x, mid.z, 0);
  ctx.events.emit('boat:teleport', { x: mid.x, z: mid.z, heading: 0, reason: 'debug' });
  assert.equal(player.active, false);
  assert.equal(ctx.state.control, 'boat');
  assert.equal(ctx.systems.skiff.state, 'stowed');
  assert.ok(ctx.systems.seiner.controlsEnabled);
  player.reset();
  assert.equal(player.serialize(), undefined);
});
