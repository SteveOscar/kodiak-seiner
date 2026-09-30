# FIX-verify-arcade — the verifier's two minor arcade findings (qa/verify-arcade/findings.md)

## Progress log

- Read findings (Issue A: skiff still out when the report is dismissed, let-go ~2.5 s later; Issue B: "Close up!"
  keypress → report 10.1 s, closedUp → report 7.1 s).
- Issue A cause confirmed: core.update only steps while `ctx.state.mode === 'play'` and dt > 0, and the report card
  pauses the game (main loop ticks systems with dt 0 in mode 'paused'), so `set.reportT` (the 2.5 s arcade skiff
  stow and the 1.5 s empty-bag finish) only runs after dismissal. The skiff and net systems don't move while paused
  either, so counting real time behind the card would only make them vanish later behind the dimmed card.
- Fix A (src/game/fishing/core.js): `stowBehindReport()` — in an arcade report while the game is paused, the crew
  stows a skiff still out and the net at once (behind the card, as it fades in). The first play tick after the card
  is dismissed finds both aboard and goes idle, so "Let 'er go!" is offered straight away. Realistic is unchanged
  (its report waits for the skiff under its own power, up to reportTimeout). Without a pausing panel (no UI) the
  arcade report keeps the old in-play timings (bag 1.5 s, skiff stowed after 2.5 s).
- Fix B (src/entities/net/tuning.js FISHING_TUNING.arcade): closeSeconds 3 → 1 (the net is made fast after 1 s;
  closeBlend, 1.6-2.6 s scaled by the gap, still brings the ends alongside while the crew purses), haulSeconds
  3 → 2.5. Space "Close up!" → report = 1 + 2 + 2.5 + 2 = 7.5 s; closedUp → report 6.5 s. Purse (the leadline leak
  that sets the arcade catch) and brail are unchanged. The hook / far-skiff case still waits for the end to be within
  liftGap before making fast.
- tests/net-arcade.test.mjs: 2 new tests — Space → report < 8 s (sim: close 1.03 + 6.57 = 7.6 s); arcade report
  under a pause stows the skiff (sent 250 m off during the haul) and the net, idle on the first play frame and
  fishing-letgo offered; a realistic report under a pause leaves the skiff out. 16/16 in the file.
- npm test: 602/602 pass (qa/verify-arcade/fix-npm-test.log).
- Real GPU qa/fix-verify-arcade/arcade1 (tests/scenarios/net-arcade-keys.json --strict): SMOKE PASS, 0 errors /
  warnings. Real seconds: closing 1.00, pursing 2.03, hauling 2.50, brailing 2.02; close-up → report 6.55,
  Space → report 7.55. __A.ok() true (no fishing interact prompts, captions arcade only). 4,123 pinks, 14,843 lb
  "good"; escapes {leads 652, gap 346, corks 17, spill 59}. The report shot shows the net and skiff already aboard
  behind the card; fishing-letgo offered after the dismissal. 07-pursing shot: the ends are alongside, net closed.
  (The generator's "06-closing-crowsnest" shot, taken 1.2 s after Space, now shows the start of pursing; the
  scenario JSON is outside this fix's files, so the wait was left as is.)
- Verifier repro qa/fix-verify-arcade/verifier-arcade (qa/verify-arcade/arcade.json: fresh profile, New Season
  tutorial, real keys, report dismissed with Space): every step completed, failures [] and errors []; SMOKE FAIL
  only from the verifier's own "[verify] stuck" console.warn watchdog under --strict (as in its runs). 300 ms after
  the Space on the report: {mode play, fishing idle, skiff stowed, net stowed} (was {play, report, returning}).
  __V.summary(): closing 1.02, pursing 2.02, hauling 2.52, brailing 2.02, pursingToReport 6.55, spaceToReport 7.57
  (was 10.12), reportToStowed 0.02 (the skiff was still out at the report and was stowed behind the card), let-go
  offered as soon as the card closed. Second let-go after switching to Realistic: set 2 hud.mode realistic.
- qa/fix-verify-arcade/net-tutorial-keys (realistic tutorial via its setup eval, --strict): SMOKE PASS, 0 errors /
  warnings. qa/fix-verify-arcade/start-location (--strict): SMOKE PASS, 0 errors / warnings.

## Summary

- Issue A fixed in src/game/fishing/core.js (`stowBehindReport`): while the arcade report card holds the game
  paused, the crew stows a skiff still out and the empty net at once, so the first frame after dismissal is idle
  with the skiff aboard and "Let 'er go!" offered. Realistic reports unchanged.
- Issue B fixed in FISHING_TUNING.arcade: closeSeconds 1 (was 3), haulSeconds 2.5 (was 3). "Close up!" press →
  report 7.55 s real (was 10.1), closed-up → report 6.55 s (was 7.1). Catch unchanged (purse time unchanged).
- Tests: tests/net-arcade.test.mjs +2; npm test 602/602.
