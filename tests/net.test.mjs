// WP-NET: corkline simulation, polygon/gap maths, bottom contact and snags, and the net model's command flow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCorkline, nodeCountFor, bottomContactOf, snagChancePerSecond } from '../src/entities/net/sim.js';
import { pointInPolygon, polygonArea, polylineDistance, segmentDistance, maxCircleArea } from '../src/entities/net/geom.js';
import { createWinch } from '../src/game/fishing/winch.js';
import { makeGame, OPEN } from './net-harness.test.mjs';

const still = { currentAt: (x, z, o) => ((o.x = 0), (o.z = 0), o), drift: 0.7, relax: 0.8, iterations: 10 };

// Lays a corkline by moving the "stern" along a circle of radius r around (cx, cz), counter-clockwise from angle 0.
function layCircle(sim, { cx = 0, cz = 0, r = 60, frac = 1, step = 0.25 } = {}) {
  sim.begin(cx + r, cz);
  const total = frac * Math.PI * 2;
  for (let a = 0; a <= total; a += step / r) sim.pay(cx + Math.cos(a) * r, cz - Math.sin(a) * r);
}

test('node count stays within 150-200 for every legal seine length', () => {
  for (const L of [100, 250, 380, 420, 457]) {
    const n = nodeCountFor(L);
    assert.ok(n >= 150 && n <= 200, `${L} m → ${n} nodes`);
  }
  const sim = createCorkline(380);
  assert.ok(Math.abs(sim.seg * (sim.n - 1) - 380) < 1e-9);
});

test('payout follows the stern path and lays nodes one segment apart', () => {
  const sim = createCorkline(380);
  sim.begin(0, 0);
  for (let x = 0; x <= 100; x += 0.5) sim.pay(x, 0);
  assert.ok(Math.abs(sim.payout - 100) < 0.01, `payout ${sim.payout}`);
  for (let i = 0; i < sim.count - 1; i++) assert.ok(Math.abs(sim.x[i + 1] - sim.x[i] - sim.seg) < 1e-9);
  // Backing up toward the net pays nothing out.
  const before = sim.count;
  for (let x = 100; x >= 80; x -= 0.5) sim.pay(x, 0, 1, 0);
  assert.equal(sim.count, before);
  // Keep going: the net is full at its length and stops laying.
  for (let x = 100; x <= 600; x += 0.5) sim.pay(x, 0, 1, 0);
  assert.ok(sim.full);
  assert.equal(sim.count, sim.n);
  assert.ok(Math.abs(sim.payout - 380) < 1e-6);
});

test('a round haul encloses about the circle area; polygon, gap and containsPoint agree', () => {
  const sim = createCorkline(380);
  const r = 380 / (2 * Math.PI) - 1;
  layCircle(sim, { r, frac: 0.97 });
  const poly = [];
  for (let i = 0; i < sim.count; i++) poly.push({ x: sim.x[i], z: sim.z[i] });
  const area = polygonArea(poly);
  assert.ok(area > 0.9 * Math.PI * r * r && area <= maxCircleArea(380), `area ${area}`);
  assert.ok(Math.abs(Math.abs(sim.signedArea()) - area) / area < 0.05);
  assert.ok(pointInPolygon(0, 0, poly));
  assert.ok(!pointInPolygon(r * 2, 0, poly));
  const gap = Math.hypot(sim.x[0] - sim.x[sim.count - 1], sim.z[0] - sim.z[sim.count - 1]);
  assert.ok(gap < 15, `gap ${gap}`);
});

test('geometry helpers', () => {
  const sq = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }];
  assert.equal(polygonArea(sq), 100);
  assert.ok(pointInPolygon(5, 5, sq));
  assert.ok(!pointInPolygon(15, 5, sq));
  assert.ok(!pointInPolygon(5, 5, null));
  const s = segmentDistance(5, 3, 0, 0, 10, 0);
  assert.equal(s.d, 3);
  assert.equal(s.t, 0.5);
  assert.equal(segmentDistance(-4, 3, 0, 0, 10, 0).d, 5);
  const xs = [0, 10, 10];
  const zs = [0, 0, 10];
  assert.equal(polylineDistance(12, 5, xs, zs, 0, 2), 2);
  assert.equal(polylineDistance(12, 5, xs, zs, 0, 1), Math.hypot(2, 5));
});

test('corks drift with a fraction of the current; segments never stretch when free', () => {
  const sim = createCorkline(380);
  sim.begin(0, 0);
  for (let x = 0; x <= 60; x += 0.5) sim.pay(x, 0);
  const env = { ...still, currentAt: (x, z, o) => ((o.x = 0), (o.z = 0.4), o), heightAt: () => 0.3 };
  for (let i = 0; i < 300; i++) sim.step(1 / 30, env);
  const v = sim.vz[5];
  assert.ok(Math.abs(v - 0.28) < 0.02, `drift speed ${v}`);
  assert.ok(sim.z[5] > 2, `moved downstream ${sim.z[5]}`);
  assert.ok(Math.abs(sim.y[5] - 0.3) < 1e-6, 'floats on the water surface');
  for (let i = 0; i < sim.count - 1; i++) {
    assert.ok(Math.hypot(sim.x[i + 1] - sim.x[i], sim.z[i + 1] - sim.z[i]) <= sim.seg + 1e-6);
  }
});

test('pinned ends hold the net against the current; towing apart strains the chain', () => {
  const sim = createCorkline(380);
  sim.begin(0, 0);
  for (let x = 0; x <= 380; x += 0.5) sim.pay(x, 0);
  const env = { ...still, currentAt: (x, z, o) => ((o.x = 0), (o.z = 1), o), pinA: { x: 0, z: 0 }, pinB: { x: 300, z: 0 } };
  for (let i = 0; i < 30 * 90; i++) sim.step(1 / 30, env);
  assert.equal(sim.x[0], 0);
  assert.equal(sim.x[sim.count - 1], 300);
  const mid = Math.floor(sim.count / 2);
  assert.ok(sim.z[mid] > 40, `bellies downstream: ${sim.z[mid]}`);
  assert.ok(sim.strain < 1.02);
  env.pinB = { x: 420, z: 0 };
  for (let i = 0; i < 90; i++) sim.step(1 / 30, env);
  assert.ok(sim.strain > 1.02, `strain ${sim.strain}`);
});

test('hauling takes the corkline aboard from the seiner end', () => {
  const sim = createCorkline(380);
  layCircle(sim, { r: 58, frac: 1 });
  const n0 = sim.count;
  const w0 = sim.inWater;
  const taken = sim.haul(100);
  assert.ok(Math.abs(taken - 100) < 1e-6);
  assert.ok(Math.abs(sim.inWater - (w0 - 100)) < 1e-6);
  assert.ok(sim.count < n0);
  sim.haul(10000, 3);
  assert.equal(sim.count, 3, 'keeps the bag');
});

test('a closed loop inflates back toward a round bag', () => {
  const sim = createCorkline(380);
  sim.begin(0, 0);
  // A flattened loop: out along z = 0, back along z = 4.
  for (let x = 0; x <= 60; x += 0.5) sim.pay(x, 0);
  for (let x = 60; x >= 0; x -= 0.5) sim.pay(x, 4);
  sim.holdEnd();
  const a0 = Math.abs(sim.signedArea());
  const env = { ...still, pinA: { x: sim.x[0], z: sim.z[0] }, pinB: { x: sim.x[sim.count - 1], z: sim.z[sim.count - 1] }, inflate: 1 };
  for (let i = 0; i < 300; i++) sim.step(1 / 30, env);
  const a1 = Math.abs(sim.signedArea());
  assert.ok(a1 > a0 * 2, `area ${a0.toFixed(0)} → ${a1.toFixed(0)}`);
});

test('bottom contact: fraction of the leadline on the seabed and how much of it is rock', () => {
  const sim = createCorkline(380);
  sim.begin(0, 0);
  for (let x = 0; x <= 380; x += 0.5) sim.pay(x, 0);
  // Seabed shoals from 30 m to 0 along x; rock beyond x = 300.
  const env = { ...still, depthAt: (x) => 30 - (x / 380) * 30, isRock: (x) => x > 300 };
  sim.step(1 / 30, env);
  const bc = bottomContactOf(sim, 16);
  // Web of 16 m touches where depth <= 16 → x >= 177 → ~53% of the net.
  assert.ok(Math.abs(bc.contact - 0.534) < 0.03, `contact ${bc.contact}`);
  assert.ok(Math.abs(bc.rockFraction - 80 / 203) < 0.05, `rock ${bc.rockFraction}`);
  assert.equal(bottomContactOf(sim, 40).contact, 1);
  assert.equal(bottomContactOf(sim, 0).contact < 0.01, true);
  assert.equal(snagChancePerSecond(0.5, 0.4, 1), 0.02 * 0.5 * 0.4);
  assert.equal(snagChancePerSecond(1, 1, 0), 0);
});

test('net model: begin → out → close → purse → haul → brail → stow', async () => {
  const g = await makeGame();
  const { net, seiner } = g;
  seiner.setPose(OPEN.x, OPEN.z, Math.PI / 2);
  g.run(0.1);
  g.ctx.systems.skiff.release();
  assert.equal(net.begin(g.ctx.systems.skiff), true);
  assert.equal(net.state, 'paying');
  assert.ok(net.gap(), 'open net has a gap');
  g.circle({ cx: OPEN.x, cz: OPEN.z - 62, r: 62, turns: 1.02 });
  assert.equal(net.state, 'out');
  assert.ok(Math.abs(net.payout - net.length) < 1e-6);
  assert.ok(net.corkline.length === net.model.sim.count && net.corkline[3].isVector3);
  const poly = net.polygon();
  assert.ok(poly.length > 100);
  assert.ok(net.containsPoint(OPEN.x, OPEN.z - 62), 'circle centre is inside');
  assert.ok(!net.containsPoint(OPEN.x + 200, OPEN.z), 'far point is outside');
  net.close();
  assert.equal(net.state, 'closed');
  assert.equal(net.gap(), null);
  g.run(2);
  let t = 0;
  while (net.pursed < 1 && t < 60) {
    net.purse(1 / 15);
    g.frame();
    t += g.dt;
  }
  assert.equal(net.state, 'pursing');
  assert.equal(net.pursed, 1);
  assert.ok(t > 14 && t < 20, `pursed in ${t.toFixed(1)} s`);
  for (let i = 0; i < 1500 && net.hauled < 0.9; i++) {
    net.haul(0.9 / 30);
    g.frame();
  }
  assert.equal(net.state, 'hauling');
  assert.ok(net.hauled >= 0.9);
  assert.ok(net.model.area > 30 && net.model.area < 600, `bag area ${net.model.area}`);
  net.brail();
  assert.equal(net.state, 'brailing');
  net.stow();
  assert.equal(net.state, 'stowed');
  assert.equal(net.polygon(), null);
  assert.equal(net.payout, 0);
});

test('net model: smooth bottom slows pursing; rocky bottom snags and opens a hole', async () => {
  const g = await makeGame();
  const { net, seiner } = g;
  seiner.setPose(OPEN.x, OPEN.z, Math.PI / 2);
  g.run(0.1);
  g.ctx.systems.skiff.release();
  net.begin(g.ctx.systems.skiff);
  g.circle({ cx: OPEN.x, cz: OPEN.z - 62, r: 62, turns: 1.02 });
  net.close();
  // Force a shallow sandy then rocky seabed under the net.
  const hm = g.ctx.heightmap;
  const depthAt = hm.depthAt;
  const seabedAt = hm.seabedAt;
  hm.depthAt = () => 5;
  hm.seabedAt = () => 'sand';
  net.model.sim.invalidateSeabed();
  g.frame();
  assert.ok(net.bottomContact > 0.95);
  net.purse(0.1);
  g.frame();
  assert.ok(net.purseRate < 0.1 * 0.85 && net.purseRate > 0.1 * 0.75, `smooth-bottom rate ${net.purseRate}`);
  hm.seabedAt = () => 'rock';
  net.model.sim.invalidateSeabed();
  let snagged = false;
  for (let i = 0; i < 30 * 120 && !snagged; i++) {
    net.purse(1 / 15);
    g.frame();
    snagged = net.snagCount > 0;
  }
  assert.ok(snagged, 'snags on rock within two minutes of pursing');
  assert.ok(net.snagged && net.hole);
  const p0 = net.pursed;
  net.purse(1 / 15);
  g.run(1);
  assert.equal(net.pursed, p0, 'pursing stalls while hung up');
  hm.depthAt = depthAt;
  hm.seabedAt = seabedAt;
});

test('purse winch: a steady hold fouls the rings late in the purse; feathering stays in the band', () => {
  const w = createWinch();
  let fouled = false;
  for (let i = 0; i < 30 * 5; i++) fouled = w.step(1 / 30, { held: true, pursed: 0.8 }).fouled || fouled;
  assert.ok(fouled, 'full speed on a heavy bag fouls');
  const w2 = createWinch();
  let inBand = 0;
  let n = 0;
  for (let i = 0; i < 30 * 20; i++) {
    const [lo, hi] = w2.band;
    const held = w2.tension < lo + (hi - lo) * 0.5;
    const r = w2.step(1 / 30, { held, pursed: i / 600 });
    assert.equal(r.fouled, false);
    if (i > 60) {
      n++;
      if (w2.inBand()) inBand++;
    }
  }
  assert.ok(inBand / n > 0.8, `in band ${(inBand / n).toFixed(2)}`);
  const w3 = createWinch();
  const r0 = w3.step(1 / 30, { held: false, pursed: 0 });
  assert.equal(r0.efficiency, 0, 'no pursing without the winch');
});

test('strided water sampling tracks a moving swell within a few centimetres', () => {
  const full = createCorkline(380);
  const strided = createCorkline(380);
  for (const sim of [full, strided]) {
    sim.begin(0, 0);
    for (let x = 0; x <= 380; x += 0.5) sim.pay(x, 0);
  }
  let t = 0;
  let calls = 0;
  const swell = (x) => 0.6 * Math.sin(x * 0.12 - t * 1.1) + 0.2 * Math.sin(x * 0.45 - t * 2.3);
  const envFull = { ...still, heightAt: (x) => swell(x) };
  const envStrided = { ...still, heightAt: (x) => (calls++, swell(x)), heightStride: 8 };
  let worst = 0;
  for (let i = 0; i < 240; i++) {
    t += 1 / 60;
    full.step(1 / 60, envFull);
    calls = 0;
    strided.step(1 / 60, envStrided);
    if (i > 5) assert.ok(calls <= Math.ceil(strided.count / 8) + 2, `calls ${calls}`);
    if (i > 30) for (let k = 0; k < strided.count; k++) worst = Math.max(worst, Math.abs(strided.y[k] - full.y[k]));
  }
  assert.ok(worst < 0.08, `worst error ${worst.toFixed(3)} m`);
});

test('environment sampling is cached: seabed per metre moved, surface current a few times a second', () => {
  const sim = createCorkline(380);
  sim.begin(0, 0);
  for (let x = 0; x <= 60; x += 0.5) sim.pay(x, 0);
  let depthCalls = 0;
  let currentCalls = 0;
  const env = {
    ...still,
    depthAt: () => (depthCalls++, 20),
    currentAt: (x, z, o) => (currentCalls++, (o.x = 0), (o.z = 0), o),
  };
  sim.step(1 / 60, env);
  assert.equal(depthCalls, sim.count, 'first step samples every node');
  depthCalls = 0;
  currentCalls = 0;
  for (let i = 0; i < 6; i++) sim.step(1 / 60, env);
  assert.equal(depthCalls, 0, 'nodes that have not moved keep their sample');
  assert.equal(currentCalls, 0, 'current refreshed at most every 0.2 s');
  for (let i = 0; i < 12; i++) sim.step(1 / 60, env);
  assert.ok(currentCalls > 0 && currentCalls <= Math.ceil(sim.count / 4) + 1, `current calls ${currentCalls}`);
  // Shift the whole net by more than a metre: every node re-samples.
  depthCalls = 0;
  for (let i = 0; i < sim.count; i++) sim.x[i] += 1.5;
  sim.step(1 / 60, env);
  assert.equal(depthCalls, sim.count);
  sim.invalidateSeabed();
  depthCalls = 0;
  sim.step(1 / 60, env);
  assert.equal(depthCalls, sim.count);
});

test('close-up: a skiff end delivered on the far side is brought around the transom to the net side', async () => {
  const g = await makeGame();
  const { net, seiner } = g;
  seiner.setPose(OPEN.x, OPEN.z, Math.PI / 2);
  g.run(0.1);
  const end = { x: OPEN.x, z: OPEN.z + 12 };
  net.begin(end);
  // Counter-clockwise on the chart: turning to port, so the net body lies to port.
  g.circle({ cx: OPEN.x, cz: OPEN.z - 62, r: 62, turns: 0.97 });
  const h = seiner.heading;
  const right = { x: Math.cos(h), z: Math.sin(h) };
  const fwd = { x: Math.sin(h), z: -Math.cos(h) };
  const local = (x, z) => {
    const dx = x - seiner.position.x;
    const dz = z - seiner.position.z;
    return { r: dx * right.x + dz * right.z, f: dx * fwd.x + dz * fwd.z };
  };
  // The skiff hands its end over on the starboard quarter, away from the net.
  end.x = seiner.position.x + right.x * 6 - fwd.x * 5;
  end.z = seiner.position.z + right.z * 6 - fwd.z * 5;
  g.run(0.5);
  assert.ok(local(net.model.sim.x[0], net.model.sim.z[0]).r > 3, 'end starts to starboard');
  net.close();
  assert.equal(net.side, -1, 'working side is the net side (port)');
  assert.equal(net.bodySide, -1);
  for (let i = 0; i < 120; i++) {
    g.frame();
    const p = local(net.model.sim.x[0], net.model.sim.z[0]);
    assert.ok(!(Math.abs(p.r) < 3.2 && Math.abs(p.f) < 9), `skiff end inside the hull at frame ${i}: r ${p.r.toFixed(1)} f ${p.f.toFixed(1)}`);
  }
  const p = local(net.model.sim.x[0], net.model.sim.z[0]);
  assert.ok(p.r < -3.5 && p.r > -6.5, `made fast on the port side: r ${p.r.toFixed(2)}`);
  // The corkline next to the end came around too: no loop left trailing on the starboard side.
  for (let i = 1; i <= 8; i++) {
    const q = local(net.model.sim.x[i], net.model.sim.z[i]);
    assert.ok(q.r < 0, `node ${i} on the port side: r ${q.r.toFixed(2)}`);
  }
});
