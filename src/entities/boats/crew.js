// Deckhands in orange rain gear: one rigidly-skinned SkinnedMesh per figure (a draw call each), posed
// procedurally every frame. Bind pose: standing, facing -z, feet at y = 0.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const BONES = ['hips', 'spine', 'head', 'armL', 'foreL', 'armR', 'foreR', 'thighL', 'shinL', 'thighR', 'shinR'];
const B = Object.fromEntries(BONES.map((n, i) => [n, i]));

// Bone pivots in the bind pose (world = model space).
const PIVOT = {
  hips: [0, 0.95, 0],
  spine: [0, 1.08, 0],
  head: [0, 1.52, 0],
  armL: [-0.235, 1.43, 0],
  foreL: [-0.26, 1.13, 0],
  armR: [0.235, 1.43, 0],
  foreR: [0.26, 1.13, 0],
  thighL: [-0.1, 0.93, 0],
  shinL: [-0.105, 0.5, 0],
  thighR: [0.1, 0.93, 0],
  shinR: [0.105, 0.5, 0],
};
const PARENT = { spine: 'hips', head: 'spine', armL: 'spine', foreL: 'armL', armR: 'spine', foreR: 'armR', thighL: 'hips', shinL: 'thighL', thighR: 'hips', shinR: 'thighR' };

const col = new THREE.Color();

function part(geo, bone, color, m) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  if (m) g.applyMatrix4(m);
  const n = g.attributes.position.count;
  const colors = new Float32Array(n * 3);
  col.set(color);
  for (let i = 0; i < n; i++) colors.set([col.r, col.g, col.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const si = new Uint16Array(n * 4);
  const sw = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    si[i * 4] = B[bone];
    sw[i * 4] = 1;
  }
  g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  return g;
}

const M = (x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));

let geometryCache = new Map();

export function crewGeometry({ hat = '#1f2d4a', gear = '#ff6a14', bibs = '#f05a10', hood = false } = {}) {
  const key = `${hat}|${gear}|${bibs}|${hood}`;
  if (geometryCache.has(key)) return geometryCache.get(key);
  const skin = '#d6a07c';
  const boot = '#5b3f2a';
  const glove = '#39473a';
  const parts = [
    // Bibs: hips and upper legs.
    part(new THREE.CapsuleGeometry(0.155, 0.12, 4, 10), 'hips', bibs, M(0, 0.98, 0, 0, 0, 0, 1.05, 1, 0.8)),
    // Jacket torso, slightly hunched.
    part(new THREE.CapsuleGeometry(0.19, 0.3, 4, 12), 'spine', gear, M(0, 1.3, 0.01, 0.05, 0, 0, 1.08, 1, 0.78)),
    part(new THREE.CylinderGeometry(0.1, 0.12, 0.08, 10), 'spine', gear, M(0, 1.5, 0.0)),
    // Head: face, beanie (or hood).
    part(new THREE.SphereGeometry(0.105, 14, 10), 'head', skin, M(0, 1.64, -0.005, 0, 0, 0, 0.92, 1.05, 0.98)),
    part(new THREE.SphereGeometry(0.112, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), 'head', hood ? gear : hat, M(0, 1.655, 0.01, -0.15, 0, 0, 1, 1.02, 1.04)),
    part(new THREE.CylinderGeometry(0.114, 0.114, 0.035, 14), 'head', hood ? gear : hat, M(0, 1.66, 0.012, -0.15)),
    // Nose hint so the face reads at a distance.
    part(new THREE.SphereGeometry(0.022, 6, 5), 'head', '#c98f6c', M(0, 1.63, -0.1)),
    // Arms.
    part(new THREE.CapsuleGeometry(0.068, 0.2, 3, 8), 'armL', gear, M(-0.25, 1.28, 0)),
    part(new THREE.CapsuleGeometry(0.06, 0.2, 3, 8), 'foreL', gear, M(-0.265, 0.99, 0)),
    part(new THREE.SphereGeometry(0.058, 8, 6), 'foreL', glove, M(-0.265, 0.84, -0.01, 0, 0, 0, 0.85, 1.2, 1)),
    part(new THREE.CapsuleGeometry(0.068, 0.2, 3, 8), 'armR', gear, M(0.25, 1.28, 0)),
    part(new THREE.CapsuleGeometry(0.06, 0.2, 3, 8), 'foreR', gear, M(0.265, 0.99, 0)),
    part(new THREE.SphereGeometry(0.058, 8, 6), 'foreR', glove, M(0.265, 0.84, -0.01, 0, 0, 0, 0.85, 1.2, 1)),
    // Legs: orange bib pants into brown XtraTufs.
    part(new THREE.CapsuleGeometry(0.088, 0.3, 3, 8), 'thighL', bibs, M(-0.1, 0.72, 0)),
    part(new THREE.CapsuleGeometry(0.078, 0.12, 3, 8), 'shinL', bibs, M(-0.105, 0.42, 0)),
    part(new THREE.CylinderGeometry(0.075, 0.07, 0.3, 10), 'shinL', boot, M(-0.105, 0.2, 0)),
    part(new THREE.CylinderGeometry(0.079, 0.079, 0.035, 10), 'shinL', '#8a6a4a', M(-0.105, 0.34, 0)),
    part(new THREE.BoxGeometry(0.11, 0.07, 0.27), 'shinL', boot, M(-0.105, 0.035, -0.05)),
    part(new THREE.CapsuleGeometry(0.088, 0.3, 3, 8), 'thighR', bibs, M(0.1, 0.72, 0)),
    part(new THREE.CapsuleGeometry(0.078, 0.12, 3, 8), 'shinR', bibs, M(0.105, 0.42, 0)),
    part(new THREE.CylinderGeometry(0.075, 0.07, 0.3, 10), 'shinR', boot, M(0.105, 0.2, 0)),
    part(new THREE.CylinderGeometry(0.079, 0.079, 0.035, 10), 'shinR', '#8a6a4a', M(0.105, 0.34, 0)),
    part(new THREE.BoxGeometry(0.11, 0.07, 0.27), 'shinR', boot, M(0.105, 0.035, -0.05)),
  ];
  const g = mergeGeometries(parts, false);
  geometryCache.set(key, g);
  return g;
}

let sharedMaterial = null;
export function crewMaterial() {
  if (!sharedMaterial) sharedMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.52, metalness: 0 });
  return sharedMaterial;
}

// One figure. pose(t, activity, look) animates it; activity: 'idle' | 'watch' | 'stack' | 'haul' | 'winch' | 'helm'.
export function createCrewman(opts = {}) {
  const geo = crewGeometry(opts);
  const bones = BONES.map((n) => {
    const b = new THREE.Bone();
    b.name = n;
    return b;
  });
  for (const n of BONES) {
    const b = bones[B[n]];
    const p = PIVOT[n];
    const par = PARENT[n];
    if (par) {
      const pp = PIVOT[par];
      b.position.set(p[0] - pp[0], p[1] - pp[1], p[2] - pp[2]);
      bones[B[par]].add(b);
    } else {
      b.position.set(...p);
    }
  }
  bones[0].updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  const mesh = new THREE.SkinnedMesh(geo, crewMaterial());
  mesh.add(bones[0]);
  mesh.bind(skeleton, new THREE.Matrix4());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  mesh.name = opts.name ?? 'crewman';
  const bn = Object.fromEntries(BONES.map((n) => [n, bones[B[n]]]));
  const phase = opts.phase ?? 0;

  // Rotation conventions (figure faces -z): +x on a limb swings it forward, +x on the head looks up, -x on the
  // spine leans forward, +z on the left arm/leg is inward.
  function pose(t, activity = 'idle', { brace = 0, lookYaw = 0 } = {}) {
    t += phase;
    const s = Math.sin;
    for (const b of bones) b.rotation.set(0, 0, 0);
    const sway = s(t * 0.9) * 0.04 + brace * 0.12;
    bn.hips.position.set(0, 0.93 + s(t * 1.8) * 0.004, 0);
    bn.hips.rotation.z = sway * 0.5;
    bn.spine.rotation.z = -sway * 0.6;
    bn.thighL.rotation.set(0.12, 0, -0.06);
    bn.thighR.rotation.set(0.12, 0, 0.06);
    bn.shinL.rotation.x = -0.22;
    bn.shinR.rotation.x = -0.22;
    bn.armL.rotation.z = -0.12;
    bn.armR.rotation.z = 0.12;
    bn.foreL.rotation.x = 0.35;
    bn.foreR.rotation.x = 0.35;
    bn.head.rotation.y = lookYaw + s(t * 0.37) * 0.25;
    bn.head.rotation.x = s(t * 0.23) * 0.08;
    switch (activity) {
      case 'watch':
        bn.spine.rotation.x = -0.05;
        bn.armL.rotation.set(0.35, 0, 0.3);
        bn.armR.rotation.set(0.35, 0, -0.3);
        bn.foreL.rotation.x = 1.25;
        bn.foreR.rotation.x = 1.25;
        break;
      case 'stack': {
        // Bent over the pile, flaking web: arms sweep in turn.
        const k = s(t * 2.4);
        bn.spine.rotation.x = -0.6 - k * 0.08;
        bn.thighL.rotation.x = 0.4;
        bn.thighR.rotation.x = 0.4;
        bn.shinL.rotation.x = -0.6;
        bn.shinR.rotation.x = -0.6;
        bn.hips.position.y = 0.87;
        bn.armL.rotation.x = 0.9 + k * 0.5;
        bn.armR.rotation.x = 0.9 - k * 0.5;
        bn.foreL.rotation.x = 0.4;
        bn.foreR.rotation.x = 0.4;
        bn.head.rotation.x = 0.3;
        break;
      }
      case 'haul': {
        // Hand over hand on the web coming down from the block.
        const k = s(t * 2.0);
        bn.spine.rotation.x = 0.08 + k * 0.06;
        bn.armL.rotation.x = 2.3 + k * 0.5;
        bn.armR.rotation.x = 2.3 - k * 0.5;
        bn.foreL.rotation.x = 0.3;
        bn.foreR.rotation.x = 0.3;
        bn.head.rotation.x = 0.4;
        break;
      }
      case 'winch':
        bn.spine.rotation.x = -0.25;
        bn.armR.rotation.x = 1.0;
        bn.foreR.rotation.x = 0.6 + s(t * 1.3) * 0.1;
        bn.armL.rotation.x = 0.5;
        bn.foreL.rotation.x = 0.9;
        bn.head.rotation.x = -0.2;
        break;
      case 'helm':
        bn.armR.rotation.x = 0.75;
        bn.foreR.rotation.x = 0.8;
        bn.armL.rotation.x = 0.35 + s(t * 0.5) * 0.05;
        bn.foreL.rotation.x = 0.9;
        bn.spine.rotation.x = -0.08;
        bn.head.rotation.y = lookYaw * 0.3 + s(t * 0.21) * 0.15;
        bn.head.rotation.x = 0.05;
        break;
      case 'coil': {
        const k = t * 3.2;
        bn.armR.rotation.x = 0.9 + Math.sin(k) * 0.35;
        bn.armR.rotation.z = 0.15 + Math.cos(k) * 0.25;
        bn.foreR.rotation.x = 0.9;
        bn.armL.rotation.x = 0.7;
        bn.foreL.rotation.x = 1.3;
        bn.spine.rotation.x = -0.18;
        bn.head.rotation.x = -0.3;
        break;
      }
      default:
        bn.armL.rotation.x = s(t * 0.7) * 0.04;
        bn.armR.rotation.x = -s(t * 0.7) * 0.04;
        break;
    }
  }
  pose(0);
  return { mesh, bones: bn, pose };
}
