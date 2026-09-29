// WP-SKY QA-fix regressions: bay fog follows the weather and burns off by 09:00, the fog preset stays playable,
// and the crow's-nest camera fades mist between itself and the sea.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { fakeCtx } from './contract.test.mjs';
import { findMistSites, sitePresence, morningFactor, bayWeatherScale } from '../src/world/sky/mistSites.js';
import { createWeather, PRESETS, fogDensityForVisibility } from '../src/world/sky/weather.js';
import { createMist } from '../src/world/sky/mist.js';

const ctx0 = fakeCtx();
const SITES = findMistSites(ctx0.heightmap, ctx0.rng.fork('sky').fork('mist'), { peakSpacing: 420, maxPeaks: 320 });
const BAYS = SITES.filter((s) => s.kind === 'bay');

// Presence a bay would hold on a moist, grey morning with the same wind (the weather-independent reference).
const env = (preset, hours, day, extra = {}) => ({ ...PRESETS[preset], hours, day, windSpeed: 4, ...extra });

test('bay fog: clear mornings keep ~0.2 of a grey morning pool, partly cloudy about half', () => {
  assert.ok(Math.abs(bayWeatherScale(PRESETS.clear.mist) - 0.2) < 0.02);
  const partly = bayWeatherScale(PRESETS.partly.mist);
  assert.ok(partly > 0.4 && partly < 0.6, `partly scale ${partly}`);
  assert.equal(bayWeatherScale(PRESETS.overcast.mist), 1);
  let n = 0;
  for (const bay of BAYS) {
    for (const day of [0, 7, 30]) {
      const grey = sitePresence(bay, env('overcast', 6, day, { fog: 0 }));
      if (grey < 0.05) continue;
      const clear = sitePresence(bay, env('clear', 6, day));
      const part = sitePresence(bay, env('partly', 6, day));
      // The grey reference uses mist 0.8 (factor 0.89); the clear/partly airmasses carry less moisture on top of the scale.
      assert.ok(clear <= grey * 0.2 + 1e-6, `clear ${clear} vs grey ${grey}`);
      assert.ok(part <= grey * 0.45 && part >= grey * 0.2, `partly ${part} vs grey ${grey}`);
      n++;
    }
  }
  assert.ok(n > 20, `checked ${n} bay/day pairs`);
});

test('bay fog burns off quickly after ~07:15 and is gone by 09:00; marine fog still fills bays', () => {
  assert.ok(morningFactor(6.5) > 0.99, 'full pool at dawn');
  assert.ok(morningFactor(8) < 0.7, `08:00 already thinning (${morningFactor(8)})`);
  assert.equal(morningFactor(9), 0);
  assert.equal(morningFactor(12), 0);
  for (const bay of BAYS.slice(0, 20)) {
    assert.equal(sitePresence(bay, env('clear', 9, 3)), 0, 'no bay fog at 09:00 on a clear day');
    assert.equal(sitePresence(bay, env('partly', 9.5, 3)), 0, 'none at 09:30 on a partly cloudy day');
  }
  assert.ok(Math.max(...BAYS.map((b) => sitePresence(b, env('fog', 14, 3, { windSpeed: 2.5 })))) > 0.3, 'marine fog fills bays all day');
});

test('fog preset: thick but playable (a boat 300 m off keeps real contrast)', () => {
  const vis = PRESETS.fog.visibility;
  assert.ok(vis >= 1000 && vis <= 1500, `fog visibility ${vis}`);
  const contrastAt300 = Math.exp(-fogDensityForVisibility(vis) * 300);
  assert.ok(contrastAt300 > 0.3, `contrast at 300 m ${contrastAt300}`);
  // Still the thickest preset, and instant sets land exactly on it.
  for (const name of Object.keys(PRESETS)) if (name !== 'fog') assert.ok(PRESETS[name].visibility > vis, name);
  const w = createWeather('clear');
  w.set('fog', 0);
  assert.equal(w.weather.visibility, vis);
});

test("mist: the crow's-nest camera fades banks between it and the sea (and never closes the fog in)", () => {
  const ctx = fakeCtx();
  const noise = new THREE.Data3DTexture(new Uint8Array(8 * 2), 2, 2, 2);
  const mist = createMist(ctx, ctx.rng.fork('sky').fork('mist'), noise, {}, new THREE.Texture());
  const bay = mist.sites.find((s) => s.kind === 'bay');
  const cam = new THREE.PerspectiveCamera();
  // Hovering 55 m over the middle of a full bay bank (inside its grazing zone).
  cam.position.set(bay.x, bay.y + bay.ry * 0.95, bay.z);
  mist.debugForce(1);
  const menv = { mist: 1, fog: 1, cloudCover: 0.8, cloudBase: 150, hours: 6, day: 0, windSpeed: 0, windX: 0, windZ: 0 };
  const run = (mode, y, frames = 60) => {
    ctx.systems.cameraRig = { mode };
    cam.position.y = y;
    ctx.time.realDt = 1 / 30;
    for (let i = 0; i < frames; i++) mist.update(1 / 30, i / 30, menv, cam);
    mist.prepare(cam);
  };
  run('chase', bay.y + bay.ry * 0.95);
  assert.equal(mist.overhead, 0);
  const chaseFog = mist.insideFog;
  assert.ok(chaseFog > 0.3, `chase camera inside a bank closes the fog in (${chaseFog})`);
  run('crowsnest', bay.y + bay.ry * 0.95);
  // 20 m → 50 m ramps the fade in; this camera sits between.
  const partial = mist.overhead;
  assert.ok(partial > 0 && partial < 1, `partial overhead ${partial}`);
  run('crowsnest', 120);
  assert.ok(mist.overhead > 0.99, `crow's nest at 120 m engages the fade (${mist.overhead})`);
  assert.equal(mist.mesh.material.uniforms.uOverhead.value, mist.overhead);
  cam.position.y = bay.y + bay.ry * 0.95;
  mist.prepare(cam);
  assert.ok(mist.insideFog < chaseFog * 0.2, `overhead camera keeps the fog open (${mist.insideFog} vs ${chaseFog})`);
  // Leaving the crow's nest eases back.
  run('chase', 120, 90);
  assert.ok(mist.overhead < 0.01, `chase releases the fade (${mist.overhead})`);
  // No rig at all (title, early boot): no fade.
  delete ctx.systems.cameraRig;
  run(undefined, 120, 90);
  assert.ok(mist.overhead < 0.01);
});
