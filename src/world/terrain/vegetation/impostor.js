// Spruce impostors: the 3D spruce variants are rendered once into albedo and normal atlases (a side view and a top
// view each); far trees draw as camera-facing quads that light the baked normals like the real meshes, so the dark
// conifer masses of Afognak and the Chiniak shore read from kilometres away. Distant tiles thin out by per-tree rank
// (kept trees grow slightly to hold coverage) and the terrain's canopy colour carries on beyond.

import * as THREE from 'three';
import { SUN_LIGHT_PATCH, CARD_MAP_FRAGMENT } from './common.js';

export const CELL_W = 128;
export const CELL_H = 256;
export const TREE_HALF_WIDTH = 0.25; // quad half-width relative to tree height

const NORMAL_BAKE_VERT = /* glsl */ `
varying vec3 vN;
varying vec2 vUv2;
void main() {
  vN = normalize( normalMatrix * normal );
  vUv2 = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;
const NORMAL_BAKE_FRAG = /* glsl */ `
uniform sampler2D map;
varying vec3 vN;
varying vec2 vUv2;
void main() {
  if ( vUv2.y > -0.5 && texture2D( map, vUv2 ).a < 0.5 ) discard;
  vec3 n = normalize( vN ) * ( gl_FrontFacing ? 1.0 : -1.0 );
  gl_FragColor = vec4( n * 0.5 + 0.5, 1.0 );
}`;

// Returns { albedo, normal } textures: variants side views in the top 256 rows, top views (128x128) below.
export function bakeImpostors(renderer, geometries, branchMap) {
  const n = geometries.length;
  const W = CELL_W * n;
  const H = CELL_H + CELL_W;
  const opts = {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: true,
    depthBuffer: true,
    samples: 0,
  };
  const albedoRT = new THREE.WebGLRenderTarget(W, H, opts);
  const normalRT = new THREE.WebGLRenderTarget(W, H, opts);
  const scene = new THREE.Scene();
  const albedoMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, map: branchMap, alphaTest: 0.5 });
  albedoMat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', CARD_MAP_FRAGMENT);
  };
  const normalMat = new THREE.ShaderMaterial({
    vertexShader: NORMAL_BAKE_VERT,
    fragmentShader: NORMAL_BAKE_FRAG,
    side: THREE.DoubleSide,
    uniforms: { map: { value: branchMap } },
  });
  const mesh = new THREE.Mesh(geometries[0], albedoMat);
  scene.add(mesh);
  const side = new THREE.OrthographicCamera(-TREE_HALF_WIDTH, TREE_HALF_WIDTH, 1, 0, 0.01, 10);
  side.position.set(0, 0, 3);
  side.lookAt(0, 0, 0);
  side.updateMatrixWorld();
  const top = new THREE.OrthographicCamera(-TREE_HALF_WIDTH, TREE_HALF_WIDTH, TREE_HALF_WIDTH, -TREE_HALF_WIDTH, 0.01, 10);
  top.position.set(0, 3, 0);
  top.up.set(0, 0, -1);
  top.lookAt(0, 0, 0);
  top.updateMatrixWorld();

  const prevTarget = renderer.getRenderTarget();
  const prevAuto = renderer.autoClear;
  const prevColor = new THREE.Color();
  renderer.getClearColor(prevColor);
  const prevAlpha = renderer.getClearAlpha();
  const prevShadow = renderer.shadowMap.enabled;
  renderer.shadowMap.enabled = false;
  renderer.autoClear = false;
  for (const [rt, mat, clear] of [
    [albedoRT, albedoMat, [0.07, 0.13, 0.08, 0]],
    [normalRT, normalMat, [0.5, 0.5, 1, 0]],
  ]) {
    mesh.material = mat;
    renderer.setRenderTarget(rt);
    renderer.setClearColor(new THREE.Color(clear[0], clear[1], clear[2]), clear[3]);
    rt.scissorTest = false;
    renderer.clear(true, true, false);
    for (let i = 0; i < n; i++) {
      mesh.geometry = geometries[i];
      rt.viewport.set(i * CELL_W, 0, CELL_W, CELL_H);
      renderer.setRenderTarget(rt);
      renderer.render(scene, side);
      rt.viewport.set(i * CELL_W, CELL_H, CELL_W, CELL_W);
      renderer.setRenderTarget(rt);
      renderer.render(scene, top);
    }
    rt.viewport.set(0, 0, W, H);
  }
  renderer.setRenderTarget(prevTarget);
  renderer.autoClear = prevAuto;
  renderer.setClearColor(prevColor, prevAlpha);
  renderer.shadowMap.enabled = prevShadow;
  albedoMat.dispose();
  normalMat.dispose();
  return { albedo: albedoRT.texture, normal: normalRT.texture, variants: n, width: W, height: H, targets: [albedoRT, normalRT] };
}

// Impostor material: MeshStandardMaterial with a billboard vertex stage and atlas-driven albedo/normal/alpha.
export function createImpostorMaterial({ uniforms, sunScale, atlas, fade }) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0, side: THREE.DoubleSide });
  mat.name = 'spruce-impostor';
  const own = {
    imAlbedo: { value: atlas.albedo },
    imNormal: { value: atlas.normal },
    imVariants: { value: atlas.variants },
    imFade: { value: new THREE.Vector4(...fade.near, ...fade.far) },
    imThin: { value: new THREE.Vector2(...fade.thin) },
    tkSunScale: sunScale,
  };
  mat.userData.im = own;
  const vertPars = /* glsl */ `
attribute vec4 iPos;
attribute vec4 iRot;
uniform vec3 uCameraPos;
uniform float imVariants;
uniform vec4 imFade;
uniform vec2 imThin;
uniform sampler2D uTerrainShadow;
uniform float uWorldHalf;
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWindSpeed;
varying vec2 imUvSide;
varying vec2 imUvTop;
varying float imTopW;
varying float imFadeV;
varying float imShadow;
varying float imTint;
varying vec3 imRight;
varying vec3 imUp;
varying vec3 imView;
`;
  const vertMain = /* glsl */ `
  float imH = iPos.w;
  vec3 imBase = iPos.xyz;
  float imDist = distance( imBase.xz, uCameraPos.xz );
  // Thinning by rank with distance; kept trees grow a little to hold canopy coverage.
  float keep = mix( 1.0, 0.35, smoothstep( imThin.x, imThin.y, imDist ) );
  float alive = 1.0 - smoothstep( keep - 0.06, keep, iRot.w );
  imH *= mix( 1.0, 1.25, smoothstep( imThin.x, imThin.y, imDist ) );
  float fNear = smoothstep( imFade.x, imFade.y, imDist );
  float fFar = 1.0 - smoothstep( imFade.z, imFade.w, imDist );
  imFadeV = fNear * fFar * alive;
  vec3 ctr = imBase + vec3( 0.0, imH * 0.5, 0.0 );
  vec3 v = normalize( uCameraPos - ctr );
  float elev = asin( clamp( v.y, -1.0, 1.0 ) );
  imTopW = smoothstep( 0.7, 1.25, elev );
  vec3 right = normalize( abs( v.y ) > 0.995 ? vec3( 1.0, 0.0, 0.0 ) : cross( vec3( 0.0, 1.0, 0.0 ), v ) );
  vec3 up = cross( v, right );
  float qh = mix( imH, imH * ${(2 * TREE_HALF_WIDTH).toFixed(3)}, imTopW );
  vec3 c = mix( ctr, imBase + vec3( 0.0, imH * 0.62, 0.0 ), imTopW );
  // Gentle sway of the crown.
  float sway = ( 0.2 + uWindSpeed * 0.03 ) * sin( uTime * 0.9 + imBase.x * 0.05 + imBase.z * 0.07 ) * position.y;
  vec3 imWorld = c + right * ( position.x * imH * ${(2 * TREE_HALF_WIDTH).toFixed(3)} ) + up * ( ( position.y - 0.5 ) * qh );
  imWorld.xz += uWindDir * sway * 0.25;
  if ( imFadeV <= 0.0 ) imWorld = imBase;
  float vi = mod( floor( iRot.w * 997.0 ), imVariants ); // same variant as the 3D tree (index.js)
  float cellU = 1.0 / imVariants;
  vec2 uvq = vec2( position.x + 0.5, position.y );
  imUvSide = vec2( ( vi + uvq.x ) * cellU, uvq.y * ${(CELL_H / (CELL_H + CELL_W)).toFixed(5)} );
  imUvTop = vec2( ( vi + uvq.x ) * cellU, ${(CELL_H / (CELL_H + CELL_W)).toFixed(5)} + uvq.y * ${(CELL_W / (CELL_H + CELL_W)).toFixed(5)} );
  vec2 suv = clamp( ( imBase.xz + uWorldHalf ) / ( 2.0 * uWorldHalf ), 0.0, 1.0 );
  imShadow = textureLod( uTerrainShadow, suv, 0.0 ).r;
  imTint = iRot.z;
  imRight = right;
  imUp = up;
  imView = v;
  vec3 objectNormal = v;
`;
  const fragPars = /* glsl */ `
uniform sampler2D imAlbedo;
uniform sampler2D imNormal;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float tkSunScale;
varying vec2 imUvSide;
varying vec2 imUvTop;
varying float imTopW;
varying float imFadeV;
varying float imShadow;
varying float imTint;
varying vec3 imRight;
varying vec3 imUp;
varying vec3 imView;
float imHash( vec2 p ) { p = fract( p * vec2( 123.34, 456.21 ) ); p += dot( p, p + 45.32 ); return fract( p.x * p.y ); }
`;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, own);
    for (const k of ['uCameraPos', 'uTerrainShadow', 'uWorldHalf', 'uTime', 'uWindDir', 'uWindSpeed', 'uSunDir', 'uSunColor']) shader.uniforms[k] = uniforms[k];
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${vertPars}`)
      .replace('#include <beginnormal_vertex>', vertMain)
      .replace('#include <begin_vertex>', 'vec3 transformed = imWorld;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${fragPars}`)
      .replace(
        '#include <map_fragment>',
        `vec4 imA = mix( texture2D( imAlbedo, imUvSide ), texture2D( imAlbedo, imUvTop ), imTopW );
  vec3 imN = mix( texture2D( imNormal, imUvSide ).xyz, texture2D( imNormal, imUvTop ).xyz, imTopW ) * 2.0 - 1.0;
  if ( imA.a < 0.35 ) discard;
  if ( imFadeV < 0.999 && imHash( floor( gl_FragCoord.xy ) ) > imFadeV ) discard;
  diffuseColor.rgb = imA.rgb * ( 1.0 + imTint * 0.15 );`,
      )
      .replace(
        '#include <normal_fragment_begin>',
        `float faceDirection = 1.0;
vec3 imWN = normalize( imRight * imN.x + imUp * imN.y + imView * max( imN.z, 0.15 ) );
vec3 normal = normalize( ( viewMatrix * vec4( imWN, 0.0 ) ).xyz );
vec3 nonPerturbedNormal = normal;`,
      )
      .replace('#include <lights_fragment_begin>', SUN_LIGHT_PATCH('imShadow'));
  };
  mat.customProgramCacheKey = () => 'spruce-impostor-v1';
  return mat;
}

// One impostor tile: a quad instanced over the tile's trees (sorted by rank so far tiles can draw a prefix).
const quad = (() => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
})();

export function createImpostorTile(material, data, count, stride, center, radius) {
  const g = new THREE.InstancedBufferGeometry();
  g.index = quad.index;
  g.setAttribute('position', quad.attributes.position);
  g.setAttribute('normal', quad.attributes.normal);
  const P = new Float32Array(count * 4);
  const R = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const o = i * stride;
    P.set(data.subarray(o, o + 4), i * 4);
    R.set(data.subarray(o + 4, o + 8), i * 4);
  }
  g.setAttribute('iPos', new THREE.InstancedBufferAttribute(P, 4));
  g.setAttribute('iRot', new THREE.InstancedBufferAttribute(R, 4));
  g.instanceCount = count;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(center.x, center.y, center.z), radius);
  const mesh = new THREE.Mesh(g, material);
  mesh.name = 'spruce-impostor-tile';
  mesh.matrixAutoUpdate = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.userData.total = count;
  return mesh;
}
