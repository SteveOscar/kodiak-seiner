// Seine materials. All are built-in three.js materials patched in onBeforeCompile, so lighting, the env map and
// WP-SKY's fog chunks apply exactly as on every other object; each also gets the shared kodiak_underwater chunk
// (SPEC §4.3). Ribbons (ropes and lifted web bundles) are camera-facing strips expanded in the vertex shader with a
// minimum on-screen width, so a 2 cm corkline still reads as a hairline from the crow's nest.

import { patchUnderwater } from '../../render/shaderChunks.js';

// Diamond-mesh twine coverage for net-space coordinates in metres. Fades to the average coverage once a mesh cell is
// smaller than a couple of pixels, so distant web is a soft haze instead of moire.
const MESH_GLSL = /* glsl */ `
float kNetMesh( vec2 uvm, float cell ) {
  vec2 m = uvm / cell;
  vec2 d = vec2( m.x + m.y, m.x - m.y );
  vec2 g = fract( d );
  vec2 dist = min( g, 1.0 - g );
  vec2 fw = max( fwidth( d ), vec2( 1e-4 ) );
  const float tw = 0.075;
  vec2 cov = 1.0 - smoothstep( vec2( tw ) - fw * 0.6, vec2( tw ) + fw * 0.6, dist );
  float lines = max( cov.x, cov.y );
  float far = smoothstep( 0.25, 0.7, max( fw.x, fw.y ) );
  return mix( lines, 0.32, far );
}`;

const NORMAL_FIX = `#include <normal_fragment_begin>
#ifndef FLAT_SHADED
  normal = normalize( vNormal );
#endif`;

function chain(material, key, patch) {
  material.onBeforeCompile = (shader, renderer) => patch(shader, renderer);
  material.customProgramCacheKey = () => key;
}

// Shared uniform: world metres per screen pixel per metre of distance (set by the view from the camera each frame).
export function createPixelUniform() {
  return { value: 0.0015 };
}

// Camera-facing ribbon: attributes aSide (±1), aTangent, aWidth (m), aNetUv (u along, v across), color.
// web: modulate colour by the mesh pattern (lifted, bunched web).
export function ribbonMaterial(ctx, { pixel, minPixels = 1.25, web = false, color = '#ffffff' }) {
  const { THREE } = ctx;
  const m = new THREE.MeshLambertMaterial({ color: new THREE.Color(color), vertexColors: true, side: THREE.DoubleSide });
  const uMinPx = { value: minPixels };
  chain(m, `kodiak-net-ribbon-${web ? 'web' : 'rope'}`, (shader) => {
    shader.uniforms.uPixel = pixel;
    shader.uniforms.uMinPx = uMinPx;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float aSide;
attribute vec3 aTangent;
attribute float aWidth;
attribute vec2 aNetUv;
uniform float uPixel;
uniform float uMinPx;
varying vec2 vNetUv;`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `vec3 kToCam = cameraPosition - position;
float kDist = length( kToCam );
kToCam /= max( kDist, 1e-4 );
vec3 kT = normalize( aTangent + vec3( 0.0, 1e-6, 0.0 ) );
vec3 kAcross = cross( kT, kToCam );
float kAl = length( kAcross );
kAcross = kAl > 1e-3 ? kAcross / kAl : normalize( cross( kT, vec3( 0.0, 1.0, 0.0 ) ) + vec3( 1e-3, 0.0, 0.0 ) );
vec3 objectNormal = normalize( kToCam * 0.7 + kAcross * aSide * 0.72 + vec3( 0.0, 0.25, 0.0 ) );
vNetUv = aNetUv;`,
      )
      .replace(
        '#include <begin_vertex>',
        `float kW = max( aWidth, kDist * uPixel * uMinPx );
vec3 transformed = position + kAcross * aSide * kW * 0.5;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec2 vNetUv;\n${MESH_GLSL}`)
      .replace('#include <normal_fragment_begin>', NORMAL_FIX);
    if (web) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  float kLines = kNetMesh( vNetUv * vec2( 1.0, 0.6 ), 0.09 );
  float kEdge = smoothstep( 0.0, 0.18, vNetUv.y ) * smoothstep( 1.0, 0.82, vNetUv.y );
  diffuseColor.rgb *= mix( 0.55, 1.25, kLines ) * mix( 0.7, 1.0, kEdge );
}`,
      );
    }
  });
  patchUnderwater(m, ctx.uniforms);
  return m;
}

// The web curtain hanging under the corkline: translucent dark-green nylon (render band −100). aNetUv = (metres
// along the corkline, metres down the web). Alpha fades with depth; kodiak_underwater tints it toward the water.
export function webMaterial(ctx, { color = '#1a3022', opacity = 0.72 } = {}) {
  const { THREE } = ctx;
  const m = new THREE.MeshLambertMaterial({
    color: new THREE.Color(color),
    transparent: true,
    opacity,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  chain(m, 'kodiak-net-web', (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec2 aNetUv;\nvarying vec2 vNetUv;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvNetUv = aNetUv;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec2 vNetUv;\n${MESH_GLSL}`)
      .replace('#include <normal_fragment_begin>', NORMAL_FIX)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  float kLines = kNetMesh( vNetUv, 0.16 );
  // Selvage: the heavier strip of web hung on the corkline reads as a darker band just under the corks.
  float kSelvage = 1.0 - smoothstep( 0.25, 0.9, vNetUv.y );
  float kDepthFade = mix( 1.0, 0.4, smoothstep( 0.0, 16.0, vNetUv.y ) );
  diffuseColor.a *= clamp( kLines * 1.5 + kSelvage * 0.4, 0.0, 1.0 ) * kDepthFade;
  diffuseColor.rgb *= mix( 1.0, 0.75, kSelvage );
}`,
      );
  });
  patchUnderwater(m, ctx.uniforms);
  return m;
}

// Solid bunched web (the pile on deck, the brailer bag).
export function solidWebMaterial(ctx, { color = '#2a4c34', cell = 0.07 } = {}) {
  const { THREE } = ctx;
  const m = new THREE.MeshLambertMaterial({ color: new THREE.Color(color), side: THREE.DoubleSide });
  chain(m, `kodiak-net-solid-${cell}`, (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec2 aNetUv;\nvarying vec2 vNetUv;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvNetUv = aNetUv;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec2 vNetUv;\n${MESH_GLSL}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  float kLines = kNetMesh( vNetUv, ${cell.toFixed(3)} );
  float kFold = 0.5 + 0.5 * sin( vNetUv.x * 3.1 + sin( vNetUv.y * 2.3 ) * 2.0 ) * sin( vNetUv.y * 2.7 + vNetUv.x * 0.7 );
  diffuseColor.rgb *= mix( 0.6, 1.2, kLines ) * mix( 0.72, 1.08, kFold );
}`,
      );
  });
  patchUnderwater(m, ctx.uniforms);
  return m;
}

export function corkMaterial(ctx) {
  const { THREE } = ctx;
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.62, metalness: 0 });
  patchUnderwater(m, ctx.uniforms);
  return m;
}

export function ringMaterial(ctx) {
  const { THREE } = ctx;
  const m = new THREE.MeshStandardMaterial({ color: new THREE.Color('#8f8a7c'), roughness: 0.42, metalness: 0.75 });
  patchUnderwater(m, ctx.uniforms);
  return m;
}

// A growable batch of camera-facing polylines drawn in one call (world-space vertices, identity transform).
export function createRibbonBatch(ctx, material, capacity, name) {
  const { THREE } = ctx;
  const vcap = capacity * 2;
  const pos = new Float32Array(vcap * 3);
  const tan = new Float32Array(vcap * 3);
  const col = new Float32Array(vcap * 3);
  const nrm = new Float32Array(vcap * 3);
  const side = new Float32Array(vcap);
  const wid = new Float32Array(vcap);
  const uv = new Float32Array(vcap * 2);
  const index = new Uint32Array((capacity - 1) * 6);
  for (let i = 0; i < capacity; i++) {
    side[i * 2] = -1;
    side[i * 2 + 1] = 1;
    nrm[i * 6 + 1] = 1;
    nrm[i * 6 + 4] = 1;
  }
  const geo = new THREE.BufferGeometry();
  const attr = (a, n) => new THREE.BufferAttribute(a, n).setUsage(THREE.DynamicDrawUsage);
  const aPos = attr(pos, 3);
  const aTan = attr(tan, 3);
  const aCol = attr(col, 3);
  const aWid = attr(wid, 1);
  const aUv = attr(uv, 2);
  const aIdx = attr(index, 1);
  geo.setAttribute('position', aPos);
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('aTangent', aTan);
  geo.setAttribute('color', aCol);
  geo.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
  geo.setAttribute('aWidth', aWid);
  geo.setAttribute('aNetUv', aUv);
  geo.setIndex(aIdx);
  geo.setDrawRange(0, 0);
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;

  let n = 0; // points written
  let ni = 0; // indices written
  let lineStart = 0;
  let r = 1;
  let g = 1;
  let b = 1;
  let w = 0.02;
  let u = 0;
  let lx = 0;
  let ly = 0;
  let lz = 0;
  const batch = {
    mesh,
    begin() {
      n = 0;
      ni = 0;
    },
    // color: THREE.Color (linear), width metres
    line(color, width) {
      lineStart = n;
      r = color.r;
      g = color.g;
      b = color.b;
      w = width;
      u = 0;
    },
    point(x, y, z, width = w) {
      if (n >= capacity) return;
      if (n > lineStart) u += Math.hypot(x - lx, y - ly, z - lz);
      lx = x;
      ly = y;
      lz = z;
      for (let s = 0; s < 2; s++) {
        const v = n * 2 + s;
        pos[v * 3] = x;
        pos[v * 3 + 1] = y;
        pos[v * 3 + 2] = z;
        col[v * 3] = r;
        col[v * 3 + 1] = g;
        col[v * 3 + 2] = b;
        wid[v] = width;
        uv[v * 2] = u;
        uv[v * 2 + 1] = s;
      }
      n++;
    },
    end() {
      const count = n - lineStart;
      if (count < 2) {
        n = lineStart;
        return;
      }
      for (let i = lineStart; i < n; i++) {
        const a = Math.max(lineStart, i - 1);
        const c = Math.min(n - 1, i + 1);
        let tx = pos[c * 6] - pos[a * 6];
        let ty = pos[c * 6 + 1] - pos[a * 6 + 1];
        let tz = pos[c * 6 + 2] - pos[a * 6 + 2];
        const l = Math.hypot(tx, ty, tz) || 1;
        tx /= l;
        ty /= l;
        tz /= l;
        for (let s = 0; s < 2; s++) {
          const v = i * 2 + s;
          tan[v * 3] = tx;
          tan[v * 3 + 1] = ty;
          tan[v * 3 + 2] = tz;
        }
      }
      for (let i = lineStart; i < n - 1; i++) {
        const a = i * 2;
        index[ni++] = a;
        index[ni++] = a + 1;
        index[ni++] = a + 2;
        index[ni++] = a + 1;
        index[ni++] = a + 3;
        index[ni++] = a + 2;
      }
    },
    finish() {
      geo.setDrawRange(0, ni);
      if (n === 0) return;
      for (const a of [aPos, aTan, aCol, aWid]) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, n * 2 * a.itemSize);
        a.needsUpdate = true;
      }
      aUv.clearUpdateRanges();
      aUv.addUpdateRange(0, n * 4);
      aUv.needsUpdate = true;
      aIdx.clearUpdateRanges();
      aIdx.addUpdateRange(0, ni);
      aIdx.needsUpdate = true;
    },
    get points() {
      return n;
    },
  };
  return batch;
}
