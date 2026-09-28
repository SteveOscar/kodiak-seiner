// QA tools (debug API only): renders recipes, beds and music offline and draws spectrogram sheets over the canvas so
// smoke screenshots can show what the game sounds like; records a live spectrogram of the master output with markers
// for every one-shot played. Nothing here runs unless called from __KODIAK__.systems.audio.qa.

import { createKit } from './kit.js';
import { createBeds } from './beds.js';
import { SOUNDS } from './sfx.js';
import { createComposer } from './composer.js';
import { pad, pluck, whistle, drone } from './instruments.js';
import { spectrogram, levels } from './dsp.js';
import {
  newEngineState,
  engineStep,
  dieselVoice,
  DIESELS,
  oceanParams,
  lapStep,
  windParams,
  rainParams,
  hydraulicParams,
  hullWashParams,
  gainToDb,
} from './params.js';

const SR = 48000;
const STOPS = [
  [0, 0, 4],
  [40, 11, 84],
  [101, 21, 110],
  [159, 42, 99],
  [212, 72, 66],
  [245, 125, 21],
  [250, 193, 39],
  [252, 255, 164],
];
function colour(u) {
  const x = Math.min(0.9999, Math.max(0, u)) * (STOPS.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = STOPS[i];
  const b = STOPS[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

function mono(buf) {
  const n = buf.length;
  const out = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / buf.numberOfChannels;
  }
  return out;
}

// Preset bed renders: engine/sea/wind/rain/gear at typical states.
const BED_PRESETS = {
  'engine-idle': { dist: 25, engine: { throttle: 0, load: 0 } },
  'engine-half': { dist: 25, engine: { throttle: 0.5, load: 0.45 } },
  'engine-full': { dist: 25, engine: { throttle: 1, load: 0.95 } },
  'engine-wheelhouse': { dist: 5, engine: { throttle: 0.6, load: 0.5 }, muffle: 0.62 },
  'skiff-towing': { dist: 30, skiff: 0.85 },
  'ocean-offshore': { ocean: { shoreDist: 1200, camHeight: 20, hs: 0.8, windSpeed: 6 } },
  'ocean-nearshore': { ocean: { shoreDist: 60, camHeight: 12, hs: 0.8, windSpeed: 6 } },
  'ocean-storm': { ocean: { shoreDist: 900, camHeight: 20, hs: 2.6, windSpeed: 17 }, wind: { windSpeed: 17, gust: 0.8, camHeight: 20 } },
  'wind-breeze': { wind: { windSpeed: 7, gust: 0.5, camHeight: 20 } },
  'rain-deck': { rain: { rain: 0.8, interior: 0 } },
  'rain-roof': { rain: { rain: 0.8, interior: 1 } },
  'purse-winch': { dist: 10, hyd: { mode: 'purse', rate: 0.8, engineRpm: 1350 } },
  'power-block': { dist: 12, hyd: { mode: 'haul', rate: 0.9, engineRpm: 1300 } },
  'hull-wash': { dist: 15, wash: 9 },
};

async function renderBed(name, seconds) {
  const P = BED_PRESETS[name];
  if (!P) throw new Error(`unknown bed preset ${name}`);
  const oac = new OfflineAudioContext({ numberOfChannels: 2, length: Math.floor(SR * seconds), sampleRate: SR });
  const kit = createKit(oac);
  const sum = kit.gain(1);
  sum.connect(oac.destination);
  const beds = createBeds(oac, kit, { bus: { ambience: sum, world: sum } });
  const l = oac.listener;
  if (l.positionX) {
    l.positionX.value = 0;
    l.positionY.value = 2;
    l.positionZ.value = 0;
  }
  const d = P.dist ?? 20;
  if (P.ocean) {
    // Offline renders cannot be driven frame by frame; schedule the lapping envelope ahead instead.
    const op = oceanParams(P.ocean);
    beds.setOcean(op, { deep: 1, surf: 1, lap: 0.6 });
    const lapG = beds.__lapGain;
    if (lapG) {
      const st = {};
      for (let t = 0; t < seconds; t += 1 / 30) lapG.gain.setTargetAtTime(op.lapGain * lapStep(st, 1 / 30, op.lapRate), t, 0.03);
    }
  }
  if (P.wind) {
    const wp = windParams(P.wind);
    beds.setWind(wp);
    beds.whistle.need(wp.whistleGain, 0)?.set(wp, P.wind.gust ?? 0.5);
  }
  if (P.rain) beds.rain.need(1, 0)?.set(rainParams(P.rain), P.rain.interior ?? 0);
  if (P.engine) {
    const st = newEngineState();
    for (let i = 0; i < 400; i++) engineStep(st, { ...P.engine, running: true }, DIESELS.main, 0.05);
    beds.main.em.setPos(0, 3, -d);
    beds.main.em.setDistance(d, 0);
    beds.main.set(dieselVoice(st, DIESELS.main), 0.6, { muffle: P.muffle ?? 0 });
  }
  if (P.skiff) {
    const st = newEngineState();
    for (let i = 0; i < 400; i++) engineStep(st, { throttle: P.skiff, load: P.skiff * 0.8, running: true }, DIESELS.skiff, 0.05);
    const b = beds.skiff.need(1, 0);
    b.em.setPos(0, 1, -d);
    b.em.setDistance(d, 0);
    b.set(dieselVoice(st, DIESELS.skiff), 0.5);
  }
  if (P.hyd) {
    const b = beds.hydraulics.need(1, 0);
    b.em.setPos(0, 4, -d);
    b.em.setDistance(d, 0);
    b.set(hydraulicParams(P.hyd));
  }
  if (P.wash) {
    const b = beds.hullWash.need(1, 0);
    b.em.setPos(0, 0.5, -d);
    b.em.setDistance(d, 0);
    b.set(hullWashParams(P.wash), 1);
  }
  return oac.startRendering();
}

async function renderSound(name, params, seconds, rate = 1) {
  const def = SOUNDS[name];
  if (!def) throw new Error(`unknown sound ${name}`);
  const oac = new OfflineAudioContext({ numberOfChannels: 2, length: Math.floor(SR * seconds), sampleRate: SR });
  const kit = createKit(oac);
  const out = kit.gain(def.level ?? 1);
  out.connect(oac.destination);
  def.fn(kit, out, 0.05, { ...(params ?? {}), rate });
  return oac.startRendering();
}

async function renderMusic(mood, seconds) {
  const oac = new OfflineAudioContext({ numberOfChannels: 2, length: Math.floor(SR * seconds), sampleRate: SR });
  const kit = createKit(oac);
  const out = kit.gain(0.42);
  out.connect(oac.destination);
  const comp = createComposer(mood);
  let t = 0.1;
  while (t < seconds && !comp.done) {
    const bar = comp.nextBar();
    for (const e of bar.events) {
      const at = t + e.t;
      if (e.type === 'pad') pad(kit, out, at, e.midi, { dur: e.dur, vel: e.vel, attack: Math.min(1.8, e.dur * 0.35), release: 3, cutoff: 1250 });
      else if (e.type === 'drone') drone(kit, out, at, e.midi, { dur: e.dur, vel: e.vel });
      else if (e.type === 'pluck') pluck(kit, out, at, e.midi, { vel: e.vel, decay: e.dur, bright: 0.85 });
      else if (e.type === 'whistle') whistle(kit, out, at, e.midi, { dur: e.dur, vel: e.vel });
    }
    t += bar.duration;
  }
  return oac.startRendering();
}

function drawSpec(g, samples, x, y, w, h, { fMin = 30, fMax = 16000, dbLo = -100, dbHi = -15 } = {}) {
  const size = 1024;
  const hop = Math.max(64, Math.floor(samples.length / w / 64) * 64 || 64);
  const sp = spectrogram(samples, { size, hop });
  const img = g.createImageData(w, h);
  const binHz = SR / size;
  const nF = sp.frames.length || 1;
  for (let px = 0; px < w; px++) {
    const fr = sp.frames[Math.min(nF - 1, Math.floor((px / w) * nF))];
    for (let py = 0; py < h; py++) {
      const f = fMin * Math.pow(fMax / fMin, 1 - py / (h - 1));
      const b = Math.min(sp.bins - 1, Math.max(1, Math.round(f / binHz)));
      const db = fr ? fr[b] : dbLo;
      const [r, gg, bb] = colour((db - dbLo) / (dbHi - dbLo));
      const i = (py * w + px) * 4;
      img.data[i] = r;
      img.data[i + 1] = gg;
      img.data[i + 2] = bb;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, x, y);
  // Frequency guides.
  g.strokeStyle = 'rgba(255,255,255,0.18)';
  g.fillStyle = 'rgba(255,255,255,0.55)';
  g.font = '9px ui-monospace, Menlo, monospace';
  for (const f of [100, 1000, 10000]) {
    const py = y + (1 - Math.log(f / fMin) / Math.log(fMax / fMin)) * (h - 1);
    g.beginPath();
    g.moveTo(x, py);
    g.lineTo(x + w, py);
    g.stroke();
    g.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 2, py - 2);
  }
}

function drawEnvelope(g, samples, x, y, w, h) {
  g.fillStyle = '#0e151c';
  g.fillRect(x, y, w, h);
  const per = Math.max(1, Math.floor(samples.length / w));
  g.fillStyle = '#7fd1c7';
  for (let px = 0; px < w; px++) {
    let pk = 0;
    const s0 = px * per;
    for (let i = s0; i < s0 + per && i < samples.length; i++) pk = Math.max(pk, Math.abs(samples[i]));
    const db = Math.max(-60, gainToDb(pk));
    const hh = ((db + 60) / 60) * h;
    g.fillRect(x + px, y + h - hh, 1, hh);
  }
  g.fillStyle = pkClip(samples) ? '#ff5a4a' : 'rgba(255,255,255,0.25)';
  g.fillRect(x, y, w, 1);
}
const pkClip = (s) => levels(s).peak >= 0.99;

export function createQa(getA, ctx) {
  let overlay = null;
  const live = { on: false, frames: [], marks: [], t0: 0, acc: 0, bins: null };

  function ensureOverlay() {
    if (overlay) return overlay;
    const c = document.createElement('canvas');
    c.width = window.innerWidth;
    c.height = window.innerHeight;
    Object.assign(c.style, { position: 'fixed', left: '0', top: '0', width: '100vw', height: '100vh', zIndex: '99999', pointerEvents: 'none' });
    document.body.appendChild(c);
    overlay = c;
    return c;
  }

  const api = {
    presets: Object.keys(BED_PRESETS),

    // Offline render → { name, peakDb, rmsDb, seconds }. kind: 'sfx' | 'bed' | 'music'.
    async render({ kind = 'sfx', name, params, seconds = 3, rate = 1 } = {}) {
      const buf = kind === 'bed' ? await renderBed(name, seconds) : kind === 'music' ? await renderMusic(name, seconds) : await renderSound(name, params, seconds, rate);
      const m = mono(buf);
      const lv = levels(m);
      let nan = 0;
      for (let i = 0; i < m.length; i += 7) if (!Number.isFinite(m[i])) nan++;
      return { kind, name, seconds, samples: m, peakDb: +lv.peakDb.toFixed(1), rmsDb: +lv.rmsDb.toFixed(1), nan };
    },

    // Draws a grid of spectrograms (log frequency 30 Hz–16 kHz, time →) with envelopes and levels.
    // items: [{ label, kind, name, params, seconds, rate }] → [{ label, peakDb, rmsDb }]
    async sheet(items, { title = 'Kodiak Seiner — procedural audio', cols = 4 } = {}) {
      const c = ensureOverlay();
      const g = c.getContext('2d');
      g.fillStyle = '#0b1016';
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = '#e8e2d6';
      g.font = '600 18px Georgia, serif';
      g.fillText(title, 18, 30);
      g.font = '11px ui-monospace, Menlo, monospace';
      g.fillStyle = 'rgba(232,226,214,0.6)';
      g.fillText('spectrogram: log frequency 30 Hz – 16 kHz, time →, −100…−15 dBFS; strip: peak envelope (−60…0 dB)', 18, 48);
      const rows = Math.ceil(items.length / cols);
      const pad0 = 14;
      const cw = Math.floor((c.width - pad0 * (cols + 1)) / cols);
      const ch = Math.floor((c.height - 64 - pad0 * (rows + 1)) / rows);
      const out = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const x = pad0 + (i % cols) * (cw + pad0);
        const y = 64 + pad0 + Math.floor(i / cols) * (ch + pad0);
        let r;
        try {
          r = await api.render(it);
        } catch (err) {
          g.fillStyle = '#ff5a4a';
          g.fillText(`${it.label ?? it.name}: ${err.message}`, x, y + 14);
          out.push({ label: it.label ?? it.name, error: err.message });
          continue;
        }
        const specH = ch - 42;
        drawSpec(g, r.samples, x, y + 18, cw, specH);
        drawEnvelope(g, r.samples, x, y + 18 + specH + 2, cw, 20);
        g.fillStyle = '#e8e2d6';
        g.font = '600 12px ui-sans-serif, system-ui, sans-serif';
        g.fillText(it.label ?? it.name, x, y + 12);
        g.font = '11px ui-monospace, Menlo, monospace';
        g.fillStyle = r.peakDb > -1 ? '#ff5a4a' : 'rgba(232,226,214,0.7)';
        const txt = `pk ${r.peakDb} rms ${r.rmsDb} dB`;
        g.fillText(txt, x + cw - g.measureText(txt).width, y + 12);
        out.push({ label: it.label ?? it.name, peakDb: r.peakDb, rmsDb: r.rmsDb, nan: r.nan });
      }
      return out;
    },

    clear() {
      overlay?.remove();
      overlay = null;
    },

    // Piano roll of the generative music (pure composer output, no audio): one lane per mood.
    pianoRoll(moods = ['title', 'dawn', 'triumph'], { bars = 16, seed = 1 } = {}) {
      const c = ensureOverlay();
      const g = c.getContext('2d');
      g.fillStyle = '#0b1016';
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = '#e8e2d6';
      g.font = '600 18px Georgia, serif';
      g.fillText('Generative music — piano roll (drone, pads, plucked motif, tin whistle)', 18, 30);
      const colours = { drone: 'rgba(90,140,200,0.35)', pad: 'rgba(127,209,199,0.45)', pluck: '#ffb070', whistle: '#ff7a1a' };
      const laneH = Math.floor((c.height - 70) / moods.length);
      const out = {};
      moods.forEach((mood, li) => {
        let s0 = seed * 9301 + li * 49297;
        const rnd = () => ((s0 = (s0 * 9301 + 49297) % 233280) / 233280);
        const comp = createComposer(mood, rnd);
        const evs = [];
        let t = 0;
        for (let b = 0; b < bars && !comp.done; b++) {
          const bar = comp.nextBar();
          for (const e of bar.events) evs.push({ ...e, at: t + e.t });
          t += bar.duration;
        }
        const T = t || 1;
        const y0 = 50 + li * laneH;
        const lo = 26;
        const hi = 90;
        const h = laneH - 26;
        const x0 = 60;
        const w = c.width - 80;
        g.fillStyle = '#10171f';
        g.fillRect(x0, y0 + 18, w, h);
        g.fillStyle = '#e8e2d6';
        g.font = '600 12px ui-sans-serif, system-ui, sans-serif';
        g.fillText(`${mood} — ${bars} bars, ${T.toFixed(0)} s`, x0, y0 + 12);
        g.font = '10px ui-monospace, Menlo, monospace';
        for (let m = 36; m <= 84; m += 12) {
          const py = y0 + 18 + h - ((m - lo) / (hi - lo)) * h;
          g.fillStyle = 'rgba(255,255,255,0.12)';
          g.fillRect(x0, py, w, 1);
          g.fillStyle = 'rgba(255,255,255,0.5)';
          g.fillText(`C${m / 12 - 1}`, 18, py + 3);
        }
        let notes = 0;
        for (const e of evs) {
          const ms = Array.isArray(e.midi) ? e.midi : [e.midi];
          for (const m of ms) {
            const px = x0 + (e.at / T) * w;
            const pw = Math.max(2, (Math.min(e.dur, T - e.at) / T) * w);
            const py = y0 + 18 + h - ((m - lo) / (hi - lo)) * h;
            g.fillStyle = colours[e.type] ?? '#fff';
            g.fillRect(px, py - 2, e.type === 'pluck' ? Math.max(3, pw * 0.25) : pw, 4);
            notes++;
          }
        }
        out[mood] = { bars, seconds: +T.toFixed(1), notes };
      });
      return out;
    },

    // RMS/peak per bus (pre-duck), from analysers attached on first use.
    busLevels() {
      const A = getA();
      if (!A) return null;
      if (!A.__busMeters) {
        A.__busMeters = {};
        for (const [k, node] of Object.entries(A.mixer.bus)) {
          const an = A.ac.createAnalyser();
          an.fftSize = 2048;
          node.connect(an);
          A.__busMeters[k] = { an, buf: new Float32Array(2048) };
        }
      }
      const out = {};
      for (const [k, m] of Object.entries(A.__busMeters)) {
        m.an.getFloatTimeDomainData(m.buf);
        const lv = levels(m.buf);
        out[k] = { rmsDb: +lv.rmsDb.toFixed(1), peakDb: +lv.peakDb.toFixed(1) };
      }
      out.master = A.mixer.levels();
      return out;
    },

    // Live spectrogram of the master output, sampled every 100 ms, with a marker for each one-shot played.
    startLive() {
      const A = getA();
      if (!A) return false;
      live.on = true;
      live.frames = [];
      live.marks = [];
      live.t0 = A.ac.currentTime;
      live.bins = new Float32Array(A.mixer.analyser.frequencyBinCount);
      live.rms = [];
      const orig = A.player.play;
      if (!A.player.__qaWrapped) {
        A.player.__qaWrapped = true;
        A.player.play = (name, opts) => {
          const id = orig(name, opts);
          if (live.on && id !== null) live.marks.push({ t: A.ac.currentTime - live.t0 + (opts?.delay ?? 0), name });
          return id;
        };
      }
      return true;
    },
    stopLive() {
      live.on = false;
    },
    mark(label) {
      const A = getA();
      if (A && live.on) live.marks.push({ t: A.ac.currentTime - live.t0, name: label, strong: true });
    },
    tick() {
      if (!live.on) return;
      const A = getA();
      if (!A) return;
      const t = A.ac.currentTime - live.t0;
      if (t - live.acc < 0.1) return;
      live.acc = t;
      A.mixer.analyser.getFloatFrequencyData(live.bins);
      live.frames.push({ t, bins: live.bins.slice(0, 700) });
      const m = A.mixer.sample();
      live.rms.push({ t, rms: m.rms, peak: m.peak });
      if (live.frames.length > 3600) live.frames.shift();
    },
    showLive({ title = 'Live mix (master, pre-volume)' } = {}) {
      const A = getA();
      const c = ensureOverlay();
      const g = c.getContext('2d');
      g.fillStyle = '#0b1016';
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = '#e8e2d6';
      g.font = '600 18px Georgia, serif';
      g.fillText(title, 18, 30);
      const x0 = 50;
      const y0 = 60;
      const w = c.width - 70;
      const h = c.height - 250;
      const fr = live.frames;
      if (!fr.length || !A) return { frames: 0 };
      const T = fr[fr.length - 1].t || 1;
      const binHz = A.ac.sampleRate / A.mixer.analyser.fftSize;
      const fMin = 30;
      const fMax = 12000;
      const img = g.createImageData(w, h);
      for (let px = 0; px < w; px++) {
        const f0 = fr[Math.min(fr.length - 1, Math.floor((px / w) * fr.length))];
        for (let py = 0; py < h; py++) {
          const f = fMin * Math.pow(fMax / fMin, 1 - py / (h - 1));
          const b = Math.min(f0.bins.length - 1, Math.max(1, Math.round(f / binHz)));
          const [r, gg, bb] = colour((f0.bins[b] + 110) / 90);
          const i = (py * w + px) * 4;
          img.data[i] = r;
          img.data[i + 1] = gg;
          img.data[i + 2] = bb;
          img.data[i + 3] = 255;
        }
      }
      g.putImageData(img, x0, y0);
      g.font = '10px ui-monospace, Menlo, monospace';
      g.fillStyle = 'rgba(255,255,255,0.6)';
      for (const f of [50, 100, 300, 1000, 3000, 10000]) {
        const py = y0 + (1 - Math.log(f / fMin) / Math.log(fMax / fMin)) * (h - 1);
        g.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, 8, py + 3);
      }
      // Level strip.
      const ly = y0 + h + 8;
      g.fillStyle = '#0e151c';
      g.fillRect(x0, ly, w, 60);
      for (const r of live.rms) {
        const px = x0 + (r.t / T) * w;
        const rh = ((Math.max(-60, gainToDb(r.rms)) + 60) / 60) * 60;
        const ph = ((Math.max(-60, gainToDb(r.peak)) + 60) / 60) * 60;
        g.fillStyle = 'rgba(127,209,199,0.35)';
        g.fillRect(px, ly + 60 - ph, 2, ph);
        g.fillStyle = '#7fd1c7';
        g.fillRect(px, ly + 60 - rh, 2, rh);
      }
      g.fillStyle = 'rgba(255,255,255,0.5)';
      g.fillText('RMS / peak  −60…0 dBFS', x0 + 4, ly + 12);
      // Markers.
      const counts = {};
      let lane = 0;
      for (const m of live.marks) {
        const px = x0 + (m.t / T) * w;
        counts[m.name] = (counts[m.name] ?? 0) + 1;
        g.strokeStyle = m.strong ? 'rgba(255,122,26,0.9)' : 'rgba(255,255,255,0.22)';
        g.beginPath();
        g.moveTo(px, y0);
        g.lineTo(px, y0 + h);
        g.stroke();
        if (m.strong || counts[m.name] <= 3) {
          g.fillStyle = m.strong ? '#ff7a1a' : 'rgba(255,255,255,0.85)';
          g.fillText(m.name, px + 2, ly + 76 + (lane % 6) * 11);
          lane++;
        }
      }
      g.fillStyle = 'rgba(255,255,255,0.6)';
      g.fillText(`${T.toFixed(1)} s · ${live.marks.length} one-shots · ${Object.entries(counts).map(([k, v]) => `${k}×${v}`).join('  ')}`.slice(0, 220), x0, c.height - 14);
      return { frames: fr.length, seconds: T, counts };
    },
  };
  return api;
}
