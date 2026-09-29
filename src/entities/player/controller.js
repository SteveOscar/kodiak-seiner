// Character controller for the deckhand on foot, DOM-free and THREE-free (unit-tested in tests/foot.test.mjs).
//
// Kinematic walker on a heightfield: camera-relative move input, walk/run, jump with gravity, the §6.14 slope rules
// (full speed <= 35°, slowing to 50°, scrambling at 30% to 58°, sliding above), wading to knee depth only, a soft world
// boundary, and ground following that never lets the walker sink below heightAt().
//
// State s: { x, y, z, vx, vy, vz, heading, onGround, sliding, depth, slopeDeg, groundDeg, factor, airTime, landSpeed,
//            landed (true on the frame of touchdown), jumped (true on the frame of take-off), blocked, touching,
//            reverse }
// cmd:    { mx, mz (world move vector, |m| <= 1), run, jump, face? (heading to keep while moving: backing away),
//           maxSpeed? (m/s cap) }
// env:    { heightAt(x, z), dt, seaLevel = 0, boundary = 7600, colliders? (array, or (x, z, r) -> array) }
//
// Colliders (WP-PLACES / WP-TERRAIN `collidersNear`): { kind: 'circle', x, z, r, y0, y1 } or { kind: 'box', x, z, hx,
// hz, rot (heading convention), y0, y1 }. The walker is a vertical capsule of radius T.radius; it is pushed out along
// the contact normal and keeps only the velocity along the wall (slides). Obstacles whose top is within T.stepHeight
// of the feet are stepped over (a jump clears a driftwood log); ones entirely above the head are walked under.

import { FOOT_RULES, slopeSpeed, directionalSlope, gradientSlope, wadeFactor, losesFooting } from './rules.js';

export const FOOT_TUNING = Object.freeze({
  walkSpeed: 2.05, // m/s: a brisk hiking pace (the landscape is compressed ~12x horizontally)
  runSpeed: 5.3,
  accel: 9, // 1/s approach rate toward the target velocity on the ground
  decel: 11,
  airControl: 1.6,
  turnRate: 9, // 1/s facing approach rate
  jumpSpeed: 4.3, // m/s: ~0.55 m hop
  gravity: 15.5,
  slideAccel: 7.5, // m/s² along the fall line on too-steep ground
  slideFriction: 1.4,
  slideMax: 9,
  slopeBaseline: 1.5,
  boundaryPush: 3,
  radius: 0.34, // body radius against props and buildings
  height: 1.75,
  stepHeight: 0.28, // obstacles lower than this above the feet are stepped over
  colliderReach: 3, // query radius around the walker (m); a step is <= 0.53 m
});

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const approach = (v, t, rate, dt) => v + (t - v) * (1 - Math.exp(-rate * dt));
const wrap = (a) => {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
};

export function createFootState(x = 0, z = 0, heading = 0, heightAt = () => 0) {
  return {
    x,
    y: heightAt(x, z),
    z,
    vx: 0,
    vy: 0,
    vz: 0,
    heading,
    onGround: true,
    sliding: false,
    depth: 0,
    slopeDeg: 0, // along the direction of travel (+ uphill)
    groundDeg: 0, // steepest slope under the feet
    factor: 1,
    speed: 0,
    airTime: 0,
    landSpeed: 0,
    landed: false,
    jumped: false,
    blocked: false,
    boundary: false,
    touching: false, // pushed by a collider this step
    reverse: false, // moving backwards (backing away while facing something)
  };
}

export function placeFoot(s, x, z, heading, heightAt) {
  s.x = x;
  s.z = z;
  s.y = heightAt(x, z);
  s.vx = s.vy = s.vz = 0;
  if (Number.isFinite(heading)) s.heading = heading;
  s.onGround = true;
  s.sliding = false;
  s.airTime = 0;
  s.speed = 0;
  return s;
}

const grad = { deg: 0, dx: 0, dz: 0 };

// Can the walker stand at (x, z)? Water deeper than the knee is not walkable.
export function standable(heightAt, x, z, seaLevel = 0, rules = FOOT_RULES) {
  return seaLevel - heightAt(x, z) <= rules.kneeDepth;
}

// ---------------------------------------------------------------- colliders
const finite = Number.isFinite;

// Does collider c stand in the way of a walker whose feet are at feetY (vertical overlap with the body, above a step)?
export function blocksWalker(c, feetY, T = FOOT_TUNING) {
  const y0 = finite(c.y0) ? c.y0 : -Infinity;
  const y1 = finite(c.y1) ? c.y1 : Infinity;
  return y1 > feetY + T.stepHeight && y0 < feetY + T.height;
}

// 2D overlap of a disc (px, pz, r) with collider c. Returns false when clear; otherwise fills out with the outward unit
// normal (nx, nz) and the depth to push along it. Boxes: local x = right (cos rot, sin rot), local z = back
// (-sin rot, cos rot), i.e. the heading convention with rotation.y = -rot.
export function colliderContact(c, px, pz, r, out = { nx: 0, nz: 0, depth: 0 }) {
  if (!c || !finite(c.x) || !finite(c.z)) return false;
  if (c.kind === 'circle') {
    const min = (finite(c.r) ? c.r : 0) + r;
    const dx = px - c.x;
    const dz = pz - c.z;
    const d2 = dx * dx + dz * dz;
    if (d2 >= min * min) return false;
    const d = Math.sqrt(d2);
    if (d > 1e-6) {
      out.nx = dx / d;
      out.nz = dz / d;
    } else {
      out.nx = 1;
      out.nz = 0;
    }
    out.depth = min - d;
    return true;
  }
  if (c.kind === 'box') {
    const rot = finite(c.rot) ? c.rot : 0;
    const cs = Math.cos(rot);
    const sn = Math.sin(rot);
    const hx = finite(c.hx) ? c.hx : 0;
    const hz = finite(c.hz) ? c.hz : 0;
    const dx = px - c.x;
    const dz = pz - c.z;
    if (dx * dx + dz * dz > (hx + hz + r) ** 2) return false;
    const lx = dx * cs + dz * sn;
    const lz = -dx * sn + dz * cs;
    const ox = lx - clamp(lx, -hx, hx);
    const oz = lz - clamp(lz, -hz, hz);
    const od = Math.hypot(ox, oz);
    let nlx;
    let nlz;
    if (od > 1e-9) {
      if (od >= r) return false;
      nlx = ox / od;
      nlz = oz / od;
      out.depth = r - od;
    } else {
      // Centre inside the footprint: out through the nearest face.
      const px_ = hx - Math.abs(lx);
      const pz_ = hz - Math.abs(lz);
      if (px_ < pz_) {
        nlx = lx >= 0 ? 1 : -1;
        nlz = 0;
        out.depth = px_ + r;
      } else {
        nlx = 0;
        nlz = lz >= 0 ? 1 : -1;
        out.depth = pz_ + r;
      }
    }
    out.nx = nlx * cs - nlz * sn;
    out.nz = nlx * sn + nlz * cs;
    return true;
  }
  return false;
}

const contact = { nx: 0, nz: 0, depth: 0 };

// Pushes the point (x, z) out of every blocking collider (a few passes for corners) and removes the velocity component
// into each contact (s.vx/vz slide along the wall). Returns true when anything was touched; the result is in res.
export function pushOut(s, x, z, list, T = FOOT_TUNING, res = { x: 0, z: 0 }) {
  let hit = false;
  for (let pass = 0; pass < 4; pass++) {
    let any = false;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!c || !blocksWalker(c, s.y, T) || !colliderContact(c, x, z, T.radius, contact)) continue;
      x += contact.nx * (contact.depth + 1e-4);
      z += contact.nz * (contact.depth + 1e-4);
      const vn = s.vx * contact.nx + s.vz * contact.nz;
      if (vn < 0) {
        s.vx -= vn * contact.nx;
        s.vz -= vn * contact.nz;
      }
      any = true;
      hit = true;
    }
    if (!any) break;
  }
  res.x = x;
  res.z = z;
  return hit;
}

// True when the disc at (x, z) still overlaps a blocking collider.
export function inCollider(s, x, z, list, T = FOOT_TUNING) {
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c && blocksWalker(c, s.y, T) && colliderContact(c, x, z, T.radius - 0.02, contact)) return true;
  }
  return false;
}

const EMPTY = Object.freeze([]);
function collidersOf(env, x, z, T) {
  const c = env.colliders;
  if (!c) return EMPTY;
  if (typeof c === 'function') return c(x, z, T.colliderReach) ?? EMPTY;
  return Array.isArray(c) ? c : EMPTY;
}
const pushRes = { x: 0, z: 0 };

export function stepFoot(s, cmd, env, T = FOOT_TUNING, rules = FOOT_RULES) {
  const dt = Math.min(env.dt ?? 0, 0.1);
  s.landed = false;
  s.jumped = false;
  s.blocked = false;
  s.boundary = false;
  s.touching = false;
  s.reverse = false;
  if (!(dt > 0)) return s;
  const heightAt = env.heightAt;
  const sea = env.seaLevel ?? 0;
  const B = env.boundary ?? 7600;

  let mx = cmd?.mx ?? 0;
  let mz = cmd?.mz ?? 0;
  const mlen = Math.hypot(mx, mz);
  if (mlen > 1) {
    mx /= mlen;
    mz /= mlen;
  }
  const moving = mlen > 0.05;
  const ux = moving ? mx / Math.max(mlen, 1e-6) : Math.sin(s.heading);
  const uz = moving ? mz / Math.max(mlen, 1e-6) : -Math.cos(s.heading);

  gradientSlope(heightAt, s.x, s.z, T.slopeBaseline, grad);
  s.groundDeg = grad.deg;
  const slope = directionalSlope(heightAt, s.x, s.z, ux, uz, T.slopeBaseline);
  s.slopeDeg = slope;
  if (s.onGround) {
    if (!s.sliding && losesFooting(grad.deg, slope, moving, rules)) s.sliding = true;
    else if (s.sliding && grad.deg < rules.slideExitDeg) s.sliding = false;
  }

  s.depth = Math.max(0, sea - heightAt(s.x, s.z));
  const wade = Math.max(wadeFactor(s.depth, rules), s.depth > rules.kneeDepth ? 0.35 : 0);
  // Downhill is a little kinder than uphill at the same angle (careful descent rather than a climb).
  const slopeFactor = slopeSpeed(slope > 0 ? slope : slope * 0.92, rules);
  const base = cmd?.run ? T.runSpeed : T.walkSpeed;
  s.factor = slopeFactor * wade;

  if (s.onGround && s.sliding) {
    // Too steep to stand: accelerate down the fall line; input only nudges sideways.
    // Velocity split along the fall line (dx, dz) and across it (-dz, dx).
    const along = Math.max(0, s.vx * grad.dx + s.vz * grad.dz);
    const across = s.vx * -grad.dz + s.vz * grad.dx;
    const acc = Math.max(0.6, T.slideAccel * Math.sin((grad.deg * Math.PI) / 180) - T.slideFriction);
    const nv = Math.min(T.slideMax, along + acc * dt);
    const want = moving ? (mx * -grad.dz + mz * grad.dx) * 1.2 : 0;
    const ns = approach(across, want, 4, dt);
    s.vx = grad.dx * nv - grad.dz * ns;
    s.vz = grad.dz * nv + grad.dx * ns;
  } else {
    let target = moving ? base * Math.min(1, mlen) * s.factor : 0;
    if (finite(cmd?.maxSpeed)) target = Math.min(target, cmd.maxSpeed);
    const tx = ux * target;
    const tz = uz * target;
    const rate = s.onGround ? (target > Math.hypot(s.vx, s.vz) ? T.accel : T.decel) : T.airControl;
    s.vx = approach(s.vx, tx, rate, dt);
    s.vz = approach(s.vz, tz, rate, dt);
  }

  // Soft world boundary.
  if (Math.abs(s.x) > B) {
    s.vx += -Math.sign(s.x) * T.boundaryPush * (1 + (Math.abs(s.x) - B) * 0.05) * dt * 10;
    s.boundary = true;
  }
  if (Math.abs(s.z) > B) {
    s.vz += -Math.sign(s.z) * T.boundaryPush * (1 + (Math.abs(s.z) - B) * 0.05) * dt * 10;
    s.boundary = true;
  }

  // Horizontal move; never into water deeper than the knee (deflect along the waterline instead).
  let nx = s.x + s.vx * dt;
  let nz = s.z + s.vz * dt;
  const curDepth = sea - heightAt(s.x, s.z);
  const tooDeep = (x, z) => {
    const d = sea - heightAt(x, z);
    return d > rules.kneeDepth && d > curDepth - 1e-4;
  };
  if (tooDeep(nx, nz)) {
    s.blocked = true;
    const vx = s.vx;
    const vz = s.vz;
    const sp = Math.hypot(vx, vz);
    let found = false;
    if (sp > 1e-4) {
      for (const ang of [0.5, -0.5, 1.0, -1.0, 1.4, -1.4]) {
        const c = Math.cos(ang);
        const sn = Math.sin(ang);
        const k = Math.cos(ang);
        const rx = (vx * c - vz * sn) * k;
        const rz = (vx * sn + vz * c) * k;
        const px = s.x + rx * dt;
        const pz = s.z + rz * dt;
        if (!tooDeep(px, pz)) {
          nx = px;
          nz = pz;
          s.vx = rx;
          s.vz = rz;
          found = true;
          break;
        }
      }
    }
    if (!found) {
      nx = s.x;
      nz = s.z;
      s.vx = 0;
      s.vz = 0;
    }
  }

  // Props, buildings, floats: sub-stepped so a fast slide cannot tunnel through a thin wall.
  const list = collidersOf(env, s.x, s.z, T);
  if (list.length) {
    const mdx = nx - s.x;
    const mdz = nz - s.z;
    const n = Math.min(6, Math.max(1, Math.ceil(Math.hypot(mdx, mdz) / 0.25)));
    let cx = s.x;
    let cz = s.z;
    let hit = false;
    for (let k = 0; k < n; k++) {
      // After a contact the remaining sub-moves follow the slid velocity.
      cx += hit ? (s.vx * dt) / n : mdx / n;
      cz += hit ? (s.vz * dt) / n : mdz / n;
      if (pushOut(s, cx, cz, list, T, pushRes)) hit = true;
      cx = pushRes.x;
      cz = pushRes.z;
    }
    if (hit) {
      s.touching = true;
      // Wedged (a gap narrower than the body) or pushed out into deep water: stay put.
      if ((inCollider(s, cx, cz, list, T) && !inCollider(s, s.x, s.z, list, T)) || tooDeep(cx, cz)) {
        cx = s.x;
        cz = s.z;
        s.vx = 0;
        s.vz = 0;
      }
      nx = cx;
      nz = cz;
    }
  }
  s.x = nx;
  s.z = nz;

  // Vertical.
  const g = heightAt(s.x, s.z);
  if (s.onGround && cmd?.jump && !s.sliding && s.depth < rules.kneeDepth * 0.9) {
    s.vy = T.jumpSpeed * (s.depth > rules.wadeStart ? 0.75 : 1);
    s.onGround = false;
    s.jumped = true;
    s.airTime = 0;
    s.y = Math.max(s.y, g);
  }
  if (s.onGround) {
    s.y = g;
    s.vy = 0;
  } else {
    s.airTime += dt;
    s.vy -= T.gravity * dt;
    s.y += s.vy * dt;
    if (s.y <= g) {
      s.landSpeed = -s.vy;
      s.y = g;
      s.vy = 0;
      s.onGround = true;
      s.landed = true;
    }
  }
  if (s.y < g) s.y = g;

  s.speed = Math.hypot(s.vx, s.vz);
  // Face the direction of travel (or of the slide), or a held facing while backing away.
  const facing = moving && !s.sliding && finite(cmd?.face);
  if (s.speed > 0.15 || moving) {
    const want = s.sliding && s.speed > 0.5 ? Math.atan2(s.vx, -s.vz) : facing ? cmd.face : moving ? Math.atan2(mx, -mz) : Math.atan2(s.vx, -s.vz);
    s.heading = wrap(s.heading + wrap(want - s.heading) * (1 - Math.exp(-T.turnRate * dt)));
  }
  // Moving against the facing (backing away): the gait runs in reverse.
  s.reverse = facing && s.speed > 0.05 && s.vx * Math.sin(s.heading) - s.vz * Math.cos(s.heading) < 0;
  s.depth = Math.max(0, sea - g);
  return s;
}

export { clamp, wrap };
