// Chimney smoke and cannery steam: instanced soft puffs animated entirely on the GPU (render band 200). Each emitter
// owns a fixed set of puffs cycling through their life; puffs drift downwind (uWindDir/uWindSpeed), rise, grow and
// fade, and are culled beyond ~1.6 km from the camera.

import * as THREE from 'three';

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
uniform float uSmokeAmount;
varying vec2 vUv;
varying float vAlpha;
varying vec3 vColor;
varying float vSeed;
#include <fog_pars_vertex>
void main() {
  float steam = iSeed.y;
  float life = mix(11.0, 16.0, steam);
  float age = fract(uTime / life + iSeed.x);
  float wind = clamp(uWindSpeed, 1.0, 14.0);
  vec3 drift = vec3(uWindDir.x, 0.0, uWindDir.y) * wind * 0.55 * age * life;
  float rise = mix(3.5, 6.0, steam) * age * life / (1.0 + 0.1 * wind) ;
  vec3 wob = vec3(sin(uTime * 0.7 + iSeed.w * 30.0), 0.0, cos(uTime * 0.6 + iSeed.w * 17.0)) * age * 2.5;
  vec3 p = iOrigin + drift + vec3(0.0, rise, 0.0) + wob;
  float size = mix(mix(0.8, 2.4, steam), mix(7.0, 16.0, steam), sqrt(age));
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  float dist = -mvPosition.z;
  float amount = mix(uSmokeAmount, 1.0, steam) * iSeed.z;
  vAlpha = smoothstep(0.0, 0.08, age) * pow(1.0 - age, 1.6) * amount * (1.0 - smoothstep(1100.0, 1600.0, dist));
  vAlpha *= mix(0.5, 0.36, steam) * mix(0.3, 1.0, uDaylight);
  mvPosition.xy += position.xy * size * step(0.002, vAlpha);
  vUv = position.xy * 2.0;
  vSeed = iSeed.w;
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
  float r2 = dot(vUv, vUv);
  if (r2 > 1.0) discard;
  float a = vAlpha * (1.0 - r2) * (1.0 - r2);
  vec2 q = vUv * 2.3 + vSeed * 13.0;
  float n = 0.5 + 0.5 * sin(q.x * 2.1 + sin(q.y * 1.7)) * cos(q.y * 1.9 - q.x * 0.8);
  a *= mix(0.65, 1.0, n);
  if (a < 0.003) discard;
  gl_FragColor = vec4(vColor, a);
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createSmoke(ctx, emitters, { puffs = 9, rng } = {}) {
  const rand = rng ? () => rng.next() : () => 0.5;
  const n = emitters.length * puffs;
  const quad = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index;
  geo.setAttribute('position', quad.getAttribute('position'));
  const origin = new Float32Array(n * 3);
  const seed = new Float32Array(n * 4);
  let k = 0;
  for (const e of emitters) {
    for (let i = 0; i < puffs; i++, k++) {
      origin.set([e.x, e.y, e.z], k * 3);
      seed.set([(i + e.phase) / puffs, e.kind === 'steam' ? 1 : 0, e.strength ?? 1, rand()], k * 4);
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
