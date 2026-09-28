// Wake-wave and trail field model (pure; no THREE, no DOM). foamField.js runs it on the GPU; createWakeSimCPU below
// mirrors the shader step for the unit tests (change one side, change the other).
//
// Per texel, per step (all neighbours read the previous state):
//   push  = P - avg                                  stamp pressure minus its moving average (high-pass)
//   v'    = clamp((v + lap(h) c^2 dt / dx^2 - w0^2 dt h - force dt push) * exp(-damping dt), +-3 H)
//   h'    = H tanh((h + v' dt) / H)                  soft limit: steeper waves break instead of growing
//   avg'  = avg + (1 - exp(-dt / PRESSURE_TAU)) (P - avg)
//   trail'= max((g + D dt / dx^2 lap(g)) * 0.5^(dt / WAKE_HALF_LIFE), trailInput(level))
// A pressure patch moving at U > c leaves a V inside the Mach cone asin(c / U). The restoring term w0^2 slows the long
// waves, so the visible V is narrower than the cone (~15-22 degrees at 6 m/s, Kelvin's 19.5, and ~13 at 10 m/s:
// narrowing at speed as real wakes do, Rabaud & Moisy 2013) and its interior rings with crests every ~2 pi U / w0
// along the track (27 m at 6 m/s, the Kelvin transverse wavelength 2 pi U^2 / g is 23 m).

export const WAKE = {
  c: 3.0, // m/s wave speed (the Mach cone asin(c / U) bounds the V)
  damping: 0.055, // 1/s velocity damping (amplitude e-folds in ~18 s, plus geometric spreading)
  restore: 2.0, // 1/s^2 restoring term (omega0^2)
  force: 26, // m/s^2 downward acceleration per unit of pressure change
  maxHeight: 0.45, // m, soft limit on wake waves (steeper ones break): sudden big splashes stay sane
  trailDiffusion: 0.22, // m^2/s spreading of the aerated trail
  sponge: [0.4, 0.49], // window fraction (Chebyshev, from the centre) over which waves are absorbed
};

export const PRESSURE_TAU = 0.35; // s, moving-average window of the stamp pressure

// Per-step coefficients. dt is clamped so one explicit step stays stable (Courant number c dt / dx <= 0.6).
export function wakeParams(dt, texel) {
  const h = Math.min(Math.max(0, dt), (0.6 * texel) / WAKE.c);
  return {
    dt: h,
    lap: (WAKE.c * WAKE.c * h) / (texel * texel),
    restore: WAKE.restore * h,
    force: WAKE.force * h,
    damp: Math.exp(-WAKE.damping * h),
    diffuse: Math.min(0.24, (WAKE.trailDiffusion * h) / (texel * texel)),
    avgK: 1 - Math.exp(-Math.max(0, dt) / PRESSURE_TAU),
  };
}

// Stamp level -> trail input: only real wash lingers (weak lace, corklines and bow-wave spray do not).
export function trailInput(level) {
  const t = Math.min(1, Math.max(0, (level - 0.15) / 0.4));
  return t * t * (3 - 2 * t) * 0.9;
}

// Stamp level -> wave pressure at the stamp centre: weak stamps barely push, so waves come from hulls and splashes.
export function stampPressure(level) {
  const t = Math.min(1, Math.max(0, (level - 0.12) / 0.33));
  return level * t * t * (3 - 2 * t);
}

// CPU reference of the GPU step on an n x n periodic grid (tests only).
export function createWakeSimCPU({ n = 128, texel = 1 } = {}) {
  const size = n * n;
  let h = new Float32Array(size);
  let v = new Float32Array(size);
  let h2 = new Float32Array(size);
  let v2 = new Float32Array(size);
  const avg = new Float32Array(size);
  const pressure = new Float32Array(size);
  const H = WAKE.maxHeight;
  const sim = {
    n,
    texel,
    get h() {
      return h;
    },
    get v() {
      return v;
    },
    avg,
    pressure,
    // Adds a stamp's pressure (max-blended, as on the GPU) for the coming step. x, z in metres from the grid corner.
    stamp(x, z, radius, level) {
      const p0 = stampPressure(level);
      if (p0 <= 0) return;
      const r = radius / texel;
      const cx = x / texel - 0.5;
      const cz = z / texel - 0.5;
      for (let j = Math.floor(cz - r); j <= Math.ceil(cz + r); j++) {
        for (let i = Math.floor(cx - r); i <= Math.ceil(cx + r); i++) {
          const q = Math.hypot(i - cx, j - cz) / r;
          if (q >= 1) continue;
          const b = 1 - q * q;
          const k = (((j % n) + n) % n) * n + (((i % n) + n) % n);
          pressure[k] = Math.max(pressure[k], p0 * b * b);
        }
      }
    },
    step(dt) {
      const p = wakeParams(dt, texel);
      for (let j = 0; j < n; j++) {
        const jm = ((j + n - 1) % n) * n;
        const jp = ((j + 1) % n) * n;
        const jr = j * n;
        for (let i = 0; i < n; i++) {
          const k = jr + i;
          const im = (i + n - 1) % n;
          const ip = (i + 1) % n;
          const lap = h[jr + im] + h[jr + ip] + h[jm + i] + h[jp + i] - 4 * h[k];
          const push = pressure[k] - avg[k];
          let vv = (v[k] + p.lap * lap - p.restore * h[k] - p.force * push) * p.damp;
          vv = Math.min(3 * H, Math.max(-3 * H, vv));
          v2[k] = vv;
          h2[k] = H * Math.tanh((h[k] + vv * p.dt) / H);
        }
      }
      [h, h2] = [h2, h];
      [v, v2] = [v2, v];
      for (let k = 0; k < size; k++) {
        avg[k] += p.avgK * (pressure[k] - avg[k]);
        pressure[k] = 0;
      }
    },
  };
  return sim;
}
