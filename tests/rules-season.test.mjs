// WP-RULES: calendar, openers, species mix, prices, closed waters, weather, fleet board, radio, sleep and waiting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/core/config.js';
import * as cal from '../src/game/data/calendar.js';
import { speciesMixAt, leadingSpecies } from '../src/game/data/runs.js';
import { priceFor, dailyPriceFactor } from '../src/game/data/market.js';
import { buildWeatherPlan, presetAt, forecastFor, dominantPreset, PRESETS } from '../src/game/data/weather.js';
import { FLEET, createBoard, creditThrough, boardRows, fleetDayGross, seasonFactor, serializeBoard, restoreBoard, COMPETENT_DAILY } from '../src/game/data/fleetBoard.js';
import { LINES, WELCOME } from '../src/game/data/radioLines.js';
import { createRadio, fillTemplate, ambientWeights } from '../src/game/data/radio.js';
import { createRng } from '../src/core/rng.js';
import { makeWorld } from './rules-helpers.test.mjs';

const days = config.season.fishingDays;

// ---- calendar and openers ----

test('calendar: fishing days open 06:00–22:00 only', () => {
  assert.deepEqual(days, [0, 2, 5, 9, 13, 17, 21, 25, 29, 34, 40, 47]);
  assert.equal(cal.isOpenAt(config, 0, 5.99), false);
  assert.equal(cal.isOpenAt(config, 0, 6), true);
  assert.equal(cal.isOpenAt(config, 0, 21.99), true);
  assert.equal(cal.isOpenAt(config, 0, 22), false);
  assert.equal(cal.isOpenAt(config, 1, 12), false);
  assert.equal(cal.isOpenAt(config, 47, 12), true);
  assert.equal(cal.isOpenAt(config, 48, 12), false);
});

test('calendar: districts — Mainland opens on alternate periods, Alitak holds the second period', () => {
  assert.equal(cal.isOpenAt(config, 0, 10, 'mainland'), false);
  assert.equal(cal.isOpenAt(config, 5, 10, 'mainland'), true);
  assert.equal(cal.isOpenAt(config, 2, 10, 'alitak'), false);
  assert.equal(cal.isOpenAt(config, 2, 10, 'Northwest Kodiak'), true);
  assert.equal(cal.isOpenAt(config, 0, 10, 'Mainland District'), false);
  assert.equal(cal.normalizeDistrict('Eastside Kodiak'), 'eastside');
  assert.equal(cal.normalizeDistrict('Afognak District'), 'afognak');
});

test('calendar: nextOpenerAfter skips an open period and honours districts', () => {
  assert.equal(cal.nextOpenerAfter(config, 0, 5.5).day, 0);
  const n = cal.nextOpenerAfter(config, 0, 7);
  assert.equal(n.day, 2);
  assert.equal(n.hours, 6);
  assert.deepEqual(n.closed.sort(), ['alitak', 'mainland']);
  assert.ok(Array.isArray(n.districts) && !n.districts.includes('mainland'));
  assert.equal(cal.nextOpenerAfter(config, 3, 12).districts, 'all');
  assert.equal(cal.nextOpenerAfter(config, 0, 7, 'mainland').day, 5);
  assert.equal(cal.nextOpenerAfter(config, 47, 23), null);
});

test('calendar: run strength ramps to a plateau and tails off', () => {
  const r = config.fish.runs.pink;
  assert.equal(cal.runStrength(r, -1), 0);
  assert.ok(Math.abs(cal.runStrength(r, 0) - 0.35) < 1e-9);
  assert.equal(cal.runStrength(r, 25), 1);
  assert.ok(cal.runStrength(r, 42) > 0 && cal.runStrength(r, 42) < 1);
  assert.equal(cal.runStrength(r, 51), 0);
  assert.equal(cal.runStrength(config.fish.runs.coho, 30), 0);
});

test('calendar: dates and weekdays for the 2026 season', () => {
  assert.equal(cal.dateOf(config, 0).label, 'Jul 6');
  assert.equal(cal.dateOf(config, 0).weekday, 'Monday');
  assert.equal(cal.dateOf(config, 26).label, 'Aug 1');
  assert.equal(cal.dateOf(config, 47).long, 'Saturday, August 22');
  assert.equal(cal.spokenTime(6), '6 a.m.');
  assert.equal(cal.spokenTime(22), '10 p.m.');
});

test('season: openerActive is the authority (schedule, hours, free explore)', async () => {
  const w = await makeWorld();
  const { ctx, season } = w;
  ctx.clock.set(5.5, 0);
  assert.equal(season.openerActive(), false);
  ctx.clock.set(9, 0);
  assert.equal(season.openerActive(), true);
  assert.equal(season.openerActive(5170, -1115), true);
  ctx.clock.set(9, 1);
  assert.equal(season.openerActive(), false);
  ctx.state.freeExplore = true;
  assert.equal(season.openerActive(), true);
  ctx.state.freeExplore = false;
  const n = season.nextOpener();
  assert.equal(n.day, 2);
  assert.equal(n.hours, 6);
  assert.match(n.label, /Wed Jul 8/);
  assert.match(season.openerStatus().label, /^Closed · opens Wed Jul 8/);
  ctx.clock.set(12, 0);
  assert.match(season.openerStatus().label, /^Open/);
});

test('season: district-aware openerActive via district polygons', async () => {
  const sq = (x0, z0, x1, z1) => [{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }];
  const w = await makeWorld({
    places: {
      list: [],
      districts: [
        { id: 'mainland', name: 'Mainland', polygon: sq(-8000, -8000, -4000, 8000) },
        { id: 'northeast', name: 'Northeast Kodiak', polygon: sq(-4000, -8000, 8000, 8000) },
      ],
    },
  });
  const { ctx, season } = w;
  ctx.clock.set(10, 0);
  assert.equal(season.districtAt(-6000, 0), 'mainland');
  assert.equal(season.openerActive(-6000, 0), false);
  assert.equal(season.openerActive(2000, 0), true);
  assert.equal(season.nextOpener(-6000, 0).day, 5);
  ctx.clock.set(10, 5);
  assert.equal(season.openerActive(-6000, 0), true);
});

test('season: emits opener:start/end on the schedule and after a time skip', async () => {
  const w = await makeWorld();
  const { ctx } = w;
  const got = [];
  ctx.events.on('opener:start', (e) => got.push(['start', e.day]));
  ctx.events.on('opener:end', (e) => got.push(['end', e.day]));
  ctx.clock.set(5.9, 0);
  w.step(0.1);
  ctx.clock.advance(0.2);
  w.step(0.1);
  assert.deepEqual(got, [['start', 0]]);
  ctx.clock.set(21.95, 0);
  w.step(0.1);
  ctx.clock.advance(0.1);
  w.step(0.1);
  assert.deepEqual(got[1], ['end', 0]);
  // Skip from the closed evening straight into the next period.
  ctx.clock.set(23, 1);
  w.step(0.1);
  ctx.clock.skip(8, 'test');
  assert.deepEqual(got[got.length - 1], ['start', 2]);
});

test('season: title mode is quiet — no radio, no opener events', async () => {
  const w = await makeWorld({ start: false });
  const { ctx } = w;
  const ev = [];
  ctx.events.on('opener:start', () => ev.push(1));
  ctx.clock.set(5.95, 0);
  for (let i = 0; i < 600; i++) {
    ctx.clock.advance(0.01);
    w.step(0.5);
  }
  assert.equal(w.radio.length, 0);
  assert.equal(ev.length, 0);
});

// ---- species mix ----

const karluk = { id: 'karluk', name: 'Karluk River', species: ['sockeye', 'pink', 'coho'] };

test('speciesMix: sockeye lead off the Karluk early, pinks at the peak, sums to 1, no kings', () => {
  const early = speciesMixAt({ day: 5, runs: config.fish.runs, streams: [{ ...karluk, distance: 200 }], district: 'southwest', enclosure: 0.2 });
  assert.equal(leadingSpecies(early), 'sockeye');
  const sum = Object.values(early).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.equal(early.king, 0);
  const peak = speciesMixAt({ day: 27, runs: config.fish.runs, streams: [{ ...karluk, distance: 200 }], district: 'southwest', enclosure: 0.2 });
  assert.equal(leadingSpecies(peak), 'pink');
});

test('speciesMix: pinks lead the opening in open water; Northwest and Eastside are pinkest', () => {
  const ne = speciesMixAt({ day: 0, runs: config.fish.runs, district: 'northeast', enclosure: 0.3 });
  assert.equal(leadingSpecies(ne), 'pink');
  assert.ok(ne.pink > 0.5);
  const nw = speciesMixAt({ day: 20, runs: config.fish.runs, district: 'northwest', enclosure: 0.3 });
  const sw = speciesMixAt({ day: 20, runs: config.fish.runs, district: 'southwest', enclosure: 0.3 });
  assert.ok(nw.pink > sw.pink);
});

test('speciesMix: chum in the bays, coho late at Kitoi', () => {
  const open = speciesMixAt({ day: 8, runs: config.fish.runs, enclosure: 0 });
  const bay = speciesMixAt({ day: 8, runs: config.fish.runs, enclosure: 0.9 });
  assert.ok(bay.chum > open.chum * 2);
  const kitoiEarly = speciesMixAt({ day: 20, runs: config.fish.runs, hatcheries: [{ name: 'kitoi Kitoi Bay Hatchery', distance: 300 }], district: 'afognak' });
  assert.equal(kitoiEarly.coho, 0);
  const kitoiLate = speciesMixAt({ day: 50, runs: config.fish.runs, hatcheries: [{ name: 'kitoi Kitoi Bay Hatchery', distance: 300 }], district: 'afognak' });
  assert.ok(kitoiLate.coho > 0.3, `coho ${kitoiLate.coho}`);
  const kitoiSock = speciesMixAt({ day: 5, runs: config.fish.runs, hatcheries: [{ name: 'Kitoi Bay Hatchery', distance: 200 }], district: 'afognak' });
  const plain = speciesMixAt({ day: 5, runs: config.fish.runs, district: 'afognak' });
  assert.ok(kitoiSock.sockeye > plain.sockeye);
});

test('season.speciesMix uses streams and the date', async () => {
  const w = await makeWorld();
  const k = w.ctx.geo.toWorld(57.57, -154.46);
  const mix = w.season.speciesMix(k.x, k.z);
  assert.ok(Math.abs(Object.values(mix).reduce((a, b) => a + b, 0) - 1) < 1e-9);
  w.ctx.clock.set(12, 40);
  const late = w.season.speciesMix(k.x, k.z);
  assert.ok(late.coho > 0);
  w.ctx.clock.set(12, 0);
  assert.equal(w.season.speciesMix(k.x, k.z).coho, 0);
});

// ---- prices ----

test('prices: daily ±15%, deterministic, per tender, cents, king 0, RSW adds', () => {
  for (let day = 0; day < 50; day++) {
    for (const buyer of [null, 'tender-a', 'tender-b']) {
      const f = dailyPriceFactor(99, day, 'pink', buyer);
      assert.ok(f >= 0.85 - 1e-9 && f <= 1.15 + 1e-9, `factor ${f}`);
    }
  }
  const p = (o) => priceFor({ seed: 7, day: 3, species: 'sockeye', basePrice: 1.15, ...o });
  assert.equal(p({}), p({}));
  assert.ok(Math.abs(Math.round(p({}) * 100) - p({}) * 100) < 1e-6);
  const varies = new Set();
  for (let d = 0; d < 10; d++) varies.add(priceFor({ seed: 7, day: d, species: 'pink', basePrice: 0.32 }));
  assert.ok(varies.size >= 3);
  assert.notEqual(dailyPriceFactor(7, 3, 'pink', 'tender-a'), dailyPriceFactor(7, 3, 'pink', 'tender-b'));
  assert.equal(priceFor({ seed: 7, day: 3, species: 'king', basePrice: 0 }), 0);
  assert.ok(Math.abs(p({ rswBonus: 0.05 }) - p({}) - 0.05) < 0.011);
});

test('season.priceFor applies economy RSW bonus and gives kings nothing', async () => {
  const w = await makeWorld();
  const base = w.season.priceFor('pink', 'stub-tender');
  assert.ok(base >= 0.27 && base <= 0.37);
  assert.equal(w.season.priceFor('king'), 0);
  w.economy.modifiers.rswBonus = 0.05;
  assert.ok(Math.abs(w.season.priceFor('pink', 'stub-tender') - base - 0.05) < 0.011);
});

// ---- closed waters ----

test('closedWaters come from streams and CLOSED_AREAS; isClosedWater tests the radius', async () => {
  const w = await makeWorld({
    places: {
      list: [],
      streams: [{ id: 'buskin', name: 'Buskin River', species: ['sockeye', 'coho'], x: 1000, z: 1000, closedRadius: 250 }, { id: 'tiny', name: 'Tiny Creek', species: ['pink'], x: -3000, z: 0, closedRadius: 20 }],
      closedAreas: [{ id: 'marmot', name: 'Marmot Island rookery', x: 5000, z: -5000, radius: 470, reason: 'Steller sea lion rookery' }],
    },
  });
  const cw = w.season.closedWaters;
  assert.equal(cw.length, 3);
  const buskin = cw.find((c) => c.streamId === 'buskin');
  assert.deepEqual([buskin.x, buskin.z, buskin.radius], [1000, 1000, 250]);
  assert.equal(cw.find((c) => c.streamId === 'tiny').radius, 150, 'clamped to config.season.closedRadius');
  assert.equal(cw.find((c) => c.id === 'area:marmot').streamId, null);
  assert.equal(w.season.isClosedWater(1100, 1100), true);
  assert.equal(w.season.isClosedWater(1300, 1000), false);
  assert.equal(w.season.isClosedWater(5000, -4600), true);
  assert.equal(w.season.closedWaterAt(5000, -4600).reason, 'Steller sea lion rookery');
});

// ---- weather ----

test('weather plan: deterministic, Kodiak-typical mix, a couple of blows, day 0 is fair', () => {
  const a = buildWeatherPlan(1234);
  const b = buildWeatherPlan(1234);
  assert.deepEqual(a, b);
  assert.notDeepEqual(buildWeatherPlan(99).map((d) => d.type), a.map((d) => d.type));
  assert.equal(a[0].type, 'opening');
  for (let seed = 1; seed < 30; seed++) {
    const plan = buildWeatherPlan(seed);
    const season = plan.slice(0, 48);
    const blows = season.filter((d) => d.type === 'blow').length;
    assert.ok(blows >= 2 && blows <= 3, `seed ${seed}: ${blows} blows`);
    const types = new Set(season.map((d) => d.type));
    for (const t of ['fog', 'overcast', 'clear']) assert.ok(types.has(t), `seed ${seed} lacks ${t}`);
    for (const d of plan) for (const s of d.segs) assert.ok(PRESETS.includes(s.preset));
  }
  assert.equal(presetAt(a, 0, 20), 'clear', 'golden evening on opening day');
});

test('weather: forecast text reads like NOAA and warns before a blow', () => {
  const plan = buildWeatherPlan(4242);
  const f = forecastFor(plan, 3, 6, (d) => cal.dateOf(config, d));
  assert.match(f.text, /Kodiak Island waters\. Today: [NESW]{1,2} wind \d+ kt/);
  assert.match(f.text, /Seas \d+ ft/);
  assert.match(f.text, /Tonight:/);
  assert.ok(PRESETS.includes(f.today) && PRESETS.includes(f.tomorrow));
  const blow = plan.findIndex((d) => d.type === 'blow');
  const eve = forecastFor(plan, blow - 1, 18, (d) => cal.dateOf(config, d));
  assert.equal(eve.warning, 'Gale Warning');
  assert.match(eve.text, /^\.\.\.GALE WARNING\.\.\./);
  assert.equal(dominantPreset(plan, blow), 'storm');
});

test('season applies the scheduled weather through sky.setWeather unless pinned', async () => {
  const w = await makeWorld({ start: false });
  const calls = [];
  w.ctx.systems.sky.setWeather = (p, s) => calls.push([p, s]);
  w.ctx.game.start({ newGame: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], w.season.scheduledWeather(0, 5.5));
  assert.equal(calls[0][1], 0);
  // Opening day turns clear at 16:00 (a scheduled segment boundary) with a slow transition.
  w.ctx.clock.set(15.95, 0);
  w.step(0.1);
  w.ctx.clock.set(16.05, 0);
  w.step(0.1);
  assert.deepEqual(calls[calls.length - 1], ['clear', 90]);
  const n = calls.length;
  w.ctx.debug.weatherPinned = true;
  w.ctx.clock.skip(30, 'test');
  w.step(0.1);
  assert.equal(calls.length, n);
});

// ---- fleet board ----

test('fleet board: 8 named boats, ~0.8× a competent rate, top boat 1.2×, deterministic', () => {
  assert.equal(FLEET.length, 8);
  assert.equal(new Set(FLEET.map((b) => b.name)).size, 8);
  const mean = FLEET.reduce((a, b) => a + b.rate, 0) / FLEET.length;
  assert.ok(Math.abs(mean - 0.8) < 0.06, `mean ${mean}`);
  assert.equal(Math.max(...FLEET.map((b) => b.rate)), 1.2);
  const avgFactor = days.reduce((a, d) => a + seasonFactor(config, d), 0) / days.length;
  assert.ok(Math.abs(avgFactor - 1) < 1e-9);
  const board = createBoard();
  assert.deepEqual(creditThrough(board, config, 5, 0, 12), []);
  assert.deepEqual(creditThrough(board, config, 5, 0, 22), [0]);
  assert.deepEqual(creditThrough(board, config, 5, 9, 3), [2, 5]);
  assert.deepEqual(creditThrough(board, config, 5, 9, 3), []);
  const total = board.boats.reduce((a, b) => a + b.gross, 0);
  assert.ok(total > 3 * 8 * COMPETENT_DAILY * 0.35 && total < 3 * 8 * COMPETENT_DAILY * 2);
  assert.equal(fleetDayGross(5, config, 0, FLEET[0]), fleetDayGross(5, config, 0, FLEET[0]));
  const rows = boardRows(board, config, 5, 9, 12, { name: 'Northern Dawn', gross: 1e6 });
  assert.equal(rows.length, 9);
  assert.equal(rows[0].player, true);
  assert.equal(rows[0].rank, 1);
  const back = restoreBoard(JSON.parse(JSON.stringify(serializeBoard(board))));
  assert.deepEqual(serializeBoard(back), serializeBoard(board));
});

test('fleet board: over a whole season the top boat out-earns the average boat', () => {
  let top = 0;
  let avg = 0;
  for (const seed of [1, 2, 3, 4, 5]) {
    const board = createBoard();
    creditThrough(board, config, seed, 60, 0);
    const g = board.boats.map((b) => b.gross);
    top += g[0];
    avg += g.reduce((a, b) => a + b, 0) / g.length;
  }
  assert.ok(top > avg * 1.25);
  // A competent full season is ~12 × $12.5k ≈ $150k; the top boat ~1.2× that (less the odd breakdown).
  assert.ok(top / 5 > 140000 && top / 5 < 215000, `top ${top / 5}`);
});

test('season.fleetBoard includes the player with live partial days', async () => {
  const w = await makeWorld();
  w.ctx.clock.set(14, 0);
  const rows = w.season.fleetBoard();
  assert.equal(rows.length, 9);
  assert.ok(rows.some((r) => r.player && r.name === 'Northern Dawn'));
  assert.ok(rows.filter((r) => !r.player).some((r) => r.today > 0));
  w.ctx.clock.set(23, 0);
  const after = w.season.fleetBoard();
  assert.ok(after.filter((r) => !r.player).every((r) => r.today === 0));
  const s = w.season.serialize();
  w.season.reset();
  w.season.restore(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(w.season.serialize(), s);
});

// ---- radio ----

test('radio library: at least 120 authentic lines with only known tokens', () => {
  const known = new Set(['me', 'boat', 'skipper', 'cape', 'bay', 'place', 'harbor', 'tender', 'pinkc', 'redc', 'dogc', 'silverc', 'fuel', 'lbs', 'dist', 'dir', 'rel', 'weekday', 'date', 'towFee', 'towTotal', 'opener', 'rival']);
  let n = 0;
  for (const [cat, list] of Object.entries(LINES)) {
    for (const l of list) {
      const text = typeof l === 'string' ? l : l.t;
      n++;
      for (const m of text.matchAll(/\{(\w+)\}/g)) assert.ok(known.has(m[1]), `${cat}: unknown token ${m[1]}`);
      assert.ok(text.length < 260, `${cat}: too long`);
    }
  }
  n += WELCOME.length;
  assert.ok(n >= 120, `only ${n} lines`);
  for (const k of ['jumpers', 'sets', 'prices', 'weather', 'bears', 'tender', 'uscg', 'niceSet', 'waterHaul']) assert.ok(LINES[k].length >= 2, k);
  assert.ok(LINES.uscgCall.every((l) => /two-two alpha/.test(l)));
  assert.ok(LINES.niceSet.some((l) => /Nice set, cap/.test(l)));
});

test('radio scheduler: rate-limited, priority first, stale lines dropped, ambient by context', () => {
  const out = [];
  const r = createRadio({ rng: createRng(3), emit: (m) => out.push(m), minGap: 10 });
  r.nextAmbient = 1e9;
  r.push({ from: 'a', text: 'low', channel: '10' }, { priority: 0 });
  r.push({ from: 'b', text: 'high', channel: '10' }, { priority: 5 });
  r.push({ from: 'c', text: 'stale', channel: '10' }, { priority: 1, ttl: 3 });
  r.update(0.1, { open: true, hours: 10 });
  assert.deepEqual(out.map((m) => m.text), ['high']);
  for (let i = 0; i < 50; i++) r.update(0.1, { open: true, hours: 10 });
  assert.equal(out.length, 1, 'min gap holds the next line');
  for (let i = 0; i < 60; i++) r.update(0.1, { open: true, hours: 10 });
  assert.deepEqual(out.map((m) => m.text), ['high', 'low']);
  assert.equal(r.push({ from: 'x', text: 'once', channel: '10' }, { key: 'k', cooldown: 100 }), true);
  assert.equal(r.push({ from: 'x', text: 'twice', channel: '10' }, { key: 'k', cooldown: 100 }), false);
  assert.equal(fillTemplate('Hi {me}, {x}', { me: () => 'Dawn' }), 'Hi Dawn, {x}');
  assert.ok(ambientWeights({ open: true, hours: 10 }).jumpers > 0);
  assert.equal(ambientWeights({ open: false, hours: 10 }).jumpers, undefined);
  assert.ok(ambientWeights({ open: false, hours: 5, fishingDay: true }).morning > 0);
  assert.deepEqual(Object.keys(ambientWeights({ open: false, hours: 2 })), ['night']);
});

test('season radio: chatter plays in play mode, never faster than the gap', async () => {
  const w = await makeWorld();
  w.ctx.clock.set(10, 0);
  const t0 = [];
  for (let i = 0; i < 6000; i++) {
    w.step(0.1);
    if (w.radio.length && t0[t0.length - 1] !== w.radio.length) t0.push(w.radio.length);
  }
  assert.ok(w.radio.length >= 4, `only ${w.radio.length} lines in 10 minutes`);
  assert.ok(w.radio.length <= 60);
  for (const m of w.radio) {
    assert.ok(m.from && m.text && m.channel);
    assert.doesNotMatch(m.text, /\{\w+\}/, `unfilled token: ${m.text}`);
  }
});

test('season radio: "Nice set, cap" after a plugged set; Pete welcomes a new season', async () => {
  const w = await makeWorld();
  for (let i = 0; i < 60; i++) w.step(0.1);
  assert.equal(w.radio[0]?.from, 'Uncle Pete', 'welcome comes first');
  assert.match(w.radio[0].text, /humpies/);
  w.ctx.clock.set(10, 0);
  w.radio.length = 0;
  w.ctx.events.emit('fishing:setComplete', { setNumber: 1, rating: 'plugged', totalLbs: 60000, waterHaul: false, cited: false });
  for (let i = 0; i < 400 && !w.radio.some((m) => /set|plugged|payment|found the fish/i.test(m.text)); i++) w.step(0.1);
  const line = w.radio.find((m) => /set|plugged|payment|found the fish/i.test(m.text));
  assert.ok(line, 'a fleet boat compliments the set');
  assert.equal(line.channel, '10');
});

test('season radio: ADF&G announces the next period the evening before, with the date', async () => {
  const w = await makeWorld();
  w.ctx.clock.set(18.9, 1);
  w.step(0.1);
  w.ctx.clock.set(19.05, 1);
  for (let i = 0; i < 1500; i++) w.step(0.1);
  const all = w.radio.filter((m) => m.from === 'ADF&G Kodiak');
  const adfg = all.slice(all.findIndex((m) => /emergency order/.test(m.text)));
  assert.ok(adfg.length >= 2, 'announcement + closed waters/escapement');
  assert.match(adfg[0].text, /6 a\.m\. until 10 p\.m\. Wednesday, July 8/);
  assert.match(adfg[0].text, /except the Alitak and Mainland Districts/);
  assert.equal(adfg[0].channel, '16');
  assert.match(adfg[1].text, /Closed waters/);
});

// ---- sleep, wait, anchor ----

test('sleep: offered at night when moored (priority 70); skips to 05:00 and autosaves', async () => {
  const w = await makeWorld();
  const { ctx } = w;
  ctx.clock.set(23, 3);
  w.step(0.1);
  assert.equal(w.offer('sleep'), null, 'not moored');
  ctx.systems.seiner.setMooring({ kind: 'anchor' });
  w.step(0.1);
  const o = w.offer('sleep');
  assert.ok(o);
  assert.equal(o.priority, 70);
  o.onPress();
  w.step(0.1);
  assert.equal(ctx.clock.day, 4);
  assert.ok(Math.abs(ctx.clock.hours - 5) < 1e-6);
  assert.ok(w.storage.getItem('kodiak-seiner:save'), 'autosaved after sleeping');
  ctx.clock.set(12, 4);
  assert.equal(w.season.canSleep().ok, false);
});

test('wait for the opener: closed day at anchor → 05:00 of the next fishing day', async () => {
  const w = await makeWorld();
  const { ctx } = w;
  ctx.clock.set(10, 5);
  ctx.systems.seiner.setMooring({ kind: 'anchor' });
  w.step(0.1);
  assert.equal(w.offer('waitOpener'), null, 'period is open');
  ctx.clock.set(10, 6);
  w.step(0.1);
  const o = w.offer('waitOpener');
  assert.ok(o, 'offered on a closed day');
  assert.equal(o.priority, 35);
  assert.match(o.label, /Wait for the opener — Wed Jul 15/);
  o.onPress();
  assert.equal(ctx.clock.day, 9);
  assert.ok(Math.abs(ctx.clock.hours - 5) < 1e-6);
  // In the small hours of a fishing day the wait runs to 05:00 that morning; within the last hour it is not offered.
  ctx.clock.set(3.5, 13);
  assert.equal(w.season.canWait().ok, true);
  w.season.waitForOpener();
  assert.equal(ctx.clock.day, 13);
  assert.ok(Math.abs(ctx.clock.hours - 5) < 1e-6);
  ctx.clock.set(5.5, 17);
  assert.equal(w.season.canWait().ok, false);
  ctx.clock.set(23, 47);
  assert.equal(w.season.canWait().ok, false, 'no periods left');
});

test('anchor: offered when stopped on a closed day in anchoring depth', async () => {
  const w = await makeWorld();
  const { ctx } = w;
  ctx.clock.set(12, 1);
  const p = ctx.systems.seiner.position;
  const depth = ctx.heightmap.depthAt(p.x, p.z);
  w.step(0.1);
  const o = w.offer('anchor');
  if (depth >= 3 && depth <= 70) {
    assert.ok(o);
    o.onPress();
    assert.deepEqual(ctx.systems.seiner.mooring, { kind: 'anchor' });
  } else {
    assert.equal(o, null);
  }
});

test('season: a skip across a whole closure reports both edges; the season ends once after the last period', async () => {
  const w = await makeWorld();
  const { ctx } = w;
  const got = [];
  ctx.events.on('opener:start', (e) => got.push(['start', e.day]));
  ctx.events.on('opener:end', (e) => got.push(['end', e.day]));
  const ends = [];
  ctx.events.on('season:end', (e) => ends.push(e.day));
  ctx.clock.set(12, 0);
  w.step(0.1);
  got.length = 0;
  ctx.clock.skip(48, 'travel'); // day 0 noon → day 2 noon, both open
  assert.deepEqual(got, [['end', 0], ['start', 2]]);
  ctx.clock.set(23, 45);
  ctx.clock.skip(30, 'wait');
  assert.deepEqual(ends, []);
  ctx.clock.set(21.9, 47);
  w.step(0.1);
  ctx.clock.advance(0.2);
  w.step(0.1);
  assert.deepEqual(ends, [47]);
  ctx.clock.skip(30, 'sleep');
  w.step(0.1);
  assert.deepEqual(ends, [47], 'once');
});
