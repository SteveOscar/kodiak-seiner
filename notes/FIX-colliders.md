# FIX-colliders — progress log (WP-PLACES + WP-TERRAIN fixer)

Collider interface (both systems): `collidersNear(x, z, radius = 0, out?)` → array of
`{ kind: 'circle', x, z, r, y0, y1 }` | `{ kind: 'box', x, z, hx, hz, rot, y0, y1 }` (world m; rot in the heading
convention: box local x = (cos rot, sin rot), local z = (-sin rot, cos rot); y0..y1 vertical extent). Returned objects
are frozen and shared; only colliders whose footprint lies within `radius` of the point are returned.

- places: `src/world/places/colliders.js` (colBox/colCircle helpers + uniform 24 m grid built once at create);
  every builder pushes a collider next to the geometry it stands for (structures.js, harbor.js, city.js, village.js,
  landmarks.js; buoys in places.js). 2,045 colliders. Verified: 99.8 % of rendered triangles in the walker's body band
  (0.4–1.9 m above ground) lie inside a collider (remaining 17: fort pit rims and spaceport rails).
- terrain: `src/world/terrain/vegetation/placement.js` (spruceAt / boulderAt / driftAt, shared by the rendered scatter
  and the colliders) + `src/world/terrain/colliders.js` (32 m tiles filled on first touch, cached, warmed around the
  camera from beforeRender, 0.3 ms/frame budget). ~0.1–0.2 ms per cold tile; warm queries sub-microsecond.
- [35] driftwood on the town grass: `placement.js driftAt` now requires the shader's beach band to be fully gravel/sand
  (h 0.7..beachTop-0.15 and h + beach-noise <= beachTop-0.4, same 17 m noise as material.js), no rock, shore distance
  -30..+1.5 m (was -40..+2 with h up to 2.4, which reached the grass), no developed region weight (landcover
  `dev` > 0.02) and no isDeveloped() at the log centre, both ends + 10 m or 10 m inland; density raised (0.26 + 0.34
  spruce) to keep the beaches dressed. Map-wide (seed 777): old 10,634 logs of which 3,127 on grass; new ~5,150, all
  on sand/gravel. Colliders use the same driftAt so they stay consistent.
- Tests: `tests/places-colliders.test.mjs` (shapes, heading convention vs kit boxes, exact grid distances, >99 % body-band
  coverage of rendered triangles, cathedral/turbines/lights/markers/floats/houses solid, ~4 µs/query) and
  `tests/terrain-colliders.test.mjs` (every rendered trunk/boulder/log has its collider across tile seams, sizes follow
  instances, warm query < 1 µs, cold tile ~0.1–0.2 ms, driftwood only on sand/gravel within 30 m of the waterline and
  off developed ground map-wide, channel head below the cathedral clear of grass logs). Log boxes use the 98.5th
  percentile of the rendered log body (crook included, branch stubs excluded); root wads get an extra circle.
- Shelf caustics (WP-OCEAN request): `material.js` seabed caustics now ~1 m cells (was 2.3 m), three-noise soft
  network with 0.45 peak (was 1.4, pow 5 lines), fading with depth (0.8→7 m), distance (25→110 m), grazing view
  (view-up 0.2→0.55) and pixel footprint (tkFw 0.06→0.25 m).
- Caustics tuned after real-GPU shots (`qa/fix-colliders/caustics2/`): peak 0.7 × net², depth fade 1→9 m. 06b (45°
  look-down) shows a fine soft network instead of the old worm lines; 05b (grazing) shows none; 06 shows driftwood
  on the sand storm line. Cathedral/channel head (`qa/fix-colliders/verify/01-*, 02-*`): no logs on the town grass.
  In-browser: 2,489 places colliders (terrain-height piles), terrain tile 0.023 ms, places+terrain query pair 0.7 µs.
- Final: `npm test` 531/531 pass. `node tools/smoke.mjs --scenario=basic --out=qa/fix-colliders/final --strict` PASS
  (60 fps, terrain 0.142 ms, places 0.049 ms systemsMs). The first attempt failed on another fixer's in-progress
  cameraRig edit (`clearOrbit` declared twice); it passed on re-run once that edit landed.
- Consumers: player.js / controller.js (WP-FOOT) and cameraRig.js already call `collidersNear(x, z, r, out)` with the
  same box convention (local x = (cos rot, sin rot)). Not changed here: notes/WP-PLACES.md / WP-TERRAIN.md (not in this
  fixer's file list) should gain a line on `collidersNear` and the driftwood rule.
