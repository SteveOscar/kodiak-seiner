// Point-sprite effects for the boats: a world-space particle pool (exhaust smoke, bow spray, splashes; render band
// 200) and glow sprites for navigation/deck lights (band 400, additive). Both use custom ShaderMaterials that follow
// the fog/colour contract and draw in one call each.

import * as THREE from 'three';
import { createSoftSprite } from './textures.js';

let spriteTex = null;
let glowTex = null;
const softTex = new Map();
const sprite = (falloff = 1.6) => {
  if (falloff === 1.6) return (spriteTex ??= createSoftSprite(64, { falloff }));
  if (!softTex.has(falloff)) softTex.set(falloff, createSoftSprite(64, { falloff }));
  return softTex.get(falloff);
};
const glowSprite = () => (glowTex ??= createSoftSprite(64, { falloff: 2.6 }));

const _v = new THREE.Vector2();

// Updates the projection scale uniform (pixels per unit at 1 m) from the live camera and drawing buffer.
export function projScale(renderer, camera) {
  renderer.getDrawingBufferSize(_v);
  return _v.y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5));
}

const PARTICLE_VS = /* glsl */ `
uniform float uScale;
uniform vec2 uNearFade;
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
varying float vAlpha;
varying vec3 vColor;
#include <common>
#include <fog_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = clamp(aSize * uScale / max(0.1, -mvPosition.z), 0.0, 400.0);
  // Sub-pixel particles fade instead of shimmering.
  vAlpha = aAlpha * clamp(gl_PointSize / 1.5, 0.0, 1.0);
  // Optional fade for particles right in front of the lens (a puff drifting past the camera must not blot the view).
  if (uNearFade.y > 0.0) vAlpha *= smoothstep(uNearFade.x, uNearFade.y, -mvPosition.z);
  gl_PointSize = max(gl_PointSize, 1.5);
  vColor = aColor;
  #include <fog_vertex>
}`;

const PARTICLE_FS = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uLight;
varying float vAlpha;
varying vec3 vColor;
#include <common>
#include <fog_pars_fragment>
void main() {
  float a = texture2D(uMap, gl_PointCoord).a * vAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor * uLight, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

// Pool of world-space particles. emit() returns false when full (oldest are not recycled: effects are short-lived).
// falloff: sprite edge softness (higher = softer, smaller core); nearFade: [from, to] metres from the camera over which
// particles fade in (off by default).
export function createParticlePool(ctx, { max = 256, renderOrder = 200, blending = THREE.NormalBlending, name = 'particles', falloff = 1.6, nearFade = null } = {}) {
  const pos = new Float32Array(max * 3);
  const size = new Float32Array(max);
  const alpha = new Float32Array(max);
  const color = new Float32Array(max * 3);
  const vel = new Float32Array(max * 3);
  const life = new Float32Array(max);
  const maxLife = new Float32Array(max);
  const size0 = new Float32Array(max);
  const size1 = new Float32Array(max);
  const alpha0 = new Float32Array(max);
  const drag = new Float32Array(max);
  const grav = new Float32Array(max);
  const buoy = new Float32Array(max);
  let count = 0;
  const geo = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const aSize = new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage);
  const aAlpha = new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage);
  const aColor = new THREE.BufferAttribute(color, 3).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', aPos);
  geo.setAttribute('aSize', aSize);
  geo.setAttribute('aAlpha', aAlpha);
  geo.setAttribute('aColor', aColor);
  geo.setDrawRange(0, 0);
  const mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uScale: { value: 600 }, uMap: { value: null }, uLight: { value: new THREE.Color(1, 1, 1) }, uNearFade: { value: new THREE.Vector2(0, 0) } }]),
    vertexShader: PARTICLE_VS,
    fragmentShader: PARTICLE_FS,
    transparent: true,
    depthWrite: false,
    blending,
    fog: true,
  });
  mat.uniforms.uMap.value = sprite(falloff);
  if (nearFade) mat.uniforms.uNearFade.value.set(nearFade[0], nearFade[1]);
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = renderOrder;
  points.name = name;
  ctx.scene.add(points);

  const pool = {
    points,
    material: mat,
    get count() {
      return count;
    },
    // o: { x, y, z, vx, vy, vz, life, size0, size1, alpha, color: [r, g, b] linear, drag, gravity, buoyancy }
    emit(o) {
      if (count >= max) return false;
      const i = count++;
      pos[i * 3] = o.x;
      pos[i * 3 + 1] = o.y;
      pos[i * 3 + 2] = o.z;
      vel[i * 3] = o.vx ?? 0;
      vel[i * 3 + 1] = o.vy ?? 0;
      vel[i * 3 + 2] = o.vz ?? 0;
      life[i] = 0;
      maxLife[i] = o.life ?? 1;
      size0[i] = o.size0 ?? 0.5;
      size1[i] = o.size1 ?? size0[i];
      alpha0[i] = o.alpha ?? 1;
      drag[i] = o.drag ?? 0.5;
      grav[i] = o.gravity ?? 0;
      buoy[i] = o.buoyancy ?? 0;
      const c = o.color ?? [1, 1, 1];
      color[i * 3] = c[0];
      color[i * 3 + 1] = c[1];
      color[i * 3 + 2] = c[2];
      size[i] = size0[i];
      alpha[i] = 0;
      return true;
    },
    // wind: {x, z} m/s; floor(x, z) → y below which a falling particle dies (water surface).
    update(dt, wind = { x: 0, z: 0 }, floor = null) {
      if (!count) {
        geo.setDrawRange(0, 0);
        return;
      }
      let i = 0;
      while (i < count) {
        life[i] += dt;
        const k = life[i] / maxLife[i];
        let dead = k >= 1;
        if (!dead) {
          const d = Math.exp(-drag[i] * dt);
          vel[i * 3] = wind.x + (vel[i * 3] - wind.x) * d;
          vel[i * 3 + 2] = wind.z + (vel[i * 3 + 2] - wind.z) * d;
          vel[i * 3 + 1] = vel[i * 3 + 1] * d - grav[i] * dt + buoy[i] * dt;
          pos[i * 3] += vel[i * 3] * dt;
          pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
          pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
          if (floor && grav[i] > 0 && vel[i * 3 + 1] < 0 && pos[i * 3 + 1] < floor(pos[i * 3], pos[i * 3 + 2])) dead = true;
        }
        if (dead) {
          // Swap-remove.
          const j = --count;
          if (i !== j) {
            for (let c = 0; c < 3; c++) {
              pos[i * 3 + c] = pos[j * 3 + c];
              vel[i * 3 + c] = vel[j * 3 + c];
              color[i * 3 + c] = color[j * 3 + c];
            }
            life[i] = life[j];
            maxLife[i] = maxLife[j];
            size0[i] = size0[j];
            size1[i] = size1[j];
            alpha0[i] = alpha0[j];
            drag[i] = drag[j];
            grav[i] = grav[j];
            buoy[i] = buoy[j];
          }
          continue;
        }
        size[i] = size0[i] + (size1[i] - size0[i]) * Math.sqrt(k);
        // Quick fade in, long fade out.
        alpha[i] = alpha0[i] * Math.min(1, k * 8) * (1 - k) * (1 - k * 0.3);
        i++;
      }
      geo.setDrawRange(0, count);
      aPos.needsUpdate = true;
      aSize.needsUpdate = true;
      aAlpha.needsUpdate = true;
      aColor.needsUpdate = true;
      aPos.clearUpdateRanges();
      aPos.addUpdateRange(0, count * 3);
      aSize.clearUpdateRanges();
      aSize.addUpdateRange(0, count);
      aAlpha.clearUpdateRanges();
      aAlpha.addUpdateRange(0, count);
      aColor.clearUpdateRanges();
      aColor.addUpdateRange(0, count * 3);
    },
    clear() {
      count = 0;
      geo.setDrawRange(0, 0);
    },
  };
  return pool;
}

// COLREGS light sectors in a boat's local frame (bow toward -z): sidelights from dead ahead to 22.5 degrees abaft the
// beam on their own side, the masthead light over the forward 225 degrees, the stern light over the after 135.
// Each sector is widened by a few degrees so both sidelights show solidly from dead ahead (the real lights overlap
// slightly across the bow) instead of both sitting on their soft cut-off.
const DEG = Math.PI / 180;
const SIDE = (112.5 / 2) * DEG;
const OVERLAP = 5 * DEG;
export const ARCS = Object.freeze({
  port: { dir: [-Math.sin(SIDE), 0, -Math.cos(SIDE)], half: SIDE + OVERLAP },
  starboard: { dir: [Math.sin(SIDE), 0, -Math.cos(SIDE)], half: SIDE + OVERLAP },
  masthead: { dir: [0, 0, -1], half: 112.5 * DEG + OVERLAP },
  stern: { dir: [0, 0, 1], half: 67.5 * DEG + OVERLAP },
  // Deck floods shine down and aft onto the working deck; from ahead and below only the dark housing shows.
  floodAft: { dir: [0, -0.85, 0.53], half: 1.4 },
});

const GLOW_VS = /* glsl */ `
uniform float uScale;
uniform float uNight;
attribute float aSize;
attribute float aOn;
attribute vec3 aColor;
attribute vec4 aArc; // xyz: axis the light shines along (zero = all-round), w: cosine of the half-arc
varying vec3 vColor;
varying float vFade;
varying float vGlowDepth;
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  float dist = max(0.1, -mvPosition.z);
  vGlowDepth = dist;
  float px = aSize * uScale / dist;
  // Lights keep a minimum on-screen size so they read across a bay at night, fading with distance.
  float minPx = 3.0 * uNight;
  gl_PointSize = clamp(max(px, minPx), 0.0, 180.0);
  vFade = aOn * uNight * clamp(px / 0.6 + 0.35, 0.0, 1.0);
  // Sectored lights (COLREGS arcs for sidelights, masthead and stern lights; floods facing their deck) fade out
  // beyond their arc. Horizontal axes compare bearings only, so a sidelight still shows from the crow's nest.
  if (dot(aArc.xyz, aArc.xyz) > 0.0) {
    vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
    vec3 axis = normalize(mat3(modelMatrix) * aArc.xyz);
    vec3 toCam = cameraPosition - wp;
    if (abs(aArc.y) < 0.01) {
      axis.y = 0.0;
      toCam.y = 0.0;
      axis = normalize(axis);
    }
    float c = dot(normalize(toCam + vec3(1e-4, 0.0, 0.0)), axis);
    vFade *= smoothstep(aArc.w - 0.06, aArc.w + 0.06, c);
  }
  vColor = aColor;
}`;

const GLOW_FS = /* glsl */ `
uniform sampler2D uMap;
uniform float uFogKeep;
uniform float fogDensity;
varying vec3 vColor;
varying float vFade;
varying float vGlowDepth;
#include <common>
void main() {
  if (vFade < 0.003) discard;
  float a = texture2D(uMap, gl_PointCoord).a;
  float core = smoothstep(0.55, 0.95, a);
  vec3 c = vColor * (a * 0.9 + core * 2.5) * vFade;
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  // Lights punch through haze: only part of the fog applies (additive, so fog dims toward black, not fogColor).
  float kFog = 1.0 - exp( - fogDensity * fogDensity * vGlowDepth * vGlowDepth );
  gl_FragColor.rgb *= 1.0 - kFog * uFogKeep;
}`;

// Glow sprites. lights: [{ pos: [x,y,z] (local to `parent`), color: hex, size: m, on: bool,
//   arc?: { dir: [x,y,z] (local axis), half: radians } }]. Without `arc` a light shows all round.
export function createGlowSet(ctx, lights, { parent = null, renderOrder = 400, name = 'glows' } = {}) {
  const n = lights.length;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const size = new Float32Array(n);
  const on = new Float32Array(n);
  const arc = new Float32Array(n * 4);
  const c = new THREE.Color();
  lights.forEach((l, i) => {
    pos.set(l.pos, i * 3);
    c.set(l.color ?? 0xffffff).multiplyScalar(l.intensity ?? 1);
    col.set([c.r, c.g, c.b], i * 3);
    size[i] = l.size ?? 0.8;
    on[i] = l.on === false ? 0 : 1;
    if (l.arc) arc.set([...l.arc.dir, Math.cos(l.arc.half)], i * 4);
  });
  const geo = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const aOn = new THREE.BufferAttribute(on, 1).setUsage(THREE.DynamicDrawUsage);
  const aArc = new THREE.BufferAttribute(arc, 4).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', aPos);
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('aOn', aOn);
  geo.setAttribute('aArc', aArc);
  const mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      { uScale: { value: 600 }, uNight: { value: 0 }, uMap: { value: null }, uFogKeep: { value: 0.75 } },
    ]),
    vertexShader: GLOW_VS,
    fragmentShader: GLOW_FS,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    // fog: true keeps fogDensity refreshed from scene.fog; the shader applies its own partial fog.
    fog: true,
  });
  mat.uniforms.uMap.value = glowSprite();
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = renderOrder;
  points.name = name;
  (parent ?? ctx.scene).add(points);
  return {
    points,
    material: mat,
    setOn(i, v) {
      const val = v ? 1 : 0;
      if (on[i] !== val) {
        on[i] = val;
        aOn.needsUpdate = true;
      }
    },
    setPos(i, x, y, z) {
      pos[i * 3] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z;
      aPos.needsUpdate = true;
    },
    // Arc axis in the set's space (world space for an unparented set); cosine of the half-arc is kept.
    setArcDir(i, x, y, z) {
      if (arc[i * 4] === x && arc[i * 4 + 1] === y && arc[i * 4 + 2] === z) return;
      arc[i * 4] = x;
      arc[i * 4 + 1] = y;
      arc[i * 4 + 2] = z;
      aArc.needsUpdate = true;
    },
    set night(v) {
      mat.uniforms.uNight.value = v;
    },
    set scale(v) {
      mat.uniforms.uScale.value = v;
    },
  };
}

const POOL_VS = /* glsl */ `
uniform float uNight;
attribute vec4 aPool; // world centre x, y, z; radius
attribute vec3 aColor;
varying vec2 vQ;
varying vec3 vColor;
varying float vPoolDepth;
void main() {
  vQ = position.xz;
  vec3 wp = aPool.xyz + vec3(position.x * aPool.w, 0.0, position.z * aPool.w);
  vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  vPoolDepth = -mvPosition.z;
  vColor = aColor * uNight;
}`;

const POOL_FS = /* glsl */ `
uniform float fogDensity;
varying vec2 vQ;
varying vec3 vColor;
varying float vPoolDepth;
#include <common>
void main() {
  float r = length(vQ);
  float a = exp(-r * r * 5.5) * (1.0 - smoothstep(0.45, 1.0, r));
  if (a < 0.002) discard;
  gl_FragColor = vec4(vColor * a, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  // Additive: fog dims the light toward black instead of blending in fogColor (same rule as the glow sprites).
  float kFog = 1.0 - exp( - fogDensity * fogDensity * vPoolDepth * vPoolDepth );
  gl_FragColor.rgb *= 1.0 - kFog;
}`;

// Warm pools of deck-flood light on the water around lit vessels at night: flat additive discs in the on-surface
// decal band (100), one draw call. set(i, x, y, z, radius, on) each frame; `night` scales everything.
export function createLightPools(ctx, max, { color = 0xffc98a, intensity = 0.22, name = 'light-pools' } = {}) {
  const plane = new THREE.PlaneGeometry(2, 2, 1, 1).rotateX(-Math.PI / 2);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = plane.index;
  geo.setAttribute('position', plane.getAttribute('position'));
  const pool = new Float32Array(max * 4);
  const col = new Float32Array(max * 3);
  const aPool = new THREE.InstancedBufferAttribute(pool, 4).setUsage(THREE.DynamicDrawUsage);
  const aColor = new THREE.InstancedBufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aPool', aPool);
  geo.setAttribute('aColor', aColor);
  geo.instanceCount = 0;
  const mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uNight: { value: 0 } }]),
    vertexShader: POOL_VS,
    fragmentShader: POOL_FS,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    fog: true,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 100;
  mesh.name = name;
  ctx.scene.add(mesh);
  const base = new THREE.Color(color).multiplyScalar(intensity);
  const on = new Uint8Array(max);
  const slots = new Float32Array(max * 4);
  const slotCol = new Float32Array(max * 3);
  let dirty = true;
  return {
    mesh,
    material: mat,
    set(i, x, y, z, radius, lit, gain = 1) {
      if (i < 0 || i >= max) return;
      on[i] = lit ? 1 : 0;
      slots[i * 4] = x;
      slots[i * 4 + 1] = y;
      slots[i * 4 + 2] = z;
      slots[i * 4 + 3] = radius;
      slotCol[i * 3] = base.r * gain;
      slotCol[i * 3 + 1] = base.g * gain;
      slotCol[i * 3 + 2] = base.b * gain;
      dirty = true;
    },
    set night(v) {
      mat.uniforms.uNight.value = v;
      mesh.visible = v > 0.01;
    },
    // Packs the lit pools into the instance buffer (call once per frame after the set() calls).
    commit() {
      if (!dirty) return;
      dirty = false;
      let n = 0;
      for (let i = 0; i < max; i++) {
        if (!on[i]) continue;
        pool[n * 4] = slots[i * 4];
        pool[n * 4 + 1] = slots[i * 4 + 1];
        pool[n * 4 + 2] = slots[i * 4 + 2];
        pool[n * 4 + 3] = slots[i * 4 + 3];
        col[n * 3] = slotCol[i * 3];
        col[n * 3 + 1] = slotCol[i * 3 + 1];
        col[n * 3 + 2] = slotCol[i * 3 + 2];
        n++;
      }
      geo.instanceCount = n;
      aPool.needsUpdate = true;
      aColor.needsUpdate = true;
    },
  };
}
