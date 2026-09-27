// Species constants for the fish system that are not in config.fish (body size, look, jump signatures), plus small
// pure helpers shared by the simulation, the net model and the tests. No THREE, no DOM.

export const SPECIES = ['pink', 'chum', 'sockeye', 'coho', 'king'];
export const SCHOOL_SPECIES = ['pink', 'chum', 'sockeye', 'coho'];
export const SPECIES_INDEX = { pink: 0, chum: 1, sockeye: 2, coho: 3, king: 4 };

export const emptyCatch = () => ({ pink: 0, chum: 0, sockeye: 0, coho: 0, king: 0 });
export const catchTotal = (c) => (c ? SPECIES.reduce((a, k) => a + (c[k] ?? 0), 0) : 0);

// Body length (m, snout to tail fork) of an ocean-bright adult; the renderer scales the unit fish by this.
export const FISH_LENGTH = { pink: 0.52, chum: 0.7, sockeye: 0.6, coho: 0.66, king: 0.95 };

// Jump signatures (SPEC §6.10). height = peak of the body centre above the surface (m); length = horizontal travel of
// one arc (m); arcs = number of consecutive leaps; walk = seconds of tail-walking between coho leaps; splash = relative
// size of the re-entry splash (1 = a chum falling flat); style names are published in fish:jump.
export const JUMP_STYLES = {
  pink: { style: 'popcorn', height: [0.22, 0.5], length: [0.5, 1.2], arcs: [1, 2], walk: [0, 0], pitch: 0.55, flop: 0, twist: [0, 0.4], splash: 0.42 },
  sockeye: { style: 'leap', height: [0.65, 1.1], length: [1.3, 2.1], arcs: [1, 1], walk: [0, 0], pitch: 1, flop: 0, twist: [0, 0.15], splash: 0.3 },
  chum: { style: 'flop', height: [0.45, 0.8], length: [0.7, 1.3], arcs: [1, 1], walk: [0, 0], pitch: 0.7, flop: 1, twist: [0, 0.05], splash: 1 },
  coho: { style: 'tailwalk', height: [0.9, 1.6], length: [1.1, 2.0], arcs: [2, 4], walk: [0.35, 0.9], pitch: 0.85, flop: 0, twist: [0.6, 1.6], splash: 0.62 },
  king: { style: 'roll', height: [0.02, 0.12], length: [1.4, 2.2], arcs: [1, 1], walk: [0, 0], pitch: 0.4, flop: 0, twist: [0, 0], splash: 0.55 },
  // Trapped fish flipping in a drying bag. Not a spotting signature, so not bound to the school heading.
  bag: { style: 'thrash', height: [0.12, 0.45], length: [0.2, 0.7], arcs: [1, 1], walk: [0, 0], pitch: 0.3, flop: 0.6, twist: [0.3, 1.4], splash: 0.45 },
};

// Kings are bycatch only; they never form their own school. Capture range for them when caught with a school.
export const KING_CAPTURE = [0.5, 0.8];

// Run intensity 0..1 on the game calendar from config.fish.runs [start, peakStart, peakEnd, end].
export function runIntensity(day, run) {
  if (!run) return 0;
  const [s, p0, p1, e] = run;
  if (day < s || day > e) return 0;
  if (day < p0) return 0.25 + 0.75 * ((day - s) / Math.max(1e-6, p0 - s));
  if (day <= p1) return 1;
  return Math.max(0, 1 - (day - p1) / Math.max(1e-6, e - p1));
}

// Species weights from run timing alone (fallback when season.speciesMix is unavailable).
export function runMix(day, runs) {
  const out = {};
  for (const k of SCHOOL_SPECIES) out[k] = runIntensity(day, runs?.[k]);
  return out;
}

// Number of run-driven schools the world should hold on this day (SPEC: 12–25).
export function targetPopulation(day, runs) {
  let sum = 0;
  for (const k of SCHOOL_SPECIES) sum += runIntensity(day, runs?.[k]);
  const strength = Math.min(1, sum / 2.2);
  return Math.max(12, Math.min(25, Math.round(12 + 13 * strength)));
}

// Late in the run fish home toward their stream: 0.15 before the peak, rising through the peak to 0.9 after it.
export function homingUrge(day, run) {
  if (!run) return 0.2;
  const [s, p0, p1, e] = run;
  if (day <= p0) return 0.15 + 0.1 * Math.max(0, (day - s) / Math.max(1, p0 - s));
  if (day <= p1) return 0.25 + 0.45 * ((day - p0) / Math.max(1, p1 - p0));
  return Math.min(0.9, 0.7 + 0.2 * ((day - p1) / Math.max(1, e - p1)));
}

// Weighted pick from an object of non-negative weights. Returns a key or null.
export function weightedPick(weights, r) {
  let total = 0;
  for (const k in weights) total += Math.max(0, weights[k] || 0);
  if (total <= 0) return null;
  let x = r * total;
  for (const k in weights) {
    const w = Math.max(0, weights[k] || 0);
    if (x < w) return k;
    x -= w;
  }
  for (const k in weights) if ((weights[k] || 0) > 0) return k;
  return null;
}

// School size: log-normal around the species median, clamped to the config range, scaled by run strength.
export function schoolCount(spec, rng, strength = 1) {
  const [lo, hi] = spec.count ?? [500, 3000];
  const median = spec.median ?? Math.sqrt(lo * hi);
  const n = median * Math.exp(0.55 * rng.gauss()) * (0.55 + 0.45 * strength);
  return Math.round(Math.min(hi, Math.max(lo, n)));
}

export const smallAngle = (a) => {
  let x = a % (2 * Math.PI);
  if (x > Math.PI) x -= 2 * Math.PI;
  if (x < -Math.PI) x += 2 * Math.PI;
  return x;
};

// Heading convention (SPEC §3): 0 = north (−z), clockwise positive. Forward = (sin h, −cos h).
export const headingOf = (vx, vz) => Math.atan2(vx, -vz);
