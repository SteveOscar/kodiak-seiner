# WP-OCEAN — the sea

Owner files: `src/world/water.js`, `src/world/water/**` (`waves.js`, `fetch.js`, `grid.js`, `glsl.js`, `textures.js`,
`reflection.js`, `stamps.js`, `foamField.js`, `wakeSim.js`), `tests/ocean.test.mjs`, `tests/ocean-wake.test.mjs`,
`tests/scenarios/ocean-*.json`, `qa/ocean/`.

## Summary

The sea is a camera/focus-following LOD grid (square rings, each twice the spacing of the last, morphed at the seams,
snapped so nothing swims) out to 1.5 km, then a flat skirt to the far plane whose outermost ring is lifted to the
camera's horizon line, so the ocean continues past the world edge with no seam. It is displaced by up to 28
Gerstner components from a fixed bank (4 long SW Gulf of Alaska swell components, 24 wind-sea components in two
wavelength groups spread around the wind, 5 chop components) with wave-group envelopes, so crests are short and
sets come through. Amplitudes follow `sky.weather` (glassy calm to storm) and are attenuated per point by depth
(heightmap R) and by a directional fetch field (8 compass directions, 256² over the world, blurred to wrap around
headlands): fjords and lee shores are calm, exposed capes take the swell. A slow surge runs up the beaches. Every
formula is mirrored on the CPU (`waves.js`): `heightAt` inverts the horizontal displacement with Newton iterations
(stops at 4 mm residual, usually 1–2 steps), and matches the GPU within 4 mm (measured on the GPU with `verify()`).

Shading (linear HDR, fog chunks, tonemapping + colorspace last): a thin transparent layer (alpha = mix(0.2, 1,
fresnel) plus foam and aeration) over the `kodiak_underwater`-attenuated seabed and the abyss plane (y = −40,
uWaterScatter); fresnel reflection of `sky.envMap` through CubeUV (falls back to uSkyColor/uHorizonColor while null);
planar reflection of layer-1 geometry (terrain reflection mesh, sky dome) for calm water; a sharp and a broad GGX sun
lobe with sub-pixel wave slope folded into roughness (a glitter path that neither aliases nor vanishes at distance);
crest subsurface tint toward a low sun; three octaves of drifting detail normals faded with distance (no moiré);
whitecaps (crest compression in wind, individual "white horses" that flare and lace out, gale streaks); shoreline
surf lines, spent foam and swash from heightmap G; turquoise shelf colour; rain rings and splashes; mountain shadow
from uTerrainShadow; night, fog and storm moods; an underwater veil if a camera ever goes below the surface. Scatter
follows daylight and greys under cloud/wind; absorption is clear coastal water.

### Wakes and the stamp field (rebuilt in this session)

The orchestrator's golden-hour shot showed the sea behind the seiner covered in blotchy foam. Cause: every stamp —
including the Kelvin-arm "comb" WP-BOATS lays at fixed offsets from the hull, which traces lines parallel to the track
rather than a V — was written into an 18 s lingering foam channel and thresholded against a cell texture, so a 35 m
wide plateau of mid-level foam turned into scattered patches. Fixed by rethinking what a stamp drives
(`foamField.js`, `wakeSim.js`); the boats' existing stamps now read as a clean V with a turbulent centre trail:

- **Foam** (r): this frame's stamps max-blended over the field with a 4 s half-life (SPEC semantics). Rendered with
  a noise floor: weak levels are sparse fine flecks, 0.4 an open lace, 0.6+ solid white; bubble clouds fill the gaps
  with milky aquamarine instead of dark water.
- **Trail** (g): only strong wash (level ≥ ~0.15, ramping to 0.55) lingers, with an 18 s half-life, and diffuses so
  the track widens into a pale aerated slick that flattens the capillary detail; its foam thins to flecks.
- **Wake waves** (b, a): a damped 2D wave equation with a restoring term (Klein–Gordon), c = 3 m/s,
  ω0² = 2 s⁻², 1 m texels, forced by the stamps as surface pressure. Only *changes* in pressure push (pressure minus
  its 0.35 s moving average), so a moving hull, a splash or a brailer dip makes waves while steady stamps (idling at
  anchor, drifting corklines) leave no dimple. A moving hull leaves a V inside the Mach cone asin(c/U): ~15–22° at
  6 m/s (Kelvin 19.5°), ~13° at 10 m/s (real wakes narrow at speed), with echelon diverging crests and curved
  transverse crests every ~27 m at 6 m/s. Heights are soft-limited at 0.45 m; an absorbing band at the window edge
  stops waves wrapping round. The slopes shade the surface (×3.5 gain; faded once a pixel covers metres) and steep
  young crests carry a thin broken foam line. Shading only: `heightAt` does not include wake waves.
- One toroidal, world-anchored 1024 m window at 1 m (1024², RGBA16F + an R16F pressure average as a second MRT
  attachment), stepped by one ping-pong pass at most 40 times a second; stamps of frames in between accumulate in an
  8-bit force target. Ripples keep their own 512 m window at 0.5 m, skipped entirely when no ring is live.

## API as built

Required (SPEC §6.3): `mesh`, `heightAt(x, z)`, `sample(x, z, out = {height, normal})`, `stamp(x, z, radius, strength,
kind = 'foam')` (returns true when accepted), `addOccluder(mesh)`, `removeOccluder(mesh)`; plus `velocityAt(x, z,
out)` (surface orbital velocity + `ctx.tide.currentAt`), `update`, `debugState`, `serialize` (undefined), `restore`,
`reset` (clears stamps, ripples and the field).

Extras: `abyss` (mesh), `model` (CPU wave model), `sea` (current smoothed sea state), `seaStateAt(x, z)` → local
significant wave height (m) including shelter and depth (for audio/spray), `verify(n, x, z, radius)` (GPU vs CPU
check; returns max/mean error in m), `overrideSea({windSpeed, windDir, swell, rain} | null)` (QA sea-state pin),
`setReflections(bool)`, `setGridCells(n)`, `debugView(mode)` (`foam normal spec shadow rough alpha detail refl fresnel
premult col lod wake wakeslope`, compile-time define), `debugToggles`, `qaPasses.field(parts)`/`.reflection()` (QA
timing), `queryCounts` (heightAt/sample/velocityAt calls last frame). `debugState().passMs` = CPU of the
`beforeRender` work (not in `perf().systemsMs`).

Stamp semantics (documented in `water/stamps.js` for callers):

| foam level | reads as |
|---|---|
| < 0.12 | faint lace only; no trail, no waves |
| 0.15 – 0.55 | foam, plus a lingering aerated trail and a push on the wake waves (both ramp in) |
| ≥ 0.6 | solid white |

Waves come from moving/changing stamps, so stamping a hull's prop wash and bow wave where they are is enough; callers
need not stamp the V arms. `'ripple'`: one expanding ring per call (≤ 128 live, oldest dropped); below strength 0.3
rings are slope only (small fish jumps), stronger ones start with a brief splash of froth. ≤ 512 stamps per frame;
stamps outside the 1024 m window (centred on `cameraRig.focus`, else the camera) are ignored.

Occluders exactly per §6.3: `MeshBasicMaterial({colorWrite: false, depthWrite: true})`, renderOrder 900, no shadows,
layer 0 only, then visible.

Writes `uWaveState` (x = Hs/2, y = choppiness − 1, z = whitecap amount, w = Hs), `uWaterAbsorb`, `uWaterScatter`.

### Deviations

- `uWaveState.w` carries the significant height (the core comment says unused).
- `velocityAt` includes the tidal/wind current (so drifting things need one call).
- Wake waves are shading only (not in `heightAt`/`sample`): other hulls do not pitch in a wake.
- Ripple froth is thresholded at strength 0.3 (WP-FISH request).

### Core changes

None.

## Tunables

- `water.js`: `FIELD_SIZE`/`FIELD_RES` (1024 m / 1024), `WAKE_SLOPE_GAIN` 3.5, `GRID_CELLS` 64 (× quality.waterSegments:
  high 64, medium 48, low 32 cells per ring half-side), `REFLECTION_INTERVAL` 4, reflection scale per quality
  (ultra/high 0.5, medium 0.34, low off), palette (`DEEP #11485a`, `SHELF #2b8a86`, `SSS #3fbf9f`, `FOAM #f2f6f7`,
  `SLATE #2a3d3f`, `DEEP_NIGHT #06141c`), `ABYSS_Y` −40.
- `waves.js`: component bank (`SWELL`, `WIND_LONG/SHORT`, `CHOP`), `seaStateFromWeather` (wind sea Hs = 0.016 U²,
  whitecaps from 4.5 to 12 m/s, detail, choppiness), `MAX_SHARPNESS` 0.9, `CPU_TOLERANCE` 1.2 cm, `INVERT_TOLERANCE`
  4 mm, exposure curves `EXPO_SWELL/WIND/CHOP`, surge `SURGE_K/OMEGA`.
- `wakeSim.js`: `WAKE` (c, damping, restore, force, maxHeight, trailDiffusion, sponge), `PRESSURE_TAU`,
  `trailInput`/`stampPressure` thresholds (mirrored in `foamField.js` STAMP_FRAG; a test checks).
- `foamField.js`: `MIN_STEP` 1/40 s, ring speed/width/amplitude, `rippleFroth`.
- `stamps.js`: `FOAM_HALF_LIFE` 4 s, `WAKE_HALF_LIFE` 18 s (trail), caps.
- `glsl.js`: stamp-foam and trail-foam mappings, V-crest foam thresholds (wake slope 0.06–0.12), whitecap cells and
  cover, shore foam zone, detail octave scales.

## Tests

`node --test tests/ocean.test.mjs tests/ocean-wake.test.mjs` — 28 passing (21 + 7):
transliterated GLSL fed with the packed uniforms matches the CPU forward map (open sea, near shore, past the world
edge); `heightAt` inversion within 5 mm; CPU component subset within 3 cm; Newton convergence; `sample` normals vs
finite differences; sea-state scaling, shelter/depth attenuation, distance fade; `velocityAt` vs the time derivative;
stamp queue semantics (level foam, ripple ring buffer, cap, window, frame-rate independent half-life); LOD grid
watertightness; `heightAt` speed (judged against a reference kernel so parallel load does not fail it — it did for
WP-PLACES before); the system under Node with occluders. Wake: explicit step stable at any frame time; a towed hull
leaves a Kelvin-like V that narrows with speed, nothing ahead of the bow, transverse crests; a steady stamp rings
once and leaves no dimple; sudden splashes stay bounded; trail/pressure thresholds; the shaders use the CPU
thresholds; small ripples carry no froth.

Scenarios: `ocean-shots` (the brief's set), `ocean-wake` / `ocean-wake-iter` (cruise, full throttle, turn, top,
side, look-back; `debugView('wake'|'wakeslope')` field views), `ocean-stamps`, `ocean-moods`, `ocean-reflect`,
`ocean-beach`, `ocean-whitecaps`, `ocean-verify` (GPU/CPU), `ocean-low` (quality low), `ocean-bench` and
`ocean-bench-ab` (A/B of field and reflection passes). Local QA tools (gitignored): `qa/ocean/tools/gpuprobe7.js`,
`gpuprobe8.js` (isolated pass timing and a shader-cost bisect, run via an `eval` that fetches them) and
`glerr-boot.mjs` (records the first GL errors from boot with the three.js program that issued the draw).

## Perf

The machine was shared with up to a dozen other agents' builds and GPU runs throughout (load average 50–160), so
timings drift by 2–5× within a run; the numbers below are from the least contended windows.

- Full game, `basic`/bench view, 1280×720, everything on: **9.08 ms avg, 11.0 ms p95** (`qa/ocean/final-bench-on`,
  first window); `skip=water` measured 8.52 ms in its clean window (`qa/ocean/bench-skip2`). Draw calls ~150,
  triangles 1.2–1.9 M in total.
- CPU: `perf().systemsMs.water` 0.05–0.10 ms (update) + `debugState().passMs` ~0.24 ms (camera-following work,
  stamp upload, secondary pass setup). `heightAt` 1.4 µs/call in Node (storm, 21 components), 5.5 µs in the
  contended browser.
- GPU, isolated passes (fence timing, min of 8×16–20 runs, net of an empty pass): surface 1.9–2.2 ms, field step
  0.3–0.45 ms (now at most 40 Hz), planar reflection 0.4–0.85 ms per render (every 4th frame while the camera moves
  smoothly, off above ~10 m/s wind or at night). In-frame A/B (alternating toggles): field ~0.7–0.9 ms and reflection
  ~0.4 ms of frame time under contention, before the 40 Hz step and the reflection interval change.
- Estimate: ~2.3–2.6 ms GPU + ~0.3 ms CPU, i.e. at or slightly over the 2.5 ms line; the frame stays far inside 16.7 ms.
  Water adds ~8 draw calls (surface, abyss, occluders, stamps, step, ripples; the reflection pass redraws the terrain
  reflection mesh and sky dome) and 183 k triangles (high).

## Best screenshots

- `qa/ocean/final/evening.png` — the orchestrator's 20:49 frame: V arm catching the sun, turbulent wash, clean sea.
- `qa/ocean/final-wake-iter/i1-chase-noon.png`, `i6-golden-lookback.png`, `i4-side-low.png` — the V from chase, from
  the stern and from the side.
- `qa/ocean/final-wake/w6-top-turn.png` — a full-throttle turn from above: foam flecks over the aerated trail, V crests.
- `qa/ocean/final-shots/01-calm-dawn.png` (glassy dawn, mirrored hills), `02-noon-chop.png`, `03-golden-glitter.png`,
  `04-storm-swell.png`, `05-beach.png`, `06b-look-down-shore.png` (seabed and a pink school through the shelf),
  `07-sunset-horizon.png`, `08-stamp-ring.png`, `09-seiner-underway.png`.
- `qa/ocean/low1/low-golden-glitter.png` — quality low keeps its glitter path.
- `qa/ocean/c6-moods/m1-rain-rings.png`, `c6-reflect/r-dawn.png`.

## Known issues

- Wake waves are not in `heightAt`: boats and corks do not ride other hulls' wakes.
- At full throttle (12 m/s, twice hull speed) the boats stamp strongly, so the wash is a broad bright band — plausible
  for a hull that far over its speed, busier than at cruise.
- The underwater fallback view (never reached by the camera rig) shows a seam at the horizon.
- From high altitude in a moderate breeze, distant white horses read as evenly spaced specks.
- Perf is at the budget line (above); the surface fragment shader is the bulk, and the next saving would be
  merging the two foam-noise taps or dropping the finest detail octave on `medium`.

## Requests

- **WP-BOATS**: the water now makes the Kelvin V from the hull's own stamps (moving pressure). Please drop the
  Kelvin-arm "comb" in `seiner.js` (`for (const d of [5, 11, 18, 27, 38])`, up to 16 m outboard): stamped at fixed
  offsets it traces lines parallel to the track, which at high speed show as extra foam streaks outside the V and
  fatten its arms. (The fleet's shoulder stamps sit next to the hull and are fine.) Keep the prop wash (0.3–0.6, it lingers as the trail) and the
  bow-wave stamps along the hull. Also: the `glDrawElementsInstanced: Mismatch between texture format and sampler
  type` warning your notes attribute to WP-TERRAIN was WP-OCEAN's reflection pass drawing the terrain reflection mesh
  on frame 1 before the sun's shadow map existed — fixed here; strict runs are clean.
- **WP-FISH**: done — ripples below strength 0.3 carry no froth; your small-jump rings (0.14–0.3) are slope only.
- **WP-SKY**: done — on the canvas path (quality low) glints now make the layer opaque instead of being clipped then
  scaled by the thin layer's alpha. The dawn mist bank reads as a hard white stripe on glassy water
  (`qa/ocean/final-shots/01-calm-dawn.png`); a softer lower edge would sit better on the mirror.
- **WP-TERRAIN**: the shelf caustics read as large, high-contrast worm lines at low camera angles
  (`qa/ocean/final-shots/05b-beach-along.png`, `06b-look-down-shore.png`); smaller scale, lower contrast or fading
  with depth and view angle would read more like light through water.

## Post-QA changes

See [FIX-ocean.md](FIX-ocean.md) (2026-09-28 QA fix wave); it supersedes anything here that it contradicts.
