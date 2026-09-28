// Kodiak brown bear models (boar, sow, subadult, cub) at real size, built for the 'quad' vertex rig (materials.js):
// massive shoulder hump, deep chest and hanging belly, short thick neck, broad dished face with small round ears,
// plantigrade hind feet, long pale front claws and grizzled golden guard hairs over the hump. Faces -z, origin on
// the ground between the feet. Silhouettes are broken up with a small normal-direction "shag" so the fur never looks
// like a smooth plastic toy; shading keeps the smooth normals.
//
// Rig channels (see shapes.js header): aRig = (leg 0..4, legT 0..1, headW, tailW), aPivot = (jointY, jointZ, kneeY)
// for legs and (neckY, neckZ) for the head and neck.

import { ModelBuilder, bodyLoft, tube, ellipsoid, lin, mix3, scale3, vnoise, sampleKeys } from './mesh.js';

const sm = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Proportions relative to an adult sow (shoulder height 1.12 m, body 1.72 m). `head` scales the head about the neck;
// cubs have big heads, short legs and round bodies.
export const BEAR_AGES = {
  boar: { sx: 1.32, sy: 1.26, sz: 1.2, hump: 1.55, head: 1.2, leg: 1.0, belly: 1.15, coat: '#57402d', tips: '#9c8264', dark: '#2f241b', face: '#664d38', muzzle: '#86694f' },
  sow: { sx: 1, sy: 1, sz: 1, hump: 1, head: 1, leg: 1, belly: 1, coat: '#664b34', tips: '#ab906e', dark: '#35291f', face: '#735840', muzzle: '#97795a' },
  subadult: { sx: 0.8, sy: 0.84, sz: 0.84, hump: 0.7, head: 0.92, leg: 1.02, belly: 0.9, coat: '#71553a', tips: '#b59a76', dark: '#3a2d22', face: '#7d6146', muzzle: '#a08262' },
  cub: { sx: 0.45, sy: 0.44, sz: 0.4, hump: 0.2, head: 1.45, leg: 0.88, belly: 1.05, coat: '#4f3a28', tips: '#7d6449', dark: '#2b2119', face: '#5c4534', muzzle: '#806650' },
};

export function buildBear(age = 'sow', { lod = 0 } = {}) {
  const A = BEAR_AGES[age] ?? BEAR_AGES.sow;
  const C = {
    coat: lin(A.coat),
    tips: lin(A.tips),
    dark: lin(A.dark),
    face: lin(A.face),
    muzzle: lin(A.muzzle),
    nose: lin('#16110f'),
    eye: lin('#0a0807'),
    ear: lin('#3d2b1d'),
    claw: lin('#cfc2a6'),
    pad: lin('#241a14'),
  };
  const mb = new ModelBuilder();
  const segs = lod ? 9 : 16;
  const X = (v) => v * A.sx;
  const Y = (v) => v * A.sy;
  const Z = (v) => v * A.sz;
  const legScale = A.leg;
  // Legs are shorter in cubs relative to the body: lift the body by the leg factor.
  const lift = (y) => y * A.sy - (1 - legScale) * 0.42 * A.sy;

  // ---------------------------------------------------------------- body
  const z0 = Z(-0.86);
  const z1 = Z(0.86);
  const H = (A.hump - 1) * 0.07;
  const B = (A.belly - 1) * 0.05;
  const prof = [
    // t, top, bottom, half-width
    [0.0, 0.98, 0.6, 0.17],
    [0.07, 1.1 + H * 0.5, 0.5, 0.29],
    [0.18, 1.2 + H, 0.45 - B * 0.3, 0.35],
    [0.32, 1.16 + H * 0.6, 0.41 - B, 0.37],
    [0.5, 1.08, 0.4 - B, 0.37],
    [0.68, 1.05, 0.44 - B * 0.6, 0.35],
    [0.82, 1.05, 0.52, 0.31],
    [0.93, 0.99, 0.6, 0.24],
    [1.0, 0.86, 0.72, 0.07],
  ];
  const keys = prof.map(([t, top, bot, hw]) => ({ t, cy: lift((top + bot) / 2), ry: Y((top - bot) / 2), rx: X(hw), pw: 2.25 }));
  const coatAt = (m, v, along) => {
    // v: -1 belly .. +1 back. Dark underside and legs, golden-tipped guard hair over the hump and shoulders.
    let c = mix3(C.dark, C.coat, sm(-0.9, -0.1, v));
    const hump = sm(0.15, 0.95, v) * (1 - sm(0.45, 0.8, along)) * 0.75 + sm(0.55, 1, v) * 0.25;
    c = mix3(c, C.tips, hump);
    // Coarse tufts: streaky noise, stretched along the body.
    const tuft = vnoise(m.x * 9, m.y * 13, m.z * 4.5);
    c = scale3(c, 0.86 + 0.3 * tuft);
    return c;
  };
  mb.add(bodyLoft(keys, { z0, z1, rings: lod ? 10 : 22, segs }), {
    color: (m) => {
      const k = sampleKeys(keys, m.t);
      return coatAt(m, (m.y - k.cy) / Math.max(0.02, k.ry), m.t);
    },
    rig: () => [0, 0, 0, 0],
    noise: 0.05,
    noiseScale: 7,
    shag: lod ? null : { amp: 0.035 * A.sy, freq: 11 / A.sy, stretch: 1.6, dir: (m) => 0.4 + 0.6 * sm(-0.6, 0.6, m.ny) },
  });

  // ---------------------------------------------------------------- neck and head
  const neckBase = [0, lift(0.86), Z(-0.72)];
  const hs = A.head;
  // Head parts are built around the neck joint and scaled by `hs` about it.
  const hj = [0, lift(0.86), Z(-0.92)];
  const HP = (p) => [hj[0] + (p[0] - 0) * hs * A.sx, hj[1] + (p[1] - 0.86) * hs * A.sy, hj[2] + (p[2] + 0.92) * hs * A.sz];
  const HR = (r) => r * hs * (A.sx + A.sy) * 0.5;
  const neckPiv = () => [neckBase[1], neckBase[2], 0, 0];
  const headRig = (m) => [0, 0, sm(-Z(-0.64), -hj[2] + 0.06 * A.sz, -m.z), 0];
  mb.add(
    tube(
      [
        { p: [0, lift(0.83), Z(-0.62)], rx: X(0.25), ry: Y(0.28) },
        { p: [0, lift(0.85), Z(-0.78)], rx: X(0.23), ry: Y(0.26) },
        { p: HP([0, 0.86, -0.94]), rx: HR(0.2), ry: HR(0.22) },
        { p: HP([0, 0.86, -1.04]), rx: HR(0.18), ry: HR(0.19) },
      ],
      { segs },
    ),
    {
      color: (m) => {
        const v = (m.y - lift(0.84)) / Y(0.26);
        return mix3(coatAt(m, v, 0.1), C.face, sm(-Z(0.8), -Z(1.0), m.z) * 0.5);
      },
      rig: headRig,
      pivot: neckPiv,
      noise: 0.05,
      shag: lod ? null : { amp: 0.04 * A.sy, freq: 10 / A.sy, stretch: 1.4, dir: (m) => 0.5 + 0.5 * sm(-0.4, 0.8, m.ny) },
    },
  );
  const zBrow = HP([0, 0, -1.18])[2];
  const zNose = HP([0, 0, -1.4])[2];
  const faceCol = (m) => scale3(mix3(C.face, C.muzzle, sm(0.1, 0.7, sm(zBrow, zNose, m.z))), 0.9 + 0.2 * vnoise(m.x * 30, m.y * 30, m.z * 30));
  // Skull, broad cheeks and brow.
  const skull = HP([0, 0.87, -1.12]);
  mb.add(ellipsoid(skull, [HR(0.175), HR(0.165), HR(0.19)], { rings: lod ? 6 : 9, segs }), {
    color: (m) => mix3(C.face, C.coat, sm(0.05, 0.16, m.y - skull[1]) * 0.6),
    rig: () => [0, 0, 1, 0],
    pivot: neckPiv,
    noise: 0.06,
    shag: lod ? null : { amp: 0.018 * hs * A.sy, freq: 22, stretch: 1 },
  });
  for (const sx of [-1, 1]) {
    mb.add(ellipsoid(HP([sx * 0.105, 0.81, -1.13]), [HR(0.1), HR(0.1), HR(0.12)], { rings: lod ? 4 : 7, segs: lod ? 6 : 9 }), {
      color: C.face,
      rig: () => [0, 0, 1, 0],
      pivot: neckPiv,
      noise: 0.08,
      noiseScale: 20,
      shag: lod ? null : { amp: 0.02 * hs * A.sy, freq: 20 },
    });
  }
  mb.add(ellipsoid(HP([0, 0.945, -1.2]), [HR(0.12), HR(0.065), HR(0.09)], { rings: lod ? 4 : 6, segs: lod ? 6 : 9 }), { color: C.face, rig: () => [0, 0, 1, 0], pivot: neckPiv, noise: 0.05 });
  // Muzzle: a straight, slightly tapering snout below the brow (the "dish" is the step between them).
  mb.add(
    tube(
      [
        { p: HP([0, 0.84, -1.18]), rx: HR(0.115), ry: HR(0.1) },
        { p: HP([0, 0.815, -1.3]), rx: HR(0.088), ry: HR(0.082) },
        { p: HP([0, 0.795, -1.39]), rx: HR(0.07), ry: HR(0.066) },
      ],
      { segs: lod ? 7 : 12 },
    ),
    { color: faceCol, rig: () => [0, 0, 1, 0], pivot: neckPiv, noise: 0.04 },
  );
  // Lower jaw and chin.
  mb.add(ellipsoid(HP([0, 0.745, -1.28]), [HR(0.07), HR(0.035), HR(0.1)], { rings: 4, segs: lod ? 6 : 8 }), { color: mix3(C.muzzle, C.dark, 0.3), rig: () => [0, 0, 1, 0], pivot: neckPiv, noise: 0.04 });
  mb.add(ellipsoid(HP([0, 0.805, -1.405]), [HR(0.055), HR(0.042), HR(0.035)], { rings: 4, segs: lod ? 6 : 8 }), { color: C.nose, rig: () => [0, 0, 1, 0], pivot: neckPiv, noise: 0 });
  // Small round ears set wide on the skull.
  for (const sx of [-1, 1]) {
    mb.add(ellipsoid(HP([sx * 0.135, 1.005, -1.075]), [HR(0.052), HR(0.05), HR(0.026)], { rings: 4, segs: lod ? 6 : 8, rot: [0.25, sx * -0.35, sx * -0.3] }), {
      color: C.ear,
      rig: () => [0, 0, 1, 0],
      pivot: neckPiv,
      noise: 0.05,
    });
    if (!lod) {
      mb.add(ellipsoid(HP([sx * 0.082, 0.905, -1.255]), [HR(0.017), HR(0.015), HR(0.012)], { rings: 4, segs: 6 }), { color: C.eye, rig: () => [0, 0, 1, 0], pivot: neckPiv, noise: 0 });
    }
  }

  // ---------------------------------------------------------------- legs
  // [id, side, joint z, joint y, knee y, hind]
  const fz = Z(-0.58);
  const hz = Z(0.55);
  const fJ = lift(0.8);
  const hJ = lift(0.74);
  const legs = [
    [1, -1, fz, fJ, fJ * 0.4, false],
    [2, 1, fz, fJ, fJ * 0.4, false],
    [3, -1, hz, hJ, hJ * 0.42, true],
    [4, 1, hz, hJ, hJ * 0.42, true],
  ];
  for (const [id, sx, jz, jy, ky, hind] of legs) {
    const x = sx * X(hind ? 0.19 : 0.2);
    const top = jy + Y(0.08);
    const nodes = [];
    const prof2 = hind
      ? [
          // y fraction of the joint height, radius, z offset (hind: thigh -> hock -> heel)
          [1.14, 0.21, -0.02],
          [0.82, 0.18, 0.01],
          [0.55, 0.135, 0.05],
          [0.3, 0.1, 0.07],
          [0.12, 0.088, 0.05],
          [0.06, 0.086, 0.03],
        ]
      : [
          [1.14, 0.17, 0.0],
          [0.8, 0.155, 0.01],
          [0.52, 0.125, 0.0],
          [0.28, 0.105, -0.01],
          [0.12, 0.095, -0.015],
          [0.06, 0.092, -0.02],
        ];
    for (const [fy, r, dz] of lod ? prof2.filter((_, i) => i % 2 === 0 || i === prof2.length - 1) : prof2) {
      const y = fy * jy;
      nodes.push({ p: [x, Math.max(y, 0.03 * A.sy), jz + Z(dz)], rx: X(r) * 0.92, ry: Z(r) * (hind && fy > 0.7 ? 1.25 : 1.05) });
    }
    const legT = (m) => Math.min(1, Math.max(0, 1 - m.y / top));
    mb.add(tube(nodes, { segs: lod ? 6 : 10, up: [0, 0, -1] }), {
      color: (m) => mix3(coatAt(m, -0.2, hind ? 0.8 : 0.2), C.dark, sm(0.15, 0.65, legT(m))),
      rig: (m) => [id, legT(m), 0, 0],
      pivot: () => [jy, jz, ky, 0],
      noise: 0.06,
      noiseScale: 10,
      shag: lod ? null : { amp: 0.025 * A.sy, freq: 14 / A.sy, stretch: 0.5, dir: (m) => 1 - sm(0.6, 1.0, legT(m)) },
    });
    // Paw / foot.
    const pawC = hind ? [x, 0.045 * A.sy, jz + Z(0.0)] : [x, 0.05 * A.sy, jz - Z(0.06)];
    const pawR = hind ? [X(0.09), Y(0.048), Z(0.17)] : [X(0.1), Y(0.055), Z(0.14)];
    mb.add(ellipsoid(pawC, pawR, { rings: 4, segs: lod ? 6 : 9 }), { color: C.dark, rig: () => [id, 1, 0, 0], pivot: () => [jy, jz, ky, 0], noise: 0.05 });
    if (!lod && !hind && age !== 'cub') {
      // Long pale front claws curving down in front of the paw.
      for (let k = 0; k < 5; k++) {
        const cx = x + X((k - 2) * 0.034);
        const cz = pawC[2] - pawR[2] * 0.85;
        const l = Z(0.075 + 0.015 * (k === 2 ? 1 : 0));
        mb.add(
          tube(
            [
              { p: [cx, 0.05 * A.sy, cz], rx: X(0.011), ry: Y(0.013) },
              { p: [cx, 0.035 * A.sy, cz - l * 0.6], rx: X(0.008), ry: Y(0.009) },
              { p: [cx, 0.012 * A.sy, cz - l], rx: X(0.003), ry: Y(0.003) },
            ],
            { segs: 4, up: [0, 1, 0] },
          ),
          { color: C.claw, rig: () => [id, 1, 0, 0], pivot: () => [jy, jz, ky, 0], noise: 0.05 },
        );
      }
    }
  }

  // Stubby tail.
  const tb = [0, lift(0.86), z1 - Z(0.03)];
  mb.add(ellipsoid([tb[0], tb[1], tb[2] + Z(0.04)], [X(0.05), Y(0.055), Z(0.06)], { rings: 4, segs: 6, rot: [-0.5, 0, 0] }), {
    color: C.coat,
    rig: () => [0, 0, 0, 1],
    pivot: () => [tb[1], tb[2], 0, 0],
    noise: 0.05,
  });

  const geo = mb.build();
  geo.userData = { kind: 'bear', age, hipY: hJ, hipZ: hz, shoulderZ: fz, shoulderY: fJ, height: lift(1.2) + Y(0.0), length: z1 - HP([0, 0, -1.42])[2] };
  return geo;
}
