// 2D geometry on the water plane (x, z) for the fish/net model. Pure, allocation-light, no THREE.

import { pointInPolygon } from '../../data/places.js';

export { pointInPolygon };

export function polygonArea(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j].x * poly[i].z - poly[i].x * poly[j].z;
  return Math.abs(a) * 0.5;
}

export function polygonCentroid(poly, out = { x: 0, z: 0 }) {
  let a = 0;
  let cx = 0;
  let cz = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const f = poly[j].x * poly[i].z - poly[i].x * poly[j].z;
    a += f;
    cx += (poly[j].x + poly[i].x) * f;
    cz += (poly[j].z + poly[i].z) * f;
  }
  if (Math.abs(a) < 1e-6) {
    let sx = 0;
    let sz = 0;
    for (const p of poly) {
      sx += p.x;
      sz += p.z;
    }
    out.x = sx / Math.max(1, poly.length);
    out.z = sz / Math.max(1, poly.length);
    return out;
  }
  out.x = cx / (3 * a);
  out.z = cz / (3 * a);
  return out;
}

export function polygonBounds(poly, out = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 }) {
  out.minX = out.minZ = Infinity;
  out.maxX = out.maxZ = -Infinity;
  for (const p of poly) {
    if (p.x < out.minX) out.minX = p.x;
    if (p.x > out.maxX) out.maxX = p.x;
    if (p.z < out.minZ) out.minZ = p.z;
    if (p.z > out.maxZ) out.maxZ = p.z;
  }
  return out;
}

// Closest point on segment ab to p. Returns squared distance; writes the point and the segment parameter to out.
export function closestOnSegment(px, pz, ax, az, bx, bz, out) {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 1e-9 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + dx * t;
  const cz = az + dz * t;
  if (out) {
    out.x = cx;
    out.z = cz;
    out.t = t;
  }
  return (px - cx) * (px - cx) + (pz - cz) * (pz - cz);
}

// Nearest point on the polygon boundary. skipEdge = index i of the edge (poly[i] → poly[i+1]) to ignore (the open
// gap). Returns { x, z, edge, d } in out.
export function nearestOnBoundary(px, pz, poly, skipEdge = -1, out = { x: 0, z: 0, edge: -1, d: Infinity, t: 0 }) {
  const tmp = { x: 0, z: 0, t: 0 };
  out.d = Infinity;
  out.edge = -1;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    if (i === skipEdge) continue;
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const d2 = closestOnSegment(px, pz, a.x, a.z, b.x, b.z, tmp);
    if (d2 < out.d) {
      out.d = d2;
      out.x = tmp.x;
      out.z = tmp.z;
      out.t = tmp.t;
      out.edge = i;
    }
  }
  out.d = Math.sqrt(out.d);
  return out;
}

// Index of the polygon edge that best matches the gap segment {a, b}, or -1.
export function findGapEdge(poly, gap) {
  if (!gap || !gap.a || !gap.b || poly.length < 3) return -1;
  let best = -1;
  let bestErr = Infinity;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    const e1 = Math.hypot(p.x - gap.a.x, p.z - gap.a.z) + Math.hypot(q.x - gap.b.x, q.z - gap.b.z);
    const e2 = Math.hypot(p.x - gap.b.x, p.z - gap.b.z) + Math.hypot(q.x - gap.a.x, q.z - gap.a.z);
    const e = Math.min(e1, e2);
    if (e < bestErr) {
      bestErr = e;
      best = i;
    }
  }
  const width = Math.hypot(gap.b.x - gap.a.x, gap.b.z - gap.a.z);
  return bestErr < Math.max(4, width * 0.5) ? best : -1;
}

const RING = [];
for (let i = 0; i < 12; i++) RING.push([Math.cos((i / 12) * Math.PI * 2), Math.sin((i / 12) * Math.PI * 2)]);

// Fraction of a school disc (centre, radius) inside the polygon: centre + 12 points at 0.45 r + 12 points at 0.85 r,
// area-weighted. Cheap and stable enough for close-up bookkeeping.
export function discInsideFraction(x, z, r, poly) {
  let w = 0;
  let inside = 0;
  const add = (px, pz, weight) => {
    w += weight;
    if (pointInPolygon(px, pz, poly)) inside += weight;
  };
  add(x, z, 1);
  for (const [c, s] of RING) add(x + c * r * 0.45, z + s * r * 0.45, 1.2);
  for (const [c, s] of RING) add(x + c * r * 0.85, z + s * r * 0.85, 2.1);
  return inside / w;
}

// Ellipse approximating a polygon (second moments of its vertices, scaled to match the area).
// → { x, z, angle (of the major axis, radians in the x/z plane from +x toward +z), a, b }.
export function fitEllipse(poly, out = { x: 0, z: 0, angle: 0, a: 1, b: 1 }) {
  const c = polygonCentroid(poly);
  let sxx = 0;
  let szz = 0;
  let sxz = 0;
  for (const p of poly) {
    const dx = p.x - c.x;
    const dz = p.z - c.z;
    sxx += dx * dx;
    szz += dz * dz;
    sxz += dx * dz;
  }
  const n = Math.max(1, poly.length);
  sxx /= n;
  szz /= n;
  sxz /= n;
  const tr = sxx + szz;
  const det = sxx * szz - sxz * sxz;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc;
  const l2 = Math.max(1e-6, tr / 2 - disc);
  const angle = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  const ratio = Math.sqrt(l2 / Math.max(l1, 1e-6));
  const area = polygonArea(poly);
  const a = Math.sqrt(area / (Math.PI * Math.max(ratio, 0.05)));
  out.x = c.x;
  out.z = c.z;
  out.angle = angle;
  out.a = a;
  out.b = a * Math.max(ratio, 0.05);
  return out;
}

// Signed side of point p relative to the directed segment a→b (+ left of travel in x/z with −z north).
export const sideOf = (px, pz, ax, az, bx, bz) => (bx - ax) * (pz - az) - (bz - az) * (px - ax);

// Do segments p0→p1 and a→b properly intersect?
export function segmentsIntersect(p0x, p0z, p1x, p1z, ax, az, bx, bz) {
  const d1 = sideOf(ax, az, p0x, p0z, p1x, p1z);
  const d2 = sideOf(bx, bz, p0x, p0z, p1x, p1z);
  const d3 = sideOf(p0x, p0z, ax, az, bx, bz);
  const d4 = sideOf(p1x, p1z, ax, az, bx, bz);
  return d1 * d2 < 0 && d3 * d4 < 0;
}
