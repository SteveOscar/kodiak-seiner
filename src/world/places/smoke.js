// Chimney smoke and cannery steam: instanced soft puffs animated entirely on the GPU (render band 200). Each emitter
// owns a fixed set of puffs cycling through their life. Together they draw a bent-over plume: puffs leave the stack
// fast, their rise decays toward a ceiling (PLUME.rise, lower in wind), they ride the wind (uWindDir/uWindSpeed), and
// each quad is stretched along its screen-space motion so neighbours merge into a streak instead of round discs.
// Steam thins in clear, dry weather (uCloudCover). Everything is gone well below PLUME.ceiling metres above the
// source, and puffs are culled beyond ~1.6 km from the camera.

import * as THREE from 'three';

// Shared by the shader and plumePuff() below (the tests check the plume envelope through plumePuff).
export const PLUME = {
  life: [8.0, 10.0], // seconds (smoke, steam)
  rise: [12.0, 18.0], // asymptotic rise above the source in calm air, metres
  riseTau: [2.8, 3.8], // seconds to reach ~63% of the rise (exit speed = rise / riseTau)
  windRise: 0.09, // rise /= 1 + windRise * wind
  drift: 0.75, // fraction of the wind speed the puffs travel downwind
  size0: [1.0, 2.0], // puff diameter at the stack, metres
  size1: [5.5, 9.0], // puff diameter at the end of its life
  fadeTop: [0.45, 1.0], // alpha fades out between these fractions of the ceiling
  ceiling: 30.0, // metres above the source where every puff has faded out
  wind: [1.0, 14.0], // clamp on uWindSpeed
};

const f = (v) => v.toFixed(4);
const VERT = /* glsl */ `
attribute vec3 iOrigin;
attribute vec4 iSeed; // x: phase 0..1, y: kind (0 chimney smoke, 1 steam), z: strength, w: random
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWindSpeed;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform float uDaylight;
uniform float uCloudCover;
uniform float uSmokeAmount;
varying vec2 vUv;
varying float vAlpha;
varying vec3 vColor;
varying float vSeed;
#include <fog_pars_vertex>
void main() {
  float steam = iSeed.y;
  float life = mix(${f(PLUME.life[0])}, ${f(PLUME.life[1])}, steam);
  float age = fract(uTime / life + iSeed.x);
  float t = age * life;
  float wind = clamp(uWindSpeed, ${f(PLUME.wind[0])}, ${f(PLUME.wind[1])});
  vec2 wd = length(uWindDir) > 1e-3 ? normalize(uWindDir) : vec2(1.0, 0.0);
  // Bent-over plume: rise decays toward a wind-lowered ceiling, drift follows the wind, and the plume widens across
  // the wind with age.
  float riseMax = mix(${f(PLUME.rise[0])}, ${f(PLUME.rise[1])}, steam) / (1.0 + ${f(PLUME.windRise)} * wind);
  float tau = mix(${f(PLUME.riseTau[0])}, ${f(PLUME.riseTau[1])}, steam);
  float e = exp(-t / tau);
  float rise = riseMax * (1.0 - e);
  float along = wind * ${f(PLUME.drift)} * t;
  float across = (iSeed.w - 0.5) * 3.0 * age + sin(uTime * 0.7 + iSeed.w * 30.0) * 0.8 * age;
  vec3 p = iOrigin + vec3(wd.x * along - wd.y * across, rise, wd.y * along + wd.x * across);
  // World velocity (m/s) of the puff: its screen projection orients the stretch.
  vec3 vel = vec3(wd.x, 0.0, wd.y) * wind * ${f(PLUME.drift)} + vec3(0.0, riseMax / tau * e, 0.0);
  float size = mix(mix(${f(PLUME.size0[0])}, ${f(PLUME.size0[1])}, steam), mix(${f(PLUME.size1[0])}, ${f(PLUME.size1[1])}, steam), sqrt(age));
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  float dist = -mvPosition.z;
  // Clear, dry air evaporates steam within a few metres; cloudy, damp mornings keep a long plume.
  float humid = smoothstep(0.1, 0.85, uCloudCover);
  float amount = mix(uSmokeAmount, mix(0.55, 1.0, humid), steam) * iSeed.z;
  float fadeAge = pow(1.0 - age, mix(1.6, mix(3.4, 1.8, humid), steam));
  float fadeTop = 1.0 - smoothstep(${f(PLUME.fadeTop[0] * PLUME.ceiling)}, ${f(PLUME.fadeTop[1] * PLUME.ceiling)}, rise + size * 0.5);
  vAlpha = smoothstep(0.0, 0.05, age) * fadeAge * fadeTop * amount * (1.0 - smoothstep(1100.0, 1600.0, dist));
  vAlpha *= mix(0.5, 0.62, steam) * mix(0.3, 1.0, uDaylight);
  // Stretch along the projected motion (less when the plume streams toward or away from the camera).
  vec3 vv = mat3(modelViewMatrix) * vel;
  float vl = length(vv.xy);
  vec2 dir = vl > 1e-4 ? vv.xy / vl : vec2(0.0, 1.0);
  float stretch = 1.0 + 0.75 * (vl / max(length(vv), 1e-4)) * smoothstep(0.5, 3.0, length(vel));
  // (perp, dir) must keep the quad's winding (determinant +1), or FrontSide culls every puff.
  vec2 perp = vec2(dir.y, -dir.x);
  vec2 off = dir * position.y * size * stretch + perp * position.x * size * 0.9;
  mvPosition.xy += off * step(0.002, vAlpha);
  vUv = position.xy * 2.0;
  vSeed = iSeed.w + floor(uTime / life + iSeed.x) * 0.37;
  float lit = clamp(uSunDir.y * 2.0 + 0.2, 0.0, 1.0);
  vec3 base = mix(vec3(0.42, 0.42, 0.44), vec3(0.9, 0.92, 0.95), steam);
  vColor = base * (uSkyColor * 0.55 + uSunColor * lit * 0.6) * mix(0.25, 1.0, uDaylight);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
varying vec2 vUv;
varying float vAlpha;
varying vec3 vColor;
varying float vSeed;
#include <fog_pars_fragment>
void main() {
  // Ragged, soft-edged blob: a noisy radius so no two puffs show the same round outline.
  vec2 q = vUv * 2.1 + vSeed * 13.0;
  float n = 0.5 + 0.5 * sin(q.x * 2.1 + sin(q.y * 1.7)) * cos(q.y * 1.9 - q.x * 0.8);
  float n2 = 0.5 + 0.5 * sin(q.x * 4.3 - q.y * 3.1 + vSeed * 5.0);
  float r2 = dot(vUv, vUv) * mix(0.8, 1.35, n * 0.7 + n2 * 0.3);
  if (r2 > 1.0) discard;
  float a = vAlpha * (1.0 - r2) * (1.0 - r2) * mix(0.55, 1.0, n);
  if (a < 0.003) discard;
  gl_FragColor = vec4(vColor, a);
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// CPU mirror of the vertex shader's plume envelope for one puff: { rise, along, size, alphaTop } at age 0..1.
export function plumePuff({ age, steam = 1, windSpeed = 4 }) {
  const mix = (a, b, k) => a + (b - a) * k;
  const smooth = (e0, e1, x) => {
    const k = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return k * k * (3 - 2 * k);
  };
  const life = mix(PLUME.life[0], PLUME.life[1], steam);
  const t = age * life;
  const wind = Math.min(PLUME.wind[1], Math.max(PLUME.wind[0], windSpeed));
  const riseMax = mix(PLUME.rise[0], PLUME.rise[1], steam) / (1 + PLUME.windRise * wind);
  const tau = mix(PLUME.riseTau[0], PLUME.riseTau[1], steam);
  const rise = riseMax * (1 - Math.exp(-t / tau));
  const size = mix(mix(PLUME.size0[0], PLUME.size0[1], steam), mix(PLUME.size1[0], PLUME.size1[1], steam), Math.sqrt(age));
  const alphaTop = 1 - smooth(PLUME.fadeTop[0] * PLUME.ceiling, PLUME.fadeTop[1] * PLUME.ceiling, rise + size * 0.5);
  return { rise, along: wind * PLUME.drift * t, size, alphaTop };
}

// puffs / steamPuffs: puffs per chimney / per steam stack (steam plumes are longer, so they need more to stay joined).
export function createSmoke(ctx, emitters, { puffs = 9, steamPuffs = puffs, rng } = {}) {
  const rand = rng ? () => rng.next() : () => 0.5;
  const per = (e) => (e.kind === 'steam' ? steamPuffs : puffs);
  const n = emitters.reduce((a, e) => a + per(e), 0);
  const quad = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index;
  geo.setAttribute('position', quad.getAttribute('position'));
  const origin = new Float32Array(n * 3);
  const seed = new Float32Array(n * 4);
  let k = 0;
  for (const e of emitters) {
    const m = per(e);
    for (let i = 0; i < m; i++, k++) {
      origin.set([e.x, e.y, e.z], k * 3);
      seed.set([(i + e.phase) / m, e.kind === 'steam' ? 1 : 0, e.strength ?? 1, rand()], k * 4);
    }
  }
  geo.setAttribute('iOrigin', new THREE.InstancedBufferAttribute(origin, 3));
  geo.setAttribute('iSeed', new THREE.InstancedBufferAttribute(seed, 4));
  geo.instanceCount = n;
  const U = ctx.uniforms;
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uSmokeAmount: { value: 1 } }]);
  Object.assign(uniforms, {
    uTime: U.uTime,
    uWindDir: U.uWindDir,
    uWindSpeed: U.uWindSpeed,
    uSunDir: U.uSunDir,
    uSunColor: U.uSunColor,
    uSkyColor: U.uSkyColor,
    uDaylight: U.uDaylight,
    uCloudCover: U.uCloudCover ?? { value: 0.3 },
  });
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    fog: true,
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'places-smoke';
  mesh.frustumCulled = false;
  mesh.renderOrder = 200;
  mesh.matrixAutoUpdate = false;
  return {
    mesh,
    count: n,
    // 0..1: chimney smoke amount (cool mornings and evenings smoke more).
    setAmount(v) {
      uniforms.uSmokeAmount.value = v;
    },
  };
}
