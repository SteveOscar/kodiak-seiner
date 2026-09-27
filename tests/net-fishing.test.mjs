// WP-NET: the fishing state machine with fake/stub neighbours, the catch flow and the fishing:setComplete payload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STUBS } from '../src/systems/stubs.js';
import { makeGame, OPEN } from './net-harness.test.mjs';
import { buildSetReport, rateSet, roundEstimate, sanitizeCatch, splitKings } from '../src/game/fishing/report.js';
import { config } from '../src/core/config.js';
import { FISHING_TUNING } from '../src/entities/net/tuning.js';

const CENTRE = { x: OPEN.x, z: OPEN.z - 60 };

// Stub fish whose harvest returns a fixed catch (and counts calls); stub economy that counts addCatch calls.
function spies(catchOf = { pink: 4000, chum: 120, sockeye: 0, coho: 0, king: 2 }) {
  const calls = { harvest: 0, addCatch: 0, addCash: [] };
  const overrides = {
    fish(ctx) {
      const f = STUBS.fish(ctx);
      f.schools[0].position.set(CENTRE.x, -2, CENTRE.z);
      f.harvest = () => {
        calls.harvest++;
        return { ...catchOf };
      };
      return f;
    },
    economy(ctx) {
      const e = STUBS.economy(ctx);
      const add = e.addCatch;
      e.addCatch = (c) => {
        calls.addCatch++;
        return add(c);
      };
      const cash = e.addCash;
      e.addCash = (d, r) => {
        calls.addCash.push([d, r]);
        return cash(d, r);
      };
      return e;
    },
  };
  return { calls, overrides };
}

// Drives one full round-haul set with scripted input. Returns the phase durations.
async function roundHaul(g) {
  const F = g.fishing;
  g.seiner.setPose(OPEN.x, OPEN.z, Math.PI / 2);
  g.run(0.2);
  const t = {};
  assert.equal(g.offer('action')?.label, "Let 'er go!");
  g.press('action');
  assert.equal(F.state, 'setting');
  let t0 = g.ctx.time.elapsed;
  g.circle({ cx: CENTRE.x, cz: CENTRE.z, r: 60, turns: 1.2, stopWhen: () => F.hud.closeReady });
  t.layout = g.ctx.time.elapsed - t0;
  assert.ok(F.hud.closeReady, 'came back to the skiff');
  assert.equal(g.offer('action')?.id, 'fishing-close');
  g.press('action');
  assert.equal(F.state, 'closing');
  t0 = g.ctx.time.elapsed;
  t.close = g.until(() => F.state === 'pursing', 40);
  // Feather E on the winch.
  t.purse = g.until(() => F.state !== 'pursing', 60, () => {
    const [lo, hi] = F.hud.tensionBand;
    if (F.hud.tension > lo + (hi - lo) * 0.7) g.held.delete('interact');
    else if (F.hud.tension < lo + (hi - lo) * 0.35) g.held.add('interact');
  });
  g.held.delete('interact');
  assert.equal(F.state, 'hauling');
  t.haul = g.until(() => F.state !== 'hauling', 60);
  assert.equal(F.state, 'brailing');
  t.brail = g.until(() => F.state !== 'brailing', 30);
  assert.equal(F.state, 'report');
  t.report = g.until(() => F.state === 'idle', 30);
  return t;
}

test('canSet explains why a set is not possible', async () => {
  const g = await makeGame({ freeExplore: false });
  const F = g.fishing;
  g.seiner.setPose(OPEN.x, OPEN.z, Math.PI / 2);
  g.ctx.clock.set(3, 1); // day 1 is not a fishing day
  g.run(0.1);
  let r = F.canSet();
  assert.equal(r.ok, false);
  assert.match(r.reason, /closed/i);
  assert.equal(g.offer('action'), null, 'no Let \'er go offer when closed');
  g.ctx.clock.set(10, 0);
  assert.equal(F.canSet().ok, true);
  // Shallow water off the spawn harbour.
  g.seiner.setPose(5170, -1115, 0);
  g.run(0.1);
  r = F.canSet();
  assert.equal(r.ok, false);
  assert.match(r.reason, /shallow/i);
  g.seiner.setPose(OPEN.x, OPEN.z, Math.PI / 2);
  g.ctx.systems.skiff.state = 'holding';
  assert.match(F.canSet().reason, /skiff/i);
  g.ctx.systems.skiff.state = 'stowed';
  g.ctx.state.control = 'foot';
  g.run(0.1);
  assert.equal(F.canSet().ok, false);
  assert.equal(g.offer('action'), null, 'no fishing offers on foot');
});

test('a round haul runs every phase in order, harvests once and reports once', async () => {
  const { calls, overrides } = spies();
  const g = await makeGame({ overrides });
  const t = await roundHaul(g);
  const states = g.named('fishing:state').map((e) => e.state);
  assert.deepEqual(states, ['setting', 'closing', 'pursing', 'hauling', 'brailing', 'report', 'idle']);
  assert.equal(g.named('fishing:skiffReleased').length, 1);
  assert.equal(g.named('fishing:closedUp').length, 1);
  assert.ok(Array.isArray(g.named('fishing:closedUp')[0].polygon));
  assert.equal(calls.harvest, 1);
  assert.equal(calls.addCatch, 1);
  const done = g.named('fishing:setComplete');
  assert.equal(done.length, 1);
  // Phase targets (real seconds): lay-out 45-60, close-up 8-12, purse 15-25, haul 25-35, brail <= 15.
  assert.ok(t.layout >= 45 && t.layout <= 60, `layout ${t.layout.toFixed(1)}`);
  assert.ok(t.close >= 8 && t.close <= 12, `close ${t.close.toFixed(1)}`);
  assert.ok(t.purse >= 15 && t.purse <= 25, `purse ${t.purse.toFixed(1)}`);
  assert.ok(t.haul >= 25 && t.haul <= 35, `haul ${t.haul.toFixed(1)}`);
  assert.ok(t.brail <= 15, `brail ${t.brail.toFixed(1)}`);
  assert.equal(g.net.state, 'stowed');
  assert.equal(g.ctx.systems.skiff.state, 'stowed');
  assert.equal(g.seiner.controlsEnabled, true, 'controls unlocked after the set');
  assert.equal(g.seiner.speedLimit, null, 'speed limit released');
  assert.equal(g.fishing.setNumber, 1);
  assert.equal(g.fishing.lastSet, done[0]);
});

test('fishing:setComplete payload shape: kings released, lbs, value and rating', async () => {
  const { overrides } = spies({ pink: 4000, chum: 120, sockeye: 0, coho: 0, king: 2 });
  const g = await makeGame({ overrides });
  await roundHaul(g);
  const p = g.named('fishing:setComplete')[0];
  for (const k of ['setNumber', 'caught', 'accepted', 'released', 'lbs', 'totalLbs', 'value', 'minutes', 'waterHaul', 'rating', 'cited']) {
    assert.ok(k in p, `payload has ${k}`);
  }
  const species = ['pink', 'chum', 'sockeye', 'coho', 'king'];
  for (const c of [p.caught, p.accepted, p.released]) assert.deepEqual(Object.keys(c).sort(), [...species].sort());
  assert.deepEqual(p.caught, { pink: 4000, chum: 120, sockeye: 0, coho: 0, king: 2 });
  assert.deepEqual(p.accepted, { pink: 4000, chum: 120, sockeye: 0, coho: 0, king: 0 });
  assert.equal(p.released.king, 2);
  assert.equal(p.lbs.pink, 4000 * 3.6);
  assert.equal(p.totalLbs, Math.round(4000 * 3.6 + 120 * 8.5));
  assert.ok(Math.abs(p.value - (4000 * 3.6 * 0.32 + 120 * 8.5 * 0.55)) < 0.01);
  assert.equal(p.waterHaul, false);
  assert.equal(p.rating, 'good');
  assert.equal(p.cited, false);
  assert.equal(p.setNumber, 1);
  assert.ok(Number.isInteger(p.minutes) && p.minutes > 60, `minutes ${p.minutes}`);
  assert.deepEqual(g.ctx.systems.economy.hold, { pink: 4000, chum: 120, sockeye: 0, coho: 0, king: 0 });
});

test('a plugged set overflows the hold: released includes the overflow', async () => {
  const { overrides } = spies({ pink: 20000, chum: 0, sockeye: 0, coho: 0, king: 0 });
  const g = await makeGame({ overrides });
  g.ctx.systems.economy.hold.pink = 15000; // 54,000 lb already aboard
  await roundHaul(g);
  const p = g.named('fishing:setComplete')[0];
  assert.equal(p.rating, 'plugged');
  assert.equal(p.accepted.pink + p.released.pink, 20000);
  assert.ok(p.released.pink > 0);
  assert.ok(g.named('ui:toast').some((t) => /Plugged/.test(t.text)));
});

test('missing the school is a water haul', async () => {
  const { overrides } = spies({ pink: 0, chum: 0, sockeye: 0, coho: 0, king: 0 });
  const g = await makeGame({ overrides });
  await roundHaul(g);
  const p = g.named('fishing:setComplete')[0];
  assert.equal(p.waterHaul, true);
  assert.equal(p.rating, 'water haul');
  assert.equal(p.totalLbs, 0);
});

test('setting in closed waters warns first, then may be cited: fine and catch forfeited', async () => {
  const { calls, overrides } = spies();
  overrides.season = (ctx) => {
    const s = STUBS.season(ctx);
    s.isClosedWater = () => true;
    return s;
  };
  const g = await makeGame({ freeExplore: false, overrides });
  g.ctx.clock.set(10, 0);
  const chance = FISHING_TUNING.citation.chance;
  FISHING_TUNING.citation.chance = 1; // the trooper is watching
  const F = g.fishing;
  g.seiner.setPose(OPEN.x, OPEN.z, Math.PI / 2);
  g.run(0.2);
  assert.match(g.offer('action').label, /closed waters/);
  g.press('action');
  assert.equal(F.state, 'idle', 'first press only warns');
  assert.match(F.hud.message, /Closed waters/);
  g.press('action');
  assert.equal(F.state, 'setting');
  assert.equal(F.core.set.closedWater, true);
  // Run the rest of the set.
  g.circle({ cx: CENTRE.x, cz: CENTRE.z, r: 60, turns: 1.2, stopWhen: () => F.hud.closeReady });
  g.press('action');
  g.until(() => F.state === 'pursing', 40);
  F.debug.auto.purse = true;
  g.until(() => F.state === 'brailing', 120);
  g.until(() => F.state === 'idle', 60);
  FISHING_TUNING.citation.chance = chance;
  const p = g.named('fishing:setComplete')[0];
  assert.equal(p.cited, true);
  assert.deepEqual(p.accepted, { pink: 0, chum: 0, sockeye: 0, coho: 0, king: 0 });
  assert.equal(p.forfeited.pink, 4000);
  assert.equal(p.fine, FISHING_TUNING.citation.fine);
  assert.equal(calls.addCatch, 0, 'forfeited catch never reaches the hold');
  assert.ok(calls.addCash.some(([d]) => d === -FISHING_TUNING.citation.fine));
  assert.ok(g.named('ui:radio').some((r) => /Troopers/.test(r.text) && r.channel === '16'));
});

test('abort hauls back to a water haul; teleport mid-set ends it instantly', async () => {
  const { calls, overrides } = spies();
  const g = await makeGame({ overrides });
  const F = g.fishing;
  g.seiner.setPose(OPEN.x, OPEN.z, Math.PI / 2);
  g.run(0.2);
  g.press('action');
  g.circle({ cx: CENTRE.x, cz: CENTRE.z, r: 60, turns: 0.4 });
  assert.equal(F.abort(), true);
  assert.equal(F.state, 'hauling');
  assert.equal(g.seiner.controlsEnabled, false);
  g.until(() => F.state === 'idle', 40);
  const p = g.named('fishing:setComplete')[0];
  assert.equal(p.waterHaul, true);
  assert.equal(p.aborted, true);
  assert.equal(calls.harvest, 0, 'no harvest on an aborted set');
  assert.equal(g.net.state, 'stowed');
  assert.equal(g.seiner.controlsEnabled, true);

  // Hold Backspace for a second.
  g.press('action');
  assert.equal(F.state, 'setting');
  g.raw.add('Backspace');
  g.run(0.5);
  assert.equal(F.state, 'setting');
  assert.ok(F.hud.abortProgress > 0.3);
  g.run(0.6);
  g.raw.delete('Backspace');
  g.until(() => F.state === 'idle', 40);
  const reports = g.named('fishing:setComplete');
  assert.equal(reports.length, 2, 'Backspace aborted the second set');
  assert.equal(reports[1].aborted, true);

  g.press('action');
  g.circle({ cx: CENTRE.x, cz: CENTRE.z, r: 60, turns: 0.3 });
  const n = g.named('fishing:setComplete').length;
  g.ctx.events.emit('boat:teleport', { x: 0, z: 0, heading: 0, reason: 'test' });
  assert.equal(F.state, 'idle');
  assert.equal(g.net.state, 'stowed');
  assert.equal(g.ctx.systems.skiff.state, 'stowed');
  assert.equal(g.seiner.speedLimit, null);
  assert.equal(g.named('fishing:setComplete').length, n, 'no report for a teleport');
});

test('hold the hook, tie off to the beach and close from a hook', async () => {
  const g = await makeGame();
  const F = g.fishing;
  const hm = g.ctx.heightmap;
  // Find open water 60-85 m off a beach, deep enough to set, heading along the shore.
  let spot = null;
  for (let a = 0; a < Math.PI * 2 && !spot; a += 0.05) {
    for (let r = 300; r < 1500 && !spot; r += 20) {
      const x = OPEN.x + Math.cos(a) * r;
      const z = OPEN.z + Math.sin(a) * r;
      const sd = hm.shoreDistance(x, z);
      if (sd > 62 && sd < 85 && hm.depthAt(x, z) > 7) spot = { x, z };
    }
  }
  assert.ok(spot, 'found a beach-side spot');
  const grad = hm.shoreGradient(spot.x, spot.z);
  // Heading offshore, the stern (drop point) is on the beach side.
  const heading = Math.atan2(grad.x, -grad.z);
  g.seiner.setPose(spot.x, spot.z, heading);
  g.run(0.2);
  assert.ok(F.canSet().ok, F.canSet().reason);
  assert.equal(g.offer('interact'), null, 'stopped off a beach, E stays free for going ashore');
  g.run(0.2, () => (g.seiner.speed = 2));
  assert.match(g.offer('interact')?.label ?? '', /tie off/i);
  g.press('interact');
  assert.equal(F.state, 'setting');
  assert.equal(F.core.set.tied, true);
  assert.equal(g.ctx.systems.skiff.state, 'tied');
  // Lay out offshore then hook back.
  g.circle({ cx: spot.x + grad.x * 50, cz: spot.z + grad.z * 50, r: 50, turns: 0.75 });
  if (F.state === 'setting') {
    assert.equal(g.offer('action')?.label, 'Hold the hook');
    g.press('action');
  }
  assert.equal(F.state, 'holding');
  assert.equal(F.core.set.hook, true);
  g.run(5);
  assert.ok(F.hud.holdSeconds > 4);
  assert.equal(g.seiner.speedLimit, 1.5);
  assert.equal(g.offer('action')?.label, 'Close up!');
  g.press('action');
  assert.equal(F.state, 'closing');
  g.until(() => F.state === 'pursing', 40);
  assert.equal(F.state, 'pursing');
});

test('offers and limits: priority 100, crow\'s nest suggested, speed limit while setting, locks while pursing', async () => {
  const g = await makeGame();
  const F = g.fishing;
  const offers = [];
  const offer = g.ctx.interact.offer;
  g.ctx.interact.offer = (o) => {
    offers.push(o);
    offer(o);
  };
  let suggested = null;
  g.ctx.systems.cameraRig.suggest = (m) => (suggested = m);
  g.seiner.setPose(OPEN.x, OPEN.z, Math.PI / 2);
  g.run(0.2);
  assert.ok(offers.length > 0 && offers.every((o) => o.priority === 100));
  g.press('action');
  assert.equal(suggested, 'crowsnest');
  assert.equal(g.seiner.speedLimit, 7);
  g.circle({ cx: CENTRE.x, cz: CENTRE.z, r: 60, turns: 1.2, stopWhen: () => F.hud.closeReady });
  g.press('action');
  g.until(() => F.state === 'pursing', 40);
  assert.equal(g.seiner.controlsEnabled, false);
  const h0 = F.hud.towHeading;
  g.setSteer(1);
  g.run(1);
  g.setSteer(0);
  assert.ok(Math.abs(F.hud.towHeading - h0 - 0.7) < 0.05, 'D swings the skiff\'s pull');
  assert.equal(g.offer('interact')?.hold, true);
});

test('Uncle Pete coaches the first set only', async () => {
  const g = await makeGame();
  await roundHaul(g);
  const hints = g.named('ui:hint');
  assert.ok(hints.length >= 5);
  assert.ok(hints.every((h) => h.id.startsWith('pete-') && h.text.length > 10 && h.from === 'Uncle Pete'));
  const ids = hints.map((h) => h.id);
  assert.equal(new Set(ids).size, ids.length, 'each hint once');
  const before = hints.length;
  await roundHaul(g);
  assert.equal(g.named('ui:hint').length, before, 'no hints on the second set');
});

test('serialize / restore / reset of setNumber, lastSet and stats', async () => {
  const { overrides } = spies();
  const g = await makeGame({ overrides });
  await roundHaul(g);
  const F = g.fishing;
  const saved = JSON.parse(JSON.stringify(F.serialize()));
  assert.equal(saved.setNumber, 1);
  assert.equal(saved.stats.sets, 1);
  assert.equal(saved.lastSet.totalLbs, F.lastSet.totalLbs);
  F.reset();
  assert.equal(F.setNumber, 0);
  assert.equal(F.lastSet, null);
  assert.equal(F.stats.sets, 0);
  F.restore(saved);
  assert.equal(F.setNumber, 1);
  assert.equal(F.stats.sets, 1);
  assert.deepEqual(F.lastSet, saved.lastSet);
});

test('report helpers', () => {
  const species = config.fish.species;
  assert.deepEqual(sanitizeCatch({ pink: 3.4, chum: -2, coho: 'x' }), { pink: 3, chum: 0, sockeye: 0, coho: 0, king: 0 });
  const { keep, released } = splitKings({ pink: 10, chum: 0, sockeye: 0, coho: 0, king: 3 }, species);
  assert.equal(keep.king, 0);
  assert.equal(released.king, 3);
  assert.equal(rateSet({ caughtFish: 0, caughtLbs: 0, value: 0, overflowFish: 0, waterHaul: true }), 'water haul');
  assert.equal(rateSet({ caughtFish: 500, caughtLbs: 1800, value: 576, overflowFish: 0, waterHaul: false }), 'fair');
  assert.equal(rateSet({ caughtFish: 4000, caughtLbs: 14400, value: 4600, overflowFish: 0, waterHaul: false }), 'good');
  assert.equal(rateSet({ caughtFish: 9000, caughtLbs: 32400, value: 9000, overflowFish: 0, waterHaul: false }), 'plugged');
  assert.equal(roundEstimate(2437), 2400);
  assert.equal(roundEstimate(87), 87);
  assert.equal(roundEstimate(0), 0);
  const p = buildSetReport({
    setNumber: 3,
    caught: { pink: 100, king: 1 },
    accepted: { pink: 100 },
    overflow: {},
    kingsReleased: { king: 1 },
    speciesTable: species,
    priceFor: (k) => species[k].price,
    minutes: 95.4,
  });
  assert.equal(p.minutes, 95);
  assert.equal(p.released.king, 1);
  assert.equal(p.totalLbs, 360);
  assert.equal(p.rating, 'fair');
});

// Lays a round haul and closes up; leaves the game in 'pursing'.
async function toPursing(g) {
  const F = g.fishing;
  g.seiner.setPose(OPEN.x, OPEN.z, Math.PI / 2);
  g.run(0.2);
  g.press('action');
  g.circle({ cx: CENTRE.x, cz: CENTRE.z, r: 60, turns: 1.2, stopWhen: () => F.hud.closeReady });
  g.press('action');
  g.until(() => F.state === 'pursing', 40);
  assert.equal(F.state, 'pursing');
}

test("stern over the corkline for 3 s puts the net in the wheel and stalls pursing", async () => {
  const g = await makeGame();
  const F = g.fishing;
  await toPursing(g);
  const sim = g.net.model.sim;
  const i = Math.floor(sim.count / 2);
  // Park the stub seiner so its stern (9 m aft of centre) sits on a corkline node mid-net.
  const park = () => {
    const h = g.seiner.heading;
    g.seiner.position.set(sim.x[i] + Math.sin(h) * 9, 0, sim.z[i] - Math.cos(h) * 9);
  };
  g.held.add('interact');
  g.run(2.5, park);
  assert.equal(F.hud.stall, null);
  assert.ok(F.hud.wheelDanger > 0.5);
  g.run(1, park);
  assert.equal(F.hud.stall, 'wheel');
  assert.match(F.hud.message, /wheel/i);
  assert.equal(F.stats.wraps, 1);
  assert.ok(g.named('ui:toast').some((t) => /in the wheel/i.test(t.text)));
  const p0 = g.net.pursed;
  g.run(4);
  assert.equal(g.net.pursed, p0, 'no pursing while clearing the wheel');
  g.run(3);
  assert.notEqual(F.hud.stall, 'wheel');
  g.held.delete('interact');
});

test('a hang-up on rock during pursing emits fishing:snag once and warns', async () => {
  const g = await makeGame();
  const F = g.fishing;
  await toPursing(g);
  const hm = g.ctx.heightmap;
  const { depthAt, seabedAt } = hm;
  hm.depthAt = () => 6;
  hm.seabedAt = () => 'rock';
  g.net.model.sim.invalidateSeabed();
  F.debug.auto.purse = true;
  // The hang-up is random (0.02/s at full contact on rock): keep the purse from finishing until one happens.
  g.until(
    () => g.net.snagCount > 0 || F.state !== 'pursing',
    900,
    () => {
      if (g.net.model.pursed > 0.8) g.net.model.pursed = 0.2;
    },
  );
  g.frame();
  hm.depthAt = depthAt;
  hm.seabedAt = seabedAt;
  assert.ok(g.net.snagCount >= 1, 'snagged');
  const snags = g.named('fishing:snag');
  assert.equal(snags.length, g.net.snagCount);
  assert.ok(Number.isFinite(snags[0].x) && Number.isFinite(snags[0].z));
  assert.equal(F.stats.snags, g.net.snagCount);
  assert.match(F.hud.bottomWarning ?? '', /rocky/i);
});

test('closing waits for a skiff running its end in from afar; times out only once it is close', async () => {
  const g = await makeGame();
  const F = g.fishing;
  const sk = g.ctx.systems.skiff;
  g.seiner.setPose(OPEN.x, OPEN.z, Math.PI / 2);
  g.run(0.2);
  g.press('action');
  g.circle({ cx: CENTRE.x, cz: CENTRE.z, r: 60, turns: 0.7 });
  assert.equal(g.offer('action')?.label, 'Hold the hook');
  g.press('action');
  assert.equal(F.state, 'holding');
  // A skiff that never arrives: its end stays ~100 m away.
  sk.closeTo = () => (sk.state = 'closing');
  g.press('action');
  assert.equal(F.state, 'closing');
  g.run(30);
  assert.equal(F.state, 'closing', 'still waiting after the near-skiff timeout');
  assert.match(F.hud.message, /meet the skiff/i);
  g.until(() => F.state !== 'closing', 60);
  assert.equal(F.state, 'pursing', 'hard timeout closes up eventually');
});
