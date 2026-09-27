// Removes single-texel and small-cluster spikes/pits from the DEM (tile-seam glitches in the source data reach
// 400 m on Afognak). Only texels whose 5x5 neighbourhood is clearly land are touched, so coastlines are unchanged.
// Real peaks stand at most ~20 m above their 5x5 median at this resolution; the glitches stand 25-380 m off it.

const THRESHOLD = 24; // metres from the 5x5 median
const QUICK = 12; // cheap pre-test against the 4-neighbour mean

export function despike(game, size, { passes = 3 } = {}) {
  const out = new Float32Array(game);
  const win = new Float32Array(24);
  let fixed = 0;
  for (let pass = 0; pass < passes; pass++) {
    const src = new Float32Array(out);
    let changed = 0;
    for (let j = 2; j < size - 2; j++) {
      for (let i = 2; i < size - 2; i++) {
        const k = j * size + i;
        const h = src[k];
        const mean = 0.25 * (src[k - 1] + src[k + 1] + src[k - size] + src[k + size]);
        if (Math.abs(h - mean) < QUICK) continue;
        let n = 0;
        for (let b = -2; b <= 2; b++) {
          const row = k + b * size;
          for (let a = -2; a <= 2; a++) if (a || b) win[n++] = src[row + a];
        }
        win.sort();
        const med = 0.5 * (win[11] + win[12]);
        if (med < 1 || Math.abs(h - med) < THRESHOLD) continue;
        out[k] = med;
        changed++;
      }
    }
    fixed += changed;
    if (!changed) break;
  }
  return { heights: out, fixed };
}
