# WP-FOOT — going ashore and walking Kodiak on foot

Owner files: `src/entities/player.js`, `src/entities/player/**` (`rules.js`, `controller.js`, `anim.js`, `model.js`,
`fader.js`), `tests/foot.test.mjs`, `tests/scenarios/foot-*.json`, `qa/foot/`.

## Summary

- **Going ashore.** While the seiner is nearly stopped (≤ 0.8 m/s), fishing is idle, the skiff is stowed and a walkable
  beach lies within 150 m, the player offers **"E — Go ashore"** (priority 40; "Go ashore — <place>" near an on-foot
  place). The landing search (`rules.findLanding`) marches 48 rays over the heightmap to the first land, refines the
  waterline, walks inland to dry ground, rejects beaches steeper than 30° or backed by > 50° ground, skips memorial
  places and closed areas (Marmot rookery), and scores by distance, slope and surface (rock penalised). It is cached
  and re-run every 1.2 s while drifting (4× less at rest, ~0.2–1.2 ms each).
- **Cutscene** (mode `cutscene`, owned by the player): the seiner anchors (`setMooring({kind: 'anchor'})` unless already
  moored) and locks (`lockControls('player', true)`); `ctx.state.control = 'foot'` + `player:mode`; the deckhand stands
  in the skiff on the stern ramp, `skiff.release()` drops it off with the real splash, then `skiff.ferry()` runs to the
  beach while the camera rig follows the deckhand in foot mode. Runs longer than 70 m show ~3 s and then cut through a
  short fade to the last 30 m. At the beach the deckhand walks to the bow, hops onto the gunwale and down into the
  shallows, and takes a few steps up the beach; control returns in `play`.
- **Returning.** Beside the beached skiff: **"E — Back to the boat"** (priority 80). The deckhand walks to the bow, climbs
  in, walks to the seat; the skiff runs back (cut if long), lines up astern and winches up the ramp
  (`skiff.returnTo`), then control is `'boat'`, controls unlock and the mode is `play`. The anchor stays set; the seiner
  clears it itself on throttle. `boat:teleport` (fast travel, tow, dock, debug, load) brings the deckhand aboard
  instantly (skiff stowed, controls unlocked). `game:toTitle` / `reset()` do the same silently.
- **Controller** (`controller.js`, pure): camera-relative WASD / left stick, Shift runs (2.05 / 5.3 m/s), Space jumps
  (~0.6 m hop, real gravity); the §6.14 slope rules along the direction of travel (full speed ≤ 35°, linear to 30% at
  50°, scramble at 30% to 58°, slide above; downhill is 8% kinder); ground steeper than 58° can only be crossed while
  traversing (to 66°) and slides when stood on or climbed straight; wading slows to 50% at knee depth (0.5 m) and never
  goes deeper (the walker deflects along the waterline); soft world boundary at |x|,|z| > 7600 with a toast; the walker
  follows `terrain.heightAt` exactly and can never be below it. `player:step {surface, run}` fires on each footfall
  (surface from `terrain.surfaceAt`, `'water'` when wading, `'skiff'` aboard it); wading steps stamp foam + ripples.
- **Character** (`model.js`): one skinned mesh (18 bones, ~9.6k triangles, 1 draw + 1 shadow draw) built from lathes
  and rounded boxes with per-vertex colour, roughness and baked AO: Grundéns-orange jacket with zipper, storm flap,
  reflective arm bands, chest patch and rolled hood; darker orange bibs with knee patches; brown XtraTuf boots with a
  light welt and dark soles; a ribbed grey beanie; a jaw-line beard and moustache, wind-burned cheeks, brows, eyes,
  nose and ears. `kodiak_underwater` applies when wading and is masked off while standing inside the skiff (its sole
  sits below the waterline). Casts and receives shadows.
- **Animation** (`anim.js`, pure): foot trajectories phase-locked to distance (no skating) with analytic two-bone leg IK
  onto the ground under each boot (feet plant on slopes and shallows); pelvis bob/sway/yaw, counter-rotating chest, arm
  swing, lean from speed/acceleration/slope, banking into turns, an underdamped crouch spring on take-off and landing
  (weight), head stabilisation with look targets (the bear when one is watching, otherwise glances at the anchored
  boat when standing still). Poses: walk, run, jump (tuck / reach), scramble (hands forward), slide (surf stance), wade
  (high steps, arms out), ride (braced in the skiff against its roll), startled (bear charge), wary (bear watching),
  idle (weight shifts, breathing, looking around).
- **Bears.** `bear:encounter` `watch` → the deckhand turns his head to the bear and goes wary, a once-per-save hint
  "Back away slowly…" (WP-UI already toasts "A brown bear stands up to watch you. Back away slowly." for the event, so
  the player does not add a second toast). `charge` → startled pose, fade to black, the deckhand stands on dry beach at
  the skiff landing looking out at the skiff, fade in, a Skiffman radio quip on channel 10 (5 lines, forked rng). If a
  bear is within 40 m of the landing (or the skiff is gone) he is put aboard instead. No injury, no penalty.
- **Discovery.** `ctx.game.avatar()` returns the deckhand (`active`, `position`, `heading`, `object3d`) while
  `control === 'foot'`. Standing within ~32 m and 5 m of the summit of a `peak` place (hill-climbed from its marker)
  or within 45 m of a `viewpoint` calls `discovery.addPerch(placeId)` once per game day (and emits `player:summit`).

## API as built

REQUIRED: `active` (getter), `object3d` (Group; feet at its origin, facing −z, `rotation` = −heading), `position`
(= `object3d.position`, feet on the ground), `canGoAshore()` → `{ok, reason, landing}` (reasons: "Slow down to go
ashore", "Finish the set first", "The skiff is out", "No beach within reach", "Too steep to land here", "No landing
here", "Already ashore"), `goAshore()` → bool, `returnToBoat()` → bool (from afar it fades to the bow first).

Additional: `heading`, `velocity` (Vector3), `phase` (`aboard|launch|ferry|disembark|foot|embark|return|retreat`),
`landing` (`{x, z, y, shoreX, shoreZ, heading, distance, slopeDeg, placeId, placeName}` of the current trip),
`onGround`, `sliding`, `wading`, `rules` (FOOT_RULES), `tuning` (FOOT_TUNING), **`cameraFraming`** (see Requests),
`update`, `debugState`, `serialize` (undefined: never saved — snapshots are refused ashore by core), `restore`, `reset`.

Debug/QA: `debugAshore()` (skip the cutscene: skiff beached, deckhand at the bow), `placeAt(x, z, headingDeg)`,
`debugDrive({mx, mz, run, jump} | {headingDeg, run, jump} | null)`, `landingFrom(x, z)`.

Events emitted: `player:mode {control}`, `player:step {surface, run}`, `player:summit {placeId, x, z}` (new). Events
consumed: `bear:encounter`, `boat:teleport`, `game:toTitle`, `game:mode`.

Pure modules (Node-tested): `rules.js` — `slopeSpeed`, `slopeBand`, `directionalSlope`, `gradientSlope`,
`losesFooting`, `wadeFactor`, `findLanding`, `stepOffPoint`, `dryPointAhead`, `findSummit`, `perchPoint`, `onSummit`,
`isHilltop`; `controller.js` — `createFootState`, `placeFoot`, `stepFoot`, `standable`; `anim.js` — `animate`,
`legIK`, `stepLength`, `SKELETON`.

### Deviations

- Spec says the player reacts to `watch` with a "Back away slowly" hint. WP-UI toasts every watch event itself, so the
  player adds only the once-per-save `ui.hint('bear-watch', …)` field advice (no duplicate toast).
- The fade is a clip-space quad in the scene (renderOrder 449, top of the glow band, no depth test, no fog) rather than
  a DOM overlay, so the cutscenes never depend on WP-UI.
- Season's own `bearCharge` radio line (fleet chatter, delayed 8 s) and the player's immediate Skiffman quip both fire
  on a charge; they read as two different voices and are rate-limited separately.

## Tunables

`TUNE` in `player.js`: `stoppedSpeed` 0.8 m/s, `boardRadius` 4.2 m, `cutDistance` 70 m, `cutAfter` 3.2 s,
`cutApproach` 30 m, `asternOffset` 7 m, `searchEvery` 1.2 s, `searchMove` 6 m, `perchEvery` 0.5 s, `summitIdle` 2.5 s.
`FOOT_RULES` (rules.js): 35/50/58°, scramble 0.3, traverse 66°, slide exit 52°, knee 0.5 m. `LANDING`: reach 150 m,
48 rays, beach ≤ 30°, inland ≤ 50°. `FOOT_TUNING` (controller.js): walk 2.05, run 5.3 m/s, jump 4.3 m/s, gravity 15.5,
slide accel/friction/max. `FRAMING` (player.js): ferry 12 m / 0.32 rad, board 8 m / 0.3, summit 9 m / 0.16.
`PALETTE` (model.js): all rain-gear, boot, skin and knit colours (sRGB).

## Tests

`node --test tests/foot.test.mjs` — 25 tests (incl. the 5 contract tests it imports): slope/speed rules (values,
monotonicity, bands, agreement with WP-PLACES `walk.js footSpeed`), wading, ramp slope measures; controller speeds on
the flat and on 25°/42.5°/54° ramps, sliding on 64°, traverse vs stand vs climb on 62°/70°, jumps on bumpy ground
never below the surface, wading stops at the knee and deflects along the shore, the soft boundary; landing search on
synthetic beaches/cliffs/exclusions and on the real DEM (every `onFoot` place lands within 150 m of an anchorage near
its beach, dry; nothing mid-Shelikof); step-off and dry-beach points; hilltops; summits; leg IK forward kinematics;
footfall count vs distance; finite poses in every mode; and the whole system under Node with stub neighbours (offer,
cutscene/control/anchor/lock, walking with `player:step`, bear hint and charge → quip beside the skiff on the beach,
return aboard, teleport while ashore).

Smoke scenarios (`tests/scenarios/foot-*.json`, generated by `qa/foot/scen/gen.mjs`):
`foot-ashore` (E → skiff → beach → walk/run/jump at Three Saints Bay), `foot-hike` (golden-hour hike on Afognak with
the real E/ferry flow, ridge scramble, summit hero shots), `foot-return` (walk back, E, embark, ferry, winch, aboard,
underway), `foot-bear` (watch → back-away, charge → fade → skiff + quip), `foot-perch` (Narrow Cape viewpoint →
`discovery.addPerch`), `foot-vistas` (three summits over anchored boats), `foot-model` (character turnaround and
gait frames), `foot-bench` (deckhand drawn vs hidden while walking).

## Perf

- CPU (`perf().systemsMs.player`): < 0.005 ms aboard (not listed), 0.09–0.2 ms on foot (controller, IK animation,
  bone upload, perch check), ~0.1 ms during the cutscene. Landing search ≤ 1.2 ms every ≥ 1.2 s when stopped near shore.
- GPU: +2 draw calls (main + shadow) and ~19k triangles when ashore; the visible/hidden A/B in `foot-bench --bench`
  was inside the noise of a heavily shared GPU (gpuMs 62 vs 65, other agents' smoke runs active). Nothing is drawn
  while aboard (group hidden; the fader quad is invisible except during fades).
- `node tools/smoke.mjs --scenario=basic --out=qa/foot/final --strict`: PASS, all 19 systems `ok`, no errors or
  warnings, 60 fps (vsync), p95 18.6 ms, 160 draw calls, 1.23 M triangles.

## Best screenshots

- Ferry cutscene: `qa/foot/c5-hike/h01-ferry.png`, `qa/foot/c7-return/r05-ferry-back.png`
- On the beach beside the skiff: `qa/foot/c6-hike/h04-beach-hero.png`, `qa/foot/c7-return/r03-back-to-the-boat-prompt.png`
- Hiking a slope: `qa/foot/c6-hike/h09-ridge-looking-back.png`, `qa/foot/c6-hike/h10-ridge-slope-side.png`
- Summit over the anchored seiner at golden hour: `qa/foot/c6-hike/h12-summit-hero.png`,
  `qa/foot/c6-hike/h13-summit-wide.png`, `qa/foot/c8-vistas/v-three-saints-hero.png`, `qa/foot/c8-vistas/v-fjord-hero.png`
- The return: `qa/foot/c7-return/r06-alongside.png`, `qa/foot/c7-return/r07-aboard.png`
- Bears: `qa/foot/c8-bear/b02-watch-back-away.png`, `qa/foot/c7-bear/b04-charge.png`, `qa/foot/c8-bear/b06-back-at-skiff-quip.png`
- Character: `qa/foot/c9-model/m02-three-quarter.png`, `qa/foot/c9-model/m09-run-b.png`, `qa/foot/c9-model/m04-face.png`

## Known issues

- No collision with props: the deckhand walks through driftwood logs, boulders, alder shrubs and tree trunks (they are
  WP-TERRAIN / WP-PLACES instanced decoration with no collision query). Terrain is solid.
- The rig's foot camera can end up inside alder/spruce foliage in dense forest (its occlusion test is terrain-only),
  and it uses the same 6.5 m / fov 55 framing on summits as on the beach (see Requests).
- The landing search uses the coarse heightmap; the beached skiff can sit a metre or two off the detailed shoreline on
  steep gravel, which the step-off/dry-point helpers absorb.
- In low-sun forest the orange rain gear is the only warm colour in frame and can look slightly flat under heavy shade.

## Requests

- **WP-BOATS (cameraRig)**: in `poseFoot`, (1) read `ctx.systems.player?.cameraFraming` (`null` or `{kind, dist,
  pitch}`) and ease `foot.dist`/`foot.pitch` toward it while the player has not zoomed/orbited recently — `ferry`
  (12 m, 0.32) frames skiff + deckhand during the cutscene, `summit` (9 m, 0.16) after 2.5 s standing still on a hilltop
  lowers the camera behind the deckhand so the view (and the anchored boat) fills the frame instead of the grass;
  (2) also pull in for vegetation (e.g. `terrain.forestDensity > 0.5` along the orbit ray) so the camera is not buried
  in spruce/alder; (3) a slightly wider fov (≈ 60°) when `kind === 'summit'` would help the golden-hour vistas.
- **WP-TERRAIN / WP-PLACES**: an optional `solidAt(x, z) → radius | 0` (driftwood, boulders, trunks) would let the
  controller stop at props; it is consumed with optional chaining if it ever appears.
- **WP-AUDIO**: footsteps by surface are available from `player:step {surface: 'sand'|'gravel'|'grass'|'forest'|'alder'|
  'rock'|'snow'|'water'|'skiff', run}`; `player:summit` could cue a short musical sting.

## Core changes

None.
