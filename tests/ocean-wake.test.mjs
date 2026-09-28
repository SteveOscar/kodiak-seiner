// WP-OCEAN wake field: the CPU mirror of the GPU wake-wave step (src/world/water/wakeSim.js) makes a Kelvin-like V
// behind a moving hull, leaves no permanent dimple under a steady stamp, stays bounded at the largest frame
// step and under sudden splashes; the shaders use the same thresholds as the CPU side.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WAKE, PRESSURE_TAU, wakeParams, trailInput, stampPressure, createWakeSimCPU } from '../src/world/water/wakeSim.js';
import { STAMP_FRAG, SIM_FRAG, rippleFroth } from '../src/world/water/foamField.js';

const N = 256;

// Tows a seiner-like cluster of stamps (stern wash and shoulders, as WP-BOATS stamps them) along +x at speed U.
function runTow(U, seconds, dt = 1 / 30) {
  const sim = createWakeSimCPU({ n: N, texel: 1 });
  let x = 40;
  const z = N / 2;
  for (let t = 0; t < seconds; t += dt) {
    sim.stamp(x - 8, z, 1.9, 0.4);
    for (const side of [-1, 1]) {
      sim.stamp(x + 6, z + side * 2.4, 1.2, 0.3);
      sim.stamp(x + 2, z + side * 3.1, 1.4, 0.25);
    }
    sim.step(dt);
    x += U * dt;
  }
  return { sim, x, z };
}

// Half-angle of the wake envelope: the outermost disturbed texel across the track at several distances behind.
function wakeAngleDeg({ sim, x, z }, from = 25, to = 70) {
  let max = 0;
  for (const v of sim.h) max = Math.max(max, Math.abs(v));
  const thr = max * 0.08;
  const pts = [];
  for (let d = from; d <= to; d += 5) {
    const i = Math.round(x - d);
    let edge = 0;
    for (let off = 0; off < N / 2 - 2; off++) {
      for (const s of [-1, 1]) {
        const j = z + s * off;
        if (Math.abs(sim.h[j * N + i]) > thr) edge = Math.max(edge, off);
      }
    }
    pts.push([d, edge]);
  }
  // Least-squares slope of edge offset vs distance (the envelope is a straight line from the hull).
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p[0], 0) / n;
  const my = pts.reduce((s, p) => s + p[1], 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const [a, b] of pts) {
    sxy += (a - mx) * (b - my);
    sxx += (a - mx) * (a - mx);
  }
  return (Math.atan(sxy / sxx) * 180) / Math.PI;
}

test('one explicit step stays stable at any frame time the game produces', () => {
  for (const dt of [1 / 144, 1 / 60, 1 / 30, 0.1, 0.5]) {
    const p = wakeParams(dt, 1);
    // Courant number of the explicit step (lap coefficient times dt = (c dt / dx)^2); the 5-point scheme needs < 0.5.
    assert.ok((WAKE.c * p.dt) / 1 <= 0.6 + 1e-9, `c dt / dx = ${WAKE.c * p.dt}`);
    assert.ok(p.lap * p.dt <= 0.36 + 1e-9);
    assert.ok(p.diffuse <= 0.24);
    assert.ok(p.damp > 0 && p.damp <= 1);
    assert.ok(p.avgK > 0 && p.avgK < 1);
  }
  // The moving average follows its time constant regardless of frame rate.
  const k30 = wakeParams(1 / 30, 1).avgK;
  const k144 = wakeParams(1 / 144, 1).avgK;
  assert.ok(Math.abs((1 - k30) ** 30 - Math.exp(-1 / PRESSURE_TAU)) < 1e-9);
  assert.ok(Math.abs((1 - k144) ** 144 - Math.exp(-1 / PRESSURE_TAU)) < 1e-9);
  assert.equal(wakeParams(0, 1).dt, 0);
});

test('a hull towed faster than the wave speed leaves a Kelvin-like V, narrower when faster', () => {
  const slow = runTow(6, 22);
  const fast = runTow(10, 13);
  const aSlow = wakeAngleDeg(slow);
  const aFast = wakeAngleDeg(fast);
  const machSlow = (Math.asin(WAKE.c / 6) * 180) / Math.PI;
  const machFast = (Math.asin(WAKE.c / 10) * 180) / Math.PI;
  // Kelvin's half-angle is 19.5 degrees; real wakes narrow once the hull outruns its own waves.
  assert.ok(aSlow > 14 && aSlow < 25, `V half-angle ${aSlow.toFixed(1)} deg at 6 m/s`);
  assert.ok(aSlow < machSlow + 2 && aFast < machFast + 2, 'the V stays inside the Mach cone');
  assert.ok(aFast < aSlow, `faster hulls leave narrower wakes (${aFast.toFixed(1)} vs ${aSlow.toFixed(1)})`);
  // Nothing ahead of the bow (supersonic source) and real waves behind it.
  const ahead = Math.abs(slow.sim.h[slow.z * N + Math.round(slow.x + 12)]);
  let behind = 0;
  for (let d = 10; d < 60; d++) for (let off = -20; off <= 20; off++) behind = Math.max(behind, Math.abs(slow.sim.h[(slow.z + off) * N + Math.round(slow.x - d)]));
  assert.ok(behind > 0.05, `wake height ${behind} m`);
  assert.ok(ahead < behind * 0.05, `disturbance ahead of the bow ${ahead} m`);
  // The interior rings: crests alternate with troughs along the track behind the hull.
  let signChanges = 0;
  let prev = 0;
  for (let d = 12; d < 90; d++) {
    const v = slow.sim.h[slow.z * N + Math.round(slow.x - d)];
    if (Math.abs(v) > 0.005) {
      if (prev && Math.sign(v) !== Math.sign(prev)) signChanges++;
      prev = v;
    }
  }
  assert.ok(signChanges >= 2, `transverse crests behind the hull: ${signChanges} sign changes`);
});

test('a steady stamp rings once and then leaves the surface flat (no permanent dimple)', () => {
  const n = 128;
  const sim = createWakeSimCPU({ n, texel: 1 });
  const dt = 1 / 30;
  let peak = 0;
  let late = 0;
  let mean = 0;
  let samples = 0;
  for (let t = 0; t < 20; t += dt) {
    sim.stamp(64, 64, 6, 0.8);
    sim.step(dt);
    const centre = sim.h[64 * n + 64];
    if (t < 3) for (const v of sim.h) peak = Math.max(peak, Math.abs(v));
    if (t > 14) {
      late = Math.max(late, Math.abs(centre));
      mean += centre;
      samples++;
    }
  }
  mean /= samples;
  assert.ok(peak > 0.05, `onset ring ${peak} m`);
  assert.ok(Math.abs(mean) < 0.005, `mean height under a steady stamp ${mean} m (a dimple would be ~0.1 m)`);
  assert.ok(late < peak * 0.2, `ringing decays: ${late} m after 14 s vs ${peak} m at onset`);
});

test('sudden splashes stay bounded, even at the largest frame step', () => {
  const sim = createWakeSimCPU({ n: 96, texel: 1 });
  for (let f = 0; f < 200; f++) {
    if (f % 10 === 0) sim.stamp(48, 48, 12, 1);
    sim.step(0.1);
  }
  let max = 0;
  for (const v of sim.h) {
    assert.ok(Number.isFinite(v));
    max = Math.max(max, Math.abs(v));
  }
  assert.ok(max <= WAKE.maxHeight + 1e-6, `wake height ${max} m`);
});

test('only real wash lingers as trail and pushes waves; weak lace does neither', () => {
  assert.equal(trailInput(0.06), 0, 'corkline lace');
  assert.equal(trailInput(0.15), 0);
  assert.ok(trailInput(0.4) > 0.4, 'prop wash');
  assert.ok(trailInput(0.9) > 0.85);
  let prev = -1;
  for (let l = 0; l <= 1; l += 0.05) {
    assert.ok(trailInput(l) >= prev);
    prev = trailInput(l);
  }
  assert.equal(stampPressure(0.06), 0);
  assert.ok(stampPressure(0.1) === 0 && stampPressure(0.4) > 0.3 && stampPressure(1) === 1);
});

test('the GPU stamp and step shaders use the CPU model thresholds', () => {
  assert.ok(STAMP_FRAG.includes('smoothstep( 0.12, 0.45, vS )'), 'pressure threshold (stampPressure)');
  assert.ok(STAMP_FRAG.includes('smoothstep( 0.15, 0.55, vS ) * 0.9'), 'trail threshold (trailInput)');
  assert.ok(SIM_FRAG.includes('uMaxH * tanh( h / uMaxH )'), 'soft height limit');
  assert.ok(SIM_FRAG.includes('clamp( v, -3.0 * uMaxH, 3.0 * uMaxH )'), 'velocity limit');
  assert.ok(SIM_FRAG.includes('float push = f.b - avg;'), 'high-passed pressure forcing');
  assert.ok(SIM_FRAG.includes('avg + uWave2.z * ( f.b - avg )'), 'pressure moving average');
});

test('small ripple rings carry no froth; big splashes do', () => {
  // WP-FISH small jumps ring at strength 0.14-0.3: slope only, no white disc.
  for (const s of [0.1, 0.14, 0.22, 0.3]) assert.equal(rippleFroth(s), 0, `strength ${s}`);
  assert.ok(rippleFroth(0.5) > 0 && rippleFroth(0.5) < rippleFroth(0.8));
  assert.ok(Math.abs(rippleFroth(1) - 0.8) < 1e-9, 'a whale breach or the skiff drop froths fully');
});
