# FIX-verify-start: verifier findings on the start-location picker

Findings: qa/verify-start/findings.md. Owned files: src/ui/title.js, src/ui/startPicker.js, src/ui/lib/start.js,
the FIX-start block of src/ui/styles.css, src/game/season.js, src/game/data/**, tests/ui-start.test.mjs.
travel.js and src/entities/fish/sim.js are not mine, so both start issues are fixed in the start pose.

## Progress log
- [read] start.js/startPicker.js/title.js, travel.js arrivalFor (Free Explore pose: ~70 m off the beach facing the
  place), main.js game.start (teleport to startAt, then game:start), fish.js/sim.js spawnTutorial/tutorialSpot,
  heightmap depth model (minOpenDepth 8 m floor in enclosed bays: Akhiok, Alitak Cannery, Port Lions have no 20 m
  water nearby, so the sim's clean-spot rule never fires there and it drops the school at a random 8 m point).
- [impl 1+2] src/ui/lib/start.js seasonStartPose(pose, sea, { place, others, closedWaters, netDepth, limit }): the New
  Season start nearest the arrival pose (lattice every 50 m out to 1,500 m) with >= 8 m under it and >= 160 m of sea
  room (past the ~150 m "Go ashore" reach), at the port (<= 1,000 m from it and no nearer another working port more
  than 600 m away: the first cut put Port Lions' start off Ouzinkie), from
  which the tutorial school can only land in safe water a clear straight run away. It mirrors the sim's placement
  (TUTORIAL_SPOT; the test pins it to sim.js TUTORIAL): clean spots on the 380-420 m ring, else the nearest clean ring
  to 700 m (the three most-margin spots nearest the bow must all be safe and reachable), else the most-margin 20 m
  spot, else the sim's random drop (every acceptable point in the +-1 rad cone off the bow must be safe, and >= 25% of
  the cone acceptable). Safe: the sim's 80 m ring keeps >= 6 m; reachable: >= 6 m along the line and 20 m either
  side. The bow points at the school (or the cone). Fallback: nearest start with sea room facing the longest clear run.
  seasonPoseFor caches per place/pose/net depth; buildStartOptions takes { sea, netDepth, limit, cache }.
- [impl 1+2] startPicker passes ctx.heightmap as `sea` with a session cache; picker.warm() (from title.show) works the
  ports out one per idle slice so the panel does not pause (~275 ms total in Node, 130 ms worst port).
- [impl 3] filterStartOptions ranks matches: whole name, name start, word start, in name, kind/district, grounds;
  the group with the best match leads and groups stay contiguous. Query normalised (case, accents, apostrophes,
  punctuation). "deadman" -> Deadman Bay first.
- [offline] /tmp/kfix/mc.mjs: the real fish sim's spawnTutorial from each new start, 100-200 seeds per port: 0 schools
  with < 6 m within 80 m, 0 with < 4 m on the straight line from the start. Before: Larsen Bay's arrival pose
  faced the beach (0.6 m at 75 m ahead), Akhiok 1.1 m at 25 m.
- [fix] Port Lions (head of a narrow inlet, no 20 m water, and no start nearer it than Ouzinkie clears the sim's
  random drop) takes the least risky start: the expected unsafe-drop share over the sim's aimed cone and the ring.
  Real sim, 300 seeds: 8 schools (2.7%) with < 4 m within 60 m, 25 (8%) with < 6 m within 80 m. A sim-side fix
  (spawnTutorial's sampleNear fallback checking the 80 m circle) would close it; sim.js is not mine. The test pins
  the risky set to ['port-lions'].
- [search] matchRank + group-aware ordering; normalised query. Tests: deadman/alitak/uyak/st paul/saints first rows,
  contiguous groups, rank tiers.
- [test] tests/ui-start.test.mjs: New Season starts have sea room, are at their port, 300 m clear ahead; TUTORIAL_SPOT
  pinned to sim.js TUTORIAL; the real fish sim (12 seeds per port) puts the school 370-710 m out, <= 60 deg off the
  bow, 80 m ring >= 5.5 m and a clear line, at every port but Port Lions; synthetic-coast unit test for
  seasonStartPose (bow offshore, closures avoided, other ports respected, null without water, cache).
- [verify] npm test 606/606.
- [verify] qa/fix-verify-start/ports-w (real clicks and keys, --strict PASS): New Season at each of the 9 ports, hold W
  5 s then 10 s more: never aground, no "Go ashore" prompt at the start, 8-24 m under the boat, Pete says the school is
  "dead ahead" (Ouzinkie/Port Lions: off the bow). Akhiok before: AGROUND after 5 s.
- [verify] qa/fix-verify-start/explore-deadman (--strict PASS): typing d-e-a-d-m-a-n with real keys lists Deadman Bay
  first and selected; Enter starts at Deadman Bay.
- [verify] qa/verify-start/scen/setd-larsen-bay.json (the verifier's real-key set): the approach, circle and let-go at
  Larsen Bay complete in 12.5 m, not aground (report "fair", 2,226 lb). The run then fails the scenario's own last
  wait (fishing idle + skiff stowed within 20 s of the report); the driver had locked onto a nearer sockeye school
  after the 9 AM time skip rather than the tutorial school.

## Start poses now (distance from the port, water under the boat)
kodiak spawn unchanged; old-harbor 231 m 11 m; akhiok 972 m 8 m; alitak-cannery 672 m 8 m; karluk 346 m 25 m;
larsen-bay 590 m 12 m; larsen-bay-cannery 431 m 12 m; ouzinkie 270 m 8 m; port-lions 891 m 10 m; uganik-cannery
250 m 8 m. The Akhiok/Alitak Cannery bay is a flat 8 m floor (heightmap minOpenDepth), so their starts sit where the
sim's random drop can only land in water the set can circle.
- [verify] tests/scenarios start-location, net-tutorial-keys, net-arcade-keys: all --strict PASS
  (qa/fix-verify-start/<name>/).
