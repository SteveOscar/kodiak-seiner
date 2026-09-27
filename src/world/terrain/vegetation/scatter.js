// Camera-centred scatter layer over world-fixed tiles. Each tile's instances are generated once (deterministically
// from the tile coordinates, so a tile always looks the same) and cached; the layer's instance buffer is rebuilt by
// concatenating cached tiles whenever the set of tiles in range changes. Generation is time-budgeted per frame,
// nearest tiles first. DOM-free.

export function createTileScatter({ tileSize, radius, stride, capacity, generate, name = 'scatter' }) {
  const cache = new Map();
  const data = new Float32Array(capacity * stride);
  let count = 0;
  let lastCx = NaN;
  let lastCz = NaN;
  let pending = true;
  let generatedTiles = 0;
  const key = (tx, tz) => (tx + 32768) * 65536 + (tz + 32768);
  let scratch = new Float32Array(stride * 256);
  let n = 0;
  // push(x, y, z, scale, cos, sin, tint, aux [, sx, sy, sz])
  const push = (a, b, c, d, e, f, g, h, i = 0, j = 0, k = 0) => {
    if ((n + 1) * stride > scratch.length) {
      const bigger = new Float32Array(scratch.length * 2);
      bigger.set(scratch);
      scratch = bigger;
    }
    const o = n * stride;
    scratch[o] = a;
    scratch[o + 1] = b;
    scratch[o + 2] = c;
    scratch[o + 3] = d;
    scratch[o + 4] = e;
    scratch[o + 5] = f;
    scratch[o + 6] = g;
    scratch[o + 7] = h;
    if (stride > 8) {
      scratch[o + 8] = i;
      scratch[o + 9] = j;
      scratch[o + 10] = k;
    }
    n++;
  };

  function tilesInRange(cx, cz) {
    const r = radius + tileSize * 0.75;
    const t0x = Math.floor((cx - r) / tileSize);
    const t1x = Math.floor((cx + r) / tileSize);
    const t0z = Math.floor((cz - r) / tileSize);
    const t1z = Math.floor((cz + r) / tileSize);
    const out = [];
    for (let tz = t0z; tz <= t1z; tz++) {
      for (let tx = t0x; tx <= t1x; tx++) {
        const dx = (tx + 0.5) * tileSize - cx;
        const dz = (tz + 0.5) * tileSize - cz;
        const d = Math.hypot(dx, dz);
        if (d < r) out.push({ tx, tz, d });
      }
    }
    out.sort((a, b) => a.d - b.d);
    return out;
  }

  return {
    name,
    data,
    stride,
    get count() {
      return count;
    },
    get cachedTiles() {
      return cache.size;
    },
    get generatedTiles() {
      return generatedTiles;
    },
    invalidate() {
      cache.clear();
      pending = true;
    },
    // Returns true when the instance buffer changed. `deadline` is a performance.now() time after which no new tile
    // is generated this frame.
    update(cx, cz, deadline) {
      const tcx = Math.floor(cx / tileSize);
      const tcz = Math.floor(cz / tileSize);
      const moved = tcx !== lastCx || tcz !== lastCz;
      if (!moved && !pending) return false;
      const tiles = tilesInRange(cx, cz);
      let missing = false;
      let fresh = false;
      for (const t of tiles) {
        const k = key(t.tx, t.tz);
        if (cache.has(k)) continue;
        if (performance.now() > deadline) {
          missing = true;
          break;
        }
        n = 0;
        generate(t.tx, t.tz, t.tx * tileSize, t.tz * tileSize, tileSize, push);
        cache.set(k, n ? scratch.slice(0, n * stride) : null);
        generatedTiles++;
        fresh = true;
      }
      pending = missing;
      if (!moved && !fresh) return false;
      lastCx = tcx;
      lastCz = tcz;
      let c = 0;
      for (const t of tiles) {
        const arr = cache.get(key(t.tx, t.tz));
        if (!arr) continue;
        const m = Math.min(arr.length / stride, capacity - c);
        if (m <= 0) break;
        data.set(m * stride === arr.length ? arr : arr.subarray(0, m * stride), c * stride);
        c += m;
      }
      count = c;
      // Forget tiles far out of range.
      if (cache.size > tiles.length * 3 + 64) {
        const keep = new Set(tiles.map((t) => key(t.tx, t.tz)));
        for (const k of cache.keys()) if (!keep.has(k)) cache.delete(k);
      }
      return true;
    },
  };
}

// Deterministic per-cell random numbers for placement: rand(ix, iz, salt) in [0, 1).
export function cellRandom(seed) {
  return function rand(ix, iz, salt) {
    let h = (Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iz | 0, 0x165667b1) ^ Math.imul((salt + seed) | 0, 0x9e3779b1)) | 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}
