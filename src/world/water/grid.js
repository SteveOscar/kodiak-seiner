// Camera-centred LOD grid for the sea surface (pure; returns typed arrays).
//
// Level 0 is a square grid of half-size R0 = cellsHalf * s0; every further level is a square ring with twice the
// spacing and twice the half-size around the previous one. The whole mesh is rigid: the vertex shader offsets it by
// one snapped centre, so every level's vertices stay on a world-fixed lattice between snaps and nothing swims.
// Vertices in the outer 30% of each level morph onto the next level's lattice (odd grid indices slide onto their
// even neighbours), so level boundaries are watertight without stitching. Beyond the last ring a flat skirt runs out
// to just inside the camera far plane; its outermost vertices are lifted toward the horizon line in the shader.
//
// Vertex attribute `position` = (local x, tag, local z): tag > 0 is the level's grid spacing (displaced + morphed),
// tag = -1 is a flat skirt vertex, tag = -2 an outermost (horizon-lifted) skirt vertex.

export function buildGrid({ s0 = 0.5, cellsHalf = 96, maxRadius = 1500, skirtRadii = [2500, 4000, 7000, 12000, 20000, 39500] } = {}) {
  if (cellsHalf % 4 !== 0) throw new Error('cellsHalf must be a multiple of 4');
  const pos = [];
  const idx = [];
  const levels = [];

  const addLevel = (s, hole) => {
    const n = cellsHalf;
    const side = 2 * n + 1;
    const map = new Int32Array(side * side).fill(-1);
    const h = hole ? n / 2 : 0;
    const inHole = (i, j) => hole && i >= -h && i < h && j >= -h && j < h;
    const vid = (i, j) => {
      const k = (j + n) * side + (i + n);
      if (map[k] < 0) {
        map[k] = pos.length / 3;
        pos.push(i * s, s, j * s);
      }
      return map[k];
    };
    // Cells are emitted in 8x8 blocks so the GPU's post-transform vertex cache reuses shared vertices (row-major
    // order over a 193-vertex-wide level re-shades most vertices twice; the wave vertex shader is not cheap).
    const B = 8;
    for (let bj = -n; bj < n; bj += B) {
      for (let bi = -n; bi < n; bi += B) {
        for (let j = bj; j < Math.min(bj + B, n); j++) {
          for (let i = bi; i < Math.min(bi + B, n); i++) {
            if (inHole(i, j)) continue;
            const a = vid(i, j);
            const b = vid(i + 1, j);
            const c = vid(i, j + 1);
            const d = vid(i + 1, j + 1);
            // Alternate the diagonal so the triangulation has no preferred direction.
            if ((i + j) & 1) idx.push(a, c, b, b, c, d);
            else idx.push(a, c, d, a, d, b);
          }
        }
      }
    }
    levels.push({ spacing: s, radius: n * s });
  };

  let s = s0;
  addLevel(s, false);
  while (cellsHalf * s < maxRadius) {
    s *= 2;
    addLevel(s, true);
  }

  // Skirt: from the last ring's outer boundary (its coarse lattice, which is what the morphed boundary becomes) out
  // through concentric circles.
  const R = cellsHalf * s;
  const step = 2 * s;
  const perSide = (2 * R) / step;
  const boundary = [];
  for (let k = 0; k < perSide; k++) boundary.push([-R + k * step, -R]);
  for (let k = 0; k < perSide; k++) boundary.push([R, -R + k * step]);
  for (let k = 0; k < perSide; k++) boundary.push([R - k * step, R]);
  for (let k = 0; k < perSide; k++) boundary.push([-R, R - k * step]);
  const M = boundary.length;
  let prev = boundary.map(([x, z]) => {
    pos.push(x, -1, z);
    return pos.length / 3 - 1;
  });
  const radii = skirtRadii.filter((r, i) => i === skirtRadii.length - 1 || r > R * Math.SQRT2 * 1.1);
  radii.forEach((r, ri) => {
    const tag = ri === radii.length - 1 ? -2 : -1;
    const ring = boundary.map(([x, z]) => {
      const l = Math.hypot(x, z);
      pos.push((x / l) * r, tag, (z / l) * r);
      return pos.length / 3 - 1;
    });
    for (let k = 0; k < M; k++) {
      const a = prev[k];
      const b = prev[(k + 1) % M];
      const c = ring[k];
      const d = ring[(k + 1) % M];
      idx.push(a, b, c, b, d, c);
    }
    prev = ring;
  });

  return {
    positions: new Float32Array(pos),
    indices: new Uint32Array(idx),
    levels,
    cellsHalf,
    s0,
    outerRadius: R,
    snap: 4 * s0,
  };
}

// Wave distance-fade range (in wavelengths) that keeps every displaced wave at >= ~7 vertices per wavelength for a
// grid of this density (worst case: the morph zone of a level, spacing ~ 2.86 d / cellsHalf).
export function fadeRangeFor(cellsHalf) {
  const k = cellsHalf / 96;
  return { start: 2.5 * k, end: 4.2 * k };
}
