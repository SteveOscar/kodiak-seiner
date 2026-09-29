// Arcade fishing mode (settings.fishingMode, default 'arcade'): the setting's default and persistence, the arcade
// set's automatic phases (durations, no winch / skiff tow / wheel / snags / corks under), the mode being read at
// let-go, and a catch comparable to a clean realistic set for the same enclosed school.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGame, OPEN } from './net-harness.test.mjs';
import { STUBS } from '../src/systems/stubs.js';
import { fakeCtx } from './contract.test.mjs';
import { DEFAULT_SETTINGS, SETTINGS_KEY, createSaveManager, mergeSettings } from '../src/game/save.js';
import { FISHING_TUNING } from '../src/entities/net/tuning.js';
import { createFishSim } from '../src/entities/fish/sim.js';
import { createWorldAdapter } from '../src/entities/fish/world.js';
import { pointInPolygon } from '../src/entities/fish/geom.js';
import { escapeSummary } from '../src/ui/lib/logic.js';

const CENTRE = { x: OPEN.x, z: OPEN.z - 60 };
const A = FISHING_TUNING.arcade;

// Stub fish milling at CENTRE whose harvest returns a fixed catch.
const fishOverride = (catchOf = { pink: 3000, chum: 0, sockeye: 0, coho: 0, king: 0 }) => ({
  fish(ctx) {
    const f = STUBS.fish(ctx);
    f.schools[0].position.set(CENTRE.x, -2, CENTRE.z);
    f.harvest = () => ({ ...catchOf });
    return f;
  },
});

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

// Lays a round haul around CENTRE and closes up. Returns the lay-out and close-up durations.
function layAndClose(g) {
  const F = g.fishing;
  g.seiner.setPose(OPEN.x, OPEN.z, Math.PI / 2);
  g.run(0.2);
  assert.equal(g.offer('action')?.id, 'fishing-letgo');
  g.press('action');
  assert.equal(F.state, 'setting');
  const t0 = g.ctx.time.elapsed;
  g.circle({ cx: CENTRE.x, cz: CENTRE.z, r: 60, turns: 1.2, stopWhen: () => F.hud.closeReady });
  const layout = g.ctx.time.elapsed - t0;
  assert.ok(F.hud.closeReady, 'came back to the skiff');
  assert.equal(g.offer('action')?.id, 'fishing-close');
  g.press('action');
  assert.equal(F.state, 'closing');
  const close = g.until(() => F.state === 'pursing', 40);
  return { layout, close };
}

test('settings: fishingMode defaults to arcade, is normalised and persists', () => {
  assert.equal(DEFAULT_SETTINGS.fishingMode, 'arcade');
  assert.equal(mergeSettings(null).fishingMode, 'arcade');
  assert.equal(mergeSettings({ fishingMode: 'bogus' }).fishingMode, 'arcade');
  assert.equal(mergeSettings({ quality: 'low' }).fishingMode, 'arcade', 'older settings without the key read as arcade');
  assert.equal(mergeSettings(null, { fishingMode: 'realistic' }).fishingMode, 'realistic');
  const storage = memoryStorage();
  const mgr = createSaveManager(null, storage);
  assert.equal(mgr.getSettings().fishingMode, 'arcade');
  const r = mgr.setSettings({ fishingMode: 'realistic' });
  assert.equal(r.settings.fishingMode, 'realistic');
  assert.equal(r.reload, false, 'switching modes needs no reload');
  assert.equal(JSON.parse(storage.getItem(SETTINGS_KEY)).fishingMode, 'realistic');
  // A fresh manager on the same storage (a reload) reads it back; other patches keep it.
  const again = createSaveManager(null, storage);
  assert.equal(again.getSettings().fishingMode, 'realistic');
  again.setSettings({ invertY: true });
  assert.equal(again.getSettings().fishingMode, 'realistic');
  again.setSettings({ fishingMode: 'arcade' });
  assert.equal(createSaveManager(null, storage).getSettings().fishingMode, 'arcade');
});

test('the fishing system reads the mode from the save manager at let-go', async () => {
  const ctx = fakeCtx();
  const storage = memoryStorage();
  ctx.systems.season = STUBS.season(ctx);
  ctx.systems.season.save = createSaveManager(null, storage);
  const { create } = await import('../src/game/fishing.js');
  const f = await create(ctx);
  assert.equal(f.core.settingMode, 'arcade');
  ctx.systems.season.save.setSettings({ fishingMode: 'realistic' });
  assert.equal(f.core.settingMode, 'realistic');
});

test('arcade set: the crew purses, hauls and brails in under 8 s with no winch, tow, wheel or corks', async () => {
  const g = await makeGame({ mode: 'arcade', overrides: fishOverride() });
  const F = g.fishing;
  const sk = g.ctx.systems.skiff;
  const calls = { towOff: 0, setTowHeading: 0, returnTo: 0 };
  for (const k of Object.keys(calls)) {
    const fn = sk[k];
    sk[k] = (...a) => {
      calls[k]++;
      return fn.apply(sk, a);
    };
  }
  // A strong current at the net: a realistic haul at this speed would sink the corks.
  g.ctx.tide.currentAt = (x, z, out = { x: 0, z: 0 }) => ((out.x = 0.5), (out.z = 0), out);
  const { layout, close } = layAndClose(g);
  assert.ok(layout > 30, `layout ${layout.toFixed(1)} s (the encircling is unchanged)`);
  assert.ok(close >= A.closeSeconds - 0.05 && close <= A.closeSeconds + 0.5, `close ${close.toFixed(2)} s`);
  assert.equal(F.hud.mode, 'arcade');
  const seen = { interact: new Set(), messages: new Set(), stalls: 0, corks: 0, tide: 0, tension: 0, unlocked: 0 };
  const watch = () => {
    const o = g.offer('interact');
    if (o) seen.interact.add(o.id);
    if (F.hud.message) seen.messages.add(F.hud.message);
    if (F.hud.stall) seen.stalls++;
    if (g.net.corksUnder) seen.corks++;
    if (F.hud.tideRunning) seen.tide++;
    if (F.hud.tension > 0 || F.core.winch.tension > 0) seen.tension++;
    if (g.seiner.controlsEnabled !== false && ['pursing', 'hauling', 'brailing'].includes(F.state)) seen.unlocked++;
    // Park the stern right over the middle of the corkline: a realistic set would get the net in the wheel.
    const sim = g.net.model.sim;
    if (sim.count > 20 && (F.state === 'pursing' || F.state === 'hauling')) {
      const i = Math.floor(sim.count / 2);
      g.seiner.setPose(sim.x[i], sim.z[i] + 8.8, 0);
    }
  };
  const t0 = g.ctx.time.elapsed;
  const purse = g.until(() => F.state !== 'pursing', 20, watch);
  assert.equal(F.state, 'hauling');
  const haul = g.until(() => F.state !== 'hauling', 20, watch);
  assert.equal(F.state, 'brailing');
  const brail = g.until(() => F.state !== 'brailing', 20, watch);
  assert.equal(F.state, 'report');
  const toReport = g.ctx.time.elapsed - t0;
  assert.ok(Math.abs(purse - A.purseSeconds) < 0.2, `purse ${purse.toFixed(2)} s`);
  assert.ok(Math.abs(haul - A.haulSeconds) < 0.2, `haul ${haul.toFixed(2)} s`);
  assert.ok(Math.abs(brail - A.brailSeconds) < 0.2, `brail ${brail.toFixed(2)} s`);
  assert.ok(toReport < 8, `close-up to report ${toReport.toFixed(2)} s`);
  console.log(`# arcade (sim seconds): close ${close.toFixed(2)}, purse ${purse.toFixed(2)}, haul ${haul.toFixed(2)}, brail ${brail.toFixed(2)}, close-up → report ${toReport.toFixed(2)}`);
  // No purse winch or block prompts, no tension, no stalls, no corks under, no tow-off.
  assert.deepEqual([...seen.interact].filter((id) => id.startsWith('fishing')), []);
  assert.equal(seen.tension, 0);
  assert.equal(seen.stalls, 0);
  assert.equal(seen.corks, 0);
  assert.equal(seen.tide, 0);
  assert.equal(seen.unlocked, 0, 'controls locked while the crew works');
  assert.equal(F.stats.wraps, 0, 'no net in the wheel');
  assert.equal(F.stats.fouls, 0);
  assert.equal(calls.towOff, 0);
  assert.equal(calls.setTowHeading, 0);
  assert.equal(calls.returnTo, 1, 'the skiff heads home at rings up');
  for (const m of seen.messages) assert.doesNotMatch(m, /winch|tension|A\/D|wheel|block|corks/i, m);
  // Uncle Pete's arcade lines, never the winch / skiff-pull ones.
  const hints = g.named('ui:hint').map((h) => h.id);
  assert.ok(hints.includes('pete-purseArcade') && hints.includes('pete-ringsUpArcade'), hints.join());
  for (const id of ['pete-purse', 'pete-tow', 'pete-ringsUp']) assert.ok(!hints.includes(id), id);
  for (const h of g.named('ui:hint')) assert.doesNotMatch(h.text, /Hold E|on the winch|A and D|skiff's pull|foul the rings|E speeds/i, h.id);
  // Report: controls back, and straight back to the fish.
  assert.equal(g.seiner.controlsEnabled, true);
  assert.equal(g.seiner.speedLimit, null);
  const p = g.named('fishing:setComplete')[0];
  assert.equal(p.mode, 'arcade');
  assert.equal(p.escapes.corks, 0);
  assert.equal(p.totalLbs, Math.round(3000 * g.ctx.config.fish.species.pink.lbs));
  const idle = g.until(() => F.state === 'idle', 10);
  assert.ok(idle <= A.skiffStowAfter + 0.2, `report → idle ${idle.toFixed(2)} s`);
  assert.equal(sk.state, 'stowed');
  assert.equal(g.net.state, 'stowed');
  assert.equal(g.net.arcade, false, 'the stowed net forgets the mode');
  g.run(0.2);
  assert.equal(g.offer('action')?.id, 'fishing-letgo', F.canSet().reason ?? '');
});

test('arcade close-up is offered from twice the realistic distance', async () => {
  const g = await makeGame({ mode: 'arcade' });
  const F = g.fishing;
  g.seiner.setPose(OPEN.x, OPEN.z, Math.PI / 2);
  g.run(0.2);
  g.press('action');
  let first = null;
  g.circle({ cx: CENTRE.x, cz: CENTRE.z, r: 60, turns: 1.2, stopWhen: () => F.hud.closeReady });
  first = F.hud.distanceToSkiff;
  const reach = g.ctx.config.net.closeDistance * A.closeFactor;
  assert.ok(first > g.ctx.config.net.closeDistance && first <= reach + 1, `offered at ${first} m (realistic ${g.ctx.config.net.closeDistance} m)`);
});

test('the mode is read at let-go: a set in progress keeps it, the next set uses the new setting', async () => {
  const g = await makeGame({ mode: 'arcade' });
  const F = g.fishing;
  g.run(1.1);
  assert.equal(F.hud.mode, 'arcade', 'idle HUD shows the setting');
  layAndClose(g);
  // Switch to realistic mid-set: this set stays arcade.
  g.settings.fishingMode = 'realistic';
  g.run(1.1);
  assert.equal(F.hud.mode, 'arcade');
  const toReport = g.until(() => F.state === 'report', 12);
  assert.ok(toReport < 8, `arcade phases ran (${toReport.toFixed(1)} s)`);
  assert.equal(g.named('fishing:setComplete')[0].mode, 'arcade');
  g.until(() => F.state === 'idle', 20);
  g.run(1.1);
  assert.equal(F.hud.mode, 'realistic', 'idle HUD follows the setting');
  // The next set is realistic: pursing waits on the winch (E) and the skiff tows off.
  g.ctx.systems.skiff.stow();
  layAndClose(g);
  assert.equal(F.hud.mode, 'realistic');
  assert.equal(g.net.arcade, false);
  assert.equal(g.ctx.systems.skiff.state, 'towingOff');
  g.run(5);
  assert.equal(F.state, 'pursing', 'no E, no purse');
  assert.equal(g.offer('interact')?.id, 'fishing-purse');
  assert.ok(g.net.pursed < 0.05);
  // And back again for a third set.
  F.abort();
  g.until(() => F.state === 'idle', 60);
  g.settings.fishingMode = 'arcade';
  g.ctx.systems.skiff.stow();
  g.seiner.setPose(OPEN.x, OPEN.z, Math.PI / 2);
  g.run(0.2);
  g.press('action');
  assert.equal(F.hud.mode, 'arcade');
  assert.equal(g.net.arcade, true);
});

test('arcade net: no hang-ups on rock and no smooth-bottom slow-down', async () => {
  const g = await makeGame({ mode: 'arcade' });
  const F = g.fishing;
  layAndClose(g);
  const hm = g.ctx.heightmap;
  const { depthAt, seabedAt } = hm;
  hm.depthAt = () => 6;
  hm.seabedAt = () => 'rock';
  g.net.model.sim.invalidateSeabed();
  // Hold the purse open for a minute on rock (a realistic purse at this speed would hang up within seconds).
  g.until(
    () => F.state !== 'pursing',
    60,
    () => {
      if (g.net.model.pursed > 0.8) g.net.model.pursed = 0.2;
    },
  );
  assert.ok(g.net.bottomContact > 0.5, `leads on the bottom (${g.net.bottomContact})`);
  assert.equal(g.net.snagCount, 0);
  assert.equal(g.named('fishing:snag').length, 0);
  assert.equal(F.hud.stall, null);
  hm.seabedAt = () => 'sand';
  g.net.model.sim.invalidateSeabed();
  g.frame();
  g.net.model.pursed = 0.2;
  g.frame();
  assert.ok(Math.abs(g.net.purseRate - 1 / A.purseSeconds) < 1e-9, `rate ${g.net.purseRate}`);
  hm.depthAt = depthAt;
  hm.seabedAt = seabedAt;
});

// Records the net's state each frame from close-up until brailing, for replay against the real fish simulation.
async function netTrace(mode) {
  const g = await makeGame({ mode });
  const F = g.fishing;
  layAndClose(g);
  const trace = [];
  const rec = () => trace.push({ state: g.net.state, pursed: g.net.pursed, hauled: g.net.hauled, corksUnder: g.net.corksUnder, closed: g.net.closed });
  g.until(
    () => F.state === 'brailing',
    120,
    () => {
      rec();
      if (F.state !== 'pursing') return g.held.delete('interact');
      const [lo, hi] = F.hud.tensionBand;
      if (F.hud.tension > lo + (hi - lo) * 0.7) g.held.delete('interact');
      else if (F.hud.tension < lo + (hi - lo) * 0.35) g.held.add('interact');
    },
  );
  return { trace, dt: g.dt };
}

const circle = (cx, cz, r, n = 36) => Array.from({ length: n }, (_, i) => ({ x: cx + Math.cos((i / n) * 2 * Math.PI) * r, z: cz + Math.sin((i / n) * 2 * Math.PI) * r }));

// Replays a net trace around a 4,000-pink school with WP-FISH's simulation; returns the harvest fraction.
function replay({ trace, dt }, seed) {
  const ctx = fakeCtx();
  ctx.rng = ctx.rng.fork(`replay-${seed}`);
  for (const n of ['season', 'places', 'seiner']) ctx.systems[n] = STUBS[n](ctx);
  const sp = ctx.systems.places.spawn;
  ctx.clock.set(9, 1);
  const w = ctx.heightmap.nearestWater(sp.x + 900, sp.z + 300, { minShore: 300 });
  ctx.systems.seiner.setPose(w.x + 400, w.z, 0);
  const world = createWorldAdapter(ctx);
  world.inView = () => false;
  world.boats = () => [];
  const net = { state: 'stowed', pursed: 0, hauled: 0, bottomContact: 0, depth: 16, hole: false, corksUnder: false, closed: false, poly: null };
  net.polygon = () => net.poly;
  net.gap = () => null;
  net.containsPoint = (x, z) => !!net.poly && pointInPolygon(x, z, net.poly);
  world.net = () => net;
  const sim = createFishSim({ config: ctx.config, rng: ctx.rng.fork('fish'), world });
  sim.update(1 / 30);
  for (const s of [...sim.schools]) if (Math.hypot(s.position.x - w.x, s.position.z - w.z) < 400) s.state = 'gone';
  sim.update(1 / 30);
  const s = sim.spawnSchool({ x: w.x, z: w.z, species: 'pink', count: 4000, spookable: false });
  s.radius = 14;
  const initial = s.count;
  net.poly = circle(w.x, w.z, 60);
  for (const f of trace) {
    Object.assign(net, f);
    ctx.clock.advance(dt / 60);
    sim.update(dt);
  }
  const got = sim.harvest();
  return Object.values(got).reduce((a, b) => a + b, 0) / initial;
}

test('arcade catches about what a clean realistic set does for the same enclosed school', async () => {
  const arc = await netTrace('arcade');
  const real = await netTrace('realistic');
  const secs = (t) => t.trace.length * t.dt;
  assert.ok(secs(arc) < 6, `arcade close-up → brailing ${secs(arc).toFixed(1)} s`);
  assert.ok(secs(real) > 35, `realistic close-up → brailing ${secs(real).toFixed(1)} s`);
  const fa = [1, 2, 3].map((k) => replay(arc, k));
  const fr = [1, 2, 3].map((k) => replay(real, k));
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const [ma, mr] = [mean(fa), mean(fr)];
  console.log(`# catch fraction (4,000 pinks, same circle): arcade ${fa.map((x) => x.toFixed(3)).join('/')}, realistic ${fr.map((x) => x.toFixed(3)).join('/')}`);
  const [lo, hi] = [0.6, 0.85]; // pink clean-set capture range (config)
  assert.ok(mr >= lo && mr <= hi, `realistic ${mr.toFixed(3)}`);
  assert.ok(ma >= lo && ma <= hi + 0.005, `arcade ${ma.toFixed(3)}`);
  assert.ok(ma / mr > 0.9 && ma / mr < 1.15, `arcade ${ma.toFixed(3)} vs realistic ${mr.toFixed(3)}`);
});

test('the set report explains escapes in arcade terms', () => {
  const leads = escapeSummary({ mode: 'arcade', escapes: { leads: 560, corks: 10, gap: 120, hole: 0, overflow: 0 } });
  assert.equal(leads.cause, 'leads');
  assert.doesNotMatch(leads.text, /Purse up faster/);
  assert.match(leads.text, /under the leadline/);
  const corks = escapeSummary({ mode: 'arcade', escapes: { corks: 300 } });
  assert.doesNotMatch(corks.text, /Ease off the block/);
  assert.match(corks.text, /tide/i);
  const gap = escapeSummary({ mode: 'arcade', escapes: { gap: 900, leads: 100 } });
  assert.match(gap.text, /Close up sooner/);
  // Realistic lessons are unchanged.
  assert.match(escapeSummary({ mode: 'realistic', escapes: { leads: 500 } }).text, /Purse up faster/);
  assert.match(escapeSummary({ escapes: { corks: 500 } }).text, /Ease off the block/);
});
