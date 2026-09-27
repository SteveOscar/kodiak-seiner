// Shared materials for places: the merged-structure material (vertex colours + procedural windows that light up at
// night), a white metal material for turbine rotors, and the uniforms that drive them.

import * as THREE from 'three';
import { patchUnderwater } from '../../render/shaderChunks.js';

// Uniforms owned by places (updated once per frame in places.update).
export function createPlaceUniforms() {
  return {
    uNight: { value: 0 }, // 0 day .. 1 night: window and lamp emission
    uNav: { value: 0 }, // 0 day .. 1 from sunset: lighthouses, buoys and aviation lights (photocell switching)
    uLitFrac: { value: 0.55 }, // fraction of windows lit at night (falls after midnight)
    uWinColor: { value: new THREE.Color(0.78, 0.34, 0.1) },
    uLampColor: { value: new THREE.Color(1.0, 0.5, 0.18).multiplyScalar(1.3) },
  };
}

const WINDOW_GLSL = /* glsl */ `
vec3 kPlTint = vec3(1.0);
float kPlHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
// Window mask for facade coords. code = type * 100 + half wall width. Returns (mask, litMask, lampMask, glassFar).
vec4 kPlWindows(vec4 fac) {
  float type = floor(fac.z / 100.0 + 0.001);
  float halfW = fac.z - type * 100.0;
  if (type < 0.5) return vec4(0.0);
  if (type > 8.5) return vec4(0.0, 0.0, 1.0, 0.0);
  vec2 cell; vec2 size; float sill;
  if (type < 1.5) { cell = vec2(3.3, 2.8); size = vec2(1.25, 1.3); sill = 0.95; }
  else if (type < 2.5) { cell = vec2(4.6, 4.2); size = vec2(2.6, 1.1); sill = 2.6; }
  else if (type < 3.5) { cell = vec2(2.4, 6.0); size = vec2(0.8, 2.4); sill = 2.2; }
  else { cell = vec2(2.8, 3.4); size = vec2(2.1, 1.6); sill = 0.9; }
  vec2 uv = vec2(fac.x + cell.x * 0.5, fac.y - sill);
  vec2 id = floor(uv / cell);
  vec2 f = uv - id * cell - (vec2(cell.x, 0.0) - vec2(size.x, 0.0)) * 0.5;
  vec2 fw = max(fwidth(uv), vec2(1e-4));
  vec2 m = smoothstep(-fw, fw, f) * smoothstep(-fw, fw, size - f);
  float inWall = step(abs(id.x * cell.x), max(0.0, halfW - 0.9)) * step(0.0, uv.y);
  float mask = m.x * m.y * inWall;
  float h = kPlHash(id + fac.w * 7.13 + type);
  float h2 = kPlHash(id.yx * 1.7 + fac.w * 3.1);
  // most rooms warm incandescent, some cooler LED/TV light; brightness varies room to room
  kPlTint = mix(vec3(1.0), vec3(0.62, 0.95, 1.9), step(0.8, h2)) * (0.45 + 0.75 * fract(h2 * 7.31));
  float lit = step(h, uLitFrac);
  // Far away the pattern is sub-pixel: fade to its average so it neither shimmers nor vanishes.
  float cov = (size.x * size.y) / (cell.x * cell.y) * step(0.0, uv.y) * step(1.0, halfW);
  float far = smoothstep(0.3, 0.9, max(fw.x / cell.x, fw.y / cell.y));
  mask = mix(mask, cov, far);
  lit = mix(lit * mask, uLitFrac * cov, far);
  kPlTint = mix(kPlTint, vec3(0.92, 0.99, 1.18) * 0.82, far);
  return vec4(mask, lit, 0.0, far);
}
`;

// MeshStandardMaterial with vertex colours; aFacade drives windows. One program for every merged structure.
export function createStructureMaterial(ctx, pu) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.0 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = pu.uNight;
    shader.uniforms.uLitFrac = pu.uLitFrac;
    shader.uniforms.uWinColor = pu.uWinColor;
    shader.uniforms.uLampColor = pu.uLampColor;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aFacade;\nvarying vec4 vFacade;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFacade = aFacade;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nvarying vec4 vFacade;\nuniform float uNight;\nuniform float uLitFrac;\nuniform vec3 uWinColor;\nuniform vec3 uLampColor;\n${WINDOW_GLSL}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
vec4 kWin = kPlWindows(vFacade);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.035, 0.045, 0.055), kWin.x * 0.9);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.22, kWin.x * (1.0 - kWin.w));`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
totalEmissiveRadiance += uWinColor * kPlTint * kWin.y * uNight + uLampColor * kWin.z * uNight;`,
      );
  };
  mat.customProgramCacheKey = () => 'kodiak-places-structure';
  patchUnderwater(mat, ctx.uniforms);
  return mat;
}

// Plain lit material for moving parts (turbine rotors, buoys).
export function createPlainMaterial(ctx, opts = {}) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.05, ...opts });
  patchUnderwater(mat, ctx.uniforms);
  return mat;
}
