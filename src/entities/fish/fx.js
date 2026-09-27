// Surface effects for jumps and the bag: GPU-animated splash particles (crown sheets, droplets, spray mist; render
// band 200), sun-glint flashes (band 400), expanding ripple rings for jumps beyond the water system's stamp field
// (band 100) and finning V-wakes (band 100). All transparent, depthWrite false (SPEC §4.3). Particles are written
// once into ring buffers and animated in the vertex shader; the CPU cost is the spawn writes only.
//
// Minimum screen size (SPEC §6.10): a whole splash (particle sizes and spread) renders at max(real size,
// 0.004 × distance); rings likewise; glints are sized in pixels.

import * as THREE from 'three';

const G = 9.81;

const PARTICLE_VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec4 aVel;   // velocity xyz, drag
attribute vec4 aLife;  // start, life, size, kind (0 droplet, 1 sheet, 2 mist, 3 foam, 4 far plume)
attribute float aRef;  // nominal splash size (m) for the minimum-size rule
uniform float uTime;
uniform float uProjScale;
uniform vec2 uViewport;
varying float vAlpha;
varying float vKind;
varying float vT;
varying vec3 vWorld;
varying vec2 vDir;
varying float vStretch;

void main() {
  float age = uTime - aLife.x;
  if (age < 0.0 || age > aLife.y) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  float t = age / aLife.y;
  float kind = aLife.w;
  float S = max(1.0, 0.004 * distance(position, cameraPosition) / max(aRef, 0.05));
  vec3 v = aVel.xyz;
  float drag = aVel.w;
  float e = drag > 0.0 ? (1.0 - exp(-drag * age)) / drag : age;
  vec3 disp;
  float size = aLife.z;
  float alpha;
  if (kind < 0.5) {
    disp = v * e + vec3(0.0, -0.5 * ${G} * age * age, 0.0);
    size *= 1.0 - 0.35 * t;
    alpha = (1.0 - t * t) * 0.85;
  } else if (kind < 1.5) {
    disp = v * e + vec3(0.0, -0.5 * ${G} * 0.85 * age * age, 0.0);
    size *= 0.8 + 0.5 * t;
    alpha = smoothstep(0.0, 0.06, t) * (1.0 - t * t) * 0.9;
  } else if (kind < 2.5) {
    disp = v * e + vec3(0.0, 0.18 * age, 0.0);
    size *= 0.6 + 1.5 * sqrt(t);
    alpha = smoothstep(0.0, 0.12, t) * (1.0 - t) * (1.0 - t) * 0.22;
  } else if (kind < 3.5) {
    disp = v * e;
    disp.y = 0.02;
    size *= 0.8 + 1.2 * sqrt(t);
    alpha = (1.0 - t) * 0.5;
  } else {
    // Far plume: the whole splash as one upright white burst, so a jump still reads when every droplet is
    // sub-pixel. Fades in with distance as the detailed particles fade out.
    float d = distance(position, cameraPosition);
    S = max(1.0, 0.007 * d / max(aRef, 0.05));
    size = aRef * (0.8 + 0.4 * sqrt(t));
    disp = vec3(0.0, 0.42 * size, 0.0);
    alpha = smoothstep(0.0, 0.04, t) * pow(1.0 - t, 1.6) * smoothstep(35.0, 150.0, d);
  }
  vec3 p = position + disp * S;
  // Droplets that fall back through the surface are gone.
  if (kind < 1.5 && p.y < position.y - 0.03 * S && age > 0.05) alpha = 0.0;
  vec4 mvPosition = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  float px = size * S * uProjScale / max(-mvPosition.z, 0.1);
  // Motion streak: how far the particle moves on screen in ~25 ms stretches the sprite along its travel.
  vDir = vec2(1.0, 0.0);
  vStretch = 1.0;
  if (kind < 1.5) {
    vec3 vel = v * exp(-drag * age) + vec3(0.0, -${G} * (kind < 0.5 ? 1.0 : 0.85) * age, 0.0);
    vec4 c2 = projectionMatrix * viewMatrix * vec4(p + vel * 0.025 * S, 1.0);
    vec2 d = (c2.xy / c2.w - gl_Position.xy / gl_Position.w) * uViewport * 0.5;
    float l = length(d);
    if (l > 1e-3) vDir = d / l;
    vStretch = clamp(1.0 + l / max(px, 1.0), 1.0, 4.0);
  }
  gl_PointSize = clamp(px * vStretch, 1.6, 256.0);
  vAlpha = alpha * (kind > 3.5 ? 1.0 : min(1.0, (px / 1.6) * (px / 1.6)));
  vKind = kind;
  vT = t;
  vWorld = p;
  #include <fog_vertex>
}
`;

const PARTICLE_FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform vec3 uSunDir;
uniform vec3 uSunRadiance;
uniform vec3 uHemiSky;
uniform vec3 uHorizonColor;
varying float vAlpha;
varying float vKind;
varying float vT;
varying vec3 vWorld;
varying vec2 vDir;
varying float vStretch;

void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  q.y = -q.y;
  vec2 c = vec2(dot(q, vDir), dot(q, vec2(-vDir.y, vDir.x)) * vStretch);
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  float shape;
  // Droplets: a bright glint over a clear body. Sheets: translucent water with brighter edges.
  if (vKind < 0.5) shape = exp(-r2 * 3.5) * (1.0 - r2) * (0.55 + 0.45 * exp(-dot(c - vec2(-0.25, 0.3), c - vec2(-0.25, 0.3)) * 9.0));
  else if (vKind < 1.5) shape = (1.0 - smoothstep(0.35, 1.0, r2)) * (0.35 + 0.65 * smoothstep(0.1, 0.75, r2));
  else if (vKind < 3.5) shape = exp(-r2 * 2.6) * (1.0 - r2);
  else {
    // Upright burst: a column that shoots up and slumps, a crown skirt at the waterline, a ragged top.
    float h = q.y * 0.5 + 0.5;
    float ax = abs(q.x);
    float seed = fract(vWorld.x * 0.37 + vWorld.z * 0.61);
    float rise = smoothstep(0.0, 0.25, vT) * (1.0 - 0.45 * vT);
    float top = rise * (0.95 - 0.55 * ax + 0.1 * sin(q.x * 13.0 + seed * 40.0));
    float column = (1.0 - smoothstep(0.16, 0.3, ax + 0.18 * h)) * (1.0 - smoothstep(top - 0.14, top, h));
    float skirt = (1.0 - smoothstep(0.45, 0.9, ax + 0.4 * h)) * (1.0 - smoothstep(0.1, 0.32, h));
    float spray = (1.0 - smoothstep(0.02, 0.1, abs(ax - 0.42 - 0.3 * h))) * smoothstep(0.1, 0.2, h) * (1.0 - smoothstep(0.3, 0.55 * rise + 0.1, h));
    shape = max(max(column, skirt), spray * 0.7) * smoothstep(0.0, 0.04, h);
  }
  float a = vAlpha * shape;
  if (a < 0.004) discard;
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 L = normalize(uSunDir);
  // Spray is bright white; backlit it glows (forward scattering toward the viewer).
  float fwd = pow(max(dot(-V, L), 0.0), 6.0);
  vec3 sun = uSunRadiance * step(0.0, L.y) * (0.8 + (vKind > 1.5 && vKind < 3.5 ? 0.6 : 2.2) * fwd);
  vec3 col = vec3(0.92, 0.96, 1.0) * (sun + uHemiSky * 1.4) * RECIPROCAL_PI;
  // Sunlit spray outshines the sky it is seen against (the sea near the horizon mirrors that sky).
  if (vKind > 3.5) col = max(col * 1.5, uHorizonColor * 2.2);
  gl_FragColor = vec4(col, a);
#if defined( KODIAK_SKY_FOG ) && defined( USE_FOG ) && defined( FOG_EXP2 )
  // Readability: a white fleck moving on the water carries through haze that hides static detail, so the far plume
  // is fogged at a reduced density (companion to the minimum-size rule).
  if (vKind > 3.5) gl_FragColor.rgb = kodiakApplyFog(gl_FragColor.rgb, vWorld, fogColor, fogDensity * 0.45);
  else {
    #include <fog_fragment>
  }
#else
  #include <fog_fragment>
#endif
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const GLINT_VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec4 aLife; // start, life, pixel size, strength
uniform float uTime;
uniform float uPixelRatio;
varying float vI;
varying vec3 vGWorld;
void main() {
  float age = uTime - aLife.x;
  if (age < 0.0 || age > aLife.y) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  float t = age / aLife.y;
  vec4 mvPosition = viewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  float env = sin(3.14159 * t);
  gl_PointSize = aLife.z * uPixelRatio * (0.55 + 0.45 * env);
  vI = aLife.w * env * env;
  vGWorld = position;
  #include <fog_vertex>
}
`;

const GLINT_FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform vec3 uSunRadiance;
varying float vI;
varying vec3 vGWorld;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  float core = exp(-r2 * 11.0);
  float halo = exp(-r2 * 3.0) * 0.25;
  float rays = exp(-abs(c.x) * 22.0) * exp(-abs(c.y) * 1.7) + exp(-abs(c.y) * 22.0) * exp(-abs(c.x) * 1.7);
  float diag = exp(-abs(c.x - c.y) * 30.0) * exp(-abs(c.x + c.y) * 3.5) + exp(-abs(c.x + c.y) * 30.0) * exp(-abs(c.x - c.y) * 3.5);
  float a = (core * 1.4 + halo + rays * 0.7 + diag * 0.25) * vI;
  if (a < 0.003) discard;
  gl_FragColor = vec4(uSunRadiance * (0.6 + 0.4 * core) * a * 1.6, 1.0);
#if defined( KODIAK_SKY_FOG ) && defined( USE_FOG ) && defined( FOG_EXP2 )
  gl_FragColor.rgb = kodiakApplyFog(gl_FragColor.rgb, vGWorld, vec3(0.0), fogDensity * 0.35);
#else
  #include <fog_fragment>
#endif
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const RING_VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec4 aRingA; // centre xyz, start
attribute vec4 aRingB; // life, r0, rMax, strength
uniform float uTime;
varying vec2 vUv2;
varying float vT;
varying float vStrength;
varying float vWidth;
void main() {
  float age = uTime - aRingA.w;
  if (age < 0.0 || age > aRingB.x) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float t = age / aRingB.x;
  vec3 c = aRingA.xyz;
  float S = max(1.0, 0.004 * distance(c, cameraPosition) / max(aRingB.z * 0.35, 0.05));
  float radius = mix(aRingB.y, aRingB.z, 1.0 - (1.0 - t) * (1.0 - t)) * S;
  float ext = radius * 1.25 + 0.05;
  vec3 p = c + vec3(position.x * ext * 2.0, 0.0, position.z * ext * 2.0);
  vUv2 = position.xz * 2.0 * 1.25;
  vT = t;
  vStrength = aRingB.w;
  vWidth = mix(0.12, 0.05, t);
  vec4 mvPosition = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const RING_FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform vec3 uHemiSky;
uniform vec3 uHorizonColor;
varying vec2 vUv2;
varying float vT;
varying float vStrength;
varying float vWidth;
void main() {
  float r = length(vUv2);
  float w = max(vWidth, fwidth(r) * 1.5);
  float crest = exp(-pow((r - 1.0) / w, 2.0));
  float trough = exp(-pow((r - 1.0 + 1.8 * w) / w, 2.0));
  float inner = exp(-pow((r - 0.62) / (w * 1.4), 2.0)) * 0.45;
  float fade = (1.0 - vT) * (1.0 - vT);
  float a = (crest + inner) * fade * vStrength;
  vec3 col = mix(uHorizonColor, uHemiSky, 0.4) * 1.15;
  a = clamp(a - trough * fade * vStrength * 0.4, 0.0, 1.0) * 0.55;
  if (a < 0.004) discard;
  gl_FragColor = vec4(col, a);
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const WAKE_VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec4 aWakeA; // apex xyz, heading
attribute vec4 aWakeB; // length, strength, time offset, unused
varying vec2 vW;
varying float vStrength;
varying float vPhase;
void main() {
  if (aWakeB.y <= 0.001) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float S = max(1.0, 0.004 * distance(aWakeA.xyz, cameraPosition) / max(aWakeB.x * 0.25, 0.05));
  float L = aWakeB.x * S;
  // position.xz in [-0.5, 0.5]: x across, z along (+z = behind the apex).
  vec2 local = vec2(position.x * L * 0.9, (position.z + 0.5) * L);
  float h = aWakeA.w;
  vec2 fwd = vec2(sin(h), -cos(h));
  vec2 rgt = vec2(cos(h), sin(h));
  vec2 xz = aWakeA.xz + rgt * local.x - fwd * (local.y - 0.1 * L);
  vW = vec2(position.x * 0.9, position.z + 0.5);
  vStrength = aWakeB.y;
  vPhase = aWakeB.z;
  vec4 mvPosition = viewMatrix * vec4(xz.x, aWakeA.y, xz.y, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const WAKE_FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform vec3 uHemiSky;
uniform vec3 uHorizonColor;
uniform float uTime;
varying vec2 vW;
varying float vStrength;
varying float vPhase;
void main() {
  float along = vW.y;           // 0 at the apex, 1 at the tail of the wake
  float across = abs(vW.x);     // 0 on the track
  float arm = along * 0.36;     // Kelvin-ish half angle ~20°
  // Keep the arms at least ~1.5 px wide so the V still reads from the crow's nest.
  float w = max(0.022 + 0.035 * along, fwidth(across) * 1.5);
  float line = exp(-pow((across - arm) / w, 2.0));
  float inner = exp(-pow((across - arm * 0.55) / (w * 1.3), 2.0)) * 0.35;
  float ripple = 0.75 + 0.25 * sin(along * 60.0 - uTime * 7.0 + vPhase);
  float head = exp(-along * 18.0) * exp(-across * across * 200.0) * 1.6;
  float a = ((line + inner) * ripple * (1.0 - along) * (1.0 - along) + head) * vStrength * 0.8;
  if (a < 0.004) discard;
  vec3 col = mix(uHorizonColor, uHemiSky, 0.3) * 1.5;
  gl_FragColor = vec4(col, a);
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function fogUniforms(extra) {
  return Object.assign(THREE.UniformsUtils.merge([THREE.UniformsLib.fog]), extra);
}

export function createFishFx(ctx, { lighting, quality }) {
  const scene = ctx.scene;
  const U = ctx.uniforms;
  const low = quality?.name === 'low';
  const PCOUNT = low ? 2048 : 4096;
  const GCOUNT = 96;
  const RCOUNT = 96;
  const WCOUNT = 32;

  // --- splash particles ---
  const pPos = new Float32Array(PCOUNT * 3);
  const pVel = new Float32Array(PCOUNT * 4);
  const pLife = new Float32Array(PCOUNT * 4).fill(-1000);
  const pRef = new Float32Array(PCOUNT).fill(1);
  const pg = new THREE.BufferGeometry();
  const attrP = new THREE.BufferAttribute(pPos, 3).setUsage(THREE.DynamicDrawUsage);
  const attrV = new THREE.BufferAttribute(pVel, 4).setUsage(THREE.DynamicDrawUsage);
  const attrL = new THREE.BufferAttribute(pLife, 4).setUsage(THREE.DynamicDrawUsage);
  const attrR = new THREE.BufferAttribute(pRef, 1).setUsage(THREE.DynamicDrawUsage);
  pg.setAttribute('position', attrP);
  pg.setAttribute('aVel', attrV);
  pg.setAttribute('aLife', attrL);
  pg.setAttribute('aRef', attrR);
  pg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  const skyFog = THREE.ShaderChunk.kodiak_sky_fog_pars ? { KODIAK_SKY_FOG: '' } : {};
  const pMat = new THREE.ShaderMaterial({
    name: 'kodiak-fish-splash',
    defines: { ...skyFog },
    uniforms: fogUniforms({
      uTime: U.uTime,
      uProjScale: { value: 600 },
      uViewport: { value: new THREE.Vector2(1280, 720) },
      uSunDir: U.uSunDir,
      uSunRadiance: lighting.uSunRadiance,
      uHemiSky: lighting.uHemiSky,
      uHorizonColor: U.uHorizonColor,
    }),
    vertexShader: PARTICLE_VERT,
    fragmentShader: PARTICLE_FRAG,
    transparent: true,
    depthWrite: false,
    fog: true,
  });
  const points = new THREE.Points(pg, pMat);
  points.frustumCulled = false;
  points.renderOrder = 200;
  points.name = 'fish-splash';
  scene.add(points);
  let pHead = 0;
  let pMin = Infinity;
  let pMax = -1;
  let pAliveUntil = -1;
  let gAliveUntil = -1;
  let rAliveUntil = -1;

  function emitParticle(x, y, z, vx, vy, vz, drag, start, life, size, kind, ref) {
    const i = pHead;
    pHead = (pHead + 1) % PCOUNT;
    pPos[i * 3] = x;
    pPos[i * 3 + 1] = y;
    pPos[i * 3 + 2] = z;
    pVel[i * 4] = vx;
    pVel[i * 4 + 1] = vy;
    pVel[i * 4 + 2] = vz;
    pVel[i * 4 + 3] = drag;
    pLife[i * 4] = start;
    pLife[i * 4 + 1] = life;
    pAliveUntil = Math.max(pAliveUntil, start + life);
    pLife[i * 4 + 2] = size;
    pLife[i * 4 + 3] = kind;
    pRef[i] = ref;
    if (i < pMin) pMin = i;
    if (i > pMax) pMax = i;
  }

  // --- glints ---
  const gPos = new Float32Array(GCOUNT * 3);
  const gLife = new Float32Array(GCOUNT * 4).fill(-1000);
  const gg = new THREE.BufferGeometry();
  const attrGP = new THREE.BufferAttribute(gPos, 3).setUsage(THREE.DynamicDrawUsage);
  const attrGL = new THREE.BufferAttribute(gLife, 4).setUsage(THREE.DynamicDrawUsage);
  gg.setAttribute('position', attrGP);
  gg.setAttribute('aLife', attrGL);
  gg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  const gMat = new THREE.ShaderMaterial({
    name: 'kodiak-fish-glint',
    defines: { ...skyFog },
    uniforms: fogUniforms({ uTime: U.uTime, uPixelRatio: { value: 1 }, uSunRadiance: lighting.uSunRadiance }),
    vertexShader: GLINT_VERT,
    fragmentShader: GLINT_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,
  });
  const glints = new THREE.Points(gg, gMat);
  glints.frustumCulled = false;
  glints.renderOrder = 400;
  glints.name = 'fish-glints';
  scene.add(glints);
  let gHead = 0;
  const gDirty = [Infinity, -1];

  // --- rings ---
  const plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const rg = new THREE.InstancedBufferGeometry();
  rg.index = plane.index;
  rg.setAttribute('position', plane.getAttribute('position'));
  const rA = new Float32Array(RCOUNT * 4);
  const rB = new Float32Array(RCOUNT * 4);
  for (let i = 0; i < RCOUNT; i++) rA[i * 4 + 3] = -1000;
  const attrRA = new THREE.InstancedBufferAttribute(rA, 4).setUsage(THREE.DynamicDrawUsage);
  const attrRB = new THREE.InstancedBufferAttribute(rB, 4).setUsage(THREE.DynamicDrawUsage);
  rg.setAttribute('aRingA', attrRA);
  rg.setAttribute('aRingB', attrRB);
  rg.instanceCount = RCOUNT;
  rg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  const rMat = new THREE.ShaderMaterial({
    name: 'kodiak-fish-ring',
    uniforms: fogUniforms({ uTime: U.uTime, uHemiSky: lighting.uHemiSky, uHorizonColor: U.uHorizonColor }),
    vertexShader: RING_VERT,
    fragmentShader: RING_FRAG,
    transparent: true,
    depthWrite: false,
    fog: true,
  });
  const rings = new THREE.Mesh(rg, rMat);
  rings.frustumCulled = false;
  rings.renderOrder = 100;
  rings.name = 'fish-rings';
  scene.add(rings);
  let rHead = 0;
  const rDirty = [Infinity, -1];

  // --- finning V-wakes ---
  const wg = new THREE.InstancedBufferGeometry();
  const wplane = new THREE.PlaneGeometry(1, 1, 1, 6).rotateX(-Math.PI / 2);
  wg.index = wplane.index;
  wg.setAttribute('position', wplane.getAttribute('position'));
  const wA = new Float32Array(WCOUNT * 4);
  const wB = new Float32Array(WCOUNT * 4);
  const attrWA = new THREE.InstancedBufferAttribute(wA, 4).setUsage(THREE.DynamicDrawUsage);
  const attrWB = new THREE.InstancedBufferAttribute(wB, 4).setUsage(THREE.DynamicDrawUsage);
  wg.setAttribute('aWakeA', attrWA);
  wg.setAttribute('aWakeB', attrWB);
  wg.instanceCount = 0;
  wg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  const wMat = new THREE.ShaderMaterial({
    name: 'kodiak-fish-wake',
    uniforms: fogUniforms({ uTime: U.uTime, uHemiSky: lighting.uHemiSky, uHorizonColor: U.uHorizonColor }),
    vertexShader: WAKE_VERT,
    fragmentShader: WAKE_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
  });
  const wakes = new THREE.Mesh(wg, wMat);
  wakes.frustumCulled = false;
  wakes.renderOrder = 101;
  wakes.name = 'fish-wakes';
  scene.add(wakes);

  const now = () => U.uTime.value;
  const rnd = Math.random;

  // A splash at the surface. strength ~0.3 (sockeye knife-entry) … 1.5 (chum falling flat); size = fish length (m);
  // (hx, hz) = travel direction of the fish; flat = landing on its side.
  function splash(x, y, z, { strength = 0.5, size = 0.6, hx = 0, hz = -1, flat = 0, distance = 0 } = {}) {
    const t0 = now();
    const k = Math.sqrt(size / 0.6);
    const s = strength * k;
    const far = distance > 500;
    const nDrop = Math.round((far ? 4 : 14) + (far ? 10 : 46) * s);
    const nSheet = Math.round(8 + 16 * s);
    const nMist = Math.round(1 + 3 * s);
    const ref = 0.5 + 1.1 * s;
    const up = 1.2 + 2.6 * Math.sqrt(s);
    for (let i = 0; i < nSheet; i++) {
      const a = (i / nSheet) * Math.PI * 2 + rnd() * 0.4;
      const out = (0.6 + 0.9 * rnd()) * (0.6 + 0.6 * s);
      let vx = Math.cos(a) * out;
      let vz = Math.sin(a) * out;
      if (flat > 0) {
        // Belly-flop: the sheet is thrown out to the sides of the fish.
        const side = -hz * Math.cos(a) + hx * Math.sin(a);
        vx += -hz * side * flat * 1.2;
        vz += hx * side * flat * 1.2;
      }
      emitParticle(x + Math.cos(a) * 0.12 * k, y + 0.02, z + Math.sin(a) * 0.12 * k, vx, up * (0.55 + 0.45 * rnd()), vz, 1.0, t0, 0.35 + 0.25 * rnd(), 0.035 + 0.045 * s, 1, ref);
    }
    for (let i = 0; i < nDrop; i++) {
      const a = rnd() * Math.PI * 2;
      const out = (0.2 + 1.4 * rnd()) * (0.5 + 0.5 * s);
      emitParticle(x, y + 0.05, z, Math.cos(a) * out + hx * 0.4, up * (0.6 + 0.8 * rnd()), Math.sin(a) * out + hz * 0.4, 0.3, t0 + rnd() * 0.06, 0.55 + 0.5 * rnd(), 0.012 + 0.018 * rnd() * (0.6 + s), 0, ref);
    }
    // A central column (Worthington jet) for the heavier entries.
    if (s > 0.55) {
      for (let i = 0; i < 8; i++) emitParticle(x, y + 0.05, z, (rnd() - 0.5) * 0.3, up * (1.05 + 0.3 * rnd()), (rnd() - 0.5) * 0.3, 0.4, t0 + 0.08 + i * 0.02, 0.5, 0.04 + 0.03 * s, 1, ref);
    }
    emitParticle(x, y, z, 0, 0, 0, 0, t0, 1.1 + 0.4 * s, ref, 4, ref);
    for (let i = 0; i < nMist; i++) {
      const a = rnd() * Math.PI * 2;
      emitParticle(x, y + 0.1, z, Math.cos(a) * 0.6 * s, 0.4 + 0.5 * rnd(), Math.sin(a) * 0.6 * s, 1.6, t0 + 0.05 + rnd() * 0.1, 1.0 + 0.8 * rnd(), 0.25 + 0.35 * s, 2, ref);
    }
  }

  // Small spray (a tail-walk kick, a fish rolling at the surface, fish flipping in the bag).
  function spray(x, y, z, { strength = 0.3, size = 0.6, hx = 0, hz = -1 } = {}) {
    const t0 = now();
    const s = strength * Math.sqrt(size / 0.6);
    const n = Math.round(4 + 10 * s);
    const ref = 0.35 + 0.8 * s;
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2;
      const out = 0.3 + 1.0 * rnd();
      emitParticle(x, y + 0.03, z, Math.cos(a) * out - hx * 0.8, 1.0 + 1.6 * rnd() * (0.5 + s), Math.sin(a) * out - hz * 0.8, 0.4, t0, 0.4 + 0.35 * rnd(), 0.012 + 0.016 * rnd(), 0, ref);
    }
    if (rnd() < 0.12) emitParticle(x, y + 0.08, z, -hx * 0.3, 0.4, -hz * 0.3, 1.8, t0, 0.7 + 0.4 * rnd(), 0.15 + 0.2 * s, 2, ref);
    if (rnd() < 0.5) emitParticle(x, y, z, 0, 0, 0, 0, t0, 0.8, ref * 0.8, 4, ref);
    if (rnd() < 0.6) emitParticle(x, y + 0.02, z, 0, 0.6, 0, 1.4, t0, 0.35, 0.05 + 0.05 * s, 1, ref);
  }

  function glint(x, y, z, { strength = 1, px = 18, life = 0.18 } = {}) {
    const i = gHead;
    gHead = (gHead + 1) % GCOUNT;
    gPos[i * 3] = x;
    gPos[i * 3 + 1] = y;
    gPos[i * 3 + 2] = z;
    gLife[i * 4] = now();
    gLife[i * 4 + 1] = life;
    gAliveUntil = Math.max(gAliveUntil, now() + life);
    gLife[i * 4 + 2] = px;
    gLife[i * 4 + 3] = strength;
    gDirty[0] = Math.min(gDirty[0], i);
    gDirty[1] = Math.max(gDirty[1], i);
  }

  function ring(x, y, z, { r0 = 0.2, rMax = 2.5, life = 5, strength = 0.8 } = {}) {
    const i = rHead;
    rHead = (rHead + 1) % RCOUNT;
    rA[i * 4] = x;
    rA[i * 4 + 1] = y;
    rA[i * 4 + 2] = z;
    rA[i * 4 + 3] = now();
    rB[i * 4] = life;
    rAliveUntil = Math.max(rAliveUntil, now() + life);
    rB[i * 4 + 1] = r0;
    rB[i * 4 + 2] = rMax;
    rB[i * 4 + 3] = strength;
    rDirty[0] = Math.min(rDirty[0], i);
    rDirty[1] = Math.max(rDirty[1], i);
  }

  // V-wakes are rewritten every frame from the renderer's finners: list of { x, y, z, heading, length, strength }.
  function setWakes(list) {
    const n = Math.min(WCOUNT, list.length);
    for (let i = 0; i < n; i++) {
      const w = list[i];
      wA[i * 4] = w.x;
      wA[i * 4 + 1] = w.y;
      wA[i * 4 + 2] = w.z;
      wA[i * 4 + 3] = w.heading;
      wB[i * 4] = w.length;
      wB[i * 4 + 1] = w.strength;
      wB[i * 4 + 2] = w.phase ?? i * 1.7;
    }
    wg.instanceCount = n;
    if (n) {
      attrWA.clearUpdateRanges();
      attrWB.clearUpdateRanges();
      attrWA.addUpdateRange(0, n * 4);
      attrWB.addUpdateRange(0, n * 4);
      attrWA.needsUpdate = true;
      attrWB.needsUpdate = true;
    }
  }

  function flushRange(attr, lo, hi, itemSize) {
    if (hi < lo) return;
    attr.clearUpdateRanges();
    attr.addUpdateRange(lo * itemSize, (hi - lo + 1) * itemSize);
    attr.needsUpdate = true;
  }

  // Upload this frame's writes (one range per attribute; a wrapped ring buffer uploads the span).
  function flush() {
    const t = now();
    points.visible = t <= pAliveUntil;
    glints.visible = t <= gAliveUntil;
    rings.visible = t <= rAliveUntil;
    wakes.visible = wg.instanceCount > 0;
    if (pMax >= 0) {
      flushRange(attrP, pMin, pMax, 3);
      flushRange(attrV, pMin, pMax, 4);
      flushRange(attrL, pMin, pMax, 4);
      flushRange(attrR, pMin, pMax, 1);
      pMin = Infinity;
      pMax = -1;
    }
    if (gDirty[1] >= 0) {
      flushRange(attrGP, gDirty[0], gDirty[1], 3);
      flushRange(attrGL, gDirty[0], gDirty[1], 4);
      gDirty[0] = Infinity;
      gDirty[1] = -1;
    }
    if (rDirty[1] >= 0) {
      flushRange(attrRA, rDirty[0], rDirty[1], 4);
      flushRange(attrRB, rDirty[0], rDirty[1], 4);
      rDirty[0] = Infinity;
      rDirty[1] = -1;
    }
  }

  function setProjection(camera, renderer) {
    const h = renderer?.domElement?.height ?? 720;
    pMat.uniforms.uProjScale.value = (h / 2) * camera.projectionMatrix.elements[5];
    pMat.uniforms.uViewport.value.set(renderer?.domElement?.width ?? 1280, h);
    gMat.uniforms.uPixelRatio.value = Math.max(1, h / 720);
  }

  function liveParticles() {
    const t = now();
    let n = 0;
    for (let i = 0; i < PCOUNT; i++) if (t - pLife[i * 4] < pLife[i * 4 + 1]) n++;
    return n;
  }

  function clear() {
    pAliveUntil = gAliveUntil = rAliveUntil = -1;
    pLife.fill(-1000);
    gLife.fill(-1000);
    for (let i = 0; i < RCOUNT; i++) rA[i * 4 + 3] = -1000;
    flushRange(attrL, 0, PCOUNT - 1, 4);
    flushRange(attrGL, 0, GCOUNT - 1, 4);
    flushRange(attrRA, 0, RCOUNT - 1, 4);
    wg.instanceCount = 0;
  }

  return { splash, spray, glint, ring, setWakes, flush, setProjection, liveParticles, clear, objects: [points, glints, rings, wakes] };
}
