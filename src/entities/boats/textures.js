// Canvas-painted textures for the boats: the hero hull atlas (paint bands, sheer stripe, rust streaks, scuffs,
// lettering), deck paint, a tileable grime map for painted steel, seine web, flags and name decals.
// Albedo canvases use SRGBColorSpace; roughness/bump maps use NoColorSpace.

import * as THREE from 'three';
import { mulberry32 } from '../../core/rng.js';

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function canvasTexture(canvas, { srgb = true, repeat = false, aniso = 8, mips = true } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = aniso;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = mips;
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

// Tileable value-noise fBm as a grey canvas (0..255).
export function noiseCanvas(size = 256, { octaves = 5, base = 4, seed = 7, contrast = 1 } = {}) {
  const rnd = mulberry32(seed);
  const lattices = [];
  for (let o = 0; o < octaves; o++) {
    const n = base << o;
    const l = new Float32Array(n * n);
    for (let i = 0; i < l.length; i++) l[i] = rnd();
    lattices.push({ n, l });
  }
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0;
      let amp = 0.5;
      let norm = 0;
      for (const { n, l } of lattices) {
        const fx = (x / size) * n;
        const fy = (y / size) * n;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const tx = fx - x0;
        const ty = fy - y0;
        const sx = tx * tx * (3 - 2 * tx);
        const sy = ty * ty * (3 - 2 * ty);
        const a = l[(y0 % n) * n + (x0 % n)];
        const b = l[(y0 % n) * n + ((x0 + 1) % n)];
        const cc = l[((y0 + 1) % n) * n + (x0 % n)];
        const d = l[((y0 + 1) % n) * n + ((x0 + 1) % n)];
        v += amp * (a + (b - a) * sx + (cc - a) * sy + (a - b - cc + d) * sx * sy);
        norm += amp;
        amp *= 0.5;
      }
      v = Math.min(1, Math.max(0, 0.5 + (v / norm - 0.5) * contrast));
      const k = (y * size + x) * 4;
      img.data[k] = img.data[k + 1] = img.data[k + 2] = v * 255;
      img.data[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

let noiseCache = null;
function sharedNoise() {
  if (!noiseCache) noiseCache = noiseCanvas(256, { octaves: 5, base: 4, seed: 11, contrast: 1.6 });
  return noiseCache;
}

// Overlays tiled noise with a composite mode for mottling.
function mottle(g, x, y, w, h, alpha, mode = 'multiply', scale = 1) {
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  g.globalAlpha = alpha;
  g.globalCompositeOperation = mode;
  const n = sharedNoise();
  const s = 256 * scale;
  for (let yy = y - (y % s); yy < y + h; yy += s) for (let xx = x - (x % s); xx < x + w; xx += s) g.drawImage(n, xx, yy, s, s);
  g.restore();
}

// Rust streak running down from (x, y), `len` pixels long.
function streak(g, rnd, x, y, len, width, color = [118, 58, 28], alpha = 0.55) {
  const strands = 2 + Math.floor(rnd() * 3);
  for (let s = 0; s < strands; s++) {
    const w = width * (0.35 + rnd() * 0.7);
    const ox = (rnd() - 0.5) * width * 1.2;
    const l = len * (0.45 + rnd() * 0.6);
    const grad = g.createLinearGradient(0, y, 0, y + l);
    const [r, gg, b] = color;
    grad.addColorStop(0, `rgba(${r},${gg},${b},${alpha})`);
    grad.addColorStop(0.35, `rgba(${r + 10},${gg + 6},${b},${alpha * 0.55})`);
    grad.addColorStop(1, `rgba(${r},${gg},${b},0)`);
    g.fillStyle = grad;
    g.beginPath();
    const wob = (rnd() - 0.5) * width;
    g.moveTo(x + ox - w / 2, y);
    g.quadraticCurveTo(x + ox + wob - w / 3, y + l * 0.5, x + ox + wob * 1.5 - w / 5, y + l);
    g.lineTo(x + ox + wob * 1.5 + w / 5, y + l);
    g.quadraticCurveTo(x + ox + wob + w / 3, y + l * 0.5, x + ox + w / 2, y);
    g.closePath();
    g.fill();
  }
}

const FONT_SERIF = "Georgia, 'Times New Roman', 'Iowan Old Style', serif";
const FONT_SANS = "'Helvetica Neue', Helvetica, Arial, sans-serif";

// Hull atlas for a seiner-type form.
// Layout (4096 x 1024, v up): sides v in [0.25, 1] mapping y in [-2.5, 4.5]; port u in [0, 0.5] (bow -> stern),
// starboard u in [0.5, 1] (stern -> bow); transom u [0, 0.5] x v [0, 0.25]; name board u [0.5, 1] x v [0, 0.25].
export function createHullAtlas(form, style = {}) {
  const W = 4096;
  const H = 1024;
  const S = {
    topsides: '#efede6',
    stripe: '#1c3152',
    pinstripe: '#b53a2d',
    boot: '#1a1c1f',
    bottom: '#7d2c22',
    letter: '#15191f',
    boardBg: '#1c3152',
    boardText: '#f4efe2',
    seed: 5,
    ...style,
  };
  const Y0 = -2.5;
  const Y1 = 4.5;
  const cyOf = (y) => (0.75 - (0.75 * (y - Y0)) / (Y1 - Y0)) * H;
  const pxPerM = (0.75 * H) / (Y1 - Y0);
  const cxOf = (side, t) => (side < 0 ? t * 2048 : 2048 + (1 - t) * 2048);
  const base = makeCanvas(W, H);
  const g = base.getContext('2d');
  const rnd = mulberry32(S.seed);
  const rough = makeCanvas(1024, 256);
  const r = rough.getContext('2d');
  const bump = makeCanvas(2048, 512);
  const b = bump.getContext('2d');
  b.fillStyle = '#808080';
  b.fillRect(0, 0, 2048, 512);

  // --- sides
  for (const side of [-1, 1]) {
    const x0 = side < 0 ? 0 : 2048;
    g.fillStyle = S.topsides;
    g.fillRect(x0, 0, 2048, 768);
    // Faint grime toward the waterline and under the rail.
    let gr = g.createLinearGradient(0, cyOf(1.2), 0, cyOf(0.48));
    gr.addColorStop(0, 'rgba(95,86,66,0)');
    gr.addColorStop(1, 'rgba(95,86,66,0.16)');
    g.fillStyle = gr;
    g.fillRect(x0, cyOf(1.2), 2048, cyOf(0.48) - cyOf(1.2));
    mottle(g, x0, 0, 2048, cyOf(0.46), 0.18, 'multiply', 2);
    // Boot stripe and bottom paint.
    g.fillStyle = S.boot;
    g.fillRect(x0, cyOf(0.48), 2048, cyOf(0.2) - cyOf(0.48));
    g.fillStyle = S.bottom;
    g.fillRect(x0, cyOf(0.2), 2048, 768 - cyOf(0.2));
    mottle(g, x0, cyOf(0.2), 2048, 768 - cyOf(0.2), 0.35, 'multiply', 1);
    gr = g.createLinearGradient(0, cyOf(0.2), 0, cyOf(-0.5));
    gr.addColorStop(0, 'rgba(70,74,40,0.45)');
    gr.addColorStop(1, 'rgba(70,74,40,0)');
    g.fillStyle = gr;
    g.fillRect(x0, cyOf(0.2), 2048, cyOf(-0.5) - cyOf(0.2));
    // Sheer stripe + pinstripe following the sheer.
    for (let cx = 0; cx < 2048; cx += 2) {
      const t = side < 0 ? cx / 2048 : 1 - cx / 2048;
      const sh = form.sheer(t);
      g.fillStyle = S.stripe;
      g.fillRect(x0 + cx, cyOf(sh + 0.2), 2.5, cyOf(sh - 0.5) - cyOf(sh + 0.2));
      g.fillStyle = S.pinstripe;
      g.fillRect(x0 + cx, cyOf(sh - 0.58), 2.5, cyOf(sh - 0.63) - cyOf(sh - 0.58));
    }
    mottle(g, x0, 0, 2048, 300, 0.12, 'multiply', 1.5);
    // Plate seams (albedo hint + bump).
    g.fillStyle = 'rgba(60,55,45,0.05)';
    const bx0 = side < 0 ? 0 : 1024;
    for (const y of [-0.9, 0.95, 1.9]) {
      g.fillRect(x0, cyOf(y), 2048, 2);
      b.fillStyle = '#6a6a6a';
      b.fillRect(bx0, cyOf(y) / 2, 1024, 1.5);
    }
    for (let z = 1.2; z < form.L; z += 2.35) {
      const t = z / form.L;
      const cx = cxOf(side, t) - x0;
      g.fillRect(x0 + cx, 0, 2, 768);
      b.fillStyle = '#707070';
      b.fillRect(bx0 + cx / 2, 0, 1.2, 384);
    }
    // Scuppers along the decks, each weeping rust.
    const P = form.P;
    for (let z = -6.8; z < form.L / 2 - 0.8; z += 1.3 + rnd() * 0.5) {
      const t = form.tOfZ(z);
      if (t > P.focsleEnd - 0.03 && t < P.focsleEnd + 0.05) continue;
      const deck = form.deckAt(t);
      // Keep the bow lettering clean (it sits 0.7-1.2 m below the sheer over the first ~40% of the length).
      const dSheer = form.sheer(t) - deck;
      if (t < 0.42 && dSheer > 0.45 && dSheer < 1.35) continue;
      const cx = cxOf(side, t);
      const cy = cyOf(deck + 0.16);
      g.fillStyle = '#2a2622';
      g.beginPath();
      g.roundRect(cx - 0.15 * pxPerM, cy, 0.3 * pxPerM, 0.1 * pxPerM, 4);
      g.fill();
      streak(g, rnd, cx, cy + 0.1 * pxPerM, (0.5 + rnd() * 1.4) * pxPerM, 0.12 * pxPerM, [112, 56, 26], 0.5 + rnd() * 0.25);
      r.fillStyle = 'rgba(210,210,210,0.8)';
      r.fillRect((cx - 0.1 * pxPerM) / 4, cy / 4, (0.2 * pxPerM) / 4, 1.2 * pxPerM / 4);
    }
    // Hawse pipe near the stem with a heavy stain.
    {
      const t = 0.045;
      const cx = cxOf(side, t);
      const cy = cyOf(form.sheer(t) - 0.95);
      streak(g, rnd, cx, cy, 1.9 * pxPerM, 0.35 * pxPerM, [104, 50, 24], 0.7);
      g.fillStyle = '#231f1c';
      g.beginPath();
      g.ellipse(cx, cy, 0.2 * pxPerM, 0.14 * pxPerM, 0, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = 'rgba(140,140,135,0.9)';
      g.lineWidth = 5;
      g.stroke();
    }
    // Random weeping rust spots.
    for (let i = 0; i < 26; i++) {
      const t = 0.08 + rnd() * 0.88;
      const y = 0.6 + rnd() * (form.sheer(t) - 1.1);
      streak(g, rnd, cxOf(side, t), cyOf(y), (0.2 + rnd() * 0.6) * pxPerM, 0.05 * pxPerM, [120, 62, 30], 0.35);
    }
    // Fender and skiff scuffs amidships.
    for (let i = 0; i < 38; i++) {
      const t = 0.3 + rnd() * 0.65;
      const y = 0.55 + rnd() * 1.3;
      const cx = cxOf(side, t);
      const cy = cyOf(y);
      const rad = (0.15 + rnd() * 0.45) * pxPerM;
      const rg = g.createRadialGradient(cx, cy, 0, cx, cy, rad);
      rg.addColorStop(0, `rgba(40,38,36,${0.1 + rnd() * 0.12})`);
      rg.addColorStop(1, 'rgba(40,38,36,0)');
      g.fillStyle = rg;
      g.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
      if (rnd() < 0.5) {
        g.strokeStyle = `rgba(80,76,70,${0.18 + rnd() * 0.2})`;
        g.lineWidth = 1 + rnd() * 1.5;
        g.beginPath();
        g.moveTo(cx - rad, cy + (rnd() - 0.5) * 6);
        g.lineTo(cx + rad * (0.5 + rnd()), cy + (rnd() - 0.5) * 10);
        g.stroke();
      }
    }
  }

  // Roughness: glossy topsides, satin stripe, flat bottom paint.
  r.globalCompositeOperation = 'source-over';
  r.fillStyle = 'rgb(92,92,92)';
  r.fillRect(0, 0, 1024, 192);
  r.fillStyle = 'rgb(200,200,200)';
  r.fillRect(0, cyOf(0.2) / 4, 1024, 192 - cyOf(0.2) / 4);
  r.fillStyle = 'rgb(120,120,120)';
  r.fillRect(0, cyOf(0.48) / 4, 1024, (cyOf(0.2) - cyOf(0.48)) / 4);
  r.fillStyle = 'rgb(110,110,110)';
  r.fillRect(0, 192, 1024, 64);
  mottle(r, 0, 0, 1024, 256, 0.35, 'overlay', 0.5);

  // --- transom region (u 0..0.5, v 0..0.25)
  const tx0 = 0;
  const ty0 = 768;
  const xMax = form.beamAt(1) * 1.05;
  const yMin = form.keel(1) - 0.1;
  const yMax = form.sheer(1) + 0.1;
  const tcy = (y) => ty0 + 256 - ((y - yMin) / (yMax - yMin)) * 256;
  g.fillStyle = S.topsides;
  g.fillRect(tx0, ty0, 2048, 256);
  mottle(g, tx0, ty0, 2048, 256, 0.16, 'multiply', 1);
  g.fillStyle = S.boot;
  g.fillRect(tx0, tcy(0.48), 2048, tcy(0.2) - tcy(0.48));
  g.fillStyle = S.bottom;
  g.fillRect(tx0, tcy(0.2), 2048, ty0 + 256 - tcy(0.2));
  const shS = form.sheer(1);
  g.fillStyle = S.stripe;
  g.fillRect(tx0, ty0, 2048, tcy(shS - 0.5) - ty0);
  g.fillStyle = S.pinstripe;
  g.fillRect(tx0, tcy(shS - 0.58), 2048, tcy(shS - 0.63) - tcy(shS - 0.58));
  for (let i = 0; i < 7; i++) {
    const cx = 200 + rnd() * 1650;
    streak(g, rnd, cx, tcy(shS - 0.7), (0.4 + rnd() * 0.6) * (256 / (yMax - yMin)), 16, [112, 56, 26], 0.45);
  }

  const pxX = 2048 / (2 * xMax); // px per metre across the transom
  const pxY = 256 / (yMax - yMin);

  const atlas = makeCanvas(W, H);
  const a = atlas.getContext('2d');
  const tex = canvasTexture(atlas, { srgb: true, aniso: 8 });

  function drawText(ctx2, text, x, y, heightM, pxW, pxH, { font = FONT_SERIF, weight = 'bold', color = S.letter, align = 'center', italic = false, shadow = null, maxWidth = null } = {}) {
    ctx2.save();
    ctx2.translate(x, y);
    ctx2.scale(pxW / pxH, 1);
    const size = heightM * pxH * 1.38;
    ctx2.font = `${italic ? 'italic ' : ''}${weight} ${size}px ${font}`;
    ctx2.textAlign = align;
    ctx2.textBaseline = 'alphabetic';
    const mw = maxWidth ? maxWidth / (pxW / pxH) : undefined;
    if (shadow) {
      ctx2.fillStyle = shadow;
      ctx2.fillText(text, size * 0.05, size * 0.05, mw);
    }
    ctx2.fillStyle = color;
    ctx2.fillText(text, 0, 0, mw);
    ctx2.restore();
  }

  function drawAlongSheer(text, side) {
    const letterH = 0.4;
    const below = 1.12;
    const size = letterH * pxPerM * 1.38;
    const sx = 2048 / form.L / pxPerM;
    a.save();
    a.font = `bold ${size}px ${FONT_SERIF}`;
    a.textBaseline = 'alphabetic';
    a.textAlign = 'center';
    const spacing = size * 0.06;
    const widths = [...text].map((ch) => a.measureText(ch).width * sx + spacing);
    let total = widths.reduce((q, w) => q + w, 0);
    const maxW = 0.3 * 2048;
    const squeeze = total > maxW ? maxW / total : 1;
    total *= squeeze;
    const tBow = 0.085;
    // Port reads bow -> stern (+cx); starboard reads stern -> bow, ending at the bow.
    let cx = side < 0 ? cxOf(-1, tBow) : cxOf(1, tBow) - total;
    const tOf = (px) => (side < 0 ? px / 2048 : 1 - (px - 2048) / 2048);
    const yAt = (px) => cyOf(form.sheer(tOf(px)) - below);
    [...text].forEach((ch, i) => {
      const w = widths[i] * squeeze;
      const c = cx + w / 2;
      const slope = (yAt(c + 20) - yAt(c - 20)) / 40;
      a.save();
      a.translate(c, yAt(c));
      a.rotate(Math.atan(slope) * 0.7);
      a.scale(sx * squeeze, 1);
      a.fillStyle = 'rgba(0,0,0,0.16)';
      a.fillText(ch, size * 0.04, size * 0.04);
      a.fillStyle = S.letter;
      a.fillText(ch, 0, 0);
      a.restore();
      cx += w;
    });
    a.restore();
  }

  function compose(name) {
    const nm = String(name || 'Northern Dawn').toUpperCase();
    a.clearRect(0, 0, W, H);
    a.drawImage(base, 0, 0);
    // Bow lettering: upright letters stepping along the sheer, clear below the stripe.
    drawAlongSheer(nm, -1);
    drawAlongSheer(nm, 1);
    // Transom: name and hailing port.
    drawText(a, nm, 1024, tcy(0.98), 0.36, pxX, pxY, { maxWidth: 1800, shadow: 'rgba(0,0,0,0.2)' });
    drawText(a, 'KODIAK, AK', 1024, tcy(0.56), 0.2, pxX, pxY, { font: FONT_SANS, maxWidth: 1000 });
    // Name board (navy with cream lettering and a gold rule).
    a.fillStyle = S.boardBg;
    a.fillRect(2048, 768, 2048, 256);
    a.strokeStyle = '#c9a24a';
    a.lineWidth = 8;
    a.strokeRect(2048 + 14, 768 + 14, 2048 - 28, 256 - 28);
    const bpx = 2048 / 3.0;
    const bpy = 256 / 0.38;
    drawText(a, nm, 3072, 768 + 190, 0.2, bpx, bpy, { color: S.boardText, maxWidth: 1850 });
    tex.needsUpdate = true;
  }
  compose(style.name);

  const roughTex = canvasTexture(rough, { srgb: false, aniso: 4 });
  const bumpTex = canvasTexture(bump, { srgb: false, aniso: 4 });
  return { texture: tex, roughness: roughTex, bump: bumpTex, setName: compose };
}

// Deck paint (u across the beam, v = 1 - t along the length).
export function createDeckTexture(form, { seed = 9, color = '#707a70', pileFrom = 0.74 } = {}) {
  const W = 512;
  const H = 1536;
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  const rnd = mulberry32(seed);
  g.fillStyle = color;
  g.fillRect(0, 0, W, H);
  mottle(g, 0, 0, W, H, 0.3, 'multiply', 1);
  mottle(g, 0, 0, W, H, 0.15, 'screen', 0.6);
  // Non-skid speckle.
  const img = g.getImageData(0, 0, W, H);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rnd() - 0.5) * 22;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  const cyT = (t) => t * H;
  // Worn walkways (lighter, scuffed to primer) and wet dark area under the pile.
  for (let i = 0; i < 60; i++) {
    const t = 0.3 + rnd() * 0.65;
    const x = W * (0.15 + rnd() * 0.7);
    const rad = 10 + rnd() * 40;
    const rg = g.createRadialGradient(x, cyT(t), 0, x, cyT(t), rad);
    rg.addColorStop(0, `rgba(150,150,140,${0.08 + rnd() * 0.12})`);
    rg.addColorStop(1, 'rgba(150,150,140,0)');
    g.fillStyle = rg;
    g.fillRect(x - rad, cyT(t) - rad, rad * 2, rad * 2);
  }
  const pg = g.createLinearGradient(0, cyT(pileFrom - 0.05), 0, cyT(pileFrom + 0.05));
  pg.addColorStop(0, 'rgba(20,24,20,0)');
  pg.addColorStop(1, 'rgba(20,24,20,0.28)');
  g.fillStyle = pg;
  g.fillRect(0, cyT(pileFrom - 0.05), W, H - cyT(pileFrom - 0.05));
  // Rust along the bulwark base and at scuppers.
  for (const x of [0, W]) {
    const eg = g.createLinearGradient(x, 0, x === 0 ? 40 : W - 40, 0);
    eg.addColorStop(0, 'rgba(110,60,30,0.55)');
    eg.addColorStop(1, 'rgba(110,60,30,0)');
    g.fillStyle = eg;
    g.fillRect(x === 0 ? 0 : W - 40, 0, 40, H);
  }
  for (let i = 0; i < 40; i++) {
    const t = 0.02 + rnd() * 0.96;
    const left = rnd() < 0.5;
    const x = left ? 4 + rnd() * 20 : W - 4 - rnd() * 20;
    const rad = 6 + rnd() * 26;
    const rg = g.createRadialGradient(x, cyT(t), 0, x, cyT(t), rad);
    rg.addColorStop(0, `rgba(118,58,26,${0.3 + rnd() * 0.35})`);
    rg.addColorStop(1, 'rgba(118,58,26,0)');
    g.fillStyle = rg;
    g.fillRect(x - rad, cyT(t) - rad, rad * 2, rad * 2);
  }
  // Safety-yellow edge line at the foc'sle break.
  g.fillStyle = 'rgba(214,176,40,0.85)';
  g.fillRect(0, cyT(form.P.focsleEnd) - 10, W, 8);
  return canvasTexture(c, { srgb: true, aniso: 8 });
}

// Tileable grime for painted steel: mostly white, mottled, with a few rust weeps (multiplies vertex colours).
export function createGrimeTexture({ seed = 21, size = 512 } = {}) {
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  const rnd = mulberry32(seed);
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, size, size);
  g.globalAlpha = 0.16;
  g.globalCompositeOperation = 'multiply';
  const n = sharedNoise();
  g.drawImage(n, 0, 0, size, size);
  g.globalAlpha = 0.1;
  g.drawImage(n, 0, 0, size / 2, size / 2);
  g.drawImage(n, size / 2, 0, size / 2, size / 2);
  g.drawImage(n, 0, size / 2, size / 2, size / 2);
  g.drawImage(n, size / 2, size / 2, size / 2, size / 2);
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
  for (let i = 0; i < 14; i++) {
    const x = rnd() * size;
    const y = rnd() * size * 0.8;
    streak(g, rnd, x, y, 30 + rnd() * 90, 4 + rnd() * 8, [130, 72, 36], 0.22 + rnd() * 0.2);
  }
  for (let i = 0; i < 40; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const rad = 1 + rnd() * 3;
    g.fillStyle = `rgba(120,64,30,${0.2 + rnd() * 0.3})`;
    g.beginPath();
    g.arc(x, y, rad, 0, Math.PI * 2);
    g.fill();
  }
  return canvasTexture(c, { srgb: true, repeat: true, aniso: 8 });
}

// Dark-green knotted nylon web for the seine pile (tileable).
export function createWebTexture({ seed = 3, size = 512 } = {}) {
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  const rnd = mulberry32(seed);
  g.fillStyle = '#16271d';
  g.fillRect(0, 0, size, size);
  mottle(g, 0, 0, size, size, 0.5, 'multiply', 1);
  const cells = 28;
  const step = size / cells;
  g.lineCap = 'round';
  for (let pass = 0; pass < 2; pass++) {
    g.strokeStyle = pass ? 'rgba(92,128,94,0.75)' : 'rgba(10,18,12,0.9)';
    g.lineWidth = pass ? 1.6 : 3.2;
    for (let i = -cells; i < cells * 2; i++) {
      for (const dir of [1, -1]) {
        g.beginPath();
        for (let k = 0; k <= cells; k++) {
          const x = (i + k * dir * 0.5) * step + (rnd() - 0.5) * 1.4 + (pass ? 0 : 1);
          const y = k * step + (rnd() - 0.5) * 1.4 + (pass ? 0 : 1);
          if (k === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
        g.stroke();
      }
    }
  }
  // Folds: broad soft dark bands.
  for (let i = 0; i < 7; i++) {
    const y = rnd() * size;
    const gr = g.createLinearGradient(0, y - 20, 0, y + 20);
    gr.addColorStop(0, 'rgba(0,0,0,0)');
    gr.addColorStop(0.5, 'rgba(0,0,0,0.35)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(0, y - 20, size, 40);
  }
  return canvasTexture(c, { srgb: true, repeat: true, aniso: 8 });
}

function star(g, cx, cy, r) {
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.42 : r;
    g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  g.closePath();
  g.fill();
}

// Flag atlas: US flag in u [0, 0.5], Alaska flag in u [0.5, 1] (both full height).
export function createFlagTexture() {
  const c = makeCanvas(512, 256);
  const g = c.getContext('2d');
  // US
  for (let i = 0; i < 13; i++) {
    g.fillStyle = i % 2 ? '#f4f1ea' : '#b22234';
    g.fillRect(0, (i * 256) / 13, 256, 256 / 13 + 1);
  }
  g.fillStyle = '#3c3b6e';
  g.fillRect(0, 0, 256 * 0.4, (256 * 7) / 13);
  g.fillStyle = '#f4f1ea';
  for (let row = 0; row < 9; row++) {
    const n = row % 2 ? 5 : 6;
    for (let k = 0; k < n; k++) star(g, 8 + k * 16.4 + (row % 2) * 8.2, 8 + row * 14.6, 4.2);
  }
  // Alaska: the Big Dipper and the North Star in gold on dark blue.
  g.fillStyle = '#0f204b';
  g.fillRect(256, 0, 256, 256);
  g.fillStyle = '#ffb612';
  const dipper = [[0.12, 0.72], [0.25, 0.7], [0.36, 0.76], [0.46, 0.82], [0.5, 0.94], [0.66, 0.92], [0.66, 0.8]];
  for (const [x, y] of dipper) star(g, 256 + x * 256, y * 256 * 0.95, 11);
  star(g, 256 + 0.82 * 256, 0.2 * 256, 18);
  return canvasTexture(c, { srgb: true, aniso: 4 });
}

// A name decal on a transparent background (for fleet boats and tenders).
export function createNameTexture(name, { color = '#f2efe6', width = 1024, height = 128, font = FONT_SERIF, italic = false, sub = null, subColor = null } = {}) {
  const c = makeCanvas(width, height);
  const g = c.getContext('2d');
  g.clearRect(0, 0, width, height);
  const size = sub ? height * 0.56 : height * 0.78;
  g.font = `${italic ? 'italic ' : ''}bold ${size}px ${font}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = color;
  g.fillText(String(name).toUpperCase(), width / 2, sub ? height * 0.36 : height * 0.54, width * 0.96);
  if (sub) {
    g.font = `bold ${height * 0.26}px ${FONT_SANS}`;
    g.fillStyle = subColor ?? color;
    g.fillText(sub, width / 2, height * 0.8, width * 0.9);
  }
  return canvasTexture(c, { srgb: true, aniso: 4 });
}

// Soft round sprite (glows, smoke, spray) as an alpha texture.
export function createSoftSprite(size = 64, { falloff = 2.2 } = {}) {
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5;
      const dy = (y + 0.5) / size - 0.5;
      const d = Math.min(1, Math.sqrt(dx * dx + dy * dy) * 2);
      const v = Math.pow(1 - d, falloff);
      const k = (y * size + x) * 4;
      img.data[k] = img.data[k + 1] = img.data[k + 2] = 255;
      img.data[k + 3] = v * 255;
    }
  }
  g.putImageData(img, 0, 0);
  return canvasTexture(c, { srgb: false, aniso: 1 });
}

// Brushed, welded aluminium plate for the seine skiff (tileable, ~1.25 m per tile with box UVs): fine brushing,
// plate seams with weld beads, scuffs, white oxide blooms and a few dents' shading.
export function createAluminiumTexture({ seed = 17, size = 512 } = {}) {
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  const rnd = mulberry32(seed);
  g.fillStyle = '#c3c8cb';
  g.fillRect(0, 0, size, size);
  mottle(g, 0, 0, size, size, 0.22, 'multiply', 1);
  // Brushing: long faint horizontal strokes.
  for (let i = 0; i < 900; i++) {
    const y = rnd() * size;
    const x = rnd() * size;
    const l = 30 + rnd() * 160;
    const v = rnd() < 0.5 ? 255 : 90;
    g.strokeStyle = `rgba(${v},${v},${v},${0.03 + rnd() * 0.05})`;
    g.lineWidth = 0.6 + rnd() * 0.8;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + l, y + (rnd() - 0.5) * 2);
    g.stroke();
  }
  // Plate seams (a weld bead: dark edge, light crown) on a staggered grid.
  const seam = (x0, y0, x1, y1) => {
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(70,74,78,0.55)';
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.stroke();
    g.strokeStyle = 'rgba(225,228,230,0.55)';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(x0, y0 - 1);
    g.lineTo(x1, y1 - 1);
    g.stroke();
  };
  seam(0, size * 0.5, size, size * 0.5);
  seam(size * 0.3, 0, size * 0.3, size * 0.5);
  seam(size * 0.78, size * 0.5, size * 0.78, size);
  // Scuffs and scratches from nets, corks and the ramp.
  for (let i = 0; i < 120; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const a = (rnd() - 0.5) * 0.6;
    const l = 6 + rnd() * 40;
    g.strokeStyle = rnd() < 0.5 ? `rgba(235,238,240,${0.2 + rnd() * 0.3})` : `rgba(60,62,64,${0.12 + rnd() * 0.2})`;
    g.lineWidth = 0.6 + rnd();
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
    g.stroke();
  }
  // Oxide blooms and grime.
  for (let i = 0; i < 26; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const r = 6 + rnd() * 30;
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    const light = rnd() < 0.6;
    rg.addColorStop(0, light ? `rgba(240,242,240,${0.15 + rnd() * 0.2})` : `rgba(70,66,58,${0.1 + rnd() * 0.15})`);
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  return canvasTexture(c, { srgb: true, repeat: true, aniso: 8 });
}
