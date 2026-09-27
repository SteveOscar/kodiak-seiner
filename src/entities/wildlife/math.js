// Small pure helpers shared by the wildlife modules (no THREE, no DOM).

export const TAU = Math.PI * 2;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
// Frame-rate independent exponential approach.
export const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));
export const wrapAngle = (a) => {
  a %= TAU;
  if (a > Math.PI) a -= TAU;
  else if (a < -Math.PI) a += TAU;
  return a;
};
export const dampAngle = (a, b, rate, dt) => a + wrapAngle(b - a) * (1 - Math.exp(-rate * dt));
// Heading convention (SPEC §3): 0 = north (-z), clockwise positive; forward = (sin h, -cos h).
export const headingOf = (dx, dz) => Math.atan2(dx, -dz);

// Stable 32-bit hash of a string or number, and a [0, 1) value from it.
export function hash32(v) {
  let h = 2166136261;
  const s = String(v);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return h >>> 0;
}
export const hash01 = (v) => hash32(v) / 4294967296;

// Smooth 1D value noise in [-1, 1] (cheap wander for flight paths and grazing walks).
export function noise1(x, seed = 0) {
  const i = Math.floor(x);
  const f = x - i;
  const a = hash01(i * 7919 + seed * 104729) * 2 - 1;
  const b = hash01((i + 1) * 7919 + seed * 104729) * 2 - 1;
  const u = f * f * (3 - 2 * f);
  return a + (b - a) * u;
}

// Writes a column-major 4x4 matrix (THREE.Matrix4 layout) into `out` at `o`: translation (x, y, z), rotation
// Ry(-heading) * Rx(pitch) * Rz(roll) for a model facing -z, uniform scale s. Positive pitch lifts the nose; positive
// roll lifts the right (+x) side.
export function composeMatrix(out, o, x, y, z, heading, pitch, roll, s) {
  const a = -heading;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const cb = Math.cos(pitch);
  const sb = Math.sin(pitch);
  const cc = Math.cos(roll);
  const sc = Math.sin(roll);
  out[o] = (ca * cc + sa * sb * sc) * s;
  out[o + 1] = cb * sc * s;
  out[o + 2] = (-sa * cc + ca * sb * sc) * s;
  out[o + 3] = 0;
  out[o + 4] = (-ca * sc + sa * sb * cc) * s;
  out[o + 5] = cb * cc * s;
  out[o + 6] = (sa * sc + ca * sb * cc) * s;
  out[o + 7] = 0;
  out[o + 8] = sa * cb * s;
  out[o + 9] = -sb * s;
  out[o + 10] = ca * cb * s;
  out[o + 11] = 0;
  out[o + 12] = x;
  out[o + 13] = y;
  out[o + 14] = z;
  out[o + 15] = 1;
  return out;
}

// Projected size in CSS pixels of an object of `size` metres at `dist` metres (projScale = viewport height / 2 /
// tan(fov / 2)).
export const pixelSize = (size, dist, projScale) => (size * projScale) / Math.max(dist, 0.01);

// Point in circle list (closed areas, etc.).
export function inAnyCircle(x, z, circles, pad = 0) {
  for (const c of circles) {
    const r = (c.radius ?? 0) + pad;
    if ((x - c.x) ** 2 + (z - c.z) ** 2 < r * r) return c;
  }
  return null;
}
