// WP-UI pure logic: formatting, key routing per mode, compass/sonar projection, gauges, report headlines, the fish
// ticket model, keycap parsing, the chart view/raster/soundings/labels, and the ui system's API under Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCtx } from './contract.test.mjs';
import { STUBS } from '../src/systems/stubs.js';
import { missingMembers } from '../src/systems/contract.js';
import * as F from '../src/ui/lib/format.js';
import * as L from '../src/ui/lib/logic.js';
import * as C from '../src/ui/lib/chart.js';
import { salmonMarkSVG } from '../src/ui/lib/art.js';

const species = fakeCtx().config.fish.species;

test('money, ints and prices format like a fish ticket', () => {
  assert.equal(F.money(2500), '$2,500');
  assert.equal(F.money(-1200.4), '−$1,200');
  assert.equal(F.money(0.32, { cents: true }), '$0.32');
  assert.equal(F.money(50, { sign: true }), '+$50');
  assert.equal(F.money(-0.001, { cents: true }), '$0.00');
  assert.equal(F.int(12400.4), '12,400');
  assert.equal(F.compactMoney(12400), '$12k');
  assert.equal(F.compactMoney(4200), '$4.2k');
  assert.equal(F.compactMoney(1.2e6), '$1.2M');
  assert.equal(F.pct(0.643), '64%');
  assert.equal(F.money(NaN), '$0');
});

test('clock, calendar and durations', () => {
  assert.equal(F.clockTime(5.7), '5:42 AM');
  assert.equal(F.clockTime(0), '12:00 AM');
  assert.equal(F.clockTime(12.25), '12:15 PM');
  assert.equal(F.clockTime(23.9999), '11:59 PM'); // floors like core clock.timeLabel
  const d0 = F.calendar(0, { month: 7, day: 6 });
  assert.equal(d0.label, 'Jul 6');
  assert.equal(d0.weekdayShort, 'Mon');
  assert.equal(F.calendar(26, { month: 7, day: 6 }).label, 'Aug 1');
  assert.equal(F.duration(1.334), '1 h 20 min');
  assert.equal(F.duration(0.75), '45 min');
  assert.equal(F.duration(3), '3 h');
  assert.equal(F.mmss(65.9), '1:05');
});

test('headings, cardinals and bearings follow the game convention (0 = north, clockwise)', () => {
  assert.equal(F.headingDeg(Math.PI / 2), 90);
  assert.equal(F.headingDeg(-Math.PI / 2), 270);
  assert.equal(F.headingDeg(Math.PI * 4), 0);
  assert.equal(F.cardinal(44), 'NE');
  assert.equal(F.cardinal(350, 16), 'N');
  assert.equal(F.cardinal(202.5, 16), 'SSW');
  // East of the origin (+x) is a bearing of 90°, north (-z) is 0°.
  assert.equal(F.headingDeg(F.bearing(0, 0, 100, 0)), 90);
  assert.equal(F.headingDeg(F.bearing(0, 0, 0, -100)), 0);
  assert.equal(F.headingDeg(F.bearing(0, 0, 0, 100)), 180);
  assert.equal(F.deltaDeg(10, 350), 20);
  assert.equal(F.deltaDeg(350, 10), -20);
  assert.equal(F.deltaDeg(180, 0), 180);
  assert.match(F.latLonLabel(57.7866, -152.4), /^57°47\.2′N {2}152°24\.0′W$/);
});

test('routeKeys: only the UI reacts to pause/map/logbook/help/photo, per mode (SPEC §4.2)', () => {
  const k = (...a) => new Set(a);
  assert.deepEqual(L.routeKeys('play', null, k('pause')), { type: 'open', panel: 'pause' });
  assert.deepEqual(L.routeKeys('play', null, k('escape', 'pause')), { type: 'open', panel: 'pause' });
  assert.deepEqual(L.routeKeys('play', null, k('map')), { type: 'open', panel: 'map' });
  assert.deepEqual(L.routeKeys('play', null, k('logbook')), { type: 'open', panel: 'logbook' });
  assert.deepEqual(L.routeKeys('play', null, k('help')), { type: 'open', panel: 'help' });
  assert.deepEqual(L.routeKeys('play', null, k('photo')), { type: 'photo', on: true });
  assert.equal(L.routeKeys('play', null, k('confirm')), null);
  // Esc closes the open panel (back), M/Esc close the chart, H/Esc leave photo mode.
  assert.deepEqual(L.routeKeys('paused', 'settings', k('escape', 'pause')), { type: 'back' });
  assert.deepEqual(L.routeKeys('paused', 'logbook', k('logbook')), { type: 'close' });
  assert.deepEqual(L.routeKeys('paused', 'help', k('help')), { type: 'close' });
  assert.deepEqual(L.routeKeys('map', 'map', k('map')), { type: 'close' });
  assert.deepEqual(L.routeKeys('map', 'map', k('escape', 'pause')), { type: 'close' });
  assert.deepEqual(L.routeKeys('photo', null, k('photo')), { type: 'photo', on: false });
  assert.deepEqual(L.routeKeys('photo', null, k('escape', 'pause')), { type: 'photo', on: false });
  // Set report and fish ticket: Space/Enter/Esc continue.
  assert.deepEqual(L.routeKeys('paused', 'report', k('confirm')), { type: 'close' });
  assert.deepEqual(L.routeKeys('paused', 'ticket', k('escape')), { type: 'close' });
  // Paused with no UI panel (someone else paused): Esc brings up the pause menu.
  assert.deepEqual(L.routeKeys('paused', null, k('pause')), { type: 'open', panel: 'pause' });
  // Title: Esc backs out of a sub-panel; nothing else is routed. Cutscenes belong to their owner.
  assert.deepEqual(L.routeKeys('title', 'settings', k('escape')), { type: 'back' });
  assert.equal(L.routeKeys('title', null, k('map', 'pause')), null);
  assert.equal(L.routeKeys('cutscene', null, k('pause', 'map', 'photo')), null);
  assert.equal(L.routeKeys('loading', null, k('pause')), null);
  assert.equal(L.routeKeys('play', null, new Set()), null);
});

test('compass layout clamps off-strip markers to the edges', () => {
  const out = L.compassLayout(0, [{ id: 'a', bearingDeg: 30 }, { id: 'b', bearingDeg: 200 }, { id: 'c', bearingDeg: 300 }], 70);
  assert.equal(out[0].offsetDeg, 30);
  assert.equal(out[0].edge, 0);
  assert.equal(out[1].edge, -1); // 200° is -160° from north: off the left edge
  assert.equal(out[1].offsetDeg, -70);
  assert.equal(out[2].offsetDeg, -60);
  const east = L.compassLayout(Math.PI / 2, [{ id: 'w', bearingDeg: 100 }], 70);
  assert.equal(east[0].offsetDeg, 10);
  assert.equal(L.unwrapDeg(359, 1), 361);
  assert.equal(L.unwrapDeg(1, 359), -1);
});

test('compass labels never overlap: priority keeps its label, colliding neighbours go quiet', () => {
  const pxPerDeg = 440 / 136;
  const laid = [
    { id: 'wp', label: '11 nm', offsetDeg: 10, edge: 0, prio: 3 },
    { id: 'tender', label: 'Sea Venture · 6.3 nm', offsetDeg: 18, edge: 0, prio: 2 },
    { id: 'harbor', label: 'City of Kodiak', offsetDeg: -40, edge: 0, prio: 1 },
    { id: 'far', label: 'Ouzinkie', offsetDeg: 68, edge: 1, prio: 1 },
  ];
  L.dedupeCompassLabels(laid, pxPerDeg);
  assert.equal(laid[0].label, '11 nm');
  assert.equal(laid[1].label, '', 'the tender label would run into the waypoint label');
  assert.equal(laid[2].label, 'City of Kodiak', 'far enough away to keep its label');
  assert.equal(laid[3].label, 'Ouzinkie', 'edge markers are left alone (their labels are hidden by CSS)');
  // A long label 25° away still collides; the same label 60° away does not.
  const a = L.dedupeCompassLabels([{ label: 'Sea Venture · 6.3 nm', offsetDeg: 0, prio: 2 }, { label: 'City of Kodiak', offsetDeg: 25, prio: 1 }], pxPerDeg);
  assert.equal(a[1].label, '');
  const b = L.dedupeCompassLabels([{ label: 'Sea Venture · 6.3 nm', offsetDeg: 0, prio: 2 }, { label: 'City of Kodiak', offsetDeg: 60, prio: 1 }], pxPerDeg);
  assert.equal(b[1].label, 'City of Kodiak');
});

test('skiff-pull advice names the key that swings the pull onto the line', () => {
  const r = (deg) => (deg * Math.PI) / 180;
  assert.deepEqual(L.pullAdvice(r(90), null), { off: 0, key: null, state: 'none' });
  assert.equal(L.pullAdvice(r(90), r(100)).state, 'on');
  const cw = L.pullAdvice(r(90), r(130)); // ideal is clockwise of the pull: D
  assert.equal(cw.key, 'D');
  assert.equal(cw.state, 'near');
  const ccw = L.pullAdvice(r(10), r(-80)); // across north, counter-clockwise: A
  assert.equal(ccw.key, 'A');
  assert.equal(ccw.state, 'off');
  assert.equal(Math.round(ccw.off), 90);
});

test('next-step line says what to do, and stays quiet when a prompt or the set already does', () => {
  const base = { control: 'boat', fishing: 'idle', freeExplore: false, open: true, holdLbs: 0, capacityLbs: 60000, fuelFrac: 1, fuelEmpty: false, hours: 10, moored: null, tender: { name: 'Sea Venture', nm: 1.8 }, opensToday: null, interactId: null };
  assert.match(L.nextStep(base), /jumpers/);
  assert.equal(L.nextStep({ ...base, fishing: 'pursing' }), null);
  assert.equal(L.nextStep({ ...base, control: 'foot' }), null);
  assert.match(L.nextStep({ ...base, holdLbs: 40000 }), /Deliver to the Sea Venture · 1\.8 nm/);
  assert.match(L.nextStep({ ...base, holdLbs: 59000 }), /Hold’s full/);
  assert.equal(L.nextStep({ ...base, holdLbs: 59000, interactId: 'deliver' }), null);
  assert.match(L.nextStep({ ...base, fuelFrac: 0.15 }), /Fuel/);
  assert.match(L.nextStep({ ...base, fuelFrac: 0.15, freeExplore: true }), /jumpers/, 'no fuel nagging in Free Explore');
  assert.match(L.nextStep({ ...base, fuelEmpty: true, fuelFrac: 0 }), /tow/);
  assert.match(L.nextStep({ ...base, open: false, holdLbs: 1000 }), /Closed — deliver/);
  assert.match(L.nextStep({ ...base, open: false, hours: 23 }), /anchor/);
  assert.match(L.nextStep({ ...base, open: false, hours: 23, moored: 'anchor', interactId: 'sleep' }), /sleep/);
  assert.match(L.nextStep({ ...base, open: false, hours: 5.5, opensToday: '6:00 AM' }), /6:00 AM/);
  assert.match(L.nextStep({ ...base, open: false, hours: 14 }), /wait at anchor/);
  assert.match(L.nextStep({ ...base, open: false, hours: 14, interactId: 'waitOpener' }), /wait here/);
  assert.match(L.nextStep({ ...base, tender: null, holdLbs: 59000 }), /a tender/);
  assert.match(L.nextStep({ ...base, moored: 'dock' }), /Cast off/, 'tied up during a period: go fishing');
  assert.match(L.nextStep({ ...base, moored: 'anchor' }), /anchor/);
  assert.match(L.nextStep({ ...base, moored: 'dock', holdLbs: 40000 }), /Deliver/);
});

test('sonar projection is heading-up with starboard to the right', () => {
  const r = L.sonarProject(0, 0, 0, [{ x: 0, z: -75, depth: 4, strength: 0.8 }, { x: 75, z: 0 }, { x: 0, z: -400 }], 150);
  assert.equal(r.length, 2);
  assert.ok(Math.abs(r[0].u) < 1e-9 && Math.abs(r[0].v - 0.5) < 1e-9, 'dead ahead');
  assert.ok(Math.abs(r[1].u - 0.5) < 1e-9 && Math.abs(r[1].v) < 1e-9, 'east is starboard when heading north');
  // Heading east: a mark to the east is dead ahead, a mark to the north is to port.
  const e = L.sonarProject(0, 0, Math.PI / 2, [{ x: 75, z: 0 }, { x: 0, z: -75 }], 150);
  assert.ok(Math.abs(e[0].v - 0.5) < 1e-9 && Math.abs(e[0].u) < 1e-9);
  assert.ok(e[1].u < -0.49);
  assert.deepEqual(L.sonarProject(0, 0, 0, null, 150), []);
});

test('hold gauge segments are species-coloured fractions of capacity, never over 100%', () => {
  const segs = L.holdSegments({ pink: 5000, chum: 1000, sockeye: 0, coho: 0, king: 3 }, 60000, species);
  assert.deepEqual(segs.map((s) => s.species), ['pink', 'chum', 'king']);
  assert.ok(Math.abs(segs[0].frac - (5000 * 3.6) / 60000) < 1e-9);
  const over = L.holdSegments({ pink: 30000 }, 60000, species);
  assert.equal(over[0].frac, 1);
  assert.deepEqual(L.holdSegments(null, 60000, species), []);
  assert.equal(L.fuelLevel(500, 3000).tone, 'warn');
  assert.equal(L.fuelLevel(200, 3000).tone, 'danger');
  assert.equal(L.fuelLevel(3000, 3000).tone, 'ok');
});

test('tension state reads the green band', () => {
  assert.equal(L.tensionState(0.5, [0.4, 0.7]).zone, 'good');
  assert.equal(L.tensionState(0.2, [0.4, 0.7]).zone, 'low');
  assert.equal(L.tensionState(0.9, [0.4, 0.7]).zone, 'high');
  assert.equal(L.tensionState(4, [0.4, 0.7]).t, 1);
});

test('set report headline by rating', () => {
  const base = { accepted: { pink: 5000, chum: 0, sockeye: 0, coho: 0, king: 0 }, released: { pink: 0, chum: 0, sockeye: 0, coho: 0, king: 0 } };
  assert.equal(L.reportHeadline({ ...base, rating: 'plugged' }).title, 'Plugged!');
  const over = L.reportHeadline({ ...base, rating: 'plugged', released: { pink: 1240, chum: 0, sockeye: 0, coho: 0, king: 2 } });
  assert.match(over.line, /1,240 go over the corks/);
  assert.equal(L.reportHeadline({ ...base, rating: 'water haul', waterHaul: true }).title, 'Water haul');
  assert.equal(L.reportHeadline({ ...base, rating: 'good' }).title, 'Good set');
  assert.equal(L.reportHeadline({ ...base, rating: 'fair' }).tone, 'fair');
  assert.equal(L.reportHeadline({ ...base, rating: 'good', cited: true }).title, 'Cited');
  const rows = L.reportRows({ ...base, lbs: { pink: 18000 }, released: { king: 2 } }, species);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].lbs, 18000);
  assert.equal(rows[1].species, 'king');
  assert.equal(rows[1].released, 2);
});

test('fish ticket model fills ADF&G fields and tolerates partial receipts', () => {
  const rec = {
    ticket: 'K26-400123',
    date: 'Jul 8, 2026',
    tender: 'Sea Venture',
    district: 'Northeast Kodiak',
    statArea: '259-42',
    permit: 'S01K-12345',
    condition: 'RSW',
    lines: [{ species: 'pink', code: 440, count: 5000, lbs: 18000, price: 0.34, value: 6120 }],
    gross: 6120,
    crewShare: 1836,
    net: 4284,
    advanceRepaid: 1000,
  };
  const m = L.ticketModel(rec, { speciesTable: species });
  assert.equal(m.ticket, 'K26-400123');
  assert.equal(m.lines[0].code, '440');
  assert.equal(m.lines[0].lbs, '18,000');
  assert.equal(m.lines[0].price, '$0.34');
  assert.equal(m.gross, '$6,120.00');
  assert.equal(m.crew.length, 3);
  assert.equal(m.crew[0].share, '$612.00');
  assert.equal(m.advanceRepaid, '$1,000.00');
  assert.equal(m.rawNet - m.rawAdvance, 3284);
  // The stub's receipt: no ticket number, date, codes or totals.
  const stub = L.ticketModel({ ticket: 'STUB', tender: 'Stub Tender', lines: [{ species: 'chum', count: 100, lbs: 850, price: 0.55, value: 467.5 }], gross: 467.5, crewShare: 140.25, net: 327.25 }, { speciesTable: species, seasonStart: { month: 7, day: 6 }, day: 2, hours: 14.5 });
  assert.match(stub.ticket, /^K26-\d{6}$/);
  assert.equal(stub.lines[0].code, '450');
  assert.equal(stub.date, 'Jul 8, 2026');
  assert.equal(stub.time, '2:30 PM');
  assert.equal(stub.totalLbs, '850');
});

test('keycapify turns key names in hints into keycaps', () => {
  const segs = L.keycapify("Hit Space to let the skiff go. Hold E on the winch. Logbook (L). A and D aim the skiff's pull.");
  const keys = segs.filter((s) => s.key).map((s) => s.key);
  assert.deepEqual(keys, ['Space', 'E', 'L', 'A', 'D']);
  assert.equal(segs.map((s) => s.key ?? s.text).join(''), "Hit Space to let the skiff go. Hold E on the winch. Logbook L. A and D aim the skiff's pull.");
  assert.deepEqual(L.keycapify('A plain sentence.'), [{ text: 'A plain sentence.' }]);
  assert.equal(L.keyLabel('KeyE'), 'E');
  assert.equal(L.keyLabel('Space'), 'Space');
});

test('radio and toast timing, throttle and tide labels', () => {
  assert.ok(L.radioDuration('short') >= 2.8);
  assert.ok(L.radioDuration('x'.repeat(2000)) <= 16);
  assert.equal(L.toastDuration({ duration: 99 }), 12);
  assert.equal(L.toastDuration({}), 4);
  const th = L.createThrottle(10);
  assert.equal(th.due(0), true);
  assert.equal(th.due(0.05), false);
  assert.equal(th.due(0.06), true);
  const t = L.tideLabel({ stage: 'flood', flow: 0.8, hoursToSlack: 1.35 });
  assert.equal(t.text, 'Flood tide · slack in 1h 21m');
  assert.equal(L.tideLabel({ stage: 'slack', flow: 0.1 }).text, 'Slack water · ebb next');
});

test('chart view: zoom keeps the point under the cursor, pan and clamp stay on the chart', () => {
  const v = C.createChartView({ half: 8000, width: 800, height: 600, margin: 20 });
  assert.ok(Math.abs(v.toScreen(0, 0).x - 400) < 1e-9);
  const w0 = v.toWorld(600, 200);
  v.zoomAt(600, 200, 3);
  const w1 = v.toWorld(600, 200);
  assert.ok(Math.abs(w0.x - w1.x) < 1e-6 && Math.abs(w0.z - w1.z) < 1e-6);
  v.pan(1e6, 0);
  assert.ok(v.cx >= -8000 && v.cx <= 8000);
  const vis = v.visibleWorld();
  assert.ok(vis.x0 >= -8000 - v.margin / v.scale - 1 && vis.x0 < vis.x1); // the neatline margin may show
  v.zoomAt(400, 300, 1e-6);
  assert.equal(v.scale, v.minScale);
  assert.equal(Math.abs(v.cx), 0);
  v.zoomAt(400, 300, 1e9);
  assert.equal(v.scale, v.maxScale);
  const s = v.toScreen(1234, -567);
  const back = v.toWorld(s.x, s.y);
  assert.ok(Math.abs(back.x - 1234) < 1e-6 && Math.abs(back.z + 567) < 1e-6);
});

test('chart raster: cream land, blue water banded by depth, dark coastline', () => {
  const hm = fakeCtx().heightmap;
  const n = 256;
  const b = C.createChartBuilder(hm, n);
  assert.equal(b.done, false);
  while (!b.step(40));
  assert.equal(b.done, true);
  const px = (x, z) => {
    const i = Math.floor(((x + hm.half) / (2 * hm.half)) * n);
    const j = Math.floor(((z + hm.half) / (2 * hm.half)) * n);
    const o = (j * n + i) * 4;
    return [...b.data.slice(o, o + 4)];
  };
  // Deep open water in the Gulf (south-east): pale, blue-dominant.
  const sea = px(6500, 6000);
  assert.ok(sea[2] > sea[0] && sea[3] === 255, `sea ${sea}`);
  // Inland Kodiak: warm (red >= blue).
  const land = px(0, 800);
  assert.ok(land[0] >= land[2], `land ${land}`);
});

test('soundings sit in open water and label placement avoids overlaps', () => {
  const hm = fakeCtx().heightmap;
  const s = C.selectSoundings(hm, { spacing: 3000 });
  assert.ok(s.length > 10);
  for (const p of s) {
    assert.ok(hm.depthAt(p.x, p.z) >= 3);
    assert.ok(hm.shoreDistance(p.x, p.z) >= 90);
  }
  assert.ok(new Set(s.map((p) => p.level)).size >= 2);
  const items = [
    { id: 'a', x: 100, y: 100, w: 60, h: 12, priority: 10 },
    { id: 'b', x: 104, y: 100, w: 60, h: 12, priority: 5 },
    { id: 'c', x: 104, y: 101, w: 60, h: 12, priority: 1 },
    { id: 'd', x: 400, y: 300, w: 60, h: 12, priority: 1, anchor: 'center' },
  ];
  const placed = C.placeLabels(items, { width: 800, height: 600 });
  const rects = placed.map((p) => ({ x: p.lx, y: p.ly, w: p.w, h: p.h }));
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const q = rects[j];
      assert.ok(!(a.x < q.x + q.w && q.x < a.x + a.w && a.y < q.y + q.h && q.y < a.y + a.h), 'labels overlap');
    }
  }
  assert.ok(placed.find((p) => p.id === 'a'));
  assert.equal(placed.find((p) => p.id === 'd').lx, 370);
  // Labels stay inside the chart's neatline (left/top bounds) and off blocked rects (legend, rose).
  const edge = C.placeLabels([{ id: 'e', x: 205, y: 100, w: 60, h: 12, priority: 1 }], { left: 200, width: 800, height: 600 });
  assert.ok(edge[0].lx >= 200, 'placed right of its anchor, inside the left bound');
  const none = C.placeLabels([{ id: 'f', x: 100, y: 100, w: 60, h: 12, anchor: 'center' }], { width: 800, height: 600, blocked: [{ x: 50, y: 80, w: 120, h: 40 }] });
  assert.equal(none.length, 0);
  assert.equal(C.WATER_KINDS.has('bay'), true);
  assert.ok(C.labelPriority('town') > C.labelPriority('cape'));
});

test('salmon mark is well-formed SVG with an outline that can draw itself', () => {
  const s = salmonMarkSVG();
  assert.match(s, /^<svg[^>]+viewBox="0 0 120 92"/);
  assert.ok(!/NaN|undefined|Infinity/.test(s));
  assert.equal((s.match(/<path/g) ?? []).length >= 9, true);
  assert.match(s, /class="salmon-body"[^>]+pathLength="100"/);
  for (const cls of ['salmon-lines', 'salmon-spots', 'salmon-eye', 'salmon-waves']) assert.ok(s.includes(`class="${cls}"`), cls);
  // The fish stays on the sheet: every coordinate inside the viewBox (with a little room for the stroke).
  for (const m of s.matchAll(/(-?\d+\.\d+),(-?\d+\.\d+)/g)) {
    const x = Number(m[1]);
    const y = Number(m[2]);
    assert.ok(x > -2 && x < 122 && y > -2 && y < 94, `point ${x},${y} off the mark`);
  }
  // Other poses stay well-formed too.
  assert.ok(!/NaN/.test(salmonMarkSVG({ R: 40, rotDeg: -2, waves: false })));
});

test('ui system under Node: required API, events only, serialize/restore/reset', async () => {
  const ctx = fakeCtx();
  const { create } = await import('../src/ui/ui.js');
  const ui = await create(ctx);
  assert.deepEqual(missingMembers('ui', ui), []);
  // Superset of the stub.
  for (const k of Object.keys(STUBS.ui(ctx))) assert.ok(k in ui, `missing ${k}`);
  const seen = [];
  for (const ev of ['ui:toast', 'ui:radio', 'ui:hint', 'ui:open']) ctx.events.on(ev, (p) => seen.push([ev, p]));
  ui.toast('Anchor down', { kind: 'info', duration: 2.5 });
  ui.radio('Uncle Pete', 'Let her go!', '10');
  ui.hint('fuel', 'Top off at a tender.');
  ui.openMap();
  ui.openLogbook();
  assert.deepEqual(seen.map((s) => s[0]), ['ui:toast', 'ui:radio', 'ui:hint', 'ui:open', 'ui:open']);
  assert.deepEqual(seen[0][1], { text: 'Anchor down', kind: 'info', duration: 2.5 });
  assert.deepEqual(seen[1][1], { from: 'Uncle Pete', text: 'Let her go!', channel: '10' });
  ui.setWaypoint({ x: 100.04, z: -250 });
  assert.deepEqual(ui.waypoint, { x: 100, z: -250 });
  ui.restore({ hintsShown: ['fuel', 'pete-spot', 3], waypoint: { x: 5, z: 6 }, sets: [{ setNumber: 1 }] });
  const d = ui.serialize();
  assert.deepEqual(d.hintsShown, ['fuel', 'pete-spot']);
  assert.deepEqual(d.waypoint, { x: 5, z: 6 });
  assert.equal(d.sets.length, 1);
  assert.doesNotThrow(() => JSON.stringify(d));
  ui.reset();
  assert.deepEqual(ui.serialize(), { hintsShown: [], waypoint: null, sets: [], tickets: [] });
  ui.restore(null);
  assert.equal(typeof ui.debugState().mode, 'string');
});
