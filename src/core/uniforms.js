// Shared shader uniforms. Custom materials reference these objects directly (not copies) so one write per frame
// updates every shader. Owners write, everyone else reads:
//   uTime, uCameraPos          main loop (uCameraPos is for LOD/culling only; view-dependent shading uses the
//                              built-in cameraPosition, which is correct in reflection/cube renders too)
//   uSunDir, uSunColor, uSkyColor, uHorizonColor, uFogColor, uFogDensity, uDaylight, uWindDir, uWindSpeed, uRain,
//   uCloudCover                sky (uFogColor/uFogDensity mirror scene.fog for shaders that cannot use fog chunks)
//   uHeightMap, uWorldHalf     heightmap (RG float texture: R = game height m, G = signed shore distance m)
//   uTerrainShadow             terrain (R: 1 = sunlit, same uv/orientation as uHeightMap; defaults to 1×1 white)
//   uWaveState                 water (x = amplitude scale, y = choppiness, z = foam amount, w = unused)
//   uWaterAbsorb, uWaterScatter water (underwater colour attenuation used by the kodiak_underwater chunk)
//
// Colours are linear (THREE.Color converts sRGB hex on construction).

import * as THREE from 'three';

function whiteTexture() {
  const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
}

export function createUniforms() {
  return {
    uTime: { value: 0 },
    uCameraPos: { value: new THREE.Vector3() },
    uSunDir: { value: new THREE.Vector3(0.3, 0.6, -0.7).normalize() },
    uSunColor: { value: new THREE.Color(1, 0.95, 0.85) },
    uSkyColor: { value: new THREE.Color(0.35, 0.55, 0.85) },
    uHorizonColor: { value: new THREE.Color(0.75, 0.82, 0.9) },
    uFogColor: { value: new THREE.Color(0.72, 0.8, 0.88) },
    uFogDensity: { value: 0.00012 },
    uDaylight: { value: 1 },
    uWindDir: { value: new THREE.Vector2(1, 0) },
    uWindSpeed: { value: 6 },
    uRain: { value: 0 },
    uCloudCover: { value: 0.3 },
    uHeightMap: { value: null },
    uWorldHalf: { value: 8000 },
    uTerrainShadow: { value: whiteTexture() },
    uWaveState: { value: new THREE.Vector4(1, 0.5, 0.5, 0) },
    uWaterAbsorb: { value: new THREE.Vector3(0.45, 0.09, 0.07) }, // per metre of water path, RGB
    uWaterScatter: { value: new THREE.Color('#0b3a44') }, // colour of the water column
  };
}
