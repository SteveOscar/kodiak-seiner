# Kodiak Seiner — design and interface contract

A 3D browser game about Alaskan salmon purse seining around a real-geography Kodiak Island. You skipper a 58-foot
limit seiner: find schools of salmon by their jumpers, let the skiff go, lay the seine around the school, close up,
purse, haul with the power block, brail the catch into the hold and deliver it to a tender. Between sets, explore the
island's bays, villages, capes, streams and mountains by boat and on foot.

This document is the contract between work packages (WPs). Code, tests and the running game are authoritative for
behaviour; this file is authoritative for **interfaces, ownership and intent**. If you must deviate from an interface,
keep the documented surface working (add, don't break) and record the deviation in your notes file.

---

## 1. Pillars

1. **Beautiful.** Every screenshot should look like a postcard from Kodiak: emerald mountains dropping into dark
   fjords, low cloud on the peaks, golden-hour light, a sea that moves and glitters. Beauty beats feature count.
2. **Authentic.** Real geography (AWS Terrain Tiles DEM of the Kodiak archipelago), real species, real gear, real
   seining sequence and vocabulary (skiff, corkline, leadline, purse rings, power block, brailer, tender, fish ticket,
   opener, closed waters, jumpers, humpies, "plugged", "water haul"). No gore, no cartoon physics in the fishing.
3. **Fun first.** The set is a readable, tense, rewarding mini-drama (spot → circle → close → purse → haul → brail).
   Exploration rewards curiosity with discoveries, wildlife, vistas and lore.
4. **Runs well.** 60 fps at 1280×720 on an Apple M-series GPU with everything on; graceful quality tiers.

---

## 2. Project layout and rules

```
index.html                 entry (Vite)
src/main.js                boot, frame loop, debug API                              [core]
src/core/*                 config, events, input, clock, geo, rng, uniforms, interact [core]
src/systems/registry.js    system list (creation + update order)                   [core]
src/systems/stubs.js       stand-in for every system (reference API shapes)        [core]
src/world/heightmap.js     DEM loading + terrain queries                           [core]
src/render/renderer.js     WebGLRenderer, scene, camera, render pipeline hooks      [core]
public/terrain/*           kodiak_height.png (+ meta) from tools/fetch-dem.mjs       [core]
tools/smoke.mjs            headless GPU play-test harness                           [core]
tests/**/*.test.mjs        node:test unit tests (npm test)
tests/scenarios/*.json     smoke scenarios (committed)
notes/WP-<NAME>.md         each WP's notes: what was built, deviations, known issues, perf, screenshots
qa/                        screenshots and reports (gitignored)
```

Commands: `npm run dev` (Vite dev server), `npm test` (unit tests), `node tools/smoke.mjs --scenario=<name|file>
--out=qa/<dir> [--params="autostart&time=19"]` (headless GPU run: screenshots, console errors, state, perf),
`npm run build` (production build to dist/).

**Ownership.** Each WP edits only the files it owns (§11). Files you own may be split into sub-modules under your
folder (e.g. `src/world/water/*.js`). **Core files** (`[core]` above) belong to the orchestrator: do not edit them
unless a core bug blocks you; then make the minimal fix and record it under "Core changes" in your notes. Never
modify another WP's files; if you need something from another WP, code defensively against the documented API
(optional chaining, feature checks) and write the request in your notes under "Requests".

**Robustness.** Every cross-system call must tolerate the stub (see `src/systems/stubs.js`) or a missing system:
`ctx.systems.fish?.schoolsWithin?.(x, z, r) ?? []`. A system must never throw from update(); the loader and loop
isolate failures but a throwing system is a failed WP.

**Code style.** Plain modern JavaScript ES modules, no TypeScript, no frameworks, no new runtime dependencies beyond
`three` (use `three/addons/...` for official add-ons). All art is procedural or generated at runtime (geometry,
canvas textures, shaders) — no external asset downloads, no copyrighted assets, no CDN fonts. Comments explain
non-obvious intent and constraints only. Keep modules focused; split big systems into sub-files.

**Randomness.** Use `ctx.rng` (seeded) or `ctx.rng.fork(salt)` for anything that shapes the world or gameplay so a
seed reproduces it. `Math.random()` only for per-frame cosmetic jitter.

---

## 3. World and coordinates

- Units are metres, seconds, radians. **+x = east, −z = north, +y = up.** Sea level (still water) is y = 0.
- The world is a 16 km square: x, z ∈ [−8000, 8000]. It maps a ~188 km square of the real Kodiak archipelago
  (lat 56.80–58.50, lon −154.98 to −151.82) at ~1:11.75 horizontally. Land heights are real metres × `vertScale`
  (0.2); peaks reach ~250 m (Kodiak) and ~440 m (Alaska Peninsula volcanoes across Shelikof Strait, NW corner).
  Seabed depth is min(real depth × 0.4, 0.4 + 0.1 × distance offshore): a guaranteed shallow shelf along every
  beach, deep water mid-bay (Shelikof Strait ~80–90 m).
- Boats, people, animals and fish are **real size** (the seiner is 17.7 m). Only the landscape is compressed. Bays
  are hundreds of metres wide, the island ~13 km long.
- **Heading** (boats, wind, animals): radians, 0 = facing north (−z), increasing clockwise (π/2 = east).
  Forward vector = (sin h, 0, −cos h). An object3d with heading h has `rotation.y = −h` when its model faces −z.
- `ctx.geo.toWorld(lat, lon)` → {x, z}; `ctx.geo.toLatLon(x, z)`; `toKnots(ms)` for HUD speed (display fiction:
  12 m/s reads as ~11 kn); `toNauticalMiles(m)`.
- **Heightmap** (`ctx.heightmap`, see `src/world/heightmap.js`): `heightAt`, `realAt`, `shoreDistance` (signed,
  positive offshore, ±~990 m), `shoreGradient` (offshore unit vector), `normalAt`, `isWater`, `depthAt`,
  `raymarch`, `nearestWater(x, z, {minShore})`. GPU: `ctx.uniforms.uHeightMap` is an RG float texture (R = game
  height, G = signed shore distance, both metres), row 0 = north, uv = ((x + 8000) / 16000, (z + 8000) / 16000).
- **Placing things:** on land use `ctx.systems.terrain.heightAt(x, z)` (render-accurate; includes any detail
  displacement the terrain adds). On water use `ctx.systems.water.heightAt(x, z)` (includes waves).
- Soft world boundary at |x| or |z| > 7600: boats/players are gently pushed back with a UI message.

---

## 4. Core services (`ctx`)

| field | what |
|---|---|
| `THREE` | the three.js namespace |
| `renderer`, `scene`, `camera` | WebGLRenderer (reversed-Z depth, sRGB output, ACES tone mapping, PCF soft shadows), Scene, PerspectiveCamera (fov 55, near 0.5, far 40 km) |
| `pipeline` | `render(dt)` (replace to own the frame, e.g. postfx), `beforeRender(fn)`, `afterRender(fn)`, `onResize(fn)` |
| `config` | `src/core/config.js` tunables (world, time, spawn, boat, net, fish species/prices, economy, render) |
| `quality` | active preset from `QUALITY` (ultra/high/medium/low): pixelRatio, shadows, shadowMapSize, waterSegments, vegetation, postfx |
| `events` | bus: `on(name, fn) → off`, `once`, `off`, `emit(name, payload)` — catalogue in §7 |
| `input` | `action(name)`, `pressed(name)`, `released(name)`, `axis('steer'|'throttle'|'lookX'|'lookY')`, `mouse {dx, dy, wheel, buttons, clicked}`, raw `keyDown/keyPressed(code)`, `gameplayBlocked`. Actions: throttleUp/Down (W/S, ↑/↓), left/right (A/D, ←/→), action (Space), interact (E/Enter), camera (C), map (M), logbook (L/J), pause (Esc/P), photo (H), sprint (Shift), horn (G), lights (N), help (F1 or /) |
| `interact` | `offer({id, label, key, priority, onPress, hold})` each frame; `current[key]` → prompt for the HUD. See `src/core/interact.js` |
| `clock` | `hours` [0,24), `day` (0 = Jun 20), `scale` (game minutes per real second, default 1), `frozen`, `advance(hours)`, `set(h, day)`, `date()`, `dayOfYear()`, `timeLabel()`, `isOpener()` |
| `uniforms` | shared shader uniforms (write-owner in `src/core/uniforms.js`): uTime, uCameraPos, uSunDir, uSunColor, uSkyColor, uHorizonColor, uFogColor, uFogDensity, uDaylight, uWindDir, uWindSpeed, uRain, uCloudCover, uHeightMap, uWorldHalf, uTerrainShadow, uWaveState |
| `heightmap` | §3 |
| `rng` | seeded RNG: `next, range, int, pick, chance, gauss, fork(salt)` |
| `systems` | every system by name (§6) |
| `state` | `{ mode: 'loading'|'title'|'play'|'paused'|'map'|'cutscene', control: 'boat'|'foot', freeExplore }` |
| `game` | `start({newGame, freeExplore})`, `setMode(mode)`, `pause()`, `resume()` |
| `time` | `{ elapsed (sim seconds), dt, realDt, frame }` |
| `flags` | URL flags: `debug`, `autostart`, `skip` (Set of system names forced to stub), `only` (Set; all others stubbed), `seed`, `time`, `weather`, `at` ("x,z,headingDeg"), `quality` |
| `debug` | `{ cameraOverride }` (set via `__KODIAK__.camera(pos, look)`; applied after lateUpdate) |

**Modes.** `title`: the living world runs (waves, fish, birds), the clock is frozen, the UI shows the title menu and
the camera rig plays a cinematic. `play`: normal. `paused`/`map`: simulation dt = 0 (update/lateUpdate still called
with dt 0; `frame(realDt)` keeps running for UI/camera). `input.gameplayBlocked` is true outside `play`.

---

## 5. System contract

Each module in `src/systems/registry.js` exports:

```js
export async function create(ctx) {
  // build meshes, subscribe to events, return the system object
  return {
    update(dt) {},        // optional, called every frame in registry order; dt = 0 while paused
    lateUpdate(dt) {},    // optional, after every update (cameras, UI prompts, things that follow others)
    frame(realDt) {},     // optional, every frame with real time even when paused (UI animation)
    debugState() {},      // optional, small JSON-safe summary merged into __KODIAK__.state()
    ...publicApi,
  };
}
```

Order: season, sky, water, terrain, places, fleet, seiner, skiff, net, fish, fishing, wildlife, player, economy,
discovery, cameraRig, audio, ui, postfx. A system may reference later systems at runtime (inside update), never
during create except via optional chaining. Interaction offers resolve after lateUpdate and before frame.

The loader substitutes the stub if the module is a placeholder, throws, or is forced off by `?skip=`/`?only=`.
`__KODIAK__.systemStatus` reports `ok | placeholder | stub (flag) | failed: …`.

---

## 6. System APIs (public surface — consumers depend on these)

Names in **bold** are required; everything else is recommended. "Consumers" lists who reads it.

### 6.1 `sky` (WP-SKY) — sky, sun/moon, time-of-day lighting, weather, atmosphere
- **`sunDirection`** Vector3 (the same object as `uniforms.uSunDir.value`; unit vector toward the sun). **`moonDirection`**.
- **`sunLight`** DirectionalLight (casts shadows in a box around **`shadowFocus`** Vector3, which the camera rig
  copies its focus point into every frame), **`hemiLight`**.
- **`daylight`** 0..1 (0 = night). **`sunElevationDeg`**. **`isNight`**.
- **`envMap`** PMREM texture of the current sky (also set as `scene.environment`), refreshed when the sun moves >2°
  or weather changes. May be null for the first frame.
- **`weather`** current interpolated state: `{ preset, cloudCover 0..1, fog 0..1, rain 0..1, windDir (heading the
  wind blows TOWARD), windSpeed m/s, swell 0..1, visibility m }`. **`setWeather(preset, transitionSeconds = 20)`**
  with presets `clear | partly | overcast | fog | rain | storm`.
- Sun and moon positions come from real astronomy for latitude 57.65°N, local time AKDT (UTC−8), `clock.dayOfYear()`.
  (Late June at Kodiak: sunrise ~5:20, sunset ~22:40, midnight twilight; August nights are properly dark.)
- Writes uniforms uSunDir, uSunColor, uSkyColor, uHorizonColor, uFogColor, uFogDensity, uDaylight, uWindDir
  (downwind unit (x, z)), uWindSpeed, uRain, uCloudCover.
- Owns `scene.fog`, the sky dome, sun disc/glow, clouds (sky-dome FBM + low cloud/mist banks that wrap mountain
  tops at 120–260 m), stars, moon, aurora (clear dark nights, late season), rain/drizzle particles near the camera,
  lightning in storms (optional).
- Consumers: water, terrain, everything lit, audio (wind/rain), season (weather schedule), UI (weather icon).

### 6.2 `postfx` (WP-SKY)
- Replaces `ctx.pipeline.render` with a composer when `quality.postfx`: HDR render target (MSAA 4× if available),
  bloom (subtle; sun glints, lights), exposure that follows daylight, ACES or AgX tone mapping, mild vignette and
  grade, optional SMAA/FXAA. Handles resize and quality changes. **`enabled`**, **`setEnabled(bool)`**.
- With reversed-Z, any pass that reads depth must account for it.

### 6.3 `water` (WP-OCEAN) — the sea
- **`mesh`** the surface; **`heightAt(x, z)`** surface height including waves (within ~5 cm of the rendered
  surface); **`sample(x, z, out = {height, normal})`**; `velocityAt?(x, z)` (orbital velocity, optional).
- **`stamp(x, z, radius, strength, kind = 'foam')`** adds a transient disturbance drawn by the water shader:
  `'foam'` (white water: wakes, splashes, the net bag), `'ripple'` (expanding rings: fish jumps, raindrops, corks).
  Cheap to call often (consumers call per frame per emitter). Decays over seconds.
- **`addOccluder(mesh)`** / `removeOccluder(mesh)`: registers a mesh (e.g. a hull footprint) that masks the water
  surface so the sea never shows inside a boat.
- Reads `sky.weather` (swell, windSpeed, windDir) each frame to set sea state; writes `uniforms.uWaveState`.
- Rendering: Gerstner/FFT-style layered waves (long swell + wind sea + chop) matched exactly by the CPU `heightAt`
  for the large waves; high-frequency detail in normals only. Physically-motivated shading: fresnel reflection of
  `sky.envMap`, sun glitter, subsurface/transmission tint on crests, depth-based absorption using uHeightMap
  (turquoise shallows over the shelf, deep blue-green offshore), shoreline foam and wave wash where the shore
  distance is small, whitecaps in wind, rain rings. Underwater objects (fish, net web, seabed) are visible through
  the surface near the viewer and fade with depth: the water is drawn in the transparent pass after opaque geometry.
- The camera must never render from below the surface; if it happens anyway, fall back to an underwater tint.
- Consumers: every floating thing (boats, corks, fish jumps, birds landing, kelp), audio, cameraRig.

### 6.4 `terrain` (WP-TERRAIN) — the island surface and vegetation
- **`mesh`/`group`**, **`heightAt(x, z)`** (render-accurate ground height), **`surfaceAt(x, z)`** →
  `'sand'|'gravel'|'grass'|'forest'|'alder'|'rock'|'snow'|'water'`, **`forestDensity(x, z)`** 0..1.
- Look: Kodiak in summer — vivid emerald grass and alder on slopes; dark Sitka spruce forest in the north-east
  (Chiniak/Kodiak city area, Afognak, Shuyak, Spruce Island) and treeless tundra/grass to the south-west; grey-brown
  rock on steep slopes and cliffs; snow patches on the highest peaks and north-facing gullies; gravel/sand beaches
  with driftwood; kelp beds just offshore; fireweed and lupine patches.
- Shading: slope/height/aspect splatting with procedural detail textures (no downloads), triplanar on cliffs,
  distance-stable detail, correct fog. Optional **`uniforms.uTerrainShadow`**: a GPU-computed sun-occlusion mask over
  the heightmap footprint (mountain shadows in valleys and on the water at low sun), recomputed when the sun moves.
- LOD/chunking so the whole island (and the Alaska Peninsula backdrop) is visible to the horizon within budget.
- Must avoid placing vegetation on developed footprints from `src/data/places.js` (`isDeveloped(x, z)`).
- Consumers: places, wildlife (bears, deer, goats), player, cameraRig collision.

### 6.5 `places` (WP-PLACES) — named places, settlements, landmarks, nav aids
- Data module **`src/data/places.js`** (pure data + helpers, importable from anywhere, no THREE):
  - `PLACES`: `[{ id, name, kind, lat, lon, radius, blurb, services?, onFoot?, dock?, model?, district? }]`, kinds
    `town | village | harbor | cannery | landmark | cape | bay | strait | island | river | lake | peak | lighthouse |
    wildlife | history | viewpoint`. `radius` is the discovery radius in game metres. `blurb` is 1–3 true,
    specific sentences (history, ecology, fishing lore). `services` ⊆ `['sell','fuel','upgrades','ice','rest']`.
    `dock` = `{lat, lon, heading}` water point where the seiner ties up (resolved to world coords at load).
  - `STREAMS`: `[{ id, name, lat, lon (mouth), species: [...], run: {sockeye: [startDay, peakDay, endDay], …},
    closedRadius }]` — major salmon streams (Karluk, Ayakulik/Red, Frazer/Dog Salmon, Upper Station, Uganik,
    Buskin, Pasagshak, Afognak, Barling, Kiliuda …). Day numbers use the game calendar (day 0 = Jun 20).
  - `DISTRICTS`: Kodiak Management Area seine districts (Northwest Kodiak, Southwest Kodiak, Alitak, Eastside
    Kodiak, Northeast Kodiak, Afognak, Mainland) with label anchors and a coarse polygon (lat/lon).
  - `FOOTPRINTS`: developed areas (towns, canneries, launch site) as circles for vegetation exclusion.
  - helpers `isDeveloped(x, z, geo)`, `resolve(geo)` → world coordinates.
- System API: **`list`** (resolved places with `x, z`), **`get(id)`**, **`nearest(x, z, filter?)`**,
  **`within(x, z, r, filter?)`**, **`streams`** (resolved), **`districtAt(x, z)`**, **`spawn`** (new-game spawn in
  St. Paul Harbor approaches).
- 3D: charming, low-poly but detailed settlements matching reality and scale: City of Kodiak (houses on the hills,
  cannery row with pilings, St. Paul & St. Herman harbors with masts, Holy Resurrection Cathedral with blue onion
  domes, the six Pillar Mountain wind turbines turning, Near Island bridge), villages (Ouzinkie, Port Lions, Old
  Harbor, Larsen Bay, Akhiok, Karluk — each with its Russian Orthodox church), canneries (Larsen Bay, Alitak/Lazy
  Bay, Uganik), Coast Guard Base Kodiak, the Pacific Spaceport launch tower at Narrow Cape, WWII bunkers at Fort
  Abercrombie, cape lights and channel buoys that blink at night, lit windows at night, smoke. Model
  instancing/merging to stay within budget.
- Consumers: discovery, UI (map, logbook), fleet (tender placement), fish (streams), season (closed waters, species
  mix), wildlife (bear streams), terrain (footprints).

### 6.6 `fleet` (WP-BOATS) — tenders and other vessels
- **`tenders`**: `[{ id, name, placeId, position, heading, object3d, buying: bool, radius }]` — 4–6 anchored tenders
  (70–120 ft converted crabbers/packers) at fishing grounds; prices come from `season.priceFor`.
- **`nearestTender(x, z)`** → `{ tender, distance }` or null. **`boats`**: ambient vessels (other seiners working
  and running, a ferry on the Kodiak route, a Coast Guard cutter near Womens Bay, skiffs), simple waypoint AI,
  lights at night, collision radius.

### 6.7 `seiner` (WP-BOATS) — the player's boat
- **`object3d`**, **`position`** (waterline centre, world), **`heading`**, **`speed`** (m/s, signed forward),
  **`velocity`** Vector3, **`throttle`** −1..1, **`rudder`** −1..1, **`maxSpeed`** (upgradeable),
  **`speedLimit`** (m/s cap set by fishing while towing gear; null = none), **`controlsEnabled`**, **`grounded`**,
  **`engineLoad`** 0..1, **`anchored`**, **`deckLights`** bool.
- **`forward(out)`**, **`sternPoint(out)`** (stern roller, where the seine pays out), **`bowPoint(out)`**,
  **`powerBlockPoint(out)`** (block at the boom tip), **`skiffMountPoint(out)`** (stern ramp), **`setPose(x, z,
  heading)`**, **`setAnchored(bool)`**, **`horn()`**.
- Physics: buoyancy/pitch/roll from `water.sample` at several hull points, inertia, rudder turning that needs way on,
  prop walk, grounding when depth < 2.2 m (stop, bump, `boat:collision` event, small damage/fuel penalty is optional),
  circle collisions with tenders/fleet, soft boundary push. Wake and bow spray via `water.stamp`.
- Model: a proper Alaska limit seiner — white hull with a coloured sheer stripe, raised foc'sle, wheelhouse with
  windows (lit at night), flying bridge with controls, mast and boom with the power block, radar dome and antennas,
  seine piled on the stern deck (web + corks), the aluminium seine skiff on the stern ramp, rigging, running lights
  (red port, green starboard, white masthead/stern), deck floods (N), 3 deckhands in orange rain gear (simple
  procedural animation), boat name on bow/stern from the save (default "Northern Dawn").
- Uses `water.addOccluder` for the hull footprint.

### 6.8 `skiff` (WP-BOATS) — the seine skiff
- **`object3d`**, **`position`**, **`heading`**, **`state`**: `'stowed' | 'released' | 'holding' | 'towing' |
  'closing' | 'returning' | 'ferry'`.
- **`release()`** drop off the stern ramp (splash), hold the bitter end of the seine at the drop point.
  **`holdAt(x, z)`**, **`towToward(x, z, effort 0..1)`** (keep the net open against drift), **`closeTo(object3d |
  Vector3)`** (run the end to the seiner for close-up), **`returnTo()`** (come back to the stern and be hauled up the
  ramp → 'stowed'), **`stow()`** (instant), **`ferry(fromVec3, toVec3, onArrive)`** (used by the on-foot WP to take
  the player ashore/back), **`endPoint(out)`** where the net end attaches, **`busy`**.
- Model: aluminium seine skiff with a big outboard/inboard, towing bitt, skiffman figure; wake via `water.stamp`.

### 6.9 `cameraRig` (WP-BOATS)
- **`mode`**: `'chase' | 'crowsnest' | 'bridge' | 'foot' | 'title' | 'free'`; **`setMode(mode)`**, **`cycle()`** (C
  cycles chase → crowsnest (high top-down, best for setting the net) → bridge), **`setTarget(object3d | null)`**,
  **`focus`** Vector3 (what the camera looks at; copied into `sky.shadowFocus`), **`shake(amount)`**,
  **`binoculars`** (hold right mouse or B: fov zoom to ~12° for spotting jumpers).
- Mouse drag orbits, wheel zooms, recenters behind after ~3 s idle; gamepad right stick. Never below the water
  surface (+1.5 m) or inside terrain (+2 m). Smooth, weighty, cinematic.
- `title` mode: slow cinematic flyover of scenic real locations at golden hour (loop of 5–7 shots with eased
  moves; e.g. the seiner running out of Kodiak, cliffs of Shelikof, Uyak Bay, snowy peaks above Olga Bay).
- Honours `ctx.debug.cameraOverride` (main applies it after lateUpdate).

### 6.10 `fish` (WP-FISH) — salmon schools
- **`schools`**: `[{ id, species (dominant), mix {pink, chum, sockeye, coho, king} (counts), count, position
  (Vector3; y = −depth), velocity, radius, depth, state: 'migrating'|'milling'|'spooked'|'sounding'|'trapped'|
  'captured'|'gone', targetStream, jumpRate }]`.
- **`nearestSchool(x, z, maxDist)`**, **`schoolsWithin(x, z, r)`**, **`schoolsInside(polygon)`** (polygon =
  `[{x, z}]`), **`harvest()`** → `{ pink, chum, sockeye, coho, king }` counts of fish still inside the pursed net
  (marks those schools captured), **`sonarReturns(x, z, range)`** → `[{x, z, depth, strength, species?}]`,
  **`spawnSchool({x, z, species, count})`** (debug/tutorial).
- Behaviour: 12–25 schools alive across the island, weighted by `season.speciesMix` and `places.streams` (schools
  come in from offshore, follow the coast using `heightmap.shoreGradient`, mill off points and at bay heads, and
  move toward their stream as the run peaks). Jumpers are the main visual cue: salmon leap clear of the water with
  splash + ripple (`water.stamp`) + `fish:jump` event, more often at dawn/dusk and for pinks; milling schools also
  show "finning" ripples. Schools spook (turn away, speed up) from a fast boat within ~40 m or the horn, and may
  sound (dive) when spooked repeatedly.
- **With the net** (reads `ctx.systems.net`): while the net is out and open, fish near the gap run for it; inside a
  closed but unpursed net they escape under the leadline at a rate that falls as `net.pursed` → 1 and rises with
  `net.bottomContact`; once pursed they are trapped. During hauling the trapped fish crowd into the shrinking bag at
  the surface beside the seiner (dense, thrashing, splashing — the money shot) until brailed.
- Rendering: instanced procedural salmon per species (vertex-shader swimming), individual fish only for schools
  near the camera (budgeted instance cap), dark shimmering shapes visible under the surface when close; jumpers at
  any distance the camera can see.

### 6.11 `net` (WP-NET) — the purse seine
- **`state`**: `'stowed'|'paying'|'out'|'closed'|'pursing'|'hauling'|'brailing'`, **`length`** (m; upgradeable),
  **`depth`** (m; upgradeable), **`payout`** (m in the water), **`pursed`** 0..1, **`hauled`** 0..1,
  **`bottomContact`** 0..1, **`corkline`** (array of Vector3 node positions).
- **`polygon()`** → `[{x, z}]` ring (corkline plus the straight gap segment) or null; **`gap()`** → `{a, b, width}`
  or null when closed; **`containsPoint(x, z)`**.
- Commands (called by `fishing`): **`begin(endAnchor)`** (bitter end attached to the skiff), **`close()`**,
  **`purse(rate)`**, **`haul(rate)`**, **`stow()`**.
- Simulation: a chain of floating corkline nodes (positions follow `water.heightAt`, distance constraints, drag),
  paid out from `seiner.sternPoint` as the boat moves; the web hangs to `depth` (or the seabed) with the leadline
  and purse rings; pursing draws the rings together under the circle; hauling feeds the net up through the power
  block and piles it back on deck.
- Rendering: yellow/white corks (instanced), corkline rope, translucent dark-green web curtain visible under water,
  purse rings, the net rising through the block; foam stamps around the bag.

### 6.12 `fishing` (WP-NET) — the set, as a state machine
- **`state`**: `'idle'|'setting'|'closing'|'pursing'|'hauling'|'brailing'|'report'`, **`setNumber`**, **`lastSet`**,
  **`canSet()`** → `{ ok, reason }`.
- Sequence and controls (offers via `ctx.interact`, priority 100):
  1. **idle** → Space "Let the skiff go!" (requires: opener open or free explore, water deeper than 6 m, not already
     setting). Closed waters (`season.isClosedWater`) warn first; setting there risks a citation (fine + catch
     confiscated) announced by an Alaska Wildlife Trooper on the radio.
  2. **setting**: the skiff holds the bitter end; the net pays out from the stern as the seiner moves (speed limited
     to ~7 m/s while paying; tight turns are allowed but a fouled/crossed net costs time). The player drives a
     circle/hook around the school. When the net is fully out the seiner tows the end.
  3. **closing**: within `config.net.closeDistance` of the skiff, Space "Close up" — the skiff brings its end to the
     seiner (short animated move).
  4. **pursing**: hold E to run the purse winch; a tension gauge rewards steady, not maximal, hauling (too fast →
     "rings fouled", brief stall; too slow → more fish escape under). Bottom contact slows pursing and risks a snag.
  5. **hauling**: the power block hauls the net (hold E to haul faster, time runs 4× faster during hauling), the
     circle shrinks toward the boat, the bag forms.
  6. **brailing**: the brailer scoops fish from the bag into the hold (short animation; count up).
  7. **report**: `fishing:setComplete` with the catch; skiff returns and is stowed; back to idle.
  Esc/Backspace during setting offers "Abort set" (haul back, water haul).
- Catch → `economy.addCatch(catch)` (returns what fit; overflow released with a message).
- Tutorial hints on the first set (radio from the skipper's uncle / seasoned deckhand voice).
- Emits `fishing:state`, `fishing:skiffReleased`, `fishing:closedUp`, `fishing:escape`, `fishing:snag`,
  `fishing:setComplete` (§7).

### 6.13 `wildlife` (WP-WILDLIFE)
- **`bears`**, **`whales`**, **`birds`** (arrays of `{ kind, position, state }`), `nearestBear(x, z)`.
- Species and behaviour: Kodiak brown bears (sows with cubs) fishing at stream mouths and walking beaches, on
  `terrain.heightAt`; bald eagles soaring and perched; glaucous-winged gulls following the seiner and "working"
  over schools (circling, diving — a hint for the player), swarming the bag during hauling; tufted puffins on rocky
  islets and flying low; humpback whales (distant blows, breaches, fluke-up dives; bubble-net feeding occasionally);
  orca pod (rare); sea otter rafts in kelp; Steller sea lions on haulout rocks; harbor seals; Sitka black-tailed deer
  on hillsides; mountain goats on high cliffs (optional). Emits `wildlife:sighted` the first time the player gets a
  good look at each kind. Budgeted and culled by distance; instanced where possible.

### 6.14 `player` (WP-FOOT) — going ashore
- **`active`**, **`object3d`**, **`position`**, **`canGoAshore()`** → `{ ok, reason, landing }`, **`goAshore()`**,
  **`returnToBoat()`**.
- Offer "E — Go ashore" (priority 40) when the seiner is nearly stopped within ~150 m of a walkable beach and not
  fishing; the skiff ferries the player (short cutscene) and the seiner anchors. On foot: WASD relative to camera,
  Shift run, Space jump, mouse orbit; slope limits; wade to knee depth only; footsteps (`player:step` with
  surface). Return by walking back to the landing skiff ("E — Back to the boat").
- Character: procedural deckhand in orange bibs, XtraTuf boots, beanie; procedural walk/run/jump animation.
- Bears: within ~30 m a bear stands and watches ("Back away slowly"); closing to ~10 m triggers a bluff charge,
  fade out, and a safe return to the skiff with a radio quip. No injuries shown.
- On-foot discoveries: peaks/viewpoints/landmarks with `onFoot: true`.

### 6.15 `season`, `economy`, `discovery`, `ui` (WP-GAME)
- `season`: **`openerActive()`**, **`speciesMix(x, z)`** (by date and district/stream runs), **`priceFor(species,
  tenderId?)`** (daily variation ±15%, RSW bonus), **`forecast()`**, **`closedWaters`** (circles at stream mouths),
  **`isClosedWater(x, z)`**, daily weather schedule (calls `sky.setWeather`), radio chatter library (other skippers,
  tender prices, NOAA marine forecasts, Coast Guard, ADF&G announcements).
- `economy`: **`cash`**, **`hold`** (counts per species), **`holdLbs()`**, **`capacityLbs`**, **`fuel`**,
  **`fuelCapacity`**, **`upgrades`**, **`addCatch(catch)`** → accepted counts, **`deliver(tender)`** → receipt,
  **`refuel()`**, **`buy(upgradeId)`**, **`catalog`**, **`stats`**. Applies upgrades to systems (`seiner.maxSpeed`,
  `net.length/depth`, pursing/hauling rates, sonar range, hold). Fuel burns with `seiner.engineLoad`.
  Offers "E — Deliver to <tender>" (priority 60) alongside a tender (<35 m, <2 m/s, fishing idle, hold not empty) and
  "E — Tie up at <harbor>" at harbors with services.
- `discovery`: **`discovered`** Set, **`isDiscovered(id)`**, **`discover(id)`**, **`sightings`**, **`progress()`**.
  Entering a place radius discovers it (toast + logbook + small bonus); on-foot places only on foot.
- `ui`: title screen (logo, Continue/New Season/Free Explore/Settings/Controls/Credits, boat name), HUD (date/time &
  opener status, cash, hold gauge, fuel, speed/heading, compass strip with waypoint, sonar/fish-finder, context
  prompts from `ctx.interact.current`, fishing progress widgets: payout, closing distance, purse tension, haul
  progress), toasts, VHF radio captions, map (nautical chart rendered from the heightmap: contours, soundings
  flavour, discovered names, districts, tenders, closed waters, waypoint, fast travel to discovered
  harbors/tenders), logbook, set report, delivery receipt styled as an ADF&G fish ticket, harbor menu (upgrades,
  fuel, sleep), pause/settings (quality, volumes, time speed, invert), help overlay, photo mode, save/load
  (`src/game/save.js`, localStorage key `kodiak-seiner:save`; autosave on delivery, sleep, every 2 game hours).
  **`toast(text, opts)`**, **`radio(from, text, channel = 16)`**, **`hint(id, text)`** (once per save),
  **`openMap()`**, **`openLogbook()`**, **`showSetReport(data)`**, **`showReceipt(data)`**, **`visible`**.
- Sleep: at night (22:00–04:00) when anchored or tied up, "E — Sleep until 5 AM" advances the clock.

### 6.16 `audio` (WP-AUDIO)
- **`unlock()`** (called on first gesture), **`play(name, {position, volume, rate})`**, **`setVolumes({master, music,
  sfx, ambience})`**, **`muted`**. All procedural WebAudio: ocean and shore wash (by swell and distance to shore),
  wind, rain, diesel engine (throttle/engineLoad), skiff outboard, hydraulic whine (pursing/hauling), splashes, gulls,
  eagles, whale blows, bears (distant), footsteps by surface, horn, radio squelch before captions, cash register on
  delivery, UI clicks; gentle generative music (title, dawn, big set). Positional sounds use the camera as listener.

### 6.17 Ownership of the interaction keys
- **Space** (`action`): fishing (skiff release, close up), player jump. **E** (`interact`): fishing holds (purse,
  haul), deliver/dock/sleep (GAME), go ashore/back to boat (FOOT), inspect landmarks. Always go through
  `ctx.interact` for discrete presses; poll `input.action` only for your own active hold mechanic.

---

## 7. Events

| event | payload | emitted by |
|---|---|---|
| `game:ready` | `{}` | core |
| `game:mode` | `{ mode, prev }` | core |
| `game:start` | `{ newGame, freeExplore }` | core |
| `time:hour` | `{ day, hour }` | core clock |
| `time:day` | `{ day }` | core clock |
| `opener:start` / `opener:end` | `{ day }` | season |
| `weather:change` | `{ preset }` | sky |
| `place:discovered` | `{ id, name, kind }` | discovery |
| `place:enter` / `place:leave` | `{ id }` | discovery |
| `wildlife:sighted` | `{ kind, x, z, first }` | wildlife |
| `fish:jump` | `{ x, y, z, species, size }` | fish |
| `fish:spooked` | `{ schoolId, x, z }` | fish |
| `fishing:state` | `{ state, prev }` | fishing |
| `fishing:skiffReleased` | `{ x, z }` | fishing |
| `fishing:closedUp` | `{ polygon, estimate }` | fishing |
| `fishing:escape` | `{ count, species }` | fishing / fish |
| `fishing:snag` | `{ x, z }` | fishing |
| `fishing:setComplete` | `{ setNumber, catch: {species: {count, lbs}}, totalLbs, value, minutes, waterHaul, rating }` | fishing |
| `economy:cash` | `{ cash, delta, reason }` | economy |
| `economy:delivered` | receipt `{ ticket, tender, lines: [{species, count, lbs, price, value}], gross, crewShare, net }` | economy |
| `economy:holdFull` | `{}` | economy |
| `economy:purchase` | `{ id }` | economy |
| `boat:collision` | `{ speed, x, z, kind: 'ground'|'boat' }` | seiner |
| `boat:horn` | `{}` | seiner |
| `player:mode` | `{ control: 'boat'|'foot' }` | player |
| `player:step` | `{ surface, run }` | player |
| `bear:encounter` | `{ stage: 'watch'|'charge'|'retreat' }` | player / wildlife |
| `ui:toast` | `{ text, kind, duration }` | anyone → ui |
| `ui:radio` | `{ from, text, channel }` | anyone → ui (+ audio squelch) |
| `ui:hint` | `{ id, text }` | anyone → ui |

Add new events freely; document them in your notes.

---

## 8. Game design details

### 8.1 Session flow
Title (cinematic, golden hour) → New Season: day 0 = June 20, 05:30, the seiner in the St. Paul Harbor approaches
with $2,500, full fuel, an empty hold, and a radio welcome that points to the nearest grounds. The fishing period
is open 06:00–22:00 daily. Free Explore: no fuel use, fishing always open, nothing saved beyond discoveries.

### 8.2 Species, seasonality, prices (game calendar; day 0 = Jun 20)
| species | avg lbs | base $/lb | run timing | behaviour |
|---|---|---|---|---|
| sockeye (red) | 6.0 | 1.15 | early (days 0–30), strongest west and south (Karluk, Ayakulik, Frazer/Olga, Upper Station) | fewer jumpers, fast, deeper |
| pink (humpy) | 3.6 | 0.32 | days 15–60, everywhere, huge schools | lots of jumpers, the bread and butter |
| chum (dog) | 8.5 | 0.55 | days 10–45, bays and heads | finning, dives when spooked |
| coho (silver) | 7.5 | 0.95 | days 45–80 | acrobatic jumpers |
| king (chinook) | 18 | 2.10 | rare bycatch all season | — |
A good pink set is 2,000–8,000 fish; a "plugged" set can overflow the hold. Hold 60,000 lb to start.

### 8.3 Money
Delivery pays lbs × price per species; crew share 30% (3 deckhands × 10%) is deducted and shown on the fish ticket.
Fuel $4.60/gal; 38 gal/hour at full throttle. Upgrades (Kodiak harbor): engine rebuild/new engine, longer seine,
deeper seine, bigger power block, purse winch, sonar (range; species ID), RSW (+price), hold expansion, deck lights,
spotter-plane day charters (reveals schools on the map). Prices $1k–$25k. A season goal ladder shows milestones
("Pay off the permit loan — $40,000", "Highliner — $150,000").

### 8.4 Exploration
~60–90 places: all villages and towns, canneries, every major bay and strait (Uyak, Uganik, Kupreanof Strait,
Viekoda, Kizhuyak, Chiniak, Ugak, Kiliuda, Sitkalidak Strait, Three Saints, Kaguyak, Alitak, Olga, Deadman, Sturgeon,
Karluk, Shelikof Strait, Marmot, Izhut, Kazakof …), capes (Chiniak, Greville, Barnabas, Alitak, Ikolik, Karluk,
Uganik, Ugat, Kuliuk, Spruce Cape …), peaks (Koniag Peak, Barometer Mountain, Pillar Mountain), lakes (Karluk,
Frazer, Red, Akalura), historical sites (Three Saints Bay 1784, Fort Abercrombie, Refuge Rock), wildlife spots
(O'Malley bear viewing, Afognak elk country, Marmot Island sea lions, puffin islets), and viewpoints reachable on
foot. Discovery gives a toast, a logbook card with the blurb, and $25–$100 "fuel money".

### 8.5 Camera and controls
W/S throttle, A/D rudder, mouse drag orbit, wheel zoom, C camera (chase / crow's nest / bridge), B or right mouse
binoculars, Space skiff/close-up, E interact/hold, M map, L logbook, G horn, N deck lights, H photo mode, Esc pause,
F1 help. Gamepad: left stick drive, right stick look, A action, X interact, Y camera, Start pause.

---

## 9. Look bible

- **Palette.** Sea: deep teal-navy offshore (#0d3140 → #11485a), green-teal in bays, turquoise over the shelf
  (#2b8a86) with visible gravel; white foam. Land: emerald summer grass (#4f8a3a → #7fb35a in sun), alder
  (#3c6b2e), spruce (#1f3a26), rock (#5b5751 dark basalt/greywacke), snow (#eef2f6). Sky: pale cold blue at noon,
  peach/gold at golden hour (sun #ffb070), dusky violet twilight.
- **Light.** Golden hour is the signature (long sunsets 20:00–22:40 in late June). Mountain shadows across valleys
  and onto the water at low sun. Midday is crisp. Overcast is moody and soft with low cloud clinging to mountains.
- **Atmosphere.** Aerial perspective is essential at this scale: distant ridges fade to blue-grey, the Alaska
  Peninsula volcanoes are pale silhouettes across Shelikof Strait. Height fog pools in bays in the morning.
- **Water** is the star: sun glitter path, reflections of mountains and sky, swell you can see the boat ride,
  wakes that linger, foam lines on beaches, rain rings.
- **Life.** Something is always moving: jumpers, gulls, eagles, a distant blow, another boat running, turbines
  turning, blinking nav lights at night.
- **UI.** Nautical and quiet: translucent dark panels, off-white text, one accent (safety orange #ff7a1a), a serif
  for titles (Georgia/Iowan Old Style) and a clean sans for data, monospace digits for gauges. Minimal HUD by
  default; photo mode hides all.

### Performance budgets (1280×720, pixel ratio 1, M-series GPU, headless smoke harness)
Frame ≤ 16.7 ms average, p95 ≤ 20 ms, with every system on. Approximate per-WP GPU+CPU budgets: sky+postfx 3 ms,
water 3 ms, terrain+vegetation 4 ms, places 1 ms, boats+fleet 1 ms, fish 1.5 ms, net 1 ms, wildlife 1.5 ms, UI 0.5 ms
(throttle DOM writes to ≤10 Hz except prompts). Draw calls ≤ 600, triangles ≤ 4 M. Measure your cost with
`--params="skip=<you>"` vs without.

---

## 10. Testing and verification (every WP)

1. **Unit tests** (`tests/<wp>.test.mjs`, node:test): put pure logic (maths, state machines, economy, data
   validation) in modules that import no DOM/WebGL so they run under Node (`three` imports are fine for math).
2. **Smoke scenarios** (`tests/scenarios/<wp>-*.json`): exercise your feature end-to-end with screenshots at
   meaningful moments (several times of day and weather where relevant). Run with
   `node tools/smoke.mjs --scenario=tests/scenarios/<file>.json --out=qa/<wp>/<name>`. Look at your screenshots
   (Read the PNGs) and iterate on the look until it is genuinely beautiful — this is a visual game.
3. **Zero console errors/warnings from your system**, no failed systems, perf within budget.
4. **Isolation:** if another WP's system breaks your run, isolate with `--params="skip=<name>"` and note it.
5. **Notes:** `notes/WP-<NAME>.md` — summary, API as built (and deviations), tunables, known issues, perf numbers,
   screenshot paths, requests to other WPs.

---

## 11. Work packages and file ownership

| WP | owns | builds |
|---|---|---|
| WP-SKY | `src/world/sky.js`, `src/world/sky/**`, `src/render/postfx.js`, `src/render/postfx/**` | §6.1, §6.2 |
| WP-OCEAN | `src/world/water.js`, `src/world/water/**` | §6.3 |
| WP-TERRAIN | `src/world/terrain.js`, `src/world/terrain/**` | §6.4 |
| WP-PLACES | `src/world/places.js`, `src/world/places/**`, `src/data/places.js` | §6.5 |
| WP-BOATS | `src/entities/seiner.js`, `src/entities/skiff.js`, `src/entities/fleet.js`, `src/entities/boats/**`, `src/render/cameraRig.js`, `src/render/camera/**` | §6.6–6.9 |
| WP-FISH | `src/entities/fish.js`, `src/entities/fish/**` | §6.10 |
| WP-NET | `src/entities/net.js`, `src/entities/net/**`, `src/game/fishing.js`, `src/game/fishing/**` | §6.11, §6.12 |
| WP-GAME | `src/game/season.js`, `src/game/economy.js`, `src/game/discovery.js`, `src/game/save.js`, `src/game/data/**`, `src/ui/**` | §6.15 |
| WP-WILDLIFE | `src/entities/wildlife.js`, `src/entities/wildlife/**` | §6.13 |
| WP-FOOT | `src/entities/player.js`, `src/entities/player/**` | §6.14 |
| WP-AUDIO | `src/audio/**` | §6.16 |

Every WP also owns `tests/<wp>*.test.mjs`, `tests/scenarios/<wp>-*.json`, `notes/WP-<NAME>.md` and `qa/<wp>/`.
