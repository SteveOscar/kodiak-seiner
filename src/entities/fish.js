// WP-FISH: salmon schools, jumpers and the fish side of a set (SPEC §6.10).
//
//   fish/sim.js        school simulation: spawning from runs/streams/speciesMix, coastal migration with the flood,
//                      milling, spooking/sounding, the open-period guarantee, the tutorial school, net interaction
//                      (deflection, hook, gap, leadline escape, trapping, the bag) and harvest. Pure, unit-tested.
//   fish/netModel.js   escape and capture maths.      fish/jumps.js   jump signatures and poses.
//   fish/world.js      ctx → the sim's world adapter.  fish/render.js  instanced salmon, jumpers, finners, FX.
//
// Public surface: schools, nearestSchool, schoolsWithin, schoolsInside, harvest, sonarReturns, spawnSchool, plus
// debugState and debug helpers (debugBag, debugJump). Events: fish:jump, fish:spooked, fishing:escape.

import { createFishSim } from './fish/sim.js';
import { createWorldAdapter } from './fish/world.js';
import { createFishRenderer } from './fish/render.js';
import { SPECIES } from './fish/species.js';

export async function create(ctx) {
  const rng = ctx.rng.fork('fish');
  let netOverride = null;
  const world = createWorldAdapter(ctx, { netOverride: () => netOverride });
  const sim = createFishSim({ config: ctx.config, rng, world });

  let renderer = null;
  try {
    if (ctx.renderer && ctx.pipeline?.beforeRender) renderer = createFishRenderer(ctx, sim);
  } catch (err) {
    // The simulation (and every consumer of the API) keeps working without visuals.
    console.error('[fish] renderer failed to initialise', err);
    renderer = null;
  }

  const spawnPoint = () => ctx.systems.places?.spawn ?? ctx.systems.seiner?.position ?? { x: 0, z: 0, heading: 0 };

  ctx.events.on('game:start', ({ newGame, freeExplore } = {}) => {
    // The tutorial school belongs to a new season; Free Explore relies on the open-water guarantee instead.
    if (newGame && !freeExplore) {
      const s = spawnPoint();
      const p = ctx.systems.seiner?.position ?? s;
      sim.spawnTutorial(p.x, p.z, ctx.systems.seiner?.heading ?? s.heading ?? null);
    } else if (!newGame) sim.reseed();
  });
  ctx.events.on('time:skip', () => sim.reseed());
  let lastTeleport = null;
  ctx.events.on('boat:teleport', (e) => {
    if (!e || !Number.isFinite(e.x)) return;
    const far = lastTeleport && Math.hypot(e.x - lastTeleport.x, e.z - lastTeleport.z) > 2500;
    lastTeleport = { x: e.x, z: e.z };
    if (far && e.reason !== 'start' && e.reason !== 'boot' && e.reason !== 'load') sim.rehome();
  });
  ctx.events.on('boat:horn', () => {
    const p = ctx.systems.seiner?.position;
    if (p) sim.onHorn(p.x, p.z);
  });
  ctx.events.on('fishing:skiffReleased', (e) => {
    const p = e && Number.isFinite(e.x) ? e : ctx.systems.skiff?.position;
    if (p) sim.onSkiffSplash(p.x, p.z);
  });

  // Debug: a pursed net (circle) around a fresh school beside the seiner, optionally hauling itself in so the bag
  // can be inspected without the real net. debugBag(null) releases it.
  let bagAnim = null;
  function debugBag(opts = {}) {
    if (opts === null) {
      netOverride = null;
      bagAnim = null;
      return null;
    }
    const s = ctx.systems.seiner;
    const h = s?.heading ?? 0;
    const side = opts.side === 'port' ? -1 : 1;
    const cx = opts.x ?? (s ? s.position.x + Math.cos(h) * side * 14 : 0);
    const cz = opts.z ?? (s ? s.position.z + Math.sin(h) * side * 14 : 0);
    const r0 = opts.radius ?? 16;
    const rNow = Math.max(2.2, r0 * (1 - 0.86 * (opts.animate ? opts.from ?? 0 : opts.hauled ?? 0.6)));
    const school = sim.spawnSchool({ x: cx, z: cz, species: opts.species ?? 'pink', count: opts.count ?? 5000, milling: true, spookable: false, radius: rNow * 0.55 });
    const target = Math.min(0.97, opts.hauled ?? (opts.animate ? 0.95 : 0.6));
    bagAnim = { cx, cz, r0, hauled: opts.animate ? opts.from ?? 0 : target, target, rate: opts.animate ? 1 / (opts.seconds ?? 25) : 0, school };
    const poly = () => {
      const r = Math.max(2.2, bagAnim.r0 * (1 - 0.86 * bagAnim.hauled));
      const pts = [];
      for (let i = 0; i < 28; i++) {
        const a = (i / 28) * Math.PI * 2;
        const wob = 1 + 0.06 * Math.sin(a * 3 + 1.3);
        pts.push({ x: bagAnim.cx + Math.cos(a) * r * wob * 1.25, z: bagAnim.cz + Math.sin(a) * r * wob * 0.8 });
      }
      return pts;
    };
    netOverride = {
      get state() {
        return bagAnim.hauled > 0 ? 'hauling' : 'pursing';
      },
      pursed: 1,
      get hauled() {
        return bagAnim.hauled;
      },
      bottomContact: 0,
      depth: 16,
      polygon: poly,
      gap: () => null,
      containsPoint: () => false,
    };
    return school;
  }

  // Debug: launch one jump right now from a school (or the nearest), e.g. to frame a close-up.
  function debugJump(schoolId) {
    const s = schoolId ? sim.schools.find((q) => q.id === schoolId) : sim.nearestSchool(ctx.camera.position.x, ctx.camera.position.z)?.school;
    if (!s) return null;
    s.nextJump = 0;
    const before = sim.jumps.length;
    const save = s.jumpRate;
    s.jumpRate = 1e6;
    sim.update(1e-4);
    s.jumpRate = save;
    return sim.jumps.length > before ? sim.jumps[sim.jumps.length - 1] : null;
  }

  const sys = {
    schools: sim.schools,
    nearestSchool: (x, z, maxDist = Infinity) => sim.nearestSchool(x, z, maxDist),
    schoolsWithin: (x, z, r) => sim.schoolsWithin(x, z, r),
    schoolsInside: (polygon) => sim.schoolsInside(polygon),
    harvest: () => sim.harvest(),
    sonarReturns: (x, z, range) => sim.sonarReturns(x, z, range ?? ctx.systems.economy?.modifiers?.sonarRange ?? 150),
    spawnSchool: (opts) => sim.spawnSchool(opts),
    get jumps() {
      return sim.jumps;
    },
    sim,
    debugBag,
    debugJump,
    get debugRender() {
      return renderer;
    },

    update(dt) {
      if (bagAnim && bagAnim.rate > 0 && dt > 0) bagAnim.hauled = Math.min(bagAnim.target, bagAnim.hauled + bagAnim.rate * dt);
      sim.update(dt);
    },

    debugState() {
      const by = {};
      for (const s of sim.schools) by[s.state] = (by[s.state] ?? 0) + 1;
      const f = world.focus();
      let catchable = 0;
      for (const s of sim.schools) if (sim.catchable(s, f.x, f.z)) catchable++;
      const tut = sim.schools.find((s) => s.tutorial);
      const near = sim.nearestSchool(f.x, f.z);
      return {
        schools: sim.schools.length,
        byState: by,
        catchableNear: catchable,
        nearest: near ? { id: near.school.id, species: near.school.species, state: near.school.state, count: near.school.count, distance: Math.round(near.distance) } : null,
        tutorial: tut ? { id: tut.id, state: tut.state, count: tut.count, distance: Math.round(Math.hypot(tut.position.x - f.x, tut.position.z - f.z)) } : null,
        jumpsActive: sim.jumps.length,
        net: sim.view.phase,
        stats: { ...sim.stats },
        render: renderer ? { ...renderer.stats } : 'none',
      };
    },

    serialize() {
      return undefined;
    },
    restore() {},
    reset() {
      netOverride = null;
      bagAnim = null;
      sim.reset();
      renderer?.reset();
    },
  };
  sys.speciesList = SPECIES;
  return sys;
}
