// Pure DSP helpers for the procedural audio: noise and texture buffers, periodic-wave spectra, the reverb impulse,
// a soft-clip curve and an FFT for the QA spectrograms. No WebAudio or DOM here, so everything is unit-testable.

import { mulberry32 } from '../core/rng.js';

export const TAU = Math.PI * 2;

export function rand(seed = 1) {
  return mulberry32(seed);
}

export function fillWhite(out, rnd) {
  for (let i = 0; i < out.length; i++) out[i] = rnd() * 2 - 1;
  return out;
}

// Paul Kellet's refined pink filter (-3 dB/octave within ~0.05 dB above 9 Hz).
export function fillPink(out, rnd) {
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let i = 0; i < out.length; i++) {
    const w = rnd() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return out;
}

// Leaky-integrated white noise (-6 dB/octave): surf rumble, wind body, engine exhaust.
export function fillBrown(out, rnd) {
  let last = 0;
  for (let i = 0; i < out.length; i++) {
    const w = rnd() * 2 - 1;
    last = (last + 0.02 * w) / 1.02;
    out[i] = last * 3.5;
  }
  return out;
}

export function removeDC(out) {
  let m = 0;
  for (let i = 0; i < out.length; i++) m += out[i];
  m /= out.length || 1;
  for (let i = 0; i < out.length; i++) out[i] -= m;
  return out;
}

export function peakOf(a) {
  let p = 0;
  for (let i = 0; i < a.length; i++) {
    const v = Math.abs(a[i]);
    if (v > p) p = v;
  }
  return p;
}

export function normalize(out, peak = 0.9) {
  const p = peakOf(out);
  if (p > 0) {
    const k = peak / p;
    for (let i = 0; i < out.length; i++) out[i] *= k;
  }
  return out;
}

// Returns a copy `n` samples shorter whose end runs seamlessly into its start (equal-power crossfade of the tail
// into the head), so looping noise beds never click at the loop point.
export function seamless(src, n) {
  const len = src.length - n;
  const out = new Float32Array(len);
  out.set(src.subarray(0, len));
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const a = Math.sin(t * Math.PI * 0.5);
    const b = Math.cos(t * Math.PI * 0.5);
    out[i] = src[i] * a + src[len + i] * b;
  }
  return out;
}

// Sparse drop texture: short damped sinusoids of random pitch and log-distributed loudness. Rain patter when looped
// dense, pebble rattle in a surf backwash, radio crackle when band-passed, spray falling back after a splash.
export function fillDrops(out, sampleRate, rnd, { rate = 300, fMin = 1800, fMax = 9000, dMin = 0.0015, dMax = 0.007 } = {}) {
  const n = Math.round((out.length / sampleRate) * rate);
  for (let k = 0; k < n; k++) {
    const start = Math.floor(rnd() * out.length);
    const f = fMin * Math.pow(fMax / fMin, rnd());
    const d = dMin + (dMax - dMin) * rnd();
    const amp = Math.pow(10, -rnd() * 1.6) * (rnd() < 0.5 ? -1 : 1);
    const len = Math.min(Math.floor(d * 6 * sampleRate), 2000);
    const w = (TAU * f) / sampleRate;
    const decay = Math.exp(-1 / (d * sampleRate));
    let e = 1;
    for (let i = 0; i < len; i++) {
      const j = (start + i) % out.length;
      out[j] += amp * e * Math.sin(w * i + (i === 0 ? 0 : 0.3));
      e *= decay;
    }
    // A tiny click at the impact.
    out[start] += amp * 0.6;
  }
  return out;
}

// Stereo reverb impulse: sparse early reflections, then exponentially decaying noise that darkens over time
// (a one-pole low-pass whose coefficient slides from `bright` to `dark`). Decorrelated channels.
export function impulseResponse(sampleRate, seconds, rnd, { decay = 1.1, predelay = 0.012, bright = 0.85, dark = 0.12, early = 10 } = {}) {
  const len = Math.max(1, Math.floor(seconds * sampleRate));
  const chans = [new Float32Array(len), new Float32Array(len)];
  const pre = Math.floor(predelay * sampleRate);
  for (const ch of chans) {
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / sampleRate;
      const k = bright + (dark - bright) * Math.min(1, t / seconds);
      lp += k * (rnd() * 2 - 1 - lp);
      ch[i] = lp * Math.exp(-t / (decay / 3)) * (1 - Math.exp(-t * 60));
    }
    for (let e = 0; e < early; e++) {
      const i = pre + Math.floor(rnd() * 0.08 * sampleRate);
      if (i < len) ch[i] += (rnd() * 2 - 1) * 0.5 * (1 - e / early);
    }
  }
  const p = Math.max(peakOf(chans[0]), peakOf(chans[1])) || 1;
  for (const ch of chans) for (let i = 0; i < len; i++) ch[i] /= p;
  return chans;
}

// One full four-stroke cycle of a diesel's exhaust pressure at the stack: `pulses` firing pulses with small timing
// and strength irregularities (the lope that makes it chug), each a sharp rise and a ringing decay.
export function dieselCycle(n, { pulses = 6, rnd = rand(7), jitter = 0.018, spread = 0.16, ring = 5.5, width = 0.45 } = {}) {
  const out = new Float32Array(n);
  const slot = 1 / pulses;
  for (let p = 0; p < pulses; p++) {
    const at = (p + (rnd() * 2 - 1) * jitter * pulses) * slot;
    const amp = 1 - spread * rnd() - (p === 0 ? 0 : 0.04);
    const len = slot * width;
    for (let i = 0; i < n; i++) {
      let t = i / n - at;
      if (t < 0) t += 1;
      if (t >= len * 3) continue;
      const u = t / len; // 0..3
      const env = (1 - Math.exp(-u * 40)) * Math.exp(-u * 2.2);
      out[i] += amp * env * (0.75 + 0.25 * Math.cos(TAU * ring * u));
    }
  }
  removeDC(out);
  return normalize(out, 1);
}

// Fourier coefficients (cosine = real, sine = imag) of one period of `wave` for harmonics 1..count, as
// createPeriodicWave expects (index 0 is DC and ignored).
export function harmonicsOf(wave, count) {
  const n = wave.length;
  const real = new Float32Array(count + 1);
  const imag = new Float32Array(count + 1);
  for (let h = 1; h <= count; h++) {
    let re = 0;
    let im = 0;
    const w = (TAU * h) / n;
    for (let i = 0; i < n; i++) {
      re += wave[i] * Math.cos(w * i);
      im += wave[i] * Math.sin(w * i);
    }
    real[h] = (2 * re) / n;
    imag[h] = (2 * im) / n;
  }
  return { real, imag };
}

// A plucked string: harmonic n has amplitude |sin(n·π·pos)| / n^1.15, rolled off by brightness^n.
export function stringHarmonics(count = 40, { pos = 0.18, bright = 0.92 } = {}) {
  const real = new Float32Array(count + 1);
  const imag = new Float32Array(count + 1);
  for (let n = 1; n <= count; n++) imag[n] = (Math.abs(Math.sin(n * Math.PI * pos)) / Math.pow(n, 1.15)) * Math.pow(bright, n - 1);
  return { real, imag };
}

// Warm pad oscillator: odd-leaning saw with a soft top.
export function padHarmonics(count = 24) {
  const real = new Float32Array(count + 1);
  const imag = new Float32Array(count + 1);
  for (let n = 1; n <= count; n++) imag[n] = (n % 2 ? 1 : 0.55) / n / (1 + n * n * 0.004);
  return { real, imag };
}

// Transfer curve for a WaveShaper safety clipper: linear below `knee`, then a tanh shoulder that never exceeds `ceil`.
export function softClipCurve(n = 2048, knee = 0.8, ceil = 0.985) {
  const c = new Float32Array(n);
  const room = ceil - knee;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + room * Math.tanh((a - knee) / room);
    c[i] = Math.sign(x) * y;
  }
  return c;
}

// Mild grit for radio squelch: an asymmetric tanh.
export function gritCurve(n = 1024, drive = 3) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(drive * x + 0.15 * x * x) / Math.tanh(drive);
  }
  return c;
}

// In-place iterative radix-2 FFT. re/im lengths must be the same power of two.
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -TAU / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

// Magnitude spectrogram (dB) with a Hann window: → { frames: Float32Array[], bins, hop, size }.
export function spectrogram(samples, { size = 1024, hop = 256 } = {}) {
  const frames = [];
  const win = new Float32Array(size);
  for (let i = 0; i < size; i++) win[i] = 0.5 - 0.5 * Math.cos((TAU * i) / (size - 1));
  const re = new Float32Array(size);
  const im = new Float32Array(size);
  for (let start = 0; start + size <= samples.length; start += hop) {
    for (let i = 0; i < size; i++) {
      re[i] = samples[start + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    const mag = new Float32Array(size / 2);
    for (let k = 0; k < size / 2; k++) mag[k] = 20 * Math.log10(Math.hypot(re[k], im[k]) / (size / 4) + 1e-9);
    frames.push(mag);
  }
  return { frames, bins: size / 2, hop, size };
}

export function levels(samples) {
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
  return { peak, rms, peakDb: db(peak), rmsDb: db(rms) };
}
