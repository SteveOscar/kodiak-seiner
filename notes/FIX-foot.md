# FIX-foot — QA fixes to WP-FOOT (player) and WP-WILDLIFE (bear encounters)

- [5] MAJOR solid props: `controller.js` resolves every step against `collidersNear` colliders (circles and
  heading-convention boxes; push out along the contact normal, keep only the velocity along the wall; sub-stepped so a
  9 m/s slide cannot tunnel; wedge/deep-water guard; obstacles < 0.28 m above the feet are stepped over, a jump clears
  a driftwood log, overhangs above the head are walked under). `player.js` merges `places.collidersNear` and
  `terrain.collidersNear` (optional, try/catch with a single warning) into every stepFoot (walking, the disembark
  walk, the bear retreat). Files: src/entities/player/controller.js, src/entities/player.js. Verified: 6 synthetic
  collider tests + a system test with a places wall and a throwing terrain provider (tests/foot-fixes.test.mjs).
- [4] MAJOR bear charge cut to black: the charge now plays out — deckhand freezes startled and turns to the bear,
  cameraRig.shake as the bear pulls up short, fade only once the bear has stopped short (>= 1.25 s, <= 3.2 s for a
  charge from further out). Files: src/entities/player.js. Verified: system test (fade at 1.2-1.8 s, bear closes to
  < 5 m first, shake before the fade).
- [17] MAJOR cooldown bear watch+charge in one instant: `ENCOUNTER.minWatch` 1.7 s of visible watch before any charge;
  on cooldown a bear re-engages (with a watch) only when the person walks inside 14 m, and otherwise stays visibly
  wary (stops, head up, turns to keep the person in view, no event); the encounter picks the nearest bear that would
  engage, so a bear resting on its cooldown no longer shields another. Charges end once the bear has pulled up short.
  Files: src/entities/wildlife/behaviour.js, src/entities/wildlife/land.js. Verified: tests/wildlife.test.mjs (cooldown
  re-engage point-blank -> watch then charge >= minWatch later; the QA 8.3 m case gives no same-instant charge).
- [39] MINOR running from a bear: stepEncounter takes the person's speed and facing (player.velocity, avatar heading):
  running > 3 m/s, or walking off with the back turned for 0.8 s, inside 25 m provokes a charge after the minimum
  watch. On the player side, walking (not running) away from a watching bear backs off facing it at 1.3 m/s with a
  reverse gait (anim.js `reverse`); Shift turns his back and runs. Files: behaviour.js, land.js, player.js,
  player/controller.js (`cmd.face`, `cmd.maxSpeed`, `s.reverse`), player/anim.js. Verified: wildlife tests (run from
  24.6 m -> charge; back turned -> charge; backing away -> released past 48 m) + foot system test (backs away facing
  the bear, <= 1.35 m/s; Shift -> back turned, > 3 m/s) + reverse-gait footfall test.
- [25] MINOR Karluk landing next to a boar: `findLanding` takes a `penalty(x, z)`; the player scores beaches within
  55 m of an adult bear down ((55 - d) x 3), so a beach next to a fishing bear loses to any reasonable alternative
  but is still used when it is the only one. Separate Skiffman quips for the put-aboard branch (`QUIPS_ABOARD`); shore
  quips no longer assume a sow. The retreat point is `besideBow` (driest standable spot <= 3.4 m from the bow), inside
  the 4.2 m "Back to the boat" radius. Files: player/rules.js, player.js. Verified: landing-penalty, besideBow and
  put-aboard/beside-skiff system tests. (The fleet line "Saw that bear run you back to the skiff" is WP-RULES' season
  radio, not changed here.)
- [26] MINOR perch on stepping off the skiff: viewpoints perch within 18 m of the marker (or of its local high point
  within 40 m), not 45 m; any perch needs 2.5 s standing there and fires only after `discovery.isDiscovered(placeId)`.
  Files: player/rules.js (`PERCH`, `perchPoint`, `onSummit`), player.js. Verified: perch unit test (37 m beach does not
  count) + system test (nothing from the beach, nothing before discovery, fires within the dwell after).
- [42] POLISH landing ends in the water: the disembark walk now goes to the first dry standable ground (+2.2 m, at
  least 3.5 m clear of the bow), angled ~25° off the skiff axis toward the higher side so the follow camera sits off
  the skiff's quarter; falls back to the landing point (dry by construction). Files: player.js. Verified: system test
  (control returns on ground >= 0.1 m above the sea, not wading).

## Real-GPU verification (headless smoke)

- `qa/fix-foot/fix-bear.json` -> `qa/fix-foot/bear2/` (PASS, 0 errors/warnings): the real E flow at the QA Karluk
  anchorage lands 60.7 m from boar bear-4 (was 22 m), control returns on dry gravel (y 0.36, `k02-ashore.png`, no bow
  in frame); walking in, bear-4 watches at 30 m; turning to run at ~12 m provokes the charge after the watch; the bear
  pulls up 3.1 m short and the fade starts ~1.4 s after the charge (`k04-charge-0.3.png` shows the startled deckhand
  with the bear pulled up beside him as the fade begins); back beside the skiff inside the board radius
  (`boardOffer: true`, gravel), shore quip on channel 10.
- `qa/fix-foot/fix-collide.json` -> `qa/fix-foot/collide1/`, `collide4/` (PASS --strict): running at a Pillar Mountain
  turbine stops at its foundation pad (`c02-turbine.png`) or at exactly the body radius from the tower (0.34 m);
  running at a grounded town warehouse stops outside its wall (`collide4/c01-building.png`, min clearance 1.34 m);
  an elevated cannery deck (y0 3.8 m) is correctly walked under at sea level. The Pillar Mountain perch still fires.
- Final: `npm test` 531/531 pass; `node tools/smoke.mjs --scenario=basic --out=qa/fix-foot/final --strict` PASS, all 19
  systems ok, 60 fps, p95 18.3 ms.

## Cross-package notes

- Colliders are consumed from `places.collidersNear` and `terrain.collidersNear` (both present now), passing a per-
  provider scratch `out` array; a throwing provider is reported once via console.warn and skipped.
- The foot camera's occlusion against buildings/foliage is cameraRig's (WP-BOATS); the turbine pad can partly occlude
  the follow camera when standing against it (`collide1/c03-turbine-gamecam.png`).
- WP-RULES: the fleet radio line "Saw that bear run you back to the skiff" still fires on the put-aboard branch.
