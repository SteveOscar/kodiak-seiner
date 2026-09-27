// The in-game HUD: date/time, opener status and tide (top-left); cash, hold and fuel (top-right); the compass strip
// with waypoint, tender, harbour and sighting markers (top-centre); sonar (bottom-left); speed and heading
// (bottom-right); interaction prompts (bottom-centre, every frame) and the fishing set widgets above them.
// Everything except prompts updates at <= 10 Hz; motion between updates is CSS-interpolated.

import { h, setText, setStyle, toggle, clear, keycap, svgFrom } from './dom.js';
import { createSonar } from './sonar.js';
import { createSetPanel } from './setPanel.js';
import { compassLayout, bearingDistance, holdSegments, fuelLevel, tideLabel, keyLabel } from './lib/logic.js';
import { money, int, clockTime, calendar, headingDeg, cardinal, nmLabel } from './lib/format.js';
import { GLYPHS } from './lib/art.js';

const HALF_SPAN = 68; // degrees either side of the heading on the compass strip
const STRIP_W = 440; // CSS px
const PX_PER_DEG = STRIP_W / (2 * HALF_SPAN);
const MARKER_POOL = 12;

export function createHud(ctx, root) {
  const el = h('div.ui-hud');
  root.append(el);

  // ---------------------------------------------------------------- top-left: time, opener, tide
  const timeEl = h('span.st-time');
  const dateEl = h('span.st-date');
  const skyGlyph = h('span.st-sky');
  const openDot = h('span.st-dot');
  const openEl = h('span.st-open-text');
  const tideArrow = h('span.st-tide-arrow');
  const tideEl = h('span.st-tide-text');
  const whereEl = h('div.st-where');
  const status = h('div.hud-status.hud-panel', null, [
    h('div.st-row.st-clock', null, [timeEl, dateEl, skyGlyph]),
    h('div.st-row.st-open', null, [openDot, openEl]),
    h('div.st-row.st-tide', null, [tideArrow, tideEl]),
    h('div.st-row.st-foot', null, [whereEl]),
  ]);

  // ---------------------------------------------------------------- top-right: cash, hold, fuel
  const cashEl = h('span.pu-cash');
  const advanceTag = h('span.pu-advance', { text: 'Advance' });
  const holdTrack = h('div.pu-track.pu-hold-track');
  const holdVal = h('span.pu-val');
  const fuelFill = h('div.pu-fuel-fill');
  const fuelVal = h('span.pu-val');
  const purse = h('div.hud-purse.hud-panel', null, [
    h('div.pu-cash-row', null, [advanceTag, cashEl]),
    h('div.pu-row', null, [h('span.pu-label', { text: 'Hold' }), holdTrack, holdVal]),
    h('div.pu-row.pu-fuel', null, [h('span.pu-label', { text: 'Fuel' }), h('div.pu-track', null, [fuelFill]), fuelVal]),
  ]);
  const holdSegs = [];

  // ---------------------------------------------------------------- top-centre: compass strip
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const stripCanvas = h('canvas.cp-strip', { width: Math.round(720 * PX_PER_DEG * dpr), height: Math.round(30 * dpr) });
  stripCanvas.style.width = `${720 * PX_PER_DEG}px`;
  drawStrip(stripCanvas, dpr);
  const cpHeading = h('span.cp-hdg');
  const cpCard = h('span.cp-card');
  const markerLayer = h('div.cp-markers');
  const pool = [];
  for (let i = 0; i < MARKER_POOL; i++) {
    const icon = h('span.cp-icon');
    const label = h('span.cp-label');
    const m = h('div.cp-marker.hidden', null, [icon, label]);
    markerLayer.append(m);
    pool.push({ el: m, icon, label, kind: null, offset: null });
  }
  const compass = h('div.hud-compass', null, [
    h('div.cp-window', null, [stripCanvas]),
    markerLayer,
    h('div.cp-notch'),
    h('div.cp-readout', null, [cpHeading, cpCard]),
  ]);
  let stripHeading = null;

  // ---------------------------------------------------------------- bottom-right: helm
  const spdEl = h('span.helm-speed');
  const hdgEl = h('span.helm-hdg');
  const throttleFill = h('div.helm-thr-fill');
  const rudderDot = h('div.helm-rud-dot');
  const helmState = h('div.helm-state');
  const camEl = h('span.helm-cam');
  const helm = h('div.hud-helm.hud-panel', null, [
    h('div.helm-main', null, [
      h('div.helm-thr', null, [h('div.helm-thr-track', null, [h('div.helm-thr-zero'), throttleFill])]),
      h('div.helm-read', null, [
        h('div.helm-speed-row', null, [spdEl, h('span.helm-unit', { text: 'kn' })]),
        h('div.helm-hdg-row', null, [hdgEl]),
      ]),
    ]),
    h('div.helm-rud', null, [h('div.helm-rud-track', null, [h('div.helm-rud-mid'), rudderDot])]),
    h('div.helm-foot', null, [helmState, camEl]),
  ]);

  // ---------------------------------------------------------------- bottom-left: sonar
  const sonar = createSonar(ctx);

  // ---------------------------------------------------------------- bottom-centre: prompts + set widgets
  const setPanel = createSetPanel(ctx);
  const promptBox = h('div.hud-prompts');
  const bottom = h('div.hud-bottom', null, [setPanel.el, promptBox]);

  el.append(status, compass, purse, sonar.el, helm, bottom);

  let promptKey = '';
  const promptRings = [];

  // ---------------------------------------------------------------- helpers
  function drawStrip(canvas, scale) {
    const g = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    g.clearRect(0, 0, W, H);
    g.scale(scale, scale);
    const toX = (deg) => (deg + 180) * PX_PER_DEG;
    for (let d = -180; d <= 540; d += 5) {
      const x = Math.round(toX(d)) + 0.5;
      const norm = ((d % 360) + 360) % 360;
      const major = norm % 45 === 0;
      const mid = norm % 15 === 0;
      g.strokeStyle = major ? 'rgba(244, 240, 230, 0.9)' : mid ? 'rgba(244, 240, 230, 0.55)' : 'rgba(244, 240, 230, 0.28)';
      g.lineWidth = major ? 1.5 : 1;
      g.beginPath();
      g.moveTo(x, 30);
      g.lineTo(x, major ? 19 : mid ? 23 : 26);
      g.stroke();
      if (major) {
        const lab = cardinal(norm, 8);
        g.font = norm % 90 === 0 ? "600 13px 'Iowan Old Style', 'Palatino Linotype', Georgia, serif" : "500 10.5px -apple-system, 'Segoe UI', sans-serif";
        g.fillStyle = norm === 0 ? '#ff8a33' : 'rgba(244, 240, 230, 0.95)';
        g.textAlign = 'center';
        g.textBaseline = 'alphabetic';
        g.fillText(lab, x, 15);
      } else if (mid) {
        g.font = "500 9px 'SF Mono', ui-monospace, Menlo, monospace";
        g.fillStyle = 'rgba(244, 240, 230, 0.5)';
        g.textAlign = 'center';
        g.fillText(String(norm), x, 15);
      }
    }
  }

  function placeStrip(hd) {
    // hd in [0, 360); the strip image spans [-180, 540).
    const x = STRIP_W / 2 - (hd + 180) * PX_PER_DEG;
    const wrapped = stripHeading !== null && Math.abs(hd - stripHeading) > 180;
    stripHeading = hd;
    if (wrapped) {
      stripCanvas.style.transition = 'none';
      stripCanvas.style.transform = `translate3d(${x.toFixed(1)}px,0,0)`;
      stripCanvas.__snap = true;
    } else {
      if (stripCanvas.__snap) {
        stripCanvas.style.transition = '';
        stripCanvas.__snap = false;
      }
      setStyle(stripCanvas, 'transform', `translate3d(${x.toFixed(1)}px,0,0)`);
    }
  }

  const GLYPH_OF = { waypoint: 'pin', tender: 'tender', harbor: 'anchor', sighting: 'fish' };

  function compassMarkers(p) {
    const out = [];
    const ui = ctx.systems.ui;
    const wp = ui?.waypoint;
    if (wp && Number.isFinite(wp.x)) {
      const bd = bearingDistance(p.x, p.z, wp.x, wp.z);
      out.push({ id: 'wp', kind: 'waypoint', ...bd, label: nmLabel(bd.distance, ctx.geo), prio: 3 });
    }
    const tenders = ctx.systems.fleet?.tenders ?? [];
    let nearest = null;
    for (const t of tenders) {
      if (!t?.position) continue;
      const bd = bearingDistance(p.x, p.z, t.position.x, t.position.z);
      if (bd.distance > 6000) continue;
      const m = { id: `t:${t.id}`, kind: 'tender', ...bd, label: '', name: t.name, prio: 2 };
      out.push(m);
      if (!nearest || bd.distance < nearest.distance) nearest = m;
    }
    if (nearest) nearest.label = `${nearest.name} · ${nmLabel(nearest.distance, ctx.geo)}`;
    const disc = ctx.systems.discovery;
    const places = ctx.systems.places;
    const harbor = places?.nearest?.(p.x, p.z, (q) => (q.services?.length ?? 0) > 0 && !q.memorial && (!disc?.isDiscovered || disc.isDiscovered(q.id)));
    if (harbor && harbor.distance < 7000 && harbor.distance > 150) {
      const hp = harbor.place.dock ?? harbor.place;
      const bd = bearingDistance(p.x, p.z, hp.x, hp.z);
      out.push({ id: `h:${harbor.place.id}`, kind: 'harbor', ...bd, label: `${harbor.place.name}`, prio: 1 });
    }
    let fish = [];
    try {
      fish = disc?.recentSightings?.() ?? [];
    } catch {
      fish = [];
    }
    let n = 0;
    for (const s of fish) {
      if (!Number.isFinite(s?.x) || n >= 5) continue;
      const bd = bearingDistance(p.x, p.z, s.x, s.z);
      if (bd.distance > 5000) continue;
      out.push({ id: `s:${s.schoolId ?? n}:${Math.round(s.x)}`, kind: 'sighting', ...bd, label: '', age: s.age ?? 0, prio: 0 });
      n++;
    }
    return out.slice(0, MARKER_POOL);
  }

  function updateCompass(p, heading) {
    const hd = headingDeg(heading);
    placeStrip(hd);
    setText(cpHeading, `${String(hd).padStart(3, '0')}°`);
    setText(cpCard, cardinal(hd, 16));
    const laid = compassLayout(heading, compassMarkers(p), HALF_SPAN - 2);
    // One label per neighbourhood: the highest-priority marker keeps its label, close neighbours go quiet.
    const labelled = [];
    for (const m of [...laid].sort((a, b) => b.prio - a.prio)) {
      if (!m.label || m.edge) continue;
      const x = m.offsetDeg * PX_PER_DEG;
      if (labelled.some((q) => Math.abs(q - x) < 78)) m.label = '';
      else labelled.push(x);
    }
    for (let i = 0; i < pool.length; i++) {
      const slot = pool[i];
      const m = laid[i];
      if (!m) {
        toggle(slot.el, 'hidden', true);
        slot.offset = null;
        continue;
      }
      toggle(slot.el, 'hidden', false);
      if (slot.kind !== m.kind) {
        slot.kind = m.kind;
        slot.el.className = `cp-marker cp-${m.kind}`;
        clear(slot.icon);
        slot.icon.append(svgFrom(GLYPHS[GLYPH_OF[m.kind]]));
        slot.offset = null;
      }
      toggle(slot.el, 'edge-left', m.edge < 0);
      toggle(slot.el, 'edge-right', m.edge > 0);
      setText(slot.label, m.label);
      const x = m.offsetDeg * PX_PER_DEG;
      const jump = slot.offset !== null && Math.abs(m.offsetDeg - slot.offset) > 60;
      slot.offset = m.offsetDeg;
      if (jump) {
        slot.el.style.transition = 'none';
        slot.el.__snap = true;
      } else if (slot.el.__snap) {
        slot.el.style.transition = '';
        slot.el.__snap = false;
      }
      setStyle(slot.el, 'transform', `translate3d(${x.toFixed(1)}px,0,0)`);
      if (m.kind === 'sighting') setStyle(slot.el, 'opacity', (1 - 0.75 * (m.age ?? 0)).toFixed(2));
      else setStyle(slot.el, 'opacity', '1');
    }
  }

  function updateStatus(p) {
    const clock = ctx.clock;
    const cal = calendar(clock.day, ctx.config.time.seasonStart);
    setText(timeEl, clockTime(clock.hours));
    setText(dateEl, `${cal.weekdayShort} ${cal.label}`);
    const night = !!ctx.systems.sky?.isNight;
    if (skyGlyph.__night !== night) {
      skyGlyph.__night = night;
      clear(skyGlyph);
      skyGlyph.append(svgFrom(night ? GLYPHS.moon : GLYPHS.sun));
    }
    const season = ctx.systems.season;
    let st = null;
    try {
      st = season?.openerStatus?.(p.x, p.z) ?? null;
    } catch {
      st = null;
    }
    if (!st) {
      const open = ctx.state.freeExplore || !!season?.openerActive?.(p.x, p.z);
      let label = open ? 'Fishing open' : 'Closed';
      if (!open) {
        const n = season?.nextOpener?.(p.x, p.z);
        if (n) label = `Closed · opens ${calendar(n.day, ctx.config.time.seasonStart).label} ${clockTime(n.hours ?? 6)}`;
      }
      st = { open, label };
    }
    setText(openEl, st.label.replace(/^Open ·/, 'Fishing open ·'));
    toggle(status, 'is-open', !!st.open);
    const tide = tideLabel(ctx.tide?.state?.());
    setText(tideArrow, tide.arrow);
    setText(tideEl, tide.text);
    toggle(status, `tide-flood`, tide.stage === 'flood');
    toggle(status, `tide-ebb`, tide.stage === 'ebb');
    let where = '';
    try {
      const id = season?.districtAt?.(p.x, p.z);
      where = (id && season?.districtName?.(id)) || ctx.systems.places?.districtAt?.(p.x, p.z) || '';
    } catch {
      where = '';
    }
    setText(whereEl, where);
  }

  function updatePurse() {
    const eco = ctx.systems.economy;
    if (!eco) return;
    const cash = Number(eco.cash) || 0;
    setText(cashEl, money(cash));
    toggle(purse, 'in-debt', cash < 0);
    const table = ctx.config.fish.species;
    const cap = Number(eco.capacityLbs) || ctx.config.economy.holdCapacityLbs;
    const segs = holdSegments(eco.hold, cap, table);
    while (holdSegs.length < segs.length) {
      const s = h('div.pu-seg');
      holdTrack.append(s);
      holdSegs.push(s);
    }
    let x = 0;
    for (let i = 0; i < holdSegs.length; i++) {
      const s = segs[i];
      const node = holdSegs[i];
      toggle(node, 'hidden', !s);
      if (!s) continue;
      setStyle(node, 'left', `${(x * 100).toFixed(2)}%`);
      setStyle(node, 'width', `${(s.frac * 100).toFixed(2)}%`);
      setStyle(node, 'background', s.color);
      x += s.frac;
    }
    const lbs = typeof eco.holdLbs === 'function' ? eco.holdLbs() : 0;
    setText(holdVal, `${int(lbs)} / ${int(cap)} lb`);
    toggle(purse, 'hold-full', lbs >= cap * 0.995 && lbs > 0);
    const f = fuelLevel(eco.fuel, eco.fuelCapacity);
    setStyle(fuelFill, 'transform', `scaleX(${f.frac.toFixed(3)})`);
    setText(fuelVal, `${int(eco.fuel)} gal`);
    toggle(purse, 'fuel-warn', f.tone === 'warn');
    toggle(purse, 'fuel-danger', f.tone === 'danger');
    toggle(purse, 'explore', !!ctx.state.freeExplore);
  }

  function updateHelm() {
    const s = ctx.systems.seiner;
    if (!s) return;
    const onFoot = ctx.state.control === 'foot';
    const kn = ctx.geo?.toKnots ? ctx.geo.toKnots(Math.abs(s.speed ?? 0)) : Math.abs(s.speed ?? 0) * 0.92;
    setText(spdEl, kn.toFixed(1));
    const hd = headingDeg(s.heading ?? 0);
    setText(hdgEl, `${String(hd).padStart(3, '0')}° ${cardinal(hd, 16)}`);
    const thr = Math.max(-1, Math.min(1, Number(s.throttle) || 0));
    setStyle(throttleFill, 'transform', `scaleY(${Math.abs(thr).toFixed(3)})`);
    toggle(throttleFill, 'astern', thr < 0);
    const rud = Math.max(-1, Math.min(1, Number(s.rudder) || 0));
    setStyle(rudderDot, 'transform', `translate3d(calc(${(rud * 26).toFixed(1)} * var(--u)),0,0)`);
    let state = '';
    const m = s.mooring;
    if (s.grounded) state = 'Aground!';
    else if (m?.kind === 'dock') state = `Tied up · ${ctx.systems.places?.get?.(m.placeId)?.name ?? 'harbour'}`;
    else if (m?.kind === 'anchor') state = 'At anchor';
    else if (ctx.systems.economy?.fuelEmpty && !ctx.state.freeExplore) state = 'Out of fuel';
    else if (s.speedLimit !== null && s.speedLimit !== undefined && s.speedLimit < (s.maxSpeed ?? 12) - 0.1) state = `Limited · ${ctx.geo?.toKnots ? ctx.geo.toKnots(s.speedLimit).toFixed(1) : s.speedLimit} kn`;
    setText(helmState, onFoot ? 'On foot' : state);
    toggle(helmState, 'warn', !!s.grounded || (!!ctx.systems.economy?.fuelEmpty && !ctx.state.freeExplore));
    const cam = ctx.systems.cameraRig?.mode;
    const camName = { chase: 'Chase cam', crowsnest: 'Crow’s nest', bridge: 'Bridge', foot: 'Follow cam' }[cam] ?? '';
    setText(camEl, camName);
  }

  const HOLD_PROGRESS = { 'fishing-purse': 'pursed', 'fishing-haul': 'hauled' };

  function updatePrompts() {
    const cur = ctx.interact?.current ?? {};
    const entries = [];
    for (const key of ['action', 'interact']) if (cur[key]?.label) entries.push([key, cur[key]]);
    for (const [key, o] of Object.entries(cur)) if (key !== 'action' && key !== 'interact' && o?.label) entries.push([key, o]);
    const sig = entries.map(([k, o]) => `${k}|${o.id}|${o.label}|${o.hold ? 1 : 0}`).join('/');
    if (sig !== promptKey) {
      promptKey = sig;
      clear(promptBox);
      promptRings.length = 0;
      for (const [key, o] of entries) {
        const binding = ctx.input?.bindings?.[key]?.[0] ?? key;
        const cap = keycap(keyLabel(binding), key === 'action' ? 'wide' : '');
        let ring = null;
        if (o.hold) {
          ring = h('span.prompt-ring');
          cap.append(ring);
        }
        const p = h(`div.prompt${o.hold ? '.hold' : ''}`, null, [cap, h('span.prompt-label', { text: o.label })]);
        if (o.hold) p.append(h('span.prompt-hold', { text: 'hold' }));
        promptBox.append(p);
        promptRings.push({ key, id: o.id, ring, el: p });
        requestAnimationFrame(() => p.classList.add('in'));
      }
    }
    const hud = ctx.systems.fishing?.hud;
    for (const r of promptRings) {
      const held = !!ctx.input?.action?.(r.key);
      toggle(r.el, 'held', held);
      if (r.ring) {
        const field = HOLD_PROGRESS[r.id];
        const v = field ? Math.max(0, Math.min(1, Number(hud?.[field]) || 0)) : held ? 1 : 0;
        const q = Math.round(v * 200) / 200;
        setStyle(r.ring, '--p', String(q));
      }
    }
  }

  const api = {
    el,
    sonar,
    setPanel,
    // Throttled refresh (<= 10 Hz).
    update(time) {
      const s = ctx.systems.seiner;
      const a = ctx.game?.avatar?.() ?? s?.position ?? { x: 0, z: 0, heading: 0 };
      const p = { x: a.x ?? 0, z: a.z ?? 0 };
      const onFoot = ctx.state.control === 'foot';
      toggle(el, 'on-foot', onFoot);
      updateStatus(p);
      updatePurse();
      updateCompass(p, onFoot ? ctx.camera ? cameraHeading(ctx.camera) : a.heading ?? 0 : s?.heading ?? 0);
      updateHelm();
      if (!onFoot) sonar.update(time);
      setPanel.update();
    },
    // Every frame (prompts only).
    frame() {
      updatePrompts();
    },
    resetPrompts() {
      promptKey = '';
      clear(promptBox);
      promptRings.length = 0;
    },
  };
  return api;
}

// Heading the camera looks toward (0 = north, clockwise), for the compass when on foot.
const _dir = { x: 0, y: 0, z: 0 };
function cameraHeading(camera) {
  const e = camera.matrixWorld.elements;
  _dir.x = -e[8];
  _dir.z = -e[10];
  return Math.atan2(_dir.x, -_dir.z);
}
