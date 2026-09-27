// Shared shader uniforms. Custom materials reference these objects directly (not copies) so one write per frame
// updates every shader. Owners write, everyone else reads:
//   uTime, uCameraPos          main loop
//   uSunDir, uSunColor, uSkyColor, uHorizonColor, uFogColor, uFogDensity, uDaylight, uWindDir, uWindSpeed, uRain,
//   uCloudCover                sky
//   uHeightMap, uWorldHalf     heightmap (RG float texture: R = game height m, G = signed shore distance m)
//   uTerrainShadow             terrain (optional sun-occlusion mask over the heightmap footprint; 1 = lit)
//   uWaveState                 water (x = amplitude scale, y = choppiness, z = foam amount, w = unused)

import * as THREE from 'three';

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
    uTerrainShadow: { value: null },
    uWaveState: { value: new THREE.Vector4(1, 0.5, 0.5, 0) },
  };
}
