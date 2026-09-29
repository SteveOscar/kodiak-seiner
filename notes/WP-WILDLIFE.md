# WP-WILDLIFE — notes

Owner files: `src/entities/wildlife.js`, `src/entities/wildlife/**`, `tests/wildlife.test.mjs`,
`tests/scenarios/wildlife-*.json`, `qa/wildlife/`.

## Summary

The living coast (SPEC §6.13). Everything is placed deterministically from the DEM and the places data with
`ctx.rng.fork('wildlife')` sub-forks, simulated with distance LOD around the camera, and drawn as instanced,
vertex-animated meshes filled once per frame from a camera-following `pipeline.beforeRender` hook (CPU frustum +
projected-size culling per animal, two geometry LODs per species, a readable minimum pixel size for birds at range).

- **Birds** (`wildlife/birds.js`): glaucous-winged gulls following the seiner (hanging in the slipstream over the
  wake, constantly trimming, flap-glide bursts; loitering in circles and settling on the water when the boat idles),
  working flocks wheeling low and diving over nearby schools (a deterministic ~45% of schools, plus bait flocks with
  no salmon so ~30% of all working flocks are over bait — unit tested), a 40-bird swarm over the bag while pursing,
  hauling and brailing (followers join in), feeding frenzies over bubble nets, resting flocks on beaches that lift off
  at the horn. Bald eagles soar in the updraft just seaward of the steepest sea cliffs (circles drift along the
  cliff, always clear of the ground), perch on procedural spruce snags at the forest edge and on shore rocks, and make
  stooping sorties to snatch fish from the surface (splash, ripple, foam). Tufted puffins raft on open water off
  their islets, dive for sand lance, stand on the rocks, and whirr past low over the sea (flight loops are checked to
  stay over water). Pelagic cormorants stand on the rocks, some drying their wings spread.
- **Marine mammals** (`wildlife/marine.js`): humpbacks in every deep named bay/strait plus a roaming visitor kept
  within a few km of the boat ("always a distant blow"). Timeline-driven behaviour (frame-rate independent):
  breath series (rise, blow, rolling arched back, sink), a classic fluke-up dive (tail stock and flukes rise ~3 m
  clear, water streaming off the trailing edge), breaches (head-first exit with a burst of white water, twisting
  fall, a full eruption on landing: entry jets along the body, crown of sheets, ~560 streaking drops, a drifting
  pall of mist, foam and ripple stamps), rare bubble-net feeding (a spiral of foam, gulls pour in, 2–3 whales lunge
  vertically with throats ballooning). Breaches are commoner in the golden evening and in wind. A rare orca pod
  (bull with a 1.8 m straight dorsal, cows, a calf) passes through on a straight transit with a surfacing rhythm and
  narrow blows. Sea otter rafts in rocky kelp shallows (favouring the forested north-east) float on their backs on
  `water.heightAt`, groom, eat, dive, carry pups, and dive when a boat bears down. Steller sea lions pack onto low
  ledges of islets and exposed points (bulls, cows, juveniles; heads up, roaring, swimmers circling offshore); the
  Marmot Island rookery (150 animals) stays inside its CLOSED_AREAS buffer and stampedes into the water if a boat
  enters the buffer (or comes within 120 m of any other haulout), hauling out again later. Harbor seals haul out on
  beaches and bottle off stream mouths.
- **Land animals** (`wildlife/land.js`, `wildlife/bear.js`): Kodiak brown bears at every stream mouth
  (`places.streams`), the O'Malley River and remote beaches — sows with 1–3 cubs (Karluk always has a family), big
  boars, subadult siblings. Bears fish in knee-deep water at their own wading spot (refined on the rendered terrain;
  pounces with splashes and foam), walk beach paths, graze sedge meadows, rest. Cubs keep their own agenda (follow,
  sit and watch mother fish from the bank, nose about, play-fight a sibling). Dedicated bear model: shoulder hump,
  hanging belly, dished face, small round ears, long pale front claws, golden-tipped guard hair, shaggy silhouette,
  fur sheen; weighty procedural quadruped gait (legs swing mostly below buried upper limbs, knees fold on the swing,
  body bob and roll), pitch/roll to the slope on `terrain.heightAt`, rearing up to watch, lying down to rest. A bear
  that comes back into range resumes where its activity would have taken it. Sitka black-tailed deer on green
  hillsides, mountain goats on high cliffs and a red fox on the wrack line (all flee a person on foot).
- **Bear encounters** (SPEC §6.13): per-bear state machine (`behaviour.js`): a person on foot within 30 m makes the
  nearest adult stand up and watch (`bear:encounter {stage: 'watch'}`), closing to 10 m provokes a bluff charge
  that stops short (`'charge'`), then `'retreat'`; backing off past 48 m, 22 s of watching or going aboard ends it; a
  25 s cooldown per bear. Only one bear watches or charges at a time; retreating bears finish on their own.
- **Sightings**: `wildlife:sighted {kind, x, z, first}` once per kind per session when an animal is seen well: in view
  (within ~0.42 × fov of the view axis), projected ≥ 11 px (≈150 m by eye for a bear; the rule uses the live camera
  fov, so binoculars count at ~12°), with a clear terrain line of sight held for ~0.45 s. `first` is false for kinds
  the discovery system already has (read on `game:start`). WP-RULES turns these into toasts and logbook entries.
- **Spray FX** (`wildlife/fx.js`): one instanced draw of GPU-animated particles (render band 200, depthWrite false,
  fog via WP-SKY's `kodiakApplyFog`): motion-streaked droplets, ragged sheets, and mist/blows shaded as thin
  scattering volumes (forward-scattering glow into the low sun). Blows scale to stay ≥ ~15 px tall at any range and
  keep a little contrast over the horizon haze, so a blow reads at 1.5–3 km at golden hour.

## API as built

Required (contract): `bears`, `whales`, `birds` (arrays of `{ id, kind, position, heading, state, ... }`),
`nearestBear(x, z)` → `{ bear, distance } | null`.

Extra members:

| member | what |
|---|---|
| `animals` | every land animal (bears, deer, goats, fox): `{ id, kind, age, position, heading, state, ... }` |
| `marine` | otters, sea lions, seals (`kind: 'otter'|'sealion'|'seal'`) |
| `workingFlocks` | `[{ id, kind: 'work', x, z, overSchool, schoolId, count }]` |
| `sighted` | kinds sighted this session |
| `encounter` | `{ bearId, stage } | null` (the bear currently watching/charging, else any retreating one) |
| `sites` | the site analysis (`sites.js`): islets, haulouts (with live `members` linked for the sea-lion chorus), cliffs, beaches, otterBeds, bearSites, whaleRanges, goatCliffs, deerMeadows, snags, rockPerches |
| `qa` | internal groups for QA framing (rafts, haulouts, seals, eagles, perches, colonies, rest, flocks) |
| `stage(kind, x, z, headingRad)` | QA/staging: `'surface' | 'breach' | 'dive' | 'blow' | 'bubbleNet' | 'orcas'` |
| `stageBear(id, state, x?, z?)` | QA: `'fishing' | 'walk' | 'graze' | 'rest'`, optionally moving the bear (and young) |
| `studio(items)` | QA: pins static instances of any herd for model review (`studio()` clears) |
| `debugState()` | sites, birds/flocks, whales, marine, bears, land, encounter, sighted, fx, per-herd triangles, ms |
| `serialize()` → `undefined`, `restore()`, `reset()`, `dispose()` | wildlife is not saved (§6.15) |

Events emitted (new ones documented here, SPEC §7 allows): `wildlife:sighted`, `bear:encounter`,
`wildlife:blow {kind, id, x, z}`, `wildlife:breach {kind, id, x, z, stage: 'start'|'splash'|'lunge'}`,
`wildlife:bubbleNet {x, z}`, `wildlife:orcas {x, z, heading}`, `wildlife:disturbed {kind: 'sealion', siteId, x, z,
closed}` (a boat inside the rookery buffer or within 120 m of a haulout; at most every 120 s per site).

Events consumed: `boat:teleport` (followers re-gather), `boat:horn` (resting gulls flush, haulouts within 260 m
alarm), `game:start` (known kinds from `discovery.wildlifeSeen()`), `time:hour` (rare orca pod / bubble-net rolls).

Deviations: none from the documented surface. `birds` lists only active birds near the camera (the full population is
thousands of cheap agents far away); `whales` includes the orca pod while it is present.

## Rendering compliance (§4.3)

- Materials: `MeshStandardMaterial`/`MeshPhysicalMaterial` (sheen for fur) with vertex colours from sRGB hexes via
  `THREE.Color` (linear), vertex rigs injected in `onBeforeCompile`, `patchUnderwater` on every animal material
  (whales, pinnipeds, otters, wading bears, diving birds), matching `MeshDepthMaterial`s for shadow casters (bears,
  flying gulls and eagles). Built-in fog chunks (WP-SKY's overrides) apply.
- Spray: custom `ShaderMaterial` with `fog: true`, `UniformsLib.fog` merged, fog chunks (`kodiakApplyFog` when sky's
  chunk exists), ends with tonemapping + colorspace includes; renderOrder 200, `depthWrite: false`, reversed-Z safe
  (no depth tricks). Quads keep a right-handed basis so they stay front-facing.
- All instance buffers are filled in `beforeRender` after the camera is final; InstancedMeshes are not frustum
  culled by three.js (culling is per animal on the CPU); update ranges limit uploads to the live count.

## Tunables

- `behaviour.js` `ENCOUNTER` (watch 30 m, charge 10 m, release 48 m, watchMax 22 s, charge 1.8 s, retreat 14 s,
  cooldown 25 s); `SIGHT_PX` 11 px; `planFlocks` share 0.45 / bait fraction 0.3; `planBears` per-site plans.
- `birds.js`: follower count (title 6, underway 11, fishing 13) and station ranges (`g.fb`), working flock size/radius/
  altitude (`planWorking`), swarm size 40, `FLAP_HZ`, `GLIDE` dihedrals, eagle soar altitude (cliff-top × 0.8 + 8–38
  m, ≥ 14 m above the ground under the circle).
- `marine.js`: humpbacks per range, `breachChance` (base 0.1, +0.1 in the 19–23 h golden evening, + wind), breath
  counts/durations, dive timeline, rookery size 150, islet colonies 8–34, disturbance radius 120 m, orca pod rarity
  0.035 / game hour, bubble nets 0.02 / game hour.
- `land.js`: bear plans, wading depth band (−0.18…−0.55 m), activity durations, cub modes, deer/goat/fox shyness.
- `fx.js`: `CAP` 4096 particles; blow min-size factor 0.022 × distance; burst recipes.

## Known issues

- Distant birds use a minimum projected size (up to 2–3.4× real size) so they read as specks; very close to the
  camera limit this can make a far gull look slightly large.
- Bears walk straight between waypoints (no path-finding); on very steep ground they can clip a little into the
  slope before the pitch/roll settles (the model has no foundation skirt; animals at rest stand on
  `terrain.heightAt`, which matches the rendered surface).
- Sea-lion swimmers circle simple loops offshore of their ledges; they do not haul out individually.
- The orca pod and bubble nets are rare by design (a few per play session); use `stage()` to see them.
- A GL warning "Mismatch between texture format and sampler type" appears in some scenarios near Karluk village; it
  also appears with `skip=wildlife`, so it belongs to another system (not wildlife).

## Perf (1280×720, `--bench`, shared GPU)

- CPU: `perf().systemsMs.wildlife` 0.31–0.44 ms (update + frame) plus the render-fill hook ~0.13 ms
  (`debugState().ms.render`), ≈ 0.5 ms total.
- GPU: A/B in one run (all wildlife meshes hidden vs shown) is within noise (gpuMs 19.6–21.6 either way).
- Draw calls: +8 in the town/boat scene (gull herds, snags, sea lions, humpback, spray). Triangles ~21–25 k there;
  worst case near the Marmot rookery ~60 k (LOD1 at range).
- Strict basic smoke: `qa/wildlife/final/` — wildlife `ok`, no errors or warnings, 60 fps.

## Best screenshots

- Gulls following the boat: `qa/wildlife/final-birds/gulls-stern.png`, `qa/wildlife/chase3/chase-12s.png`
- Swarm over the bag while hauling: `qa/wildlife/h1/bag-swarm-low.png`, `qa/wildlife/h1/bag-swarm.png`
- Eagle soaring over a sea cliff: `qa/wildlife/eg5/eagle-over-cliff.png`
- Humpback breach at golden hour: `qa/wildlife/wc1/breach-up-2.png`, `qa/wildlife/wc1/breach-down.png`,
  `qa/wildlife/final-whales/breach-3.png`
- Fluke-up dive: `qa/wildlife/fluke/fluke-c.png`; blows: `qa/wildlife/b5/north-1500.png`, `qa/wildlife/wc1/roll-1.png`
- Bubble-net lunge with gulls: `qa/wildlife/o1/bubblenet-lunge-2.png`; orca pod: `qa/wildlife/o1/orcas-1.png`
- Otters in the kelp shallows: `qa/wildlife/c2/otters-raft.png`
- Sea lions on an islet: `qa/wildlife/c2/sealions.png`
- Sow with cubs at the Karluk River mouth: `qa/wildlife/k2/karluk-beach-c.png` (fishing),
  `qa/wildlife/bw1/walk-front.png`, `qa/wildlife/bw1/walk-2.png` (walking the beach)
- Bears from the boat through binoculars: `qa/wildlife/k2/karluk-binoculars.png`
- Model sheets: `qa/wildlife/sb1/bears-golden.png`, `qa/wildlife/land3/deer-goat-fox.png`

## Scenarios

`wildlife-whales` (blows, breach, fluke, far blows), `wildlife-blows` (far blows in Shelikof Strait),
`wildlife-fluke`, `wildlife-orcas` (orca pod + bubble net), `wildlife-coast` (otters, sea lions, puffins, rookery by
eye and binoculars), `wildlife-birds` (followers, working flock), `wildlife-haul` (bag swarm), `wildlife-eagles`,
`wildlife-karluk` (bears from the beach and binoculars from the boat), `wildlife-bearwalk`, `wildlife-encounter`
(on foot: watch → charge → player retreat), `wildlife-studio*` (model sheets), `wildlife-explore` (older overview).

## Core changes

None.

## Requests to other work packages

- WP-AUDIO: `sites.haulouts[i].members` is now the live colony array (count and positions), so the sea-lion chorus
  can use real numbers; `wildlife:disturbed` could trigger a stampede roar/splash chorus; `birds[i].role` includes
  `'follow' | 'work' | 'swarm' | 'frenzy' | 'rest' | 'soar' | 'perch' | 'raft' | 'loop' | 'stand' | 'spread'`.
- WP-RULES / WP-UI: `wildlife:disturbed {closed: true}` fires when the seiner enters the Marmot rookery buffer; a
  radio reminder about the 3-nm no-approach zone would fit there.
- WP-BOATS (cameraRig): nothing required; binocular sightings already work through the live camera fov.

## Post-QA changes

See [FIX-foot.md](FIX-foot.md) (2026-09-28 QA fix wave); it supersedes anything here that it contradicts.
