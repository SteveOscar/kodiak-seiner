// Point-light glows for the whole archipelago in one draw call: navigation lights (flashing characteristics), buoy
// lights, streetlamps, harbour and aviation lights. Camera-facing quads, additive, render band 400 (SPEC §4.3).
// Sizes are in metres with a minimum on-screen size so distant lights stay visible as small points.

import * as THREE from 'three';

const VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec3 iColor;
attribute vec4 iParams; // size m, period s (0 = steady), phase s, flashes
attribute vec2 iMode;   // x: 0 always, 1 night (lamps), 2 dusk-to-dawn nav/aviation lights; y: day intensity
uniform float uTime;
uniform float uNight;
uniform float uNav;
uniform float uPixelAngle;
varying vec3 vColor;
varying vec2 vUv;
varying float vCore;
#include <fog_pars_vertex>
float kGlowBlink(float period, float phase, float flashes, float t) {
  if (period <= 0.0) return 1.0;
  float tt = mod(t + phase, period);
  float on = 0.0;
  for (int k = 0; k < 4; k++) {
    float s = float(k) * 1.3;
    float f = smoothstep(s, s + 0.08, tt) * (1.0 - smoothstep(s + 0.75, s + 0.95, tt));
    on = max(on, f * step(float(k) + 0.5, flashes));
  }
  return on;
}
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(iPos, 1.0);
  float dist = max(1.0, -mvPosition.z);
  float minSize = dist * uPixelAngle * 5.0;
  float size = max(iParams.x, minSize);
  float on = kGlowBlink(iParams.y, iParams.z, iParams.w, uTime);
  float dark = iMode.x > 1.5 ? uNav : iMode.x > 0.5 ? uNight : 1.0;
  float vis = max(iMode.y, dark);
  // Expanded sprites keep their total energy roughly constant so far lights read as points, not blobs.
  float energy = clamp(iParams.x / size, 0.18, 1.0);
  vColor = iColor * on * vis * mix(0.55, 1.0, energy);
  vCore = clamp(size / max(iParams.x, 1e-3), 1.0, 8.0);
  vUv = position.xy * 2.0;
  mvPosition.xy += position.xy * size * step(0.001, on * vis);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
varying vec3 vColor;
varying vec2 vUv;
varying float vCore;
#include <fog_pars_fragment>
void main() {
  float r2 = dot(vUv, vUv);
  if (r2 > 1.0) discard;
  float core = exp(-r2 * 38.0 / vCore);
  float halo = exp(-r2 * 5.0) * 0.22;
  vec3 glow = vColor * (core * 3.0 + halo);
  gl_FragColor = vec4(glow, 1.0);
  // Additive glow under the fog contract: run the fog chunk on the colour and on black, keep the difference
  // (glow scaled by the fog transmittance) so fogged lights fade out instead of adding fog colour.
  #include <fog_fragment>
  vec3 kFogged = gl_FragColor.rgb;
  gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
  {
    #include <fog_fragment>
  }
  gl_FragColor.rgb = max(kFogged - gl_FragColor.rgb, vec3(0.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createGlows(ctx, pu, capacity = 512) {
  const quad = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index;
  geo.setAttribute('position', quad.getAttribute('position'));
  const pos = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
  pos.setUsage(THREE.DynamicDrawUsage);
  const color = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
  const params = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  const mode = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
  geo.setAttribute('iPos', pos);
  geo.setAttribute('iColor', color);
  geo.setAttribute('iParams', params);
  geo.setAttribute('iMode', mode);
  geo.instanceCount = 0;
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uPixelAngle: { value: 0.001 } }]);
  uniforms.uTime = ctx.uniforms.uTime;
  uniforms.uNight = pu.uNight;
  uniforms.uNav = pu.uNav;
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    fog: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'places-glows';
  mesh.frustumCulled = false;
  mesh.renderOrder = 400;
  mesh.matrixAutoUpdate = false;
  const c = new THREE.Color();
  let count = 0;
  const api = {
    mesh,
    get count() {
      return count;
    },
    // o: { color, intensity, size, period, phase, flashes, nightOnly = true, nav (default: flashing), day = 0 }
    add(x, y, z, o = {}) {
      if (count >= capacity) return -1;
      const i = count++;
      pos.setXYZ(i, x, y, z);
      c.set(o.color ?? '#ffd08a').multiplyScalar(o.intensity ?? 4);
      color.setXYZ(i, c.r, c.g, c.b);
      params.setXYZW(i, o.size ?? 2, o.period ?? 0, o.phase ?? 0, o.flashes ?? 1);
      const nav = o.nav ?? (o.period ?? 0) > 0;
      mode.setXY(i, o.nightOnly === false ? 0 : nav ? 2 : 1, o.day ?? 0);
      geo.instanceCount = count;
      pos.needsUpdate = color.needsUpdate = params.needsUpdate = mode.needsUpdate = true;
      return i;
    },
    setY(i, y) {
      pos.setY(i, y);
      pos.needsUpdate = true;
    },
    beforeRender(camera, renderer) {
      const h = renderer.getDrawingBufferSize?.(new THREE.Vector2()).y || renderer.domElement?.height || 720;
      uniforms.uPixelAngle.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, h);
    },
  };
  return api;
}
