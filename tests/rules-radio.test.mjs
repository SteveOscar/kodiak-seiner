// WP-RULES radio polish: the fleet's bear-charge quip follows where the deckhand ended up (beside the skiff or put back
// aboard), and the radio library agrees with the current mechanics (goal ladder, sellers, prices, RSW, tow, welcome).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LINES } from '../src/game/data/radioLines.js';
import { SEASON_GOALS } from '../src/game/data/fleetBoard.js';
import { UPGRADES } from '../src/game/data/upgrades.js';
import { PLACES } from '../src/data/places.js';
import { ambientWeights } from '../src/game/data/radio.js';
import { makeWorld } from './rules-helpers.test.mjs';

function run(w, seconds, dt = 0.1) {
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    if (w.ctx.state.mode === 'play') w.ctx.clock.update(dt);
    w.step(dt);
  }
}

// A quiet mid-day on a closed day after the first set, with the queue cleared, so only the quip under test is queued.
async function quietWorld() {
  const w = await makeWorld();
  const { ctx } = w;
  ctx.systems.fishing.setNumber = 5;
  ctx.clock.set(12, 1);
  ctx.events.emit('time:skip', { hours: 0, reason: 'test' });
  w.radio.length = 0;
  return w;
}

const filled = (w, list) => list.map((l) => l.replaceAll('{me}', w.ctx.systems.seiner.boatName));
const said = (w, list) => w.radio.filter((m) => filled(w, list).includes(m.text));

// Mirrors player.js: on foot → charge (phase 'retreat', cutscene) → fade → one of the two outcomes.
function fakePlayer(w) {
  const p = { active: true, phase: 'foot', position: w.ctx.systems.seiner.position.clone() };
  w.ctx.systems.player = p;
  w.ctx.state.control = 'foot';
  return p;
}
function charge(w, p) {
  w.ctx.events.emit('bear:encounter', { stage: 'charge', bearId: 'bear-4' });
  if (p) p.phase = 'retreat';
  w.ctx.game.setMode('cutscene');
}
function putAboard(w, p) {
  w.ctx.state.control = 'boat';
  w.ctx.events.emit('player:mode', { control: 'boat' });
  if (p) {
    p.phase = 'aboard';
    p.active = false;
  }
  w.ctx.game.setMode('play');
}
function besideSkiff(w, p) {
  if (p) p.phase = 'foot';
  w.ctx.game.setMode('play');
}

test('bear charge that ends with the deckhand put back aboard: the fleet says so, never "back to the skiff"', async () => {
  const w = await quietWorld();
  const p = fakePlayer(w);
  charge(w, p);
  run(w, 2.6);
  putAboard(w, p);
  run(w, 40);
  assert.equal(said(w, LINES.bearCharge).length, 0, 'no skiff line');
  assert.equal(said(w, LINES.bearChargeAboard).length, 1, w.radio.map((m) => m.text).join(' | '));
  const m = said(w, LINES.bearChargeAboard)[0];
  assert.equal(m.channel, '10');
  assert.doesNotMatch(m.text, /back to the skiff/);
});

test('bear charge that ends beside the landed skiff: the skiff line, after the Skiffman has had his say', async () => {
  const w = await quietWorld();
  const p = fakePlayer(w);
  charge(w, p);
  run(w, 2.6);
  run(w, 2.4); // the fade, still in the cutscene
  assert.equal(w.radio.length, 0);
  besideSkiff(w, p);
  run(w, 5);
  assert.equal(said(w, LINES.bearCharge).length, 0, 'held back (delay) behind the Skiffman quip');
  run(w, 35);
  assert.equal(said(w, LINES.bearChargeAboard).length, 0);
  assert.equal(said(w, LINES.bearCharge).length, 1, w.radio.map((m) => m.text).join(' | '));
});

test('a charge the player never reacted to, or one while aboard, says nothing', async () => {
  const w = await quietWorld();
  const p = fakePlayer(w);
  // player.js ignores a charge outside foot/play: no retreat phase ever starts.
  w.ctx.events.emit('bear:encounter', { stage: 'charge', bearId: 'bear-1' });
  run(w, 40);
  assert.equal(said(w, [...LINES.bearCharge, ...LINES.bearChargeAboard]).length, 0);
  // Aboard the seiner (a bear charging someone else on the beach).
  w.ctx.state.control = 'boat';
  p.phase = 'aboard';
  w.ctx.events.emit('bear:encounter', { stage: 'charge', bearId: 'bear-2' });
  run(w, 40);
  assert.equal(said(w, [...LINES.bearCharge, ...LINES.bearChargeAboard]).length, 0);
});

test('without a player.phase field the cutscene stands in for the retreat (both outcomes)', async () => {
  for (const [outcome, list] of [['aboard', LINES.bearChargeAboard], ['skiff', LINES.bearCharge]]) {
    const w = await quietWorld();
    w.ctx.state.control = 'foot'; // the stub player has no phase
    charge(w, null);
    run(w, 3.5);
    if (outcome === 'aboard') putAboard(w, null);
    else besideSkiff(w, null);
    run(w, 40);
    assert.equal(said(w, list).length, 1, `${outcome}: ${w.radio.map((m) => m.text).join(' | ')}`);
    assert.equal(said(w, outcome === 'aboard' ? LINES.bearCharge : LINES.bearChargeAboard).length, 0);
  }
});

test('pausing mid-fade does not drop the bear quip', async () => {
  const w = await quietWorld();
  const p = fakePlayer(w);
  charge(w, p);
  run(w, 1.5);
  w.ctx.game.setMode('paused');
  run(w, 60);
  w.ctx.game.setMode('cutscene');
  run(w, 1.5);
  putAboard(w, p);
  run(w, 40);
  assert.equal(said(w, LINES.bearChargeAboard).length, 1);
});

test('the bear lines match the outcome they are used for', () => {
  for (const l of LINES.bearChargeAboard) assert.doesNotMatch(l, /back to the skiff|stay (close|by|near)/i, l);
  for (const l of LINES.bearCharge) assert.doesNotMatch(l, /aboard|off the island|another landing/i, l);
});

// ---- the library against the mechanics ----

test('every radio category composes from the season tokens without a raw {token}', async () => {
  const w = await makeWorld();
  const kinds = { tender: 'tender', delivered: 'tender', lowFuel: 'tender', tow: 'tender', highliner: 'tender', pete: 'pete', holdFull: 'pete', uscg: 'uscg' };
  // delivered's {lbs} comes with economy:delivered; every other token is the season's own.
  const extras = { delivered: { lbs: '12,300' } };
  const presets = ['clear', 'partly', 'overcast', 'rain', 'fog', 'storm'];
  let n = 0;
  for (const [cat, list] of Object.entries(LINES)) {
    for (const preset of cat === 'weather' ? presets : [null]) {
      for (let i = 0; i < list.length + 2; i++) {
        const m = w.season.say(cat, { kind: kinds[cat] ?? 'fleet', extra: extras[cat] ?? {}, preset }, {});
        assert.ok(m, `${cat} composes`);
        assert.doesNotMatch(m.text, /\{\w+\}/, `${cat}: ${m.text}`);
        assert.match(m.text, /^[^a-z]/, `${cat} starts a sentence: ${m.text}`);
        n++;
      }
    }
  }
  assert.ok(n > 200);
});

test("Pete's goal lines follow the goal ladder, and the highliner line names the boat just passed", async () => {
  assert.equal(LINES.goal.length, SEASON_GOALS.length);
  const words = [/grub and fuel/i, /permit loan/i, /boat payment/i];
  SEASON_GOALS.forEach((g, i) => {
    assert.match(g.label, words[i]);
    assert.match(LINES.goal[i], words[i]);
  });
  assert.deepEqual(SEASON_GOALS.map((g) => g.gross), [15000, 65000, 120000]);
  const w = await quietWorld();
  const rival = w.season.fleetBoard().find((r) => !r.player).name;
  w.ctx.events.emit('economy:goal', { label: 'Highliner', gross: 250000, index: 3 });
  run(w, 20);
  const m = w.radio.find((r) => /highliner/.test(r.text));
  assert.ok(m, 'highliner line');
  assert.ok(m.text.includes(`${rival}'s not gonna like`), m.text);
  // The tender reads it in its own voice, on its own channel.
  const tender = w.ctx.systems.fleet.tenders.find((t) => t.name === m.from);
  assert.ok(tender, `from a tender: ${m.from}`);
  assert.ok(m.text.startsWith(`${tender.name} here.`), m.text);
  assert.equal(m.channel, w.season.tenderChannel(tender));
  w.ctx.events.emit('economy:goal', { label: SEASON_GOALS[1].label, gross: 65000, index: 1 });
  run(w, 20);
  assert.ok(w.radio.some((r) => r.from === 'Uncle Pete' && /Permit loan paid off/.test(r.text)));
});

test('where the radio says to sell matches the buyers: tenders, the town and the canneries', () => {
  const sellers = PLACES.filter((p) => (p.services ?? []).includes('sell'));
  assert.ok(sellers.length >= 2);
  for (const p of sellers) assert.ok(p.kind === 'town' || p.kind === 'cannery', `${p.name} (${p.kind}) buys fish`);
  assert.match(LINES.holdFull[0], /tender/);
  assert.match(LINES.holdFull[0], /in town or at a cannery/);
});

test('price lines quote the tender whose price they carry, never "the cannery"', () => {
  for (const l of LINES.prices) {
    if (/\{(pinkc|redc|dogc|silverc)\}/.test(l)) assert.doesNotMatch(l, /cannery/i, l);
  }
  // "a nickel over for chilled fish" is the RSW upgrade's bonus.
  const rsw = UPGRADES.find((u) => u.id === 'rsw').tiers[0].effect.rswBonus;
  assert.equal(rsw, 0.05);
  assert.ok(LINES.prices.some((l) => /RSW/.test(l) && /nickel over/.test(l)));
});

test('the tow call quotes the fee and the total that is charged', () => {
  assert.equal(LINES.tow.length, 1);
  assert.match(LINES.tow[0], /\{towFee\}/);
  assert.match(LINES.tow[0], /\{towTotal\}/);
});

test("Pete's welcome points at the pink tutorial school, and never calls another species humpies", async () => {
  const at = async (schools) => {
    const w = await makeWorld({ start: false });
    w.ctx.systems.fish.schools = [];
    w.ctx.game.start({ newGame: true });
    const q = w.ctx.systems.seiner.position;
    w.ctx.systems.fish.schools = schools.map((s, i) => ({ id: i + 1, state: 'milling', ...s, position: { x: q.x, z: q.z + s.d } }));
    run(w, 6);
    return w.radio.find((m) => m.from === 'Uncle Pete')?.text ?? '';
  };
  // The tutorial school (400 m) wins over a closer ordinary pink school.
  assert.match(await at([{ species: 'pink', d: 230 }, { species: 'pink', d: 400, tutorial: true }]), /a quarter mile/);
  // A chum school alone is not "humpies milling": the general welcome instead.
  const chum = await at([{ species: 'chum', d: 400 }]);
  assert.doesNotMatch(chum, /milling|popping a quarter mile/);
  assert.match(chum, /Watch for jumpers/);
});

test('closed-day chatter stays off opener mornings and the night after a period', () => {
  assert.ok(ambientWeights({ open: false, hours: 14, fishingDay: false }).closed > 0, 'a closed day');
  assert.ok(ambientWeights({ open: false, hours: 22.5, fishingDay: false }).closed > 0, 'a closed-day night');
  for (const hours of [5.2, 5.8, 22.1, 22.9]) {
    const w = ambientWeights({ open: false, hours, fishingDay: true });
    assert.ok(!w.closed, `fishing day at ${hours}: ${JSON.stringify(w)}`);
    assert.ok(Object.values(w).some((v) => v > 0), 'something else still airs');
  }
  assert.ok(ambientWeights({ open: false, hours: 5.5, fishingDay: true }).morning > 0);
  // The evening lines air from 20:30, before sunset for most of the season: none of them says it is dark.
  for (const l of LINES.evening) assert.doesNotMatch(l, /\bdark\b|tonight's dark/i, l);
});

test("the tender's daily report signs off for the season after the last period, not \"see you next period\"", async () => {
  const report = async (day) => {
    const w = await makeWorld();
    w.ctx.systems.fishing.setNumber = 3;
    w.ctx.clock.set(12, day);
    run(w, 1);
    w.ctx.clock.set(22.35, day);
    run(w, 90);
    return w.radio.find((m) => /daily deliveries/.test(m.text))?.text ?? '';
  };
  const days = (await makeWorld()).ctx.config.season.fishingDays;
  const mid = await report(days[1]);
  assert.match(mid, /see you next period/, mid);
  const last = await report(days[days.length - 1]);
  assert.match(last, /That's the season/, last);
  assert.doesNotMatch(last, /next period/, last);
});
