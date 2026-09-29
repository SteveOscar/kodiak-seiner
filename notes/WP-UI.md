# WP-UI — title, HUD, chart, logbook, reports, fish tickets, harbor, menus

## Summary

Owned files: `src/ui/**` (`ui.js`, `styles.css`, `hud.js`, `sonar.js`, `setPanel.js`, `messages.js`, `title.js`,
`menus.js`, `logbook.js`, `map.js`, `report.js`, `harbor.js`, `overlays.js`, `saves.js`, `dom.js`, pure modules in
`src/ui/lib/` — `format.js`, `logic.js`, `chart.js`, `art.js`), tests `tests/ui.test.mjs`, scenarios
`tests/scenarios/ui-*.json`, QA `qa/ui/` (helper scripts and profiling scenarios in `qa/ui/tools/`).

Verified in the full game against the real fishing, economy, season/rules, discovery, places, fleet, cameraRig and
audio systems (no skip flags): a real set from "Let 'er go!" to the report card, a real delivery to a tender with its
fish ticket, save & quit → Continue, fast travel, sleep/tie-up, settings (quality reload, time speed, invert Y), the
chart with every place discovered, binocular sightings, on-foot HUD, and 1024×640 / 1280×720 / 1920×1080 layouts.

- **Title** over the live cinematic: a fine-line leaping salmon (built along a curved spine with a measured salmon
  depth profile — dorsal/adipose/pelvic/anal/pectoral fins, gill cover, lateral line, spots, forked tail) whose outline
  draws itself over a swell before fins and spots fade in; the KODIAK / SEINER wordmark with letter-by-letter entry; a
  left scrim; the menu (Continue with boat/date/gross when a save exists, New Season (confirms before replacing a
  save), Free Explore, Settings, Controls, Credits), keyboard navigation (↑/↓/W/S, Enter/Space); the F/V boat-name
  field (`seiner.setBoatName` on start; remembered in `localStorage['kodiak-seiner:boatName']`); a film-style caption
  naming the current title shot (labels from `src/render/camera/titleShots.js`, imported lazily).
- **HUD**: top-left date/time (sun/moon glyph), opener status (`season.openerStatus`, green/amber dot, "opens Wed Jul
  8 6:00 AM"), tide stage and time to slack, district, and a quiet "what next" line (look for jumpers / cast off (W) /
  pick up the anchor / deliver to the nearest tender with distance / fuel low / night — anchor and sleep / opener at
  6:00 AM; silent during a set, ashore, or when a prompt already says it); top-right cash (red + "Advance" chip in
  debt), hold gauge (species-coloured segments, lbs/capacity), fuel bar (amber ≤ 20%, red ≤ 10%; cash and fuel hide in
  Free Explore); top-centre compass strip (canvas strip translated with a 100 ms CSS transition, wrap-safe) with
  waypoint, tenders (nearest named with distance), nearest discovered harbor and fading fish sightings, labels
  de-duplicated by priority, edge arrows for off-strip markers; bottom-left sonar (heading-up PPI: `fish.sonarReturns`
  echoes colour-coded by strength with phosphor persistence, shore and shoal returns from the heightmap, CSS sweep,
  depth, range from `economy.modifiers.sonarRange`); bottom-right helm (speed in kn, heading, throttle and rudder
  indicators, state: tied up / at anchor / aground / out of fuel / speed-limited, camera mode; ashore it becomes an
  elevation (real metres) and walking-heading readout); bottom-centre prompts from `interact.current` (keycaps; hold
  prompts get a progress ring fed by `hud.pursed`/`hud.hauled` and light up while the key is held).
- **Set widgets** from `fishing.hud`: caption line (`hud.message`), phase header with set number, hook/tied flags and a
  "Closed waters" chip, depth under the stern; payout bar in fathoms; skiff distance with a bearing arrow and "in
  range" badge (`closeReady`); in-the-hook / in-the-net estimate; hold timer; purse tension gauge (track, low/high
  zones, the green band from `tensionBand`, a gliding needle, "steady / too slow / too fast"); rings-up bar; haul bar;
  skiff-pull dial (current vs ideal pull, heading-up, A/D keycaps light the key that swings it); brailer count-up;
  bottom warning (red when rocky); stall banner (net in the wheel / hung up / rings fouled with seconds); "stern near
  the corks" blinker (`wheelDanger`); abort progress bar (Backspace). When idle, the rocky-bottom caution shows only
  beside a "Let 'er go!" prompt.
- **Messages**: toasts (top-centre pills, 4 max — 2 while a title banner is up so they never collide); discovery
  banners (a place-name title card built from the discovery toast + `place:discovered`; memorials stay quiet);
  season-goal, opener open/closed and end-of-season banners, one at a time with a fade gap; VHF captions (channel
  badge, sender, time, per-character typewriter; one transmission at a time like a real channel; the older of two
  collapses to one dimmed line); hints once per save (a "Skipper's notes" card; hints with `from` — Uncle Pete's
  tutorial — render as radio captions tagged "Tip"); the "time passes" fade card (`ui.fade`, used by
  travel/sleep/wait/tie-up/tow). Messages hold still behind menus, the chart and photo mode.
- **Chart** (M, mode `map`): raster built once from the heightmap in idle time (2048², ~130 ms total, sliced by
  `requestIdleCallback` after boot): cream land with NW hillshade and 100 m / 500 m contours, blue depth bands at the
  gameplay depths (< 6 m can't set, 6–16 m leads touch bottom, 16–40 m, deep) with depth contours, a dark coastline.
  Vector layers on view change: graticule with margin ticks, a double neatline, magenta district boundaries and names,
  hatched closed waters (streams + closed areas), soundings (three density levels by zoom, kept clear of the rose), a
  compass rose with the 14°E magnetic ring, discovered place names (serif; italic for water features; symbols per
  kind; peak heights) with greedy collision-free placement inside the neatline and clear of the legend and rose, faint
  dots for undiscovered places; the chart's title block ("Kodiak Island and approaches · soundings in metres") sits
  with the legend in the corner of the sheet. Live layer at 10 Hz: own boat and heading line, tenders (named, VHF
  channel), fleet boats, waypoint with bearing/distance, intel notes (dots at overview zoom, note icons closer; hover
  tooltips), fish sightings by species colour fading with age, tidal-current arrows around the boat, fast-travel route
  preview. Pan (drag), zoom (wheel, buttons, double-click), click to set a waypoint or pick a harbor/tender,
  right-click clears. Sidebar: position (deg-min), district and opener, tide curve (now → +11 h), waypoint, fast-travel
  list and preview card (`season.travel.targets/preview/go` from `src/game/travel.js`: distance, running time,
  cruising speed, fuel and cost, arrival, warnings).
- **Logbook** (L): Places (progress, cards newest first with blurbs, chart notes and bonus; memorial cards quiet — no
  kind, date or bonus), Wildlife (sightings, schools logged by binoculars/spotter/summit, and a "reading jumpers" guide
  per species), Catch (season stats, set history from `fishing:setComplete`, delivered lbs by species, fish-ticket
  history — click to reopen a ticket), Season (goals with progress, fishing periods with today/past/closures, the
  fleet board with the player highlighted, the marine forecast). Long lists fade at the bottom edge.
- **Set report** (`fishing:setComplete`, pauses): headline by rating (Plugged! / Good set / A few fish / Water haul /
  Cited), a line of skipper talk, species rows with bars, totals (lbs, value at today's prices, crew share), notes
  (escapes, kings released, overflow over the corks, hold level). Space/Enter/Esc continue.
- **Fish ticket** (`economy:delivered`, pauses): an ADF&G Salmon Fish Ticket on paper — seal, ticket number, date and
  time landed, vessel, CFEC permit, gear 01 purse seine, condition, delivery code, district, stat area,
  processor/tender, species codes 410–450 with counts, pounds, price, value, totals, crew shares (skiffman + 2
  deckhands), advance repaid, paid to vessel, signatures and a PAID stamp.
- **Harbor menu** (`ui.openHarbor(place)`; economy offers "E — <harbor> — harbour services"): the boat (cash, hold,
  fuel, seine, sonar, speed), sell the catch (opens the fish ticket over the menu), fill the tanks (quote, advance
  limit), rest (sleep / wait for the opener, with reasons when unavailable), the boatyard (upgrade cards with category,
  tier pips, blurb, current → next, price, reason when not buyable) and the spotter charter.
- **Pause / settings / help / credits**: pause (Resume, Chart, Logbook, Settings, Controls, "Abort set — haul back"
  while fishing, Save & quit / Quit to title with a note on whether the game can save now and when it last saved;
  ↑/↓ or W/S move a highlight, Enter/Space picks); settings (quality segmented control → saves then reloads;
  master/music/effects/ambience sliders → `audio.setVolumes`; time speed ½×–4× → `clock.scale`; invert vertical look);
  controls card (F1: how to work a seine in 7 steps + key reference + mouse + gamepad); credits (data attribution per
  THIRD_PARTY_NOTICES, three.js MIT, procedural-art statement, Alutiiq acknowledgement).
- **Binoculars** overlay while `cameraRig.binoculars`: twin-barrel mask with soft edges, reticle with mil ticks,
  bearing and field of view, a first-use hint, and a "Logged on your chart — Pink school — humpies · heading SE · 2.3
  nm off" card on `camera:sighting`; HUD corner panels hide. **Photo mode** (H): everything hidden, a key card for the
  free camera fades after 4.5 s.

## API as built (`ctx.systems.ui`)

Required: `visible` (get/set; hides HUD + messages), `toast(text, {kind, duration})` → `ui:toast`,
`radio(from, text, channel = '16')` → `ui:radio`, `hint(id, text)` → `ui:hint`, `openMap()` / `openLogbook(opts)` →
`ui:open {panel}`. Extras: `openHarbor(place)` → `ui:open {panel: 'harbor', opts}`, `fade({title, subtitle, holdMs,
fadeMs})` → `ui:fade` (travel.js's `showFade` uses it), `setWaypoint({x, z} | null)` → `ui:waypoint {waypoint}`,
`waypoint` (getter), `frame(realDt)`, `serialize()` → `{hintsShown, waypoint, sets, tickets}`, `restore(d)`,
`reset()`, `debugState()` → `{mode, panels, waypoint, hintsShown, sets, tickets, toasts, radio, radioQueued, banner,
hintQueued, chartReady}`. All methods only emit; everything is drawn from events in `frame()`.

Events consumed: `ui:toast`, `ui:radio`, `ui:hint` (`from`/`channel` optional → radio tip), `ui:open`, `ui:fade`,
`place:discovered`, `fishing:setComplete`, `economy:delivered`, `opener:start`/`opener:end` (banners in play),
`season:end` (banner with board rank), `boat:collision` (ground cue), `bear:encounter` (watch/charge cues),
`camera:sighting` (binocular card), `game:mode`, `game:start` (first-start controls hint), `game:ready` (schedules the
chart raster), `time:skip`, `economy:cash` (harbor menu refresh).
New events: `ui:open {panel, opts}`, `ui:fade {title, subtitle, holdMs, fadeMs}`, `ui:waypoint {waypoint}`,
`ui:radioShown {from, channel, tip}` (a caption starts typing — for audio sync if wanted).

Modes (SPEC §4.2): only the UI reacts to pause (Esc/P/pad Start), map (M/pad Back), logbook (L/J), help (F1, /) and
photo (H). Routing is the pure `routeKeys(mode, topPanel, keys)` (unit-tested): play → open pause/map/logbook/help or
photo; paused → Esc closes the top panel (back), L/F1 toggle their panels; map → M/Esc close; photo → H/Esc leave;
report/ticket → Space/Enter/Esc continue; title → Esc backs out of a sub-panel; cutscene/loading → nothing. The UI
keeps a panel stack: the map sets `map`, every other panel `paused`, and closing the last one returns to `play`. If
another system resumes play while panels are open they close silently. Set reports and tickets queue until play (or
open over the harbor/pause menu).

Pointer events: `#ui` and its children are `none`; cards, the title menu/name field, chart frame and sidebar, ticket
and zoom buttons opt in with `.ui-interactive`. Clicked buttons blur so Space/Enter stay with the game.

DOM writes: a 20 Hz beat alternates between the HUD panels (status, purse, compass, helm, set panel, binocular
bearing) and the sonar, so each refreshes at 10 Hz on its own frames (needles and strips glide with 100 ms CSS
transitions); prompts every frame but only when their signature changes (ring progress quantised to 0.5%); messages
build DOM once per message; the chart base redraws only on view changes, the live layer at 10 Hz while open.

## Deviations and decisions

- **Set report pauses** (SPEC: paused is entered by the set report and fish ticket). Scenarios from other WPs that wait
  for `fishing.state === 'idle'` after a set must dismiss the report (Space/Escape, or
  `clickSel: "#ui .panel-report .btn.primary"`).
- **Cutscene**: UI keys do nothing during a cutscene (Esc would otherwise call `resume()` and break the owner's
  cutscene); SPEC says Esc always pauses — recorded as a deliberate exception.
- **Chart scale**: distances are chart nautical miles (`geo.toNauticalMiles`, the real-world scale), matching
  travel.js; soundings are game depths in metres (what the HUD, sonar and net use), labelled "soundings in metres".
- **Chart title block** lives in the legend box (a fixed corner of the sheet) rather than at a world position: at the
  overview zoom every open-water spot large enough for it overlapped the island's south-east coast.
- **Hints**: the UI adds one of its own on a new game (`ui-controls`, 9 s after start). `ui:hint` events arriving in
  title are ignored and not marked shown.
- `localStorage['kodiak-seiner:boatName']` remembers the last boat name for the title field (not part of the save).
- Settings read/write goes through `season.save` (the running save manager) → `src/game/save.js` helpers (lazy import)
  → plain localStorage, so a broken neighbour never stops the menus. Quality changes save first when possible, then
  reload.
- `serialize()` also keeps the last 40 set summaries and 16 fish tickets for the logbook (additive to
  `{hintsShown, waypoint}`).
- UI copy uses American spelling ("harbor") to match the place names; the economy's own prompt text says "harbour
  services" (WP-RULES' string).
- Sizes scale with `--k = clamp(0.8, (min(h/760, w/1350))^0.6, 1.35)`; below 1100 px wide some grids collapse, below
  860 px the chart sidebar and title caption hide.

## Tunables

`hud.js` (`HALF_SPAN` 68° compass span, `STRIP_W` 440, marker ranges 6 km tenders / 7 km harbor / 5 km sightings,
`LABEL_CHAR_PX` for label collisions), `sonar.js` (`ANGLES` 96 × `STEPS` 30 shore sampling a third of the ring per
refresh, echo colour `SCALE`, phosphor fade 0.8 s), `messages.js` (`MAX_TOASTS` 4, `MAX_RADIO` 2, `MAX_RADIO_QUEUE`
6, typewriter `CPS` 42, `RADIO_GAP` 0.55 s, banner gap 0.9 s), `lib/logic.js` (`radioDuration`, `toastDuration`,
`nextStep` thresholds), `lib/chart.js` (`CHART_COLORS`, `DEPTH_CONTOURS` [6, 16, 40], `LAND_CONTOUR` 20 m game (100 m
real), `LAND_INDEX` 100), `lib/art.js` (salmon `PROFILE`, spine pose via `R`/`rotDeg`, tail flick), `map.js`
(paper/ink colours, zoom range ×7, sounding spacing 1500 m, rose world position), `ui.js` (`WAYPOINT_REACHED` 60 m,
history sizes, HUD beat 20 Hz).

## Tests

`node --test tests/ui.test.mjs` — 20 UI tests (+ the imported contract tests, 25 total): money/time/calendar/heading
formatting, `routeKeys` for every mode, compass layout and label de-duplication, skiff-pull advice, the "what next"
line (incl. tied up / at anchor), sonar projection (heading-up, starboard right), hold segments/fuel tones, tension
zones, report headlines/rows (plugged overflow, water haul, cited), fish-ticket model (full receipt and the stub's
partial receipt), keycap parsing, timing helpers and tide labels, the chart view (zoom-about-cursor, pan clamp, round
trips), the chart raster (sea blue, land warm) on the real heightmap, soundings in open water, label placement
without overlaps, inside left/top bounds and off blocked rects, the salmon mark (well-formed, draw-on classes and
`pathLength`, every point on the sheet, other poses), and the ui system under Node (required API, events only,
serialize/restore/reset).

## Smoke scenarios

The harness now runs without HMR/watch, so the live tree is used directly (the older `qa/ui/tools/snap-smoke.sh`
frozen-copy runner is kept for busy periods).
- `ui-realset.json` — **the real game end to end**: New Season, a real set driven by WP-NET's pilot (idle prompt,
  setting, hook/holding, close-up ready, closing, pursing with E held — tension gauge, pull dial, hold ring — hauling,
  brailing count-up), the report card, then a real delivery to the nearest tender (prompt, fish ticket) and the
  logbook's Catch tab. Use `--timeout=1200000` on a busy GPU.
- `ui-abort.json` — pause mid-set ("Abort set — haul back"), hauling back, the aborted water-haul card, period closing
  at night, logbook Season tab.
- `ui-panels.json` — chart (overview, zoom, travel preview), logbook tabs, set report (plugged), fish ticket (real
  `economy.deliver`), pause, settings, help, harbor menu (tied up at Kodiak), binoculars, photo mode.
- `ui-chart.json` — every place discovered: the whole chart, Kodiak close up, panned, maximum zoom.
- `ui-flow.json` — discovery banner, toasts + hint, fast travel with the fade card, save & quit, Continue on the title,
  load.
- `ui-settings.json` — settings over the title, quality change → reload (verifies `ctx.quality` and the stored
  setting), pause-menu keyboard navigation, time speed 2× (`clock.scale`), invert Y.
- `ui-title.json`, `ui-title-hud.json` — title, keyboard selection, credits, second title shot; HUD at noon, underway,
  night.
- `ui-bino.json` — binocular sighting card, the sighting on the compass and chart, the logbook's schools list.
- `ui-delivery.json`, `ui-reports.json` — staged haul → brail → report → real delivery; water haul, cited, plugged with
  overflow, advance on the HUD and the ticket.
- `ui-foot.json` — the HUD ashore (elevation readout, compass follows the camera).
- `ui-sizes.json` — run with `--width/--height` (1024×640, 1920×1080): title, a staged real purse, chart, logbook,
  help, harbor, pause.
- `ui-console.json` — widget gallery for states that are hard to trigger for real (stalls, rocky bottom, abort bar);
  run with `--params="skip=fishing"` so `fishing.hud` fields can be set on the stub.
- `ui-compass.json` (markers, night), `ui-bench.json` (`--bench`, with and without `skip=ui`).
- Profiling: `qa/ui/tools/prof2.json` (neighbour-call costs), `prof3.json` (per-frame `ui.frame` distribution),
  `title-mark.json` (title mark draw-on timing), `mark3.mjs` (renders the salmon mark variants large).

## Perf

- `--bench`, quiet machine (`qa/ui/final-bench-with`): `perf().systemsMs.ui` **0.007 ms title, 0.024 ms underway,
  0.034 ms with the chart open**; in-page `ui.frame(0.1)` refresh 0.058 ms (one beat) and 0.019 ms per frame averaged
  at 60 fps. Strict basic run (`qa/ui/final`, 60 fps vsync): ui 0.069 ms.
- Busy machine (other agents' runs, 20–50 fps): EMA 0.18–0.4 ms; real-frame distribution (`qa/ui/w3-prof3`, 0.1 ms
  timer resolution): mean 0.10 ms, p50 0, p90 0.3, p99 0.9 ms. Neighbour calls per refresh total ~60 µs
  (`sonarReturns` 4 µs, harbor lookup 11 µs, 320 `depthAt` 40 µs). Always under the 0.5 ms budget.
- GPU: `--bench` with/without `skip=ui` shows no difference beyond noise (gpuMs 9.8–12.2 with vs 13.7–16.1 without in
  back-to-back runs — the "without" run was the noisier one). No draw calls, no triangles.
- The always-on HUD uses no `backdrop-filter` (it would re-blur the moving canvas every frame); only modal scrims
  darken the scene. The chart raster costs ~130 ms once, spread over idle callbacks after boot (a 2048² canvas).

## Best screenshots

- Title: `qa/ui/w4-1080/01-title.png` (1080p), `qa/ui/w2-title/04-title-shot2.png` (Uyak Bay caption),
  `qa/ui/w2-flow/05-title-continue.png` (Continue), `qa/ui/w8-mark2/b-1500.png` → `d-4300.png` (mark drawing on).
- HUD: `qa/ui/final/evening.png` (golden hour), `qa/ui/w1-titlehud/02-hud-noon.png`,
  `qa/ui/w1-titlehud/04-hud-night.png`, `qa/ui/w6-foot/01-on-foot.png` (ashore).
- The real set: `qa/ui/final-realset/01-setting.png`, `02-holding.png`, `03-close-ready.png`, `05-pursing.png`,
  `07-hauling.png`, `08-brailing.png`, `09-report.png`, `11-deliver-prompt.png`, `12-ticket.png`,
  `14-logbook-catch.png`; widget states: `qa/ui/w5-console/05-pursing-foul.png`, `08-abort.png`.
- Chart: `qa/ui/w7-chart3/01-overview.png`, `qa/ui/w7-chart3/02-kodiak-close.png`, `qa/ui/final-panels/12-map-travel.png`.
- Panels: `qa/ui/final-panels/20-logbook-places.png`, `qa/ui/w3-abort/05-logbook-season.png`,
  `qa/ui/final-panels/30-report.png`, `qa/ui/final-panels/31-ticket.png`, `qa/ui/final-panels/50-harbor.png`,
  `qa/ui/w3-abort/01-pause-mid-set.png`, `qa/ui/w6-settings/03-settings-in-game.png`, `qa/ui/final-panels/42-help.png`,
  `qa/ui/w2-title/03-credits.png`.
- Overlays: `qa/ui/w4-bino/02-logged.png` (binocular sighting), `qa/ui/final-panels/61-photo.png`,
  `qa/ui/w2-flow/03-travel-fade.png`.

## Known issues

- Keyboard covers Esc/Space/Enter/L/M/F1/H, title and pause-menu navigation; the harbor menu, logbook tabs and chart
  are mouse-first (no focus traversal inside them).
- The chart raster is 2048² (the heightmap's resolution); at maximum zoom (×7) it is upscaled and the baked coastline
  and lake outlines look soft and slightly stepped.
- Chart labels are placed greedily per view; at some zooms a lower-priority name is dropped rather than moved far from
  its feature.
- The world keeps rendering behind the opaque chart (see Requests).
- `ui-console.json` needs `--params="skip=fishing"`: the real fishing system rewrites `fishing.hud` every frame.

## Requests to other work packages

- **Core**: while `mode === 'map'` the chart panel is opaque; `pipeline.render` could be skipped (or run at a low rate)
  to save the GPU for the chart's pan/zoom.
- **WP-RULES**: the start-of-season radio ("… Opens at six — go get 'em") is also sent when a game is started later in
  the day (debug starts); consider wording it from the clock. The harbor offer label says "harbour services" — the UI
  uses "Harbor" elsewhere.
- **WP-AUDIO**: `ui-click` / `ui-open` are wired and heard; `ui:radioShown` is available if the radio squelch should
  start exactly when a queued caption begins typing.
- **Other WPs' screenshots**: the HUD appears in every shot; use `--params="skip=ui"` for clean beauty shots.

## Core changes

None.

## Post-QA changes

See [FIX-ui.md](FIX-ui.md) (2026-09-28 QA fix wave); it supersedes anything here that it contradicts.
