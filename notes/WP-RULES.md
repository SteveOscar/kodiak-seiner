# WP-RULES — season, economy, discovery, save, sleep, fast travel

## Summary

Owned files: `src/game/season.js`, `src/game/economy.js`, `src/game/discovery.js`, `src/game/save.js`,
`src/game/travel.js`, `src/game/data/**` (pure, DOM-free rule modules), tests `tests/rules-*.test.mjs`, scenarios
`tests/scenarios/rules-*.json`, QA output `qa/rules/`.

- **season** — the ADF&G period schedule and `openerActive(x, z)` as the single authority (fishing day ×
  06:00–22:00 × district rules; always open in Free Explore), `nextOpener`, `opener:start/end` (also after a
  `time:skip` that crosses a boundary), species mix by date/runs/streams/hatcheries/district/bay enclosure, seeded
  daily prices per buyer (±15%) + RSW bonus (kings 0), closed waters from `places.streams` + `CLOSED_AREAS`, a seeded
  Kodiak July–August weather schedule applied through `sky.setWeather` (never while `debug.weatherPinned`), a
  NOAA-style marine forecast, the 8-boat fleet board, the VHF radio (≈205 lines + templated ADF&G / NOAA / Coast
  Guard / tender broadcasts, rate-limited and context-aware, silent in title), and the rest offers: **Sleep**
  (priority 70), **Wait for the opener**, **Drop anchor**. It installs the save manager and fast travel.
- **economy** — cash with the cannery advance (to −$10,000), the hold (kings never kept), fuel burn from
  `seiner.engineLoad` (none in Free Explore), 20%/10% warnings, empty → `setSpeedLimit('fuel', 2)` + tender radio +
  "Accept a tow" ($750 + fill to 25% at the tender price), deliveries to tenders and cannery docks producing the §7
  receipt and `economy:delivered`, refuelling ($4.60 in town, +$0.40 at villages, canneries and tenders), "Tie up at
  <harbour>" (snaps to the dock behind a short fade, `setMooring({kind: 'dock'})`), the §8.3 upgrade catalog with
  tiers, caps and modifiers, spotter-plane charters, goals on `stats.seasonGross` plus Highliner.
- **discovery** — place enter/leave/discover from `ctx.game.avatar()` (onFoot places only on foot, memorials quiet),
  toasts + $25–$100 tokens, stream discovery (`stream:<id>`), chart intel (run-timing cards and species-aware hot-spot
  notes for streams, rivers, bays, capes, straits, hatcheries), wildlife first sightings, fish marks from binoculars /
  summit perches (line of sight, 3 km, rest of the day) / the spotter plane, `progress()`, logbook `cards()`.
- **save.js** — career save, Continue, settings, Free Explore log; autosaves; versioned.
- **travel.js** — fast travel with a water-route cost preview, plus the shared fade/caption overlay used by travel,
  tow, sleep, waiting and tying up.

## API as built

### season (`ctx.systems.season`)
Required: `openerActive(x?, z?)`, `nextOpener(x?, z?)` → `{day, hours, districts: 'all'|[ids], closed, date, label,
inHours, districtNames}` or null, `speciesMix(x?, z?)` → Catch shares summing to 1 (king always 0),
`priceFor(species, tenderId?)` → $/lb (cents), `forecast()` → `{today, tomorrow, warning, todayText, tonightText,
tomorrowText, text, wind: {dir, kt, from}, seasFt}`, `closedWaters` (stable array of `{id, streamId, name, x, z,
radius, reason}`), `isClosedWater(x, z)`.
Extras: `closedWaterAt(x, z)`, `districtAt(x, z)` → id (`afognak|northwest|southwest|alitak|eastside|northeast|
mainland`), `districtName(id)`, `openerStatus(x?, z?)` → `{open, label: 'Open · closes 10:00 PM' | 'Closed · opens Wed
Jul 8 6:00 AM' | 'Season closed', next}`, `period(day?)`, `schedule()`, `weatherPlan`, `scheduledWeather(day?, h?)`,
`fleetBoard()` → `[{rank, name, skipper, gross, today, player}]` (player included, live partial day while open),
`fleetNames`, `tenderChannel(tender)`, `radioSay({from, text, channel}, opts)` (rate-limited radio for other WPs),
`say(category, opts, queue)`, `canSleep()`, `sleep()`, `canWait()`, `waitForOpener()`, `dropAnchor()`, `save`
(save manager), `travel` (fast travel API).

### economy (`ctx.systems.economy`)
Required: `cash`, `hold`, `holdLbs()`, `capacityLbs`, `fuel`, `fuelCapacity`, `fuelEmpty`, `upgrades` (`{id: tier}`),
`modifiers` (same object for the whole session; `{maxSpeed, netLength, netDepth, purseRate, haulRate, sonarRange,
holdLbs, rswBonus, deckLights, deckLightsLevel, spotterUntilDay}`), `catalog` (getter: rows `{id, name, category,
blurb, level, maxLevel, current, next, price, affordable, maxed, tiers, consumable?}`; seine rows in fathoms/meshes),
`stats` (`{seasonGross, sets, deliveries, bestSetLbs, bestSetValue, bestDelivery, lbsDelivered, fishDelivered,
crewPaid, fuelBurned, fuelBought, fuelSpend, upgradesSpend, fines, bonuses, tows, advanceMax, goals, daily}`),
`addCatch(counts)`, `deliver(tender|place)` → receipt | null, `refuel(source?)` → `{ok, gallons, cost, price,
reason?}`, `buy(id)` → boolean (reason in `lastBuyError`), `addCash(delta, reason)`, `useFuel(gallons, reason)`.
Extras: `permit` (S01K-xxxxx), `advance`, `holdFraction()`, `refuelQuote(source?)`, `canBuy(id)`, `acceptTow()`,
`tieUp(place|id)`, `dockedAt()`, `services()`, `spotterActive(x?, z?)`, `goals()`, `gearSummary()`.
Receipt (§7 plus extras): `{ticket 'K26-xxxxxx', date 'Jul 6, 2026', day, time, tender, tenderId, district, statArea
'259-42', permit, vessel, gear '01 Purse seine', condition 'RSW'|'Iced', lines: [{species, code, count, lbs, price,
value}], totalLbs, gross, crewShare, crew: [{role, share}×3], net, advanceRepaid, cashAfter}`.

### discovery (`ctx.systems.discovery`)
Required: `discovered` (Set of place ids and `stream:<id>`), `sightings` (Set of records `{type: 'wildlife', kind,
name, x, z, day, hours}` / `{type: 'fish', source: 'binoculars'|'perch'|'spotter', schoolId, species, heading, x, z,
t, day, hours}`), `isDiscovered(id)`, `discover(id)`, `progress()` → `{places: [n, total], streams, wildlife, intel,
memorials}`.
Extras: `intel` (array `{id, placeId|streamId, kind: 'hotspot'|'run', title, text, x, z, species, tide, day}`),
`addSighting({schoolId, species, heading, x?, z?, source?})`, `addPerch(placeId)`, `activePerches()`,
`addWildlife(e)`, `recentSightings(maxAgeHours = 3)` (fish marks with `age` 0..1 for fading), `wildlifeSeen()`,
`cards()` (logbook), `perches`.

### save.js
`import { hasSave, saveInfo, loadSave, saveNow, deleteSave, getSettings, setSettings, hasExplore } from
'../game/save.js'` — also available as `ctx.systems.season.save` (`readSave, saveExplore, restoreExplore,
applySettings`, …). `setSettings(patch)` → `{settings, reload}` (reload = quality changed; the UI reloads).
`saveInfo()` → `{savedAt, day, date, hours, cash, seasonGross, boatName, discovered}` for the title screen.

### travel.js (`ctx.systems.season.travel`, or `createTravel(ctx)`)
`targets({includeUndiscovered})` → `[{id: 'place:<id>'|'tender:<id>', kind, name, x, z, heading, services,
discovered}]` (discovered harbours with services/docks + every tender), `preview(target)` → `{ok, reason, name,
distance, nm, knots, hours, duration, gallons, fuelCost, arrive: {day, hours, label}, warnings, reachable, route:
[{x, z}]}`, `go(target)` (same shape; teleports, skips the clock, burns fuel, moors at a dock), `canTravel()`,
`resolveTarget(t)`. Also exported: `showFade(ctx, {title, subtitle, holdMs, fadeMs})` (uses `ui.fade` if it exists).

### Offers (key E)
| id | priority | when |
|---|---|---|
| sleep | 70 | moored, control boat, fishing idle, skiff stowed, 22:00–04:00 |
| deliver (cannery dock) | 68 | tied up at a place with `sell`, fish aboard |
| refuel (dock) | 67 | tied up at a place with `fuel`, tanks < 90% |
| tow | 66 | out of fuel, no tender alongside, not docked |
| harbor | 64 | tied up and `ui.openHarbor` exists → `ui.openHarbor(place)` |
| deliver (tender) | 60 | < 35 m of water between the hulls (centre distance − tender.radius), < 2 m/s, fishing idle, hold not empty, tender buying |
| tieUp | 60 | < 90 m from a harbour's dock point, < 3 m/s, not moored |
| refuel (tender) | 59 | alongside a tender, hold empty, tanks < 97% |
| waitOpener | 35 | moored, closed here, next period ≥ 1 h away |
| anchor | 30 | stopped (< 0.6 m/s), 3–70 m of water, closed period or after 21:00 |

### New events
`season:end {day, board}`, `economy:goal {label, gross, index}`, `economy:tow {tender, cost, gallons, hours}`,
`travel:arrived {id, name, kind, hours, gallons, nm}`, `game:saved {reason, explore}`, `discovery:sighting
<record>`, `discovery:wildlife {kind, name}`, `discovery:perch {placeId, day}`. `place:discovered` carries extra
`bonus` and `intel` (ids). Economy also emits the §7 `economy:cash`, `economy:delivered`, `economy:holdFull`,
`economy:purchase {id, level, price}`, `economy:fuel {fuel, empty}`.

## Deviations and decisions

- **Fast travel time.** SPEC: `hours = distance / (0.7 × maxSpeed) / 3600` — that treats sim seconds as game
  seconds, while the clock runs one game minute per real second, so a cross-island run would cost ~20 game minutes
  (cheaper than a short drive). Built instead: `hours = toNauticalMiles(route) / toKnots(0.7 × maxSpeed)` — the chart
  nautical miles over the cruising knots the HUD shows (~7.7 kn base), which reads correctly to the player and is
  realistic (Kodiak → Karluk ≈ 12 h). Fuel at 60% load for those hours, as specified. Distance follows water
  (Dijkstra on a 50 m grid with string pulling); unconnected waters use 1.35 × the straight line.
- **The DEM has no water connection between the Kodiak-city side and the Shelikof side** (Kupreanof Strait / Whale
  Passage close up at this resolution, and the world boundary cuts off the passages around Shuyak and the south end).
  Fast travel is therefore the only way to reach Uyak, Uganik, Karluk, Alitak from town by boat. See Requests.
- **District-aware openers.** Every period opens all districts except: the Mainland District (open only on days 5,
  13, 21, 29, 40) and the Alitak District on day 2 (early sockeye escapement). ADF&G announcements name the
  exceptions. Outside all district polygons the general schedule applies.
- **Wait for the opener priority 35** (not specified): below "Go ashore" (40) so a beach landing wins near shore on
  the closed days that are meant for exploring, above "Drop anchor" (30). It skips to 05:00 of the next period for
  this district and is only offered when that is ≥ 1 h away.
- **Drop anchor** offer added (not in SPEC): without it the only way to be "at anchor" for sleeping/waiting was going
  ashore.
- **Deliver range** measured as water between the hulls (centre distance − `tender.radius`, default 15) < 35 m; a
  centre-to-centre 35 m would sit inside most tender collision circles.
- **Berths.** Fast travel, tows and "Tie up" place the seiner bow-in to the dock point (heading against the offshore
  shore gradient, backed off 10 m so the bow clears the pier head; the chase camera then sits over the water). The
  data's `dock.heading` is used only where the shore gradient is flat. Tender standoff: rafted up 12 m abeam on the
  tender's starboard side (`nearestWater({minShore: 40})` applied), inside the delivery range.
- **Cannery docks** with `sell` also buy fish ("Sell your catch at <place>"). Deliveries work in Free Explore (so the
  hold can be emptied); goals never count there.
- **Home waters**: on a new season the places whose radius contains the spawn (City of Kodiak, St. Paul Harbor,
  Cannery Row, Near Island, Chiniak Bay, the Buskin) are logged silently instead of five toasts at once.
- **Autosave** also after purchases and waiting for an opener; event-driven saves run in `season.frame()` of the
  same frame (after every system reacted, so they also work while the fish ticket pauses the game). `game:toTitle`
  saves synchronously.
- `speciesMix` never includes kings (bycatch is `config.fish.species.king.bycatchChance`).
- `modifiers.deckLights` stays `true`; the LED upgrade sets `deckLightsLevel: 2`.
- `sightings` is a Set (as in the stub) of wildlife and fish records; fading chart marks come from
  `recentSightings()`.
- Weather: `sky.setWeather(preset, 90)` at scheduled boundaries during play, `(preset, 0)` on game start, load and
  after every `time:skip`. Nothing is set in title (the title cinematic owns its look).

## Tunables
`src/game/data/weather.js` (day-type weights, fog burn-off 08:30–11:00, blows: one in days 11–20, one in 31–44, 50%
a third in 23–28), `calendar.js` `PERIOD_CLOSURES`, `runs.js` (`BASE_ABUNDANCE`, stream/hatchery boosts, district
multipliers, 1.4 km influence), `market.js` (±10% market + ±5% buyer), `upgrades.js` (prices/effects/tiers, spotter
$1,200), `fleetBoard.js` (`COMPETENT_DAILY` $7,500, boat rates 1.2 … 0.62, luck, 5% breakdowns), `radio.js`
(12 s minimum gap; ambient every 55–110 s open, 90–170 s closed, 180–320 s at night), economy constants at the top of
`economy.js` (ranges, Highliner from the 6th period), `travel.js` (`TRAVEL_SPEED_FRACTION`, `TRAVEL_LOAD`,
`NO_ROUTE_FACTOR`), discovery constants (perch 3 km, fish marks 3 game hours / 48 max).

## Tests
`node --test tests/rules-*.test.mjs` — 98 tests: calendar/openers/districts, opener events incl. after skips, quiet
title, species mix by date/stream/district/enclosure, prices, closed waters, weather plan and forecast text, weather
application/pinning, fleet board, radio library and scheduler, "Nice set, cap", ADF&G eve announcement, sleep/wait/
anchor offers, hold/overflow, exact fish-ticket math and crew shares, receipts, deliver-offer conditions, fuel burn,
warnings, limp and tow, advance and repayment, refuel prices, catalog caps (457 m / 250 fm, 22 m / 325 meshes) and
modifiers, spotter, goals and Highliner, tie-up, discovery rules (onFoot, memorial, intel, streams, explore),
sightings/perches, progress/cards, save round-trip through a `ctx.game`-like snapshot/load, autosave triggers, Free
Explore log, settings, water routes and travel costs. `tests/rules-helpers.test.mjs` builds the Node-side world.

## Smoke scenarios
- `tests/scenarios/rules-loop.json` — new season → fill the hold → alongside the tender → E deliver → 22:24 E anchor →
  E sleep → E wait for the opener → opener → fast travel to Kodiak (arrives tied up). Checks state, saves and radio.
- `tests/scenarios/rules-weather.json` — the scheduled weather on opening evening, fog morning/burn-off, drizzle,
  blow, clear evening, overcast (with the forecast text).
- `tests/scenarios/rules-discovery.json` — Spruce Cape, Monashka Bay, the Buskin, Woody Island with the real places
  data: toasts, tokens, intel, cards.
Long scenarios were run on a static copy of the tree (`rsync` to /tmp) because concurrent edits make Vite full-reload
the page mid-run.

## Perf
CPU (`perf().systemsMs`, EMA): final strict basic run (all real systems except wildlife/player/audio/ui, machine
heavily shared) season 0.061 ms, economy 0.017 ms, discovery 0.037 ms; lighter runs 0.01–0.03 ms each. No GPU work —
the only visual is a DOM fade overlay; `--bench` with/without `skip=season,economy,discovery` showed only shared-GPU
noise (other agents' smoke runs were active). Draw calls/triangles unchanged by these systems. Fast-travel previews run
one Dijkstra over a 320² grid (~10 ms) per boat position (cached per 50 m), only when the chart asks.

## Best screenshots
`qa/rules/loop9/02-alongside-tender.png` (rafted to the Sea Venture at dawn), `qa/rules/loop9/05-morning-at-anchor.png`
(fog dawn after sleeping), `qa/rules/loop9/08-tied-up-kodiak.png` (fast travel → tied up at the city pier),
`qa/rules/loop5/04-sleep-fade.png`, `qa/rules/loop5/07-travel-fade.png`, `qa/rules/weather1/w5-blow.png`,
`qa/rules/weather1/w2-fog-morning.png`, `qa/rules/weather1/w4-drizzle.png`.

## Known issues
- Radio text, toasts, fish tickets and the fleet board only become visible once WP-UI renders `ui:radio` /
  `ui:toast` / `economy:delivered`; verified here through event transcripts.
- The fog preset (WP-SKY) is very dense; fog mornings now burn off by 08:30–11:00 to keep openers playable.
- `forecast()` wind directions are the schedule's nominal winds; `sky.weather.windDir` is chosen by WP-SKY and may
  differ.

## Requests to other work packages
- **WP-UI**: render radio/toasts/hints from events; title Continue via `hasSave()/saveInfo()/loadSave()` from
  `src/game/save.js`; settings via `getSettings()/setSettings()` (reload when `reload`); HUD opener status from
  `season.openerStatus(x, z)`; chart layers from `season.closedWaters`, `discovery.intel`,
  `discovery.recentSightings()`; logbook from `discovery.cards()/progress()/wildlifeSeen()` and `economy.goals()`;
  fleet board from `season.fleetBoard()`; forecast from `season.forecast()`; fast travel from
  `season.travel.targets()/preview()/go()` (close the map after `go()` returns ok; draw `preview().route`).
  Harbour menu: expose `ui.openHarbor(place)` (economy then offers "E — <harbour> — harbour services", priority 64) or
  open it on `boat:mooring {kind: 'dock'}`; use `economy.catalog / canBuy / buy / refuelQuote / refuel /
  gearSummary`, `season.canSleep / sleep / canWait / waitForOpener`. Optional `ui.fade({title, subtitle, holdMs,
  fadeMs})` replaces the built-in fade.
- **WP-BOATS**: already aligned (fleet seiners carry the board names; tenders have `radius`, `channel`,
  `collisionRadius`). If the names ever diverge, the board adopts the fleet's seiner names on game:ready.
- **WP-NET (fishing)**: emit `fishing:setComplete` with `rating` / `waterHaul` / `cited` / `totalLbs` / `value`
  (drives radio reactions and `stats`); use `economy.addCash(-fine, 'fine: closed waters')` for citations (ignored in
  Free Explore).
- **WP-FOOT**: call `discovery.addPerch(placeId)` on summits/viewpoints.
- **Orchestrator / WP-TERRAIN**: consider carving Kupreanof Strait / Whale Passage (or widening them) in the
  heightmap so the Shelikof side is reachable by boat from Kodiak.

## Core changes
None.
