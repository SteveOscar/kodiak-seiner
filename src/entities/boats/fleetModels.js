// Ambient vessels: fleet seiners, tenders (packers with a brailing crane), the Kodiak ferry and the Coast Guard
// cutter. Each builds a near model (a few merged, vertex-coloured meshes + a name decal) and a one-mesh far LOD.
// Local frame: bow toward -z, origin on the waterline amidships.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { patchUnderwater } from '../../render/shaderChunks.js';
import { createBuilder, shapes, addTube, sideProfileExtrude } from './builder.js';
import { createHullForm, buildShell, buildTransom, buildBulwarks, buildDecks, SEINER_FORM } from './hull.js';
import { makeCanvas, canvasTexture, createNameTexture } from './textures.js';
import { seinerMaterials, C } from './seinerModel.js';
import { ARCS } from './fx.js';

const srgb = (hex) => {
  const c = new THREE.Color(hex).convertLinearToSRGB();
  return [c.r, c.g, c.b];
};

let FM = null;
export function fleetMaterials(ctx) {
  if (FM) return FM;
  const grime = seinerMaterials(ctx).grime;
  const paint = new THREE.MeshStandardMaterial({ map: grime, vertexColors: true, roughness: 0.55, metalness: 0.05 });
  patchUnderwater(paint, ctx.uniforms);
  const far = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.05 });
  patchUnderwater(far, ctx.uniforms);
  const glass = new THREE.MeshStandardMaterial({ color: 0x1b2833, roughness: 0.06, metalness: 0.1, emissive: new THREE.Color('#ffc07a'), emissiveIntensity: 0, envMapIntensity: 3.4 });
  FM = { paint, far, glass, grime };
  return FM;
}

function decalMaterial(texture) {
  return new THREE.MeshStandardMaterial({
    map: texture,
    alphaTest: 0.45,
    roughness: 0.5,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}

// Quad on the hull side at station t (0 bow .. 1 stern), centred at height y, width w (m) and height h (m); faces
// outward on `side` (-1 port, 1 starboard). Reads left-to-right from outside.
function hullDecal(form, side, t, y, w, h, uv = [0, 0, 1, 1]) {
  const L = form.L;
  const z0 = form.zOfT(t) - w / 2;
  const z1 = z0 + w;
  const pts = [];
  const n = 8;
  for (let i = 0; i <= n; i++) {
    const z = z0 + ((z1 - z0) * i) / n;
    const tt = (z + L / 2) / L;
    const xb = form.halfWidthAt(tt, y - h / 2) + 0.02;
    const xt = form.halfWidthAt(tt, y + h / 2) + 0.02;
    pts.push([z, xb, xt]);
  }
  const pos = [];
  const uvs = [];
  const idx = [];
  const [u0, v0, u1, v1] = uv;
  for (let i = 0; i <= n; i++) {
    const [z, xb, xt] = pts[i];
    // Starboard reads stern->bow (+z is left), port reads bow->stern.
    const u = side > 0 ? u1 - ((u1 - u0) * i) / n : u0 + ((u1 - u0) * i) / n;
    pos.push(side * xb, y - h / 2, z, side * xt, y + h / 2, z);
    uvs.push(u, v0, u, v1);
  }
  for (let i = 0; i < n; i++) {
    const a = i * 2;
    if (side > 0) idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    else idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function transomDecal(form, y, w, h, uv = [0, 0, 1, 1]) {
  const z = form.L / 2 + form.P.transomRake * 0.5 + 0.03;
  const [u0, v0, u1, v1] = uv;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-w / 2, y - h / 2, z, w / 2, y - h / 2, z, w / 2, y + h / 2, z, -w / 2, y + h / 2, z], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([u0, v0, u1, v0, u1, v1, u0, v1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.computeVertexNormals();
  return g;
}

// Hull shell with crisp vertex-colour paint bands (bottom paint, boot top, topsides, sheer stripe, pinstripe): each
// band edge gets a pair of rows 12 mm apart so the colour change is sharp.
function paintedShell(form, { hull, stripe, bottom = '#7d2c22', boot = '#1a1c1f', stripeW = 0.5, pin = null, stations = 40, rows = 14, bootLo = 0.2, bootHi = 0.48 }) {
  const H = srgb(hull);
  const S = srgb(stripe);
  const Bt = srgb(bottom);
  const Bo = srgb(boot);
  const Pn = pin ? srgb(pin) : null;
  const D1 = stripeW + 0.06;
  const D2 = stripeW + 0.12;
  const paint = (t, y, sh) => {
    if (y < bootLo - 1e-3) return Bt;
    if (y < bootHi - 1e-3) return Bo;
    const d = sh - y;
    if (d < stripeW + 0.005) return S;
    if (Pn && d > D1 + 0.005 && d < D2 + 0.005) return Pn;
    return H;
  };
  const e = 0.012;
  const bandSheer = [stripeW, stripeW + e, 0.02];
  if (Pn) bandSheer.push(D1, D1 + e, D2, D2 + e);
  const bandYs = [bootLo - e, bootLo, bootHi - e, bootHi];
  const opts = { stations, rows, bandYs, bandSheer, paint };
  return [buildShell(form, opts), buildTransom(form, { rows, bandYs, bandSheer, paint })];
}

function lowerLOD(builder, bucket) {
  return builder.build(bucket);
}

// ---------------------------------------------------------------------------------------------- fleet seiner
export function buildFleetSeiner(ctx, style) {
  const form = createHullForm(SEINER_FORM);
  const P = form.P;
  const mats = fleetMaterials(ctx);
  const near = new THREE.Group();
  const b = createBuilder();
  const [shell, transom] = paintedShell(form, { hull: style.hull, stripe: style.stripe, pin: style.pin ?? null, stations: 36, rows: 12 });
  b.add('body', shell, { uvScale: 0.5 });
  b.add('body', transom, { uvScale: 0.5 });
  const bw = buildBulwarks(form, { stations: 24 });
  b.add('body', bw.inner, { color: '#d9d7cf' });
  b.add('body', bw.cap, { color: C.wood });
  b.add('body', buildDecks(form, { stations: 24 }), { color: '#6d776d' });
  const houseCol = style.house ?? C.white;
  // House, wheelhouse (reverse-raked front), roof, flying bridge rail.
  b.add('body', shapes.rbox(4.0, 2.45, 5.5, 0.06), { p: [0, 1.0 + 1.225, -2.2], color: houseCol });
  b.add('body', sideProfileExtrude([[-4.45, 3.45], [-0.85, 3.45], [-0.85, 5.55], [-4.9, 5.55]], 3.7, 0.05), { color: houseCol });
  b.add('body', shapes.box(4.0, 0.14, 4.4), { p: [0, 5.62, -2.95], color: houseCol });
  // Flying bridge: white windscreen with a navy cap, a rail round the front, and the console.
  b.add('body', shapes.box(3.7, 0.6, 0.05), { p: [0, 6.0, -4.95], color: houseCol });
  b.add('body', shapes.box(3.74, 0.09, 0.12), { p: [0, 6.33, -4.95], color: C.navy });
  for (const side of [-1, 1]) {
    b.add('body', shapes.box(0.05, 0.6, 1.8), { p: [side * 1.85, 6.0, -4.05], color: houseCol });
    b.add('body', shapes.box(0.12, 0.09, 1.84), { p: [side * 1.85, 6.33, -4.05], color: C.navy });
    addTube(b, 'body', [side * 1.88, 6.62, -4.95], [side * 1.88, 6.62, -2.0], 0.025, { color: C.galv, seg: 5 });
    for (const z of [-4.95, -3.5, -2.0]) addTube(b, 'body', [side * 1.88, 5.7, z], [side * 1.88, 6.64, z], 0.022, { color: C.galv, seg: 5 });
  }
  addTube(b, 'body', [-1.88, 6.62, -4.97], [1.88, 6.62, -4.97], 0.025, { color: C.galv, seg: 5 });
  b.add('body', shapes.box(1.2, 0.95, 0.5), { p: [0, 6.15, -4.4], color: houseCol });
  b.add('body', shapes.cyl(0.08, 0.08, 0.25, 8), { p: [0.9, 5.82, -1.6], color: C.white });
  b.add('body', shapes.box(1.7, 0.1, 0.12), { p: [0.9, 6.0, -1.6], color: '#e9e8e2' });
  // Mast, yard, boom, block, stack.
  addTube(b, 'body', [0, 3.5, 0.1], [0, 12.4, 0.1], 0.13, { radiusB: 0.08, color: C.white, open: false });
  addTube(b, 'body', [-1.1, 9.7, 0.1], [1.1, 9.7, 0.1], 0.05, { color: C.white });
  addTube(b, 'body', [0, 4.3, 0.4], [0, 9.0, 8.1], 0.12, { radiusB: 0.085, color: C.white, open: false });
  b.add('body', shapes.cyl(0.46, 0.46, 0.4, 16), { p: [0, 8.0, 8.2], r: [0, 0, Math.PI / 2], color: C.red });
  b.add('body', shapes.cyl(0.16, 0.17, 3.6, 10), { p: [-1.5, 5.3, 0.15], color: C.dark });
  addTube(b, 'body', [0, 12.2, 0.1], [0, 9.05, 8.1], 0.02, { color: C.black, seg: 4 });
  // Seine pile with the corkline strip.
  b.add('body', shapes.rbox(4.6, 1.1, 4.2, 0.45, 3), { p: [0, P.deckAft + 0.45, 6.5], color: '#1d3326' });
  b.add('body', shapes.rbox(1.4, 0.2, 3.6, 0.08), { p: [1.2, P.deckAft + 1.02, 6.5], color: C.yellow });
  // Tyres along the sides.
  for (const side of [-1, 1]) {
    for (const z of [-1.3, 2.4, 5.6]) {
      const t = form.tOfZ(z);
      b.add('body', shapes.torus(0.3, 0.12, 6, 12), { p: [side * (form.halfWidthAt(t, 1.35) + 0.12), 1.35, z], r: [0, Math.PI / 2, 0], color: C.rubber });
    }
  }
  // Windows.
  const glassB = createBuilder();
  for (const side of [-1, 1]) {
    glassB.add('g', shapes.box(0.02, 0.95, 3.0), { p: [side * 1.86, 4.8, -2.7] });
  }
  glassB.add('g', shapes.box(3.2, 1.0, 0.02), { p: [0, 4.78, -4.72], r: [0.21, 0, 0] });
  glassB.add('g', shapes.box(2.6, 0.9, 0.02), { p: [0, 4.8, -0.83] });

  const body = new THREE.Mesh(b.build('body'), mats.paint);
  body.castShadow = true;
  body.receiveShadow = true;
  const glass = new THREE.Mesh(glassB.build('g'), mats.glass);
  near.add(body, glass);
  // Name on the bows and transom.
  const nameTex = createNameTexture(style.name, { color: style.letter ?? (isDark(style.hull) ? '#f0ede4' : '#15191f'), width: 1024, height: 128 });
  const dg = mergeGeometries([
    hullDecal(form, -1, 0.2, form.sheer(0.2) - 1.1, 3.4, 0.45),
    hullDecal(form, 1, 0.2, form.sheer(0.2) - 1.1, 3.4, 0.45),
    transomDecal(form, 1.1, 3.6, 0.48),
  ]);
  const decal = new THREE.Mesh(dg, decalMaterial(nameTex));
  near.add(decal);

  // Far LOD: hull silhouette, house, mast, boom in one mesh.
  const f = createBuilder();
  const [s2, t2] = paintedShell(form, { hull: style.hull, stripe: style.stripe, stations: 14, rows: 6 });
  f.add('far', s2);
  f.add('far', t2);
  f.add('far', buildDecks(form, { stations: 8 }), { color: '#6d776d' });
  f.add('far', shapes.box(4.0, 2.45, 5.5), { p: [0, 2.22, -2.2], color: houseCol });
  f.add('far', shapes.box(3.7, 2.1, 3.9), { p: [0, 4.5, -2.8], color: houseCol });
  f.add('far', shapes.box(3.6, 0.8, 0.1), { p: [0, 4.8, -4.8], color: '#1a2024' });
  f.add('far', shapes.cyl(0.14, 0.1, 8.9, 5), { p: [0, 7.95, 0.1], color: C.white });
  addTube(f, 'far', [0, 4.3, 0.4], [0, 9.0, 8.1], 0.14, { color: C.white, seg: 5 });
  f.add('far', shapes.box(4.4, 1.0, 4.0), { p: [0, P.deckAft + 0.4, 6.5], color: '#1d3326' });
  const far = new THREE.Mesh(f.build('far'), mats.far);
  far.castShadow = false;

  return {
    near,
    far,
    form,
    halfLength: form.L / 2 - 3,
    radius: 3.2,
    lights: [
      { id: 'port', pos: [-2.1, 5.0, -4.1], color: 0xff2a1a, size: 0.55, intensity: 1.6, arc: ARCS.port },
      { id: 'starboard', pos: [2.1, 5.0, -4.1], color: 0x2aff7a, size: 0.55, intensity: 1.4, arc: ARCS.starboard },
      { id: 'masthead', pos: [0, 10.4, -0.1], color: 0xfff2dc, size: 0.6, intensity: 1.5, arc: ARCS.masthead },
      { id: 'stern', pos: [2.2, 2.6, 8.8], color: 0xfff2dc, size: 0.45, intensity: 1.4, arc: ARCS.stern },
      { id: 'anchor', pos: [0, 12.5, 0.1], color: 0xfff2dc, size: 0.6, intensity: 1.5 },
      { id: 'fishRed', pos: [0, 11.6, 0.0], color: 0xff2a1a, size: 0.5, intensity: 1.5 },
      { id: 'fishWhite', pos: [0, 11.05, 0.0], color: 0xfff2dc, size: 0.5, intensity: 1.3 },
      { id: 'flood', pos: [0, 9.55, 0.3], color: 0xffe2b0, size: 1.6, intensity: 2.0, arc: ARCS.floodAft },
    ],
    skiffMount: { pos: [0, 3.2, 5.95], rotX: 0.2 },
    points: { stern: [0, 2.3, 9.0], bow: [0, form.sheer(0), -form.L / 2] },
  };
}

function isDark(hex) {
  const c = new THREE.Color(hex);
  return c.r + c.g + c.b < 0.35;
}

// ---------------------------------------------------------------------------------------------- tender
export function buildTender(ctx, spec) {
  const L = spec.length ?? 30;
  const beam = L * 0.27;
  const form = createHullForm({
    length: L,
    beam,
    sheerStern: 2.4,
    sheerRise: 0.5,
    sheerBow: 1.7,
    sheerPow: 3.2,
    keel: -2.5,
    forefoot: -0.3,
    forefootEnd: 0.25,
    keelStern: -0.9,
    runStart: 0.72,
    maxBeamAt: 0.5,
    entryPow: 2.4,
    sternBeam: 0.9,
    flareBow: 0.35,
    flareMid: 0.06,
    vBow: 0.34,
    bilge: 0.3,
    rake: 1.6,
    rakeLen: 0.2,
    transomRake: 0.3,
    deckAft: 1.45,
    deckFwd: 2.65,
    focsleEnd: 0.2,
    bowBulwark: 1.0,
  });
  const P = form.P;
  const mats = fleetMaterials(ctx);
  const near = new THREE.Group();
  const b = createBuilder();
  const [shell, transom] = paintedShell(form, { hull: spec.hull, stripe: spec.trim, stripeW: 0.35, pin: null, stations: 44, rows: 14, bootLo: 0.25, bootHi: 0.6 });
  b.add('body', shell, { uvScale: 0.35 });
  b.add('body', transom, { uvScale: 0.35 });
  const bw = buildBulwarks(form, { stations: 28, thickness: 0.12, capWidth: 0.24 });
  b.add('body', bw.inner, { color: spec.trim });
  b.add('body', bw.cap, { color: C.dark });
  b.add('body', buildDecks(form, { stations: 28 }), { color: '#5f6a63' });
  const zH0 = form.zOfT(0.1);
  const zH1 = form.zOfT(0.44);
  const hw = form.halfWidthAt(0.3, P.deckAft) - 0.9;
  const trim = spec.trim;
  // House forward: a full-width main deckhouse, a tall wheelhouse with a reverse-raked window band on top, and a
  // railed top deck carrying the mast. Tenders stand tall so a seiner alongside is dwarfed.
  const H1 = 2.9;
  const H2 = 2.6;
  b.add('body', shapes.rbox(hw * 2, H1, zH1 - zH0, 0.08), { p: [0, P.deckAft + H1 / 2, (zH0 + zH1) / 2], color: trim });
  b.add('body', shapes.box(hw * 2 + 0.06, 0.12, zH1 - zH0 + 0.06), { p: [0, P.deckAft + H1 - 0.05, (zH0 + zH1) / 2], color: spec.company });
  const wz0 = zH0 + 0.9;
  const wz1 = zH0 + (zH1 - zH0) * 0.66;
  const wy0 = P.deckAft + H1;
  const wy1 = wy0 + H2;
  b.add('body', sideProfileExtrude([[wz0 + 0.45, wy0], [wz1, wy0], [wz1, wy1], [wz0, wy1]], hw * 2 - 0.4, 0.06), { color: trim });
  b.add('body', shapes.box(hw * 2 - 0.1, 0.18, wz1 - wz0 + 1.0), { p: [0, wy1 + 0.09, (wz0 + wz1) / 2 - 0.3], color: trim });
  // Top-deck rail and a white windscreen at the front.
  const topY = wy1 + 0.18;
  const rx = hw - 0.25;
  const railZ0 = wz0 - 0.1;
  const railZ1 = wz1 - 0.2;
  for (const [a, c] of [[[-rx, railZ0], [rx, railZ0]], [[-rx, railZ0], [-rx, railZ1]], [[rx, railZ0], [rx, railZ1]]]) {
    addTube(b, 'body', [a[0], topY + 1.0, a[1]], [c[0], topY + 1.0, c[1]], 0.03, { color: C.galv });
    addTube(b, 'body', [a[0], topY + 0.5, a[1]], [c[0], topY + 0.5, c[1]], 0.02, { color: C.galv });
  }
  for (let z = railZ0; z <= railZ1 + 1e-6; z += 1.1) {
    for (const x of [-rx, rx]) addTube(b, 'body', [x, topY, z], [x, topY + 1.0, z], 0.025, { color: C.galv, seg: 6 });
  }
  b.add('body', shapes.box(rx * 2, 0.7, 0.06), { p: [0, topY + 0.35, railZ0], color: trim });
  // Mast with a crossyard, radar array and dome, masthead lights and the company flag.
  const mastZ = wz1 - 0.9;
  const mastTop = topY + 8.2;
  addTube(b, 'body', [0, topY, mastZ], [0, mastTop, mastZ], 0.16, { radiusB: 0.1, color: trim, open: false });
  addTube(b, 'body', [-1.6, topY + 5.2, mastZ], [1.6, topY + 5.2, mastZ], 0.07, { color: trim });
  b.add('body', shapes.box(2.6, 0.16, 0.2), { p: [0, topY + 2.4, mastZ - 0.2], color: '#ecebe4' });
  b.add('body', shapes.box(0.4, 0.5, 0.4), { p: [0, topY + 2.1, mastZ - 0.2], color: '#dcdad2' });
  b.add('body', shapes.sphere(0.45, 12, 8), { p: [1.3, topY + 0.45, mastZ - 1.6], s: [1, 0.85, 1], color: '#ecebe4' });
  for (const side of [-1, 1]) {
    b.add('body', shapes.rbox(0.36, 0.28, 0.26, 0.03), { p: [side * 1.35, topY + 5.0, mastZ + 0.15], r: [0.5, 0, 0], color: C.dark });
  }
  b.add('body', shapes.box(0.03, 0.6, 0.95), { p: [0, mastTop - 0.4, mastZ + 0.5], color: spec.company });
  // Stack aft of the wheelhouse, banded in the company colour.
  b.add('body', shapes.cyl(0.26, 0.28, 4.6, 12), { p: [-hw + 0.55, P.deckAft + H1 + 1.4, zH1 - 0.7], color: C.dark });
  b.add('body', shapes.cyl(0.285, 0.285, 0.5, 12), { p: [-hw + 0.55, P.deckAft + H1 + 2.6, zH1 - 0.7], color: spec.company });
  // Brailing crane on the port side aft of the house: pedestal, knuckle boom, hook.
  const cz = zH1 + 1.8;
  const cx = -hw + 0.3;
  b.add('body', shapes.cyl(0.45, 0.55, 2.4, 14), { p: [cx, P.deckAft + 1.2, cz], color: '#d4a22a' });
  addTube(b, 'body', [cx, P.deckAft + 2.4, cz], [cx - 2.4, P.deckAft + 7.8, cz + 4.5], 0.24, { color: '#d4a22a', open: false });
  addTube(b, 'body', [cx - 2.4, P.deckAft + 7.8, cz + 4.5], [cx - 4.6, P.deckAft + 6.4, cz + 7.5], 0.18, { color: '#d4a22a', open: false });
  addTube(b, 'body', [cx - 0.3, P.deckAft + 3.0, cz + 0.2], [cx - 1.6, P.deckAft + 5.7, cz + 2.6], 0.09, { color: C.galv });
  addTube(b, 'body', [cx - 4.6, P.deckAft + 6.4, cz + 7.5], [cx - 4.6, P.deckAft + 2.6, cz + 7.5], 0.02, { color: C.black, seg: 4 });
  b.add('body', shapes.box(0.25, 0.4, 0.2), { p: [cx - 4.6, P.deckAft + 2.4, cz + 7.5], color: C.orange });
  // Hatches on the long working deck, fish pump, totes.
  for (const k of [0.55, 0.7, 0.84]) b.add('body', shapes.rbox(2.2, 0.55, 2.2, 0.05), { p: [0, P.deckAft + 0.27, form.zOfT(k)], color: '#8f9893' });
  for (let i = 0; i < 4; i++) b.add('body', shapes.box(1.1, 0.8, 1.1), { p: [hw - 0.3, P.deckAft + 0.4, form.zOfT(0.52 + i * 0.07)], color: i % 2 ? '#2f6aa8' : '#c9542c' });
  // Heavy fendering along both sides for seiners coming alongside.
  for (const side of [-1, 1]) {
    for (let k = 0.28; k <= 0.86; k += 0.09) {
      const z = form.zOfT(k);
      b.add('body', shapes.torus(0.42, 0.17, 6, 14), { p: [side * (form.halfWidthAt(k, 1.6) + 0.16), 1.6, z], r: [0, Math.PI / 2, 0], color: C.rubber });
    }
  }
  // Stern flag staff (flag drawn as a small quad).
  addTube(b, 'body', [-form.halfWidthAt(0.97, 2.4) + 0.4, form.sheer(0.98), form.L / 2 - 0.2], [-form.halfWidthAt(0.97, 2.4) + 0.3, form.sheer(0.98) + 2.2, form.L / 2 + 0.1], 0.03, { color: C.white });
  b.add('body', shapes.box(0.02, 0.55, 0.95), { p: [-form.halfWidthAt(0.97, 2.4) + 0.3, form.sheer(0.98) + 1.9, form.L / 2 + 0.6], color: '#b22234' });
  // Windows: wheelhouse band all round (the front follows the reverse rake), portholes along the main house.
  const gB = createBuilder();
  const wy = wy0 + 1.55;
  const rake = 0.45 / H2;
  gB.add('g', shapes.box(hw * 2 - 0.8, 1.15, 0.03), { p: [0, wy, wz0 + 0.45 - rake * (wy - wy0) - 0.035], r: [-Math.atan(rake), 0, 0] });
  for (const side of [-1, 1]) {
    gB.add('g', shapes.box(0.03, 1.05, wz1 - wz0 - 1.1), { p: [side * (hw - 0.2 + 0.02), wy, (wz0 + wz1) / 2 + 0.2] });
    for (let k = 0; k < 5; k++) gB.add('g', shapes.cyl(0.18, 0.18, 0.03, 12), { p: [side * (hw + 0.02), P.deckAft + 1.85, zH0 + 1.4 + k * 1.6], r: [0, 0, Math.PI / 2] });
  }
  gB.add('g', shapes.box(hw * 2 - 1.2, 0.95, 0.03), { p: [0, wy, wz1 + 0.02] });
  const body = new THREE.Mesh(b.build('body'), mats.paint);
  body.castShadow = true;
  body.receiveShadow = true;
  const glass = new THREE.Mesh(gB.build('g'), mats.glass);
  near.add(body, glass);
  const nameTex = createNameTexture(spec.name, { color: isDark(spec.hull) ? '#f0ede4' : '#15191f', width: 1024, height: 128 });
  const dg = mergeGeometries([
    hullDecal(form, -1, 0.1, form.sheer(0.1) - 1.05, 5.2, 0.6),
    hullDecal(form, 1, 0.1, form.sheer(0.1) - 1.05, 5.2, 0.6),
    transomDecal(form, 1.3, 5.4, 0.62),
  ]);
  near.add(new THREE.Mesh(dg, decalMaterial(nameTex)));

  const f = createBuilder();
  const [s2, t2] = paintedShell(form, { hull: spec.hull, stripe: spec.trim, stripeW: 0.35, stations: 14, rows: 6, bootLo: 0.25, bootHi: 0.6 });
  f.add('far', s2);
  f.add('far', t2);
  f.add('far', buildDecks(form, { stations: 8 }), { color: '#5f6a63' });
  f.add('far', shapes.box(hw * 2, H1, zH1 - zH0), { p: [0, P.deckAft + H1 / 2, (zH0 + zH1) / 2], color: trim });
  f.add('far', shapes.box(hw * 2 - 0.4, H2, wz1 - wz0), { p: [0, wy0 + H2 / 2, (wz0 + wz1) / 2 + 0.2], color: trim });
  f.add('far', shapes.box(hw * 2 - 0.6, 1.0, 0.1), { p: [0, wy, wz0 + 0.1], color: '#1a2024' });
  f.add('far', shapes.cyl(0.16, 0.1, mastTop - topY, 5), { p: [0, (topY + mastTop) / 2, mastZ], color: trim });
  addTube(f, 'far', [cx, P.deckAft + 2.4, cz], [cx - 2.4, P.deckAft + 7.8, cz + 4.5], 0.26, { color: '#d4a22a', seg: 5 });
  const far = new THREE.Mesh(f.build('far'), mats.far);

  const deckY = P.deckAft;
  return {
    near,
    far,
    form,
    beam,
    halfLength: L / 2 - beam / 2,
    radius: beam / 2 + 0.3,
    lights: [
      { id: 'anchorFwd', pos: [0, mastTop + 0.2, mastZ], color: 0xfff2dc, size: 0.8, intensity: 1.6 },
      { id: 'anchorAft', pos: [0, form.sheer(0.98) + 2.4, L / 2 - 0.4], color: 0xfff2dc, size: 0.6, intensity: 1.4 },
      { id: 'flood1', pos: [-1.35, topY + 4.85, mastZ + 0.3], color: 0xffe2b0, size: 3.4, intensity: 2.6, arc: ARCS.floodAft },
      { id: 'flood2', pos: [1.35, topY + 4.85, mastZ + 0.3], color: 0xffe2b0, size: 3.4, intensity: 2.6, arc: ARCS.floodAft },
      { id: 'flood3', pos: [0, wy1 + 0.05, wz1 + 0.3], color: 0xffe2b0, size: 2.6, intensity: 2.3 },
      { id: 'crane', pos: [cx - 2.4, deckY + 7.9, cz + 4.5], color: 0xffe2b0, size: 2.2, intensity: 2.2 },
      { id: 'port', pos: [-(hw - 0.2), wy0 + 1.9, wz0 + 0.7], color: 0xff2a1a, size: 0.6, intensity: 1.4, arc: ARCS.port },
      { id: 'starboard', pos: [hw - 0.2, wy0 + 1.9, wz0 + 0.7], color: 0x2aff7a, size: 0.6, intensity: 1.3, arc: ARCS.starboard },
    ],
  };
}

// ---------------------------------------------------------------------------------------------- ferry
export function buildFerry(ctx) {
  const L = 90;
  const form = createHullForm({
    length: L,
    beam: 18,
    sheerStern: 7.2,
    sheerRise: 1.0,
    sheerBow: 3.0,
    sheerPow: 3,
    keel: -4.6,
    forefoot: -1.2,
    forefootEnd: 0.18,
    keelStern: -2.5,
    runStart: 0.75,
    maxBeamAt: 0.45,
    entryPow: 2.1,
    sternBeam: 0.88,
    flareBow: 0.3,
    flareMid: 0.04,
    vBow: 0.28,
    bilge: 0.24,
    rake: 5,
    rakeLen: 0.14,
    transomRake: 0.6,
    deckAft: 7.0,
    deckFwd: 8.0,
    focsleEnd: 0.14,
    bowBulwark: 1.2,
  });
  const mats = fleetMaterials(ctx);
  const near = new THREE.Group();
  const b = createBuilder();
  const blue = '#1b3c6c';
  const white = '#eeede7';
  const [shell, transom] = paintedShell(form, { hull: blue, stripe: white, stripeW: 1.0, stations: 48, rows: 14, bootLo: 0.3, bootHi: 1.0, bottom: '#7a2a22', boot: '#141618' });
  b.add('body', shell, { uvScale: 0.6 });
  b.add('body', transom, { uvScale: 0.6 });
  b.add('body', buildDecks(form, { stations: 24 }), { color: '#6f7474', uvScale: 1 });
  // Superstructure decks with window bands.
  const decks = [
    { z0: -30, z1: 26, y0: 7.0, h: 3.0, hw: 8.0 },
    { z0: -27, z1: 16, y0: 10.0, h: 2.8, hw: 7.3 },
    { z0: -27, z1: -14, y0: 12.8, h: 2.6, hw: 6.2 },
  ];
  const gB = createBuilder();
  for (const d of decks) {
    b.add('body', shapes.rbox(d.hw * 2, d.h, d.z1 - d.z0, 0.12), { p: [0, d.y0 + d.h / 2, (d.z0 + d.z1) / 2], color: white });
    for (const side of [-1, 1]) {
      gB.add('g', shapes.box(0.04, d.h * 0.36, d.z1 - d.z0 - 2.5), { p: [side * (d.hw + 0.01), d.y0 + d.h * 0.58, (d.z0 + d.z1) / 2] });
    }
    gB.add('g', shapes.box(d.hw * 2 - 1.5, d.h * 0.38, 0.04), { p: [0, d.y0 + d.h * 0.58, d.z0 - 0.01] });
  }
  // Bridge wings.
  b.add('body', shapes.box(17.4, 0.3, 3.2), { p: [0, 15.4, -25.8], color: white });
  // Funnel: AMHS blue with a gold band.
  b.add('body', shapes.rbox(3.2, 5.6, 5.5, 0.6), { p: [0, 15.6, 6], color: blue });
  b.add('body', shapes.rbox(3.3, 0.9, 5.6, 0.45), { p: [0, 16.3, 6], color: '#e0b030' });
  b.add('body', shapes.box(2.4, 0.4, 3.6), { p: [0, 18.5, 6], color: C.black });
  // Masts, radar, lifeboats.
  addTube(b, 'body', [0, 15.4, -21], [0, 23, -21], 0.25, { radiusB: 0.15, color: white, open: false });
  addTube(b, 'body', [-2, 21, -21], [2, 21, -21], 0.1, { color: white });
  addTube(b, 'body', [0, 12.8, 20], [0, 18, 20], 0.2, { color: white, open: false });
  for (const side of [-1, 1]) {
    for (const z of [-8, -1, 6, 12]) {
      b.add('body', shapes.rbox(1.9, 1.5, 5.6, 0.6, 2), { p: [side * 8.6, 11.8, z], color: C.orange });
    }
  }
  // Stern car-deck door.
  b.add('body', shapes.box(6, 3.2, 0.2), { p: [0, 5.2, L / 2 + 0.5], color: '#2c3136' });
  const body = new THREE.Mesh(b.build('body'), mats.paint);
  body.castShadow = true;
  body.receiveShadow = true;
  const glass = new THREE.Mesh(gB.build('g'), mats.glass);
  near.add(body, glass);
  const nameTex = createNameTexture('Tustumena', { color: '#f0ede4', width: 1024, height: 128, font: "'Helvetica Neue', Helvetica, Arial, sans-serif" });
  const lineTex = createNameTexture('ALASKA MARINE HIGHWAY', { color: blue, width: 2048, height: 128, font: "'Helvetica Neue', Helvetica, Arial, sans-serif" });
  near.add(new THREE.Mesh(mergeGeometries([hullDecal(form, -1, 0.12, form.sheer(0.12) - 1.7, 13, 1.6), hullDecal(form, 1, 0.12, form.sheer(0.12) - 1.7, 13, 1.6)]), decalMaterial(nameTex)));
  const side = (s) => {
    const g = new THREE.PlaneGeometry(30, 1.6);
    if (s < 0) g.rotateY(-Math.PI / 2);
    else g.rotateY(Math.PI / 2);
    g.translate(s * 7.35, 12.0, -4);
    return g;
  };
  near.add(new THREE.Mesh(mergeGeometries([side(-1), side(1)]), decalMaterial(lineTex)));

  const f = createBuilder();
  const [s2, t2] = paintedShell(form, { hull: blue, stripe: white, stripeW: 1.0, stations: 16, rows: 6, bootLo: 0.3, bootHi: 1.0 });
  f.add('far', s2);
  f.add('far', t2);
  for (const d of decks) f.add('far', shapes.box(d.hw * 2, d.h, d.z1 - d.z0), { p: [0, d.y0 + d.h / 2, (d.z0 + d.z1) / 2], color: white });
  f.add('far', shapes.box(3.2, 5.6, 5.5), { p: [0, 15.6, 6], color: blue });
  const far = new THREE.Mesh(f.build('far'), mats.far);

  const lights = [
    { id: 'masthead', pos: [0, 23.2, -21], color: 0xfff2dc, size: 1.2, intensity: 1.8, arc: ARCS.masthead },
    { id: 'masthead2', pos: [0, 18.2, 20], color: 0xfff2dc, size: 1.2, intensity: 1.8, arc: ARCS.masthead },
    { id: 'port', pos: [-8.7, 15.6, -25.8], color: 0xff2a1a, size: 1.0, intensity: 1.8, arc: ARCS.port },
    { id: 'starboard', pos: [8.7, 15.6, -25.8], color: 0x2aff7a, size: 1.0, intensity: 1.6, arc: ARCS.starboard },
    { id: 'stern', pos: [0, 10, L / 2 + 0.6], color: 0xfff2dc, size: 0.9, intensity: 1.6, arc: ARCS.stern },
  ];
  // Rows of lit cabin windows at night.
  for (const s of [-1, 1]) {
    for (let z = -26; z < 24; z += 4) lights.push({ id: 'win', pos: [s * 8.05, 8.7, z], color: 0xffcf8a, size: 1.1, intensity: 0.7 });
    for (let z = -24; z < 14; z += 4) lights.push({ id: 'win', pos: [s * 7.35, 11.6, z], color: 0xffcf8a, size: 1.0, intensity: 0.6 });
  }
  return { near, far, form, halfLength: L / 2 - 9, radius: 9, lights };
}

// ---------------------------------------------------------------------------------------------- cutter
function cutterStripeTexture() {
  const c = makeCanvas(512, 256);
  const g = c.getContext('2d');
  g.clearRect(0, 0, 512, 256);
  // The Coast Guard "racing stripe": a wide red-orange bar and a narrow blue bar, slanted forward.
  g.save();
  g.translate(256, 128);
  g.transform(1, 0, -0.55, 1, 0, 0);
  g.fillStyle = '#e04a2f';
  g.fillRect(-150, -128, 140, 256);
  g.fillStyle = '#1f3d7a';
  g.fillRect(10, -128, 40, 256);
  g.restore();
  return canvasTexture(c, { srgb: true, aniso: 4 });
}

export function buildCutter(ctx) {
  const L = 86;
  const form = createHullForm({
    length: L,
    beam: 15,
    sheerStern: 5.2,
    sheerRise: 1.2,
    sheerBow: 2.6,
    sheerPow: 2.6,
    keel: -4.2,
    forefoot: -1.0,
    forefootEnd: 0.22,
    keelStern: -2.2,
    runStart: 0.72,
    maxBeamAt: 0.5,
    entryPow: 2.0,
    sternBeam: 0.85,
    flareBow: 0.32,
    flareMid: 0.04,
    vBow: 0.34,
    bilge: 0.3,
    rake: 5,
    rakeLen: 0.16,
    transomRake: 0.5,
    deckAft: 5.0,
    deckFwd: 6.2,
    focsleEnd: 0.3,
    bowBulwark: 1.0,
  });
  const mats = fleetMaterials(ctx);
  const near = new THREE.Group();
  const b = createBuilder();
  const white = '#f1f0ec';
  const grey = '#8d9496';
  const [shell, transom] = paintedShell(form, { hull: white, stripe: white, stripeW: 0.1, stations: 48, rows: 14, bootLo: 0.3, bootHi: 1.0, bottom: '#7a2a22', boot: '#141618' });
  b.add('body', shell, { uvScale: 0.6 });
  b.add('body', transom, { uvScale: 0.6 });
  b.add('body', buildDecks(form, { stations: 24 }), { color: grey, uvScale: 1 });
  // Superstructure, bridge, mast with radar domes, hangar and flight deck aft.
  b.add('body', shapes.rbox(11, 4.2, 26, 0.15), { p: [0, 7.2, -8], color: white });
  b.add('body', shapes.rbox(9.5, 3.0, 9, 0.15), { p: [0, 10.8, -15], color: white });
  b.add('body', shapes.box(13.5, 0.3, 3), { p: [0, 12.3, -18.5], color: white });
  b.add('body', shapes.rbox(8.5, 4.5, 10, 0.12), { p: [0, 7.3, 11], color: white });
  b.add('body', shapes.box(13, 0.2, 22), { p: [0, 5.15, 28], color: '#5c6366' });
  addTube(b, 'body', [0, 12.3, -10], [0, 26, -10], 0.35, { radiusB: 0.2, color: grey, open: false });
  addTube(b, 'body', [-3, 21, -10], [3, 21, -10], 0.15, { color: grey });
  b.add('body', shapes.sphere(1.0, 12, 8), { p: [-2.5, 21.9, -10], color: white });
  b.add('body', shapes.sphere(0.7, 12, 8), { p: [2.5, 21.6, -10], color: white });
  b.add('body', shapes.rbox(2.6, 4, 3.6, 0.5), { p: [0, 11.3, -1], color: white });
  b.add('body', shapes.rbox(2.6, 1.1, 5.8, 0.5, 2), { p: [6.4, 8.9, 2], color: C.orange });
  b.add('body', shapes.box(0.2, 2.4, 0.2), { p: [5.4, 10.3, 0], color: grey });
  // Bow gun mount.
  b.add('body', shapes.rbox(1.6, 1.2, 2.2, 0.3), { p: [0, form.deckAt(0.18) + 0.6, form.zOfT(0.18)], color: grey });
  addTube(b, 'body', [0, form.deckAt(0.18) + 0.8, form.zOfT(0.18) - 1], [0, form.deckAt(0.18) + 1.1, form.zOfT(0.18) - 3.2], 0.09, { color: grey });
  const gB = createBuilder();
  gB.add('g', shapes.box(8.5, 1.2, 0.04), { p: [0, 11.3, -19.52] });
  for (const side of [-1, 1]) gB.add('g', shapes.box(0.04, 1.1, 7.5), { p: [side * 4.76, 11.3, -15] });
  const body = new THREE.Mesh(b.build('body'), mats.paint);
  body.castShadow = true;
  body.receiveShadow = true;
  near.add(body, new THREE.Mesh(gB.build('g'), mats.glass));
  const stripeMat = decalMaterial(cutterStripeTexture());
  near.add(new THREE.Mesh(mergeGeometries([hullDecal(form, -1, 0.2, 2.8, 9, 5.6), hullDecal(form, 1, 0.2, 2.8, 9, 5.6)]), stripeMat));
  const cgTex = createNameTexture('COAST GUARD', { color: '#141618', width: 1024, height: 128, font: "'Helvetica Neue', Helvetica, Arial, sans-serif" });
  near.add(new THREE.Mesh(mergeGeometries([hullDecal(form, -1, 0.45, 3.4, 20, 1.9), hullDecal(form, 1, 0.45, 3.4, 20, 1.9)]), decalMaterial(cgTex)));
  const numTex = createNameTexture('39', { color: '#141618', width: 256, height: 256 });
  near.add(new THREE.Mesh(mergeGeometries([hullDecal(form, -1, 0.07, form.sheer(0.07) - 2.2, 4.5, 3.4), hullDecal(form, 1, 0.07, form.sheer(0.07) - 2.2, 4.5, 3.4)]), decalMaterial(numTex)));

  const f = createBuilder();
  const [s2, t2] = paintedShell(form, { hull: white, stripe: white, stripeW: 0.1, stations: 16, rows: 6, bootLo: 0.3, bootHi: 1.0 });
  f.add('far', s2);
  f.add('far', t2);
  f.add('far', shapes.box(11, 4.2, 26), { p: [0, 7.2, -8], color: white });
  f.add('far', shapes.box(9.5, 3, 9), { p: [0, 10.8, -15], color: white });
  f.add('far', shapes.box(8.5, 4.5, 10), { p: [0, 7.3, 11], color: white });
  f.add('far', shapes.cyl(0.3, 0.2, 14, 5), { p: [0, 19, -10], color: grey });
  f.add('far', shapes.box(0.2, 3, 7), { p: [-7.3, 3, -26], r: [0, 0, 0], color: '#e04a2f' });
  f.add('far', shapes.box(0.2, 3, 7), { p: [7.3, 3, -26], color: '#e04a2f' });
  const far = new THREE.Mesh(f.build('far'), mats.far);
  return {
    near,
    far,
    form,
    halfLength: L / 2 - 7.5,
    radius: 7.5,
    lights: [
      { id: 'masthead', pos: [0, 26.3, -10], color: 0xfff2dc, size: 1.2, intensity: 1.8, arc: ARCS.masthead },
      { id: 'port', pos: [-6.8, 12.5, -18.5], color: 0xff2a1a, size: 1.0, intensity: 1.8, arc: ARCS.port },
      { id: 'starboard', pos: [6.8, 12.5, -18.5], color: 0x2aff7a, size: 1.0, intensity: 1.6, arc: ARCS.starboard },
      { id: 'stern', pos: [0, 6.5, L / 2 + 0.4], color: 0xfff2dc, size: 0.9, intensity: 1.6, arc: ARCS.stern },
      { id: 'deck', pos: [0, 10, 18], color: 0xffe6b8, size: 1.8, intensity: 1.4 },
    ],
  };
}

export { lowerLOD };
