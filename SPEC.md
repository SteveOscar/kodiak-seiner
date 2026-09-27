# Kodiak Seiner — design and interface contract

A 3D browser game about Alaskan salmon purse seining around a real-geography Kodiak Island. You skipper a 58-foot
limit seiner: find schools of salmon by their jumpers, let the skiff go, lay the seine around the school (or hook it
off a point), close up, purse, haul with the power block, brail the catch into the hold and deliver it to a tender.
Between fishing periods, explore the island's bays, villages, capes, streams and mountains by boat and on foot.

This document is the contract between work packages (WPs). Code, tests and the running game are authoritative for
behaviour; this file is authoritative for **interfaces, ownership and intent**. If you must deviate from an interface,
keep the documented surface working (add, don't break) and record the deviation in your notes file.

---

## 1. Pillars

1. **Beautiful.** Every screenshot should look like a postcard from Kodiak: emerald mountains dropping into dark
   fjords, low cloud on the peaks, golden-hour light, a sea that moves and glitters. Beauty beats feature count.
2. **Authentic.** Real geography (AWS Terrain Tiles DEM), real species, gear, regulations, seining sequence and
   vocabulary: skiff end, corkline, leadline, purse rings, "rings up", power block, "dry up the bag", brailer,
   tender, fish ticket, fishing period, closed waters, jumpers, humpies, "plugged", "water haul", "hung up", "net in
   the wheel", "Let 'er go!". Kodiak's Alutiiq (Sugpiaq) people and history are presented with respect.
3. **Fun first.** The set is a readable, tense, rewarding mini-drama (spot → set → hold → close → purse → haul →
   brail). Exploration rewards curiosity with discoveries, wildlife, vistas, lore and fishing intel.
4. **Runs well.** 60 fps at 1280×720 on an Apple M-series GPU with everything on; graceful quality tiers.

---

## 2. Project layout and rules

```
index.html                 entry (Vite)
src/main.js                boot, frame loop, ctx.game (modes, start/load/snapshot/teleport), debug API     [core]
src/core/*                 config, events, input, clock, geo, rng, uniforms, interact, tide                 [core]
src/systems/registry.js    system list (creation + update order)                                            [core]
src/systems/stubs.js       stand-in for every system (full required API, a few minimally functional)        [core]
src/systems/contract.js    REQUIRED members per system; main.js warns when a real system lacks one           [core]
src/world/heightmap.js     DEM loading + terrain/seabed queries                                             [core]
src/render/renderer.js     WebGLRenderer, scene, camera, render pipeline hooks                              [core]
src/render/shaderChunks.js shared GLSL chunks (kodiak_underwater) + patchUnderwater()                       [core]
src/data/places.js         places/streams/districts/footprints data — exports FROZEN; contents WP-PLACES
public/terrain/*           kodiak_height.png (+ meta) from tools/fetch-dem.mjs                              [core]
tools/smoke.mjs            headless real-GPU play-test harness                                              [core]
tests/**/*.test.mjs        node:test unit tests (npm test); tests/contract.test.mjs exports fakeCtx()
tests/scenarios/*.json     smoke scenarios (committed)
notes/WP-<NAME>.md         each WP's notes
qa/                        screenshots and reports (gitignored)
```

Commands: `npm run dev`, `npm test`, `npm run build`, and
`node tools/smoke.mjs --scenario=<name|file> --out=qa/<dir> [--params="autostart&time=19"] [--bench] [--strict]`.

**Ownership.** Each WP edits only the files it owns (§11) and may split them into sub-modules under its own folder.
Core files belong to the orchestrator: do not edit them unless a core bug blocks you; then make the minimal fix and
record it under "Core changes" in your notes. Never modify another WP's files. If you need something from another
WP, code defensively against the documented API (optional chaining) and write it under "Requests" in your notes.
Other agents are editing their own files concurrently: their systems will appear, change or briefly break during
your run — that is expected.

**Robustness.** Real systems must be supersets of their stub and of `REQUIRED` in `src/systems/contract.js`. Every
cross-system call must tolerate the stub or a missing system (`ctx.systems.fish?.schoolsWithin?.(x, z, r) ?? []`).
A system must never throw from update(); failures are isolated, but a throwing system is a failed WP.

**Code style.** Plain modern JavaScript ES modules; no TypeScript, frameworks or new runtime dependencies beyond
`three` (use `three/addons/...`). All art is procedural or generated at runtime (geometry, canvas textures,
shaders) — no downloads, no copyrighted assets, no CDN fonts. Comments explain non-obvious intent and constraints
only. Keep modules focused; split big systems into sub-files.

**Randomness.** Never draw from `ctx.rng` directly. In create(), take `const rng = ctx.rng.fork('<system>')` and
sub-fork per purpose. A fork depends only on seed and salt, so other systems' draws never change yours.
`Math.random()` only for per-frame cosmetic jitter.

---

## 3. World and coordinates

- Units are metres, seconds, radians. **+x = east, −z = north, +y = up.** Sea level is y = 0 (no vertical tide).
- The world is a 16 km square: x, z ∈ [−8000, 8000], mapping a ~188 km square of the real archipelago (lat
  56.80–58.50, lon −154.98 to −151.82) at ~1:11.75 horizontally. Land heights are real metres × 0.2 — terrain is
  **vertically exaggerated ≈ 2.35×** relative to horizontal distance (a real 25° slope is ~48° in game). Peaks
  reach ~250 m (Kodiak) and ~440 m (Alaska Peninsula volcanoes across Shelikof Strait, NW corner).
- Seabed depth = min(real depth × 0.4, 0.4 + 0.1 × distance offshore): a shallow shelf along every beach (water is
  shallower than the 16 m base seine within ~155 m of shore), deep water mid-bay (Shelikof Strait ~80–90 m).
- Boats, people, animals and fish are **real size** (seiner 17.7 m). Only the landscape is compressed: bays are
  hundreds of metres wide, the island ~13 km long.
- **Heading**: radians, 0 = north (−z), clockwise positive (π/2 = east). Forward = (sin h, 0, −cos h). A model facing
  −z with heading h has `rotation.y = −h`.
- `ctx.geo.toWorld(lat, lon)` → {x, z}; `toLatLon(x, z)`; `toKnots(ms)` (12 m/s reads ~11 kn); `toNauticalMiles(m)`.
- **Heightmap** (`ctx.heightmap`): `heightAt`, `realAt`, `shoreDistance` (signed, + offshore, ±~990 m),
  `shoreGradient` (offshore unit vector), `normalAt`, `isWater`, `depthAt`, `raymarch`, `nearestWater(x, z,
  {minShore})`, `seabedAt(x, z)` → `'sand'|'gravel'|'mud'|'rock'|'land'`. GPU: `ctx.uniforms.uHeightMap` is an RG
  float texture with a mip chain (R = game height, G = signed shore distance, metres), row 0 = north, uv = ((x +
  8000) / 16000, (z + 8000) / 16000). Vertex shaders use `textureLod(uHeightMap, uv, 0.0)`. Shore-distance effects
  (foam, wash) fade out beyond ~3 km from the camera.
- **Tide/current** (`ctx.tide`): `state()` → `{flow, height, stage: 'flood'|'ebb'|'slack', hoursToSlack}`;
  `currentAt(x, z, out)` → surface current m/s (tidal stream along the shore, strongest nearshore, + 3% wind drift).
  One cycle = 12.42 game hours. Consumers: net corks, skiff, seiner drift at rest/holding/pursing, fish, flotsam, UI.
- **Placing things on land:** `ctx.systems.terrain.heightAt(x, z)` returns the full-detail surface. Terrain LOD
  error is ≤ 0.3 m within 600 m of the camera and ≤ 2 m within 3 km, so anything placed on land (buildings, pier
  ends, bunkers, animals at rest) must have a skirt/foundation extending ≥ 2 m below its base. On water use
  `ctx.systems.water.heightAt(x, z)` (includes waves).
- Soft world boundary at |x| or |z| > 7600: boats/players are gently pushed back with a UI message.

---

## 4. Core services, modes and rendering rules

### 4.1 `ctx`

| field | what |
|---|---|
| `THREE` | the three.js namespace (r186) |
| `renderer`, `scene`, `camera` | WebGLRenderer (reversed-Z depth, sRGB output, ACES tone mapping, PCF shadows — softness via `sunLight.shadow.radius`, `shadowMap.autoUpdate = false` with one redraw per frame, `info.autoReset = false`), Scene, PerspectiveCamera (fov 55, near 0.5, far 40 km) |
| `pipeline` | `render(dt)` (postfx replaces it), `beforeRender(fn)` → remover, `afterRender(fn)` → remover, `onResize(fn)`. beforeRender hooks run after the debug camera override: put camera-following work (sky dome centring, shadow box, rain volume, camera-centred grids) and secondary renders there |
| `config` | `src/core/config.js`: world, time, season (fishingDays, closedRadius), spawn, boat, net (lengths, caps, phase durations), fish (species table, runs), economy, render |
| `quality` | read-only preset (ultra/high/medium/low): pixelRatio, shadows, shadowMapSize, waterSegments, vegetation, postfx. Changing quality = save `kodiak-seiner:settings` and reload |
| `events` | bus `on(name, fn) → off`, `once`, `off`, `emit` — catalogue §7 |
| `input` | `action`, `pressed`, `released`, `axis('steer'|'throttle'|'lookX'|'lookY')`, `mouse {dx, dy, wheel, buttons (1 left orbit, 2 right binoculars), clicked}`, raw `keyDown/keyPressed(code)`, `gameplayBlocked`, `consume()`. Actions: throttleUp/Down (W/S ↑/↓), left/right (A/D ←/→), action (Space), interact (E/Enter), camera (C), map (M), logbook (L/J), pause (Esc/P), photo (H), sprint (Shift), horn (G), binoculars (B or hold right mouse), lights (N), help (F1 or /) |
| `interact` | `offer({id, label, key, priority, onPress, hold})` every frame while available; `current[key]` → `{id, label, hold}` for the HUD (read it in `frame()`). Only resolved in steady `play` |
| `clock` | `hours` [0,24), `day` (0 = Jul 6), `scale` (game min per real s; UI time-speed only), `frozen` (core only), `advance`, `skip(hours, reason)` (emits `time:skip`, never `time:hour`), `hoursUntil(h)`, `set(h, day)`, `date()`, `dayOfYear()`, `timeLabel()`, `inOpenerHours()` (daily window only — use `season.openerActive()`) |
| `tide` | §3 |
| `uniforms` | shared uniform objects (see `src/core/uniforms.js` for owners): uTime, uCameraPos (LOD/culling only), uSunDir, uSunColor, uSkyColor, uHorizonColor, uFogColor, uFogDensity, uDaylight, uWindDir, uWindSpeed, uRain, uCloudCover, uHeightMap, uWorldHalf, uTerrainShadow (1×1 white default), uWaveState, uWaterAbsorb, uWaterScatter |
| `heightmap`, `geo`, `rng` | §3, §2 |
| `systems` | every system by registry name (§6) |
| `state` | `{ mode, control: 'boat'|'foot' (written only by player), freeExplore }` |
| `game` | `start({newGame, freeExplore})` (newGame calls every `sys.reset()`), `setMode(mode)`, `pause()`, `resume()`, `toTitle()` (emits `game:toTitle` first), `teleport(x, z, heading, {reason})` (emits `boat:teleport`), `avatar()` → `{x, y, z, heading, object3d, control}` (person on foot, else the seiner), `snapshot()` → save JSON or null, `load(data)` |
| `time` | `{ elapsed (sim s), dt, realDt, frame }` |
| `flags` | URL: `debug`, `autostart`, `explore`, `skip`/`only` (Sets of system names forced to stub), `seed`, `time`, `day`, `weather`, `at` ("x,z,headingDeg"), `quality` |
| `debug` | `{ cameraOverride, weatherPinned }` — season never calls `sky.setWeather` while `weatherPinned` |

### 4.2 Modes

| mode | sim dt | clock | gameplay input / offers | entered by | left by |
|---|---|---|---|---|---|
| title | real | frozen | off | core boot, `game.toTitle()` | UI (start/continue) |
| play | real | runs | on | core | — |
| paused | 0 | frozen | off | UI: Esc/P, settings, help, logbook, harbour menu, set report, fish ticket | UI |
| map | 0 | frozen | off | UI: M | UI: M/Esc |
| photo | 0 | frozen | off | UI: H (cameraRig flies 'free' with raw keys in `frame(realDt)`) | UI: H/Esc |
| cutscene | real | frozen | off | player (ferry, bear retreat) | same owner |

- Only UI reacts to pause, map, logbook, help and photo keys. Esc always pauses (or closes the open panel).
- Gameplay-rule systems (fishing, economy, discovery, season radio/opener events, player) act only in `play`. World
  systems keep animating in title and cutscene. `setMode` calls `input.consume()`: keys held across a mode change
  stay inert until released.
- The seiner reads throttle/steer/horn/lights only when `control === 'boat'` and controls are unlocked. Fishing offers
  only when `control === 'boat'`. The player polls Space for jump only when `control === 'foot'`.

### 4.3 Rendering rules (all WPs)

- **Colour.** Shading is linear-sRGB HDR. Tone mapping and sRGB encoding happen once (renderer on the canvas path,
  OutputPass with postfx). Custom shaders end with `#include <tonemapping_fragment>` then
  `#include <colorspace_fragment>`; no manual gamma/ACES. Palette hexes (§9) are sRGB: pass them as
  `new THREE.Color('#0d3140')` uniforms. Canvas/procedural albedo textures: `colorSpace = SRGBColorSpace`; normals,
  masks, heights, foam: NoColorSpace.
- **Fog contract.** `scene.fog` is one `THREE.FogExp2` created in `sky.create()`, afterwards only mutated (`.color`,
  `.density`), never replaced. WP-SKY alone may override `THREE.ShaderChunk.fog_pars_vertex/fog_vertex/
  fog_pars_fragment/fog_fragment` (in create, before anything compiles), referencing only mvPosition, viewMatrix,
  cameraPosition, fogColor, fogDensity (world pos = `(mvPosition.xyz - viewMatrix[3].xyz) * mat3(viewMatrix)`). Every
  custom ShaderMaterial sets `fog: true`, merges `THREE.UniformsLib.fog` into its uniforms, computes `vec4
  mvPosition` before `#include <fog_vertex>`, and includes fog_pars_vertex, fog_vertex, fog_pars_fragment,
  fog_fragment (after lighting). Shaders that cannot use the chunks (sky dome, clouds) use uFogColor/uFogDensity with
  the same formula as sky's chunks. Other WPs may add chunks only as `kodiak_<wp>_*`; never overwrite built-ins.
- **Underwater look.** Every material that can sit below y = 0 (seabed terrain, fish, net web/leadline/rings, kelp,
  whales, pinnipeds, hull bottoms) applies the shared `kodiak_underwater` chunk (see `src/render/shaderChunks.js`;
  built-in materials: `patchUnderwater(material, ctx.uniforms)`). The water surface is a thin layer: opacity ≈
  mix(0.2, 1.0, fresnel) plus foam and reflection, never derived from seabed depth; the body colour comes from the
  attenuated geometry below. WP-OCEAN owns uWaterAbsorb/uWaterScatter values and draws an opaque "abyss" plane at
  y = −40 (uWaterScatter colour) outside the terrain footprint so something is always under the surface.
- **Render order** (set `mesh.renderOrder` on meshes only — never on a Group, which becomes groupOrder):
  opaque: −1000 sky dome/stars/moon (depthWrite false, drawn at the far plane), 0 everything else, 900 water
  occluders (colorWrite false). Transparent: −100 underwater translucency (net web, fish shimmer, bubbles), 0 the
  water surface (WP-OCEAN only, depthWrite true), 100 on-surface decals/foam meshes/kelp mats, 200 FX above the water
  (spray, splashes, wake mist, rain, smoke, exhaust), 300 atmosphere (mist/low-cloud banks, rain curtains), 400
  glows/halos/flares. All transparent materials except the water use `depthWrite: false`. ±49 offsets within a band.
  Screenshot your transparent effects over the real water (not `skip=water`).
- **Reversed-Z.** Do not use the Sky, Water, Water2, Reflector or Refractor add-ons unmodified. Anything drawn "at
  infinity" uses `#ifdef USE_REVERSED_DEPTH_BUFFER gl_Position.z = 0.0; #else gl_Position.z = gl_Position.w; #endif`
  (or renderOrder −1000 with depthTest false). Planar reflections clip with clipping planes, not oblique
  projection. Depth reads use `#include <packing>` / perspectiveDepthToViewZ; never write gl_FragDepth. CPU "in front
  of camera" tests use view space (`p.applyMatrix4(camera.matrixWorldInverse).z < 0`); after `project()`, visible
  means 0 < ndc.z ≤ 1. Reversed-Z only adds precision with a 32F depth attachment (the postfx scene target); on the
  `low` preset (24-bit canvas) cameraRig keeps near ≥ 2 m in boat/title modes.
- **Shared GPU state — single writers.** Core: renderer size, pixelRatio, shadowMap enabled/type/needsUpdate,
  outputColorSpace, toneMapping, info. postfx: `toneMappingExposure` (from daylight, every frame, even when postfx is
  disabled). sky: scene.fog, scene.environment, scene.background, sunLight.shadow.*, built-in fog chunks.
- **Secondary renders** (reflection, foam maps, terrain-shadow compute, env capture) run from `pipeline.beforeRender`
  (sky may capture in update), restore render target/autoClear/clear colour/viewport/scissor, and render only camera
  layer 1 (`LAYER_REFLECT`; meshes opt in with `mesh.layers.enable(1)`) except the reflection pass. View-dependent
  shading uses built-in `cameraPosition`, not uCameraPos.
- **Environment map.** WP-SKY renders a sky-only scene (no sun disc, clouds on, no lights/terrain/particles) with a
  CubeCamera into a persistent `WebGLCubeRenderTarget(256, HalfFloat)`, then `pmrem.fromCubemap(cube, envTarget)` into
  one persistent target, so `sky.envMap` is the same texture object all session and non-null after create. Refresh
  ≤ every 0.5 s: on > 2° sun movement or every 2 s during weather transitions. Publish `sky.envMapDefines` for
  custom shaders sampling CubeUV. Sun specular comes from uSunDir/sunLight, never the env map.

---

## 5. System contract

```js
export async function create(ctx) {
  return {
    update(dt) {},        // every frame, registry order; dt = 0 while paused/map/photo
    lateUpdate(dt) {},    // after all updates (cameras, things following others)
    frame(realDt) {},     // every frame with real time, even when paused (UI, photo camera)
    debugState() {},      // small JSON-safe summary merged into __KODIAK__.state()
    serialize() {},       // JSON-safe persisted state or undefined (see §6.15 save)
    restore(data) {},     // apply serialized state (called by ctx.game.load before start)
    reset() {},           // back to new-game state (called by ctx.game.start({newGame: true}) and load)
    ...publicApi,
  };
}
```

- Order: season, sky, water, terrain, places, fleet, seiner, skiff, net, fish, fishing, wildlife, player, economy,
  discovery, cameraRig, audio, ui, postfx. `name` is reserved (core sets the registry name).
- Core emits **`game:ready`** once after every system exists and before the first frame: do wiring that needs later
  systems there (or lazily in update), never in create except via optional chaining.
- Systems exposing world-space point getters call `object3d.updateMatrixWorld(true)` at the end of update() (or
  compute points analytically), so consumers never read last frame's matrices.
- UI prompts read `ctx.interact.current` in `frame()` (offers resolve after lateUpdate).
- The loader substitutes the stub if the module is a placeholder, throws, or is forced off by `?skip=`/`?only=`;
  `__KODIAK__.systemStatus` reports `ok | ok (missing: …) | placeholder | stub (flag) | failed: …`.

---

## 6. System APIs (public surface — consumers depend on these)

Bold names are REQUIRED (`src/systems/contract.js`); everything else is recommended.
`Catch = { pink, chum, sockeye, coho, king }` (integer fish counts). Every `nearestX` returns
`{ <item>, distance } | null` (`{school, distance}`, `{place, distance}`, `{bear, distance}`, `{tender, distance}`).

### 6.1 `sky` (WP-SKY)
- **`sunDirection`** (= `uniforms.uSunDir.value`), **`moonDirection`**, **`sunLight`** (DirectionalLight; shadow box
  around **`shadowFocus`**, which cameraRig copies its focus into; texel-snapped to avoid shimmer), **`hemiLight`**,
  **`daylight`** 0..1, **`sunElevationDeg`**, **`isNight`**, **`envMap`** (§4.3), `envMapDefines`,
  **`weather`** `{ preset, cloudCover, fog, rain, windDir (heading the wind blows TOWARD), windSpeed m/s, swell,
  visibility m }`, **`setWeather(preset, transitionSeconds = 20)`**: `clear|partly|overcast|fog|rain|storm`.
- Real astronomy for 57.65°N, AKDT (UTC−8), `clock.dayOfYear()` (July: sunrise ~5:00, sunset ~22:30, long twilight;
  late August nights are dark). Moon phase by date.
- Scales `sunLight` intensity by `terrain.sunVisibilityAt(shadowFocus)` so boats darken in mountain shadow.
- Writes uniforms uSunDir, uSunColor, uSkyColor, uHorizonColor, uFogColor, uFogDensity, uDaylight, uWindDir
  (downwind unit x/z), uWindSpeed, uRain, uCloudCover.
- Owns scene.fog (+ fog chunks), sky dome (sun disc/glow, FBM clouds), low cloud/mist banks that wrap peaks at
  120–260 m and pool in bays, stars, moon, aurora (clear dark nights, late season), rain/drizzle near the camera,
  optional lightning.

### 6.2 `postfx` (WP-SKY)
- **`enabled`**, **`setEnabled(bool)`**. When `quality.postfx`: scene pass into `new WebGLRenderTarget(w, h, {type:
  HalfFloatType, samples: 4, depthTexture: new DepthTexture(w, h, FloatType)})` handed to `new EffectComposer(renderer,
  rt)`; subtle bloom (half-res), exposure from daylight, ACES/AgX via OutputPass, mild vignette/grade, optional
  SMAA. Handles resize. Writes `renderer.toneMappingExposure` every frame even when disabled.

### 6.3 `water` (WP-OCEAN)
- **`mesh`**, **`heightAt(x, z)`** (within ~5 cm of the rendered surface), **`sample(x, z, out = {height, normal})`**,
  `velocityAt?(x, z)`.
- **`stamp(x, z, radius (0.5–40 m), strength 0..1, kind = 'foam')`**. `'foam'` is a level, not an increment: max-blended
  into a foam field with a ~4 s half-life, so calling it every frame is frame-rate independent. `'ripple'` is an
  event: one call spawns one expanding ring (≤ 128 live; oldest dropped). The field is a ≥ 1 km square centred on
  `cameraRig.focus` (else the camera); stamps outside are ignored. Calls are queued into preallocated arrays, capped
  at 512 per frame across callers (corklines stamp every 4th node; fleet boats > 1 km away don't stamp). Rain rings,
  whitecaps and shore wash are procedural (uRain, uWaveState, uHeightMap), never stamped.
- **`addOccluder(mesh)`** / **`removeOccluder(mesh)`**: the caller builds a cap/volume in the boat's local space
  covering the hull interior up to the sheer (the open skiff: gunwale), parents it to its object3d, sets
  `visible = false`, and calls `water?.addOccluder?.(mesh)`. WP-OCEAN assigns `MeshBasicMaterial({ colorWrite:
  false, depthWrite: true })`, renderOrder 900, no shadows, main-view layer only, then `visible = true`. No stencil.
- Reads `sky.weather` each frame for sea state; writes `uniforms.uWaveState`, uWaterAbsorb, uWaterScatter.
- Look: layered Gerstner/FFT-style waves (long swell + wind sea + chop) matched by the CPU for the large waves;
  high-frequency detail in normals only, faded with distance (no moiré); fresnel reflection of `sky.envMap`; sun
  glitter path; subsurface tint in crests; turquoise over the shelf, deep blue-green offshore; shoreline foam and
  wash; whitecaps in wind; rain rings; the abyss plane; the ocean continues to the horizon beyond the world edge.
  The camera never renders from below the surface; if it does, fall back to an underwater tint.

### 6.4 `terrain` (WP-TERRAIN)
- **`heightAt(x, z)`** (full-detail), **`surfaceAt(x, z)`** → `'sand'|'gravel'|'grass'|'forest'|'alder'|'rock'|
  'snow'|'water'`, **`forestDensity(x, z)`** 0..1, **`sunVisibilityAt(x, z)`** 0..1 (CPU, e.g. raymarch toward
  uSunDir; cached per sun move).
- `uniforms.uTerrainShadow`: optional GPU sun-occlusion mask, R channel (1 = lit), same uv/orientation as
  uHeightMap, linear, R8/R16F; assign `.value` (no recompile). Terrain and water light themselves from uSunColor ×
  uTerrainShadow; mountain shadows fall across valleys and onto the water at low sun.
- Look: summer Kodiak — vivid emerald grass and alder; dark Sitka spruce in the north-east (Kodiak city/Chiniak,
  Afognak, Shuyak, Spruce and Woody islands), treeless to the south-west; grey-brown rock on steep slopes and cliffs;
  snow patches on the highest peaks and north gullies (more on the Peninsula volcanoes); gravel/sand beaches with
  driftwood; kelp beds just offshore; fireweed and lupine patches. Slope/height/aspect splatting with procedural
  detail, triplanar cliffs, correct fog, seabed with `kodiak_underwater`.
- LOD per §3 (≤ 0.3 m error within 600 m, ≤ 2 m within 3 km, morph without popping; vegetation uses the same
  surface). No vegetation on `isDeveloped(x, z, ctx.geo)` from `src/data/places.js`.

### 6.5 `places` (WP-PLACES)
- **Data** (`src/data/places.js`, exports frozen): `PLACES`, `STREAMS`, `DISTRICTS`, `FOOTPRINTS`, `CLOSED_AREAS`,
  `resolve(geo)`, `isDeveloped(x, z, geo)`, `pointInPolygon`. See the file header for field shapes.
  - 60–90 places (§8.4). Blurbs: 1–3 true, specific sentences presenting Kodiak's Alutiiq (Sugpiaq) people and
    history alongside the Russian and American periods (Alutiiq names where in common use; the 1964 earthquake and
    tsunami — Afognak village relocated to found Port Lions, Kaguyak destroyed, Old Harbor rebuilt; the 1912 Novarupta
    ashfall), ecology and fishing lore. Awa'uq (Refuge Rock, 1784 massacre) is a `memorial` entry: quiet logbook
    card, no bonus, no toast, no landing.
  - `STREAMS` with `closedRadius` 150–350 game m; ADF&G closed-waters markers stand at the boundary.
  - `CLOSED_AREAS` includes the Marmot Island Steller sea lion rookery buffer (~470 m game radius, federal
    3-nm no-approach zone); the sea lions are discovered by binoculars from outside it.
  - Hatcheries: Kitoi Bay (Izhut Bay, Afognak) and Pillar Creek.
  - `onFoot` places carry a `landing` beach reachable under the on-foot slope limits (§6.14; tested).
- System: **`list`** (resolved), **`get(id)`**, **`nearest(x, z, filter?)`**, **`within(x, z, r, filter?)`**,
  **`streams`**, `districts`, `closedAreas`, **`districtAt(x, z)`** → name, **`spawn`** `{x, z, heading}` (St. Paul
  Harbor approaches, open water).
- 3D: charming low-poly but detailed settlements at true scale: City of Kodiak (houses on the hills, cannery row on
  pilings, St. Paul & St. Herman harbors with masts, Holy Resurrection Cathedral with blue onion domes, the six
  Pillar Mountain wind turbines turning, Near Island bridge), villages (Ouzinkie, Port Lions, Old Harbor, Larsen Bay,
  Akhiok, Karluk — each with its church), canneries (Larsen Bay, Alitak/Lazy Bay, Uganik), Coast Guard Base Kodiak,
  the Pacific Spaceport launch tower at Narrow Cape, WWII bunkers at Fort Abercrombie, cape lights and channel buoys
  that blink at night, closed-waters markers, lit windows at night, chimney smoke. Instance/merge to stay in budget.

### 6.6 `fleet` (WP-BOATS)
- **`tenders`**: `[{ id, name, placeId, position, heading, object3d, buying, radius, services }]` — 4–6 anchored
  tenders (70–120 ft packers) on the grounds; they sell fuel (+$0.40/gal) and buy fish (`season.priceFor`).
- **`nearestTender(x, z)`**, **`boats`**: ambient vessels — 8 named fleet seiners (working, running, making sets
  with visible corklines at a distance), a ferry on the Kodiak route, a Coast Guard cutter near Womens Bay, skiffs.
  Waypoint AI, lights at night, collision radius. Fleet seiners also carry the fleet-board names (§8.3).

### 6.7 `seiner` (WP-BOATS)
- **`object3d`**, **`position`** (waterline centre), **`heading`**, **`speed`** (m/s signed), **`velocity`**,
  **`throttle`**, **`rudder`**, **`maxSpeed`** (getter: `economy.modifiers.maxSpeed` ?? base), **`speedLimit`**
  (getter: min over owners), **`setSpeedLimit(owner, mps | null)`** (owners: 'fishing', 'fuel', 'mooring'),
  **`controlsEnabled`** (getter: no locks), **`lockControls(owner, locked)`** (owners: 'fishing', 'player',
  'cutscene'), **`mooring`** (`null | {kind: 'anchor'} | {kind: 'dock', placeId}`), **`anchored`** (getter),
  **`setMooring(m)`** (emits `boat:mooring`; the seiner clears its own mooring when the player applies throttle with
  controls unlocked), **`grounded`**, **`engineLoad`** 0..1, **`deckLights`** (N toggles; owned here),
  **`boatName`**, **`setBoatName(n)`** (redraws hull lettering; default "Northern Dawn"), **`forward(out)`**,
  **`sternPoint(out)`**, **`bowPoint(out)`**, **`powerBlockPoint(out)`**, **`skiffMountPoint(out)`**,
  **`setPose(x, z, heading)`**, **`horn()`** (emits `boat:horn`).
- Physics: buoyancy/pitch/roll from `water.sample` at several hull points, inertia, rudder needs way on, drift with
  `ctx.tide.currentAt` and wind when slow, grounding when depth < `config.boat.groundingDepth` (stop, bump,
  `boat:collision`), circle collisions with tenders/fleet, soft boundary push. Wake/bow spray via `water.stamp`.
- Model: a proper Alaska limit seiner — white hull with a coloured sheer stripe, raised foc'sle, wheelhouse (lit
  windows at night), flying bridge, mast and boom with the power block, radar dome, antennas, seine piled on the
  stern deck (web + corks), the aluminium skiff on the stern ramp, rigging, running lights, deck floods, 2 deckhands
  on deck in orange rain gear (the skiffman rides the skiff) with simple procedural animation, name on bow/stern.
  Hull occluder per §6.3.

### 6.8 `skiff` (WP-BOATS)
- **`object3d`**, **`position`**, **`heading`**, **`state`**: `'stowed'|'released'|'holding'|'tied'|'towing'|
  'closing'|'towingOff'|'returning'|'ferry'`, **`busy`**.
- **`release()`** (drops off the stern ramp with a splash; holds the skiff end), **`holdAt(x, z)`**,
  **`towToward(x, z, effort)`** (keep the net open against `ctx.tide.currentAt`), **`tieOff(point)`** (runs the end
  ashore, state 'tied'), **`closeTo(object3d | Vector3, onArrive)`** (brings its end to the seiner),
  **`towOff(seiner, side: 'port'|'starboard')`** (after close-up: a line on the far side, pulls the seiner off the
  net), **`setTowHeading(h)`** (A/D aim the pull during pursing/hauling), **`returnTo(onArrive)`** (back to the
  ramp → 'stowed'), **`stow()`** (instant), **`ferry(from, to, onArrive)`** (on-foot WP), **`endPoint(out)`** (where
  the seine attaches).
- Model: aluminium seine skiff, big inboard, towing bitt, skiffman figure; wake via stamps; occluder.

### 6.9 `cameraRig` (WP-BOATS)
- **`mode`**: `'chase'|'crowsnest'|'bridge'|'foot'|'title'|'free'`, **`setMode(mode)`**, **`cycle()`** (C: chase →
  crowsnest (high top-down, best for setting) → bridge), **`suggest(mode)`** (fishing suggests 'crowsnest' on skiff
  release; ignored if C was pressed in the last 10 s), **`setTarget(object3d | null)`**, **`focus`** Vector3 (copied
  into `sky.shadowFocus`), **`shake(amount)`**, **`binoculars`** bool (hold B/right mouse: fov to ~12°).
- The rig owns its mode: follows `game:mode` (title → 'title', photo → 'free', play → last gameplay mode) and
  `player:mode` (foot ↔ chase) itself. Snaps without smoothing on `boat:teleport`.
- Mouse drag orbits, wheel zooms, recenters behind after ~3 s idle; gamepad right stick. Never below water (+1.5 m)
  or inside terrain (+2 m). Smooth and weighty. Binoculars: holding the view on a jump for ~1 s logs a sighting
  (`discovery.addSighting({schoolId, species, heading})`) and a fading marker on the compass strip/chart.
- 'title': slow cinematic loop of 5–7 golden-hour shots of real places (the seiner leaving Kodiak, Shelikof cliffs,
  Uyak Bay, peaks above Olga Bay …). Honours `ctx.debug.cameraOverride`.

### 6.10 `fish` (WP-FISH)
- **`schools`**: `[{ id, species, mix: Catch, count, position (y = −depth), velocity, radius, depth, state:
  'migrating'|'milling'|'spooked'|'sounding'|'trapped'|'captured'|'gone', targetStream, jumpRate }]`.
- **`nearestSchool(x, z, maxDist)`**, **`schoolsWithin(x, z, r)`**, **`schoolsInside(polygon)`**, **`harvest()`** →
  Catch of fish still inside the pursed net (marks schools captured; called once by fishing at brailing),
  **`sonarReturns(x, z, range)`** → `[{x, z, depth, strength}]` (marks and depth only; no species),
  **`spawnSchool({x, z, species, count, milling})`**.
- Numbers come from `config.fish.species` (count, radius, depth, speed, jumpsPerMin, capture, leadlineEscape) and
  `config.fish.runs`. 12–25 run-driven schools alive, weighted by `season.speciesMix` and `places.streams`: they come
  in from offshore, follow the coast with the flood (`ctx.tide`), mill off points and at bay heads, and head for
  their stream as the run peaks; they mill with jumpRate ×1.5 within 30 game min of slack. **During an open period
  at least 2 catchable schools** (outside closed waters, depth ≥ 8 m) exist within 1,500 m of the seiner (spawned
  ≥ 600 m away, out of view). On a new season, a milling pink school spawns 500–700 m from the spawn with
  jumpRate ×3 and spooking disabled (the tutorial set).
- **Jump signatures** (the core skill): pink — short, low, frequent "popcorn" jumps, small splash; sockeye — clean
  straight leap, head-first re-entry, little splash; chum — heavy jump falling flat on its side, big splash, plus
  finning V-wakes when milling; coho — high, twisting, repeated tail-walking jumps; king — rarely jumps. Every jump
  points within ±25° of the school's velocity. Splash/spray render at max(real size, 0.004 × distance) with a
  sun-glint flash; ripples persist 4–6 s: jumps read to ~800 m by eye and ~3 km in binoculars. Emits `fish:jump`.
- **Spooking**: speed > 8 m/s within 40 m, any hull crossing the school radius above 2 m/s, the horn within 150 m, or
  the skiff splash within 20 m. Paying out at ≤ 7 m/s outside the school radius never spooks. Repeated spooks make
  chum/sockeye sound (dive).
- **With the net** (reads `ctx.systems.net`): fish meeting the web are deflected along it; in a hook they mill in the
  bight; near the open gap they run for it; in a closed unpursed net they escape under the leadline at a rate that
  falls as `net.pursed` → 1, scaled by species `leadlineEscape` and × (1 − 0.8 · bottomContact on smooth bottom);
  once pursed they are trapped. Targets: a clean set captures 60–85% (pink/chum) or 40–70% (sockeye/coho); a sloppy
  set 15–40%; a water haul only if the school was outside at close-up or sounded. Emits `fishing:escape`.
  During hauling, trapped fish crowd the shrinking bag beside the seiner — dense, thrashing, splashing — until
  brailed (the money shot).
- Rendering: instanced procedural salmon per species (vertex-shader swimming, marine-bright colouring with species
  cues), individual fish only near the camera (budgeted), dark shimmering shapes under the surface when close
  (`kodiak_underwater`), jumpers at any visible distance.

### 6.11 `net` (WP-NET)
- **`state`**: `'stowed'|'paying'|'out'|'closed'|'pursing'|'hauling'|'brailing'`, **`length`**, **`depth`** (both
  re-read from `economy.modifiers` only while stowed), **`payout`**, **`pursed`** 0..1, **`hauled`** 0..1,
  **`bottomContact`** 0..1 (fraction of leadline resting on the seabed), **`corkline`** (Vector3[]),
  **`polygon()`** → `[{x, z}]` (corkline + gap segment) or null, **`gap()`** → `{a, b, width}` or null,
  **`containsPoint(x, z)`**, commands **`begin(endAnchor)`**, **`close()`**, **`purse(rate)`**, **`haul(rate)`**,
  **`stow()`**.
- Bottom: on smooth seabed (`heightmap.seabedAt`: mud/sand/gravel) contact seals the net (see §6.10) and pursing is
  20% slower; on rock it hangs up: snag chance per second = 0.02 · bottomContact · rockFraction · pursingSpeed; a
  snag stalls pursing 5–10 s, emits `fishing:snag` (via fishing) and opens a hole (+25% escape) until hauled.
- Simulation: chain of floating corkline nodes following `water.heightAt`, distance constraints, drag and
  `ctx.tide.currentAt` drift, paid out from `seiner.sternPoint`; web to `depth` or the seabed, leadline, purse rings;
  pursing draws the rings together; hauling feeds the net up through the power block onto the stern pile.
- Rendering: yellow/white corks (instanced), corkline, translucent dark-green web visible under water (render band
  −100, `kodiak_underwater`), purse rings, the net rising through the block; foam stamps around the bag.

### 6.12 `fishing` (WP-NET) — the set
- **`state`**: `'idle'|'setting'|'holding'|'closing'|'pursing'|'hauling'|'brailing'|'report'`, **`setNumber`**,
  **`lastSet`**, **`canSet()`** → `{ok, reason}`, **`abort()`** (haul back → water haul), **`hud`**: `{ phase,
  payout 0..1, distanceToSkiff, tension 0..1, tensionBand [lo, hi], pursed, hauled, inHook (±30% estimate),
  holdSeconds, depthUnderStern, bottomWarning, towHeading, message }` for the UI.
- Sequence (offers via `ctx.interact`, priority 100, only when `control === 'boat'`):
  1. **idle** → Space "Let 'er go!" (requires `season.openerActive(x, z)` or free explore, depth > 6 m, skiff stowed).
     Closed waters warn first; setting there risks an Alaska Wildlife Trooper citation (fine, catch forfeited)
     announced on the radio. If the drop point is ≤ 40 m from shore, E offers "Tie off to the beach"
     (`skiff.tieOff`). Fishing suggests the crow's-nest camera.
  2. **setting**: the net pays out as the seiner moves (speed limited to 7 m/s). Round haul = circle back to the skiff;
     hook = lay out from the beach/point and turn back against the fish's travel into a J.
  3. **holding**: automatic at full payout, or Space "Hold the hook" once payout ≥ 60%. Seiner speed limit 1.5 m/s,
     towing its end; an untied skiff tows its end against the current. Fish meeting the web are deflected into the
     hook and mill there; HUD shows "In the hook: ~N" and hold time. If current collapses the hook below 40% of its
     best area, fish leak faster.
  4. **closing**: Space "Close up" within `config.net.closeDistance` of the skiff end (round haul) or any time while
     holding (hook); a tied skiff unties and brings its end.
  5. **pursing**: `skiff.towOff` pulls the seiner off the net; the seiner's controls are locked and A/D aim the skiff's
     pull (`skiff.setTowHeading`). If the stern drifts over the corkline for > 3 s: "Net's in the wheel!" — pursing
     stalls 6 s. Hold E to run the purse winch: a tension gauge rewards steady hauling (too fast → "rings fouled",
     brief stall; too slow → more escape). "Rings up!" when done.
  6. **hauling**: the block hauls automatically (E speeds it up; above 80% in current, corks go under and fish
     escape); the player keeps steering the skiff's pull until the bag is dried up.
  7. **brailing**: `fish.harvest()` once, kings released, `economy.addCatch(counts)` once, animate the brailer
     count-up to the accepted totals (overflow: "Plugged! Let N go over the corks"); Space skips.
  8. **report**: emit `fishing:setComplete`; skiff returns and is stowed; idle.
- Phase targets (real seconds): lay-out 45–60, hold 0–90, close-up 8–12, purse 15–25, haul 25–35, brail 1 s per
  1,500 lb (≤ 15). A set is ~3 real minutes; a fishing day allows 4–5 sets plus running and deliveries. Fishing never
  changes global time; rates come from `economy.modifiers.purseRate/haulRate`.
- Abort: the pause menu shows "Abort set" (calls `abort()`), or hold Backspace 1 s. Esc always pauses.
- `boat:teleport` during a set → abort to idle, net and skiff stowed.
- Tutorial: radio hints from an old hand ("Uncle Pete") on the first set, via `ui.hint`.

### 6.13 `wildlife` (WP-WILDLIFE)
- **`bears`**, **`whales`**, **`birds`** (`[{ id, kind, position, heading, state }]`), **`nearestBear(x, z)`**.
- Kodiak brown bears (sows with cubs) fishing at stream mouths and walking beaches on `terrain.heightAt`; bald eagles
  soaring/perched; glaucous-winged gulls following the seiner and "working" over schools (and 30% of working flocks
  are over bait with no salmon), swarming the bag during hauling; tufted puffins on rocky islets; humpback whales
  (distant blows, breaches, fluke-up dives, occasional bubble-net feeding); rare orca pod; sea otter rafts in kelp;
  Steller sea lions on haulouts (Marmot Island rookery behind its buffer); harbor seals; Sitka black-tailed deer;
  mountain goats on high cliffs (optional).
- Owns bear encounters: reads `ctx.game.avatar()` when on foot; within ~30 m a bear stands and watches, emitting
  `bear:encounter {stage: 'watch', bearId}`; if the player keeps closing to ~10 m, a bluff charge (`stage:
  'charge'`); `stage: 'retreat'` when it ends. Emits `wildlife:sighted {kind, x, z, first}` when a kind is first seen
  well (in view, within ~150 m, or via binoculars). Instanced, LOD'd and culled.

### 6.14 `player` (WP-FOOT)
- **`active`**, **`object3d`**, **`position`**, **`canGoAshore()`** → `{ok, reason, landing}`, **`goAshore()`**,
  **`returnToBoat()`**. Only `player` writes `ctx.state.control` (emits `player:mode`).
- "E — Go ashore" (priority 40) when the seiner is nearly stopped within ~150 m of a walkable beach, fishing idle,
  skiff stowed: `skiff.ferry` (short cutscene), the seiner anchors (`setMooring({kind: 'anchor'})`) and locks
  controls ('player'). On foot: WASD relative to the camera, Shift run, Space jump, mouse orbit; walk at full speed
  ≤ 35°, slowing linearly to 50°, scramble at 30% speed up to 58°, slide above; wade to knee depth only; footsteps
  (`player:step {surface, run}`). Back to the landing skiff: "E — Back to the boat". On `bear:encounter` 'charge':
  fade, return to the skiff, radio quip. On `boat:teleport`: return aboard.
- Character: procedural deckhand in orange bibs, XtraTuf boots, beanie; procedural walk/run/jump.
- Peaks and viewpoints reached on foot act as spotting perches: for the rest of that game day, jumpers within 3 km
  in line of sight of the summit show on the chart (`discovery.addPerch(placeId)`).

### 6.15 `season`, `economy`, `discovery`, save (WP-RULES) and `ui` (WP-UI)
- `season`: **`openerActive(x?, z?)`** (the only authority: fishing day per `config.season.fishingDays`, 06:00–22:00,
  district-aware, always true in free explore), **`nextOpener()`** → `{day, hours, districts}`, **`speciesMix(x,
  z)`** (by date via `config.fish.runs` and nearby streams/districts: sockeye strongest at Karluk, Ayakulik, Upper
  Station and enhanced Spiridon/Telrod Cove and Kitoi fish; pinks strongest Northwest Kodiak, Eastside, near Kitoi;
  chum in bays; coho late at Kitoi/Afognak), **`priceFor(species, tenderId?)`** (daily ±15%, + RSW bonus; king 0),
  **`forecast()`** → `{today, tomorrow, text}`, **`closedWaters`** `[{id, streamId, x, z, radius}]` (streams +
  `CLOSED_AREAS`), **`isClosedWater(x, z)`**. Emits `opener:start/end`; ADF&G announces each period on the radio the
  evening before; "E — Wait for the opener" at anchor/harbour on closed days (`clock.skip` to 05:00 of the next
  fishing day). Daily weather schedule via `sky.setWeather` (never while `debug.weatherPinned`). Radio library: fleet
  chatter on a working channel (e.g. 10), tender prices/deliveries on the tender's channel, USCG/ADF&G securité on 16
  ("switch to 22 Alpha"), NOAA forecasts on WX. Recomputes on `time:skip`.
- `economy`: **`cash`**, **`hold`** (Catch), **`holdLbs()`**, **`capacityLbs`**, **`fuel`**, **`fuelCapacity`**,
  **`fuelEmpty`**, **`upgrades`**, **`modifiers`** (read-only: `{ maxSpeed, netLength, netDepth, purseRate, haulRate,
  sonarRange, holdLbs, rswBonus, deckLights, spotterUntilDay }`, recomputed on buy/restore/reset),
  **`catalog`**, **`stats`** (`{ seasonGross, sets, deliveries, bestSetLbs, … }`), **`addCatch(counts)`** →
  `{accepted: Catch, overflow: Catch, acceptedLbs}`, **`deliver(tender)`** → receipt, **`refuel(source)`**,
  **`buy(id)`**, **`addCash(delta, reason)`**, **`useFuel(gallons, reason)`**. lbs = count × species lbs (no variance).
  Fuel burns 38 × engineLoad^1.5 + 1.5 gal/game-h; warnings at 20%/10%; at 0 the seiner limps (`setSpeedLimit('fuel',
  2)`) and the nearest tender radios an offer: "E — Accept a tow" → fade, placed alongside, $750 + fill to 25%. Cash
  may go to −$10,000 as a cannery advance (red; repaid from fish tickets); purchases need positive cash. No game
  over. Offers: "E — Deliver to <tender>" (priority 60: < 35 m, < 2 m/s, fishing idle, hold not empty), "E — Tie up
  at <harbour>" (places with services). Free explore: no fuel burn, no fines.
- `discovery`: **`discovered`** Set, **`sightings`**, **`isDiscovered(id)`**, **`discover(id)`**, **`progress()`**,
  `addSighting(s)`, `addPerch(placeId)`, `intel` (chart notes). Entering a place radius discovers it (toast + logbook
  card + $25–$100 token); discovering a stream, bay or cape adds its run-timing card and a hot-spot note to the
  chart ("humpies stack up off Cape Ugat on the flood"). Memorial places: quiet card only.
- `ui`: **`visible`**, **`toast(text, opts)`**, **`radio(from, text, channel)`**, **`hint(id, text)`** (once per save),
  **`openMap()`**, **`openLogbook()`**. UI renders toasts, radio, hints, set reports and fish tickets **only from
  events** (`ui:toast`, `ui:radio`, `ui:hint`, `fishing:setComplete`, `economy:delivered`); the methods just emit.
  Title (logo, Continue/New Season/Free Explore/Settings/Controls/Credits incl. data attribution, boat name), HUD
  (date/time, opener status/next opener, tide stage, cash, hold gauge, fuel, speed/heading, compass strip with
  waypoint and sighting markers, sonar (`fish.sonarReturns`, range from modifiers), prompts from `interact.current`,
  fishing widgets from `fishing.hud`: payout, distance to skiff, hold time/in-the-hook, purse tension, haul,
  skiff-pull arrow, depth under stern/"Leads on bottom — rocky!"), toasts, VHF captions, map (nautical chart from the
  heightmap: contours, soundings flavour, discovered names, districts, tenders, closed waters shaded, waypoint, intel
  notes, sightings, fast travel), logbook, set report, fish ticket (fields: date, district/stat area, permit
  S01K-xxxxx, gear 01 purse seine, condition RSW, species codes 410/420/430/440/450, lbs, price, value, crew share),
  harbour menu (upgrades, fuel, sleep), pause/settings (quality → reload, volumes, time speed, invert Y; "Abort set"
  while fishing), help, photo mode, fleet board, season goals. `#ui` children default to pointer-events none;
  interactive widgets use `.ui-interactive`.
- Sleep: offer id 'sleep', priority 70, when `hours ≥ 22 || hours < 4`, moored, control 'boat', fishing idle →
  `clock.skip` to 05:00, autosave. Fast travel (map): only with control 'boat', fishing idle, skiff stowed; target =
  a place's dock or a tender standoff (`nearestWater({minShore: 40})`); cost = `clock.skip(distance / (0.7 ×
  maxSpeed) / 3600)` hours and matching fuel at 60% load; then `game.teleport`.
- Save (`src/game/save.js`): localStorage `kodiak-seiner:save` = `ctx.game.snapshot()`; autosave on delivery, sleep,
  tie-up and on `game:toTitle` (only when snapshot is non-null); Continue = `ctx.game.load(save)`. Settings:
  `kodiak-seiner:settings = { quality, volumes, timeSpeed, invertY }`. Free Explore saves only discovery under
  `kodiak-seiner:explore`. Persisted per system via serialize/restore: seiner `{x, z, heading, name, mooring}`,
  economy `{cash, hold, fuel, upgrades, stats}`, discovery `{discovered, sightings, intel}`, fishing `{setNumber,
  lastSet, stats}`, ui `{hintsShown, waypoint}`, season (fleet board). Fish, fleet positions, wildlife, net, skiff
  are not saved.

### 6.16 `audio` (WP-AUDIO)
- **`unlock()`**, **`play(name, {position, volume, rate})`**, **`setVolumes({master, music, sfx, ambience})`**,
  **`muted`**. Procedural WebAudio: ocean and shore wash, wind, rain, diesel engine (engineLoad), skiff outboard,
  hydraulic whine (pursing/hauling), splashes, gulls, eagles, whale blows, distant bears, footsteps by surface,
  horn, radio squelch before captions, cash register on delivery, UI clicks; gentle generative music (title, dawn,
  big set). Positional sounds use the camera as listener.

### 6.17 Keys
Space (`action`): fishing (let go, hold the hook, close up, skip brail) when on the boat; jump on foot.
E (`interact`): fishing holds (purse, haul), tie off, deliver/dock/sleep/wait (RULES), go ashore/back (FOOT),
inspect landmarks. Discrete presses always go through `ctx.interact`; poll `input.action` only for your own active
hold mechanic.

---

## 7. Events

Single emitter per event unless noted. Add new events freely; document them in your notes.

| event | payload | emitter |
|---|---|---|
| `game:ready` | `{}` | core |
| `game:mode` | `{ mode, prev }` | core |
| `game:start` | `{ newGame, freeExplore }` | core |
| `game:toTitle` | `{}` | core |
| `boat:teleport` | `{ x, z, heading, reason }` | core |
| `time:hour` / `time:day` | `{ day, hour }` / `{ day }` | core clock |
| `time:skip` | `{ fromDay, fromHours, day, hours, reason }` | core clock |
| `opener:start` / `opener:end` | `{ day }` | season |
| `weather:change` | `{ preset }` | sky |
| `place:discovered` | `{ id, name, kind, memorial }` | discovery |
| `place:enter` / `place:leave` | `{ id }` | discovery |
| `wildlife:sighted` | `{ kind, x, z, first }` | wildlife |
| `bear:encounter` | `{ stage: 'watch'|'charge'|'retreat', bearId, x, z }` | wildlife |
| `fish:jump` | `{ x, y, z, species, size, schoolId, heading, style }` | fish |
| `fish:spooked` | `{ schoolId, x, z }` | fish |
| `fishing:escape` | `{ count, species }` | fish |
| `fishing:state` | `{ state, prev }` | fishing |
| `fishing:skiffReleased` | `{ x, z }` | fishing |
| `fishing:closedUp` | `{ polygon, estimate }` | fishing |
| `fishing:snag` | `{ x, z }` | fishing |
| `fishing:setComplete` | `{ setNumber, caught: Catch, accepted: Catch, released: Catch (kings + overflow), lbs: {species: lbs}, totalLbs, value, minutes, waterHaul, rating: 'water haul'|'fair'|'good'|'plugged', cited }` | fishing |
| `economy:cash` | `{ cash, delta, reason }` | economy |
| `economy:delivered` | `{ ticket, date, tender, district, lines: [{species, code, count, lbs, price, value}], gross, crewShare, net }` | economy |
| `economy:holdFull` | `{}` | economy |
| `economy:purchase` | `{ id }` | economy |
| `economy:fuel` | `{ fuel, empty }` | economy |
| `boat:collision` | `{ speed, x, z, kind: 'ground'|'boat' }` | seiner |
| `boat:horn` | `{}` | seiner |
| `boat:mooring` | `{ mooring }` | seiner |
| `player:mode` | `{ control: 'boat'|'foot' }` | player |
| `player:step` | `{ surface, run }` | player |
| `ui:toast` | `{ text, kind, duration }` | anyone |
| `ui:radio` | `{ from, text, channel }` | anyone |
| `ui:hint` | `{ id, text }` | anyone |

---

## 8. Game design

### 8.1 Session flow and calendar
Title (cinematic, golden hour) → New Season: day 0 = **July 6**, the Kodiak general, pink-focused opening; 05:30,
the seiner in the St. Paul Harbor approaches with $2,500, 3,000 gal of fuel, an empty hold, and a radio welcome that
points to a milling pink school nearby (the tutorial set). The season is a schedule of ADF&G fishing periods
(`config.season.fishingDays`: days 0, 2, 5, 9, 13, 17, 21, 25, 29, 34, 40, 47 — Jul 6 → Aug 22), open 06:00–22:00 on
those days; waters are closed between periods — explore, deliver, upgrade, or wait at anchor for the opener. A full
season is ~12 fishing days (~3.5 real hours). Free Explore: fishing always open, no fuel use, discoveries only.

### 8.2 Species and runs (numbers in `config.fish`)
| species | lbs | $/lb | runs (day 0 = Jul 6) | spotting |
|---|---|---|---|---|
| pink (humpy) | 3.6 | 0.32 | 0–50, peak 20–35, everywhere; big schools (median 5,000) | popcorn jumpers everywhere |
| chum (dog) | 8.5 | 0.55 | 0–35, bays and heads | heavy flat jumps, finning |
| sockeye (red) | 6.0 | 1.15 | late runs 0–45: Karluk, Ayakulik, Upper Station, Spiridon, Kitoi | few clean leaps; deep; escape under the lead |
| coho (silver) | 7.5 | 0.95 | 35–75, Kitoi/Afognak and bays | acrobatic tail-walkers |
| king (chinook) | — | — | rare bycatch; ≥ 28 in must be released | rarely jumps |
Good sets gross ~$3k–7k (pink 5,000 × 3.6 × $0.32 ≈ $5.8k). A plugged set can overflow the 60,000 lb hold.

### 8.3 Money and progression
Delivery pays lbs × price per species; the crew (skiffman + 2 deckhands, 10% each) takes 30%, shown on the fish
ticket. Fuel $4.60/gal in town, +$0.40 elsewhere (Kodiak, Port Lions, Old Harbor, Larsen Bay and Alitak canneries,
every tender). Upgrades (Kodiak harbour): purse winch (~$6k, affordable after the second delivery), bigger power
block, engine rebuild / new engine ($20–25k), deeper seine (cap ~22 m / 325 meshes), longer seine (cap 457 m / 250
fathoms; gear shown in fathoms), sonar range tiers (150 → 300 → 500 m; marks and depth only), RSW (+price), hold
expansion, deck lights, spotter-plane day charters (reveal schools on the chart; not allowed in the Mainland
District). Goals on `stats.seasonGross` (`config.economy.goals`): $10k "Covered the grub and fuel bill" (~25 min),
$40k "Permit loan paid off" (~1.5 h), $75k "Made the boat payment" (~2.5 h), and **Highliner** = first place on the
fleet board (8 named fleet seiners whose gross advances each fishing day around 0.8× a competent player's rate, the
top boat 1.2×; tenders radio the daily deliveries).

### 8.4 Exploration
60–90 places: all towns and villages, canneries, hatcheries, every major bay and strait (Uyak, Uganik, Kupreanof
Strait, Viekoda, Kizhuyak, Chiniak, Ugak, Kiliuda, Sitkalidak Strait, Three Saints, Kaguyak, Alitak, Olga, Deadman,
Sturgeon, Karluk, Shelikof Strait, Marmot, Izhut, Kazakof …), capes (Chiniak, Greville, Barnabas, Alitak, Ikolik,
Karluk, Uganik, Ugat, Kuliuk, Spruce Cape …), peaks (Koniag Peak, Barometer Mountain, Pillar Mountain), lakes (Karluk,
Frazer, Red, Akalura), history (Three Saints Bay 1784, Fort Abercrombie, the 1964 tsunami, Awa'uq memorial),
wildlife spots (O'Malley bear viewing, Marmot Island sea lions behind the buffer, puffin islets), viewpoints on foot.
Discovery gives a toast, a logbook card and intel; closed days between periods are the intended time to explore.

### 8.5 Controls
W/S throttle, A/D rudder (A/D aim the skiff's pull while pursing/hauling), mouse drag orbit, wheel zoom, C camera, B
or right mouse binoculars, Space let go / hold the hook / close up / jump, E interact/hold, M map, L logbook, G horn,
N deck lights, H photo mode, Esc pause, F1 help. Gamepad: left stick drive, right stick look, A action, X interact,
Y camera, LB binoculars, B horn, Start pause.

---

## 9. Look bible and budgets

- **Palette (sRGB).** Sea: deep teal-navy offshore (#0d3140 → #11485a), green-teal in bays, turquoise over the shelf
  (#2b8a86) with visible gravel; white foam. Land: emerald summer grass (#4f8a3a → #7fb35a in sun), alder (#3c6b2e),
  spruce (#1f3a26), rock (#5b5751), snow (#eef2f6). Sky: pale cold blue at noon, peach/gold at golden hour (sun
  #ffb070), dusky violet twilight.
- **Light.** Golden hour is the signature (long July sunsets). Mountain shadows across valleys and onto the water at
  low sun. Midday is crisp. Overcast is moody and soft with low cloud clinging to mountains.
- **Atmosphere.** Aerial perspective is essential: distant ridges fade to blue-grey; the Peninsula volcanoes are pale
  silhouettes across Shelikof Strait; height fog pools in bays in the morning.
- **Water** is the star: glitter path, reflections, swell the boat rides, lingering wakes, beach foam, rain rings.
- **Life.** Always something moving: jumpers, gulls, eagles, a distant blow, another boat, turning turbines, nav
  lights blinking at night.
- **UI.** Nautical and quiet: translucent dark panels, off-white text, one accent (safety orange #ff7a1a), a serif for
  titles (Georgia/Iowan Old Style), a clean sans for data, monospace digits for gauges. Minimal HUD; photo mode hides
  all.

**Budgets** (1280×720, pixel ratio 1, M-series, `--bench`): frame ≤ 16.7 ms average, p95 ≤ 20 ms with everything on.
Per WP (CPU + GPU): sky+postfx 2.5 ms, water 2.5, terrain+vegetation 3.5, places 1, boats+fleet 1, fish 1.5, net 1,
wildlife 1.5, UI 0.5 (DOM writes ≤ 10 Hz except prompts) — 3 ms headroom. Shadow-map drawing counts against the owner
of each caster; casters stay within the shadow box or are chunked for culling. Draw calls ≤ 600, triangles ≤ 4 M.
Evidence: `perf().systemsMs[<you>]` for CPU, the `gpuMs` delta with and without your system for GPU (note whether
other smoke runs were active — the GPU is shared).

---

## 10. Testing and verification (every WP)

1. **Unit tests** (`tests/<wp>.test.mjs`, node:test): put pure logic (maths, state machines, economy, data
   validation) in modules that import no DOM/WebGL. `tests/contract.test.mjs` exports `fakeCtx()` for Node-side
   construction.
2. **Smoke scenarios** (`tests/scenarios/<wp>-*.json`) exercise your feature end-to-end with screenshots at
   meaningful moments (times of day and weather where relevant):
   `node tools/smoke.mjs --scenario=tests/scenarios/<file>.json --out=qa/<wp>/<name> [--bench]`. **Look at your
   screenshots** (Read the PNGs) and iterate until genuinely beautiful — this is a visual game.
3. **Clean runs:** no console errors or warnings from your system (`--strict`), no failed systems, perf in budget.
4. **Isolation:** if another WP's system breaks your run, isolate with `--params="skip=<name>"` and note it.
5. **Notes:** `notes/WP-<NAME>.md` — summary, API as built (and deviations), tunables, known issues, perf numbers,
   screenshot paths, requests to other WPs.

Debug API (`window.__KODIAK__`): `start(opts)`, `setTime(h, day)`, `setWeather(p)`, `teleport(x, z, deg)`,
`teleportTo(lat, lon, deg)`, `camera(pos, look)` / `camera(null)`, `perf()`, `state()`, `systems`, `systemStatus`,
`errors`, `warnings`, `ctx`. URL flags per §4.1.

---

## 11. Work packages and file ownership

| WP | owns | builds |
|---|---|---|
| WP-SKY | `src/world/sky.js`, `src/world/sky/**`, `src/render/postfx.js`, `src/render/postfx/**` | §6.1, §6.2 |
| WP-OCEAN | `src/world/water.js`, `src/world/water/**` | §6.3 |
| WP-TERRAIN | `src/world/terrain.js`, `src/world/terrain/**` | §6.4 |
| WP-PLACES | `src/world/places.js`, `src/world/places/**`, contents of `src/data/places.js` | §6.5 |
| WP-BOATS | `src/entities/seiner.js`, `src/entities/skiff.js`, `src/entities/fleet.js`, `src/entities/boats/**`, `src/render/cameraRig.js`, `src/render/camera/**` | §6.6–6.9 |
| WP-FISH | `src/entities/fish.js`, `src/entities/fish/**` | §6.10 |
| WP-NET | `src/entities/net.js`, `src/entities/net/**`, `src/game/fishing.js`, `src/game/fishing/**` | §6.11, §6.12 |
| WP-RULES | `src/game/season.js`, `src/game/economy.js`, `src/game/discovery.js`, `src/game/save.js`, `src/game/travel.js`, `src/game/data/**` | §6.15 season, economy, discovery, save, sleep, fast travel |
| WP-UI | `src/ui/**` (incl. `styles.css`) | §6.15 ui, §9 UI |
| WP-WILDLIFE | `src/entities/wildlife.js`, `src/entities/wildlife/**` | §6.13 |
| WP-FOOT | `src/entities/player.js`, `src/entities/player/**` | §6.14 |
| WP-AUDIO | `src/audio/**` | §6.16 |

Every WP also owns `tests/<wp>*.test.mjs`, `tests/scenarios/<wp>-*.json`, `notes/WP-<NAME>.md` and `qa/<wp>/`.
