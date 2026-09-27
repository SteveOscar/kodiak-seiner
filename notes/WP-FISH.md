# WP-FISH — salmon schools, jumpers and the fish side of a set

## Summary

`src/entities/fish.js` plus `src/entities/fish/*` implement SPEC §6.10.

- **Simulation** (`fish/sim.js`, pure, DOM-free, unit-tested). 12–25 run-driven schools weighted by
  `season.speciesMix` × the run calendar (`config.fish.runs`, species out of run are gated to 0) and anchored on
  `places.streams`. Schools come in from offshore, follow the coast in the flood direction of `ctx.tide`, keep an
  offshore band, mill off points and at bay heads, stack up off their stream as the run peaks (then may enter it and
  leave the world), and all mill with jumpRate ×1.5 within 30 game min of slack. Steering runs at 2 Hz per school,
  terrain feature checks at 0.25 Hz. Far (> 7.6 km) and old schools are despawned and replaced near the seiner.
- **Open-period guarantee**: every 2 s during `season.openerActive(seiner)` (or free explore) at least 2 catchable
  schools (migrating/milling/spooked, outside closed waters, water depth ≥ 8 m, ≥ 50 fish) exist within 1,500 m,
  spawned 600–1,450 m away and outside the camera frustum (frustum + terrain line of sight).
- **Tutorial school** on `game:start {newGame, !freeExplore}`: a milling pink school (4.2–6k fish) 520–680 m from the
  seiner, preferring the spawn heading, jumpRate ×3, `spookable: false`, never despawned by age.
- **Spooking** exactly per spec: boat speed > 8 m/s within 40 m of the school edge, any hull (seiner, skiff, fleet boat)
  inside the school radius above 2 m/s, the horn (`boat:horn`) within 150 m, the skiff splash
  (`fishing:skiffReleased`) within 20 m. Paying out at ≤ 7 m/s outside the radius never spooks. Spooked schools flee
  at up to 2.6 m/s for 14–28 s; chum and sockeye sound (dive to 14–24 m for 60–150 s) on the second spook
  (`soundsAfterSpooks`, default 2 for sockeye).
- **Re-seed** on `time:skip`; re-home (drop > 7.6 km, fill the new neighbourhood) on long teleports.
- **Net interaction** (reads `ctx.systems.net`, works with the stub net and with WP-NET's real net — a full scripted
  set through pursing, hauling and brailing caught 4,396 of 6,000 pinks, rating "good"):
  - open net: a school may cross the polygon boundary only through the gap edge; meeting the web deflects its
    velocity along it; inside the hook it mills in the bight (centroid pushed away from the gap); close to the gap
    (or spooked) it runs for it, and leaving through it emits `fishing:escape {viaGap}`; a hook leaks 0.4%/s (×3 when
    the hook area collapses below 40% of its best area).
  - close-up: the fraction of the school disc inside the corkline is enclosed; the outside part splits off as its own
    school; a fringe of 10–18% boils out as the ends meet.
  - leadline escape per second `0.012 · leadlineEscape · (1 − pursed)² · (1 − 0.8·bottomContact on mud/sand/gravel)
    · deep · (×8 sounding) · (×1.25 snag hole)`; trapped at pursed ≥ 0.98 (a snag hole keeps leaking until hauled
    past 60%). Hauling fast in a current (or `net.corksUnder`) above 80% hauled leaks too.
  - the bag: trapped fish follow the shrinking net polygon (ellipse fit), crowd upward as `hauled` → 1 and thrash;
    bag flips (`style: 'thrash'`, throttled `fish:jump`), spray and a soft foam stamp.
  - `harvest()` returns what is still inside, capped per species at the clean-set ceiling (`capture[1]`), marks the
    schools captured (they stay visible in the bag for ~7 s of brailing, then vanish when the net is stowed), and
    reports the spill as `fishing:escape {overCorks}`. Abort (net stowed without brailing) releases the fish.
  - Tested outcomes: clean set (close 10 s, rings up in 20 s) lands inside each species' capture range; sloppy set
    (55 s closed, 40 s pursing) lands in 15–40% (pink 36–40%, sockeye 16–17%); outside at close-up or sounded → water
    haul.
- **Rendering** (`fish/render.js`, `salmonGeometry.js`, `salmonMaterial.js`, `fx.js`):
  - procedural salmon: lofted fusiform body (superellipse sections, arched back, pointed snout, slim peduncle), forked
    caudal, dorsal, adipose, anal, pelvic and pectoral fins; LODs of 578 / 314 / 84 triangles.
  - ocean-bright colouring by species in the fragment shader: narrow dark back, mirror-silver flank, white belly, eye,
    gill cover, lateral line, scale-lattice sheen, faint thin-film tint. Pink: blue-green back, large black ovals on
    both tail lobes and back, hump on ~half the fish late in the season. Chum: faint vertical bars. Sockeye: bright
    silver, steel-blue back. Coho: small spots on the back and the upper tail lobe only. King: large, spotted back and
    both lobes. Flank reflections sample `sky.envMap` (CubeUV) above water; submerged fish mirror the water column.
  - school fish are placed entirely on the GPU: 8 slots (slot 0 = 1,024 fish for the net school or the nearest
    school, 7 × 136 others; ~2,000 total), per-fish static offsets, per-slot uniforms (centre, heading, radius, mill,
    thrash, species mix, bag ellipse). Migrating schools swim as an elongated parallel school, milling ones as a lobed,
    breathing doughnut, the bag as a packed, rolling, surface-boiling mass. Vertex-shader swimming (travelling body
    wave, tail beat, C-curl, roll). Slots fade in/out (no popping).
  - jumpers and finning chum: CPU-posed instances of the high LOD, with a ~5 px minimum silhouette.
  - `kodiak_underwater` + an extra depth haze on all fish; fog chunks everywhere.
- **Jumpers** (`fish/jumps.js`): pink popcorn (short, low, 1–2 pops), sockeye clean head-first leap, chum heavy jump
  landing flat on its side, coho high twisting leaps with tail-walking between 2–4 arcs, king a rare back-roll.
  Every leg is within ±25° of the school heading (bag flips excepted). Exit and re-entry splashes (crown sheets,
  motion-stretched droplets, Worthington column for heavy entries, mist; band 200), ripple stamps inside the water's
  stamp field and my own expanding rings outside it (band 100, 4–6 s), sun-glint stars (band 400) from a
  half-vector-vs-body-axis test (backlit fish flash off the back, front-lit off the flank), finning V-wakes (band 100)
  for milling chum schools, nervous-water ripples over shallow milling schools.
- **Readability at range**: every splash scales as a whole to max(real size, 0.004 × distance); an extra upright
  "far plume" (0.007 × distance, brighter than the horizon it is seen against, fogged at 45% density) fades in beyond
  35 m, so jumps read as white flecks at 800 m by eye and as a clear splash crown at 3 km in binoculars (fov 12°).
  Glints are fogged at 35% density.

## API as built

`schools`, `nearestSchool(x, z, maxDist = ∞)`, `schoolsWithin(x, z, r)`, `schoolsInside(polygon)`, `harvest()`,
`sonarReturns(x, z, range = economy.modifiers.sonarRange ?? 150)`, `spawnSchool({x, z, species, count, milling,
jumpRateMul?, spookable?, radius?, depth?, mix?})`, `debugState()`, `serialize()` → undefined, `restore()`, `reset()`.

School objects: `{ id, species, mix, count, position (Vector3, y = −depth), velocity (Vector3), radius, depth, state,
targetStream, jumpRate }` plus read-only extras (`heading`, `tutorial`, `spookable`, `spooks`, `net` (in-net record),
`bag`, `hump`, …). Queries exclude `captured` and `gone` schools; `sonarReturns` entries are exactly
`{x, z, depth, strength}` (2–7 marks per school, no species).

Debug/QA members: `jumps` (active jump choreography), `sim`, `debugJump(schoolId?)` (launch one jump now),
`debugBag({x?, z?, species, count, hauled, animate?, seconds?} | null)` (a scripted pursed net beside the seiner for
bag shots without the real net), `debugRender` (`stats`, `fx`, `meshes`, `setHidden(bool)` for paired GPU timing,
`setGallery({x, y, z, heading} | null)` for a species line-up).

Events: `fish:jump {x, y, z, species, size (fish length m), schoolId, heading, style}` (style ∈ popcorn, leap, flop,
tailwalk, roll, thrash), `fish:spooked {schoolId, x, z, reason}`, `fishing:escape {count, species, schoolId, viaGap?,
released?, overCorks?}`.

### Deviations / decisions

- "Instanced per species": one instanced mesh per LOD with the species chosen per instance (mixed-stock schools
  show their minority species too). Same look, 3 draw calls instead of 10.
- No tutorial school in Free Explore (the spec ties it to a new season); the guarantee still applies there.
- Capture targets are produced by the escape physics plus the clean-set ceiling rather than by a mapping table; a
  very sloppy set (minutes closed without pursing) can fall below 15%.
- The far plume and glints use reduced fog density and a floor at 2.2 × the horizon colour: a readability aid in the
  spirit of the minimum-size rule.
- The tutorial school's `jumpRate` already includes the ×3.

## Tunables

- `fish/sim.js`: `GUARANTEE` (count 2, radius 1,500, spawn 600–1,450 m, depth 8), `WORLD_LIMIT`, `MAX_JUMPS` (90),
  mill durations, offshore band 90–340 m, flee speed 2.6 m/s, sounding 60–150 s.
- `fish/netModel.js`: `LAMBDA0` 0.012/s, `PURSED` 0.98, `FRINGE` 0.82–0.9, `GAP_LEAK` 0.004/s, `HOOK_COLLAPSE` 0.4,
  `SOUNDING_ESCAPE` ×8.
- `fish/species.js`: `FISH_LENGTH`, `JUMP_STYLES` (height, length, arcs, walk, pitch, flop, twist, splash).
- `fish/render.js`: slot capacities (1,024 + 7 × 136; 512 + 7 × 96 on `low`), `SCHOOL_VIEW` 300 m, `FX_RANGE` 7 km,
  glint size/life, ripple/foam stamp strengths. `salmonMaterial.js`: `uLodDist` 22 m, `uMaxDist` 260 m, colours.
- `fish/fx.js`: particle pool 4,096 (2,048 on `low`), far-plume 0.007 × distance, splash counts and sizes.

## Performance

- CPU: `perf().systemsMs.fish` 0.04–0.13 ms (sim); the render hook (in `pipeline.beforeRender`, not counted there)
  0.10–0.11 ms EMA (`debugState().fish.render.cpuMs`), including a dense bag with 1,024 fish and ~20 jumpers.
- GPU (the GPU is shared with ~11 concurrent agents, so whole-frame deltas are noise; measured instead by rendering
  only the fish objects 20× inside a timer query, minima of several runs): normal chase view ~0.1–0.5 ms; hovering
  15 m over a 1,024-fish school ~0.3–0.7 ms; camera 10 m from a dense drying bag ~0.8 ms; the near-LOD school mesh
  dominates. Earlier optimisations: slot instance ranges and hidden idle meshes, 22 m near-LOD distance, indexed fins
  (mid LOD 344 → 236 vertices), no env fetch for submerged fish, 2×2 arithmetic-hash spots, pattern-free far LOD.
- Draw calls: ≤ 7 (school near/far, jumpers, splash points, glints, rings, wakes), fewer when idle. Counted triangles
  +0.4 M over a school (mostly collapsed instances).
- Strict basic smoke: PASS, fish `ok`, no errors or warnings.

## Known issues

- GPU budget is tight only in the worst case (camera very close over or inside a dense bag); the numbers above are
  inflated by GPU sharing. If it bites on real hardware, lower slot 0 capacity (`caps[0]`) or `uLodDist`.
- The water system renders every ripple stamp with a frothy disc; jump ripples are kept weak so those read as soft
  splash rings rather than foam patches.
- Glints are brief (0.2–0.38 s) by design; most still frames of distant jumps show splashes rather than glints.
- Finning chum dorsal fins are small at crow's-nest range; the V-wake is the readable cue.
- Smoke runs on the live tree can be hot-reloaded by other agents' edits; my iteration shots ran from a frozen copy
  via `qa/fish/snap.sh` (gitignored qa/).

## Screenshots (qa/fish/best/)

1. `01-jump-closeup-chum-over-school.png` — evening chum leap, its school below.
2. `02-jump-coho-reentry-over-school.png` — coho re-entry splash over the school in turquoise shallows.
3. `03-school-crowsnest-near-shore.png` — milling pinks under the surface from crow's-nest height near a beach.
4. `04-chum-school-shallows.png` — chum school near the village shore.
5. `05-golden-hour-jumpers-glints.png` — golden-hour jumpers with sun glints across the bay.
6. `06-jumpers-800m-by-eye.png` — jumps at ~800 m by eye.
7. `07-jump-3km-binoculars.png` (+ `07b-…-crop.png`) — a jump at 3 km through binoculars.
8. `08-trapped-bag-real-net.png` — the drying bag in WP-NET's real net (the money shot).
9. `09-bag-beside-seiner.png` — the bag beside the Northern Dawn.
10. `10-species-gallery-evening.png`, `11-pink-closeup-tail-spots.png` — species line-up and pink detail.

Scenarios: `tests/scenarios/fish-shots.json` (close-ups, bag via debugBag), `fish-hero.json`, `fish-distance.json`
(800 m / 3 km), `fish-golden.json` (glint-triggered stills), `fish-realset.json` (a full real set), `fish-bench.json`.

## Tests

`node --test tests/fish.test.mjs tests/fish-net.test.mjs tests/fish-jumps.test.mjs` — population, migration, tutorial,
open-period guarantee (4 locations, spawn distance/out-of-view/depth/closed-water), spook rules (speed/hull/horn/skiff,
7 m/s payout), sounding by species, queries and sonar, ±25° jump headings (sim and choreography), slack milling,
system contract and wiring (tutorial, time:skip re-seed, horn), escape maths, capture ranges for all four species
(clean and sloppy), water hauls (outside, sounded), bottom contact and snag hole, split at close-up, deflection, hook
milling, gap escape, bag and single harvest, abort release, geometry and LODs.

## Requests to other work packages

- WP-NET: please keep `net.hole` (boolean while a snag hole is open) and `net.corksUnder`; fish read both. The bag
  already gets foam from the net; fish add only a light stamp.
- WP-OCEAN: a ripple stamp option without froth (or froth scaled separately from ring amplitude) would let small
  jumps ring the water without a white disc.
- WP-BOATS (cameraRig): binocular sightings can rely on `fish:jump` (`style`, `heading`, `schoolId`); jumps are
  emitted for every school within 7 km of the camera even when not drawn.
- WP-UI: sonar marks come from `fish.sonarReturns(x, z, range)` (range defaults to `economy.modifiers.sonarRange`).
- WP-AUDIO: `fish:jump.size` is the fish length in metres; `style` distinguishes a chum belly-flop from pink popcorn.

## Core changes

None.
