// Species models, built procedurally at real size (metres). Models face -z, +y up. Every geometry carries vertex
// colours plus two rig channels read by the vertex-animation materials (materials.js):
//
//   bird   aRig = (part, side, shoulderX, wristX)   part: 0 body, 1 wing, 2 tail, 3 head, 4 legs/feet
//          aPivot = (neckY, neckZ, 0, 0)            head turn pivot (head vertices)
//   quad   aRig = (leg 0..4, legT 0..1, headW, tailW)   leg: 1 LF, 2 RF, 3 LH, 4 RH; legT 0 at the joint -> 1 at the foot
//          aPivot = (jointY, jointZ, kneeY, 0) for legs, (neckY, neckZ, 0, 0) for head/neck, (tailY, tailZ) for tail
//   marine aRig = (s 0..1 nose->tail, part, finT 0..1, headW)   part: 0 body, 1 left fore fin, 2 right fore fin,
//          3 fluke / hind flippers, 4 dorsal fin;  aPivot = (finY, finZ, finX, 0) for fins, (neckY, neckZ) for heads
//
// Origins: flying birds and swimming animals at the centre of mass; perched/standing animals at the feet (y = 0),
// floating animals at the waterline.

import * as THREE from 'three';
import { ModelBuilder, bodyLoft, tube, ellipsoid, blade, lin, mix3, scale3, vnoise, sampleKeys } from './mesh.js';

const sm = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function transformPart(part, m) {
  const v = new THREE.Vector3();
  for (let i = 0; i < part.pos.length; i += 3) {
    v.set(part.pos[i], part.pos[i + 1], part.pos[i + 2]).applyMatrix4(m);
    part.pos[i] = v.x;
    part.pos[i + 1] = v.y;
    part.pos[i + 2] = v.z;
  }
  return part.orient();
}
const rotX = (a, pivot = [0, 0, 0]) =>
  new THREE.Matrix4()
    .makeTranslation(pivot[0], pivot[1], pivot[2])
    .multiply(new THREE.Matrix4().makeRotationX(a))
    .multiply(new THREE.Matrix4().makeTranslation(-pivot[0], -pivot[1], -pivot[2]));

// ------------------------------------------------------------------------------------------------------------ birds

const BIRDS = {
  gull: {
    body: { z0: -0.17, z1: 0.2, keys: [
      { t: 0, cy: 0.012, rx: 0.036, ry: 0.04 }, { t: 0.25, cy: 0.002, rx: 0.068, ry: 0.066 }, { t: 0.5, cy: -0.004, rx: 0.074, ry: 0.07 },
      { t: 0.78, cy: 0.002, rx: 0.056, ry: 0.05 }, { t: 1, cy: 0.012, rx: 0.026, ry: 0.022 },
    ] },
    neck: [[0, 0.018, -0.14], [0, 0.034, -0.205]], neckR: 0.037,
    head: { c: [0, 0.042, -0.238], r: [0.041, 0.044, 0.054] },
    bill: { from: [0, 0.036, -0.284], to: [0, 0.027, -0.348], r0: 0.012, r1: 0.005, depth: 1.25 },
    eye: { c: [0.034, 0.053, -0.252], r: 0.0065 },
    tail: { z0: 0.16, z1: 0.31, w0: 0.03, w1: 0.07, t: 0.012 },
    wing: { root: 0.035, half: 0.64, wrist: 0.27, y: 0.018, stations: [
      [0, -0.085, 0.12, 0.034], [0.12, -0.1, 0.115, 0.03], [0.25, -0.122, 0.085, 0.024], [0.38, -0.1, 0.07, 0.016],
      [0.5, -0.07, 0.07, 0.011], [0.58, -0.035, 0.08, 0.008], [0.64, 0.035, 0.09, 0.004],
    ] },
    folded: { len: 0.42, w: 0.036, h: 0.05 },
    legH: 0.14, footLen: 0.06, legR: 0.007,
    colors: { body: '#f4f3ef', back: '#a4adb3', wingTop: '#a4adb3', tip: '#7f878d', under: '#e7e9ea', bill: '#e9c64c', spot: '#c43a2a', eye: '#161616', legs: '#d99f9c', tail: '#f4f3ef' },
    flapHz: 2.9,
  },
  eagle: {
    body: { z0: -0.22, z1: 0.25, keys: [
      { t: 0, cy: 0.02, rx: 0.06, ry: 0.065 }, { t: 0.25, cy: 0.0, rx: 0.115, ry: 0.11 }, { t: 0.5, cy: -0.01, rx: 0.12, ry: 0.115 },
      { t: 0.78, cy: 0.0, rx: 0.09, ry: 0.08 }, { t: 1, cy: 0.012, rx: 0.045, ry: 0.035 },
    ] },
    neck: [[0, 0.03, -0.19], [0, 0.052, -0.27]], neckR: 0.062,
    head: { c: [0, 0.062, -0.31], r: [0.055, 0.06, 0.075] },
    bill: { from: [0, 0.058, -0.37], to: [0, 0.032, -0.445], r0: 0.028, r1: 0.008, depth: 1.5, hook: 0.02 },
    eye: { c: [0.044, 0.078, -0.33], r: 0.009 },
    tail: { z0: 0.2, z1: 0.5, w0: 0.06, w1: 0.13, t: 0.02 },
    wing: { root: 0.06, half: 1.02, wrist: 0.46, y: 0.03, fingers: 6, stations: [
      [0, -0.19, 0.27, 0.06], [0.2, -0.2, 0.26, 0.05], [0.42, -0.21, 0.24, 0.04], [0.6, -0.17, 0.22, 0.028], [0.78, -0.14, 0.19, 0.018],
    ] },
    folded: { len: 0.62, w: 0.06, h: 0.1 },
    legH: 0.2, footLen: 0.1, legR: 0.018,
    colors: { body: '#3a2a1e', back: '#4a3727', wingTop: '#3f2e21', tip: '#231a13', under: '#2c2219', bill: '#e5b83c', spot: '#e5b83c', eye: '#d8c65a', legs: '#e3b43a', tail: '#f1efe8', head: '#f2f0ea' },
    flapHz: 1.9,
  },
  puffin: {
    body: { z0: -0.1, z1: 0.13, keys: [
      { t: 0, cy: 0.012, rx: 0.036, ry: 0.04 }, { t: 0.3, cy: 0.0, rx: 0.058, ry: 0.06 }, { t: 0.6, cy: -0.004, rx: 0.058, ry: 0.058 },
      { t: 1, cy: 0.006, rx: 0.024, ry: 0.02 },
    ] },
    neck: [[0, 0.018, -0.085], [0, 0.03, -0.12]], neckR: 0.042,
    head: { c: [0, 0.036, -0.14], r: [0.042, 0.046, 0.05] },
    bill: { from: [0, 0.028, -0.176], to: [0, 0.02, -0.232], r0: 0.02, r1: 0.006, depth: 2.3, hook: 0.006 },
    eye: { c: [0.033, 0.05, -0.155], r: 0.006 },
    tail: { z0: 0.1, z1: 0.17, w0: 0.02, w1: 0.035, t: 0.01 },
    wing: { root: 0.03, half: 0.3, wrist: 0.12, y: 0.012, stations: [
      [0, -0.045, 0.06, 0.018], [0.1, -0.05, 0.055, 0.015], [0.2, -0.035, 0.05, 0.009], [0.3, 0.02, 0.05, 0.003],
    ] },
    folded: { len: 0.2, w: 0.03, h: 0.045 },
    legH: 0.07, footLen: 0.05, legR: 0.008,
    colors: { body: '#1d1d1f', back: '#19191b', wingTop: '#18181a', tip: '#141416', under: '#2d2d30', bill: '#e9532c', spot: '#c9ae55', eye: '#b42a1a', legs: '#f27a28', tail: '#18181a', face: '#f3f1ea', tuft: '#e8d596' },
    flapHz: 8.5,
  },
  cormorant: {
    body: { z0: -0.15, z1: 0.2, keys: [
      { t: 0, cy: 0.012, rx: 0.032, ry: 0.034 }, { t: 0.3, cy: 0.0, rx: 0.062, ry: 0.058 }, { t: 0.6, cy: -0.004, rx: 0.062, ry: 0.056 },
      { t: 1, cy: 0.008, rx: 0.024, ry: 0.02 },
    ] },
    neck: [[0, 0.012, -0.13], [0, 0.03, -0.25], [0, 0.042, -0.33]], neckR: 0.024,
    head: { c: [0, 0.046, -0.355], r: [0.026, 0.03, 0.04] },
    bill: { from: [0, 0.043, -0.39], to: [0, 0.036, -0.455], r0: 0.007, r1: 0.003, depth: 1.1, hook: 0.004 },
    eye: { c: [0.022, 0.054, -0.365], r: 0.005 },
    tail: { z0: 0.17, z1: 0.36, w0: 0.02, w1: 0.05, t: 0.012 },
    wing: { root: 0.03, half: 0.5, wrist: 0.2, y: 0.014, stations: [
      [0, -0.075, 0.1, 0.028], [0.1, -0.085, 0.095, 0.024], [0.22, -0.09, 0.08, 0.018], [0.36, -0.07, 0.07, 0.01], [0.5, -0.02, 0.05, 0.004],
    ] },
    folded: { len: 0.3, w: 0.032, h: 0.045 },
    legH: 0.1, footLen: 0.07, legR: 0.009,
    colors: { body: '#141816', back: '#1c231f', wingTop: '#1a201c', tip: '#101311', under: '#1a1c1b', bill: '#2a2a2a', spot: '#a63a2a', eye: '#2f7d54', legs: '#1a1a1a', tail: '#111312', flank: '#e8e6df' },
    flapHz: 5.2,
  },
};

export const BIRD_SPECS = Object.fromEntries(Object.entries(BIRDS).map(([k, v]) => [k, { flapHz: v.flapHz, half: v.wing.half, len: v.body.z1 - v.head.c[2] + v.tail.z1 - v.body.z1 }]));

// Builds one bird. pose: 'fly' (wings spread, origin at the body centre), 'perch' (standing, folded wings, origin at
// the feet), 'sit' (floating on water, origin at the waterline), 'spread' (standing, wings held out to dry).
export function buildBird(kind, { pose = 'fly', lod = 0 } = {}) {
  const B = BIRDS[kind];
  const C = Object.fromEntries(Object.entries(B.colors).map(([k, v]) => [k, lin(v)]));
  const segs = lod ? 6 : 10;
  const mb = new ModelBuilder();
  const neckPivot = [B.neck[0][1], B.neck[0][2]];
  const headRig = () => [3, 0, 0, 0];
  const headPiv = () => [neckPivot[0], neckPivot[1], 0, 0];
  const parts = [];
  const push = (part, opts) => parts.push({ part, opts });

  // Body with a darker mantle on the back.
  const bodyColor = (m) => {
    const top = sm(0.2, 0.75, (m.y - 0.0) / 0.07);
    let c = mix3(C.body, C.back, top * (kind === 'gull' ? 0.9 : 0.6));
    if (kind === 'eagle') c = mix3(C.body, C.back, top * 0.5);
    if (kind === 'puffin') c = mix3(C.under, C.body, sm(-0.03, 0.02, m.y));
    if (kind === 'cormorant' && pose !== 'fly' && m.z > 0.05 && m.z < 0.12 && m.y < 0 && Math.abs(m.x) > 0.03) c = C.flank;
    return c;
  };
  push(bodyLoft(B.body.keys, { z0: B.body.z0, z1: B.body.z1, rings: lod ? 8 : 14, segs }), { color: bodyColor, rig: () => [0, 0, 0, 0] });

  // Neck and head.
  const neckNodes = B.neck.map((p) => ({ p, rx: B.neckR, ry: B.neckR * 1.05 }));
  const headCol = kind === 'eagle' ? C.head : kind === 'puffin' ? C.body : C.body;
  push(tube(neckNodes, { segs, up: [0, 1, 0] }), { color: (m) => (kind === 'eagle' ? C.head : kind === 'puffin' ? (m.y > 0.02 ? C.body : C.under) : bodyColor(m)), rig: headRig, pivot: headPiv });
  push(ellipsoid(B.head.c, B.head.r, { rings: lod ? 5 : 8, segs }), {
    color: (m) => {
      if (kind === 'puffin') {
        // White face mask from the bill base back around the eye.
        const dz = m.z - B.head.c[2];
        const face = Math.abs(m.x) > 0.018 && m.y > B.head.c[1] - 0.03 && dz < 0.02 ? 1 : 0;
        return face ? C.face : C.body;
      }
      return headCol;
    },
    rig: headRig,
    pivot: headPiv,
    noise: 0.03,
  });
  // Bill: laterally compressed, slightly hooked.
  {
    const { from, to, r0, r1, depth, hook = 0 } = B.bill;
    const nodes = [];
    for (let i = 0; i <= 5; i++) {
      const t = i / 5;
      const p = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t - hook * Math.max(0, t - 0.6) * 2.5, from[2] + (to[2] - from[2]) * t];
      const r = r0 + (r1 - r0) * t;
      nodes.push({ p, rx: r * 0.8, ry: r * depth });
    }
    push(tube(nodes, { segs: lod ? 5 : 8, up: [0, 1, 0] }), {
      color: (m) => {
        const t = (m.z - from[2]) / (to[2] - from[2]);
        if (kind === 'gull' && t > 0.62 && t < 0.85 && m.y < from[1] - 0.004) return C.spot;
        if (kind === 'puffin' && t < 0.3) return C.spot;
        return C.bill;
      },
      rig: headRig,
      pivot: headPiv,
      noise: 0.02,
    });
  }
  if (!lod) {
    for (const sx of [-1, 1]) {
      const e = B.eye;
      push(ellipsoid([e.c[0] * sx, e.c[1], e.c[2]], [e.r, e.r, e.r], { rings: 4, segs: 6 }), { color: C.eye, rig: headRig, pivot: headPiv, noise: 0 });
    }
    if (kind === 'puffin') {
      // Straw-yellow tufts curling back from above the eyes.
      for (const sx of [-1, 1]) {
        const nodes = [];
        for (let i = 0; i <= 4; i++) {
          const t = i / 4;
          nodes.push({ p: [sx * (0.026 + 0.006 * t), 0.066 - 0.03 * t * t, -0.15 + 0.1 * t], rx: 0.009 * (1 - 0.6 * t), ry: 0.005 });
        }
        push(tube(nodes, { segs: 5 }), { color: C.tuft, rig: headRig, pivot: headPiv, noise: 0.05 });
      }
    }
  }

  // Tail fan (a blade spanning z, chord across x).
  {
    const T = B.tail;
    const st = [];
    for (let i = 0; i <= 3; i++) {
      const t = i / 3;
      const w = T.w0 + (T.w1 - T.w0) * t;
      st.push({ s: T.z0 + (T.z1 - T.z0) * t, lead: -w, trail: w, t: T.t * (1 - 0.6 * t), off: [0, 0.006, 0] });
    }
    push(blade(st, { axis: [0, 0, 1], chordAxis: [1, 0, 0], chords: 3 }), {
      color: (m) => (kind === 'gull' ? C.tail : kind === 'eagle' ? C.tail : C.tail),
      rig: () => [2, 0, 0, 0],
    });
  }

  const shoulder = B.wing.root;
  const wrist = B.wing.root + B.wing.wrist;
  if (pose === 'fly' || pose === 'spread') {
    for (const side of [-1, 1]) {
      const stations = B.wing.stations.map(([s, lead, trail, t]) => ({ s: s + shoulder, lead, trail, t, off: [0, B.wing.y, 0] }));
      const wingCol = (m) => {
        const along = (Math.abs(m.x) - shoulder) / B.wing.half;
        if (!m.top) {
          if (kind === 'gull') return along > 0.8 ? mix3(C.under, C.tip, 0.35) : C.under;
          return C.under;
        }
        let c = C.wingTop;
        if (kind === 'gull') {
          if (along > 0.72) c = mix3(C.wingTop, C.tip, sm(0.72, 0.9, along));
          // White "mirrors" near the tip and a white trailing edge.
          const trailing = m.z > (sampleKeysZ(B.wing.stations, along * B.wing.half) - 0.02);
          if (trailing && along < 0.85) c = mix3(c, C.body, 0.8);
          if (along > 0.9) c = mix3(c, C.body, 0.6);
        }
        if (kind === 'eagle') c = mix3(C.back, C.wingTop, sm(0.1, 0.4, (m.z + 0.15) / 0.4));
        return c;
      };
      const part = blade(stations, { axis: [side, 0, 0], chordAxis: [0, 0, 1], chords: lod ? 2 : 4, camber: 0.25 });
      push(part, { color: wingCol, rig: () => [1, side, shoulder, wrist], noise: 0.04 });
      if (B.wing.fingers) {
        // Eagle primaries: separate "fingers" fanning from the wing tip.
        const last = B.wing.stations[B.wing.stations.length - 1];
        const tipX = last[0] + shoulder;
        for (let f = 0; f < B.wing.fingers; f++) {
          const u = f / (B.wing.fingers - 1);
          const z0 = last[1] + 0.02 + (last[2] - last[1] - 0.06) * u;
          const ang = -0.25 + 0.95 * u; // fan: leading fingers point outward/forward, trailing ones sweep back
          const len = 0.26 - 0.08 * Math.abs(u - 0.35);
          const dir = [side * Math.cos(ang), 0, Math.sin(ang)];
          const nodes = [];
          for (let i = 0; i <= 3; i++) {
            const t = i / 3;
            nodes.push({
              p: [side * (tipX - 0.04) + dir[0] * len * t, B.wing.y + 0.012 * t * t, z0 + dir[2] * len * t],
              rx: 0.026 * (1 - 0.55 * t),
              ry: 0.006,
            });
          }
          push(tube(nodes, { segs: 4, up: [0, 1, 0] }), { color: (m) => (m.ny > 0 ? C.tip : C.under), rig: () => [1, side, shoulder, wrist], noise: 0.03 });
        }
      }
    }
  }
  if (pose === 'perch' || pose === 'sit') {
    // Folded wings along the flanks, tips crossing over the tail.
    const F = B.folded;
    for (const side of [-1, 1]) {
      const nodes = [];
      for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        const r = Math.sin(Math.PI * Math.min(1, 0.12 + t * 0.95)) ** 0.7;
        nodes.push({ p: [side * (B.body.keys[2].rx * 0.78 - 0.01 * t), B.wing.y + 0.012 - 0.018 * t, -0.07 + F.len * t], rx: F.w * r * 0.55 + 0.003, ry: F.h * r + 0.002 });
      }
      push(tube(nodes, { segs: lod ? 5 : 8, up: [0, 1, 0] }), {
        color: (m) => {
          const t = (m.z + 0.07) / F.len;
          let c = C.wingTop;
          if (kind === 'gull') c = t > 0.72 ? mix3(C.wingTop, C.tip, 0.6) : C.wingTop;
          if (kind === 'eagle') c = mix3(C.back, C.tip, sm(0.5, 1, t));
          return c;
        },
        rig: () => [0, 0, 0, 0],
        noise: 0.05,
      });
    }
  }
  // Poses other than flight tilt the whole bird up and sit it on its feet or on the water.
  let m = null;
  if (pose === 'perch') {
    const tilt = { gull: 0.18, eagle: 0.95, puffin: 0.45, cormorant: 1.05 }[kind];
    m = new THREE.Matrix4().makeTranslation(0, B.legH, 0).multiply(rotX(tilt, [0, -B.legH * 0.2, 0.04]));
  } else if (pose === 'spread') {
    m = new THREE.Matrix4().makeTranslation(0, B.legH, 0).multiply(rotX(1.05, [0, -B.legH * 0.2, 0.04]));
  } else if (pose === 'sit') {
    m = new THREE.Matrix4().makeTranslation(0, 0.035, 0).multiply(rotX(kind === 'puffin' ? 0.12 : 0.06));
  }
  const fixed = [];
  if (pose === 'perch' || pose === 'spread' || (pose === 'fly' && kind === 'puffin')) {
    // Legs and feet, built in the final frame so standing legs stay vertical (puffins trail their bright feet in
    // flight).
    const flying = pose === 'fly';
    for (const side of [-1, 1]) {
      const top = new THREE.Vector3(side * 0.03 * (B.wing.half / 0.5), -0.03, 0.05);
      if (m) top.applyMatrix4(m);
      const legTop = [top.x, top.y, top.z];
      const foot = flying ? [side * 0.02, -0.03, B.tail.z0 + 0.02] : [side * 0.035 * (B.wing.half / 0.5), 0.012, top.z];
      const nodes = [
        { p: legTop, rx: B.legR * 1.6, ry: B.legR * 1.6 },
        { p: [(legTop[0] + foot[0]) / 2, (legTop[1] + foot[1]) / 2, (legTop[2] + foot[2]) / 2], rx: B.legR, ry: B.legR },
        { p: foot, rx: B.legR * 0.9, ry: B.legR * 0.9 },
      ];
      fixed.push({ part: tube(nodes, { segs: 5, up: [0, 0, -1] }), opts: { color: C.legs, rig: () => [4, 0, 0, 0], noise: 0 } });
      fixed.push({
        part: ellipsoid([foot[0], foot[1] - (flying ? 0 : 0.006), foot[2] + (flying ? B.footLen * 0.5 : -B.footLen * 0.4)], [B.footLen * 0.45, 0.006, B.footLen * 0.6], { rings: 4, segs: 6 }),
        opts: { color: C.legs, rig: () => [4, 0, 0, 0], noise: 0 },
      });
    }
  }

  for (const { part, opts } of parts) {
    if (m) transformPart(part, m);
    mb.add(part, opts);
  }
  for (const { part, opts } of fixed) mb.add(part, opts);
  const geo = mb.build();
  if (m) {
    // Keep the head pivot consistent with the transformed head.
    const pv = new THREE.Vector3(0, neckPivot[0], neckPivot[1]).applyMatrix4(m);
    const a = geo.attributes.aPivot;
    for (let i = 0; i < a.count; i++) {
      if (geo.attributes.aRig.getX(i) === 3) a.setXY(i, pv.y, pv.z);
    }
  }
  geo.userData = { kind, pose, shoulder, wrist, half: B.wing.half };
  return geo;
}

function sampleKeysZ(stations, s) {
  // Trailing-edge z at span position s (for the gull's white trailing edge).
  for (let i = 1; i < stations.length; i++) {
    if (stations[i][0] >= s) {
      const a = stations[i - 1];
      const b = stations[i];
      const t = (s - a[0]) / Math.max(1e-6, b[0] - a[0]);
      return a[2] + (b[2] - a[2]) * t;
    }
  }
  return stations[stations.length - 1][2];
}

// ------------------------------------------------------------------------------------------------------ cetaceans

// Humpback whale, ~14 m. Knobby flattened rostrum, throat pleats, long white pectorals, small dorsal on a hump,
// broad serrated flukes with a black-and-white underside.
export function buildHumpback({ lod = 0 } = {}) {
  const L = 14;
  const z0 = -L / 2;
  const z1 = L / 2;
  const C = {
    back: lin('#1b2024'),
    side: lin('#2a3035'),
    belly: lin('#d7d6cf'),
    groove: lin('#5d6164'),
    pec: lin('#e4e3dc'),
    pecDark: lin('#30363a'),
    knob: lin('#2b2f31'),
    barnacle: lin('#c9c6bb'),
    flukeUnder: lin('#e2e0d8'),
  };
  const mb = new ModelBuilder();
  const keys = [
    { t: 0.0, cy: -0.08, rx: 0.16, ry: 0.07, pw: 2.4 },
    { t: 0.04, cy: -0.14, rx: 0.64, ry: 0.27, pw: 2.5 },
    { t: 0.12, cy: -0.26, rx: 1.08, ry: 0.6, pw: 2.3 },
    { t: 0.22, cy: -0.38, rx: 1.42, ry: 1.0 },
    { t: 0.34, cy: -0.3, rx: 1.66, ry: 1.3 },
    { t: 0.46, cy: -0.12, rx: 1.62, ry: 1.36 },
    { t: 0.58, cy: 0.0, rx: 1.32, ry: 1.22 },
    { t: 0.68, cy: 0.06, rx: 0.98, ry: 1.0 },
    { t: 0.78, cy: 0.06, rx: 0.56, ry: 0.76 },
    { t: 0.88, cy: 0.04, rx: 0.3, ry: 0.52 },
    { t: 0.95, cy: 0.02, rx: 0.2, ry: 0.3 },
    { t: 1.0, cy: 0.0, rx: 0.08, ry: 0.1 },
  ];
  const bodyCol = (m) => {
    const k = sampleKeys(keys, m.t);
    const v = (m.y - k.cy) / Math.max(0.05, k.ry); // -1 belly .. +1 back
    let c = mix3(C.side, C.back, sm(-0.1, 0.7, v));
    // Throat pleats: white belly with dark grooves from the chin to the navel.
    const throat = sm(0.02, 0.08, m.t) * (1 - sm(0.42, 0.52, m.t)) * sm(0.1, -0.55, v);
    if (throat > 0) {
      const g = Math.abs(Math.sin(m.x * 9.5)) ** 0.35;
      c = mix3(c, mix3(C.groove, C.belly, g), throat);
    }
    // Mottled white flanks and belly further back, barnacle scars on the chin.
    const belly = sm(0.3, -0.8, v) * sm(0.45, 0.6, m.t) * (1 - sm(0.8, 0.9, m.t));
    c = mix3(c, C.belly, belly * 0.55 * vnoise(m.x * 2.1, m.y * 2.1, m.z * 0.7));
    if (m.t < 0.12 && vnoise(m.x * 6, m.y * 6, m.z * 6) > 0.72) c = mix3(c, C.barnacle, 0.7);
    return c;
  };
  mb.add(bodyLoft(keys, { z0, z1, rings: lod ? 14 : 32, segs: lod ? 10 : 20 }), {
    color: bodyCol,
    rig: (m) => [(m.z - z0) / L, 0, 0, m.z < z0 + 3 ? 1 : 0],
    noise: 0.07,
    noiseScale: 1.4,
  });
  if (!lod) {
    // Tubercles on the rostrum and lower jaw.
    const k = [];
    for (let i = 0; i < 18; i++) {
      const t = 0.03 + (i % 6) * 0.018;
      const row = Math.floor(i / 6);
      const s = sampleKeys(keys, t);
      const z = z0 + L * t;
      if (row === 0) k.push([0, s.cy + s.ry * 0.96, z]);
      else {
        const sx = row === 1 ? 1 : -1;
        k.push([sx * s.rx * 0.55, s.cy + s.ry * 0.78, z]);
      }
    }
    for (const p of k) mb.add(ellipsoid(p, [0.09, 0.07, 0.09], { rings: 4, segs: 6 }), { color: C.knob, rig: () => [(p[2] - z0) / L, 0, 0, 1], noise: 0.05 });
  }
  // Small dorsal fin on the hump.
  {
    const t0 = 0.66;
    const s = sampleKeys(keys, t0);
    const base = s.cy + s.ry * 0.93;
    const st = [
      { s: 0, lead: -0.45, trail: 0.4, t: 0.18 },
      { s: 0.22, lead: -0.2, trail: 0.35, t: 0.12 },
      { s: 0.36, lead: 0.12, trail: 0.3, t: 0.05 },
    ];
    mb.add(blade(st, { axis: [0, 1, 0], chordAxis: [0, 0, 1], origin: [0, base - 0.05, z0 + L * t0], chords: 3 }), {
      color: C.back,
      rig: (m) => [(m.z - z0) / L, 4, 0, 0],
    });
  }
  // Pectoral fins: ~1/3 of the body, white, knobby leading edge.
  for (const side of [-1, 1]) {
    const rootZ = z0 + L * 0.3;
    const rootY = -0.95;
    const rootX = side * 1.25;
    const len = 4.4;
    const st = [];
    for (let i = 0; i <= (lod ? 4 : 9); i++) {
      const t = i / (lod ? 4 : 9);
      const chord = 1.2 * (1 - t) ** 0.8 * (1 - 0.15 * t) + 0.2 * t + 0.09 * Math.abs(Math.sin(t * 16)) * (1 - t) * (lod ? 0 : 1);
      st.push({ s: len * t, lead: -chord * 0.35, trail: chord * 0.65, t: 0.2 * (1 - 0.8 * t), off: [0, 0, len * t * 0.55] });
    }
    const dir = [side * 0.78, -0.6, 0];
    const part = blade(st, { axis: dir, chordAxis: [0, 0, 1], origin: [rootX, rootY, rootZ], chords: lod ? 2 : 4 });
    mb.add(part, {
      color: (m) => (m.ny > 0.3 && vnoise(m.x * 1.7, m.y * 1.7, m.z * 1.7) > 0.55 ? C.pecDark : C.pec),
      rig: (m) => [0.3, side < 0 ? 1 : 2, Math.min(1, Math.hypot(m.x - rootX, m.y - rootY) / 3), 0],
      pivot: () => [rootY, rootZ, rootX, 0],
      noise: 0.05,
    });
  }
  // Flukes: wide, swept, serrated trailing edge and a centre notch.
  {
    const rootZ = z0 + L * 0.965;
    for (const side of [-1, 1]) {
      const st = [];
      const n = lod ? 4 : 10;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const sweep = 0.75 * t * t;
        const chord = 1.25 * (1 - t * t * 0.8) + 0.05;
        const serr = lod ? 0 : 0.06 * Math.abs(Math.sin(t * 23));
        st.push({ s: 2.25 * t, lead: sweep - 0.45 + (i === 0 ? 0 : 0), trail: sweep - 0.45 + chord - serr - (i === 0 ? 0.25 : 0), t: 0.16 * (1 - 0.85 * t) });
      }
      mb.add(blade(st, { axis: [side, 0, 0], chordAxis: [0, 0, 1], origin: [0, 0, rootZ], chords: lod ? 2 : 4 }), {
        color: (m) => (m.top ? C.back : vnoise(m.x * 2.2 + side, m.z * 2.2, 3) > 0.42 ? C.flukeUnder : C.back),
        rig: (m) => [Math.min(1.08, (m.z - z0) / L), 3, Math.abs(m.x) / 2.25, 0],
        pivot: () => [0, rootZ, 0, 0],
      });
    }
  }
  const geo = mb.build();
  geo.userData = { kind: 'humpback', length: L };
  return geo;
}

// Orca, ~7 m (male) with a 1.8 m straight dorsal, or ~6 m (female/juvenile) with a falcate one.
export function buildOrca({ male = true, lod = 0 } = {}) {
  const L = male ? 7.2 : 6.2;
  const z0 = -L / 2;
  const z1 = L / 2;
  const C = { black: lin('#0d0f11'), white: lin('#eceae3'), grey: lin('#8d9194') };
  const keys = [
    { t: 0.0, cy: -0.02, rx: 0.1, ry: 0.1 },
    { t: 0.06, cy: -0.03, rx: 0.36, ry: 0.34 },
    { t: 0.16, cy: -0.02, rx: 0.6, ry: 0.6 },
    { t: 0.32, cy: 0.0, rx: 0.8, ry: 0.84 },
    { t: 0.48, cy: 0.02, rx: 0.78, ry: 0.82 },
    { t: 0.64, cy: 0.04, rx: 0.56, ry: 0.66 },
    { t: 0.8, cy: 0.04, rx: 0.3, ry: 0.46 },
    { t: 0.92, cy: 0.02, rx: 0.16, ry: 0.22 },
    { t: 1.0, cy: 0.0, rx: 0.05, ry: 0.06 },
  ].map((k) => ({ ...k, rx: (k.rx * L) / 7.2, ry: (k.ry * L) / 7.2, cy: (k.cy * L) / 7.2 }));
  const mb = new ModelBuilder();
  const col = (m) => {
    const k = sampleKeys(keys, m.t);
    const v = (m.y - k.cy) / Math.max(0.05, k.ry);
    const side = Math.abs(m.x) / Math.max(0.05, k.rx);
    // Eye patch: an oval above and behind the eye.
    const ex = (m.t - 0.17) / 0.055;
    const ey = (v - 0.32) / 0.2;
    if (ex * ex + ey * ey < 1 && side > 0.55) return C.white;
    // White chin and belly, the flank patch sweeping up behind the dorsal.
    const bellyEdge = -0.35 + 0.95 * sm(0.52, 0.66, m.t) * (1 - sm(0.72, 0.8, m.t));
    if (v < bellyEdge && m.t < 0.8 && !(m.t > 0.3 && m.t < 0.5 && side > 0.75 && v > -0.55)) return C.white;
    // Grey saddle patch behind the dorsal.
    if (m.t > 0.46 && m.t < 0.58 && v > 0.62) return mix3(C.black, C.grey, 0.7);
    return C.black;
  };
  mb.add(bodyLoft(keys, { z0, z1, rings: lod ? 12 : 30, segs: lod ? 10 : 20 }), {
    color: col,
    rig: (m) => [(m.z - z0) / L, 0, 0, m.t < 0.2 ? 1 : 0],
    noise: 0.02,
  });
  // Dorsal fin.
  {
    const t0 = 0.4;
    const s = sampleKeys(keys, t0);
    const h = male ? 1.8 : 0.9;
    const n = 6;
    const st = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const falc = male ? 0 : 0.45 * t * t;
      const chord = (male ? 1.0 : 0.8) * (1 - t) + 0.08;
      st.push({ s: h * t, lead: -chord * 0.55 + falc + (male ? 0.35 * t : 0.1 * t), trail: chord * 0.45 + falc + (male ? 0.05 * t : 0.2 * t), t: 0.14 * (1 - 0.8 * t) });
    }
    mb.add(blade(st, { axis: [0, 1, 0], chordAxis: [0, 0, 1], origin: [0, s.cy + s.ry * 0.9, z0 + L * t0], chords: 3 }), {
      color: C.black,
      rig: (m) => [(m.z - z0) / L, 4, 0, 0],
    });
  }
  for (const side of [-1, 1]) {
    const rootZ = z0 + L * 0.25;
    const rootY = -0.45;
    const rootX = side * 0.55;
    const st = [];
    for (let i = 0; i <= 4; i++) {
      const t = i / 4;
      const chord = 0.55 * Math.sqrt(Math.max(0.05, 1 - t * t)) + 0.05;
      st.push({ s: 0.95 * t, lead: -chord * 0.4, trail: chord * 0.6, t: 0.09 * (1 - 0.6 * t), off: [0, 0, 0.35 * t] });
    }
    mb.add(blade(st, { axis: [side * 0.8, -0.6, 0], chordAxis: [0, 0, 1], origin: [rootX, rootY, rootZ], chords: 3 }), {
      color: C.black,
      rig: (m) => [0.25, side < 0 ? 1 : 2, Math.min(1, Math.hypot(m.x - rootX, m.y - rootY)), 0],
      pivot: () => [rootY, rootZ, rootX, 0],
    });
  }
  {
    const rootZ = z0 + L * 0.965;
    for (const side of [-1, 1]) {
      const st = [];
      for (let i = 0; i <= 5; i++) {
        const t = i / 5;
        st.push({ s: 0.95 * t, lead: 0.35 * t * t - 0.2, trail: 0.35 * t * t - 0.2 + 0.55 * (1 - 0.75 * t * t) + 0.04, t: 0.07 * (1 - 0.8 * t) });
      }
      mb.add(blade(st, { axis: [side, 0, 0], chordAxis: [0, 0, 1], origin: [0, 0, rootZ], chords: 3 }), {
        color: (m) => (m.top ? C.black : mix3(C.black, C.white, 0.85)),
        rig: (m) => [Math.min(1.08, (m.z - z0) / L), 3, Math.abs(m.x), 0],
        pivot: () => [0, rootZ, 0, 0],
      });
    }
  }
  const geo = mb.build();
  geo.userData = { kind: 'orca', length: L, male };
  return geo;
}

// --------------------------------------------------------------------------------------------------- pinnipeds

// Steller sea lion lying on a rock (origin on the ground under the chest; a hidden skirt extends 0.8 m below so a
// coarser terrain LOD never shows daylight under the body). bull: 3 m with a heavy maned neck; cow: 2.3 m.
export function buildSeaLion({ bull = false, lod = 0 } = {}) {
  const S = bull ? 1.28 : 1;
  const L = 2.3 * S;
  const z0 = -L / 2;
  const z1 = L / 2;
  const C = bull
    ? { back: lin('#8d6a45'), belly: lin('#4e3a28'), mane: lin('#6f5134'), flipper: lin('#2b211a'), muzzle: lin('#3a2c20'), eye: lin('#0b0a09') }
    : { back: lin('#b8905c'), belly: lin('#7a5b3d'), mane: lin('#b08858'), flipper: lin('#3a2a1f'), muzzle: lin('#5a4430'), eye: lin('#0b0a09') };
  const neck = bull ? 1.35 : 1;
  const keys = [
    { t: 0.0, cy: 0.42, rx: 0.035, ry: 0.035 },
    { t: 0.05, cy: 0.43, rx: 0.07, ry: 0.07 },
    { t: 0.12, cy: 0.45, rx: 0.12, ry: 0.12 },
    { t: 0.2, cy: 0.4, rx: 0.15 * neck, ry: 0.16 * neck },
    { t: 0.34, cy: 0.3, rx: 0.3, ry: 0.27 * (bull ? 1.1 : 1) },
    { t: 0.5, cy: 0.27, rx: 0.33, ry: 0.27 },
    { t: 0.66, cy: 0.23, rx: 0.27, ry: 0.23 },
    { t: 0.8, cy: 0.16, rx: 0.17, ry: 0.15 },
    { t: 0.92, cy: 0.1, rx: 0.09, ry: 0.08 },
    { t: 1.0, cy: 0.08, rx: 0.03, ry: 0.03 },
  ].map((k) => ({ ...k, cy: k.cy * S, rx: k.rx * S, ry: k.ry * S }));
  const neckY = 0.36 * S;
  const neckZ = z0 + L * 0.3;
  const mb = new ModelBuilder();
  mb.add(bodyLoft(keys, { z0, z1, rings: lod ? 12 : 22, segs: lod ? 8 : 14 }), {
    color: (m) => {
      const k = sampleKeys(keys, m.t);
      const v = (m.y - k.cy) / Math.max(0.03, k.ry);
      let c = mix3(C.belly, C.back, sm(-0.6, 0.3, v));
      if (m.t < 0.26 && m.t > 0.14) c = mix3(c, C.mane, 0.5);
      if (m.t < 0.07) c = mix3(c, C.muzzle, 0.8);
      return c;
    },
    rig: (m) => [(m.z - z0) / L, 0, 0, 1 - sm(0.2, 0.34, (m.z - z0) / L)],
    pivot: () => [neckY, neckZ, 0, 0],
    noise: 0.08,
    noiseScale: 5,
  });
  // Hidden skirt under the chest and belly.
  mb.add(ellipsoid([0, -0.35 * S, z0 + L * 0.55], [0.26 * S, 0.5 * S, 0.62 * S], { rings: 5, segs: 8 }), { color: C.belly, rig: () => [0.55, 0, 0, 0], noise: 0 });
  if (!lod) {
    for (const sx of [-1, 1]) {
      mb.add(ellipsoid([sx * 0.075 * S, 0.5 * S, z0 + L * 0.1], [0.018 * S, 0.018 * S, 0.018 * S], { rings: 4, segs: 6 }), { color: C.eye, rig: () => [0.1, 0, 0, 1], pivot: () => [neckY, neckZ, 0, 0], noise: 0 });
    }
  }
  // Fore flippers splayed on the rock, hind flippers trailing.
  for (const side of [-1, 1]) {
    const rz = z0 + L * 0.36;
    const st = [0, 0.25, 0.5].map((s, i) => ({ s: s * S, lead: -0.12 * S, trail: (0.1 - 0.05 * i) * S, t: 0.05 * S * (1 - 0.5 * i) }));
    mb.add(blade(st, { axis: [side * 0.8, -0.35, 0.45], chordAxis: [0, 0, 1], origin: [side * 0.22 * S, 0.12 * S, rz], chords: 2 }), {
      color: C.flipper,
      rig: () => [0.36, side < 0 ? 1 : 2, 0.5, 0],
      pivot: () => [0.12 * S, rz, side * 0.22 * S, 0],
    });
    const hz = z0 + L * 0.9;
    const st2 = [0, 0.18, 0.36].map((s, i) => ({ s: s * S, lead: -0.08 * S, trail: (0.08 + 0.04 * i) * S, t: 0.04 * S * (1 - 0.4 * i) }));
    mb.add(blade(st2, { axis: [side * 0.45, -0.1, 0.9], chordAxis: [side, 0, 0], origin: [side * 0.05 * S, 0.06 * S, hz], chords: 2 }), {
      color: C.flipper,
      rig: () => [0.95, 3, 0.5, 0],
      pivot: () => [0.06 * S, hz, 0, 0],
    });
  }
  const geo = mb.build();
  geo.userData = { kind: 'sealion', length: L, bull };
  return geo;
}

// Harbor seal, ~1.6 m: dappled grey with dark spots; lying on a rock or beach (origin on the ground).
export function buildSeal({ lod = 0 } = {}) {
  const L = 1.6;
  const z0 = -L / 2;
  const z1 = L / 2;
  const C = { grey: lin('#8e918b'), pale: lin('#bcb8aa'), spot: lin('#3d3f3b'), dark: lin('#2b2c29'), eye: lin('#070707') };
  const keys = [
    { t: 0.0, cy: 0.2, rx: 0.03, ry: 0.03 },
    { t: 0.05, cy: 0.21, rx: 0.06, ry: 0.06 },
    { t: 0.12, cy: 0.22, rx: 0.1, ry: 0.1 },
    { t: 0.2, cy: 0.21, rx: 0.13, ry: 0.13 },
    { t: 0.4, cy: 0.19, rx: 0.2, ry: 0.19 },
    { t: 0.6, cy: 0.17, rx: 0.19, ry: 0.17 },
    { t: 0.78, cy: 0.12, rx: 0.12, ry: 0.11 },
    { t: 0.9, cy: 0.08, rx: 0.06, ry: 0.06 },
    { t: 1.0, cy: 0.07, rx: 0.025, ry: 0.025 },
  ];
  const mb = new ModelBuilder();
  const neckY = 0.2;
  const neckZ = z0 + L * 0.25;
  mb.add(bodyLoft(keys, { z0, z1, rings: lod ? 10 : 20, segs: lod ? 8 : 12 }), {
    color: (m) => {
      const k = sampleKeys(keys, m.t);
      const v = (m.y - k.cy) / Math.max(0.03, k.ry);
      let c = mix3(C.pale, C.grey, sm(-0.5, 0.3, v));
      if (vnoise(m.x * 22, m.y * 22, m.z * 22) > 0.7) c = mix3(c, C.spot, 0.75);
      if (m.t < 0.04) c = C.dark;
      return c;
    },
    rig: (m) => {
      const t = (m.z - z0) / L;
      return [t, 0, 0, t < 0.5 ? 1 - sm(0.16, 0.3, t) : -sm(0.7, 0.95, t)];
    },
    pivot: (m) => ((m.z - z0) / L > 0.6 ? [0.12, z0 + L * 0.72, 0, 0] : [neckY, neckZ, 0, 0]),
    noise: 0.05,
  });
  mb.add(ellipsoid([0, -0.25, z0 + L * 0.5], [0.16, 0.34, 0.45], { rings: 5, segs: 8 }), { color: C.pale, rig: () => [0.5, 0, 0, 0], noise: 0 });
  if (!lod) for (const sx of [-1, 1]) mb.add(ellipsoid([sx * 0.06, 0.25, z0 + L * 0.08], [0.02, 0.02, 0.02], { rings: 4, segs: 6 }), { color: C.eye, rig: () => [0.08, 0, 0, 1], pivot: () => [neckY, neckZ, 0, 0], noise: 0 });
  for (const side of [-1, 1]) {
    const rz = z0 + L * 0.34;
    const st = [0, 0.1, 0.2].map((s, i) => ({ s, lead: -0.06, trail: 0.05, t: 0.03 * (1 - 0.4 * i) }));
    mb.add(blade(st, { axis: [side * 0.7, -0.6, 0.3], chordAxis: [0, 0, 1], origin: [side * 0.15, 0.1, rz], chords: 2 }), { color: C.grey, rig: () => [0.34, side < 0 ? 1 : 2, 0.5, 0], pivot: () => [0.1, rz, side * 0.15, 0] });
    const st2 = [0, 0.1, 0.2].map((s, i) => ({ s, lead: -0.05, trail: 0.06 + 0.03 * i, t: 0.025 }));
    mb.add(blade(st2, { axis: [side * 0.3, 0, 1], chordAxis: [side, 0, 0], origin: [side * 0.03, 0.07, z0 + L * 0.94], chords: 2 }), { color: C.dark, rig: () => [0.97, 3, 0.5, -1], pivot: () => [0.12, z0 + L * 0.72, 0, 0] });
  }
  const geo = mb.build();
  geo.userData = { kind: 'seal', length: L };
  return geo;
}

// Sea otter floating on its back (origin at the waterline): dark brown body, grizzled cream head, forepaws on the
// chest, hind flippers raised, flat tail trailing. Pups use the same model scaled down.
export function buildOtter({ lod = 0 } = {}) {
  const C = { fur: lin('#3f2f24'), belly: lin('#5a4535'), head: lin('#c8b597'), nose: lin('#1b1614'), eye: lin('#070707'), paw: lin('#2c211a') };
  const keys = [
    { t: 0.0, cy: 0.02, rx: 0.06, ry: 0.05 },
    { t: 0.2, cy: 0.0, rx: 0.14, ry: 0.11 },
    { t: 0.5, cy: -0.01, rx: 0.16, ry: 0.12 },
    { t: 0.8, cy: -0.01, rx: 0.12, ry: 0.09 },
    { t: 1.0, cy: 0.0, rx: 0.05, ry: 0.04 },
  ];
  const z0 = -0.42;
  const z1 = 0.42;
  const mb = new ModelBuilder();
  mb.add(bodyLoft(keys, { z0, z1, rings: lod ? 8 : 14, segs: lod ? 8 : 12 }), {
    color: (m) => mix3(C.fur, C.belly, sm(0.0, 0.1, m.y)),
    rig: (m) => [(m.z - z0) / (z1 - z0), 0, 0, 0],
    noise: 0.1,
    noiseScale: 14,
  });
  // Head held up off the water, looking along the body.
  const headC = [0, 0.1, -0.5];
  mb.add(ellipsoid(headC, [0.075, 0.07, 0.08], { rings: lod ? 5 : 7, segs: lod ? 7 : 10 }), {
    color: (m) => (m.z < headC[2] - 0.07 && Math.abs(m.x) < 0.02 && m.y > headC[1] ? C.nose : C.head),
    rig: () => [0, 0, 0, 1],
    pivot: () => [0.03, -0.4, 0, 0],
    noise: 0.07,
    noiseScale: 30,
  });
  mb.add(tube([{ p: [0, 0.03, -0.38], rx: 0.07, ry: 0.06 }, { p: [0, 0.07, -0.46], rx: 0.06, ry: 0.055 }], { segs: 8 }), {
    color: C.head,
    rig: () => [0, 0, 0, 1],
    pivot: () => [0.03, -0.4, 0, 0],
  });
  if (!lod) {
    for (const sx of [-1, 1]) mb.add(ellipsoid([sx * 0.04, 0.14, -0.53], [0.01, 0.01, 0.01], { rings: 4, segs: 5 }), { color: C.eye, rig: () => [0, 0, 0, 1], pivot: () => [0.03, -0.4, 0, 0], noise: 0 });
  }
  // Forepaws folded on the chest.
  for (const sx of [-1, 1]) {
    mb.add(ellipsoid([sx * 0.06, 0.12, -0.2], [0.035, 0.03, 0.05], { rings: 4, segs: 6 }), { color: C.paw, rig: () => [0.25, sx < 0 ? 1 : 2, 1, 0], pivot: () => [0.08, -0.25, sx * 0.08, 0] });
  }
  // Hind flippers raised out of the water, and the flat tail.
  for (const sx of [-1, 1]) {
    const st = [0, 0.08, 0.16].map((s, i) => ({ s, lead: -0.04, trail: 0.05 + 0.02 * i, t: 0.02 }));
    mb.add(blade(st, { axis: [sx * 0.35, 0.55, 0.75], chordAxis: [sx, 0, 0], origin: [sx * 0.07, 0.03, 0.36], chords: 2 }), { color: C.paw, rig: () => [0.95, 3, 0.5, 0], pivot: () => [0.03, 0.36, 0, 0] });
  }
  const tail = [0, 0.1, 0.2, 0.3].map((s, i) => ({ s, lead: -0.045, trail: 0.045, t: 0.025 * (1 - 0.3 * i) }));
  mb.add(blade(tail, { axis: [0, 0, 1], chordAxis: [1, 0, 0], origin: [0, -0.005, 0.4], chords: 2 }), { color: C.fur, rig: () => [1, 3, 0.5, 0], pivot: () => [0, 0.4, 0, 0] });
  const geo = mb.build();
  geo.userData = { kind: 'otter', length: 1.3 };
  return geo;
}

// ---------------------------------------------------------------------------------------------------- quadrupeds

export const QUADS = {
  deer: {
    len: 1.25, shoulderH: 0.84, hipH: 0.86, girth: 0.19, hump: 0.0, neck: 0.34, neckUp: 0.8, headLen: 0.22, headR: 0.062, snout: 0.1, snoutR: 0.032,
    ear: 0.085, earLong: true, legTop: 0.05, legBot: 0.017, paw: [0.02, 0.025, 0.035], tail: 0.16, legX: 0.09, slim: true,
    colors: { coat: '#8a5a36', tips: '#97683f', legs: '#5a3c26', face: '#7c5d41', nose: '#141110', ear: '#5e4330', rump: '#e9e2d3', tail: '#1c1714' },
  },
  goat: {
    len: 1.3, shoulderH: 0.95, hipH: 0.88, girth: 0.27, hump: 0.06, neck: 0.3, neckUp: 0.4, headLen: 0.26, headR: 0.08, snout: 0.1, snoutR: 0.045,
    ear: 0.05, horns: true, beard: true, legTop: 0.1, legBot: 0.05, paw: [0.045, 0.05, 0.06], tail: 0.06, legX: 0.13,
    colors: { coat: '#eceae1', tips: '#f6f4ec', legs: '#dcd8cc', face: '#efede6', nose: '#1a1a1a', ear: '#dedbd0', horn: '#141414' },
  },
  fox: {
    len: 0.62, shoulderH: 0.38, hipH: 0.38, girth: 0.1, hump: 0.0, neck: 0.16, neckUp: 0.5, headLen: 0.17, headR: 0.05, snout: 0.09, snoutR: 0.022,
    ear: 0.05, earLong: true, earPointed: true, legTop: 0.035, legBot: 0.018, paw: [0.02, 0.02, 0.035], tail: 0.4, tailBushy: true, legX: 0.05, slim: true,
    colors: { coat: '#c8662a', tips: '#d97a36', legs: '#2a1d16', face: '#cf7234', nose: '#141110', ear: '#2e2019', rump: '#f1ece2', tail: '#f3efe6' },
  },
};

// Parametric quadruped (deer, goat, fox; the bears have their own builder in bear.js). Origin between the feet on the
// ground; faces -z.
export function buildQuadruped(kind, { lod = 0 } = {}) {
  const P = QUADS[kind];
  const C = Object.fromEntries(Object.entries(P.colors).map(([k, v]) => [k, lin(v)]));
  const mb = new ModelBuilder();
  const L = P.len;
  const zChest = -L / 2;
  const zRump = L / 2;
  const segs = lod ? 7 : 12;
  // Leg joints: shoulder and hip, inside the body.
  const fz = zChest + L * 0.2;
  const hz = zRump - L * 0.2;
  const fJointY = P.shoulderH - P.girth * 0.75;
  const hJointY = P.hipH - P.girth * 0.7;
  const bodyKeys = [
    { t: 0.0, cy: P.shoulderH - P.girth * 1.05, rx: P.girth * 0.55, ry: P.girth * 0.6 },
    { t: 0.12, cy: P.shoulderH - P.girth * 0.95 + P.hump * 0.3, rx: P.girth * 0.88, ry: P.girth * 0.95 + P.hump * 0.3 },
    { t: 0.28, cy: P.shoulderH - P.girth * 0.95 + P.hump * 0.6, rx: P.girth * 0.95, ry: P.girth * 1.0 + P.hump * 0.6 },
    { t: 0.5, cy: (P.shoulderH + P.hipH) / 2 - P.girth * 1.0, rx: P.girth * (P.slim ? 0.85 : 1.0), ry: P.girth * 0.95 },
    { t: 0.75, cy: P.hipH - P.girth * 0.9, rx: P.girth * 0.92, ry: P.girth * 0.9 },
    { t: 0.92, cy: P.hipH - P.girth * 0.85, rx: P.girth * 0.7, ry: P.girth * 0.72 },
    { t: 1.0, cy: P.hipH - P.girth * 0.9, rx: P.girth * 0.25, ry: P.girth * 0.3 },
  ];
  const coatCol = (m) => {
    const k = sampleKeys(bodyKeys, Math.min(1, Math.max(0, m.t ?? 0.5)));
    const v = (m.y - k.cy) / Math.max(0.02, k.ry);
    let c = mix3(scale3(C.coat, 0.78), C.coat, sm(-0.8, 0.0, v));
    c = mix3(c, C.tips, sm(0.35, 0.95, v) * 0.85);
    if (C.rump && m.t > 0.86 && v > -0.4) c = mix3(c, C.rump, 0.9 * sm(0.86, 0.95, m.t));
    if (kind === 'deer' && v < -0.55) c = mix3(c, C.rump, 0.5);
    if (kind === 'fox' && v < -0.35 && m.t < 0.4) c = mix3(c, C.rump, 0.85);
    return c;
  };
  mb.add(bodyLoft(bodyKeys, { z0: zChest, z1: zRump, rings: lod ? 9 : 16, segs }), {
    color: coatCol,
    rig: () => [0, 0, 0, 0],
    noise: kind === 'goat' ? 0.05 : 0.12,
    noiseScale: 11,
  });
  // Neck and head: from the shoulders forward (and up for deer, goats, foxes).
  const up = P.neckUp ?? 0.05;
  const nb = [0, P.shoulderH - P.girth * 0.55 + P.hump * 0.3, zChest + L * 0.08];
  const nd = [0, Math.sin(up) * P.neck, -Math.cos(up) * P.neck];
  const hc = [nb[0] + nd[0], nb[1] + nd[1], nb[2] + nd[2]];
  const neckPiv = () => [nb[1], nb[2] + L * 0.06, 0, 0];
  mb.add(
    tube(
      [
        { p: [nb[0], nb[1] - P.girth * 0.1, nb[2] + 0.1 * L], rx: P.girth * 0.72, ry: P.girth * 0.78 },
        { p: nb, rx: P.girth * 0.62, ry: P.girth * 0.68 },
        { p: [nb[0] + nd[0] * 0.5, nb[1] + nd[1] * 0.5, nb[2] + nd[2] * 0.5], rx: P.headR * 1.1 + P.girth * 0.12, ry: P.headR * 1.2 + P.girth * 0.15 },
        { p: hc, rx: P.headR * 1.05, ry: P.headR * 1.1 },
      ],
      { segs },
    ),
    { color: (m) => mix3(coatCol({ ...m, t: 0.1 }), C.face, 0.2), rig: (m) => [0, 0, sm(nb[2] + 0.07 * L, hc[2], m.z), 0], pivot: neckPiv, noise: 0.1, noiseScale: 11 },
  );
  // Head: skull + snout (dished face for bears).
  const headDown = kind === 'deer' || kind === 'goat' ? 0.9 : 0.35;
  const hdir = [0, -Math.sin(headDown), -Math.cos(headDown)];
  const skull = [hc[0] + hdir[0] * P.headLen * 0.25, hc[1] + hdir[1] * P.headLen * 0.25 + P.headR * 0.1, hc[2] + hdir[2] * P.headLen * 0.25];
  mb.add(ellipsoid(skull, [P.headR * (kind === 'fox' ? 1.1 : 1.0), P.headR * 0.95, P.headLen * 0.45], { rings: lod ? 5 : 7, segs, rot: [-headDown * 0.6, 0, 0] }), {
    color: C.face,
    rig: () => [0, 0, 1, 0],
    pivot: neckPiv,
    noise: 0.08,
  });
  const snoutEnd = [skull[0] + hdir[0] * (P.headLen * 0.4 + P.snout), skull[1] + hdir[1] * (P.headLen * 0.4 + P.snout) - P.snoutR * 0.3, skull[2] + hdir[2] * (P.headLen * 0.4 + P.snout)];
  mb.add(
    tube(
      [
        { p: skull, rx: P.headR * 0.7, ry: P.headR * 0.6 },
        { p: [(skull[0] + snoutEnd[0]) / 2, (skull[1] + snoutEnd[1]) / 2, (skull[2] + snoutEnd[2]) / 2], rx: P.snoutR * 1.15, ry: P.snoutR * 1.05 },
        { p: snoutEnd, rx: P.snoutR * 0.85, ry: P.snoutR * 0.75 },
      ],
      { segs },
    ),
    {
      color: (m) => {
        const d = Math.hypot(m.x - snoutEnd[0], m.y - snoutEnd[1], m.z - snoutEnd[2]);
        if (d < P.snoutR * 0.9) return C.nose;
        return C.face;
      },
      rig: () => [0, 0, 1, 0],
      pivot: neckPiv,
      noise: 0.06,
    },
  );
  // Ears.
  for (const sx of [-1, 1]) {
    const ec = [sx * P.headR * 0.7, skull[1] + P.headR * 0.85, skull[2] + P.headLen * 0.12];
    const er = P.earLong ? [P.ear * 0.35, P.ear * (P.earPointed ? 1.2 : 0.9), P.ear * 0.18] : [P.ear * 0.55, P.ear * 0.55, P.ear * 0.3];
    mb.add(ellipsoid(ec, er, { rings: 4, segs: 6, rot: [0, 0, sx * (P.earLong ? -0.45 : -0.2)] }), { color: C.ear, rig: () => [0, 0, 1, 0], pivot: neckPiv, noise: 0.05 });
  }
  if (P.horns) {
    for (const sx of [-1, 1]) {
      const b = [sx * P.headR * 0.4, skull[1] + P.headR * 0.8, skull[2] - P.headLen * 0.05];
      const nodes = [0, 0.33, 0.66, 1].map((t) => ({ p: [b[0] + sx * 0.01 * t, b[1] + 0.17 * t - 0.03 * t * t, b[2] + 0.06 * t * t + 0.02 * t], rx: 0.016 * (1 - 0.8 * t) + 0.003, ry: 0.016 * (1 - 0.8 * t) + 0.003 }));
      mb.add(tube(nodes, { segs: 5 }), { color: C.horn, rig: () => [0, 0, 1, 0], pivot: neckPiv, noise: 0 });
    }
  }
  if (P.beard) {
    mb.add(ellipsoid([0, skull[1] - P.headR * 1.1, skull[2] - P.headLen * 0.25], [0.03, 0.08, 0.035], { rings: 4, segs: 6 }), { color: C.coat, rig: () => [0, 0, 1, 0], pivot: neckPiv });
  }
  if (!lod) {
    for (const sx of [-1, 1]) {
      mb.add(ellipsoid([sx * P.headR * 0.62, skull[1] + P.headR * 0.25, skull[2] - P.headLen * 0.28], [P.headR * 0.1, P.headR * 0.1, P.headR * 0.1], { rings: 3, segs: 5 }), {
        color: C.nose,
        rig: () => [0, 0, 1, 0],
        pivot: neckPiv,
        noise: 0,
      });
    }
  }
  // Legs: shoulder/hip joint to the ground, with a paw or hoof.
  const legs = [
    [1, -1, fz, fJointY],
    [2, 1, fz, fJointY],
    [3, -1, hz, hJointY],
    [4, 1, hz, hJointY],
  ];
  for (const [id, sx, jz, jy] of legs) {
    const hind = id > 2;
    const x = sx * P.legX;
    const kneeY = jy * 0.45;
    const nodes = [];
    const n = lod ? 3 : 6;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const y = jy + (0 - jy) * t;
      // Hind legs angle back through the hock; bears stand plantigrade.
      const bend = hind && P.slim ? 0.08 * Math.sin(Math.PI * t) * L * 0.2 : 0;
      const r = P.legTop + (P.legBot - P.legTop) * t ** 0.8 + (hind ? P.legTop * 0.3 * (1 - t) ** 3 : 0);
      nodes.push({ p: [x, Math.max(y, P.paw[1] * 0.4), jz + bend + (hind ? 0.02 * L * t : 0)], rx: r, ry: r * 1.05 });
    }
    const legT = (m) => Math.min(1, Math.max(0, 1 - m.y / jy));
    mb.add(tube(nodes, { segs: lod ? 5 : 8, up: [0, 0, -1] }), {
      color: (m) => mix3(scale3(C.coat, 0.85), C.legs, sm(0.05, 0.5, legT(m))),
      rig: (m) => [id, legT(m), 0, 0],
      pivot: () => [jy, jz, kneeY, 0],
      noise: 0.1,
      noiseScale: 12,
    });
    mb.add(ellipsoid([x, P.paw[1] * 0.55, jz - P.paw[2] * 0.25 + (hind ? 0.02 * L : 0)], [P.paw[0], P.paw[1] * 0.75, P.paw[2] * 0.6], { rings: 4, segs: lod ? 5 : 7 }), {
      color: C.legs,
      rig: () => [id, 1, 0, 0],
      pivot: () => [jy, jz, kneeY, 0],
      noise: 0.05,
    });
  }
  // Tail.
  {
    const tb = [0, P.hipH - P.girth * 0.45, zRump - 0.02];
    const n = P.tailBushy ? 5 : 2;
    const nodes = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const droop = P.tailBushy ? 0.35 : kind === 'deer' ? 0.9 : 0.6;
      const r = P.tailBushy ? 0.045 + 0.05 * Math.sin(Math.PI * Math.min(1, t * 1.2)) : kind === 'deer' ? 0.04 : P.tail * 0.5;
      nodes.push({ p: [0, tb[1] - Math.sin(droop) * P.tail * t, tb[2] + Math.cos(droop) * P.tail * t], rx: r * (1 - 0.4 * t) + 0.005, ry: r * (1 - 0.3 * t) + 0.005 });
    }
    mb.add(tube(nodes, { segs: lod ? 5 : 7 }), {
      color: (m) => {
        const t = Math.hypot(m.y - tb[1], m.z - tb[2]) / P.tail;
        if (kind === 'fox' && t > 0.8) return C.tail;
        if (kind === 'deer') return m.y > tb[1] - P.tail * 0.5 ? C.tail : C.rump;
        return coatCol({ ...m, t: 0.95 });
      },
      rig: (m) => [0, 0, 0, Math.min(1, Math.hypot(m.y - tb[1], m.z - tb[2]) / Math.max(0.05, P.tail))],
      pivot: () => [tb[1], tb[2], 0, 0],
      noise: 0.08,
    });
  }
  const geo = mb.build();
  geo.userData = { kind, length: L + P.neck + P.headLen, height: P.shoulderH, hipY: hJointY, hipZ: hz, shoulderZ: fz, shoulderY: fJointY };
  return geo;
}

// ---------------------------------------------------------------------------------------------------- props

// A weathered spruce snag, the eagles' lookout (origin at the base; 2 m of trunk below ground as a foundation).
export function buildSnag({ height = 16 } = {}) {
  const C = { wood: lin('#8f8a80'), dark: lin('#5a554d'), top: lin('#b1aca1') };
  const mb = new ModelBuilder();
  const nodes = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    nodes.push({ p: [0.12 * Math.sin(t * 2.3), -2 + (height + 2) * t, 0.08 * Math.cos(t * 3.1)], rx: 0.42 * (1 - t) ** 0.9 + 0.05, ry: 0.42 * (1 - t) ** 0.9 + 0.05 });
  }
  const bark = (m) => {
    const streak = vnoise(m.x * 3, m.y * 0.4, m.z * 3);
    return mix3(C.dark, C.wood, sm(0.3, 0.7, streak) * 0.8 + sm(height * 0.7, height, m.y) * 0.3);
  };
  mb.add(tube(nodes, { segs: 8, up: [0, 0, 1] }), { color: bark, noise: 0.08, noiseScale: 3 });
  // Broken branch stubs, longer toward the middle, drooping; one sturdy perch near the top.
  for (let b = 0; b < 9; b++) {
    const t = 0.35 + 0.55 * (b / 8);
    const y = -2 + (height + 2) * t;
    const a = b * 2.4;
    const len = b === 7 ? 1.3 : 0.4 + 0.9 * Math.sin(Math.PI * (b / 8));
    const r = b === 7 ? 0.07 : 0.045;
    const dir = [Math.cos(a), -0.15, Math.sin(a)];
    mb.add(tube([{ p: [0, y, 0], rx: r, ry: r }, { p: [dir[0] * len, y + dir[1] * len, dir[2] * len], rx: r * 0.35, ry: r * 0.35 }], { segs: 5 }), { color: C.dark, noise: 0.05 });
  }
  const geo = mb.build();
  const a = 7 * 2.4;
  const y = -2 + (height + 2) * (0.35 + 0.55 * (7 / 8));
  geo.userData = { kind: 'snag', perch: [Math.cos(a) * 0.9, y - 0.12, Math.sin(a) * 0.9], height };
  return geo;
}
