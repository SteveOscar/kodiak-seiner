// WP-PLACES system (SPEC §6.5): the places API over src/data/places.js, and the built world: the City of Kodiak,
// villages with their churches, canneries, hatcheries, Coast Guard Base Kodiak, the spaceport launch tower, Fort
// Abercrombie, light towers, channel buoys, closed-waters markers, lit windows, streetlamps and chimney smoke.
//
// Structures are merged per district into a few meshes sharing one material; point lights are one instanced
// draw (band 400), smoke another (band 200). Turbine nacelles/rotors and buoys are small InstancedMeshes animated
// per frame. Nothing here is persisted: discovery state belongs to WP-RULES.

import * as THREE from 'three';
import { createPlacesApi } from './places/api.js';
import { Builder, col } from './places/kit.js';
import { createPlaceUniforms, createStructureMaterial, createPlainMaterial } from './places/materials.js';
import { createGlows } from './places/glows.js';
import { createSmoke } from './places/smoke.js';
import { buildKodiak, buildCoastGuard, TURBINE, KODIAK_LAYOUT } from './places/city.js';
import { buildVillage, buildCannery, buildHatchery } from './places/village.js';
import { buildSpaceport, buildFort, buildLight, buildMarkers, BUOYS } from './places/landmarks.js';
import { createRng } from '../core/rng.js';
import { createColliderGrid } from './places/colliders.js';

export const LAYOUT_SEED = 1985;

const VILLAGE_OPTS = {
  ouzinkie: { houses: 26, R: 100 },
  'port-lions': { houses: 32, R: 115 },
  'old-harbor': { houses: 30, R: 110 },
  'larsen-bay': { houses: 22, R: 95 },
  akhiok: { houses: 16, R: 90, boats: 0 },
  karluk: { houses: 14, R: 90, boats: 2 },
};

export async function create(ctx) {
  const { THREE: T = THREE, scene } = ctx;
  const api = createPlacesApi({ geo: ctx.geo, heightmap: ctx.heightmap });
  const rng = ctx.rng.fork('places');
  const pu = createPlaceUniforms();
  const material = createStructureMaterial(ctx, pu);
  const group = new T.Group();
  group.name = 'places';
  scene.add(group);

  const H = (x, z) => ctx.systems.terrain?.heightAt?.(x, z) ?? ctx.heightmap.heightAt(x, z);
  // The settlement layout uses a fixed seed, not the game seed: FOOTPRINTS in src/data/places.js (which clear
  // vegetation under buildings) were generated from this exact layout and must match it for every ?seed=.
  const S = { b: null, H, hm: ctx.heightmap, rng: createRng(LAYOUT_SEED).fork('places-layout'), smoke: [], glows: [], sites: [], colliders: [] };
  const builders = new Map();
  const chunk = (name) => {
    if (!builders.has(name)) builders.set(name, new Builder());
    return builders.get(name);
  };
  const failures = [];
  const attempt = (label, fn) => {
    try {
      return fn();
    } catch (err) {
      failures.push(`${label}: ${err?.message ?? err}`);
      console.error(`[places] building ${label} failed:`, err);
      return null;
    }
  };

  // ------------------------------------------------------------------ build the world
  const lights = [];
  let spaceport = null;
  const kodiak = attempt('kodiak', () => buildKodiak(S, chunk));
  const uscg = api.get('uscg-base');
  if (uscg) {
    S.b = chunk('uscg-base');
    attempt('uscg-base', () => buildCoastGuard(S, uscg));
  }
  for (const p of api.list) {
    if (p.model === 'village') {
      S.b = chunk(p.id);
      attempt(p.id, () => buildVillage(S, p, VILLAGE_OPTS[p.id] ?? {}));
    } else if (p.model === 'cannery') {
      S.b = chunk(p.id);
      attempt(p.id, () => buildCannery(S, p, p.id === 'alitak-cannery' ? { width: 64, depth: 36, bunkhouses: 10 } : {}));
    } else if (p.model === 'hatchery' || p.model === 'hatcherySmall') {
      S.b = chunk(p.id);
      attempt(p.id, () => buildHatchery(S, p, { pens: p.model === 'hatchery' }));
    } else if (p.model === 'spaceport') {
      S.b = chunk(p.id);
      spaceport = attempt(p.id, () => buildSpaceport(S, p))?.pad ?? null;
    } else if (p.model === 'bunkers') {
      S.b = chunk(p.id);
      attempt(p.id, () => buildFort(S, p));
    } else if (p.model === 'light') {
      S.b = chunk('lights');
      const l = attempt(p.id, () => buildLight(S, p));
      if (l) lights.push({ id: p.id, x: l.x, y: l.y, z: l.z });
    }
  }
  S.b = chunk('markers');
  const markers = [];
  for (const s of api.streams) {
    for (const m of attempt(`markers ${s.id}`, () => buildMarkers(S, s)) ?? []) markers.push({ streamId: s.id, x: m.x, z: m.z });
  }
  const markerCount = markers.length;

  // ------------------------------------------------------------------ meshes
  const meshes = [];
  let triangles = 0;
  for (const [name, b] of builders) {
    if (!b.vertexCount) continue;
    const mesh = new T.Mesh(b.geometry(), material);
    mesh.name = `places-${name}`;
    mesh.castShadow = !!ctx.quality.shadows;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    group.add(mesh);
    const bs = mesh.geometry.boundingSphere;
    meshes.push({ mesh, center: bs.center.clone(), radius: bs.radius });
    triangles += b.vertexCount / 3;
  }

  // Turbine nacelles (yaw) and rotors (yaw + spin), instanced.
  const turbines = kodiak?.turbines ?? [];
  const rotorMat = createPlainMaterial(ctx, { color: 0xf1f3f3, roughness: 0.45 });
  const nacB = new Builder();
  nacB.box({ x: 0, z: 0, rot: 0 }, 0, -1.1, -1.5, 2.1, 2.3, 5.2, col('#eef0f0'));
  nacB.box({ x: 0, z: 0, rot: 0 }, 0, 1.2, -3.0, 0.4, 0.7, 0.4, col('#9aa0a3'));
  const nacelles = new T.InstancedMesh(nacB.geometry(), rotorMat, Math.max(1, turbines.length));
  const rotB = new Builder();
  rotB.beam([0, 0, -0.5], [0, 0, 1.1], 1.5, col('#f4f6f6'));
  rotB.beam([0, 0, 1.1], [0, 0, 1.9], 0.85, col('#f4f6f6'));
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const tip = [Math.cos(a) * TURBINE.rotor, Math.sin(a) * TURBINE.rotor, 0.2];
    const root = [Math.cos(a) * 0.9, Math.sin(a) * 0.9, 0.3];
    rotB.beam(root, [(root[0] + tip[0]) * 0.3, (root[1] + tip[1]) * 0.3, 0.25], 1.0, col('#f2f4f4'));
    rotB.beam([(root[0] + tip[0]) * 0.3, (root[1] + tip[1]) * 0.3, 0.25], tip, 0.42, col('#f2f4f4'));
  }
  const rotGeo = rotB.geometry();
  const rotors = new T.InstancedMesh(rotGeo, rotorMat, Math.max(1, turbines.length));
  for (const m of [nacelles, rotors]) {
    m.name = m === rotors ? 'places-rotors' : 'places-nacelles';
    m.castShadow = !!ctx.quality.shadows;
    m.receiveShadow = true;
    m.count = turbines.length;
    m.frustumCulled = false;
    group.add(m);
  }
  const turbineState = turbines.map((t, i) => ({ ...t, yaw: 0.6, angle: i * 0.7 }));

  // Buoys (red nuns, green cans), instanced; they ride the waves.
  const buoyList = BUOYS.filter((q) => ctx.heightmap.heightAt(q.x, q.z) < -1.2);
  const nunB = new Builder();
  nunB.cylinder({ x: 0, z: 0, rot: 0 }, 0, -1.2, 0, 0.9, 0.9, 2.4, 10, col('#c8322a'));
  nunB.lathe({ x: 0, z: 0, rot: 0 }, 0, 1.2, 0, [[0.9, 0], [0.45, 1.2], [0, 1.7]], 10, col('#c8322a'));
  const canB = new Builder();
  canB.cylinder({ x: 0, z: 0, rot: 0 }, 0, -1.2, 0, 0.85, 0.85, 3.0, 10, col('#2f7a45'));
  for (const bb of [nunB, canB]) {
    bb.box({ x: 0, z: 0, rot: 0 }, 0, 1.6, 0, 0.12, 2.4, 0.12, col('#3a3c3e'));
    bb.box({ x: 0, z: 0, rot: 0 }, 0, 3.9, 0, 0.35, 0.35, 0.35, col('#2a2c2e'));
  }
  const buoyMat = createPlainMaterial(ctx, { vertexColors: true, roughness: 0.55 });
  for (const q of buoyList) S.colliders.push({ kind: 'circle', x: q.x, z: q.z, r: 0.9, y0: -1.6, y1: 4.1 });
  // Solid volumes of everything above, bucketed once (see places/colliders.js for the shapes).
  const colliderGrid = createColliderGrid(S.colliders);
  const reds = buoyList.filter((q) => q.c === 'R');
  const greens = buoyList.filter((q) => q.c === 'G');
  const nunMesh = new T.InstancedMesh(nunB.geometry(), buoyMat, Math.max(1, reds.length));
  const canMesh = new T.InstancedMesh(canB.geometry(), buoyMat, Math.max(1, greens.length));
  nunMesh.count = reds.length;
  canMesh.count = greens.length;
  for (const m of [nunMesh, canMesh]) {
    m.name = m === nunMesh ? 'places-buoys-red' : 'places-buoys-green';
    m.frustumCulled = false;
    m.castShadow = false;
    group.add(m);
  }

  // Glows: everything collected during building + turbine aviation lights (synchronised red flashes) and buoy lights.
  for (const t of turbines) S.glows.push({ x: t.x, y: t.h + TURBINE.hub + 1.3, z: t.z, color: '#ff2a1a', intensity: 7, size: 1.6, period: 2, flashes: 1, phase: 0 });
  const glows = createGlows(ctx, pu, S.glows.length + buoyList.length + 8);
  for (const g of S.glows) glows.add(g.x, g.y, g.z, g);
  const buoyGlow = new Map();
  for (const q of buoyList) {
    if (!q.lit) continue;
    const i = glows.add(q.x, 4.2, q.z, { color: q.c === 'R' ? '#ff3b2f' : '#38ff70', intensity: 7, size: 1.8, period: q.c === 'R' ? 4 : 6, flashes: 1, phase: (q.x * 0.13) % 4 });
    buoyGlow.set(q, i);
  }
  group.add(glows.mesh);

  // Smoke and steam.
  let smoke = null;
  if (ctx.quality.name !== 'low' && S.smoke.length) {
    smoke = createSmoke(ctx, S.smoke, { puffs: 8, rng: rng.fork('smoke') });
    group.add(smoke.mesh);
  }

  // ------------------------------------------------------------------ per-frame
  const removeHook = ctx.pipeline.beforeRender(() => glows.beforeRender(ctx.camera, ctx.renderer));
  const m4 = new T.Matrix4();
  const q4 = new T.Quaternion();
  const e = new T.Euler();
  const v3 = new T.Vector3();
  const one = new T.Vector3(1, 1, 1);
  let cullTimer = 0;
  const cam = ctx.camera.position;

  function updateTurbines(dt) {
    const U = ctx.uniforms;
    const ws = U.uWindSpeed.value ?? 6;
    const wd = U.uWindDir.value;
    // face upwind: the rotor's +z points against the downwind vector
    const target = Math.atan2(-wd.x, -wd.y);
    const spin = THREE.MathUtils.clamp((ws - 3) / 9, 0, 1) * ((16 * Math.PI * 2) / 60);
    turbineState.forEach((t, i) => {
      let d = target - t.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      t.yaw += d * Math.min(1, dt * 0.08);
      t.angle += (spin + 0.03) * dt;
      const hubY = t.h + TURBINE.hub;
      e.set(0, t.yaw, 0);
      q4.setFromEuler(e);
      m4.compose(v3.set(t.x, hubY, t.z), q4, one);
      nacelles.setMatrixAt(i, m4);
      e.set(0, t.yaw, t.angle, 'YXZ');
      q4.setFromEuler(e);
      const fx = Math.sin(t.yaw) * 1.5;
      const fz = Math.cos(t.yaw) * 1.5;
      m4.compose(v3.set(t.x + fx, hubY, t.z + fz), q4, one);
      rotors.setMatrixAt(i, m4);
    });
    nacelles.instanceMatrix.needsUpdate = true;
    rotors.instanceMatrix.needsUpdate = true;
  }

  function updateBuoys(time) {
    const water = ctx.systems.water;
    const put = (mesh, list) => {
      list.forEach((q, i) => {
        const near = (q.x - cam.x) ** 2 + (q.z - cam.z) ** 2 < 2500 * 2500;
        const y = near ? (water?.heightAt?.(q.x, q.z) ?? 0) : 0;
        e.set(Math.sin(time * 0.9 + q.x) * 0.06, q.x * 0.1, Math.cos(time * 0.7 + q.z) * 0.06);
        q4.setFromEuler(e);
        m4.compose(v3.set(q.x, y - 0.35, q.z), q4, one);
        mesh.setMatrixAt(i, m4);
        const gi = buoyGlow.get(q);
        if (gi !== undefined) glows.setY(gi, y + 3.9);
      });
      mesh.instanceMatrix.needsUpdate = true;
    };
    put(nunMesh, reds);
    put(canMesh, greens);
  }

  function updateLighting() {
    const sky = ctx.systems.sky;
    const daylight = sky?.daylight ?? ctx.uniforms.uDaylight.value ?? 1;
    const night = 1 - THREE.MathUtils.smoothstep(daylight, 0.1, 0.55);
    pu.uNight.value = night;
    pu.uNav.value = 1 - THREE.MathUtils.smoothstep(daylight, 0.3, 0.5);
    const h = ctx.clock?.hours ?? 12;
    // Fewer windows lit in the small hours, most in the evening.
    const late = h >= 0.5 && h < 5.5 ? THREE.MathUtils.smoothstep(Math.abs(h - 3), 0, 2.5) : 1;
    pu.uLitFrac.value = 0.25 + 0.4 * late;
    if (smoke) smoke.setAmount(THREE.MathUtils.clamp(0.35 + 0.65 * (1 - daylight) + (h < 9 ? 0.25 : 0), 0.2, 1));
  }

  updateTurbines(0);
  updateBuoys(0);
  updateLighting();

  const sys = {
    ...api,
    group,

    // Solid props near (x, z): circles and oriented boxes (world m, heading-convention rot, y0..y1) whose footprint
    // lies within `radius`. Pass `out` to reuse an array.
    collidersNear(x, z, radius = 0, out) {
      return colliderGrid.near(x, z, radius, out);
    },

    update(dt) {
      updateLighting();
      if (turbineState.length) updateTurbines(dt);
      if (buoyList.length) updateBuoys(ctx.time?.elapsed ?? 0);
      cullTimer -= dt || 0.016;
      if (cullTimer <= 0) {
        cullTimer = 0.3;
        for (const c of meshes) {
          const d = Math.hypot(c.center.x - cam.x, c.center.z - cam.z) - c.radius;
          c.mesh.visible = d < 9000;
        }
      }
    },

    debugState() {
      return {
        places: api.list.length,
        streams: api.streams.length,
        chunks: meshes.length,
        triangles: Math.round(triangles),
        glows: glows.count,
        smoke: smoke?.count ?? 0,
        turbines: turbines.length,
        buoys: buoyList.length,
        markers: markerCount,
        colliders: colliderGrid.items.length,
        night: +pu.uNight.value.toFixed(2),
        nav: +pu.uNav.value.toFixed(2),
        failures,
      };
    },

    serialize() {
      return undefined;
    },
    restore() {},
    reset() {},
    dispose() {
      removeHook?.();
      scene.remove(group);
    },
    layout: { kodiak: KODIAK_LAYOUT, sites: S.sites, lights, spaceport, markers, turbines: turbines.map((t) => ({ x: t.x, y: t.h, z: t.z, hub: t.h + TURBINE.hub })) },
  };
  return sys;
}
