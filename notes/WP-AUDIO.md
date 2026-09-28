# WP-AUDIO — procedural sound for Kodiak Seiner

Status: complete. `src/audio/audio.js` is the system entry (`create(ctx)`); everything is synthesised in WebAudio at
runtime (no samples, no files, no network). The loader reports `audio: ok` with no missing members; the strict
`basic` smoke passes with no audio errors or warnings.

## Summary

The sound of the game is built from four layers, all positioned around the listener (the camera, see "Listener"):

- **Ambience beds** (ambience bus): the sea as three layers — a deep swell rumble, a surf/wash layer that gets louder
  and brighter toward the beach (from `heightmap.shoreDistance` at the listener) and a close "lapping" layer of
  sloshes (Poisson onsets) that carries the water on small speakers; all breathe with a slow multi-sine swell and fade
  with height (on foot on a ridge) and inland. Breaking waves on the nearest beach are positional one-shots
  (rising curl → crash → foam hiss → pebble backwash; gravel from `heightmap.seabedAt` at the waterline), panned
  toward the shore. Wind follows `sky.weather.windSpeed` with its own gust walker plus a low buffet, a narrow-band
  rigging whistle aboard in strong wind, and leaf/needle rustle on foot under spruce and alder
  (`terrain.forestDensity/surfaceAt`). Rain patter + hiss by `weather.rain`, drumming on the wheelhouse roof in the
  bridge camera. Towns, harbours and canneries (from the places data) add a low hum, cannery refrigeration drone,
  halyards clinking on masts and extra gulls. A salmon stream babbles when you are near its mouth.
- **The boat and gear** (world bus): the main diesel is a six-cylinder PeriodicWave (one whole four-stroke cycle per
  period, built from a jittered pulse train so it lopes) plus a second bank drifting randomly in and out of step, a
  fixed stack resonance (so no rpm-tracking whine), injector clatter and
  exhaust noise amplitude-modulated by the firing pulses, turbo whistle and intake hiss; rpm/load from
  `seiner.throttle`/`engineLoad` through a flywheel model (`engineStep`: cranking → catch → running → run-down). It
  stops when anchored or tied up (a generator hum takes over) and restarts with the starter when you throttle away.
  Hydraulic demand (purse winch, power block) holds the rpm up. The skiff has its own lighter diesel (effort from
  `skiff.effort`, starter on release, shuts down after ~10 s parked at a beach). Hull wash by speed, bow slaps at the
  bottom of each pitch (from `seiner.pitch`), soft lapping and rigging knocks on roll reversals at rest. Fishing: the
  seine rushing off the stern with corks rattling over the roller while setting; purse-winch clutch clunk, winch whine
  and ring knocks while pursing; "rings up" clatter; power-block whine and corks through the block while hauling;
  the bag boiling with thrashing salmon; brailer dips and fish thumping into the hold on the brailer's 2.8 s cycle;
  snag groan. Anchor chain running out / hauled in on `boat:mooring`, fender bump when docking, air horn on
  `boat:horn` (with a fjord echo), grounding scrape/thump on `boat:collision`. Up to two nearby fleet boats get
  their own diesels (tenders/ferry/cutter pitched lower).
- **Nature** (world bus): fish-jump splashes per species/style/size from `fish:jump` (pink popcorn "plip", sockeye
  clean plunk, chum flat "whack", coho tail-walking patter, king swirl, thrashing in the bag), with sound travel delay
  past 60 m; a school boil on `fish:spooked`; glaucous-winged gulls (FM saw through beak/throat formants; long calls,
  kek-kek when working, mews) placed on real gulls from `wildlife.birds` (followers, working flocks, the bag swarm)
  and in harbours; bald-eagle chitter from nearby eagles; humpback/orca blows and breaches from
  `wildlife:blow/breach`; Steller sea-lion roars and barks at haulouts (`wildlife.sites.haulouts`); bear huffs, jaw
  pops and the bluff charge from `bear:encounter`, pouncing splashes near fishing bears; footsteps by surface
  (gravel crunch, sand shuffle, grass swish, forest-floor snap, rock click, snow creak, wading slosh) from
  `player:step`; thunder rolling in after `sky:lightning` (3 s/km); a lighthouse diaphone in thick fog.
- **Feedback and music** (ui and music buses): VHF radio squelch-open, static bed, a band-limited muffled "voice"
  for as long as the caption types (42 cps), and the squelch tail, on every `ui:radio` and on radio-style `ui:hint`s
  (Uncle Pete) that the UI will actually show; queued radio calls follow each other; music ducks −10 dB and the world
  −4 dB under radio. Soft UI clicks (title menu, every button via a delegated listener, deduped), panel ticks, toast
  and sighting blips, a cash register on `economy:delivered`, a warm chord + rising arpeggio on `place:discovered`
  (open voicing for peaks/lakes/viewpoints, reflective minor colour for history, none at all for memorial places), a
  set-complete stinger by rating (water haul → fair → good → plugged with bell shimmer; a flat "cited" variant).
  Generative maritime/folk music (drone, slow pads, a sparse plucked motif, a tin-whistle line) plays at the title
  (D dorian, endless), once at first light each day (G mixolydian, ~80 s, never while fishing) and briefly after a
  plugged or ≥ 20,000 lb set and on season goals (D major, ~35 s).

Pause and chart modes low-pass and lower the world (music and UI stay clear); the title lowers the world under the
title music. The master chain is sub-cut → glue compressor → make-up → brickwall limiter (−4 dB) → soft clipper
(ceiling 0.985) → meter → master volume. Levels measured live (master, pre-volume, `qa/audio/final-live-set` and
`final-live-tour`): title −21 dBFS RMS; under way/setting/pursing/hauling/brailing −16.7…−18.8; dawn/anchor/rain in the
wheelhouse/storm −17…−20; on foot inland −28; peaks −3…−7 dBFS, limiter ≤ 1.4 dB on the busiest moment (pursing), never
clipped. Bus balance at the title: music −34 dB RMS over a world at −31 and ambience −37 (pre-master).

## Files

| file | what |
|---|---|
| `src/audio/audio.js` | system entry: lazy AudioContext on first gesture, API, event forwarding, debugState |
| `src/audio/mixer.js` | buses, low shelf, pause muffle, radio duck, reverb (3 s dark impulse), dynamics, meter |
| `src/audio/engine.js` | one-shot player: PannerNode (equalpower, inverse), air absorption, travel delay, voice table, caps |
| `src/audio/beds.js` | continuous layers; lazy build/teardown for rarely-audible ones; diesel chain factory |
| `src/audio/director.js` | per-frame world reading, listener, bed parameters, scheduled world one-shots, music cue |
| `src/audio/cues.js` | event → sound handlers (`EVENTS`), radio queue, delegated UI clicks |
| `src/audio/sfx.js` | one-shot recipes + `SOUNDS` table (bus, priority, distance model, range) |
| `src/audio/instruments.js`, `composer.js`, `music.js` | pad/pluck/whistle/drone/bell voices; generative composer; lookahead player |
| `src/audio/params.js`, `scene.js` | pure mappings (unit-tested); `TUNING` holds every mix level |
| `src/audio/kit.js`, `dsp.js`, `voices.js` | shared noise/texture buffers + periodic waves (built once per sample rate, warmed in idle time), DSP helpers, voice limiter |
| `src/audio/qa.js` | debug-only: offline renders, spectrogram sheets, live spectrogram with markers, bus meters, piano roll |
| `tests/audio.test.mjs` | pure logic (21 tests; the file also re-runs the 5 contract tests it imports `fakeCtx` from) |
| `tests/audio-graph.test.mjs` | strict mock AudioContext: every recipe, mixer, player, beds, music, a whole voyage through the director, the system under a mock browser (7 tests) |
| `tests/scenarios/audio-*.json` | `sheets`, `music`, `live-set`, `live-tour`, `events`, `quick`, `bench`, `cpu` |

## API as built

Required: `unlock()`, `play(name, {position, volume, rate, params, delay})` → voice id | null,
`setVolumes({master, music, sfx, ambience})` (partial patches merge; 0..1; squared curve), `muted` (get/set).

Extras: `ready`, `volumes`, `sounds` (names), `context`, `qa`, `frame`, `debugState`, `serialize` (undefined — the UI
persists volumes in `kodiak-seiner:settings`, which audio also reads at create), `restore`, `reset`, `dispose`.

`play` names: `fish-jump, splash, surf-break, hull-slap, gull, eagle, whale-blow, breach, bear-huff, bear-charge,
sealion, boil, clunk, footstep, horn, anchor-chain, collision, skiff-release, starter, cork, rings-up, snag,
brail-dip, brail-dump, thunder, foghorn, clink, ui-click, ui-open, ui-close, ui-toast, ui-blip, radio, cash-register,
discovery, stinger`. With `position` the sound is positional (world metres); without it, it is played flat on its bus.

Events consumed: `fish:jump, fish:spooked, skiff:splash, fishing:skiffReleased, fishing:closedUp, fishing:snag,
fishing:setComplete, economy:delivered, economy:goal, economy:purchase, place:discovered, camera:sighting, ui:radio,
ui:hint, ui:toast, game:mode, game:toTitle, boat:teleport, boat:horn, boat:mooring, boat:collision, player:step,
bear:encounter, wildlife:blow, wildlife:breach, sky:lightning`. Audio subscribes at create (before the UI) so it can
tell whether a hint is new. No events are emitted.

State read (all optional-chained): `seiner` (position, throttle, engineLoad, speed, pitch, roll, mooring, heading,
bowPoint, sternPoint, powerBlockPoint), `skiff` (state, effort, speed, position), `fishing` (state, hud.tension,
hud.stall), `net` (hauled, state, bagCentroid), `wildlife` (birds, bears, sites.haulouts), `fleet.boats`,
`sky` (weather, daylight), `water.seaStateAt`, `terrain` (heightAt, surfaceAt, forestDensity), `cameraRig.mode`,
`economy.fuelEmpty`, `ui.serialize().hintsShown`, `places` (else `resolve(geo)` from the data file), `ctx.heightmap`.

### Deviations / decisions

- **Listener.** Positional audio is relative to the camera's orientation, but in gameplay cameras the listener's
  position is pulled toward the crew: at most 16 m from the seiner in chase, on the mast (~9 m up) in the crow's nest,
  8 m in the bridge and 7 m on foot. Without this the recommended fishing camera (crow's nest, high overhead) was
  15–20 dB quieter than chase and the boat sounded far away. Title, photo (`free`) and debug camera overrides use the
  true camera position.
- **Autoplay.** The AudioContext is created in `unlock()` on the first activation-triggering gesture (Esc is not one;
  audio waits for the next key/click) to avoid Chrome's autoplay warning. Noise/texture buffers are pre-built in idle
  callbacks on the title screen, so the first key press starts audio without a hitch. Under automation
  (`navigator.webdriver`, i.e. every smoke run) the context starts at boot so the whole graph runs and is measured,
  but the final output gain is 0 so headless runs never play through the machine's speakers; `?audible` overrides,
  `?mute` starts muted.
- The UI's `setVolumes` calls that happen before audio exists are covered by reading the saved settings at create.

## Tunables

`TUNING` in `src/audio/params.js` (single place for a listening pass): bus levels (`ambience 1.3, sfx 1.0, music 0.5,
ui 0.8`), `trim 1.6` (make-up into the limiter), ocean (`deep, surf, wash, lap`), wind (`gain, whistle`), rain,
harbor (`hum, clinkRate`), engines (`main 0.38, skiff 0.4, fleet 0.4, genset 0.07`), `hydraulics`, `hullWash`,
`maxVoices 28`, radio (`squelch, bed, voice` — set `voice: 0` to drop the muffled VHF voice and keep only
squelch/static). Engine models in `DIESELS` (idle/max rpm, spool times, turbo). Per-sound level/range/distance model
in `SOUNDS` (`sfx.js`), concurrency caps in `engine.js`, listener reach in `director.js` (`EAR_REACH`), music moods
in `composer.js` (`MOODS`: key, mode, bar length, bars, densities, progressions, fades).

## Sound design notes for a human listening pass

Things to listen for (headphones and laptop speakers):
1. Title: soft drone + pads + plucked motif in D dorian with an occasional tin-whistle phrase; ocean, harbour clinks
   and gulls under it; nothing harsh. New season at 05:30: the title music crossfades into the dawn piece.
2. Chase camera under way: the diesel should feel big and warm, not buzzy; the turbo whistle only faintly at full
   load; bow slaps when the sea is up; wind whistle in the rigging in a gale; gulls around the boat not too chatty.
3. Crow's nest while setting: seine and corks rushing off the stern, skiff engine revving on the far end of the net;
   pursing (winch whine, ring knocks), "rings up", power block with corks, the bag boiling, brailer scoops and fish
   thumps; stinger at the end. Check the power-block whine pitch (tracks engine rpm) is not piercing.
4. Anchor: chain rattling out, engine running down, generator hum, soft lapping and the odd rigging knock; weigh
   anchor: chain clanking in, starter, catch.
5. Weather: rain on deck vs drumming on the wheelhouse roof (C to the bridge camera), storm wind/gusts, thunder after
   the flash, a diaphone in thick fog near a lighthouse.
6. On foot: footsteps per surface (gravel crunch is the most common), surf on the beach, stream babble at a mouth,
   leaves rustling under spruce; bears huffing when close.
7. Radio: squelch + static + muffled voice for the caption; music ducks and returns smoothly.
Likely tuning candidates: `TUNING.engine.main`, `TUNING.ocean.lap`, gull rate (`gullInterval`), radio voice level,
`TUNING.bus.music`.

## QA evidence (screenshots)

Offline spectrogram sheets (log frequency 30 Hz–16 kHz, peak envelope strip, peak/RMS per sound):
- `qa/audio/final-sheets/sheet1.png` — sea, weather and salmon jumps
- `qa/audio/final-sheets/sheet2.png` — wildlife and footsteps
- `qa/audio/final-sheets/sheet3.png` — the boat (diesel idle/half/full/wheelhouse, skiff, winch, block, horn, chain…)
- `qa/audio/final-sheets/sheet4.png` — gear and feedback (radio, register, discovery, stingers…)
- `qa/audio/final-sheets/sheet5.png` — music and atmosphere
- `qa/audio/music/piano-roll.png` — composer output for title/dawn/triumph
Live mixes (master spectrogram, RMS/peak strip, a marker per one-shot):
- `qa/audio/final-live-set/live-set.png` — title → under way → horn → radio → a full set to the stinger
- `qa/audio/final-live-tour/live-tour.png` — title, dawn, anchor, rain, wheelhouse, storm, haulout, ashore
- `qa/audio/final-events/live-events.png` — each event sound fired in turn, then pause/resume muffle
- `qa/audio/final/` — the strict `basic` run (game screenshots; audio `ok`)

## Perf

CPU (`perf().systemsMs.audio`, EMA): 0.06 ms per frame when the machine was quiet (strict `skip=terrain` run), 0.14–0.23
ms under the heavy shared load of this session (load average 30–300); a tight in-page loop of `audio.frame()` measures
0.045 ms/frame (bed parameters at 30 Hz, scene scans at 3 Hz, the listener every frame). GPU: none (no draw calls, no
render hooks). Bench `audio-bench.json` with vs without `skip=audio`: frame-time differences were dominated by GPU
contention noise (skip=audio runs ranged 12–22 ms, audio-on 19–21 ms in alternating runs); audio adds no GPU work.
Audio thread: ~10 always-on sources (sea ×3, wind ×2, diesel ×5) + convolver + two compressors; everything else is
built only while audible and torn down after 2–3 quiet seconds; one-shots are capped at 28 voices with priority
stealing and per-sound caps (peak 17 live voices during a full set; none refused or stolen). Shared buffers ≈ 1.5 M
samples, built once per sample rate (~45 ms total, spread over idle callbacks on the title screen).

## Known issues

- Sound was verified by spectrogram/levels, a strict mock-WebAudio test suite and live captures, not by ear; the
  listening checklist above is the outstanding pass. The VHF "voice" is abstract mumble by design.
- Headless live captures sometimes show short gaps in the meter strip when the shared machine is overloaded (audio
  thread starved); not reproducible in offline renders or at normal load.
- During this session some strict runs failed on a WebGL warning (`glDrawElementsInstanced: Mismatch between texture
  format and sampler type`) that persists with `skip=audio` and disappears with `skip=terrain` — WP-TERRAIN's, not
  audio's (audio makes no GL calls). The final full strict `basic` run passed.
- Doppler is not modelled (fleet boats and whales are far/slow enough). The generative music has three moods; there is
  no night or storm piece by design ("never intrusive").

## Requests to other work packages

- None blocking. Nice to have: WP-NET could emit `fishing:brail {x, z, lbs}` per brailer scoop (audio currently
  mirrors the brailer's 2.8 s cycle); WP-WILDLIFE could emit `wildlife:call {kind, x, z}` for staged birds/animals
  (audio picks gulls/eagles from `birds` itself).

## Core changes

None.
