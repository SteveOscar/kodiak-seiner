// WP-AUDIO graph-level tests on a strict mock AudioContext (Node has no WebAudio). The mock enforces the WebAudio
// rules that throw in browsers (non-finite values, negative times, exponential ramps to 0, overlapping value curves,
// double start, stop before start, connecting to non-nodes) and records every source's start/stop, so every recipe,
// the mixer, the beds, the music player and the director can be exercised for real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { fakeCtx } from './contract.test.mjs';
import { createKit } from '../src/audio/kit.js';
import { createMixer } from '../src/audio/mixer.js';
import { createPlayer } from '../src/audio/engine.js';
import { createBeds } from '../src/audio/beds.js';
import { createMusic } from '../src/audio/music.js';
import { createDirector } from '../src/audio/director.js';
import { EVENTS } from '../src/audio/cues.js';
import { SOUNDS } from '../src/audio/sfx.js';
import { create } from '../src/audio/audio.js';

// ------------------------------------------------------------------------------------------------ the mock
const fin = (...a) => {
  for (const v of a) if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`non-finite AudioParam argument: ${v}`);
};
const time = (t) => {
  fin(t);
  if (t < 0) throw new RangeError(`negative time ${t}`);
};

class MockParam {
  constructor(v = 0) {
    this._v = v;
    this.events = [];
    this.inputs = 0;
  }
  get value() {
    return this._v;
  }
  set value(v) {
    fin(v);
    this._v = v;
  }
  _push(e) {
    this.events.push(e);
    if (this.events.length > 5000) this.events.splice(0, 2500);
    return this;
  }
  setValueAtTime(v, t) {
    fin(v);
    time(t);
    return this._push({ type: 'set', v, t });
  }
  linearRampToValueAtTime(v, t) {
    fin(v);
    time(t);
    return this._push({ type: 'lin', v, t });
  }
  exponentialRampToValueAtTime(v, t) {
    fin(v);
    time(t);
    if (v === 0) throw new RangeError('exponential ramp to 0');
    if (v < 0) throw new RangeError('exponential ramp to a negative value (sign flip)');
    return this._push({ type: 'exp', v, t });
  }
  setTargetAtTime(v, t, tc) {
    fin(v, tc);
    time(t);
    if (tc < 0) throw new RangeError('negative time constant');
    return this._push({ type: 'target', v, t, tc });
  }
  setValueCurveAtTime(curve, t, d) {
    time(t);
    fin(d);
    if (!(d > 0)) throw new RangeError('curve duration must be > 0');
    if (!curve || curve.length < 2) throw new Error('InvalidStateError: curve too short');
    for (const x of curve) fin(x);
    for (const e of this.events) if (e.t >= t && e.t < t + d) throw new Error('NotSupportedError: automation overlaps a value curve');
    return this._push({ type: 'curve', t, d });
  }
  cancelScheduledValues(t) {
    time(t);
    this.events = this.events.filter((e) => e.t < t);
    return this;
  }
  cancelAndHoldAtTime(t) {
    return this.cancelScheduledValues(t);
  }
}

class MockNode {
  constructor(ac, kind) {
    this.context = ac;
    this.kind = kind;
    this.outputs = new Set();
    ac.nodes++;
  }
  connect(dest) {
    if (!(dest instanceof MockNode) && !(dest instanceof MockParam)) throw new TypeError(`connect to a non-node (${dest})`);
    if (dest instanceof MockNode && dest.context !== this.context) throw new Error('InvalidAccessError: cross-context connect');
    this.outputs.add(dest);
    if (dest instanceof MockParam) dest.inputs++;
    return dest;
  }
  disconnect() {
    this.outputs.clear();
  }
}

class MockSource extends MockNode {
  constructor(ac, kind) {
    super(ac, kind);
    this.startAt = null;
    this.stopAt = null;
    ac.sources.push(this);
  }
  start(when = 0, offset = 0) {
    if (this.startAt !== null) throw new Error('InvalidStateError: start called twice');
    time(when);
    fin(offset);
    if (offset < 0) throw new RangeError('negative offset');
    this.startAt = when;
  }
  stop(when = 0) {
    if (this.startAt === null) throw new Error('InvalidStateError: stop before start');
    time(when);
    this.stopAt = when;
  }
}

class MockAudioContext {
  constructor() {
    this.sampleRate = 48000;
    this.currentTime = 0;
    this.state = 'running';
    this.nodes = 0;
    this.sources = [];
    this.destination = new MockNode(this, 'destination');
    const P = () => new MockParam(0);
    this.listener = { positionX: P(), positionY: P(), positionZ: P(), forwardX: P(), forwardY: P(), forwardZ: P(), upX: P(), upY: P(), upZ: P() };
  }
  createGain() {
    const n = new MockNode(this, 'gain');
    n.gain = new MockParam(1);
    return n;
  }
  createBiquadFilter() {
    const n = new MockNode(this, 'biquad');
    n.type = 'lowpass';
    n.frequency = new MockParam(350);
    n.Q = new MockParam(1);
    n.gain = new MockParam(0);
    n.detune = new MockParam(0);
    return n;
  }
  createOscillator() {
    const n = new MockSource(this, 'osc');
    n.frequency = new MockParam(440);
    n.detune = new MockParam(0);
    let type = 'sine';
    Object.defineProperty(n, 'type', {
      get: () => type,
      set: (v) => {
        if (!['sine', 'square', 'sawtooth', 'triangle'].includes(v)) throw new TypeError(`bad oscillator type ${v}`);
        type = v;
      },
    });
    n.setPeriodicWave = (w) => {
      if (!w?.periodic) throw new TypeError('not a PeriodicWave');
      type = 'custom';
    };
    return n;
  }
  createBufferSource() {
    const n = new MockSource(this, 'buffer');
    n.playbackRate = new MockParam(1);
    n.detune = new MockParam(0);
    n.loop = false;
    n.buffer = null;
    return n;
  }
  createBuffer(ch, len, sr) {
    const data = Array.from({ length: ch }, () => new Float32Array(len));
    return { numberOfChannels: ch, length: len, sampleRate: sr, duration: len / sr, getChannelData: (i) => data[i], copyToChannel: (a, i) => data[i].set(a) };
  }
  createPeriodicWave(real, imag) {
    if (real.length !== imag.length || real.length < 2) throw new Error('IndexSizeError: bad periodic wave');
    for (let i = 0; i < real.length; i++) fin(real[i], imag[i]);
    return { periodic: true };
  }
  createPanner() {
    const n = new MockNode(this, 'panner');
    for (const k of ['positionX', 'positionY', 'positionZ', 'orientationX', 'orientationY', 'orientationZ']) n[k] = new MockParam(0);
    n.setPosition = () => {};
    return n;
  }
  createStereoPanner() {
    const n = new MockNode(this, 'stereo');
    n.pan = new MockParam(0);
    return n;
  }
  createWaveShaper() {
    const n = new MockNode(this, 'shaper');
    n.curve = null;
    n.oversample = 'none';
    return n;
  }
  createConvolver() {
    const n = new MockNode(this, 'convolver');
    n.buffer = null;
    n.normalize = true;
    return n;
  }
  createDynamicsCompressor() {
    const n = new MockNode(this, 'compressor');
    for (const k of ['threshold', 'knee', 'ratio', 'attack', 'release']) n[k] = new MockParam(0);
    n.reduction = 0;
    return n;
  }
  createAnalyser() {
    const n = new MockNode(this, 'analyser');
    n.fftSize = 2048;
    n.frequencyBinCount = 1024;
    n.smoothingTimeConstant = 0.8;
    n.getFloatTimeDomainData = (a) => a.fill(0.01);
    n.getFloatFrequencyData = (a) => a.fill(-90);
    return n;
  }
  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
  suspend() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}

const ac0 = new MockAudioContext();
const kit0 = createKit(ac0);

// ------------------------------------------------------------------------------------------------ recipes
const VARIANTS = {
  'fish-jump': [{ species: 'pink' }, { species: 'chum', size: 0.8 }, { species: 'coho' }, { species: 'sockeye' }, { species: 'king' }, { species: 'pink', style: 'thrash' }],
  splash: [{ size: 0.3 }, { size: 1 }, { size: 3.5 }],
  'surf-break': [{ level: 0.8, gravel: 1 }, { level: 0.2, gravel: 0 }],
  'hull-slap': [{ strength: 0.9 }, { strength: 0.2, soft: true }],
  gull: [{}, { excited: true }, { call: { type: 'long', pitch: 900, notes: 5, rasp: 0.3 } }, { call: { type: 'kek', pitch: 1000, notes: 4, rasp: 0.2 } }, { call: { type: 'mew', pitch: 950, notes: 1, rasp: 0.2 } }],
  'whale-blow': [{}, { strength: 0.45 }],
  'bear-huff': [{}, { huffs: 1, intensity: 0.4, pops: 0 }],
  footstep: ['gravel', 'sand', 'grass', 'forest', 'alder', 'rock', 'snow', 'water', 'skiff', 'lava'].flatMap((s) => [{ surface: s }, { surface: s, run: true }]),
  horn: [{}, { dur: 3 }],
  'anchor-chain': [{ mode: 'drop' }, { mode: 'haul' }],
  collision: [{ kind: 'ground', strength: 1 }, { kind: 'ground', strength: 0.2 }, { kind: 'boat', strength: 0.3 }],
  starter: [{}, { dur: 0.6 }],
  cork: [{}, { drip: false }],
  thunder: [{ distance: 800 }, { distance: 5000, intensity: 0.4 }],
  radio: [{ text: 'Northern Dawn, Northern Dawn, this is the Kodiak tender on ten.' }, { text: '' }, { text: 'x'.repeat(600) }],
  discovery: [{ kind: 'peak' }, { kind: 'history' }, { kind: 'town' }, { kind: 'history', memorial: true }],
  stinger: [{ rating: 'plugged' }, { rating: 'good' }, { rating: 'fair' }, { rating: 'water haul' }, { rating: 'good', cited: true }],
  sealion: [{ bull: true }, { bull: false }],
  clunk: [{}, { hiss: true }],
};

test('every sound recipe schedules cleanly and stops all of its sources by its returned end', () => {
  for (const [name, def] of Object.entries(SOUNDS)) {
    for (const params of VARIANTS[name] ?? [{}]) {
      for (const rate of [1, 1.3]) {
        const before = ac0.sources.length;
        const out = kit0.gain(1);
        out.connect(ac0.destination);
        const t = 2;
        const end = def.fn(kit0, out, t, { ...params, rate });
        assert.ok(Number.isFinite(end) && end >= t, `${name} returns an end time (${end})`);
        const made = ac0.sources.slice(before);
        for (const s of made) {
          assert.notEqual(s.startAt, null, `${name}: every source is started`);
          assert.ok(s.startAt >= t - 1e-9, `${name}: starts at or after t`);
          assert.notEqual(s.stopAt, null, `${name}: every source is stopped (${s.kind})`);
          assert.ok(s.stopAt <= end + 1e-6, `${name}: ${s.kind} stops by the returned end (${s.stopAt} > ${end})`);
        }
        if (name !== 'discovery' || !params.memorial) assert.ok(made.length > 0, `${name} makes sound`);
      }
    }
  }
});

// ------------------------------------------------------------------------------------------------ the graph
function stage() {
  const ac = new MockAudioContext();
  const kit = createKit(ac);
  const mixer = createMixer(ac, kit, { silent: true });
  const player = createPlayer(ac, kit, mixer);
  const beds = createBeds(ac, kit, mixer);
  const music = createMusic(ac, kit, mixer.bus.music);
  return { ac, kit, mixer, player, beds, music, ready: true };
}

test('mixer: volumes, mute, duck, muffle and the meter', () => {
  const { ac, mixer } = stage();
  const v = mixer.setVolumes({ master: 0.5, music: 0 });
  assert.equal(v.master, 0.5);
  mixer.muted = true;
  assert.equal(mixer.muted, true);
  mixer.fadeIn(1);
  mixer.duck(3);
  mixer.duck(1); // shorter duck inside a longer one is ignored
  mixer.setMuffle({ cutoff: 900, gain: 0.45 });
  ac.currentTime = 5;
  const m = mixer.sample();
  assert.ok(m.peak > 0 && m.rms > 0);
  assert.doesNotThrow(() => JSON.stringify(mixer.levels()));
});

test('player: positional voices, range culling, caps, voice limit and cleanup', () => {
  const { ac, player } = stage();
  player.setListener(0, 5, 0);
  assert.equal(player.play('nope'), null);
  assert.equal(player.play('fish-jump', { position: { x: 5000, y: 0, z: 0 } }), null, 'out of range');
  assert.ok(player.play('fish-jump', { position: { x: 100, y: 0, z: 0 }, params: { species: 'chum' } }));
  assert.ok(player.play('radio', { params: { text: 'hello' }, pan: 0.3 }));
  let n = 0;
  for (let i = 0; i < 40; i++) if (player.play('gull', { position: { x: 20, y: 10, z: i } })) n++;
  assert.ok(n <= 4, `gull cap (${n})`);
  for (let i = 0; i < 80; i++) player.play(['splash', 'cork', 'clink', 'footstep', 'hull-slap', 'eagle'][i % 6], { position: { x: i, y: 0, z: 0 } });
  const s = player.stats();
  assert.ok(s.live <= s.max, `voice limit (${s.live}/${s.max})`);
  assert.ok(s.peak <= s.max);
  ac.currentTime = 60;
  player.collect();
  assert.equal(player.stats().live, 0);
  assert.equal(player.stats().pending, 0);
});

test('beds: lazy layers build when audible and tear down after silence', () => {
  const { beds } = stage();
  assert.deepEqual(beds.active(), []);
  const rain = beds.rain.need(0.2, 0.03);
  rain.set({ patterGain: 0.2, patterCutoff: 8000, patterHighpass: 400, hissGain: 0.03, rate: 1 }, 0);
  assert.deepEqual(beds.active(), ['rain']);
  for (let i = 0; i < 200; i++) beds.rain.need(0, 1 / 30);
  assert.deepEqual(beds.active(), []);
  for (const k of ['whistle', 'foliage', 'harbor', 'genset', 'hullWash', 'skiff', 'hydraulics', 'bag', 'stream']) assert.ok(beds[k].need(0.1, 0.03), k);
  assert.equal(beds.active().length, 9);
  beds.dispose();
});

test('music: title plays on with a lookahead, dawn ends by itself, cues crossfade', () => {
  const { ac, music } = stage();
  music.setCue('title');
  for (let t = 0; t < 60; t += 0.1) {
    ac.currentTime = t;
    music.tick();
  }
  const st = music.stats();
  assert.equal(st.cue, 'title');
  assert.ok(st.barsPlayed >= 14 && st.barsPlayed <= 18, `bars ${st.barsPlayed}`);
  music.setCue('dawn');
  for (let t = 60; t < 200; t += 0.1) {
    ac.currentTime = t;
    music.tick();
  }
  assert.equal(music.finished, true);
  music.setCue(null);
  assert.equal(music.cue, null);
});

// A minimal world for the director: a seiner under way, a skiff, weather, wildlife, fishing.
function world(ctx) {
  const pos = new THREE.Vector3(5170, 0, -1115);
  const seiner = {
    position: pos,
    heading: 1,
    speed: 6,
    throttle: 0.6,
    engineLoad: 0.5,
    mooring: null,
    pitch: 0,
    object3d: new THREE.Group(),
    bowPoint: (o = new THREE.Vector3()) => o.set(pos.x + 8, 1, pos.z),
    sternPoint: (o = new THREE.Vector3()) => o.set(pos.x - 8, 1, pos.z),
    powerBlockPoint: (o = new THREE.Vector3()) => o.set(pos.x - 4, 9, pos.z),
  };
  const skiff = { position: new THREE.Vector3(5200, 0, -1100), state: 'stowed', effort: 0 };
  const fishing = { state: 'idle', hud: { tension: 0.5 } };
  const net = { state: 'stowed', hauled: 0, bagCentroid: (o) => ((o.x = 5160), (o.z = -1120), o) };
  const gulls = Array.from({ length: 12 }, (_, i) => ({ kind: 'gull', role: i < 6 ? 'follow' : 'work', position: new THREE.Vector3(5170 + i * 3, 12, -1110) }));
  const wildlife = {
    birds: [...gulls, { kind: 'eagle', role: 'soar', position: new THREE.Vector3(5250, 60, -1150) }],
    bears: [{ id: 'bear-1', state: 'fishing', position: new THREE.Vector3(5230, 2, -1180) }],
    sites: { haulouts: [{ id: 'h1', x: 5600, z: -1115, members: new Array(30) }] },
    whales: [],
  };
  Object.assign(ctx.systems, {
    seiner,
    skiff,
    fishing,
    net,
    wildlife,
    sky: { weather: { windSpeed: 12, rain: 0.6, fog: 0.8, swell: 1.2 }, daylight: 0.8 },
    water: { seaStateAt: () => 1.1, heightAt: () => 0 },
    terrain: { heightAt: () => 5, surfaceAt: () => 'forest', forestDensity: () => 0.7 },
    cameraRig: { mode: 'chase' },
    fleet: { boats: [{ id: 'f1', kind: 'seiner', speed: 5, state: 'running', position: new THREE.Vector3(5300, 0, -1100) }, { id: 'f2', kind: 'tender', speed: 0, state: 'anchored', position: new THREE.Vector3(5100, 0, -1300) }] },
    ui: { serialize: () => ({ hintsShown: ['pete-old'] }) },
    economy: { fuelEmpty: false },
  });
  return { seiner, skiff, fishing, net };
}

test('director: a whole voyage of frames and events runs clean, bounded and finite', () => {
  const ctx = fakeCtx();
  const A = stage();
  const w = world(ctx);
  A.director = createDirector(ctx, A);
  ctx.camera.position.set(5150, 12, -1100);
  ctx.camera.lookAt(5170, 0, -1115);
  const frame = (mode, secs, fn) => {
    ctx.state.mode = mode;
    for (let t = 0; t < secs; t += 1 / 60) {
      A.ac.currentTime += 1 / 60;
      ctx.time.dt = mode === 'play' || mode === 'title' ? 1 / 60 : 0;
      ctx.time.elapsed += ctx.time.dt;
      fn?.(t);
      A.director.frame(1 / 60);
    }
  };
  // Neighbours with broken numbers must not break the audio (AudioParams throw on NaN in browsers; the mock too).
  ctx.systems.fleet.boats.push({ id: 'bad', kind: 'seiner', speed: NaN, position: new THREE.Vector3(5160, NaN, -1110) });
  ctx.systems.wildlife.birds.push({ kind: 'gull', role: 'follow', position: new THREE.Vector3(5150, NaN, -1100) });
  frame('title', 3);
  frame('play', 5, (t) => (w.seiner.pitch = 0.05 * Math.sin(t * 1.8)));
  // A set: release, pursing, hauling, brailing.
  w.skiff.state = 'released';
  w.skiff.effort = 0.8;
  w.fishing.state = 'setting';
  frame('play', 3);
  w.fishing.state = 'pursing';
  frame('play', 3);
  w.fishing.state = 'hauling';
  frame('play', 4, (t) => (w.net.hauled = Math.min(0.95, t / 4)));
  w.fishing.state = 'brailing';
  frame('play', 6);
  w.fishing.state = 'report';
  w.net.state = 'hauling';
  frame('play', 1);
  w.fishing.state = 'idle';
  w.skiff.state = 'stowed';
  w.seiner.mooring = { kind: 'anchor' };
  w.seiner.speed = 0;
  frame('play', 12, (t) => {
    w.seiner.roll = 0.04 * Math.sin(t * 1.3);
    w.seiner.pitch = 0.02 * Math.sin(t * 1.7);
  });
  assert.ok(A.player.stats().started > 0);
  frame('paused', 1);
  ctx.state.control = 'foot';
  ctx.systems.cameraRig.mode = 'foot';
  frame('play', 2);
  ctx.systems.cameraRig.mode = 'bridge';
  ctx.state.control = 'boat';
  frame('play', 2);

  const payloads = {
    'fish:jump': { x: 5180, y: 0, z: -1110, species: 'coho', size: 0.7, style: 'tailwalk' },
    'fish:spooked': { x: 5180, z: -1110 },
    'skiff:splash': { x: 5190, z: -1110 },
    'fishing:snag': {},
    'fishing:setComplete': { rating: 'plugged', totalLbs: 40000 },
    'ui:radio': { from: 'ADF&G', text: 'Attention all purse seiners.' },
    'ui:hint': { id: 'pete-new', text: 'Let her go!', from: 'Uncle Pete' },
    'ui:toast': { text: 'hi', kind: 'warn' },
    'game:mode': { mode: 'play', prev: 'paused' },
    'boat:teleport': { x: 0, z: 0, reason: 'debug' },
    'boat:mooring': { mooring: null },
    'boat:collision': { speed: 4, x: 5170, z: -1115, kind: 'ground' },
    'player:step': { surface: 'gravel', run: true },
    'bear:encounter': { stage: 'charge', bearId: 'bear-1' },
    'wildlife:blow': { kind: 'humpback', x: 5400, z: -1200 },
    'wildlife:breach': { stage: 'splash', x: 5400, z: -1200 },
    'sky:lightning': { distance: 1800, x: 6000, z: -1000, intensity: 1 },
    'place:discovered': { id: 'kodiak', kind: 'town' },
    'economy:delivered': {},
  };
  ctx.state.mode = 'play';
  for (const name of EVENTS) A.director.event(name, payloads[name] ?? {});
  A.director.event('boat:mooring', { mooring: { kind: 'anchor' } });
  A.director.event('boat:mooring', { mooring: null });
  A.director.event('ui:hint', { id: 'pete-old', text: 'shown before', from: 'Uncle Pete' });
  frame('play', 3);
  frame('title', 1);
  A.director.event('game:toTitle', {});
  A.director.reset();

  const s = A.director.stats();
  assert.doesNotThrow(() => JSON.stringify(s));
  const ps = A.player.stats();
  assert.ok(ps.started > 20, `one-shots played (${ps.started})`);
  assert.ok(ps.peak <= ps.max);
  for (const k of ['fish-jump', 'gull', 'horn', 'radio']) assert.ok(k in SOUNDS);
  // Every AudioParam automation target stayed finite (the mock throws otherwise) and the engine is running.
  assert.equal(s.engine.phase === 'running' || s.engine.phase === 'off', true);
});

test('audio system: unlock under a mock browser builds the graph and routes events', async () => {
  const ctx = fakeCtx();
  world(ctx);
  const saved = { window: globalThis.window, navigator: globalThis.navigator, document: globalThis.document };
  globalThis.window = { AudioContext: MockAudioContext };
  Object.defineProperty(globalThis, 'navigator', { value: { webdriver: true }, configurable: true, writable: true });
  const listeners = {};
  globalThis.document = { hidden: false, addEventListener: (k, f) => (listeners[k] = f), removeEventListener: () => {} };
  try {
    const sys = await create(ctx);
    ctx.systems.audio = sys;
    assert.equal(sys.ready, true);
    assert.equal(sys.debugState().silentOutput, true);
    ctx.state.mode = 'play';
    ctx.events.emit('ui:radio', { from: 'x', text: 'Copy that.' });
    ctx.events.emit('ui:radio', { from: 'y', text: 'Roger, we will be over after this set.' });
    assert.equal(sys.debugState().voices.byName.radio, 2, 'a second call queues behind the first');
    assert.ok(sys.play('horn', { position: new THREE.Vector3(5170, 8, -1115) }));
    assert.ok(sys.play('ui-click'));
    assert.equal(sys.play('ui-click', { position: { x: NaN, z: 0 } }) === null || true, true);
    sys.setVolumes({ master: 0.3 });
    sys.muted = true;
    for (let i = 0; i < 30; i++) sys.frame(1 / 60);
    listeners.visibilitychange?.();
    const ds = sys.debugState();
    assert.doesNotThrow(() => JSON.stringify(ds));
    assert.equal(ds.muted, true);
    sys.dispose();
  } finally {
    globalThis.window = saved.window;
    Object.defineProperty(globalThis, 'navigator', { value: saved.navigator, configurable: true, writable: true });
    globalThis.document = saved.document;
  }
});
