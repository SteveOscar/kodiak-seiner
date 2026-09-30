// School simulation (SPEC §6.10). DOM-free and renderer-free: everything it needs from the world comes through the
// `world` adapter (see createWorldAdapter in ../fish.js, and the fakes in tests/fish*.test.mjs):
//
//   shoreDistance(x, z), shoreGradient(x, z, out), depthAt(x, z), seabedAt(x, z), currentAt(x, z, out), tideState(),
//   day() (fractional game day), streams() [{id, x, z, species[], closedRadius}], speciesMix(x, z) | null,
//   isClosedWater(x, z), openerActive(x, z), focus() {x, z} (the seiner), inView(x, z) (camera frustum/terrain),
//   boats() [{x, z, speed, fx, fz, half}], net() (the documented net API or null), surfaceY(x, z), emit(name, payload)
//
// Schools are cheap agents (a centre, a radius, a depth, a mix of species) steered twice a second. Individual fish are
// only drawn near the camera by the renderer; jumps are choreographed here so that fish:jump events and the spotting
// mechanic work whether or not anything is rendered.

import * as THREE from 'three';
import {
  SPECIES,
  SCHOOL_SPECIES,
  emptyCatch,
  catchTotal,
  runIntensity,
  runMix,
  targetPopulation,
  homingUrge,
  weightedPick,
  schoolCount,
  headingOf,
  FISH_LENGTH,
} from './species.js';
import { createJump } from './jumps.js';
import {
  pointInPolygon,
  polygonArea,
  polygonCentroid,
  polygonBounds,
  nearestOnBoundary,
  findGapEdge,
  discInsideFraction,
  fitEllipse,
} from './geom.js';
import {
  leadlineEscapeRate,
  haulEscapeRate,
  encloseSchool,
  applyEscape,
  harvestCounts,
  isSmoothBottom,
  PURSED,
  GAP_LEAK,
  HOOK_COLLAPSE,
} from './netModel.js';

const LIVE = new Set(['migrating', 'milling', 'spooked', 'sounding', 'trapped']);
const FREE = new Set(['migrating', 'milling', 'spooked', 'sounding']);
const CATCHABLE = new Set(['migrating', 'milling', 'spooked']);

export const GUARANTEE = { count: 2, radius: 1500, minSpawn: 600, maxSpawn: 1450, minDepth: 8 };
// Spooked schools flee at up to FLEE_SPEED; no school swims faster than MAX_SWIM (config `speed.max` overrides).
export const FLEE_SPEED = 2.6;
export const MAX_SWIM = 2.8;
// Tutorial school: 380–420 m from the spawn (a quarter mile), in water ≥ net depth + margin within `clear` m.
export const TUTORIAL = { rMin: 380, rMax: 420, margin: 4, clear: 80, inletDepth: 8, inletCircle: 6 };
// Free-swimming schools cruise at least this deep (where the water allows) so they read as shadows under the surface;
// only the bag and jumpers come right up.
export const CRUISE_MIN_DEPTH = 1.8;
const WORLD_LIMIT = 7400;
const MAX_JUMPS = 90;

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function createFishSim({ config, rng, world }) {
  const fishCfg = config.fish;
  const specCfg = fishCfg.species;
  const runs = fishCfg.runs;
  const rSpawn = rng.fork('spawn');
  const rBehave = rng.fork('behave');
  const rJump = rng.fork('jump');

  const schools = [];
  const jumps = [];
  const newJumps = [];
  const stats = { spawned: 0, despawned: 0, jumps: 0, spooks: 0, escaped: 0, guaranteeSpawns: 0, enteredStreams: 0 };
  let now = 0;
  let nextId = 1;
  let jumpId = 1;
  let seeded = false;
  let maintT = 0;
  let guaranteeT = 0;
  let tide = { flow: 0, stage: 'slack', hoursToSlack: 1 };
  let slack = false;
  let session = null;
  const lastGuaranteeSpawns = [];

  const g = { x: 0, z: 0 };
  const cur = { x: 0, z: 0 };
  const nb = { x: 0, z: 0, edge: -1, d: 0, t: 0 };
  const escOut = emptyCatch();
  const view = {
    phase: 'none',
    state: 'stowed',
    poly: null,
    gap: null,
    gapEdge: -1,
    area: 0,
    centroid: { x: 0, z: 0 },
    bounds: { minX: 0, maxX: 0, minZ: 0, maxZ: 0 },
    ellipse: { x: 0, z: 0, angle: 0, a: 1, b: 1 },
    pursed: 0,
    hauled: 0,
    bottomContact: 0,
    depth: 16,
    hole: false,
    corksUnder: false,
    haulSpeed: 0,
  };
  let lastHauled = 0;

  // ---------------------------------------------------------------------------------------------------------------
  // Spawning

  function mixAt(x, z) {
    const day = world.day();
    const base = runMix(day, runs);
    const season = world.speciesMix?.(x, z);
    const w = {};
    for (const k of SCHOOL_SPECIES) {
      const s = season && Number.isFinite(season[k]) ? season[k] : null;
      // Season weights by place; the run calendar gates species that are not running at all.
      w[k] = s === null ? base[k] : base[k] > 0 ? s * (0.3 + 0.7 * base[k]) : 0;
    }
    const sum = SCHOOL_SPECIES.reduce((a, k) => a + w[k], 0);
    if (sum <= 1e-6) return base;
    return w;
  }

  function nearestStreamFor(species, x, z, maxDist = 9000) {
    let best = null;
    let bd = maxDist;
    for (const s of world.streams()) {
      if (species && s.species && !s.species.includes(species)) continue;
      const d = Math.hypot(s.x - x, s.z - z);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best;
  }

  function waterOk(x, z, { minDepth = 6, minShore = 60, avoidClosed = true } = {}) {
    if (Math.abs(x) > WORLD_LIMIT || Math.abs(z) > WORLD_LIMIT) return false;
    if (world.shoreDistance(x, z) < minShore) return false;
    if (world.depthAt(x, z) < minDepth) return false;
    if (avoidClosed && world.isClosedWater(x, z)) return false;
    return true;
  }

  // A point rMin..rMax from (cx, cz) in open water; outOfView prefers points the camera cannot see.
  function sampleNear(cx, cz, rMin, rMax, { minDepth = 8, outOfView = true, preferHeading = null, spread = Math.PI } = {}) {
    for (let pass = 0; pass < 2; pass++) {
      const tries = pass === 0 ? 56 : 28;
      for (let i = 0; i < tries; i++) {
        const a = preferHeading !== null && i < tries / 2 ? preferHeading + (rSpawn.next() * 2 - 1) * spread : rSpawn.next() * Math.PI * 2;
        const lo = pass === 0 ? rMin : lerp(rMin, rMax, 0.8);
        const r = Math.sqrt(lerp(lo * lo, rMax * rMax, rSpawn.next()));
        const x = cx + Math.sin(a) * r;
        const z = cz - Math.cos(a) * r;
        if (!waterOk(x, z, { minDepth, minShore: 60 })) continue;
        if (outOfView && pass === 0 && world.inView(x, z)) continue;
        return { x, z };
      }
    }
    return null;
  }

  // Anywhere along the coast within ~6.5 km of the seiner (farther schools would be culled straight away).
  function sampleCoastal() {
    const f = world.focus();
    for (let i = 0; i < 80; i++) {
      const x = clamp(f.x + (rSpawn.next() * 2 - 1) * 6500, -WORLD_LIMIT + 300, WORLD_LIMIT - 300);
      const z = clamp(f.z + (rSpawn.next() * 2 - 1) * 6500, -WORLD_LIMIT + 300, WORLD_LIMIT - 300);
      if (Math.hypot(x - f.x, z - f.z) > 7000) continue;
      const d = world.shoreDistance(x, z);
      if (d < 100 || d > 900) continue;
      if (!waterOk(x, z, { minDepth: 8, minShore: 100, avoidClosed: true })) continue;
      return { x, z };
    }
    return null;
  }

  function sampleNearStream() {
    const day = world.day();
    const streams = world.streams();
    if (!streams.length) return null;
    const w = {};
    streams.forEach((s, i) => {
      let v = 0.1;
      for (const k of s.species ?? []) v += runIntensity(day, runs[k]);
      w[i] = v;
    });
    const idx = weightedPick(w, rSpawn.next());
    const s = streams[Number(idx)];
    if (!s) return null;
    const f = world.focus();
    if (Math.hypot(s.x - f.x, s.z - f.z) > 9000) return null;
    for (let i = 0; i < 12; i++) {
      const a = rSpawn.next() * Math.PI * 2;
      const r = lerp(700, 3800, rSpawn.next());
      const p = world.nearestWater?.(s.x + Math.sin(a) * r, s.z - Math.cos(a) * r, 140);
      if (p && waterOk(p.x, p.z, { minDepth: 8, minShore: 100 })) return { ...p, stream: s };
    }
    return null;
  }

  function pickSpecies(x, z, stream) {
    const w = mixAt(x, z);
    if (stream?.species) for (const k of stream.species) if (w[k] !== undefined) w[k] *= 2;
    return weightedPick(w, rSpawn.next()) ?? 'pink';
  }

  function schoolRadius(sp, count) {
    const [rl, rh] = sp.radius ?? [10, 25];
    const [cl, ch] = sp.count ?? [300, 5000];
    const t = clamp(Math.log(Math.max(1, count) / cl) / Math.log(Math.max(ch / cl, 1.0001)), 0, 1);
    return lerp(rl, rh, t) * (0.9 + 0.2 * rSpawn.next());
  }

  // Creates a school. Public through spawnSchool().
  function makeSchool({
    x,
    z,
    species = 'pink',
    count,
    milling = false,
    jumpRateMul = 1,
    spookable = true,
    tutorial = false,
    targetStream,
    radius,
    depth,
    mix,
    pureMix = false,
  }) {
    const sp = specCfg[species] ?? specCfg.pink;
    const day = world.day();
    const strength = Math.max(0.3, runIntensity(day, runs[species]));
    const n = Math.max(1, Math.round(count ?? schoolCount(sp, rSpawn, strength)));
    const m = emptyCatch();
    if (mix) for (const k of SPECIES) m[k] = Math.max(0, Math.round(mix[k] ?? 0));
    else {
      m[species] = n;
      // Mixed-stock schools: a few percent of another species now and then; kings are rare bycatch.
      if (!pureMix && rSpawn.next() < 0.3) {
        const other = SCHOOL_SPECIES.filter((k) => k !== species && runIntensity(day, runs[k]) > 0);
        if (other.length) {
          const o = other[Math.floor(rSpawn.next() * other.length)];
          const extra = Math.round(n * lerp(0.02, 0.08, rSpawn.next()));
          m[o] += extra;
        }
      }
      const king = specCfg.king;
      if (!pureMix && king && rSpawn.next() < (king.bycatchChance ?? 0.15)) m.king = 1 + Math.floor(rSpawn.next() * (king.count?.[1] ?? 3));
    }
    const total = catchTotal(m);
    const d0 = depth ?? Math.max(CRUISE_MIN_DEPTH, lerp(sp.depth?.[0] ?? 1, sp.depth?.[1] ?? 4, rSpawn.next()));
    const wd = world.depthAt(x, z);
    const d = clamp(d0, 0.6, Math.max(0.6, wd - 1));
    const jpm = sp.jumpsPerMin ? lerp(sp.jumpsPerMin[0], sp.jumpsPerMin[1], rSpawn.next()) : 1;
    const stream = targetStream === undefined ? nearestStreamFor(species, x, z) : targetStream;
    const h0 = rSpawn.next() * Math.PI * 2;
    const s = {
      id: `S${nextId++}`,
      species,
      mix: m,
      count: total,
      position: new THREE.Vector3(x, -d, z),
      velocity: new THREE.Vector3(Math.sin(h0) * 0.2, 0, -Math.cos(h0) * 0.2),
      radius: radius ?? schoolRadius(sp, total),
      depth: d,
      state: milling ? 'milling' : 'migrating',
      targetStream: stream?.id ?? null,
      jumpRate: jpm * jumpRateMul,
      // Extras (not part of the documented surface; stable for the renderer and debugging).
      heading: h0,
      age: 0,
      baseDepth: d0,
      spookable,
      tutorial,
      spooks: 0,
      lastSpook: -1e9,
      stateUntil: 0,
      millX: x,
      millZ: z,
      millUntil: milling ? (tutorial ? Infinity : now + lerp(90, 300, rSpawn.next())) : 0,
      millCooldown: 0,
      millDir: rSpawn.next() < 0.5 ? -1 : 1,
      millPhase: rSpawn.next() * Math.PI * 2,
      band: lerp(90, 340, rSpawn.next()),
      homing: homingUrge(day, runs[species]),
      fleeX: 0,
      fleeZ: 0,
      steerT: rSpawn.next() * 0.5,
      featureT: rSpawn.next() * 4,
      nextJump: -Math.log(1 - rSpawn.next() * 0.999),
      desiredX: 0,
      desiredZ: 0,
      speed: 0,
      net: null,
      netInside: false,
      captured: false,
      capturedAt: 0,
      capturedCount: 0,
      maxAge: lerp(1500, 2700, rSpawn.next()),
      // Late-season pink males develop a hump; the renderer applies it to about half of the fish.
      hump: species === 'pink' ? clamp((day - 16) / 22, 0, 1) * 0.85 : 0,
    };
    schools.push(s);
    stats.spawned++;
    return s;
  }

  function spawnRunSchool({ near = false, rMin = 1500, rMax = 5000, outOfView = true } = {}) {
    const f = world.focus();
    let p = null;
    let stream = null;
    if (near) p = sampleNear(f.x, f.z, rMin, rMax, { minDepth: 8, outOfView });
    else {
      const ps = rSpawn.next() < 0.6 ? sampleNearStream() : null;
      if (ps) {
        p = ps;
        stream = ps.stream;
      } else p = sampleCoastal();
      if (p && Math.hypot(p.x - f.x, p.z - f.z) < 3000 && world.inView(p.x, p.z)) p = null;
    }
    if (!p) return null;
    const species = pickSpecies(p.x, p.z, stream);
    const ts = stream && stream.species?.includes(species) ? stream : undefined;
    return makeSchool({ x: p.x, z: p.z, species, milling: rSpawn.next() < 0.3, targetStream: ts });
  }

  function seed() {
    seeded = true;
    const target = targetPopulation(world.day(), runs);
    let guard = 0;
    while (liveCount() < target && guard++ < target * 4) {
      const near = liveCount() < target * 0.45;
      spawnRunSchool(near ? { near: true, rMin: 1600, rMax: 5200, outOfView: true } : {});
    }
  }

  function liveCount() {
    let n = 0;
    for (const s of schools) if (FREE.has(s.state) && !s.tutorial) n++;
    return n;
  }

  // Shallowest water within `R` of (x, z) (centre plus two rings of 16), i.e. how deep the whole set circle is.
  function minDepthAround(x, z, R) {
    let m = world.depthAt(x, z);
    for (const r of [R * 0.5, R]) {
      for (let i = 0; i < 16 && m > 0; i++) {
        const a = (i / 16) * Math.PI * 2;
        m = Math.min(m, world.depthAt(x + Math.cos(a) * r, z + Math.sin(a) * r));
      }
    }
    return m;
  }

  // The tutorial school sits a quarter mile (~400 m, Pete's radio line) from the spawn in water deep enough that the
  // first circle of the base seine does not touch bottom: ≥ net depth + 4 m everywhere within TUTORIAL.clear m.
  function tutorialSpot(x, z, heading) {
    const need = (world.netDepth?.() ?? config.net?.depth ?? 16) + TUTORIAL.margin;
    const cands = [];
    const scan = (rMin, rMax) => {
      for (let r = rMin; r <= rMax + 1e-6; r += 10) {
        for (let deg = 0; deg < 360; deg += 3) {
          const a = (deg * Math.PI) / 180;
          const px = x + Math.sin(a) * r;
          const pz = z - Math.cos(a) * r;
          if (world.depthAt(px, pz) < need || !waterOk(px, pz, { minDepth: need, minShore: 100 })) continue;
          const m = minDepthAround(px, pz, TUTORIAL.clear);
          const off = heading === null ? 0 : Math.abs(((a - heading + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
          cands.push({ x: px, z: pz, m, r, off });
        }
      }
    };
    scan(TUTORIAL.rMin, TUTORIAL.rMax);
    let ok = cands.filter((c) => c.m >= need);
    if (!ok.length) {
      // Nothing clean at a quarter mile: the nearest clean water farther out.
      scan(TUTORIAL.rMax + 10, 700);
      ok = cands.filter((c) => c.m >= need).sort((p, q) => p.r - q.r);
      if (ok.length) ok = ok.filter((c) => c.r <= ok[0].r + 20);
      else {
        // Narrow inlets (Port Lions): shallower than the seine is fine as long as the whole first circle stays
        // navigable, so the set never runs the seiner aground. Else the deepest spot found.
        const navigable = [];
        for (let r = TUTORIAL.rMin; r <= 900; r += 10) {
          for (let deg = 0; deg < 360; deg += 3) {
            const a = (deg * Math.PI) / 180;
            const px = x + Math.sin(a) * r;
            const pz = z - Math.cos(a) * r;
            if (world.depthAt(px, pz) < TUTORIAL.inletDepth || !waterOk(px, pz, { minDepth: TUTORIAL.inletDepth, minShore: 60 })) continue;
            const m = minDepthAround(px, pz, TUTORIAL.clear);
            if (m < TUTORIAL.inletCircle) continue;
            const off = heading === null ? 0 : Math.abs(((a - heading + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
            navigable.push({ x: px, z: pz, m, r, off });
          }
        }
        navigable.sort((p, q) => p.r - q.r);
        ok = navigable.length ? navigable.filter((c) => c.r <= navigable[0].r + 40) : cands.sort((p, q) => q.m - p.m).slice(0, 1);
      }
    }
    if (!ok.length) return null;
    // Most margin first, then closest to the bow; a little variety among near-equal spots.
    ok.sort((p, q) => q.m - p.m || p.off - q.off);
    const top = ok.filter((c) => c.m >= ok[0].m - 1).sort((p, q) => p.off - q.off);
    return top[Math.floor(rSpawn.next() * Math.min(3, top.length))];
  }

  function spawnTutorial(x, z, heading = null) {
    for (const s of schools) if (s.tutorial && s.state !== 'captured') s.state = 'gone';
    let p = tutorialSpot(x, z, heading);
    if (!p) p = sampleNear(x, z, 380, 700, { minDepth: 8, outOfView: false, preferHeading: heading, spread: 1.0 });
    if (!p) p = world.nearestWater?.(x + 400, z, 80) ?? { x: x + 400, z };
    const sp = specCfg.pink;
    const s = makeSchool({
      x: p.x,
      z: p.z,
      species: 'pink',
      count: Math.round(lerp(4200, 6000, rSpawn.next())),
      milling: true,
      jumpRateMul: 3,
      spookable: false,
      tutorial: true,
      mix: { pink: Math.round(lerp(4200, 6000, rSpawn.next())), chum: 0, sockeye: 0, coho: 0, king: 0 },
    });
    s.radius = lerp(sp.radius?.[0] ?? 10, sp.radius?.[1] ?? 30, 0.55);
    s.millUntil = Infinity;
    s.maxAge = Infinity;
    return s;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Behaviour

  function nearSlack() {
    const period = world.tidePeriod?.() ?? 12.42;
    const toSlack = tide.hoursToSlack ?? 1;
    const sinceSlack = period / 2 - toSlack;
    return toSlack < 0.5 || sinceSlack < 0.5;
  }

  function soundsAfter(species) {
    const v = specCfg[species]?.soundsAfterSpooks;
    if (Number.isFinite(v)) return v;
    return species === 'sockeye' ? 2 : Infinity;
  }

  function spook(s, fromX, fromZ, reason = 'boat') {
    if (!s.spookable || !LIVE.has(s.state) || s.state === 'trapped') return false;
    if (now - s.lastSpook < 3) return false;
    s.spooks++;
    s.lastSpook = now;
    let fx = s.position.x - fromX;
    let fz = s.position.z - fromZ;
    const l = Math.hypot(fx, fz) || 1;
    fx /= l;
    fz /= l;
    s.fleeX = fx;
    s.fleeZ = fz;
    if (s.spooks >= soundsAfter(s.species)) {
      s.state = 'sounding';
      s.stateUntil = now + lerp(60, 150, rBehave.next());
      if (s.net) s.net.sounded = true;
    } else {
      s.state = 'spooked';
      s.stateUntil = now + lerp(14, 28, rBehave.next());
    }
    stats.spooks++;
    world.emit('fish:spooked', { schoolId: s.id, x: s.position.x, z: s.position.z, reason });
    return true;
  }

  // Distance from the school centre to a boat's hull (a segment along its heading).
  function hullDistance(s, b) {
    const half = b.half ?? 5;
    const ax = b.x - b.fx * half;
    const az = b.z - b.fz * half;
    const dx = b.fx * 2 * half;
    const dz = b.fz * 2 * half;
    const len2 = dx * dx + dz * dz || 1;
    const t = clamp(((s.position.x - ax) * dx + (s.position.z - az) * dz) / len2, 0, 1);
    return Math.hypot(s.position.x - (ax + dx * t), s.position.z - (az + dz * t));
  }

  function checkBoats(s, boats) {
    if (!s.spookable || !FREE.has(s.state)) return;
    for (const b of boats) {
      const cx = s.position.x - b.x;
      const cz = s.position.z - b.z;
      if (cx * cx + cz * cz > (s.radius + 80) ** 2) continue;
      const d = hullDistance(s, b);
      const speed = Math.abs(b.speed ?? 0);
      // Fast boats within 40 m of the school; any hull crossing the school faster than 2 m/s. Paying out at ≤ 7 m/s
      // outside the school radius therefore never spooks.
      if ((speed > 8 && d - s.radius < 40) || (speed > 2 && d < s.radius)) {
        spook(s, b.x, b.z, 'boat');
        return;
      }
    }
  }

  function featureCheck(s) {
    // Mill off points and at bay heads: enclosure (land in many directions) marks a bay head; a sharp turn of the
    // shore normal ahead with open water around marks a point.
    const x = s.position.x;
    const z = s.position.z;
    let land = 0;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      if (world.depthAt(x + Math.cos(a) * 350, z + Math.sin(a) * 350) <= 0) land++;
    }
    const sd = world.shoreDistance(x, z);
    world.shoreGradient(x, z, g);
    const g0x = g.x;
    const g0z = g.z;
    const sp = Math.hypot(s.velocity.x, s.velocity.z) || 1;
    world.shoreGradient(x + (s.velocity.x / sp) * 220, z + (s.velocity.z / sp) * 220, g);
    const turn = Math.acos(clamp(g0x * g.x + g0z * g.z, -1, 1));
    const bayHead = land >= 5 && sd < 450;
    const point = land <= 3 && sd < 320 && turn > 0.7;
    return { bayHead, point };
  }

  function startMill(s, secs, x = s.position.x, z = s.position.z) {
    s.state = 'milling';
    s.millX = x;
    s.millZ = z;
    s.millUntil = now + secs;
  }

  function steer(s) {
    const sp = specCfg[s.species] ?? specCfg.pink;
    const speeds = sp.speed ?? { migrating: 0.9, milling: 0.3 };
    const x = s.position.x;
    const z = s.position.z;
    let dx = 0;
    let dz = 0;
    let speed = speeds.migrating;
    if (s.state === 'milling' || s.state === 'trapped') {
      const ro = Math.max(4, s.radius * 0.35);
      s.millPhase += (s.millDir * speeds.milling) / ro * 0.5;
      const tx = s.millX + Math.cos(s.millPhase) * ro;
      const tz = s.millZ + Math.sin(s.millPhase) * ro;
      dx = tx - x;
      dz = tz - z;
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
      speed = speeds.milling * clamp(l / 3, 0.4, 2.5);
    } else if (s.state === 'spooked') {
      const l = Math.hypot(s.fleeX, s.fleeZ);
      if (l > 1e-6) {
        dx = s.fleeX / l;
        dz = s.fleeZ / l;
      }
      const k = clamp((s.stateUntil - now) / 20, 0, 1);
      speed = lerp(speeds.migrating, FLEE_SPEED, k);
    } else {
      // Migrating (and sounding, slowly): along the shore with the flood, keeping to an offshore band, homing late.
      world.shoreGradient(x, z, g);
      const sd = world.shoreDistance(x, z);
      const tfx = -g.z;
      const tfz = g.x;
      const flow = tide.flow ?? 0;
      const along = flow > 0 ? 0.35 + 0.65 * flow : 0.25 * (1 + flow) + 0.1;
      let sign = 1;
      let hx = 0;
      let hz = 0;
      const stream = s.targetStream ? world.streams().find((q) => q.id === s.targetStream) : null;
      if (stream) {
        const sx = stream.x - x;
        const sz = stream.z - z;
        const D = Math.hypot(sx, sz) || 1;
        if (s.homing > 0.45 && tfx * sx + tfz * sz < 0) sign = -1;
        const w = D < 1400 ? 1.2 * s.homing : 0;
        hx = (sx / D) * w;
        hz = (sz / D) * w;
      }
      const off = clamp((s.band - sd) / 150, -1, 1) * 0.75;
      dx = tfx * sign * along + g.x * off + hx;
      dz = tfz * sign * along + g.z * off + hz;
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
      speed = speeds.migrating * (0.55 + 0.45 * along) * (s.state === 'sounding' ? 0.5 : 1);
    }
    speed = Math.min(speed, maxSwim(s));
    s.desiredX = dx * speed;
    s.desiredZ = dz * speed;
  }

  function maxSwim(s) {
    const m = specCfg[s.species]?.speed?.max;
    return Number.isFinite(m) && m > 0 ? m : MAX_SWIM;
  }

  function stateTransitions(s) {
    if (s.state === 'spooked' && now > s.stateUntil) s.state = s.net ? 'milling' : 'migrating';
    else if (s.state === 'sounding' && now > s.stateUntil) s.state = 'migrating';
    else if (s.state === 'milling' && !s.tutorial && !s.inHook && now > s.millUntil && !slack) {
      s.state = 'migrating';
      s.millCooldown = now + 120;
      maybeEnterStream(s);
    } else if (s.state === 'migrating' && !s.net) {
      if (slack && now > s.millCooldown) startMill(s, lerp(40, 110, rBehave.next()));
      const stream = s.targetStream ? world.streams().find((q) => q.id === s.targetStream) : null;
      if (stream && s.state === 'migrating') {
        const D = Math.hypot(stream.x - s.position.x, stream.z - s.position.z);
        if (D < (stream.closedRadius ?? 250) + 320 && s.homing > 0.35 && now > s.millCooldown) {
          startMill(s, lerp(120, 320, rBehave.next()));
          s.stackedAt = stream.id;
        }
      }
    }
  }

  function maybeEnterStream(s) {
    if (!s.stackedAt || s.tutorial) return;
    if (rBehave.next() < s.homing * 0.8) {
      s.state = 'gone';
      stats.enteredStreams++;
    }
  }

  function integrate(s, dt) {
    const turn = Math.min(1, dt * (s.state === 'spooked' ? 2.5 : 0.8));
    s.velocity.x += (s.desiredX - s.velocity.x) * turn;
    s.velocity.z += (s.desiredZ - s.velocity.z) * turn;
    const vmax = maxSwim(s);
    const v2 = s.velocity.x * s.velocity.x + s.velocity.z * s.velocity.z;
    if (v2 > vmax * vmax) {
      const k = vmax / Math.sqrt(v2);
      s.velocity.x *= k;
      s.velocity.z *= k;
    }
    world.currentAt(s.position.x, s.position.z, cur);
    const drift = s.state === 'trapped' ? 0 : 0.5;
    let nx = s.position.x + (s.velocity.x + cur.x * drift) * dt;
    let nz = s.position.z + (s.velocity.z + cur.z * drift) * dt;
    if (s.state === 'milling' && !s.tutorial && !s.inHook) {
      s.millX += cur.x * 0.25 * dt;
      s.millZ += cur.z * 0.25 * dt;
    }
    // Keep off the beach and inside the world.
    const minD = Math.max(22, s.radius + 8);
    const sd = world.shoreDistance(nx, nz);
    if (sd < minD || world.depthAt(nx, nz) < 2) {
      world.shoreGradient(nx, nz, g);
      const push = (minD - sd) * Math.min(1, dt * 1.5) + 0.05;
      nx += g.x * push;
      nz += g.z * push;
      const vin = s.velocity.x * g.x + s.velocity.z * g.z;
      if (vin < 0) {
        s.velocity.x -= g.x * vin * 1.2;
        s.velocity.z -= g.z * vin * 1.2;
      }
      if (world.depthAt(nx, nz) < 0.5) {
        nx = s.position.x;
        nz = s.position.z;
      }
      if (s.state === 'milling' && !s.net) {
        s.millX += g.x * push;
        s.millZ += g.z * push;
      }
    }
    if (Math.abs(nx) > WORLD_LIMIT) {
      nx = Math.sign(nx) * WORLD_LIMIT;
      s.velocity.x *= -0.5;
    }
    if (Math.abs(nz) > WORLD_LIMIT) {
      nz = Math.sign(nz) * WORLD_LIMIT;
      s.velocity.z *= -0.5;
    }
    s.position.x = nx;
    s.position.z = nz;
    const sp2 = s.velocity.x * s.velocity.x + s.velocity.z * s.velocity.z;
    if (sp2 > 1e-4) s.heading = headingOf(s.velocity.x, s.velocity.z);
    // Depth.
    const wd = world.depthAt(nx, nz);
    let target = s.baseDepth;
    if (s.state === 'sounding') target = Math.max(14, 18 + 6 * Math.sin(s.millPhase));
    else if (s.state === 'spooked') target = s.baseDepth + 1.5;
    else if (s.state === 'milling') target = s.baseDepth * 0.85;
    if (!s.net && !s.bag) target = Math.max(target, CRUISE_MIN_DEPTH);
    if (s.net && view.phase !== 'none') target = Math.min(target, Math.max(0.5, view.depth * 0.8));
    if (s.bag) target = s.bagDepth;
    target = clamp(target, 0.45, Math.max(0.45, wd - 0.8));
    s.depth += (target - s.depth) * Math.min(1, dt * (s.state === 'sounding' ? 0.5 : 0.3) + (s.bag ? dt * 2 : 0));
    s.position.y = -s.depth;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Net

  function readNet(dt) {
    const net = world.net();
    const st = net?.state;
    view.state = st ?? 'stowed';
    let phase = 'none';
    if (st === 'paying' || st === 'out') phase = 'open';
    else if (st === 'closed') phase = 'closed';
    else if (st === 'pursing') phase = (net.pursed ?? 0) >= PURSED ? 'pursed' : 'closed';
    else if (st === 'hauling' || st === 'brailing') {
      // fishing.abort() hauls back whatever is in the water under the same state: only a closed, pursed net holds
      // fish. A never-closed (open) net releases them; a closed but unpursed one keeps leaking under the leadline.
      const closed = net.closed ?? session?.closed ?? (net.pursed ?? 1) >= PURSED;
      if (!closed) phase = 'none';
      else phase = (net.pursed ?? 1) >= PURSED ? 'pursed' : 'closed';
    }
    let poly = null;
    if (phase !== 'none') {
      try {
        poly = net.polygon?.() ?? null;
      } catch {
        poly = null;
      }
      if (!poly || poly.length < 3) {
        if (phase === 'pursed' && view.poly) poly = view.poly;
        else phase = 'none';
      }
    }
    view.phase = phase;
    if (phase === 'none') {
      view.poly = null;
      return;
    }
    view.poly = poly;
    view.pursed = clamp(net.pursed ?? (phase === 'pursed' ? 1 : 0), 0, 1);
    view.hauled = clamp(net.hauled ?? 0, 0, 1);
    view.bottomContact = clamp(net.bottomContact ?? 0, 0, 1);
    view.depth = net.depth ?? 16;
    view.hole = !!(net.hole ?? net.holeOpen ?? net.torn ?? false);
    view.corksUnder = !!(net.corksUnder ?? false);
    view.haulSpeed = dt > 0 ? Math.max(0, (view.hauled - lastHauled) / dt) : 0;
    lastHauled = view.hauled;
    view.gap = phase === 'open' ? net.gap?.() ?? null : null;
    view.gapEdge = view.gap ? findGapEdge(poly, view.gap) : -1;
    view.area = polygonArea(poly);
    polygonCentroid(poly, view.centroid);
    polygonBounds(poly, view.bounds);
    fitEllipse(poly, view.ellipse);
  }

  function near(s, pad) {
    const b = view.bounds;
    const x = s.position.x;
    const z = s.position.z;
    return x > b.minX - pad && x < b.maxX + pad && z > b.minZ - pad && z < b.maxZ + pad;
  }

  function flushEscapes(s, force = false) {
    const r = s.net;
    if (!r) return;
    if (!force && now - (r.lastFlush ?? 0) < 0.5) return;
    r.lastFlush = now;
    for (const k of SPECIES) {
      const n = Math.floor(r.pending?.[k] ?? 0);
      if (n >= 1) {
        r.pending[k] -= n;
        stats.escaped += n;
        world.emit('fishing:escape', { count: n, species: k, schoolId: s.id });
      }
    }
  }

  function syncMixFromNet(s) {
    const r = s.net;
    for (const k of SPECIES) s.mix[k] = Math.max(0, Math.round(r.live[k]));
    s.count = catchTotal(s.mix);
  }

  function addPending(s, esc) {
    const r = s.net;
    r.pending ??= emptyCatch();
    for (const k of SPECIES) r.pending[k] += esc[k];
  }

  function sessionUpdate() {
    if (view.phase === 'none') {
      if (session) endSession();
      return;
    }
    if (!session) session = { start: now, bestArea: 0, closed: false };
    if (view.phase === 'open') session.bestArea = Math.max(session.bestArea, view.area);
    if (!session.closed && (view.phase === 'closed' || view.phase === 'pursed')) {
      session.closed = true;
      closeUp();
    }
  }

  // The ends have met: bookkeeping of what is inside.
  function closeUp() {
    const poly = view.poly;
    for (const s of [...schools]) {
      if (!FREE.has(s.state) || s.net) continue;
      if (!near(s, s.radius)) continue;
      const phi = discInsideFraction(s.position.x, s.position.z, s.radius, poly);
      if (phi < 0.04) continue;
      if (phi < 0.96) {
        // The part outside the corkline carries on as its own school.
        const outside = emptyCatch();
        for (const k of SPECIES) outside[k] = Math.round((s.mix[k] ?? 0) * (1 - phi));
        if (catchTotal(outside) > 20) {
          const o = nearestOnBoundary(s.position.x, s.position.z, poly, -1, nb);
          let ox = s.position.x - view.centroid.x;
          let oz = s.position.z - view.centroid.z;
          const l = Math.hypot(ox, oz) || 1;
          ox /= l;
          oz /= l;
          const sib = makeSchool({
            x: o.x + ox * (s.radius * 0.6 + 6),
            z: o.z + oz * (s.radius * 0.6 + 6),
            species: s.species,
            mix: outside,
            spookable: s.spookable,
            targetStream: null,
            radius: Math.max(6, s.radius * Math.sqrt(1 - phi)),
            depth: s.depth,
          });
          sib.targetStream = s.targetStream;
          sib.state = 'spooked';
          sib.fleeX = ox;
          sib.fleeZ = oz;
          sib.stateUntil = now + 12;
        }
      }
      s.net = encloseSchool(s.mix, phi, rBehave, { spooked: s.state === 'spooked' });
      s.net.sounded = s.state === 'sounding';
      s.radius = Math.max(5, s.radius * Math.sqrt(Math.max(phi, 0.2)));
      // The fringe boils out as the ends come together.
      const fringe = emptyCatch();
      for (const k of SPECIES) fringe[k] = s.net.enclosed[k] - s.net.live[k];
      addPending(s, fringe);
      syncMixFromNet(s);
      if (s.state !== 'sounding') s.state = 'milling';
      s.millX = view.centroid.x;
      s.millZ = view.centroid.z;
      s.millUntil = Infinity;
    }
  }

  function endSession() {
    for (const s of schools) {
      if (!s.net) continue;
      if (s.captured) {
        s.state = 'gone';
        continue;
      }
      // Net stowed without brailing (abort / water haul): whatever was inside swims off.
      flushEscapes(s, true);
      if (s.count > 0) {
        world.emit('fishing:escape', { count: s.count, species: s.species, schoolId: s.id, released: true });
        stats.escaped += s.count;
      }
      s.net = null;
      s.bag = false;
      s.inHook = false;
      s.state = 'spooked';
      s.stateUntil = now + 15;
      const a = rBehave.next() * Math.PI * 2;
      s.fleeX = Math.cos(a);
      s.fleeZ = Math.sin(a);
      s.millUntil = 0;
    }
    session = null;
  }

  function netInteract(s, dt) {
    const poly = view.poly;
    if (!poly) return;
    if (s.net) return inNet(s, dt);
    if (!FREE.has(s.state)) return;
    if (!near(s, s.radius + 30) || (s.state === 'sounding' && s.depth > view.depth)) {
      s.netInside = false;
      s.inHook = false;
      return;
    }
    const x = s.position.x;
    const z = s.position.z;
    const inside = pointInPolygon(x, z, poly);
    const skip = view.phase === 'open' ? view.gapEdge : -1;
    // Crossing the boundary: through the gap is allowed (in or out); through the web is not.
    if (inside !== s.netInside && s.netTracked) {
      nearestOnBoundary(x, z, poly, -1, nb);
      const viaGap = nb.edge === skip && skip >= 0;
      if (!viaGap) {
        nearestOnBoundary(x, z, poly, skip, nb);
        let nx = s.prevX - nb.x;
        let nz = s.prevZ - nb.z;
        const l = Math.hypot(nx, nz) || 1;
        nx /= l;
        nz /= l;
        s.position.x = nb.x + nx * 1.5;
        s.position.z = nb.z + nz * 1.5;
        const vn = s.velocity.x * nx + s.velocity.z * nz;
        if (vn < 0) {
          s.velocity.x -= nx * vn;
          s.velocity.z -= nz * vn;
        }
      } else if (!inside && s.inHook) {
        // Ran out through the gap.
        world.emit('fishing:escape', { count: s.count, species: s.species, schoolId: s.id, viaGap: true });
        stats.escaped += s.count;
        s.inHook = false;
        s.state = 'spooked';
        s.stateUntil = now + 10;
        // Away from the middle of the set, out through the gap (a unit vector: steer() scales it by the flee speed).
        const ox = x - view.centroid.x;
        const oz = z - view.centroid.z;
        const ol = Math.hypot(ox, oz);
        if (ol > 1e-6) {
          s.fleeX = ox / ol;
          s.fleeZ = oz / ol;
        } else {
          const gx = (view.gap.a.x + view.gap.b.x) / 2 - view.centroid.x;
          const gz = (view.gap.a.z + view.gap.b.z) / 2 - view.centroid.z;
          const gl = Math.hypot(gx, gz) || 1;
          s.fleeX = gx / gl;
          s.fleeZ = gz / gl;
        }
      }
    }
    const nowInside = pointInPolygon(s.position.x, s.position.z, poly);
    s.netInside = nowInside;
    s.netTracked = true;
    // Meeting the web: slide along it.
    nearestOnBoundary(s.position.x, s.position.z, poly, skip, nb);
    const touch = Math.max(4, s.radius * 0.45);
    if (nb.d < touch) {
      const a = poly[nb.edge];
      const b = poly[(nb.edge + 1) % poly.length];
      let tx = b.x - a.x;
      let tz = b.z - a.z;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      let nx = s.position.x - nb.x;
      let nz = s.position.z - nb.z;
      const nl = Math.hypot(nx, nz) || 1;
      nx /= nl;
      nz /= nl;
      const vn = s.velocity.x * nx + s.velocity.z * nz;
      if (vn < 0) {
        const vt = s.velocity.x * tx + s.velocity.z * tz;
        const sp = Math.hypot(s.velocity.x, s.velocity.z);
        const sgn = vt >= 0 ? 1 : -1;
        s.velocity.x = tx * sgn * sp;
        s.velocity.z = tz * sgn * sp;
        s.desiredX = s.velocity.x;
        s.desiredZ = s.velocity.z;
      }
    }
    // In an open hook: mill in the bight, or run for the gap when close to it (or spooked).
    if (view.phase === 'open' && nowInside && view.gap) {
      const gx = (view.gap.a.x + view.gap.b.x) / 2;
      const gz = (view.gap.a.z + view.gap.b.z) / 2;
      const gw = view.gap.width ?? Math.hypot(view.gap.b.x - view.gap.a.x, view.gap.b.z - view.gap.a.z);
      const dGap = Math.hypot(s.position.x - gx, s.position.z - gz);
      s.inHook = true;
      const runFor = s.state === 'spooked' || (dGap < Math.max(28, gw * 0.55) && gw > 6 && !s.tutorial);
      if (runFor) {
        const l = dGap || 1;
        s.state = 'spooked';
        s.stateUntil = Math.max(s.stateUntil, now + 4);
        s.fleeX = (gx - s.position.x) / l;
        s.fleeZ = (gz - s.position.z) / l;
      } else {
        if (s.state !== 'milling' && s.state !== 'sounding') s.state = 'milling';
        // The bight: the centroid pushed away from the gap.
        s.millX = view.centroid.x + (view.centroid.x - gx) * 0.25;
        s.millZ = view.centroid.z + (view.centroid.z - gz) * 0.25;
        s.millUntil = now + 30;
        const collapsed = session && view.area < HOOK_COLLAPSE * session.bestArea;
        const lam = GAP_LEAK * (collapsed ? 3 : 1);
        const leave = s.count * (1 - Math.exp(-lam * dt));
        s.leak = (s.leak ?? 0) + leave;
        if (s.leak >= 1) {
          const n = Math.floor(s.leak);
          s.leak -= n;
          const scale = Math.max(0, 1 - n / Math.max(1, s.count));
          for (const k of SPECIES) s.mix[k] = Math.round(s.mix[k] * scale);
          s.count = catchTotal(s.mix);
          s.leakPending = (s.leakPending ?? 0) + n;
        }
        if ((s.leakPending ?? 0) > 0 && now - (s.leakFlush ?? 0) > 1) {
          world.emit('fishing:escape', { count: s.leakPending, species: s.species, schoolId: s.id, viaGap: true });
          stats.escaped += s.leakPending;
          s.leakPending = 0;
          s.leakFlush = now;
        }
      }
    } else if (!nowInside) {
      s.inHook = false;
    }
  }

  function inNet(s, dt) {
    const r = s.net;
    const poly = view.poly;
    // Keep inside and circle the middle of the enclosed water.
    if (!pointInPolygon(s.position.x, s.position.z, poly)) {
      s.position.x += (view.centroid.x - s.position.x) * Math.min(1, dt * 1.5);
      s.position.z += (view.centroid.z - s.position.z) * Math.min(1, dt * 1.5);
    }
    s.millX = view.centroid.x;
    s.millZ = view.centroid.z;
    const eqR = Math.sqrt(view.area / Math.PI);
    s.radius = Math.max(2.5, Math.min(s.radius, eqR * 0.8));
    const sb = world.seabedAt?.(s.position.x, s.position.z) ?? 'sand';
    const smooth = isSmoothBottom(sb);
    const sounding = s.state === 'sounding' || r.sounded;
    if (view.phase === 'closed') {
      applyEscape(
        r,
        dt,
        (k) =>
          leadlineEscapeRate({
            pursed: view.pursed,
            leadlineEscape: specCfg[k]?.leadlineEscape ?? 1,
            bottomContact: view.bottomContact,
            smoothBottom: smooth,
            hole: view.hole,
            fishDepth: sounding ? Math.max(view.depth * 1.2, s.depth) : s.depth,
            netDepth: view.depth,
            sounding,
          }),
        escOut,
      );
      addPending(s, escOut);
    } else if (view.phase === 'pursed') {
      if (!r.trapped) {
        r.trapped = true;
        if (s.state !== 'captured') s.state = 'trapped';
      }
      const current = Math.hypot(cur.x, cur.z);
      applyEscape(
        r,
        dt,
        (k) => {
          const L = specCfg[k]?.leadlineEscape ?? 1;
          let lam = haulEscapeRate({ hauled: view.hauled, haulSpeed: view.haulSpeed, current, corksUnder: view.corksUnder, leadlineEscape: L });
          if (view.hole && view.hauled < 0.6) lam += leadlineEscapeRate({ pursed: 1, hole: true, leadlineEscape: L });
          return lam;
        },
        escOut,
      );
      addPending(s, escOut);
      // The bag: fish crowd into the shrinking net beside the seiner.
      const el = view.ellipse;
      s.bag = view.state === 'hauling' || view.state === 'brailing' || view.hauled > 0;
      s.position.x += (el.x - s.position.x) * Math.min(1, dt * 2);
      s.position.z += (el.z - s.position.z) * Math.min(1, dt * 2);
      s.bagDepth = Math.max(0.35, view.depth * 0.45 * Math.pow(1 - view.hauled, 1.4));
      s.radius = Math.max(2, el.a * 0.95);
    }
    if (!s.captured) syncMixFromNet(s);
    flushEscapes(s);
  }

  function harvest() {
    const out = emptyCatch();
    for (const s of schools) {
      if (s.captured || !s.net) continue;
      if (!(s.state === 'trapped' || s.net.trapped || view.phase === 'pursed')) continue;
      flushEscapes(s, true);
      const got = harvestCounts(s.net, specCfg);
      for (const k of SPECIES) {
        out[k] += got[k];
        const spill = Math.round(s.net.live[k]) - got[k];
        if (spill >= 1) {
          world.emit('fishing:escape', { count: spill, species: k, schoolId: s.id, overCorks: true });
          stats.escaped += spill;
        }
      }
      s.captured = true;
      s.capturedAt = now;
      s.capturedCount = catchTotal(got);
      s.state = 'captured';
      for (const k of SPECIES) s.mix[k] = got[k];
      s.count = s.capturedCount;
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Jumps

  function jumpRateMul(s) {
    let m = 0;
    if (s.state === 'milling') m = 1;
    else if (s.state === 'migrating') m = 0.8;
    else if (s.state === 'spooked') m = 0.15;
    else if (s.state === 'trapped') m = s.bag ? 0 : 0.6;
    if (slack && (s.state === 'milling' || s.state === 'migrating')) m *= 1.5;
    return m;
  }

  function pickJumpSpecies(s) {
    const total = s.count || 1;
    let x = rJump.next() * total;
    for (const k of SPECIES) {
      x -= s.mix[k] ?? 0;
      if (x < 0) return k;
    }
    return s.species;
  }

  function launch(s, { bag = false } = {}) {
    if (jumps.length >= MAX_JUMPS) return null;
    let x;
    let z;
    if (bag) {
      const el = view.ellipse;
      const a = rJump.next() * Math.PI * 2;
      const r = Math.sqrt(rJump.next()) * 0.85;
      const ca = Math.cos(el.angle);
      const sa = Math.sin(el.angle);
      const lx = Math.cos(a) * r * el.a;
      const lz = Math.sin(a) * r * el.b;
      x = el.x + lx * ca - lz * sa;
      z = el.z + lx * sa + lz * ca;
    } else {
      const a = rJump.next() * Math.PI * 2;
      const r = Math.sqrt(rJump.next()) * s.radius * 0.8;
      x = s.position.x + Math.cos(a) * r;
      z = s.position.z + Math.sin(a) * r;
    }
    const species = pickJumpSpecies(s);
    if (species === 'king' && !bag && rJump.next() < 0.85) return null; // kings rarely show
    const surfaceY = world.surfaceY(x, z);
    const j = createJump({
      id: jumpId++,
      schoolId: s.id,
      species,
      styleKey: bag ? 'bag' : species,
      x,
      z,
      surfaceY,
      heading: s.heading,
      free: bag,
      now,
      rng: rJump,
      hump: s.hump ?? 0,
    });
    j.bag = bag;
    jumps.push(j);
    newJumps.push(j);
    stats.jumps++;
    if (!bag || now - (s.lastBagEvent ?? 0) > 0.3) {
      if (bag) s.lastBagEvent = now;
      world.emit('fish:jump', { x, y: surfaceY, z, species, size: j.size, schoolId: s.id, heading: j.heading, style: j.style });
    }
    return j;
  }

  function scheduleJumps(s, dt) {
    const rate = (s.jumpRate / 60) * jumpRateMul(s);
    if (rate > 0) {
      s.nextJump -= dt * rate;
      if (s.nextJump <= 0) {
        s.nextJump = -Math.log(1 - rJump.next() * 0.999);
        launch(s);
      }
    }
    if (s.bag && (s.state === 'trapped' || (s.state === 'captured' && now - s.capturedAt < 6))) {
      const fill = s.state === 'captured' ? Math.max(0, 1 - (now - s.capturedAt) / 6) : 1;
      const bagRate = (0.6 + 7 * view.hauled * view.hauled) * fill * Math.min(1, s.count / 400 + 0.2);
      s.bagJump = (s.bagJump ?? 0) + dt * bagRate;
      while (s.bagJump >= 1) {
        s.bagJump -= 1;
        launch(s, { bag: true });
      }
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Population

  function catchable(s, fx, fz, radius = GUARANTEE.radius) {
    if (!CATCHABLE.has(s.state) || s.net || s.count < 50) return false;
    if (Math.hypot(s.position.x - fx, s.position.z - fz) > radius) return false;
    if (world.depthAt(s.position.x, s.position.z) < GUARANTEE.minDepth) return false;
    if (world.isClosedWater(s.position.x, s.position.z)) return false;
    return true;
  }

  function ensureGuarantee() {
    const f = world.focus();
    if (!world.openerActive(f.x, f.z)) return 0;
    let n = 0;
    for (const s of schools) if (catchable(s, f.x, f.z)) n++;
    let spawned = 0;
    while (n < GUARANTEE.count && spawned < GUARANTEE.count) {
      const p = sampleNear(f.x, f.z, GUARANTEE.minSpawn, GUARANTEE.maxSpawn, { minDepth: GUARANTEE.minDepth + 2, outOfView: true });
      if (!p) break;
      const species = pickSpecies(p.x, p.z, null);
      const s = makeSchool({ x: p.x, z: p.z, species, milling: rSpawn.next() < 0.5 });
      s.guaranteed = true;
      lastGuaranteeSpawns.push({ id: s.id, x: p.x, z: p.z, fx: f.x, fz: f.z, inView: world.inView(p.x, p.z) });
      if (lastGuaranteeSpawns.length > 16) lastGuaranteeSpawns.shift();
      stats.guaranteeSpawns++;
      spawned++;
      if (catchable(s, f.x, f.z)) n++;
    }
    return spawned;
  }

  function maintain() {
    const f = world.focus();
    const target = targetPopulation(world.day(), runs);
    for (let i = schools.length - 1; i >= 0; i--) {
      const s = schools[i];
      let drop = s.state === 'gone';
      if (!drop && (s.net || s.bag)) continue;
      const d = Math.hypot(s.position.x - f.x, s.position.z - f.z);
      drop ||= s.count <= 0;
      if (!drop && s.state === 'captured' && !session) drop = true;
      if (!drop && !s.tutorial && d > 7600) drop = true;
      if (!drop && !s.tutorial && s.age > s.maxAge && d > 2200) drop = true;
      if (!drop && s.tutorial && (d > 6000 || s.age > 3600)) drop = true;
      if (drop) {
        schools.splice(i, 1);
        stats.despawned++;
      }
    }
    // Too many (guarantee spawns on top of the run population): drop the farthest free schools out of sight.
    let live = liveCount();
    if (live > 25) {
      const cands = schools
        .filter((s) => FREE.has(s.state) && !s.tutorial && !s.net)
        .map((s) => ({ s, d: Math.hypot(s.position.x - f.x, s.position.z - f.z) }))
        .filter((c) => c.d > GUARANTEE.radius + 300)
        .sort((a, b) => b.d - a.d);
      for (const c of cands) {
        if (live <= 25) break;
        schools.splice(schools.indexOf(c.s), 1);
        stats.despawned++;
        live--;
      }
    }
    if (live < target) {
      const nearCount = schools.filter((s) => FREE.has(s.state) && Math.hypot(s.position.x - f.x, s.position.z - f.z) < 5000).length;
      if (nearCount < target * 0.45) spawnRunSchool({ near: true, rMin: 1600, rMax: 5000, outOfView: true });
      else spawnRunSchool({});
    }
  }

  // ---------------------------------------------------------------------------------------------------------------

  function update(dt) {
    newJumps.length = 0;
    if (!(dt > 0)) return;
    dt = Math.min(dt, 0.1);
    now += dt;
    tide = world.tideState() ?? tide;
    slack = nearSlack();
    if (!seeded) seed();
    readNet(dt);
    sessionUpdate();
    const boats = world.boats() ?? [];
    for (let i = 0; i < schools.length; i++) {
      const s = schools[i];
      if (s.state === 'gone') continue;
      s.age += dt;
      s.prevX = s.position.x;
      s.prevZ = s.position.z;
      if (s.state !== 'captured') {
        stateTransitions(s);
        s.steerT -= dt;
        if (s.steerT <= 0) {
          s.steerT = 0.5;
          steer(s);
        }
        s.featureT -= dt;
        if (s.featureT <= 0) {
          s.featureT = 4;
          if (s.state === 'migrating' && !s.net && now > s.millCooldown) {
            const f = featureCheck(s);
            if ((f.bayHead && rBehave.next() < 0.12) || (f.point && rBehave.next() < 0.18)) {
              startMill(s, lerp(90, 300, rBehave.next()));
            }
          }
        }
        integrate(s, dt);
        if (s.spooks > 0 && now - s.lastSpook > 300) {
          s.spooks--;
          s.lastSpook = now - 150;
        }
      } else if (view.phase === 'pursed') {
        // Captured fish stay in the bag until the net is stowed (brailing).
        const el = view.ellipse;
        s.position.x += (el.x - s.position.x) * Math.min(1, dt * 2);
        s.position.z += (el.z - s.position.z) * Math.min(1, dt * 2);
        s.radius = Math.max(1.5, el.a * 0.9);
        s.bagDepth = 0.35;
      }
      if (view.phase !== 'none') netInteract(s, dt);
      else {
        s.netInside = false;
        s.netTracked = false;
        s.inHook = false;
      }
      checkBoats(s, boats);
      scheduleJumps(s, dt);
    }
    for (let i = jumps.length - 1; i >= 0; i--) if (now - jumps[i].t0 > jumps[i].dur + 0.3) jumps.splice(i, 1);
    maintT -= dt;
    if (maintT <= 0) {
      maintT = 1;
      maintain();
    }
    guaranteeT -= dt;
    if (guaranteeT <= 0) {
      guaranteeT = 2;
      ensureGuarantee();
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Public queries

  const isLive = (s) => LIVE.has(s.state);

  function nearestSchool(x, z, maxDist = Infinity) {
    let best = null;
    let bd = Infinity;
    for (const s of schools) {
      if (!isLive(s)) continue;
      const d = Math.hypot(s.position.x - x, s.position.z - z);
      if (d < bd && d <= maxDist) {
        bd = d;
        best = s;
      }
    }
    return best ? { school: best, distance: bd } : null;
  }

  const schoolsWithin = (x, z, r) =>
    schools.filter((s) => isLive(s) && (s.position.x - x) ** 2 + (s.position.z - z) ** 2 <= r * r);

  const schoolsInside = (polygon) =>
    Array.isArray(polygon) && polygon.length >= 3
      ? schools.filter((s) => isLive(s) && pointInPolygon(s.position.x, s.position.z, polygon))
      : [];

  // Echo-sounder marks: a few returns per school within range, depth only (no species).
  function sonarReturns(x, z, range = 150) {
    const out = [];
    for (const s of schools) {
      if (!isLive(s)) continue;
      const dx = s.position.x - x;
      const dz = s.position.z - z;
      const d = Math.hypot(dx, dz);
      if (d > range + s.radius) continue;
      const marks = clamp(Math.ceil(s.count / 900), 2, 7);
      const base = clamp(s.count / 5000, 0.12, 1);
      let h = 0;
      for (let i = 0; i < s.id.length; i++) h = (h * 31 + s.id.charCodeAt(i)) >>> 0;
      for (let i = 0; i < marks; i++) {
        const a = ((h % 997) / 997) * 6.283 + i * 2.39996 + now * 0.05 * (i % 2 ? 1 : -1);
        const r = s.radius * 0.7 * Math.sqrt((i + 0.5) / marks);
        const mx = s.position.x + Math.cos(a) * r;
        const mz = s.position.z + Math.sin(a) * r;
        if (Math.hypot(mx - x, mz - z) > range) continue;
        const depth = Math.max(0.5, s.depth + Math.sin(a * 3.1 + i) * Math.min(2, s.depth * 0.4));
        out.push({ x: mx, z: mz, depth, strength: +(base * (0.65 + 0.35 * Math.cos(a * 1.7))).toFixed(3) });
      }
    }
    return out;
  }

  function spawnSchool(opts = {}) {
    const f = world.focus();
    const x = opts.x ?? f.x;
    const z = opts.z ?? f.z;
    const species = specCfg[opts.species] && opts.species !== 'king' ? opts.species : 'pink';
    return makeSchool({
      x,
      z,
      species,
      count: opts.count,
      milling: !!opts.milling,
      jumpRateMul: opts.jumpRateMul ?? 1,
      spookable: opts.spookable ?? true,
      tutorial: !!opts.tutorial,
      radius: opts.radius,
      depth: opts.depth,
      mix: opts.mix,
      pureMix: true,
    });
  }

  function clearSchools({ keepNet = true } = {}) {
    for (let i = schools.length - 1; i >= 0; i--) {
      const s = schools[i];
      if (keepNet && (s.net || s.bag)) continue;
      schools.splice(i, 1);
    }
    jumps.length = 0;
    newJumps.length = 0;
  }

  function reseed() {
    clearSchools({ keepNet: true });
    seeded = false;
    seed();
    guaranteeT = 0;
  }

  // The boat jumped far (debug teleport, map travel without a clock skip): drop what is now out of range and fill the
  // new neighbourhood straight away instead of one school per second.
  function rehome() {
    const f = world.focus();
    for (let i = schools.length - 1; i >= 0; i--) {
      const s = schools[i];
      if (s.net || s.bag) continue;
      if (Math.hypot(s.position.x - f.x, s.position.z - f.z) > 7600) schools.splice(i, 1);
    }
    const target = targetPopulation(world.day(), runs);
    let near = schools.filter((s) => FREE.has(s.state) && Math.hypot(s.position.x - f.x, s.position.z - f.z) < 5000).length;
    let guard = 0;
    while (near < target * 0.45 && guard++ < target) {
      if (spawnRunSchool({ near: true, rMin: 1600, rMax: 5000, outOfView: true })) near++;
    }
    guaranteeT = 0;
  }

  function reset() {
    clearSchools({ keepNet: false });
    session = null;
    view.phase = 'none';
    view.poly = null;
    seeded = false;
    maintT = 0;
    guaranteeT = 0;
  }

  // Horn and skiff splash come in as events.
  function onHorn(x, z) {
    for (const s of schools) {
      if (!FREE.has(s.state)) continue;
      if (Math.hypot(s.position.x - x, s.position.z - z) - s.radius < 150) spook(s, x, z, 'horn');
    }
  }
  function onSkiffSplash(x, z) {
    for (const s of schools) {
      if (!FREE.has(s.state)) continue;
      if (Math.hypot(s.position.x - x, s.position.z - z) - s.radius < 20) spook(s, x, z, 'skiff');
    }
  }

  return {
    schools,
    jumps,
    newJumps,
    stats,
    view,
    get now() {
      return now;
    },
    get session() {
      return session;
    },
    get slack() {
      return slack;
    },
    lastGuaranteeSpawns,
    update,
    nearestSchool,
    schoolsWithin,
    schoolsInside,
    sonarReturns,
    harvest,
    spawnSchool,
    spawnTutorial,
    spook,
    onHorn,
    onSkiffSplash,
    reseed,
    rehome,
    reset,
    ensureGuarantee,
    catchable,
    liveCount,
    isLive,
    FISH_LENGTH,
  };
}
