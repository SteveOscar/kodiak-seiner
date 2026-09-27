// On-foot rules (SPEC §6.14), DOM-free and THREE-free so Node tests can use them.
//
//   slopeSpeed(deg)          walking speed factor: 1 up to 35°, linear down to 0.3 at 50°, scrambling at 0.3 up to 58°,
//                            0 above (the ground is too steep to stand on: the walker slides)
//   directionalSlope(...)    slope in degrees met walking along a unit direction (centred difference over a baseline)
//   gradientSlope(...)       steepest slope of the ground (degrees) and its downhill direction
//   wadeFactor(depth)        speed factor in the shallows; 0 beyond knee depth (no swimming)
//   findLanding(...)         the best walkable beach within reach of an anchored boat, or a reason why there is none
//   findSummit / perchPoint  top of the hill a named peak marks (hill-climb), or a viewpoint's own spot, for perches
//
// Slopes are game slopes: the terrain is vertically exaggerated ~2.35x (a real 25° hillside is ~48° in game), which is
// what makes the upper ridges of Kodiak a scramble.

export const FOOT_RULES = Object.freeze({
  fullDeg: 35, // full speed up to here
  slowDeg: 50, // speed falls linearly to scrambleSpeed at this slope
  scrambleDeg: 58, // scrambling (hands down) up to here; steeper ground cannot be climbed and slides
  scrambleSpeed: 0.3,
  traverseDeg: 66, // on ground steeper than scrambleDeg a walker may keep moving across the slope up to here
  slideExitDeg: 52, // a slide ends once the ground under the walker eases below this
  kneeDepth: 0.5, // metres of water: wading stops here
  wadeStart: 0.08, // depth where wading begins to slow the walker
  wadeSlow: 0.5, // speed factor at knee depth
});

const DEG = 180 / Math.PI;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function slopeSpeed(deg, rules = FOOT_RULES) {
  const d = Math.abs(deg);
  if (d <= rules.fullDeg) return 1;
  if (d <= rules.slowDeg) return 1 - ((1 - rules.scrambleSpeed) * (d - rules.fullDeg)) / (rules.slowDeg - rules.fullDeg);
  if (d <= rules.scrambleDeg) return rules.scrambleSpeed;
  return 0;
}

// Gait band for animation and UI: 'walk' | 'steep' | 'scramble' | 'slide'.
export function slopeBand(deg, rules = FOOT_RULES) {
  const d = Math.abs(deg);
  if (d <= rules.fullDeg) return 'walk';
  if (d <= rules.slowDeg) return 'steep';
  if (d <= rules.scrambleDeg) return 'scramble';
  return 'slide';
}

// Signed slope (degrees, + uphill) along unit direction (ux, uz) at (x, z).
export function directionalSlope(heightAt, x, z, ux, uz, baseline = 1.2) {
  const a = heightAt(x - ux * baseline, z - uz * baseline);
  const b = heightAt(x + ux * baseline, z + uz * baseline);
  return Math.atan2(b - a, 2 * baseline) * DEG;
}

// Steepest slope at (x, z): { deg, dx, dz } with (dx, dz) the unit downhill direction (0, 0 on flat ground).
export function gradientSlope(heightAt, x, z, e = 1.2, out = { deg: 0, dx: 0, dz: 0 }) {
  const gx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
  const gz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
  const g = Math.hypot(gx, gz);
  out.deg = Math.atan(g) * DEG;
  out.dx = g > 1e-6 ? -gx / g : 0;
  out.dz = g > 1e-6 ? -gz / g : 0;
  return out;
}

// Does a walker on ground of steepest slope `groundDeg`, moving (or not) along a path of slope `pathDeg`, lose their
// footing? Steeper than scrambleDeg is only held while traversing across it (path no steeper than slowDeg) and never
// beyond traverseDeg; standing still, or heading straight up or down such ground, slides.
export function losesFooting(groundDeg, pathDeg, moving, rules = FOOT_RULES) {
  if (groundDeg <= rules.scrambleDeg) return false;
  if (groundDeg > rules.traverseDeg || !moving) return true;
  return Math.abs(pathDeg) > rules.slowDeg;
}

// Speed factor for wading at `depth` metres (<= 0 on dry ground). 0 beyond knee depth.
export function wadeFactor(depth, rules = FOOT_RULES) {
  if (depth <= rules.wadeStart) return 1;
  if (depth > rules.kneeDepth) return 0;
  const t = (depth - rules.wadeStart) / (rules.kneeDepth - rules.wadeStart);
  return 1 - (1 - rules.wadeSlow) * t;
}

export const LANDING = Object.freeze({
  reach: 150, // the seiner must be within this of the beach (metres)
  directions: 48,
  step: 2.5,
  dryHeight: 0.2, // a landing stands at least this far above the sea
  beachDeg: 30, // beach and first few metres inland no steeper than this
  inlandDeg: 50, // the ground behind the beach must still be walkable (no cliff at the tide line)
  inland: [4, 10, 18],
});

// Searches for the best walkable beach reachable in a straight skiff run from (x, z).
//
// opts: { heightAt(x, z) (sea level 0), shoreDistance?(x, z) (fast reject), reach, exclude?(x, z) -> bool,
//         surfaceAt?(x, z) -> string (rock is penalised) }
// Returns { ok: true, landing } or { ok: false, reason: 'none' | 'steep' | 'excluded' }, where
// landing = { x, z, y (beach height), shoreX, shoreZ (waterline), distance (from the boat), heading (boat to beach),
//             slopeDeg (beach), score }.
export function findLanding(x, z, opts) {
  const { heightAt, shoreDistance, exclude, surfaceAt } = opts;
  const R = { ...LANDING, ...(opts.rules ?? {}) };
  const reach = opts.reach ?? R.reach;
  if (shoreDistance && shoreDistance(x, z) > reach + 10) return { ok: false, reason: 'none' };
  if (heightAt(x, z) >= 0) return { ok: false, reason: 'none' };
  let best = null;
  let shores = 0;
  let excluded = 0;
  for (let i = 0; i < R.directions; i++) {
    const a = (i / R.directions) * Math.PI * 2;
    const ux = Math.sin(a);
    const uz = -Math.cos(a);
    // March out over water to the first land.
    let tShore = -1;
    for (let t = R.step; t <= reach + R.step; t += R.step) {
      if (heightAt(x + ux * t, z + uz * t) >= 0) {
        tShore = t;
        break;
      }
    }
    if (tShore < 0) continue;
    // Refine the waterline, then walk inland to dry ground.
    let lo = tShore - R.step;
    let hi = tShore;
    for (let k = 0; k < 6; k++) {
      const m = (lo + hi) / 2;
      if (heightAt(x + ux * m, z + uz * m) >= 0) hi = m;
      else lo = m;
    }
    const tWater = hi;
    let tDry = -1;
    for (let t = tWater; t <= tWater + 14; t += 0.5) {
      if (heightAt(x + ux * t, z + uz * t) >= R.dryHeight) {
        tDry = t;
        break;
      }
    }
    if (tDry < 0 || tDry > reach) continue;
    const bx = x + ux * tDry;
    const bz = z + uz * tDry;
    if (exclude && exclude(bx, bz)) {
      excluded++;
      continue;
    }
    shores++;
    const by = heightAt(bx, bz);
    // Beach slope across the tide line and just inland, and the steepest of the ground behind it.
    const beach = Math.atan2(Math.max(0, heightAt(x + ux * (tDry + R.inland[0]), z + uz * (tDry + R.inland[0])) - heightAt(x + ux * tWater, z + uz * tWater)), tDry + R.inland[0] - tWater) * DEG;
    const lateral = gradientSlope(heightAt, bx, bz, 2).deg;
    let inland = 0;
    let prevT = tDry;
    let prevH = by;
    for (const d of R.inland) {
      const t = tDry + d;
      const h = heightAt(x + ux * t, z + uz * t);
      inland = Math.max(inland, (Math.atan2(Math.abs(h - prevH), t - prevT) * DEG));
      prevT = t;
      prevH = h;
    }
    const beachDeg = Math.max(beach, lateral);
    if (beachDeg > R.beachDeg || inland > R.inlandDeg) continue;
    const surface = surfaceAt ? surfaceAt(bx, bz) : null;
    const score = tDry + beachDeg * 1.5 + inland * 0.6 + (surface === 'rock' ? 45 : 0) + (surface === 'forest' ? 10 : 0);
    if (!best || score < best.score) {
      best = { x: bx, z: bz, y: by, shoreX: x + ux * tWater, shoreZ: z + uz * tWater, distance: tDry, heading: a, slopeDeg: beachDeg, inlandDeg: inland, surface, score };
    }
  }
  if (best) return { ok: true, landing: best };
  return { ok: false, reason: shores ? 'steep' : excluded ? 'excluded' : 'none' };
}

// Where the walker steps off the skiff's bow: the first point ahead (along ux, uz) shallow enough to wade, else null.
export function stepOffPoint(heightAt, bowX, bowZ, ux, uz, { maxAhead = 9, depth = FOOT_RULES.kneeDepth * 0.8 } = {}) {
  for (let t = 0.6; t <= maxAhead; t += 0.3) {
    const px = bowX + ux * t;
    const pz = bowZ + uz * t;
    if (heightAt(px, pz) >= -depth) return { x: px, z: pz, ahead: t };
  }
  return null;
}

// Summit of the hill a named peak marks: hill-climb from (cx, cz), staying within `radius`, so a higher neighbour
// across a saddle is not mistaken for this peak's top. Returns { x, z, h }.
export function findSummit(heightAt, cx, cz, radius = 150, step = 16) {
  let bx = cx;
  let bz = cz;
  let bh = heightAt(cx, cz);
  const dirs = 16;
  for (let s = step; s >= 0.75; s /= 2) {
    for (let iter = 0; iter < 200; iter++) {
      let nx = bx;
      let nz = bz;
      let nh = bh;
      for (let k = 0; k < dirs; k++) {
        const a = (k / dirs) * Math.PI * 2;
        const x = bx + Math.cos(a) * s;
        const z = bz + Math.sin(a) * s;
        if ((x - cx) ** 2 + (z - cz) ** 2 > radius * radius) continue;
        const h = heightAt(x, z);
        if (h > nh) {
          nh = h;
          nx = x;
          nz = z;
        }
      }
      if (nh <= bh) break;
      bx = nx;
      bz = nz;
      bh = nh;
    }
  }
  return { x: bx, z: bz, h: bh };
}

// Spotting perch for a place: peaks use their summit, viewpoints the marked spot itself.
export function perchPoint(heightAt, place) {
  if (place.kind === 'peak') return { ...findSummit(heightAt, place.x, place.z, Math.min(160, Math.max(60, place.radius ?? 150))), radius: 32, drop: 5 };
  return { x: place.x, z: place.z, h: heightAt(place.x, place.z), radius: 45, drop: 4 };
}

// True when a walker at (x, y, z) stands on the summit: close to the top and nearly as high.
export function onSummit(x, y, z, summit, { radius = summit?.radius ?? 32, drop = summit?.drop ?? 5 } = {}) {
  if (!summit) return false;
  return Math.hypot(x - summit.x, z - summit.z) <= radius && y >= summit.h - drop;
}

export { clamp };
