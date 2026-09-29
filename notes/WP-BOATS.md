# WP-BOATS — seiner, skiff, fleet and camera rig

## Summary

**Seiner** (`src/entities/seiner.js` + `boats/seinerModel.js`, `boats/hull.js`, `boats/textures.js`,
`boats/seinerController.js`, `boats/handling.js`). The hero asset is a 58 ft Alaska limit seiner built procedurally
in its local frame (bow −z, origin on the design waterline amidships): a lofted displacement hull (high flared bow,
raised foc'sle, round bilge aft, raked stem and transom) with a 4096×1024 canvas atlas (white topsides, navy sheer
stripe, red pinstripe, black boot top, red bottom paint, plate seams in a bump map, weeping rust streaks under
scuppers and the hawsepipe, grime at the waterline, hull lettering and hailing port "KODIAK, AK" on the transom);
bulwarks and wooden cap rail; foc'sle with anchor winch, chain, bow roller and a galvanized plow anchor stowed on it;
the house and a reverse-raked wheelhouse with framed windows, wipers, portholes, sidelights in screens, door, life
ring and ladder; a flying bridge on the wheelhouse roof (rails, windscreen with a canvas roll, white helm console
with instrument panel, wheel, throttles, compass, plotter); radar array (spinning), radome, whip antennas,
searchlight, horn; mast with yard, floods, masthead/anchor/fishing lights, steps and rigging; the boom reaching aft
over the pile with hydraulic hoses and topping lift; a Marco-style power block hanging from the boom tip (fixed
yoke and motor; the rubber-lined sheave and its red side plates with lightening holes turn while hauling); purse
winch; fish hold hatch; stern roller; tyre fenders and buoys; stack with muffler; liferaft; the US flag on the stern
staff and Alaska's Big Dipper at the yard (vertex-rippled in the relative wind). The **seine pile** is a heaped mound
of tarred web with the corkline flaked in hand-laid fore-and-aft folds along the starboard side (three tiers,
bights at the ends, faded and white marker corks) and the leadline and purse rings along the port side; it sinks as
the net pays out and rebuilds as it is hauled. Two deckhands in orange rain gear (skinned, procedurally posed:
idle, coiling, watching the set, working the purse winch, hauling under the block, stacking) brace against the
roll. Materials are PBR with a grime/rust canvas map; underwater parts use `kodiak_underwater` plus a per-boat sea
plane (`boats/waterline.js`) so a hull riding a swell is tinted only below the real surface. Hull occluder via
`water.addOccluder`. Running lights follow COLREGS (underway, at anchor, engaged in fishing) and are **sectored**:
sidelights show from dead ahead to abaft the beam on their own side, the masthead forward, the stern light astern,
deck floods only toward the deck; lenses stay dim so unlit lights never shine. Deck floods (N) are two cone lights
injected into the boat's own materials only (no scene SpotLights), with a warm light pool on the water.

**Handling**: a pure, unit-tested displacement-hull model. Throttle is a lever (W/S tap = 10% notch, hold slides
it, it stops at neutral on the way through; gamepad stick drives it directly), acceleration τ 5.5 s, coast 11 s,
brake astern 3 s; rudder with finite rate that needs way on, prop-wash kick at low speed, prop walk astern; turns
heel the hull outboard and skid the stern; squat and acceleration trim; buoyancy/pitch/roll/heave springs toward a
plane fitted to five `water.sample` points (bow, stern, both sides, middle); drift with `ctx.tide.currentAt` at any
speed plus wind leeway when slow; grounding per SPEC (probe along travel, stop, bump, one `boat:collision`, camera
shake, sliding along the shore, backing off always allowed); capsule collisions with tenders and fleet boats; soft
boundary push with a toast. FX: prop wash that lingers as a widening foam trail, bow wave peeling along the flare,
Kelvin-arm foam and stem ripples (all `water.stamp`), a reverse-wash boil astern, bow spray sheets + droplets (more
when the bow slams a sea), sooty exhaust puffs when the throttle opens and a thin haze otherwise (band 200), anchor
rode from the roller to the anchor.

**Skiff** (`src/entities/skiff.js` + `boats/skiffController.js`, `boats/skiffModel.js`): a ~19 ft aluminium seine
skiff (beamy welded hull, rubber gunwale fender and push knee, engine box, console and wheel, tall yellow towing
bitt, stack, all-round light) with the skiffman at the helm. All §6.8 behaviours: `release()` slides it off the
stern into the water (splash: foam, two ripple rings, spray; `skiff:splash`); `holdAt` station-keeps bow into the
stream; `towToward` creeps against the current with visible effort (squat, prop wash, exhaust); `tieOff` noses
into the beach and runs a line to a stake ashore; `closeTo(seiner.object3d)` brings the end alongside the stern
quarter on its own side and fires the callback once; `towOff(seiner, side)` swings out 24 m on the far side and
pulls the seiner off the net through `seiner.applyTow` with a sagging towline that straightens under strain;
`setTowHeading` aims the pull; `returnTo` comes up astern and is winched up the ramp to 'stowed'; `stow()` is
instant; `ferry(from, to)` lands at the water line (for WP-FOOT). Commands issued during the drop are applied when
it lands. Wake stamps, bow spray, exhaust, occluder.

**Fleet** (`src/entities/fleet.js` + `boats/fleetData.js`, `boats/fleetAI.js`, `boats/fleetModels.js`,
`boats/nav.js`): six named tenders (packers 24–33 m with a tall house, mast with floods, radar, company-coloured
stack, brailing crane, hatches, totes, heavy fendering, stern flag) anchored off Kodiak/Chiniak Bay (Sea Venture),
Larsen Bay cannery in Uyak Bay (Pacific Star), Old Harbor/Sitkalidak (Island Mist), Uganik (Westward Wind), Port
Lions/Kizhuyak (Norseman) and Alitak/Lazy Bay (Alitak Provider), each resolved from `src/data/places.js` to the
nearest deep open water and swinging slowly to the stream. The eight fleet-board seiners (names from
`src/game/data/fleetBoard.js`) run A* water routes (`boats/nav.js`, incremental, budgeted per frame) between spots
on their grounds, search, lay a round haul (skiff out, a cork circle laid astern, close up, purse, haul — the circle
shrinks to the boat — brail), deliver alongside their tender every few sets, anchor when the fishery is closed, and
give way to the player. The Tustumena runs Kodiak – Ouzinkie – Port Lions; the cutter Alex Haley patrols off Womens
Bay; setnet skiffs potter along beaches at Larsen Bay, Uganik and Old Harbor. Near/far LODs by distance, one
instanced draw for every fleet cork (scaled with distance so a set reads across a bay), one glow draw for every
navigation light (sectored per COLREGS, rotated with each hull), one draw for all deck-flood pools. Wake stamps only
within 1 km of the camera focus.

**Camera rig** (`src/render/cameraRig.js` + `camera/rigMath.js`, `camera/titleShots.js`): chase (drag orbit, wheel
zoom, recentres after 3 s idle, look-ahead with speed, boat framed in the lower third, terrain pull-in), crow's nest
(high and looking down; while the skiff is off it frames the seiner, the skiff and the net polygon), bridge (first
person from beside the flying-bridge console, rides the boat's pitch and roll), foot (third person on `setTarget` or
the avatar), title (seven eased golden-hour/dawn shots of real places: leaving St. Paul Harbor, Uyak Bay, Shelikof
Strait off Cape Ugat, dawn over the Koniag range, Ugak Bay, Three Saints Bay, Chiniak Bay at dusk; seiner shots put
the player's boat on autopilot), free (photo mode fly-cam on raw keys in `frame()`: WASD/arrows, E/Space up, Q/C
down, Shift fast, Alt slow, wheel zoom), binoculars (hold B/right mouse: fov 12° from the helmsman's eye with breath
and boat-motion sway; a jump held in view ~1 s logs `discovery.addSighting` and emits `camera:sighting`). Blended
mode changes, snap on `boat:teleport`, never below water +1.5 m or inside terrain +2 m, trauma shake on collisions,
focus copied into `sky.shadowFocus` every frame, near ≥ 2 m in boat/title/free modes on the `low` preset.

Verified end to end with the real neighbours (`tests/scenarios/boats-set.json`): Space lets the skiff go, the net
pays out from the stern while the skiff holds its end, the circle closes, the skiff tows the seiner off the net on a
visible towline during pursing, the net rises through the power block while hauling, and after the set report the
skiff is winched back up the ramp.

## API as built

All REQUIRED members of `src/systems/contract.js` are present (strict smoke: `seiner`, `skiff`, `fleet`,
`cameraRig` all `ok`). Extras:

**seiner** — `heading` also has a setter; `pitch`, `roll`, `bump` (0..1 decaying impact), `anchorPoint` ({x, z}
while anchored), `baseMaxSpeed`, `model` (the built model: `points`, `crew`, `block`, `pile`, `skiffMount`, …);
`bittPoint(side, out)` (towline bitts), `eyePoint(out)` (helmsman's eye), `floodPatch(material)` (let other
materials receive the deck floods), `applyTow(vx, vz)` (external velocity for one step, used by the skiff),
`setAutopilot({heading, throttle} | null)` (title only; cleared outside the title). `serialize()` also stores
`deckLights`. `reset()` keeps the boat's name (chosen on the title screen).

**skiff** — `effort`, `strain` (0..1), `speed`, `towHeading`, `model` (`points`: `bitt`, `netEnd`, `helm`, `seat`,
`stack`, `light`, `bow`, `stern`, used by WP-FOOT), `bittPoint(out)`, `seatPoint(out)`. `busy` is true while
released (dropping), returning, and closing/ferrying until arrival. `release()` returns false unless stowed.

**fleet** — `obstacles()` (collision capsules for the seiner), `ferry`, `cutter`, `grid` (nav grid). Every tender
has `{id, name, kind: 'tender', placeId, position, heading, object3d, buying, radius, services: ['sell', 'fuel'],
channel, length, beam}`; `boats` entries have `{id, name, kind: 'seiner'|'skiff'|'ferry'|'cutter', position,
heading, speed, state, object3d, radius}`.

**cameraRig** — `fov`, `seekTitle(index, frac)`, `titleShots` (ids), `titleShot` ({id, label} while the title
runs; WP-UI shows the caption).

**Events** (new): `skiff:state {state, prev}`, `skiff:splash {x, z}` (audio plays the splash),
`camera:mode {mode, prev}`, `camera:sighting {schoolId, species, heading, x, z, day, hours}` (UI marker, audio
blip). Emitted per SPEC: `boat:collision`, `boat:horn`, `boat:mooring` (only on an actual change).

## Deviations and decisions

- Throttle is a lever rather than hold-to-go: taps notch it, holding slides it, passing neutral stops there until
  the key is released (so W/S never flips ahead/astern by accident). Applying throttle with controls unlocked clears
  a mooring, as specified.
- `setMooring({kind: 'anchor'})` drops an anchor ~19 m ahead of the bow on a 26 m rode; the hull weathervanes to lie
  bow into the stream (and wind) and the rode holds it within scope. `{kind: 'dock'}` holds position. Both add a 0
  m/s speed limit under the owner `'mooring'`.
- `release()` passes through a 1.4 s `'released'` state (sliding off the ramp) before `'holding'` at the drop point.
- The skiff's return up the ramp happens after the player dismisses the set report (the UI pauses the game there).
- The title cinematic moves the player's seiner for its two seiner shots; New Season teleports to the spawn and
  Continue restores the saved pose, so this never leaks into play.
- Fleet seiners are visual only (no fish are removed from `fish.schools`).

## Tunables

- `boats/handling.js` `SEINER_TUNING`: speeds/time constants, turn rate, heel, trim, spring periods, leeway,
  grounding depth, bump speed, boundary push, anchor scope.
- `boats/skiffController.js` `SKIFF_TUNING`: run/ferry speeds, drop/winch seconds, towline length, tow pull.
- `boats/fleetAI.js` `FLEET_TUNING`: cruise/search/set speeds, set radius, cork spacing, phase durations, sets per
  delivery. `boats/fleetData.js`: tenders, grounds, fleet seiners and colours, ferry and cutter stops.
- `seiner.js`: `BOW_WAVE` stamp layout, spray/exhaust rates. `cameraRig.js`: chase distance/pitch, `NEST_PITCH`,
  `NEST_HEIGHT`, `BRIDGE_PITCH`; `camera/titleShots.js`: the cinematic cut list.
- `boats/fx.js` `ARCS`: light sectors.

## Tests

`node --test tests/boats.test.mjs tests/boats-world.test.mjs` — 41 passing (36 here plus the 5 contract tests that
importing `fakeCtx` registers): owner-map semantics; throttle/limits;
coasting vs braking; rudder authority and prop-wash kick; heel and slip; buoyancy; drift and leeway; grounding (one
event, backing off, escaping shallows); boundary; capsule collisions; the throttle lever; owner-keyed limits and
locks; mooring semantics (events, limit, throttle clears it, dock holds); anchored weathervaning; tow pull; every
skiff command (release/splash, deferred commands, towToward strain, tieOff at the beach, closeTo once, towOff pull,
returnTo winch, ferry landing); A* water routing; occluder inside the raked stem/transom; camera maths; light-pool
packing; title shots (count, golden hour, water under seiner shots, no terrain between camera and subject); fleet
data on real grounds; fleet seiner and shuttle AI state machines.

Scenarios (`node tools/smoke.mjs --scenario=tests/scenarios/<file> --out=qa/boats/<run>`): `boats-hero`,
`boats-underway`, `boats-skiff`, `boats-set` (real set with WP-NET), `boats-fleet`, `boats-lights`, `boats-title`,
`boats-camera`, `boats-physics` (grounding, mooring, limits, horn/lights, boundary, save/load, rename),
`boats-polish`, `boats-bench`, `boats-ab` (GPU A/B with the boats hidden in-page).

## Perf

- CPU (`perf().systemsMs`, EMA under heavy machine load from other agents' runs): seiner 0.29–0.36 ms, fleet
  0.25–0.35, skiff 0.03–0.09, cameraRig 0.03–0.06. In-page micro-benchmark (hot, same frame state): seiner 0.12 ms,
  fleet 0.12, skiff 0.02, cameraRig 0.03 — 0.29 ms total.
- GPU: A/B in one page, hiding every boat object at the same moment (`tests/scenarios/boats-ab.json --bench`,
  `qa/boats/ab`): 21.4–23.4 ms with vs 21.6 without (underway), 21.5 vs 21.1 at night with floods — ≈ 0.5 ms
  including shadow casting (that run had WP-TERRAIN mid-edit on its stub). Repeated with the real terrain
  (`qa/boats/ab2`): draw calls 114 vs 62 (+52), triangles 1.13 M vs 0.97 M (+158 k incl. shadow pass); its gpuMs
  swung 22 → 26 → 44 ms across consecutive windows from other agents' GPU load, so only the counts are usable there.
  Seiner model 67 k triangles, skiff 4 k. Separate runs with `--params="skip=fleet,seiner,skiff"`: gpuMs 61.3 vs 57.8
  and 66.3 vs 66.9 (shared GPU, within noise).
- Total boats+fleet ≈ 0.3 ms CPU + ≈ 0.5 ms GPU, inside the 1 ms budget.

## Best screenshots

- `qa/boats/final2-hero/golden-34-bow-low.png`, `golden-bow-close.png`, `golden-34-stern.png` — golden hour, low 3/4.
- `qa/boats/c2-underway/golden-underway-beam.png`, `golden-underway-wake.png`, `storm-bow.png` — underway, spray, wake.
- `qa/boats/final3-hero/night-deck-floods-aft.png`, `night-at-anchor.png`, `qa/boats/lights/lights-ahead.png`,
  `floods-from-astern.png` — night (sectored running lights, deck floods, anchor light and rode).
- `qa/boats/set1/set-03-laying-crowsnest.png`, `set-05-circle-crowsnest.png` — crow's nest while setting.
- `qa/boats/bridge/bridge-hq-underway.png` — bridge view.
- `qa/boats/set1/set-02-skiff-off-the-stern.png`, `set-04-skiff-holding-end.png` — skiff released and holding.
- `qa/boats/set1/set-06-towoff-wide.png`, `qa/boats/final2-skiff/towoff-line-low.png` — towOff with its towline.
- `qa/boats/set1/set-08-hauling-block.png` — hauling through the power block; `qa/boats/final3-set/set-09-winched-up-ramp.png`
  — the skiff winched back up the stern ramp after the set.
- `qa/boats/final3-fleet/tender-1.png`, `tender-night.png`, `fleet-seiner-running.png`, `fleet-seiner-set-above.png`.
- `qa/boats/final2-title/title-0-b.png`, `title-2-a.png`, `title-4-a.png`, `title-5-a.png`, `title-6-a.png`.

## Known issues

- The seiner's bow wave and Kelvin wake are drawn by WP-OCEAN from these stamps; seen from a very low camera the bow
  foam is thin (it reads well from chase height).
- The pile's corks (several hundred, merged into one mesh) do not change in number with how much net is aboard; the
  whole pile scales vertically instead, and WP-NET draws the net coming off and back onto it.
- The low-preset bridge camera stands 2.3 m aft of the console so the 24-bit depth buffer's 2 m near plane never
  clips the helm.
- Fleet boats do not collide with each other (they give way to the player only).
- The final strict basic run (`qa/boats/final`) shows every system `ok` but fails `--strict` on one WebGL warning,
  "glDrawElementsInstanced: Mismatch between texture format and sampler type", which is not from this package: it
  reproduces with `--params="skip=fleet,seiner,skiff"` (`qa/boats/final-skipboats`) and disappears with
  `--params="skip=terrain"` (`qa/boats/final-skipterrain`: strict PASS, all boat systems `ok`, no warnings). An
  earlier strict run of this package (before that terrain change) passed cleanly.

## Core changes

None.

## Requests to other work packages

- WP-AUDIO: `skiff:state` (drop, winch, towing strain via `skiff.strain`) and `seiner.engineLoad` drive the engines;
  `boat:collision {kind: 'ground'}` is the hull thump.
- WP-UI: `cameraRig.mode` for the camera label; `camera:sighting` for the fading compass/chart marker (already wired).
- WP-OCEAN: none; stamps follow the documented budget (fleet boats > 1 km from the focus don't stamp).
- WP-TERRAIN: an instanced terrain draw currently samples a texture with a mismatched sampler type (the WebGL warning
  above); it breaks every `--strict` run.

## Post-QA changes

See [FIX-boats.md](FIX-boats.md) (2026-09-28 QA fix wave); it supersedes anything here that it contradicts.
