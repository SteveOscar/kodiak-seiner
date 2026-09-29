# FIX-rules-radio — polish log (WP-RULES: season radio after the QA fix wave)

One line per change: what, files, how verified. Files owned: src/game/season.js, src/game/data/**, tests/rules*.test.mjs.

Starting state: src/game/season.js and src/game/data/radioLines.js already carried uncommitted edits in this area (the
bear outcome watch, `bearChargeAboard`, `{rival}`, RSW/morning/evening/tender/niceSet/holdFull rewording). They were
reviewed against the current code, kept, and completed below.

- Bear-charge quip branches on the outcome. player.js emits no outcome event: after a charge (`bear:encounter`
  stage 'charge' while `ctx.state.control === 'foot'`) season.frame() watches `player.phase` ('retreat' while the charge
  and fade play) and `ctx.state.control`. Control → 'boat' after the retreat = put back aboard → `bearChargeAboard`
  ("haul you back aboard", "Pick another landing"); phase back to 'foot', still on foot, mode 'play' = beside the
  skiff → `bearCharge` ("run you back to the skiff"). Without a `phase` field, the player's cutscene stands in for the
  retreat. A charge the player ignored (no retreat within 3 s) or one that never settles (30 s) says nothing. Waits
  count simulated seconds only (play/cutscene), so a pause mid-fade no longer drops the line. The line is delayed 7 s
  so the Skiffman's own quip (player.js QUIPS / QUIPS_ABOARD) airs first. src/game/season.js, radioLines.js.
- `{rival}` is a regular token (the best non-player row on the fleet board) instead of an extra passed only by the
  Highliner handler, so the line can never air with a raw `{rival}`. src/game/season.js.
- Price lines no longer quote the tender's price as the cannery's: tokens price at the nearest tender's buyer id, and
  canneries/City of Kodiak are separate buyers (±5% buyer spread). "Cannery says humpies are…" → "<tender> says…",
  "Silvers are … at the cannery" → "<tender>'s paying … on silvers", "paying a penny over the cannery on dogs" (not
  guaranteed) → "<tender>'s paying <price> on dogs". src/game/data/radioLines.js.
- Composed lines are sentence-cased, so a line opening on a lower-case token fallback ("the tender") reads right.
  src/game/season.js (compose → fill).
- holdFull (Pete): sellers are the tenders, City of Kodiak and the cannery docks (places with 'sell'), so "sell at a
  cannery dock" → "run 'em to a tender, or tie up and sell in town or at a cannery". "Potluck on the dock in
  {harbor}" → "at {harbor}" ({harbor} can be a cannery). src/game/data/radioLines.js.
- Pete's welcome only names a pink school ("humpies") and prefers the tutorial school (fish sim, 380–420 m, "a quarter
  mile"); with no pink school in 1.5 km it falls back to WELCOME_NONE instead of calling chum humpies.
  src/game/season.js.
