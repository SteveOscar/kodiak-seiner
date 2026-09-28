// Headless play-test harness on the real GPU (Chromium + ANGLE/Metal). Starts its own Vite server on a free port, so
// any number of runs can go concurrently. Drives scripted input, records console errors, debug state, perf, and
// screenshots.
//
// Usage:
//   node tools/smoke.mjs [--scenario=basic|<file.json>] [--out=qa/run] [--params="autostart&time=19"]
//                        [--width=1280 --height=720] [--dist] [--timeout=180000] [--bench] [--strict]
//   --bench   disables vsync / frame-rate limiting so frameMsAvg and gpuMs show real cost (use for budgets)
//   --strict  also fail on console warnings
//
// Scenario = JSON array of steps (all optional keys, run in order):
//   { "wait": 500 }                          real milliseconds
//   { "until": "js expr", "timeout": 8000 }  poll until expr is truthy (fails the run on timeout)
//   { "key": "KeyW", "down": true }          keydown (hold)   | { "key": "KeyW", "up": true } keyup
//   { "press": "Space" }                     keydown + keyup  | { "hold": "KeyW", "ms": 2000 } hold for ms
//   { "eval": "js" }                         run JS in the page (result recorded)
//   { "start": {} }                          __KODIAK__.start(opts)
//   { "time": 19.5 }                         set clock hours
//   { "weather": "fog" }                     set weather preset (instant)
//   { "teleport": [x, z, headingDeg] }       place the seiner
//   { "teleportTo": [lat, lon, headingDeg] } place the seiner at the nearest open water to a lat/lon
//   { "camera": { "pos": [x,y,z], "look": [x,y,z] } }   debug camera override; { "camera": null } releases it
//   { "shot": "name" }                       screenshot -> <out>/name.png
//   { "state": "label" }                     record __KODIAK__.state()
//   { "perf": "label", "ms": 3000 }          wait ms then record __KODIAK__.perf()
//   { "click": [x, y] }                      mouse click at viewport pixel
//   { "drag": [dx, dy], "button": "left" }   mouse drag from the viewport centre
//   { "wheel": 300 }                         mouse wheel at the viewport centre (positive = zoom out)
//   { "clickSel": "#ui .menu-new" }          click a DOM element by CSS selector
//   { "reload": true }                       reload the page (localStorage survives)
//   { "timeScale": 30 }                      game minutes per real second
// Writes <out>/report.json. Exit code 1 on page errors, console errors, failed `until`, or systems that failed.

import { chromium } from 'playwright';
import { createServer, preview } from 'vite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const s = a.replace(/^--/, '');
    const i = s.indexOf('=');
    return i < 0 ? [s, 'true'] : [s.slice(0, i), s.slice(i + 1)];
  }),
);

const SCENARIOS = {
  basic: [
    { until: 'window.__KODIAK__ && __KODIAK__.ctx.state.mode === "title"', timeout: 60000 },
    { wait: 1500 },
    { shot: 'title' },
    { start: {} },
    { time: 9 },
    { wait: 1500 },
    { shot: 'start' },
    { state: 'start' },
    { hold: 'KeyW', ms: 4000 },
    { shot: 'underway' },
    { state: 'underway' },
    { key: 'KeyW', down: true },
    { hold: 'KeyA', ms: 1500 },
    { key: 'KeyW', up: true },
    { time: 20.8 },
    { wait: 1200 },
    { shot: 'evening' },
    { perf: 'evening', ms: 3000 },
  ],
  vista: [
    { until: 'window.__KODIAK__ && __KODIAK__.ctx.state.mode === "title"', timeout: 60000 },
    { start: {} },
    { time: 20.5 },
    { wait: 1500 },
    { camera: { pos: [5600, 120, -700], look: [4200, 20, -1500] } },
    { wait: 1000 },
    { shot: 'vista-kodiak-evening' },
    { time: 12 },
    { wait: 800 },
    { shot: 'vista-kodiak-noon' },
    { camera: { pos: [-1500, 420, 5200], look: [-800, 120, 2400] } },
    { wait: 1000 },
    { shot: 'vista-south-noon' },
    { perf: 'vista', ms: 2000 },
  ],
};

const out = path.resolve(ROOT, args.out ?? `qa/smoke-${args.scenario ?? 'basic'}`);
await mkdir(out, { recursive: true });

let steps;
const scen = args.scenario ?? 'basic';
if (SCENARIOS[scen]) steps = SCENARIOS[scen];
else steps = JSON.parse(await readFile(path.resolve(ROOT, scen), 'utf8'));

const width = Number(args.width ?? 1280);
const height = Number(args.height ?? 720);
const params = args.params ? `?${args.params.replace(/^\?/, '')}` : '';
const timeout = Number(args.timeout ?? 180000);

let server;
let baseUrl;
if (args.dist) {
  server = await preview({ root: ROOT, logLevel: 'error', cacheDir: path.join(os.tmpdir(), `kodiak-vite-${process.pid}`), preview: { port: 0, host: '127.0.0.1' } });
  baseUrl = server.resolvedUrls.local[0];
} else {
  // A private deps cache per run: concurrent runs never 504 or reload each other's pages on re-optimisation.
  server = await createServer({
    root: ROOT,
    logLevel: 'error',
    cacheDir: path.join(os.tmpdir(), `kodiak-vite-${process.pid}`),
    // No HMR: other agents editing files must not reload this page mid-scenario.
    server: { port: 0, host: '127.0.0.1', strictPort: false, hmr: false, watch: null },
  });
  await server.listen();
  baseUrl = server.resolvedUrls.local[0];
}

const report = { url: baseUrl + params, scenario: scen, errors: [], warnings: [], states: {}, perf: {}, evals: [], shots: [], failures: [] };
const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-angle=metal',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    ...(args.bench ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : []),
  ],
});
const page = await browser.newPage({ viewport: { width, height } });
page.on('pageerror', (e) => report.errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') report.errors.push(`console.error: ${m.text()}`);
  else if (m.type() === 'warning') report.warnings.push(m.text());
});

const killer = setTimeout(async () => {
  report.failures.push(`timeout after ${timeout} ms`);
  await finish(1);
}, timeout);

async function finish(code) {
  clearTimeout(killer);
  try {
    report.systemStatus = await page.evaluate(() => window.__KODIAK__?.systemStatus ?? null);
  } catch {}
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close().catch(() => {});
  await server.close?.();
  await server.httpServer?.close?.();
  const failedSystems = Object.entries(report.systemStatus ?? {}).filter(([, v]) => String(v).startsWith('failed'));
  console.log(`url: ${report.url}`);
  console.log(`shots: ${report.shots.join(', ') || '(none)'} -> ${path.relative(ROOT, out)}/`);
  console.log(`systems: ${JSON.stringify(report.systemStatus)}`);
  for (const [k, v] of Object.entries(report.perf)) console.log(`perf ${k}: ${JSON.stringify(v)}`);
  if (report.errors.length) console.log(`errors (${report.errors.length}):\n  ${report.errors.slice(0, 20).join('\n  ')}`);
  if (report.warnings.length) console.log(`warnings (${report.warnings.length}):\n  ${[...new Set(report.warnings)].slice(0, 20).join('\n  ')}`);
  if (report.failures.length) console.log(`failures:\n  ${report.failures.join('\n  ')}`);
  const bad = report.errors.length || report.failures.length || failedSystems.length || (args.strict && report.warnings.length);
  console.log(bad ? 'SMOKE: FAIL' : 'SMOKE: PASS');
  process.exit(code || (bad ? 1 : 0));
}

try {
  await page.goto(baseUrl + params, { waitUntil: 'load' });
  const K = (expr) => page.evaluate(expr);
  for (const step of steps) {
    if (step.wait) await page.waitForTimeout(step.wait);
    if (step.until) {
      try {
        await page.waitForFunction(step.until, null, { timeout: step.timeout ?? 8000, polling: 100 });
      } catch {
        report.failures.push(`until timed out: ${step.until}`);
        break;
      }
    }
    if (step.key && step.down) await page.keyboard.down(step.key);
    if (step.key && step.up) await page.keyboard.up(step.key);
    if (step.press) await page.keyboard.press(step.press);
    if (step.hold) {
      await page.keyboard.down(step.hold);
      await page.waitForTimeout(step.ms ?? 1000);
      await page.keyboard.up(step.hold);
    }
    if (step.eval) {
      const r = await K(step.eval).catch((e) => `threw: ${e.message}`);
      report.evals.push({ eval: step.eval, result: r });
    }
    if (step.start) await K(`__KODIAK__.start(${JSON.stringify(step.start)})`);
    if (step.time !== undefined) await K(`__KODIAK__.setTime(${step.time})`);
    if (step.weather) await K(`__KODIAK__.setWeather(${JSON.stringify(step.weather)}, 0)`);
    if (step.teleport) await K(`__KODIAK__.teleport(${step.teleport.join(',')})`);
    if (step.teleportTo) await K(`__KODIAK__.teleportTo(${step.teleportTo.join(',')})`);
    if (step.camera !== undefined) {
      await K(step.camera ? `__KODIAK__.camera(${JSON.stringify(step.camera.pos)}, ${JSON.stringify(step.camera.look)})` : '__KODIAK__.camera(null)');
    }
    if (step.click) await page.mouse.click(step.click[0], step.click[1]);
    if (step.clickSel) {
      try {
        await page.click(step.clickSel, { timeout: step.timeout ?? 5000 });
      } catch (e) {
        report.failures.push(`clickSel failed: ${step.clickSel}: ${e.message.split('\n')[0]}`);
      }
    }
    if (step.wheel) {
      await page.mouse.move(width / 2, height / 2);
      await page.mouse.wheel(0, step.wheel);
    }
    if (step.reload) await page.reload({ waitUntil: 'load' });
    if (step.timeScale !== undefined) await K(`__KODIAK__.ctx.clock.scale = ${Number(step.timeScale)}`);
    if (step.drag) {
      await page.mouse.move(width / 2, height / 2);
      await page.mouse.down({ button: step.button ?? 'left' });
      await page.mouse.move(width / 2 + step.drag[0], height / 2 + step.drag[1], { steps: 12 });
      await page.mouse.up({ button: step.button ?? 'left' });
    }
    if (step.shot) {
      await page.screenshot({ path: path.join(out, `${step.shot}.png`) });
      report.shots.push(step.shot);
    }
    if (step.state) report.states[step.state] = await K('__KODIAK__.state()').catch((e) => `threw: ${e.message}`);
    if (step.perf) {
      await page.waitForTimeout(step.ms ?? 3000);
      report.perf[step.perf] = await K('__KODIAK__.perf()');
    }
  }
  const pageErrors = await K('window.__KODIAK__ ? __KODIAK__.errors : []').catch(() => []);
  for (const e of pageErrors) if (!report.errors.some((x) => x.includes(e.slice(0, 60)))) report.errors.push(`app: ${e}`);
} catch (err) {
  report.failures.push(`harness: ${err.message}`);
}
await finish(0);
