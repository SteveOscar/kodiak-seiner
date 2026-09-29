# FIX-sky — QA fixes (sky / mist / postfx)

- [14] Aurora phantom ridges: `src/world/sky/shaders.js` `aurora()` — the lower border is now the brightest part of the
  curtain (thin pale-green fringe) and glows softly downward (two exponentials, 4.5 km + 14 km) instead of a
  smoothstep cut; the glow below the border stays green (the old violet/grey wash read as haze over land); violet is a
  thin strip in bright rays only; the far sheet meanders 0.35x as much, weighs 0.38 (was 0.55) and has no crisp border
  (it only deepens the glow under the near arc); both arcs fade toward the horizon (`smoothstep(0.02, 0.17, dir.y)`).
  Verified: `qa/fix-sky/aurora.json` → `qa/fix-sky/aurora2/` (day 45 01:30 from Kodiak at 12 m and 400 m, day 45
  23:30 over town, open water north in Shelikof and north of Kodiak): one luminous lower border, no stacked dark bands.
- [34] Faint round puffs in the clear 09:00 sky: isolated — NOT sky mist or the dome. `H.isolate('^sky-mist$')`,
  hiding `sky-dome`, postfx off and hiding wildlife all leave them; hiding `places-smoke` removes them
  (`qa/fix-sky/puffs-iso/`, `qa/fix-sky/puffs-iso2/02-nosmoke.png`). They are the cannery steam puffs from
  `src/world/places/smoke.js` (WP-PLACES): steam rises ~70 m (6 m/s × 16 s life / (1 + 0.1 wind)) and grows to 16 m
  round discs at alpha ≈ 0.36. Outside this package — request to WP-PLACES: fade steam by height/age much sooner
  (gone by ~25–30 m above the stack), cap the size near 6–8 m and shear it downwind so it never reads as round discs.
- [15] Bay fog slab: `src/world/sky/mistSites.js` — `bayWeatherScale(mist)` (clear 0.2, partly 0.47, overcast+ 1)
  scales bay presence; `morningFactor` burns off 07:15–09:00 (was 07:30–10:00); marine fog contributes 0.85.
  `src/world/sky/mist.js` — bay density scales with presence (`amount`), the pool thins toward a noisy top whose height
  varies in plan (230 m noise, 0.4–1.6×), shallower when thin; soft foot at the waterline widening with distance
  (WP-OCEAN's "hard white stripe" request). Verified: `tests/sky-fixes.test.mjs` (weather scale ratios, 09:00 = gone,
  marine fog still fills bays), `qa/fix-sky/bayfog1..2/` (Kodiak town 05:15 and 09:00 clear, Three Saints 05:15, calm
  dawn clear/partly, morning bays partly/overcast, fog 14:00).
- Fog preset (WP-RULES request): `src/world/sky/weather.js` visibility 600 → 1100 m, mist 1 → 0.85; visibility now
  lands exactly on the preset at the end of a transition. Verified: `tests/sky-fixes.test.mjs`,
  `qa/fix-sky/bayfog2/11-fog-1400.png`, `qa/fix-sky/crowsnest1/05-kalsin-fog-chase.png`.
- Crow's nest readability (finding [0], mist half): `src/world/sky/mist.js` reads `ctx.systems.cameraRig?.mode`
  (optional); in `crowsnest` above 20–50 m a `uOverhead` fade (eased) removes up to 92% of mist density on rays looking
  down more than ~12–33°, the in-bank fog boost drops by 85%, and `src/world/sky.js` lifts the fog-chunk cloud-deck
  base above the camera (+45 m) so the ragged deck never lies between the camera and the sea. Verified:
  `tests/sky-fixes.test.mjs` (fade engages/eases/releases, insideFog), `qa/fix-sky/crowsnest1/` (Kalsin Bay 06:00
  partly, 07:39 partly, overcast, fog: sea, school and seiner clear from 60 m).
- Final checks: `npm test` 546/546 pass (`qa/fix-sky/npmtest.log`); `node tools/smoke.mjs --scenario=basic
  --out=qa/fix-sky/final --strict` PASS, 60 fps, all systems ok; golden-hour evening frame unchanged.
- Not changed here: `notes/WP-SKY.md` (outside this task's ownership) still describes the old aurora border, the
  07:30–10:00 burn-off and the 600 m fog preset; the entries above supersede those lines.
