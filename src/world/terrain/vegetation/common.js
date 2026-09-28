// Shared pieces for the vegetation layers: a MeshStandardMaterial patched for compact per-instance attributes, wind
// sway, distance fades and terrain-shadowed sunlight, plus the matching depth material for sun shadow casting.
//
// Per-instance attributes (InstancedBufferGeometry):
//   iPos  vec4  world x, y (base), z, uniform scale
//   iRot  vec4  cos(yaw), sin(yaw), tint (-1..1, varies albedo), aux (rank 0..1 or per-layer extra)
// Optional iScale vec3 (non-uniform scale for rocks/logs) when the layer sets `nonUniform`.

import * as THREE from 'three';
import { patchUnderwater } from '../../../render/shaderChunks.js';

// Sun term override shared with the terrain: the key light (direction == uSunDir) uses uSunColor * scale * terrain
// shadow, so vegetation darkens in mountain shadow exactly like the ground beneath it.
// Cards whose uv.y < 0 (tree cores, trunks) skip the cut-out texture.
export const CARD_MAP_FRAGMENT = /* glsl */ `
#ifdef USE_MAP
  if ( vMapUv.y > -0.5 ) diffuseColor *= texture2D( map, vMapUv );
#endif`;

// transExpr (optional): weight of sunlight transmitted through thin leaves and blades toward a viewer looking into the
// sun (backlit grass and alder glow at golden hour).
const RE_DIRECT_CALL = 'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';
export const SUN_LIGHT_PATCH = (shadowExpr, transExpr = null) => {
  const chunk = THREE.ShaderChunk.lights_fragment_begin;
  const cut = chunk.indexOf('#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )');
  let tail = chunk.slice(cut).replace(
    'getDirectionalLightInfo( directionalLight, directLight );',
    `getDirectionalLightInfo( directionalLight, directLight );
		bool vgSun = dot( directLight.direction, normalize( ( viewMatrix * vec4( uSunDir, 0.0 ) ).xyz ) ) > 0.9995;
		if ( vgSun ) directLight.color = uSunColor * tkSunScale * ( ${shadowExpr} );`,
  );
  if (transExpr) {
    tail = tail.replace(
      RE_DIRECT_CALL,
      `${RE_DIRECT_CALL}
		if ( vgSun ) reflectedLight.directDiffuse += directLight.color * material.diffuseColor * ( ( ${transExpr} ) * pow( saturate( dot( -geometryViewDir, directLight.direction ) ), 4.0 ) );`,
    );
  }
  return chunk.slice(0, cut) + tail;
};

const HASH = /* glsl */ `
float vgHash( vec2 p ) {
  p = fract( p * vec2( 123.34, 456.21 ) );
  p += dot( p, p + 45.32 );
  return fract( p.x * p.y );
}`;

/**
 * options:
 *   uniforms        ctx.uniforms (shared objects)
 *   sunScale        { value } shared with the terrain
 *   fade            [near0, near1, far0, far1] distance fades: fade in over near0..near1, out over far0..far1
 *   fadeMode        'dither' (screen-door, for trees) | 'shrink' (collapse to the base, for small plants)
 *   wind            sway amplitude in metres at 1 m above the base (0 = rigid)
 *   windStiff       height exponent of the sway
 *   nonUniform      use the iScale attribute
 *   underwater      apply kodiak_underwater
 *   tintAmount      how much iRot.z brightens/darkens albedo
 *   thin            rank-based thinning with distance: [d0, d1] keep fraction falls from 1 at d0 to ~0.3 at d1
 *   extraVertex     GLSL run after the instance transform (has vgWorld, vgLocal, vgDist)
 *   dryTint         iRot.w (0..1) turns the albedo toward straw (sun-cured grass, beach rye)
 *   shadowFar       casters collapse beyond this distance in the shadow depth pass (stay inside the sky's box)
 *   standard        material params (MeshStandardMaterial, or MeshLambertMaterial with `lambert`)
 *   lambert         diffuse-only shading: cheaper, and no grazing-angle sheen on blades and leaves
 *   translucency    backlit transmission weight (foliage)
 *   grain           stone/wood albedo grain from object-space value noise: [scale (1/m), strength, ax, ay, az]
 *                   (a = per-axis stretch, e.g. wood grain along the log)
 */
export function createInstancedMaterial(opts) {
  const {
    uniforms,
    sunScale,
    fade = [0, 0, 1e6, 1e6],
    fadeMode = 'dither',
    wind = 0,
    windStiff = 2,
    nonUniform = false,
    underwater = false,
    tintAmount = 0.15,
    thin = null,
    extraVertex = '',
    standard = {},
    name = 'vegetation',
    cardMap = false,
    foliage = false,
    dryTint = false,
    shadowFar = 150,
    lambert = false,
    translucency = 0,
    grain = null,
  } = opts;
  let mat;
  if (lambert) {
    const { roughness, metalness, ...rest } = standard;
    mat = new THREE.MeshLambertMaterial({ vertexColors: true, ...rest });
  } else {
    mat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, vertexColors: true, ...standard });
  }
  mat.name = name;
  const own = {
    vgFade: { value: new THREE.Vector4(...fade) },
    vgThin: { value: new THREE.Vector2(...(thin ?? [1e6, 1e6])) },
    tkSunScale: sunScale,
  };
  mat.userData.vg = own;
  const defines = [];
  if (fadeMode === 'dither') defines.push('#define VG_DITHER');
  if (nonUniform) defines.push('#define VG_NONUNIFORM');
  if (thin) defines.push('#define VG_THIN');
  if (dryTint) defines.push('#define VG_DRY');
  if (grain) defines.push('#define VG_GRAIN', `#define VG_GRAIN_SCALE ( ${grain[0].toFixed(3)} * vec3( ${(grain[2] ?? 1).toFixed(3)}, ${(grain[3] ?? 1).toFixed(3)}, ${(grain[4] ?? 1).toFixed(3)} ) )`, `#define VG_GRAIN_AMT ${grain[1].toFixed(3)}`);

  const vertPars = /* glsl */ `
${defines.join('\n')}
attribute vec4 iPos;
attribute vec4 iRot;
#ifdef VG_NONUNIFORM
attribute vec3 iScale;
#endif
uniform vec4 vgFade;
uniform vec2 vgThin;
uniform vec3 uCameraPos;
uniform vec2 uWindDir;
uniform float uWindSpeed;
uniform float uTime;
uniform sampler2D uTerrainShadow;
uniform float uWorldHalf;
varying float vgShadow;
varying float vgFadeV;
varying float vgTint;
varying float vgAux;
#ifdef VG_GRAIN
varying vec3 vgWP;
#endif
${HASH}
vec3 vgRotate( vec3 v ) { return vec3( v.x * iRot.x - v.z * iRot.y, v.y, v.x * iRot.y + v.z * iRot.x ); }
`;
  const vertMain = /* glsl */ `
  vec3 vgLocal = position;
#ifdef VG_NONUNIFORM
  vgLocal *= iScale;
#endif
  vgLocal *= iPos.w;
  vec3 vgWorld = vgRotate( vgLocal ) + iPos.xyz;
  float vgDist = distance( iPos.xz, uCameraPos.xz ) + max( 0.0, abs( uCameraPos.y - iPos.y ) - 30.0 ) * 0.5;
  float vgF = ( vgFade.y > 0.0 ? smoothstep( vgFade.x, vgFade.y, vgDist ) : 1.0 ) * ( 1.0 - smoothstep( vgFade.z, vgFade.w, vgDist ) );
#ifdef VG_THIN
  float vgKeep = mix( 1.0, 0.3, smoothstep( vgThin.x, vgThin.y, vgDist ) );
  vgF *= 1.0 - smoothstep( vgKeep - 0.08, vgKeep, iRot.w );
#endif
  ${
    wind > 0
      ? `{
    float hN = max( 0.0, vgLocal.y );
    float gust = 0.6 + 0.4 * sin( uTime * 1.3 + iPos.x * 0.07 + iPos.z * 0.05 );
    float sway = ${wind.toFixed(4)} * pow( hN, ${windStiff.toFixed(2)} ) * ( 0.25 + uWindSpeed * 0.09 ) * gust;
    float flutter = sin( uTime * ( 2.1 + uWindSpeed * 0.25 ) + iPos.x * 0.37 + iPos.z * 0.29 + hN * 1.7 );
    vgWorld.xz += uWindDir * sway * ( 0.65 + 0.35 * flutter );
    vgWorld.y -= sway * sway * 0.15;
  }`
      : ''
  }
#ifndef VG_DITHER
  vgWorld = mix( iPos.xyz + ( vgWorld - iPos.xyz ) * 0.0, vgWorld, vgF );
#endif
  ${extraVertex}
  vec2 vgUV = ( iPos.xz + uWorldHalf ) / ( 2.0 * uWorldHalf );
  vgShadow = textureLod( uTerrainShadow, clamp( vgUV, 0.0, 1.0 ), 0.0 ).r;
  vgFadeV = vgF;
  vgTint = iRot.z;
  vgAux = iRot.w;
#ifdef VG_GRAIN
  vgWP = vgLocal * 1.0 + vec3( iRot.z * 17.0, iRot.w * 5.0, iPos.x * 0.37 );
#endif
  vec3 objectNormal = vgRotate( normal );
`;
  const fragPars = /* glsl */ `
${defines.join('\n')}
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float tkSunScale;
varying float vgShadow;
varying float vgFadeV;
varying float vgTint;
varying float vgAux;
${HASH}
#ifdef VG_GRAIN
varying vec3 vgWP;
float vgN3( vec3 p ) {
  vec3 i = floor( p );
  vec3 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  vec2 o = vec2( 1.0, 0.0 );
  float a = mix( vgHash( i.xy + i.z * 7.13 ), vgHash( i.xy + o.xy + i.z * 7.13 ), f.x );
  float b = mix( vgHash( i.xy + o.yx + i.z * 7.13 ), vgHash( i.xy + o.xx + i.z * 7.13 ), f.x );
  float c = mix( vgHash( i.xy + ( i.z + 1.0 ) * 7.13 ), vgHash( i.xy + o.xy + ( i.z + 1.0 ) * 7.13 ), f.x );
  float d = mix( vgHash( i.xy + o.yx + ( i.z + 1.0 ) * 7.13 ), vgHash( i.xy + o.xx + ( i.z + 1.0 ) * 7.13 ), f.x );
  return mix( mix( a, b, f.y ), mix( c, d, f.y ), f.z );
}
#endif
`;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, own);
    for (const k of ['uCameraPos', 'uWindDir', 'uWindSpeed', 'uTime', 'uTerrainShadow', 'uWorldHalf', 'uSunDir', 'uSunColor']) {
      shader.uniforms[k] = uniforms[k];
    }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${vertPars}`)
      .replace('#include <beginnormal_vertex>', vertMain)
      .replace('#include <begin_vertex>', 'vec3 transformed = vgWorld;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${fragPars}`)
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
#ifdef VG_DITHER
  if ( vgFadeV < 0.999 && vgHash( floor( gl_FragCoord.xy ) + fract( vgTint * 91.7 ) * 37.0 ) > vgFadeV ) discard;
#endif`,
      )
      .replace('#include <map_fragment>', cardMap ? CARD_MAP_FRAGMENT : '#include <map_fragment>')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
  diffuseColor.rgb *= 1.0 + vgTint * ${tintAmount.toFixed(3)};
#ifdef VG_GRAIN
  {
    float gn = vgN3( vgWP * VG_GRAIN_SCALE ) * 0.6 + vgN3( vgWP * ( VG_GRAIN_SCALE * 3.7 ) ) * 0.4;
    diffuseColor.rgb *= 1.0 + ( gn - 0.5 ) * 2.0 * VG_GRAIN_AMT;
  }
#endif
#ifdef VG_DRY
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.3, 0.26, 0.11 ) * ( 0.45 + 3.0 * dot( diffuseColor.rgb, vec3( 0.3333 ) ) ), vgAux * 0.75 );
#endif`,
      )
      .replace('#include <lights_fragment_begin>', SUN_LIGHT_PATCH('vgShadow', translucency > 0 ? translucency.toFixed(3) : null))
      // Foliage: back faces keep the front normal (light passes through thin leaves and needles).
      .replace('normal *= faceDirection;', foliage ? '' : 'normal *= faceDirection;');
  };
  mat.customProgramCacheKey = () => `vg3|${name}|${defines.join(',')}|${wind}|${extraVertex.length}|${cardMap}|${foliage}|${translucency}`;
  if (underwater) patchUnderwater(mat, uniforms);

  // Depth material for casting sun shadows with the same instance transform.
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: cardMap ? standard.map : null, alphaTest: cardMap ? standard.alphaTest ?? 0.5 : 0 });
  depth.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, own);
    for (const k of ['uCameraPos', 'uWindDir', 'uWindSpeed', 'uTime', 'uTerrainShadow', 'uWorldHalf']) shader.uniforms[k] = uniforms[k];
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${vertPars}`)
      .replace('#include <begin_vertex>', `${vertMain.replace('vec3 objectNormal = vgRotate( normal );', '')}\n  if ( vgDist > ${shadowFar.toFixed(1)} ) vgWorld = iPos.xyz;\n  vec3 transformed = vgWorld;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying float vgShadow;\nvarying float vgFadeV;\nvarying float vgTint;\nvarying float vgAux;`)
      .replace('#include <map_fragment>', cardMap ? CARD_MAP_FRAGMENT : '#include <map_fragment>');
  };
  depth.customProgramCacheKey = () => `vgd2|${name}|${defines.join(',')}|${wind}|${cardMap}|${shadowFar}`;
  return { material: mat, depthMaterial: depth };
}

// Instanced mesh from a base geometry with preallocated per-instance buffers (capacity instances).
export function createInstancedLayer({ geometry, material, depthMaterial, capacity, nonUniform = false, name, castShadow = false, renderOrder = 0 }) {
  const g = new THREE.InstancedBufferGeometry();
  g.index = geometry.index;
  for (const [k, v] of Object.entries(geometry.attributes)) g.setAttribute(k, v);
  const pos = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  const rot = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  pos.setUsage(THREE.DynamicDrawUsage);
  rot.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('iPos', pos);
  g.setAttribute('iRot', rot);
  let scl = null;
  if (nonUniform) {
    scl = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    scl.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iScale', scl);
  }
  g.instanceCount = 0;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  const mesh = new THREE.Mesh(g, material);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  mesh.renderOrder = renderOrder;
  if (depthMaterial) mesh.customDepthMaterial = depthMaterial;
  return {
    mesh,
    capacity,
    // data: Float32Array stride 8 (+3 when nonUniform): x y z scale cos sin tint aux [sx sy sz]
    upload(data, count, stride) {
      const n = Math.min(count, capacity);
      const P = pos.array;
      const R = rot.array;
      const S = scl?.array;
      for (let i = 0; i < n; i++) {
        const o = i * stride;
        const p = i * 4;
        P[p] = data[o];
        P[p + 1] = data[o + 1];
        P[p + 2] = data[o + 2];
        P[p + 3] = data[o + 3];
        R[p] = data[o + 4];
        R[p + 1] = data[o + 5];
        R[p + 2] = data[o + 6];
        R[p + 3] = data[o + 7];
        if (S) {
          S[i * 3] = data[o + 8];
          S[i * 3 + 1] = data[o + 9];
          S[i * 3 + 2] = data[o + 10];
        }
      }
      for (const a of [pos, rot, scl]) {
        if (!a) continue;
        a.clearUpdateRanges();
        a.addUpdateRange(0, n * a.itemSize);
        a.needsUpdate = true;
      }
      g.instanceCount = n;
    },
    get count() {
      return g.instanceCount;
    },
  };
}
