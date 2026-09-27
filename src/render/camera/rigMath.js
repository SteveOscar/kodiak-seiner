// Camera maths, DOM-free: damping, orbit placement, terrain/water clearance, occlusion pull-in, trauma shake and
// shot easing. Headings follow the world convention (0 = north / -z, clockwise).

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;

export function wrapAngle(a) {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
}

// Frame-rate independent exponential approach.
export function damp(current, target, tau, dt) {
  if (tau <= 0) return target;
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

export function dampAngle(current, target, tau, dt) {
  return current + wrapAngle(target - current) * (tau <= 0 ? 1 : 1 - Math.exp(-dt / tau));
}

// Critically damped spring (Unity's SmoothDamp). state = {v}; returns the new value.
export function smoothDamp(current, target, state, smoothTime, dt, maxSpeed = Infinity) {
  smoothTime = Math.max(1e-4, smoothTime);
  const omega = 2 / smoothTime;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  let change = current - target;
  const maxChange = maxSpeed * smoothTime;
  change = clamp(change, -maxChange, maxChange);
  const t = current - change;
  const temp = (state.v + omega * change) * dt;
  state.v = (state.v - omega * temp) * exp;
  let out = t + (change + temp) * exp;
  if (target - current > 0 === out > target) {
    out = target;
    state.v = (out - target) / dt;
  }
  return out;
}

// Camera position for an orbit: `yaw` is the direction the camera looks (world heading), pitch > 0 looks down.
export function orbitPosition(fx, fy, fz, yaw, pitch, dist, out = { x: 0, y: 0, z: 0 }) {
  const c = Math.cos(pitch);
  out.x = fx - Math.sin(yaw) * c * dist;
  out.z = fz + Math.cos(yaw) * c * dist;
  out.y = fy + Math.sin(pitch) * dist;
  return out;
}

// Heading (world convention) and pitch (positive = looking down) of the direction from a to b.
export function lookAngles(ax, ay, az, bx, by, bz) {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const h = Math.hypot(dx, dz);
  return { yaw: Math.atan2(dx, -dz), pitch: Math.atan2(-dy, h) };
}

// Fraction (0..1] of the way from the focus to the camera before terrain blocks the view (1 = clear).
export function occlusionFraction(fx, fy, fz, cx, cy, cz, groundAt, clearance = 1.5, samples = 16) {
  let clear = 1;
  for (let i = 1; i <= samples; i++) {
    const t = i / samples;
    const x = fx + (cx - fx) * t;
    const y = fy + (cy - fy) * t;
    const z = fz + (cz - fz) * t;
    if (y < groundAt(x, z) + clearance) {
      clear = Math.max(0.05, (i - 1) / samples);
      break;
    }
  }
  return clear;
}

// Smooth pseudo-noise in [-1, 1] from a few incommensurate sines (deterministic, allocation-free).
export function wobble(t, seed = 0) {
  return (
    Math.sin(t * 1.0 + seed * 1.7) * 0.5 +
    Math.sin(t * 2.31 + seed * 3.1) * 0.3 +
    Math.sin(t * 4.77 + seed * 0.3) * 0.2
  );
}

// Trauma shake: magnitude grows with trauma squared (small knocks stay subtle).
export function shakeOffsets(t, trauma, out = { yaw: 0, pitch: 0, roll: 0, y: 0 }) {
  const m = trauma * trauma;
  const f = 18;
  out.yaw = 0.035 * m * wobble(t * f, 1);
  out.pitch = 0.035 * m * wobble(t * f, 2);
  out.roll = 0.05 * m * wobble(t * f, 3);
  out.y = 0.35 * m * wobble(t * f, 4);
  return out;
}

export const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeInOutSine = (t) => -(Math.cos(Math.PI * t) - 1) / 2;

// Crow's-nest framing: height needed to keep both the seiner and a point (the skiff) in view.
export function crowsnestHeight(base, separation, fovDeg = 55, margin = 1.25) {
  const half = (fovDeg * Math.PI) / 360;
  return Math.max(base, (separation * 0.5 * margin) / Math.tan(half) + 10);
}
