// Small boats (the skiff) steering around the seiner's hull, DOM-free. The hull is a capsule along its heading; when
// the straight run to a target would cross it, the next waypoint comes from a shortest path over a few nodes around
// the hull (quarters, shoulders, dead astern, dead ahead). Called every step, so it follows a swinging or moving hull
// and drops back to the direct run as soon as that clears.

import { segmentDistance } from './handling.js';

const seg = {};

// hull: { x, z, heading, halfLength (stem/transom from the centre), halfBeam }. Distance from a point to the hull
// capsule's surface (negative inside).
export function hullClearance(px, pz, hull) {
  const fx = Math.sin(hull.heading);
  const fz = -Math.cos(hull.heading);
  const a = Math.max(0, hull.halfLength - hull.halfBeam);
  segmentDistance(px, pz, px, pz, hull.x - fx * a, hull.z - fz * a, hull.x + fx * a, hull.z + fz * a, seg);
  return Math.sqrt(seg.d2) - hull.halfBeam;
}

function segmentClear(ax, az, bx, bz, hull, margin) {
  const fx = Math.sin(hull.heading);
  const fz = -Math.cos(hull.heading);
  const a = Math.max(0, hull.halfLength - hull.halfBeam);
  segmentDistance(ax, az, bx, bz, hull.x - fx * a, hull.z - fz * a, hull.x + fx * a, hull.z + fz * a, seg);
  return Math.sqrt(seg.d2) - hull.halfBeam >= margin;
}

// Next point to steer for on the way from (px, pz) to (tx, tz) around `hull`, or null when the straight run clears it
// by `margin`. An endpoint that itself lies close to the hull (a target alongside the quarter) only needs the run to
// stay as clear as that endpoint. `state` ({ side }) keeps the chosen side between calls so the route does not flip
// when both ways are about equal. out = { x, z, side }.
export function hullWaypoint(px, pz, tx, tz, hull, { margin = 2.4, abeam = 6, beyond = 4.5, state = null } = {}, out = { x: 0, z: 0, side: 0 }) {
  if (!hull) return null;
  const dP = hullClearance(px, pz, hull);
  const dT = hullClearance(tx, tz, hull);
  const mP = Math.min(margin, dP - 0.3);
  const mT = Math.min(margin, dT - 0.3);
  if (segmentClear(px, pz, tx, tz, hull, Math.min(mP, mT))) {
    if (state) state.side = 0;
    return null;
  }
  const fx = Math.sin(hull.heading);
  const fz = -Math.cos(hull.heading);
  const rx = Math.cos(hull.heading);
  const rz = Math.sin(hull.heading);
  const L = hull.halfLength + beyond;
  const W = hull.halfBeam + abeam;
  // Nodes: 0 = start, 1 = target, then (u along the bow, v to starboard, side).
  const local = [
    [-L * 0.95, W, 1], [L * 0.95, W, 1], [0, W * 1.05, 1],
    [-L * 0.95, -W, -1], [L * 0.95, -W, -1], [0, -W * 1.05, -1],
    [-L - 1.5, 0, 0], [L + 1.5, 0, 0],
  ];
  const n = local.length + 2;
  const nx = new Array(n);
  const nz = new Array(n);
  const side = new Array(n);
  nx[0] = px;
  nz[0] = pz;
  nx[1] = tx;
  nz[1] = tz;
  side[0] = side[1] = 0;
  for (let i = 0; i < local.length; i++) {
    const [u, v, s] = local[i];
    nx[i + 2] = hull.x + fx * u + rx * v;
    nz[i + 2] = hull.z + fz * u + rz * v;
    side[i + 2] = s;
  }
  const keep = state?.side ?? 0;
  const dist = new Array(n).fill(Infinity);
  const prev = new Array(n).fill(-1);
  const done = new Array(n).fill(false);
  dist[0] = 0;
  for (let iter = 0; iter < n; iter++) {
    let i = -1;
    for (let k = 0; k < n; k++) if (!done[k] && dist[k] < Infinity && (i < 0 || dist[k] < dist[i])) i = k;
    if (i < 0 || i === 1) break;
    done[i] = true;
    for (let j = 1; j < n; j++) {
      if (done[j] || j === i) continue;
      let m = margin;
      if (i === 0) m = Math.min(m, mP);
      if (j === 1) m = Math.min(m, mT);
      if (!segmentClear(nx[i], nz[i], nx[j], nz[j], hull, m)) continue;
      // Changing sides mid-route costs extra so a route, once chosen, is kept.
      const penalty = keep && side[j] === -keep ? 25 : 0;
      const c = dist[i] + Math.hypot(nx[j] - nx[i], nz[j] - nz[i]) + penalty;
      if (c < dist[j]) {
        dist[j] = c;
        prev[j] = i;
      }
    }
  }
  let first = -1;
  if (dist[1] < Infinity) {
    let k = 1;
    while (prev[k] > 0) k = prev[k];
    first = k;
  }
  if (first < 2) {
    // Boxed in (starting inside the margin): back straight out, away from the hull's centreline.
    const v = (px - hull.x) * rx + (pz - hull.z) * rz;
    const u = (px - hull.x) * fx + (pz - hull.z) * fz;
    const s = v >= 0 ? 1 : -1;
    out.x = hull.x + fx * u + rx * s * W;
    out.z = hull.z + fz * u + rz * s * W;
    out.side = s;
    if (state) state.side = s;
    return out;
  }
  out.x = nx[first];
  out.z = nz[first];
  // The side of the route: the first node that commits to one.
  let s = 0;
  for (let k = 1; k > 0 && !s; k = prev[k]) s = side[k];
  out.side = s;
  if (state && s) state.side = s;
  return out;
}
