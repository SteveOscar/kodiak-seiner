# FIX-net — QA fix log (WP-NET: net + fishing)

- [44] Per-frame allocations: net/model.js keeps one persistent polygon array (filled from the node pool instead of
  `slice`), `gap()` fills a reused `{a, b, width}` object, and every `sim.centroid()` on a per-frame path (model
  update, close, snag, net.js foam stamps, fishing HUD) writes into a scratch object. Files: src/entities/net/model.js,
  src/entities/net.js. Verified: node --test tests/net*.test.mjs (49/49).
- [6] Let-go near fish: idle reads `fish.nearestSchool` (1.5 km). On a new season's first set (not free explore)
  the Space prompt is `fishing-find-fish` "Jumpers 420 m E — get within 150 m to let go" until the school is within
  150 m (+ radius); Space there only repeats the line and Pete's `findFish` tip. Otherwise the let-go label reads
  "Let 'er go! (no fish close)" when no school is within 150 m. HUD extras `nearestFish` {distance, bearing,
  compass, close} and `fishClose`. Files: src/game/fishing/core.js, hints.js, src/entities/net/tuning.js.
  Verified: tests/net-qa-fixes.test.mjs (first-set + general cases).
- [7] Round-haul holding short of the skiff: Close up! is offered only within `config.net.closeDistance` of the skiff
  end (SPEC §6.12 step 4; hooks and tied sets still close any time); meanwhile the message is "Bring her around to
  the skiff — 280 m", the 1.5 m/s tow limit is lifted to 7 m/s, Pete says `bringAround`, and `hud.closeReady` is
  false. Closing with the skiff end > 60 m away also lifts the 3 m/s limit. Files: core.js, tuning.js, hints.js.
  Verified: tests/net-qa-fixes.test.mjs (straight lay-out → holding with a 380 m gap → no close offer → alongside →
  close in ≤ 12 s; hook close lifts the limit).
- [8] Running tide while hauling: the E offer (same id `fishing-haul`, still a hold prompt) reads "Speed up the block
  — tide's running, the corks will sink" and the caption warns while the current at the net exceeds the corks-under
  threshold; `hud.tideRunning`. Escapes are tallied by cause into `fishing:setComplete.escapes {leads, corks, gap,
  hole, overflow}` (WP-FISH flags viaGap/overCorks/released or a `cause` field are honoured; the rest is attributed
  from the net state at the time: open → gap, hauling → corks or hole, closed/pursing → leads with a snag hole taking
  its 20% share, all of it once pursed). `escaped` stays the event total (overflow is separate and also in
  `released`). Files: core.js, report.js. Verified: net-qa-fixes (tide label, corks/gap/hole/overflow tallies;
  leads/hole split while pursing).
- [27] Pete's let-go tip reworded ("Keep her moving — the winch holds you to setting speed…"); the HUD exposes
  `payoutSpeed` (m/s, smoothed), `payoutPace` ('slow' < 60% of the 7 m/s limit | 'steady') and `payoutEta` (s), and
  the setting caption says "Paying out slowly — open her up, the winch sets the pace". Files: hints.js, core.js.
  Verified: net-qa-fixes (7 m/s steady, 2 m/s slow).
- [28] canSet() refuses with "Hold's plugged — deliver first" when the hold can't take one brailer load (1,500 lb).
- [43] canSet() refuses while tied up at a dock ("Cast off first"), within 60 m of a tender's hull or 90 m of a
  harbour's dock point ("Too close to the <name> to set"), so no let-go offer appears there.
  Files: core.js. Verified: net-qa-fixes (plugged, tender, harbour dock, dock mooring).
- [29] The set is valued at the nearest buying tender's price (`season.priceFor(k, tenderId)`, the same call a
  delivery makes); payload `valuedAt` (tender name, null = market estimate) and `valuedAtId`; `hud.valuedAt` while
  brailing. Files: core.js, report.js. Verified: net-qa-fixes (value = lbs × tender price, names the tender).
- [30] The brailer runs only when a catch was accepted (water hauls and seized catches show no brailer and no fish);
  scoop fill comes from the accepted pounds (no 0.25 floor), spilled fish scale with it, and the splash counter
  resets per set. Each scoop emits `fishing:brail {x, z, lbs}` (WP-AUDIO), summing to the accepted pounds when not
  skipped. The brailing caption is null (the set panel's count-up carries it; WP-UI request) except "Water haul —
  nothing to brail" / trooper seizure. `fishing.brailer` exposed for tests. Files: src/game/fishing.js, brailer.js,
  core.js. Verified: net-qa-fixes (brail events sum to 14,400 lb; water haul: brailer hidden, no events).
- [8] follow-up: WP-FISH's harvest spill (`overCorks`, the catch above the clean-set ceiling, independent of block
  speed) is tallied under an additive `escapes.spill`, not `corks`, so the report's main cause ("ease off the block")
  is not given after a clean slack-water set (seen in qa/fix-net/brail: 900 spill blamed on the corks before this).
- Real-GPU checks (all `--strict` PASS, 0 errors/warnings): qa/fix-net/firstset (new season: "Jumpers 410 m SE — get
  within 150 m to let go" at the spawn; Space there stays idle + Pete tip; 111 m off → "Let 'er go!"; pay-out
  6.4 m/s 'steady' ETA 49 s; straight lay-out → holding "Bring her around to the skiff — 340 m", no Space offer,
  limit 7 m/s; alongside → "Close up!" at 21 m, limit 1.5; hauling in a forced 0.43 m/s current → E "Speed up the
  block — tide's running, the corks will sink"; water haul: brailer hidden, caption "Water haul — nothing to
  brail"); qa/fix-net/edges (free explore "Let 'er go! (no fish close)" 368 m off; staged water haul with no brailer
  and no fishing:brail; plugged hold 59,400 lb → no let-go, reason "Hold's plugged — deliver first"; 16 m off the
  Sea Venture → no let-go, "Too close to the Sea Venture to set"); qa/fix-net/brail (18,360 lb staged set: 5
  fishing:brail scoops of 3,672 lb summing to the accepted pounds, brailing caption null, valued at Sea Venture;
  WP-UI's report shows "At Sea Venture prices").
- Key-driven tutorial scenario (tests/net-tutorial-scenario.test.mjs → regenerated tests/scenarios/net-tutorial-keys.json,
  WP-NET's own generated scenario): WP-FISH now spawns the tutorial school ~400 m off, often astern of the spawn
  heading, and the old fixed approach line (no trims inside 40 m) passed it 190 m off, where the new first-set rule
  (correctly) offers no let-go. The helmsman now uses live tangent guidance (pass the school R = 58 m to port), trims
  down to 25 m, arms "abeam" only after the school has been ahead, and waits for the real `fishing-letgo` offer
  before pressing Space.
- [7] follow-up (from the key-driven tutorial run): a natural circle often runs out 25–30 m short of the skiff and
  the untied skiff re-aimed its tow 18 m further up-current every 20 s from wherever its end had got to, so it walked
  off (~0.9 m/s) and a strict 22 m rule left the prompt flickering and the set held for minutes. Now a round haul in
  holding is offered the close within `close.holdRange` 45 m (the skiff runs its end in at ~4.9 m/s, ~10 s) and keeps
  it out to 60 m (hysteresis); the skiff holds station 18 m up-current of where its end lay when holding began
  (`set.towAnchor`). Setting keeps SPEC's 22 m `closeDistance`. Verified: net-qa-fixes (no offer at 380 m, offer
  alongside, still offered at 40 m after being ready, tow target within 18.5 m of the anchor after 65 s).
- Final: key-driven tutorial (qa/fix-net/tutorial, --strict PASS, 0 errors/warnings): let-go 58 m off the school,
  close-up alongside in setting, purse, haul, 5-scoop brail with no duplicate caption; 3,829 pinks, 13,784 lb,
  $3,721.79 "good" at Sea Venture prices; escapes {leads 748, corks 76, gap 558} → WP-UI report "1,382 got away — most
  under the leadline (748). Purse up faster." npm test: 546/546 pass. node tools/smoke.mjs --scenario=basic
  --out=qa/fix-net/final --strict: PASS (net 0.018 ms, fishing 0.022 ms idle).
