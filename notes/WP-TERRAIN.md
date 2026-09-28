# WP-TERRAIN — terrain, land cover, terrain sun shadow, vegetation

## Summary

Owned files: `src/world/terrain.js` + `src/world/terrain/**`, tests `tests/terrain.test.mjs`, scenarios
`tests/scenarios/terrain-*.json`, QA output `qa/terrain/`.

- **Geometry** (`terrain/quadtree.js`, `terrain/lodMesh.js`, `terrain/surface.js`, `terrain/glsl.js`): CDLOD
  quadtree over a 32 km root (the 16 km DEM mirrored beyond the world edge and sinking to −60 m over 3.2 km, so the
  Alaska Peninsula and Shuyak continue past the edge instead of ending in a wall). Every selected region is drawn as
  instances of one 32×32 grid quadrant with outward-facing single-sided skirts; one draw call. Vertices morph toward
  the next level over the last 30 % of each band (no cracks, no pops; checked with frame sequences and an LOD-tint
  debug view). Heights are displaced on the GPU from a despiked R32F copy of the DEM with clamped Catmull-Rom
  interpolation plus procedural detail (smoothed-ridged noise on steep rock, low hummocks on gentle land), evaluated
  bit-identically on the CPU: `heightAt(x, z)` is the level-0 triangulation of that surface (GPU/CPU parity check:
  max 3 mm over 9,216 random points, `tests/scenarios/terrain-parity.json`). Nodes entirely below −26 m stop at level
  5, the shelf below −5 m at level 2 (seabed behind the water column); seabed fragments under > 4.6 optical depths
  of water write the water-column colour and skip all surface and lighting work.
- **Reflection mesh**: a second LOD mesh (coarser ranges, `REFLECTION_RANGES`) with a cheap variant of the terrain
  shader (baked cover only), on camera layer 1 only; the main terrain mesh is layer 0 only. WP-OCEAN's planar
  reflection therefore reflects hills without paying for the full terrain shader twice. Selection for both meshes
  runs in `frame()` (the camera is final after `cameraRig.lateUpdate`, and water renders its reflection in its
  `beforeRender`, which runs before ours), and again in `beforeRender` only if the camera moved since (photo mode,
  debug camera). Selection is skipped entirely while the camera holds still.
- **Material** (`terrain/material.js`): MeshStandardMaterial patched with custom vertex displacement and a lean lighting
  replacement (Lambert sun from `uSunColor × uTerrainShadow × shadow map`, hemisphere + per-vertex IBL irradiance,
  Blinn-Phong/IBL specular only on wet ground, lakes and snow, sun translucency through grass). Splatting from three
  baked cover textures (DEM resolution, generated on the GPU at startup from the same formulas as the CPU land cover):
  emerald meadows with a mosaic of fern beds and seed-head swards, lush drainages, dry crests and south faces, beach
  rye, alpine tundra; alder and salmonberry thickets along drainages and as fingers down per-pixel fall-line rills;
  spruce canopy (crowns far, forest floor near); rock on cliffs and crests (triplanar cliff macro texture at two
  scales + fine rock texture near, ragged edges, lichen, fraying into streaks along the rills), scree and talus;
  gravel and sand beaches with a wet dark band and a wrack line; snow on peaks and north gullies (lower on the
  Peninsula volcanoes, shed by steep volcanic ribs); lakes; seabed gravel/sand/rock/mud/kelp with caustics and
  `kodiak_underwater`. Mid-scale normal relief (hummocks and V-shaped fall-line rills) that the 7.8 m DEM cannot carry,
  faded out by pixel footprint so distance stays stable. All noise comes from one 256² lattice shared with the CPU.
  Colour management: palette hexes are sRGB (`THREE.Color`), textures NoColorSpace (masks/normals) or SRGB (albedo
  canvases); the built-in chunks do tone mapping, colour space and fog (sky's chunks).
- **Terrain sun shadow** (`terrain/shadowPass.js`, `terrain/sunvis.js`): a 2048² R8 world-covering target (1024² on
  `low`) ray-marched toward `uSunDir` with a soft ~1.4° penumbra, re-marched when the sun moves > 0.5° (16 row bands
  over 16 frames, then a 1.6 s cross-fade so shadows sweep instead of stepping; instant on jumps > 6°), published as
  `uniforms.uTerrainShadow.value` (one persistent texture object). `sunVisibilityAt(x, z)` runs the same march on the
  CPU, cached on a 256² grid per 0.25° of sun movement.
- **Land cover** (`terrain/landcover.js`, `terrain/drainage.js`, `terrain/despike.js`): regional factors from real
  geography via `ctx.geo.toWorld` (spruce north-east of the Kizhuyak→Middle Bay line and on Afognak, Shuyak,
  Raspberry, Spruce, Woody, Long, Near and Marmot; treeless south-west; Peninsula side of Shelikof Strait), D8
  drainage for gullies, `isDeveloped` footprints from `src/data/places.js`. `surfaceAt`, `forestDensity`,
  `alderDensity` and vegetation placement read these same functions, so what is drawn is what is reported.
- **Vegetation** (`terrain/vegetation/*`, density × `quality.vegetation`): Sitka spruce (3D drooping-bough card trees
  within ~48 m, dithered into atlas impostors to 2.3 km with rank thinning, sun shadows from a cone proxy per tree
  drawn only in the shadow pass); alder and salmonberry bushes from leafy foliage cards (near/far card sets, re-split
  as the camera moves); grass clumps with dry-straw tint; ferns on the forest floor and in damp gullies; fireweed and
  lupine stands inside baked meadow patches; beach boulders (fine mesh near, coarse far), sea-bleached driftwood logs
  and root wads on the storm line; bull kelp mats (band 100) riding `water.heightAt` and turning with
  `ctx.tide.currentAt`. Wind sway from `uWindDir/uWindSpeed`; foliage is Lambert-lit (no grazing sheen) with sun
  translucency; all layers read the terrain shadow texture. Nothing grows on developed footprints.

## API as built

Required: `heightAt(x, z)`, `surfaceAt(x, z)` (`'sand'|'gravel'|'grass'|'forest'|'alder'|'rock'|'snow'|'water'`),
`forestDensity(x, z)` 0..1, `sunVisibilityAt(x, z)` 0..1.

Extras: `mesh` (main LOD mesh), `reflectionMesh`, `material`, `surface` (`smooth`, `full`, `detail`, `normalAt`),
`landcover` (all cover formulas incl. `rillAt`, `regionAt`), `heights` (despiked DEM), `alderDensity(x, z)`,
`normalAt(x, z, out?)`, `slopeAt(x, z)` (radians), `isLake(x, z)`, `raycast(origin, dir, maxDist)` → hit distance or
−1, `verifyGpuParity(n)` → `{points, maxErr, meanErr, worst}`, `setDebug({flat, noDetail, hidden, reflection, veg:
{name: bool}, defines: {NAME: bool}, maxInstances, rangeScale})`, `debugSelect()`, `debugState()`
(`instances, triangles, reflectionInstances, cpuMs, selectMs, shadowComputations, despiked, vegetation`).
`serialize()` → undefined (nothing persisted), `restore()`, `reset()` are no-ops. Shader debug defines:
`TK_DBG_LEVELS` (tint by LOD level/morph), `TK_DBG_UNLIT`, `TK_DEBUG_FLAT`, `TK_DEBUG_NODETAIL`, and `TK_PROF_*`
profiling switches (all off by default). URL: `?tkdbg=levels` etc.

### Deviations

- **LOD error within 3 km is p99 ≈ 2.5–2.7 m, not ≤ 2 m** (SPEC §3). Measured on the real DEM over ground under 20°
  (tests and `qa/terrain/scratch/lodcand.mjs`): within 600 m p99 0.19 m (level 1, starting to morph), meeting the
  0.3 m target; beyond 2.2 km level 3's 15.6 m lattice gives p99 2.5 m (test sample: 2.7 m), and 1.7 % of placements
  there exceed 2 m — sub-pixel at that distance (0.6 px). Meeting 2 m needs level 2 out to ~3.3 km: implemented and
  measured at roughly +1.4 ms GPU in the boat view (mostly quad overshading of ~2 px triangles by the terrain fragment
  shader), which alone would use 40 % of the 3.5 ms terrain budget, so the previous ranges were kept.
  `tests/terrain.test.mjs` asserts p99 ≤ 0.3 m (600 m) and ≤ 2.8 m (3 km). Max (not p99) errors near cliff edges are
  several metres at any LOD; place objects on gentle ground.
- The GPU shadow is marched over the despiked DEM texture rather than `uHeightMap` (same data without the source's
  tile-seam spikes, which reach 380 m on Afognak). `sunVisibilityAt` uses the bilinear despiked DEM (centimetres from
  the rendered surface).
- `perf().systemsMs.terrain` covers `update()` + `frame()` (LOD selection); the per-frame `beforeRender` work (terrain
  shadow bands, vegetation scatter, kelp) is reported in `debugState().cpuMs`.

## Tunables

- `terrain/quadtree.js`: `DEFAULT_RANGES` (LOD bands), `MORPH_FRACTION`, `DETAIL_LEVEL`, `DEEP_Y/DEEP_LEVEL`,
  `SHALLOW_Y/SHALLOW_LEVEL`; `terrain.js`: `REFLECTION_RANGES`, `MAX_INSTANCES`.
- `terrain/surface.js` `DETAIL`: rock ridge amplitude/wavelength/slope band, hummock amplitude/wavelength.
- `terrain/landcover.js` `COVER`: tree line, forest slope/shore limits, beach top, snow lines (Kodiak/Peninsula), rock
  score thresholds, ledges, `rillAlder`; `ALDER_T0/T1` thicket coverage (≈ 25 % of mid slopes). Regional lines are
  lat/lon in `buildRegion`.
- `terrain/material.js` `PALETTE` (sRGB), relief amplitudes and fade distances in `FRAG_SURFACE`.
- `terrain/sunvis.js`: penumbra, ray steps, cache resolution; `terrain/shadowPass.js`: target size, bands, cross-fade.
- `terrain/vegetation/index.js`: per-layer radius/cell/density (all × `quality.vegetation`), spruce near/impostor
  ranges, shrub and boulder near/far split distances; `vegetation/models.js` for model shapes and palettes.

## Perf

M4 (10-core GPU), 1280×720, pixel ratio 1, `high` preset. GPU numbers are noisy: up to five other agents' headless
Chromium runs shared the machine during the session (load average 2–110); the numbers below are from three A/B
pairs taken at load ≈ 2–3.

- Full game, `--bench`, `tests/scenarios/terrain-bench.json`, with vs `?skip=terrain` (the core stub terrain), GPU
  delta (three pairs): boat-kodiak +0.4 / +0.5 / −0.8 ms (≈ 0), high (1.5 km altitude) +1.9 / +2.0 / +1.3 ms, on
  foot on a meadow slope +2.1 / +2.7 / +2.2 ms, forest floor +0.7 / +0.8 / +0.1 ms. Frame-time deltas are smaller
  (≤ 0.9 ms). CPU: LOD selection 0.2–0.35 ms (in `systemsMs.terrain` during play; under a debug camera it moves into
  the hook), `beforeRender` hook (`debugState().cpuMs`) 0.3–0.7 ms (terrain-shadow bands, vegetation scatter with a
  1.1 ms/frame budget, 7 ms/frame for 45 frames after a teleport, kelp). Worst case ≈ 2.5 + 0.7 ≈ 3.2 ms < 3.5 ms.
- Draw calls: terrain 1 (+1 reflection when WP-OCEAN renders it) + up to ~20 vegetation layers (spruce impostors are
  one draw per 512 m tile, frustum-culled). Triangles: terrain main ~0.65 M in the boat view (284 quadrants × 2,304),
  reflection ~0.27 M (119 quadrants).
- Where the GPU time goes (standalone bench `qa/terrain/bench/bench.html` + `qa/terrain/bench.sh`, terrain only,
  alternating variants per frame; indicative, since ANGLE/Metal timer queries attribute alternating frames loosely):
  the terrain fragment shader dominated (quad overshading of small far triangles × a heavy shader, and texture
  fetches — each full-screen fetch ≈ 0.1–0.3 ms), then vertex/raster, then lighting (shadow-map taps ≈ 0.2–0.8 ms).
  The optimisation pass: deep-seabed early exit, far-field trimming (relief, ground texture and strata only where
  resolvable), shore-distance fetch only near the coast, `tkRegion` and the 470 m macro noise folded out of the fetch
  list (cover textures repacked), lattice-texture noise instead of integer hashes, skipped triplanar projections,
  single-sided skirts, one-fetch morph height, the coarse cheap reflection mesh, spruce shadow proxies, and smaller
  vegetation radii with near/far model LODs. Before it, the same views measured 2.6–5.6 ms GPU.
- Startup: `terrain.create()` ≈ 0.2 s (despike, drainage, region bake, GPU prep passes, impostor bake).

## Known issues

- Rock outcrops are shading and texture only (the DEM is 7.8 m); at some grazing angles they still read as painted
  on smooth slopes.
- Kelp cards are flat and ride the swell at their base only; in big swell blade tips dip under the surface (they fade
  into the water colour anyway). From a standing eye height, kelp beds more than ~60 m out are nearly edge-on.
- Near spruce → impostor swap at ~48 m is a dithered fade; impostors are camera-facing with a top view blended in from
  above, so very steep downward views of forests show some card structure.
- Grass is instanced only within 18 m (fireweed/lupine 48 m, ferns 28 m, shrubs 78 m); beyond, the terrain's meadow
  colours carry the look. Shrinking at the fade edge is smooth but visible when flying low and fast.
- The previous frame's LOD selection feeds the reflection mesh under a debug camera override (one frame of lag); in
  normal play it is current.

## Best screenshots

- `qa/terrain/final/evening.png` (full game, chase cam, Kodiak city at golden hour)
- `qa/terrain/final-vistas/kodiak-golden.png`, `kodiak-noon.png` (from the water toward Kodiak city and the spruce)
- `qa/terrain/final-vistas/uyak-noon.png`, `uyak-golden.png` (Uyak Bay, treeless green west side)
- `qa/terrain/final-vistas/high-noon.png` (high above the island)
- `qa/terrain/final-vistas/peninsula-noon.png`, `peninsula-golden.png` (Peninsula volcanoes across Shelikof Strait)
- `qa/terrain/final-vistas/shadow-2130.png`, `shadow-2130-kodiak.png`, `qa/terrain/final-shadow/sweep-ne-*.png`
  (mountain shadows at 20:48 → 21:42)
- `qa/terrain/final-veg/beach-golden.png`, `beach-close.png`, `beach-kelp.png`, `kelp-boat.png` (gravel, driftwood,
  boulders, kelp, grass, spruce)
- `qa/terrain/final-vistas/hill-onfoot.png`, `hill-onfoot-golden.png`, `qa/terrain/final-veg/meadow.png`,
  `meadow-golden.png`, `alder-close.png`, `forest-onfoot.png` (on-foot scale)
- `qa/terrain/final-lod/seq-0..7.png` (6 m steps, no pops) and `lvl-*.png` (LOD level/morph tint)

## Requests to other work packages

- **WP-OCEAN**: the terrain on camera layer 1 is now a dedicated coarse mesh with a cheap shader, meant for the
  planar reflection (the main terrain mesh is layer 0 only). If another layer-1 pass needs the full terrain, tell
  WP-TERRAIN. `uTerrainShadow` stays the same texture object for the session.
- **WP-SKY**: vegetation shadow casters (spruce proxies, boulders, driftwood) collapse beyond 150 m in the depth pass
  to stay inside the ±150 m cascade; if `SHADOW_HALF` changes, `shadowFar` in `vegetation/common.js` should follow.
- **WP-FOOT**: `surfaceAt` returns `'alder'` in rill thickets too (for footsteps); `slopeAt` and `normalAt` are
  available for the walking limits.
- **WP-PLACES**: vegetation and the developed-ground tint follow `isDeveloped`; harbour water inside a footprint gets
  no kelp.

## Core changes

None.
