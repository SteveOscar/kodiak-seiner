// WP-WILDLIFE (SPEC §6.13): the living coast. Birds (wildlife/birds.js), whales, orcas, otters, sea lions and seals
// (wildlife/marine.js), bears, deer, goats and a fox (wildlife/land.js), spray FX (wildlife/fx.js), all placed
// deterministically from the DEM and places data (wildlife/sites.js) with rng forks, simulated with distance LOD
// around the camera and drawn as instanced, vertex-animated meshes filled from a camera-following render hook.
//
// Public API: bears, whales, birds ([{ id, kind, position, heading, state }]), nearestBear(x, z), plus workingFlocks,
// animals, sighted, stage(...) for QA shots, debugState. Events: wildlife:sighted {kind, x, z, first},
// bear:encounter {stage, bearId, x, z}, and (new) wildlife:blow, wildlife:breach, wildlife:bubbleNet, wildlife:orcas,
// wildlife:disturbed.

import { resolve as resolvePlaces } from '../data/places.js';
import { findSites } from './wildlife/sites.js';
import { createRigMaterial, createRigDepthMaterial } from './wildlife/materials.js';
import { createFx } from './wildlife/fx.js';
import { createView } from './wildlife/herd.js';
import { createBirds } from './wildlife/birds.js';
import { createMarine } from './wildlife/marine.js';
import { createLand } from './wildlife/land.js';
import { seenWell, SIGHT_PX } from './wildlife/behaviour.js';

export async function create(ctx) {
  const { THREE, heightmap: hm, events } = ctx;
  const rng = ctx.rng.fork('wildlife');

  // ---- sites (places system if present, else the frozen data resolved here)
  const P = ctx.systems.places;
  const data = P?.list && P?.streams ? { places: P.list, streams: P.streams, closedAreas: P.closedAreas ?? resolvePlaces(ctx.geo).closedAreas } : resolvePlaces(ctx.geo);
  const sites = findSites({ heightmap: hm, places: data.places, streams: data.streams, closedAreas: data.closedAreas ?? [], rng: rng.fork('sites'), terrain: ctx.systems.terrain, half: ctx.config.world.half });

  // ---- shared materials
  const mats = {
    bird: createRigMaterial(ctx, 'bird', { roughness: 0.86, name: 'wildlife-bird' }),
    birdDepth: createRigDepthMaterial(ctx, 'bird'),
    whale: createRigMaterial(ctx, 'marine', { roughness: 0.34, envMapIntensity: 1.15, name: 'wildlife-whale' }),
    fur: createRigMaterial(ctx, 'marine', { roughness: 0.92, name: 'wildlife-otter' }),
    pinniped: createRigMaterial(ctx, 'marine', { roughness: 0.6, name: 'wildlife-pinniped' }),
    static: createRigMaterial(ctx, null, { roughness: 0.92, name: 'wildlife-static' }),
    quad: (kind, hip) =>
      createRigMaterial(ctx, 'quad', {
        roughness: kind === 'goat' ? 0.96 : 0.9,
        hip,
        name: `wildlife-${kind}`,
        sheen: kind === 'boar' || kind === 'sow' || kind === 'cub' ? { amount: 0.55, color: '#9c8568', roughness: 0.5 } : kind === 'goat' ? null : { amount: 0.45, color: '#a08a70', roughness: 0.55 },
      }),
    quadDepth: (kind, hip) => createRigDepthMaterial(ctx, 'quad', { hip }),
  };
  const fx = createFx(ctx);

  const terrainH = (x, z) => {
    const f = ctx.systems.terrain?.heightAt;
    const v = typeof f === 'function' ? f(x, z) : NaN;
    return Number.isFinite(v) ? v : hm.heightAt(x, z);
  };
  const env = {
    ctx,
    rng,
    sites,
    fx,
    mats,
    dt: 0,
    water: (x, z) => {
      const v = ctx.systems.water?.heightAt?.(x, z);
      return Number.isFinite(v) ? v : 0;
    },
    ground: terrainH,
    groundRaw: (x, z) => hm.heightAt(x, z),
    normal: (x, z) => hm.normalAt(x, z),
    stamp: (x, z, r, s, kind) => {
      try {
        const w = ctx.systems.water;
        if (kind === 'foam' && r > 6) {
          // Big foam: a ragged cluster of smaller patches rather than one clean disc.
          const n = Math.min(9, Math.round(r / 3));
          for (let i = 0; i < n; i++) {
            const a = Math.random() * Math.PI * 2;
            const d = r * 0.55 * Math.sqrt(Math.random());
            w?.stamp?.(x + Math.cos(a) * d, z + Math.sin(a) * d, r * (0.25 + 0.3 * Math.random()), s * (0.55 + 0.45 * Math.random()), 'foam');
          }
        } else w?.stamp?.(x, z, r, s, kind);
      } catch {
        // A neighbour's stamp queue failing must not stop the animals.
      }
    },
    // Breaches are commoner in the long golden evenings (and in rough weather).
    breachChance: () => {
      const h = ctx.clock.hours;
      const golden = h > 19 && h < 23 ? 0.1 : 0;
      const wind = Math.min(0.06, (ctx.systems.sky?.weather?.windSpeed ?? 5) * 0.005);
      return 0.1 + golden + wind;
    },
    onBubbleNet: null,
  };

  const birds = createBirds(env);
  const marine = createMarine(env);
  const land = createLand(env);
  env.onBubbleNet = (x, z) => birds.frenzy(x, z, 50, 24);

  // ---- public lists (refreshed each frame; SPEC shape { id, kind, position, heading, state })
  const birdsList = [];
  const whalesList = [];
  function refreshLists() {
    birdsList.length = 0;
    for (const b of birds.list) if (b.active && b.role !== 'idle') birdsList.push(b);
    whalesList.length = 0;
    for (const w of marine.whales) whalesList.push(w);
    for (const o of marine.orcas) if (o.state !== 'away') whalesList.push(o);
  }

  // ---- sightings
  const view = createView(THREE);
  const seen = new Set();
  let known = new Set();
  const cand = new Map();
  const tmpDir = new THREE.Vector3();
  function sight(kind, pos, size) {
    if (seen.has(kind)) return;
    const dx = pos.x - view.cam.x;
    const dy = pos.y - view.cam.y;
    const dz = pos.z - view.cam.z;
    const dist = Math.hypot(dx, dy, dz);
    const cos = (dx * view.dir.x + dy * view.dir.y + dz * view.dir.z) / Math.max(dist, 1e-3);
    const off = (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
    if (!seenWell({ size, dist, projScale: view.projScale, offAxisDeg: off, fovDeg: view.fov })) return;
    const px = (size * view.projScale) / dist;
    const c = cand.get(kind);
    if (!c || px > c.px) cand.set(kind, { px, x: pos.x, y: pos.y, z: pos.z, dist });
  }
  const pending = new Map();
  let losKinds = [];
  function resolveSightings(realDt) {
    for (const k of [...pending.keys()]) if (!cand.has(k)) pending.delete(k);
    if (ctx.state.mode !== 'play') {
      cand.clear();
      return;
    }
    losKinds = [...cand.keys()];
    // One terrain line-of-sight test per frame.
    const k = losKinds[Math.floor(ctx.time.frame % Math.max(1, losKinds.length))];
    if (k) {
      const c = cand.get(k);
      tmpDir.set(c.x - view.cam.x, c.y + 0.5 - view.cam.y, c.z - view.cam.z);
      const len = tmpDir.length();
      tmpDir.divideScalar(len || 1);
      const hit = hm.raymarch(view.cam, tmpDir, Math.max(1, len - 4));
      const p = pending.get(k) ?? { t: 0, x: c.x, z: c.z };
      if (hit < 0) {
        p.t += Math.max(realDt, 1 / 60) * Math.max(1, losKinds.length);
        p.x = c.x;
        p.z = c.z;
        pending.set(k, p);
      }
      if (p.t >= 0.45) {
        seen.add(k);
        pending.delete(k);
        events.emit('wildlife:sighted', { kind: k, x: c.x, z: c.z, first: !known.has(k) });
        known.add(k);
      }
    }
    cand.clear();
  }

  // ---- QA studio: pinned static instances of any herd (model review shots; empty in play)
  const herdByName = new Map();
  for (const h of [...Object.values(birds.herds), birds.snagHerd, ...Object.values(marine.herds), ...Object.values(land.herds)]) herdByName.set(h.name, h);
  const studio = [];
  function renderStudio() {
    const touched = new Set();
    for (const it of studio) {
      const h = herdByName.get(it.herd);
      if (!h) continue;
      const mul = h.test(it.x, it.y, it.z, it.radius ?? 3);
      if (!mul) continue;
      const a = it.a ?? [];
      const b = it.b ?? [];
      h.write(it.x, it.y, it.z, it.heading ?? 0, it.pitch ?? 0, it.roll ?? 0, (it.scale ?? 1) * mul, a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0, b[0] ?? 0, b[1] ?? 0, b[2] ?? 0, b[3] ?? 0, it.tint ?? null);
      touched.add(h);
    }
    for (const h of touched) h.end();
  }

  // ---- render hook: culling, LOD, instance fill (after the camera is final this frame)
  let renderMs = 0;
  let lastKey = '';
  const hooks = [];
  hooks.push(
    ctx.pipeline.beforeRender((realDt) => {
      const t0 = performance.now();
      try {
        const cam = ctx.camera;
        const e = cam.matrixWorld.elements;
        const key = `${e[12].toFixed(2)},${e[13].toFixed(2)},${e[14].toFixed(2)},${e[8].toFixed(4)},${e[9].toFixed(4)},${cam.fov.toFixed(2)}`;
        const still = ctx.time.dt === 0 && key === lastKey && !studio.length;
        lastKey = key;
        if (!still) {
          view.update(cam, ctx.renderer.domElement?.clientHeight || ctx.renderer.domElement?.height || 720);
          birds.render(view, sight);
          marine.render(view, sight);
          land.render(view, sight);
          if (studio.length) renderStudio();
          resolveSightings(realDt);
        }
        fx.update();
      } catch (err) {
        if (!sys.__renderErr) console.error('[wildlife] render hook failed', err);
        sys.__renderErr = (sys.__renderErr ?? 0) + 1;
      }
      renderMs += (performance.now() - t0 - renderMs) * 0.05;
    }),
  );

  // ---- events
  const offs = [
    events.on('boat:teleport', (e) => {
      if (e?.reason !== 'load') birds.teleport();
    }),
    events.on('boat:horn', () => {
      const s = ctx.systems.seiner?.position;
      if (!s) return;
      birds.flush(s.x, s.z, 350);
      for (const ho of marine.haulouts) if (Math.hypot(ho.x - s.x, ho.z - s.z) < 260) ho.disturbedAt = ctx.time.elapsed;
    }),
    events.on('game:start', () => {
      known = new Set((ctx.systems.discovery?.wildlifeSeen?.() ?? []).map((r) => r.kind));
      for (const k of known) seen.add(k);
    }),
    events.on('time:hour', () => {
      const s = ctx.systems.seiner?.position;
      if (s && ctx.state.mode === 'play') marine.maybeEvents(1, s.x, s.z);
    }),
  ];

  let updateMs = 0;
  const sys = {
    get bears() {
      return land.bears;
    },
    get whales() {
      return whalesList;
    },
    get birds() {
      return birdsList;
    },
    get animals() {
      return land.animals;
    },
    get marine() {
      return marine.others;
    },
    get workingFlocks() {
      return birds.flocks.filter((f) => f.kind === 'work');
    },
    get sighted() {
      return [...seen];
    },
    get encounter() {
      return land.encounter;
    },
    sites,
    // Internal groups for QA framing (read-only use).
    get qa() {
      return { rafts: marine.rafts, haulouts: marine.haulouts, seals: marine.sealGroups, ...birds.groups, flocks: birds.flocks };
    },
    nearestBear: (x, z) => land.nearestBear(x, z),

    // QA / staging (debug API; not used by gameplay):
    //   stage('breach' | 'surface' | 'dive' | 'bubbleNet' | 'orcas', x, z, headingRad)
    //   stageBear(bearId, 'fishing' | 'walk' | 'graze' | 'rest', x?, z?)
    stage: (kind, x, z, heading = 0) => marine.stage(kind, x, z, heading),
    stageBear: (id, state, x, z) => land.stage(id, state, x, z),
    //   studio([{ herd, x, y, z, heading, pitch, roll, scale, a: [4], b: [4], tint }]) pins static model instances;
    //   studio() clears them and returns the herd names.
    studio(items = []) {
      studio.length = 0;
      for (const it of items) studio.push(it);
      return [...herdByName.keys()];
    },

    update(dt) {
      if (!(dt > 0)) return;
      const t0 = performance.now();
      env.dt = dt;
      const cam = ctx.camera.position;
      const rangeMul = ctx.systems.cameraRig?.binoculars ? 2.5 : 1;
      birds.update(dt, cam, rangeMul);
      marine.update(dt, cam, rangeMul);
      land.update(dt, cam, rangeMul);
      refreshLists();
      updateMs = performance.now() - t0;
    },

    debugState() {
      const count = (list) => list.length;
      const drawn = (list) => list.filter((a) => a.drawn).length;
      const whaleStates = {};
      for (const w of marine.whales) whaleStates[w.state] = (whaleStates[w.state] ?? 0) + 1;
      const flocks = birds.flocks;
      return {
        sites: { haulouts: sites.haulouts.length, bearSites: sites.bearSites.length, otterBeds: sites.otterBeds.length, whaleRanges: sites.whaleRanges.length, cliffs: sites.cliffs.length },
        birds: { active: birdsList.length, drawn: drawn(birds.list), followers: birds.followers, byKind: { ...birds.drawn } },
        flocks: { work: flocks.filter((f) => f.kind === 'work' && f.overSchool).length, bait: flocks.filter((f) => f.kind === 'work' && !f.overSchool).length, swarm: flocks.filter((f) => f.kind === 'swarm').length },
        whales: { humpbacks: count(marine.whales), drawn: drawn(marine.whales), states: whaleStates, orcas: marine.podActive ? drawn(marine.orcas) + '/' + marine.orcas.length : 'away' },
        marine: { total: count(marine.others), drawn: drawn(marine.others) },
        bears: { total: count(land.bears), active: land.bears.filter((b) => b.active).length, drawn: drawn(land.bears) },
        land: { total: count(land.animals), drawn: drawn(land.animals) },
        encounter: land.encounter,
        sighted: [...seen],
        fx: { active: fx.active, spawned: fx.spawned },
        tris: (() => {
          const out = {};
          let total = 0;
          for (const [name, h] of herdByName) {
            const t = h.triangles();
            if (t) out[name] = t;
            total += t;
          }
          out.total = total;
          return out;
        })(),
        ms: { update: +updateMs.toFixed(3), render: +renderMs.toFixed(3) },
      };
    },

    serialize() {
      return undefined;
    },
    restore() {},
    reset() {
      seen.clear();
      known = new Set();
      pending.clear();
      birds.reset();
      marine.reset();
      land.reset();
    },
    dispose() {
      for (const off of offs) off?.();
      for (const h of hooks) h?.();
    },
  };
  return sys;
}
