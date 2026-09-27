// Planar geometry helpers for the seine (DOM-free). Polygons are arrays of {x, z}.

export function pointInPolygon(x, z, poly) {
  if (!poly || poly.length < 3) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

export function polygonArea(poly) {
  if (!poly || poly.length < 3) return 0;
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j].x * poly[i].z - poly[i].x * poly[j].z;
  return Math.abs(a) / 2;
}

export function polygonCentroid(poly, out = { x: 0, z: 0 }) {
  let sx = 0;
  let sz = 0;
  for (const p of poly) {
    sx += p.x;
    sz += p.z;
  }
  out.x = poly.length ? sx / poly.length : 0;
  out.z = poly.length ? sz / poly.length : 0;
  return out;
}

// Distance from (px, pz) to segment a-b, plus the parameter t of the closest point.
export function segmentDistance(px, pz, ax, az, bx, bz, out = { d: 0, t: 0 }) {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  out.t = t;
  out.d = Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
  return out;
}

// Smallest distance from (px, pz) to the polyline through xs/zs[from..to] (inclusive indices).
export function polylineDistance(px, pz, xs, zs, from, to) {
  let best = Infinity;
  const s = { d: 0, t: 0 };
  for (let i = Math.max(0, from); i < to; i++) {
    segmentDistance(px, pz, xs[i], zs[i], xs[i + 1], zs[i + 1], s);
    if (s.d < best) best = s.d;
  }
  return best;
}

// Area of the largest circle a corkline of `length` metres can enclose.
export function maxCircleArea(length) {
  return (length * length) / (4 * Math.PI);
}
