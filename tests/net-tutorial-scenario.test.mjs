// WP-NET: the key-driven tutorial set scenario (tests/scenarios/net-tutorial-keys.json) is generated from this
// description; the test keeps the committed JSON in sync. Regenerate with:
//   WRITE_SCENARIO=1 node --test tests/net-tutorial-scenario.test.mjs
// The scenario drives a complete round haul around the new-season tutorial school with Playwright key input only:
// W/S throttle lever, A/D rudder (bang-bang against a heading error computed in the page), Space let go / close up,
// E feathering the purse winch against the tension band. Every wait is a condition with a generous timeout, so a
// slow, shared GPU (sim dt clamps at 0.1 s) only stretches the run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = new URL('./scenarios/net-tutorial-keys.json', import.meta.url);

const HELPERS = String.raw`(() => {
  const K = __KODIAK__, S = K.systems;
  const wrap = (a) => ((((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
  const hdg = (vx, vz) => Math.atan2(vx, -vz);
  const p0 = S.seiner.position;
  const sc = S.fish.nearestSchool(p0.x, p0.z, 1500).school;
  const R = 58;
  const dx = sc.position.x - p0.x, dz = sc.position.z - p0.z, d = Math.hypot(dx, dz);
  const ux = dx / d, uz = dz / d;
  const P = { x: sc.position.x - uz * R, z: sc.position.z + ux * R };
  const pos = () => S.seiner.position;
  const fwd = () => ({ x: Math.sin(S.seiner.heading), z: -Math.cos(S.seiner.heading) });
  const F = () => S.fishing;
  const band = () => F().hud.tensionBand;
  window.__T = {
    school: sc, P, R,
    // Follow the approach line through P (parallel to spawn → school): heading correction from cross-track error.
    aErr: () => {
      const p = pos();
      const ct = (p.x - P.x) * -uz + (p.z - P.z) * ux;
      return wrap(hdg(ux, uz) - Math.atan(ct / 40) - S.seiner.heading);
    },
    distP: () => (P.x - pos().x) * ux + (P.z - pos().z) * uz,
    abeam: () => { const f = fwd(); return (sc.position.x - pos().x) * f.x + (sc.position.z - pos().z) * f.z < 3; },
    cErr: () => {
      const p = pos(), cx = sc.position.x, cz = sc.position.z;
      const ddx = p.x - cx, ddz = p.z - cz, dd = Math.hypot(ddx, ddz) || 1;
      const k = Math.max(-0.8, Math.min(0.8, (dd - R) / 25));
      return wrap(hdg(ddz / dd - (ddx / dd) * k, -ddx / dd - (ddz / dd) * k) - S.seiner.heading);
    },
    done: () => F().hud.closeReady || F().state !== 'setting',
    st: () => F().state,
    tHi: () => F().state !== 'pursing' || F().hud.tension > band()[0] + (band()[1] - band()[0]) * 0.68,
    tLo: () => F().state !== 'pursing' || F().hud.tension < band()[0] + (band()[1] - band()[0]) * 0.3,
    view: (mode) => {
      if (K.systemStatus.cameraRig === 'ok') { K.camera(null); S.cameraRig.setMode(mode); return 'rig:' + mode; }
      F().debug.cam(mode === 'crowsnest' ? 'crow' : mode); return 'debug:' + mode;
    },
  };
  return JSON.stringify({ school: [Math.round(sc.position.x), Math.round(sc.position.z), sc.count, sc.species], P, d: Math.round(d) });
})()`;

const DISMISS =
  "(() => { if (__KODIAK__.ctx.state.mode !== 'paused') return 'no panel'; for (const t of ['keydown', 'keyup']) window.dispatchEvent(new KeyboardEvent(t, { code: 'Escape', key: 'Escape' })); return 'dismissed'; })()";

export function tutorialSteps() {
  const steps = [
    { until: "window.__KODIAK__ && __KODIAK__.ctx.state.mode === 'title'", timeout: 90000 },
    { start: {} },
    { time: 9 },
    { wait: 2500 },
    { eval: HELPERS },
    { eval: "__T.view('chase')" },
    { wait: 1500 },
    { shot: '00-start-chase' },
    { state: 'start' },
    // Full ahead: hold W to slide the throttle lever up, then let go of the key (the lever stays).
    { key: 'KeyW', down: true },
    { wait: 2600 },
    { key: 'KeyW', up: true },
    { until: '__KODIAK__.systems.seiner.speed > 3', timeout: 40000 },
  ];
  // Come onto the approach line, then trim it every few seconds on the way in.
  const trim = () => [
    { key: 'KeyD', down: true },
    { until: '__T.aErr() < 0.01', timeout: 40000 },
    { key: 'KeyD', up: true },
    { key: 'KeyA', down: true },
    { until: '__T.aErr() > -0.01', timeout: 40000 },
    { key: 'KeyA', up: true },
  ];
  steps.push(...trim());
  [520, 450, 380, 310, 250, 190].forEach((d, i) => {
    steps.push({ until: `__T.distP() < ${d}`, timeout: 180000 }, ...trim());
    if (i === 2) steps.push({ eval: "__T.view('crowsnest')" }, { wait: 500 }, { shot: '01-approach-crowsnest' });
  });
  // Ease the lever back to 60% for the set.
  for (let i = 0; i < 4; i++) steps.push({ press: 'KeyS' }, { wait: 150 });
  for (const d of [130, 80, 40]) steps.push({ until: `__T.distP() < ${d}`, timeout: 90000 }, ...trim());
  steps.push(
    { until: '__T.abeam()', timeout: 90000 },
    { state: 'letgo' },
    { press: 'Space' },
    { wait: 200 },
    { state: 'released' },
  );
  // Round haul: bang-bang A to follow a circle around the school (counter-clockwise on the chart).
  for (let i = 0; i < 70; i++) {
    steps.push(
      { key: 'KeyA', down: true },
      { until: '__T.cErr() >= -0.004 || __T.done()', timeout: 40000 },
      { key: 'KeyA', up: true },
      { until: '__T.cErr() < -0.07 || __T.done()', timeout: 40000 },
    );
    if (i === 12) steps.push({ shot: '02-setting-crowsnest' });
    if (i === 22) steps.push({ eval: "__T.view('chase')" }, { wait: 600 }, { shot: '03-setting-chase' }, { eval: "__T.view('crowsnest')" });
    if (i === 34) steps.push({ shot: '04-setting-crowsnest-late' });
  }
  steps.push(
    { until: "__KODIAK__.systems.fishing.hud.closeReady || __KODIAK__.systems.fishing.state === 'holding'", timeout: 120000 },
    { state: 'closeReady' },
    { shot: '05-close-ready-crowsnest' },
    { press: 'Space' },
    { wait: 300 },
    { state: 'closing' },
    { wait: 3500 },
    { eval: "__T.view('chase')" },
    { wait: 1200 },
    { shot: '06-closing-chase' },
    { eval: "__T.view('crowsnest')" },
    { until: "__KODIAK__.systems.fishing.state === 'pursing'", timeout: 90000 },
    { state: 'pursing-start' },
  );
  // Purse winch: feather E to keep the needle in the green.
  for (let i = 0; i < 60; i++) {
    steps.push(
      { key: 'KeyE', down: true },
      { until: '__T.tHi()', timeout: 40000 },
      { key: 'KeyE', up: true },
      { until: '__T.tLo()', timeout: 40000 },
    );
    if (i === 6) steps.push({ shot: '07-pursing-crowsnest' });
    if (i === 12) steps.push({ eval: "__T.view('chase')" }, { wait: 900 }, { shot: '08-pursing-chase' }, { eval: "__T.view('crowsnest')" });
  }
  steps.push(
    { until: "__KODIAK__.systems.fishing.state === 'hauling'", timeout: 40000 },
    { state: 'hauling-start' },
    { wait: 6000 },
    { shot: '09-hauling-crowsnest' },
    { eval: "__T.view('chase')" },
    { wait: 5000 },
    { shot: '10-hauling-chase' },
    { eval: "__T.view('crowsnest')" },
    { until: "__KODIAK__.systems.fishing.state === 'brailing'", timeout: 180000 },
    { state: 'brailing' },
    { wait: 800 },
    { shot: '11-brailing-crowsnest' },
    { eval: "__T.view('chase')" },
    { wait: 1500 },
    { shot: '12-brailing-chase' },
    { until: "__KODIAK__.systems.fishing.state === 'report'", timeout: 90000 },
    { state: 'report' },
    { eval: 'JSON.stringify(__KODIAK__.systems.fishing.lastSet)' },
    // WP-UI shows the set report as a pausing panel; photograph it, then dismiss it with Escape (only if it is up).
    { wait: 1500 },
    { shot: '13-set-report' },
    { eval: DISMISS },
    { until: "__KODIAK__.systems.fishing.state === 'idle'", timeout: 90000 },
    { wait: 500 },
    { shot: '14-done' },
    { state: 'done' },
  );
  return steps;
}

test('the committed key-driven tutorial scenario matches its generator', () => {
  const steps = tutorialSteps();
  if (process.env.WRITE_SCENARIO) writeFileSync(FILE, `${JSON.stringify(steps, null, 1)}\n`);
  const committed = JSON.parse(readFileSync(FILE, 'utf8'));
  assert.deepEqual(committed, steps);
  // Only real input and read-only probes drive the set: no fishing debug commands in the scenario.
  const text = JSON.stringify(steps);
  assert.ok(!/fishing\.debug|debug\.(letGo|closeUp|stage|pilot)/.test(text));
  assert.ok(steps.some((s) => s.press === 'Space') && steps.some((s) => s.key === 'KeyE'));
});
