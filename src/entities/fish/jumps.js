// Jump choreography: builds a jump (one or more ballistic arcs, coho tail-walks, king rolls) from a species signature
// and evaluates the fish pose along it. Pure; the renderer turns poses into instance matrices and the FX events
// (exit, entry, walk spray, apex) into splashes, ripples and glints.

import { JUMP_STYLES, FISH_LENGTH } from './species.js';

export const G = 9.81;
export const MAX_JUMP_DEVIATION = (25 * Math.PI) / 180;
const SUB = 0.3; // body-centre depth at launch and re-entry (m)

const lerp = (a, b, t) => a + (b - a) * t;
const range = (rng, [a, b]) => a + (b - a) * rng.next();
const clampTo = (h, centre, dev) => {
  let d = h - centre;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return centre + Math.max(-dev, Math.min(dev, d));
};

// → jump { id, schoolId, species, style, t0, dur, heading, size, splash, segs[], events[], x, z, surfaceY }
// opts: { id, schoolId, species, styleKey (default species), x, z, surfaceY, heading (school heading), free (true =
// heading not bound to the school), now, rng, sizeScale }
export function createJump(opts) {
  const { rng } = opts;
  const species = opts.species;
  const key = opts.styleKey ?? species;
  const S = JUMP_STYLES[key] ?? JUMP_STYLES.pink;
  const size = (FISH_LENGTH[species] ?? 0.6) * (opts.sizeScale ?? 1) * (0.9 + 0.2 * rng.next());
  const k = size / 0.6; // bigger fish jump a little higher and longer
  const centre = opts.heading ?? 0;
  let heading = opts.free ? rng.next() * Math.PI * 2 : centre + (rng.next() * 2 - 1) * MAX_JUMP_DEVIATION * 0.92;
  const arcs = Math.max(1, Math.round(range(rng, S.arcs)));
  const segs = [];
  const events = [];
  let t = 0;
  let x = opts.x;
  let z = opts.z;
  const surfaceY = opts.surfaceY ?? 0;
  for (let i = 0; i < arcs; i++) {
    const fade = S.style === 'popcorn' ? (i === 0 ? 1 : 0.6) : S.style === 'tailwalk' ? 1 - 0.18 * i : 1;
    const h = range(rng, S.height) * Math.sqrt(k) * fade;
    const len = range(rng, S.length) * k * fade;
    const dx = Math.sin(heading);
    const dz = -Math.cos(heading);
    if (S.style === 'roll') {
      const dur = 1.25 + 0.4 * rng.next();
      segs.push({ kind: 'roll', t0: t, dur, x0: x, z0: z, dx, dz, len, h });
      events.push({ t: t + dur * 0.3, kind: 'exit', x: x + dx * len * 0.3, z: z + dz * len * 0.3, strength: 0.5 * S.splash });
      events.push({ t: t + dur * 0.5, kind: 'apex', x: x + dx * len * 0.5, z: z + dz * len * 0.5, strength: 0.6 });
      events.push({ t: t + dur * 0.72, kind: 'entry', x: x + dx * len * 0.72, z: z + dz * len * 0.72, strength: 0.7 * S.splash });
      x += dx * len;
      z += dz * len;
      t += dur;
    } else {
      const vy0 = Math.sqrt(2 * G * (h + SUB));
      const dur = (2 * vy0) / G;
      const twist = range(rng, S.twist) * (rng.next() < 0.5 ? -1 : 1);
      const flopDir = rng.next() < 0.5 ? -1 : 1;
      const roll0 = segs.length ? segs[segs.length - 1].roll1 ?? 0 : 0;
      const seg = { kind: 'arc', t0: t, dur, x0: x, z0: z, dx, dz, len, h, vy0, roll0, roll1: roll0 + twist * Math.PI, flop: S.flop, flopDir, pitchK: S.pitch };
      segs.push(seg);
      const tExit = dur * 0.1;
      events.push({ t: t + tExit, kind: 'exit', x: x + dx * len * 0.1, z: z + dz * len * 0.1, strength: (i === 0 ? 0.45 : 0.3) * S.splash });
      events.push({ t: t + dur * 0.5, kind: 'apex', x: x + dx * len * 0.5, z: z + dz * len * 0.5, strength: 1 });
      events.push({ t: t + dur * 0.9, kind: 'entry', x: x + dx * len * 0.9, z: z + dz * len * 0.9, strength: S.splash * (0.8 + 0.4 * rng.next()) * (1 + 0.5 * (h > 0.9 ? 1 : 0)) });
      x += dx * len;
      z += dz * len;
      t += dur;
    }
    if (i < arcs - 1) {
      if (S.style === 'tailwalk') {
        const dur = range(rng, S.walk);
        const wh = heading;
        segs.push({ kind: 'walk', t0: t, dur, x0: x, z0: z, dx: Math.sin(wh), dz: -Math.cos(wh), speed: 1.2 + 0.5 * rng.next(), size });
        for (let w = 0.04; w < dur; w += 0.075) {
          const d = (1.2 + 0.5 * rng.next()) * w;
          events.push({ t: t + w, kind: 'walk', x: x + Math.sin(wh) * d, z: z - Math.cos(wh) * d, strength: 0.35 });
        }
        x += Math.sin(wh) * segs[segs.length - 1].speed * dur;
        z += -Math.cos(wh) * segs[segs.length - 1].speed * dur;
        t += dur;
      } else {
        const gap = 0.12 + 0.2 * rng.next();
        segs.push({ kind: 'under', t0: t, dur: gap, x0: x, z0: z, dx, dz });
        t += gap;
      }
      if (!opts.free) heading = clampTo(heading + (rng.next() * 2 - 1) * 0.1, centre, MAX_JUMP_DEVIATION * 0.92);
    }
  }
  events.sort((a, b) => a.t - b.t);
  return {
    id: opts.id ?? 0,
    schoolId: opts.schoolId ?? null,
    species,
    style: S.style,
    t0: opts.now ?? 0,
    dur: t,
    heading: segs[0]?.dx !== undefined ? Math.atan2(segs[0].dx, -segs[0].dz) : heading,
    size,
    splash: S.splash,
    x: opts.x,
    z: opts.z,
    surfaceY,
    segs,
    events,
    nextEvent: 0,
    hump: opts.hump ?? 0,
    seed: rng.next(),
  };
}

// Pose at jump-local time t (0..dur). out: { x, y, z, heading, pitch, roll, bend, beatHz, beatAmp, airborne }.
export function jumpPose(j, t, out = {}) {
  let seg = j.segs[j.segs.length - 1];
  for (const s of j.segs) {
    if (t < s.t0 + s.dur) {
      seg = s;
      break;
    }
  }
  const u = Math.max(0, Math.min(seg.dur, t - seg.t0));
  const f = seg.dur > 0 ? u / seg.dur : 1;
  out.heading = Math.atan2(seg.dx, -seg.dz);
  out.bend = 0;
  out.roll = 0;
  out.pitch = 0;
  out.beatHz = 8;
  out.beatAmp = 0.5;
  out.airborne = false;
  if (seg.kind === 'arc') {
    const d = seg.len * f;
    out.x = seg.x0 + seg.dx * d;
    out.z = seg.z0 + seg.dz * d;
    const vy = seg.vy0 - G * u;
    out.y = j.surfaceY - SUB + seg.vy0 * u - 0.5 * G * u * u;
    const vh = seg.len / Math.max(1e-3, seg.dur);
    let pitch = Math.atan2(vy, vh) * seg.pitchK;
    let roll = lerp(seg.roll0, seg.roll1, f);
    if (seg.flop > 0) {
      // Chum: rises nose-first, then falls over onto its side and lands flat.
      const fall = Math.max(0, Math.min(1, (f - 0.42) / 0.4));
      const e = fall * fall * (3 - 2 * fall) * seg.flop;
      roll += seg.flopDir * (Math.PI / 2) * e;
      pitch *= 1 - 0.85 * e;
    }
    out.pitch = pitch;
    out.roll = roll;
    out.bend = 0.22 * Math.sin(2 * Math.PI * (2.6 * u + j.seed));
    out.beatHz = 10;
    out.beatAmp = 0.55;
    out.airborne = out.y > j.surfaceY - 0.1;
  } else if (seg.kind === 'walk') {
    const d = seg.speed * u;
    const side = 0.12 * Math.sin(2 * Math.PI * 1.7 * u);
    out.x = seg.x0 + seg.dx * d - seg.dz * side;
    out.z = seg.z0 + seg.dz * d + seg.dx * side;
    out.y = j.surfaceY + 0.2 * (seg.size / 0.66) + 0.04 * Math.sin(2 * Math.PI * 6.5 * u);
    out.pitch = 1.05 + 0.12 * Math.sin(2 * Math.PI * 3.1 * u);
    out.roll = 0.35 * Math.sin(2 * Math.PI * 2.3 * u);
    out.bend = 0.18 * Math.sin(2 * Math.PI * 4.0 * u);
    out.beatHz = 14;
    out.beatAmp = 1.25;
    out.airborne = true;
  } else if (seg.kind === 'roll') {
    const d = seg.len * f;
    out.x = seg.x0 + seg.dx * d;
    out.z = seg.z0 + seg.dz * d;
    out.y = j.surfaceY - 0.32 + (seg.h + 0.32) * Math.sin(Math.PI * f);
    out.pitch = 0.45 * Math.cos(Math.PI * f);
    out.beatHz = 2.5;
    out.beatAmp = 0.5;
    out.airborne = out.y > j.surfaceY - 0.2;
  } else {
    out.x = seg.x0;
    out.z = seg.z0;
    out.y = j.surfaceY - SUB - 0.1;
    out.airborne = false;
  }
  return out;
}

// Collects the FX events whose time lies in (tPrev, tNow] (jump-local seconds); advances j.nextEvent.
export function dueEvents(j, tNow, out = []) {
  out.length = 0;
  while (j.nextEvent < j.events.length && j.events[j.nextEvent].t <= tNow) out.push(j.events[j.nextEvent++]);
  return out;
}
