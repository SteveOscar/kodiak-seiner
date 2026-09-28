// Birds: glaucous-winged gulls (following the seiner, working over schools and bait, swarming the bag while hauling,
// resting on beaches), bald eagles (soaring the cliffs, perched on snags and rocks, stooping for fish), tufted puffins
// (rafts and low whirring flights by their islets) and pelagic cormorants (on the rocks, some drying their wings).
//
// Flight: circling and soaring birds follow parametric paths (stable at any frame rate); followers ride a critically
// damped spring on a wandering anchor; dives, sorties and take-offs are explicit timelines. Attitude (heading, bank,
// pitch) comes from the path velocity and acceleration; flapping from climb/acceleration effort with flap-glide bursts.

import * as THREE from 'three';
import { Herd } from './herd.js';
import { buildBird, buildSnag, BIRD_SPECS } from './shapes.js';
import { clamp, damp, dampAngle, wrapAngle, headingOf, hash01, noise1, TAU, lerp, smoothstep } from './math.js';
import { planFlocks } from './behaviour.js';

const G = 9.81;
const FLAP_HZ = { gull: 2.9, eagle: 1.9, puffin: 8.5, cormorant: 5.2 };
const GLIDE = { gull: [0.13, -0.2], eagle: [0.07, 0.12], puffin: [0.02, 0.0], cormorant: [0.03, 0.0] };

export function createBirds(env) {
  const { ctx, rng, sites, fx, mats } = env;
  const R = rng.fork('birds');
  const all = [];
  const V = new THREE.Vector3();

  // ------------------------------------------------------------------------------------------------ rendering
  const herd = (name, kind, pose, cap, opts = {}) =>
    new Herd(ctx, {
      name,
      geometries: [buildBird(kind, { pose }), opts.noLod ? null : buildBird(kind, { pose, lod: 1 })],
      material: mats.bird,
      depthMaterial: mats.birdDepth,
      capacity: cap,
      castShadow: !!opts.shadow,
      lodPx: opts.lodPx ?? 28,
      minPx: opts.minPx ?? 0,
      maxScale: opts.maxScale ?? 1,
      cullPx: 0.9,
    });
  const H = {
    gullFly: herd('gull-fly', 'gull', 'fly', 220, { shadow: true, minPx: 3.2, maxScale: 3.2 }),
    gullSit: herd('gull-sit', 'gull', 'sit', 120, { minPx: 2.2, maxScale: 2 }),
    eagleFly: herd('eagle-fly', 'eagle', 'fly', 48, { shadow: true, minPx: 3.4, maxScale: 3 }),
    eaglePerch: herd('eagle-perch', 'eagle', 'perch', 64, { minPx: 1.5, maxScale: 1.6 }),
    puffinFly: herd('puffin-fly', 'puffin', 'fly', 90, { minPx: 2.2, maxScale: 2.4 }),
    puffinSit: herd('puffin-sit', 'puffin', 'sit', 160, { minPx: 1.4, maxScale: 1.6 }),
    puffinPerch: herd('puffin-perch', 'puffin', 'perch', 60, { minPx: 1.2, maxScale: 1.4 }),
    cormFly: herd('cormorant-fly', 'cormorant', 'fly', 24, { minPx: 2.4, maxScale: 2.4 }),
    cormPerch: herd('cormorant-perch', 'cormorant', 'perch', 90, { minPx: 1.4, maxScale: 1.5 }),
    cormSpread: herd('cormorant-spread', 'cormorant', 'spread', 30, { minPx: 1.4, maxScale: 1.5, noLod: true }),
  };
  const snagGeo = buildSnag();
  const snagHerd = new Herd(ctx, { name: 'snag', geometries: [snagGeo], material: mats.static, capacity: 40, castShadow: true, lodPx: 0, cullPx: 1.2 });
  const snagPerch = snagGeo.userData.perch;

  // ------------------------------------------------------------------------------------------------ agents
  let nextId = 0;
  function bird(kind, role, x, y, z) {
    const b = {
      id: `${kind}-${nextId++}`,
      kind,
      role,
      position: new THREE.Vector3(x, y, z),
      vel: new THREE.Vector3(),
      heading: R.next() * TAU,
      pitch: 0,
      bank: 0,
      state: 'flying', // flying | soaring | swimming | perched | diving
      phase: R.next() * TAU,
      amp: 0.3,
      burst: R.next() * 3,
      fold: 0,
      headYaw: 0,
      seed: R.next(),
      active: false,
      drawn: false,
      t: 0,
      water: 0,
      waterAt: -1,
    };
    all.push(b);
    return b;
  }

  // Attitude from a path velocity/acceleration.
  function attitude(b, vx, vy, vz, dt, kind) {
    const hs = Math.hypot(vx, vz);
    if (hs > 0.4) {
      const h = headingOf(vx, vz);
      const turn = wrapAngle(h - b.heading) / Math.max(dt, 1e-3);
      b.heading = dampAngle(b.heading, h, 6, dt);
      b.bank = damp(b.bank, clamp(Math.atan((turn * hs) / G), -0.85, 0.85), 4, dt);
    } else b.bank = damp(b.bank, 0, 3, dt);
    b.pitch = damp(b.pitch, clamp(Math.atan2(vy, Math.max(hs, 1)) * 0.8, -0.7, 0.55), 4, dt);
    // Flap effort: climbing, speeding up, or slow flight; otherwise glide with occasional bursts.
    const speedChange = (hs - (b._hs ?? hs)) / Math.max(dt, 1e-3);
    b._hs = hs;
    const minSpeed = kind === 'eagle' ? 7 : kind === 'puffin' ? 10 : 5;
    let effort = clamp(vy * 0.35 + speedChange * 0.25 + (hs < minSpeed ? (minSpeed - hs) / minSpeed : 0), 0, 1);
    if (kind === 'puffin' || kind === 'cormorant') effort = Math.max(effort, 0.85);
    b.burst -= dt;
    if (effort < 0.35 && kind !== 'puffin') {
      if (b.burst < 0) b.burst = kind === 'eagle' ? 12 + R.next() * 30 : 2 + R.next() * 5;
      const flapping = b.burst < (kind === 'eagle' ? 1.6 : 1.2);
      effort = Math.max(effort, flapping ? 0.7 : 0);
    }
    const ampMax = kind === 'eagle' ? 0.55 : kind === 'puffin' ? 0.7 : kind === 'cormorant' ? 0.6 : 0.62;
    b.amp = damp(b.amp, effort * ampMax, 5, dt);
    b.phase += dt * TAU * FLAP_HZ[kind] * (0.85 + 0.3 * b.seed) * (0.6 + 0.4 * clamp(effort * 2, 0, 1));
  }

  function waterY(b, x, z, frame) {
    // Round-robin water sampling (swimmers are many; the swell is slow).
    if (b.waterAt < 0 || (frame + (b.seed * 7) | 0) % 3 === 0) {
      b.water = env.water(x, z);
      b.waterAt = frame;
    }
    return b.water;
  }

  // ------------------------------------------------------------------------------------------------ gulls
  const gulls = [];
  for (let i = 0; i < 190; i++) gulls.push(bird('gull', 'idle', 0, -100, 0));
  const takeGull = (role) => {
    const g = gulls.find((b) => b.role === 'idle');
    if (!g) return null;
    g.role = role;
    g.t = 0;
    g.active = true;
    return g;
  };
  const freeGull = (g) => {
    g.role = 'leaving';
    g.t = 0;
    const a = R.next() * TAU;
    g.leave = { vx: Math.cos(a) * 11, vz: Math.sin(a) * 11 };
  };

  // Followers.
  const follow = { members: [], slowFor: 0, lastBoat: new THREE.Vector3(), target: 9 };
  function spawnFollowers(n, near = true) {
    const s = ctx.systems.seiner;
    const p = s?.position ?? ctx.camera.position;
    for (let i = 0; i < n; i++) {
      const g = takeGull('follow');
      if (!g) break;
      // Station relative to the boat's centre: mostly over the stern and wake, a few abeam or over the wheelhouse.
      const u = R.next();
      g.fb = { back: u < 0.75 ? 11 + 15 * R.next() : -6 + 10 * R.next(), side: (R.next() - 0.5) * (u < 0.75 ? 16 : 30), up: u < 0.75 ? 3.5 + 6 * R.next() : 9 + 5 * R.next(), w: [0.12 + 0.25 * R.next(), 0.1 + 0.25 * R.next(), 0.15 + 0.3 * R.next()], p: [R.next() * TAU, R.next() * TAU, R.next() * TAU], k: 0.7 + 0.6 * R.next(), loiterR: 12 + 26 * R.next(), loiterDir: R.next() < 0.5 ? -1 : 1, sitter: R.next() < 0.35 };
      if (near) g.position.set(p.x + (R.next() - 0.5) * 60, 8 + R.next() * 12, p.z + (R.next() - 0.5) * 60);
      else {
        const a = R.next() * TAU;
        g.position.set(p.x + Math.cos(a) * 220, 25, p.z + Math.sin(a) * 220);
      }
      g.vel.set(0, 0, 0);
      g.state = 'flying';
      follow.members.push(g);
    }
  }

  function updateFollowers(dt, frame) {
    const s = ctx.systems.seiner;
    if (!s?.position) return;
    const speed = Math.abs(s.speed ?? 0);
    const h = s.heading ?? 0;
    const fx_ = Math.sin(h);
    const fz = -Math.cos(h);
    const vx = s.velocity?.x ?? fx_ * speed;
    const vz = s.velocity?.z ?? fz * speed;
    follow.slowFor = speed < 1.8 ? follow.slowFor + dt : 0;
    const loiter = follow.slowFor > 8;
    const t = ctx.time.elapsed;
    for (const g of follow.members) {
      const F = g.fb;
      g.t += dt;
      if (loiter && F.sitter && g.state !== 'swimming' && follow.slowFor > 14 + F.back) {
        // Settle on the water near the boat.
        const a = F.p[0] + F.side * 0.2;
        g.sitAt = { x: s.position.x + Math.cos(a) * (10 + F.loiterR), z: s.position.z + Math.sin(a) * (10 + F.loiterR) };
        g.state = 'landing';
      }
      if (!loiter && (g.state === 'swimming' || g.state === 'landing')) g.state = 'takeoff';
      if (g.state === 'landing' || g.state === 'swimming') {
        const tx = g.sitAt.x;
        const tz = g.sitAt.z;
        const wy = waterY(g, tx, tz, frame);
        if (g.state === 'landing') {
          const dx = tx - g.position.x;
          const dz = tz - g.position.z;
          const d = Math.hypot(dx, dz);
          const sp = Math.min(9, d * 0.8 + 2);
          const ty = wy + Math.min(10, d * 0.25);
          const nvx = (dx / Math.max(d, 1e-3)) * sp;
          const nvz = (dz / Math.max(d, 1e-3)) * sp;
          const nvy = (ty - g.position.y) * 1.2;
          g.position.x += nvx * dt;
          g.position.z += nvz * dt;
          g.position.y += nvy * dt;
          attitude(g, nvx, nvy, nvz, dt, 'gull');
          if (d < 1.5 && g.position.y - wy < 0.6) g.state = 'swimming';
        } else {
          g.position.set(tx, wy, tz);
          g.heading = dampAngle(g.heading, g.heading + noise1(t * 0.1, g.seed * 100) * 0.3, 1, dt);
          g.pitch = 0;
          g.bank = 0;
        }
        continue;
      }
      if (g.state === 'takeoff') {
        g.vel.y = 3.5;
        g.state = 'flying';
      }
      let ax;
      let ay;
      let az;
      if (loiter) {
        // Lazy circles over the idle boat.
        const w = (F.loiterDir * 7.5) / F.loiterR;
        const a = F.p[1] + t * w;
        ax = s.position.x + Math.cos(a) * F.loiterR;
        az = s.position.z + Math.sin(a) * F.loiterR;
        ay = 7 + F.up * 0.8 + 3 * Math.sin(t * F.w[2] + F.p[2]);
      } else {
        // Hang off the stern on the boat's slipstream, drifting about.
        // Over the wake behind the stern (the low ones never drift forward over the deck).
        const back = Math.max(F.up < 8 ? 10 : -8, F.back + 5 * Math.sin(t * F.w[0] + F.p[0]));
        const side = F.side + 6 * Math.sin(t * F.w[1] + F.p[1]);
        ax = s.position.x - fx_ * back + Math.cos(h) * side;
        az = s.position.z - fz * back + Math.sin(h) * side;
        ay = F.up + 2.5 * Math.sin(t * F.w[2] + F.p[2]) + (s.position.y ?? 0);
      }
      const k = F.k * (loiter ? 1.4 : 1);
      // Critically damped spring on the moving anchor.
      let accx = k * k * (ax - g.position.x) + 2 * k * ((loiter ? 0 : vx) - g.vel.x);
      let accy = k * k * (ay - g.position.y) + 2 * k * (0 - g.vel.y);
      let accz = k * k * (az - g.position.z) + 2 * k * ((loiter ? 0 : vz) - g.vel.z);
      const am = Math.hypot(accx, accy, accz);
      const maxA = 9;
      if (am > maxA) {
        accx *= maxA / am;
        accy *= maxA / am;
        accz *= maxA / am;
      }
      g.vel.x += accx * dt;
      g.vel.y += accy * dt;
      g.vel.z += accz * dt;
      g.position.addScaledVector(g.vel, dt);
      const wy = g.position.y < 4 ? waterY(g, g.position.x, g.position.z, frame) : 0;
      if (g.position.y < wy + 1.5) g.position.y = wy + 1.5;
      if (loiter || speed < 3) attitude(g, g.vel.x, g.vel.y, g.vel.z, dt, 'gull');
      else {
        // Moving boat: the gull faces into the apparent wind (along the course) and holds station in the slipstream,
        // constantly trimming: yawing to look down at the wake, tilting and side-slipping on the gusts.
        g.heading = dampAngle(g.heading, h + 0.4 * Math.sin(t * 0.43 + g.seed * 9) + 0.15 * Math.sin(t * 1.7 + g.seed * 3), 2.5, dt);
        const turn = (g.vel.x - vx) * Math.cos(h) + (g.vel.z - vz) * Math.sin(h);
        g.bank = damp(g.bank, clamp(turn * 0.25 + 0.38 * Math.sin(t * 0.9 + g.seed * 7) + 0.12 * Math.sin(t * 2.3 + g.seed * 5), -0.75, 0.75), 3, dt);
        g.pitch = damp(g.pitch, clamp(g.vel.y * 0.08, -0.3, 0.3) + 0.05 + 0.12 * Math.sin(t * 0.6 + g.seed * 11), 3, dt);
        g.headYaw = 0.5 * Math.sin(t * 0.5 + g.seed * 13);
        const effort = clamp(Math.abs(accy) * 0.08 + Math.abs(accx * fx_ + accz * fz) * 0.08, 0, 1);
        g.burst -= dt;
        if (g.burst < 0) g.burst = 1.5 + R.next() * 3.5;
        const e = Math.max(effort, g.burst < 0.9 ? 0.7 : 0.05);
        g.amp = damp(g.amp, e * 0.6, 5, dt);
        g.phase += dt * TAU * FLAP_HZ.gull * (0.85 + 0.3 * g.seed);
      }
    }
  }

  // Working flocks (over schools and bait) and the bag swarm share one circling/diving behaviour.
  const flocks = [];
  let flockPlanAt = -99;
  let baitSalt = 0;
  function makeFlock(kind, anchor, n, { radius = 16, alt = 12, schoolId = null } = {}) {
    const f = { id: `flock-${nextId++}`, kind, anchor, schoolId, members: [], radius, alt, age: 0, x: anchor.x, z: anchor.z, sitters: kind === 'swarm' ? 0.3 : 0.12 };
    for (let i = 0; i < n; i++) {
      const g = takeGull(kind);
      if (!g) break;
      const a = R.next() * TAU;
      const far = 40 + R.next() * 70;
      g.position.set(f.x + Math.cos(a) * far, 10 + R.next() * 12, f.z + Math.sin(a) * far);
      // A tight, low wheel over the feed: most birds within the ring, a few higher lookouts.
      const hi = R.next() < 0.2;
      g.wk = { r: radius * (0.3 + 0.8 * R.next()), alt: hi ? alt * (1.3 + 0.6 * R.next()) : alt * (0.45 + 0.6 * R.next()), w: (R.next() < 0.5 ? -1 : 1) * (0.35 + 0.4 * R.next()), a: R.next() * TAU, diveIn: 2 + R.next() * 8, sit: R.next() < f.sitters };
      g.state = 'flying';
      g.arrive = 0;
      f.members.push(g);
    }
    flocks.push(f);
    return f;
  }
  function dropFlock(f) {
    for (const g of f.members) freeGull(g);
    f.members.length = 0;
    const i = flocks.indexOf(f);
    if (i >= 0) flocks.splice(i, 1);
  }

  function planWorking(focus) {
    const fish = ctx.systems.fish;
    const schools = (fish?.schoolsWithin?.(focus.x, focus.z, 2600) ?? [])
      .slice()
      .sort((a, b) => Math.hypot(a.position.x - focus.x, a.position.z - focus.z) - Math.hypot(b.position.x - focus.x, b.position.z - focus.z));
    const plan = planFlocks(schools, { maxSchoolFlocks: 4, salt: Math.floor(ctx.time.elapsed / 600) + baitSalt });
    // Keep existing flocks whose school is still wanted; add new ones.
    for (const f of flocks.slice()) {
      if (f.kind !== 'work') continue;
      if (f.schoolId && !plan.schoolIds.includes(f.schoolId)) dropFlock(f);
    }
    for (const id of plan.schoolIds) {
      if (flocks.some((f) => f.schoolId === id)) continue;
      const sc = schools.find((s) => s.id === id);
      if (!sc) continue;
      makeFlock('work', { x: sc.position.x, z: sc.position.z, school: sc }, 10 + Math.floor(R.next() * 10), { radius: 8 + (sc.radius ?? 15) * 0.45, alt: 7 + R.next() * 5, schoolId: id });
    }
    const bait = flocks.filter((f) => f.kind === 'work' && !f.schoolId);
    // Bait flocks: fish-free patches of feed a few hundred metres to a couple of kilometres off.
    while (bait.length > plan.baitCount) dropFlock(bait.pop());
    let tries = 0;
    while (bait.length < plan.baitCount && tries++ < 12) {
      const a = R.next() * TAU;
      const d = 500 + R.next() * 1500;
      const x = focus.x + Math.cos(a) * d;
      const z = focus.z + Math.sin(a) * d;
      if (ctx.heightmap.shoreDistance(x, z) < 120) continue;
      bait.push(makeFlock('work', { x, z, drift: { x: Math.cos(a + 1.7) * 0.25, z: Math.sin(a + 1.7) * 0.25 } }, 9 + Math.floor(R.next() * 8), { radius: 11, alt: 8 }));
    }
  }

  function bagPosition(out) {
    const net = ctx.systems.net;
    const ck = net?.corkline;
    if (Array.isArray(ck) && ck.length > 2) {
      let x = 0;
      let z = 0;
      for (const p of ck) {
        x += p.x;
        z += p.z;
      }
      return out.set(x / ck.length, 0, z / ck.length);
    }
    const s = ctx.systems.seiner;
    if (!s?.position) return null;
    const h = s.heading ?? 0;
    return out.set(s.position.x + Math.cos(h) * 14, 0, s.position.z + Math.sin(h) * 14);
  }
  const bagV = new THREE.Vector3();
  let swarm = null;
  function updateSwarm() {
    const st = ctx.systems.fishing?.state ?? ctx.systems.net?.state;
    const hauling = st === 'hauling' || st === 'brailing' || st === 'pursing';
    if (hauling && !swarm) {
      if (!bagPosition(bagV)) return;
      swarm = makeFlock('swarm', { x: bagV.x, z: bagV.z, bag: true }, st === 'pursing' ? 16 : 40, { radius: 12, alt: 7 });
      // The followers join in.
      for (const g of follow.members) g.state = g.state === 'swimming' ? 'takeoff' : g.state;
    } else if (swarm && hauling && st !== 'pursing' && swarm.members.length < 36) {
      for (let i = 0; i < 4; i++) {
        const g = takeGull('swarm');
        if (!g) break;
        const a = R.next() * TAU;
        g.position.set(swarm.x + Math.cos(a) * 150, 25, swarm.z + Math.sin(a) * 150);
        g.wk = { r: 12 * (0.3 + R.next()), alt: 7 * (0.5 + R.next()), w: (R.next() < 0.5 ? -1 : 1) * (0.5 + 0.5 * R.next()), a: R.next() * TAU, diveIn: 2 + R.next() * 5, sit: R.next() < 0.3 };
        g.state = 'flying';
        swarm.members.push(g);
      }
    } else if (swarm && !hauling) {
      dropFlock(swarm);
      swarm = null;
    }
    if (swarm && bagPosition(bagV)) {
      swarm.anchor.x = bagV.x;
      swarm.anchor.z = bagV.z;
    }
  }

  function updateFlock(f, dt, frame, near) {
    f.age += dt;
    if (f.anchor.expires && ctx.time.elapsed > f.anchor.expires) {
      dropFlock(f);
      return;
    }
    if (f.anchor.school) {
      const sc = f.anchor.school;
      if (sc.state === 'captured' || sc.state === 'gone') {
        dropFlock(f);
        return;
      }
      f.anchor.x = sc.position.x;
      f.anchor.z = sc.position.z;
    } else if (f.anchor.drift) {
      f.anchor.x += f.anchor.drift.x * dt;
      f.anchor.z += f.anchor.drift.z * dt;
    }
    f.x = damp(f.x, f.anchor.x, 1.5, dt);
    f.z = damp(f.z, f.anchor.z, 1.5, dt);
    const t = ctx.time.elapsed;
    const swarmK = f.kind === 'swarm' ? 1.6 : 1;
    for (const g of f.members) {
      const W = g.wk;
      g.t += dt;
      if (!near) {
        // Far flocks: just carry the birds around their circle.
        W.a += W.w * dt * swarmK;
        g.position.set(f.x + Math.cos(W.a) * W.r, W.alt, f.z + Math.sin(W.a) * W.r);
        g.state = 'flying';
        continue;
      }
      if (g.state === 'swimming') {
        g.sitT -= dt;
        const wy = waterY(g, g.position.x, g.position.z, frame);
        g.position.y = wy;
        if (g.sitT < 0) {
          g.state = 'flying';
          g.vel.set(0, 4, 0);
        }
        continue;
      }
      if (g.state === 'diving') {
        g.dive.t += dt;
        const D = g.dive;
        const u = D.t / D.dur;
        const wy = D.wy;
        if (u < 1) {
          // Wings fold and the gull drops onto the fish at the surface.
          const e = u * u;
          const px = lerp(D.x0, D.x1, u);
          const pz = lerp(D.z0, D.z1, u);
          const py = lerp(D.y0, wy + 0.1, e);
          const vx = (D.x1 - D.x0) / D.dur;
          const vz = (D.z1 - D.z0) / D.dur;
          const vy = ((wy - D.y0) * 2 * u) / D.dur;
          g.position.set(px, py, pz);
          g.heading = dampAngle(g.heading, headingOf(vx, vz), 5, dt);
          g.pitch = damp(g.pitch, clamp(Math.atan2(vy, Math.hypot(vx, vz)), -1.2, 0), 6, dt);
          g.fold = damp(g.fold, 0.9, 6, dt);
          g.amp = damp(g.amp, 0.05, 6, dt);
        } else {
          fx?.splash(g.position.x, wy, g.position.z, { size: 0.45, count: 8, mist: false });
          env.stamp(g.position.x, g.position.z, 1.2, 0.8, 'ripple');
          g.fold = 0;
          if (W.sit || f.kind === 'swarm') {
            g.state = 'swimming';
            g.sitT = 2 + R.next() * (f.kind === 'swarm' ? 8 : 4);
          } else {
            g.state = 'flying';
            g.vel.set(0, 5, 0);
          }
          W.diveIn = (f.kind === 'swarm' ? 3 : 5) + R.next() * 9;
        }
        continue;
      }
      // Circling: the ring breathes and drifts; birds dip toward the water now and then.
      W.a += (W.w * dt * swarmK * 8) / Math.max(4, W.r);
      const r = W.r * (1 + 0.25 * noise1(t * 0.2, g.seed * 50));
      const tx = f.x + Math.cos(W.a) * r;
      const tz = f.z + Math.sin(W.a) * r;
      const ty = W.alt + 3 * noise1(t * 0.35, g.seed * 70) + 1.5;
      const k = 1.3;
      let ax = k * k * (tx - g.position.x) - 2 * k * g.vel.x * 0.6;
      let ay = k * k * (ty - g.position.y) - 2 * k * g.vel.y;
      let az = k * k * (tz - g.position.z) - 2 * k * g.vel.z * 0.6;
      const am = Math.hypot(ax, ay, az);
      if (am > 12) {
        ax *= 12 / am;
        ay *= 12 / am;
        az *= 12 / am;
      }
      g.vel.x += ax * dt;
      g.vel.y += ay * dt;
      g.vel.z += az * dt;
      const sp = Math.hypot(g.vel.x, g.vel.z);
      if (sp > 13) {
        g.vel.x *= 13 / sp;
        g.vel.z *= 13 / sp;
      }
      g.position.addScaledVector(g.vel, dt);
      g.fold = damp(g.fold, 0, 5, dt);
      attitude(g, g.vel.x, g.vel.y, g.vel.z, dt, 'gull');
      W.diveIn -= dt;
      if (W.diveIn < 0 && g.position.y > 4 && Math.hypot(g.position.x - f.x, g.position.z - f.z) < W.r * 1.6) {
        const wy = waterY(g, g.position.x, g.position.z, frame);
        g.state = 'diving';
        g.dive = { t: 0, dur: 0.6 + 0.012 * g.position.y * 10, x0: g.position.x, y0: g.position.y, z0: g.position.z, x1: g.position.x + g.vel.x * 0.4, z1: g.position.z + g.vel.z * 0.4, wy };
      }
    }
  }

  function updateLeavers(dt) {
    for (const g of gulls) {
      if (g.role !== 'leaving') continue;
      g.t += dt;
      g.vel.set(g.leave.vx, 2.5, g.leave.vz);
      g.position.addScaledVector(g.vel, dt);
      attitude(g, g.vel.x, g.vel.y, g.vel.z, dt, 'gull');
      if (g.t > 25) {
        g.role = 'idle';
        g.active = false;
      }
    }
  }

  // Resting gulls: small flocks standing on beaches and floating off them.
  const restFlocks = [];
  for (const b of sites.beaches) {
    if (R.next() > 0.45) continue;
    const members = [];
    const n = 5 + Math.floor(R.next() * 9);
    for (let i = 0; i < n; i++) {
      const a = R.next() * TAU;
      const d = 3 + R.next() * 16;
      const onWater = R.next() < 0.4;
      const off = onWater ? 14 + R.next() * 20 : -2 - R.next() * 4;
      const x = b.x + b.gx * off + Math.cos(a) * d;
      const z = b.z + b.gz * off + Math.sin(a) * d;
      const g = bird('gull', 'rest', x, 0, z);
      g.state = 'swimming';
      g.onWater = ctx.heightmap.heightAt(x, z) < -0.05;
      g.ground = g.onWater ? 0 : Math.max(0, ctx.heightmap.heightAt(x, z));
      g.heading = headingOf(b.gx, b.gz) + (R.next() - 0.5) * 1.2;
      members.push(g);
    }
    restFlocks.push({ x: b.x, z: b.z, members, active: false, spooked: 0 });
  }

  // ------------------------------------------------------------------------------------------------ eagles
  const eagleGroups = [];
  for (const c of sites.cliffs) {
    if (R.next() > 0.55) continue;
    const members = [];
    const n = R.next() < 0.45 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const e = bird('eagle', 'soar', c.x, c.top + 40, c.z);
      e.state = 'soaring';
      // Riding the updraft just seaward of the cliff edge, around cliff-top height, kept clear of the ground.
      const S = { cx: c.x + c.gx * (40 + 50 * R.next()), cz: c.z + c.gz * (40 + 50 * R.next()), top: c.top, r: 30 + 40 * R.next(), alt: c.top * 0.8 + 8 + 30 * R.next(), dir: R.next() < 0.5 ? -1 : 1, a: R.next() * TAU, ax: -c.gz, az: c.gx, speed: 9 + 2 * R.next() };
      let floor = 0;
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * TAU;
        for (const along of [-90, 0, 90]) floor = Math.max(floor, ctx.heightmap.heightAt(S.cx + S.ax * along + Math.cos(a) * S.r, S.cz + S.az * along + Math.sin(a) * S.r));
      }
      S.alt = Math.max(S.alt, floor + 14 + 10 * R.next());
      e.soar = S;
      members.push(e);
    }
    eagleGroups.push({ x: c.x, z: c.z, members, range: 3200 });
  }
  const perchGroups = [];
  const snags = [];
  for (const s of sites.snags) {
    const ground = env.groundRaw(s.x, s.z);
    const rot = R.next() * TAU;
    const snag = { x: s.x, z: s.z, y: ground, rot };
    snags.push(snag);
    if (R.next() > 0.7) continue;
    const c = Math.cos(-rot);
    const sn = Math.sin(-rot);
    // Perch offset rotated with the snag (Ry(-rot) applied to the model-space perch point).
    const px = s.x + snagPerch[0] * c + snagPerch[2] * sn;
    const pz = s.z - snagPerch[0] * sn + snagPerch[2] * c;
    const e = bird('eagle', 'perch', px, ground + snagPerch[1], pz);
    e.state = 'perched';
    e.perch = { x: px, y: ground + snagPerch[1], z: pz, face: s.face, onSnag: snag };
    e.heading = s.face + (R.next() - 0.5) * 1.5;
    perchGroups.push({ x: s.x, z: s.z, members: [e] });
  }
  for (const p of sites.rockPerches) {
    if (R.next() > 0.5) continue;
    const e = bird('eagle', 'perch', p.x, p.h, p.z);
    e.state = 'perched';
    e.perch = { x: p.x, y: null, z: p.z, face: p.face };
    e.heading = p.face + (R.next() - 0.5) * 1.2;
    perchGroups.push({ x: p.x, z: p.z, members: [e] });
  }

  function updateSoar(e, dt) {
    const S = e.soar;
    const t = ctx.time.elapsed;
    // Ridge lift: circles drift along the cliff and back.
    S.a += (S.dir * S.speed * dt) / S.r;
    const along = 90 * Math.sin(t * 0.013 + e.seed * 20);
    const cx = S.cx + S.ax * along;
    const cz = S.cz + S.az * along;
    const x = cx + Math.cos(S.a) * S.r;
    const z = cz + Math.sin(S.a) * S.r;
    const y = S.alt + 12 * Math.sin(t * 0.05 + e.seed * 9);
    const vx = (x - e.position.x) / Math.max(dt, 1e-3);
    const vy = (y - e.position.y) / Math.max(dt, 1e-3);
    const vz = (z - e.position.z) / Math.max(dt, 1e-3);
    e.position.set(x, y, z);
    if (dt > 0) attitude(e, vx, vy, vz, dt, 'eagle');
  }

  function updatePerched(e, dt, near) {
    const P = e.perch;
    if (P.y === null) P.y = env.ground(P.x, P.z);
    const t = ctx.time.elapsed;
    if (e.state === 'perched') {
      e.position.set(P.x, P.y, P.z);
      e.headYaw = 0.7 * noise1(t * 0.3, e.seed * 40);
      e.pitch = 0;
      e.bank = 0;
      e.sortieIn = (e.sortieIn ?? 30 + R.next() * 120) - dt;
      if (near && e.sortieIn < 0) {
        e.sortieIn = 90 + R.next() * 200;
        // Stoop on a fish offshore, then back to the perch.
        const g = { x: 0, z: 0 };
        ctx.heightmap.shoreGradient(P.x, P.z, g);
        const d = 70 + R.next() * 120;
        const tx = P.x + g.x * d + (R.next() - 0.5) * 60;
        const tz = P.z + g.z * d + (R.next() - 0.5) * 60;
        if (ctx.heightmap.heightAt(tx, tz) < -1) {
          e.state = 'sortie';
          e.sortie = { t: 0, tx, tz, dur: 9 + d / 12, back: 10 + d / 10, struck: false };
        }
      }
      return;
    }
    // Sortie: glide out and down, strike at the surface, climb back and land.
    const S = e.sortie;
    S.t += dt;
    const out = S.dur;
    let x;
    let y;
    let z;
    if (S.t < out) {
      const u = S.t / out;
      const e2 = smoothstep(0, 1, u);
      x = lerp(P.x, S.tx, e2);
      z = lerp(P.z, S.tz, e2);
      const wy = 0;
      y = lerp(P.y + 2, wy + 0.6, Math.pow(u, 1.6)) + Math.sin(Math.PI * u) * 8;
    } else if (S.t < out + S.back) {
      if (!S.struck) {
        S.struck = true;
        const wy = env.water(S.tx, S.tz);
        fx?.splash(S.tx, wy, S.tz, { size: 0.9, count: 14 });
        env.stamp(S.tx, S.tz, 2, 0.8, 'ripple');
        env.stamp(S.tx, S.tz, 1.5, 0.6, 'foam');
      }
      const u = (S.t - out) / S.back;
      const e2 = smoothstep(0, 1, u);
      x = lerp(S.tx, P.x, e2);
      z = lerp(S.tz, P.z, e2);
      y = lerp(0.8, P.y + 0.3, Math.pow(e2, 0.7)) + Math.sin(Math.PI * u) * 12;
    } else {
      e.state = 'perched';
      e.position.set(P.x, P.y, P.z);
      e.fold = 0;
      return;
    }
    const vx = (x - e.position.x) / Math.max(dt, 1e-3);
    const vy = (y - e.position.y) / Math.max(dt, 1e-3);
    const vz = (z - e.position.z) / Math.max(dt, 1e-3);
    e.position.set(x, y, z);
    if (dt > 0) attitude(e, vx, vy, vz, dt, 'eagle');
    if (S.t > out - 1 && S.t < out + 1.5) e.legs = 1;
    else e.legs = 0;
  }

  // ------------------------------------------------------------------------------------------------ puffins & cormorants
  // Low flights must stay over the sea: shrink an elliptical loop until it clears the land, or give up.
  function waterLoop(L) {
    for (let k = 0; k < 5; k++) {
      let ok = true;
      for (let i = 0; i < 24 && ok; i++) {
        const a = (i / 24) * TAU;
        const ex = Math.cos(a) * L.r;
        const ez = Math.sin(a) * L.r * L.ecc;
        const x = L.cx + ex * Math.cos(L.rot) - ez * Math.sin(L.rot);
        const z = L.cz + ex * Math.sin(L.rot) + ez * Math.cos(L.rot);
        if (ctx.heightmap.heightAt(x, z) > -0.5) ok = false;
      }
      if (ok) return true;
      L.r *= 0.7;
    }
    return false;
  }

  const colonies = [];
  for (const h of sites.haulouts) {
    if (!h.birds || !h.slots.length) continue;
    const isl = sites.islets.find((i) => i.id === h.isletId);
    const puffins = isl ? isl.maxH > 3 || h.kind === 'rookery' || isl.cells > 40 : R.next() < 0.5;
    const col = { x: h.x, z: h.z, puffinRaft: [], puffinFly: [], puffinStand: [], corms: [], cormFly: [], active: false, spooked: 0 };
    const g = { x: 0, z: 0 };
    ctx.heightmap.shoreGradient(h.slots[0].x, h.slots[0].z, g);
    if (puffins) {
      const rafts = h.kind === 'rookery' || (isl && isl.cells > 300) ? 3 : 1;
      for (let r = 0; r < rafts; r++) {
        // Rafts sit on open water a little off the rocks.
        let rc = null;
        for (let k = 0; k < 12 && !rc; k++) {
          const sl = h.slots[Math.floor(R.next() * h.slots.length)];
          const gg = { x: 0, z: 0 };
          ctx.heightmap.shoreGradient(sl.x, sl.z, gg);
          const d = 35 + 110 * R.next();
          const cx = sl.x + gg.x * d + (R.next() - 0.5) * 30;
          const cz = sl.z + gg.z * d + (R.next() - 0.5) * 30;
          if (ctx.heightmap.heightAt(cx, cz) < -3) rc = { x: cx, z: cz };
        }
        if (!rc) continue;
        const n = 6 + Math.floor(R.next() * 12);
        for (let i = 0; i < n; i++) {
          const p = bird('puffin', 'raft', rc.x + (R.next() - 0.5) * 18, 0, rc.z + (R.next() - 0.5) * 18);
          p.state = 'swimming';
          p.raft = rc;
          p.off = { x: p.position.x - rc.x, z: p.position.z - rc.z };
          col.puffinRaft.push(p);
        }
        for (let i = 0; i < 3 + Math.floor(R.next() * 4); i++) {
          const p = bird('puffin', 'loop', rc.x, 2, rc.z);
          p.loop = { a: R.next() * TAU, r: 50 + R.next() * 80, cx: rc.x, cz: rc.z, dir: R.next() < 0.5 ? -1 : 1, ecc: 0.4 + 0.4 * R.next(), rot: R.next() * TAU };
          p.state = 'flying';
          if (waterLoop(p.loop)) col.puffinFly.push(p);
          else p.loop = null;
        }
      }
      for (const s of h.slots.slice(0, 6)) {
        if (R.next() < 0.5) continue;
        const p = bird('puffin', 'stand', s.x + (R.next() - 0.5) * 4, s.h, s.z + (R.next() - 0.5) * 4);
        p.state = 'perched';
        p.heading = s.face + (R.next() - 0.5);
        col.puffinStand.push(p);
      }
    }
    const nc = h.kind === 'rookery' ? 10 : 2 + Math.floor(R.next() * 6);
    for (let i = 0; i < nc; i++) {
      const s = h.slots[Math.floor(R.next() * h.slots.length)];
      const c = bird('cormorant', R.next() < 0.3 ? 'spread' : 'stand', s.x + (R.next() - 0.5) * 5, s.h, s.z + (R.next() - 0.5) * 5);
      c.state = 'perched';
      c.heading = s.face + (R.next() - 0.5) * 1.4;
      col.corms.push(c);
    }
    if (R.next() < 0.6) {
      const sl = h.slots[Math.floor(R.next() * h.slots.length)];
      const gg = { x: 0, z: 0 };
      ctx.heightmap.shoreGradient(sl.x, sl.z, gg);
      const c = bird('cormorant', 'loop', sl.x, 3, sl.z);
      c.loop = { a: R.next() * TAU, r: 90 + R.next() * 120, cx: sl.x + gg.x * 140, cz: sl.z + gg.z * 140, dir: R.next() < 0.5 ? -1 : 1, ecc: 0.35, rot: R.next() * TAU };
      c.state = 'flying';
      if (waterLoop(c.loop)) col.cormFly.push(c);
    }
    colonies.push(col);
  }

  function updateLoop(b, dt, speed, alt) {
    const L = b.loop;
    L.a += (L.dir * speed * dt) / L.r;
    const ex = Math.cos(L.a) * L.r;
    const ez = Math.sin(L.a) * L.r * L.ecc;
    const c = Math.cos(L.rot);
    const s = Math.sin(L.rot);
    const x = L.cx + ex * c - ez * s;
    const z = L.cz + ex * s + ez * c;
    const y = alt + 0.6 * Math.sin(L.a * 3 + b.seed * 10);
    const vx = (x - b.position.x) / Math.max(dt, 1e-3);
    const vy = (y - b.position.y) / Math.max(dt, 1e-3);
    const vz = (z - b.position.z) / Math.max(dt, 1e-3);
    b.position.set(x, y, z);
    if (dt > 0) attitude(b, vx, vy, vz, dt, b.kind);
  }

  // ------------------------------------------------------------------------------------------------ update
  let frame = 0;
  const focusV = new THREE.Vector3();
  let wasHorn = false;
  function update(dt, cam, rangeMul = 1) {
    frame++;
    focusV.copy(cam);
    const s = ctx.systems.seiner;
    const nearSeiner = s?.position ? Math.hypot(s.position.x - cam.x, s.position.z - cam.z) < 3000 : false;
    // Followers: maintain the flock around the seiner (more when the boat is working).
    if (s?.position) {
      const want = ctx.state.mode === 'title' ? 6 : (ctx.systems.fishing?.state ?? 'idle') !== 'idle' ? 13 : 11;
      if (follow.members.length < want) spawnFollowers(want - follow.members.length, follow.members.length > 0);
      updateFollowers(dt, frame);
    }
    if (ctx.time.elapsed - flockPlanAt > 5) {
      flockPlanAt = ctx.time.elapsed;
      planWorking(nearSeiner ? s.position : cam);
      updateSwarm();
    } else if (swarm) updateSwarm();
    for (const f of flocks.slice()) {
      const d = Math.hypot(f.x - cam.x, f.z - cam.z);
      updateFlock(f, dt, frame, d < 900 * rangeMul);
    }
    updateLeavers(dt);
    for (const grp of eagleGroups) {
      const near = Math.hypot(grp.x - cam.x, grp.z - cam.z) < grp.range * rangeMul;
      for (const e of grp.members) {
        e.active = near;
        if (near) updateSoar(e, dt);
      }
    }
    for (const grp of perchGroups) {
      const d = Math.hypot(grp.x - cam.x, grp.z - cam.z);
      const near = d < 2400 * rangeMul;
      for (const e of grp.members) {
        e.active = near;
        if (near) updatePerched(e, dt, d < 900);
      }
    }
    for (const col of colonies) {
      const d = Math.hypot(col.x - cam.x, col.z - cam.z);
      col.active = d < 1500 * rangeMul;
      if (!col.active) continue;
      const t = ctx.time.elapsed;
      for (const p of col.puffinRaft) {
        p.active = true;
        const rc = p.raft;
        const x = rc.x + p.off.x + 1.5 * Math.sin(t * 0.07 + p.seed * 30);
        const z = rc.z + p.off.z + 1.5 * Math.cos(t * 0.06 + p.seed * 20);
        p.position.set(x, d < 500 ? waterY(p, x, z, frame) : 0, z);
        // Puffins dive for sand lance: gone for a while, then pop up.
        p.diveT = (p.diveT ?? R.next() * 40) - dt;
        if (p.diveT < 0) p.diveT = 15 + R.next() * 50;
        p.state = p.diveT < 6 ? 'underwater' : 'swimming';
        p.heading += noise1(t * 0.2, p.seed * 99) * dt * 0.4;
      }
      for (const p of col.puffinFly) {
        p.active = true;
        updateLoop(p, dt, 17, 2.2);
      }
      for (const p of col.puffinStand) {
        p.active = true;
        if (p.position.y === 0 || !p.grounded) {
          p.position.y = env.ground(p.position.x, p.position.z);
          p.grounded = true;
        }
        p.headYaw = 0.8 * noise1(t * 0.4, p.seed * 33);
      }
      for (const c of col.corms) {
        c.active = true;
        if (!c.grounded) {
          c.position.y = env.ground(c.position.x, c.position.z);
          c.grounded = true;
        }
        c.headYaw = 0.6 * noise1(t * 0.3, c.seed * 13);
        c.phase = t * 1.2 + c.seed * 10;
      }
      for (const c of col.cormFly) {
        c.active = true;
        updateLoop(c, dt, 14, 2.5);
      }
    }
    for (const rf of restFlocks) {
      const d = Math.hypot(rf.x - cam.x, rf.z - cam.z);
      rf.active = d < 1100 * rangeMul;
      if (!rf.active) continue;
      for (const g of rf.members) {
        g.active = true;
        const x = g.position.x;
        const z = g.position.z;
        g.position.y = g.onWater ? (d < 400 ? waterY(g, x, z, frame) : 0) : g.ground;
      }
    }
  }

  // Horn or a close pass: resting gulls lift off and wheel before settling again.
  function flush(x, z, radius) {
    for (const rf of restFlocks) {
      if (Math.hypot(rf.x - x, rf.z - z) > radius) continue;
      for (const g of rf.members) {
        if (g.role !== 'rest') continue;
        const n = takeGull('leaving');
        if (!n) break;
        n.position.copy(g.position).setY(g.position.y + 1);
        const a = R.next() * TAU;
        n.leave = { vx: Math.cos(a) * 9, vz: Math.sin(a) * 9 };
      }
    }
  }

  // ------------------------------------------------------------------------------------------------ render
  const drawnByKind = {};
  function render(view, sight) {
    for (const h of Object.values(H)) h.begin(view);
    snagHerd.begin(view);
    for (const k of ['gull', 'eagle', 'puffin', 'cormorant']) drawnByKind[k] = 0;
    for (const sn of snags) {
      if (Math.hypot(sn.x - view.cam.x, sn.z - view.cam.z) > 5000) continue;
      snagHerd.push(sn.x, sn.y, sn.z, sn.rot, 0, 0, 1, 9);
    }
    for (const b of all) {
      b.drawn = false;
      if (!b.active || b.state === 'underwater') continue;
      const spec = BIRD_SPECS[b.kind];
      const flying = b.state === 'flying' || b.state === 'soaring' || b.state === 'diving' || b.state === 'landing' || b.state === 'sortie' || b.state === 'takeoff';
      let herdSel;
      if (b.kind === 'gull') herdSel = flying ? H.gullFly : H.gullSit;
      else if (b.kind === 'eagle') herdSel = flying ? H.eagleFly : H.eaglePerch;
      else if (b.kind === 'puffin') herdSel = flying ? H.puffinFly : b.role === 'stand' ? H.puffinPerch : H.puffinSit;
      else herdSel = flying ? H.cormFly : b.role === 'spread' ? H.cormSpread : H.cormPerch;
      const radius = flying ? spec.half + 0.1 : spec.len * 0.5;
      const mul = herdSel.test(b.position.x, b.position.y, b.position.z, radius);
      if (!mul) continue;
      const gl = GLIDE[b.kind];
      let a0 = b.phase;
      let a1 = b.amp;
      let a2 = gl[0];
      let b2 = gl[1];
      if (!flying) {
        a1 = 0;
        if (b.role === 'spread') {
          a1 = 0.06;
          a2 = 0.25;
          a0 = b.phase;
        }
      }
      herdSel.write(b.position.x, b.position.y, b.position.z, b.heading, flying ? b.pitch : 0, flying ? -b.bank : 0, mul, a0, a1, a2, b.fold, b.headYaw, b.legs ? 1 : 0.3 * Math.max(0, Math.sin(b.phase * 0.1)), b2, b.seed);
      b.drawn = true;
      drawnByKind[b.kind]++;
      if (sight) sight(b.kind, b.position, flying ? spec.half * 2 : spec.len);
    }
    for (const h of Object.values(H)) h.end();
    snagHerd.end();
  }

  // A feeding frenzy over a bubble net or a bait ball: gulls pour in for a while.
  function frenzy(x, z, seconds = 45, n = 22) {
    return makeFlock('frenzy', { x, z, expires: ctx.time.elapsed + seconds }, n, { radius: 14, alt: 9 });
  }

  const api = {
    list: all,
    frenzy,
    update,
    render,
    flush,
    get flocks() {
      return flocks.map((f) => ({ id: f.id, kind: f.kind, x: f.x, z: f.z, overSchool: !!f.schoolId, schoolId: f.schoolId, count: f.members.length }));
    },
    get followers() {
      return follow.members.length;
    },
    teleport() {
      // The boat moved: send the old followers off and bring new ones in.
      for (const g of follow.members) {
        g.role = 'idle';
        g.active = false;
      }
      follow.members.length = 0;
      follow.slowFor = 0;
      for (const f of flocks.slice()) if (f !== swarm) dropFlock(f);
      flockPlanAt = -99;
    },
    reset() {
      api.teleport();
      if (swarm) {
        dropFlock(swarm);
        swarm = null;
      }
      baitSalt++;
    },
    drawn: drawnByKind,
    herds: H,
    snagHerd,
    groups: { eagles: eagleGroups, perches: perchGroups, colonies, rest: restFlocks },
  };
  return api;
}
