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

// Foot camera clearance for things that are not terrain (foliage, props, a hull): `blocked(x, y, z)` says whether a
// point is inside one. Samples beyond `minT` metres along the orbit ray (the thicket the person stands in is allowed);
// first tries lifting the view (up to `maxPitch`) so the ray passes over the obstacle, else returns the fraction of
// the distance to pull in to. Returns out = { pitch, frac }.
export function clearOrbit(fx, fy, fz, yaw, pitch, dist, blocked, { minT = 2.2, maxPitch = 1.0, step = 0.12, samples = 6 } = {}, out = { pitch: 0, frac: 1 }) {
  const firstHit = (p) => {
    const c = Math.cos(p);
    const sx = -Math.sin(yaw) * c;
    const sz = Math.cos(yaw) * c;
    const sy = Math.sin(p);
    for (let i = 1; i <= samples; i++) {
      const t = (i / samples) * dist;
      if (t < minT && i < samples) continue;
      if (blocked(fx + sx * t, fy + sy * t, fz + sz * t)) return i;
    }
    return 0;
  };
  out.pitch = pitch;
  out.frac = 1;
  const hit0 = firstHit(pitch);
  if (!hit0) return out;
  for (let p = pitch + step; p <= Math.max(pitch, maxPitch) + 1e-6; p += step) {
    if (!firstHit(p)) {
      out.pitch = p;
      return out;
    }
  }
  out.frac = Math.max(0.05, (hit0 - 1) / samples);
  return out;
}

// Whether (x, y, z) lies inside a collider: { kind: 'circle', x, z, r, y0, y1 } or { kind: 'box', x, z, hx, hz,
// rot (heading convention), y0, y1 }, grown by `pad` metres.
export function insideCollider(c, x, y, z, pad = 0.3) {
  if (!c) return false;
  if (Number.isFinite(c.y0) && y < c.y0 - pad) return false;
  if (Number.isFinite(c.y1) && y > c.y1 + pad) return false;
  const dx = x - c.x;
  const dz = z - c.z;
  if (c.kind === 'box') {
    const h = c.rot ?? 0;
    // Box axes: local x along the right (cos h, sin h), local z along the back (-sin h, cos h).
    const lx = dx * Math.cos(h) + dz * Math.sin(h);
    const lz = -dx * Math.sin(h) + dz * Math.cos(h);
    return Math.abs(lx) <= (c.hx ?? 0) + pad && Math.abs(lz) <= (c.hz ?? 0) + pad;
  }
  const r = (c.r ?? 0) + pad;
  return dx * dx + dz * dz <= r * r;
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

// Height ceiling for the auto-framed crow's nest: under the weather's cloud deck and the mist banks that hang from
// ~120 m, and never so high that the corkline turns into a thread.
export function crowsnestCeiling(cloudBase, max = 115, min = 45) {
  const deck = Number.isFinite(cloudBase) ? cloudBase - 20 : max;
  return clamp(Math.min(max, deck), min, max);
}

// Crow's-nest pose that fits a ground box (`across` = width across the view, `along` = depth along it, metres) into
// the part of the screen the HUD leaves clear (`bottomUse` / `topUse`: fraction of the half-height used below / above
// the centre), under a height ceiling. An oblique view covers much more ground above the centre than below, so the
// box is placed by solving for the near and far edges rather than centring it. Starts from `pitch` (down-look, rad)
// and `fovDeg`; when the fit would climb above `ceiling` it tilts toward the horizon (down to `minPitch`), then widens
// the fov (up to `maxFov`), and finally accepts the ceiling. `floor` is the least height (the player's zoom).
// Returns { dist (slant, camera to the look point), pitch, fov, height, shift } where `shift` is how far the look
// point sits along the view from the box centre (negative = nearer the camera).
export function crowsnestFrame({
  across, along, pitch = 0.9, fovDeg = 55, aspect = 16 / 9, ceiling = 115, floor = 35,
  minPitch = 0.52, maxFov = 70, margin = 1.15, bottomUse = 0.6, topUse = 0.8,
}, out = { dist: 0, pitch: 0, fov: 0, height: 0, shift: 0 }) {
  // A player who zoomed out past the ceiling keeps their height.
  const cap = Math.max(ceiling, floor);
  const A = Math.max(0, along) * margin;
  const W = Math.max(0, across) * margin;
  const bands = (p, f) => {
    const tv = Math.tan((f * Math.PI) / 360);
    const aBot = Math.atan(bottomUse * tv);
    const aTop = Math.atan(topUse * tv);
    const cotNear = 1 / Math.tan(Math.min(1.5, p + aBot));
    const cotFar = 1 / Math.tan(Math.max(0.03, p - aTop));
    return { tv, aBot, aTop, cotNear, cotFar };
  };
  const need = (p, f) => {
    const b = bands(p, f);
    const hA = A / Math.max(1e-3, b.cotFar - b.cotNear);
    // The width must fit at the band's middle, where the box centre sits (nearer is narrower, further wider).
    const hW = (W * 0.5 * Math.sin(Math.min(1.5, p + (b.aBot - b.aTop) / 2))) / (b.tv * aspect);
    return Math.max(hA, hW, floor);
  };
  let p = pitch;
  let f = fovDeg;
  let h = need(p, f);
  if (h > cap && pitch > minPitch) {
    // Height needed grows with the pitch, so bisect for the steepest pitch under the ceiling.
    let a = minPitch;
    let b = pitch;
    if (need(a, f) <= cap) {
      for (let i = 0; i < 14; i++) {
        const m = (a + b) / 2;
        if (need(m, f) <= cap) a = m;
        else b = m;
      }
    }
    p = a;
    h = need(p, f);
  }
  if (h > cap && maxFov > f) {
    let a = f;
    let b = maxFov;
    if (need(p, b) > cap) a = b;
    else {
      for (let i = 0; i < 14; i++) {
        const m = (a + b) / 2;
        if (need(p, m) <= cap) b = m;
        else a = m;
      }
      a = b;
    }
    f = a;
    h = need(p, f);
  }
  h = Math.min(h, cap);
  // Camera along-position relative to the box centre: the box centre mid-band, then nudged so its edges stay inside.
  const bd = bands(p, f);
  const cotMid = 1 / Math.tan(p + (bd.aBot - bd.aTop) / 2);
  let xc = -h * cotMid;
  if (xc + h * bd.cotNear > -A / 2) xc = -A / 2 - h * bd.cotNear;
  else if (xc + h * bd.cotFar < A / 2) xc = A / 2 - h * bd.cotFar;
  out.pitch = p;
  out.fov = f;
  out.height = h;
  out.dist = h / Math.sin(p);
  out.shift = xc + h / Math.tan(p);
  return out;
}
