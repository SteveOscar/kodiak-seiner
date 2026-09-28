// Marine mammals: humpback whales (breath series with blows and rolling backs, fluke-up dives, breaches, rare
// bubble-net lunges with gulls), a rare orca pod passing through, sea otter rafts in the kelp, Steller sea lions on
// their haulouts (the Marmot Island rookery stays inside its closed-area buffer and stampedes if a boat pushes in)
// and harbor seals hauled out on beaches or bottling off the stream mouths.
//
// Whale motion is timeline-driven per state (positions and attitude are functions of state time), so behaviour is
// frame-rate independent and a whale far away costs a few arithmetic operations per frame.

import * as THREE from 'three';
import { Herd } from './herd.js';
import { buildHumpback, buildOrca, buildOtter, buildSeaLion, buildSeal } from './shapes.js';
import { clamp, damp, dampAngle, wrapAngle, headingOf, noise1, TAU, lerp, smoothstep } from './math.js';

const L_HUMP = 14;

export function createMarine(env) {
  const { ctx, rng, sites, fx, mats } = env;
  const R = rng.fork('marine');
  const hm = ctx.heightmap;
  const whales = [];
  const others = []; // otters, sea lions, seals (public list material)

  const H = {
    hump: new Herd(ctx, { name: 'humpback', geometries: [buildHumpback(), buildHumpback({ lod: 1 })], material: mats.whale, capacity: 16, lodPx: 70, cullPx: 1 }),
    orcaM: new Herd(ctx, { name: 'orca-male', geometries: [buildOrca({ male: true }), buildOrca({ male: true, lod: 1 })], material: mats.whale, capacity: 4, lodPx: 60, cullPx: 1 }),
    orcaF: new Herd(ctx, { name: 'orca-female', geometries: [buildOrca({ male: false }), buildOrca({ male: false, lod: 1 })], material: mats.whale, capacity: 8, lodPx: 60, cullPx: 1 }),
    otter: new Herd(ctx, { name: 'otter', geometries: [buildOtter(), buildOtter({ lod: 1 })], material: mats.fur, capacity: 220, lodPx: 30, cullPx: 0.9 }),
    cow: new Herd(ctx, { name: 'sealion', geometries: [buildSeaLion(), buildSeaLion({ lod: 1 })], material: mats.pinniped, capacity: 200, lodPx: 30, cullPx: 0.9, tint: true }),
    bull: new Herd(ctx, { name: 'sealion-bull', geometries: [buildSeaLion({ bull: true }), buildSeaLion({ bull: true, lod: 1 })], material: mats.pinniped, capacity: 40, lodPx: 30, cullPx: 0.9 }),
    seal: new Herd(ctx, { name: 'seal', geometries: [buildSeal(), buildSeal({ lod: 1 })], material: mats.pinniped, capacity: 120, lodPx: 30, cullPx: 0.9, tint: true }),
  };

  // --------------------------------------------------------------------------------------------- humpbacks
  const ranges = sites.whaleRanges.slice();
  let wid = 0;
  function makeWhale(range, x, z) {
    const w = {
      id: `humpback-${wid++}`,
      kind: 'humpback',
      range,
      position: new THREE.Vector3(x, -14, z),
      heading: R.next() * TAU,
      pitch: 0,
      roll: 0,
      arch: 0,
      amp: 0.3,
      phase: R.next() * TAU,
      pec: 0,
      gulp: 0,
      state: 'deep',
      t: R.next() * 60,
      dur: 40 + R.next() * 70,
      breaths: 0,
      breathDur: 10,
      blown: false,
      seed: R.next(),
      target: { x, z },
      drawn: false,
      visible: false,
    };
    whales.push(w);
    return w;
  }
  for (const r of ranges) {
    const n = r.r > 1000 ? 2 : R.next() < 0.35 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const a = R.next() * TAU;
      makeWhale(r, r.x + Math.cos(a) * r.r * 0.5, r.z + Math.sin(a) * r.r * 0.5);
    }
  }
  // A roaming visitor keeps a whale within a few kilometres of the boat ("always a distant blow").
  const roamer = makeWhale(null, 0, 0);
  roamer.roamer = true;

  const fwd = (h) => [Math.sin(h), -Math.cos(h)];
  function swim(w, speed, dt, depthOK = true) {
    const [fx_, fz] = fwd(w.heading);
    const nx = w.position.x + fx_ * speed * dt;
    const nz = w.position.z + fz * speed * dt;
    // Keep off the shelf: turn away from shallow water ahead.
    const ahead = hm.heightAt(nx + fx_ * 60, nz + fz * 60);
    if (ahead > -12 && depthOK) {
      const g = { x: 0, z: 0 };
      hm.shoreGradient(nx, nz, g);
      w.heading = dampAngle(w.heading, headingOf(g.x, g.z), 0.8, dt);
    }
    w.position.x = nx;
    w.position.z = nz;
  }
  function steer(w, dt) {
    const c = w.range ?? w.home ?? { x: w.position.x, z: w.position.z, r: 800 };
    const dx = w.target.x - w.position.x;
    const dz = w.target.z - w.position.z;
    if (dx * dx + dz * dz < 80 * 80) {
      const a = R.next() * TAU;
      const rr = (c.r ?? 800) * Math.sqrt(R.next());
      w.target = { x: c.x + Math.cos(a) * rr, z: c.z + Math.sin(a) * rr };
    }
    w.heading = dampAngle(w.heading, headingOf(w.target.x - w.position.x, w.target.z - w.position.z), 0.12, dt);
  }

  function blowholeOf(w, out) {
    const [fx_, fz] = fwd(w.heading);
    // Blowhole: ~a quarter of the body behind the rostrum, on top of the head.
    const ahead = w.kind === 'orca' ? 2.4 * (w.scale ?? 1) : 3.6;
    const cp = Math.cos(w.pitch);
    out.x = w.position.x + fx_ * ahead * cp;
    out.z = w.position.z + fz * ahead * cp;
    out.y = w.position.y + ahead * Math.sin(w.pitch) + (w.kind === 'orca' ? 0.75 : 1.0);
    return out;
  }
  const tmp = { x: 0, y: 0, z: 0 };
  function doBlow(w, height = 4.8) {
    blowholeOf(w, tmp);
    const wy = env.water(tmp.x, tmp.z);
    fx?.blow(tmp.x, wy + 0.2, tmp.z, { height, width: w.kind === 'orca' ? 0.55 : 1, heading: w.heading });
    env.stamp(tmp.x, tmp.z, w.kind === 'orca' ? 1.5 : 2.5, 0.22, 'foam');
    env.stamp(tmp.x, tmp.z, w.kind === 'orca' ? 2 : 3.5, 0.5, 'ripple');
    ctx.events.emit('wildlife:blow', { kind: w.kind, id: w.id, x: tmp.x, z: tmp.z });
  }

  function enter(w, state) {
    w.state = state;
    w.t = 0;
    if (state === 'deep') w.dur = 35 + R.next() * 75;
    if (state === 'surface') {
      w.breaths = w.breathsNext ?? 3 + Math.floor(R.next() * 4);
      w.breathsNext = null;
      w.breathDur = 9 + R.next() * 4;
      w.blown = false;
    }
    if (state === 'dive') w.dur = 8.5;
    if (state === 'breach') {
      w.dur = 7.5;
      w.splashed = false;
      w.exited = false;
      w.rollDir = R.next() < 0.5 ? -1 : 1;
      ctx.events.emit('wildlife:breach', { kind: w.kind, id: w.id, x: w.position.x, z: w.position.z, stage: 'start' });
    }
  }

  function updateHumpback(w, dt, near) {
    w.t += dt;
    const t = w.t;
    w.phase += dt * TAU * (w.state === 'deep' ? 0.12 : 0.08);
    switch (w.state) {
      case 'deep': {
        steer(w, dt);
        swim(w, 1.7, dt);
        w.position.y = damp(w.position.y, -14, 0.5, dt);
        w.pitch = damp(w.pitch, 0, 1, dt);
        w.arch = damp(w.arch, 0, 1, dt);
        w.roll = damp(w.roll, 0, 0.6, dt);
        w.amp = 0.45;
        if (t > w.dur) {
          if (w.forced) {
            const f = w.forced;
            w.forced = null;
            enter(w, f);
          } else enter(w, R.next() < env.breachChance(w) ? 'breach' : 'surface');
        }
        break;
      }
      case 'surface': {
        const u = (t % w.breathDur) / w.breathDur;
        const idx = Math.floor(t / w.breathDur);
        if (idx >= w.breaths) {
          enter(w, 'dive');
          break;
        }
        if (w.lastIdx !== idx) {
          w.lastIdx = idx;
          w.blown = false;
        }
        swim(w, 1.9, dt);
        steer(w, dt * 0.3);
        // Rise, blow, roll the back through and sink between breaths.
        const rise = smoothstep(0, 0.14, u);
        const roll = smoothstep(0.18, 0.72, u);
        const sink = smoothstep(0.62, 1, u);
        w.position.y = lerp(-4.2, -0.9, rise) - 0.9 * roll - 2.2 * sink;
        w.pitch = 0.14 * (1 - smoothstep(0.1, 0.3, u)) - 0.2 * Math.sin(Math.PI * roll) - 0.05 * sink;
        w.arch = 0.6 * Math.sin(Math.PI * clamp((u - 0.15) / 0.6, 0, 1));
        w.roll = damp(w.roll, 0.08 * Math.sin(w.seed * 20 + idx), 1, dt);
        w.amp = 0.25;
        w.pec = 0.05 * Math.sin(t * 0.5);
        if (!w.blown && u > 0.12) {
          w.blown = true;
          doBlow(w, 4.2 + 1.2 * w.seed);
        }
        break;
      }
      case 'dive': {
        const u = t / w.dur;
        swim(w, 1.6 * (1 - u * 0.5), dt, false);
        // Roll the back high, then tip steeply down so the tail stock and flukes rise clear of the water (the tips
        // ~3 m up), hang there a moment, and slide straight down.
        const a = smoothstep(0, 0.28, u);
        const b = smoothstep(0.24, 0.6, u);
        const c = smoothstep(0.68, 1, u);
        w.arch = 1.1 * a - 0.9 * b;
        w.pitch = -0.3 * a - 1.12 * b;
        w.position.y = -0.8 - 0.3 * a - 2.5 * b - 9 * c;
        w.amp = 0.15 + 0.2 * b;
        // Flukes clear the water: water streams off the trailing edge.
        if (near && u > 0.4 && u < 0.85 && Math.random() < 0.6) {
          const [fx_, fz] = fwd(w.heading);
          const tipBack = 7.2 * Math.cos(w.pitch);
          const ty = w.position.y - 7.2 * Math.sin(w.pitch) - 0.1;
          // Sheets of water streaming off the trailing edge of the raised flukes.
          const side = (Math.random() - 0.5) * 4.2;
          const rx = Math.cos(w.heading);
          const rz = Math.sin(w.heading);
          if (ty > 0.3) fx?.shed(w.position.x - fx_ * tipBack + rx * side, ty, w.position.z - fz * tipBack + rz * side, 0, -0.5, 0, 0.7, 2);
        }
        if (!w.fluked && u > 0.8) {
          w.fluked = true;
          const [fx_, fz] = fwd(w.heading);
          env.stamp(w.position.x - fx_ * 5, w.position.z - fz * 5, 7, 0.5, 'foam');
          env.stamp(w.position.x - fx_ * 5, w.position.z - fz * 5, 6, 0.6, 'ripple');
        }
        if (u >= 1) {
          w.fluked = false;
          enter(w, 'deep');
        }
        break;
      }
      case 'breach': {
        const [fx_, fz] = fwd(w.heading);
        const up = 1.2;
        let y;
        if (t < up) {
          y = lerp(-16, -5, t / up);
          w.pitch = damp(w.pitch, 1.18, 4, dt);
          w.roll = 0;
          w.amp = 1.2;
          // The rostrum breaks the surface: a burst of white water around the rising head.
          if (!w.exited && t > 0.95) {
            w.exited = true;
            const hx = w.position.x + fx_ * 1.5;
            const hz = w.position.z + fz * 1.5;
            if (near) fx?.splash(hx, 0, hz, { size: 3.2, up: 1.6 });
            env.stamp(hx, hz, 9, 0.9, 'foam');
            env.stamp(hx, hz, 5, 1, 'ripple');
          }
        } else {
          const tau = t - up;
          y = -5 + 12.2 * tau - 4.9 * tau * tau;
          w.pitch = 1.18 - 1.0 * smoothstep(0.35, 2.3, tau);
          w.roll = w.rollDir * 2.7 * smoothstep(0.05, 1.9, tau);
          w.pec = 0.9 * Math.sin(Math.min(Math.PI, tau * 1.6));
          w.amp = 0.4;
          // Water pours off the body as it clears the surface (and off the flippers at the top of the leap).
          if (near && tau < 1.5) {
            const vy = 12.2 - 9.8 * tau;
            const cp = Math.cos(w.pitch);
            const sp = Math.sin(w.pitch);
            for (let k = 0; k < 2; k++) {
              const s = Math.random() * 12 - 6;
              const py = y + s * sp;
              if (py < 0.2) continue;
              fx?.shed(w.position.x + fx_ * s * cp + (Math.random() - 0.5) * 2, py, w.position.z + fz * s * cp + (Math.random() - 0.5) * 2, fx_ * 2.2, vy, fz * 2.2, 1.6, tau < 0.6 ? 4 : 2);
            }
          }
          if (!w.splashed && tau > 1.4 && y < -0.2) {
            w.splashed = true;
            const cx = w.position.x;
            const cz = w.position.z;
            fx?.breach(cx, 0, cz, { heading: w.heading, scale: 1 });
            env.stamp(cx, cz, 22, 1, 'foam');
            env.stamp(cx + fx_ * 6, cz + fz * 6, 16, 1, 'foam');
            env.stamp(cx - fx_ * 6, cz - fz * 6, 14, 1, 'foam');
            env.stamp(cx, cz, 10, 1, 'ripple');
            env.stamp(cx, cz, 18, 1, 'ripple');
            env.stamp(cx, cz, 28, 1, 'ripple');
            ctx.events.emit('wildlife:breach', { kind: w.kind, id: w.id, x: cx, z: cz, stage: 'splash' });
          }
        }
        if (w.splashed) y = Math.max(y, lerp(-1.5, -6, smoothstep(0, 2.5, t - 3.9)));
        w.position.y = y;
        w.position.x += fx_ * 2.2 * dt;
        w.position.z += fz * 2.2 * dt;
        if (t > w.dur) {
          w.roll = 0;
          w.breathsNext = 2 + Math.floor(R.next() * 3);
          enter(w, 'surface');
        }
        break;
      }
      case 'lunge': {
        // Bubble-net lunge: rise vertically through the ring with the throat ballooning, then fall back.
        const L = w.lunge;
        const tt = t - L.delay;
        if (tt < 0) {
          w.position.set(L.x, -14, L.z);
          w.pitch = 1.35;
          break;
        }
        const up = 1.4;
        if (tt < up) {
          w.position.set(L.x, lerp(-14, -3.4, tt / up), L.z);
          w.pitch = 1.38;
          w.gulp = smoothstep(0.3, 1, tt / up);
        } else {
          const tau = tt - up;
          const y = -3.4 + 4.2 * tau - 3.2 * tau * tau;
          w.position.y = Math.max(y, -8);
          w.pitch = 1.38 - 0.9 * smoothstep(0.6, 2.2, tau);
          w.roll = L.roll * smoothstep(0.8, 2.4, tau);
          w.gulp = 1 - smoothstep(1.2, 3, tau);
          w.pec = 0.6;
          if (!L.splashed && tau > 1.5) {
            L.splashed = true;
            fx?.splash(L.x, 0, L.z, { size: 7, count: 60 });
            env.stamp(L.x, L.z, 12, 1, 'foam');
          }
          if (tau > 4) {
            w.gulp = 0;
            w.roll = 0;
            w.breathsNext = 2 + Math.floor(R.next() * 2);
            enter(w, 'surface');
          }
        }
        break;
      }
    }
  }

  // Bubble-net feeding: a ring of bubbles boils up, gulls gather, then the whales lunge up through the middle.
  const bubbleNets = [];
  function startBubbleNet(x, z, members) {
    const bn = { x, z, t: 0, members, ring: 11 + R.next() * 4, lunged: false };
    bubbleNets.push(bn);
    env.onBubbleNet?.(x, z);
    for (const w of members) {
      w.state = 'bubble';
      w.t = 0;
      w.position.set(x + (R.next() - 0.5) * 20, -12, z + (R.next() - 0.5) * 20);
    }
    ctx.events.emit('wildlife:bubbleNet', { x, z });
    return bn;
  }
  function updateBubbleNets(dt) {
    for (const bn of bubbleNets.slice()) {
      bn.t += dt;
      if (bn.t < 9) {
        // The spiral of bubbles: foam and fizz marching around the ring.
        const a0 = (bn.t / 9) * TAU * 1.1;
        for (let k = 0; k < 2; k++) {
          const a = a0 - k * 0.3;
          const px = bn.x + Math.cos(a) * bn.ring;
          const pz = bn.z + Math.sin(a) * bn.ring;
          env.stamp(px, pz, 3.2, 0.7, 'foam');
          if (Math.random() < 0.5) fx?.splash(px, 0, pz, { size: 0.35, count: 4, up: 0.5, mist: false });
        }
        for (const w of bn.members) {
          w.position.y = -12;
          w.state = 'bubble';
        }
      } else if (!bn.lunged) {
        bn.lunged = true;
        bn.members.forEach((w, i) => {
          const a = (i / bn.members.length) * TAU;
          w.lunge = { x: bn.x + Math.cos(a) * 3.5, z: bn.z + Math.sin(a) * 3.5, delay: i * 0.35, roll: (R.next() - 0.5) * 2, splashed: false };
          w.heading = a + Math.PI / 2;
          enter(w, 'lunge');
          ctx.events.emit('wildlife:breach', { kind: 'humpback', id: w.id, x: bn.x, z: bn.z, stage: 'lunge' });
        });
      } else if (bn.t > 20) bubbleNets.splice(bubbleNets.indexOf(bn), 1);
    }
  }

  // --------------------------------------------------------------------------------------------- orcas
  const pod = { members: [], active: false, t: 0, path: null, speed: 3.3, surfaceIn: 5 };
  const podMake = [
    { male: true, off: [0, 0] },
    { male: false, off: [-12, 10] },
    { male: false, off: [14, 16] },
    { male: false, off: [-4, 26], juvenile: true },
    { male: false, off: [22, 34] },
  ];
  for (const m of podMake) {
    pod.members.push({
      id: `orca-${pod.members.length}`,
      kind: 'orca',
      male: m.male,
      scale: m.juvenile ? 0.62 : 1,
      off: m.off,
      position: new THREE.Vector3(0, -40, 0),
      heading: 0,
      pitch: 0,
      roll: 0,
      arch: 0,
      phase: R.next() * TAU,
      amp: 0.25,
      state: 'away',
      breath: null,
      seed: R.next(),
    });
  }
  const orcas = pod.members;
  function podVisit(x, z, heading, { pass = 600 } = {}) {
    // A straight transit that passes `pass` metres abeam of (x, z).
    const [fx_, fz] = fwd(heading);
    const rx = Math.cos(heading);
    const rz = Math.sin(heading);
    const sx = x - fx_ * 2600 + rx * pass;
    const sz = z - fz * 2600 + rz * pass;
    pod.path = { x: sx, z: sz, heading, len: 5600 };
    pod.t = 0;
    pod.active = true;
    pod.surfaceIn = 3;
    for (const m of orcas) m.state = 'travel';
    ctx.events.emit('wildlife:orcas', { x: sx, z: sz, heading });
  }
  function updatePod(dt) {
    if (!pod.active) return;
    pod.t += dt;
    const P = pod.path;
    const s = pod.t * pod.speed;
    if (s > P.len) {
      pod.active = false;
      for (const m of orcas) m.state = 'away';
      return;
    }
    const [fx_, fz] = fwd(P.heading);
    const wob = 30 * Math.sin(s / 400);
    const cx = P.x + fx_ * s + Math.cos(P.heading) * wob;
    const cz = P.z + fz * s + Math.sin(P.heading) * wob;
    pod.surfaceIn -= dt;
    if (pod.surfaceIn < 0) {
      pod.surfaceIn = 22 + R.next() * 14;
      for (const m of orcas) m.breath = { t: -R.next() * 2.5 - (m.off[1] / 30) * 1.5, n: 2 + Math.floor(R.next() * 2), idx: 0, gap: 4 + R.next() * 2 };
    }
    for (const m of orcas) {
      const x = cx + Math.cos(P.heading) * m.off[0] - fx_ * m.off[1];
      const z = cz + Math.sin(P.heading) * m.off[0] - fz * m.off[1];
      m.position.x = x;
      m.position.z = z;
      m.heading = P.heading + 0.08 * Math.sin(pod.t * 0.3 + m.seed * 10);
      m.phase += dt * TAU * 0.35;
      let y = -4.5;
      let pitch = 0;
      let arch = 0;
      const B = m.breath;
      if (B && B.idx < B.n) {
        B.t += dt;
        const u = B.t / 2.8;
        if (u >= 0 && u <= 1) {
          // Porpoise arc: head, blow, tall fin, arched back, gone.
          y = lerp(-2.6, -0.3 * m.scale - 0.15, Math.sin(Math.PI * u));
          pitch = 0.2 * Math.cos(Math.PI * u);
          arch = 0.35 * Math.sin(Math.PI * clamp(u * 1.2 - 0.1, 0, 1));
          if (!B.blown && u > 0.18) {
            B.blown = true;
            doBlow(m, 2.2 * m.scale);
          }
        } else if (u > 1) {
          y = -2.6;
          if (B.t > 2.8 + B.gap) {
            B.idx++;
            B.t = 0;
            B.blown = false;
          }
        }
      }
      m.position.y = damp(m.position.y, y, u01(B) ? 20 : 1.2, dt);
      m.pitch = pitch;
      m.arch = arch;
    }
  }
  const u01 = (B) => B && B.idx < B.n && B.t >= 0 && B.t <= 2.8;

  // --------------------------------------------------------------------------------------------- otters
  const rafts = [];
  for (const bed of sites.otterBeds) {
    const n = 5 + Math.floor(R.next() * 18);
    const raft = { x: bed.x, z: bed.z, members: [], active: false };
    for (let i = 0; i < n; i++) {
      const a = R.next() * TAU;
      const d = Math.sqrt(R.next()) * (6 + n * 1.2);
      const o = {
        id: `otter-${others.length}`,
        kind: 'otter',
        raft,
        off: { x: Math.cos(a) * d, z: Math.sin(a) * d },
        position: new THREE.Vector3(bed.x, 0, bed.z),
        heading: R.next() * TAU,
        state: 'float',
        t: R.next() * 20,
        next: 5 + R.next() * 25,
        roll: 0,
        headPitch: 0,
        paws: 0,
        pup: R.next() < 0.18,
        seed: R.next(),
        drawn: false,
      };
      raft.members.push(o);
      others.push(o);
    }
    rafts.push(raft);
  }
  function updateRaft(raft, dt, cam, frame, near) {
    const t = ctx.time.elapsed;
    const s = ctx.systems.seiner;
    const bx = raft.x + 8 * Math.sin(t * 0.011 + raft.x);
    const bz = raft.z + 8 * Math.cos(t * 0.009 + raft.z);
    for (const o of raft.members) {
      o.t += dt;
      const x = bx + o.off.x;
      const z = bz + o.off.z;
      // A boat bearing down makes them dive.
      if (s?.position && o.state !== 'dive' && Math.abs(s.speed ?? 0) > 3 && Math.hypot(s.position.x - x, s.position.z - z) < 40) {
        o.state = 'dive';
        o.t = 0;
        o.next = 15 + R.next() * 25;
        env.stamp(x, z, 1.2, 0.6, 'ripple');
      }
      if (o.t > o.next) {
        o.t = 0;
        const u = R.next();
        o.state = o.state === 'dive' ? 'float' : u < 0.45 ? 'float' : u < 0.7 ? 'groom' : u < 0.88 ? 'eat' : 'dive';
        o.next = o.state === 'dive' ? 20 + R.next() * 35 : 4 + R.next() * 14;
        if (o.state === 'dive') env.stamp(x, z, 1, 0.5, 'ripple');
        if (o.state === 'float' && near) env.stamp(x, z, 0.8, 0.35, 'ripple');
      }
      o.position.x = x;
      o.position.z = z;
      o.position.y = near ? waterY(o, x, z, frame) : 0;
      o.heading += noise1(t * 0.05, o.seed * 77) * dt * 0.25;
      const groom = o.state === 'groom';
      o.roll = groom ? 0.9 * Math.sin(o.t * 2.2) : damp(o.roll, 0.1 * Math.sin(t * 0.8 + o.seed * 9), 2, dt);
      o.paws = o.state === 'eat' ? 0.35 * Math.sin(o.t * 7) : groom ? 0.5 * Math.sin(o.t * 5) : 0.1 * Math.sin(t + o.seed);
      o.headPitch = o.state === 'eat' ? 0.25 + 0.2 * Math.sin(o.t * 3) : 0.1 * Math.sin(t * 0.4 + o.seed * 5);
    }
  }
  function waterY(o, x, z, frame) {
    if (o.waterAt === undefined || (frame + ((o.seed * 11) | 0)) % 3 === 0) {
      o.water = env.water(x, z);
      o.waterAt = frame;
    }
    return o.water;
  }

  // --------------------------------------------------------------------------------------------- sea lions
  const haulouts = [];
  for (const h of sites.haulouts) {
    if (!h.slots.length) continue;
    const rook = h.kind === 'rookery';
    if (!rook && R.next() < 0.35) continue;
    const target = rook ? 150 : Math.min(h.slots.length * 2.5, 8 + Math.floor(R.next() * 26));
    const ho = { id: h.id, kind: h.kind, x: h.x, z: h.z, closed: h.closed ?? null, members: [], swimmers: [], active: false, alarm: 0, gone: 0, disturbedAt: -1e9, clusters: [] };
    // Sea lions pack together on a few low ledges near the water rather than spreading over the whole islet: pick
    // cluster centres from the lowest rim slots, then place animals around them without overlapping.
    const low = h.slots.slice().sort((p, q) => p.h + R.next() * 2 - (q.h + R.next() * 2));
    const nClusters = rook ? 6 : 1 + Math.floor(R.next() * 2.4);
    for (const c of low) {
      if (ho.clusters.length >= nClusters) break;
      if (ho.clusters.some((o) => Math.hypot(o.x - c.x, o.z - c.z) < (rook ? 30 : 22))) continue;
      const g = { x: 0, z: 0 };
      hm.shoreGradient(c.x, c.z, g);
      ho.clusters.push({ x: c.x, z: c.z, gx: g.x, gz: g.z });
    }
    if (ho.clusters.length) {
      ho.x = ho.clusters[0].x;
      ho.z = ho.clusters[0].z;
    }
    let tries = 0;
    while (ho.members.length < target && tries++ < target * 12 && ho.clusters.length) {
      const c = ho.clusters[Math.floor(R.next() ** 1.6 * ho.clusters.length)];
      const spread = rook ? 16 : 5 + ho.members.length * 0.25;
      const x = c.x + (R.next() + R.next() - 1) * spread;
      const z = c.z + (R.next() + R.next() - 1) * spread;
      const gh = hm.heightAt(x, z);
      if (gh < 0.3 || gh > 7) continue;
      if (rook && h.closed && Math.hypot(x - h.closed.x, z - h.closed.z) > h.closed.radius - 15) continue;
      const u = R.next();
      const bull = u < (rook ? 0.1 : 0.14);
      if (ho.members.some((o) => Math.hypot(o.home.x - x, o.home.z - z) < (bull || o.bull ? 2.8 : 1.9))) continue;
      const juv = !bull && u > 0.82;
      // Most face the water (ready to go), the rest any way.
      const seaward = headingOf(c.gx, c.gz);
      const sl = {
        id: `sealion-${others.length}`,
        kind: 'sealion',
        haulout: ho,
        bull,
        scale: bull ? 1 : juv ? 0.7 : 0.92 + R.next() * 0.16,
        position: new THREE.Vector3(x, gh, z),
        home: { x, z },
        heading: R.next() < 0.55 ? seaward + (R.next() - 0.5) * 1.6 : R.next() * TAU,
        state: 'lying',
        headPitch: 0,
        headYaw: 0,
        t: R.next() * 10,
        next: 4 + R.next() * 20,
        seed: R.next(),
        tint: juv ? [0.85, 0.8, 0.72] : [1 - 0.12 * R.next(), 1 - 0.12 * R.next(), 1 - 0.14 * R.next()],
        grounded: false,
        drawn: false,
      };
      ho.members.push(sl);
      others.push(sl);
    }
    // A few in the water around the rocks.
    const ns = rook ? 12 : 2 + Math.floor(R.next() * 4);
    for (let i = 0; i < ns; i++) {
      const sl = {
        id: `sealion-${others.length}`,
        kind: 'sealion',
        haulout: ho,
        bull: false,
        swimmer: true,
        scale: 0.9,
        position: new THREE.Vector3(h.x, -0.3, h.z),
        heading: 0,
        state: 'swimming',
        loop: { a: R.next() * TAU, r: 14 + R.next() * 30, dir: R.next() < 0.5 ? -1 : 1, speed: 1.5 + R.next() * 1.5, cx: h.x, cz: h.z },
        headPitch: 0.5,
        headYaw: 0,
        t: 0,
        seed: R.next(),
        tint: [1, 1, 1],
        drawn: false,
      };
      // Circle in open water off one of the ledges.
      const c = ho.clusters[i % Math.max(1, ho.clusters.length)] ?? { x: h.x, z: h.z, gx: 0, gz: 0 };
      sl.loop.cx = c.x + c.gx * (sl.loop.r + 12);
      sl.loop.cz = c.z + c.gz * (sl.loop.r + 12);
      if (hm.heightAt(sl.loop.cx, sl.loop.cz) > -2) continue;
      ho.swimmers.push(sl);
      others.push(sl);
    }
    if (ho.members.length || ho.swimmers.length) {
      haulouts.push(ho);
      // Consumers reading the site list (audio's sea-lion chorus) see the live colony.
      h.members = ho.members;
    }
  }
  function updateHaulout(ho, dt, frame, near) {
    const t = ctx.time.elapsed;
    const s = ctx.systems.seiner;
    // Disturbance: a boat inside the rookery buffer (or within 120 m of any haulout) sends them into the water.
    let pushed = false;
    if (s?.position) {
      const d = Math.hypot(s.position.x - ho.x, s.position.z - ho.z);
      if (ho.closed && Math.hypot(s.position.x - ho.closed.x, s.position.z - ho.closed.z) < ho.closed.radius) pushed = true;
      else if (!ho.closed && d < 120) pushed = true;
    }
    if (pushed) {
      if (ctx.time.elapsed - ho.disturbedAt > 120) ctx.events.emit('wildlife:disturbed', { kind: 'sealion', siteId: ho.id, x: ho.x, z: ho.z, closed: !!ho.closed });
      ho.disturbedAt = ctx.time.elapsed;
    }
    const stampede = ctx.time.elapsed - ho.disturbedAt < 90;
    ho.alarm = damp(ho.alarm, stampede ? 1 : 0, 0.5, dt);
    for (const sl of ho.members) {
      sl.t += dt;
      if (!sl.grounded && near) {
        sl.position.y = env.ground(sl.position.x, sl.position.z);
        const n = env.normal(sl.position.x, sl.position.z);
        const [fx_, fz] = fwd(sl.heading);
        sl.pitch = clamp(-Math.asin(clamp(n.x * fx_ + n.z * fz, -1, 1)), -0.4, 0.4);
        sl.roll = clamp(Math.asin(clamp(n.x * Math.cos(sl.heading) + n.z * Math.sin(sl.heading), -1, 1)), -0.4, 0.4);
        sl.grounded = true;
      }
      if (stampede && !sl.inWater) {
        // Rush for the water.
        if (!sl.flee) {
          const g = { x: 0, z: 0 };
          hm.shoreGradient(sl.position.x, sl.position.z, g);
          sl.flee = { gx: g.x, gz: g.z, delay: R.next() * 2.5 };
        }
        sl.flee.delay -= dt;
        if (sl.flee.delay < 0) {
          sl.heading = dampAngle(sl.heading, headingOf(sl.flee.gx, sl.flee.gz), 3, dt);
          sl.position.x += sl.flee.gx * 3.2 * dt;
          sl.position.z += sl.flee.gz * 3.2 * dt;
          const gh = hm.heightAt(sl.position.x, sl.position.z);
          sl.position.y = Math.max(gh, env.water(sl.position.x, sl.position.z) - 0.35);
          sl.headPitch = 0.4;
          if (gh < -0.4) {
            sl.inWater = true;
            fx?.splash(sl.position.x, 0, sl.position.z, { size: 1.6 * sl.scale, count: 14 });
            env.stamp(sl.position.x, sl.position.z, 3, 0.8, 'foam');
          }
        }
        continue;
      }
      if (!stampede && sl.inWater && ctx.time.elapsed - ho.disturbedAt > 150 + sl.seed * 120) {
        // Haul back out.
        sl.inWater = false;
        sl.flee = null;
        sl.position.x = sl.home.x;
        sl.position.z = sl.home.z;
        sl.grounded = false;
      }
      if (sl.inWater) continue;
      if (sl.t > sl.next) {
        sl.t = 0;
        const u = R.next();
        sl.state = u < 0.55 ? 'lying' : u < 0.85 ? 'alert' : 'roar';
        sl.next = sl.state === 'roar' ? 2 + R.next() * 3 : 5 + R.next() * 20;
        if (ho.alarm > 0.3 && sl.state === 'lying') sl.state = 'alert';
      }
      const want = sl.state === 'lying' ? 0 : sl.state === 'alert' ? 0.55 : 1.0;
      sl.headPitch = damp(sl.headPitch, want + (sl.state === 'roar' ? 0.15 * Math.sin(sl.t * 6) : 0), 2.5, dt);
      sl.headYaw = sl.state === 'lying' ? damp(sl.headYaw, 0, 1, dt) : 0.5 * noise1(t * 0.3, sl.seed * 50);
    }
    for (const sw of ho.swimmers) {
      const L = sw.loop;
      L.a += (L.dir * L.speed * dt) / L.r;
      const x = L.cx + Math.cos(L.a) * L.r;
      const z = L.cz + Math.sin(L.a) * L.r;
      const nx = L.cx + Math.cos(L.a + 0.05 * L.dir) * L.r;
      const nz = L.cz + Math.sin(L.a + 0.05 * L.dir) * L.r;
      sw.heading = headingOf(nx - x, nz - z);
      const bob = Math.sin(t * 0.6 + sw.seed * 20);
      sw.submerged = bob < -0.55;
      sw.position.set(x, (near ? waterY(sw, x, z, frame) : 0) - 0.34 - (sw.submerged ? 1.5 : 0), z);
      sw.headPitch = 0.55 + 0.15 * Math.sin(t * 1.3 + sw.seed * 7);
      sw.headYaw = 0.4 * Math.sin(t * 0.4 + sw.seed * 3);
      sw.pitch = 0;
      sw.roll = 0;
    }
  }

  // --------------------------------------------------------------------------------------------- harbor seals
  const sealGroups = [];
  const sealBeaches = sites.beaches.filter((b, i) => (i * 7919) % 5 < 2).slice(0, 10);
  for (const b of sealBeaches) {
    const grp = { x: b.x, z: b.z, members: [], active: false };
    const n = 3 + Math.floor(R.next() * 8);
    for (let i = 0; i < n; i++) {
      const along = (R.next() - 0.5) * 50;
      const inland = 1 + R.next() * 5;
      const x = b.x + Math.cos(b.along) * 0 - b.gx * inland + Math.sin(b.along) * along;
      const z = b.z - b.gz * inland - Math.cos(b.along) * along;
      const gh = hm.heightAt(x, z);
      if (gh < 0.05 || gh > 4) continue;
      const seal = {
        id: `seal-${others.length}`,
        kind: 'seal',
        position: new THREE.Vector3(x, gh, z),
        heading: headingOf(b.gx, b.gz) + Math.PI + (R.next() - 0.5) * 2,
        state: 'hauled',
        headPitch: 0.2 + R.next() * 0.3,
        tailRaise: 0.2 + R.next() * 0.3,
        seed: R.next(),
        tint: [1 - 0.15 * R.next(), 1 - 0.15 * R.next(), 1 - 0.1 * R.next()],
        grounded: false,
        drawn: false,
      };
      grp.members.push(seal);
      others.push(seal);
    }
    sealGroups.push(grp);
  }
  // Heads bottling off the stream mouths, waiting for salmon.
  for (const b of sites.bearSites) {
    if (!b.wade || R.next() < 0.45) continue;
    const grp = { x: b.wade.x, z: b.wade.z, members: [], active: false };
    const g = { x: 0, z: 0 };
    hm.shoreGradient(b.wade.x, b.wade.z, g);
    for (let i = 0; i < 1 + Math.floor(R.next() * 3); i++) {
      const d = 45 + R.next() * 70;
      const x = b.wade.x + g.x * d + (R.next() - 0.5) * 40;
      const z = b.wade.z + g.z * d + (R.next() - 0.5) * 40;
      if (hm.heightAt(x, z) > -1.5) continue;
      const seal = { id: `seal-${others.length}`, kind: 'seal', position: new THREE.Vector3(x, 0, z), home: { x, z }, heading: headingOf(-g.x, -g.z), state: 'bottling', headPitch: 0, tailRaise: 0, seed: R.next(), tint: [1, 1, 1], t: R.next() * 20, drawn: false };
      grp.members.push(seal);
      others.push(seal);
    }
    if (grp.members.length) sealGroups.push(grp);
  }
  function updateSeals(grp, dt, frame, near) {
    const t = ctx.time.elapsed;
    for (const s of grp.members) {
      if (s.state === 'bottling') {
        s.t += dt;
        // Up for a look, down for a while.
        const cyc = (s.t % 40) / 40;
        s.submerged = cyc > 0.55;
        const x = s.home.x + 3 * Math.sin(t * 0.05 + s.seed * 9);
        const z = s.home.z + 3 * Math.cos(t * 0.04 + s.seed * 7);
        s.position.set(x, (near ? waterY(s, x, z, frame) : 0) - 0.62, z);
        s.heading += noise1(t * 0.1, s.seed * 31) * dt * 0.3;
        continue;
      }
      if (!s.grounded && near) {
        s.position.y = env.ground(s.position.x, s.position.z);
        s.grounded = true;
      }
      s.headPitch = damp(s.headPitch, 0.25 + 0.25 * noise1(t * 0.1, s.seed * 20), 1, dt);
    }
  }

  // --------------------------------------------------------------------------------------------- update
  let frame = 0;
  let roamCheck = 0;
  function update(dt, cam, rangeMul = 1) {
    frame++;
    const s = ctx.systems.seiner;
    // Keep the roamer near the boat while it is out of sight.
    roamCheck -= dt;
    if (roamCheck < 0 && s?.position) {
      roamCheck = 20;
      const nearest = Math.min(...whales.filter((w) => !w.roamer).map((w) => Math.hypot(w.position.x - s.position.x, w.position.z - s.position.z)));
      const rd = Math.hypot(roamer.position.x - s.position.x, roamer.position.z - s.position.z);
      if (nearest > 2600 && rd > 3200 && roamer.state === 'deep') {
        for (let k = 0; k < 10; k++) {
          const a = R.next() * TAU;
          const d = 1200 + R.next() * 1400;
          const x = s.position.x + Math.cos(a) * d;
          const z = s.position.z + Math.sin(a) * d;
          if (hm.heightAt(x, z) < -22 && hm.shoreDistance(x, z) > 250) {
            roamer.position.set(x, -14, z);
            roamer.home = { x, z, r: 900 };
            roamer.target = { x, z };
            roamer.t = roamer.dur * 0.6;
            break;
          }
        }
      }
    }
    for (const w of whales) {
      if (w.state === 'bubble') continue;
      const d = Math.hypot(w.position.x - cam.x, w.position.z - cam.z);
      updateHumpback(w, dt, d < 1500 * rangeMul);
    }
    updateBubbleNets(dt);
    updatePod(dt);
    for (const raft of rafts) {
      const d = Math.hypot(raft.x - cam.x, raft.z - cam.z);
      raft.active = d < 1400 * rangeMul;
      if (raft.active) updateRaft(raft, dt, cam, frame, d < 450);
    }
    for (const ho of haulouts) {
      const d = Math.hypot(ho.x - cam.x, ho.z - cam.z);
      ho.active = d < 2600 * rangeMul;
      if (ho.active) updateHaulout(ho, dt, frame, d < 1500 * rangeMul);
    }
    for (const g of sealGroups) {
      const d = Math.hypot(g.x - cam.x, g.z - cam.z);
      g.active = d < 1300 * rangeMul;
      if (g.active) updateSeals(g, dt, frame, d < 500);
    }
  }

  // --------------------------------------------------------------------------------------------- render
  function render(view, sight) {
    for (const h of Object.values(H)) h.begin(view);
    for (const w of whales) {
      w.drawn = false;
      if (w.position.y < -10 || w.state === 'bubble') continue;
      const mul = H.hump.test(w.position.x, w.position.y, w.position.z, 8);
      if (!mul) continue;
      H.hump.write(w.position.x, w.position.y, w.position.z, w.heading, w.pitch, w.roll, 1, w.phase, w.amp, w.arch, w.pec, 0, 0, 0, w.gulp);
      w.drawn = true;
      if (sight && w.position.y > -3) sight('humpback', w.position, L_HUMP * 0.7);
    }
    for (const m of orcas) {
      m.drawn = false;
      if (m.state === 'away' || m.position.y < -6) continue;
      const herd = m.male ? H.orcaM : H.orcaF;
      const mul = herd.test(m.position.x, m.position.y, m.position.z, 4 * m.scale);
      if (!mul) continue;
      herd.write(m.position.x, m.position.y, m.position.z, m.heading, m.pitch, 0, m.scale, m.phase, 0.25, m.arch, 0.1, 0, 0, 0, 0);
      m.drawn = true;
      if (sight && m.position.y > -1.5) sight('orca', m.position, 6 * m.scale);
    }
    for (const raft of rafts) {
      if (!raft.active) continue;
      for (const o of raft.members) {
        o.drawn = false;
        if (o.state === 'dive') continue;
        const mul = H.otter.test(o.position.x, o.position.y, o.position.z, 0.7);
        if (!mul) continue;
        H.otter.write(o.position.x, o.position.y, o.position.z, o.heading, 0, o.roll, 1, 0, 0, 0, o.paws, o.headPitch, 0, 0, 0);
        o.drawn = true;
        if (o.pup && H.otter.test(o.position.x, o.position.y + 0.1, o.position.z, 0.3)) {
          const [fx_, fz] = fwd(o.heading);
          H.otter.write(o.position.x + fx_ * 0.12, o.position.y + 0.13, o.position.z + fz * 0.12, o.heading + 0.3, 0.05, o.roll * 0.5, 0.42, 0, 0, 0, 0.2 * Math.sin(ctx.time.elapsed * 2 + o.seed), 0.3, 0, 0, 0);
        }
        if (sight) sight('otter', o.position, 1.3);
      }
    }
    for (const ho of haulouts) {
      if (!ho.active) continue;
      for (const sl of ho.members.concat(ho.swimmers)) {
        sl.drawn = false;
        if (sl.inWater || sl.submerged) continue;
        const herd = sl.bull ? H.bull : H.cow;
        const mul = herd.test(sl.position.x, sl.position.y + 0.4, sl.position.z, 1.6 * sl.scale);
        if (!mul) continue;
        herd.write(sl.position.x, sl.position.y, sl.position.z, sl.heading, sl.pitch ?? 0, sl.roll ?? 0, sl.scale * mul, 0, 0, 0, sl.swimmer ? 0.5 : 0, sl.headPitch, sl.headYaw, 0, 0, sl.tint);
        sl.drawn = true;
        if (sight) sight('sealion', sl.position, 2.6 * sl.scale);
      }
    }
    for (const g of sealGroups) {
      if (!g.active) continue;
      for (const s of g.members) {
        s.drawn = false;
        if (s.submerged) continue;
        const mul = H.seal.test(s.position.x, s.position.y + 0.3, s.position.z, 1);
        if (!mul) continue;
        const bottling = s.state === 'bottling';
        H.seal.write(s.position.x, s.position.y, s.position.z, s.heading, bottling ? 1.3 : 0, 0, mul, 0, 0, 0, 0, bottling ? -0.4 : s.headPitch, 0, s.tailRaise, 0, s.tint);
        s.drawn = true;
        if (sight) sight('seal', s.position, 1.6);
      }
    }
    for (const h of Object.values(H)) h.end();
  }

  // --------------------------------------------------------------------------------------------- debug / staging
  function nearestWhales(x, z, n) {
    return whales
      .filter((w) => w.state !== 'lunge' && w.state !== 'bubble')
      .sort((a, b) => Math.hypot(a.position.x - x, a.position.z - z) - Math.hypot(b.position.x - x, b.position.z - z))
      .slice(0, n);
  }
  const api = {
    whales,
    orcas,
    others,
    update,
    render,
    haulouts,
    rafts,
    sealGroups,
    // Staging helpers for QA shots and events: move a whale (hidden at depth) to (x, z) and start a behaviour.
    stage(kind, x, z, heading = 0) {
      if (kind === 'orcas') {
        podVisit(x, z, heading, { pass: 0 });
        pod.t = 2600 / pod.speed - 6;
        pod.surfaceIn = 0;
        return true;
      }
      if (kind === 'blow') {
        fx?.blow(x, env.water(x, z) + 0.2, z, { height: 4.6, heading });
        return true;
      }
      if (kind === 'bubbleNet') {
        const ws = nearestWhales(x, z, 3);
        startBubbleNet(x, z, ws);
        return true;
      }
      // A whale not staged in the last half minute, so several stagings in a row use different animals.
      const now = ctx.time.elapsed;
      const w = nearestWhales(x, z, whales.length).find((c) => !(now - (c.stagedAt ?? -1e9) < 30)) ?? nearestWhales(x, z, 1)[0];
      if (!w) return false;
      w.stagedAt = now;
      w.position.set(x, -14, z);
      w.heading = heading;
      w.home = { x, z, r: 500 };
      w.range = null;
      w.target = { x: x + Math.sin(heading) * 400, z: z - Math.cos(heading) * 400 };
      if (kind === 'breach') enter(w, 'breach');
      else if (kind === 'dive') {
        w.position.y = -1;
        enter(w, 'dive');
      } else {
        w.breathsNext = 6;
        enter(w, 'surface');
        // Surface just before the first blow.
        w.t = w.breathDur * 0.08;
      }
      return w.id;
    },
    podVisit,
    get podActive() {
      return pod.active;
    },
    maybeEvents(dtHours, x, z) {
      // Rare events on the game clock: an orca pod passing through, a bubble-net group.
      if (!pod.active && R.next() < 0.035 * dtHours && hm.depthAt(x, z) > 15) podVisit(x, z, R.next() * TAU, { pass: 500 + R.next() * 700 });
      if (!bubbleNets.length && R.next() < 0.02 * dtHours) {
        const w = nearestWhales(x, z, 1)[0];
        if (w && Math.hypot(w.position.x - x, w.position.z - z) < 3500 && w.state === 'deep') startBubbleNet(w.position.x, w.position.z, nearestWhales(w.position.x, w.position.z, 3));
      }
    },
    reset() {
      pod.active = false;
      for (const m of orcas) m.state = 'away';
      bubbleNets.length = 0;
      for (const w of whales) {
        if (w.state === 'bubble' || w.state === 'lunge') enter(w, 'deep');
        w.gulp = 0;
      }
      for (const ho of haulouts) {
        ho.disturbedAt = -1e9;
        for (const sl of ho.members) {
          sl.inWater = false;
          sl.flee = null;
          sl.position.x = sl.home.x;
          sl.position.z = sl.home.z;
          sl.grounded = false;
        }
      }
    },
    herds: H,
  };
  return api;
}
