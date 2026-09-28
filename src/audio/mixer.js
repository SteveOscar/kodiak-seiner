// The mix graph: four buses (ambience, world, ui, music). World + ambience pass a low shelf, the pause muffle and the
// radio duck; music has its own duck. Then sub-cut → glue compressor → make-up trim → brickwall limiter → soft
// clipper → meter → master volume → speakers. One shared reverb (long, dark, fjord-like) takes sends from music,
// stingers and far-off world sounds. The glue barely touches normal play; the limiter and clipper only catch pile-ups
// (a breach next to a horn blast during a thunderclap).

import { TUNING, volumeCurve, mergeVolumes, DEFAULT_VOLUMES, gainToDb } from './params.js';

export function createMixer(ac, kit, { silent = false } = {}) {
  const now = () => ac.currentTime;
  const busNames = ['ambience', 'world', 'ui', 'music'];
  const bus = {};
  for (const n of busNames) bus[n] = kit.gain(1);

  // Pause muffle for the world + ambience; the ui and music stay clear.
  const muffle = kit.filter('lowpass', 20000, 0.5);
  const muffleGain = kit.gain(1);
  const worldDuck = kit.gain(1);
  // Diesel, swell and surf pile up below ~120 Hz; a gentle shelf keeps the rumble warm rather than boomy.
  const lowShelf = kit.filter('lowshelf', 120, 0.7, -4);
  kit.chain(bus.ambience, lowShelf);
  kit.chain(bus.world, lowShelf);
  kit.chain(lowShelf, muffle, muffleGain, worldDuck);

  const musicDuck = kit.gain(1);
  bus.music.connect(musicDuck);

  // Reverb.
  const verb = ac.createConvolver();
  verb.normalize = true;
  verb.buffer = kit.buf.ir;
  const verbIn = kit.gain(1);
  const verbHp = kit.filter('highpass', 180, 0.6);
  const verbOut = kit.gain(0.55);
  kit.chain(verbIn, verbHp, verb, verbOut);
  const send = {
    music: kit.gain(0.32),
    ui: kit.gain(0.22),
    world: kit.gain(0.18),
  };
  musicDuck.connect(send.music);
  bus.ui.connect(send.ui);
  for (const s of Object.values(send)) s.connect(verbIn);
  // Sends that individual voices tap (far-off horns, whale blows, thunder rolling round the hills).
  const worldSend = kit.gain(1);
  kit.chain(worldSend, send.world);

  // Master chain.
  const sum = kit.gain(1);
  worldDuck.connect(sum);
  musicDuck.connect(sum);
  bus.ui.connect(sum);
  verbOut.connect(sum);
  const glue = ac.createDynamicsCompressor();
  glue.threshold.value = -20;
  glue.knee.value = 10;
  glue.ratio.value = 2.5;
  glue.attack.value = 0.012;
  glue.release.value = 0.3;
  const limiter = ac.createDynamicsCompressor();
  limiter.threshold.value = -4;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.12;
  const trim = kit.gain(TUNING.trim);
  const subCut = kit.filter('highpass', 28, 0.7);
  const clip = kit.shaper(kit.curves.softClip);
  const analyser = ac.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0;
  const master = kit.gain(0);
  // Under automation (headless QA) the graph runs and is measured, but nothing reaches the speakers.
  const out = kit.gain(silent ? 0 : 1);
  kit.chain(sum, subCut, glue, trim, limiter, clip, analyser, master, out, ac.destination);

  let volumes = { ...DEFAULT_VOLUMES };
  let muted = false;
  let duckUntil = 0;
  let muffleState = '20000|1';
  const meter = { peak: 0, rms: 0, peakHold: 0, clipped: 0, samples: new Float32Array(analyser.fftSize) };

  const ramp = (param, v, tau = 0.08) => {
    const t = now();
    param.cancelScheduledValues(t);
    param.setTargetAtTime(v, t, tau);
  };

  function applyVolumes(tau = 0.06) {
    const v = volumes;
    ramp(bus.ambience.gain, volumeCurve(v.ambience) * TUNING.bus.ambience, tau);
    ramp(bus.world.gain, volumeCurve(v.sfx) * TUNING.bus.sfx, tau);
    ramp(bus.ui.gain, volumeCurve(v.sfx) * TUNING.bus.ui, tau);
    ramp(bus.music.gain, volumeCurve(v.music) * TUNING.bus.music, tau);
    ramp(master.gain, muted ? 0 : volumeCurve(v.master), tau);
  }

  const mixer = {
    bus,
    worldSend,
    analyser,
    get volumes() {
      return { ...volumes };
    },
    setVolumes(patch) {
      volumes = mergeVolumes(volumes, patch);
      applyVolumes();
      return { ...volumes };
    },
    get muted() {
      return muted;
    },
    set muted(m) {
      muted = !!m;
      applyVolumes(0.05);
    },
    // Fades the master in (first unlock) so the ocean never starts with a click.
    fadeIn(seconds = 1.5) {
      const t = now();
      master.gain.cancelScheduledValues(t);
      master.gain.setValueAtTime(0, t);
      master.gain.linearRampToValueAtTime(muted ? 0 : volumeCurve(volumes.master), t + seconds);
    },
    // Radio / big-moment duck: music −10 dB, world −4 dB, for `seconds`.
    duck(seconds, { music = 0.3, world = 0.62 } = {}) {
      const t = now();
      const until = t + seconds;
      if (until <= duckUntil) return;
      duckUntil = until;
      for (const [node, depth] of [
        [musicDuck, music],
        [worldDuck, world],
      ]) {
        node.gain.cancelScheduledValues(t);
        node.gain.setTargetAtTime(depth, t, 0.06);
        node.gain.setTargetAtTime(1, until, 0.5);
      }
    },
    // Pause/menu muffle (see scene.muffleFor).
    setMuffle({ cutoff, gain }) {
      const key = `${cutoff}|${gain}`;
      if (key === muffleState) return;
      muffleState = key;
      ramp(muffle.frequency, cutoff, 0.12);
      ramp(muffleGain.gain, gain, 0.12);
    },
    // Output meter, sampled a few times a second (post-limiter, pre-volume).
    sample() {
      analyser.getFloatTimeDomainData(meter.samples);
      let pk = 0;
      let sum2 = 0;
      const a = meter.samples;
      for (let i = 0; i < a.length; i++) {
        const v = a[i];
        const x = v < 0 ? -v : v;
        if (x > pk) pk = x;
        sum2 += v * v;
      }
      meter.peak = pk;
      meter.rms = Math.sqrt(sum2 / a.length);
      meter.peakHold = Math.max(meter.peakHold * 0.97, pk);
      if (pk >= 0.985) meter.clipped++;
      return meter;
    },
    levels() {
      return {
        peakDb: +gainToDb(meter.peak).toFixed(1),
        rmsDb: +gainToDb(meter.rms).toFixed(1),
        peakHoldDb: +gainToDb(meter.peakHold).toFixed(1),
        clipped: meter.clipped,
        glueReductionDb: +glue.reduction.toFixed(1),
        limiterReductionDb: +limiter.reduction.toFixed(1),
      };
    },
  };
  applyVolumes(0.01);
  return mixer;
}
