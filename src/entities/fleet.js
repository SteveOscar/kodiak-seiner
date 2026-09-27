// WP-BOATS: the ambient fleet (SPEC §6.6). Tenders anchored on the grounds (they buy fish and sell fuel), the eight
// fleet-board seiners working their grounds (round-haul sets with corklines you can see from across the bay), the
// Tustumena on the Kodiak - Ouzinkie - Port Lions run, the cutter Alex Haley off Womens Bay, and skiffs. Vessels
// switch between a detailed and a one-mesh model by distance; every navigation light draws in one call.

import * as THREE from 'three';
import { patchUnderwater } from '../render/shaderChunks.js';
import { TENDERS, GROUNDS, FLEET_SEINERS, FERRY, CUTTER, SKIFF_SITES } from './boats/fleetData.js';
import { createFleetBoatAI, createShuttleAI } from './boats/fleetAI.js';
import { buildFleetSeiner, buildTender, buildFerry, buildCutter, fleetMaterials } from './boats/fleetModels.js';
import { buildSkiffModel } from './boats/skiffModel.js';
import { buildNavGrid, createSearch } from './boats/nav.js';
import { createGlowSet, createLightPools, projScale } from './boats/fx.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const TAU = Math.PI * 2;
const LIMIT = 7350;

export async function create(ctx) {
  const { scene, heightmap, geo } = ctx;
  const rng = ctx.rng.fork('fleet');
  const places = ctx.systems.places;
  const grid = buildNavGrid(heightmap, { cell: 50 });
  const root = new THREE.Group();
  root.name = 'fleet';
  scene.add(root);
  const mats = fleetMaterials(ctx);

  // ------------------------------------------------------------------ helpers
  const placeXZ = (id, hint) => {
    const p = id ? places?.get?.(id) : null;
    if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) return { x: p.x, z: p.z };
    return hint ? geo.toWorld(hint[0], hint[1]) : null;
  };
  const inBounds = (x, z) => Math.abs(x) < LIMIT && Math.abs(z) < LIMIT;
  // Nearest open water around (x, z) meeting the clearance/depth, relaxing the requirements if needed.
  function anchorage(x, z, tries = [[120, 6], [90, 4.5], [60, 3.2], [35, 2.6]], maxR = 1600) {
    for (const [shore, depth] of tries) {
      for (let r = 0; r <= maxR; r += 25) {
        const n = Math.max(1, Math.ceil((TAU * r) / 30));
        let best = null;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * TAU;
          const px = x + Math.cos(a) * r;
          const pz = z + Math.sin(a) * r;
          if (!inBounds(px, pz)) continue;
          const sd = heightmap.shoreDistance(px, pz);
          if (sd >= shore && heightmap.depthAt(px, pz) >= depth && (!best || sd > best.sd)) best = { x: px, z: pz, sd };
        }
        if (best) return best;
      }
    }
    return { x, z, sd: 0 };
  }
  const waterOk = (x, z) => inBounds(x, z) && heightmap.shoreDistance(x, z) > 18 && heightmap.depthAt(x, z) > 3.5;

  // Incremental routing shared by every vessel (budgeted per frame).
  const queue = [];
  function route(from, to, { clearance = 32, minDepth = 3, sync = false } = {}) {
    const search = createSearch(grid, from, to, { clearance, minDepth });
    const req = { status: search.status, path: null };
    const job = { search, req };
    if (sync) {
      let st = search.status;
      for (let i = 0; i < 400 && st === 'running'; i++) st = search.step(4000);
      req.status = st;
      req.path = search.path;
    } else queue.push(job);
    return req;
  }
  function pumpRoutes(budget = 3500) {
    while (queue.length && budget > 0) {
      const job = queue[0];
      const before = job.search.expanded;
      const st = job.search.step(Math.min(budget, 1500));
      budget -= Math.max(1, job.search.expanded - before);
      if (st !== 'running') {
        job.req.status = st;
        job.req.path = job.search.path;
        queue.shift();
      }
    }
  }

  // ------------------------------------------------------------------ tenders
  const tenders = [];
  const lightRefs = []; // { vessel, def } in glow-set order
  function registerLights(vessel, defs) {
    vessel.lightStart = lightRefs.length;
    for (const d of defs) lightRefs.push({ vessel, def: d });
    vessel.lightCount = defs.length;
  }

  for (const spec of TENDERS) {
    const hint = placeXZ(spec.placeId, spec.hint);
    if (!hint) continue;
    const a = anchorage(hint.x, hint.z);
    const model = buildTender(ctx, spec);
    const group = new THREE.Group();
    group.name = `tender-${spec.id}`;
    group.add(model.near, model.far);
    root.add(group);
    const placeId = places?.get?.(spec.placeId) ? spec.placeId : (places?.nearest?.(a.x, a.z)?.place?.id ?? spec.placeId);
    const c = ctx.tide?.currentAt?.(a.x, a.z) ?? { x: 0, z: 0 };
    const heading = Math.hypot(c.x, c.z) > 0.02 ? Math.atan2(-c.x, c.z) : rng.range(0, TAU);
    const tender = {
      id: spec.id,
      name: spec.name,
      kind: 'tender',
      placeId,
      position: group.position,
      heading,
      object3d: group,
      buying: true,
      radius: spec.length / 2,
      services: ['sell', 'fuel'],
      channel: spec.channel,
      length: spec.length,
      beam: model.beam,
      halfLength: model.halfLength,
      collisionRadius: model.radius,
      model,
      bob: rng.range(0, TAU),
    };
    group.position.set(a.x, 0, a.z);
    group.rotation.y = -heading;
    registerLights(tender, model.lights);
    tenders.push(tender);
  }
  const tenderById = Object.fromEntries(tenders.map((t) => [t.id, t]));

  // ------------------------------------------------------------------ grounds and spots
  const groundInfo = {};
  for (const [gid, g] of Object.entries(GROUNDS)) {
    const centres = [...g.anchors.map((id) => placeXZ(id, null)).filter(Boolean), ...g.hints.map((h) => geo.toWorld(h[0], h[1]))];
    const tender = tenderById[g.tender] ?? null;
    const spots = [];
    const srng = rng.fork(`spots:${gid}`);
    for (let k = 0; k < 260 && spots.length < 8; k++) {
      const c = centres[k % centres.length];
      const r = srng.range(300, 1800);
      const a = srng.range(0, TAU);
      const x = c.x + Math.cos(a) * r;
      const z = c.z + Math.sin(a) * r;
      if (!inBounds(x, z)) continue;
      const sd = heightmap.shoreDistance(x, z);
      if (sd < 80 || sd > 320 || heightmap.depthAt(x, z) < 7) continue;
      if (spots.some((s) => Math.hypot(s.x - x, s.z - z) < 260)) continue;
      spots.push({ x, z });
    }
    if (!spots.length) spots.push(anchorage(centres[0].x, centres[0].z, [[90, 6], [50, 3]]));
    const t = tender ?? { x: spots[0].x, z: spots[0].z };
    const ax = (tender?.position.x ?? t.x) + srng.range(-1, 1) * 180;
    const az = (tender?.position.z ?? t.z) + srng.range(-1, 1) * 180;
    groundInfo[gid] = { spots, tender, anchorage: anchorage(ax, az, [[80, 5], [50, 3]], 600) };
  }

  // ------------------------------------------------------------------ fleet seiners
  // Names follow the fleet board (WP-RULES) when it loads, so the boats on the water are the boats on the board.
  const board = await import('../game/data/fleetBoard.js').then((m) => m.FLEET).catch(() => null);
  const boardNames = Array.isArray(board) ? board.map((b) => b?.name).filter((n) => typeof n === 'string' && n) : [];
  const boats = [];
  const seiners = [];
  const skiffs = [];
  for (let i = 0; i < FLEET_SEINERS.length; i++) {
    const style = { ...FLEET_SEINERS[i], name: boardNames[i] ?? FLEET_SEINERS[i].name };
    const gi = groundInfo[style.ground] ?? Object.values(groundInfo)[0];
    const model = buildFleetSeiner(ctx, style);
    const group = new THREE.Group();
    group.name = `fleet-${style.name}`;
    group.add(model.near, model.far);
    root.add(group);
    const stowed = buildSkiffModel(ctx, { detail: 'low', stripe: style.skiff });
    stowed.group.position.fromArray(model.skiffMount.pos);
    stowed.group.rotation.x = model.skiffMount.rotX;
    model.near.add(stowed.group);
    const loose = buildSkiffModel(ctx, { detail: 'low', stripe: style.skiff });
    loose.group.visible = false;
    root.add(loose.group);
    const brng = rng.fork(`boat:${style.name}`);
    const t = gi.tender;
    const ai = createFleetBoatAI({
      id: `fleet-${i}`,
      name: style.name,
      spots: gi.spots,
      tender: t ? { x: t.position.x, z: t.position.z, heading: t.heading, beam: t.beam } : null,
      anchorage: gi.anchorage,
      rng: () => brng.next(),
      start: { ...gi.spots[Math.floor(brng.next() * gi.spots.length)], heading: brng.range(0, TAU) },
    });
    const boat = {
      id: `fleet-${i}`,
      name: style.name,
      kind: 'seiner',
      type: 'seiner',
      ground: style.ground,
      position: group.position,
      get heading() {
        return ai.s.heading;
      },
      get speed() {
        return ai.s.speed;
      },
      get state() {
        return ai.s.state;
      },
      object3d: group,
      radius: model.radius,
      halfLength: model.halfLength,
      ai,
      model,
      stowedSkiff: stowed.group,
      looseSkiff: loose.group,
      bob: brng.range(0, TAU),
      att: { pitch: 0, roll: 0 },
    };
    registerLights(boat, model.lights);
    boats.push(boat);
    seiners.push(boat);
    const skiff = {
      id: `fleet-skiff-${i}`,
      name: `${style.name} skiff`,
      kind: 'skiff',
      type: 'skiff',
      position: loose.group.position,
      heading: 0,
      object3d: loose.group,
      radius: 1.6,
      halfLength: 1.4,
      owner: boat,
    };
    skiffs.push(skiff);
    boats.push(skiff);
  }

  // Setnet / cannery skiffs pottering between beach spots.
  const setnetSkiffs = [];
  for (const site of SKIFF_SITES) {
    const c = placeXZ(site.anchor, site.hint);
    if (!c) continue;
    const pts = [];
    for (let k = 0; k < 40 && pts.length < 3; k++) {
      const a = rng.range(0, TAU);
      const r = rng.range(80, 500);
      const x = c.x + Math.cos(a) * r;
      const z = c.z + Math.sin(a) * r;
      const sd = heightmap.shoreDistance(x, z);
      if (inBounds(x, z) && sd > 12 && sd < 90 && heightmap.depthAt(x, z) > 0.8) pts.push({ x, z });
    }
    if (pts.length < 2) continue;
    const m = buildSkiffModel(ctx, { detail: 'low', stripe: '#b8bdc0' });
    root.add(m.group);
    const sk = {
      id: `setnet-${setnetSkiffs.length}`,
      name: 'setnet skiff',
      kind: 'skiff',
      type: 'skiff',
      position: m.group.position,
      heading: 0,
      object3d: m.group,
      radius: 1.6,
      halfLength: 1.4,
      pts,
      leg: 0,
      wait: rng.range(0, 20),
      speed: 0,
      x: pts[0].x,
      z: pts[0].z,
    };
    m.group.position.set(sk.x, 0, sk.z);
    setnetSkiffs.push(sk);
    boats.push(sk);
  }

  // ------------------------------------------------------------------ ferry and cutter
  const shuttles = [];
  function addShuttle(def, build, kind, clearance) {
    const stops = def.stops ?? def.patrol;
    const pts = stops.map((s) => {
      const c = placeXZ(s.placeId, s.hint);
      const a = anchorage(c.x, c.z, [[clearance, 6], [clearance * 0.7, 4], [40, 3]], 1500);
      return { x: a.x, z: a.z, dwell: s.dwell ?? 25 };
    });
    const model = build(ctx);
    const group = new THREE.Group();
    group.name = `${kind}-${def.id}`;
    group.add(model.near, model.far);
    root.add(group);
    const srng = rng.fork(kind);
    const ai = createShuttleAI({ id: def.id, name: def.name, stops: pts, speed: def.speed, rng: () => srng.next(), start: Math.floor(srng.next() * pts.length) });
    ai.s.heading = srng.range(0, TAU);
    const v = {
      id: def.id,
      name: def.name,
      kind,
      type: kind,
      position: group.position,
      get heading() {
        return ai.s.heading;
      },
      get speed() {
        return ai.s.speed;
      },
      get state() {
        return ai.s.state;
      },
      object3d: group,
      radius: model.radius,
      halfLength: model.halfLength,
      ai,
      model,
      clearance,
      bob: srng.range(0, TAU),
      att: { pitch: 0, roll: 0 },
    };
    registerLights(v, model.lights);
    boats.push(v);
    shuttles.push(v);
    return v;
  }
  const ferry = addShuttle(FERRY, buildFerry, 'ferry', 70);
  const cutter = addShuttle(CUTTER, buildCutter, 'cutter', 70);

  // Seiner skiffs and setnet skiffs get a white all-round light too.
  const skiffLightStart = lightRefs.length;
  for (const sk of [...skiffs, ...setnetSkiffs]) {
    sk.lightStart = lightRefs.length;
    sk.lightCount = 1;
    lightRefs.push({ vessel: sk, def: { id: 'skiff', pos: [0, 1.9, -2.2], color: 0xfff2dc, size: 0.4, intensity: 1.2 } });
  }
  void skiffLightStart;

  const glows = createGlowSet(
    ctx,
    lightRefs.map((r) => ({ pos: [0, -1000, 0], color: r.def.color, size: r.def.size, intensity: r.def.intensity, on: false })),
    { name: 'fleet-lights' },
  );

  // Deck floods pooling on the water at night: one slot per tender and fleet seiner.
  const pools = createLightPools(ctx, tenders.length + seiners.length, { name: 'fleet-light-pools' });

  // Corklines of sets in progress: one instanced draw for every fleet cork.
  const MAX_CORKS = 1600;
  const corkGeo = new THREE.CapsuleGeometry(0.12, 0.1, 2, 6);
  corkGeo.rotateZ(Math.PI / 2);
  const corkMat = patchUnderwater(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 }), ctx.uniforms);
  const corks = new THREE.InstancedMesh(corkGeo, corkMat, MAX_CORKS);
  corks.name = 'fleet-corks';
  corks.count = 0;
  corks.frustumCulled = false;
  const yellow = new THREE.Color('#e8b62a');
  const white = new THREE.Color('#ece7da');
  for (let i = 0; i < MAX_CORKS; i++) corks.setColorAt(i, i % 9 === 0 ? white : yellow);
  corks.instanceColor.needsUpdate = true;
  root.add(corks);

  // ------------------------------------------------------------------ world interface for the AI
  const playerPos = { x: 0, z: 0 };
  const world = {
    fishing: true,
    route: (from, to) => route(from, to),
    current: (x, z) => ctx.tide?.currentAt?.(x, z) ?? { x: 0, z: 0 },
    water: waterOk,
    player: null,
  };
  // Fleet boats fish during openers (always in the title cinematic) and lie at anchor otherwise.
  function fishingOpen(x, z) {
    if (ctx.state.mode === 'title') return true;
    const h = ctx.clock?.hours ?? 12;
    const s = ctx.systems.season;
    if (typeof s?.openerActive === 'function') {
      try {
        return !!s.openerActive(x, z);
      } catch {
        return h >= 6 && h < 22;
      }
    }
    return h >= 6 && h < 22;
  }

  // Warm start so the grounds are busy from the first frame: every boat is somewhere in its cycle.
  {
    const syncWorld = { ...world, route: (from, to) => route(from, to, { sync: true }) };
    for (const b of seiners) {
      const n = Math.floor(rng.range(0, 360) / 0.5);
      for (let i = 0; i < n; i++) b.ai.step(0.5, syncWorld);
    }
    for (const v of shuttles) {
      const n = Math.floor(rng.range(0, 240) / 0.5);
      const clearance = v.clearance;
      const w = { ...world, route: (from, to) => route(from, to, { sync: true, clearance, minDepth: 4.5 }) };
      for (let i = 0; i < n; i++) v.ai.step(0.5, w);
    }
  }

  // ------------------------------------------------------------------ per-frame posing
  const cam = ctx.camera.position;
  const tmp = new THREE.Vector3();
  const mtx = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3(1, 1, 1);
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const waterY = (x, z) => ctx.systems.water?.heightAt?.(x, z) ?? 0;
  let night = 0;
  let stamps = 0;

  function lod(v, near, far) {
    const d = Math.hypot(v.object3d.position.x - cam.x, v.object3d.position.z - cam.z);
    v.dist = d;
    const m = v.model;
    if (!m) return d;
    m.near.visible = d < near;
    m.far.visible = d >= near && d < far;
    v.object3d.visible = d < far;
    return d;
  }

  function poseHull(v, x, z, heading, length, dt, t) {
    const g = v.object3d;
    const d = v.dist ?? 1e9;
    let y = 0;
    let pitch = 0;
    let roll = 0;
    if (d < 1600) {
      const fx = Math.sin(heading) * length * 0.4;
      const fz = -Math.cos(heading) * length * 0.4;
      const hb = waterY(x + fx, z + fz);
      const hs = waterY(x - fx, z - fz);
      y = (hb + hs) * 0.5;
      pitch = Math.atan2(hb - hs, length * 0.8);
      roll = Math.sin(t * 0.7 + v.bob) * 0.02 * (18 / length);
    } else {
      y = Math.sin(t * 0.5 + v.bob) * 0.15;
    }
    const a = v.att ?? (v.att = { pitch: 0, roll: 0 });
    a.pitch += (pitch - a.pitch) * Math.min(1, dt * 1.5);
    a.roll += (roll - a.roll) * Math.min(1, dt * 1.5);
    g.position.set(x, y - (v.kind === 'tender' ? 0.25 : 0.14), z);
    g.rotation.set(a.pitch, -heading, -a.roll, 'YXZ');
  }

  // Stern wash and, near the camera focus, the bow wave peeling off both shoulders.
  function stampWake(x, z, heading, speed, length, beam) {
    const w = ctx.systems.water;
    if (!w?.stamp || speed < 0.8 || stamps > 72) return;
    const f = ctx.systems.cameraRig?.focus ?? cam;
    const d = Math.hypot(x - f.x, z - f.z);
    if (d > 1000) return;
    const fx = Math.sin(heading);
    const fz = -Math.cos(heading);
    const sx = x - fx * length * 0.5;
    const sz = z - fz * length * 0.5;
    w.stamp(sx, sz, beam * 0.3 + speed * 0.1, clamp(speed / 12, 0.1, 0.5), 'foam');
    stamps++;
    const k = clamp((speed - 3) / 7, 0, 1);
    if (k > 0.05 && d < 700) {
      const rx = Math.cos(heading);
      const rz = Math.sin(heading);
      for (const side of [-1, 1]) {
        const bx = x + fx * length * 0.4 + rx * side * beam * 0.3;
        const bz = z + fz * length * 0.4 + rz * side * beam * 0.3;
        w.stamp(bx, bz, beam * 0.2 + 0.6, k * 0.45, 'foam');
        w.stamp(bx - fx * length * 0.35 + rx * side * beam * 0.3, bz - fz * length * 0.35 + rz * side * beam * 0.3, beam * 0.25 + 0.8, k * 0.32, 'foam');
      }
      stamps += 4;
    }
  }

  // Navigation/deck light sprites. In daylight they are invisible (the glow set scales by night), so skip the work.
  function setLights(v, fn) {
    const dark = night > 0.01;
    for (let i = 0; i < v.lightCount; i++) {
      const ref = lightRefs[v.lightStart + i];
      const on = dark && v.object3d.visible && fn(ref.def.id);
      glows.setOn(v.lightStart + i, on);
      if (on) {
        tmp.fromArray(ref.def.pos).applyMatrix4(v.object3d.matrixWorld);
        glows.setPos(v.lightStart + i, tmp.x, tmp.y, tmp.z);
      }
    }
  }

  // Fleet corklines, refreshed at half the frame rate (they move at set speed, well under a cork per frame).
  let corkTick = 0;
  function updateCorks() {
    if ((corkTick++ & 1) === 1) return;
    let n = 0;
    const t = ctx.time.elapsed;
    for (const b of seiners) {
      const list = b.ai.s.corks;
      if (!list.length || n >= MAX_CORKS) continue;
      const cx = b.object3d.position.x;
      const cz = b.object3d.position.z;
      const d = Math.hypot(cx - cam.x, cz - cam.z);
      if (d > 5000) continue;
      // Corks stay readable across a bay: they grow with distance so a corkline reads as a dotted arc to ~3 km.
      const s = Math.max(1.4, d / 150);
      const near = d < 450;
      for (let i = 0; i < list.length && n < MAX_CORKS; i++) {
        const c = list[i];
        const y = near ? waterY(c.x, c.z) : 0;
        const next = list[Math.min(list.length - 1, i + 1)];
        const prev = list[Math.max(0, i - 1)];
        const ang = Math.atan2(next.x - prev.x, -(next.z - prev.z));
        quat.setFromEuler(euler.set(0, -ang + Math.PI / 2, Math.sin(t * 1.3 + i) * 0.1, 'YXZ'));
        scl.setScalar(s);
        mtx.compose(tmp.set(c.x, y + 0.03 * s, c.z), quat, scl);
        corks.setMatrixAt(n++, mtx);
      }
    }
    corks.count = n;
    if (n) corks.instanceMatrix.needsUpdate = true;
  }

  // ------------------------------------------------------------------ system
  const sys = {
    tenders,
    boats,
    get ferry() {
      return ferry;
    },
    get cutter() {
      return cutter;
    },
    grid,

    nearestTender(x, z) {
      let best = null;
      let bd = Infinity;
      for (const t of tenders) {
        const d = Math.hypot(t.position.x - x, t.position.z - z);
        if (d < bd) {
          bd = d;
          best = t;
        }
      }
      return best ? { tender: best, distance: bd } : null;
    },

    // Collision capsules for the player's seiner: { id, x, z, heading, halfLength, radius }.
    obstacles() {
      const out = sys._obs ?? (sys._obs = []);
      out.length = 0;
      for (const t of tenders) out.push({ id: t.id, x: t.position.x, z: t.position.z, heading: t.heading, halfLength: t.halfLength, radius: t.collisionRadius });
      for (const b of boats) {
        if (b.kind === 'skiff' && !b.object3d.visible) continue;
        out.push({ id: b.id, x: b.position.x, z: b.position.z, heading: b.heading ?? 0, halfLength: b.halfLength ?? 0, radius: b.radius ?? 3 });
      }
      return out;
    },

    update(dt) {
      if (!(dt > 0)) return;
      const t = ctx.time.elapsed;
      stamps = 0;
      const sn = ctx.systems.seiner;
      if (sn?.position) {
        playerPos.x = sn.position.x;
        playerPos.z = sn.position.z;
        world.player = playerPos;
      }
      pumpRoutes(3500);
      const daylight = ctx.systems.sky?.daylight ?? ctx.uniforms.uDaylight.value ?? 1;
      const target = clamp((0.5 - daylight) / 0.35, 0, 1);
      night += (target - night) * Math.min(1, dt * 2);
      mats.glass.emissiveIntensity = clamp((0.32 - daylight) / 0.25, 0, 1) * 1.2;
      glows.night = night;
      pools.night = night;
      const poolOn = night > 0.02;

      // Tenders: at anchor, swinging slowly to the stream.
      for (let ti = 0; ti < tenders.length; ti++) {
        const tn = tenders[ti];
        lod(tn, 1500, 11000);
        const c = ctx.tide?.currentAt?.(tn.position.x, tn.position.z) ?? { x: 0, z: 0 };
        if (Math.hypot(c.x, c.z) > 0.04) {
          const want = Math.atan2(-c.x, c.z);
          let d = want - tn.heading;
          d = Math.atan2(Math.sin(d), Math.cos(d));
          tn.heading += clamp(d, -0.01 * dt, 0.01 * dt);
        }
        poseHull(tn, tn.position.x, tn.position.z, tn.heading, tn.length, dt, t);
        tn.object3d.updateMatrixWorld(true);
        setLights(tn, (id) => id !== 'port' && id !== 'starboard');
        const litT = poolOn && tn.object3d.visible && tn.dist < 6000;
        if (litT) {
          const px = tn.position.x - Math.sin(tn.heading) * tn.length * 0.12;
          const pz = tn.position.z + Math.cos(tn.heading) * tn.length * 0.12;
          pools.set(ti, px, waterY(px, pz) + 0.3, pz, tn.length * 0.8, true, 1);
        } else pools.set(ti, 0, 0, 0, 0, false);
      }

      // Fleet seiners and their skiffs.
      for (let si = 0; si < seiners.length; si++) {
        const b = seiners[si];
        const s = b.ai.s;
        world.fishing = fishingOpen(s.x, s.z);
        b.ai.step(dt, world);
        lod(b, 1000, 8500);
        poseHull(b, s.x, s.z, s.heading, 17.7, dt, t);
        b.stowedSkiff.visible = !s.skiff.out;
        const sk = b.looseSkiff;
        sk.visible = s.skiff.out && b.dist < 3000;
        if (sk.visible) {
          sk.position.set(s.skiff.x, waterY(s.skiff.x, s.skiff.z) - 0.05, s.skiff.z);
          sk.rotation.set(0, -s.skiff.heading, 0);
        }
        stampWake(s.x, s.z, s.heading, s.speed, 17.7, 6.3);
        if (s.skiff.out && s.skiff.speed > 1) stampWake(s.skiff.x, s.skiff.z, s.skiff.heading, s.skiff.speed * 2, 5.8, 2.9);
        b.object3d.updateMatrixWorld(true);
        const setting = ['set', 'close', 'purse', 'haul', 'brail'].includes(s.state);
        const working = setting || s.state === 'deliver';
        setLights(b, (id) => {
          if (id === 'anchor') return s.anchored;
          if (id === 'fishRed' || id === 'fishWhite') return setting;
          if (id === 'flood') return working;
          if (id === 'masthead') return !s.anchored && !setting;
          return !s.anchored;
        });
        const litS = poolOn && working && b.object3d.visible && b.dist < 4000;
        if (litS) {
          const px = s.x - Math.sin(s.heading) * 3;
          const pz = s.z + Math.cos(s.heading) * 3;
          pools.set(tenders.length + si, px, waterY(px, pz) + 0.3, pz, 13, true, 0.65);
        } else pools.set(tenders.length + si, 0, 0, 0, 0, false);
      }
      for (let i = 0; i < skiffs.length; i++) {
        const sk = skiffs[i];
        const s = sk.owner.ai.s;
        sk.heading = s.skiff.heading;
        const vis = sk.object3d.visible;
        glows.setOn(sk.lightStart, vis);
        if (vis) {
          sk.object3d.updateMatrixWorld(true);
          tmp.set(0, 1.9, -2.2).applyMatrix4(sk.object3d.matrixWorld);
          glows.setPos(sk.lightStart, tmp.x, tmp.y, tmp.z);
        }
      }

      // Setnet skiffs.
      for (const sk of setnetSkiffs) {
        const d = Math.hypot(sk.x - cam.x, sk.z - cam.z);
        sk.object3d.visible = d < 2500;
        if (sk.wait > 0) {
          sk.wait -= dt;
          sk.speed = Math.max(0, sk.speed - dt * 2);
        } else {
          const p = sk.pts[sk.leg];
          const dd = Math.hypot(p.x - sk.x, p.z - sk.z);
          if (dd < 3) {
            sk.leg = (sk.leg + 1) % sk.pts.length;
            sk.wait = 15 + Math.random() * 40;
          } else {
            const want = Math.atan2(p.x - sk.x, -(p.z - sk.z));
            let e = want - sk.heading;
            e = Math.atan2(Math.sin(e), Math.cos(e));
            sk.heading += clamp(e, -1.2 * dt, 1.2 * dt);
            sk.speed += (Math.min(5.5, dd * 0.4) - sk.speed) * Math.min(1, dt);
            sk.x += Math.sin(sk.heading) * sk.speed * dt;
            sk.z += -Math.cos(sk.heading) * sk.speed * dt;
          }
        }
        if (sk.object3d.visible) {
          sk.object3d.position.set(sk.x, waterY(sk.x, sk.z) - 0.05, sk.z);
          sk.object3d.rotation.set(-sk.speed * 0.012, -sk.heading, 0);
          stampWake(sk.x, sk.z, sk.heading, sk.speed * 1.5, 5.8, 2.9);
          sk.object3d.updateMatrixWorld(true);
          tmp.set(0, 1.9, -2.2).applyMatrix4(sk.object3d.matrixWorld);
          glows.setPos(sk.lightStart, tmp.x, tmp.y, tmp.z);
        }
        glows.setOn(sk.lightStart, sk.object3d.visible && sk.wait <= 0);
      }

      // Ferry and cutter.
      for (const v of shuttles) {
        const clearance = v.clearance;
        // Per-vessel routing view (deep-draught clearance), created once and reused.
        v.world ??= { ...world, route: (from, to) => route(from, to, { clearance, minDepth: 4.5 }) };
        v.world.fishing = world.fishing;
        v.world.player = world.player;
        v.ai.step(dt, v.world);
        lod(v, 2600, 13000);
        const s = v.ai.s;
        poseHull(v, s.x, s.z, s.heading, v.kind === 'ferry' ? 90 : 86, dt, t);
        stampWake(s.x, s.z, s.heading, s.speed, v.kind === 'ferry' ? 90 : 86, 16);
        v.object3d.updateMatrixWorld(true);
        const moving = s.speed > 0.3 || s.state !== 'dwell';
        setLights(v, (id) => (id === 'win' ? true : id === 'port' || id === 'starboard' || id === 'masthead' || id === 'masthead2' ? moving : true));
      }

      updateCorks();
      pools.commit();
    },

    frame() {
      glows.scale = projScale(ctx.renderer, ctx.camera);
    },

    debugState() {
      const states = {};
      for (const b of seiners) states[b.name] = b.ai.s.state;
      return {
        tenders: tenders.map((t) => `${t.name}@${t.position.x.toFixed(0)},${t.position.z.toFixed(0)}`),
        seiners: states,
        ferry: ferry ? `${ferry.ai.s.state}@${ferry.position.x.toFixed(0)},${ferry.position.z.toFixed(0)}` : null,
        cutter: cutter ? `${cutter.ai.s.state}@${cutter.position.x.toFixed(0)},${cutter.position.z.toFixed(0)}` : null,
        routesPending: queue.length,
        corks: corks.count,
      };
    },

    reset() {},
  };
  sys.update(1 / 60);
  return sys;
}
