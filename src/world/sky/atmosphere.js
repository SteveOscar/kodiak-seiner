// Physically based atmosphere (after Hillaire 2020, "A Scalable and Production Ready Sky and Atmosphere Rendering
// Technique"): Rayleigh + Mie single scattering with ozone absorption and a multiple-scattering transfer LUT.
// Pure JS (no THREE/DOM). The transmittance and multiple-scattering LUTs are computed here once and uploaded to the
// GPU unchanged, so CPU lighting (sun colour, ambient, fog colour) and the GPU sky dome share one model.
//
// Units: kilometres. Radiance is returned per unit solar illuminance (the caller scales by the sun's intensity).

export const ATMOSPHERE = {
  bottom: 6360,
  top: 6460,
  rayleighScattering: [5.802e-3, 13.558e-3, 33.1e-3],
  rayleighScale: 8,
  // Maritime haze: Mie coefficients ×1.8 of the standard atmosphere (Kodiak rarely has an alpine-clear sky).
  mieScattering: 3.996e-3 * 1.8,
  mieExtinction: 4.4e-3 * 1.8,
  mieScale: 1.2,
  mieG: 0.8,
  ozoneAbsorption: [0.65e-3, 1.881e-3, 0.085e-3],
  ozoneCenter: 25,
  ozoneWidth: 15,
  groundAlbedo: 0.1,
  // Camera altitude used for the sky (km). The game camera is always near sea level.
  viewAltitude: 0.05,
};

export const TRANSMITTANCE_SIZE = [128, 32];
export const MULTISCATTER_SIZE = [32, 16];
const SUN_ANGULAR_RADIUS = 0.00465;

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

// Bruneton's unit-range <-> texel-centre mapping: keeps samples inside the LUT's texel centres.
export const coordFromUnit = (x, size) => 0.5 / size + x * (1 - 1 / size);
export const unitFromCoord = (u, size) => (u - 0.5 / size) / (1 - 1 / size);

export function distanceToTop(r, mu, A = ATMOSPHERE) {
  const disc = r * r * (mu * mu - 1) + A.top * A.top;
  return Math.max(0, -r * mu + Math.sqrt(Math.max(0, disc)));
}

export function distanceToBottom(r, mu, A = ATMOSPHERE) {
  const disc = r * r * (mu * mu - 1) + A.bottom * A.bottom;
  return Math.max(0, -r * mu - Math.sqrt(Math.max(0, disc)));
}

export function hitsGround(r, mu, A = ATMOSPHERE) {
  return mu < 0 && r * r * (mu * mu - 1) + A.bottom * A.bottom >= 0;
}

// Medium coefficients at altitude h (km) into out = { sR: [3], sM, ext: [3] }.
export function medium(h, A, out) {
  const rho = Math.exp(-h / A.rayleighScale);
  const mie = Math.exp(-h / A.mieScale);
  const oz = Math.max(0, 1 - Math.abs(h - A.ozoneCenter) / A.ozoneWidth);
  for (let c = 0; c < 3; c++) {
    out.sR[c] = A.rayleighScattering[c] * rho;
    out.ext[c] = A.rayleighScattering[c] * rho + A.mieExtinction * mie + A.ozoneAbsorption[c] * oz;
  }
  out.sM = A.mieScattering * mie;
  return out;
}

export function transmittanceUV(r, mu, A = ATMOSPHERE) {
  const H = Math.sqrt(A.top * A.top - A.bottom * A.bottom);
  const rho = Math.sqrt(Math.max(0, r * r - A.bottom * A.bottom));
  const d = distanceToTop(r, mu, A);
  const dMin = A.top - r;
  const dMax = rho + H;
  const xMu = (d - dMin) / Math.max(1e-6, dMax - dMin);
  const xR = rho / H;
  return [coordFromUnit(clamp(xMu, 0, 1), TRANSMITTANCE_SIZE[0]), coordFromUnit(clamp(xR, 0, 1), TRANSMITTANCE_SIZE[1])];
}

function transmittanceRMu(u, v, A) {
  const xMu = unitFromCoord(u, TRANSMITTANCE_SIZE[0]);
  const xR = unitFromCoord(v, TRANSMITTANCE_SIZE[1]);
  const H = Math.sqrt(A.top * A.top - A.bottom * A.bottom);
  const rho = H * xR;
  const r = Math.sqrt(rho * rho + A.bottom * A.bottom);
  const dMin = A.top - r;
  const dMax = rho + H;
  const d = dMin + xMu * (dMax - dMin);
  const mu = d === 0 ? 1 : clamp((H * H - rho * rho - d * d) / (2 * r * d), -1, 1);
  return [r, mu];
}

// Bilinear lookup in an RGBA float LUT at texture coordinates (u, v) ∈ [0, 1].
export function sampleLUT(lut, u, v, out = [0, 0, 0]) {
  const { width: w, height: h, data } = lut;
  const x = clamp(u * w - 0.5, 0, w - 1);
  const y = clamp(v * h - 0.5, 0, h - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  for (let c = 0; c < 3; c++) {
    const a = data[(y0 * w + x0) * 4 + c];
    const b = data[(y0 * w + x1) * 4 + c];
    const d = data[(y1 * w + x0) * 4 + c];
    const e = data[(y1 * w + x1) * 4 + c];
    out[c] = (a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty;
  }
  return out;
}

function buildTransmittance(A) {
  const [W, H] = TRANSMITTANCE_SIZE;
  const data = new Float32Array(W * H * 4);
  const m = { sR: [0, 0, 0], sM: 0, ext: [0, 0, 0] };
  const steps = 40;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const [r, mu] = transmittanceRMu((i + 0.5) / W, (j + 0.5) / H, A);
      const tMax = distanceToTop(r, mu, A);
      const dt = tMax / steps;
      const od = [0, 0, 0];
      for (let s = 0; s < steps; s++) {
        const t = (s + 0.5) * dt;
        const h = Math.sqrt(r * r + t * t + 2 * r * mu * t) - A.bottom;
        medium(h, A, m);
        for (let c = 0; c < 3; c++) od[c] += m.ext[c] * dt;
      }
      const k = (j * W + i) * 4;
      data[k] = Math.exp(-od[0]);
      data[k + 1] = Math.exp(-od[1]);
      data[k + 2] = Math.exp(-od[2]);
      data[k + 3] = 1;
    }
  }
  return { width: W, height: H, data };
}

export function multiScatterUV(r, muS, A = ATMOSPHERE) {
  return [
    coordFromUnit(clamp(muS * 0.5 + 0.5, 0, 1), MULTISCATTER_SIZE[0]),
    coordFromUnit(clamp((r - A.bottom) / (A.top - A.bottom), 0, 1), MULTISCATTER_SIZE[1]),
  ];
}

export function createAtmosphere(params = {}) {
  const A = { ...ATMOSPHERE, ...params };
  const transmittanceLUT = buildTransmittance(A);
  const m = { sR: [0, 0, 0], sM: 0, ext: [0, 0, 0] };
  const tmp = [0, 0, 0];

  // Transmittance from radius r toward direction cosine mu (0 when the planet blocks it, softened across the sun's
  // disc so sunsets fade instead of switching off).
  function transmittance(r, mu, out = [0, 0, 0]) {
    const [u, v] = transmittanceUV(r, mu, A);
    sampleLUT(transmittanceLUT, u, v, out);
    const sinH = A.bottom / r;
    const muHorizon = -Math.sqrt(Math.max(0, 1 - sinH * sinH));
    const vis = smoothstep(-SUN_ANGULAR_RADIUS, SUN_ANGULAR_RADIUS, mu - muHorizon);
    out[0] *= vis;
    out[1] *= vis;
    out[2] *= vis;
    return out;
  }

  // Multiple scattering LUT (isotropic Ψms per unit illuminance).
  const msLUT = (() => {
    const [W, H] = MULTISCATTER_SIZE;
    const data = new Float32Array(W * H * 4);
    const N = 8;
    const steps = 16;
    const T = [0, 0, 0];
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const muS = unitFromCoord((i + 0.5) / W, W) * 2 - 1;
        const r = A.bottom + unitFromCoord((j + 0.5) / H, H) * (A.top - A.bottom) + 1e-3;
        const sun = [0, muS, Math.sqrt(Math.max(0, 1 - muS * muS))];
        const L2 = [0, 0, 0];
        const fms = [0, 0, 0];
        for (let a = 0; a < N; a++) {
          for (let b = 0; b < N; b++) {
            const theta = (2 * Math.PI * (a + 0.5)) / N;
            const phi = Math.acos(1 - (2 * (b + 0.5)) / N);
            const dir = [Math.cos(theta) * Math.sin(phi), Math.cos(phi), Math.sin(theta) * Math.sin(phi)];
            const mu = dir[1];
            const ground = hitsGround(r, mu, A);
            const tMax = ground ? distanceToBottom(r, mu, A) : distanceToTop(r, mu, A);
            const dt = tMax / steps;
            const thr = [1, 1, 1];
            const L = [0, 0, 0];
            const f = [0, 0, 0];
            for (let s = 0; s < steps; s++) {
              const t = (s + 0.3) * dt;
              const px = dir[0] * t;
              const py = r + dir[1] * t;
              const pz = dir[2] * t;
              const pr = Math.sqrt(px * px + py * py + pz * pz);
              medium(pr - A.bottom, A, m);
              const muL = (px * sun[0] + py * sun[1] + pz * sun[2]) / pr;
              transmittance(pr, muL, T);
              for (let c = 0; c < 3; c++) {
                const sig = m.sR[c] + m.sM;
                const ext = m.ext[c];
                const st = Math.exp(-ext * dt);
                const S = sig * T[c] / (4 * Math.PI);
                L[c] += (thr[c] * (S - S * st)) / ext;
                f[c] += (thr[c] * (sig - sig * st)) / ext;
                thr[c] *= st;
              }
            }
            if (ground) {
              const gx = dir[0] * tMax;
              const gy = r + dir[1] * tMax;
              const gz = dir[2] * tMax;
              const gr = Math.sqrt(gx * gx + gy * gy + gz * gz);
              const nDotL = Math.max(0, (gx * sun[0] + gy * sun[1] + gz * sun[2]) / gr);
              transmittance(gr, nDotL, T);
              for (let c = 0; c < 3; c++) L[c] += (thr[c] * T[c] * nDotL * A.groundAlbedo) / Math.PI;
            }
            for (let c = 0; c < 3; c++) {
              L2[c] += L[c] / (N * N);
              fms[c] += f[c] / (N * N) / (4 * Math.PI);
            }
          }
        }
        const k = (j * W + i) * 4;
        for (let c = 0; c < 3; c++) data[k + c] = L2[c] / (1 - fms[c]);
        data[k + 3] = 1;
      }
    }
    return { width: W, height: H, data };
  })();

  function multiScatter(r, muS, out = [0, 0, 0]) {
    const [u, v] = multiScatterUV(r, muS, A);
    return sampleLUT(msLUT, u, v, out);
  }

  const T1 = [0, 0, 0];
  const M1 = [0, 0, 0];
  // Sky radiance (per unit illuminance of each light) seen from altitude viewAlt (km) along unit dir [x, y, z]
  // (y up). lights = [{ dir: [3], scale }] where scale multiplies that light's illuminance.
  // Returns radiance in out and the view-ray transmittance in outT (optional).
  function skyRadiance(dir, lights, out = [0, 0, 0], { viewAlt = A.viewAltitude, steps = 24, outT = null } = {}) {
    const r = A.bottom + viewAlt;
    const mu = dir[1];
    const ground = hitsGround(r, mu, A);
    const tMax = ground ? distanceToBottom(r, mu, A) : distanceToTop(r, mu, A);
    out[0] = out[1] = out[2] = 0;
    const thr = [1, 1, 1];
    let tPrev = 0;
    for (let s = 0; s < steps; s++) {
      const tn = ((s + 1) / steps) ** 2 * tMax;
      const dt = tn - tPrev;
      const t = tPrev + 0.3 * dt;
      tPrev = tn;
      const px = dir[0] * t;
      const py = r + dir[1] * t;
      const pz = dir[2] * t;
      const pr = Math.sqrt(px * px + py * py + pz * pz);
      medium(pr - A.bottom, A, m);
      const S = tmp;
      S[0] = S[1] = S[2] = 0;
      for (const L of lights) {
        if (!(L.scale > 0)) continue;
        const ld = L.dir;
        const muL = (px * ld[0] + py * ld[1] + pz * ld[2]) / pr;
        const cosT = dir[0] * ld[0] + dir[1] * ld[1] + dir[2] * ld[2];
        transmittance(pr, muL, T1);
        multiScatter(pr, muL, M1);
        const pR = rayleighPhase(cosT);
        const pM = miePhase(cosT, A.mieG);
        for (let c = 0; c < 3; c++) {
          S[c] += L.scale * (m.sR[c] * (T1[c] * pR + M1[c]) + m.sM * (T1[c] * pM + M1[c]));
        }
      }
      for (let c = 0; c < 3; c++) {
        const st = Math.exp(-m.ext[c] * dt);
        out[c] += (thr[c] * (S[c] - S[c] * st)) / m.ext[c];
        thr[c] *= st;
      }
    }
    if (outT) {
      outT[0] = thr[0];
      outT[1] = thr[1];
      outT[2] = thr[2];
    }
    return out;
  }

  return { params: A, transmittanceLUT, msLUT, transmittance, multiScatter, skyRadiance };
}

export function rayleighPhase(c) {
  return (3 / (16 * Math.PI)) * (1 + c * c);
}

// Cornette-Shanks.
export function miePhase(c, g) {
  const g2 = g * g;
  return ((3 / (8 * Math.PI)) * ((1 - g2) * (1 + c * c))) / ((2 + g2) * Math.pow(Math.max(1e-4, 1 + g2 - 2 * g * c), 1.5));
}

export function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
