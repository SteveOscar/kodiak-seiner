// Displacement-hull handling for the seiner (and, with other tunings, the skiff). Pure maths: no THREE, no DOM.
//
// Heading: 0 = north (-z), clockwise positive. forward = (sin h, -cos h); right = (cos h, sin h).
// Roll > 0 = heeled to starboard (right side down); pitch > 0 = bow up.
//
// stepHull(state, cmd, env, dt, tuning) advances one step and returns an array of events ({type: 'ground'|'boat',
// speed, x, z}). The caller samples the water and fills env.wave; everything else is plain numbers and callbacks, so
// tests drive it with synthetic seas and seabeds.

export const SEINER_TUNING = Object.freeze({
  length: 17.7,
  beam: 6.2,
  accelTau: 5.5, // s, 63% of the way to a higher target speed
  coastTau: 11, // s, throttle eased back / neutral
  brakeTau: 3.0, // s, engine astern against headway
  limitTau: 2.2, // s, above an owner speed limit
  holdTau: 0.9, // s, moored to a dock
  turnRate: 0.45, // rad/s at full rudder with way on
  wayOn: 3.5, // m/s for full rudder authority
  yawTau: 0.95, // s
  rudderRate: 2.4, // per second toward hard over
  rudderReturn: 3.2, // per second back to midships when released
  kickTurn: 0.42, // extra authority from prop wash when throttling ahead at low speed
  propWalk: 0.045, // rad/s bow-to-starboard when backing (right-handed wheel)
  sideslip: 0.22, // lateral slip in turns (m/s per (rad/s * m/s))
  heelPerTurn: 0.024, // steady outboard heel (rad per rad/s * m/s)
  heelMax: 0.16,
  squat: 0.034, // bow-up trim at full speed (rad)
  accelPitch: 0.012, // bow-up per m/s^2
  rollPeriod: 5.2, // s, natural roll period
  rollDamping: 0.32,
  pitchPeriod: 3.6,
  pitchDamping: 0.55,
  heavePeriod: 2.6,
  heaveDamping: 0.6,
  waveFollow: 0.85, // how much of the sampled wave slope the hull adopts
  leeway: 0.035, // fraction of wind speed as drift at rest
  driftTau: 3.5,
  groundingDepth: 2.2,
  bumpSpeed: 0.7, // m/s: slower contacts don't emit a collision
  boundary: 7600,
  boundaryHard: 7950,
  boundaryPush: 0.05, // m/s of push per metre past the boundary
  anchorScope: 26, // m of rode from the bow to the anchor
  anchorYawTau: 7,
});

export function createHullState(x = 0, z = 0, heading = 0) {
  return {
    x,
    z,
    heading,
    speed: 0, // m/s through the water along the heading (negative = astern)
    sway: 0, // m/s lateral slip (positive = to starboard)
    yawRate: 0,
    rudder: 0, // -1..1 (positive = starboard)
    driftX: 0, // m/s ground drift (current + leeway)
    driftZ: 0,
    vx: 0, // m/s ground velocity (world)
    vz: 0,
    accel: 0, // m/s^2 along the heading, smoothed
    roll: 0,
    rollVel: 0,
    pitch: 0,
    pitchVel: 0,
    heave: 0,
    heaveVel: 0,
    engineLoad: 0,
    grounded: false,
    groundContact: 0, // seconds in contact
    groundX: 0, // where the last contact happened (grounded clears only after backing well away)
    groundZ: 0,
    groundCooldown: 0,
    beyondBoundary: false,
    bump: 0, // decaying bump impulse for camera/FX
  };
}

export function resetMotion(s) {
  s.speed = s.sway = s.yawRate = s.driftX = s.driftZ = s.vx = s.vz = s.accel = 0;
  s.rollVel = s.pitchVel = s.heaveVel = 0;
  s.grounded = false;
  s.groundContact = 0;
  s.bump = 0;
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const approach = (v, target, tau, dt) => v + (target - v) * (1 - Math.exp(-dt / Math.max(1e-4, tau)));
export const wrapAngle = (a) => {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
};

// Damped spring toward target; period in seconds, zeta = damping ratio. Semi-implicit Euler.
export function springStep(pos, vel, target, period, zeta, dt) {
  const w = (2 * Math.PI) / period;
  const acc = w * w * (target - pos) - 2 * zeta * w * vel;
  vel += acc * dt;
  pos += vel * dt;
  return [pos, vel];
}

// Half extent of an ellipse (semi-axes a along forward, b across) in a direction at angle theta from forward.
export function hullExtent(a, b, theta) {
  const c = Math.cos(theta) / a;
  const s = Math.sin(theta) / b;
  return 1 / Math.sqrt(c * c + s * s);
}

// Speed the throttle asks for, after the owner speed limit.
export function targetSpeed(throttle, maxSpeed, reverseSpeed, speedLimit) {
  let t = throttle >= 0 ? throttle * maxSpeed : throttle * reverseSpeed;
  if (speedLimit !== null && speedLimit !== undefined) t = clamp(t, -Math.min(reverseSpeed, speedLimit), speedLimit);
  return t;
}

// Rudder authority multiplier for a given speed and throttle (way on, prop wash, reversed when going astern).
export function rudderAuthority(speed, throttle, tuning) {
  const way = clamp(Math.abs(speed) / tuning.wayOn, 0, 1);
  const kick = Math.max(0, throttle) * (1 - clamp(Math.abs(speed) / 6, 0, 1)) * tuning.kickTurn;
  const fast = 1 - 0.3 * clamp((Math.abs(speed) - 8) / 4, 0, 1);
  if (speed < -0.3) return -0.55 * way + kick;
  return way * fast + kick;
}

// Closest points between segments p1-q1 and p2-q2 (2D). Returns squared distance and the points.
export function segmentDistance(p1x, p1z, q1x, q1z, p2x, p2z, q2x, q2z, out = {}) {
  const d1x = q1x - p1x;
  const d1z = q1z - p1z;
  const d2x = q2x - p2x;
  const d2z = q2z - p2z;
  const rx = p1x - p2x;
  const rz = p1z - p2z;
  const a = d1x * d1x + d1z * d1z;
  const e = d2x * d2x + d2z * d2z;
  const f = d2x * rx + d2z * rz;
  let s;
  let t;
  if (a <= 1e-9 && e <= 1e-9) {
    s = t = 0;
  } else if (a <= 1e-9) {
    s = 0;
    t = clamp(f / e, 0, 1);
  } else {
    const c = d1x * rx + d1z * rz;
    if (e <= 1e-9) {
      t = 0;
      s = clamp(-c / a, 0, 1);
    } else {
      const b = d1x * d2x + d1z * d2z;
      const denom = a * e - b * b;
      s = denom > 1e-9 ? clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp(-c / a, 0, 1);
      } else if (t > 1) {
        t = 1;
        s = clamp((b - c) / a, 0, 1);
      }
    }
  }
  out.ax = p1x + d1x * s;
  out.az = p1z + d1z * s;
  out.bx = p2x + d2x * t;
  out.bz = p2z + d2z * t;
  const dx = out.ax - out.bx;
  const dz = out.az - out.bz;
  out.d2 = dx * dx + dz * dz;
  return out;
}

const segTmp = {};

// cmd: { throttle -1..1 (effective, after locks), steer -1..1, maxSpeed, reverseSpeed, speedLimit|null,
//        held (dock), anchor: {x, z}|null, external: {x, z}|null (tow velocity, m/s) }
// env: { current {x, z}, wind {x, z} (m/s, toward), depthAt(x, z), shoreGradient?(x, z, out),
//        wave {heave, pitch, roll} (sampled targets), obstacles [{x, z, heading, halfLength, radius}] }
export function stepHull(s, cmd, env, dt, T = SEINER_TUNING) {
  const events = [];
  if (!(dt > 0)) return events;
  dt = Math.min(dt, 0.1);

  // Rudder follows the helm at a finite rate and returns to midships when released.
  const steer = clamp(cmd.steer ?? 0, -1, 1);
  if (Math.abs(steer) > 0.01) {
    const d = steer - s.rudder;
    s.rudder += clamp(d, -T.rudderRate * dt, T.rudderRate * dt);
  } else {
    s.rudder -= clamp(s.rudder, -T.rudderReturn * dt, T.rudderReturn * dt);
  }

  const throttle = clamp(cmd.throttle ?? 0, -1, 1);
  const prevSpeed = s.speed;
  if (cmd.held) {
    s.speed = approach(s.speed, 0, T.holdTau, dt);
  } else {
    const limit = cmd.speedLimit ?? null;
    const tgt = targetSpeed(throttle, cmd.maxSpeed ?? 12, cmd.reverseSpeed ?? 3, limit);
    let tau;
    const sameDir = Math.sign(tgt) === Math.sign(s.speed) || Math.abs(s.speed) < 0.05;
    if (sameDir && Math.abs(tgt) > Math.abs(s.speed)) tau = T.accelTau;
    else if (!sameDir && Math.abs(tgt) > 0.05) tau = T.brakeTau;
    else tau = T.coastTau;
    if (limit !== null && Math.abs(s.speed) > limit + 0.05) tau = Math.min(tau, T.limitTau);
    s.speed = approach(s.speed, tgt, tau, dt);
  }
  s.accel = approach(s.accel, (s.speed - prevSpeed) / dt, 0.4, dt);

  // Yaw: the rudder needs way on; prop wash gives a kick at low speed; backing walks the stern to port.
  let yawTarget = s.rudder * T.turnRate * rudderAuthority(s.speed, throttle, T);
  if (throttle < -0.05) yawTarget += T.propWalk * -throttle * (1 - clamp(Math.abs(s.speed) / 4, 0, 1));
  if (cmd.held) yawTarget = 0;
  s.yawRate = approach(s.yawRate, yawTarget, T.yawTau, dt);

  // Anchored: bow tethered to the anchor. The hull weathervanes bow-into the stream (and wind) on its own, since the
  // anchor holds the bow while the stern is set down-current; a taut rode also pulls the bow toward the anchor.
  const fx0 = Math.sin(s.heading);
  const fz0 = -Math.cos(s.heading);
  const cur = env.current ?? { x: 0, z: 0 };
  const wind = env.wind ?? { x: 0, z: 0 };
  if (cmd.anchor) {
    const half = T.length * 0.45;
    const bx = s.x + fx0 * half;
    const bz = s.z + fz0 * half;
    const dist = Math.hypot(cmd.anchor.x - bx, cmd.anchor.z - bz);
    let yawWant = 0;
    if (dist > T.anchorScope * 0.6) {
      const want = Math.atan2(cmd.anchor.x - s.x, -(cmd.anchor.z - s.z));
      const taut = clamp((dist - T.anchorScope * 0.6) / (T.anchorScope * 0.4), 0, 1);
      yawWant += (wrapAngle(want - s.heading) / T.anchorYawTau) * taut * 2.5;
    }
    const setX = cur.x + wind.x * T.leeway;
    const setZ = cur.z + wind.z * T.leeway;
    const set = Math.hypot(setX, setZ);
    if (set > 0.02) {
      const into = Math.atan2(-setX, setZ);
      yawWant += (wrapAngle(into - s.heading) / T.anchorYawTau) * clamp(set / 0.25, 0, 1);
    }
    s.yawRate = approach(s.yawRate, clamp(yawWant, -0.12, 0.12), 1.5, dt);
  }
  s.heading = wrapAngle(s.heading + s.yawRate * dt);

  // Lateral slip in turns (stern skids outboard).
  const swayTarget = cmd.held ? 0 : -T.sideslip * s.yawRate * Math.abs(s.speed);
  s.sway = approach(s.sway, swayTarget, 1.0, dt);

  // Drift: the tidal stream carries the hull at any speed; wind leeway matters when slow.
  const lee = T.leeway * (1 - clamp(Math.abs(s.speed) / 5, 0, 1));
  const tdx = cmd.held ? 0 : cur.x + wind.x * lee;
  const tdz = cmd.held ? 0 : cur.z + wind.z * lee;
  s.driftX = approach(s.driftX, tdx, T.driftTau, dt);
  s.driftZ = approach(s.driftZ, tdz, T.driftTau, dt);

  const fx = Math.sin(s.heading);
  const fz = -Math.cos(s.heading);
  const rx = Math.cos(s.heading);
  const rz = Math.sin(s.heading);
  let vx = fx * s.speed + rx * s.sway + s.driftX;
  let vz = fz * s.speed + rz * s.sway + s.driftZ;
  if (cmd.external) {
    vx += cmd.external.x;
    vz += cmd.external.z;
  }

  // Soft world boundary.
  s.beyondBoundary = false;
  for (const axis of ['x', 'z']) {
    const p = s[axis];
    const over = Math.abs(p) - T.boundary;
    if (over > 0) {
      s.beyondBoundary = true;
      const push = Math.min(3, over * T.boundaryPush) * -Math.sign(p);
      if (axis === 'x') vx += push;
      else vz += push;
    }
  }

  let dispX = vx * dt;
  let dispZ = vz * dt;

  // Grounding: probe the hull end in the direction of travel. Moving toward deeper water is always allowed, so a
  // boat placed in the shallows can back or drift out.
  const moveLen = Math.hypot(dispX, dispZ);
  const depthAt = env.depthAt;
  if (depthAt && moveLen > 1e-6) {
    const dirX = dispX / moveLen;
    const dirZ = dispZ / moveLen;
    const theta = Math.atan2(dirX * rx + dirZ * rz, dirX * fx + dirZ * fz);
    const ext = hullExtent(T.length * 0.5, T.beam * 0.5, theta) * 0.92;
    const px = s.x + dirX * ext;
    const pz = s.z + dirZ * ext;
    const dNow = depthAt(px, pz);
    const dNext = depthAt(px + dispX, pz + dispZ);
    const blocked = dNext < T.groundingDepth && dNext < dNow - 1e-4;
    if (blocked) {
      const along = s.speed * (dirX * fx + dirZ * fz);
      const impact = Math.abs(vx * dirX + vz * dirZ);
      if (!s.grounded && impact > T.bumpSpeed && s.groundCooldown <= 0) {
        events.push({ type: 'ground', speed: impact, x: px, z: pz });
        s.groundCooldown = 2.5;
        s.bump = Math.min(1, impact / 6);
        s.pitchVel += (along >= 0 ? 1 : -1) * Math.min(0.25, impact * 0.035);
        s.rollVel += (Math.random() - 0.5) * impact * 0.02;
      }
      s.grounded = true;
      s.groundX = s.x;
      s.groundZ = s.z;
      // Slide along the shore instead of sticking when there is a tangent to follow.
      if (env.shoreGradient) {
        const g = env.shoreGradient(px, pz, { x: 0, z: 0 });
        const into = dispX * g.x + dispZ * g.z;
        if (into < 0) {
          dispX -= into * g.x;
          dispZ -= into * g.z;
        }
        const d2 = depthAt(px + dispX, pz + dispZ);
        if (d2 < T.groundingDepth && d2 < dNow - 1e-4) {
          dispX = 0;
          dispZ = 0;
        }
      } else {
        dispX = 0;
        dispZ = 0;
      }
      // Kill headway into the bank; a little bounce back on hard hits.
      if (along !== 0 && Math.sign(s.speed) === Math.sign(along)) s.speed = impact > 3 ? -0.08 * s.speed : 0;
      s.sway *= 0.3;
      s.driftX *= 0.5;
      s.driftZ *= 0.5;
      s.groundContact += dt;
    } else {
      const probe = depthAt(s.x + fx * T.length * 0.46, s.z + fz * T.length * 0.46);
      const probeAft = depthAt(s.x - fx * T.length * 0.46, s.z - fz * T.length * 0.46);
      const away = Math.hypot(s.x - s.groundX, s.z - s.groundZ) > 2.5;
      if (probe >= T.groundingDepth && probeAft >= T.groundingDepth && (!s.grounded || away)) {
        s.grounded = false;
        s.groundContact = 0;
      }
    }
  }

  // Circle/capsule collisions with tenders and fleet boats.
  const obstacles = env.obstacles;
  if (obstacles && obstacles.length) {
    const half = T.length * 0.5 - T.beam * 0.5;
    for (const o of obstacles) {
      const nx = s.x + dispX;
      const nz = s.z + dispZ;
      const reach = half + T.beam * 0.5 + o.halfLength + o.radius + 2;
      if (Math.abs(o.x - nx) > reach || Math.abs(o.z - nz) > reach) continue;
      const ofx = Math.sin(o.heading ?? 0);
      const ofz = -Math.cos(o.heading ?? 0);
      const oh = o.halfLength ?? 0;
      segmentDistance(
        nx - fx * half, nz - fz * half, nx + fx * half, nz + fz * half,
        o.x - ofx * oh, o.z - ofz * oh, o.x + ofx * oh, o.z + ofz * oh,
        segTmp,
      );
      const minD = T.beam * 0.5 + o.radius;
      if (segTmp.d2 < minD * minD) {
        const d = Math.sqrt(segTmp.d2) || 1e-3;
        const nX = (segTmp.ax - segTmp.bx) / d;
        const nZ = (segTmp.az - segTmp.bz) / d;
        const pen = minD - d;
        dispX += nX * pen;
        dispZ += nZ * pen;
        const vn = vx * nX + vz * nZ;
        if (vn < 0) {
          if (-vn > T.bumpSpeed && !o._touching) {
            events.push({ type: 'boat', speed: -vn, x: segTmp.bx, z: segTmp.bz, id: o.id });
            s.bump = Math.min(1, -vn / 6);
            s.rollVel += (nX * rx + nZ * rz) * Math.min(0.08, -vn * 0.02);
          }
          const along = nX * fx + nZ * fz;
          s.speed -= along * vn * 0.9;
          s.sway -= (nX * rx + nZ * rz) * vn * 0.9;
        }
        o._touching = true;
      } else {
        o._touching = false;
      }
    }
  }

  s.x += dispX;
  s.z += dispZ;
  s.groundCooldown = Math.max(0, s.groundCooldown - dt);

  // The anchor rode holds the bow within scope of the anchor.
  if (cmd.anchor) {
    const half = T.length * 0.45;
    const hx = Math.sin(s.heading);
    const hz = -Math.cos(s.heading);
    const dx = s.x + hx * half - cmd.anchor.x;
    const dz = s.z + hz * half - cmd.anchor.z;
    const dist = Math.hypot(dx, dz);
    if (dist > T.anchorScope) {
      const nx = dx / dist;
      const nz = dz / dist;
      const corr = dist - T.anchorScope;
      s.x -= nx * corr;
      s.z -= nz * corr;
      dispX -= nx * corr;
      dispZ -= nz * corr;
      const out = s.driftX * nx + s.driftZ * nz;
      if (out > 0) {
        s.driftX -= out * nx;
        s.driftZ -= out * nz;
      }
    }
  }
  const hard = T.boundaryHard;
  s.x = clamp(s.x, -hard, hard);
  s.z = clamp(s.z, -hard, hard);
  s.vx = dispX / dt;
  s.vz = dispZ / dt;

  // Attitude: springs toward the sea surface plus turn heel and speed trim.
  const wave = env.wave ?? { heave: 0, pitch: 0, roll: 0 };
  const heelTarget = clamp(-T.heelPerTurn * s.yawRate * Math.abs(s.speed), -T.heelMax, T.heelMax);
  const trim = T.squat * Math.pow(clamp(Math.abs(s.speed) / 12, 0, 1), 1.5) * Math.sign(s.speed || 1) + T.accelPitch * clamp(s.accel, -2, 2);
  [s.roll, s.rollVel] = springStep(s.roll, s.rollVel, wave.roll * T.waveFollow + heelTarget, T.rollPeriod, T.rollDamping, dt);
  [s.pitch, s.pitchVel] = springStep(s.pitch, s.pitchVel, wave.pitch * T.waveFollow + trim, T.pitchPeriod, T.pitchDamping, dt);
  [s.heave, s.heaveVel] = springStep(s.heave, s.heaveVel, wave.heave, T.heavePeriod, T.heaveDamping, dt);
  s.roll = clamp(s.roll, -0.45, 0.45);
  s.pitch = clamp(s.pitch, -0.3, 0.3);

  // Engine load: how hard the diesel is working (throttle, plus a surge while accelerating).
  const loadTarget = cmd.held ? 0 : clamp(Math.pow(Math.abs(throttle), 1.25) * (1 + 0.15 * clamp(Math.abs(s.accel), 0, 1)), 0, 1);
  s.engineLoad = approach(s.engineLoad, loadTarget, 0.8, dt);
  s.bump = Math.max(0, s.bump - dt * 1.5);
  return events;
}

// Plane fit of sampled water heights at hull points: bow/stern/port/starboard (+ centre). Returns targets for the
// attitude springs. Heights in metres; length/beam in metres.
export function waveAttitude(hBow, hStern, hPort, hStb, hMid, length, beam, out = { heave: 0, pitch: 0, roll: 0 }) {
  out.heave = (hBow + hStern + hPort + hStb + 2 * hMid) / 6;
  out.pitch = Math.atan2(hBow - hStern, length);
  out.roll = Math.atan2(hPort - hStb, beam);
  return out;
}
