// Searchlight sonar / fish finder: a heading-up plan display of fish marks (fish.sonarReturns — marks and depth only,
// no species) and shore returns, redrawn at the HUD rate; the sweep is a CSS animation so it stays smooth for free.

import { h, setText } from './dom.js';
import { sonarProject } from './lib/logic.js';

const ANGLES = 96; // shore sampling: bearings around the boat
const STEPS = 30; // shore sampling: range steps per bearing
const SLICES = 3; // the ring is resampled a third at a time

// Echo colour scale, weak to strong (the classic searchlight-sonar palette).
const SCALE = [
  [0, [70, 170, 205]],
  [0.35, [92, 222, 150]],
  [0.62, [255, 214, 92]],
  [0.85, [255, 104, 64]],
];
function echoColor(s, a) {
  let i = 0;
  while (i < SCALE.length - 2 && s > SCALE[i + 1][0]) i++;
  const [s0, c0] = SCALE[i];
  const [s1, c1] = SCALE[i + 1];
  const t = Math.max(0, Math.min(1, (s - s0) / (s1 - s0)));
  const c = c0.map((v, k) => Math.round(v + (c1[k] - v) * t));
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a.toFixed(3)})`;
}

export function createSonar(ctx) {
  const size = 172;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const canvas = h('canvas.sonar-canvas', { width: Math.round(size * dpr), height: Math.round(size * dpr) });
  const g = canvas.getContext('2d');
  const rangeEl = h('span.sonar-range');
  const depthEl = h('span.sonar-depth-val');
  const marksEl = h('span.sonar-marks');
  const el = h('div.hud-sonar.hud-panel-round', null, [
    canvas,
    h('div.sonar-sweep'),
    h('div.sonar-glass'),
    h('div.sonar-label.sonar-label-top', null, [h('span.sonar-title', { text: 'SONAR' }), rangeEl]),
    h('div.sonar-label.sonar-label-bottom', null, [h('span.sonar-depth', null, [h('span.sonar-depth-cap', { text: 'DEPTH ' }), depthEl]), marksEl]),
  ]);

  // Per bearing: range fraction of the first drying shallows and of the first dry land (1 = nothing in range).
  const shoalAt = new Float32Array(ANGLES).fill(1);
  const landAt = new Float32Array(ANGLES).fill(1);
  let lastRange = 0;

  // The sonar cannot see past the shore: each bearing stops at the first land it meets. Bearings are world bearings
  // (0 = north) so the ring can be refreshed a slice at a time; the layer is drawn rotated to heading-up.
  function sampleLand(x, z, range, from, to) {
    const hm = ctx.heightmap;
    for (let a = from; a < to; a++) {
      const th = (a / ANGLES) * Math.PI * 2;
      const sx = Math.sin(th);
      const cz = -Math.cos(th);
      let shoal = 1;
      let land = 1;
      for (let r = 1; r <= STEPS; r++) {
        const f = r / STEPS;
        const d = f * range;
        const depth = hm?.depthAt ? hm.depthAt(x + sx * d, z + cz * d) : 50;
        if (shoal === 1 && depth < 3) shoal = f - 0.5 / STEPS;
        if (depth <= 0.3) {
          land = f - 0.5 / STEPS;
          break;
        }
      }
      shoalAt[a] = Math.min(shoal, land);
      landAt[a] = land;
    }
  }

  // Static face (screen, range rings, lubber line) and the shore-return layer are cached in offscreen canvases; the
  // shore layer is redrawn only when the heightmap is resampled.
  const W = canvas.width;
  const C = W / 2;
  const RR = C - 3 * dpr;
  const layer = () => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = W;
    return cv;
  };
  const face = layer();
  const shore = layer();
  {
    const f = face.getContext('2d');
    f.beginPath();
    f.arc(C, C, RR, 0, Math.PI * 2);
    f.clip();
    const bg = f.createRadialGradient(C, C, 0, C, C, RR);
    bg.addColorStop(0, 'rgba(10, 52, 60, 0.92)');
    bg.addColorStop(0.75, 'rgba(6, 30, 38, 0.92)');
    bg.addColorStop(1, 'rgba(3, 16, 22, 0.95)');
    f.fillStyle = bg;
    f.fillRect(0, 0, W, W);
    f.strokeStyle = 'rgba(140, 214, 206, 0.16)';
    f.lineWidth = dpr;
    for (const k of [1 / 3, 2 / 3]) {
      f.beginPath();
      f.arc(C, C, RR * k, 0, Math.PI * 2);
      f.stroke();
    }
    f.beginPath();
    f.moveTo(C, C - RR);
    f.lineTo(C, C + RR);
    f.moveTo(C - RR, C);
    f.lineTo(C + RR, C);
    f.stroke();
    // Bearing ticks every 30° around the rim.
    f.strokeStyle = 'rgba(160, 225, 215, 0.35)';
    for (let i = 0; i < 36; i++) {
      const t = (i / 36) * Math.PI * 2;
      const r0 = RR - (i % 3 === 0 ? 7 : 4) * dpr;
      f.beginPath();
      f.moveTo(C + Math.cos(t) * r0, C + Math.sin(t) * r0);
      f.lineTo(C + Math.cos(t) * RR, C + Math.sin(t) * RR);
      f.stroke();
    }
    f.strokeStyle = 'rgba(255, 170, 90, 0.4)';
    f.setLineDash([3 * dpr, 4 * dpr]);
    f.beginPath();
    f.moveTo(C, C);
    f.lineTo(C, C - RR);
    f.stroke();
  }

  // Shore returns: a smooth outline through the per-bearing ranges, drying shallows as a faint band, dry land beyond
  // with a bright echo line along the shore.
  function outline(s, radii, close) {
    for (let a = 0; a <= ANGLES; a++) {
      const i = a % ANGLES;
      const t = (i / ANGLES) * Math.PI * 2 - Math.PI / 2;
      const r = radii[i] * RR;
      const px = C + Math.cos(t) * r;
      const py = C + Math.sin(t) * r;
      if (a === 0) s.moveTo(px, py);
      else s.lineTo(px, py);
    }
    if (close) s.closePath();
  }
  function drawShore() {
    const s = shore.getContext('2d');
    s.clearRect(0, 0, W, W);
    let anyLand = false;
    let anyShoal = false;
    for (let a = 0; a < ANGLES; a++) {
      if (landAt[a] < 1) anyLand = true;
      if (shoalAt[a] < landAt[a]) anyShoal = true;
    }
    if (!anyLand && !anyShoal) return;
    s.save();
    s.beginPath();
    s.arc(C, C, RR, 0, Math.PI * 2);
    s.clip();
    // Everything outside the shallows outline, minus the open water inside it (even-odd).
    if (anyShoal) {
      s.beginPath();
      s.rect(0, 0, W, W);
      outline(s, shoalAt, true);
      s.fillStyle = 'rgba(214, 178, 92, 0.16)';
      s.fill('evenodd');
    }
    if (anyLand) {
      s.beginPath();
      s.rect(0, 0, W, W);
      outline(s, landAt, true);
      s.fillStyle = 'rgba(196, 160, 84, 0.42)';
      s.fill('evenodd');
      // The shore echo: stroke only the stretches where land lies inside the range.
      s.strokeStyle = 'rgba(255, 196, 96, 0.85)';
      s.lineWidth = 1.6 * dpr;
      s.lineJoin = 'round';
      s.beginPath();
      let pen = false;
      for (let a = 0; a <= ANGLES; a++) {
        const i = a % ANGLES;
        if (landAt[i] >= 1) {
          pen = false;
          continue;
        }
        const t = (i / ANGLES) * Math.PI * 2 - Math.PI / 2;
        const px = C + Math.cos(t) * landAt[i] * RR;
        const py = C + Math.sin(t) * landAt[i] * RR;
        if (pen) s.lineTo(px, py);
        else s.moveTo(px, py);
        pen = true;
      }
      s.stroke();
    }
    s.restore();
  }

  // Echoes: short arc segments across the beam, thicker and warmer for stronger returns. Marks are bucketed by
  // strength so each bucket is one path and one stroke.
  const LEVELS = 6;
  const buckets = Array.from({ length: LEVELS }, () => []);
  const colors = Array.from({ length: LEVELS }, (_, i) => ({
    core: echoColor(i / (LEVELS - 1), 0.95),
    glow: echoColor(i / (LEVELS - 1), 0.3),
    trail: echoColor(i / (LEVELS - 1), 0.5),
  }));
  function strokeEchoes(target, marks, pass) {
    for (const b of buckets) b.length = 0;
    for (const m of marks) buckets[Math.max(0, Math.min(LEVELS - 1, Math.round(m.strength * (LEVELS - 1))))].push(m);
    target.lineCap = 'round';
    for (let i = 0; i < LEVELS; i++) {
      const list = buckets[i];
      if (!list.length) continue;
      const str = i / (LEVELS - 1);
      const thick = (2 + 3.2 * str) * dpr;
      const widen = pass === 'glow' ? 1.15 : 1;
      target.beginPath();
      for (const m of list) {
        const r = Math.max(1, Math.hypot(m.u, m.v) * RR);
        const th = Math.atan2(-m.v, m.u);
        const half = (((3 + 4 * str) * Math.PI) / 180 + (2.2 * dpr) / Math.max(8 * dpr, r)) * widen;
        target.moveTo(C + Math.cos(th - half) * r, C + Math.sin(th - half) * r);
        target.arc(C, C, r, th - half, th + half);
      }
      target.strokeStyle = colors[i][pass];
      target.lineWidth = pass === 'glow' ? thick + 3.5 * dpr : thick;
      target.stroke();
    }
  }

  // Persistence, like a phosphor screen: fresh echoes are laid into a layer that fades a little on every update.
  const phos = layer();
  const pg = phos.getContext('2d');
  let lastDrawAt = null;

  function draw(marks, heading, t) {
    const dt = lastDrawAt === null ? 0.1 : Math.max(0, Math.min(1, t - lastDrawAt));
    lastDrawAt = t;
    pg.globalCompositeOperation = 'destination-out';
    pg.fillStyle = `rgba(0, 0, 0, ${(1 - Math.exp(-dt / 0.8)).toFixed(3)})`;
    pg.fillRect(0, 0, W, W);
    pg.globalCompositeOperation = 'source-over';
    strokeEchoes(pg, marks, 'trail');

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, W);
    g.drawImage(face, 0, 0);
    g.save();
    g.translate(C, C);
    g.rotate(-heading);
    g.translate(-C, -C);
    g.drawImage(shore, 0, 0);
    g.restore();
    g.save();
    g.beginPath();
    g.arc(C, C, RR, 0, Math.PI * 2);
    g.clip();
    g.globalAlpha = 0.55;
    g.drawImage(phos, 0, 0);
    g.globalAlpha = 1;
    strokeEchoes(g, marks, 'glow');
    strokeEchoes(g, marks, 'core');
    g.restore();

    // Own ship.
    g.fillStyle = 'rgba(255, 240, 220, 0.95)';
    g.beginPath();
    g.moveTo(C, C - 5 * dpr);
    g.lineTo(C + 3.4 * dpr, C + 4 * dpr);
    g.lineTo(C - 3.4 * dpr, C + 4 * dpr);
    g.closePath();
    g.fill();
  }

  let slice = 0;
  const api = {
    el,
    update(time) {
      const s = ctx.systems.seiner;
      const p = s?.position;
      if (!p) return;
      const range = Number(ctx.systems.economy?.modifiers?.sonarRange) || 150;
      const heading = s.heading ?? 0;
      let returns = [];
      try {
        returns = ctx.systems.fish?.sonarReturns?.(p.x, p.z, range) ?? [];
      } catch {
        returns = [];
      }
      // Nothing shows beyond the shore on its bearing (land shadows the beam).
      const marks = sonarProject(p.x, p.z, heading, returns, range).filter((m) => {
        const b = heading + Math.atan2(m.u, m.v);
        const i = ((Math.round((b / (Math.PI * 2)) * ANGLES) % ANGLES) + ANGLES) % ANGLES;
        return m.r <= landAt[i] + 0.02;
      });
      // A third of the ring per refresh (the whole ring every 0.3 s); all of it when the range changes.
      if (range !== lastRange) sampleLand(p.x, p.z, range, 0, ANGLES);
      else {
        const n = ANGLES / SLICES;
        sampleLand(p.x, p.z, range, slice * n, (slice + 1) * n);
        slice = (slice + 1) % SLICES;
      }
      drawShore();
      draw(marks, heading, time);
      if (range !== lastRange) {
        lastRange = range;
        setText(rangeEl, `${range} m`);
      }
      const depth = ctx.heightmap?.depthAt?.(p.x, p.z) ?? 0;
      setText(depthEl, `${depth < 10 ? depth.toFixed(1) : Math.round(depth)} m`);
      setText(marksEl, marks.length ? `${marks.length} mark${marks.length > 1 ? 's' : ''}` : '');
    },
  };
  return api;
}
