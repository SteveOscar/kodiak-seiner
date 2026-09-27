// Site helpers shared by the settlement builders: lot finding on real terrain, shoreline marching, orientation.
// Layout decisions read the core heightmap (S.hm) so they are identical in Node tests and in the browser whatever
// detail WP-TERRAIN adds; only final vertical placement uses the rendered surface (S.H).

// Unit vector pointing downhill (x, z) or offshore when flat.
export function downhill(S, x, z) {
  const n = S.hm.normalAt(x, z);
  const l = Math.hypot(n.x, n.z);
  if (l > 0.05) return { x: n.x / l, z: n.z / l };
  const g = S.hm.shoreGradient(x, z);
  return { x: g.x, z: g.z };
}

export const slopeDeg = (S, x, z) => (Math.acos(Math.min(1, S.hm.normalAt(x, z).y)) * 180) / Math.PI;

// Yaw so that a structure's front (local +z) faces direction (dx, dz).
export const faceRot = (dx, dz) => Math.atan2(dx, dz);

// Walks from (x, z) along (dx, dz) until the terrain drops below sea level; returns the first water point.
export function marchToWater(S, x, z, dx, dz, maxDist = 600, step = 2) {
  for (let t = 0; t <= maxDist; t += step) {
    const px = x + dx * t;
    const pz = z + dz * t;
    if (S.hm.heightAt(px, pz) < 0) return { x: px, z: pz, t };
  }
  return null;
}

// Greedy lot picking inside a disc. Returns [{ x, z, rot }] sorted by preference.
// o: { n, R, minH, maxH, maxSlope, maxSd (shore distance must be <=, i.e. inland), spacing, avoid: [{x,z,r}],
//      score(x, z) lower is better, face: 'downhill'|'offshore'|{x,z} }
export function findLots(S, cx, cz, o) {
  const { rng } = S;
  const R = o.R ?? 100;
  const step = o.step ?? 5;
  const cands = [];
  for (let gz = -R; gz <= R; gz += step) {
    for (let gx = -R; gx <= R; gx += step) {
      if (gx * gx + gz * gz > R * R) continue;
      const x = cx + gx + (rng.next() - 0.5) * step * 0.8;
      const z = cz + gz + (rng.next() - 0.5) * step * 0.8;
      const h = S.hm.heightAt(x, z);
      if (h < (o.minH ?? 0.9) || h > (o.maxH ?? 40)) continue;
      if (S.hm.shoreDistance(x, z) > (o.maxSd ?? -10)) continue;
      if (slopeDeg(S, x, z) > (o.maxSlope ?? 30)) continue;
      if (o.inside && !o.inside(x, z)) continue;
      cands.push({ x, z, s: (o.score ? o.score(x, z) : Math.hypot(gx, gz)) + rng.next() * (o.jitter ?? 8) });
    }
  }
  cands.sort((a, b) => a.s - b.s);
  const out = [];
  const sp2 = (o.spacing ?? 13) ** 2;
  const avoid = o.avoid ?? [];
  for (const c of cands) {
    if (out.length >= (o.n ?? 20)) break;
    let ok = true;
    for (const p of out) if ((p.x - c.x) ** 2 + (p.z - c.z) ** 2 < sp2) ok = false;
    for (const a of avoid) if ((a.x - c.x) ** 2 + (a.z - c.z) ** 2 < a.r * a.r) ok = false;
    if (!ok) continue;
    let dir;
    if (o.face === 'offshore') dir = S.hm.shoreGradient(c.x, c.z);
    else if (o.face && typeof o.face === 'object') {
      const l = Math.hypot(o.face.x - c.x, o.face.z - c.z) || 1;
      dir = { x: (o.face.x - c.x) / l, z: (o.face.z - c.z) / l };
    } else dir = downhill(S, c.x, c.z);
    const jit = ((rng.next() - 0.5) * (o.rotJitter ?? 22) * Math.PI) / 180;
    out.push({ x: c.x, z: c.z, rot: faceRot(dir.x, dir.z) + jit });
  }
  return out;
}
