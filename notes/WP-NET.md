# WP-NET — the seine (`net`) and the set (`fishing`)

## Summary

`src/entities/net.js` is the purse seine: a 150–200-node verlet corkline floating on `water.heightAt`, paid out
from `seiner.sternPoint` along the stern's path (payout = path length), drifting with 70% of `ctx.tide.currentAt`,
with its skiff end pinned to `skiff.endPoint` (or kept at the water's edge below a beach tie). After close-up both
ends are made fast on the side the net body lies on (bunt end just outside the rail, tow end under the block);
pursing gathers the leadline and rings toward a purse point beside the hull (the web becomes a bowl); hauling
shortens the corkline from the seiner end through the power block while an inflate term keeps the shrinking bag
round beside the boat. Bottom contact is measured per node from the heightmap seabed vs the hanging web depth; rock
under a leadline on the bottom snags at the SPEC rate.

`src/game/fishing.js` is the set state machine (SPEC §6.12): idle → setting → holding → closing → pursing →
hauling → brailing → report, with offers through `ctx.interact` (priority 100, boat only), seiner speed limits and
control locks under owner `'fishing'`, the crow's-nest camera suggestion, the purse-winch tension mini-game,
"Net's in the wheel!", snags, corks going under, the catch flow (harvest once, kings released, `addCatch` once,
overflow "Plugged!"), closed-waters warnings and trooper citations, abort (pause menu or hold Backspace 1 s),
`boat:teleport` hard stop, "Uncle Pete" hints on the first set, and serialize/restore/reset.

Rendering (all procedural): instanced spindle corks (sun-faded yellow, every 7th white, orange bunt corks at the
skiff end) bobbing with the swell and scaled up with distance so the corkline reads from the crow's nest;
camera-facing rope ribbons with a minimum pixel width (corkline, leadline, purse line through the rings, skiff and
bunt lines, beach tie line); a translucent dark tarred-green web curtain under the corkline (render band −100,
`kodiak_underwater`, diamond-mesh twine pattern that fades to its average coverage when sub-pixel, darker selvage,
alpha fading with depth, lit as a vertical wall); purse rings; the web sliding off the stern ramp while paying out;
while hauling, a tapered, bellied, swaying sheet of web rising from the working quarter into the power block with
the corkline and leadline riding its edges and corks climbing at the haul speed, then falling to the deck pile; the
rings hung up on the davit ("rings up"); foam stamps every 4th cork, at the ramp and the block, and a boiling bag
(foam level + ripples) as it dries up. The brailer (`src/game/fishing/brailer.js`) swings a dip-net bag on its whip
from the boom: dips into the bag with a splash, lifts full of salmon, swings over the hatch and spills them.

Verified end to end in the real game with WP-FISH's fish:
- Key-driven tutorial round haul (Playwright keyboard only: W/S lever, A/D rudder, Space let go / close up, E purse
  winch feathering) on the final code: 3,505 pinks, 12,618 lb, $3,659, "good"; lay-out 47.8 s, close-up 8.3 s,
  purse 20.1 s, haul 31.1 s, brail 8.3 s — every phase inside the SPEC targets (`qa/net/tut6`; earlier runs
  `qa/net/tut2`, `qa/net/tut5`).
- Hook set off a beach with real keys (E "Let 'er go — tie off to the beach" under way, J laid out and hooked back,
  Space "Hold the hook", Space close-up while running down to the skiff): 2,621 pinks, 9,436 lb, "good"
  (`qa/net/hook2`).
- Outcomes (`tests/scenarios/net-outcomes.json`, `qa/net/outcomes1`): clean set 3,129/4,000 (78%, target 60–85%);
  sloppy set with a 94 m gap held open 25 s 1,128/4,000 (28%, target 15–40%); school 150 m outside the circle →
  water haul.

## Files

- `src/entities/net.js` — system: public surface, foam stamps, frame snapshot for the view, game:ready wiring.
- `src/entities/net/sim.js` — DOM-free corkline chain (payout, one-sided distance constraints, drift, pins, inflate,
  haul, strided surface sampling, cached seabed/current sampling), `bottomContactOf`, `snagChancePerSecond`.
- `src/entities/net/model.js` — net state and commands (begin/holdEnd/close/purse/haul/brail/stow), attachment points
  from the seiner, close-up routing, pursing/snags, hauling, polygon/gap/containsPoint, gear refresh.
- `src/entities/net/geom.js` — polygon maths. `tuning.js` — every tunable (net and fishing).
- `src/entities/net/render.js`, `materials.js` — the view (corks, ropes, web, rings, bundles, fallback deck pile).
- `src/game/fishing.js` — system wrapper, brailer driving, teleport/title hard stops.
- `src/game/fishing/core.js` — the state machine (DOM-free). `winch.js` — purse winch mini-game. `report.js` — catch
  bookkeeping and the `fishing:setComplete` payload. `hints.js` — Uncle Pete. `brailer.js` — brailer visual.
  `debug.js` — smoke helpers (key-dispatching helmsman, camera framings, instant staging).
- Tests: `tests/net.test.mjs` (sim, geometry, bottom contact, snags, model flow, caching, close-up routing, winch),
  `tests/net-fishing.test.mjs` (state machine with stub neighbours: phases/timings, payload shape, plugged, water
  haul, citations, abort/Backspace/teleport, hook + beach tie, offers/limits/locks, hints, save, wheel, snag, far
  skiff close-up), `tests/net-harness.test.mjs` (Node game harness with the real interact arbiter).
- `tests/net-tutorial-scenario.test.mjs` — generator for `net-tutorial-keys.json`; the test keeps the committed JSON
  in sync (`WRITE_SCENARIO=1 node --test tests/net-tutorial-scenario.test.mjs` rewrites it).
- Scenarios: `net-tutorial-keys.json` (complete tutorial set with Playwright key input only),
  `net-hook-beach.json` (hook off a beach, keys + helmsman), `net-outcomes.json` (clean / sloppy / missed),
  `net-look.json` (staged phases, look-dev), `net-hero.json` (golden hour + dusk), `net-phases.json`
  (helmsman-driven set), `net-bench.json` (perf with the net shown/hidden).

## API as built

### `net` (superset of SPEC §6.11)

Required: `state` ('stowed'|'paying'|'out'|'closed'|'pursing'|'hauling'|'brailing'), `length`, `depth` (re-read from
`economy.modifiers.netLength/netDepth` only while stowed, clamped to `config.net.maxLength/maxDepth`), `payout` (m),
`pursed`, `hauled`, `bottomContact`, `corkline` (Vector3[], synced every update), `polygon()` (corkline + stern tail
while paying; the closing edge is the gap), `gap()` → `{a, b, width}` (null once closed), `containsPoint(x, z)`,
`begin(endAnchor)` (anchor: an object with `endPoint(out)`, an Object3D, a function `(out) → {x,z}` or a fixed
`{x, z}`; default the skiff; returns false if the anchor has no position), `close()`, `purse(rate)` (pursed/s requested
this frame; returns the effective rate), `haul(rate)` (hauled fraction/s requested this frame), `stow()`.

Extras: `holdEnd()` (stop paying: the seiner end becomes the last node → 'out'), `brail()` ('hauling' →
'brailing'), `rockFraction`, `snagged`, `snagCount`, `snagPoint`, `hole` (a snag's hole, cleared at brailing),
`corksUnder`, `closed`, `side` / `bodySide` (+1 starboard / −1 port: the working side = the net-body side),
`area`, `hookHealth` (area / best area while the net is out), `strain`, `pileFraction`, `purseRate`, `haulRate`,
`currentSpeed` (at the net), `shoreTie` ({x, z} of the beach end while tied), `bagCentroid(out)`, `drawsPile`,
`points`, `model`, `view`.

### `fishing` (superset of SPEC §6.12)

Required: `state`, `setNumber`, `lastSet` (the last `fishing:setComplete` payload), `canSet()` → `{ok, reason}`
(reasons: set under way, ashore, net/skiff out, tied up at a dock ("Cast off first"), anchored, aground, "Hold's
plugged — deliver first" (the hold can't take one 1,500 lb brailer load), "Too close to the <tender|harbour> to
set" (< 60 m of water to a tender's hull or < 90 m from a harbour's dock point), waters closed with the next opener,
too shallow), `abort()`, `hud`.

`hud` (rewritten every frame, same object): `phase`, `payout` 0..1, `distanceToSkiff` (m from the nearest of bow,
centre or stern to the skiff end; null when idle), `tension` 0..1+, `tensionBand` [0.42, 0.74], `pursed`, `hauled`,
`inHook` (±30% estimate of fish inside the net polygon, two significant figures, refreshed at 2 Hz; the closed-up
estimate while pursing/hauling), `holdSeconds`, `depthUnderStern`, `bottomWarning` ('Leads on bottom' |
'Leads on bottom — rocky!' | idle 'Rocky bottom — the lead will hang up' | null), `towHeading`, `message`.
Extras: `setNumber`, `hook`, `tied`, `closeReady`, `stall` ('wheel'|'snag'|'foul'|null), `stallSeconds`,
`idealTowHeading` (pull that keeps the stern off the net against the current), `brailLbs`, `brailFish`,
`brailProgress`, `acceptedLbs`, `abortProgress` (Backspace hold seconds), `closedWater`, `wheelDanger` 0..1,
`nearestFish` (idle: `{distance, bearing (deg), compass, close}` of the nearest school within 1.5 km, or null),
`fishClose` (idle: true/false, null when the fish system can't say), `payoutSpeed` (m/s over the stern, smoothed),
`payoutPace` ('slow' below 60% of the 7 m/s limit | 'steady' | null), `payoutEta` (s to all out at this pace),
`tideRunning` (hauling: current over the corks-under threshold), `valuedAt` (tender name pricing the catch).
`closeReady` is false while a round haul is held short of the skiff. `message` is null while brailing a catch (the
set panel's count-up carries it); "Water haul — nothing to brail" / trooper seizure otherwise.

Extras on the system: `stats` ({sets, waterHauls, fish, lbs, value, bestSetLbs, citations, snags, wraps, fouls,
aborted, kingsReleased}; saved), `core`, `debug` (see below), `brailer` (the visual; tests read `group.visible`).

Offers (all priority 100, only with `control === 'boat'`): idle Space "Let 'er go!" (label warns inside closed
waters — the first press only warns, a second within 6 s sets — or reads "Let 'er go! (no fish close)" when no
school is within 150 m + its radius); on a new season's first set (not free explore) with no school that close, the
Space offer is instead `fishing-find-fish` "Jumpers 410 m SE — get within 150 m to let go" (informational: Space
repeats it as the message and Pete's `findFish` tip; no idle E tie-off either); idle E "Let 'er go — tie off to the
beach" (see deviations); setting Space "Close up!" (≥ 45% out and within `config.net.closeDistance` of the skiff end)
or "Hold the hook" (≥ 60% out); setting E "Tie off to the beach" (skiff end within range, < 50% out); holding Space
"Close up!" (a round haul only within 45 m of the skiff end, kept out to 60 m once offered — see deviations; hooks
and tied sets any time); pursing E hold-prompt "Hold to run the purse winch"; hauling E hold-prompt `fishing-haul` "Hold to speed up
the block", relabelled "Speed up the block — tide's running, the corks will sink" while the current at the net is
over the corks-under threshold; brailing Space "Skip brailing".

### Events

Emitted: `fishing:state {state, prev}`, `fishing:skiffReleased {x, z}`, `fishing:closedUp {polygon, estimate}`,
`fishing:snag {x, z}`, `fishing:setComplete` (exactly SPEC §7 — `setNumber, caught, accepted, released (kings +
overflow), lbs {species: lbs}, totalLbs, value, minutes (game minutes), waterHaul, rating, cited` — plus extras
`forfeited` (catch seized with a citation), `fine`, `aborted`, `escaped` (fish counted from `fishing:escape`)),
`ui:toast`, `ui:radio` (trooper on channel 16), `ui:hint {id: 'pete-<key>', text, from: 'Uncle Pete'}` (the `from`
lets the UI show it as a radio tip), `fishing:brail {x, z, lbs}` (one per brailer scoop; the scoops sum to the
accepted pounds unless skipped; none on water hauls or seized catches). `fishing:setComplete` extras also include
`escapes: {leads, corks, gap, hole, overflow, spill}` (fish counts by cause: under the leadline, over sunk corks
while hauling, out through the open gap, through a snag's hole, let go with a plugged hold, and — additive — the
harvest's spill above the clean-set capture ceiling (WP-FISH `overCorks`), which no skipper action changes, so it is
kept out of `corks`; `escaped` = leads + corks + gap + hole + spill, overflow is also in `released`) and `valuedAt` / `valuedAtId` (the nearest buying tender whose
`season.priceFor(k, tenderId)` values the set — the same price a delivery there pays today; null = market price
estimate). Escapes use WP-FISH's flags (`viaGap`, `overCorks`, `released`, or a `cause` field if one is added) and
otherwise the net's state when the escape is flushed. Consumed: `boat:teleport`, `game:toTitle` (hard stop, no report),
`fishing:escape`, `game:ready`.

### Debug helpers (`__KODIAK__.systems.fishing.debug`)

`letGo({tie})`, `tieOff()`, `holdHook()`, `closeUp()`, `finishClose()`, `ringsUp()`, `brail()`, `finishBrail()`,
`trueInside()`, `auto.purse` / `auto.haul`, `pilot.circle/goto/heading/toward/purse/stop` (a helmsman that
dispatches real keydown/keyup events every frame), `cam(mode)` ('crow'|'chase'|'wide'|'bag'|'block'|'under'),
`stage({x, z, r, phase, frac, pursed, hauled, schoolAt, species, count})` (lays a round haul instantly along the
real stern path and advances to 'laid'|'holding'|'closing'|'pursing'|'hauling'|'brailing').

## Deviations and decisions

- **Tie off to the beach within 90 m, not 40 m, and only under way.** With the world's seabed formula (depth =
  min(real × 0.4, 0.4 + 0.1 × distance offshore)) water within 40 m of the beach is at most 4.4 m deep, below the
  SPEC's own 6 m minimum to let go, so a 40 m rule could never trigger. 90 m (≈ 9 m deep) keeps hook sets possible
  close in. The idle tie-off let-go (E) is offered only above 0.8 m/s so that stopped off a beach E remains "Go
  ashore" (WP-FOOT, priority 40) instead of being taken by fishing's priority 100.
- **Working side = net-body side.** At close-up both ends are made fast on the side the net lies on; if the skiff
  hands its end over on the far quarter, the end is routed around the transom (cubic path in the seiner's frame)
  instead of through the hull. The skiff then tows the seiner off toward the other side.
- **Closing a hook waits for the skiff.** Close-up completes when the skiff end is alongside (≥ 8.5 s); the 24 s
  timeout applies only once the end is within 30 m (hard cap 75 s), so a skiff running in from a beach tie never
  has its end jump across open water. The HUD message says "Closing up — run down to meet the skiff" meanwhile.
- **Purse winch.** In-band tension purses at the full rate whatever drum speed that takes (the heavy late bag needs
  less); below the band the rate falls with the tension ("too slow"); above it the rings foul after 0.9 s (3 s
  stall). Feathered well a purse takes ~16–20 s (15.5 s perfect, 22 s on a smooth bottom); holding E flat out takes
  ~40 s with repeated fouls.
- "Net's in the wheel" is also checked while hauling (the skiff keeps pulling the stern off the net then too).
- **Holding short of the skiff.** A round haul that reaches full payout more than 45 m from its skiff end is not
  offered a close-up (SPEC says `closeDistance`, 22 m; in holding the skiff runs its end in at ~5 m/s, so 45 m still
  closes in ~10 s, and once offered the close stays offered out to 60 m so it cannot flicker as the skiff tows); the
  1.5 m/s holding limit is lifted to 7 m/s ("Bring her around to the skiff — 340 m") so the player can run around
  to it, and closing a hook with the skiff end > 60 m away lifts the 3 m/s closing limit the same way (QA: 75–109 s
  closes). The untied skiff holds station 18 m up-current of where its end lay when holding began (it used to
  re-aim from its own position every 20 s and walk away).
- **First-set let-go.** A new season's tutorial set only lets go within 150 m of the school (QA: players let go
  600 m off and water-hauled); free explore and later sets only relabel the prompt.
- Kings are always released (config `release: true`); a cited set forfeits the catch (never reaches the hold) and
  fines $3,000 (65% chance per closed-water set, free explore never).
- `fishing:setComplete.minutes` is game minutes from let-go to report.

## Tunables (`src/entities/net/tuning.js`)

NET_TUNING: drift 0.7 of the surface current, relax 0.8/s, 10 constraint sweeps, leadline lag 1.1 s; purse base
1/15 per s, smooth-bottom slow-down 20%, leadline lift 60% of web depth when pursed; snag stall 5–10 s; haul: bag
dried up at 90% hauled, 32 s without E, E ×1.5, corks go under above 80% of max block speed in ≥ 0.18 m/s current,
3.5 s to take the empty bag aboard after brailing, 7 s haul-back on abort.

FISHING_TUNING: 6 m minimum depth under the stern; tie-off range 90 m, min speed 0.8 m/s; hold the hook at ≥ 60%
out; speed limits setting 7 / holding 1.5 / closing 3 / pursing 0.5 m/s; close 8.5 s min, 24 s near timeout
(within 30 m), 75 s hard cap, arrive at 7 m; wheel: stern within 2.4 m of the corkline for 3 s → 6 s stall; winch
band [0.42, 0.74], ramp up 0.95/s, down 1.6/s, load 0.62 → 1.12 over the purse, foul after 0.9 s over, 3 s stall;
A/D aim the pull at 0.7 rad/s; hook collapse warning below 40% of best area; estimate noise ±30%; citation 65%,
$3,000; report waits ≤ 16 s for the skiff; ratings: water haul < 25 fish, good ≥ 8,000 lb or $2,500, plugged on
overflow or ≥ 30,000 lb.

Phase timings (real seconds): the unit harness asserts lay-out 45–60, close 8–12, purse 15–25, haul 25–35, brail
≤ 15 (`net-fishing.test.mjs`); in the real game with keys (tut6): 47.8 / 8.3 / 20.1 / 31.1 / 8.3 s for 12,618 lb.
A set takes ~2 real minutes plus the run to the fish (116 game minutes let-go to report).

## Performance

Measured with `--bench`, 1280×720, on the shared Apple GPU while other agents' smoke runs were active (absolute
frame times are not meaningful; fps 23–42 overall). Idle (net stowed) the two systems cost 0.03 + 0.06 ms
(`qa/net/final`, `basic --strict`).
- CPU (`perf().systemsMs`): net 0.3–0.7 ms, fishing 0.03–0.08 ms; plus the view update in `pipeline.beforeRender`
  (`debugState().net.viewMs`) 0.25–0.35 ms. In-page micro-timings: `water.heightAt` 4.5 µs per call (the net samples
  each node every 8th frame, calibrated at boot from that cost, with velocity extrapolation in between), sim step
  ~0.26 ms, whole net update ~0.33 ms. The same code in Node (unloaded core): sim step 35–85 µs, view update
  55–60 µs, so on an idle M-series the net's total CPU is ~0.2–0.3 ms; on the contended machine the net update plus
  view read 0.6–1.0 ms. Optimisations: inlined one-sided constraint solver with a squared-length
  early-out (64 → 18 µs per step in Node), surface current sampled on every 4th node at 5 Hz, seabed depth/rock
  re-sampled only after a node moves 1 m.
- GPU: +5–6 draw calls (corks, rings, ropes, bundles, web; the fallback pile is off because the seiner model has its
  own pile), +20–60k triangles; the `gpuMs` delta with the net hidden vs shown was below the noise floor (hidden
  read *higher* in both pairs: 63 vs 48–55 ms laid, 89 vs 72 ms hauling).

## Known issues

- `debug.stage` walks the seiner around a full circle instantly, so staged "laid" frames put the seiner right on top
  of its own skiff; key-driven sets close up normally.
- The web curtain is a 6-row strip per corkline node; in current it bellies only by the leadline lag (no per-row
  physics), and the pursed bowl is shaped procedurally from `pursed`.
- The key-driven tutorial scenario steers by polling a heading error from Playwright; it is robust to slow frames
  (condition waits with long timeouts) but depends on the new-season tutorial school spawning where WP-FISH puts it
  (500–700 m from the spawn).
- WP-UI shows the set report as a pausing panel: the report phase (skiff home, net aboard) resumes when it is
  dismissed. The tutorial scenario photographs it and dismisses it with Escape.

## Best screenshots

- `qa/net/hero3/h4-pursing-wide-golden.png` — pursing in the sunset glitter, Kodiak behind, skiff towing off.
- `qa/net/hero3/h2-circle-aerial-golden.png` — the round haul from the air at golden hour.
- `qa/net/hero3/h3-corkline-low-golden.png` — corks marching through the sun path.
- `qa/net/hero3/h8-brailing-bag-golden.png` — the bag boiling with salmon, brailer on the whip, web up the block.
- `qa/net/hero3/h10-dusk-deck-lights.png` — hauling at dusk under the deck lights.
- `qa/net/hook2/05-hook-wide.png` and `qa/net/hook2/06-hook-beach-tie.png` — a hook set off a beach; the skiff nosed
  onto the beach with its tie line.
- `qa/net/tut6/07-pursing-crowsnest.png` — crow's nest while pursing: leadline drawn in under the corks, both ends
  made fast on the port quarter, skiff towing off to starboard.
- `qa/net/tut8-ui/08-pursing-chase.png`, `12-brailing-chase.png`, `13-set-report.png` — the key-driven tutorial set
  with WP-UI's widgets fed by `fishing.hud` and the set report from `fishing:setComplete`.

## Requests to other work packages

- **WP-UI (QA fixes)**: render the `fishing-find-fish` Space prompt dimmed (it only informs); show the main cause from
  `fishing:setComplete.escapes` instead of always "under the leads" and label the value with `valuedAt` ("at the
  Sea Venture's price", or "≈ market price" when null); optional set-panel cues from `hud.payoutPace`/`payoutEta`
  and `hud.tideRunning`. The brailing caption is now null (no duplicate of the count-up).
- **WP-AUDIO**: `fishing:brail {x, z, lbs}` fires once per brailer scoop (the splash as the brailer dips).
- **WP-FISH**: optional `cause: 'leads'|'corks'|'gap'|'hole'` on `fishing:escape` would replace the net-state
  attribution in fishing.

- **WP-UI**: the hud message is shown both as the caption above the set panel and inside it during brailing
  ("Brailing — N lbs aboard"); consider dropping the caption when the panel already shows the count-up. Available
  hud extras not yet shown: `stall` / `stallSeconds` (wheel, snag, fouled rings), `wheelDanger`, `idealTowHeading`,
  `abortProgress`, `closedWater`.
- **WP-BOATS**: `skiff.closeTo(seiner)` brings the end to the quarter on the skiff's own side; the net routes it
  around the transom when that is the far side. Approaching on the net side (from `net.bagCentroid()` relative to
  the seiner) would make the handover look more natural still.
- **WP-FISH**: none — `net.hole`, `net.corksUnder`, `net.pursed`, `net.bottomContact`, `polygon()`/`gap()` are read as
  documented and the capture rates land in the SPEC targets.

## Core changes

None.

## Post-QA changes

See [FIX-net.md](FIX-net.md) (2026-09-28 QA fix wave); it supersedes anything here that it contradicts.
