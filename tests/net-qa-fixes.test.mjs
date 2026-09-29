// WP-NET: regressions for the QA fixes (let-go near fish only on the first set, close-up only alongside a round
// haul's skiff, the E block offer in a running tide, escapes by cause, plugged hold, berths, tender valuation, the
// brailer on water hauls, pay-out pace, scratch objects).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STUBS } from '../src/systems/stubs.js';
import { makeGame, OPEN } from './net-harness.test.mjs';
import { HINTS } from '../src/game/fishing/hints.js';
import { FISHING_TUNING as T } from '../src/entities/net/tuning.js';
import { config } from '../src/core/config.js';

const CENTRE = { x: OPEN.x, z: OPEN.z - 60 };

const fixedCatch = (c) => ({
  fish(ctx) {
    const f = STUBS.fish(ctx);
    f.schools[0].position.set(CENTRE.x, -2, CENTRE.z);
    f.harvest = () => ({ ...c });
    return f;
  },
});

// Runs the seiner straight ahead at `speed` for `seconds` (scripted position, like the harness's circle()).
function straight(g, { heading, speed = 7, seconds, stopWhen = null }) {
  const s = g.seiner;
  s.heading = heading;
  const n = Math.round(seconds / g.dt);
  for (let i = 0; i < n && !stopWhen?.(); i++) {
    s.position.x += Math.sin(heading) * speed * g.dt;
    s.position.z -= Math.cos(heading) * speed * g.dt;
    s.speed = 0;
    g.frame();
  }
}

async function toHauling(g) {
  const F = g.fishing;
  g.seiner.setPose(OPEN.x, OPEN.z, Math.PI / 2);
  g.run(0.2);
  g.press('action');
  g.circle({ cx: CENTRE.x, cz: CENTRE.z, r: 60, turns: 1.2, stopWhen: () => F.hud.closeReady });
  g.press('action');
  g.until(() => F.state === 'pursing', 40);
  F.debug.auto.purse = true;
  g.until(() => F.state === 'hauling', 60);
  F.debug.auto.purse = false;
  assert.equal(F.state, 'hauling');
  g.run(0.1);
}

test('first set of a new season: let-go only near the school; elsewhere the prompt points at the jumpers', async () => {
  const g = await makeGame({ freeExplore: false });
  const F = g.fishing;
  g.ctx.clock.set(10, 0);
  const school = g.ctx.systems.fish.schools[0];
  school.position.set(OPEN.x + 420, -2, OPEN.z); // due east, 420 m
  g.seiner.setPose(OPEN.x, OPEN.z, 0);
  g.run(0.2);
  assert.equal(F.canSet().ok, true);
  const o = g.offer('action');
  assert.equal(o?.id, 'fishing-find-fish');
  assert.match(o.label, /Jumpers 420 m E/);
  assert.equal(F.hud.fishClose, false);
  assert.equal(F.hud.nearestFish.compass, 'E');
  assert.equal(F.hud.nearestFish.bearing, 90);
  g.press('action');
  assert.equal(F.state, 'idle', 'Space far from the fish does not let go');
  assert.ok(g.named('ui:hint').some((h) => h.id === 'pete-findFish'));
  // Close in: the real let-go.
  school.position.set(OPEN.x + 120, -2, OPEN.z);
  g.run(0.1);
  assert.equal(F.hud.fishClose, true);
  assert.equal(g.offer('action')?.id, 'fishing-letgo');
  assert.equal(g.offer('action')?.label, "Let 'er go!");
  g.press('action');
  assert.equal(F.state, 'setting');
});

test('after the first set (or in free explore) let-go stays available but says when no fish are close', async () => {
  const g = await makeGame();
  const F = g.fishing;
  g.ctx.systems.fish.schools[0].position.set(OPEN.x + 900, -2, OPEN.z);
  g.seiner.setPose(OPEN.x, OPEN.z, 0);
  g.run(0.2);
  assert.equal(g.offer('action')?.id, 'fishing-letgo');
  assert.equal(g.offer('action')?.label, "Let 'er go! (no fish close)");
  // No school at all within range.
  g.ctx.systems.fish.schools[0].position.set(OPEN.x + 5000, -2, OPEN.z);
  g.run(0.1);
  assert.equal(F.hud.nearestFish, null);
  assert.equal(g.offer('action')?.label, "Let 'er go! (no fish close)");
});

test('a round haul held short of the skiff: no close-up until alongside; the tow limit is lifted to get there', async () => {
  const g = await makeGame();
  const F = g.fishing;
  g.seiner.setPose(OPEN.x, OPEN.z, Math.PI / 2);
  g.run(0.2);
  g.press('action');
  // Lay the whole seine out in a straight line: full payout → holding with the skiff far astern.
  straight(g, { heading: Math.PI / 2, seconds: 120, stopWhen: () => F.state !== 'setting' });
  assert.equal(F.state, 'holding');
  assert.equal(F.core.set.hook, false);
  assert.ok(F.hud.distanceToSkiff > 200, `gap ${F.hud.distanceToSkiff}`);
  assert.equal(g.offer('action'), null, 'no Close up! with the skiff hundreds of metres away');
  assert.equal(F.hud.closeReady, false);
  assert.match(F.hud.message, /Bring her around to the skiff — \d+ m/);
  assert.equal(g.seiner.speedLimit, T.speed.bringAround);
  assert.ok(g.named('ui:hint').some((h) => h.id === 'pete-bringAround'));
  // The skiff holds station up-current of where its end lay; it does not walk off 18 m every 20 s.
  g.run(0.2, () => (g.seiner.speed = 0));
  const anchor = { ...F.core.set.towAnchor };
  assert.ok(Number.isFinite(anchor.x));
  g.run(65, () => (g.seiner.speed = 0));
  const tt = F.core.set.towTarget;
  assert.ok(Math.hypot(tt.x - anchor.x, tt.z - anchor.z) <= 18.5, 'tow target stays by the anchor');
  // Run back alongside the skiff end.
  const e = g.net.gap().a;
  g.seiner.setPose(e.x + 12, e.z, Math.PI / 2);
  g.run(0.2);
  assert.equal(F.hud.closeReady, true);
  assert.equal(g.offer('action')?.id, 'fishing-close');
  assert.equal(g.seiner.speedLimit, T.speed.holding);
  // Hysteresis: drifting out past closeDistance keeps the offer until the gap passes close.liftGap.
  g.seiner.setPose(e.x + 40, e.z, Math.PI / 2);
  g.run(0.1);
  assert.equal(g.offer('action')?.id, 'fishing-close', 'no flicker just outside closeDistance');
  g.seiner.setPose(e.x + 12, e.z, Math.PI / 2);
  g.run(0.1);
  g.press('action');
  const t = g.until(() => F.state === 'pursing', 40);
  assert.ok(t <= 12, `close ${t.toFixed(1)} s`);
});

test('closing a hook toward a far skiff lifts the 3 m/s limit until the gap is under 60 m', async () => {
  const g = await makeGame();
  const F = g.fishing;
  const sk = g.ctx.systems.skiff;
  g.seiner.setPose(OPEN.x, OPEN.z, Math.PI / 2);
  g.run(0.2);
  g.press('action');
  g.circle({ cx: CENTRE.x, cz: CENTRE.z, r: 60, turns: 0.7 });
  g.press('action'); // Hold the hook
  assert.equal(F.state, 'holding');
  sk.closeTo = () => (sk.state = 'closing');
  g.press('action');
  assert.equal(F.state, 'closing');
  g.run(0.2);
  assert.ok(F.core.set.closeGap > T.close.liftGap);
  assert.equal(g.seiner.speedLimit, T.speed.bringAround);
});

test('hauling in a running tide: the E offer warns, and escapes are tallied by cause in the report', async () => {
  const g = await makeGame({ overrides: fixedCatch({ pink: 20000, chum: 0, sockeye: 0, coho: 0, king: 0 }) });
  const F = g.fishing;
  g.ctx.systems.economy.hold.pink = 15000; // plugged: part of the set goes over the corks
  const ev = g.ctx.events;
  let flow = 0.05; // slack water, then a running tide
  g.ctx.tide.currentAt = (x, z, out = { x: 0, z: 0 }) => ((out.x = flow), (out.z = 0), out);
  await toHauling(g);
  assert.equal(g.offer('interact')?.label, 'Hold to speed up the block');
  assert.equal(F.hud.tideRunning, false);
  flow = 0.45;
  g.run(0.3);
  assert.equal(F.hud.tideRunning, true);
  assert.match(g.offer('interact')?.label ?? '', /tide's running/);
  assert.equal(g.offer('interact')?.id, 'fishing-haul');
  assert.equal(g.offer('interact')?.hold, true);
  // Corks under while E is held in the current.
  g.held.add('interact');
  g.run(0.5);
  assert.equal(g.net.corksUnder, true);
  ev.emit('fishing:escape', { count: 300, species: 'pink', schoolId: 'x' });
  g.held.delete('interact');
  flow = 0.05;
  ev.emit('fishing:escape', { count: 40, species: 'pink', schoolId: 'x', viaGap: true });
  ev.emit('fishing:escape', { count: 7, species: 'pink', schoolId: 'x', cause: 'hole' });
  g.until(() => F.state === 'idle', 120);
  const p = g.named('fishing:setComplete')[0];
  assert.equal(p.escapes.corks, 300);
  assert.equal(p.escapes.gap, 40);
  assert.equal(p.escapes.hole, 7);
  assert.ok(p.escapes.overflow > 0);
  assert.equal(p.escapes.overflow, p.released.pink);
  assert.equal(p.escaped, 347);
  assert.deepEqual(Object.keys(p.escapes).sort(), ['corks', 'gap', 'hole', 'leads', 'overflow', 'spill']);
  assert.equal(p.escapes.spill, 0);
});

test('escapes while pursing count against the leads (a snag hole takes its share)', async () => {
  const g = await makeGame();
  const F = g.fishing;
  g.seiner.setPose(OPEN.x, OPEN.z, Math.PI / 2);
  g.run(0.2);
  g.press('action');
  g.circle({ cx: CENTRE.x, cz: CENTRE.z, r: 60, turns: 1.2, stopWhen: () => F.hud.closeReady });
  g.press('action');
  g.until(() => F.state === 'pursing', 40);
  g.ctx.events.emit('fishing:escape', { count: 100, species: 'pink' });
  g.ctx.events.emit('fishing:escape', { count: 30, species: 'pink', overCorks: true });
  g.net.model.hole = true;
  g.ctx.events.emit('fishing:escape', { count: 100, species: 'pink' });
  const e = F.core.set.escapes;
  assert.equal(e.leads, 180);
  assert.equal(e.hole, 20);
  assert.equal(e.spill, 30, 'the harvest spill over the capture ceiling is not blamed on the block');
  assert.equal(e.corks, 0);
});

test("a plugged hold, a berth alongside a tender or harbour, and a dock mooring all refuse the let-go", async () => {
  const g = await makeGame();
  const F = g.fishing;
  const eco = g.ctx.systems.economy;
  g.seiner.setPose(OPEN.x, OPEN.z, Math.PI / 2);
  g.run(0.1);
  assert.equal(F.canSet().ok, true);
  eco.hold.pink = Math.ceil((eco.capacityLbs - 1000) / 3.6);
  g.run(0.1);
  assert.deepEqual(F.canSet(), { ok: false, reason: "Hold's plugged — deliver first" });
  assert.equal(g.offer('action'), null);
  eco.hold.pink = 0;
  // Alongside the tender.
  const t = g.ctx.systems.fleet.tenders[0];
  g.seiner.setPose(t.position.x + t.radius + 25, t.position.z, 0);
  g.ctx.systems.fish.schools[0].position.set(t.position.x + 100, -2, t.position.z);
  g.run(0.1);
  assert.match(F.canSet().reason ?? '', /Too close to the Stub Tender/);
  assert.equal(g.offer('action'), null);
  // A harbour's dock.
  const kodiak = g.ctx.systems.places.list.find((p) => p.dock && p.services?.length);
  g.seiner.setPose(kodiak.dock.x + 30, kodiak.dock.z, 0);
  g.run(0.1);
  assert.equal(F.canSet().ok, false);
  // Tied up.
  g.seiner.setPose(OPEN.x, OPEN.z, 0);
  g.seiner.setMooring({ kind: 'dock', placeId: kodiak.id });
  g.run(0.1);
  assert.match(F.canSet().reason ?? '', /Cast off/);
});

test("the set's value uses the nearest buying tender's price and names it", async () => {
  const seen = [];
  const overrides = {
    ...fixedCatch({ pink: 3000, chum: 0, sockeye: 0, coho: 0, king: 0 }),
    season(ctx) {
      const s = STUBS.season(ctx);
      s.priceFor = (k, id) => {
        seen.push(id);
        return id === 'stub-tender' ? 0.27 : 0.32;
      };
      return s;
    },
  };
  const g = await makeGame({ overrides });
  await toHauling(g);
  g.until(() => g.fishing.state === 'brailing', 60);
  assert.equal(g.fishing.hud.valuedAt, 'Stub Tender');
  g.until(() => g.fishing.state === 'idle', 60);
  const p = g.named('fishing:setComplete')[0];
  assert.equal(p.valuedAt, 'Stub Tender');
  assert.equal(p.valuedAtId, 'stub-tender');
  assert.ok(Math.abs(p.value - 3000 * 3.6 * 0.27) < 0.01, `value ${p.value}`);
  assert.ok(seen.includes('stub-tender'));
});

test('the brailer lifts fish only for an accepted catch; each scoop emits fishing:brail', async () => {
  const g = await makeGame({ overrides: fixedCatch({ pink: 4000, chum: 0, sockeye: 0, coho: 0, king: 0 }) });
  const F = g.fishing;
  await toHauling(g);
  g.until(() => F.state === 'brailing', 60);
  g.run(0.1);
  assert.equal(F.brailer.group.visible, true);
  assert.equal(F.hud.message, null, 'the count-up is on the set panel, not repeated as a caption');
  g.until(() => F.state !== 'brailing', 30);
  const scoops = g.named('fishing:brail');
  assert.ok(scoops.length >= 2, `${scoops.length} scoops`);
  assert.ok(scoops.every((b) => Number.isFinite(b.x) && Number.isFinite(b.z) && b.lbs > 0));
  const lbs = scoops.reduce((a, b) => a + b.lbs, 0);
  assert.ok(Math.abs(lbs - 4000 * 3.6) <= scoops.length, `brailed ${lbs}`);
  g.until(() => F.state === 'idle', 60);

  // Water haul: no brailer, no fish, no scoops.
  const g2 = await makeGame({ overrides: fixedCatch({ pink: 0, chum: 0, sockeye: 0, coho: 0, king: 0 }) });
  await toHauling(g2);
  g2.until(() => g2.fishing.state === 'brailing', 60);
  g2.run(0.5);
  assert.equal(g2.fishing.brailer.group.visible, false);
  assert.match(g2.fishing.hud.message ?? '', /Water haul/);
  g2.until(() => g2.fishing.state !== 'brailing', 30);
  assert.equal(g2.named('fishing:brail').length, 0);
});

test("Pete's let-go tip no longer says to ease off, and the HUD shows the pay-out pace", async () => {
  assert.doesNotMatch(HINTS.letgo, /easy on the throttle/i);
  const g = await makeGame();
  const F = g.fishing;
  g.seiner.setPose(OPEN.x, OPEN.z, Math.PI / 2);
  g.run(0.2);
  g.press('action');
  straight(g, { heading: Math.PI / 2, speed: 7, seconds: 5 });
  assert.ok(F.hud.payoutSpeed > 5, `pay-out ${F.hud.payoutSpeed}`);
  assert.equal(F.hud.payoutPace, 'steady');
  assert.ok(F.hud.payoutEta > 30 && F.hud.payoutEta < 60, `eta ${F.hud.payoutEta}`);
  straight(g, { heading: Math.PI / 2, speed: 2, seconds: 4 });
  assert.equal(F.hud.payoutPace, 'slow');
  assert.match(F.hud.message, /slowly/);
});

test('polygon() and gap() reuse their objects frame to frame', async () => {
  const g = await makeGame();
  g.seiner.setPose(OPEN.x, OPEN.z, Math.PI / 2);
  g.run(0.2);
  g.press('action');
  g.circle({ cx: CENTRE.x, cz: CENTRE.z, r: 60, turns: 0.5 });
  const p0 = g.net.polygon();
  const g0 = g.net.gap();
  const n0 = p0.length;
  g.circle({ cx: CENTRE.x, cz: CENTRE.z, r: 60, turns: 0.1 });
  assert.equal(g.net.polygon(), p0);
  assert.equal(g.net.gap(), g0);
  assert.ok(p0.length >= n0);
  assert.equal(config.net.closeDistance > 0, true);
});
