// The deckhand: a procedural figure in orange rain gear — Grundéns-style bibs and jacket, brown XtraTuf boots, a knit
// beanie and a short beard. One smoothly skinned SkinnedMesh (one draw call, one shadow draw) built from lathed and
// rounded primitives in the bind pose (standing, facing -z, feet at y = 0), with per-vertex colour and roughness
// (shiny PVC, rubber boots, knit wool, skin). Joints blend between bones so knees, elbows and the waist bend without
// seams. Bone layout and proportions come from anim.js (SKELETON).

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { patchUnderwater } from '../../render/shaderChunks.js';
import { SKELETON as S, BONE_NAMES } from './anim.js';

export const PALETTE = Object.freeze({
  jacket: '#f57a22',
  jacketShade: '#dc6219',
  bibs: '#df561b',
  bibsPatch: '#b8411a',
  trim: '#26292c',
  reflective: '#cdd2d5',
  boot: '#654330',
  bootTop: '#74503a',
  sole: '#221710',
  welt: '#a57c52',
  skin: '#d39c77',
  beard: '#5b3b27',
  lips: '#b0705a',
  beanie: '#5c5f63',
  beanieCuff: '#4b4e52',
  eye: '#17120e',
});

const ROUGH = { pvc: 0.4, trim: 0.72, reflective: 0.3, boot: 0.5, sole: 0.92, skin: 0.62, hair: 0.95, knit: 0.98, eye: 0.3 };

const B = Object.fromEntries(['root', ...BONE_NAMES].map((n, i) => [n, i]));
const col = new THREE.Color();

// Bone pivots in the bind pose (model space).
function pivots() {
  const hx = S.hipX;
  const sx = S.shoulderX;
  return {
    root: [0, 0, 0],
    hips: [0, S.hipY, 0],
    spine: [0, S.spineY, 0],
    chest: [0, S.chestY, 0],
    neck: [0, S.neckY, 0],
    head: [0, S.headY, 0],
    upperArmL: [-sx, S.shoulderY, 0],
    foreArmL: [-sx - 0.007, S.elbowY, 0],
    handL: [-sx - 0.011, S.wristY, 0],
    upperArmR: [sx, S.shoulderY, 0],
    foreArmR: [sx + 0.007, S.elbowY, 0],
    handR: [sx + 0.011, S.wristY, 0],
    thighL: [-hx, S.hipJointY, 0],
    shinL: [-hx, S.kneeY, 0],
    footL: [-hx, S.ankleY, 0],
    thighR: [hx, S.hipJointY, 0],
    shinR: [hx, S.kneeY, 0],
    footR: [hx, S.ankleY, 0],
  };
}
const PARENT = {
  hips: 'root', spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck',
  upperArmL: 'chest', foreArmL: 'upperArmL', handL: 'foreArmL',
  upperArmR: 'chest', foreArmR: 'upperArmR', handR: 'foreArmR',
  thighL: 'hips', shinL: 'thighL', footL: 'shinL',
  thighR: 'hips', shinR: 'thighR', footR: 'shinR',
};

const smoothstep = (a, b, v) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Weight functions: (x, y, z) -> [[bone, w], [bone, w]].
const rigid = (bone) => () => [[B[bone], 1]];
// Blend from `lower` (below y0 - band) to `upper` (above y0 + band).
const blendY = (lower, upper, y0, band) => (x, y) => {
  const t = smoothstep(y0 - band, y0 + band, y);
  return [[B[upper], t], [B[lower], 1 - t]];
};
// Several vertical bands, bottom to top: [[bone, yTop], ...] with the last bone above.
const chainY = (list, band) => (x, y) => {
  for (let i = 0; i < list.length - 1; i++) {
    const [bone, yTop] = list[i];
    if (y < yTop + band) {
      const t = smoothstep(yTop - band, yTop + band, y);
      return [[B[list[i + 1][0]], t], [B[bone], 1 - t]];
    }
  }
  return [[B[list[list.length - 1][0]], 1]];
};

// Finalises a primitive: strips uv, adds colour (a constant or (x, y, z, i) -> hex/Color), roughness and skin weights.
function part(geo, { color, rough, weights, matrix, ao }) {
  let g = geo.index ? geo.toNonIndexed() : geo;
  if (matrix) g.applyMatrix4(matrix);
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  const pos = g.attributes.position;
  const n = pos.count;
  const colors = new Float32Array(n * 3);
  const roughA = new Float32Array(n);
  const si = new Uint16Array(n * 4);
  const sw = new Float32Array(n * 4);
  const fixed = typeof color === 'function' ? null : col.set(color).clone();
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const c = fixed ?? col.set(color(x, y, z, i));
    const k = ao ? ao(x, y, z) : 1;
    colors[i * 3] = c.r * k;
    colors[i * 3 + 1] = c.g * k;
    colors[i * 3 + 2] = c.b * k;
    roughA[i] = typeof rough === 'function' ? rough(x, y, z) : rough;
    const w = weights(x, y, z);
    let sum = 0;
    for (let k = 0; k < Math.min(4, w.length); k++) {
      si[i * 4 + k] = w[k][0];
      sw[i * 4 + k] = w[k][1];
      sum += w[k][1];
    }
    for (let k = 0; k < 4; k++) sw[i * 4 + k] /= sum || 1;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.setAttribute('rough', new THREE.BufferAttribute(roughA, 1));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  return g;
}

const M = (x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));

// Lathe around the vertical axis from [[radius, y], ...] (bottom to top), elliptical (sx, sz), centred at (cx, cz).
function lathe(profile, segments, { sx = 1, sz = 1, cx = 0, cz = 0 } = {}) {
  const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(1e-4, r), y));
  const g = new THREE.LatheGeometry(pts, segments);
  g.applyMatrix4(M(cx, 0, cz, 0, 0, 0, sx, 1, sz));
  return g;
}

// Strip hugging the front of a lathe profile (zipper, placket).
function frontStrip(profile, { sz = 1, half = 0.008, lift = 0.004, angle = 0 }) {
  const pos = [];
  const idx = [];
  for (let i = 0; i < profile.length; i++) {
    const [r, y] = profile[i];
    const zc = -(r * sz + lift);
    const xOff = Math.sin(angle) * r;
    pos.push(xOff - half, y, zc, xOff + half, y, zc);
    if (i > 0) {
      const a = (i - 1) * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Deterministic hash noise for subtle colour variation.
const hash = (x, y, z) => {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
};
const tint = (hex, k) => col.set(hex).clone().multiplyScalar(k);
const mix = (a, b, t) => a + (b - a) * t;

// Baked ambient occlusion in the bind pose: inner legs, under the jacket hem, armpits, the inside of the arms, under
// the chin. Gives the rain gear its form in flat light.
const legAO = (x, y) => {
  let k = mix(0.62, 1, smoothstep(0.01, 0.075, Math.abs(x)));
  k *= mix(0.6, 1, smoothstep(0.0, 0.12, 0.815 - y));
  k *= y < 0.34 ? mix(0.7, 1, smoothstep(0.26, 0.34, y)) : 1;
  return k;
};
const torsoAO = (x, y, z) => {
  const pit = smoothstep(0.15, 0.215, Math.abs(x)) * smoothstep(1.02, 1.2, y) * (1 - smoothstep(1.34, 1.42, y));
  const hem = y < 0.86 ? mix(0.8, 1, smoothstep(0.815, 0.86, y)) : 1;
  const collar = y > 1.44 ? mix(1, 0.78, smoothstep(1.44, 1.49, y)) : 1;
  return (1 - 0.32 * pit) * hem * collar;
};
const armAO = (cx) => (x, y) => {
  const inner = Math.sign(cx) * (x - cx) < -0.02 ? 1 : 0;
  const top = y > 1.38 ? mix(1, 0.85, smoothstep(1.38, 1.46, y) * inner) : 1;
  return mix(1, 0.74, inner * smoothstep(1.02, 1.3, y)) * top * mix(1, 0.86, inner);
};

function buildGeometry() {
  const parts = [];
  const P = PALETTE;

  // ---------------------------------------------------------------- legs: bibs over boots
  for (const side of ['L', 'R']) {
    const sign = side === 'L' ? -1 : 1;
    const cx = sign * S.hipX;
    const thigh = `thigh${side}`;
    const shin = `shin${side}`;
    const foot = `foot${side}`;
    const legProfile = [
      [0.074, 0.27],
      [0.08, 0.285],
      [0.078, 0.32],
      [0.074, 0.4],
      [0.077, 0.47],
      [0.082, 0.53],
      [0.086, 0.6],
      [0.092, 0.72],
      [0.098, 0.84],
      [0.1, 0.94],
      [0.095, 1.02],
    ];
    const legW = (x, y) => {
      if (y > 0.9) {
        const t = smoothstep(0.9, 1.0, y);
        return [[B.hips, t], [B[thigh], 1 - t]];
      }
      const t = smoothstep(S.kneeY - 0.055, S.kneeY + 0.055, y);
      return [[B[thigh], t], [B[shin], 1 - t]];
    };
    parts.push(part(lathe(legProfile, 18, { cx, sz: 1.02 }), {
      color: (x, y, z) => {
        // Darker reinforced knee patch and a faint crease shade at the back of the knee.
        const knee = y > 0.44 && y < 0.62 && z < -0.03 ? 1 : 0;
        const n = 0.96 + hash(x, y, z) * 0.06;
        return tint(knee ? P.bibsPatch : P.bibs, n * (y < 0.3 ? 0.9 : 1));
      },
      rough: ROUGH.pvc,
      weights: legW,
      ao: legAO,
    }));
    // Boot shaft (XtraTuf), rolled rim just under the bib cuff.
    const bootProfile = [
      [0.058, 0.035],
      [0.062, 0.08],
      [0.06, 0.14],
      [0.061, 0.24],
      [0.064, 0.3],
      [0.068, 0.335],
      [0.06, 0.34],
    ];
    parts.push(part(lathe(bootProfile, 16, { cx, sz: 1.1 }), {
      color: (x, y) => (y > 0.3 ? P.bootTop : P.boot),
      rough: ROUGH.boot,
      weights: blendY(foot, shin, 0.13, 0.045),
      ao: (x, y) => mix(1, 0.62, smoothstep(0.17, 0.27, y)),
    }));
    // Foot: toe box forward, heel back; sole, welt stripe.
    parts.push(part(new RoundedBoxGeometry(0.118, 0.1, 0.29, 3, 0.045), {
      matrix: M(cx, 0.062, -0.052),
      color: P.boot,
      rough: ROUGH.boot,
      weights: rigid(foot),
    }));
    parts.push(part(new RoundedBoxGeometry(0.126, 0.034, 0.305, 2, 0.014), {
      matrix: M(cx, 0.017, -0.053),
      color: P.sole,
      rough: ROUGH.sole,
      weights: rigid(foot),
    }));
    parts.push(part(new RoundedBoxGeometry(0.128, 0.011, 0.307, 2, 0.005), {
      matrix: M(cx, 0.037, -0.053),
      color: P.welt,
      rough: 0.7,
      weights: rigid(foot),
    }));
  }

  // ---------------------------------------------------------------- torso: jacket
  const torsoProfile = [
    [0.198, 0.815],
    [0.222, 0.83],
    [0.226, 0.86],
    [0.214, 0.95],
    [0.206, 1.04],
    [0.208, 1.13],
    [0.218, 1.24],
    [0.224, 1.33],
    [0.218, 1.385],
    [0.2, 1.425],
    [0.165, 1.458],
    [0.12, 1.485],
    [0.085, 1.5],
    [0.07, 1.502],
  ];
  const TZ = 0.66;
  const torsoW = chainY([['hips', 1.04], ['spine', 1.27], ['chest', 9]], 0.06);
  parts.push(part(lathe(torsoProfile, 28, { sz: TZ }), {
    color: (x, y, z) => {
      const hem = y < 0.87 ? 0.82 : 1;
      const side = 0.95 + 0.05 * Math.abs(x) / 0.23;
      return tint(P.jacket, hem * side * (0.97 + hash(x, y, z) * 0.05));
    },
    rough: ROUGH.pvc,
    weights: torsoW,
    ao: torsoAO,
  }));
  // Zipper and storm-flap line down the front.
  const zipProfile = torsoProfile.filter(([, y]) => y > 0.83 && y < 1.47);
  parts.push(part(frontStrip(zipProfile, { sz: TZ, half: 0.0075, lift: 0.003 }), { color: P.trim, rough: ROUGH.trim, weights: torsoW }));
  parts.push(part(frontStrip(zipProfile, { sz: TZ, half: 0.02, lift: 0.0015, angle: 0.06 }), { color: P.jacketShade, rough: ROUGH.pvc, weights: torsoW }));
  // Collar: stand-up, dark lining inside the top edge.
  const collarProfile = [
    [0.078, 1.45],
    [0.086, 1.5],
    [0.085, 1.56],
    [0.078, 1.565],
    [0.07, 1.55],
  ];
  parts.push(part(lathe(collarProfile, 20, { sz: 0.95, cz: 0.008 }), {
    color: (x, y, z, i) => (y > 1.556 ? P.trim : P.jacket),
    rough: ROUGH.pvc,
    weights: rigid('chest'),
  }));
  // Hood rolled down behind the collar.
  parts.push(part(new THREE.SphereGeometry(0.1, 14, 8), {
    matrix: M(0, 1.47, 0.1, 0.35, 0, 0, 1.25, 0.55, 0.62),
    color: (x, y, z) => tint(P.jacketShade, 0.95 + hash(x, y, z) * 0.06),
    rough: ROUGH.pvc,
    weights: rigid('chest'),
  }));

  // ---------------------------------------------------------------- arms
  for (const side of ['L', 'R']) {
    const sign = side === 'L' ? -1 : 1;
    const cx = sign * (S.shoulderX + 0.006);
    const up = `upperArm${side}`;
    const fore = `foreArm${side}`;
    const hand = `hand${side}`;
    const sleeve = [
      [0.056, 0.912],
      [0.06, 0.93],
      [0.058, 0.96],
      [0.06, 1.05],
      [0.064, 1.13],
      [0.066, 1.17],
      [0.07, 1.26],
      [0.074, 1.36],
      [0.074, 1.41],
      [0.058, 1.452],
    ];
    const armW = (x, y) => {
      const t = smoothstep(S.elbowY - 0.045, S.elbowY + 0.045, y);
      return [[B[up], t], [B[fore], 1 - t]];
    };
    parts.push(part(lathe(sleeve, 14, { cx }), {
      color: (x, y, z) => {
        // Reflective bands round the forearm and upper arm.
        if ((y > 0.995 && y < 1.03) || (y > 1.235 && y < 1.268)) return P.reflective;
        return tint(P.jacket, 0.97 + hash(x, y, z) * 0.05);
      },
      rough: (x, y) => ((y > 0.995 && y < 1.03) || (y > 1.235 && y < 1.268) ? ROUGH.reflective : ROUGH.pvc),
      weights: armW,
      ao: armAO(cx),
    }));
    // Shoulder cap.
    parts.push(part(new THREE.SphereGeometry(0.078, 16, 10), {
      matrix: M(sign * (S.shoulderX - 0.01), S.shoulderY - 0.022, 0, 0, 0, sign * 0.35, 1.05, 0.8, 1.02),
      color: P.jacket,
      rough: ROUGH.pvc,
      weights: rigid(up),
    }));
    // Neoprene cuff.
    parts.push(part(lathe([[0.047, 0.895], [0.05, 0.9], [0.05, 0.925], [0.046, 0.93]], 12, { cx }), {
      color: P.trim,
      rough: ROUGH.trim,
      weights: rigid(fore),
    }));
    // Hand: palm toward the thigh, fingers loosely curled, thumb forward.
    const hx = sign * (S.shoulderX + 0.012);
    parts.push(part(new RoundedBoxGeometry(0.036, 0.095, 0.078, 2, 0.016), {
      matrix: M(hx, 0.845, 0.004, 0.1, 0, 0),
      color: P.skin,
      rough: ROUGH.skin,
      weights: rigid(hand),
    }));
    parts.push(part(new THREE.CapsuleGeometry(0.013, 0.035, 3, 6), {
      matrix: M(hx - sign * 0.004, 0.862, -0.04, -0.5, 0, sign * 0.2),
      color: P.skin,
      rough: ROUGH.skin,
      weights: rigid(hand),
    }));
  }

  // ---------------------------------------------------------------- head
  parts.push(part(lathe([[0.05, 1.45], [0.052, 1.52], [0.05, 1.6], [0.046, 1.63]], 12, { sz: 1.05 }), {
    color: P.skin,
    rough: ROUGH.skin,
    weights: blendY('chest', 'neck', 1.5, 0.03),
  }));
  const headC = [0, 1.683, 0.004];
  parts.push(part(new THREE.SphereGeometry(0.104, 26, 18), {
    matrix: M(headC[0], headC[1], headC[2], 0, 0, 0, 0.9, 1.1, 1.0),
    color: (x, y, z) => {
      const ly = y - headC[1];
      const lz = z - headC[2];
      // Short beard on the jaw and chin, a little thinner up the cheeks; lips as a warmer band.
      const beard = ly < -0.012 + Math.max(0, lz + 0.03) * 0.8 && lz < 0.045;
      if (beard && ly > -0.052 && ly < -0.036 && lz < -0.085 && Math.abs(x) < 0.03) return P.lips;
      if (beard) return tint(P.beard, 0.9 + hash(x, y, z) * 0.2);
      return tint(P.skin, 0.95 + hash(x, y, z) * 0.06 - Math.max(0, ly - 0.05) * 0.8);
    },
    rough: (x, y, z) => (y - headC[1] < -0.012 && z < 0.05 ? ROUGH.hair : ROUGH.skin),
    weights: rigid('head'),
  }));
  // Nose, ears, eyes and brows.
  parts.push(part(new THREE.SphereGeometry(0.019, 10, 8), {
    matrix: M(0, 1.675, -0.1, 0.35, 0, 0, 0.75, 1.15, 1.0),
    color: tint(P.skin, 0.96),
    rough: ROUGH.skin,
    weights: rigid('head'),
  }));
  for (const sign of [-1, 1]) {
    parts.push(part(new THREE.SphereGeometry(0.024, 10, 8), {
      matrix: M(sign * 0.094, 1.678, 0.012, 0, 0, 0, 0.42, 1, 0.72),
      color: tint(P.skin, 0.92),
      rough: ROUGH.skin,
      weights: rigid('head'),
    }));
    parts.push(part(new THREE.SphereGeometry(0.0115, 8, 6), {
      matrix: M(sign * 0.034, 1.699, -0.088),
      color: P.eye,
      rough: ROUGH.eye,
      weights: rigid('head'),
    }));
    parts.push(part(new RoundedBoxGeometry(0.034, 0.009, 0.014, 1, 0.004), {
      matrix: M(sign * 0.034, 1.716, -0.09, 0, 0, sign * -0.12),
      color: P.beard,
      rough: ROUGH.hair,
      weights: rigid('head'),
    }));
  }
  // Beanie: knit crown and a ribbed, folded cuff.
  parts.push(part(new THREE.SphereGeometry(0.108, 22, 10, 0, Math.PI * 2, 0, Math.PI / 2), {
    matrix: M(0, 1.742, 0.008, -0.08, 0, 0, 0.98, 1.08, 1.06),
    color: (x, y, z) => tint(P.beanie, 0.92 + hash(x * 3, y * 3, z * 3) * 0.14),
    rough: ROUGH.knit,
    weights: rigid('head'),
  }));
  parts.push(part(lathe([[0.096, 1.72], [0.106, 1.724], [0.109, 1.742], [0.108, 1.766], [0.1, 1.773]], 32, { sx: 0.96, sz: 1.05, cz: 0.008 }), {
    color: (x, y, z) => {
      const a = Math.atan2(x, z - 0.008);
      return tint(P.beanieCuff, 0.86 + 0.14 * (0.5 + 0.5 * Math.cos(a * 36)));
    },
    rough: ROUGH.knit,
    weights: rigid('head'),
  }));

  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  g.computeBoundingSphere();
  return g;
}

let sharedGeometry = null;

// Builds the figure. Returns { group (root, feet at origin, facing -z), mesh, bones: {name: Bone}, applyPose(pose) }.
export function buildDeckhand(ctx) {
  if (!sharedGeometry) sharedGeometry = buildGeometry();
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, envMapIntensity: 0.9 });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float rough;\nvarying float vRough;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRough = rough;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vRough;')
      .replace('float roughnessFactor = roughness;', 'float roughnessFactor = roughness * vRough;');
  };
  material.customProgramCacheKey = () => 'kodiak-deckhand';
  patchUnderwater(material, ctx.uniforms);

  const piv = pivots();
  const bones = {};
  const list = [];
  for (const name of ['root', ...BONE_NAMES]) {
    const b = new THREE.Bone();
    b.name = `deckhand-${name}`;
    const p = piv[name];
    const parent = PARENT[name];
    if (parent) {
      const q = piv[parent];
      b.position.set(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      bones[parent].add(b);
    } else {
      b.position.set(p[0], p[1], p[2]);
    }
    bones[name] = b;
    list.push(b);
  }
  const mesh = new THREE.SkinnedMesh(sharedGeometry, material);
  mesh.name = 'deckhand';
  mesh.add(bones.root);
  mesh.bind(new THREE.Skeleton(list));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // Always near the camera when shown; skip the per-frame skinned bounds.
  mesh.frustumCulled = false;

  const group = new THREE.Group();
  group.name = 'player';
  group.add(mesh);

  const hipsRest = new THREE.Vector3(...piv.hips);
  function applyPose(pose) {
    for (const name of BONE_NAMES) {
      const r = pose.rot[name];
      bones[name].rotation.set(r.x, r.y, r.z);
    }
    bones.hips.position.set(hipsRest.x + pose.hips.x, pose.hips.y, hipsRest.z + pose.hips.z);
  }

  return { group, mesh, bones, material, applyPose };
}
