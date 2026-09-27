// Adapter from ctx to the narrow `world` interface the school simulation uses (see sim.js). Tolerates stubbed or
// missing neighbours. No DOM: constructs under Node with tests/contract.test.mjs fakeCtx().

import * as THREE from 'three';

export function createWorldAdapter(ctx, { netOverride = () => null } = {}) {
  const hm = ctx.heightmap;
  const sys = ctx.systems;
  const tmpV = new THREE.Vector3();
  const tmpDir = new THREE.Vector3();
  const skiffPrev = { x: 0, z: 0, t: -1, speed: 0 };
  const fleetPrev = new Map();
  const boats = [];
  const seinerBoat = { kind: 'seiner', x: 0, z: 0, speed: 0, fx: 0, fz: -1, half: 8.85 };
  const skiffBoat = { kind: 'skiff', x: 0, z: 0, speed: 0, fx: 0, fz: -1, half: 3 };
  let streamsCache = null;
  let streamsSrc = null;

  const world = {
    shoreDistance: (x, z) => hm.shoreDistance(x, z),
    shoreGradient: (x, z, out) => hm.shoreGradient(x, z, out),
    depthAt: (x, z) => hm.depthAt(x, z),
    seabedAt: (x, z) => hm.seabedAt?.(x, z) ?? 'sand',
    nearestWater: (x, z, minShore = 60) => hm.nearestWater(x, z, { minShore, maxRadius: 1500 }),
    currentAt: (x, z, out) => ctx.tide?.currentAt?.(x, z, out) ?? ((out.x = 0), (out.z = 0), out),
    tideState: () => ctx.tide?.state?.() ?? { flow: 0, stage: 'slack', hoursToSlack: 3 },
    tidePeriod: () => ctx.tide?.period ?? 12.42,
    day: () => (ctx.clock?.day ?? 0) + (ctx.clock?.hours ?? 12) / 24,

    streams() {
      const src = sys.places?.streams;
      if (src !== streamsSrc) {
        streamsSrc = src;
        streamsCache = Array.isArray(src)
          ? src
              .filter((s) => Number.isFinite(s?.x) && Number.isFinite(s?.z))
              .map((s) => ({ id: s.id, x: s.x, z: s.z, species: s.species ?? [], closedRadius: s.closedRadius ?? 250 }))
          : [];
      }
      return streamsCache;
    },

    speciesMix(x, z) {
      try {
        const m = sys.season?.speciesMix?.(x, z);
        return m && typeof m === 'object' ? m : null;
      } catch {
        return null;
      }
    },

    isClosedWater(x, z) {
      try {
        return !!sys.season?.isClosedWater?.(x, z);
      } catch {
        return false;
      }
    },

    openerActive(x, z) {
      if (ctx.state?.freeExplore) return true;
      try {
        return !!sys.season?.openerActive?.(x, z);
      } catch {
        return false;
      }
    },

    focus() {
      const p = sys.seiner?.position;
      if (p) return p;
      return ctx.camera.position;
    },

    // Camera frustum (with a margin) plus terrain line of sight: "out of view" for spawns.
    inView(x, z) {
      const cam = ctx.camera;
      if (!cam) return false;
      cam.updateMatrixWorld?.();
      for (const y of [0.5, 2.5]) {
        tmpV.set(x, y, z).applyMatrix4(cam.matrixWorldInverse);
        if (tmpV.z >= 0) continue;
        tmpV.applyMatrix4(cam.projectionMatrix);
        if (Math.abs(tmpV.x) > 1.12 || Math.abs(tmpV.y) > 1.12) continue;
        // Terrain between camera and the point hides it.
        const cp = cam.position;
        tmpDir.set(x - cp.x, y - cp.y, z - cp.z);
        const dist = tmpDir.length();
        tmpDir.divideScalar(dist || 1);
        const hit = hm.raymarch(cp, tmpDir, dist, Math.max(hm.texel, dist / 60));
        if (hit >= 0 && hit < dist - 5) continue;
        return true;
      }
      return false;
    },

    boats() {
      boats.length = 0;
      const t = ctx.time?.elapsed ?? 0;
      const s = sys.seiner;
      if (s?.position) {
        seinerBoat.x = s.position.x;
        seinerBoat.z = s.position.z;
        seinerBoat.speed = Number.isFinite(s.speed) ? s.speed : 0;
        const h = s.heading ?? 0;
        seinerBoat.fx = Math.sin(h);
        seinerBoat.fz = -Math.cos(h);
        boats.push(seinerBoat);
      }
      const k = sys.skiff;
      if (k?.position && k.state && k.state !== 'stowed') {
        const dt = t - skiffPrev.t;
        if (skiffPrev.t >= 0 && dt > 1e-4) {
          const v = Math.hypot(k.position.x - skiffPrev.x, k.position.z - skiffPrev.z) / dt;
          skiffPrev.speed += (Math.min(v, 20) - skiffPrev.speed) * Math.min(1, dt * 4);
        }
        skiffPrev.x = k.position.x;
        skiffPrev.z = k.position.z;
        skiffPrev.t = t;
        skiffBoat.x = k.position.x;
        skiffBoat.z = k.position.z;
        skiffBoat.speed = skiffPrev.speed;
        const h = k.heading ?? 0;
        skiffBoat.fx = Math.sin(h);
        skiffBoat.fz = -Math.cos(h);
        boats.push(skiffBoat);
      } else skiffPrev.t = -1;
      const fleet = sys.fleet?.boats;
      if (Array.isArray(fleet)) {
        for (const b of fleet) {
          const p = b?.position ?? b?.object3d?.position;
          if (!p) continue;
          let e = fleetPrev.get(b);
          if (!e) {
            e = { kind: 'fleet', x: p.x, z: p.z, speed: 0, fx: 0, fz: -1, half: (b.length ?? 18) / 2, t };
            fleetPrev.set(b, e);
          }
          const dt = t - e.t;
          let speed = Number.isFinite(b.speed) ? Math.abs(b.speed) : e.speed;
          if (!Number.isFinite(b.speed) && dt > 1e-4) speed = Math.min(20, Math.hypot(p.x - e.x, p.z - e.z) / dt);
          e.speed = speed;
          e.x = p.x;
          e.z = p.z;
          e.t = t;
          const h = b.heading ?? 0;
          e.fx = Math.sin(h);
          e.fz = -Math.cos(h);
          boats.push(e);
        }
      }
      return boats;
    },

    net() {
      const o = netOverride();
      if (o) return o;
      return sys.net ?? null;
    },

    surfaceY(x, z) {
      try {
        const h = sys.water?.heightAt?.(x, z);
        return Number.isFinite(h) ? h : 0;
      } catch {
        return 0;
      }
    },

    emit(name, payload) {
      ctx.events.emit(name, payload);
    },
  };
  return world;
}
