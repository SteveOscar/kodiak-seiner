# FIX-visuals: kelp beds and town steam plumes

Scope: QA findings [23] (flat brown/orange chevrons on the water; root cause kelp, see notes/FIX-fish.md) and [34]
(faint round discs in the clear 09:00 sky over Kodiak; root cause `places-smoke`, see notes/FIX-sky.md).
Scenarios and helpers: `qa/polish-visuals/kelp.json`, `kelp-sun.json`, `smoke.json`, `k.js` (findBed / over /
sunPath / steamCam). Before shots: `qa/polish-visuals/kelp-before/`, `qa/polish-visuals/smoke-before/`.

## Kelp (src/world/terrain/vegetation/kelp.js, vegetation/index.js)

- Rebuilt bull kelp as two instanced layers sharing one subdivided card: `kelp` (render band 100, over the water:
  round floats with a wet highlight plus the awash first third of the blades) and `kelp-under` (band -100, drawn
  before the water: full blades sinking 0.06 m to 0.45 m, `KELP_SINK`), so the water's fresnel, reflection, glitter
  and `kodiak_underwater` cover most of each plant. Canvas atlas with four variants (three fronds, one cluster of
  bare floats); dark olive-brown tissue; surface layer takes half the direct sun of a dry leaf (wet sheen, roughness
  0.36), the under layer 0.7 of it before underwater darkening.
- Smaller plants (1.6-3.6 m, was 2.8-6.0 m), fewer per bed (2 m cells, a third 6 m clump noise, was 1.7 m), fade
  with camera distance `KELP_FADE` 70-190 m (scatter radius follows it, was 420 m).
- This pass: plants in a bed now stream the same way (50 m direction field in `vegetation/index.js`, +-20 deg jitter;
  tide alignment jitter +-14 deg, was +-26 deg), blades in a plant trail nearly parallel (spread +-1-10 deg, was
  +-3-23 deg) so a plant reads as a streamer, not a chevron/fan; submerged blades 0.68x opacity so beds read as a
  shadow in the water (`qa/polish-visuals/kelp-after3/`). Aligned single-float streamers then read a little like a
  school of small fish from 30 m, so: frond atlas variants carry one, two or three floats bunched together (3-5
  blades each for clusters), heading jitter +-34 deg inside the bed direction field, submerged blades 0.55x opacity.
  Program cache key kelp-v7.
- Verified (`qa/polish-visuals/kelp.json`, `kelp-sun.json`; before `kelp-before/`, final `kelp-after4/`,
  `kelp-sun-after3/`): Fort Abercrombie and Pacific Spaceport noon from 30-35 m, low-contrast olive clusters under
  the surface instead of large flat brown chevrons; 20:30 chase in the glitter path (a3, b2, s1-s3) shows no orange
  shapes, beds beyond ~190 m are gone.

## Steam and smoke plumes (src/world/places/smoke.js, places.js)

- Plume model shared by the shader and a CPU mirror `plumePuff()` (`PLUME` constants): rise decays toward a
  wind-lowered ceiling (exp, `riseTau`), puffs drift downwind at 0.75x wind (uWindDir/uWindSpeed) and spread across it
  with age, each quad stretched along its projected motion; alpha fades with age (steeper in clear dry air: steam
  exponent 3.4 at low uCloudCover vs 1.8 humid, steam amount 0.55 in clear weather) and with height (gone by
  `PLUME.ceiling` 30 m above the source); fragment outline is noise-ragged instead of a round disc. Life 8/10 s
  (was 11/16 s), which with the old 6 m/s linear rise is what put 16 m discs ~70 m up.
- Bug found this pass: the stretched basis `(perp, dir)` used `perp = vec2(-dir.y, dir.x)` (determinant -1), which
  mirrored every quad; the FrontSide ShaderMaterial culled them all, so the previous iteration drew no steam at all
  (`qa/polish-visuals/diag2/`: control quads 183k magenta px, dir/perp basis 0 px). Fixed to `vec2(dir.y, -dir.x)`.
- Tuning after the fix (first render, `qa/polish-visuals/smoke-after3/`, showed long thin streaks rising into the sky):
  rise 12/18 m (was 14/26), riseTau 2.8/3.8 s (exit ~3.4 m/s), puffs 1.0-2.0 m at the stack growing to 5.5-9 m,
  height fade from 45% of the ceiling, stretch 1 + 0.75 (was 1.1), cross width 0.9, 22 puffs per steam stack (was 16)
  so the plume stays joined near the stack.
- Test: `tests/places-smoke.test.mjs` (no puff top above 40 m for any wind/age; anything reaching the ceiling has
  alpha 0; stronger wind bends the plume over; the quad basis keeps front-face winding - fails on the old perp).
- Verified (`qa/polish-visuals/smoke.json`; before `smoke-before/`, final `smoke-after4/`): cannery row, St. Herman
  harbor and the Kodiak overview at 09:00 clear show no discs in the sky; close stack views show thin plumes leaving
  the stacks and bending downwind, gone within ~20 m in clear air; 09:00 overcast plumes are denser and longer; 20:30
  wisps are faint and warm-lit.

## Final checks

- `node --test tests/terrain*.test.mjs tests/places*.test.mjs` 52/52; `npm test` 571/571
  (`qa/polish-visuals/npmtest.log`); `node tools/smoke.mjs --scenario=basic --out=qa/polish-visuals/final --strict`
  PASS, 60 fps, all systems ok.
- Scratch left in `qa/polish-visuals/`: `diag.json`/`diag2.json` (shader isolation runs) and `magenta.mjs` (counts
  magenta pixels in screenshots).
