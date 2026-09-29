// WP-NET: the key-driven tutorial set scenarios are generated from this description; the test keeps the committed
// JSON in sync. tests/scenarios/net-tutorial-keys.json flies a realistic set (the setup stores fishingMode
// 'realistic'); tests/scenarios/net-arcade-keys.json flies the same approach and circle in arcade mode, photographs
// each automatic phase and checks there is no winch or skiff-pull prompt. Regenerate with:
//   WRITE_SCENARIO=1 node --test tests/net-tutorial-scenario.test.mjs
// The scenario drives a complete round haul around the new-season tutorial school with Playwright key input only:
// W/S throttle lever, A/D rudder (bang-bang against a heading error computed in the page), Space let go / close up,
// E feathering the purse winch against the tension band. Every wait is a condition with a generous timeout, so a
// slow, shared GPU (sim dt clamps at 0.1 s) only stretches the run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = new URL('./scenarios/net-tutorial-keys.json', import.meta.url);
const ARCADE_FILE = new URL('./scenarios/net-arcade-keys.json', import.meta.url);

// Stores settings.fishingMode before the game starts (fishing reads it at each let-go).
const setMode = (mode) =>
  `(() => { const k = 'kodiak-seiner:settings'; let s = {}; try { s = JSON.parse(localStorage.getItem(k) || '{}') || {}; } catch {} s.fishingMode = '${mode}'; localStorage.setItem(k, JSON.stringify(s)); return s.fishingMode; })()`;

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
  // Metres to go until the school is abeam; armed once it has been well ahead (it may start astern of the spawn).
  let armed = false;
  let pauseT = 0;
  const along = () => {
    const f = fwd(), a = (sc.position.x - pos().x) * f.x + (sc.position.z - pos().z) * f.z;
    if (a > 30) armed = true;
    return armed ? a : 1e4;
  };
  window.__T = {
    school: sc, P, R,
    // Tangent guidance on the live school: the heading whose track passes it R metres to port (then the circle turns
    // left around it), re-aimed from wherever the boat is, so a slow turn or a nudge off a tender never misses it.
    aErr: () => {
      const p = pos(), bx = sc.position.x - p.x, bz = sc.position.z - p.z, d = Math.hypot(bx, bz) || 1;
      return wrap(hdg(bx, bz) + Math.asin(Math.min(1, R / d)) - S.seiner.heading);
    },
    distP: along,
    abeam: () => along() < 3,
    letGo: () => K.ctx.interact.current.action?.id === 'fishing-letgo',
    cErr: () => {
      const p = pos(), cx = sc.position.x, cz = sc.position.z;
      const ddx = p.x - cx, ddz = p.z - cz, dd = Math.hypot(ddx, ddz) || 1;
      const k = Math.max(-0.8, Math.min(0.8, (dd - R) / 25));
      return wrap(hdg(ddz / dd - (ddx / dd) * k, -ddx / dd - (ddz / dd) * k) - S.seiner.heading);
    },
    done: () => F().hud.closeReady || F().state !== 'setting',
    // Heading error to the skiff end (bringing her around when the net ran out short of it).
    kErr: () => {
      const g = K.systems.net.gap?.();
      if (!g) return 0;
      const p = pos();
      return wrap(hdg(g.a.x - p.x, g.a.z - p.z) - S.seiner.heading);
    },
    ready: () => F().hud.closeReady && K.ctx.interact.current.action?.id === 'fishing-close',
    // True once ms real milliseconds have passed since the first call of a wait.
    pause: (ms) => {
      const n = performance.now();
      if (!pauseT) pauseT = n;
      if (n - pauseT < ms) return false;
      pauseT = 0;
      return true;
    },
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

// Title → full ahead onto the tutorial school → let go abeam of it (shared by both scenarios).
function approachSteps(mode) {
  const steps = [
    { until: "window.__KODIAK__ && __KODIAK__.ctx.state.mode === 'title'", timeout: 90000 },
    { eval: setMode(mode) },
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
  // Come onto the tangent, then trim it every few seconds on the way in (a trim ends early once the school is abeam).
  const trim = () => [
    { key: 'KeyD', down: true },
    { until: '__T.aErr() < 0.01 || __T.abeam()', timeout: 40000 },
    { key: 'KeyD', up: true },
    { key: 'KeyA', down: true },
    { until: '__T.aErr() > -0.01 || __T.abeam()', timeout: 40000 },
    { key: 'KeyA', up: true },
  ];
  steps.push(...trim());
  [520, 450, 380, 310, 250, 190].forEach((d, i) => {
    steps.push({ until: `__T.distP() < ${d}`, timeout: 180000 }, ...trim());
    if (i === 2) steps.push({ eval: "__T.view('crowsnest')" }, { wait: 500 }, { shot: '01-approach-crowsnest' });
  });
  // Ease the lever back to 60% for the set.
  for (let i = 0; i < 4; i++) steps.push({ press: 'KeyS' }, { wait: 150 });
  for (const d of [130, 100, 80, 60, 40, 25]) steps.push({ until: `__T.distP() < ${d}`, timeout: 90000 }, ...trim());
  steps.push(
    { until: '__T.abeam()', timeout: 90000 },
    // The first set only lets go this close to the school (no "Jumpers … get within 150 m" prompt any more).
    { until: '__T.letGo()', timeout: 20000 },
    { state: 'letgo' },
    { press: 'Space' },
    { wait: 200 },
    { state: 'released' },
    { until: `__KODIAK__.systems.fishing.hud.mode === '${mode}'`, timeout: 5000 },
  );
  return steps;
}

// Round haul around the school, then bring her around to the skiff until the close-up is offered.
function circleSteps(steps) {
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
  // Short of the skiff when the net ran out: "Bring her around to the skiff" — steer for it until the close is offered.
  steps.push({ until: "__T.ready() || __KODIAK__.systems.fishing.state === 'holding'", timeout: 120000 });
  for (let i = 0; i < 16; i++) {
    steps.push(
      { key: 'KeyD', down: true },
      { until: '__T.kErr() < 0.02 || __T.ready()', timeout: 20000 },
      { key: 'KeyD', up: true },
      { key: 'KeyA', down: true },
      { until: '__T.kErr() > -0.02 || __T.ready()', timeout: 20000 },
      { key: 'KeyA', up: true },
      { until: '__T.ready() || __T.pause(1500)', timeout: 10000 },
    );
  }
  steps.push({ until: '__T.ready()', timeout: 120000 }, { state: 'closeReady' }, { shot: '05-close-ready-crowsnest' });
  return steps;
}

export function tutorialSteps() {
  const steps = circleSteps(approachSteps('realistic'));
  steps.push(
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

// Arcade: records real-time phase timestamps and every interact prompt / caption seen while the crew works.
const ARCADE_PROBE = String.raw`(() => {
  const K = __KODIAK__, F = () => K.systems.fishing;
  const A = (window.__A = { t: {}, offers: [], msgs: [], modes: [], panel: [] });
  K.ctx.events.on('fishing:state', (e) => { A.t[e.state] ??= performance.now(); });
  const crew = () => ['pursing', 'hauling', 'brailing'].includes(F().state);
  const tick = () => {
    if (crew()) {
      const o = K.ctx.interact.current.interact?.id;
      if (o && !A.offers.includes(o)) A.offers.push(o);
      const m = F().hud.message;
      if (m && !A.msgs.includes(m)) A.msgs.push(m);
      if (!A.modes.includes(F().hud.mode)) A.modes.push(F().hud.mode);
      const vis = (sel) => { const el = document.querySelector(sel); return !!el && !el.closest('.hidden') && el.offsetParent !== null; };
      const p = F().state + (vis('.set-tension') ? '+tension' : '') + (vis('.set-pull') ? '+pull' : '');
      if (!A.panel.includes(p)) A.panel.push(p);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  A.ok = () =>
    A.offers.every((id) => !/^fishing/.test(id)) &&
    A.msgs.every((m) => !/winch|tension|A\/D|wheel|corks|block/i.test(m)) &&
    A.modes.every((m) => m === 'arcade') &&
    A.panel.every((p) => !/\+/.test(p));
  A.report = () => {
    const s = (a, b) => (A.t[a] && A.t[b] ? +((A.t[b] - A.t[a]) / 1000).toFixed(2) : null);
    return JSON.stringify({
      realSeconds: { closing: s('closing', 'pursing'), pursing: s('pursing', 'hauling'), hauling: s('hauling', 'brailing'), brailing: s('brailing', 'report'), closeUpToReport: s('pursing', 'report'), spaceToReport: s('closing', 'report') },
      offers: A.offers, msgs: A.msgs, modes: A.modes, panel: A.panel, ok: A.ok(),
    });
  };
  return 'probe installed';
})()`;

export function arcadeSteps() {
  const steps = approachSteps('arcade');
  steps.splice(steps.findIndex((s) => s.eval === HELPERS) + 1, 0, { eval: ARCADE_PROBE });
  circleSteps(steps);
  const st = (s) => `__KODIAK__.systems.fishing.state === '${s}'`;
  steps.push(
    { press: 'Space' },
    { state: 'closing' },
    { wait: 1200 },
    { shot: '06-closing-crowsnest' },
    { until: st('pursing'), timeout: 60000 },
    { state: 'pursing' },
    { wait: 700 },
    { shot: '07-pursing-crowsnest' },
    { until: st('hauling'), timeout: 20000 },
    { state: 'hauling' },
    { wait: 500 },
    { shot: '08-hauling-crowsnest' },
    { eval: "__T.view('chase')" },
    { wait: 900 },
    { shot: '09-hauling-chase' },
    { until: st('brailing'), timeout: 20000 },
    { state: 'brailing' },
    { wait: 400 },
    { shot: '10-brailing-chase' },
    { until: st('report'), timeout: 20000 },
    { state: 'report' },
    { eval: 'JSON.stringify(__KODIAK__.systems.fishing.lastSet)' },
    { eval: '__A.report()' },
    // The crew's phases showed no winch / block prompt, no tension gauge or skiff-pull dial, only arcade.
    { until: '__A.ok()', timeout: 2000 },
    { wait: 1200 },
    { shot: '11-set-report' },
    { eval: DISMISS },
    { until: "__KODIAK__.systems.fishing.state === 'idle' && __KODIAK__.systems.skiff.state === 'stowed'", timeout: 20000 },
    { eval: "__T.view('chase')" },
    { wait: 800 },
    { shot: '12-done-chase' },
    { state: 'done' },
    { eval: "JSON.stringify({ t: __A.t, idle: performance.now(), letGo: __KODIAK__.ctx.interact.current.action?.id ?? null })" },
  );
  return steps;
}

test('the committed key-driven arcade scenario matches its generator', () => {
  const steps = arcadeSteps();
  if (process.env.WRITE_SCENARIO) writeFileSync(ARCADE_FILE, `${JSON.stringify(steps, null, 1)}\n`);
  const committed = JSON.parse(readFileSync(ARCADE_FILE, 'utf8'));
  assert.deepEqual(committed, steps);
  const text = JSON.stringify(steps);
  assert.ok(!/fishing\.debug|debug\.(letGo|closeUp|stage|pilot)/.test(text));
  assert.ok(steps.some((s) => s.press === 'Space') && !steps.some((s) => s.key === 'KeyE'), 'Space only: no winch');
  assert.ok(steps.some((s) => s.eval?.includes("fishingMode = 'arcade'")));
});

test('the committed key-driven tutorial scenario matches its generator', () => {
  const steps = tutorialSteps();
  if (process.env.WRITE_SCENARIO) writeFileSync(FILE, `${JSON.stringify(steps, null, 1)}\n`);
  const committed = JSON.parse(readFileSync(FILE, 'utf8'));
  assert.deepEqual(committed, steps);
  // Only real input and read-only probes drive the set: no fishing debug commands in the scenario.
  const text = JSON.stringify(steps);
  assert.ok(!/fishing\.debug|debug\.(letGo|closeUp|stage|pilot)/.test(text));
  assert.ok(steps.some((s) => s.press === 'Space') && steps.some((s) => s.key === 'KeyE'));
  assert.ok(steps.some((s) => s.eval?.includes("fishingMode = 'realistic'")), 'the tutorial flies a realistic set');
});
