// WP-RULES: hold, fish tickets and crew share, fuel burn / warnings / tow, refuelling prices, the cannery advance,
// upgrades and modifiers, goals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/core/config.js';
import { fillHold, buildTicket, fuelBurnPerHour, fuelPriceAt, affordableGallons, towQuote, lbsOf, spokenPrice } from '../src/game/data/market.js';
import { UPGRADES, computeModifiers, catalogRows, fathoms, meshes } from '../src/game/data/upgrades.js';
import { makeWorld } from './rules-helpers.test.mjs';

const table = config.fish.species;
const eco = config.economy;

test('fillHold: capacity, overflow, kings never kept', () => {
  const empty = { pink: 0, chum: 0, sockeye: 0, coho: 0, king: 0 };
  const r = fillHold(empty, { pink: 20000, king: 3 }, 60000, table);
  assert.equal(r.accepted.pink, Math.floor(60000 / 3.6));
  assert.equal(r.accepted.pink + r.overflow.pink, 20000);
  assert.equal(r.accepted.king, 0);
  assert.equal(r.overflow.king, 3);
  assert.ok(lbsOf(r.hold, table) <= 60000);
  const r2 = fillHold(r.hold, { chum: 10 }, 60000, table);
  assert.equal(r2.accepted.chum, 0);
  assert.equal(r2.overflow.chum, 10);
});

test('fish ticket: lbs × price per species, 30% crew share in three 10% shares', () => {
  const hold = { pink: 5000, chum: 400, sockeye: 250, coho: 0, king: 2 };
  const prices = { pink: 0.33, chum: 0.57, sockeye: 1.2, coho: 0.95 };
  const t = buildTicket(hold, table, (s) => prices[s], 0.3);
  assert.deepEqual(t.lines.map((l) => l.species), ['pink', 'chum', 'sockeye']);
  const pink = t.lines[0];
  assert.deepEqual(pink, { species: 'pink', code: 440, count: 5000, lbs: 18000, price: 0.33, value: 5940 });
  assert.equal(t.lines[1].lbs, 3400);
  assert.equal(t.lines[1].value, 1938);
  assert.equal(t.lines[2].code, 420);
  assert.equal(t.lines[2].value, 1800);
  assert.equal(t.gross, 9678);
  assert.equal(t.crewShare, 2903.4);
  assert.equal(t.net, 6774.6);
  assert.equal(t.totalLbs, 22900);
  assert.equal(t.crew.length, 3);
  assert.ok(Math.abs(t.crew.reduce((a, c) => a + c.share, 0) - t.crewShare) < 0.001);
  assert.ok(t.crew.every((c) => Math.abs(c.share - t.gross * 0.1) < 0.02));
});

test('fuel rules: burn curve, town vs away prices, credit limit, tow quote', () => {
  assert.equal(fuelBurnPerHour(0, eco), 1.5);
  assert.equal(fuelBurnPerHour(1, eco), 39.5);
  assert.ok(Math.abs(fuelBurnPerHour(0.6, eco) - (38 * 0.6 ** 1.5 + 1.5)) < 1e-9);
  assert.equal(fuelPriceAt({ kind: 'town', id: 'kodiak' }, eco), 4.6);
  assert.equal(fuelPriceAt({ kind: 'village', id: 'port-lions' }, eco), 5);
  assert.equal(fuelPriceAt({ kind: 'cannery', id: 'alitak' }, eco), 5);
  assert.equal(fuelPriceAt({ isTender: true, id: 't1' }, eco), 5);
  assert.equal(affordableGallons(-9000, 5, -10000, 3000), 200);
  assert.equal(affordableGallons(100, 5, -10000, 3000), 2020);
  const q = towQuote(0, 3000, eco, 5);
  assert.deepEqual(q, { gallons: 750, fee: 750, fuelCost: 3750, total: 4500 });
  assert.equal(spokenPrice(0.34), 'thirty-four');
  assert.equal(spokenPrice(1.2), 'a buck-twenty');
  assert.equal(spokenPrice(1.05), 'a buck-oh-five');
});

test('economy: starting state per SPEC 8.1', async () => {
  const w = await makeWorld();
  const e = w.economy;
  assert.equal(e.cash, 2500);
  assert.equal(e.fuel, 3000);
  assert.equal(e.fuelCapacity, 3000);
  assert.equal(e.holdLbs(), 0);
  assert.equal(e.capacityLbs, 60000);
  assert.equal(e.fuelEmpty, false);
  assert.deepEqual(Object.keys(e.modifiers).sort(), ['deckLights', 'deckLightsLevel', 'haulRate', 'holdLbs', 'maxSpeed', 'netDepth', 'netLength', 'purseRate', 'rswBonus', 'sonarRange', 'spotterUntilDay'].sort());
  assert.equal(e.modifiers.sonarRange, 150);
  assert.match(e.permit, /^S01K-\d{5}$/);
});

test('economy: deliver produces the SPEC §7 receipt, pays net, empties the hold', async () => {
  const w = await makeWorld();
  const { ctx, economy: e } = w;
  ctx.clock.set(14, 0);
  const t = ctx.systems.fleet.tenders[0];
  const r0 = e.addCatch({ pink: 5000, chum: 300, sockeye: 100, king: 1 });
  assert.equal(r0.accepted.king, 0);
  assert.equal(r0.acceptedLbs, 5000 * 3.6 + 300 * 8.5 + 100 * 6);
  const events = [];
  ctx.events.on('economy:delivered', (x) => events.push(x));
  const receipt = e.deliver(t);
  assert.equal(events.length, 1);
  assert.equal(events[0], receipt);
  for (const k of ['ticket', 'date', 'tender', 'district', 'lines', 'gross', 'crewShare', 'net']) assert.ok(k in receipt, k);
  assert.equal(receipt.tender, 'Stub Tender');
  for (const l of receipt.lines) {
    assert.deepEqual(Object.keys(l).sort(), ['code', 'count', 'lbs', 'price', 'species', 'value']);
    assert.equal(l.price, w.season.priceFor(l.species, t.id));
    assert.equal(l.value, Math.round(l.lbs * l.price * 100) / 100);
  }
  assert.equal(receipt.crewShare, Math.round(receipt.gross * 0.3 * 100) / 100);
  assert.equal(receipt.net, Math.round((receipt.gross - receipt.crewShare) * 100) / 100);
  assert.equal(e.cash, Math.round((2500 + receipt.net) * 100) / 100);
  assert.equal(e.holdLbs(), 0);
  assert.equal(e.stats.seasonGross, receipt.gross);
  assert.equal(e.stats.deliveries, 1);
  assert.equal(e.stats.daily[0].lbs, receipt.totalLbs);
  assert.match(receipt.ticket, /^K26-\d{6}$/);
  assert.match(receipt.statArea, /^\d{3}-\d{2}$/);
  assert.equal(receipt.condition, 'Iced');
  assert.equal(e.deliver(t), null, 'empty hold delivers nothing');
});

test('economy: deliver offer (priority 60) needs < 35 m, < 2 m/s, fishing idle, fish aboard', async () => {
  const w = await makeWorld();
  const { ctx, economy: e } = w;
  const t = ctx.systems.fleet.tenders[0];
  const s = ctx.systems.seiner;
  s.setPose(t.position.x + t.radius + 20, t.position.z, 0);
  w.step(0.1);
  assert.equal(w.offer('deliver'), null, 'hold empty');
  e.addCatch({ pink: 3000 });
  w.step(0.1);
  const o = w.offer('deliver');
  assert.ok(o);
  assert.equal(o.priority, 60);
  assert.equal(o.label, 'Deliver to the Stub Tender');
  s.speed = 3;
  w.step(0.1);
  assert.equal(w.offer('deliver'), null, 'too fast');
  s.speed = 0;
  ctx.systems.fishing.state = 'setting';
  w.step(0.1);
  assert.equal(w.offer('deliver'), null, 'mid-set');
  ctx.systems.fishing.state = 'idle';
  s.setPose(t.position.x + t.radius + 60, t.position.z, 0);
  w.step(0.1);
  assert.equal(w.offer('deliver'), null, 'too far');
  s.setPose(t.position.x + t.radius + 20, t.position.z, 0);
  w.step(0.1);
  w.offer('deliver').onPress();
  assert.equal(e.holdLbs(), 0);
  w.step(0.1);
  assert.ok(w.storage.getItem('kodiak-seiner:save'), 'autosave after delivery');
});

test('economy: fuel burns 38·load^1.5 + 1.5 gal per game hour, none in free explore', async () => {
  const w = await makeWorld();
  const { ctx, economy: e } = w;
  ctx.systems.seiner.engineLoad = 1;
  // 60 real seconds at 1 game-min/s = 1 game hour.
  for (let i = 0; i < 600; i++) e.update(0.1);
  assert.ok(Math.abs(3000 - e.fuel - 39.5) < 0.01, `burned ${3000 - e.fuel}`);
  ctx.systems.seiner.engineLoad = 0.5;
  const before = e.fuel;
  for (let i = 0; i < 600; i++) e.update(0.1);
  assert.ok(Math.abs(before - e.fuel - (38 * 0.5 ** 1.5 + 1.5)) < 0.01);
  ctx.state.freeExplore = true;
  const f = e.fuel;
  for (let i = 0; i < 600; i++) e.update(0.1);
  assert.equal(e.fuel, f);
  e.useFuel(100, 'travel');
  assert.equal(e.fuel, f);
});

test('economy: warnings at 20% and 10%, limp at empty, tow offer and tow', async () => {
  const w = await makeWorld();
  const { ctx, economy: e } = w;
  const s = ctx.systems.seiner;
  e.useFuel(3000 - 610, 'test');
  e.useFuel(20, 'test');
  assert.ok(w.toasts.some((t) => /Fuel at 20%/.test(t.text)));
  e.useFuel(300, 'test');
  assert.ok(w.toasts.some((t) => /Fuel at 10%/.test(t.text)));
  assert.equal(w.toasts.filter((t) => /Fuel at 20%/.test(t.text)).length, 1, 'warned once');
  e.useFuel(1000, 'test');
  assert.equal(e.fuel, 0);
  assert.equal(e.fuelEmpty, true);
  assert.equal(s.speedLimit, 2, 'limps at 2 m/s');
  // Far from the tender: the tow offer.
  const t = ctx.systems.fleet.tenders[0];
  s.setPose(t.position.x + 800, t.position.z + 300, 0);
  w.step(0.1);
  const o = w.offer('tow');
  assert.ok(o, 'tow offered');
  assert.match(o.label, /Accept a tow from the Stub Tender/);
  const cash0 = e.cash;
  const h0 = ctx.clock.day * 24 + ctx.clock.hours;
  o.onPress();
  assert.equal(e.fuel, 750, 'filled to 25%');
  assert.equal(e.cash, cash0 - 750 - 750 * 5);
  assert.equal(s.speedLimit, null, 'limp cleared');
  assert.ok(Math.hypot(s.position.x - t.position.x, s.position.z - t.position.z) < 120, 'placed alongside');
  assert.ok(ctx.clock.day * 24 + ctx.clock.hours > h0, 'the tow takes time');
  assert.equal(e.stats.tows, 1);
});

test('economy: cannery advance to −$10,000; purchases need cash; deliveries repay', async () => {
  const w = await makeWorld();
  const { ctx, economy: e } = w;
  e.addCash(-2400, 'fine: closed waters');
  assert.equal(e.cash, 100);
  assert.equal(e.stats.fines, 2400);
  e.useFuel(2900, 'test');
  const r = e.refuel({ kind: 'town', id: 'kodiak', name: 'Kodiak' });
  assert.ok(r.ok);
  assert.ok(e.cash < 0, 'fuel on the cannery advance');
  assert.ok(e.cash >= -10000);
  assert.ok(w.toasts.some((t) => /advance/.test(t.text)));
  e.addCash(-50000, 'fine');
  assert.equal(e.cash, -10000, 'never below the advance limit');
  const r2 = e.refuel({ kind: 'town', id: 'kodiak' });
  assert.equal(r2.ok, false);
  // Buy fails without positive cash even when docked at the yard.
  ctx.systems.seiner.setMooring({ kind: 'dock', placeId: 'kodiak' });
  assert.equal(e.buy('purseWinch'), false);
  assert.equal(e.lastBuyError, 'Not enough cash');
  e.addCatch({ sockeye: 5000 });
  const rec = e.deliver(ctx.systems.fleet.tenders[0]);
  assert.ok(rec.advanceRepaid > 0);
  assert.equal(e.cash, Math.round((-10000 + rec.net) * 100) / 100);
});

test('economy: free explore ignores fines', async () => {
  const w = await makeWorld({ freeExplore: true });
  const c = w.economy.cash;
  w.economy.addCash(-5000, 'fine: closed waters citation');
  assert.equal(w.economy.cash, c);
});

test('economy: refuel prices — $4.60 in town, $5.00 at tenders and villages', async () => {
  const w = await makeWorld();
  const e = w.economy;
  e.useFuel(1000, 'test');
  const town = e.refuelQuote({ kind: 'town', id: 'kodiak', name: 'Kodiak' });
  assert.equal(town.price, 4.6);
  const t = w.ctx.systems.fleet.tenders[0];
  assert.equal(e.refuelQuote(t).price, 5);
  assert.equal(e.refuelQuote({ kind: 'village', id: 'old-harbor', name: 'Old Harbor' }).price, 5);
  const r = e.refuel(t);
  assert.ok(r.ok);
  assert.equal(r.gallons, 1000);
  assert.equal(r.cost, 5000);
  assert.equal(e.cash, -2500, 'the cannery advance covers the rest');
  assert.equal(e.fuel, 3000);
});

test('upgrades: catalog per SPEC 8.3 — prices, caps, fathoms', () => {
  const ids = UPGRADES.map((u) => u.id);
  for (const id of ['purseWinch', 'powerBlock', 'engine', 'seineDepth', 'seineLength', 'sonar', 'rsw', 'hold', 'deckLights']) assert.ok(ids.includes(id), id);
  const winch = UPGRADES.find((u) => u.id === 'purseWinch');
  assert.ok(winch.tiers[0].price >= 5000 && winch.tiers[0].price <= 7000);
  const engine = UPGRADES.find((u) => u.id === 'engine');
  assert.ok(engine.tiers.every((t) => t.price >= 20000 && t.price <= 25000));
  const all = { purseWinch: 1, powerBlock: 2, engine: 2, seineDepth: 2, seineLength: 2, sonar: 2, rsw: 1, hold: 1, deckLights: 1 };
  const m = computeModifiers(config, all);
  assert.equal(m.netLength, 457);
  assert.equal(fathoms(m.netLength), 250);
  assert.equal(m.netDepth, 22);
  assert.equal(meshes(m.netDepth), 325);
  assert.equal(m.sonarRange, 500);
  assert.ok(Math.abs(m.maxSpeed - 12 * 1.2) < 1e-9);
  assert.equal(m.rswBonus, 0.05);
  assert.equal(m.holdLbs, 75000);
  assert.ok(m.purseRate > 1 && m.haulRate > 1);
  const over = computeModifiers(config, { seineLength: 9, seineDepth: 9 });
  assert.equal(over.netLength, 457);
  assert.equal(over.netDepth, 22);
  const rows = catalogRows(config, {}, { cash: 7000 });
  const seine = rows.find((r) => r.id === 'seineLength');
  assert.match(seine.current, /208 fathoms/);
  assert.match(seine.next, /225 fathoms/);
  assert.equal(rows.find((r) => r.id === 'purseWinch').affordable, true);
  assert.ok(rows.some((r) => r.id === 'spotter' && r.consumable));
});

test('upgrades: buy at the Kodiak yard; tiers raise modifiers; max tier stops', async () => {
  const w = await makeWorld();
  const { ctx, economy: e } = w;
  e.addCash(100000, 'test');
  assert.equal(e.buy('sonar'), false);
  assert.match(e.lastBuyError, /Kodiak harbour/);
  ctx.systems.seiner.setMooring({ kind: 'dock', placeId: 'kodiak' });
  const purchases = [];
  ctx.events.on('economy:purchase', (p) => purchases.push(p));
  assert.equal(e.buy('sonar'), true);
  assert.equal(e.modifiers.sonarRange, 300);
  assert.equal(e.buy('sonar'), true);
  assert.equal(e.modifiers.sonarRange, 500);
  assert.equal(e.buy('sonar'), false);
  assert.equal(e.lastBuyError, 'Already at the maximum');
  assert.equal(e.buy('engine'), true);
  assert.ok(Math.abs(ctx.systems.seiner.maxSpeed - 13.2) < 1e-9, 'seiner.maxSpeed reads the modifier');
  assert.equal(e.buy('rsw'), true);
  ctx.clock.set(12, 0);
  const p = w.season.priceFor('pink', 'stub-tender');
  e.addCatch({ pink: 100 });
  const r = e.deliver(ctx.systems.fleet.tenders[0]);
  assert.equal(r.condition, 'RSW');
  assert.equal(r.lines[0].price, p);
  const cash = e.cash;
  assert.equal(e.buy('seineLength'), true);
  assert.equal(e.cash, cash - 8000);
  assert.equal(e.modifiers.netLength, 411);
  assert.deepEqual(purchases.map((x) => x.id), ['sonar', 'sonar', 'engine', 'rsw', 'seineLength']);
  const mods = e.modifiers;
  e.reset();
  assert.equal(e.modifiers, mods, 'modifiers object keeps its identity');
  assert.equal(e.modifiers.sonarRange, 150);
});

test('spotter charter: bought anywhere for today\'s or the next period; not over the Mainland', async () => {
  const w = await makeWorld();
  const { ctx, economy: e } = w;
  ctx.clock.set(12, 1);
  assert.equal(e.buy('spotter'), true);
  assert.equal(e.modifiers.spotterUntilDay, 2);
  assert.equal(e.spotterActive(), false, 'closed day');
  ctx.clock.set(10, 2);
  assert.equal(e.spotterActive(), true);
  assert.equal(e.buy('spotter'), false);
  ctx.clock.set(10, 3);
  assert.equal(e.spotterActive(), false);
});

test('goals on seasonGross toast once and emit economy:goal', async () => {
  const w = await makeWorld();
  const { ctx, economy: e } = w;
  const goals = [];
  ctx.events.on('economy:goal', (g) => goals.push(g.label));
  ctx.clock.set(12, 0);
  e.addCatch({ sockeye: 1500 });
  e.deliver(ctx.systems.fleet.tenders[0]);
  assert.ok(e.stats.seasonGross >= 10000 * 0.85, `${e.stats.seasonGross}`);
  if (e.stats.seasonGross < 10000) {
    e.addCatch({ sockeye: 400 });
    e.deliver(ctx.systems.fleet.tenders[0]);
  }
  assert.deepEqual(goals, ['Covered the grub and fuel bill']);
  e.addCatch({ pink: 100 });
  e.deliver(ctx.systems.fleet.tenders[0]);
  assert.equal(goals.length, 1);
  assert.ok(w.toasts.some((t) => /Season goal: Covered the grub and fuel bill/.test(t.text)));
  assert.deepEqual(e.goals().map((g) => g.reached), [true, false, false, false]);
});

test('Highliner: first on the fleet board at the close of the sixth period or later', async () => {
  const w = await makeWorld();
  const { ctx, economy: e } = w;
  const goals = [];
  ctx.events.on('economy:goal', (g) => goals.push(g.label));
  e.stats.seasonGross = 500000;
  ctx.clock.set(23, 13);
  ctx.events.emit('opener:end', { day: 13 });
  assert.deepEqual(goals, [], 'too early in the season');
  ctx.clock.set(22.5, 17);
  ctx.events.emit('opener:end', { day: 17 });
  assert.deepEqual(goals, ['Highliner']);
  ctx.events.emit('opener:end', { day: 21 });
  assert.equal(goals.length, 1);
});

test('economy: tie up at a harbour snaps to the dock, moors, autosaves', async () => {
  const w = await makeWorld();
  const { ctx, economy: e } = w;
  const kodiak = ctx.systems.places.get('kodiak');
  const s = ctx.systems.seiner;
  s.setPose(kodiak.dock.x + 40, kodiak.dock.z + 20, 0);
  s.speed = 0.5;
  w.step(0.1);
  const o = w.offer('tieUp');
  assert.ok(o, 'tie-up offered near the dock');
  assert.equal(o.priority, 60);
  assert.equal(o.label, 'Tie up at City of Kodiak');
  o.onPress();
  assert.deepEqual(s.mooring, { kind: 'dock', placeId: 'kodiak' });
  // Bow-in berth: backed off the dock point toward open water, bow toward the shore.
  const off = Math.hypot(s.position.x - kodiak.dock.x, s.position.z - kodiak.dock.z);
  assert.ok(off <= 10.5, `berth ${off} m from the dock point`);
  const g = ctx.heightmap.shoreGradient(kodiak.dock.x, kodiak.dock.z);
  const fwd = { x: Math.sin(s.heading), z: -Math.cos(s.heading) };
  assert.ok(fwd.x * g.x + fwd.z * g.z < -0.9, 'bow points toward the shore');
  w.step(0.1);
  assert.ok(w.storage.getItem('kodiak-seiner:save'));
  assert.equal(e.dockedAt().id, 'kodiak');
  assert.deepEqual(e.services().services, ['sell', 'fuel', 'upgrades', 'ice', 'rest']);
  // Docked with fish: sell at the cannery; with room in the tanks: fuel up.
  e.addCatch({ pink: 100 });
  w.step(0.1);
  assert.equal(w.best().id, 'deliver');
  w.best().onPress();
  e.useFuel(1000, 'test');
  w.step(0.1);
  assert.equal(w.best().id, 'refuel');
  assert.match(w.best().label, /Fuel up — 1,000 gal · \$4,600/);
});

test('economy: serialize/restore round-trip', async () => {
  const w = await makeWorld();
  const e = w.economy;
  w.ctx.systems.seiner.setMooring({ kind: 'dock', placeId: 'kodiak' });
  e.addCash(30000, 'test');
  e.buy('purseWinch');
  e.buy('seineDepth');
  e.addCatch({ pink: 1234, chum: 55 });
  e.useFuel(321, 'test');
  const snap = JSON.parse(JSON.stringify(e.serialize()));
  e.reset();
  assert.equal(e.cash, 2500);
  e.restore(snap);
  assert.deepEqual(JSON.parse(JSON.stringify(e.serialize())), snap);
  assert.equal(e.modifiers.purseRate, 1.35);
  assert.equal(e.modifiers.netDepth, 19);
  assert.equal(e.hold.pink, 1234);
});
