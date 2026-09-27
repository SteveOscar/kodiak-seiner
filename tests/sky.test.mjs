// WP-SKY unit tests: astronomy, atmosphere, light model, weather, mist sites, exposure, fog chunks, noise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCtx } from './contract.test.mjs';
import {
  sunTimes,
  skyAstronomy,
  sunPosition,
  julianDayLocal,
  equatorialToLocal,
  applyMat3,
  SOLAR_CLOCK_SHIFT_HOURS,
  hhmm,
} from '../src/world/sky/astro.js';
import { createAtmosphere } from '../src/world/sky/atmosphere.js';
import { createLightModel } from '../src/world/sky/lightModel.js';
import { createWeather, PRESETS, PRESET_NAMES, fogDensityForVisibility } from '../src/world/sky/weather.js';
import { findMistSites, sitePresence, morningFactor, PEAK_BAND } from '../src/world/sky/mistSites.js';
import { targetExposure, adaptExposure, meterCorrection, sceneKeyFromDaylight, EXPOSURE } from '../src/render/postfx/exposure.js';
import { FOG_CHUNKS, FOG_PARS_GLSL } from '../src/world/sky/fogChunks.js';
import { cloudNoise2D, sampleNoise2D } from '../src/world/sky/noise.js';
import { skyViewFrag, domeFrag } from '../src/world/sky/shaders.js';

const JUL6 = 187;
const minutes = (h) => h * 60;
const near = (a, b, tolMin, label) =>
  assert.ok(Math.abs(minutes(a) - minutes(b)) <= tolMin, `${label}: ${hhmm(a)} vs ${hhmm(b)} (±${tolMin} min)`);

test('NOAA sun: literal clock matches a known reference (Anchorage, June solstice 04:20 / 23:43 ADT)', () => {
  const t = sunTimes(172, { shift: 0, lat: 61.218, lon: -149.9 });
  near(t.sunrise, 4 + 20 / 60, 4, 'Anchorage sunrise');
  near(t.sunset, 23 + 43 / 60, 4, 'Anchorage sunset');
});

test('Jul 6 at 57.65N 153.4W: sunrise about 05:10 and sunset about 22:35 on the game clock', () => {
  // Sun centre on the horizon (geometric) and the standard -0.833° definition both land near the design targets.
  const centre = sunTimes(JUL6, { altitudeDeg: 0 });
  near(centre.sunrise, 5 + 10 / 60, 10, 'centre sunrise');
  near(centre.sunset, 22 + 35 / 60, 10, 'centre sunset');
  const std = sunTimes(JUL6);
  near(std.sunrise, 5 + 10 / 60, 15, 'standard sunrise');
  near(std.sunset, 22 + 35 / 60, 15, 'standard sunset');
  assert.ok(std.noonElevation > 54 && std.noonElevation < 56, `noon elevation ${std.noonElevation}`);
  // The shift is a documented design constant; the literal AKDT clock would put sunset after 23:00.
  const literal = sunTimes(JUL6, { shift: 0 });
  assert.ok(literal.sunset > 23, 'literal sunset is after 23:00');
  assert.ok(SOLAR_CLOCK_SHIFT_HOURS > 0.3 && SOLAR_CLOCK_SHIFT_HOURS < 0.5);
});

test('long July twilight, dark late-August nights', () => {
  assert.ok(sunTimes(JUL6).minElevation > -12, 'early July never reaches astronomical twilight');
  assert.ok(sunTimes(234).minElevation < -18, 'Aug 22 has a properly dark night');
  // Day length shrinks through the season.
  const a = sunTimes(JUL6);
  const b = sunTimes(234);
  assert.ok(b.sunset - b.sunrise < a.sunset - a.sunrise - 2);
});

test('sun direction is in the game frame (+x east, -z north, +y up)', () => {
  const noon = sunPosition(julianDayLocal(JUL6, 13.9));
  assert.ok(noon.dir[2] > 0.3, 'midday sun is to the south (+z)');
  const eve = sunPosition(julianDayLocal(JUL6, 21));
  assert.ok(eve.dir[0] < -0.5 && eve.dir[2] < 0, 'evening sun is in the north-west');
  const len = Math.hypot(...noon.dir);
  assert.ok(Math.abs(len - 1) < 1e-9);
});

test('moon: phase by date (2026: new moon ~Jul 14, full moon ~Jul 29)', () => {
  const phaseAt = (doy) => skyAstronomy(doy, 12).moon.phase;
  const newP = phaseAt(195); // Jul 14
  assert.ok(newP < 0.06 || newP > 0.94, `new moon phase ${newP}`);
  const fullP = phaseAt(210); // Jul 29
  assert.ok(Math.abs(fullP - 0.5) < 0.06, `full moon phase ${fullP}`);
  const full = skyAstronomy(210, 1).moon;
  assert.ok(full.illumination > 0.95);
});

test('star rotation maps the celestial pole to due north at the latitude elevation', () => {
  const A = skyAstronomy(JUL6, 1.5);
  const m = A.starRotation;
  const pole = applyMat3(m, [0, 0, 1]);
  const el = (Math.asin(pole[1]) * 180) / Math.PI;
  assert.ok(Math.abs(el - 57.65) < 0.01, `pole elevation ${el}`);
  assert.ok(Math.abs(pole[0]) < 1e-9 && pole[2] < 0, 'pole is due north');
  // Orthonormal rows.
  for (let i = 0; i < 3; i++) {
    const r = [m[i * 3], m[i * 3 + 1], m[i * 3 + 2]];
    assert.ok(Math.abs(Math.hypot(...r) - 1) < 1e-9);
  }
  const r2 = equatorialToLocal(0, 0);
  assert.ok(Math.abs(applyMat3(r2, [1, 0, 0])[1] - 1) < 1e-9, 'at the equator with LST 0, RA 0h is overhead');
});

const atm = createAtmosphere();
const r0 = atm.params.bottom + atm.params.viewAltitude;

test('atmosphere: sunlight dims and reddens toward the horizon', () => {
  const hi = atm.transmittance(r0, Math.sin((50 * Math.PI) / 180));
  const lo = atm.transmittance(r0, Math.sin((3 * Math.PI) / 180));
  assert.ok(hi[0] > lo[0] && hi[2] > lo[2]);
  assert.ok(lo[0] / lo[2] > 3 * (hi[0] / hi[2]), 'low sun is much redder');
  const below = atm.transmittance(r0, Math.sin((-2 * Math.PI) / 180));
  assert.ok(below[0] < 1e-3, 'the planet blocks a set sun');
});

test('atmosphere: blue zenith at noon, warm horizon toward the setting sun', () => {
  const sunHigh = [0, Math.sin(0.9), -Math.cos(0.9)];
  const z = atm.skyRadiance([0, 1, 0], [{ dir: sunHigh, scale: 1 }]);
  assert.ok(z[2] > z[1] && z[1] > z[0], 'zenith is blue');
  const s = (2 * Math.PI) / 180;
  const sunLow = [0, Math.sin(s), -Math.cos(s)];
  const h = atm.skyRadiance([0, Math.sin(0.05), -Math.cos(0.05)], [{ dir: sunLow, scale: 1 }]);
  assert.ok(h[0] > h[2] * 2, 'sunset glow is warm');
});

test('light model: noon bright and white, sunset warm and low, night dim but readable', () => {
  const lm = createLightModel(atm);
  const evalAt = (day, hours, preset = 'clear') => {
    const A = skyAstronomy(JUL6 + day, hours);
    const W = createWeather(preset);
    return structuredClone(
      lm.evaluate({
        sunDir: A.sun.dir,
        sunElevationDeg: A.sun.elevation,
        moonDir: A.moon.dir,
        moonElevationDeg: A.moon.elevation,
        moonIllumination: A.moon.illumination,
        weather: W.weather,
        sunCloudAlpha: 0,
      }),
    );
  };
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const noon = evalAt(0, 13.9);
  const golden = evalAt(0, 21.5);
  const night = evalAt(45, 23.5);
  assert.ok(noon.keyIsSun && golden.keyIsSun && !night.keyIsSun);
  assert.ok(lum(noon.keyColor) > lum(golden.keyColor) * 1.5);
  assert.ok(noon.keyColor[2] / noon.keyColor[0] > 0.7, 'noon light is near white');
  assert.ok(golden.keyColor[2] / golden.keyColor[0] < 0.35, 'golden hour light is warm');
  assert.ok(lum(night.keyColor) > 0.02 && lum(night.skyAmbient) > 0.01, 'night keeps a readable floor');
  assert.ok(night.daylight < 0.1 && noon.daylight > 0.95 && golden.daylight > night.daylight);
  const storm = evalAt(0, 13.9, 'storm');
  assert.ok(storm.sceneKey < noon.sceneKey * 0.6, 'storms are darker');
  const ovc = evalAt(0, 13.9, 'overcast');
  const f = ovc.fogColor;
  assert.ok(Math.max(...f) / Math.min(...f) < 1.35, 'overcast fog is grey');
  for (const o of [noon, golden, night, storm, ovc]) {
    for (const k of ['keyColor', 'skyAmbient', 'fogColor', 'horizon', 'groundBounce', 'cloudBase']) {
      assert.ok(o[k].every((v) => Number.isFinite(v) && v >= 0), `${k} finite`);
    }
  }
});

test('weather: presets, smooth transitions, instant sets, wind wraps the short way', () => {
  for (const name of ['clear', 'partly', 'overcast', 'fog', 'rain', 'storm']) assert.ok(PRESETS[name], name);
  assert.deepEqual(PRESET_NAMES.length, 6);
  const w = createWeather('clear');
  assert.equal(w.set('nope'), false);
  w.set('storm', 10);
  w.update(5, 0);
  assert.equal(w.weather.preset, 'storm');
  assert.ok(w.weather.cloudCover > PRESETS.clear.cloudCover && w.weather.cloudCover < PRESETS.storm.cloudCover);
  assert.ok(w.weather.visibility < PRESETS.clear.visibility && w.weather.visibility > PRESETS.storm.visibility);
  assert.ok(w.transitioning);
  w.update(6, 0);
  assert.ok(!w.transitioning);
  assert.equal(w.weather.cloudCover, PRESETS.storm.cloudCover);
  w.set('fog', 0);
  assert.equal(w.weather.visibility, PRESETS.fog.visibility);
  // Wind direction interpolates across north (315° → 45° passes 0°, never 180°).
  const x = createWeather('storm');
  x.set('partly', 10);
  x.update(5, 0);
  const d = (x.weather.windDir * 180) / Math.PI;
  assert.ok(d > 330 || d < 60, `wind veers through north: ${d}`);
  assert.ok(Math.abs(fogDensityForVisibility(600) - 3.912 / 600) < 1e-12);
});

test('mist sites: peak banks on mountainsides in the cloud band, bay banks over enclosed water', () => {
  const ctx = fakeCtx();
  const sites = findMistSites(ctx.heightmap, ctx.rng.fork('sky').fork('mist'), { peakSpacing: 420, maxPeaks: 320 });
  const peaks = sites.filter((s) => s.kind === 'peak');
  const bays = sites.filter((s) => s.kind === 'bay');
  assert.ok(peaks.length > 40 && bays.length > 20, `${peaks.length} peaks, ${bays.length} bays`);
  for (const p of peaks) {
    const h = ctx.heightmap.heightAt(p.x, p.z);
    assert.ok(h >= PEAK_BAND[0] - 12 && h <= PEAK_BAND[1] + 22, `peak site ground ${h}`);
  }
  for (const b of bays) assert.ok(ctx.heightmap.isWater(b.x, b.z), 'bay site is water');
  // Deterministic for a seed.
  const again = findMistSites(ctx.heightmap, ctx.rng.fork('sky').fork('mist'), { peakSpacing: 420, maxPeaks: 320 });
  assert.deepEqual(again.map((s) => [s.x, s.z]), sites.map((s) => [s.x, s.z]));
  // Grey days load the peaks; mornings fill the bays.
  const peak = peaks[0];
  const bay = bays[0];
  const grey = sitePresence(peak, { ...PRESETS.overcast, hours: 14, day: 3 });
  const fine = sitePresence(peak, { ...PRESETS.clear, hours: 14, day: 3 });
  assert.ok(grey > fine, `overcast ${grey} > clear ${fine}`);
  assert.ok(morningFactor(6) > morningFactor(15));
  const dawn = sitePresence(bay, { ...PRESETS.partly, hours: 6, day: 3 });
  const noon = sitePresence(bay, { ...PRESETS.partly, hours: 14, day: 3 });
  assert.ok(dawn > noon, `bay dawn ${dawn} > noon ${noon}`);
  assert.ok(sitePresence(bay, { ...PRESETS.fog, hours: 14, day: 3 }) > 0.3, 'marine fog fills bays all day');
});

test('exposure: brighter scenes expose less, within limits; adaptation converges; metering is bounded', () => {
  const noon = targetExposure(EXPOSURE.noonKey);
  assert.ok(Math.abs(noon - EXPOSURE.base) < 1e-9);
  assert.ok(targetExposure(0.2) > noon);
  assert.equal(targetExposure(1e-6), EXPOSURE.max);
  assert.equal(targetExposure(100), EXPOSURE.min);
  assert.equal(targetExposure(NaN), EXPOSURE.base);
  let e = 1;
  for (let i = 0; i < 300; i++) e = adaptExposure(e, 2, 1 / 60);
  assert.ok(Math.abs(e - 2) < 0.01);
  assert.ok(sceneKeyFromDaylight(1) > sceneKeyFromDaylight(0.3));
  assert.equal(meterCorrection(null, 1), 1);
  const bright = meterCorrection(3, 1);
  const dark = meterCorrection(-10, 1);
  assert.ok(bright < 1 && bright >= 2 ** EXPOSURE.meterMinEv - 1e-9);
  assert.ok(dark > 1 && dark <= 2 ** EXPOSURE.meterMaxEv + 1e-9);
});

test('fog chunks: radial height fog that reads only the allowed built-in symbols', () => {
  const all = Object.values(FOG_CHUNKS).join('\n') + FOG_PARS_GLSL;
  const identifiers = new Set(all.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g));
  const builtinUniformsUsed = [...identifiers].filter((id) =>
    ['modelMatrix', 'modelViewMatrix', 'projectionMatrix', 'normalMatrix', 'vViewPosition', 'vFogDepth', 'isOrthographic'].includes(id),
  );
  assert.deepEqual(builtinUniformsUsed, [], 'only mvPosition, viewMatrix and cameraPosition from three');
  for (const needed of ['mvPosition', 'viewMatrix', 'cameraPosition', 'fogColor', 'fogDensity']) assert.ok(identifiers.has(needed), needed);
  assert.ok(FOG_CHUNKS.fog_fragment.includes('kodiakFogDepth'));
  assert.ok(FOG_CHUNKS.fog_pars_fragment.includes('#include <kodiak_sky_fog_pars>'));
  // Optional uniforms default to sane behaviour when a material lacks them (zero-initialised).
  assert.ok(FOG_PARS_GLSL.includes('kodiakFogParams.x > 0.0 ?'));
  // The shared shader sources generate.
  assert.ok(skyViewFrag().includes('uSunScale') && domeFrag().includes('kodiakFogTint'));
});

test('noise: tileable cloud field and wrapped CPU sampling', () => {
  const f = cloudNoise2D(32, 7);
  for (let ch = 0; ch < 4; ch++) {
    const a = sampleNoise2D(f, 0.25, 0.4, ch);
    const b = sampleNoise2D(f, 1.25, -0.6, ch);
    assert.ok(Math.abs(a - b) < 1e-9, 'wraps');
  }
  // Opposite edges of the tile continue smoothly (tileable).
  let maxJump = 0;
  for (let i = 0; i < 32; i++) {
    const u = (i + 0.5) / 32;
    maxJump = Math.max(maxJump, Math.abs(sampleNoise2D(f, u, 0.999, 0) - sampleNoise2D(f, u, 1.001, 0)));
  }
  assert.ok(maxJump < 0.08, `edge jump ${maxJump}`);
});

test('env map refresh policy: throttled, sun/moon moves, 2 s cadence in transitions, instant changes', async () => {
  const { shouldCaptureEnv } = await import('../src/world/sky/envPolicy.js');
  const base = { since: 1, captures: 3, sunMovedDeg: 0, moonMovedDeg: 0, keyIsSun: true, keyFlip: false, transitioning: false, coverDelta: 0, fogDelta: 0 };
  assert.equal(shouldCaptureEnv({ ...base, captures: 0, since: 0 }), true, 'first capture always');
  assert.equal(shouldCaptureEnv(base), false, 'nothing changed');
  assert.equal(shouldCaptureEnv({ ...base, sunMovedDeg: 2.5 }), true);
  assert.equal(shouldCaptureEnv({ ...base, sunMovedDeg: 2.5, since: 0.3 }), false, 'never more often than 0.5 s');
  assert.equal(shouldCaptureEnv({ ...base, moonMovedDeg: 3 }), false, 'the moon only matters at night');
  assert.equal(shouldCaptureEnv({ ...base, keyIsSun: false, moonMovedDeg: 3 }), true);
  assert.equal(shouldCaptureEnv({ ...base, transitioning: true, coverDelta: 0.3, since: 1.2 }), false, '2 s cadence while transitioning');
  assert.equal(shouldCaptureEnv({ ...base, transitioning: true, since: 2.1 }), true);
  assert.equal(shouldCaptureEnv({ ...base, coverDelta: 0.3 }), true, 'instant weather change');
  assert.equal(shouldCaptureEnv({ ...base, keyFlip: true }), true);
  assert.equal(shouldCaptureEnv({ ...base, since: 21 }), true, 'periodic catch-all');
});

test('weather transitions: clouds build before the rain and the rain stops before the clouds break', () => {
  const w = createWeather('clear');
  w.set('storm', 10);
  w.update(3, 0);
  const cloudFrac = (w.weather.cloudCover - PRESETS.clear.cloudCover) / (PRESETS.storm.cloudCover - PRESETS.clear.cloudCover);
  const rainFrac = w.weather.rain / PRESETS.storm.rain;
  assert.ok(cloudFrac > rainFrac + 0.2, `worsening: cloud ${cloudFrac.toFixed(2)} leads rain ${rainFrac.toFixed(2)}`);
  const c = createWeather('storm');
  c.set('clear', 10);
  c.update(3, 0);
  const cloudLeft = (c.weather.cloudCover - PRESETS.clear.cloudCover) / (PRESETS.storm.cloudCover - PRESETS.clear.cloudCover);
  const rainLeft = c.weather.rain / PRESETS.storm.rain;
  assert.ok(rainLeft < cloudLeft - 0.2, `clearing: rain ${rainLeft.toFixed(2)} stops before cloud ${cloudLeft.toFixed(2)}`);
});
