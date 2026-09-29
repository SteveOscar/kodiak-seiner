// WP-RULES regression tests for the QA fix pass: harbor E priorities at night, the tow price, the spotter call after
// a New Season, rounded tender reports, the tutorial-quiet radio on the first set, the opening-minutes prompts, the
// rookery reminder and the pacing calibration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/core/config.js';
import { spokenDollars } from '../src/game/data/market.js';
import { makeWorld } from './rules-helpers.test.mjs';

// Real-time run: the clock advances 1 game minute per real second, as in play.
function run(w, seconds, dt = 0.1) {
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    w.ctx.clock.update(dt);
    w.step(dt);
  }
}

const clockOf = (ctx) => ctx.clock.hours;

// ---- [13] harbor at night ----

test('tied up at a harbor after 22:00: Sell, then Harbor services win E over Sleep; Sleep still leads at anchor', async () => {
  const w = await makeWorld();
  const { ctx, economy } = w;
  let opened = 0;
  ctx.systems.ui.openHarbor = () => opened++;
  ctx.clock.set(22.5, 0);
  economy.tieUp('kodiak');
  economy.addCatch({ pink: 3000 });
  w.step(0.1);
  assert.equal(w.best().id, 'deliver', 'selling at the dock wins E at night');
  assert.match(w.best().label, /Sell your catch at City of Kodiak/);
  const sleep = w.offer('sleep');
  assert.ok(sleep, 'sleep is still offered');
  assert.ok(sleep.priority < w.offer('harbor').priority, 'sleep ranks below Harbor services at a harbor');
  w.best().onPress();
  assert.equal(economy.holdLbs(), 0, 'sold');
  w.step(0.1);
  assert.equal(w.best().id, 'harbor', 'then E opens Harbor services (which has its own Sleep/Wait)');
  assert.match(w.best().label, /Harbor services/);
  w.best().onPress();
  assert.equal(opened, 1);
  // At anchor Sleep keeps its 70.
  ctx.systems.seiner.setMooring({ kind: 'anchor' });
  w.step(0.1);
  assert.equal(w.best().id, 'sleep');
  assert.equal(w.best().priority, 70);
});

// ---- [31] tow price ----

test('spokenDollars says money like the radio does', () => {
  assert.equal(spokenDollars(750), 'seven-fifty');
  assert.equal(spokenDollars(4500), 'forty-five hundred');
  assert.equal(spokenDollars(4000), 'four thousand');
  assert.equal(spokenDollars(1200), 'twelve hundred');
  assert.equal(spokenDollars(600), 'six hundred');
  assert.equal(spokenDollars(15000), 'fifteen thousand');
});

test('out of fuel: the tow prompt, radio and fade all quote the $4,500 total that is charged', async () => {
  const w = await makeWorld();
  const { ctx, economy: e } = w;
  const s = ctx.systems.seiner;
  const fades = [];
  ctx.events.on('ui:fade', (f) => fades.push(f));
  const t = ctx.systems.fleet.tenders[0];
  s.setPose(t.position.x + 800, t.position.z + 300, 0);
  ctx.clock.set(12, 1);
  e.useFuel(3000, 'test');
  assert.equal(e.towQuote().total, 4500);
  run(w, 20);
  const call = w.radio.find((m) => /out of fuel/.test(m.text));
  assert.ok(call, 'the tender radios the offer');
  assert.match(call.text, /seven-fifty for the tow/);
  assert.match(call.text, /forty-five hundred/);
  w.step(0.1);
  const o = w.offer('tow');
  assert.match(o.label, /\$4,500 incl\. 750 gal diesel/);
  const cash0 = e.cash;
  o.onPress();
  assert.equal(e.cash, cash0 - 4500);
  const fade = fades.find((f) => /Under tow/.test(f.title ?? ''));
  if (fade) assert.match(fade.subtitle, /\$4,500/);
});

// ---- [33] spotter after New Season ----

test('spotter plane calls again after a New Season and after loading an earlier save', async () => {
  const w = await makeWorld();
  const { ctx, economy, discovery } = w;
  const calls = () => w.radio.filter((m) => /Two-Seven Kilo/.test(m.from)).length;
  ctx.systems.fishing.setNumber = 5;
  ctx.clock.set(9, 13);
  economy.buy('spotter');
  const save = ctx.game.snapshot();
  run(w, 90);
  assert.equal(calls(), 1, 'called on day 13');
  // New Season: the clock goes back to day 0.
  ctx.game.start({ newGame: true });
  ctx.systems.fishing.setNumber = 5;
  ctx.clock.set(9, 0);
  economy.buy('spotter');
  run(w, 90);
  assert.equal(calls(), 2, 'called again after a New Season');
  // Loading the earlier save (day 13, 09:00) after the day-0 call: the absolute hour went forward, so also check a
  // load that moves the clock back.
  ctx.clock.set(20, 13);
  run(w, 30);
  ctx.game.load(save);
  ctx.systems.fishing.setNumber = 5;
  run(w, 90);
  assert.equal(calls(), 3, 'called again after loading an earlier save');
  assert.ok(discovery.recentSightings().some((m) => m.source === 'spotter'));
});

// ---- [46] tender report ----

test('tender daily-deliveries line rounds the player like the fleet (nearest 100 lb)', async () => {
  const w = await makeWorld();
  const { ctx, economy } = w;
  ctx.systems.fishing.setNumber = 3;
  ctx.clock.set(12, 0);
  run(w, 1);
  economy.addCatch({ pink: 16666 });
  economy.deliver(ctx.systems.fleet.tenders[0]);
  assert.ok(economy.stats.daily[0].lbs % 100 !== 0, 'the delivered weight is not round');
  ctx.clock.set(22.35, 0);
  run(w, 90);
  const rep = w.radio.find((m) => /daily deliveries/.test(m.text));
  assert.ok(rep, 'the tender reads the daily deliveries');
  const mine = rep.text.match(/Northern Dawn ([\d,]+)/);
  assert.ok(mine);
  assert.equal(Number(mine[1].replace(/,/g, '')) % 100, 0, rep.text);
});

// ---- [16] tutorial-quiet radio ----

test('new season: Pete, then ADF&G and its closed-waters follow-up, all before six; no fleet opener chatter', async () => {
  const w = await makeWorld();
  const { ctx } = w;
  const log = [];
  ctx.events.on('ui:radio', (m) => log.push({ h: clockOf(ctx), ...m }));
  run(w, 29);
  assert.ok(clockOf(ctx) < 6);
  assert.equal(log[0]?.from, 'Uncle Pete', 'welcome first');
  assert.match(log[0].text, /Opener's at six|Opens at six/);
  const adfg = log.filter((m) => m.from === 'ADF&G Kodiak');
  assert.equal(adfg.length, 2, 'reminder and closed-waters follow-up both aired before six');
  assert.match(adfg[0].text, /opens at 6 a\.m\. today/);
  assert.match(adfg[1].text, /Closed waters/);
  const before6 = log.length;
  run(w, 90); // 06:00–07:30, first set not yet made
  const after = log.slice(before6);
  assert.ok(!after.some((m) => /Six o'clock|we're open|Skiffs away|First set of the day/i.test(m.text)), 'no opener chatter');
  assert.ok(!after.some((m) => m.from === 'NOAA Weather Radio'), 'NOAA waits during the first set');
  assert.ok(after.length <= 2, `quiet while Pete teaches: ${after.map((m) => m.from).join(', ')}`);
  // The first set is done: the late morning forecast airs.
  ctx.systems.fishing.setNumber = 1;
  run(w, 60);
  assert.ok(log.some((m) => m.from === 'NOAA Weather Radio'), 'forecast after the first set');
});

test('a coaching tip holds routine radio traffic while it is read', async () => {
  const w = await makeWorld();
  const { ctx, season } = w;
  ctx.systems.fishing.setNumber = 4;
  ctx.clock.set(12, 0);
  run(w, 15);
  const n0 = w.radio.length;
  ctx.events.emit('ui:hint', { id: 'pete-purse', from: 'Uncle Pete', text: "Now purse her up. Hold E on the winch — keep the needle in the green. Don't horse it or you'll foul the rings." });
  season.radioSay({ from: 'Coast Guard Sector Anchorage', text: 'Securité test', channel: '16' }, { priority: 4 });
  run(w, 8);
  assert.equal(w.radio.length, n0, 'nothing airs over the tip');
  run(w, 20);
  assert.ok(w.radio.some((m) => m.text === 'Securité test'), 'held traffic airs after the tip');
});

// ---- [45] opening minutes ----

test('opening minutes: no "Drop anchor" before the first set; Pete says a quarter mile at ~400 m', async () => {
  const w = await makeWorld();
  const { ctx } = w;
  const s = ctx.systems.seiner;
  const p = s.position;
  ctx.clock.set(5.6, 0);
  w.step(0.1);
  assert.equal(w.offer('anchor'), null, 'no anchor offer before the first set');
  ctx.systems.fishing.setNumber = 1;
  ctx.clock.set(12, 1);
  w.step(0.1);
  const depth = ctx.heightmap.depthAt(p.x, p.z);
  if (depth >= 3 && depth <= 70) assert.ok(w.offer('anchor'), 'offered again on a closed day after the first set');
  // Pete's distance words from the tutorial school's real distance.
  for (const [d, words] of [[400, /a quarter mile/], [640, /half a mile/], [220, /a couple hundred yards/]]) {
    const w2 = await makeWorld({ start: false });
    const s2 = w2.ctx.systems.seiner;
    w2.ctx.systems.fish.schools = [{ id: 1, species: 'pink', state: 'milling', position: { x: s2.position.x, z: s2.position.z + d } }];
    w2.ctx.game.start({ newGame: true });
    const q = w2.ctx.systems.seiner.position;
    w2.ctx.systems.fish.schools[0].position = { x: q.x, z: q.z + d };
    run(w2, 6);
    const welcome = w2.radio.find((m) => m.from === 'Uncle Pete');
    assert.ok(welcome, 'welcome');
    assert.match(welcome.text, words, `${d} m: ${welcome.text}`);
    assert.match(welcome.text, /south of you/);
  }
});

test('the welcome is worded from the clock: after six Pete does not say it opens at six', async () => {
  const w = await makeWorld({ start: false });
  w.ctx.game.start({ newGame: true });
  w.ctx.clock.set(6.2, 0);
  run(w, 6);
  const welcome = w.radio.find((m) => m.from === 'Uncle Pete');
  assert.ok(welcome);
  assert.doesNotMatch(welcome.text, /at six/i);
  assert.match(welcome.text, /open/i);
  const adfg = w.radio.filter((m) => m.from === 'ADF&G Kodiak' && /reminds/.test(m.text));
  for (const m of adfg) assert.doesNotMatch(m.text, /opens at 6 a\.m\./);
});

// ---- rookery ----

test('entering the Marmot Island rookery buffer brings a NOAA Fisheries reminder about the no-approach zone', async () => {
  const w = await makeWorld();
  const { ctx } = w;
  ctx.systems.fishing.setNumber = 2;
  ctx.clock.set(12, 1);
  run(w, 20);
  ctx.events.emit('wildlife:disturbed', { kind: 'sealion', siteId: 'marmot-rookery', x: 0, z: 0, closed: false });
  run(w, 15);
  assert.ok(!w.radio.some((m) => m.from === 'NOAA Fisheries'), 'an ordinary haulout is not the rookery');
  ctx.events.emit('wildlife:disturbed', { kind: 'sealion', siteId: 'marmot-rookery', x: 0, z: 0, closed: true });
  run(w, 15);
  const r = w.radio.filter((m) => m.from === 'NOAA Fisheries');
  assert.equal(r.length, 1);
  assert.match(r[0].text, /Marmot Island/);
  assert.match(r[0].text, /three-mile no-approach zone/);
  assert.equal(r[0].channel, '16');
  ctx.events.emit('wildlife:disturbed', { kind: 'sealion', siteId: 'marmot-rookery', x: 0, z: 0, closed: true });
  run(w, 15);
  assert.equal(w.radio.filter((m) => m.from === 'NOAA Fisheries').length, 1, 'not repeated within the cooldown');
});

// ---- [32] pacing ----

test('pacing: goals land near SPEC 8.3 times for a competent player; the measured skipper is highliner pace', async () => {
  const { SEASON_GOALS, COMPETENT_DAILY, MINUTES_PER_PERIOD, competentGrossAfter, seasonFactor, FLEET } = await import('../src/game/data/fleetBoard.js');
  // Measured (qa/season/r3e): 4 good sets on Jul 6 in one period, $12,923; a competent player makes ~3 of those.
  const measuredDay0 = 12923;
  const f0 = seasonFactor(config, 0);
  assert.ok(Math.abs((measuredDay0 * 0.75) / f0 - COMPETENT_DAILY) / COMPETENT_DAILY < 0.05, 'competent = 3 of the 4 measured sets');
  for (const g of SEASON_GOALS) {
    const at = competentGrossAfter(config, g.minutes);
    assert.ok(Math.abs(at - g.gross) / g.gross < 0.1, `${g.label}: competent $${Math.round(at)} at ${g.minutes} min vs $${g.gross}`);
  }
  // The measured (scripted) skipper reaches the first goal inside the first two periods, not after ~12 minutes.
  const fast = (min) => competentGrossAfter(config, min) * (measuredDay0 / f0 / COMPETENT_DAILY);
  assert.ok(fast(MINUTES_PER_PERIOD) < SEASON_GOALS[0].gross, 'no first goal inside the first period');
  assert.ok(fast(25) >= SEASON_GOALS[0].gross, 'an efficient skipper beats the 25-minute mark');
  // The board's top boat's median Jul 6 day is in the measured skipper's range.
  const top = Math.max(...FLEET.map((b) => b.rate));
  assert.ok(Math.abs(COMPETENT_DAILY * top * f0 - measuredDay0) / measuredDay0 < 0.15);
  // Economy uses the ladder.
  const w = await makeWorld();
  assert.deepEqual(w.economy.goals().slice(0, 3).map((g) => g.gross), SEASON_GOALS.map((g) => g.gross));
});

export { run };
