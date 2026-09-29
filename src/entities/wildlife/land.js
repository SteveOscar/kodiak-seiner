// Land animals: Kodiak brown bears (sows with cubs, big boars, subadult siblings) fishing the stream mouths, walking
// the beaches, grazing the sedge meadows and resting; Sitka black-tailed deer on the green hillsides, mountain goats
// on the high cliffs and a red fox trotting the wrack line. Quadrupeds walk on terrain.heightAt with a procedural
// gait (materials.js 'quad' rig) and pitch/roll to the slope.
//
// Bear encounters (SPEC §6.13): a person ashore within ~30 m makes the nearest adult bear stand and watch
// (bear:encounter 'watch'); closing to ~10 m provokes a bluff charge ('charge') that stops a few metres short; the
// bear then turns and leaves ('retreat').

import * as THREE from 'three';
import { Herd } from './herd.js';
import { buildQuadruped, QUADS } from './shapes.js';
import { buildBear } from './bear.js';
import { clamp, damp, dampAngle, wrapAngle, headingOf, noise1, TAU, lerp, smoothstep, hash01 } from './math.js';
import { planBears, createEncounter, stepEncounter, canEngage, ENCOUNTER } from './behaviour.js';

export function createLand(env) {
  const { ctx, rng, sites, fx, mats } = env;
  const R = rng.fork('land');
  const hm = ctx.heightmap;

  const BEARS = { boar: 1, sow: 1, cub: 1 };
  const quadHerd = (kind, cap, shadow = false) => {
    const build = BEARS[kind] ? (o) => buildBear(kind, o) : (o) => buildQuadruped(kind, o);
    const g0 = build({});
    const g1 = build({ lod: 1 });
    const ud = g0.userData;
    const mat = mats.quad(kind, [ud.hipY, ud.hipZ]);
    const depth = shadow ? mats.quadDepth(kind, [ud.hipY, ud.hipZ]) : null;
    return new Herd(ctx, { name: kind, geometries: [g0, g1], material: mat, depthMaterial: depth, capacity: cap, castShadow: shadow, lodPx: 36, cullPx: 0.9, tint: true });
  };
  const H = { boar: quadHerd('boar', 24, true), sow: quadHerd('sow', 40, true), cub: quadHerd('cub', 60, true), deer: quadHerd('deer', 80), goat: quadHerd('goat', 50), fox: quadHerd('fox', 16) };

  const animals = [];
  const bears = [];
  let nid = 0;
  function animal(kind, age, x, z, extra = {}) {
    const a = {
      id: `${kind}-${nid++}`,
      kind,
      age,
      position: new THREE.Vector3(x, 0, z),
      heading: R.next() * TAU,
      pitch: 0,
      roll: 0,
      state: 'idle',
      speed: 0,
      gait: R.next() * TAU,
      walk: 0,
      gallop: 0,
      headPitch: 0,
      headYaw: 0,
      rear: 0,
      lie: 0,
      t: 0,
      next: 2 + R.next() * 10,
      target: null,
      seed: R.next(),
      scale: 1,
      tint: [1, 1, 1],
      drawn: false,
      ...extra,
    };
    animals.push(a);
    return a;
  }

  // ------------------------------------------------------------------------------------------------ bears
  const siteById = new Map(sites.bearSites.map((s) => [s.id, s]));
  const beachWalks = sites.beaches.filter((b) => b.x < 2500 && hash01(`bw${b.x}`) < 0.35).slice(0, 6);
  for (const b of beachWalks) {
    // Remote beaches get a wandering bear: a synthetic site made from the beach.
    const g = { x: b.gx, z: b.gz };
    const path = [];
    for (let k = -3; k <= 3; k++) {
      const x = b.x - g.x * 8 + Math.sin(b.along) * k * 40;
      const z = b.z - g.z * 8 - Math.cos(b.along) * k * 40;
      const h = hm.heightAt(x, z);
      if (h > 0.3 && h < 7) path.push({ x, z });
    }
    if (path.length >= 3) siteById.set(`beach-${b.x.toFixed(0)}`, { id: `beach-${b.x.toFixed(0)}`, x: b.x, z: b.z, wade: null, bank: path[0], path, meadow: [], heading: 0 });
  }
  const groups = planBears(sites.bearSites, R);
  for (const s of siteById.values()) if (s.id.startsWith('beach-')) groups.push({ siteId: s.id, type: R.next() < 0.5 ? 'boar' : 'family', cubs: 1 + Math.floor(R.next() * 2) });
  const tintBear = () => {
    const k = 0.78 + R.next() * 0.4;
    const blond = R.next() < 0.25 ? 0.12 : 0;
    return [k + blond, k * (0.95 + blond * 0.5), k * 0.9];
  };
  for (const g of groups) {
    const site = siteById.get(g.siteId);
    if (!site) continue;
    const spot = site.bank ?? { x: site.x, z: site.z };
    const lead =
      g.type === 'boar'
        ? animal('bear', 'boar', spot.x + (R.next() - 0.5) * 20, spot.z + (R.next() - 0.5) * 20)
        : animal('bear', g.type === 'subadults' ? 'subadult' : 'sow', spot.x + (R.next() - 0.5) * 12, spot.z + (R.next() - 0.5) * 12);
    lead.site = site;
    lead.wadeIdx = bears.filter((o) => o.site === site && !o.mother).length;
    lead.tint = tintBear();
    lead.enc = createEncounter();
    lead.scale = lead.age === 'subadult' ? 0.82 : 0.94 + R.next() * 0.12;
    bears.push(lead);
    lead.cubs = [];
    const n = g.type === 'family' ? g.cubs ?? 2 : g.type === 'subadults' ? 1 : 0;
    for (let i = 0; i < n; i++) {
      const young = g.type === 'subadults';
      const c = animal('bear', young ? 'subadult' : 'cub', lead.position.x + (R.next() - 0.5) * 4, lead.position.z + (R.next() - 0.5) * 4);
      c.mother = lead;
      c.slot = i;
      c.tint = young ? lead.tint : [0.85 + R.next() * 0.2, 0.82 + R.next() * 0.2, 0.8 + R.next() * 0.2];
      c.scale = young ? 0.8 : 0.9 + R.next() * 0.25;
      if (young) c.enc = createEncounter();
      lead.cubs.push(c);
      bears.push(c);
    }
    lead.state = site.wade ? 'fishing' : 'walk';
    lead.target = site.path?.[0] ?? { x: spot.x, z: spot.z };
    lead.next = 10 + R.next() * 30;
  }

  const ground = (x, z) => env.ground(x, z);
  function placeOnGround(a, halfLen) {
    const [fx_, fz] = [Math.sin(a.heading), -Math.cos(a.heading)];
    const x = a.position.x;
    const z = a.position.z;
    const hF = ground(x + fx_ * halfLen, z + fz * halfLen);
    const hB = ground(x - fx_ * halfLen, z - fz * halfLen);
    const rx = Math.cos(a.heading);
    const rz = Math.sin(a.heading);
    const hL = ground(x - rx * halfLen * 0.4, z - rz * halfLen * 0.4);
    const hR = ground(x + rx * halfLen * 0.4, z + rz * halfLen * 0.4);
    a.position.y = Math.min((hF + hB) / 2, ground(x, z) + 0.05);
    a.pitch = damp(a.pitch, clamp(Math.atan2(hF - hB, 2 * halfLen), -0.55, 0.55), 6, env.dt);
    a.roll = damp(a.roll, clamp(Math.atan2(hR - hL, 0.8 * halfLen), -0.3, 0.3) * 0.7, 6, env.dt);
  }

  // Moves an animal toward (tx, tz) at `speed`; returns the remaining distance.
  function moveTo(a, tx, tz, speed, dt, turnRate = 2.5) {
    const dx = tx - a.position.x;
    const dz = tz - a.position.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.05) {
      a.speed = damp(a.speed, 0, 4, dt);
      return 0;
    }
    const want = headingOf(dx, dz);
    a.heading = dampAngle(a.heading, want, turnRate, dt);
    const align = Math.max(0, Math.cos(wrapAngle(want - a.heading)));
    a.speed = damp(a.speed, Math.min(speed, d * 1.5) * (0.3 + 0.7 * align), 3, dt);
    a.position.x += Math.sin(a.heading) * a.speed * dt;
    a.position.z += -Math.cos(a.heading) * a.speed * dt;
    return d;
  }

  function gaitFrom(a, dt, stride) {
    a.gait += dt * TAU * (a.speed / Math.max(0.2, stride));
    a.walk = damp(a.walk, clamp(a.speed / (stride * 0.75), 0, 1.15), 5, dt);
    a.gallop = damp(a.gallop, smoothstep(2.6, 5.5, a.speed), 4, dt);
  }

  const bearStride = (a) => ({ boar: 1.55, sow: 1.35, subadult: 1.2, cub: 0.65 })[a.age] ?? 1.3;
  const bearLen = (a) => ({ boar: 1.2, sow: 1.0, subadult: 0.85, cub: 0.42 })[a.age] ?? 1;

  // Fishing spots: knee-to-elbow-deep water on the rendered terrain near the analysed wading point (the coarse site
  // analysis runs on the DEM; this refines it once on the full-detail surface). Up to three spots at least 11 m
  // apart, so two bears at one mouth keep their distance.
  function wadeSpot(s, idx = 0) {
    if (!s.wadeFine) {
      const cands = [];
      for (let r = 0; r <= 36; r += 2) {
        const n = r === 0 ? 1 : Math.round(r * 1.5);
        for (let k = 0; k < n; k++) {
          const a = (k / n) * TAU;
          const x = s.wade.x + Math.cos(a) * r;
          const z = s.wade.z + Math.sin(a) * r;
          const h = ground(x, z);
          if (h > -0.18 || h < -0.55) continue;
          cands.push({ x, z, score: Math.abs(h + 0.36) * 20 + Math.hypot(x - s.x, z - s.z) * 0.05 });
        }
      }
      cands.sort((p, q) => p.score - q.score);
      const out = [];
      for (const c of cands) {
        if (out.length >= 3) break;
        if (out.some((o) => Math.hypot(o.x - c.x, o.z - c.z) < 11)) continue;
        out.push(c);
      }
      s.wadeFine = out.length ? out : [s.wade];
    }
    return s.wadeFine[idx % s.wadeFine.length];
  }

  function pickWaypoint(a) {
    const s = a.site;
    const u = R.next();
    if (s.wade && u < 0.5) return { state: 'fishing' };
    if (s.meadow?.length && u < 0.72) return { state: 'graze', target: s.meadow[Math.floor(R.next() * s.meadow.length)] };
    if (u < 0.85 && s.path?.length) return { state: 'walk', target: s.path[Math.floor(R.next() * s.path.length)] };
    return { state: 'rest' };
  }

  function updateAdultBear(a, dt, t) {
    a.t += dt;
    const s = a.site;
    let targetHead = 0.1;
    let targetRear = 0;
    let targetLie = 0;
    const wary = waryOf(a, t);
    if (wary) {
      a.pounce = null;
      a.speed = damp(a.speed, 0, 4, dt);
      const av = person.av;
      a.heading = dampAngle(a.heading, headingOf(av.x - a.position.x, av.z - a.position.z), 1.2, dt);
      targetHead = -0.12;
      a.headYaw = 0.2 * Math.sin(t * 0.9 + a.seed * 7);
    }
    if (!wary) switch (a.state) {
      case 'fishing': {
        // Wade into the shallows at the mouth, stand watching the water, lunge now and then.
        if (!s.wade) {
          nextActivity(a);
          break;
        }
        const W = wadeSpot(s, a.wadeIdx ?? 0);
        const wx = W.x + 3 * Math.sin(a.seed * 20 + t * 0.02);
        const wz = W.z + 3 * Math.cos(a.seed * 13 + t * 0.017);
        if (!a.pounce) {
          const d = moveTo(a, wx, wz, 1.1, dt);
          if (d < 1.5) {
            a.speed = damp(a.speed, 0, 3, dt);
            // Face out over the shallows where the salmon come in, shifting now and then.
            a.heading = dampAngle(a.heading, (s.heading ?? a.heading) + 0.9 * noise1(t * 0.05, a.seed * 60), 0.6, dt);
            targetHead = 0.55 + 0.15 * Math.sin(t * 0.7 + a.seed * 5);
            a.headYaw = 0.5 * noise1(t * 0.25, a.seed * 40);
            a.pounceIn = (a.pounceIn ?? 3 + R.next() * 8) - dt;
            if (a.pounceIn < 0) {
              a.pounceIn = 6 + R.next() * 12;
              a.pounce = { t: 0, heading: a.heading + (R.next() - 0.5) * 2 };
            }
          }
        } else {
          const P = a.pounce;
          P.t += dt;
          a.heading = dampAngle(a.heading, P.heading, 8, dt);
          a.speed = P.t < 0.55 ? 5.5 : damp(a.speed, 0, 6, dt);
          a.position.x += Math.sin(a.heading) * a.speed * dt;
          a.position.z += -Math.cos(a.heading) * a.speed * dt;
          targetHead = P.t < 0.5 ? 0.2 : 0.9;
          if (!P.splashed && P.t > 0.5) {
            P.splashed = true;
            const wy = env.water(a.position.x, a.position.z);
            if (hm.heightAt(a.position.x, a.position.z) < wy) {
              const [fx_, fz] = [Math.sin(a.heading), -Math.cos(a.heading)];
              fx?.splash(a.position.x + fx_ * 1.1, wy, a.position.z + fz * 1.1, { size: 1.5, count: 22 });
              env.stamp(a.position.x + fx_, a.position.z + fz, 2.2, 0.8, 'foam');
              env.stamp(a.position.x + fx_, a.position.z + fz, 2.5, 0.8, 'ripple');
            }
          }
          if (P.t > 1.6) a.pounce = null;
        }
        if (a.t > a.next) nextActivity(a);
        break;
      }
      case 'walk':
      case 'graze': {
        const tgt = a.target;
        if (!tgt) {
          nextActivity(a);
          break;
        }
        const d = moveTo(a, tgt.x, tgt.z, a.state === 'graze' ? 0.45 : 1.05, dt);
        if (a.state === 'graze') targetHead = 0.75 + 0.1 * Math.sin(t * 0.5 + a.seed);
        else targetHead = 0.15 + 0.1 * Math.sin(t * 0.8);
        if (d < 2) {
          if (a.state === 'graze' && a.t < a.next) a.target = { x: tgt.x + (R.next() - 0.5) * 30, z: tgt.z + (R.next() - 0.5) * 30 };
          else nextActivity(a);
        }
        if (a.t > a.next * 2) nextActivity(a);
        break;
      }
      case 'rest': {
        a.speed = damp(a.speed, 0, 3, dt);
        targetLie = 1;
        targetHead = 0.25;
        a.headYaw = 0.6 * noise1(t * 0.1, a.seed * 30);
        if (a.t > a.next) nextActivity(a);
        break;
      }
      case 'watch': {
        a.speed = damp(a.speed, 0, 4, dt);
        const av = ctx.game?.avatar?.();
        if (av) a.heading = dampAngle(a.heading, headingOf(av.x - a.position.x, av.z - a.position.z), 2, dt);
        // Up on the hind legs for a better look, then down to all fours, still facing the person.
        targetRear = a.t < 4 ? smoothstep(0.1, 0.8, a.t) : 1 - smoothstep(4, 5, a.t);
        targetHead = -0.2;
        a.headYaw = 0.25 * Math.sin(t * 1.3);
        break;
      }
      case 'charge': {
        const av = ctx.game?.avatar?.();
        if (av) {
          const dx = av.x - a.position.x;
          const dz = av.z - a.position.z;
          const d = Math.hypot(dx, dz);
          a.heading = dampAngle(a.heading, headingOf(dx, dz), 6, dt);
          const stopShort = 4;
          a.speed = damp(a.speed, d > stopShort ? 9 : 0, d > stopShort ? 3.5 : 10, dt);
          a.position.x += Math.sin(a.heading) * a.speed * dt;
          a.position.z += -Math.cos(a.heading) * a.speed * dt;
        }
        targetHead = -0.1;
        break;
      }
      case 'retreat': {
        const R0 = a.retreatTo;
        moveTo(a, R0.x, R0.z, a.t < 3 ? 3 : 1.4, dt);
        targetHead = 0.1;
        break;
      }
    }
    a.headPitch = damp(a.headPitch, targetHead, 3, dt);
    a.rear = damp(a.rear, targetRear, 4, dt);
    a.lie = damp(a.lie, targetLie, 1.2, dt);
    gaitFrom(a, dt, bearStride(a));
    placeOnGround(a, bearLen(a));
  }

  function nextActivity(a) {
    const w = pickWaypoint(a);
    if (w.state === 'fishing' && !a.site.wade) w.state = 'rest';
    a.state = w.state;
    a.target = w.target ?? null;
    a.t = 0;
    a.next = a.state === 'fishing' ? 40 + R.next() * 60 : a.state === 'rest' ? 20 + R.next() * 40 : 25 + R.next() * 40;
    if ((a.state === 'walk' || a.state === 'graze') && !a.target) a.state = 'rest';
  }

  // Cubs and subadults: each keeps its own loose station around the mother and its own little agenda (follow, sit
  // and watch her fish from the bank, nose about, play-fight a sibling), so a family never moves in lockstep.
  function updateYoung(c, dt, t) {
    const m = c.mother;
    c.t += dt;
    const cs = (c.cs ??= { mode: 'follow', next: 0, a: Math.PI + (R.next() - 0.5) * 2, d: 1.6 + R.next() * 1.6, tx: 0, tz: 0 });
    const bank = m.site?.bank;
    const fishing = m.state === 'fishing' && bank && c.age === 'cub';
    const alarmed = m.state === 'watch' || m.state === 'charge' || m.state === 'retreat';
    const sib = m.cubs.find((o) => o !== c) ?? null;
    cs.next -= dt;
    if (cs.next < 0 || (alarmed && cs.mode !== 'follow')) {
      const u = R.next();
      if (alarmed) cs.mode = 'follow';
      else if (fishing) cs.mode = u < 0.45 ? 'watch' : u < 0.7 && sib ? 'play' : 'nose';
      else if (m.state === 'rest') cs.mode = u < 0.65 ? 'rest' : sib && u < 0.85 ? 'play' : 'nose';
      else cs.mode = u < 0.7 ? 'follow' : u < 0.85 && sib ? 'play' : 'nose';
      cs.next = cs.mode === 'play' ? 3 + R.next() * 4 : 5 + R.next() * 9;
      cs.a = (fishing ? R.next() * Math.PI * 2 : Math.PI + (R.next() - 0.5) * 2.4) + c.slot;
      cs.d = cs.mode === 'nose' ? 3 + R.next() * 3 : 1.4 + R.next() * 1.8;
    }
    // Anchor: the mother, or while she fishes a spot on the bank a few metres above the waterline.
    let ax = m.position.x;
    let az = m.position.z;
    let ah = m.heading;
    if (fishing) {
      ax = bank.x;
      az = bank.z;
      ah = headingOf(m.position.x - bank.x, m.position.z - bank.z);
    }
    const ca = Math.cos(ah);
    const sa = Math.sin(ah);
    // Offset in the anchor's frame (angle 0 = ahead): rotate by heading.
    const ox = Math.sin(cs.a) * cs.d;
    const oz = -Math.cos(cs.a) * cs.d;
    let tx = ax + ox * ca - oz * sa;
    let tz = az + ox * sa + oz * ca;
    let speed = Math.max(1.3, m.speed * 1.35 + 0.4);
    let head = 0.1;
    let lie = 0;
    let rear = m.rear > 0.3 ? 1 : 0;
    if (cs.mode === 'play' && sib) {
      // Circle and tussle with the sibling.
      const pa = t * 1.7 + c.slot * Math.PI;
      tx = sib.position.x + Math.cos(pa) * 0.9;
      tz = sib.position.z + Math.sin(pa) * 0.9;
      speed = 2.6;
      head = 0.35;
      if (Math.hypot(sib.position.x - c.position.x, sib.position.z - c.position.z) < 1.1 && Math.sin(t * 2.3 + c.seed * 9) > 0.55) rear = 0.8;
    } else if (cs.mode === 'nose') {
      speed = 0.7;
      head = 0.75;
    } else if (cs.mode === 'watch') {
      speed = 1.2;
      head = -0.1;
    } else if (cs.mode === 'rest') {
      speed = 0.9;
    }
    // Stay out of deep water.
    if (ground(tx, tz) < -0.25) {
      tx = (tx + ax) / 2;
      tz = (tz + az) / 2;
    }
    const d = moveTo(c, tx, tz, speed, dt, 4);
    if (d < 0.6) {
      c.speed = damp(c.speed, 0, 5, dt);
      if (cs.mode === 'watch') {
        c.heading = dampAngle(c.heading, headingOf(m.position.x - c.position.x, m.position.z - c.position.z), 2, dt);
        lie = 0.55;
      } else if (cs.mode === 'rest') lie = 1;
      else if (cs.mode === 'follow') c.heading = dampAngle(c.heading, m.heading + (c.seed - 0.5) * 0.8, 1.2, dt);
    }
    c.rear = damp(c.rear, rear, 3, dt);
    c.lie = damp(c.lie, lie, 1.5, dt);
    c.headPitch = damp(c.headPitch, m.state === 'graze' && cs.mode === 'follow' ? 0.6 : c.rear > 0.3 ? -0.3 : head, 3, dt);
    c.headYaw = 0.4 * noise1(t * 0.5, c.seed * 20);
    gaitFrom(c, dt, bearStride(c));
    placeOnGround(c, bearLen(c));
  }

  // A bear that comes into range after a while out of it resumes where its activity would have taken it (at the
  // wading spot, on its beach path), not where it was left.
  function warmStart(b) {
    if (b.mother) return;
    const s = b.site;
    if (b.state === 'fishing' && s?.wade) {
      const W = wadeSpot(s, b.wadeIdx ?? 0);
      b.position.x = W.x + (R.next() - 0.5) * 5;
      b.position.z = W.z + (R.next() - 0.5) * 5;
    } else if ((b.state === 'walk' || b.state === 'graze') && b.target) {
      const u = 0.3 + 0.6 * R.next();
      b.position.x = lerp(b.position.x, b.target.x, u);
      b.position.z = lerp(b.position.z, b.target.z, u);
    }
    for (const c of b.cubs ?? []) {
      const a = R.next() * TAU;
      const home = b.state === 'fishing' && s?.bank && c.age === 'cub' ? s.bank : b.position;
      c.position.x = home.x + Math.cos(a) * 2;
      c.position.z = home.z + Math.sin(a) * 2;
      c.cs = null;
    }
  }

  // ------------------------------------------------------------------------------------------------ encounters
  // Every bear runs its own encounter state machine (behaviour.js). At most one bear at a time is watching or
  // charging the person; bears already retreating finish on their own, so a second bear can engage meanwhile.
  const engaged = new Set();
  let encounterBear = null;
  function applyStage(b, change, av) {
    if (change === 'watch') {
      b.prevState = b.state === 'watch' || b.state === 'charge' || b.state === 'retreat' ? 'walk' : b.state;
      b.state = 'watch';
      b.t = 0;
      b.pounce = null;
    } else if (change === 'charge') {
      b.state = 'charge';
      b.t = 0;
    } else if (change === 'retreat') {
      b.state = 'retreat';
      b.t = 0;
      const away = av ? headingOf(b.position.x - av.x, b.position.z - av.z) : b.heading + Math.PI;
      let rx = b.position.x + Math.sin(away) * 70;
      let rz = b.position.z - Math.cos(away) * 70;
      if (hm.heightAt(rx, rz) < 0.2) {
        rx = b.site?.bank?.x ?? rx;
        rz = b.site?.bank?.z ?? rz;
      }
      b.retreatTo = { x: rx, z: rz };
    } else if (change === 'none') {
      nextActivity(b);
    }
    if (change !== 'none') ctx.events.emit('bear:encounter', { stage: change, bearId: b.id, x: b.position.x, z: b.position.z });
  }
  // The person on foot as the bears see them: position, ground speed and which way they face.
  const person = { av: null, onFoot: false, speed: 0 };
  function readPerson() {
    const av = ctx.game?.avatar?.();
    person.av = av ?? null;
    person.onFoot = ctx.state.control === 'foot' && av?.control === 'foot' && ctx.state.mode === 'play';
    const v = person.onFoot ? ctx.systems.player?.velocity : null;
    person.speed = v && Number.isFinite(v.x) ? Math.hypot(v.x, v.z) : 0;
    return person;
  }
  // Degrees the person faces away from bear b (0 = looking straight at it, 180 = back turned).
  function facingAway(b, av) {
    if (!av || !Number.isFinite(av.heading)) return 0;
    return (Math.abs(wrapAngle(headingOf(b.position.x - av.x, b.position.z - av.z) - av.heading)) * 180) / Math.PI;
  }
  function updateEncounter(dt, t) {
    const { av, onFoot, speed } = readPerson();
    const distTo = (b) => (av ? Math.hypot(b.position.x - av.x, b.position.z - av.z) : Infinity);
    let primary = null;
    for (const b of [...engaged]) {
      const change = stepEncounter(b.enc, { dist: distTo(b), onFoot, dt, time: t, speed, facingDeg: facingAway(b, av), bearSpeed: b.speed ?? 0 });
      if (change) applyStage(b, change, av);
      if (b.enc.stage === 'none') engaged.delete(b);
      else if (b.enc.stage === 'watch' || b.enc.stage === 'charge') primary = b;
    }
    if (!primary && onFoot) {
      // The nearest bear that would engage: one resting on its cooldown further off does not shield another.
      let nearest = null;
      let nd = Infinity;
      for (const b of bears) {
        if (!b.enc || !b.active || engaged.has(b)) continue;
        const d = distTo(b);
        if (d < nd && canEngage(b.enc, { dist: d, onFoot, time: t })) {
          nd = d;
          nearest = b;
        }
      }
      if (nearest) {
        const change = stepEncounter(nearest.enc, { dist: nd, onFoot, dt, time: t, speed, facingDeg: facingAway(nearest, av) });
        if (change === 'watch') {
          engaged.add(nearest);
          applyStage(nearest, change, av);
          primary = nearest;
        }
      }
    }
    encounterBear = primary ?? [...engaged][0] ?? null;
  }

  // A bear that has just ended an encounter stays wary while the person is still around: it stops what it is doing,
  // keeps its head up and turns to keep them in view (no event; it re-engages with a watch if they walk right up).
  function waryOf(a, t) {
    const enc = a.enc;
    if (!enc || enc.stage !== 'none' || t >= enc.cooldownUntil || !person.onFoot || !person.av) return false;
    return Math.hypot(a.position.x - person.av.x, a.position.z - person.av.z) < ENCOUNTER.watchDist;
  }

  // ------------------------------------------------------------------------------------------------ deer, goats, fox
  const herds = [];
  for (const m of sites.deerMeadows) {
    const n = 1 + Math.floor(R.next() * 4);
    const grp = { x: m.x, z: m.z, members: [], kind: 'deer', active: false, r: 55 };
    for (let i = 0; i < n; i++) {
      const d = animal('deer', i === 0 && R.next() < 0.4 ? 'buck' : 'doe', m.x + (R.next() - 0.5) * 25, m.z + (R.next() - 0.5) * 25);
      d.home = { x: m.x, z: m.z };
      d.scale = i > 0 && R.next() < 0.3 ? 0.65 : 0.92 + R.next() * 0.15;
      d.tint = [0.95 + R.next() * 0.1, 0.95 + R.next() * 0.08, 0.95];
      grp.members.push(d);
    }
    herds.push(grp);
  }
  for (const c of sites.goatCliffs) {
    const n = 2 + Math.floor(R.next() * 5);
    const grp = { x: c.x, z: c.z, members: [], kind: 'goat', active: false, r: 40 };
    for (let i = 0; i < n; i++) {
      const g = animal('goat', 'goat', c.x + (R.next() - 0.5) * 30, c.z + (R.next() - 0.5) * 30);
      g.home = { x: c.x, z: c.z };
      g.scale = i > 0 && R.next() < 0.35 ? 0.6 : 0.95 + R.next() * 0.1;
      grp.members.push(g);
    }
    herds.push(grp);
  }
  const foxBeaches = sites.beaches.filter((b) => hash01(`fox${b.z}`) < 0.2).slice(0, 7);
  for (const b of foxBeaches) {
    const f = animal('fox', 'fox', b.x - b.gx * 5, b.z - b.gz * 5);
    const path = [];
    for (let k = -2; k <= 2; k++) path.push({ x: b.x - b.gx * 5 + Math.sin(b.along) * k * 30, z: b.z - b.gz * 5 - Math.cos(b.along) * k * 30 });
    f.path = path.filter((p) => {
      const h = hm.heightAt(p.x, p.z);
      return h > 0.2 && h < 6;
    });
    if (f.path.length < 2) f.path = [{ x: f.position.x, z: f.position.z }];
    f.pi = 0;
    herds.push({ x: b.x, z: b.z, members: [f], kind: 'fox', active: false, r: 60 });
  }

  function updateGrazer(a, dt, t, grp) {
    a.t += dt;
    const av = ctx.game?.avatar?.();
    const onFoot = ctx.state.control === 'foot';
    const threat = av && onFoot ? Math.hypot(av.x - a.position.x, av.z - a.position.z) : Infinity;
    const shy = a.kind === 'deer' ? 55 : a.kind === 'fox' ? 35 : 40;
    if (threat < shy && a.state !== 'flee') {
      a.state = 'flee';
      a.t = 0;
      const away = headingOf(a.position.x - av.x, a.position.z - av.z);
      a.target = { x: a.position.x + Math.sin(away) * 120, z: a.position.z - Math.cos(away) * 120 };
    }
    let head = 0.1;
    switch (a.state) {
      case 'flee':
        moveTo(a, a.target.x, a.target.z, a.kind === 'goat' ? 2.4 : 7.5, dt, 4);
        head = -0.15;
        if (a.t > 12) {
          a.state = 'idle';
          a.home = { x: a.position.x, z: a.position.z };
        }
        break;
      case 'move': {
        const d = moveTo(a, a.target.x, a.target.z, a.kind === 'fox' ? 1.9 : a.kind === 'goat' ? 0.35 : 0.55, dt);
        head = a.kind === 'fox' ? 0.35 : 0.5;
        if (d < 1) {
          a.state = a.kind === 'fox' ? 'sniff' : 'graze';
          a.t = 0;
          a.next = 4 + R.next() * 12;
        }
        break;
      }
      case 'graze':
      case 'sniff':
        a.speed = damp(a.speed, 0, 4, dt);
        head = a.state === 'sniff' ? 0.8 : 0.95;
        // Heads come up now and then to look around.
        if (Math.sin(t * 0.37 + a.seed * 30) > 0.72) head = -0.25;
        if (a.t > a.next) {
          a.state = 'move';
          a.t = 0;
          if (a.kind === 'fox') {
            a.pi = (a.pi + 1) % a.path.length;
            a.target = a.path[a.pi];
          } else {
            const r = grp.r;
            a.target = { x: a.home.x + (R.next() - 0.5) * r * 2, z: a.home.z + (R.next() - 0.5) * r * 2 };
            if (a.kind === 'goat' || hm.heightAt(a.target.x, a.target.z) < 1) a.target = { x: a.home.x + (R.next() - 0.5) * 20, z: a.home.z + (R.next() - 0.5) * 20 };
          }
        }
        break;
      default:
        a.state = 'graze';
        a.t = 0;
        a.next = 3 + R.next() * 8;
    }
    a.headPitch = damp(a.headPitch, head, 3, dt);
    a.headYaw = a.state === 'graze' ? 0.3 * noise1(t * 0.2, a.seed * 30) : 0;
    const stride = a.kind === 'fox' ? 0.55 : a.kind === 'goat' ? 0.8 : 1.0;
    gaitFrom(a, dt, stride);
    placeOnGround(a, (QUADS[a.kind]?.len ?? 1) * 0.45 * a.scale);
  }

  // ------------------------------------------------------------------------------------------------ update / render
  function update(dt, cam, rangeMul = 1) {
    const t = ctx.time.elapsed;
    const av = ctx.game?.avatar?.();
    readPerson();
    for (const b of bears) {
      const d = Math.hypot(b.position.x - cam.x, b.position.z - cam.z);
      const da = av ? Math.hypot(b.position.x - av.x, b.position.z - av.z) : Infinity;
      const was = b.active;
      b.active = d < 2600 * rangeMul || da < 400 || b.drawn;
      if (b.active && !was && ctx.time.elapsed - (b.lastActive ?? -1e9) > 20) warmStart(b);
      if (b.active) b.lastActive = ctx.time.elapsed;
    }
    for (const b of bears) {
      if (!b.active) continue;
      if (b.mother) {
        if (b.mother.active) updateYoung(b, dt, t);
      } else updateAdultBear(b, dt, t);
    }
    updateEncounter(dt, t);
    for (const grp of herds) {
      const d = Math.hypot(grp.x - cam.x, grp.z - cam.z);
      grp.active = d < (grp.kind === 'goat' ? 3500 : 2000) * rangeMul;
      if (!grp.active) continue;
      for (const a of grp.members) updateGrazer(a, dt, t, grp);
    }
  }

  const herdOf = (a) => (a.kind === 'bear' ? (a.age === 'boar' ? H.boar : a.age === 'cub' ? H.cub : H.sow) : H[a.kind]);
  const radiusOf = (a) => (a.kind === 'bear' ? bearLen(a) * 1.4 : (QUADS[a.kind]?.len ?? 1) * 0.8) * a.scale;
  function render(view, sight) {
    for (const h of Object.values(H)) h.begin(view);
    for (const a of animals) {
      a.drawn = false;
      const act = a.kind === 'bear' ? a.active : true;
      if (!act) continue;
      const herd = herdOf(a);
      const r = radiusOf(a);
      const mul = herd.test(a.position.x, a.position.y + r * 0.5, a.position.z, r);
      if (!mul) continue;
      const bob = -0.025 * a.walk * Math.abs(Math.sin(a.gait * 2)) * a.scale;
      herd.write(a.position.x, a.position.y + bob, a.position.z, a.heading, a.pitch + 0.03 * a.walk * Math.sin(a.gait * 2), a.roll + 0.035 * a.walk * Math.sin(a.gait), a.scale * mul, a.gait, a.walk, a.gallop, a.headPitch, a.headYaw, a.rear, a.lie, a.seed, a.tint);
      a.drawn = true;
      if (sight) sight(a.kind, a.position, a.kind === 'bear' ? bearLen(a) * 2 : (QUADS[a.kind]?.len ?? 1));
    }
    for (const h of Object.values(H)) h.end();
  }

  function nearestBear(x, z) {
    let best = null;
    let bd = Infinity;
    for (const b of bears) {
      const d = Math.hypot(b.position.x - x, b.position.z - z);
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
    return best ? { bear: best, distance: bd } : null;
  }

  return {
    bears,
    animals,
    update,
    render,
    nearestBear,
    get encounter() {
      return encounterBear ? { bearId: encounterBear.id, stage: encounterBear.enc.stage } : null;
    },
    // Sets a bear's activity for QA shots: 'fishing' | 'walk' | 'graze' | 'rest', optionally moving it (and its
    // young) to (x, z) first.
    stage(bearId, state, x, z) {
      const b = bears.find((o) => o.id === bearId);
      if (!b || b.mother) return false;
      if (Number.isFinite(x) && Number.isFinite(z)) {
        b.position.x = x;
        b.position.z = z;
        for (const c of b.cubs ?? []) {
          c.position.x = x + (R.next() - 0.5) * 4;
          c.position.z = z + (R.next() - 0.5) * 4;
          c.cs = null;
        }
      }
      b.state = state;
      b.t = 0;
      b.next = 60;
      b.pounce = null;
      if (state === 'walk' || state === 'graze') b.target = (state === 'graze' ? b.site.meadow : b.site.path)?.[0] ?? { x: b.position.x + 20, z: b.position.z };
      return true;
    },
    reset() {
      encounterBear = null;
      engaged.clear();
      for (const b of bears) {
        if (b.enc) Object.assign(b.enc, createEncounter());
        if (!b.mother) {
          b.state = b.site?.wade ? 'fishing' : 'walk';
          if (b.state === 'walk') b.target = b.site?.path?.[0] ?? { x: b.position.x, z: b.position.z };
          b.t = 0;
        }
      }
    },
    herds: H,
    ENCOUNTER,
  };
}
