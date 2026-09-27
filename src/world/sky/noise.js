// Tileable procedural noise baked into textures at startup. Pure JS (no THREE/DOM): returns typed arrays; sky.js
// wraps them in THREE textures. The CPU keeps the 2D cloud field so it can sample the same clouds the GPU draws
// (sunlight dims when a cloud crosses the sun).

const smooth5 = (t) => t * t * t * (t * (t * 6 - 15) + 10);

function hash3(x, y, z, seed) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + seed * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Periodic gradient (Perlin) noise in 2D with integer periods (px, py); returns roughly [-1, 1].
function perlin2(x, y, px, seed, py = px) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const g = (ix, iy, dx, dy) => {
    const a = hash3(((ix % px) + px) % px, ((iy % py) + py) % py, 0, seed) * Math.PI * 2;
    return Math.cos(a) * dx + Math.sin(a) * dy;
  };
  const u = smooth5(xf);
  const v = smooth5(yf);
  const n00 = g(xi, yi, xf, yf);
  const n10 = g(xi + 1, yi, xf - 1, yf);
  const n01 = g(xi, yi + 1, xf, yf - 1);
  const n11 = g(xi + 1, yi + 1, xf - 1, yf - 1);
  return 1.41 * ((n00 + (n10 - n00) * u) * (1 - v) + (n01 + (n11 - n01) * u) * v);
}

// Periodic Worley (F1) noise in 2D, returns [0, ~1].
function worley2(x, y, p, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let best = 9;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = xi + i;
      const cy = yi + j;
      const wx = ((cx % p) + p) % p;
      const wy = ((cy % p) + p) % p;
      const fx = cx + hash3(wx, wy, 1, seed);
      const fy = cy + hash3(wx, wy, 2, seed);
      const d = (fx - x) ** 2 + (fy - y) ** 2;
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}

function perlin3(x, y, z, p, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = x - xi;
  const yf = y - yi;
  const zf = z - zi;
  const w = (v) => ((v % p) + p) % p;
  const g = (ix, iy, iz, dx, dy, dz) => {
    const a = hash3(w(ix), w(iy), w(iz), seed) * Math.PI * 2;
    const b = hash3(w(ix), w(iy), w(iz), seed + 7) * 2 - 1;
    const s = Math.sqrt(1 - b * b);
    return Math.cos(a) * s * dx + Math.sin(a) * s * dy + b * dz;
  };
  const u = smooth5(xf);
  const v = smooth5(yf);
  const t = smooth5(zf);
  const lerp = (a, b, k) => a + (b - a) * k;
  const x00 = lerp(g(xi, yi, zi, xf, yf, zf), g(xi + 1, yi, zi, xf - 1, yf, zf), u);
  const x10 = lerp(g(xi, yi + 1, zi, xf, yf - 1, zf), g(xi + 1, yi + 1, zi, xf - 1, yf - 1, zf), u);
  const x01 = lerp(g(xi, yi, zi + 1, xf, yf, zf - 1), g(xi + 1, yi, zi + 1, xf - 1, yf, zf - 1), u);
  const x11 = lerp(g(xi, yi + 1, zi + 1, xf, yf - 1, zf - 1), g(xi + 1, yi + 1, zi + 1, xf - 1, yf - 1, zf - 1), u);
  return 1.5 * lerp(lerp(x00, x10, v), lerp(x01, x11, v), t);
}

function worley3(x, y, z, p, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const w = (v) => ((v % p) + p) % p;
  let best = 9;
  for (let k = -1; k <= 1; k++) {
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const cx = xi + i;
        const cy = yi + j;
        const cz = zi + k;
        const fx = cx + hash3(w(cx), w(cy), w(cz), seed + 1);
        const fy = cy + hash3(w(cx), w(cy), w(cz), seed + 2);
        const fz = cz + hash3(w(cx), w(cy), w(cz), seed + 3);
        const d = (fx - x) ** 2 + (fy - y) ** 2 + (fz - z) ** 2;
        if (d < best) best = d;
      }
    }
  }
  return Math.sqrt(best);
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// 2D cloud noise, size×size RGBA8, tileable.
//   R: billowy Perlin FBM (large cloud masses)   G: inverted Worley FBM (cumulus puffs)
//   B: stretched fibrous FBM (cirrus)             A: fine Perlin FBM (edge detail)
export function cloudNoise2D(size = 256, seed = 1) {
  const data = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = i / size;
      const y = j / size;
      let r = 0;
      let amp = 0.5;
      let tot = 0;
      for (let o = 0; o < 5; o++) {
        const f = 4 << o;
        r += amp * perlin2(x * f, y * f, f, seed + o);
        tot += amp;
        amp *= 0.5;
      }
      r = clamp01(0.5 + 0.55 * (r / tot));
      let g = 0;
      amp = 0.55;
      tot = 0;
      for (let o = 0; o < 3; o++) {
        const f = 6 << o;
        g += amp * (1 - worley2(x * f, y * f, f, seed + 20 + o));
        tot += amp;
        amp *= 0.5;
      }
      g = clamp01((g / tot - 0.25) / 0.75);
      let b = 0;
      amp = 0.5;
      tot = 0;
      for (let o = 0; o < 4; o++) {
        const fx = 2 << o;
        const fy = 16 << o;
        b += amp * perlin2(x * fx + 0.6 * perlin2(x * 4, y * 4, 4, seed + 40), y * fy, fx, seed + 30 + o, fy);
        tot += amp;
        amp *= 0.55;
      }
      b = clamp01(0.5 + 0.6 * (b / tot));
      let a = 0;
      amp = 0.5;
      tot = 0;
      for (let o = 0; o < 3; o++) {
        const f = 32 << o;
        a += amp * perlin2(x * f, y * f, f, seed + 50 + o);
        tot += amp;
        amp *= 0.5;
      }
      a = clamp01(0.5 + 0.6 * (a / tot));
      const k = (j * size + i) * 4;
      data[k] = Math.round(r * 255);
      data[k + 1] = Math.round(g * 255);
      data[k + 2] = Math.round(b * 255);
      data[k + 3] = Math.round(a * 255);
    }
  }
  return { size, data };
}

// Bilinear, wrapped sample of one channel (0..3) of a cloudNoise2D field at uv (repeating), returns 0..1.
export function sampleNoise2D(field, u, v, channel = 0) {
  const n = field.size;
  const x = u * n - 0.5;
  const y = v * n - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const w = (a) => ((a % n) + n) % n;
  const at = (i, j) => field.data[(w(j) * n + w(i)) * 4 + channel] / 255;
  return (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
}

// 3D mist noise, size³ RG8, tileable. R: Perlin-Worley FBM (billowy fog), G: fine Perlin FBM (wisps).
export function mistNoise3D(size = 32, seed = 5) {
  const data = new Uint8Array(size * size * size * 2);
  for (let k = 0; k < size; k++) {
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const x = i / size;
        const y = j / size;
        const z = k / size;
        let p = 0;
        let amp = 0.5;
        let tot = 0;
        for (let o = 0; o < 3; o++) {
          const f = 2 << o;
          p += amp * perlin3(x * f, y * f, z * f, f, seed + o);
          tot += amp;
          amp *= 0.5;
        }
        p = clamp01(0.5 + 0.6 * (p / tot));
        const wv = 1 - worley3(x * 4, y * 4, z * 4, 4, seed + 10);
        const r = clamp01(p * 0.65 + clamp01(wv) * 0.5 - 0.1);
        let q = 0;
        amp = 0.5;
        tot = 0;
        for (let o = 0; o < 2; o++) {
          const f = 8 << o;
          q += amp * perlin3(x * f, y * f, z * f, f, seed + 20 + o);
          tot += amp;
          amp *= 0.5;
        }
        q = clamp01(0.5 + 0.6 * (q / tot));
        const idx = ((k * size + j) * size + i) * 2;
        data[idx] = Math.round(r * 255);
        data[idx + 1] = Math.round(q * 255);
      }
    }
  }
  return { size, data };
}
