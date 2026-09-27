# WP-PLACES — notes

Owner files: `src/world/places.js`, `src/world/places/**`, contents of `src/data/places.js`, `tests/places.test.mjs`,
`tests/scenarios/places-*.json`, `qa/places/`.

## Summary

The places system is the named geography of the Kodiak archipelago plus everything people built on it.

- **Data** (`src/data/places.js`, exports and signatures unchanged): 81 places (1 town, 6 villages, 2 harbours,
  4 canneries, 2 hatcheries, 17 bays, 3 straits, 10 capes, 3 peaks, 4 lakes, 7 rivers, 5 lights, 6 history sites
  including the Awa'uq memorial, 3 wildlife sites, 3 islands, 3 landmarks, 2 viewpoints), 19 salmon streams with
  species and closed-waters radii (150–350 game m), the seven Kodiak Management Area salmon districts as coarse
  polygons following 5 AAC 18.200 (Afognak, Northwest Kodiak, Southwest Kodiak, Alitak, Eastside Kodiak, Northeast
  Kodiak, Mainland), 197 developed-ground footprints generated from the built layout, the Marmot Island Steller sea
  lion rookery buffer (470 m game ≈ 3 nm), and `SPAWN` (open water in the St. Paul Harbor approaches).
- **System** (`src/world/places.js`): the §6.5 API over the resolved data, and the built world:
  - City of Kodiak (showpiece): St. Paul Harbor behind an L-shaped rubble breakwater with two floats of seiners,
    gillnetters and skiffs; city pier and ferry terminal; cannery row (three plants on pilings, tenders unloading,
    steam stacks); downtown blocks; about 300 buildings in all, houses climbing the west knoll and north/east
    slopes; Holy Resurrection Cathedral (~21 m to the cross, five blue onion domes, bell tower) on its rise; six
    Pillar Mountain wind turbines on the ridge line with yawing nacelles, spinning rotors (wind-driven, ≤16 rpm)
    and synchronised red aviation lights;
    the Near Island bridge; St. Herman Harbor with an inner line of crabbers/tenders and an outer float of limit
    seiners, a boatyard with hauled-out boats, and the Fisheries Research Center.
  - Coast Guard Base Kodiak on Womens Bay: 170 m cutter pier with a medium-endurance cutter (racing stripe),
    hangars, barracks, apron with two Jayhawk helicopters, tanks, radio mast.
  - Villages Ouzinkie, Port Lions, Old Harbor, Larsen Bay, Akhiok, Karluk: houses facing the water, school and
    store, pier + float with boats, fuel tanks where the place sells fuel, and each village's Orthodox church
    (per-village dome colour/tower style; Old Harbor's Three Saints church has three domes, Karluk's green dome).
  - Canneries at Larsen Bay, Alitak (Lazy Bay) and Port O'Brien (Uganik): plant on pilings, sheds, steam stack,
    wharf lights, a tender alongside, bunkhouses, tanks, pier out to the dock.
  - Kitoi Bay hatchery (building, raceways, net pens) and Pillar Creek hatchery.
  - Pacific Spaceport Complex on Narrow Cape: pad with flame trench, 46 m red/white banded umbilical tower with
    hammerhead crane and lightning mast, rocket on the stand, rolling service structure, lightning masts with
    obstruction lights, processing facility, range control, gravel road.
  - Fort Abercrombie: two 8-inch gun emplacements (ring parapet, carriage, shield, barrel) and the earth-covered
    ready-ammunition bunker, in spruce clearings behind the beach.
  - Five light towers (skeleton tower, daymark, keeper's shed) with their real flash characteristics, 19 channel
    buoys (red nuns / green cans) riding the waves, 38 ADF&G closed-waters markers where each stream's closed
    circle meets the shore.
  - Lit windows (procedural, per-window lit/brightness/warm-or-cool tint, fewer after midnight) driven by
    `sky.daylight`; streetlamps, porch lights, float lights; chimney smoke and cannery steam.

## API as built

Required (§6.5): `list` (resolved places), `get(id)`, `nearest(x, z, filter?)` → `{place, distance} | null`,
`within(x, z, r, filter?)` (nearest first), `streams`, `districtAt(x, z)` → district name, `spawn` `{x, z, heading}`.
Also: `districts`, `closedAreas`, `footprints`.

Additions (safe to use):
- Filters everywhere accept a predicate, a kind string, or an array of kinds.
- `placeAt(x, z, filter?)` — place whose discovery radius contains the point (smallest radius wins).
- `districtIdAt(x, z)` — district id (`northeast`, `northwest`, `southwest`, `alitak`, `eastside`, `afognak`,
  `mainland`).
- `stream(id)`, `nearestStream(x, z, maxDist?)` → `{stream, distance} | null`.
- `closedAt(x, z)` → `{kind: 'stream'|'area', id, name, x, z, radius, reason?} | null` (stream mouths + CLOSED_AREAS).
- `isDeveloped(x, z)` (bound to ctx.geo).
- `group` (THREE.Group of everything built), `dispose()`.
- `layout`: `{ kodiak: {dock, bridge, cathedral, ridge}, sites, lights: [{id, x, y, z}], spaceport: {x, z, rot},
  markers: [{streamId, x, z}], turbines: [{x, y, z, hub}] }` — world positions for cameras, title shots and tests.
- `debugState()` → `{places, streams, chunks, triangles, glows, smoke, turbines, buoys, markers, night, nav,
  failures}`.
- `serialize()` returns undefined (nothing persisted); `reset()`/`restore()` are no-ops.

Data fields added to places (the frozen header documents them): `real` (true position of the feature when the
game position had to be moved), `light` (`{color, period s, flashes}`), `church` (village church style),
`district` (filled by `resolve()` from the polygons). Streams carry `placeId` when they have a place card.
`CLOSED_AREAS` entries carry `placeId`. New export `SPAWN` (`{lat, lon, heading deg}`); `resolve()` also fills
`place.district`. `isDeveloped` keeps its signature but uses a 200 m hash grid (1e6 calls ≈ 90 ms).

## Deviations and decisions

- **Coordinates fitted to the DEM.** The ~90 m source DEM closes many narrow waters (Near Island channel ends,
  Sitkalidak Strait at Old Harbor, Settler Cove, Uganik's Northeast Arm, Kupreanof Strait, Whale Pass) and
  shallows Alitak and Olga bays. Settlements, docks, stream mouths and water labels sit on the nearest shore or
  water the game actually has; `real` keeps the true position. Largest moves (game m): Old Harbor ≈1,500 (to the
  open south end of Sitkalidak Strait), Port O'Brien ≈1,700 (Northeast Arm absent), several stream mouths
  800–1,200 (Uganik, Kizhuyak, Sturgeon, Dog Salmon). Ids and anchors are what fleet/season/economy already use.
- **Layout seed.** Settlements are laid out with a fixed seed (`LAYOUT_SEED` in `src/world/places.js`), not the
  game seed, because `FOOTPRINTS` (static data read by terrain at boot) must match the buildings for every
  `?seed=`. This is the one departure from "fork ctx.rng"; ctx.rng is still forked for smoke puffs.
- **Footprints are generated.** `node src/world/places/genFootprints.mjs` rebuilds the layout headlessly and
  rewrites `FOOTPRINTS`; a test fails if any structure site falls outside them.
- **Turbine scale.** Towers and rotors are ~43% of the real GE 1.5 MW (hub 34 m, rotor radius 16.5 m) so they
  sit on the 1:11.75-compressed ridge without dwarfing it; buildings, boats, the cathedral (~21 m to the cross)
  and the launch tower are true scale.
- **Districts** are coarse polygons that include land; latitude lines and midstream Shelikof Strait follow the
  regulation (Termination Point 57°51.37′ bounds Northwest Kodiak; Cape Chiniak latitude bounds Eastside).
- **Nav lights** switch on at sunset (`uNav`, daylight < 0.5) like photocells; windows and lamps follow the later
  `uNight` curve.

## Tunables

- `src/world/places.js`: `VILLAGE_OPTS` (houses, radius, boats per village), `LAYOUT_SEED`, chunk cull distance
  (9 km), `uNav`/`uNight` curves and `uLitFrac` (lit-window fraction by hour) in `updateLighting()`.
- `src/world/places/city.js`: `KODIAK_LAYOUT` (harbour axes, dock, bridge ends, cathedral, turbine ridge line),
  `TURBINE` (hub, rotor, tower radii), house lot counts per district.
- `src/world/places/materials.js`: window colour (`uWinColor`), lamp colour, window cell sizes per facade type.
- `src/world/places/glows.js`: flash shape, halo strength, minimum on-screen size (5 px).
- `src/world/places/smoke.js`: puff life, rise, drift, size; `puffs` per emitter (8) in places.js.
- `src/world/places/landmarks.js`: `BUOYS` list (positions, colour, lit), spaceport tower height, light tower height.

## Perf

Numbers from `tests/scenarios/places-bench.json` (`--bench`, 1280×720) on the shared GPU; eleven other agents were
running smoke tests, so gpuMs varied 65–230 ms between identical runs.

- CPU: `perf().systemsMs.places` 0.11–0.13 ms (turbine/buoy instance updates, lighting uniforms).
- Content: 24 merged chunks + nacelles, rotors, 2 buoy meshes, glows (383 instances, 1 draw), smoke (2,056 puffs,
  1 draw, off on `low`); 57.9k triangles.
- Full game, Kodiak views: +32–34 draw calls and +75k triangles (main + shadow passes) vs `skip=places`
  (134 vs 101 draws; 3.07 M vs 2.99 M triangles). frameMsAvg differences were within run-to-run noise.
- Isolated (`only=places` vs all stubs, 3 runs × 3 views): +28–29 draws, +64–72k triangles; gpuMs 3.4–7.0 vs
  3.9–21.5 (noise-bound); in the quietest runs frame time +1–2.5 ms at 200–400 fps, where frames are
  submission-bound. Estimated GPU ≤ ~1 ms, within the 1 ms places budget.

## Screenshots

`qa/places/final-shots/` (shot scenario `tests/scenarios/places-shots.json`, run with `skip=ui`):
- `kodiak-approach-noon.png`, `kodiak-overview-noon.png` — the city from the harbour approach
- `cathedral-noon.png` — Holy Resurrection Cathedral among the houses, turbines above
- `kodiak-approach-night.png`, `kodiak-harbor-night.png` — lit windows, streetlamps, buoys, turbine lights
- `village-ouzinkie-golden.png`, `village-oldharbor-golden.png` — villages at golden hour
- `cannery-larsen-golden.png` — Larsen Bay cannery against the sun
- `turbines-noon.png`, `turbines-golden.png` — Pillar Mountain turbines
- `spaceport-noon.png` — the launch tower
- `light-chiniak-dusk-b.png` — Cape Chiniak light flashing at dusk (a/c are between flashes)
- `fort-noon.png`, `marker-buskin-noon.png`

Also `qa/places/r1/harbor-close-noon.png` (St. Paul Harbor floats), `qa/places/t1/` (every village and cannery from
the earlier tour) and `qa/places/final/` (strict basic smoke: spawn view of Kodiak with the HUD).

Full test run: `npm test` 316/317 pass; the one failure is WP-OCEAN's `heightAt is fast enough` timing test under
parallel load (passes alone).

## Known issues

- Place positions follow the game DEM, not always the real map (see Deviations); the `real` field and blurbs keep
  the true geography.
- Lights flash with real characteristics (e.g. Fl 6 s), so a single screenshot can land between flashes.
- The window pattern is procedural on every wall of a building; there is no per-building interior variation.
- Smoke puffs are culled beyond ~1.6 km; very large smoke overdraw only occurs with the camera inside the town.
- `markers` and `lights` chunks span the whole map, so they are never frustum-culled (a few thousand triangles).

## Requests to other work packages

- WP-TERRAIN: vegetation already respects `isDeveloped`; footprints now also cover light towers, the fort, turbine
  pads, markers and the spaceport. If you add ground decals (roads/gravel pads), `FOOTPRINTS` is a good mask.
- WP-FOOT: `src/world/places/walk.js` exports `findFootPath(heightAt, from, to)` and `footSpeed(slopeDeg)` matching
  §6.14's slope rules; every `onFoot` place's `landing` is tested reachable with it.
- WP-RULES / WP-UI: `places.closedAt(x, z)`, `places.districtIdAt(x, z)` and `places.placeAt(x, z)` are available;
  place `district` ids match the district polygons.
- WP-BOATS (cameraRig title shots): `places.layout.turbines`, `.lights`, `.spaceport` and `.kodiak` give good
  framing targets (turbines at golden hour and Kodiak at night look best).
- WP-SKY: nav lights use `sky.daylight` thresholds 0.5→0.3 for "sunset"; if daylight's scale changes, the curves in
  `updateLighting()` need the same change.

## Core changes

None.

## Sources

- ADF&G, *2024–2027 Kodiak Area Commercial Salmon Fishing Regulations* (5 AAC 18.200 district descriptions,
  closed waters): https://adfg.alaska.gov/index.cfm?adfg=fishregulations.commercial
- OpenStreetMap via Nominatim (place geocoding) and Overpass (seamarks, lights, rocks), ODbL:
  https://nominatim.openstreetmap.org, https://overpass-api.de
- NOAA nautical chart catalogue: http://www.charts.noaa.gov/InteractiveCatalog/nrnc.shtml
- City of Kodiak Port & Harbors (St. Paul 250 slips, St. Herman 325 slips): https://www.city.kodiak.ak.us/ph
- Pillar Mountain wind (KEA; 2009 + 2012 turbines, 99.7% renewable):
  https://www.windpowerengineering.com/alaska-sees-its-first-utility-scale-wind-turbine/,
  https://www.eenews.net/articles/on-kodiak-island-flywheels-are-in-and-diesel-is-99-8-out/
- Kitoi Bay Hatchery history (1954 USFWS, 1965 rebuild, KRAA): https://www.kraa.org/kitoi-bay-hatchery,
  https://www.adfg.alaska.gov/static/fishing/PDFs/hatcheries/annual_management_plans/2025_amp_kitoi.pdf
- Port O'Brien cannery (1926, San Juan Fishing & Packing, closed 1984): https://coastview.org/2025/05/26/port-obrien-uganik-bay/
- Alitak cannery (1917, PAF 1928): https://alaskahistoricalsociety.org/alitak-cannery-looking-forward-towards-100-years-of-operation/
- Old Harbor / Nuniaq and the 1964 tsunami: https://alutiiqmuseum.org/collection/Detail/word/371,
  https://explorenorth.com/alaska/history/old_harbor-history.html
- Kaguyak: https://alutiiqmuseum.org/collection/index.php/Detail/word/301,
  https://alaskahistoricalsociety.org/remembering-kaguyak/
- Akhiok chapel: https://en.wikipedia.org/wiki/Protection_of_the_Theotokos_Chapel
- Karluk chapel and the 1978 storm: https://en.wikipedia.org/wiki/Ascension_of_Our_Lord_Chapel,
  https://sah-archipedia.org/buildings/AK-01-SW009
- Frazer Lake stocking and fish pass: https://www.adfg.alaska.gov/index.cfm?adfg=CommercialKodiakresearch.project&id=4,
  https://alutiiqmuseum.org/collection/Detail/word/647
- Narrow Cape gray whales: https://www.adfg.alaska.gov/index.cfm?adfg=viewinglocations.kodiak
- Uganik Bay / Uganik River / San Juan (Uganik) seaplane base coordinates:
  https://en.wikipedia.org/wiki/Uganik_Bay, https://en.wikipedia.org/wiki/Uganik_River,
  https://en.wikipedia.org/wiki/San_Juan_(Uganik)_Seaplane_Base
- Steller sea lion 3-nm rookery no-approach zones: 50 CFR 224.103(d)
- Alutiiq Museum (Alutiiq place names: Sun'aq, Tangirnaq, Nuniaq, Awa'uq): https://alutiiqmuseum.org
- US Coast Guard (Base Kodiak, USCGC Alex Haley): https://www.pacificarea.uscg.mil/Our-Organization/Cutters/cgcAlexHaley/

## Test and run commands

- `node --test tests/places.test.mjs` — data vs heightmap (land/water, docks navigable and connected to the spawn,
  stream mouths at the coast, on-foot A* reachability from landings, districts, closed areas, footprints cover
  every structure, layout independent of the game seed), API, Node construction.
- `node tools/smoke.mjs --scenario=tests/scenarios/places-shots.json --out=qa/places/final-shots --params=skip=ui`
- `node tools/smoke.mjs --scenario=tests/scenarios/places-bench.json --out=qa/places/bench --bench`
- `node tools/smoke.mjs --scenario=tests/scenarios/places-review.json --out=qa/places/review` (close-ups, daylight
  readings)
- `node src/world/places/genFootprints.mjs` after any layout change.
