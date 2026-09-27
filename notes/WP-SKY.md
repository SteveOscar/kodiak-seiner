# WP-SKY — sky, astronomy, lighting, weather, fog contract, env map, mist, rain, postfx

## Summary

Owned files: `src/world/sky.js` + `src/world/sky/*`, `src/render/postfx.js` + `src/render/postfx/*`, tests
`tests/sky.test.mjs`, scenarios `tests/scenarios/sky-*.json`, QA output `qa/sky/`.

- **Atmosphere** (`sky/atmosphere.js`, `sky/shaders.js`): Hillaire-2020-style physically based sky — Rayleigh + Mie
  (maritime haze, Mie ×1.8) + ozone, a transmittance LUT and a multiple-scattering LUT computed once in JS and uploaded
  unchanged, so CPU lighting and the GPU dome share one model. A 256×128 HalfFloat sky-view LUT (sun + moon terms) is
  re-rendered only when the sun/moon moves (≈3–6 Hz at normal time speed).
- **Dome**: one fullscreen triangle at the far plane (`gl_Position.z = 0` under `USE_REVERSED_DEPTH_BUFFER`, else `w`),
  renderOrder −1000, depthTest/depthWrite off, on layer 1 (water reflection). Sun disc + limb darkening + glow (main
  view only), FBM cumulus layer at 1.6 km following `cloudCover` with two-tap sun self-shadowing, powder term, warm
  under-lit bases at low sun and a textured overcast deck; wind-drifted cirrus that stays lit after sunset; ragged scud
  under rain/storm decks; stars (magnitude-distributed, twinkling low, limiting magnitude from sky brightness) rotated
  by real local sidereal time, a Milky Way band; the moon with real phase/terminator and maria; aurora curtains (two
  meandering vertical sheets 440–560 km north, sharp bright green lower border, violet fringe, rays, red tops, bright
  edge-on folds, gaps along the arc) on clear dark nights from ~day 26, strongest after day 40; lightning glow in the
  deck around each strike. High sky gets a gentle elevation-weighted saturation (deep blue noon).
- **Astronomy** (`sky/astro.js`): NOAA solar position (~0.01°), truncated ELP/Meeus moon (~0.3°) with phase and
  illumination, GMST star rotation, `sunTimes(dayOfYear)`. See "Clock shift" below.
- **Lighting** (`sky/lightModel.js`): key light = sun by day (colour/intensity from atmospheric transmittance, cloud
  dimming from the same cloud field the dome draws, golden-hour warm bias), moon or twilight glow by night (cool, dim,
  readable); hemisphere sky/ground colours from a quadrature of the physical sky; fog/horizon colours; a "night lift"
  (display ∝ physical^0.42) so twilight and night stay readable with exposure in ~0.8–2.3. `sceneKey` (luminance of a
  white horizontal surface) drives postfx exposure.
- **Shadows**: one cascade ±150 m around `shadowFocus`, texel-snapped in light space, placed in
  `pipeline.beforeRender`; `castShadow = quality.shadows`, `mapSize = quality.shadowMapSize`, `shadow.radius` 2.5 by
  day / 4.5 by moonlight; key intensity × `terrain.sunVisibilityAt(shadowFocus)` (sampled at 10 Hz, eased).
- **Fog contract** (`sky/fogChunks.js`): the four built-in chunks are replaced in `create()` with radial exponential
  fog + height falloff (thick at sea level, thin aloft) + an altitude-independent fraction up to a haze ceiling + a
  ragged low cloud deck on grey days + key-light inscattering (warm toward the sun), reading only mvPosition,
  viewMatrix, cameraPosition, fogColor, fogDensity (+ optional shared `kodiakFog*` uniforms injected into
  `UniformsLib.fog` and every built-in ShaderLib entry by reference). Only the in-air part of a ray is fogged: the
  segment below y = 0 belongs to `kodiak_underwater` (fixes deep-water seabed turning into fog in thick weather).
  `scene.fog` is one FogExp2 mutated in place; `uFogColor/uFogDensity` mirror it.
- **Weather** (`sky/weather.js`): presets clear, partly, overcast, fog (marine fog, 600 m), rain (drizzle under a low
  deck), storm (dark, heavy rain, 17 m/s SE gale, 2.4 m swell, lightning). Smooth transitions (visibility in log
  space, wind the short way round, clouds build before the rain and the rain stops before the clouds break), gusts and
  slow veer.
- **Mist / low cloud** (`sky/mist.js`, `sky/mistSites.js`, band 300): ~200 sites from the heightmap (≈150 peak
  banks, ≈50 bay pools) — peak banks on mountainsides whose terrain crosses the cloud band below higher ground, and
  bay pools over enclosed water. One
  instanced draw (≤ 44 ellipsoid proxies, front faces) ray-marches 3D noise inside each bank (6–13 steps by distance,
  white-noise jitter), stopping at the terrain/sea via `uHeightMap`; peak banks hug the slope, bay fog is a
  flat-topped pool with an undulating top. Lit by sky + whitened key light, softly darkened in terrain shadow
  (`uTerrainShadow`, 4 taps). Presence follows weather, a morning factor (fog pools at dawn, burns off 07:30–10:00),
  the deck height and wind. When the camera enters a bank, its instance fades and the global fog closes in instead.
- **Rain** (`sky/rain.js`, band 200): up to 14,000 wind-slanted streaks in a camera-wrapped box, one instanced draw,
  no per-frame CPU work; drizzle → downpour by `rain`; lit by the lightning flash.
- **Env map** (`sky/envCapture.js`, `sky/envPolicy.js`): a sky-only scene (dome with clouds, no sun disc/stars/moon,
  lower hemisphere = sea/ground bounce colour) → CubeCamera on layer 1 → persistent `WebGLCubeRenderTarget(256,
  HalfFloat)` → `pmrem.fromCubemap(cube, envTarget)` into one persistent target; `sky.envMap` is the same texture
  object all session and valid after `create()`. Refresh ≤ every 0.5 s: > 2° sun movement (moon at night), every 2 s
  during transitions, at once after an instant weather change or a sun/night key switch, and every 20 s.
  PMREM's GGX sample count is reduced to 24 (the sky-only env has no sun disc).
- **Postfx** (`postfx.js`, `postfx/*`): scene → `WebGLRenderTarget(w, h, {type: HalfFloatType, samples: 4,
  depthTexture: new DepthTexture(w, h, FloatType)})` → `EffectComposer(renderer, rt)` → RenderPass → exposure meter
  (1×1 log-average, async readback 5 Hz) → half-res bloom (Karis 13-tap prefilter, 4-level mip chain, tent upsample;
  sun glints and lights) → OutputPass with the grade folded into its shader (bloom add, white balance warm at golden
  hour / cool at night, Purkinje night shift, saturation, log contrast, vignette), ACES tone mapping, sRGB and a ½-LSB
  dither. Exposure = daylight curve × bounded metering correction, adapted in log space; written to
  `renderer.toneMappingExposure` every frame in `frame()` whether or not postfx is enabled. Resizes with the canvas.

## API as built

### sky (`ctx.systems.sky`)
Required: `sunDirection` (= `uniforms.uSunDir.value`), `moonDirection`, `sunLight`, `hemiLight`, `shadowFocus`,
`daylight` (0..1), `sunElevationDeg` (true sun, geometric), `isNight`, `envMap`, `weather`, `setWeather(preset,
transitionSeconds = 20)` → boolean.
Extras: `envMapDefines` (`ENVMAP_TYPE_CUBE_UV`, `CUBEUV_TEXEL_WIDTH/HEIGHT`, `CUBEUV_MAX_MIP` for custom CubeUV
shaders), `trueSunDirection`, `moonElevationDeg`, `moonIllumination`, `moonPhase` (0 new → 0.5 full), `golden`
(0..1 golden-hour strength), `sceneKey`, `lightning` (0..1 flash), `sunTimes(day?)` → `{sunrise, sunset, noon,
noonElevation, minElevation}` in game-clock hours, `serialize()` → `{preset}`, `restore(d)`, `reset()` (partly unless
`debug.weatherPinned`), `debugState()`.
`weather` (mutated in place every frame): `{preset, cloudCover, fog, rain, windDir (heading the wind blows TOWARD),
windSpeed m/s (gusting), swell m, visibility m, cloudBase m (game height of the low deck), mist 0..1, darkness 0..1,
transition 0..1}`.
QA helpers: `debugTimings(n)` (GPU ms per component, min of n), `debugSetActive(bool)` (switch all sky GPU work
off/on for A/B), `debugFogCheck()` (compiles and checks fog on 7 material kinds + the underwater clip),
`debugMist(force?)`, `debugEnvStats()`.

Deviations / decisions:
- `sunDirection` / `uSunDir` / `sunLight` are the **key light**: the sun by day, the moon (or the twilight glow when
  the moon is down) at night, so water glitter becomes a moon path and night stays lit from a plausible direction.
  The true sun is `trueSunDirection`; `sunElevationDeg` is always the true sun.
- **Clock shift** (`SOLAR_CLOCK_SHIFT_HOURS = 0.425`): at 153.4°W on UTC−8 the literal clock puts Jul 6 sunrise at
  05:24 and sunset at 23:12; SPEC/brief want ~05:10 / ~22:35 (the 06:00–22:00 opener, golden hour at 20:30, twilight
  at 22:45). Game-clock readings map to the real instant 25.5 min later; latitude, declination, day length, twilight
  depth and the moon are real. Result: Jul 6 standard sunrise/sunset 04:59 / 22:46 (sun centre 05:08 / 22:37), solar
  noon 13:53 at 55°, the sun never below −9.7° (no astronomical night in early July); Aug 22: 06:28 / 21:12, −20.7° at
  night. Set the constant to 0 for the literal clock.
- Peak mist sites use a terrain band starting at 85 m (SPEC says banks at 120–260 m) so Kodiak's lower north-east
  hills also collect cloud; bank centres sit at ≤ 260 m.
- Postfx: the grade/vignette is part of the OutputPass shader rather than a separate pass (one full-res pass saved);
  MSAA ×4 on the scene target is the anti-aliasing (no SMAA).

### postfx (`ctx.systems.postfx`)
Required: `enabled`, `setEnabled(bool)` → boolean. Extras: `exposure`, `sceneTarget`, `depthTexture` (FloatType, of
the scene target — valid after the composer's RenderPass), `bloomStrength`, `setBloomStrength(v)`, `debugTimings(n,
skipScene)`, `debugState()`.

### Events
- `weather:change {preset}` (SPEC) — on every preset change and on instant sets.
- `sky:lightning {x, z, distance, intensity}` (new) — each strike during a storm, for audio thunder (delay by
  distance / 343 m/s) and anything that wants to flash.

### Fog contract details for other WPs
- Custom ShaderMaterials: `fog: true`, merge `THREE.UniformsLib.fog` (brings the shared `kodiakFog*` uniforms by
  reference), compute `vec4 mvPosition` before `#include <fog_vertex>`, include the four chunks (fragment after
  lighting). Materials missing the optional uniforms still get correct height fog (zero-initialised → defaults).
- Shaders that cannot use the chunks: `#include <kodiak_sky_fog_pars>` and call `kodiakApplyFog(color, worldPos,
  uFogColor, uFogDensity)`, or `kodiakFogDepth(cameraPos, worldPos, density)` + `kodiakFogTint(viewDir, fogColor)`.
  (Uniforms: pass the `kodiakFog*` entries from `THREE.UniformsLib.fog`.)

## Tunables

- `sky/weather.js` `PRESETS` — cover, fog, rain, wind, swell, visibility, deck height, mist abundance, darkness.
- `sky/lightModel.js` `SKY_TUNING` — sun illuminance, sky gain, ambient gain, night lift (`liftGamma`, `liftMax`),
  airglow, night ambient, moon/twilight key; the golden-hour warm bias in `evaluate()`.
- `sky/atmosphere.js` `ATMOSPHERE` — scattering coefficients (maritime Mie ×1.8), ozone, ground albedo.
- `sky/shaders.js` `CLOUD_LAYER` (altitude/tiling), aurora constants in `aurora()`.
- `sky.js` — `SHADOW_HALF` (150 m), `SUN_DISC_GAIN`, fog height falloff / ceiling / sun-lobe (`kodiakFogParams`),
  deck density (`kodiakFogDeck`), aurora season (`auroraStrength`: ramps days 26–40).
- `sky/mistSites.js` `PEAK_BAND`, spacing; `sitePresence` / `morningFactor`. `sky/mist.js` `MAX_INSTANCES` (44),
  `VIEW_RANGE` (9.5 km), densities in the shader.
- `sky/envPolicy.js` `ENV_POLICY`.
- `postfx/exposure.js` `EXPOSURE` (curve, limits 0.8–2.3, adaptation rates, metering strength);
  `postfx.js` bloom threshold/knee/levels and `bloomStrength` (0.055); grade balance/saturation/contrast in `frame()`.

## Known issues

- Mist banks stop at the heightmap only (no depth-buffer read in the transparent pass), so boats/buildings/trees
  inside a bank are fogged over the bank's full depth behind them (slightly too misty). White-noise jitter shows as
  fine grain up close.
- Env capture is a single-frame spike (1.2–1.6 ms GPU measured on a quiet GPU) every few seconds while the sun moves
  (~every 8 s at normal time speed), every 2 s during transitions; not split across frames.
- Aurora is a 2D sheet model: toward the east/west horizon (north component < 0.2) it fades out, where the track
  iteration would not converge.
- Lightning lights the dome, rain and ambient; it does not add a real light source to geometry beyond the sky/hemi
  ambient boost.
- On the canvas path (quality `low` / postfx disabled) there is no MSAA or bloom; exposure still adapts.
- GPU A/B timing on the shared GPU is inconclusive (see Perf).

## Perf

Measured with `--bench` at 1280×720, pixel ratio 1, quality high, full game (`qa/sky/bench4`, taken while no other
smoke runs were active): whole frame 6.2–7.9 ms average, p95 7.7–13 ms, 100–120 draw calls. CPU (`perf().systemsMs`):
sky 0.01–0.03 ms, postfx < 0.01 ms (under contention in other runs: sky ≤ 0.3 ms). GPU per component
(`debugTimings`, min of 30, minus a 0.07 ms target-clear baseline): dome 0.12–0.33 ms (aurora nights at the top),
mist 0.12–0.46 ms (dense morning fog at the top), rain ~0.3 ms in a storm (0 when dry), sky-view LUT 0.06–0.44 ms
only when dirty (≈3–6 Hz), env capture 1.2–1.6 ms per refresh; bloom 0.24 ms, graded output 0.16 ms, plus the
4×MSAA HalfFloat scene target and resolve. Estimated sky + postfx ≈ 0.8–1.5 ms per typical frame (budget 2.5 ms).
The EXT_disjoint_timer_query `gpuMs` and in-page on/off A/B (`tests/scenarios/sky-ab.json`) swing by ±8 ms between
identical windows on the shared GPU (up to 16 concurrent headless browsers), so no reliable frame-level delta is
claimed.

## Screenshots (qa/sky/)

- `final-times/t0515-sunrise.png` — 05:15 sunrise over St. Paul Harbor approaches
- `final-times/t0900.png`, `final-times/t1300.png` — morning and deep-blue noon toward Kodiak's hills
- `final-times/t2030-golden.png`, `q2/q-golden-south.png` — 20:30 golden hour (into the sun / sunlit side)
- `final-times/t2245-twilight.png` — 22:45 pink-lit clouds over the city
- `final-times/t0130-night.png`, `r2-times/t0236-moon.png` — 01:30 day 0 night; moon path on the water
- `final-times/t2330-d45-aurora.png` — 23:30 day 45, clear, aurora
- `final-times/s2030-shelikof.png`, `final-times/s1300-shelikof.png` — Peninsula volcanoes across Shelikof Strait
- `final-weather/w-clear.png`, `w-partly.png`, `w-overcast.png`, `w-fog.png`, `w-rain.png`, `w-storm.png` — each
  preset at 14:00; `final-weather/w-*-shelikof.png` from Shelikof Strait
- `final-mist/mist-morning-bays.png`, `inbank/abovebank-70m.png`, `inbank/inbank-6m.png` — dawn fog pooling in bays
- `stormnight3/overcast-dusk.png`, `stormnight3/storm-lightning.png`, `transition/tr-4.png` … `tr-12.png`
- `shadows1/sh-noon.png`, `shadows1/sh-golden-2.png`, `shadows1/sh-night.png` — seiner shadows / night readability
- `final/` — the strict basic run

## Tests and QA tools

- `node --test tests/sky.test.mjs` (21 tests): NOAA reference (Anchorage solstice), Jul 6 sunrise ~05:10 / sunset
  ~22:35 on the game clock, long July twilight vs dark late August, game-frame directions, moon phase by date, star
  rotation, atmosphere (reddening, blue zenith, warm sunset), light model (noon/golden/night/storm/overcast), weather
  presets and transitions (incl. cloud-before-rain ordering), mist sites and presence, exposure, fog chunk symbol
  whitelist, tileable noise, env refresh policy.
- In-browser: `tests/scenarios/sky-fogcheck.json` → `debugFogCheck()` — MeshStandard, MeshLambert, MeshBasic,
  Points, Sprite, LineBasic and a fog:true ShaderMaterial all compile and fog correctly, plus the underwater clip.
- Scenarios: `sky-times`, `sky-weather`, `sky-mist`, `sky-quick`, `sky-noon`, `sky-evening`, `sky-inbank`,
  `sky-shadows`, `sky-transition`, `sky-stormnight`, `sky-postfx`, `sky-bench`, `sky-ab`. They hide `#ui` for
  clean frames.
- `qa/sky/smoke-nohmr.mjs`: a copy of `tools/smoke.mjs` with HMR/file watching off (same flags), because other WPs'
  edits trigger Vite full reloads mid-run ("`__KODIAK__` is not defined"). `qa/sky/crop.mjs` crops/zooms PNGs.

## Core changes

None.

## Requests to other WPs

- **Core / `kodiak_underwater`**: attenuate the sunlight's path down to the seabed as well (≈ depth / sunDir.y), not
  only the view path: in clear weather the seiner's shadow on a 14 m seabed reads strongly through the thin surface.
- **WP-OCEAN**: on the canvas path (quality `low`, postfx off) materials tone-map before blending, so the water's
  un-premultiplied glitter is scaled by its ~0.2 alpha and the sun path disappears; raising alpha where specular is
  strong would keep it.
- **WP-RULES**: use 20–60 s transitions in the weather schedule (`setWeather(p, seconds)`); the sky orders cloud
  build-up before rain. Thunder can hang off `sky:lightning`.
- **WP-AUDIO**: `sky:lightning {distance}` for thunder; `sky.weather.rain/windSpeed` for rain and wind beds.
- **WP-TERRAIN**: the mist samples `uTerrainShadow` (R, 1 = lit); keep assigning `.value` on the shared uniform.
- **WP-BOATS (cameraRig)**: keep copying the focus into `sky.shadowFocus` every frame (the shadow box and
  sun-visibility sampling follow it).
- **All WPs with custom shaders**: see "Fog contract details" above; don't read `vFogDepth`/`fogNear` in custom code.
