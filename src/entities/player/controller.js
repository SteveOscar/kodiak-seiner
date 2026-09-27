// Character controller for the deckhand on foot, DOM-free and THREE-free (unit-tested in tests/foot.test.mjs).
//
// Kinematic walker on a heightfield: camera-relative move input, walk/run, jump with gravity, the §6.14 slope rules
// (full speed <= 35°, slowing to 50°, scrambling at 30% to 58°, sliding above), wading to knee depth only, a soft world
// boundary, and ground following that never lets the walker sink below heightAt().
//
// State s: { x, y, z, vx, vy, vz, heading, onGround, sliding, depth, slopeDeg, groundDeg, factor, airTime, landSpeed,
//            landed (true on the frame of touchdown), jumped (true on the frame of take-off), blocked }
// cmd:    { mx, mz (world move vector, |m| <= 1), run, jump }
// env:    { heightAt(x, z), dt, seaLevel = 0, boundary = 7600 }

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

export function stepFoot(s, cmd, env, T = FOOT_TUNING, rules = FOOT_RULES) {
  const dt = Math.min(env.dt ?? 0, 0.1);
  s.landed = false;
  s.jumped = false;
  s.blocked = false;
  s.boundary = false;
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
    const target = moving ? base * Math.min(1, mlen) * s.factor : 0;
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
  // Face the direction of travel (or of the slide).
  if (s.speed > 0.15 || moving) {
    const want = s.sliding && s.speed > 0.5 ? Math.atan2(s.vx, -s.vz) : moving ? Math.atan2(mx, -mz) : Math.atan2(s.vx, -s.vz);
    s.heading = wrap(s.heading + wrap(want - s.heading) * (1 - Math.exp(-T.turnRate * dt)));
  }
  s.depth = Math.max(0, sea - g);
  return s;
}

export { clamp, wrap };
