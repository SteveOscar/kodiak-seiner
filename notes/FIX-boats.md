# FIX-boats — QA fix log (WP-BOATS)

- [0] Crow's nest climbed to 200-700 m into haze. `rigMath.crowsnestFrame` fits the seiner + net polygon (the skiff only
  before the net is in the water) as a box across/along the view into the screen band the HUD leaves clear (60% of
  the lower half, 80% of the upper), solving the oblique view's near and far edges (look point shifted toward the
  camera) instead of centring, under `crowsnestCeiling(sky.weather.cloudBase)` = min(115, cloudBase - 20), >= 45 (115
  keeps it under the 120-260 m mist banks; overcast 94, rain 88, storm 72). A wide set tilts toward the horizon (to
  0.52 rad), then widens the fov (to 70), never climbs; the player's wheel zoom still wins. Distance, pitch and fov are
  damped. Files: src/render/camera/rigMath.js, src/render/cameraRig.js. Verified: node test (ceilings, caps under
  every weather, tilt first, line framing) and tests/scenarios/boats-crowsnest.json -> qa/fix-boats/crowsnest3
  (let-go 60 m; long line at 31% payout 113 m partly / 95 m overcast; 54% payout; holding 115 / 94.5 m; pursing 115
  / 89 m in rain; the whole corkline, skiff, seiner and jumpers above the set panel in every shot).
- [1] Ferry skiff drove through the anchored seiner. New pure `boats/hullRoute.js` (`hullWaypoint`, `hullClearance`):
  a capsule hull and a shortest path over 8 nodes round it (quarters, shoulders, abeam, astern, ahead), recomputed each
  step (follows a swinging hull; sticky side). `skiffController` steers every drive() through it (ferry, returnTo
  approach, closing, holding, tie-off run, tow-off positioning); ferry() also points the skiff at the first waypoint.
  Verified: 3 new node tests (ferry out/back round a bow-on seiner, closing to the far quarter, returnTo from ahead,
  route stickiness).
- [20] World boundary pinned the boat on the hard wall. `handling.stepHull`: past the soft line the helm is overridden
  to swing the bow toward the chart centre until it points inside; the outward way is cancelled (25% at the line, all of
  it 30 m past) plus an inward set; the hard clamp kills way into the wall. Verified: 2 new node tests (full ahead south
  from Alitak: max z < 7945, back inside heading north under way; clamp).
- [41] Skiff exhaust read as dark hard blobs. `fx.createParticlePool` gains `falloff` (sprite softness) and `nearFade`
  (fade within n metres of the lens); the skiff's exhaust is now a light blue-grey haze (grey 0.55-0.65, alpha
  0.07/0.14, life 1.1-1.7 s, falloff 2.6, near fade 1.5-6 m); the seiner's exhaust keeps its look and gains the near
  fade. Files: src/entities/boats/fx.js, src/entities/skiff.js, src/entities/seiner.js. Verified: qa/fix-boats/ashore1
  f01/f02 (soft pale puffs over the stack during the ferry).
- WP-OCEAN request: removed the seiner's Kelvin-arm foam comb (`for d of [5, 11, 18, 27, 38]`); prop wash and bow-wave
  stamps unchanged (src/entities/seiner.js).
- WP-NET request: `skiff.closeTo(seiner)` picks the stern quarter on the net's side (lateral offset of
  `net.bagCentroid()`, else `net.bodySide`/`side`, else the skiff's own side); the hull routing takes the skiff round
  when it starts on the other side (src/entities/skiff.js).
- [2] Foot camera buried in alder/spruce. `rigMath.clearOrbit` samples the orbit ray (beyond 2 m of the person) against
  `footBlocked`: `terrain.collidersNear` + `places.collidersNear` (circles/boxes with y0..y1; tall terrain circles are
  spruce, modelled as a bough cone of 0.3 x height), the seiner hull and house boxes, and a cached 2 m-grid alder canopy
  (`terrain.alderDensity` if published, else `surfaceAt === 'alder'`; dense forest only when no tree colliders exist).
  It first lifts the view (to 0.95 rad), else pulls in behind the deckhand; lift/pull are damped. `rigMath.insideCollider`
  is the shared shape test. Verified: node tests (lift over a wall, pull in from a tall one, box rotation) and
  tests/scenarios/boats-ashore-cam.json -> qa/fix-boats/ashore2 a01-a04 (alder belt above Uyak: deckhand visible in
  every frame, close over-shoulder or lifted over the thicket).
- [21] `poseFoot` consumes `player.cameraFraming` ({kind, dist, pitch}): eased in when the camera is untouched for 3 s
  (at once in cutscenes); touching the camera adopts the blended pose. 'summit' also widens the fov to 60 and turns the
  view toward the anchored seiner. The ferry framing (12 m, 0.32) and the hull boxes keep the cutscene camera out of the
  seiner. Verified: qa/fix-boats/ashore2 s01/s02 (summit: fov 55.6 -> 60, lower camera, golden-hour vista toward the
  boat), f01-f04 and r01-r03 (ferry out and back round the hull: min skiff clearance 2.75 m, camera never inside the
  hull in 395 samples).
- Final: `npm test` 531/531 pass (qa/fix-boats/npmtest.log); `node tools/smoke.mjs --scenario=basic
  --out=qa/fix-boats/final --strict` PASS, every system ok, no warnings (perf: seiner 0.14 ms, skiff 0.03, cameraRig
  0.01). Not done here (other packages): fading WP-SKY's mist/cloud sprites between a high camera and the sea.
