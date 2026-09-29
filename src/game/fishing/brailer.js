// The brailer: a big dip-net bag on a whip line from the boom that scoops salmon out of the dried-up seine bag
// alongside and dumps them into the hold. Purely visual; driven by fishing while state === 'brailing'.

import {
  createPixelUniform,
  createRibbonBatch,
  ribbonMaterial,
  solidWebMaterial,
} from '../../entities/net/materials.js';
import { patchUnderwater } from '../../render/shaderChunks.js';

const FISH = 46;
const SPILL = 30;
const CYCLE = 2.8; // seconds per scoop
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;

function bagGeometry(THREE) {
  const pts = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10; // 0 = bottom, 1 = ring
    const r = 0.3 + 0.5 * Math.sin(Math.min(1, t * 1.15) * Math.PI * 0.62) - 0.06 * t;
    pts.push(new THREE.Vector2(Math.max(0.05, r), (t - 1) * 1.45));
  }
  const g = new THREE.LatheGeometry(pts, 16);
  const uv = [];
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) uv.push(Math.atan2(p.getX(i), p.getZ(i)) * 0.8, p.getY(i) * 1.6);
  g.setAttribute('aNetUv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

function fishGeometry(THREE) {
  const g = new THREE.SphereGeometry(1, 8, 6);
  g.scale(0.075, 0.09, 0.3);
  const p = g.attributes.position;
  const col = [];
  const back = new THREE.Color('#3b5b66');
  const belly = new THREE.Color('#d9dfe2');
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    c.copy(belly).lerp(back, smooth(-0.02, 0.07, p.getY(i)));
    col.push(c.r, c.g, c.b);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

export function createBrailer(ctx) {
  const { THREE, scene } = ctx;
  const group = new THREE.Group();
  group.name = 'brailer';
  group.visible = false;
  scene.add(group);

  const bag = new THREE.Mesh(bagGeometry(THREE), solidWebMaterial(ctx, { color: '#2e5237', cell: 0.06 }));
  bag.castShadow = !!ctx.quality?.shadows;
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.72, 0.035, 6, 24).rotateX(Math.PI / 2),
    patchUnderwater(new THREE.MeshStandardMaterial({ color: '#8d8a80', metalness: 0.7, roughness: 0.45 }), ctx.uniforms),
  );
  const bridle = new THREE.Mesh(
    new THREE.ConeGeometry(0.72, 0.9, 4, 1, true).translate(0, 0.45, 0),
    new THREE.MeshBasicMaterial({ color: '#34322c', wireframe: true }),
  );
  group.add(bag, ring, bridle);

  const fishMat = patchUnderwater(
    new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.35, roughness: 0.32 }),
    ctx.uniforms,
  );
  const fish = new THREE.InstancedMesh(fishGeometry(THREE), fishMat, FISH + SPILL);
  fish.frustumCulled = false;
  fish.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  fish.count = 0;
  scene.add(fish);
  fish.visible = false;

  const pixel = createPixelUniform();
  const line = createRibbonBatch(ctx, ribbonMaterial(ctx, { pixel, minPixels: 1.2 }), 24, 'brailer-line');
  scene.add(line.mesh);
  const lineColor = new THREE.Color('#bdb49a');

  const pos = new THREE.Vector3();
  const tip = new THREE.Vector3();
  const hatch = new THREE.Vector3();
  const dip = new THREE.Vector3();
  const above = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const m = new THREE.Matrix4();
  const sc = new THREE.Vector3();
  const offsets = [];
  const rng = ctx.rng.fork('brailer');
  for (let i = 0; i < FISH + SPILL; i++) offsets.push([rng.next(), rng.next(), rng.next(), rng.next()]);
  let t = 0;
  let lastSplash = -1;
  const result = { scooped: false }; // reused return value

  const brailer = {
    group,
    cycle: CYCLE,
    // opts: { active, loaded (0..1 how full each scoop is; 0 = an empty bag, no fish), boomTip, hatch, dip (Vector3s) }
    // → { scooped } (true on the frame the brailer dips into the bag).
    update(dt, opts) {
      const active = !!opts?.active && opts.boomTip && opts.hatch && opts.dip;
      group.visible = !!active;
      line.mesh.visible = !!active;
      fish.visible = !!active;
      result.scooped = false;
      if (!active) {
        t = 0;
        lastSplash = -1;
        fish.count = 0;
        return result;
      }
      t += dt;
      pixel.value = (2 * Math.tan((ctx.camera.fov * Math.PI) / 360)) / Math.max(200, ctx.renderer?.domElement?.clientHeight || 720);
      tip.copy(opts.boomTip);
      hatch.copy(opts.hatch);
      dip.copy(opts.dip);
      const ph = (t % CYCLE) / CYCLE;
      const cycleN = Math.floor(t / CYCLE);
      // Path: dip in the bag → lift clear → swing over the hatch → dump → swing back.
      above.copy(dip).setY(Math.max(dip.y, hatch.y) + 2.4);
      const overHatch = tmp.copy(hatch).setY(hatch.y + 2.1);
      if (ph < 0.22) {
        const k = smooth(0, 0.22, ph);
        pos.lerpVectors(above, dip, k);
      } else if (ph < 0.42) {
        const k = smooth(0.22, 0.42, ph);
        pos.lerpVectors(dip, above, k);
      } else if (ph < 0.68) {
        const k = smooth(0.42, 0.68, ph);
        pos.lerpVectors(above, overHatch, k);
        pos.y += Math.sin(k * Math.PI) * 0.4;
      } else if (ph < 0.84) {
        pos.copy(overHatch);
      } else {
        const k = smooth(0.84, 1.0, ph);
        pos.lerpVectors(overHatch, above, k);
      }
      // Pendulum swing on the whip, lagging the path.
      const sway = Math.sin(t * 2.2) * 0.12;
      pos.x += sway;
      const full = ph >= 0.2 && ph < 0.76 ? smooth(0.2, 0.3, ph) * (1 - smooth(0.7, 0.76, ph)) : 0;
      const fill = Math.max(0, Math.min(1, opts.loaded ?? 1));
      const load = full * fill;
      group.position.copy(pos);
      const dx = tip.x - pos.x;
      const dz = tip.z - pos.z;
      e.set(Math.atan2(dz, tip.y - pos.y) * 0.25, 0, -Math.atan2(dx, tip.y - pos.y) * 0.25);
      group.quaternion.setFromEuler(e);
      bag.scale.set(0.75 + 0.3 * load, 0.8 + 0.25 * load, 0.75 + 0.3 * load);
      group.updateMatrixWorld(true);

      // Splash and foam when the brailer dips into the bag.
      const w = ctx.systems.water;
      if (ph > 0.18 && ph < 0.3 && lastSplash !== cycleN) {
        lastSplash = cycleN;
        w?.stamp?.(dip.x, dip.z, 1.6, 0.8, 'ripple');
        result.scooped = fill > 0;
      }
      if (ph > 0.15 && ph < 0.42) w?.stamp?.(dip.x, dip.z, 2.2, 0.8, 'foam');

      // Whip line from the boom tip to the ring.
      line.begin();
      line.line(lineColor, 0.03);
      ring.getWorldPosition(tmp);
      line.point(tip.x, tip.y, tip.z);
      line.point(tmp.x, tmp.y + 0.9, tmp.z);
      line.end();
      line.finish();

      // Fish: packed in the bag when full; spilling into the hatch during the dump.
      let n = 0;
      if (load > 0.05) {
        const nIn = Math.round(FISH * load);
        for (let i = 0; i < nIn; i++) {
          const o = offsets[i];
          const a = o[0] * Math.PI * 2;
          const r = Math.sqrt(o[1]) * 0.55;
          const y = -1.25 + o[2] * 1.05 * load;
          tmp.set(Math.cos(a) * r, y, Math.sin(a) * r).applyMatrix4(bag.matrixWorld);
          e.set(o[3] * 3, a + Math.sin(t * 9 + i) * 0.3, Math.sin(t * 11 + i * 2) * 0.5);
          q.setFromEuler(e);
          sc.setScalar(0.85 + 0.3 * o[2]);
          m.compose(tmp, q, sc);
          fish.setMatrixAt(n++, m);
        }
      }
      if (fill > 0 && ph >= 0.68 && ph < 0.9) {
        const k = (ph - 0.68) / 0.22;
        const nSpill = Math.round(SPILL * Math.min(1, fill * 1.3));
        for (let i = 0; i < nSpill; i++) {
          const o = offsets[FISH + i];
          const tt = k - o[0] * 0.35;
          if (tt <= 0 || tt >= 1) continue;
          tmp.set(
            pos.x + (o[1] - 0.5) * 0.9,
            lerp(pos.y - 1.2, hatch.y + 0.1, tt * tt),
            pos.z + (o[2] - 0.5) * 0.9,
          );
          e.set(t * 7 + i, i, t * 5);
          q.setFromEuler(e);
          sc.setScalar(1);
          m.compose(tmp, q, sc);
          fish.setMatrixAt(n++, m);
        }
      }
      fish.count = n;
      fish.instanceMatrix.needsUpdate = true;
      return result;
    },
  };
  return brailer;
}
