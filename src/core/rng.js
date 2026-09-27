// Seeded random numbers. Use these instead of Math.random() for anything that affects the world layout so a given
// seed reproduces the same island dressing; Math.random() is fine for purely cosmetic per-frame jitter.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createRng(seed = 1) {
  const next = mulberry32(seed);
  const rng = {
    next,
    range: (a, b) => a + (b - a) * next(),
    int: (a, b) => Math.floor(a + (b - a + 1) * next()),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
    gauss: () => {
      let u = 0;
      let v = 0;
      while (u === 0) u = next();
      while (v === 0) v = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    // Independent stream that depends only on (seed, salt), so other systems' draws never shift yours.
    fork: (salt) =>
      createRng((Math.imul(seed, 1664525) + 1013904223 + Math.imul(typeof salt === 'string' ? hashString(salt) : salt >>> 0, 2654435761)) >>> 0),
  };
  return rng;
}

// Stable string hash, for deriving seeds from ids.
export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
