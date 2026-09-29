# FIX-arcade — arcade vs realistic fishing mode

Request: simplify and speed up bringing in the net; setting `fishingMode` 'arcade' (default) | 'realistic'.

## Progress log

- Start: read SPEC 6.11-6.12, WP-NET, FIX-net, fishing core.
- Design decisions (before coding): mode read at let-go into `set.mode` (settings via `season.save.getSettings()`,
  else save.js module); net gets `begin(anchor, {arcade})` so the model skips snags, smooth-bottom slow-down and corks
  under; arcade closing = 3 s once the skiff end is within 75 m (offers: setting 2 x closeDistance = 44 m, holding
  60 m / 75 m hysteresis); after close-up no towOff (skiff keeps riding in, returnTo at rings up), purse 2 s,
  haul 0.9 in 3 s, brail 2 s, report stows the skiff after 2.5 s if it isn't home. Payload gains `mode`; the UI's
  escape lessons switch for arcade. Existing tests pin realistic via the harness (`makeGame({mode})`).
- Implemented (core.js arcade branches, net model `arcade` + `close({blend})`, tuning `FISHING_TUNING.arcade`,
  hints purseArcade/ringsUpArcade, save.js fishingMode default + normalisation, settings segmented control, help
  card, set panel, escapeSummary arcade lessons, debug.stage defaults to realistic). npm test 571/571 with the
  harness pinned to realistic. Next: arcade unit tests, then scenarios.
- tests/net-arcade.test.mjs (8 tests) pass: settings default/normalise/persist, core reads season.save, arcade
  phases (Node sim seconds: close 3.03, purse 2.03, haul 3.03, brail 2.00, close-up → report 7.07), no winch/tow/
  wheel/corks/snags, mode read at let-go, catch fraction replayed on WP-FISH's sim (4,000 pinks: arcade
  0.850/0.850/0.844 vs realistic 0.829/0.839/0.798), arcade escape lessons. Next: scenarios.
- Scenario generator refactored (approach/circle shared); tutorial gains a realistic-mode setup eval + a mode check
  after let-go (2 steps); new tests/scenarios/net-arcade-keys.json (probe records real-time phase timestamps,
  interact prompts/captions/panel widgets during the crew phases; `until __A.ok()` fails the run on any winch/pull
  prompt). Running real-GPU runs next: qa/arcade/arcade1, qa/arcade/tutorial1, qa/arcade/basic1.
- Real GPU qa/arcade/arcade1 (net-arcade-keys.json --strict): PASS, 0 errors. Real seconds: closing 3.02, pursing
  2.02, hauling 3.02, brailing 2.02, close-up → report 7.05 (Space → report 10.07). No fishing interact prompt,
  captions only "Crew's pursing her up" / "Rings up!" / "Crew's hauling — drying up the bag", no tension gauge or
  pull dial. Catch 4,074 pinks, 14,666 lb, $3,959.93 "good"; escapes {leads 644, gap 406, corks 19, spill 56}.
  (Run predates the cork-climb visual cap added to net.js: VIS_HAUL_STEP.) Next: look at shots, tutorial + basic.
- qa/arcade/basic1 (basic --strict): PASS (fishing 0.05 ms, net 0.026 ms). qa/arcade/settings1
  (tests/scenarios/net-arcade-settings.json --strict): PASS — default Arcade with its hint, click Realistic →
  stored + hint, survives a reload (hud.mode realistic in game), switch back from the pause menu → hud.mode arcade.
  Tutorial (realistic) running as qa/arcade/tutorial1.
- qa/arcade/tutorial1 (net-tutorial-keys.json, realistic via the setup eval, --strict): PASS, 0 errors/warnings.
  3,870 pinks, 13,932 lb, $3,761.64 "good", mode realistic, escapes {leads 746, gap 575, corks 8}. Phase game
  minutes (= real s at 1 min/s): close ~8.8, purse 17.7, haul ~37.9 (incl. scenario shot waits), brail 9.2.
- Other set-driving scenarios (audio-live-set, fish-realset, net-phases, net-outcomes, net-hook-beach, ui-fishing,
  ui-realset, ui-sizes, ui-console, ui-delivery) gained the same realistic setup eval as step 2 so they keep
  photographing/measuring the realistic set they were written for (not re-run here).
- Final qa/arcade/arcade2 (all final code incl. the cork-climb cap, --strict): PASS, 0 errors/warnings. Real seconds:
  closing 3.02, pursing 2.03, hauling 3.02, brailing 2.02, close-up → report 7.07, Space → report 10.08; report →
  idle with the skiff stowed ~2.2 s (incl. the report panel photo). 4,072 pinks, 14,659 lb, $3,957.98 "good";
  escapes {leads 644, gap 405, corks 15, spill 60}; report line "most under the leadline as she closed up … Some
  always dive — keep off the school so it isn't spooked." npm test 586/586.
- Not mine: src/main.js and notes/FIX-start.md were modified by a concurrent task (start location) during this work.

## Summary

- `settings.fishingMode` 'arcade' (default) | 'realistic' in DEFAULT_SETTINGS, normalised by mergeSettings;
  Settings panel "Fishing: Arcade / Realistic" with the one-line hint (+ "— from the next set" mid-set); help card's
  Purse step and E / A-D rows follow `fishing.hud.mode`.
- fishing reads the mode at let-go (`set.mode`, `hud.mode`, payload `mode`); the realistic path is unchanged (every
  arcade difference is behind `set.mode === 'arcade'` / `net.arcade`).
- Arcade: close-up offered within 2 × closeDistance (44 m) while setting, 60 m (kept to 75 m) holding; closing 3 s
  once the end is within 75 m (a hook's far beach end still needs running down); no tow-off / A-D / wheel / winch /
  fouls / snags / smooth-bottom slow-down / corks under / tide label; purse 2 s, haul 3 s (0.9 of the corkline at
  ~100 m/s; the cork climb is visually capped at 0.56 m per frame to avoid strobing), brail 2 s (1.5 s water haul,
  Space skips); the skiff heads home at rings up and is stowed 2.5 s into the report if not yet aboard; the empty bag
  comes aboard in 1.5 s. Controls locked pursing → brailing only.
- Catch: the fish sim's leadline leak runs for 2 s instead of ~20 s, so a clean arcade set lands at the species
  ceiling (pinks 0.85) vs ~0.80–0.84 realistic (tests replay both net traces on WP-FISH's sim: ratio 1.04); gap and
  fringe losses before/at close-up are identical.
- Tunables: FISHING_TUNING.arcade in src/entities/net/tuning.js.
