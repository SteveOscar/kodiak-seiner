// Where the animals live. Pure analysis of the game heightmap and the places data (no THREE, no DOM), run once at
// create and deterministic for a given DEM and rng fork:
//
//   islets        small land components (sea stacks, reefs, Ugak and Marmot islands) with their low rocky rims
//   haulouts      sea lion haulouts: islets and exposed rocky headlands; the Marmot Island rookery sits inside its
//                 CLOSED_AREAS buffer
//   cliffs        steep coasts (eagles soar in the updraft, cormorants nest on the ledges)
//   beaches       low gentle shores (bears walk them, seals and gulls rest, a fox trots the wrack line)
//   otterBeds     rocky nearshore shallows where the kelp grows
//   bearSites     every salmon stream mouth (wading shallows, bank, beach path, meadow) plus the O'Malley River
//   whaleRanges   deep open water in the big bays and straits
//   goatCliffs    high steep slopes; deerMeadows: moderate green hillsides near the coast; snags: forest-edge perches

import { hash01, headingOf, clamp } from './math.js';

const N = 512; // analysis grid for coast features (31.25 m cells)

export function findSites({ heightmap: hm, places, streams = [], closedAreas = [], rng, terrain = null, half = 8000 }) {
  const cell = (2 * half) / N;
  const P = (i) => -half + (i + 0.5) * cell;
  const g = { x: 0, z: 0 };
  const coast = [];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = P(i);
      const z = P(j);
      const sd = hm.shoreDistance(x, z);
      if (sd > 0 || sd < -45) continue;
      if (Math.abs(x) > 7500 || Math.abs(z) > 7500) continue;
      hm.shoreGradient(x, z, g);
      const h = hm.heightAt(x, z);
      const hIn = hm.heightAt(x - g.x * 90, z - g.z * 90);
      const hFar = hm.heightAt(x - g.x * 220, z - g.z * 220);
      coast.push({ x, z, sd, h, hIn, hFar, gx: g.x, gz: g.z });
    }
  }

  // Headland-ness: fraction of water on a 160 m ring.
  const waterFrac = (x, z, r = 160, n = 16) => {
    let w = 0;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      if (hm.heightAt(x + Math.cos(a) * r, z + Math.sin(a) * r) < 0) w++;
    }
    return w / n;
  };

  // Greedy spread pick: sorted by score, keep candidates at least `sep` from any kept one.
  function pick(cands, count, sep, score = (c) => c.score ?? 0) {
    const sorted = cands.slice().sort((a, b) => score(b) - score(a));
    const out = [];
    for (const c of sorted) {
      if (out.length >= count) break;
      if (out.some((o) => (o.x - c.x) ** 2 + (o.z - c.z) ** 2 < sep * sep)) continue;
      out.push(c);
    }
    return out;
  }
  const jitter = (key) => hash01(`${key}`) * 0.25;

  // ---- islets (flood fill on a 1024 grid straight from the heightmap array)
  const islets = [];
  {
    const M = 1024;
    const src = hm.game;
    const S = hm.size;
    const step = S / M;
    const land = new Uint8Array(M * M);
    for (let j = 0; j < M; j++) {
      const row = Math.floor(j * step) * S;
      for (let i = 0; i < M; i++) land[j * M + i] = src[row + Math.floor(i * step)] > 0.15 ? 1 : 0;
    }
    const comp = new Int32Array(M * M).fill(-1);
    const stack = new Int32Array(M * M);
    const cellM = (2 * half) / M;
    let id = 0;
    for (let s = 0; s < M * M; s++) {
      if (!land[s] || comp[s] >= 0) continue;
      let top = 0;
      stack[top++] = s;
      comp[s] = id;
      let n = 0;
      let sx = 0;
      let sz = 0;
      let maxH = 0;
      const cellsList = [];
      let big = false;
      while (top > 0) {
        const c = stack[--top];
        n++;
        const ci = c % M;
        const cj = (c / M) | 0;
        sx += ci;
        sz += cj;
        if (!big) {
          cellsList.push(c);
          if (cellsList.length > 2600) big = true;
        }
        if (ci > 0 && land[c - 1] && comp[c - 1] < 0) {
          comp[c - 1] = id;
          stack[top++] = c - 1;
        }
        if (ci < M - 1 && land[c + 1] && comp[c + 1] < 0) {
          comp[c + 1] = id;
          stack[top++] = c + 1;
        }
        if (cj > 0 && land[c - M] && comp[c - M] < 0) {
          comp[c - M] = id;
          stack[top++] = c - M;
        }
        if (cj < M - 1 && land[c + M] && comp[c + M] < 0) {
          comp[c + M] = id;
          stack[top++] = c + M;
        }
      }
      id++;
      if (big || n > 2600) continue;
      const cx = -half + (sx / n + 0.5) * cellM;
      const cz = -half + (sz / n + 0.5) * cellM;
      const nearRookery = closedAreas.some((a) => Math.hypot(cx - a.x, cz - a.z) < a.radius + 800);
      if (!nearRookery && (Math.abs(cx) > 7600 || Math.abs(cz) > 7600)) continue;
      const rim = [];
      for (const c of cellsList) {
        const x = -half + ((c % M) + 0.5) * cellM;
        const z = -half + (((c / M) | 0) + 0.5) * cellM;
        const h = hm.heightAt(x, z);
        maxH = Math.max(maxH, h);
        const sd = hm.shoreDistance(x, z);
        if (h > 0.25 && h < 9 && sd > -30) rim.push({ x, z, h, sd });
      }
      islets.push({ id: `islet-${islets.length}`, x: cx, z: cz, cells: n, area: n * cellM * cellM, maxH, rim });
    }
  }

  // ---- haulouts: islets with a rim, exposed rocky headlands, and the Marmot rookery
  const rookeryArea = closedAreas.find((c) => /rookery|sea lion/i.test(`${c.id} ${c.name} ${c.reason}`)) ?? null;
  const haulouts = [];
  const slotsFrom = (cells, cx, cz, maxSlots, filter = () => true) =>
    cells
      .filter(filter)
      .map((c) => ({ x: c.x, z: c.z, h: c.h, face: headingOf(c.x - cx, c.z - cz) }))
      .sort((a, b) => hash01(`${a.x.toFixed(0)}:${a.z.toFixed(0)}`) - hash01(`${b.x.toFixed(0)}:${b.z.toFixed(0)}`))
      .slice(0, maxSlots);
  for (const is of islets) {
    if (!is.rim.length) continue;
    if (rookeryArea && Math.hypot(is.x - rookeryArea.x, is.z - rookeryArea.z) < rookeryArea.radius + 800) {
      const inside = is.rim.filter((c) => Math.hypot(c.x - rookeryArea.x, c.z - rookeryArea.z) < rookeryArea.radius - 25);
      haulouts.push({ id: 'marmot-rookery', kind: 'rookery', x: rookeryArea.x, z: rookeryArea.z, closed: rookeryArea, isletId: is.id, slots: slotsFrom(inside, is.x, is.z, 60), birds: true });
      continue;
    }
    haulouts.push({ id: `haul-${is.id}`, kind: 'islet', x: is.x, z: is.z, isletId: is.id, slots: slotsFrom(is.rim, is.x, is.z, 30), birds: is.cells >= 3 });
  }
  const headlands = [];
  for (const c of coast) {
    if (c.sd < -25 || c.h > 5 || c.hIn < 6) continue;
    const wf = waterFrac(c.x, c.z);
    if (wf < 0.52) continue;
    headlands.push({ ...c, score: wf + jitter(`hl${c.x}:${c.z}`) + Math.min(0.3, c.hIn / 60) });
  }
  for (const h of pick(headlands.filter((h) => !haulouts.some((o) => Math.hypot(o.x - h.x, o.z - h.z) < 1500)), 9, 1800)) {
    const cells = coast.filter((c) => Math.hypot(c.x - h.x, c.z - h.z) < 110 && c.sd > -18 && c.h < 6 && c.h > 0.2);
    if (cells.length < 2) continue;
    // Denser slots: sub-sample positions between the coarse cells.
    const slots = [];
    for (const c of cells) for (let k = 0; k < 3; k++) {
      const a = hash01(`${c.x}:${c.z}:${k}`) * Math.PI * 2;
      const x = c.x + Math.cos(a) * 10;
      const z = c.z + Math.sin(a) * 10;
      const hh = hm.heightAt(x, z);
      if (hh > 0.2 && hh < 6) slots.push({ x, z, h: hh, face: headingOf(c.gx, c.gz) });
    }
    haulouts.push({ id: `haul-point-${haulouts.length}`, kind: 'point', x: h.x, z: h.z, slots: slots.slice(0, 24), birds: true });
  }

  // ---- cliffs
  const cliffCands = coast.filter((c) => c.hIn > 26 && c.sd > -30).map((c) => ({ x: c.x, z: c.z, top: Math.max(c.hIn, c.hFar), heading: headingOf(c.gx, c.gz), gx: c.gx, gz: c.gz, score: c.hIn / 40 + jitter(`cl${c.x}:${c.z}`) }));
  const cliffs = pick(cliffCands, 34, 1100);

  // ---- beaches
  const beachCands = coast.filter((c) => c.h < 3 && c.hIn < 6 && c.hFar < 18 && c.sd > -30).map((c) => ({ x: c.x, z: c.z, h: c.h, gx: c.gx, gz: c.gz, along: headingOf(-c.gz, c.gx), score: 1 - c.hIn / 6 + jitter(`be${c.x}:${c.z}`) }));
  const beaches = pick(beachCands, 40, 900);

  // ---- otter beds: rocky nearshore shallows (kelp country), favouring the forested north-east where Kodiak's otters
  // concentrate.
  const otterCands = [];
  for (const c of coast) {
    if (c.hIn < 8) continue;
    for (const d of [55, 95]) {
      const x = c.x + c.gx * (d - c.sd);
      const z = c.z + c.gz * (d - c.sd);
      const depth = -hm.heightAt(x, z);
      if (depth < 2.6 || depth > 14) continue;
      const ne = clamp((x + 2000) / 8000, 0, 1) * 0.6 + clamp((-z + 2000) / 8000, 0, 1) * 0.4;
      otterCands.push({ x, z, depth, score: ne + Math.min(0.4, c.hIn / 50) + jitter(`ot${x}:${z}`) });
    }
  }
  const otterBeds = pick(otterCands, 16, 1300);

  // ---- bear sites: every stream mouth
  const nearestWaterPoint = (x, z, minSd, maxSd, maxR = 260) => {
    let best = null;
    let bd = Infinity;
    for (let r = 6; r <= maxR; r += 8) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const px = x + Math.cos(a) * r;
        const pz = z + Math.sin(a) * r;
        const sd = hm.shoreDistance(px, pz);
        if (sd >= minSd && sd <= maxSd && hm.heightAt(px, pz) < -0.35) {
          if (r < bd) {
            bd = r;
            best = { x: px, z: pz };
          }
        }
      }
      if (best) return best;
    }
    return best;
  };
  const shorePath = (x, z, count, radius = 240) => {
    const near = [];
    for (const c of coast) if (c.h < 6 && Math.abs(c.x - x) < radius && Math.abs(c.z - z) < radius && Math.hypot(c.x - x, c.z - z) < radius) near.push(c);
    const pts = near
      .map((c) => {
        // Walk the upper beach: a few metres inland of the waterline.
        const gg = { x: 0, z: 0 };
        hm.shoreGradient(c.x, c.z, gg);
        const sd = hm.shoreDistance(c.x, c.z);
        const k = sd + 7;
        return { x: c.x - gg.x * k, z: c.z - gg.z * k };
      })
      .filter((p) => {
        const h = hm.heightAt(p.x, p.z);
        return h > 0.3 && h < 6;
      });
    return pick(pts.map((p) => ({ ...p, score: hash01(`${p.x.toFixed(1)}:${p.z.toFixed(1)}`) })), count, 35);
  };
  const meadowNear = (x, z) => {
    const cands = [];
    for (let r = 80; r <= 420; r += 40) {
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        const px = x + Math.cos(a) * r;
        const pz = z + Math.sin(a) * r;
        const h = hm.heightAt(px, pz);
        if (h < 2 || h > 45) continue;
        const n = hm.normalAt(px, pz);
        if (n.y < 0.85) continue;
        cands.push({ x: px, z: pz, h, score: n.y - r / 2000 + jitter(`md${px}:${pz}`) });
      }
    }
    return pick(cands, 3, 60);
  };
  const bearSites = [];
  for (const s of streams) {
    const wade = nearestWaterPoint(s.x, s.z, 2, 16);
    if (!wade) continue;
    const gg = { x: 0, z: 0 };
    hm.shoreGradient(s.x, s.z, gg);
    const bank = { x: s.x - gg.x * 6, z: s.z - gg.z * 6 };
    bearSites.push({ id: `stream-${s.id}`, streamId: s.id, name: s.name, x: s.x, z: s.z, wade, bank, path: shorePath(s.x, s.z, 6), meadow: meadowNear(s.x, s.z), heading: headingOf(gg.x, gg.z) });
  }
  const omalley = places.find((p) => p.id === 'omalley-river');
  if (omalley) {
    const m = meadowNear(omalley.x, omalley.z);
    bearSites.push({ id: 'omalley', streamId: null, name: omalley.name, x: omalley.x, z: omalley.z, wade: null, bank: { x: omalley.x, z: omalley.z }, path: m, meadow: m, heading: 0, inland: true });
  }

  // ---- whale ranges: deep water in named bays/straits and a few open-shelf patches
  const whaleRanges = [];
  const namedWater = places.filter((p) => p.kind === 'bay' || p.kind === 'strait' || p.id === 'ugak-island');
  for (const p of namedWater) {
    const w = hm.nearestWater(p.x, p.z, { minShore: 380, maxRadius: 1600 });
    if (!w || hm.depthAt(w.x, w.z) < 18) continue;
    if (whaleRanges.some((r) => Math.hypot(r.x - w.x, r.z - w.z) < 1400)) continue;
    whaleRanges.push({ id: `range-${p.id}`, placeId: p.id, x: w.x, z: w.z, r: clamp(hm.shoreDistance(w.x, w.z) * 2.2, 650, 1600) });
  }

  // ---- mountain goats: high steep slopes; deer: moderate green hillsides within ~1.5 km of the coast
  const goatCands = [];
  const deerCands = [];
  for (let j = 4; j < N - 4; j += 2) {
    for (let i = 4; i < N - 4; i += 2) {
      const x = P(i);
      const z = P(j);
      if (Math.abs(x) > 7400 || Math.abs(z) > 7400) continue;
      const h = hm.heightAt(x, z);
      if (h < 12) continue;
      const n = hm.normalAt(x, z);
      if (h > 120 && n.y < 0.62 && n.y > 0.38) goatCands.push({ x, z, h, score: h / 250 + jitter(`gt${x}:${z}`) });
      const sd = hm.shoreDistance(x, z);
      if (h < 110 && n.y > 0.8 && n.y < 0.97 && sd > -900) deerCands.push({ x, z, h, score: jitter(`dr${x}:${z}`) * 4 + n.y });
    }
  }
  const goatCliffs = pick(goatCands, 10, 2200);
  const deerMeadows = pick(deerCands, 22, 1300);

  // ---- snags at the forest edge near the shore (the spruce country of the north-east), eagle perches on rocks
  const forest = (x, z) => {
    const f = terrain?.forestDensity?.(x, z);
    if (Number.isFinite(f)) return f;
    // Fallback: the spruce region of Kodiak's north-east and Afognak.
    return x > 1500 && z < 1500 ? 0.6 : 0;
  };
  const snagCands = [];
  for (const c of coast) {
    if (c.hIn > 30) continue;
    const x = c.x - c.gx * (45 - c.sd);
    const z = c.z - c.gz * (45 - c.sd);
    const h = hm.heightAt(x, z);
    if (h < 1.5 || h > 40) continue;
    const f = forest(x, z);
    if (f < 0.25) continue;
    snagCands.push({ x, z, h, score: f + jitter(`sn${x}:${z}`), face: headingOf(c.gx, c.gz) });
  }
  const snags = pick(snagCands, 26, 900);
  const rockPerches = pick(
    coast.filter((c) => c.hIn > 12 && c.sd > -14 && c.h > 0.4 && c.h < 8).map((c) => ({ x: c.x, z: c.z, h: c.h, face: headingOf(c.gx, c.gz), score: jitter(`rp${c.x}:${c.z}`) })),
    30,
    1100,
  );

  return { islets, haulouts, cliffs, beaches, otterBeds, bearSites, whaleRanges, goatCliffs, deerMeadows, snags, rockPerches, coastCount: coast.length, rng: !!rng };
}
