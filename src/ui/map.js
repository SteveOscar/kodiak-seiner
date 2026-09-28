// The chart (M, mode 'map'): a nautical chart rendered once from the heightmap (land tint, hillshade and contours,
// depth tints and contours, coastline), with vector layers drawn on view changes (graticule, districts, closed
// waters, soundings, compass rose, place names) and live overlays at 10 Hz (boat, tenders, fleet,
// waypoint, intel notes, fish sightings, tidal current, fast-travel route). Pan with drag, zoom with the wheel,
// click to set a waypoint or pick a fast-travel destination.

import { h, clear, button, setText, toggle, svgFrom } from './dom.js';
import { createChartView, createChartBuilder, selectSoundings, placeLabels, WATER_KINDS, labelPriority } from './lib/chart.js';
import { bearingDistance, tideLabel } from './lib/logic.js';
import { money, int, nmLabel, latLonLabel, cardinal, SPECIES_INFO, clockTime, calendar } from './lib/format.js';
import { GLYPHS } from './lib/art.js';

const PAPER = '#f4ecd6';
const INK = '#2c3336';
const MAGENTA = '#a3317a';
const WATER_INK = '#2f5d78';
const SOUND_INK = '#557a90';
const CLOSED = '#c0392b';
const BOAT = '#ff7a1a';

export function createMap(ctx, { close, getWaypoint, setWaypoint, openTeleport = null }) {
  const half = ctx.config.world.half;
  const base = h('canvas.map-base');
  const live = h('canvas.map-live');
  const tip = h('div.map-tip.hidden');
  const scaleBar = h('div.map-scale', null, [h('div.map-scale-bar'), h('div.map-scale-label')]);
  const zoomBox = h('div.map-zoom.ui-interactive', null, [
    button('+', () => zoomBy(1.6), { cls: 'map-zbtn', title: 'Zoom in' }),
    button('−', () => zoomBy(1 / 1.6), { cls: 'map-zbtn', title: 'Zoom out' }),
    button('', () => centerBoat(), { cls: 'map-zbtn map-zboat', title: 'Centre on the boat' }),
    button('', () => overview(), { cls: 'map-zbtn map-zall', title: 'Whole chart' }),
  ]);
  zoomBox.querySelector('.map-zboat .btn-label').append(svgFrom(GLYPHS.pin));
  zoomBox.querySelector('.map-zall .btn-label').textContent = '⤢';
  // The chart's title block sits with the legend in the corner of the sheet, so it never lands on the island.
  const legend = h('div.map-legend', null, [
    h('div.lg-title', null, [h('div.lg-name', { text: 'Kodiak Island' }), h('div.lg-sub', { text: 'and approaches · soundings in metres' })]),
    legendRow('lg-shallow', 'Under 6 m — too shallow to set'),
    legendRow('lg-lead', '6–16 m — leads touch bottom'),
    legendRow('lg-closed', 'Closed waters'),
    legendRow('lg-district', 'District boundary'),
  ]);
  const frame = h('div.map-frame.ui-interactive', null, [base, live, tip, zoomBox, scaleBar, legend]);

  const posEl = h('div.ms-pos');
  const posSub = h('div.ms-pos-sub');
  const openEl = h('div.ms-open');
  const tideEl = h('div.ms-tide');
  const tideCanvas = h('canvas.ms-tide-canvas', { width: 520, height: 110 });
  const wpBox = h('div.ms-wp');
  const travelList = h('div.ms-travel-list');
  const travelHead = h('div.ms-h', { text: 'Fast travel' });
  const explore = () => !!ctx.state.freeExplore && !!ctx.systems.season?.travel?.teleport;
  const preview = h('div.ms-preview.hidden');
  const travelNote = h('div.ms-note');
  const side = h('div.map-side.ui-interactive', null, [
    h('div.ms-head', null, [h('div.panel-kicker', { text: 'Chart' }), h('h2.ms-title', { text: 'Kodiak Island & approaches' })]),
    h('div.ms-sec', null, [posEl, posSub, openEl]),
    h('div.ms-sec', null, [h('div.ms-h', { text: 'Tide' }), tideEl, tideCanvas]),
    h('div.ms-sec', null, [h('div.ms-h', { text: 'Waypoint' }), wpBox]),
    h('div.ms-sec.ms-travel', null, [travelHead, travelNote, preview, travelList]),
  ]);
  const hint = h('div.map-hint', null, [
    hintItem('Drag', 'pan'),
    hintItem('Wheel', 'zoom'),
    hintItem('Click', 'set waypoint · pick a harbor or tender'),
    hintItem('Right-click', 'clear waypoint'),
    hintItem('M', 'close'),
  ]);
  const el = h('div.ui-panel.panel-map', null, [h('div.map-wrap', null, [frame, side]), hint]);

  const view = createChartView({ half, width: 800, height: 600, margin: 26, maxZoom: 7 });
  let builder = null;
  let raster = null; // canvas holding the finished raster
  let soundings = null;
  let dpr = Math.min(2, window.devicePixelRatio || 1);
  let dirtyBase = true;
  let dirtyLive = true;
  let liveT = 0;
  let isOpen = false;
  let sized = false;
  let selected = null; // travel target
  let selectedPreview = null;
  let hover = null;
  let hitList = [];
  let lastView = '';
  let uiRects = []; // chart-space rects covered by the legend, zoom buttons and scale bar
  let labelRects = []; // rects taken by charted names, so live labels can avoid them

  // ---------------------------------------------------------------- raster build (idle time, before first open)
  function ensureBuilder() {
    if (!builder && ctx.heightmap?.game) builder = createChartBuilder(ctx.heightmap, Math.min(2048, ctx.heightmap.size));
    return builder;
  }
  function finishRaster() {
    const b = ensureBuilder();
    if (!b) return null;
    if (!raster) {
      b.finish();
      raster = document.createElement('canvas');
      raster.width = raster.height = b.n;
      raster.getContext('2d').putImageData(new ImageData(b.data, b.n, b.n), 0, 0);
      builder.data = null;
    }
    return raster;
  }
  function idleBuild(deadline) {
    const b = ensureBuilder();
    if (!b || raster) return;
    const t0 = performance.now();
    const budget = Math.min(6, deadline?.timeRemaining?.() ?? 4);
    while (!b.done && performance.now() - t0 < budget) b.step(8);
    if (b.done) finishRaster();
    else schedule();
  }
  function schedule() {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(idleBuild, { timeout: 500 });
    else setTimeout(() => idleBuild(null), 50);
  }

  // ---------------------------------------------------------------- view controls
  function zoomBy(f, px = view.width / 2, py = view.height / 2) {
    view.zoomAt(px, py, f);
    dirtyBase = dirtyLive = true;
  }
  function centerBoat() {
    const p = ctx.game?.avatar?.() ?? ctx.systems.seiner?.position;
    if (p) view.centerOn(p.x, p.z, Math.max(view.scale, view.minScale * 2.4));
    dirtyBase = dirtyLive = true;
  }
  function overview() {
    view.fit();
    dirtyBase = dirtyLive = true;
  }

  function resize() {
    const r = frame.getBoundingClientRect();
    const w = Math.max(200, Math.round(r.width));
    const hh = Math.max(200, Math.round(r.height));
    dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const c of [base, live]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(hh * dpr);
      c.style.width = `${w}px`;
      c.style.height = `${hh}px`;
    }
    view.resize(w, hh);
    measureUi();
    sized = true;
    dirtyBase = dirtyLive = true;
  }

  // Chart-space rects of the overlaid legend, zoom buttons and scale bar (the scale bar changes width with zoom).
  function measureUi() {
    const r = frame.getBoundingClientRect();
    uiRects = [legend, zoomBox, scaleBar].map((node) => {
      const q = node.getBoundingClientRect();
      return { x: q.left - r.left - 4, y: q.top - r.top - 4, w: q.width + 8, h: q.height + 8 };
    });
  }

  // Places a live label (tender, fleet boat) beside its marker, avoiding charted names and other live labels.
  function liveLabel(g, lines, x, y, taken) {
    const widths = lines.map((l) => {
      g.font = l.font;
      return g.measureText(l.text).width;
    });
    const w = Math.max(...widths);
    const hgt = lines.reduce((a, l) => a + l.size + 1, 0);
    const cands = [
      [10, -hgt / 2],
      [-10 - w, -hgt / 2],
      [-w / 2, -hgt - 9],
      [-w / 2, 9],
    ];
    for (const [ox, oy] of cands) {
      const rect = { x: x + ox, y: y + oy, w, h: hgt };
      if (rect.x < 3 || rect.y < 3 || rect.x + w > view.width - 3 || rect.y + hgt > view.height - 3) continue;
      const hit = [...labelRects, ...taken].some((q) => rect.x < q.x + q.w && q.x < rect.x + rect.w && rect.y < q.y + q.h && q.y < rect.y + rect.h);
      if (hit) continue;
      taken.push(rect);
      let cy = rect.y;
      g.textAlign = 'left';
      g.textBaseline = 'top';
      g.lineJoin = 'round';
      lines.forEach((l) => {
        g.font = l.font;
        g.strokeStyle = 'rgba(244, 236, 214, 0.9)';
        g.lineWidth = 3;
        g.strokeText(l.text, rect.x, cy);
        g.fillStyle = l.color;
        g.fillText(l.text, rect.x, cy);
        cy += l.size + 1;
      });
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- pointer
  let drag = null;
  frame.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.map-zoom')) return;
    frame.setPointerCapture?.(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, moved: 0, button: e.button };
  });
  frame.addEventListener('pointermove', (e) => {
    const r = frame.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    if (drag && drag.button === 0) {
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      drag.x = e.clientX;
      drag.y = e.clientY;
      if (drag.moved > 3) {
        view.pan(dx, dy);
        dirtyBase = dirtyLive = true;
        frame.classList.add('dragging');
      }
      return;
    }
    const hit = hitTest(mx, my);
    if ((hit?.key ?? null) !== (hover?.key ?? null)) {
      hover = hit;
      showTip(hit, mx, my);
      dirtyLive = true;
    } else if (hit) moveTip(mx, my);
    frame.style.cursor = hit?.travel ? 'pointer' : '';
  });
  frame.addEventListener('pointerup', (e) => {
    const r = frame.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    frame.classList.remove('dragging');
    if (!drag) return;
    const wasDrag = drag.moved > 3;
    const btn = drag.button;
    drag = null;
    if (wasDrag) return;
    if (btn === 2) {
      setWaypoint(null);
      dirtyLive = true;
      renderSide();
      return;
    }
    if (btn !== 0) return;
    const hit = hitTest(mx, my);
    if (hit?.travel) {
      select(hit.travel);
      return;
    }
    const w = view.toWorld(mx, my);
    if (Math.abs(w.x) > half || Math.abs(w.z) > half) return;
    setWaypoint({ x: w.x, z: w.z });
    if (explore()) select({ id: 'point', point: true, name: ctx.systems.places?.districtAt?.(w.x, w.z) ?? 'Open water', x: w.x, z: w.z });
    dirtyLive = true;
    renderSide();
  });
  frame.addEventListener('pointerleave', () => {
    hover = null;
    showTip(null);
  });
  frame.addEventListener('contextmenu', (e) => e.preventDefault());
  frame.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const r = frame.getBoundingClientRect();
      const f = Math.exp(-Math.sign(e.deltaY) * Math.min(1, Math.abs(e.deltaY) / 100) * 0.35);
      zoomBy(f, e.clientX - r.left, e.clientY - r.top);
    },
    { passive: false },
  );
  frame.addEventListener('dblclick', (e) => {
    const r = frame.getBoundingClientRect();
    zoomBy(2, e.clientX - r.left, e.clientY - r.top);
  });

  function hitTest(mx, my) {
    let best = null;
    let bd = 13 * 13;
    for (const o of hitList) {
      const d = (o.sx - mx) ** 2 + (o.sy - my) ** 2;
      if (d < bd) {
        bd = d;
        best = o;
      }
    }
    return best;
  }
  function showTip(hit, mx, my) {
    toggle(tip, 'hidden', !hit);
    if (!hit) return;
    clear(tip);
    tip.append(h('div.map-tip-t', { text: hit.title }));
    if (hit.text) tip.append(h('div.map-tip-b', { text: hit.text }));
    if (hit.travel) tip.append(h('div.map-tip-a', { text: explore() ? 'Click to teleport' : 'Click for fast travel' }));
    moveTip(mx, my);
  }
  function moveTip(mx, my) {
    const left = mx + 16 + 260 > view.width ? mx - 16 - 260 : mx + 16;
    tip.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(Math.min(view.height - 90, my + 10))}px, 0)`;
  }

  // ---------------------------------------------------------------- base layer
  function drawBase() {
    const g = base.getContext('2d');
    const W = base.width;
    const H = base.height;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = PAPER;
    g.fillRect(0, 0, W, H);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    updateScale();
    measureUi();
    const r = finishRaster();
    const a = view.toScreen(-half, -half);
    const b = view.toScreen(half, half);
    if (r) {
      // Draw only the visible part of the raster.
      const vw = view.visibleWorld();
      const x0 = Math.max(-half, vw.x0);
      const z0 = Math.max(-half, vw.z0);
      const x1 = Math.min(half, vw.x1);
      const z1 = Math.min(half, vw.z1);
      if (x1 > x0 && z1 > z0) {
        const n = r.width;
        const sx = ((x0 + half) / (2 * half)) * n;
        const sy = ((z0 + half) / (2 * half)) * n;
        const sw = ((x1 - x0) / (2 * half)) * n;
        const sh = ((z1 - z0) / (2 * half)) * n;
        const d0 = view.toScreen(x0, z0);
        g.imageSmoothingEnabled = true;
        g.imageSmoothingQuality = 'high';
        g.drawImage(r, sx, sy, sw, sh, d0.x, d0.y, (x1 - x0) * view.scale, (z1 - z0) * view.scale);
      }
    }
    g.save();
    g.beginPath();
    g.rect(a.x, a.y, b.x - a.x, b.y - a.y);
    g.clip();
    drawGraticule(g, a, b);
    drawDistricts(g);
    drawClosed(g);
    drawSoundings(g);
    drawRose(g);
    drawLabels(g);
    g.restore();
    // Neatline: a double rule round the chart with lat/lon ticks in the margin.
    g.strokeStyle = INK;
    g.lineWidth = 1.4;
    g.strokeRect(a.x - 5.5, a.y - 5.5, b.x - a.x + 11, b.y - a.y + 11);
    g.lineWidth = 0.7;
    g.strokeRect(a.x - 0.5, a.y - 0.5, b.x - a.x + 1, b.y - a.y + 1);
    drawMarginTicks(g, a, b);
  }

  function drawGraticule(g, a, b) {
    const geo = ctx.geo;
    g.strokeStyle = 'rgba(60, 90, 110, 0.16)';
    g.lineWidth = 0.8;
    const lat0 = geo.toLatLon(0, half).lat;
    const lat1 = geo.toLatLon(0, -half).lat;
    const lon0 = geo.toLatLon(-half, 0).lon;
    const lon1 = geo.toLatLon(half, 0).lon;
    const step = view.zoom > 3 ? 5 / 60 : 10 / 60;
    for (let lat = Math.ceil(lat0 / step) * step; lat < lat1; lat += step) {
      const z = geo.toWorld(lat, 0).z;
      const y = view.toScreen(0, z).y;
      g.beginPath();
      g.moveTo(a.x, y);
      g.lineTo(b.x, y);
      g.stroke();
    }
    const lstep = step * 2;
    for (let lon = Math.ceil(lon0 / lstep) * lstep; lon < lon1; lon += lstep) {
      const x = view.toScreen(geo.toWorld(0, lon).x, 0).x;
      g.beginPath();
      g.moveTo(x, a.y);
      g.lineTo(x, b.y);
      g.stroke();
    }
  }

  function drawMarginTicks(g, a, b) {
    const geo = ctx.geo;
    g.fillStyle = INK;
    g.font = "10px 'SF Mono', ui-monospace, Menlo, monospace";
    const step = view.zoom > 3 ? 5 / 60 : 10 / 60;
    const lat0 = geo.toLatLon(0, half).lat;
    const lat1 = geo.toLatLon(0, -half).lat;
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    for (let lat = Math.ceil(lat0 / step) * step; lat < lat1; lat += step) {
      const y = view.toScreen(0, geo.toWorld(lat, 0).z).y;
      if (y < a.y + 8 || y > b.y - 8 || y < 10 || y > view.height - 10) continue;
      const d = Math.floor(lat + 1e-9);
      const m = Math.round((lat - d) * 60);
      if (a.x > 34) g.fillText(`${d}°${String(m).padStart(2, '0')}′`, a.x - 9, y);
    }
    const lon0 = geo.toLatLon(-half, 0).lon;
    const lon1 = geo.toLatLon(half, 0).lon;
    g.textAlign = 'center';
    g.textBaseline = 'bottom';
    for (let lon = Math.ceil(lon0 / (step * 2)) * step * 2; lon < lon1; lon += step * 2) {
      const x = view.toScreen(geo.toWorld(0, lon).x, 0).x;
      if (x < a.x + 20 || x > b.x - 20 || x < 20 || x > view.width - 20) continue;
      const v = Math.abs(lon);
      const d = Math.floor(v + 1e-9);
      const m = Math.round((v - d) * 60);
      if (a.y > 18) g.fillText(`${d}°${String(m).padStart(2, '0')}′W`, x, a.y - 9);
    }
  }

  function drawDistricts(g) {
    const ds = ctx.systems.places?.districts ?? [];
    g.save();
    g.strokeStyle = 'rgba(163, 49, 122, 0.55)';
    g.lineWidth = 1.2;
    g.setLineDash([7, 4, 1.5, 4]);
    for (const d of ds) {
      if (!d.polygon?.length) continue;
      g.beginPath();
      d.polygon.forEach((p, i) => {
        const s = view.toScreen(p.x, p.z);
        if (i === 0) g.moveTo(s.x, s.y);
        else g.lineTo(s.x, s.y);
      });
      g.closePath();
      g.stroke();
    }
    g.setLineDash([]);
    g.restore();
  }

  // District names join the label placement (lowest priority, several candidate spots near the label point).
  function districtLabelItems(g) {
    const ds = ctx.systems.places?.districts ?? [];
    const size = Math.max(9, Math.min(12.5, 8.5 + view.zoom));
    const font = `600 ${size}px -apple-system, 'Segoe UI', sans-serif`;
    g.font = font;
    const out = [];
    for (const d of ds) {
      if (!d.label) continue;
      const s = view.toScreen(d.label.x, d.label.z);
      const text = `${String(d.name).toUpperCase()} DISTRICT`;
      const sp = 2.2;
      const w = g.measureText(text).width + sp * (text.length - 1);
      const hgt = size + 2;
      // Centred on the district's label point, then nudged up/down, then sideways (near the chart edge).
      const cands = [];
      for (const dx of [0, 0.35, -0.35]) for (const dy of [0, 34, -34, 68, -68, 102]) cands.push([-w / 2 + dx * w, dy - hgt / 2]);
      out.push({ id: `d:${d.id}`, x: s.x, y: s.y, w, h: hgt, priority: 12, cands, text, font, spacing: sp, district: true });
    }
    return out;
  }

  function closedWaters() {
    const cw = ctx.systems.season?.closedWaters;
    if (Array.isArray(cw) && cw.length) return cw;
    const out = [];
    for (const s of ctx.systems.places?.streams ?? []) out.push({ id: s.id, name: s.name, x: s.x, z: s.z, radius: s.closedRadius ?? 200 });
    for (const c of ctx.systems.places?.closedAreas ?? []) out.push({ id: c.id, name: c.name, x: c.x, z: c.z, radius: c.radius ?? 400, reason: c.reason });
    return out;
  }

  function drawClosed(g) {
    g.save();
    for (const c of closedWaters()) {
      const s = view.toScreen(c.x, c.z);
      const r = (c.radius ?? 200) * view.scale;
      if (r < 1.5 || s.x < -r || s.y < -r || s.x > view.width + r || s.y > view.height + r) continue;
      g.save();
      g.beginPath();
      g.arc(s.x, s.y, r, 0, Math.PI * 2);
      g.fillStyle = 'rgba(192, 57, 43, 0.08)';
      g.fill();
      g.clip();
      g.strokeStyle = 'rgba(192, 57, 43, 0.5)';
      g.lineWidth = 1;
      const step = 4.5;
      g.beginPath();
      for (let k = -r * 2; k < r * 2; k += step) {
        g.moveTo(s.x + k - r, s.y - r);
        g.lineTo(s.x + k + r, s.y + r);
      }
      g.stroke();
      g.restore();
      g.beginPath();
      g.arc(s.x, s.y, r, 0, Math.PI * 2);
      g.strokeStyle = 'rgba(192, 57, 43, 0.85)';
      g.lineWidth = 1.1;
      g.setLineDash([3, 2.5]);
      g.stroke();
      g.setLineDash([]);
    }
    g.restore();
  }

  function drawSoundings(g) {
    if (!soundings) soundings = selectSoundings(ctx.heightmap, { spacing: 1500 });
    const maxLevel = view.zoom < 1.8 ? 0 : view.zoom < 3.6 ? 1 : 2;
    g.save();
    g.fillStyle = SOUND_INK;
    g.font = `italic ${view.zoom > 3 ? 11 : 10}px 'Iowan Old Style', 'Palatino Linotype', Georgia, serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    // Soundings stay clear of the compass rose.
    const rose = roseGeom();
    const clear2 = (rose.R * 1.32) ** 2;
    for (const s of soundings) {
      if (s.level > maxLevel) continue;
      const p = view.toScreen(s.x, s.z);
      if (p.x < -10 || p.y < -10 || p.x > view.width + 10 || p.y > view.height + 10) continue;
      if ((p.x - rose.c.x) ** 2 + (p.y - rose.c.y) ** 2 < clear2) continue;
      g.fillText(String(s.depth), p.x, p.y);
    }
    g.restore();
  }

  // The compass rose sits in open water south-east of the island; its size follows the zoom within limits.
  function roseGeom() {
    return { c: view.toScreen(6150, 3650), R: Math.max(46, Math.min(150, 850 * view.scale)) };
  }

  function drawRose(g) {
    const { c, R } = roseGeom();
    if (c.x < -R || c.y < -R || c.x > view.width + R || c.y > view.height + R) return;
    g.save();
    g.translate(c.x, c.y);
    g.strokeStyle = 'rgba(163, 49, 122, 0.75)';
    g.fillStyle = 'rgba(163, 49, 122, 0.75)';
    g.lineWidth = 0.8;
    // True ring.
    g.beginPath();
    g.arc(0, 0, R, 0, Math.PI * 2);
    g.stroke();
    g.beginPath();
    g.arc(0, 0, R * 0.9, 0, Math.PI * 2);
    g.stroke();
    for (let d = 0; d < 360; d += 5) {
      const a = (d * Math.PI) / 180;
      const len = d % 30 === 0 ? R * 0.1 : d % 10 === 0 ? R * 0.065 : R * 0.035;
      g.beginPath();
      g.moveTo(Math.sin(a) * R, -Math.cos(a) * R);
      g.lineTo(Math.sin(a) * (R - len), -Math.cos(a) * (R - len));
      g.stroke();
    }
    g.font = `${Math.max(7, R * 0.075)}px 'SF Mono', ui-monospace, Menlo, monospace`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let d = 30; d < 360; d += 30) {
      const a = (d * Math.PI) / 180;
      g.fillText(String(d), Math.sin(a) * R * 1.1, -Math.cos(a) * R * 1.1);
    }
    // Magnetic ring, rotated by the local variation (~14° E).
    const varA = (14 * Math.PI) / 180;
    g.save();
    g.rotate(varA);
    g.beginPath();
    g.arc(0, 0, R * 0.62, 0, Math.PI * 2);
    g.stroke();
    for (let d = 0; d < 360; d += 10) {
      const a = (d * Math.PI) / 180;
      const len = d % 90 === 0 ? R * 0.09 : R * 0.04;
      g.beginPath();
      g.moveTo(Math.sin(a) * R * 0.62, -Math.cos(a) * R * 0.62);
      g.lineTo(Math.sin(a) * (R * 0.62 - len), -Math.cos(a) * (R * 0.62 - len));
      g.stroke();
    }
    g.beginPath();
    g.moveTo(0, -R * 0.5);
    g.lineTo(-R * 0.035, -R * 0.4);
    g.lineTo(R * 0.035, -R * 0.4);
    g.closePath();
    g.fill();
    g.restore();
    // Star.
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      const long = i % 2 === 0;
      const L = long ? R * 0.84 : R * 0.46;
      const w = long ? R * 0.075 : R * 0.055;
      const tipx = Math.sin(a) * L;
      const tipy = -Math.cos(a) * L;
      const lx = Math.sin(a - Math.PI / 2) * w;
      const ly = -Math.cos(a - Math.PI / 2) * w;
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(lx, ly);
      g.lineTo(tipx, tipy);
      g.closePath();
      g.fillStyle = 'rgba(163, 49, 122, 0.8)';
      g.fill();
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(-lx, -ly);
      g.lineTo(tipx, tipy);
      g.closePath();
      g.fillStyle = 'rgba(244, 236, 214, 0.9)';
      g.fill();
      g.stroke();
    }
    g.fillStyle = 'rgba(163, 49, 122, 0.9)';
    g.font = `600 ${Math.max(9, R * 0.12)}px 'Iowan Old Style', 'Palatino Linotype', Georgia, serif`;
    g.fillText('N', 0, -R * 1.24);
    g.font = `italic ${Math.max(7, R * 0.06)}px 'Iowan Old Style', 'Palatino Linotype', Georgia, serif`;
    g.fillText('VAR 14°E (2026)', 0, R * 0.26);
    g.restore();
  }

  function drawLabels(g) {
    const places = ctx.systems.places?.list ?? [];
    const disc = ctx.systems.discovery;
    const items = [];
    const dots = [];
    g.save();
    for (const p of places) {
      if (!Number.isFinite(p.x)) continue;
      const s = view.toScreen(p.x, p.z);
      if (s.x < -80 || s.y < -30 || s.x > view.width + 80 || s.y > view.height + 30) continue;
      const known = p.id === 'kodiak' || !!disc?.isDiscovered?.(p.id);
      if (!known) {
        if (!p.memorial) dots.push(s);
        continue;
      }
      const water = WATER_KINDS.has(p.kind) && p.kind !== 'harbor';
      const pri = labelPriority(p.kind);
      const big = p.kind === 'town' || (water && (p.radius ?? 0) > 600);
      let size = water ? (big ? 13 : 11.5) : p.kind === 'town' ? 12.5 : p.kind === 'village' ? 11.5 : 10.5;
      size += Math.min(2.5, (view.zoom - 1) * 0.5);
      const text = p.kind === 'town' || p.kind === 'village' ? p.name.toUpperCase() : p.name;
      const font = water
        ? `italic ${size}px 'Iowan Old Style', 'Palatino Linotype', Georgia, serif`
        : p.kind === 'town' || p.kind === 'village'
          ? `600 ${size - 1}px 'Iowan Old Style', 'Palatino Linotype', Georgia, serif`
          : `${size}px 'Iowan Old Style', 'Palatino Linotype', Georgia, serif`;
      g.font = font;
      const spacing = p.kind === 'town' || p.kind === 'village' ? 1.4 : water && big ? 1.2 : 0;
      const w = g.measureText(text).width + spacing * text.length;
      const peak = p.kind === 'peak' && Number.isFinite(p.x) ? Math.round(ctx.heightmap?.realAt?.(p.x, p.z) ?? 0) : null;
      items.push({ id: p.id, x: s.x, y: s.y, w, h: size + 2, priority: pri + (big ? 10 : 0), anchor: water ? 'center' : 'point', gap: 7, text, font, spacing, water, kind: p.kind, memorial: p.memorial, peak });
    }
    // Undiscovered places: faint dots (no names).
    g.fillStyle = 'rgba(44, 51, 54, 0.28)';
    for (const s of dots) {
      g.beginPath();
      g.arc(s.x, s.y, 1.6, 0, Math.PI * 2);
      g.fill();
    }
    const boat = ctx.systems.seiner?.position;
    const bs = boat ? view.toScreen(boat.x, boat.z) : null;
    items.push(...districtLabelItems(g));
    // Names keep off the overlaid legend/buttons and the compass rose (both sliced off labelRects below).
    const rose = roseGeom();
    const blocked = [...uiRects, { x: rose.c.x - rose.R * 1.15, y: rose.c.y - rose.R * 1.35, w: rose.R * 2.3, h: rose.R * 2.5 }];
    const fixed = blocked.length;
    if (bs) blocked.push({ x: bs.x - 12, y: bs.y - 12, w: 24, h: 24 });
    // Anchored tenders keep their spot on the chart: names are placed clear of their hull symbols.
    for (const t of ctx.systems.fleet?.tenders ?? []) {
      if (!t?.position) continue;
      const q = view.toScreen(t.position.x, t.position.z);
      blocked.push({ x: q.x - 10, y: q.y - 10, w: 20, h: 20 });
    }
    const occ = {};
    // Inside the neatline (the chart is clipped to it) as well as the frame.
    const na = view.toScreen(-half, -half);
    const nb = view.toScreen(half, half);
    const placed = placeLabels(items, { left: Math.max(0, na.x + 2), top: Math.max(0, na.y + 2), width: Math.min(view.width, nb.x - 2), height: Math.min(view.height, nb.y - 2), blocked, out: occ });
    labelRects = (occ.rects ?? []).slice(fixed);
    for (const it of placed) {
      if (it.district) {
        g.font = it.font;
        g.fillStyle = 'rgba(163, 49, 122, 0.78)';
        g.textAlign = 'left';
        g.textBaseline = 'top';
        spaced(g, it.text, it.lx, it.ly, it.spacing);
        continue;
      }
      // Point symbol.
      if (!it.water) symbol(g, it.kind, it.x, it.y, it.memorial);
      g.font = it.font;
      g.textAlign = 'left';
      g.textBaseline = 'top';
      g.lineJoin = 'round';
      g.strokeStyle = 'rgba(244, 236, 214, 0.85)';
      g.lineWidth = 3;
      g.fillStyle = it.water ? WATER_INK : INK;
      if (it.spacing) {
        spacedStroke(g, it.text, it.lx, it.ly, it.spacing);
      } else {
        g.strokeText(it.text, it.lx, it.ly);
        g.fillText(it.text, it.lx, it.ly);
      }
      if (it.peak && view.zoom > 1.5) {
        g.font = "italic 9px 'Iowan Old Style', Georgia, serif";
        g.fillStyle = 'rgba(90, 70, 40, 0.9)';
        g.fillText(`${int(it.peak)} m`, it.lx, it.ly + it.h);
      }
    }
    g.restore();
  }

  function symbol(g, kind, x, y, memorial) {
    g.save();
    g.fillStyle = INK;
    g.strokeStyle = INK;
    g.lineWidth = 1;
    if (memorial) {
      g.strokeStyle = 'rgba(44, 51, 54, 0.6)';
      g.beginPath();
      g.arc(x, y, 2.6, 0, Math.PI * 2);
      g.stroke();
    } else if (kind === 'town') {
      g.beginPath();
      g.arc(x, y, 4, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = PAPER;
      g.beginPath();
      g.arc(x, y, 1.6, 0, Math.PI * 2);
      g.fill();
    } else if (kind === 'village') {
      g.beginPath();
      g.arc(x, y, 3, 0, Math.PI * 2);
      g.fill();
    } else if (kind === 'cannery' || kind === 'hatchery') {
      g.fillRect(x - 2.6, y - 2.6, 5.2, 5.2);
    } else if (kind === 'lighthouse') {
      g.fillStyle = MAGENTA;
      g.beginPath();
      g.moveTo(x, y - 7);
      g.quadraticCurveTo(x + 2.2, y - 2, x + 0.8, y);
      g.lineTo(x - 0.8, y);
      g.quadraticCurveTo(x - 2.2, y - 2, x, y - 7);
      g.fill();
      g.fillStyle = INK;
      g.beginPath();
      g.arc(x, y, 1.6, 0, Math.PI * 2);
      g.fill();
    } else if (kind === 'peak') {
      g.beginPath();
      g.moveTo(x, y - 4);
      g.lineTo(x + 3.6, y + 2.4);
      g.lineTo(x - 3.6, y + 2.4);
      g.closePath();
      g.fill();
    } else if (kind === 'cape' || kind === 'island') {
      // Capes and islands are named without a symbol.
    } else {
      g.beginPath();
      g.arc(x, y, 2.2, 0, Math.PI * 2);
      g.stroke();
    }
    g.restore();
  }

  function spaced(g, text, x, y, sp) {
    const align = g.textAlign;
    const widths = [...text].map((ch) => g.measureText(ch).width);
    const total = widths.reduce((a, b) => a + b, 0) + sp * (text.length - 1);
    let cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
    g.textAlign = 'left';
    [...text].forEach((ch, i) => {
      g.fillText(ch, cx, y);
      cx += widths[i] + sp;
    });
    g.textAlign = align;
  }
  function spacedStroke(g, text, x, y, sp) {
    let cx = x;
    for (const ch of text) {
      g.strokeText(ch, cx, y);
      g.fillText(ch, cx, y);
      cx += g.measureText(ch).width + sp;
    }
  }

  function updateScale() {
    // A round number of nautical miles about 90-160 px long.
    const nmPerPx = ctx.geo.toNauticalMiles(1 / view.scale);
    const target = nmPerPx * 120;
    const steps = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20];
    const nm = steps.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a), steps[0]);
    const px = nm / nmPerPx;
    scaleBar.querySelector('.map-scale-bar').style.width = `${Math.round(px)}px`;
    scaleBar.querySelector('.map-scale-label').textContent = `${nm} nautical mile${nm === 1 ? '' : 's'}`;
  }

  // ---------------------------------------------------------------- live layer
  function drawLive() {
    const g = live.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, live.width, live.height);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    hitList = [];
    const s = ctx.systems.seiner;
    const av = ctx.game?.avatar?.() ?? s?.position;
    const bp = s?.position;

    // Tidal current arrows around the boat.
    if (bp && view.zoom > 1.3) drawCurrents(g, bp);

    // Fast-travel route preview.
    const route = selectedPreview?.route;
    if (Array.isArray(route) && route.length > 1) {
      g.save();
      g.strokeStyle = 'rgba(255, 122, 26, 0.9)';
      g.lineWidth = 2.2;
      g.setLineDash([7, 5]);
      g.beginPath();
      route.forEach((p, i) => {
        const q = view.toScreen(p.x, p.z);
        if (i === 0) g.moveTo(q.x, q.y);
        else g.lineTo(q.x, q.y);
      });
      g.stroke();
      g.restore();
    }

    // Intel notes.
    const intel = ctx.systems.discovery?.intel ?? [];
    for (const n of intel) {
      if (!Number.isFinite(n?.x)) continue;
      const q = clearOfLabels(view.toScreen(n.x, n.z), view.zoom < 2.3 ? 4 : 7);
      if (q.x < -10 || q.y < -10 || q.x > view.width + 10 || q.y > view.height + 10) continue;
      const hot = n.kind === 'hotspot';
      hitList.push({ key: `n:${n.id}`, sx: q.x, sy: q.y, title: n.title ?? 'Chart note', text: n.text });
      if (view.zoom < 2.3) {
        // Overview: a small pencilled dot; the note icon appears when zoomed in.
        g.fillStyle = hot ? 'rgba(20, 92, 110, 0.85)' : 'rgba(58, 74, 84, 0.7)';
        g.strokeStyle = 'rgba(244, 236, 214, 0.9)';
        g.lineWidth = 1.2;
        g.beginPath();
        g.arc(q.x, q.y, 2.6, 0, Math.PI * 2);
        g.fill();
        g.stroke();
        continue;
      }
      g.save();
      g.translate(q.x, q.y);
      g.fillStyle = hot ? 'rgba(20, 92, 110, 0.92)' : 'rgba(58, 74, 84, 0.85)';
      g.beginPath();
      g.moveTo(-4.5, -5.5);
      g.lineTo(3, -5.5);
      g.lineTo(5, -3.5);
      g.lineTo(5, 5.5);
      g.lineTo(-4.5, 5.5);
      g.closePath();
      g.fill();
      g.strokeStyle = 'rgba(244, 236, 214, 0.95)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(-2.3, -1.6);
      g.lineTo(2.8, -1.6);
      g.moveTo(-2.3, 1);
      g.lineTo(2.8, 1);
      g.moveTo(-2.3, 3.4);
      g.lineTo(1.2, 3.4);
      g.stroke();
      g.restore();
    }

    // Fish sightings (binoculars, summit perches, the spotter plane), fading with age.
    let marks = [];
    try {
      marks = ctx.systems.discovery?.recentSightings?.() ?? [];
    } catch {
      marks = [];
    }
    for (const m of marks) {
      if (!Number.isFinite(m?.x)) continue;
      const q = view.toScreen(m.x, m.z);
      const col = SPECIES_INFO[m.species]?.color ?? '#5b7f8f';
      const alpha = 1 - 0.75 * (m.age ?? 0);
      g.save();
      g.globalAlpha = alpha;
      g.translate(q.x, q.y);
      g.rotate(m.heading ?? 0);
      g.fillStyle = col;
      g.strokeStyle = 'rgba(30, 40, 44, 0.9)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(0, -7);
      g.quadraticCurveTo(4, -2, 0, 5);
      g.lineTo(3, 8);
      g.lineTo(-3, 8);
      g.lineTo(0, 5);
      g.quadraticCurveTo(-4, -2, 0, -7);
      g.fill();
      g.stroke();
      g.restore();
      const cal = calendar(m.day ?? ctx.clock.day, ctx.config.time.seasonStart);
      hitList.push({ key: `f:${m.schoolId}:${Math.round(m.x)}`, sx: q.x, sy: q.y, title: `${SPECIES_INFO[m.species] ? `${SPECIES_INFO[m.species].name} school` : 'Jumpers'} sighted`, text: `${m.source === 'spotter' ? 'Spotter plane' : m.source === 'perch' ? 'From a summit' : 'Binoculars'} · ${cal.label} ${clockTime(m.hours ?? ctx.clock.hours)}${Number.isFinite(m.heading) ? ` · heading ${cardinal((m.heading * 180) / Math.PI, 8)}` : ''}` });
    }

    // Tenders first (their names matter most), then the fleet (small grey hulls, named when zoomed in).
    const taken = [];
    const TENDER_FONT = "600 11px 'Iowan Old Style', Georgia, serif";
    const SUB_FONT = "9px 'SF Mono', ui-monospace, Menlo, monospace";
    for (const t of ctx.systems.fleet?.tenders ?? []) {
      if (!t?.position) continue;
      const q = view.toScreen(t.position.x, t.position.z);
      if (q.x < -40 || q.y < -20 || q.x > view.width + 40 || q.y > view.height + 20) continue;
      hull(g, q.x, q.y, t.heading ?? 0, '#8e2b22', 8);
      const lines = [{ text: t.name, font: TENDER_FONT, size: 11, color: '#6e1f1b' }];
      if (t.channel && view.zoom > 2.4) lines.push({ text: `tender · ch ${t.channel}`, font: SUB_FONT, size: 9, color: 'rgba(110, 31, 27, 0.8)' });
      liveLabel(g, lines, q.x, q.y, taken);
      const tgt = travelTargets().find((x) => x.kind === 'tender' && x.tenderId === t.id);
      hitList.push({ key: `t:${t.id}`, sx: q.x, sy: q.y, title: `${t.name} — tender`, text: `Buys fish, sells fuel${t.channel ? ` · VHF ${t.channel}` : ''}`, travel: tgt ?? null });
    }
    for (const b of ctx.systems.fleet?.boats ?? []) {
      if (!b?.position || b.kind === 'skiff' || b.type === 'skiff') continue;
      const q = view.toScreen(b.position.x, b.position.z);
      if (q.x < -10 || q.y < -10 || q.x > view.width + 10 || q.y > view.height + 10) continue;
      hull(g, q.x, q.y, b.heading ?? 0, 'rgba(70, 82, 88, 0.75)', 5.5);
      if (view.zoom > 2.5 && b.name) liveLabel(g, [{ text: b.name, font: "italic 10px 'Iowan Old Style', Georgia, serif", size: 10, color: 'rgba(44, 51, 54, 0.8)' }], q.x, q.y, taken);
    }

    // Harbours you can travel to (hit targets on their docks).
    for (const tg of travelTargets()) {
      if (tg.kind !== 'place') continue;
      const q = view.toScreen(tg.x, tg.z);
      if (explore() && !(tg.services?.length)) {
        // Free Explore: every place is a teleport target; non-harbours get a small ring instead of an anchor.
        if (q.x < -10 || q.y < -10 || q.x > view.width + 10 || q.y > view.height + 10) continue;
        g.strokeStyle = 'rgba(44, 51, 54, 0.7)';
        g.lineWidth = 1.2;
        g.beginPath();
        g.arc(q.x, q.y, 2.6, 0, Math.PI * 2);
        g.stroke();
        hitList.push({ key: `p:${tg.placeId}`, sx: q.x, sy: q.y, title: tg.name, text: [tg.placeKind, tg.districtName].filter(Boolean).join(' · '), travel: tg });
        continue;
      }
      g.save();
      g.translate(q.x, q.y);
      g.strokeStyle = 'rgba(44, 51, 54, 0.85)';
      g.lineWidth = 1.3;
      g.beginPath();
      g.arc(0, -3.2, 1.5, 0, Math.PI * 2);
      g.moveTo(0, -1.7);
      g.lineTo(0, 4.2);
      g.moveTo(-3, -0.4);
      g.lineTo(3, -0.4);
      g.moveTo(-3.8, 1.8);
      g.quadraticCurveTo(-3, 4.6, 0, 4.6);
      g.quadraticCurveTo(3, 4.6, 3.8, 1.8);
      g.stroke();
      g.restore();
      hitList.push({ key: `p:${tg.placeId}`, sx: q.x, sy: q.y, title: tg.name, text: (tg.services ?? []).map((x) => ({ sell: 'fish buyer', fuel: 'fuel', upgrades: 'boatyard', ice: 'ice', rest: 'rest' })[x] ?? x).join(' · '), travel: tg });
    }

    // Selected travel target ring.
    if (selected) {
      const q = view.toScreen(selected.x, selected.z);
      g.strokeStyle = BOAT;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(q.x, q.y, 11, 0, Math.PI * 2);
      g.stroke();
    }

    // Waypoint.
    const wp = getWaypoint();
    if (wp && bp) {
      const q = view.toScreen(wp.x, wp.z);
      const b = view.toScreen(bp.x, bp.z);
      g.save();
      g.strokeStyle = 'rgba(255, 122, 26, 0.85)';
      g.lineWidth = 1.5;
      g.setLineDash([2, 5]);
      g.beginPath();
      g.moveTo(b.x, b.y);
      g.lineTo(q.x, q.y);
      g.stroke();
      g.setLineDash([]);
      g.translate(q.x, q.y);
      g.fillStyle = BOAT;
      g.strokeStyle = '#fff';
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(0, -8);
      g.lineTo(6, 0);
      g.lineTo(0, 8);
      g.lineTo(-6, 0);
      g.closePath();
      g.fill();
      g.stroke();
      g.beginPath();
      g.arc(0, 0, 13, 0, Math.PI * 2);
      g.strokeStyle = 'rgba(255, 122, 26, 0.6)';
      g.stroke();
      const bd = bearingDistance(bp.x, bp.z, wp.x, wp.z);
      g.font = "600 11px -apple-system, 'Segoe UI', sans-serif";
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      g.lineJoin = 'round';
      g.strokeStyle = 'rgba(244, 236, 214, 0.95)';
      g.lineWidth = 3;
      const txt = `${nmLabel(bd.distance, ctx.geo)} · ${String(bd.bearingDeg).padStart(3, '0')}°`;
      g.strokeText(txt, 16, 0);
      g.fillStyle = '#b3490c';
      g.fillText(txt, 16, 0);
      g.restore();
    }

    // Own boat (and the person ashore).
    if (bp) {
      const q = view.toScreen(bp.x, bp.z);
      const hd = s.heading ?? 0;
      g.save();
      g.strokeStyle = 'rgba(255, 122, 26, 0.55)';
      g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(q.x, q.y);
      g.lineTo(q.x + Math.sin(hd) * 38, q.y - Math.cos(hd) * 38);
      g.stroke();
      g.restore();
      hull(g, q.x, q.y, hd, BOAT, 10, '#fff');
      if (ctx.state.control === 'foot' && av) {
        const a = view.toScreen(av.x, av.z);
        g.fillStyle = BOAT;
        g.strokeStyle = '#fff';
        g.lineWidth = 1.5;
        g.beginPath();
        g.arc(a.x, a.y, 4, 0, Math.PI * 2);
        g.fill();
        g.stroke();
      }
    }
  }

  // A note icon that would sit on a charted name is tucked just past the end of that name.
  function clearOfLabels(p, r) {
    for (const q of labelRects) {
      if (p.x + r > q.x && p.x - r < q.x + q.w && p.y + r > q.y && p.y - r < q.y + q.h) return { x: q.x + q.w + r + 3, y: q.y + q.h / 2 };
    }
    return p;
  }

  function hull(g, x, y, heading, fill, len, stroke = 'rgba(244, 236, 214, 0.9)') {
    g.save();
    g.translate(x, y);
    g.rotate(heading);
    g.beginPath();
    g.moveTo(0, -len);
    g.quadraticCurveTo(len * 0.45, -len * 0.3, len * 0.4, len * 0.75);
    g.lineTo(-len * 0.4, len * 0.75);
    g.quadraticCurveTo(-len * 0.45, -len * 0.3, 0, -len);
    g.closePath();
    g.fillStyle = fill;
    g.fill();
    g.strokeStyle = stroke;
    g.lineWidth = 1.3;
    g.stroke();
    g.restore();
  }

  const cur = { x: 0, z: 0 };
  function drawCurrents(g, bp) {
    const tide = ctx.tide;
    if (!tide?.currentAt) return;
    const c = view.toScreen(bp.x, bp.z);
    const spacing = 34;
    const R = 170;
    g.save();
    g.strokeStyle = 'rgba(47, 93, 120, 0.55)';
    g.fillStyle = 'rgba(47, 93, 120, 0.55)';
    g.lineWidth = 1.1;
    for (let py = c.y - R; py <= c.y + R; py += spacing) {
      for (let px = c.x - R; px <= c.x + R; px += spacing) {
        const dd = Math.hypot(px - c.x, py - c.y);
        if (dd > R || dd < 16) continue;
        const w = view.toWorld(px, py);
        if (!ctx.heightmap.isWater(w.x, w.z)) continue;
        tide.currentAt(w.x, w.z, cur);
        const sp = Math.hypot(cur.x, cur.z);
        if (sp < 0.03) continue;
        const L = Math.min(14, 4 + sp * 22);
        const ux = cur.x / sp;
        const uz = cur.z / sp;
        g.globalAlpha = Math.max(0.15, 1 - dd / R);
        g.beginPath();
        g.moveTo(px - ux * L * 0.5, py - uz * L * 0.5);
        g.lineTo(px + ux * L * 0.5, py + uz * L * 0.5);
        g.stroke();
        g.beginPath();
        g.moveTo(px + ux * L * 0.5, py + uz * L * 0.5);
        g.lineTo(px + ux * L * 0.5 - ux * 3.5 + uz * 2.4, py + uz * L * 0.5 - uz * 3.5 - ux * 2.4);
        g.lineTo(px + ux * L * 0.5 - ux * 3.5 - uz * 2.4, py + uz * L * 0.5 - uz * 3.5 + ux * 2.4);
        g.closePath();
        g.fill();
      }
    }
    g.restore();
  }

  // ---------------------------------------------------------------- side panel
  let targetsCache = null;
  let targetsAt = -1;
  function travelTargets() {
    const now = performance.now();
    if (!targetsCache || now - targetsAt > 1000) {
      targetsAt = now;
      try {
        const tr = ctx.systems.season?.travel;
        targetsCache = (explore() ? tr?.teleportTargets?.() : tr?.targets?.()) ?? fallbackTargets();
      } catch {
        targetsCache = fallbackTargets();
      }
    }
    return targetsCache;
  }
  function fallbackTargets() {
    const out = [];
    for (const t of ctx.systems.fleet?.tenders ?? []) if (t?.position) out.push({ id: `tender:${t.id}`, kind: 'tender', tenderId: t.id, name: t.name, x: t.position.x, z: t.position.z, services: t.services ?? [] });
    return out;
  }

  function select(t) {
    selected = t;
    selectedPreview = null;
    if (explore()) {
      selectedPreview = ctx.systems.season.travel.canTeleport?.() ?? { ok: true };
      dirtyLive = true;
      renderSide();
      return;
    }
    try {
      selectedPreview = ctx.systems.season?.travel?.preview?.(t) ?? null;
    } catch (err) {
      console.warn('[ui] travel preview failed', err?.message ?? err);
      selectedPreview = null;
    }
    dirtyLive = true;
    renderSide();
  }

  function renderPreview() {
    clear(preview);
    toggle(preview, 'hidden', !selected);
    if (!selected) return;
    const p = selectedPreview;
    if (explore()) {
      renderTeleportPreview(p);
      return;
    }
    const hasTravel = !!ctx.systems.season?.travel?.go;
    preview.append(h('div.mp-name', { text: `Run to ${selected.name}` }));
    if (!p) {
      preview.append(h('p.mp-reason', { text: hasTravel ? 'No route preview available.' : 'Fast travel is not available.' }));
    } else {
      preview.append(
        h('div.mp-grid', null, [
          kv('Distance', `${p.nm ?? '—'} nm`),
          kv('Running time', p.duration ?? '—'),
          kv('Cruising', p.knots ? `${p.knots} kn` : '—'),
          kv('Fuel', ctx.state.freeExplore ? 'no charge' : `${int(p.gallons ?? 0)} gal · ${money(p.fuelCost ?? 0)}`),
          kv('Arrive', p.arrive?.label ?? '—', 'wide'),
        ]),
      );
      for (const w of p.warnings ?? []) preview.append(h('p.mp-warn', { text: w }));
      if (!p.ok && p.reason) preview.append(h('p.mp-reason', { text: p.reason }));
    }
    const go = button('Make the run', () => {
      let r = null;
      try {
        r = ctx.systems.season?.travel?.go?.(selected);
      } catch (err) {
        console.warn('[ui] travel failed', err?.message ?? err);
      }
      if (r?.ok) {
        selected = null;
        selectedPreview = null;
        close();
      } else if (r?.reason) ctx.systems.ui?.toast?.(r.reason, { kind: 'warn' });
    }, { cls: 'primary', disabled: !p?.ok });
    preview.append(h('div.mp-actions', null, [button('Cancel', () => {
      selected = null;
      selectedPreview = null;
      dirtyLive = true;
      renderSide();
    }), go]));
  }

  function renderTeleportPreview(p) {
    preview.append(h('div.mp-name', { text: selected.point ? 'Teleport here' : `Teleport to ${selected.name}` }));
    preview.append(h('p.mp-sub', { text: selected.point ? `${selected.name} — nearest open water to the click` : [selected.districtName, selected.placeKind && selected.placeKind[0].toUpperCase() + selected.placeKind.slice(1)].filter(Boolean).join(' · ') }));
    if (p && !p.ok && p.reason) preview.append(h('p.mp-reason', { text: p.reason }));
    const go = button('Teleport', () => {
      const r = ctx.systems.season?.travel?.teleport?.(selected.point ? { x: selected.x, z: selected.z, name: selected.name } : selected);
      if (r?.ok) {
        selected = null;
        selectedPreview = null;
        close();
      } else if (r?.reason) ctx.systems.ui?.toast?.(r.reason, { kind: 'warn' });
    }, { cls: 'primary', disabled: p ? !p.ok : false });
    preview.append(h('div.mp-actions', null, [button('Cancel', () => {
      selected = null;
      selectedPreview = null;
      dirtyLive = true;
      renderSide();
    }), go]));
  }

  function kv(k, v, cls = '') {
    return h(`div.mp-kv${cls ? `.${cls}` : ''}`, null, [h('span.mp-k', { text: k }), h('span.mp-v', { text: v })]);
  }

  function renderSide() {
    const s = ctx.systems.seiner;
    const p = ctx.game?.avatar?.() ?? s?.position;
    if (p) {
      const ll = ctx.geo.toLatLon(p.x, p.z);
      setText(posEl, latLonLabel(ll.lat, ll.lon));
      const season = ctx.systems.season;
      let dist = '';
      try {
        dist = season?.districtName?.(season?.districtAt?.(p.x, p.z)) ?? ctx.systems.places?.districtAt?.(p.x, p.z) ?? '';
      } catch {
        dist = '';
      }
      const near = ctx.systems.places?.nearest?.(p.x, p.z, (q) => !q.memorial && (q.id === 'kodiak' || ctx.systems.discovery?.isDiscovered?.(q.id)));
      setText(posSub, [dist, near && near.distance < 3000 ? `near ${near.place.name}` : null].filter(Boolean).join(' · '));
      let st = null;
      try {
        st = season?.openerStatus?.(p.x, p.z);
      } catch {
        st = null;
      }
      setText(openEl, st?.label ?? '');
      toggle(openEl, 'open', !!st?.open);
    }
    const t = tideLabel(ctx.tide?.state?.());
    setText(tideEl, t.text);
    drawTide();

    clear(wpBox);
    const wp = getWaypoint();
    if (wp && s?.position) {
      const bd = bearingDistance(s.position.x, s.position.z, wp.x, wp.z);
      wpBox.append(h('div.ms-wp-row', null, [h('span.ms-wp-v', { text: `${nmLabel(bd.distance, ctx.geo)} · ${String(bd.bearingDeg).padStart(3, '0')}° ${cardinal(bd.bearingDeg, 16)}` }), button('Clear', () => {
        setWaypoint(null);
        dirtyLive = true;
        renderSide();
      }, { cls: 'small' })]));
    } else wpBox.append(h('p.ms-muted', { text: 'Click the chart to drop a waypoint. It shows on the compass.' }));

    clear(travelList);
    setText(travelHead, explore() ? 'Teleport' : 'Fast travel');
    const can = explore()
      ? ctx.systems.season.travel.canTeleport?.() ?? { ok: true }
      : ctx.systems.season?.travel?.canTravel?.() ?? { ok: false, reason: 'Fast travel is not available' };
    setText(travelNote, can.ok ? (explore() ? 'Free Explore: click any place or open water to jump there instantly.' : 'Pay in time and fuel to run to a harbor or tender.') : can.reason ?? '');
    if (explore() && openTeleport) travelList.append(button('Where to? — all places', () => openTeleport(), { cls: 'small ms-where' }));
    toggle(travelNote, 'warn', !can.ok);
    const bp = s?.position ?? { x: 0, z: 0 };
    const list = travelTargets()
      .map((tg) => ({ tg, d: Math.hypot(tg.x - bp.x, tg.z - bp.z) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, explore() ? 10 : Infinity);
    for (const { tg, d } of list) {
      const b = h(`button.ms-dest${selected?.id === tg.id ? '.on' : ''}`, { type: 'button' }, [
        svgFrom(tg.kind === 'tender' ? GLYPHS.tender : GLYPHS.anchor),
        h('span.ms-dest-name', { text: tg.name }),
        h('span.ms-dest-d', { text: nmLabel(d, ctx.geo) }),
      ]);
      b.disabled = !can.ok;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        select(tg);
        const q = view.toScreen(tg.x, tg.z);
        if (q.x < 40 || q.y < 40 || q.x > view.width - 40 || q.y > view.height - 40) {
          view.centerOn((tg.x + bp.x) / 2, (tg.z + bp.z) / 2, view.scale);
          dirtyBase = dirtyLive = true;
        }
      });
      travelList.append(b);
    }
    renderPreview();
  }

  function drawTide() {
    const g = tideCanvas.getContext('2d');
    const W = tideCanvas.width;
    const H = tideCanvas.height;
    g.clearRect(0, 0, W, H);
    const tide = ctx.tide;
    if (!tide?.state) return;
    const now = ctx.clock.day * 24 + ctx.clock.hours;
    const span = 14;
    g.strokeStyle = 'rgba(244, 240, 230, 0.12)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, H / 2);
    g.lineTo(W, H / 2);
    g.stroke();
    g.beginPath();
    for (let i = 0; i <= 120; i++) {
      const t = now - 3 + (i / 120) * span;
      const s = tide.state(t);
      const x = (i / 120) * W;
      const y = H / 2 - s.height * (H * 0.36);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.strokeStyle = 'rgba(120, 200, 220, 0.85)';
    g.lineWidth = 3;
    g.stroke();
    const nx = (3 / span) * W;
    const ns = tide.state(now);
    g.fillStyle = BOAT;
    g.beginPath();
    g.arc(nx, H / 2 - ns.height * (H * 0.36), 7, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(244, 240, 230, 0.55)';
    g.font = '20px -apple-system, sans-serif';
    g.textAlign = 'left';
    g.fillText('now', nx + 12, H - 10);
    g.textAlign = 'right';
    g.fillText('+11 h', W - 4, H - 10);
  }

  function legendRow(cls, text) {
    return h('div.lg-row', null, [h(`span.lg-sw.${cls}`), h('span', { text })]);
  }
  function hintItem(k, text) {
    return h('span.mh', null, [h('span.keycap.tiny', { text: k }), h('span', { text })]);
  }

  const api = {
    id: 'map',
    el,
    schedule,
    show() {
      isOpen = true;
      targetsCache = null;
      requestAnimationFrame(() => {
        resize();
        const p = ctx.game?.avatar?.() ?? ctx.systems.seiner?.position;
        if (p) view.centerOn(p.x, p.z, lastView ? view.scale : view.minScale * 1.9);
        lastView = 'set';
        dirtyBase = dirtyLive = true;
        renderSide();
      });
    },
    hide() {
      isOpen = false;
      showTip(null);
    },
    // Called every frame while open.
    tick(realDt) {
      if (!isOpen || !sized) return;
      liveT += realDt;
      if (dirtyBase) {
        dirtyBase = false;
        drawBase();
        dirtyLive = true;
      }
      if (dirtyLive || liveT > 0.1) {
        liveT = 0;
        dirtyLive = false;
        drawLive();
      }
    },
    onResize() {
      if (isOpen) resize();
    },
    refreshSide() {
      if (isOpen) renderSide();
    },
    invalidate() {
      dirtyBase = dirtyLive = true;
    },
    get rasterReady() {
      return !!raster;
    },
  };
  return api;
}
