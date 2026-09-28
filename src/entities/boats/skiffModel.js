// Aluminium seine skiff (~19 ft x 9.5 ft): beamy open hull with a rubber-fendered gunwale, a big inboard under an
// engine box, a steering console, the tall towing bitt the seine and towlines make fast to, an exhaust stack and an
// all-round light. Local frame: bow toward -z, origin on the waterline amidships.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { patchUnderwater } from '../../render/shaderChunks.js';
import { createBuilder, shapes, addTube } from './builder.js';
import { createHullForm, buildShell, buildTransom, buildOccluder } from './hull.js';
import { createCrewman } from './crew.js';
import { createAluminiumTexture } from './textures.js';
import { seinerMaterials, C } from './seinerModel.js';
import { createSeaPlane, patchWaterline } from './waterline.js';

export const SKIFF_FORM = Object.freeze({
  length: 5.8,
  beam: 3.05,
  sheerStern: 0.8,
  sheerRise: 0.16,
  sheerBow: 0.46,
  sheerPow: 2.4,
  keel: -0.34,
  forefoot: 0.12,
  forefootEnd: 0.32,
  keelStern: -0.3,
  runStart: 0.85,
  maxBeamAt: 0.42,
  entryPow: 3.6,
  sternBeam: 0.97,
  flareBow: 0.34,
  flareMid: 0.14,
  vBow: 0.3,
  bilge: 0.1,
  rake: 0.55,
  rakeLen: 0.3,
  transomRake: 0.12,
  deckAft: -0.12,
  deckFwd: -0.12,
  focsleEnd: 0,
  bowBulwark: 10,
});

let alloyMat = null;
export const skiffSea = createSeaPlane();
function alloy(ctx) {
  if (alloyMat) return alloyMat;
  // Bare welded aluminium: brushed plate with seams, scuffs and oxide blooms. Weathered marine alloy is mostly a
  // matte oxide, so it keeps a diffuse base: a fully metallic hull would mirror the dark lower sky and read as a black
  // tub from the side.
  alloyMat = new THREE.MeshStandardMaterial({
    map: createAluminiumTexture(),
    color: 0xf6f8f9,
    vertexColors: true,
    metalness: 0.32,
    roughness: 0.46,
    envMapIntensity: 1.1,
    side: THREE.DoubleSide,
  });
  patchWaterline(patchUnderwater(alloyMat, ctx.uniforms), skiffSea);
  return alloyMat;
}

// detail: 'full' (player's skiff: separate parts + skiffman) | 'low' (fleet: one merged mesh, no figure).
export function buildSkiffModel(ctx, { detail = 'full', stripe = '#b3342a' } = {}) {
  const form = createHullForm(SKIFF_FORM);
  const mats = seinerMaterials(ctx);
  const group = new THREE.Group();
  group.name = detail === 'full' ? 'skiff' : 'fleet-skiff';
  const b = createBuilder();
  const bare = detail === 'full' ? [1, 1, 1] : [0.76, 0.78, 0.8];
  const paintBand = (t, y, sh) => (y > sh - 0.16 && y < sh - 0.06 ? hexRGB(stripe) : bare);
  const shell = buildShell(form, { stations: detail === 'full' ? 30 : 14, rows: detail === 'full' ? 10 : 5, bandSheer: [0.06, 0.16], paint: paintBand });
  const transom = buildTransom(form, { rows: detail === 'full' ? 10 : 5, bandSheer: [0.06, 0.16], paint: paintBand });
  b.add('alloy', shell, { uv: 'box', uvScale: 0.8 });
  b.add('alloy', transom, { uv: 'box', uvScale: 0.8 });
  const L = form.L;
  const sole = -0.12;
  // Floor.
  {
    const pts = [];
    for (let i = 0; i <= 12; i++) {
      const t = 0.06 + (0.93 * i) / 12;
      pts.push([form.halfWidthAt(t, sole) - 0.04, form.zOfT(t)]);
    }
    const shape = new THREE.Shape();
    pts.forEach(([x, z], i) => (i ? shape.lineTo(x, -z) : shape.moveTo(x, -z)));
    for (let i = pts.length - 1; i >= 0; i--) shape.lineTo(-pts[i][0], -pts[i][1]);
    shape.closePath();
    const g = new THREE.ShapeGeometry(shape);
    g.rotateX(-Math.PI / 2);
    g.translate(0, sole, 0);
    b.add('alloy', g, { color: '#9da2a5', uvScale: 1 });
  }
  // Rubber fender strake along the gunwale.
  const gun = [];
  for (let i = 0; i <= 24; i++) {
    const t = 0.01 + (0.985 * i) / 24;
    gun.push([form.halfWidthAt(t, form.sheer(t)) + 0.03, form.sheer(t) - 0.02, form.zOfT(t) + form.zShift(t, 1)]);
  }
  for (const side of [-1, 1]) {
    for (let i = 0; i < gun.length - 1; i++) {
      addTube(b, 'rough', [side * gun[i][0], gun[i][1], gun[i][2]], [side * gun[i + 1][0], gun[i + 1][1], gun[i + 1][2]], 0.075, { color: C.rubber, seg: 6, open: false });
    }
  }
  addTube(b, 'rough', [-gun[24][0], gun[24][1], gun[24][2] + 0.02], [gun[24][0], gun[24][1], gun[24][2] + 0.02], 0.075, { color: C.rubber, seg: 6, open: false });
  // Push knee: a rubber-faced bumper down the stem for shoving the net and nosing onto beaches.
  {
    const top = [0, form.sheer(0.004) - 0.02, form.zOfT(0.004) + form.zShift(0.004, 1) - 0.06];
    const bot = [0, 0.12, form.zOfT(0.02) + form.zShift(0.02, clamp01((0.12 - form.keel(0.02)) / (form.sheer(0.02) - form.keel(0.02)))) - 0.05];
    addTube(b, 'rough', top, bot, 0.1, { color: C.rubber, seg: 8, open: false });
  }
  // Engine box, console and wheel.
  b.add('alloy', shapes.rbox(1.05, 0.72, 1.45, 0.05), { p: [0, sole + 0.36, 0.95], color: '#d9dcdd' });
  b.add('paint', shapes.box(0.95, 0.03, 1.35), { p: [0, sole + 0.735, 0.95], color: C.dark });
  b.add('alloy', shapes.rbox(0.55, 0.95, 0.45, 0.04), { p: [0.75, sole + 0.47, -0.3], color: '#d4d7d8' });
  b.add('metal', shapes.torus(0.17, 0.014, 5, 16), { p: [0.75, sole + 0.98, -0.02], r: [-0.5, 0, 0], color: C.galv });
  b.add('paint', shapes.sphere(0.03, 6, 4), { p: [0.92, sole + 1.0, -0.2], color: C.red });
  // Towing bitt: an H of heavy pipe aft of the engine box, where the seine and towlines make fast.
  const bittZ = 1.95;
  for (const x of [-0.25, 0.25]) b.add('paint', shapes.cyl(0.075, 0.08, 1.35, 10), { p: [x, sole + 0.67, bittZ], color: '#e2b529' });
  b.add('paint', shapes.cyl(0.06, 0.06, 0.8, 10), { p: [0, sole + 1.2, bittZ], r: [0, 0, Math.PI / 2], color: '#e2b529' });
  // Exhaust stack.
  b.add('paint', shapes.cyl(0.07, 0.07, 1.6, 10), { p: [-0.35, sole + 1.3, 1.25], color: C.dark });
  b.add('rough', shapes.cyl(0.075, 0.075, 0.25, 10, true), { p: [-0.35, sole + 2.0, 1.25], color: C.black });
  // All-round light on a short pole at the bow.
  b.add('metal', shapes.cyl(0.02, 0.02, 1.0, 6), { p: [0, form.sheer(0.12) + 0.45, form.zOfT(0.12)], color: C.galv });
  b.add('lamp', shapes.cyl(0.04, 0.04, 0.08, 8), { p: [0, form.sheer(0.12) + 0.98, form.zOfT(0.12)], color: [1, 0.97, 0.9] });
  // Thwart and cleats.
  b.add('alloy', shapes.box(form.halfWidthAt(0.3, 0.35) * 2 - 0.1, 0.05, 0.3), { p: [0, 0.35, form.zOfT(0.3)], color: '#b9bec1' });

  const out = { group, form, points: {}, occluder: null, crew: null, parts: {} };
  if (detail === 'full') {
    const mk = (bucket, mat, cast = true) => {
      const g = b.build(bucket);
      if (!g) return null;
      const m = new THREE.Mesh(g, mat);
      m.castShadow = cast;
      m.receiveShadow = true;
      m.name = `skiff-${bucket}`;
      group.add(m);
      return m;
    };
    mk('alloy', alloy(ctx));
    mk('rough', mats.rough);
    mk('paint', mats.paint);
    mk('metal', mats.metal);
    out.parts.lamp = mk('lamp', mats.lamp, false);
    const skiffman = createCrewman({ hat: '#2f4a2c', phase: 1.3, name: 'skiffman', hood: false });
    skiffman.mesh.position.set(0.72, sole, 0.28);
    group.add(skiffman.mesh);
    out.crew = skiffman;
    const occ = new THREE.Mesh(buildOccluder(form, { stations: 16, inset: 0.05, topY: (t) => form.sheer(t) - 0.04 }), new THREE.MeshBasicMaterial({ colorWrite: false }));
    occ.visible = false;
    occ.name = 'skiff-occluder';
    group.add(occ);
    out.occluder = occ;
  } else {
    const list = ['alloy', 'rough', 'paint', 'metal', 'lamp'].map((k) => b.build(k)).filter(Boolean);
    const g = mergeGeometries(list);
    const m = new THREE.Mesh(g, alloyVertexMaterial(ctx));
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    out.parts.mesh = m;
  }
  out.points = {
    bitt: new THREE.Vector3(0, sole + 1.2, bittZ),
    netEnd: new THREE.Vector3(0, 0.1, L / 2),
    helm: new THREE.Vector3(0.72, sole, 0.28),
    seat: new THREE.Vector3(-0.4, sole, -0.6),
    stack: new THREE.Vector3(-0.35, sole + 2.15, 1.25),
    light: new THREE.Vector3(0, form.sheer(0.12) + 1.0, form.zOfT(0.12)),
    bow: new THREE.Vector3(0, form.sheer(0), -L / 2),
    stern: new THREE.Vector3(0, 0.2, L / 2),
  };
  return out;
}

// For merged low-detail skiffs: alloy look with vertex colours for the rubber/paint parts.
let lowMat = null;
export function alloyVertexMaterial(ctx) {
  if (lowMat) return lowMat;
  lowMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.3, roughness: 0.5, side: THREE.DoubleSide });
  patchUnderwater(lowMat, ctx.uniforms);
  return lowMat;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function hexRGB(hex) {
  const c = new THREE.Color(hex);
  const s = c.clone().convertLinearToSRGB();
  return [s.r, s.g, s.b];
}
