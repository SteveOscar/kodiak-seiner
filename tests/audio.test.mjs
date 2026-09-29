// WP-AUDIO pure logic: parameter mappings, engine model, splash plans, music, scene analysis, DSP helpers and the
// voice limiter. Node-only (no WebAudio); the graph-level tests with a mock AudioContext live in audio-graph.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCtx } from './contract.test.mjs';
import { missingMembers } from '../src/systems/contract.js';
import * as P from '../src/audio/params.js';
import * as Sc from '../src/audio/scene.js';
import * as D from '../src/audio/dsp.js';
import { createVoiceTable } from '../src/audio/voices.js';
import { createComposer, MOODS, SCALES, chordTones, noteOf } from '../src/audio/composer.js';
import { SOUNDS } from '../src/audio/sfx.js';
import { create } from '../src/audio/audio.js';
import { resolve } from '../src/data/places.js';
import { mulberry32 } from '../src/core/rng.js';

const seq = (seed = 7) => mulberry32(seed);

// ------------------------------------------------------------------------------------------------ system shell
test('audio constructs under Node (no WebAudio) with the full contract and stays inert', async () => {
  const ctx = fakeCtx();
  const sys = await create(ctx);
  ctx.systems.audio = sys;
  assert.deepEqual(missingMembers('audio', sys), []);
  assert.equal(sys.unlock(), false);
  assert.equal(sys.play('horn', { position: { x: 0, y: 0, z: 0 } }), null);
  assert.equal(sys.play('no-such-sound'), null);
  const v = sys.setVolumes({ music: 0.25, bogus: 3, sfx: 'x' });
  assert.equal(v.music, 0.25);
  assert.equal(v.sfx, P.DEFAULT_VOLUMES.sfx);
  assert.equal(v.bogus, undefined);
  sys.muted = true;
  assert.equal(sys.muted, true);
  sys.frame(0.016);
  sys.update?.(0.016);
  sys.reset();
  assert.equal(sys.serialize(), undefined);
  const ds = sys.debugState();
  assert.equal(ds.ready, false);
  assert.doesNotThrow(() => JSON.stringify(ds));
  // Events before unlock are ignored quietly.
  ctx.events.emit('fish:jump', { x: 0, y: 0, z: 0, species: 'pink' });
  ctx.events.emit('ui:radio', { from: 'x', text: 'hello' });
  assert.ok(sys.sounds.includes('fish-jump'));
});

// -------------------------------------------------------------------------------------------------- volumes
test('volume curve and merge', () => {
  assert.equal(P.volumeCurve(0), 0);
  assert.equal(P.volumeCurve(1), 1);
  assert.ok(Math.abs(P.volumeCurve(0.5) - 0.25) < 1e-9);
  assert.equal(P.volumeCurve(7), 1);
  assert.equal(P.volumeCurve('nope'), 0);
  const m = P.mergeVolumes({ master: 0.5 }, { music: 2, sfx: -1, ambience: null, master: NaN });
  assert.deepEqual(m, { master: 0.5, music: 1, sfx: 0, ambience: P.DEFAULT_VOLUMES.ambience });
});

test('distance helpers: air absorption, travel time', () => {
  assert.ok(P.airCutoff(2000) < P.airCutoff(200));
  assert.ok(P.airCutoff(1e6) >= 700);
  assert.equal(P.travelDelay(30), 0);
  assert.ok(Math.abs(P.travelDelay(403) - 1) < 0.01);
  assert.equal(P.travelDelay(1e6), 6);
});

// -------------------------------------------------------------------------------------------------- the sea
test('ocean: louder and brighter near the surf, quieter high up and inland, muffled in the wheelhouse', () => {
  const off = P.oceanParams({ shoreDist: 1200, camHeight: 15, hs: 0.8 });
  const near = P.oceanParams({ shoreDist: 50, camHeight: 15, hs: 0.8 });
  assert.ok(near.surfGain > off.surfGain * 1.8, 'surf louder near shore');
  assert.ok(near.surfCutoff > off.surfCutoff + 1000, 'surf brighter near shore');
  assert.ok(near.washLevel > 0.1 && off.washLevel === 0, 'wash only near beaches');
  const high = P.oceanParams({ shoreDist: 200, camHeight: 220, hs: 0.8 });
  const low = P.oceanParams({ shoreDist: 200, camHeight: 5, hs: 0.8 });
  assert.ok(high.deepGain < low.deepGain * 0.5, 'quieter high up on foot');
  const inland = P.oceanParams({ shoreDist: -900, camHeight: 5, hs: 0.8 });
  assert.ok(inland.deepGain < low.deepGain * 0.05 && inland.washLevel < 0.01, 'fades inland');
  const room = P.oceanParams({ shoreDist: 200, camHeight: 5, hs: 0.8, interior: 1 });
  assert.ok(room.surfGain < low.surfGain && room.surfCutoff < low.surfCutoff);
  const storm = P.oceanParams({ shoreDist: 800, camHeight: 15, hs: 3 });
  assert.ok(storm.deepGain > off.deepGain && storm.swellHz < off.swellHz);
  for (const o of [off, near, high, low, inland, room, storm]) for (const v of Object.values(o)) assert.ok(Number.isFinite(v));
  assert.ok(near.lapGain > 0 && high.lapGain < low.lapGain && room.lapGain < low.lapGain);
  const lap = {};
  const lr = seq(12);
  let lmin = 9;
  let lmax = 0;
  for (let i = 0; i < 3000; i++) {
    const e = P.lapStep(lap, 1 / 30, 1.2, lr);
    lmin = Math.min(lmin, e);
    lmax = Math.max(lmax, e);
  }
  assert.ok(lmin >= 0.2 && lmax <= 1.2 && lmax - lmin > 0.4, `lapping swells (${lmin}..${lmax})`);
  const r = seq();
  for (let i = 0; i < 50; i++) {
    const w = P.washInterval(Math.random() * 3, r());
    assert.ok(w >= 6 && w <= 12);
  }
});

test('wind: grows with wind speed, whistles in the rigging only aboard, gusts stay bounded', () => {
  const calm = P.windParams({ windSpeed: 2 });
  const breeze = P.windParams({ windSpeed: 8 });
  const gale = P.windParams({ windSpeed: 18, gust: 0.9 });
  assert.ok(calm.gain < breeze.gain && breeze.gain < gale.gain);
  assert.ok(gale.centre > calm.centre);
  assert.ok(gale.whistleGain > 0 && calm.whistleGain === 0);
  assert.equal(P.windParams({ windSpeed: 18, onFoot: true }).whistleGain, 0);
  assert.ok(P.windParams({ windSpeed: 12, interior: 1 }).gain < P.windParams({ windSpeed: 12 }).gain);
  let g = { value: 0.5 };
  const r = seq(3);
  let lo = 1;
  let hi = 0;
  for (let i = 0; i < 4000; i++) {
    g = P.gustStep(g, 1 / 30, r());
    assert.ok(g.value >= 0 && g.value <= 1);
    lo = Math.min(lo, g.value);
    hi = Math.max(hi, g.value);
  }
  assert.ok(hi - lo > 0.2, 'gusts wander');
});

test('rain: silent when dry, drums on the roof, hiss outdoors', () => {
  const dry = P.rainParams({ rain: 0 });
  assert.equal(dry.patterGain, 0);
  assert.equal(dry.hissGain, 0);
  const deck = P.rainParams({ rain: 0.8 });
  const roof = P.rainParams({ rain: 0.8, interior: 1 });
  assert.ok(deck.patterGain > 0.1);
  assert.ok(roof.patterCutoff < deck.patterCutoff && roof.hissGain < deck.hissGain && roof.patterGain > deck.patterGain);
});

// ---------------------------------------------------------------------------------------------------- engines
test('diesel engine: cranks, catches, follows the throttle, runs down', () => {
  const st = P.newEngineState();
  const cfg = P.DIESELS.main;
  const evs = [];
  for (let i = 0; i < 40; i++) {
    const e = P.engineStep(st, { throttle: 0, load: 0, running: true }, cfg, 0.05);
    if (e) evs.push(e);
  }
  assert.deepEqual(evs, ['start', 'catch']);
  for (let i = 0; i < 200; i++) P.engineStep(st, { throttle: 0, load: 0, running: true }, cfg, 0.05);
  assert.ok(Math.abs(st.rpm - cfg.idleRpm) < 30, `idles near ${cfg.idleRpm}: ${st.rpm}`);
  for (let i = 0; i < 300; i++) P.engineStep(st, { throttle: 1, load: 0.9, running: true }, cfg, 0.05);
  assert.ok(st.rpm > cfg.maxRpm * 0.93, `full ahead ${st.rpm}`);
  const v = P.dieselVoice(st, cfg);
  assert.ok(Math.abs(v.cycleHz - st.rpm / 120) < 1e-9);
  assert.ok(Math.abs(v.firingHz - (st.rpm / 120) * 6) < 1e-9);
  const idleV = P.dieselVoice({ ...st, rpm: cfg.idleRpm, load: 0 }, cfg);
  assert.ok(v.gain > idleV.gain && v.cutoff > idleV.cutoff && v.exhaust > idleV.exhaust);
  // Hydraulic demand holds the rpm up with the lever at neutral.
  const d = P.newEngineState();
  for (let i = 0; i < 400; i++) P.engineStep(d, { throttle: 0, running: true, demand: 0.5 }, cfg, 0.05);
  assert.ok(d.rpm > cfg.idleRpm + 0.4 * (cfg.maxRpm - cfg.idleRpm));
  assert.equal(P.engineStep(st, { running: false }, cfg, 0.05), 'stop');
  for (let i = 0; i < 200; i++) P.engineStep(st, { running: false }, cfg, 0.05);
  assert.equal(st.rpm, 0);
  assert.ok(st.on < 0.01);
  // A warm engine restarting catches without the starter.
  const w = { phase: 'off', rpm: 600, load: 0, on: 0.5, crank: 0 };
  assert.equal(P.engineStep(w, { running: true }, cfg, 0.05), null);
  assert.equal(w.phase, 'running');
});

test('skiff effort and hydraulics', () => {
  assert.equal(P.skiffEffortFor('stowed'), null);
  assert.equal(P.skiffEffortFor('tied'), null);
  assert.ok(P.skiffEffortFor('towing') > P.skiffEffortFor('holding'));
  assert.equal(P.hydraulicParams({ mode: null }).gain, 0);
  const slow = P.hydraulicParams({ mode: 'haul', rate: 0.2, engineRpm: 900 });
  const fast = P.hydraulicParams({ mode: 'haul', rate: 1, engineRpm: 1500 });
  assert.ok(fast.gain > slow.gain && fast.whineHz > slow.whineHz && fast.corkRate > slow.corkRate);
  assert.ok(P.hydraulicParams({ mode: 'purse', rate: 0.5 }).rumble > P.hydraulicParams({ mode: 'haul', rate: 0.5 }).rumble);
  assert.equal(P.hullWashParams(0).gain, 0);
  assert.ok(P.hullWashParams(10).gain > P.hullWashParams(3).gain);
});

// -------------------------------------------------------------------------------------------------- one-shots
test('splash plans differ by species and scale with the fish', () => {
  const r = seq(11);
  const pink = P.splashPlan({ species: 'pink' }, r);
  const chum = P.splashPlan({ species: 'chum' }, r);
  const coho = P.splashPlan({ species: 'coho' }, r);
  const sock = P.splashPlan({ species: 'sockeye' }, r);
  const king = P.splashPlan({ species: 'king' }, r);
  const max = (pl) => Math.max(...pl.map((h) => h.strength));
  assert.ok(chum.some((h) => h.kind === 'slap' && h.slap >= 1), 'chum falls flat');
  assert.ok(max(chum) > max(pink) * 1.5, 'chum splash is heavier than popcorn');
  assert.ok(coho.filter((h) => h.kind === 'walk').length >= 4, 'coho tail-walks');
  assert.ok(sock.filter((h) => h.kind === 'entry').length === 1 && sock.every((h) => h.slap === 0), 'sockeye re-enters clean');
  assert.ok(king.every((h) => h.kind === 'swirl'));
  const big = P.splashPlan({ species: 'pink', size: 0.9, style: 'popcorn' }, seq(2));
  const small = P.splashPlan({ species: 'pink', size: 0.35, style: 'popcorn' }, seq(2));
  assert.ok(max(big) > max(small) && big[1].bodyHz < small[1].bodyHz, 'bigger fish: louder and deeper');
  assert.ok(P.splashPlan({ species: 'pink', style: 'thrash' }, r).every((h) => h.kind === 'slap'));
  for (const pl of [pink, chum, coho, sock, king]) for (const h of pl) for (const k of ['t', 'strength', 'bodyHz', 'decay']) assert.ok(Number.isFinite(h[k]) && h[k] >= 0);
});

test('footsteps by surface, gulls, radio timing, stingers and discovery chords', () => {
  assert.equal(P.footstepRecipe('mystery').surface, 'gravel');
  assert.ok(P.footstepRecipe('rock', true).thud > P.footstepRecipe('rock').thud);
  assert.ok(P.footstepRecipe('water').slosh > 0 && P.footstepRecipe('gravel').grains > P.footstepRecipe('grass').grains);
  assert.ok(P.gullInterval({ swarm: true }) < P.gullInterval({ near: 0.5 }));
  assert.ok(P.gullInterval({ near: 1, daylight: 0 }) > P.gullInterval({ near: 1, daylight: 1 }));
  assert.ok(['long', 'mew', 'kek'].includes(P.gullCall(seq(1)).type));
  const short = P.radioTiming('Copy.');
  const long = P.radioTiming('x'.repeat(200));
  assert.ok(short.voice >= 0.6 && long.voice > short.voice && long.voice <= 9 && long.duck > long.voice);
  assert.ok(P.stingerFor('plugged').plucks.length > P.stingerFor('water haul').plucks.length);
  assert.equal(P.stingerFor('good', true).name, 'cited');
  assert.equal(P.stingerFor('plugged').cue, 'triumph');
  assert.equal(P.discoveryChord({ kind: 'history', memorial: true }), null);
  assert.equal(P.discoveryChord({ kind: 'peak' }).name, 'open');
  assert.equal(P.discoveryChord({ kind: 'town' }).name, 'warm');
});

test('music cues: title, one dawn piece per day, silence while working, triumph after a big set', () => {
  const base = { hours: 12, day: 3, fishing: 'idle', dawnDay: -1, triumphUntil: -1, now: 100, current: null };
  assert.equal(P.musicCue({ ...base, mode: 'title' }), 'title');
  assert.equal(P.musicCue({ ...base, mode: 'loading' }), null);
  assert.equal(P.musicCue({ ...base, mode: 'play' }), null);
  assert.equal(P.musicCue({ ...base, mode: 'play', hours: 5 }), 'dawn');
  assert.equal(P.musicCue({ ...base, mode: 'play', hours: 5, dawnDay: 3 }), null);
  assert.equal(P.musicCue({ ...base, mode: 'play', hours: 9, current: 'dawn' }), 'dawn', 'the dawn piece finishes');
  assert.equal(P.musicCue({ ...base, mode: 'play', hours: 5, fishing: 'hauling' }), null);
  assert.equal(P.musicCue({ ...base, mode: 'play', triumphUntil: 130 }), 'triumph');
  assert.equal(P.musicCue({ ...base, mode: 'play', triumphUntil: 90 }), null);
});

// ---------------------------------------------------------------------------------------------------- scene
test('settlements: harbour bustle in Kodiak, silence at sea, memorials never count', () => {
  const ctx = fakeCtx();
  const { places } = resolve(ctx.geo);
  const kodiak = places.find((p) => p.id === 'st-paul-harbor');
  const inTown = Sc.settlementAt(places, kodiak.x, kodiak.z);
  assert.ok(inTown.level > 0.9 && inTown.clink > 0.5 && inTown.hum > 0.5);
  const cannery = places.find((p) => p.kind === 'cannery' && p.id !== 'cannery-row');
  assert.ok(Sc.settlementAt(places, cannery.x, cannery.z).machinery > 0.9);
  assert.equal(Sc.settlementAt(places, 0, 7900).level, 0);
  assert.equal(Sc.settlementAt([{ kind: 'village', memorial: true, x: 0, z: 0, radius: 200 }], 0, 0).level, 0);
  assert.equal(Sc.settlementAt(null, 0, 0).level, 0);
  const hp = Sc.harborPoint(kodiak, seq(4));
  assert.ok(Math.hypot(hp.x - kodiak.x, hp.z - kodiak.z) < 90);
});

test('listener context, shore point, beach material', () => {
  assert.equal(Sc.listenerContext({ camMode: 'bridge' }).interior, 1);
  assert.equal(Sc.listenerContext({ camMode: 'chase' }).interior, 0);
  const foot = Sc.listenerContext({ camMode: 'foot', control: 'foot', camY: 52, groundY: 50 });
  assert.ok(foot.onFoot && foot.interior === 0 && Math.abs(foot.height - 2) < 1e-9);
  const p = Sc.shorePoint(100, 0, 80, { x: 1, z: 0 });
  assert.ok(Math.abs(p.x - (100 - 86)) < 1e-9 && p.z === 0);
  assert.equal(Sc.shorePoint(0, 0, 900, { x: 1, z: 0 }), null);
  assert.ok(Sc.beachGravel('gravel') > Sc.beachGravel('sand'));
  // Real heightmap: the gradient points offshore, so the shore point is closer to land.
  const ctx = fakeCtx();
  const hm = ctx.heightmap;
  const w = hm.nearestWater(5170, -1115, { minShore: 120 });
  const sd = hm.shoreDistance(w.x, w.z);
  const g = hm.shoreGradient(w.x, w.z);
  const sp = Sc.shorePoint(w.x, w.z, sd, g, 2000);
  assert.ok(hm.shoreDistance(sp.x, sp.z) < sd - 40, `shore point nearer the beach (${hm.shoreDistance(sp.x, sp.z)} vs ${sd})`);
});

test('brailer scoops (fishing:brail), thunder delay, poisson waits', () => {
  // A full brailer load dips harder and dumps more salmon than a small catch's half-empty scoop.
  const full = Sc.brailScoop({ lbs: 3300, loadLbs: 1500 });
  const small = Sc.brailScoop({ lbs: 300, loadLbs: 1500 });
  assert.ok(full.dipVolume > small.dipVolume && full.dumpCount > small.dumpCount);
  assert.ok(full.dumpCount <= 18 && small.dumpCount >= 3);
  // The bag thins toward the last scoop.
  assert.ok(Sc.brailScoop({ lbs: 1500, progress: 0.9 }).dumpCount < Sc.brailScoop({ lbs: 1500, progress: 0 }).dumpCount);
  // The dump lands as the brailer reaches the hatch (~0.51 of its cycle after the dip), tracking the cycle length.
  assert.ok(Math.abs(Sc.brailScoop({ lbs: 1500, cycle: 2.8 }).dumpDelay - 0.51 * 2.8) < 1e-9);
  assert.ok(Sc.brailScoop({ lbs: 1500, cycle: 4 }).dumpDelay > Sc.brailScoop({ lbs: 1500, cycle: 2.8 }).dumpDelay);
  const junk = Sc.brailScoop({ lbs: 'x', loadLbs: NaN, progress: undefined, cycle: -1 });
  assert.ok(Number.isFinite(junk.dipVolume) && Number.isFinite(junk.dumpCount) && Number.isFinite(junk.dumpDelay));
  // The whip hoists right after a scoop and idles otherwise (a water haul never scoops).
  assert.equal(Sc.brailWhipRate(0.3), 0.75);
  assert.equal(Sc.brailWhipRate(2), 0.18);
  assert.equal(Sc.brailWhipRate(1e9), 0.18);
  assert.equal(Sc.brailWhipRate(-1), 0.18);
  assert.ok(Math.abs(Sc.thunderDelay(686) - 2) < 1e-9);
  assert.equal(Sc.thunderDelay(9000), 9);
  assert.equal(Sc.thunderDelay('x'), 0);
  const r = seq(5);
  let sum = 0;
  for (let i = 0; i < 20000; i++) sum += Sc.poissonWait(3, r);
  assert.ok(Math.abs(sum / 20000 - 3) < 0.1);
});

test('sea-lion stampede scales with the colony and stays bounded', () => {
  const r = seq(11);
  const islet = Sc.stampedePlan(12, r);
  const rookery = Sc.stampedePlan(150, r);
  assert.ok(rookery.roars.length > islet.roars.length && rookery.plunges.length > islet.plunges.length);
  assert.ok(rookery.chorus > islet.chorus && rookery.dur > islet.dur && rookery.level >= islet.level);
  for (const pl of [islet, rookery, Sc.stampedePlan(5000, r), Sc.stampedePlan(NaN, r)]) {
    assert.ok(pl.roars.length <= 5 && pl.plunges.length <= 8, 'node count bounded however big the colony');
    assert.ok(pl.dur >= 4 && pl.dur <= 8);
    for (const e of [...pl.roars, ...pl.plunges]) assert.ok(e.t >= 0 && e.t <= pl.dur, `event inside the stampede (${e.t})`);
    for (let i = 1; i < pl.plunges.length; i++) assert.ok(pl.plunges[i].t >= pl.plunges[i - 1].t);
  }
  assert.ok(islet.roars.some((x) => x.bull), 'a bull leads the roar');
});

test('radio captions: ui:radioShown finds the call that queued it, even when the UI reorders', () => {
  const pending = [
    { from: 'ADF&G', channel: '16', tip: false, text: 'a' },
    { from: 'Double Eagle', channel: '10', tip: false, text: 'b' },
    { from: 'Uncle Pete', channel: '10', tip: true, text: 'c' },
    { from: 'ADF&G', channel: '16', tip: false, text: 'd' },
  ];
  // Pete's tip jumps the queue; then the oldest ADF&G call; a sender match wins over nothing when the channel differs.
  assert.equal(Sc.matchRadio(pending, { from: 'Uncle Pete', channel: '10', tip: true }), 2);
  assert.equal(Sc.matchRadio(pending, { from: 'ADF&G', channel: '16', tip: false }), 0);
  assert.equal(Sc.matchRadio(pending, { from: 'Double Eagle', channel: '6', tip: false }), 1);
  assert.equal(Sc.matchRadio(pending, { from: 'Uncle Pete', channel: '10', tip: false }), -1, 'a routine call is not a tip');
  assert.equal(Sc.matchRadio(pending, { from: 'Coast Guard', channel: '16' }), -1);
  assert.equal(Sc.matchRadio([], { from: 'x' }), -1);
  assert.equal(Sc.matchRadio(null, null), -1);
  // Same channel normalisation as the UI ('ch 16' → '16'; a missing sender reads 'VHF').
  assert.equal(Sc.radioChannel('ch 16'), '16');
  assert.equal(Sc.radioChannel(undefined, '10'), '10');
  assert.equal(Sc.matchRadio([{ from: 'VHF', channel: '16', tip: false }], { from: 'VHF', channel: '16', tip: false }), 0);
});

test('nearest helpers, gull scene, slaps, sea lions, muffle', () => {
  const list = [{ position: { x: 10, z: 0 } }, { position: { x: 3, z: 4 } }, { x: 100, z: 0 }, null, { position: { x: NaN, z: 0 } }];
  assert.equal(Sc.nearestOf(list, 0, 0).distance, 5);
  assert.equal(Sc.nearestOf(list, 0, 0, 4), null);
  assert.deepEqual(Sc.nearestN(list, 0, 0, 2).map((e) => e.distance), [5, 10]);
  assert.equal(Sc.nearestN(list, 0, 0, 5, 50).length, 2);
  const birds = [
    ...Array.from({ length: 8 }, (_, i) => ({ kind: 'gull', role: 'swarm', position: { x: i, z: 0 } })),
    ...Array.from({ length: 6 }, (_, i) => ({ kind: 'gull', role: 'work', position: { x: 0, z: i } })),
    { kind: 'eagle', role: 'soar', position: { x: 1, z: 1 } },
    { kind: 'gull', role: 'follow', position: { x: 5000, z: 0 } },
  ];
  const gs = Sc.gullScene(birds, 0, 0, 200);
  assert.equal(gs.count, 14);
  assert.ok(gs.swarm && gs.working > 0.8 && gs.near > 0.9);
  assert.equal(Sc.gullScene(undefined, 0, 0).count, 0);
  assert.equal(Sc.slapStrength({ pitchRate: 0.005, hs: 0.3 }), 0);
  assert.ok(Sc.slapStrength({ pitchRate: 0.12, hs: 1.5, speed: 8 }) > Sc.slapStrength({ pitchRate: 0.06, hs: 0.6, speed: 2 }));
  assert.ok(Sc.lapInterval(1.5) < Sc.lapInterval(0.1));
  assert.equal(Sc.sealionRate(2000), 0);
  assert.ok(Sc.sealionRate(200, 40) > Sc.sealionRate(900, 40));
  assert.equal(Sc.muffleFor('paused').cutoff, 900);
  assert.equal(Sc.muffleFor('play').gain, 1);
  assert.ok(Sc.muffleFor('title').gain < 1 && Sc.muffleFor('title').cutoff > 10000);
});

// ------------------------------------------------------------------------------------------------------- dsp
test('noise loops are seamless and normalised', () => {
  const r = seq(9);
  const a = D.fillBrown(new Float32Array(48000), r);
  D.removeDC(a);
  const s = D.normalize(D.seamless(a, 2400), 0.9);
  assert.ok(Math.abs(D.peakOf(s) - 0.9) < 1e-6);
  let maxStep = 0;
  for (let i = 1; i < s.length; i++) maxStep = Math.max(maxStep, Math.abs(s[i] - s[i - 1]));
  assert.ok(Math.abs(s[0] - s[s.length - 1]) <= maxStep * 1.5, 'no click at the loop point');
  const w = D.fillWhite(new Float32Array(1000), r);
  assert.ok(D.peakOf(w) <= 1);
  const pk = D.fillPink(new Float32Array(20000), r);
  assert.ok(pk.every(Number.isFinite));
  const drops = D.fillDrops(new Float32Array(48000), 48000, r, { rate: 200 });
  assert.ok(D.peakOf(drops) > 0);
});

test('soft clip never exceeds its ceiling; spectra and FFT are right', () => {
  const c = D.softClipCurve(2048, 0.8, 0.985);
  assert.ok(D.peakOf(c) <= 0.985 + 1e-6);
  for (let i = 1; i < c.length; i++) assert.ok(c[i] >= c[i - 1]);
  const mid = c[Math.round(0.25 * 2047)];
  assert.ok(Math.abs(mid - -0.5) < 0.002, 'linear below the knee');
  const n = 256;
  const sine = Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * i) / n));
  const h = D.harmonicsOf(sine, 4);
  assert.ok(Math.abs(h.imag[1] - 1) < 1e-3 && Math.abs(h.imag[2]) < 1e-3 && Math.abs(h.real[1]) < 1e-3);
  // The FFT path (power-of-two lengths) matches the direct Fourier sum.
  const rw = D.fillWhite(new Float32Array(64), seq(8));
  const fast = D.harmonicsOf(rw, 12);
  for (let k = 1; k <= 12; k++) {
    let a = 0;
    let b = 0;
    for (let i = 0; i < 64; i++) {
      a += rw[i] * Math.cos((2 * Math.PI * k * i) / 64);
      b += rw[i] * Math.sin((2 * Math.PI * k * i) / 64);
    }
    assert.ok(Math.abs(fast.real[k] - a / 32) < 1e-4 && Math.abs(fast.imag[k] - b / 32) < 1e-4, `harmonic ${k}`);
  }
  const re = Float32Array.from({ length: 64 }, (_, i) => Math.cos((2 * Math.PI * 5 * i) / 64));
  const im = new Float32Array(64);
  D.fft(re, im);
  const mags = Array.from(re, (v, i) => Math.hypot(v, im[i]));
  assert.equal(mags.indexOf(Math.max(...mags.slice(0, 32))), 5);
  const sp = D.spectrogram(new Float32Array(4096), { size: 512, hop: 256 });
  assert.equal(sp.frames.length, 15);
  const lv = D.levels(Float32Array.from([0.5, -0.5]));
  assert.ok(Math.abs(lv.peakDb - -6.02) < 0.01);
});

test('diesel cycle, string, pad and reverb impulse', () => {
  const cyc = D.dieselCycle(2048, { pulses: 6, rnd: seq(1) });
  let mean = 0;
  for (const v of cyc) mean += v;
  assert.ok(Math.abs(mean / cyc.length) < 1e-3);
  assert.ok(Math.abs(D.peakOf(cyc) - 1) < 1e-6);
  const w = D.harmonicsOf(cyc, 60);
  let best = 0;
  let arg = 0;
  for (let k = 1; k <= 12; k++) {
    const m = Math.hypot(w.real[k], w.imag[k]);
    if (m > best) {
      best = m;
      arg = k;
    }
  }
  assert.equal(arg, 6, 'the firing harmonic (6 cylinders) dominates the low spectrum');
  const s = D.stringHarmonics(20);
  assert.ok(s.imag[1] > s.imag[5]);
  const ir = D.impulseResponse(8000, 1, seq(2), { decay: 0.8 });
  const e = (ch, a, b) => ch.slice(a, b).reduce((x, v) => x + v * v, 0);
  assert.ok(e(ir[0], 0, 800) > 20 * e(ir[0], 7200, 8000), 'reverb decays');
  assert.ok(Math.max(D.peakOf(ir[0]), D.peakOf(ir[1])) <= 1 + 1e-6);
});

// ------------------------------------------------------------------------------------------------------ voices
test('voice table: limit, priority stealing, refusal and pruning', () => {
  const vt = createVoiceTable(3, { stealAge: 0.5 });
  const stopped = [];
  const mk = (priority, now, name) => vt.admit({ priority, now, end: now + 2, name, stop: () => stopped.push(name) });
  assert.ok(mk(2, 0, 'a') && mk(3, 0, 'b') && mk(5, 0, 'c'));
  assert.equal(mk(1, 0.1, 'low'), null, 'a weaker sound is refused when full');
  assert.ok(mk(4, 0.1, 'd'), 'a stronger one steals');
  assert.deepEqual(stopped, ['a']);
  assert.ok(mk(3, 0.8, 'e'), 'equal priority steals an old voice');
  assert.deepEqual(stopped, ['a', 'b']);
  assert.equal(vt.count, 3);
  vt.prune(10);
  assert.equal(vt.count, 0);
  assert.equal(vt.stats.refused, 1);
  assert.equal(vt.stats.stolen, 2);
  mk(1, 10, 'z');
  vt.clear(10);
  assert.equal(vt.count, 0);
  assert.ok(stopped.includes('z'));
});

// ------------------------------------------------------------------------------------------------------- music
test('composer: bars stay in the mode, finite moods end, the title plays on', () => {
  for (const name of Object.keys(MOODS)) {
    const mood = MOODS[name];
    const comp = createComposer(name, seq(name.length));
    const scale = new Set(SCALES[mood.scale].map((s) => s % 12));
    let bars = 0;
    while (!comp.done && bars < 60) {
      const bar = comp.nextBar();
      bars++;
      assert.ok(bar.duration > 0);
      for (const e of bar.events) {
        assert.ok(e.t >= 0 && e.t < bar.duration + 1e-9, `${name} event inside the bar`);
        const notes = Array.isArray(e.midi) ? e.midi : [e.midi];
        for (const m of notes) {
          assert.ok(Number.isInteger(m) && m > 20 && m < 100);
          assert.ok(scale.has((((m - mood.root) % 12) + 12) % 12), `${name}: ${m} in ${mood.scale}`);
        }
        assert.ok(e.vel > 0 && e.vel <= 1);
      }
    }
    if (Number.isFinite(mood.bars)) assert.equal(bars, mood.bars);
    else assert.equal(bars, 60);
  }
  assert.deepEqual(chordTones('dorian', 0), [0, 3, 7]);
  assert.equal(noteOf(50, 'dorian', 7), 62);
});

test('sound table: every recipe declared with a bus, priority and (if positional) a range', () => {
  for (const [name, d] of Object.entries(SOUNDS)) {
    assert.equal(typeof d.fn, 'function', name);
    assert.ok(['world', 'ambience', 'ui'].includes(d.bus), `${name} bus`);
    assert.ok(d.priority >= 1 && d.priority <= 10, `${name} priority`);
    if (d.bus === 'world') assert.ok(d.range > 0 && d.ref > 0, `${name} range/ref`);
  }
  for (const k of ['fish-jump', 'gull', 'eagle', 'whale-blow', 'bear-huff', 'footstep', 'horn', 'anchor-chain', 'collision', 'radio', 'cash-register', 'discovery', 'stinger', 'ui-click', 'ui-open', 'brail-dip', 'brail-dump', 'hull-slap', 'surf-break', 'thunder', 'sealion', 'stampede', 'summit']) {
    assert.ok(SOUNDS[k], `has ${k}`);
  }
});
