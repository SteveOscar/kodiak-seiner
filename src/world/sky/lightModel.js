// Natural light for one instant: key light (sun by day; moon or the twilight glow by night), sky ambient, horizon
// and fog colours, cloud base colour, and the sky-radiance scales used by the GPU sky-view LUT. Pure JS (no THREE/DOM).
//
// All outputs are linear-sRGB "display" radiance/irradiance in three.js units: a white Lambert surface facing the key
// light has radiance keyColor / π, ambient-lit radiance albedo × skyAmbient (matching three's IBL convention).
//
// Night lift: the physical sky dims ~10^6 from sunset to astronomical night. Natural light is multiplied by a lift
// that grows as the physical sky darkens (display ∝ physical^liftGamma), so twilight and night stay readable while
// postfx exposure stays within ~1-2.2 (emissive lights of other systems keep their intended look).

import { smoothstep } from './atmosphere.js';

export const SKY_TUNING = {
  sunIlluminance: 3.3, // key-light intensity of the clear overhead sun
  skyGain: 2.0, // sky radiance relative to the physical sun/sky ratio (a luminous, photographic sky)
  ambientGain: 0.88, // sky ambient on geometry (fill, so shadows are not crushed)
  refAmbientLum: 0.0206, // physical ambient luminance per unit illuminance at a high sun (lift reference)
  liftGamma: 0.42,
  liftMax: 4000,
  airglow: [0.0013, 0.0019, 0.0042], // night-sky floor radiance in the dome (display units): a deep navy, not black
  nightAmbient: [0.011, 0.015, 0.028], // extra ambient on geometry at night so the world stays readable
  moonSky: 0.028, // full-moon sky scale relative to sunScale at noon (artistic)
  moonKey: 0.26, // full-moon key-light intensity
  nightKey: 0.085, // key light from the twilight glow / sky when the moon is down
  twilightTint: [0.5, 0.78, 1.5], // colour of the lifted (deep twilight) sky above the horizon band: the blue hour
  nightKeyColor: [0.55, 0.68, 1.0],
  moonKeyColor: [0.62, 0.74, 1.0],
  groundAlbedo: 0.07,
};

const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const DEG = Math.PI / 180;

// Directions for the ambient quadrature: rings of elevation (deg) × azimuth samples, with cos·sin weights.
const RINGS = [
  { el: 4, n: 8 },
  { el: 16, n: 8 },
  { el: 32, n: 8 },
  { el: 52, n: 6 },
  { el: 75, n: 4 },
];

export function createLightModel(atmosphere, tuning = SKY_TUNING) {
  const T = tuning;
  const L = [0, 0, 0];
  const tr = [0, 0, 0];
  const r0 = atmosphere.params.bottom + atmosphere.params.viewAltitude;

  // Radiance of the physical sky (sun only, unit illuminance) and the moon term, for direction d.
  function skyPhys(d, sunDir, moonDir, moonScale, out) {
    return atmosphere.skyRadiance(d, [{ dir: sunDir, scale: 1 }, { dir: moonDir, scale: moonScale }], out, { steps: 16 });
  }

  const sunRad = new Float64Array(64 * 3);
  const moonRad = new Float64Array(64 * 3);
  const out = {
    sunScale: 0, // multiplies the physical (unit-illuminance) sun sky → display radiance
    moonScale: 0, // same for the moon term
    lift: 1,
    skyTint: [1, 1, 1],
    golden: 0, // 0..1 golden-hour strength (low sun, not overcast)
    warm: [1, 1, 1], // artistic golden-hour bias on sunlight (key light and the dome's sunlit clouds)
    airglow: T.airglow.slice(),
    keyDir: [0, 1, 0],
    keyColor: [0, 0, 0], // irradiance (three intensity × colour)
    keyIsSun: true,
    sunColor: [0, 0, 0], // direct sun irradiance (0 when set), for the sky dome and clouds
    sunTransmittance: [0, 0, 0],
    skyAmbient: [0, 0, 0], // cosine-weighted sky radiance incl. clouds (display)
    clearAmbient: [0, 0, 0],
    zenith: [0, 0, 0],
    horizon: [0, 0, 0], // azimuth-averaged horizon radiance
    fogColor: [0, 0, 0],
    fogSunColor: [0, 0, 0], // extra fog radiance looking straight at the key light
    groundBounce: [0, 0, 0], // radiance of the sea/ground seen from above (hemi ground colour / 1)
    cloudBase: [0, 0, 0], // radiance of a thick overcast deck's underside
    daylight: 1,
    sceneKey: 1, // luminance of a white horizontal surface (display units), for exposure
    nightFactor: 0,
  };

  // state: { sunDir, sunElevationDeg, moonDir, moonElevationDeg, moonIllumination, weather, sunCloudAlpha }
  function evaluate(state) {
    const { sunDir, moonDir, weather: w } = state;
    const sunEl = state.sunElevationDeg;
    const cover = w.cloudCover;
    const dark = w.darkness ?? 0;

    // One pass over the quadrature directions: the sun-only physical sky (drives the lift) and the moon term.
    const illum = state.moonIllumination ?? 0;
    const moonUp = smoothstep(-2, 6, state.moonElevationDeg ?? -90);
    const needMoon = illum * moonUp > 0.01;
    let physAmb = 0;
    let wsum = 0;
    let n = 0;
    for (const ring of RINGS) {
      const e = ring.el * DEG;
      const wt = Math.sin(e) * Math.cos(e);
      for (let i = 0; i < ring.n; i++) {
        const a = (i / ring.n) * Math.PI * 2 + ring.el;
        const d = [Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)];
        atmosphere.skyRadiance(d, [{ dir: sunDir, scale: 1 }], L, { steps: 12 });
        const k = n * 3;
        sunRad[k] = L[0];
        sunRad[k + 1] = L[1];
        sunRad[k + 2] = L[2];
        if (needMoon) {
          atmosphere.skyRadiance(d, [{ dir: moonDir, scale: 1 }], L, { steps: 12 });
          moonRad[k] = L[0];
          moonRad[k + 1] = L[1];
          moonRad[k + 2] = L[2];
        } else {
          moonRad[k] = moonRad[k + 1] = moonRad[k + 2] = 0;
        }
        physAmb += lum([sunRad[k], sunRad[k + 1], sunRad[k + 2]]) * wt;
        wsum += wt;
        n++;
      }
    }
    physAmb /= wsum;
    const ratio = Math.max(1e-12, physAmb / T.refAmbientLum);
    const lift = Math.min(T.liftMax, Math.max(1, ratio ** (T.liftGamma - 1)));
    out.lift = lift;
    const sunScale = T.sunIlluminance * T.skyGain * lift;
    out.sunScale = sunScale;
    // Deep twilight reads blue to the eye; tint the lifted sky toward it.
    const tw = smoothstep(2, 80, lift);
    for (let c = 0; c < 3; c++) out.skyTint[c] = 1 + (T.twilightTint[c] - 1) * tw;
    const moonScale = T.sunIlluminance * T.skyGain * T.moonSky * illum ** 1.5 * moonUp;
    out.moonScale = moonScale;
    const moonRel = sunScale > 0 ? moonScale / sunScale : 0;

    // Sky ambient and horizon in display units (sun + moon + airglow).
    const amb = [0, 0, 0];
    const hor = [0, 0, 0];
    n = 0;
    for (const ring of RINGS) {
      const e = ring.el * DEG;
      const wt = Math.sin(e) * Math.cos(e);
      const glow = 1 + 1.5 * (1 - Math.sin(e));
      const tk = smoothstep(0, 0.3, Math.sin(e));
      for (let i = 0; i < ring.n; i++) {
        const k = n * 3;
        for (let c = 0; c < 3; c++) {
          const v = sunRad[k + c] * sunScale * (1 + (out.skyTint[c] - 1) * tk) + moonRad[k + c] * moonScale + T.airglow[c] * glow;
          amb[c] += v * wt;
        }
        n++;
      }
    }
    for (let c = 0; c < 3; c++) amb[c] /= wsum;
    skyPhys([0, 1, 0], sunDir, moonDir, moonRel, L);
    for (let c = 0; c < 3; c++) out.zenith[c] = L[c] * sunScale * out.skyTint[c] + T.airglow[c];
    for (let c = 0; c < 3; c++) out.clearAmbient[c] = amb[c];

    // Fog/horizon colour: the horizon away from the sun (sides and back), so the sun's broad glow does not tint the
    // whole haze; the sunward excess becomes the fog inscatter lobe.
    const sa = Math.atan2(sunDir[0], -sunDir[2]);
    const tk4 = smoothstep(0, 0.3, Math.sin(4 * DEG));
    const side = [0, 0, 0];
    for (const off of [Math.PI / 2, -Math.PI / 2, Math.PI * 0.75, -Math.PI * 0.75, Math.PI]) {
      const a = sa + off;
      skyPhys([Math.sin(a) * Math.cos(4 * DEG), Math.sin(4 * DEG), -Math.cos(a) * Math.cos(4 * DEG)], sunDir, moonDir, moonRel, L);
      for (let c = 0; c < 3; c++) side[c] += (L[c] * sunScale * (1 + (out.skyTint[c] - 1) * tk4) + T.airglow[c] * 2.5) / 5;
    }
    for (let c = 0; c < 3; c++) hor[c] = side[c];
    const hd = [Math.sin(sa) * Math.cos(4 * DEG), Math.sin(4 * DEG), -Math.cos(sa) * Math.cos(4 * DEG)];
    skyPhys(hd, sunDir, moonDir, moonRel, L);
    const sunSide = [0, 0, 0];
    for (let c = 0; c < 3; c++) sunSide[c] = Math.max(0, L[c] * sunScale * (1 + (out.skyTint[c] - 1) * tk4) + T.airglow[c] * 2.5 - hor[c]);

    // Direct sun (transmittance at the observer), dimmed by clouds.
    atmosphere.transmittance(r0, sunDir[1], tr);
    for (let c = 0; c < 3; c++) out.sunTransmittance[c] = tr[c];
    const overcastBlock = Math.min(1, cover ** 1.6);
    const cloudAtSun = Math.max(state.sunCloudAlpha ?? 0, 0);
    const directAtt = (1 - 0.93 * overcastBlock) * (1 - 0.82 * cloudAtSun * (1 - overcastBlock)) * (1 - 0.7 * dark);
    const sunE = T.sunIlluminance * lift;
    for (let c = 0; c < 3; c++) out.sunColor[c] = sunE * tr[c];

    // Overcast deck underside: sunlight diffused through the cloud plus some sky, warm when the sun is low.
    const sunH = Math.max(0, sunDir[1]);
    const tl = Math.max(1e-6, lum(tr));
    const diffuse = (sunE * tl * (0.04 + sunH) * 0.34) / Math.PI;
    const sunTint = [tr[0] / tl, tr[1] / tl, tr[2] / tl];
    for (let c = 0; c < 3; c++) {
      const tint = 0.55 + 0.45 * Math.min(1.6, sunTint[c]);
      out.cloudBase[c] = (diffuse * tint * (c === 2 ? 1.04 : 1) + amb[c] * 0.45 + T.airglow[c]) * (1 - 0.62 * dark);
    }

    // Sky ambient with clouds, plus the night floor that keeps the world readable.
    const ovc = cover ** 1.25;
    out.nightFactor = smoothstep(-1, -7, sunEl);
    for (let c = 0; c < 3; c++) {
      out.skyAmbient[c] = T.ambientGain * (amb[c] * (1 - ovc) + out.cloudBase[c] * ovc) + T.nightAmbient[c] * out.nightFactor * (1 - 0.15 * dark);
    }
    out.golden = smoothstep(30, 14, sunEl) * (1 - 0.75 * smoothstep(10, 1, sunEl)) * (1 - smoothstep(0, -3, sunEl)) * (1 - 0.8 * Math.min(1, cover ** 2)) * (1 - (w.fog ?? 0));

    // Fog / horizon colours: clear horizon → grey deck → lit fog.
    const fogLit = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      fogLit[c] = ((sunE * tl * (0.06 + sunH) * 0.42) / Math.PI) * (c === 2 ? 1.0 : c === 1 ? 0.98 : 0.95) * (0.7 + 0.3 * sunTint[c]) + amb[c] * 0.7;
      const deck = out.cloudBase[c] * 0.92;
      let f = hor[c] * (1 - ovc) + deck * ovc;
      f = f + (fogLit[c] * (1 - 0.5 * dark) - f) * (w.fog ?? 0) * 0.85;
      out.fogColor[c] = f;
      out.horizon[c] = hor[c] * (1 - ovc) + deck * ovc;
      out.fogSunColor[c] = sunSide[c] * (1 - 0.85 * ovc) * (1 - 0.5 * (w.fog ?? 0)) + sunE * tr[c] * 0.035 * (w.fog ?? 0) * directAtt;
    }

    // Key light.
    const sunKeyLum = lum(out.sunColor) * directAtt;
    // Golden hour: a touch warmer than physical, the look of film at low sun.
    const warm = out.warm;
    warm[0] = 1 + 0.24 * out.golden;
    warm[1] = 1 - 0.1 * out.golden;
    warm[2] = 1 - 0.5 * out.golden;
    if (sunEl > -1 && sunKeyLum > 0) {
      out.keyIsSun = true;
      out.keyDir = [sunDir[0], sunDir[1], sunDir[2]];
      for (let c = 0; c < 3; c++) out.keyColor[c] = out.sunColor[c] * directAtt * warm[c];
    } else {
      out.keyIsSun = false;
      // Twilight glow direction: the sun's azimuth, 35° up; blend toward the moon while it is up.
      const glowDir = [Math.sin(sa) * Math.cos(35 * DEG), Math.sin(35 * DEG), -Math.cos(sa) * Math.cos(35 * DEG)];
      const mw = smoothstep(0, 12, state.moonElevationDeg ?? -90) * Math.min(1, illum * 1.6);
      let kd = [0, 0, 0];
      for (let c = 0; c < 3; c++) kd[c] = glowDir[c] * (1 - mw) + moonDir[c] * mw;
      const n = Math.hypot(kd[0], kd[1], kd[2]) || 1;
      kd = kd.map((v) => v / n);
      out.keyDir = kd;
      atmosphere.transmittance(r0, Math.max(0.02, moonDir[1]), tr);
      const tlm = Math.max(1e-6, lum(tr));
      const moonI = T.moonKey * illum ** 1.2 * mw;
      const clouds = (1 - 0.85 * overcastBlock) * (1 - 0.6 * dark);
      for (let c = 0; c < 3; c++) {
        const moonC = T.moonKeyColor[c] * (0.75 + 0.25 * tr[c] / tlm);
        out.keyColor[c] = out.nightFactor * clouds * (T.nightKey * T.nightKeyColor[c] + moonI * moonC);
      }
    }

    // Ground/sea bounce radiance.
    for (let c = 0; c < 3; c++) {
      out.groundBounce[c] = (T.groundAlbedo * (out.keyColor[c] * Math.max(0, out.keyDir[1]) + Math.PI * out.skyAmbient[c])) / Math.PI;
    }

    out.sceneKey = (lum(out.keyColor) * Math.max(0, out.keyDir[1]) + Math.PI * lum(out.skyAmbient)) / Math.PI;
    const noonKey = (T.sunIlluminance * 0.82 * 0.8 + Math.PI * T.refAmbientLum * T.sunIlluminance * T.skyGain * T.ambientGain) / Math.PI;
    out.daylight = Math.max(0, Math.min(1, 1 + Math.log10(Math.max(1e-9, out.sceneKey / noonKey)) / 1.6));
    return out;
  }

  return { evaluate, out };
}
