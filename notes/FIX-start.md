# FIX-start — pick a start location for every new game

Request: "When users start a new game, they should always be given the option of which location to start at."

## Progress log
- [start] Read SPEC §4, §6.5, §6.15, §8.1, title.js, teleport.js, travel.js, main.js ctx.game.start (startAt already supported).
- [survey] Downstream check: fish.js spawns the tutorial school around the seiner's position at game:start (sim avoids
  closed waters); season.js tutorialWelcome() is computed from positions (generic wording); discovery.js silently
  discovers places around the start on a new game (generic, comment still says St. Paul Harbor — not my file);
  HUD nextStep() is generic; radio LINES use nearby-name tokens; economy.js "in town" = Kodiak (true from anywhere).
- [plan] src/ui/lib/start.js (pure: build options, filter, group, preselect, remember), src/ui/startPicker.js (DOM),
  title.js wires New Season/Free Explore -> picker -> ctx.game.start({ newGame, freeExplore, startAt }).
  CSS appended as one delimited block at the end of styles.css. localStorage key kodiak-seiner:startAt.
- [impl] Wrote src/ui/lib/start.js (buildStartOptions/filter/group/preselect/startAtFor/pickSurprise/remember,
  clearOfClosedWaters: the Karluk arrival pose sits inside the Karluk River markers, so New Season starts are moved
  just outside closures), src/ui/startPicker.js, wired title.js, appended the CSS block (delimited "FIX-start").
  Kodiak's in-town harbors/cannery row fold into City of Kodiak for New Season.
- [test] tests/ui-start.test.mjs passes (14 incl. helper world); scenario tests/scenarios/start-location.json written; ui-flow/ui-panels/ui-title-hud now click through the picker
- [fix] hover no longer steals the preselection (row mousemove after real pointer motion); list fades at the bottom when more is below
- [verify] start-location scenario PASS --strict (qa/start/run3); click timing after quit-to-title needed wait 2500 + timeout 12000
- [verify] npm test: 600/600 pass
- [verify] basic smoke --strict PASS (qa/start/basic)
