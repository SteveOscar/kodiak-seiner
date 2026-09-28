// The hero asset: a 58-foot Alaska limit seiner, built procedurally in the boat's local frame (bow toward -z,
// origin on the design waterline amidships, metres). Parts are merged per material; animated pieces (radar, power
// block sheave, flags, seine pile, crew) stay separate.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { patchUnderwater } from '../../render/shaderChunks.js';
import { createBuilder, shapes, addTube, addRope } from './builder.js';
import { createHullForm, buildShell, buildTransom, buildBulwarks, buildDecks, buildOccluder } from './hull.js';
import { createHullAtlas, createDeckTexture, createGrimeTexture, createWebTexture, createFlagTexture } from './textures.js';
import { createCrewman } from './crew.js';
import { mulberry32 } from '../../core/rng.js';
import { createSeaPlane, patchWaterline } from './waterline.js';
import { ARCS } from './fx.js';

export const C = {
  white: '#ecebe4',
  white2: '#dcdad2',
  navy: '#1c3152',
  red: '#b3342a',
  dark: '#2a2d30',
  grey: '#5f666c',
  steel: '#8b9196',
  galv: '#a9ada9',
  black: '#141617',
  orange: '#e8561c',
  wood: '#8a5836',
  canvas: '#1d2c44',
  yellow: '#e3b22a',
  corkWhite: '#e6e2d6',
  brass: '#b08d57',
  rubber: '#1b1c1d',
};

// Shared materials (one set per session).
let MATS = null;
export function seinerMaterials(ctx) {
  if (MATS) return MATS;
  const grime = createGrimeTexture();
  const u = ctx.uniforms;
  const paint = new THREE.MeshStandardMaterial({ map: grime, vertexColors: true, roughness: 0.48, metalness: 0.04 });
  const rough = new THREE.MeshStandardMaterial({ map: grime, vertexColors: true, roughness: 0.86, metalness: 0 });
  const metal = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.85 });
  // Dielectric glass (F0 ~0.04): dark head-on, mirroring the sky at grazing angles. A metallic near-black base would
  // kill the Fresnel reflection and read as flat black.
  const glass = new THREE.MeshStandardMaterial({
    color: 0x1b2833,
    roughness: 0.05,
    metalness: 0.1,
    emissive: new THREE.Color('#ffb35e'),
    emissiveIntensity: 0,
    envMapIntensity: 3.6,
  });
  const glassCabin = glass.clone();
  glassCabin.emissive = new THREE.Color('#ffc27a');
  const lamp = new THREE.MeshBasicMaterial({ vertexColors: true });
  const rig = new THREE.MeshStandardMaterial({ color: 0x1e2022, roughness: 0.7 });
  // One sea level shared by the seiner and its skiff parts (level only; see waterline.js).
  const sea = createSeaPlane();
  for (const m of [paint, rough, metal]) patchWaterline(patchUnderwater(m, u), sea);
  MATS = { paint, rough, metal, glass, glassCabin, lamp, rig, grime, sea };
  return MATS;
}

// Flag cloth that ripples in the wind (vertex displacement, amplitude grows from the hoist).
function flagMaterial(ctx, texture) {
  const mat = new THREE.MeshStandardMaterial({ map: texture, side: THREE.DoubleSide, roughness: 0.85 });
  const uniforms = { uFlagTime: ctx.uniforms.uTime, uFlagWind: { value: 6 } };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uFlagTime;\nuniform float uFlagWind;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          float k = uv.x;
          float w = 0.35 + 0.06 * uFlagWind;
          transformed.z += k * (sin(uv.x * 7.0 - uFlagTime * w * 2.2) * 0.07 + sin(uv.x * 13.0 + uv.y * 3.0 - uFlagTime * w * 3.7) * 0.025);
          transformed.y -= k * k * 0.06 * (1.0 - clamp(uFlagWind / 10.0, 0.0, 1.0));
        }`,
      );
  };
  mat.customProgramCacheKey = () => 'kodiak-flag';
  mat.userData.uniforms = uniforms;
  return mat;
}

// Seine pile: a heaped mound of dark web on the stern deck with the corkline flaked along the starboard side and
// the leadline and purse rings along the port side. Local y = 0 is the deck; scale.y follows how much net is aboard.
function buildPile(form, mats, webTex, rnd) {
  const group = new THREE.Group();
  group.name = 'seine-pile';
  const z0 = 4.2;
  const z1 = 8.7;
  const nx = 24;
  const nz = 30;
  const H = 1.3;
  const hash = (i, j) => {
    const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const heightAt = (x, z, halfW) => {
    const ex = 1 - Math.pow(Math.abs(x) / halfW, 3);
    const ez = Math.min(1, (z - z0) / 1.1) * Math.min(1, (z1 - z) / 0.35);
    const edge = Math.max(0, ex) * Math.max(0, ez);
    const folds = 0.08 * Math.sin(z * 12.5 + Math.sin(x * 1.7) * 1.4) + 0.05 * Math.sin(x * 4.1 + z * 2.3);
    const lump = 0.1 * (hash(Math.round(x * 2.5), Math.round(z * 2.5)) - 0.5);
    // Peaks toward the stern where the skiff rests.
    const aft = 0.85 + 0.25 * ((z - z0) / (z1 - z0));
    return Math.max(0, H * Math.pow(edge, 0.55) * aft * (1 + folds + lump));
  };
  const positions = [];
  const uvs = [];
  const idx = [];
  for (let j = 0; j <= nz; j++) {
    const z = z0 + (z1 - z0) * (j / nz);
    const halfW = form.halfWidthAt(form.tOfZ(z), form.P.deckAft + 0.3) - 0.12;
    for (let i = 0; i <= nx; i++) {
      const x = -halfW + 2 * halfW * (i / nx);
      positions.push(x, heightAt(x, z, halfW) + 0.01, z);
      uvs.push(x * 0.9, z * 0.9);
    }
  }
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      const b = a + nx + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const web = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: webTex, roughness: 0.92, color: 0xb8c4b4 }));
  web.castShadow = true;
  web.receiveShadow = true;
  web.name = 'pile-web';
  group.add(web);

  // Corks and rings.
  const b = createBuilder();
  // Seine corks are threaded on the corkline through their long axis (~20 x 14 cm foam floats).
  const cork = new THREE.CapsuleGeometry(0.068, 0.07, 2, 8);
  cork.rotateX(Math.PI / 2);
  // The corkline is stacked the way a deckhand flakes it off the block: long fore-and-aft folds laid side by side
  // along the starboard side of the pile, each turning back at the ends, three tiers deep. From the crow's nest it
  // reads as a tidy yellow ridge beside the skiff, with the odd faded or white marker cork.
  const tones = [C.yellow, '#d9a526', '#ebbd3a', '#c99a2a'];
  const spacing = 0.19;
  const dx = 0.155;
  let n = 0;
  const addCork = (x, z, layer, yaw, lift = 0) => {
    const halfW = form.halfWidthAt(form.tOfZ(z), form.P.deckAft + 0.3) - 0.12;
    if (x > halfW - 0.1 || z < z0 + 0.25 || z > z1 - 0.15) return;
    const y = heightAt(x, z, halfW) + 0.06 + layer * 0.115 + lift + (rnd() - 0.5) * 0.025;
    const marker = n++ % 29 === 0;
    const color = marker ? C.corkWhite : tones[Math.floor(rnd() * tones.length)];
    b.add('cork', cork, { p: [x, y, z], r: [(rnd() - 0.5) * 0.25, yaw + (rnd() - 0.5) * 0.3, rnd() * 3], color, uvScale: 2 });
  };
  for (let layer = 0; layer < 3; layer++) {
    const folds = 9 - layer;
    const xStart = 1.02 + layer * dx * 0.5;
    const za = z0 + 0.45 + layer * 0.12;
    const zb = z1 - 0.3 - layer * 0.1;
    for (let f = 0; f < folds; f++) {
      const x = xStart + f * dx + (rnd() - 0.5) * 0.02;
      // Folds are hand-laid: their ends wander, the middle of the stack crowns a little and each fold snakes.
      const fa = za + rnd() * 0.3;
      const fb = zb - rnd() * 0.3;
      const crown = Math.sin((Math.PI * (f + 0.5)) / folds) * 0.05;
      const wave = 0.02 + rnd() * 0.03;
      const phase = rnd() * 6;
      const count = Math.floor((fb - fa) / spacing);
      for (let k = 0; k <= count; k++) {
        const z = fa + k * spacing + (rnd() - 0.5) * 0.04;
        addCork(x + Math.sin(z * 2.3 + phase) * wave + (rnd() - 0.5) * 0.025, z, layer, Math.cos(z * 2.3 + phase) * wave * 2, crown);
      }
      // The bight where the line doubles back to the next fold.
      if (f < folds - 1) {
        const zEnd = f % 2 ? fa - 0.1 : fb + 0.1;
        addCork(x + dx * 0.5, zEnd, layer, Math.PI / 2, crown);
      }
    }
  }
  for (let z = z0 + 0.7; z < z1 - 0.4; z += 0.32) {
    const x = -1.35 - rnd() * 0.5;
    const halfW = form.halfWidthAt(form.tOfZ(z), form.P.deckAft + 0.3) - 0.12;
    const y = heightAt(x, z, halfW) + 0.04;
    b.add('rings', shapes.torus(0.1, 0.018, 6, 14), { p: [x, y, z], r: [Math.PI / 2 + (rnd() - 0.5) * 0.8, 0, rnd()], color: C.brass });
    b.add('lead', shapes.cyl(0.035, 0.035, 0.34, 6), { p: [x - 0.25, y - 0.02, z + 0.1], r: [Math.PI / 2, 0, 0], color: '#2c2d2f' });
  }
  const corks = new THREE.Mesh(b.build('cork'), mats.rough);
  corks.castShadow = true;
  corks.name = 'pile-corks';
  const lead = new THREE.Mesh(mergeGeometries([b.build('rings'), b.build('lead')].filter(Boolean)), mats.metal);
  lead.castShadow = true;
  lead.name = 'pile-leadline';
  group.add(corks, lead);
  group.userData.heightAt = heightAt;
  return group;
}

// Galvanized plow (CQR-style) anchor stowed on a bow roller: the shank lies in the roller chute from `heel` (aft) to
// `head` (forward), and the ploughshare hangs from the head, tip down, ahead of the stem.
function plowAnchor(b, heel, head) {
  // Weathered hot-dip galvanizing: a dull mid grey, darker than fresh zinc so it doesn't flare in low sun.
  const galv = '#8f9391';
  addTube(b, 'paint', heel, head, 0.04, { color: galv, seg: 6, open: false });
  b.add('paint', shapes.cyl(0.065, 0.065, 0.07, 10), { p: heel, r: [0, 0, Math.PI / 2], color: galv });
  const share = new THREE.Shape();
  share.moveTo(0, 0);
  share.lineTo(0.17, 0.3);
  share.quadraticCurveTo(0.09, 0.42, 0, 0.48);
  share.closePath();
  const plate = new THREE.ExtrudeGeometry(share, { depth: 0.02, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 1, curveSegments: 4 });
  // Two plates in a V, keel forward, wings swept aft, tucked against the stem under the roller. Mirroring would flip
  // the winding, so the port plate is the starboard plate rotated half a turn about the vertical.
  for (const yaw of [-0.7, Math.PI + 0.7]) {
    const g = plate.clone();
    g.rotateY(yaw);
    g.rotateX(0.22);
    b.add('paint', g, { p: [head[0], head[1] - 0.5, head[2] + 0.12], color: '#848886' });
  }
}

// A flat quad on a (possibly tilted) wall. corners: [a, b, c, d] counter-clockwise seen from outside.
function quad(corners, uv = [[0, 0], [1, 0], [1, 1], [0, 1]]) {
  const g = new THREE.BufferGeometry();
  const p = corners.flat();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv.flat(), 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.computeVertexNormals();
  return g;
}

// Wheelhouse with a reverse-raked front (top leans forward): 8 corners, flat-shaded.
function wheelhouseGeometry(W) {
  const { y0, y1, zf0, zf1, zb, hw0, hw1 } = W;
  const v = {
    fbl: [-hw0, y0, zf0], fbr: [hw0, y0, zf0], ftl: [-hw1, y1, zf1], ftr: [hw1, y1, zf1],
    bbl: [-hw0, y0, zb], bbr: [hw0, y0, zb], btl: [-hw1, y1, zb], btr: [hw1, y1, zb],
  };
  const faces = [
    [v.fbl, v.fbr, v.ftr, v.ftl], // front (faces -z)... wound below
    [v.bbl, v.bbr, v.btr, v.btl], // back
    [v.fbl, v.bbl, v.btl, v.ftl], // port
    [v.bbr, v.fbr, v.ftr, v.btr], // starboard
    [v.btl, v.btr, v.ftr, v.ftl], // top
  ];
  const geos = faces.map((f, i) => {
    // Front face must face -z: reverse its winding.
    const q = i === 0 ? quad([f[1], f[0], f[3], f[2]]) : quad(f);
    return q;
  });
  return mergeGeometries(geos.map((g) => g.toNonIndexed()));
}

// Point on the wheelhouse front face at (x fraction -1..1, height y).
function frontPoint(W, xf, y, out = 0.012) {
  const k = (y - W.y0) / (W.y1 - W.y0);
  const z = W.zf0 + (W.zf1 - W.zf0) * k;
  const hw = W.hw0 + (W.hw1 - W.hw0) * k;
  // Outward normal of the reversed-rake face points forward and slightly down.
  const nz = -(W.y1 - W.y0);
  const ny = -(W.zf0 - W.zf1);
  const len = Math.hypot(nz, ny);
  return [xf * hw, y + (ny / len) * out, z + (nz / len) * out];
}

function sidePoint(W, side, z, y, out = 0.012) {
  const k = (y - W.y0) / (W.y1 - W.y0);
  const hw = W.hw0 + (W.hw1 - W.hw0) * k;
  return [side * (hw + out), y, z];
}

export function buildSeinerModel(ctx, { name = 'Northern Dawn', style = {} } = {}) {
  const form = createHullForm(style.form);
  const P = form.P;
  const mats = seinerMaterials(ctx);
  const rnd = mulberry32(58);
  const group = new THREE.Group();
  group.name = 'seiner';
  const b = createBuilder();
  const deckY = P.deckAft;

  // ---------------------------------------------------------------- hull
  const atlas = createHullAtlas(form, { name, ...style.atlas });
  const hullMat = new THREE.MeshStandardMaterial({
    map: atlas.texture,
    roughnessMap: atlas.roughness,
    bumpMap: atlas.bump,
    bumpScale: 1.2,
    roughness: 1,
    metalness: 0.05,
    envMapIntensity: 0.9,
  });
  const hullSea = createSeaPlane();
  patchWaterline(patchUnderwater(hullMat, ctx.uniforms), hullSea);
  const shell = buildShell(form, { stations: 64, rows: 24 });
  const transom = buildTransom(form, { rows: 24, uvRect: [0, 0, 0.5, 0.25] });
  // Name board on the fascia under the flying bridge.
  const board = quad(
    [[-1.5, 5.54, -5.225], [1.5, 5.54, -5.225], [1.5, 5.9, -5.225], [-1.5, 5.9, -5.225]].map((p) => p),
    [[1, 0], [0.5, 0], [0.5, 0.25], [1, 0.25]],
  );
  // quad() winds CCW seen from +z; the board faces -z, so flip.
  board.index.array.set([0, 2, 1, 0, 3, 2]);
  board.computeVertexNormals();
  for (const g of [shell, transom, board]) {
    if (!g.attributes.color) g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 3).fill(1), 3));
  }
  const hull = new THREE.Mesh(mergeGeometries([shell, transom, board]), hullMat);
  hull.castShadow = true;
  hull.receiveShadow = true;
  hull.name = 'hull';
  group.add(hull);

  // Skeg, rudder and wheel (underwater).
  b.add('paint', shapes.box(0.22, 0.7, 5.5), { p: [0, P.keel - 0.25, 3.2], color: C.red });
  b.add('paint', shapes.box(0.08, 1.3, 1.0), { p: [0, -1.25, 8.2], color: C.red });
  b.add('metal', shapes.cyl(0.55, 0.55, 0.1, 5), { p: [0, -1.3, 7.45], r: [Math.PI / 2, 0, 0], color: C.brass });

  // Bulwarks and cap rail.
  const bw = buildBulwarks(form, { stations: 48, thickness: 0.1, capWidth: 0.2 });
  b.add('paint', bw.inner, { color: C.white2, uvScale: 0.6 });
  b.add('paint', bw.cap, { color: C.wood, uvScale: 1.5 });

  // Decks.
  const deckTex = createDeckTexture(form);
  const deckMat = new THREE.MeshStandardMaterial({ map: deckTex, roughness: 0.8, metalness: 0.05 });
  const deck = new THREE.Mesh(buildDecks(form, { stations: 44, thickness: 0.1 }), deckMat);
  deck.receiveShadow = true;
  deck.name = 'deck';
  group.add(deck);

  // ------------------------------------------------------------- house
  const houseZ0 = -5.0;
  const houseZ1 = 0.55;
  const houseTop = 3.55;
  const planPts = [
    [-1.55, houseZ0], [1.55, houseZ0], [1.98, houseZ0 + 0.75], [2.0, houseZ1], [-2.0, houseZ1], [-1.98, houseZ0 + 0.75],
  ];
  {
    const shape = new THREE.Shape();
    planPts.forEach(([x, z], i) => (i ? shape.lineTo(x, -z) : shape.moveTo(x, -z)));
    shape.closePath();
    const bev = 0.06;
    const g = new THREE.ExtrudeGeometry(shape, { depth: houseTop - 1.0 - 2 * bev, bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelSegments: 2, curveSegments: 2 });
    g.rotateX(-Math.PI / 2);
    g.translate(0, 1.0 + bev, 0);
    b.add('paint', g, { color: C.white, uvScale: 0.5 });
  }
  // Rub rail / drip strip around the house top edge.
  b.add('paint', shapes.box(4.06, 0.06, houseZ1 - houseZ0 - 0.7), { p: [0, houseTop - 0.02, (houseZ0 + 0.7 + houseZ1) / 2], color: C.navy });

  // Portholes along the house sides (lit at night).
  for (const side of [-1, 1]) {
    for (const z of [-3.55, -2.2, -0.85]) {
      b.add('metal', shapes.torus(0.16, 0.028, 6, 18), { p: [side * 2.07, 2.62, z], r: [0, Math.PI / 2, 0], color: C.galv });
      b.add('glassCabin', shapes.cyl(0.145, 0.145, 0.02, 16), { p: [side * 2.06, 2.62, z], r: [0, 0, Math.PI / 2] });
    }
  }
  // Aft door and window.
  b.add('paint', shapes.rbox(0.78, 1.85, 0.07, 0.03), { p: [0.75, deckY + 0.95, houseZ1 + 0.04], color: C.grey });
  b.add('glassCabin', shapes.cyl(0.13, 0.13, 0.02, 14), { p: [0.75, deckY + 1.45, houseZ1 + 0.085], r: [Math.PI / 2, 0, 0] });
  b.add('metal', shapes.torus(0.14, 0.022, 6, 16), { p: [0.75, deckY + 1.45, houseZ1 + 0.085], color: C.galv });
  b.add('metal', shapes.box(0.04, 0.2, 0.06), { p: [1.05, deckY + 0.95, houseZ1 + 0.1], color: C.galv });
  b.add('glassCabin', shapes.box(0.7, 0.5, 0.02), { p: [-0.95, deckY + 1.55, houseZ1 + 0.075] });
  b.add('paint', shapes.box(0.8, 0.06, 0.05), { p: [-0.95, deckY + 1.27, houseZ1 + 0.08], color: C.white2 });
  // Life ring beside the door.
  b.add('rough', shapes.torus(0.33, 0.07, 8, 20), { p: [-0.95, deckY + 0.75, houseZ1 + 0.1], color: C.orange });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    b.add('rough', shapes.box(0.16, 0.15, 0.16), { p: [-0.95 + Math.cos(a) * 0.33, deckY + 0.75 + Math.sin(a) * 0.33, houseZ1 + 0.1], r: [0, 0, a], color: C.white });
  }
  // Grab rails along the house sides.
  for (const side of [-1, 1]) addTube(b, 'metal', [side * 2.08, 3.15, -4.0], [side * 2.08, 3.15, 0.3], 0.022, { color: C.galv });
  // Ladder to the house top (starboard aft).
  for (const x of [1.45, 1.85]) addTube(b, 'metal', [x, deckY, houseZ1 + 0.18], [x, houseTop + 0.7, houseZ1 + 0.1], 0.025, { color: C.galv });
  for (let y = deckY + 0.3; y < houseTop + 0.4; y += 0.3) addTube(b, 'metal', [1.45, y, houseZ1 + 0.17], [1.85, y, houseZ1 + 0.17], 0.018, { color: C.galv });

  // ---------------------------------------------------------- wheelhouse
  const W = { y0: houseTop, y1: 5.55, zf0: -4.45, zf1: -4.92, zb: -0.85, hw0: 1.9, hw1: 1.82 };
  b.add('paint', wheelhouseGeometry(W), { color: C.white, uvScale: 0.5 });
  // Corner posts soften the box.
  for (const side of [-1, 1]) {
    addTube(b, 'paint', [side * W.hw0, W.y0, W.zf0], [side * W.hw1, W.y1, W.zf1], 0.05, { color: C.white, seg: 8, open: false });
    addTube(b, 'paint', [side * W.hw0, W.y0, W.zb], [side * W.hw1, W.y1, W.zb], 0.05, { color: C.white, seg: 8, open: false });
  }
  // Front windows: four panes with dark frames.
  {
    const ya = 4.2;
    const yb = 5.35;
    const n = 4;
    const gap = 0.1;
    for (let i = 0; i < n; i++) {
      const x0 = -0.93 + (i / n) * 1.86 + gap / 2 / 1.9;
      const x1 = -0.93 + ((i + 1) / n) * 1.86 - gap / 2 / 1.9;
      const fr = 0.035;
      const corners = [frontPoint(W, x1, ya, 0.008), frontPoint(W, x0, ya, 0.008), frontPoint(W, x0, yb, 0.008), frontPoint(W, x1, yb, 0.008)];
      const frame = [frontPoint(W, x1 + fr, ya - fr, 0.004), frontPoint(W, x0 - fr, ya - fr, 0.004), frontPoint(W, x0 - fr, yb + fr, 0.004), frontPoint(W, x1 + fr, yb + fr, 0.004)];
      b.add('rough', quad(frame), { color: C.rubber, uv: 'keep' });
      b.add('glass', quad(corners), { uv: 'keep' });
    }
    // Window wipers.
    for (const xf of [-0.45, 0.45]) {
      const a = frontPoint(W, xf, 4.25, 0.03);
      const c = frontPoint(W, xf + 0.18, 4.85, 0.03);
      addTube(b, 'rough', a, c, 0.012, { color: C.black });
    }
  }
  // Side and back windows.
  for (const side of [-1, 1]) {
    for (const [za, zb2] of [[-4.2, -3.25], [-3.1, -2.15], [-2.0, -1.1]]) {
      const ya = 4.3;
      const yb = 5.3;
      const zs = side < 0 ? [za, zb2] : [zb2, za];
      const c0 = [sidePoint(W, side, zs[0], ya, 0.008), sidePoint(W, side, zs[1], ya, 0.008), sidePoint(W, side, zs[1], yb, 0.008), sidePoint(W, side, zs[0], yb, 0.008)];
      const f = 0.035;
      const zf = side < 0 ? [za - f, zb2 + f] : [zb2 + f, za - f];
      const c1 = [sidePoint(W, side, zf[0], ya - f, 0.004), sidePoint(W, side, zf[1], ya - f, 0.004), sidePoint(W, side, zf[1], yb + f, 0.004), sidePoint(W, side, zf[0], yb + f, 0.004)];
      b.add('rough', quad(c1), { color: C.rubber, uv: 'keep' });
      b.add('glass', quad(c0), { uv: 'keep' });
    }
  }
  for (const [xa, xb] of [[0.35, 1.45], [-1.45, -0.35]]) {
    b.add('rough', quad([[xa - 0.035, 4.26, W.zb + 0.004], [xb + 0.035, 4.26, W.zb + 0.004], [xb + 0.035, 5.33, W.zb + 0.004], [xa - 0.035, 5.33, W.zb + 0.004]]), { color: C.rubber, uv: 'keep' });
    b.add('glass', quad([[xa, 4.3, W.zb + 0.008], [xb, 4.3, W.zb + 0.008], [xb, 5.3, W.zb + 0.008], [xa, 5.3, W.zb + 0.008]]), { uv: 'keep' });
  }
  // Roof with a visor over the front windows, and the fascia carrying the name board.
  const roofY = 5.72;
  b.add('paint', shapes.rbox(4.05, 0.16, 4.5, 0.05), { p: [0, roofY - 0.08, -2.95], color: C.white });
  b.add('paint', shapes.rbox(4.0, 0.42, 0.1, 0.03), { p: [0, 5.72, -5.16], color: C.white });

  // Sidelights with their screens.
  const sideLightY = 5.05;
  for (const side of [-1, 1]) {
    b.add('paint', shapes.box(0.05, 0.36, 0.7), { p: [side * 2.02, sideLightY, -4.0], color: C.black });
    b.add('paint', shapes.box(0.14, 0.2, 0.26), { p: [side * 2.12, sideLightY, -4.15], color: C.dark });
    b.add('lamp', shapes.box(0.1, 0.14, 0.2), { p: [side * 2.2, sideLightY, -4.18], color: side < 0 ? [0.9, 0.08, 0.06] : [0.05, 0.85, 0.3] });
  }

  // ------------------------------------------------------- flying bridge
  {
    const rail = [];
    const zf = -4.95;
    const zs = -2.1;
    const hw = 1.9;
    for (let z = zs; z > zf; z -= 0.7) rail.push([-hw, z]);
    for (let x = -hw; x <= hw + 1e-6; x += 0.76) rail.push([x, zf]);
    for (let z = zf + 0.7; z <= zs + 1e-6; z += 0.7) rail.push([hw, z]);
    const topY = roofY + 0.98;
    for (const [x, z] of rail) addTube(b, 'metal', [x, roofY, z], [x, topY, z], 0.022, { color: C.galv, seg: 6 });
    const railPath = [[-hw, zs], [-hw, zf], [hw, zf], [hw, zs]];
    for (let i = 0; i < railPath.length - 1; i++) {
      const [ax, az] = railPath[i];
      const [bx, bz] = railPath[i + 1];
      addTube(b, 'metal', [ax, topY, az], [bx, topY, bz], 0.026, { color: C.galv });
      addTube(b, 'metal', [ax, roofY + 0.5, az], [bx, roofY + 0.5, bz], 0.018, { color: C.galv });
    }
    // Painted steel windscreen (the flying bridge's bulwark) inside the rail, capped with a navy canvas roll.
    b.add('paint', shapes.rbox(hw * 2 - 0.06, 0.62, 0.06, 0.02), { p: [0, roofY + 0.33, zf + 0.05], color: C.white, uvScale: 1 });
    b.add('rough', shapes.rbox(hw * 2 - 0.02, 0.1, 0.12, 0.04), { p: [0, roofY + 0.66, zf + 0.05], color: C.navy, uvScale: 2 });
    for (const side of [-1, 1]) {
      b.add('paint', shapes.rbox(0.06, 0.62, 1.9, 0.02), { p: [side * (hw - 0.04), roofY + 0.33, zf + 0.98], color: C.white, uvScale: 1 });
      b.add('rough', shapes.rbox(0.12, 0.1, 1.94, 0.04), { p: [side * (hw - 0.04), roofY + 0.66, zf + 0.98], color: C.navy, uvScale: 2 });
    }
    // Console: pedestal, wheel, throttles, compass, plotter.
    b.add('paint', shapes.rbox(1.35, 1.0, 0.55, 0.05), { p: [0, roofY + 0.5, -4.35], color: C.white });
    // Sloped white dash with an inset instrument panel.
    b.add('paint', shapes.rbox(1.34, 0.06, 0.52, 0.02), { p: [0, roofY + 1.02, -4.35], r: [0.25, 0, 0], color: C.white2 });
    b.add('paint', shapes.box(0.95, 0.02, 0.32), { p: [0.08, roofY + 1.05, -4.37], r: [0.25, 0, 0], color: C.dark });
    for (const [x, c] of [[0.2, '#c9d6c2'], [0.36, '#c9d6c2'], [0.52, '#d9c9a0']]) {
      b.add('metal', shapes.cyl(0.045, 0.045, 0.02, 14), { p: [x, roofY + 1.065, -4.33], r: [0.25, 0, 0], color: C.galv });
      b.add('paint', shapes.cyl(0.036, 0.036, 0.022, 14), { p: [x, roofY + 1.07, -4.33], r: [0.25, 0, 0], color: c });
    }
    b.add('glass', shapes.box(0.42, 0.28, 0.02), { p: [-0.35, roofY + 1.12, -4.36], r: [-0.3, 0, 0] });
    b.add('metal', shapes.torus(0.23, 0.018, 6, 22), { p: [0, roofY + 0.78, -4.03], r: [-0.35, 0, 0], color: C.galv });
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      addTube(b, 'metal', [0, roofY + 0.78, -4.03], [Math.cos(a) * 0.22, roofY + 0.78 + Math.sin(a) * 0.22 * Math.cos(0.35), -4.03 - Math.sin(a) * 0.22 * Math.sin(0.35)], 0.012, { color: C.galv });
    }
    b.add('metal', shapes.cyl(0.04, 0.04, 0.12, 8), { p: [0, roofY + 0.8, -4.1], r: [Math.PI / 2 - 0.35, 0, 0], color: C.dark });
    for (const [x, c] of [[0.42, C.red], [0.52, C.black]]) {
      addTube(b, 'metal', [x, roofY + 1.04, -4.3], [x, roofY + 1.24, -4.25], 0.012, { color: C.galv });
      b.add('paint', shapes.sphere(0.03, 8, 6), { p: [x, roofY + 1.25, -4.25], color: c });
    }
    b.add('paint', shapes.sphere(0.09, 12, 6), { p: [0, roofY + 1.06, -4.45], s: [1, 0.6, 1], color: C.black });
  }
  // Radar pedestal (the array spins as its own mesh), radome, antennas, searchlight, horn.
  b.add('paint', shapes.rbox(0.36, 0.5, 0.36, 0.04), { p: [0, roofY + 0.25, -1.35], color: C.white2 });
  b.add('paint', shapes.sphere(0.34, 16, 8, 0), { p: [-1.35, roofY + 0.22, -1.25], s: [1, 0.85, 1], color: C.white });
  b.add('paint', shapes.cyl(0.14, 0.18, 0.2, 10), { p: [-1.35, roofY + 0.1, -1.25], color: C.white2 });
  for (const side of [-1, 1]) {
    addTube(b, 'paint', [side * 1.62, roofY, -1.05], [side * 1.82, roofY + 3.9, -0.62], 0.018, { radiusB: 0.007, color: C.white, seg: 6 });
    b.add('metal', shapes.cyl(0.035, 0.035, 0.25, 6), { p: [side * 1.62, roofY + 0.12, -1.05], color: C.galv });
  }
  b.add('paint', shapes.cyl(0.07, 0.07, 0.08, 10), { p: [1.35, roofY + 0.04, -1.9], color: C.white });
  b.add('metal', shapes.cyl(0.12, 0.13, 0.28, 12), { p: [1.15, roofY + 0.3, -4.62], r: [Math.PI / 2, 0, 0], color: C.galv });
  b.add('lamp', shapes.cyl(0.1, 0.1, 0.02, 12), { p: [1.15, roofY + 0.3, -4.77], r: [Math.PI / 2, 0, 0], color: [0.9, 0.88, 0.8] });
  b.add('metal', shapes.cyl(0.03, 0.03, 0.2, 6), { p: [1.15, roofY + 0.08, -4.62], color: C.galv });

  // ------------------------------------------------------ mast and boom
  const mastZ = 0.1;
  const mastTop = 12.9;
  addTube(b, 'paint', [0, houseTop, mastZ], [0, mastTop, mastZ], 0.14, { radiusB: 0.085, color: C.white, seg: 12, open: false });
  b.add('paint', shapes.cyl(0.1, 0.1, 0.06, 10), { p: [0, mastTop + 0.03, mastZ], color: C.dark });
  const yardY = 10.0;
  addTube(b, 'paint', [-1.25, yardY, mastZ], [1.25, yardY, mastZ], 0.055, { color: C.white, open: false });
  for (const side of [-1, 1]) {
    b.add('paint', shapes.rbox(0.3, 0.24, 0.22, 0.03), { p: [side * 1.12, yardY - 0.15, mastZ + 0.12], r: [0.5, 0, 0], color: C.dark });
    b.add('lamp', shapes.box(0.24, 0.02, 0.16), { p: [side * 1.12, yardY - 0.28, mastZ + 0.2], r: [0.5, 0, 0], color: [1, 0.93, 0.78] });
    // House-top floods aimed aft.
    b.add('paint', shapes.rbox(0.26, 0.2, 0.2, 0.03), { p: [side * 1.65, houseTop + 0.2, houseZ1 - 0.12], r: [-0.4, 0, 0], color: C.dark });
    b.add('lamp', shapes.box(0.2, 0.14, 0.02), { p: [side * 1.65, houseTop + 0.18, houseZ1 - 0.01], r: [-0.4, 0, 0], color: [1, 0.93, 0.78] });
  }
  // Masthead (steaming) light, fishing lights, anchor light, horn.
  b.add('paint', shapes.box(0.18, 0.24, 0.16), { p: [0, 10.65, mastZ - 0.18], color: C.dark });
  b.add('lamp', shapes.box(0.12, 0.14, 0.02), { p: [0, 10.65, mastZ - 0.27], color: [1, 0.97, 0.9] });
  b.add('lamp', shapes.cyl(0.07, 0.07, 0.14, 10), { p: [0, 11.75, mastZ - 0.2], color: [0.9, 0.1, 0.08] });
  b.add('lamp', shapes.cyl(0.07, 0.07, 0.14, 10), { p: [0, 11.2, mastZ - 0.2], color: [1, 0.97, 0.9] });
  for (const y of [11.75, 11.2]) b.add('metal', shapes.box(0.04, 0.04, 0.2), { p: [0, y, mastZ - 0.1], color: C.galv });
  b.add('lamp', shapes.cyl(0.06, 0.06, 0.16, 10), { p: [0, mastTop + 0.14, mastZ], color: [1, 0.97, 0.9] });
  b.add('metal', shapes.cyl(0.02, 0.1, 0.34, 10), { p: [0.12, 9.3, mastZ - 0.25], r: [Math.PI / 2, 0, 0], color: C.galv });
  // Mast steps.
  for (let y = houseTop + 0.6; y < yardY - 0.2; y += 0.42) addTube(b, 'metal', [-0.2, y, mastZ], [0.2, y, mastZ], 0.015, { color: C.galv });

  const goose = [0, 4.35, mastZ + 0.3];
  const tip = [0, 9.15, 8.2];
  addTube(b, 'paint', goose, tip, 0.13, { radiusB: 0.09, color: C.white, seg: 12, open: false });
  b.add('paint', shapes.box(0.3, 0.3, 0.3), { p: goose, color: C.dark });
  b.add('paint', shapes.box(0.26, 0.22, 0.32), { p: [0, 9.2, 8.22], r: [0.5, 0, 0], color: C.dark });
  // Hydraulic hoses down the boom and a loop to the block motor.
  for (const x of [-0.14, 0.14]) {
    addRope(b, 'rough', [x, 4.5, mastZ + 0.35], [x, 9.05, 8.1], 0.022, 0.05, 6, { color: C.black });
  }
  addRope(b, 'rough', [0.14, 9.05, 8.1], [0.36, 8.25, 8.25], 0.022, -0.15, 5, { color: C.black });

  // Stack with a muffler and a sooty top.
  const stackX = -1.5;
  const stackZ = 0.15;
  const stackTop = 7.3;
  b.add('paint', shapes.cyl(0.16, 0.17, stackTop - houseTop - 0.5, 14), { p: [stackX, houseTop + (stackTop - houseTop - 0.5) / 2, stackZ], color: C.dark });
  b.add('metal', shapes.cyl(0.24, 0.24, 1.3, 16), { p: [stackX, 5.2, stackZ], color: C.galv });
  b.add('rough', shapes.cyl(0.16, 0.16, 0.5, 14, true), { p: [stackX, stackTop - 0.25, stackZ], color: C.black });
  b.add('metal', shapes.box(0.36, 0.02, 0.3), { p: [stackX, stackTop + 0.06, stackZ + 0.1], r: [-0.5, 0, 0], color: C.dark });
  for (const y of [4.1, 6.3]) addTube(b, 'metal', [stackX, y, stackZ], [-0.14, y, mastZ], 0.02, { color: C.galv });

  // Liferaft canister in its cradle.
  b.add('paint', shapes.cyl(0.28, 0.28, 0.95, 16), { p: [1.2, houseTop + 0.42, -0.25], r: [0, 0, Math.PI / 2], color: C.white });
  for (const x of [0.85, 1.55]) b.add('paint', shapes.box(0.05, 0.3, 0.62), { p: [x, houseTop + 0.15, -0.25], color: C.dark });

  // --------------------------------------------------------- foc'sle
  const focsleDeck = (z) => form.deckAt(form.tOfZ(z));
  // Anchor winch, chain, bow roller, anchor.
  {
    const z = -6.6;
    const y = focsleDeck(z);
    b.add('paint', shapes.rbox(0.9, 0.34, 0.55, 0.04), { p: [0, y + 0.17, z], color: C.dark });
    b.add('metal', shapes.cyl(0.21, 0.21, 0.5, 14), { p: [0, y + 0.45, z], r: [0, 0, Math.PI / 2], color: C.galv });
    for (const x of [-0.28, 0.28]) b.add('paint', shapes.cyl(0.27, 0.27, 0.04, 14), { p: [x, y + 0.45, z], r: [0, 0, Math.PI / 2], color: C.red });
    const stemY = form.sheer(0.004) + 0.02;
    const stemZ = -form.L / 2 + 0.05;
    let prev = [0, y + 0.62, z];
    const end = [0, stemY + 0.08, stemZ + 0.2];
    for (let i = 1; i <= 12; i++) {
      const t = i / 12;
      const p = [0, prev[1] + (end[1] - prev[1]) / (13 - i) - 0.02 * Math.sin(t * Math.PI), z + (end[2] - z) * t];
      addTube(b, 'rough', prev, p, 0.035, { color: '#3a3430', seg: 5 });
      prev = p;
    }
    b.add('paint', shapes.box(0.3, 0.22, 0.6), { p: [0, stemY, stemZ + 0.05], color: C.dark });
    b.add('metal', shapes.cyl(0.1, 0.1, 0.26, 10), { p: [0, stemY + 0.08, stemZ - 0.22], r: [0, 0, Math.PI / 2], color: C.galv });
    // Galvanized plow anchor stowed on the roller: shank over the roller, the ploughshare tucked against the stem.
    plowAnchor(b, [0, stemY + 0.15, stemZ + 0.4], [0, stemY + 0.05, stemZ - 0.3]);
  }
  // Bow rail on stanchions above the cap.
  {
    const ts = [];
    for (let t = 0.012; t <= 0.24; t += 0.028) ts.push(t);
    for (const side of [-1, 1]) {
      let prevTop = null;
      for (const t of ts) {
        const s = form.sheer(t);
        const x = side * (form.halfWidthAt(t, s) - 0.08);
        const z = form.zOfT(t) + form.zShift(t, 1);
        const top = [x, s + 0.6, z];
        addTube(b, 'metal', [x, s + 0.05, z], top, 0.024, { color: C.galv, seg: 6 });
        if (prevTop) {
          addTube(b, 'metal', prevTop, top, 0.028, { color: C.galv, seg: 6 });
          addTube(b, 'metal', [prevTop[0], prevTop[1] - 0.28, prevTop[2]], [top[0], top[1] - 0.28, top[2]], 0.018, { color: C.galv, seg: 6 });
        }
        prevTop = top;
      }
    }
  }
  // Mooring bitts (the midships pair takes the skiff's towline).
  const bittPts = [];
  for (const [t, dx] of [[0.14, 0.45], [0.55, 0.3], [0.93, 0.35]]) {
    const y = form.deckAt(t);
    const z = form.zOfT(t);
    for (const side of [-1, 1]) {
      const x = side * (form.halfWidthAt(t, y) - 0.1 - dx);
      b.add('paint', shapes.box(0.5, 0.06, 0.24), { p: [x, y + 0.03, z], color: C.dark });
      for (const oz of [-0.14, 0.14]) b.add('paint', shapes.cyl(0.075, 0.08, 0.36, 10), { p: [x, y + 0.2, z + oz], color: C.dark });
      if (t === 0.55) bittPts.push([x, y + 0.35, z]);
    }
  }

  // ------------------------------------------------------- main deck gear
  // Purse winch: two drums, red flanges, hydraulic motor.
  {
    const z = 1.95;
    b.add('paint', shapes.rbox(2.2, 0.22, 1.0, 0.04), { p: [0, deckY + 0.11, z], color: C.dark });
    for (const x of [-0.55, 0.55]) {
      b.add('rough', shapes.cyl(0.33, 0.33, 0.55, 18), { p: [x, deckY + 0.62, z], r: [0, 0, Math.PI / 2], color: '#35393c' });
      for (const dx of [-0.3, 0.3]) b.add('paint', shapes.cyl(0.43, 0.43, 0.05, 18), { p: [x + dx, deckY + 0.62, z], r: [0, 0, Math.PI / 2], color: C.red });
      b.add('paint', shapes.box(0.08, 0.5, 0.6), { p: [x + (x < 0 ? -0.36 : 0.36), deckY + 0.42, z], color: C.dark });
    }
    b.add('paint', shapes.cyl(0.16, 0.16, 0.35, 12), { p: [0, deckY + 0.62, z], r: [0, 0, Math.PI / 2], color: C.red });
    addTube(b, 'metal', [0.95, deckY + 0.3, z - 0.3], [1.05, deckY + 1.05, z - 0.45], 0.02, { color: C.galv });
  }
  // Fish hold hatch.
  b.add('paint', shapes.rbox(1.45, 0.34, 1.15, 0.04), { p: [0, deckY + 0.17, 3.35], color: C.white2 });
  b.add('paint', shapes.rbox(1.55, 0.07, 1.25, 0.03), { p: [0, deckY + 0.37, 3.35], color: C.grey });
  // Stern roller across the transom.
  {
    const y = P.sheerStern + 0.14;
    const z = form.L / 2 + 0.12;
    b.add('rough', shapes.cyl(0.2, 0.2, 4.3, 18), { p: [0, y, z], r: [0, 0, Math.PI / 2], color: C.rubber });
    for (const x of [-2.3, 2.3]) b.add('paint', shapes.box(0.12, 0.42, 0.5), { p: [x, y - 0.05, z - 0.05], color: C.dark });
  }
  // Tyre fenders and buoys over the side.
  for (const side of [-1, 1]) {
    for (const z of [-1.3, 2.4, 5.6]) {
      const t = form.tOfZ(z);
      const x = side * (form.halfWidthAt(t, 1.35) + 0.12);
      b.add('rough', shapes.torus(0.3, 0.12, 8, 16), { p: [x, 1.35, z], r: [0, Math.PI / 2, 0], color: C.rubber });
      addTube(b, 'rig', [x, 1.62, z], [side * (form.halfWidthAt(t, form.sheer(t)) - 0.05), form.sheer(t) + 0.02, z], 0.012);
    }
    const t = form.tOfZ(-3.2);
    const x = side * (form.halfWidthAt(t, 1.6) + 0.3);
    b.add('rough', shapes.sphere(0.3, 14, 10), { p: [x, 1.55, -3.2], color: C.orange });
    addTube(b, 'rig', [x, 1.85, -3.2], [side * (form.halfWidthAt(t, form.sheer(t)) - 0.05), form.sheer(t) + 0.02, -3.2], 0.012);
  }
  // Stern light post and flag staff.
  b.add('metal', shapes.cyl(0.03, 0.03, 0.55, 6), { p: [2.3, P.sheerStern + 0.35, 8.72], color: C.galv });
  b.add('paint', shapes.box(0.12, 0.14, 0.12), { p: [2.3, P.sheerStern + 0.66, 8.72], color: C.dark });
  b.add('lamp', shapes.box(0.08, 0.1, 0.02), { p: [2.3, P.sheerStern + 0.66, 8.79], color: [1, 0.97, 0.9] });
  addTube(b, 'paint', [-2.3, P.sheerStern, 8.45], [-2.42, P.sheerStern + 1.95, 8.62], 0.025, { color: C.white, open: false });

  // ------------------------------------------------------------ rigging
  // Forward shrouds to the foc'sle rails (a pair rather than a centreline forestay, which would split the bridge and
  // binocular views down the middle).
  const shroudT = 0.16;
  const shroudX = form.halfWidthAt(shroudT, form.sheer(shroudT)) - 0.12;
  const shroudFoot = (side) => [side * shroudX, form.sheer(shroudT) + 0.06, form.zOfT(shroudT)];
  const rigLines = [
    [[0, 12.55, mastZ], tip, 0.014], // topping lift
    [[-0.08, 11.7, mastZ - 0.05], shroudFoot(-1), 0.011],
    [[0.08, 11.7, mastZ - 0.05], shroudFoot(1), 0.011],
    [[-1.2, yardY, mastZ], [-1.85, houseTop + 0.05, -0.2], 0.01],
    [[1.2, yardY, mastZ], [1.85, houseTop + 0.05, -0.2], 0.01],
    [tip, [-2.72, P.sheerStern + 0.1, 7.4], 0.012], // boom guys
    [tip, [2.72, P.sheerStern + 0.1, 7.4], 0.012],
    [[-1.2, yardY, mastZ], [-2.42, P.sheerStern + 1.95, 8.62], 0.006], // flag halyard / stern
  ];
  for (const [a, c, r] of rigLines) addTube(b, 'rig', a, c, r, { seg: 4 });

  // ------------------------------------------------------------ meshes
  const add = (bucket, mat, { cast = true, receive = true, name: nm = bucket } = {}) => {
    const geo = b.build(bucket);
    if (!geo) return null;
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = cast;
    m.receiveShadow = receive;
    m.name = nm;
    group.add(m);
    return m;
  };
  add('paint', mats.paint);
  add('rough', mats.rough);
  add('metal', mats.metal);
  add('glass', mats.glass, { cast: false });
  add('glassCabin', mats.glassCabin, { cast: false });
  const lamps = add('lamp', mats.lamp, { cast: false, receive: false });
  add('rig', mats.rig, { cast: false, receive: false });

  // Radar array (rotates).
  const radar = new THREE.Mesh(
    mergeGeometries([
      new THREE.BoxGeometry(1.9, 0.14, 0.14).toNonIndexed(),
      new THREE.BoxGeometry(0.2, 0.12, 0.18).translate(0, -0.1, 0).toNonIndexed(),
    ]),
    new THREE.MeshStandardMaterial({ color: 0xe9e8e2, roughness: 0.4 }),
  );
  radar.position.set(0, roofY + 0.62, -1.35);
  radar.castShadow = true;
  radar.name = 'radar';
  group.add(radar);

  // Power block: frame and motor (red) + rubber-lined V sheave (spins while hauling), hanging from the boom tip.
  const block = new THREE.Group();
  block.name = 'power-block';
  block.position.set(tip[0], tip[1] - 0.12, tip[2]);
  {
    const fb = createBuilder();
    // Fixed: swivel and shackle under the boom tip, the yoke down both cheeks, the hydraulic motor and the axle.
    fb.add('frame', shapes.cyl(0.06, 0.06, 0.4, 10), { p: [0, -0.2, 0], color: C.galv });
    fb.add('frame', shapes.torus(0.07, 0.022, 6, 14), { p: [0, -0.02, 0], r: [0, Math.PI / 2, 0], color: C.galv });
    fb.add('frame', shapes.rbox(0.64, 0.11, 0.2, 0.035), { p: [0, -0.42, 0], color: C.red });
    for (const x of [-0.27, 0.27]) fb.add('frame', shapes.rbox(0.07, 0.62, 0.17, 0.025), { p: [x, -0.72, 0], color: C.red });
    fb.add('frame', shapes.cyl(0.16, 0.17, 0.3, 20), { p: [0.44, -0.98, 0.02], r: [0, 0, Math.PI / 2], color: C.red });
    fb.add('frame', shapes.cyl(0.1, 0.1, 0.06, 16), { p: [0.61, -0.98, 0.02], r: [0, 0, Math.PI / 2], color: C.dark });
    fb.add('frame', shapes.cyl(0.07, 0.07, 0.95, 12), { p: [0, -0.98, 0.02], r: [0, 0, Math.PI / 2], color: C.galv });
    const frame = new THREE.Mesh(fb.build('frame'), mats.paint);
    frame.castShadow = true;
    // Turning: the rubber-lined V sheave between red side plates with lightening holes (they show it spinning).
    const wb = createBuilder();
    const prof = [
      [0.1, -0.2], [0.52, -0.2], [0.55, -0.17], [0.34, -0.03], [0.34, 0.03], [0.55, 0.17], [0.52, 0.2], [0.1, 0.2],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    const sg = new THREE.LatheGeometry(prof, 40);
    sg.rotateZ(Math.PI / 2);
    wb.add('wheel', sg, { color: '#1a1b1c', uvScale: 2 });
    for (const x of [-0.243, 0.243]) {
      const side = Math.sign(x);
      wb.add('wheel', shapes.cyl(0.5, 0.5, 0.035, 40), { p: [x, 0, 0], r: [0, 0, Math.PI / 2], color: C.red });
      wb.add('wheel', shapes.torus(0.5, 0.02, 6, 40), { p: [x, 0, 0], r: [0, Math.PI / 2, 0], color: '#8f231c' });
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        wb.add('wheel', shapes.cyl(0.075, 0.075, 0.01, 14), { p: [x + side * 0.018, Math.sin(a) * 0.3, Math.cos(a) * 0.3], r: [0, 0, Math.PI / 2], color: '#2a1512' });
      }
      wb.add('wheel', shapes.cyl(0.12, 0.12, 0.05, 18), { p: [x + side * 0.03, 0, 0], r: [0, 0, Math.PI / 2], color: C.red });
    }
    const sheave = new THREE.Mesh(wb.build('wheel'), mats.paint);
    sheave.position.set(0, -0.98, 0.02);
    sheave.castShadow = true;
    sheave.name = 'sheave';
    block.add(frame, sheave);
    block.userData.sheave = sheave;
  }
  group.add(block);

  // Flags: the Stars and Stripes on the stern staff, Alaska's Big Dipper at the starboard yardarm.
  const flagTex = createFlagTexture();
  const flagMat = flagMaterial(ctx, flagTex);
  const mkFlag = (w, h, u0, u1) => {
    const g = new THREE.PlaneGeometry(w, h, 12, 4);
    g.translate(w / 2, -h / 2, 0);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setX(i, u0 + uv.getX(i) * (u1 - u0));
    // Keep the ripple amplitude keyed to the distance from the hoist (0..1), stored in uv2-free form via position.x/w.
    const m = new THREE.Mesh(g, flagMat);
    m.castShadow = true;
    return m;
  };
  const flagUS = new THREE.Group();
  flagUS.position.set(-2.42, P.sheerStern + 1.93, 8.62);
  flagUS.add(mkFlag(0.95, 0.5, 0, 0.5));
  const flagAK = new THREE.Group();
  flagAK.position.set(1.18, yardY - 0.05, mastZ);
  flagAK.add(mkFlag(0.7, 0.5, 0.5, 1));
  group.add(flagUS, flagAK);

  // Seine pile.
  const pile = buildPile(form, mats, createWebTexture(), rnd);
  pile.position.y = deckY;
  group.add(pile);

  // Skiff rides on the pile, stern over the roller, bow cocked up.
  const skiffMount = new THREE.Object3D();
  skiffMount.name = 'skiff-mount';
  skiffMount.position.set(0, 3.2, 5.95);
  skiffMount.rotation.x = 0.2;
  group.add(skiffMount);

  // Deckhands.
  const crew = [
    createCrewman({ hat: '#1f2d4a', phase: 0, name: 'deckhand-1' }),
    createCrewman({ hat: '#7a1d1d', gear: '#ff7418', bibs: '#ee5c12', phase: 3.7, name: 'deckhand-2' }),
  ];
  crew[0].mesh.position.set(1.35, deckY, 4.0);
  crew[0].mesh.rotation.y = Math.PI;
  crew[1].mesh.position.set(-1.25, deckY, 2.0);
  crew[1].mesh.rotation.y = Math.PI / 2;
  for (const c of crew) group.add(c.mesh);

  // Water occluder: the hull volume up to the decks.
  const occluder = new THREE.Mesh(buildOccluder(form, { stations: 26 }), new THREE.MeshBasicMaterial({ colorWrite: false }));
  occluder.visible = false;
  occluder.name = 'seiner-occluder';
  group.add(occluder);

  const points = {
    stern: new THREE.Vector3(0, P.sheerStern + 0.3, form.L / 2 + 0.15),
    bow: new THREE.Vector3(0, form.sheer(0), -form.L / 2),
    block: new THREE.Vector3(0, tip[1] - 1.1, tip[2] + 0.02),
    bittPort: new THREE.Vector3(...bittPts[0]),
    bittStarboard: new THREE.Vector3(...bittPts[1]),
    // Skipper standing beside the flying-bridge console on its starboard side: the wheel and throttles in the corner
    // of the eye, the bow clear past the dash.
    eye: new THREE.Vector3(0.85, roofY + 1.74, -3.75),
    stackTop: new THREE.Vector3(stackX, stackTop + 0.1, stackZ),
    mastTop: new THREE.Vector3(0, mastTop, mastZ),
    anchorRoller: new THREE.Vector3(0, form.sheer(0.004) + 0.08, -form.L / 2 - 0.15),
  };

  const lightDefs = [
    { id: 'port', pos: [-2.27, sideLightY, -4.18], color: 0xff2a1a, size: 0.55, intensity: 1.6, arc: ARCS.port },
    { id: 'starboard', pos: [2.27, sideLightY, -4.18], color: 0x2aff7a, size: 0.55, intensity: 1.4, arc: ARCS.starboard },
    { id: 'masthead', pos: [0, 10.65, mastZ - 0.32], color: 0xfff2dc, size: 0.6, intensity: 1.5, arc: ARCS.masthead },
    { id: 'stern', pos: [2.3, P.sheerStern + 0.66, 8.85], color: 0xfff2dc, size: 0.45, intensity: 1.4, arc: ARCS.stern },
    { id: 'anchor', pos: [0, mastTop + 0.16, mastZ], color: 0xfff2dc, size: 0.6, intensity: 1.5 },
    { id: 'fishRed', pos: [0, 11.75, mastZ - 0.2], color: 0xff2a1a, size: 0.5, intensity: 1.5 },
    { id: 'fishWhite', pos: [0, 11.2, mastZ - 0.2], color: 0xfff2dc, size: 0.5, intensity: 1.3 },
    { id: 'floodP', pos: [-1.12, yardY - 0.3, mastZ + 0.24], color: 0xffe2b0, size: 1.4, intensity: 2.0, arc: ARCS.floodAft },
    { id: 'floodS', pos: [1.12, yardY - 0.3, mastZ + 0.24], color: 0xffe2b0, size: 1.4, intensity: 2.0, arc: ARCS.floodAft },
    { id: 'floodHP', pos: [-1.65, houseTop + 0.18, houseZ1 + 0.02], color: 0xffe2b0, size: 1.0, intensity: 1.6, arc: ARCS.floodAft },
    { id: 'floodHS', pos: [1.65, houseTop + 0.18, houseZ1 + 0.02], color: 0xffe2b0, size: 1.0, intensity: 1.6, arc: ARCS.floodAft },
  ];

  function setName(n) {
    atlas.setName(n);
  }

  return {
    group,
    form,
    hull,
    deck,
    lamps,
    radar,
    block,
    pile,
    flags: [flagUS, flagAK],
    flagMaterial: flagMat,
    skiffMount,
    crew,
    occluder,
    points,
    lightDefs,
    materials: { ...mats, hull: hullMat, deck: deckMat },
    pileMaterial: pile.getObjectByName('pile-web')?.material ?? null,
    hullSea,
    setName,
  };
}
