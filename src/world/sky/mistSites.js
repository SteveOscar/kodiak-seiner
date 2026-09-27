// Where low cloud and mist collect on Kodiak: pure logic over the heightmap (no THREE/DOM; unit-tested).
//
//   peak sites  — mountainsides whose terrain crosses the 120–260 m (game) band below higher ground: orographic cloud
//                 that wraps the peaks on grey days and lingers in the corries on fine mornings.
//   bay sites   — enclosed water near shore where morning fog pools and marine fog thickens.
//
// presence(site, env) gives how much of a bank a site holds for the current weather and time of day.

export const PEAK_BAND = [85, 260];

function hash(i, salt) {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt, 0xc2b2ae35);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2d);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// heightmap: { heightAt, shoreDistance, half }. rng: { next() }.
export function findMistSites(heightmap, rng, { peakSpacing = 520, baySpacing = 650, maxPeaks = 260, maxBays = 140 } = {}) {
  const half = heightmap.half ?? 8000;
  const peaks = [];
  const bays = [];
  const step = 180;
  const dirs = 12;
  for (let z = -half + step / 2; z < half; z += step) {
    for (let x = -half + step / 2; x < half; x += step) {
      const jx = x + (rng.next() - 0.5) * step * 0.8;
      const jz = z + (rng.next() - 0.5) * step * 0.8;
      const h = heightmap.heightAt(jx, jz);
      if (h >= PEAK_BAND[0] - 10 && h <= PEAK_BAND[1] + 20) {
        let higher = 0;
        let maxH = h;
        for (let k = 0; k < dirs; k++) {
          const a = (k / dirs) * Math.PI * 2;
          for (const r of [260, 520]) {
            const hh = heightmap.heightAt(jx + Math.cos(a) * r, jz + Math.sin(a) * r);
            if (hh > h + 12) higher++;
            maxH = Math.max(maxH, hh);
          }
        }
        if (higher >= 3) peaks.push({ x: jx, z: jz, ground: h, top: maxH, score: rng.next() + higher / (2 * dirs) });
      } else if (h < -1) {
        const sd = heightmap.shoreDistance(jx, jz);
        if (sd > 40 && sd < 800) {
          let enclosed = 0;
          for (let k = 0; k < dirs; k++) {
            const a = (k / dirs) * Math.PI * 2;
            for (let r = 250; r <= 1800; r += 260) {
              if (heightmap.heightAt(jx + Math.cos(a) * r, jz + Math.sin(a) * r) > 3) {
                enclosed++;
                break;
              }
            }
          }
          if (enclosed >= 7) bays.push({ x: jx, z: jz, shore: sd, score: rng.next() + enclosed / dirs });
        }
      }
    }
  }
  const thin = (list, spacing, max) => {
    list.sort((a, b) => b.score - a.score);
    const out = [];
    const cell = spacing;
    const grid = new Map();
    const key = (i, j) => `${i},${j}`;
    for (const s of list) {
      const i = Math.floor(s.x / cell);
      const j = Math.floor(s.z / cell);
      let ok = true;
      for (let dj = -1; dj <= 1 && ok; dj++) {
        for (let di = -1; di <= 1 && ok; di++) {
          for (const o of grid.get(key(i + di, j + dj)) ?? []) {
            if ((o.x - s.x) ** 2 + (o.z - s.z) ** 2 < spacing * spacing) {
              ok = false;
              break;
            }
          }
        }
      }
      if (!ok) continue;
      out.push(s);
      const k = key(i, j);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(s);
      if (out.length >= max) break;
    }
    return out;
  };
  const sites = [];
  for (const p of thin(peaks, peakSpacing, maxPeaks)) {
    const i = sites.length;
    sites.push({
      id: i,
      kind: 'peak',
      x: p.x,
      z: p.z,
      y: Math.min(p.ground + 18, PEAK_BAND[1]),
      rx: 240 + 260 * hash(i, 1),
      ry: 34 + 34 * hash(i, 2),
      seed: hash(i, 3),
    });
  }
  for (const b of thin(bays, baySpacing, maxBays)) {
    const i = sites.length;
    sites.push({
      id: i,
      kind: 'bay',
      x: b.x,
      z: b.z,
      y: 2,
      rx: 300 + 380 * hash(i, 1),
      ry: 22 + 22 * hash(i, 2),
      seed: hash(i, 3),
    });
  }
  return sites;
}

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Morning fog pooling factor for local hours: strong around dawn, burned off by late morning.
export function morningFactor(hours) {
  return smooth(3.5, 5.5, hours) * (1 - smooth(7.5, 10, hours)) + 0.35 * smooth(21.5, 23.5, hours) + 0.35 * (1 - smooth(0.5, 3.5, hours));
}

// Target presence 0..1 of a site. env: { mist 0..1, fog 0..1, cloudCover 0..1, hours, day, cloudBase }.
export function sitePresence(site, env) {
  const slow = hash(site.id * 31 + (env.day ?? 0) * 7 + Math.floor((env.hours ?? 0) / 3), 11);
  const vary = 0.55 + 0.45 * slow;
  if (site.kind === 'peak') {
    // Grey days: banks wrap every flank near and above the deck base; fine days: a few wisps in the morning/evening.
    const grey = Math.min(1, (env.mist ?? 0) * 1.1) * smooth(0.3, 0.8, env.cloudCover ?? 0);
    const nearDeck = 1 - smooth(60, 160, Math.abs(site.y - (env.cloudBase ?? 250)));
    const fine = 0.5 * (env.mist ?? 0) * (0.35 + 0.65 * morningFactor(env.hours ?? 12)) * (slow > 0.55 ? 1 : 0.15);
    return Math.min(1, Math.max(grey * (0.45 + 0.55 * nearDeck), fine) * vary);
  }
  const morning = morningFactor(env.hours ?? 12);
  const fog = env.fog ?? 0;
  const base = Math.max(morning * (0.45 + 0.55 * (env.mist ?? 0)) * (slow > 0.3 ? 1 : 0.25), fog);
  return Math.min(1, base * vary * (1 - 0.6 * Math.min(1, (env.windSpeed ?? 0) / 16)));
}
