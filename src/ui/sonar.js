// Searchlight sonar / fish finder: a heading-up plan display of fish marks (fish.sonarReturns — marks and depth only,
// no species) and shore returns, redrawn at the HUD rate; the sweep is a CSS animation so it stays smooth for free.

import { h, setText } from './dom.js';
import { sonarProject } from './lib/logic.js';

const ANGLES = 56;
const RINGS = 12;

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

  const land = new Uint8Array(ANGLES * RINGS); // 2 = dry land, 1 = drying shallows
  // Soft blip sprites: weak (blue-green), medium (yellow), strong (red) returns.
  const SPRITES = [[90, 230, 200], [255, 214, 90], [255, 92, 60]].map(([r, gg, b]) => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 32;
    const x = cv.getContext('2d');
    const gr = x.createRadialGradient(16, 16, 0, 16, 16, 16);
    gr.addColorStop(0, `rgba(${r}, ${gg}, ${b}, 0.95)`);
    gr.addColorStop(0.45, `rgba(${r}, ${gg}, ${b}, 0.45)`);
    gr.addColorStop(1, `rgba(${r}, ${gg}, ${b}, 0)`);
    x.fillStyle = gr;
    x.fillRect(0, 0, 32, 32);
    return cv;
  });
  const trail = []; // recent marks, faded over time for persistence
  let lastRange = 0;

  function sampleLand(x, z, heading, range) {
    const hm = ctx.heightmap;
    for (let a = 0; a < ANGLES; a++) {
      const th = heading + (a / ANGLES) * Math.PI * 2;
      const sx = Math.sin(th);
      const cz = -Math.cos(th);
      for (let r = 0; r < RINGS; r++) {
        const d = ((r + 0.5) / RINGS) * range;
        const px = x + sx * d;
        const pz = z + cz * d;
        const depth = hm?.depthAt ? hm.depthAt(px, pz) : 50;
        land[a * RINGS + r] = depth <= 0.3 ? 2 : depth < 3 ? 1 : 0;
      }
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
    f.strokeStyle = 'rgba(255, 170, 90, 0.4)';
    f.setLineDash([3 * dpr, 4 * dpr]);
    f.beginPath();
    f.moveTo(C, C);
    f.lineTo(C, C - RR);
    f.stroke();
  }

  // Shore returns as annular sectors, merging runs of equal cells along each ring (dry land, drying shallows).
  function drawShore() {
    const s = shore.getContext('2d');
    s.clearRect(0, 0, W, W);
    s.fillStyle = 'rgb(214, 178, 92)';
    for (const [level, alpha] of [[2, 0.55], [1, 0.3]]) {
      s.beginPath();
      let any = false;
      for (let r = 0; r < RINGS; r++) {
        const r0 = (r / RINGS) * RR;
        const r1 = ((r + 1) / RINGS) * RR;
        let a = 0;
        while (a < ANGLES) {
          if (land[a * RINGS + r] !== level) {
            a++;
            continue;
          }
          let b = a;
          while (b + 1 < ANGLES && land[(b + 1) * RINGS + r] === level) b++;
          const a0 = (a / ANGLES) * Math.PI * 2 - Math.PI / 2;
          const a1 = ((b + 1) / ANGLES) * Math.PI * 2 - Math.PI / 2 + 0.01;
          s.moveTo(C + Math.cos(a0) * r0, C + Math.sin(a0) * r0);
          s.arc(C, C, r1, a0, a1);
          s.arc(C, C, r0, a1, a0, true);
          s.closePath();
          any = true;
          a = b + 1;
        }
      }
      if (any) {
        s.globalAlpha = alpha;
        s.fill();
      }
    }
    s.globalAlpha = 1;
  }

  function draw(marks, range, t) {
    const c = C;
    const R = RR;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, W);
    g.drawImage(face, 0, 0);
    g.drawImage(shore, 0, 0);
    g.save();
    g.beginPath();
    g.arc(c, c, R, 0, Math.PI * 2);
    g.clip();

    // Marks: persistent trail (fading) then fresh returns, coloured weak→strong (blue-green, yellow, red).
    // Normal blending keeps the classic colours (additive stacking would wash a school out to white).
    for (const m of trail) {
      const age = t - m.t;
      const a = Math.max(0, 1 - age / 2.4);
      if (a <= 0) continue;
      blip(m.u, m.v, m.strength, a * 0.28);
    }
    for (const m of marks) blip(m.u, m.v, m.strength, 0.85);
    g.restore();

    // Own ship.
    g.fillStyle = 'rgba(255, 240, 220, 0.95)';
    g.beginPath();
    g.moveTo(c, c - 5 * dpr);
    g.lineTo(c + 3.4 * dpr, c + 4 * dpr);
    g.lineTo(c - 3.4 * dpr, c + 4 * dpr);
    g.closePath();
    g.fill();

    function blip(u, v, s, alpha) {
      const sprite = SPRITES[s > 0.66 ? 2 : s > 0.33 ? 1 : 0];
      const rad = (2.2 + s * 4.2) * dpr * 1.8;
      g.globalAlpha = alpha;
      g.drawImage(sprite, c + u * R - rad, c - v * R - rad, rad * 2, rad * 2);
      g.globalAlpha = 1;
    }
  }

  let lastLandAt = -1;
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
      const marks = sonarProject(p.x, p.z, heading, returns, range);
      if (time - lastLandAt > 0.25 || range !== lastRange) {
        lastLandAt = time;
        sampleLand(p.x, p.z, heading, range);
        drawShore();
      }
      for (const m of marks) trail.push({ ...m, t: time });
      while (trail.length && time - trail[0].t > 2.4) trail.shift();
      if (trail.length > 240) trail.splice(0, trail.length - 240);
      draw(marks, range, time);
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
