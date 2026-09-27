// Vertex-animated MeshStandardMaterials for the wildlife (lighting, shadows, env map, fog chunks and colour
// management come from three.js and WP-SKY's chunk overrides; SPEC §4.3). Each rig deforms position and normal from
// the per-vertex rig channels (shapes.js) and two per-instance vec4s written by the CPU each frame:
//
//   bird   aAnim  = (flap phase rad, flap amplitude rad, dihedral rad, fold 0..1)
//          aAnim2 = (head yaw rad, tail spread 0..1, outer-wing dihedral rad, seed)
//   quad   aAnim  = (gait phase rad, walk 0..1.2, gallop 0..1, head pitch rad (+ down))
//          aAnim2 = (head yaw rad, rear-up 0..1, lie 0..1, seed)
//   marine aAnim  = (stroke phase rad, stroke amplitude m, back arch m, fore-fin angle rad)
//          aAnim2 = (head pitch rad (+ up), head yaw rad, tail raise rad, throat gulp 0..1)
//
// Every material applies kodiak_underwater (whales, pinnipeds, wading bears and diving birds sit below y = 0), and a
// matching MeshDepthMaterial carries the same deformation for shadow casting.

import * as THREE from 'three';
import { patchUnderwater } from '../../render/shaderChunks.js';

const COMMON = /* glsl */ `
attribute vec4 aRig;
attribute vec4 aPivot;
attribute vec4 aAnim;
attribute vec4 aAnim2;
uniform float uTime;
vec2 kwRot( vec2 v, float a ) {
  float c = cos( a ), s = sin( a );
  return vec2( c * v.x - s * v.y, s * v.x + c * v.y );
}
// Rotation in the (z, y) plane about (pz, py): positive angle swings the part below the pivot forward (-z) and
// lifts the part in front of it.
void kwPitch( inout vec3 p, inout vec3 n, float pz, float py, float a ) {
  vec2 v = kwRot( vec2( p.z - pz, p.y - py ), -a );
  p.z = pz + v.x; p.y = py + v.y;
  n.zy = kwRot( n.zy, -a );
}
void kwYaw( inout vec3 p, inout vec3 n, float px, float pz, float a ) {
  vec2 v = kwRot( vec2( p.x - px, p.z - pz ), a );
  p.x = px + v.x; p.z = pz + v.y;
  n.xz = kwRot( n.xz, a );
}
`;

const BIRD = /* glsl */ `
void kwDeform( inout vec3 p, inout vec3 n ) {
  float part = aRig.x;
  float s = sin( aAnim.x );
  float amp = aAnim.y;
  if ( part > 0.5 && part < 1.5 ) {
    float side = aRig.y;
    float sh = aRig.z;
    float wr = aRig.w;
    float fold = aAnim.w;
    float th1 = aAnim.z + amp * s;
    float th2 = aAnim2.z + amp * 0.6 * sin( aAnim.x - 0.9 ) - fold * 0.6;
    vec2 q = vec2( p.x * side, p.y );
    vec2 nq = vec2( n.x * side, n.y );
    if ( fold > 0.0 ) {
      float d = max( 0.0, q.x - sh );
      p.z += fold * d * 0.9;
      q.x = sh + d * ( 1.0 - 0.62 * fold );
    }
    float w = smoothstep( wr - 0.04, wr + 0.04, q.x );
    vec2 o = kwRot( q - vec2( wr, 0.0 ), th2 ) + vec2( wr, 0.0 );
    q = mix( q, o, w );
    nq = mix( nq, kwRot( nq, th2 ), w );
    q = kwRot( q - vec2( sh, 0.0 ), th1 ) + vec2( sh, 0.0 );
    nq = kwRot( nq, th1 );
    p.x = q.x * side; p.y = q.y;
    n.x = nq.x * side; n.y = nq.y;
  } else if ( part > 2.5 && part < 3.5 ) {
    kwYaw( p, n, 0.0, aPivot.y, aAnim2.x );
  } else if ( part > 1.5 && part < 2.5 ) {
    p.x *= 1.0 + 0.6 * aAnim2.y * smoothstep( 0.0, 0.3, abs( p.x ) * 8.0 );
  }
  // The body bobs against the downstroke.
  p.y -= 0.02 * amp * s;
}
`;

const QUAD = /* glsl */ `
uniform vec2 uHip;
float kwLegOff( float id, float gal ) {
  float w = id < 1.5 ? 0.25 : id < 2.5 ? 0.75 : id < 3.5 ? 0.0 : 0.5;
  float g = id < 1.5 ? 0.62 : id < 2.5 ? 0.52 : id < 3.5 ? 0.1 : 0.0;
  return mix( w, g, gal ) * 6.2831853;
}
void kwDeform( inout vec3 p, inout vec3 n ) {
  float leg = aRig.x;
  float walk = aAnim.y;
  float gal = aAnim.z;
  float rear = aAnim2.y;
  float lie = aAnim2.z;
  if ( leg > 0.5 ) {
    float jy = aPivot.x;
    float jz = aPivot.y;
    float ky = aPivot.z;
    float ph = aAnim.x + kwLegOff( leg, gal );
    float amp = walk * ( 0.3 + 0.32 * gal );
    float sw = amp * sin( ph );
    float kn = -( 0.5 + 0.45 * gal ) * max( 0.0, cos( ph ) ) * min( 1.0, walk * 2.0 );
    float wk = 1.0 - smoothstep( ky - 0.05 * jy, ky + 0.05 * jy, p.y );
    vec3 pk = p; vec3 nk = n;
    kwPitch( pk, nk, jz, ky, kn );
    p = mix( p, pk, wk ); n = mix( n, nk, wk );
    kwPitch( p, n, jz, jy, sw );
    // Lying down: legs fold under the body and splay a little.
    p.y = jy + ( p.y - jy ) * ( 1.0 - 0.72 * lie );
    p.x += sign( p.x ) * lie * 0.12 * aRig.y * jy;
    // Rearing up: front legs hang from the shoulders.
    if ( leg < 2.5 ) kwPitch( p, n, jz, jy, -rear * 0.9 );
  }
  float hw = aRig.z;
  if ( hw > 0.0 ) {
    vec3 ph = p; vec3 nh = n;
    kwPitch( ph, nh, aPivot.y, aPivot.x, -aAnim.w );
    kwYaw( ph, nh, 0.0, aPivot.y, aAnim2.x );
    p = mix( p, ph, hw ); n = normalize( mix( n, nh, hw ) );
  }
  float tw = aRig.w;
  if ( tw > 0.0 ) {
    float wag = 0.25 * sin( uTime * 2.3 + aAnim2.w * 17.0 ) + 0.5 * walk * sin( aAnim.x * 2.0 );
    vec3 pt = p; vec3 nt = n;
    kwYaw( pt, nt, 0.0, aPivot.y, wag * 0.3 );
    p = mix( p, pt, tw ); n = mix( n, nt, tw );
  }
  p.y -= lie * 0.72 * uHip.x;
  if ( rear > 0.0 && !( leg > 2.5 ) ) kwPitch( p, n, uHip.y, uHip.x, rear * 1.2 );
}
`;

const MARINE = /* glsl */ `
void kwDeform( inout vec3 p, inout vec3 n ) {
  float s = aRig.x;
  float part = aRig.y;
  float amp = aAnim.y;
  // Vertical stroke travelling toward the flukes, and a whole-body arch (rolling dives).
  float env = smoothstep( 0.25, 1.0, s );
  float ph = aAnim.x - 2.6 * s;
  float dy = amp * env * env * sin( ph ) + aAnim.z * ( 1.0 - 4.0 * ( s - 0.5 ) * ( s - 0.5 ) );
  float slope = amp * ( 2.0 * env * sin( ph ) * ( s > 0.25 ? 1.33 : 0.0 ) - 2.6 * env * env * cos( ph ) ) - aAnim.z * 8.0 * ( s - 0.5 );
  if ( part > 2.5 && part < 3.5 ) {
    // Flukes / hind flippers pitch with the stroke, lagging a little.
    float a = 0.18 * amp * cos( aAnim.x - 3.2 );
    kwPitch( p, n, aPivot.y, aPivot.x, a );
  }
  p.y += dy;
  n.zy = kwRot( n.zy, atan( slope * 0.08 ) );
  if ( part > 0.5 && part < 2.5 ) {
    float side = part < 1.5 ? -1.0 : 1.0;
    vec2 v = kwRot( vec2( p.x - aPivot.z, p.y - aPivot.x ), aAnim.w * side * aRig.z );
    p.x = aPivot.z + v.x; p.y = aPivot.x + v.y;
    n.xy = kwRot( n.xy, aAnim.w * side );
  }
  float hw = aRig.w;
  if ( hw > 0.0 ) {
    vec3 q = p; vec3 nq = n;
    kwPitch( q, nq, aPivot.y, aPivot.x, aAnim2.x );
    kwYaw( q, nq, 0.0, aPivot.y, aAnim2.y );
    p = mix( p, q, hw ); n = normalize( mix( n, nq, hw ) );
  } else if ( hw < 0.0 ) {
    vec3 q = p; vec3 nq = n;
    kwPitch( q, nq, aPivot.y, aPivot.x, -aAnim2.z );
    p = mix( p, q, -hw ); n = normalize( mix( n, nq, -hw ) );
  }
  if ( aAnim2.w > 0.0 && s < 0.55 && p.y < 0.0 ) {
    // Lunge feeding: the throat pouch balloons out.
    float g = aAnim2.w * sin( 3.14159 * s / 0.55 );
    p.y *= 1.0 + 0.9 * g;
    p.x *= 1.0 + 0.35 * g * ( 1.0 - smoothstep( -1.0, 0.0, p.y ) );
  }
}
`;

const RIGS = { bird: BIRD, quad: QUAD, marine: MARINE };

function injectVertex(shader, rig, withNormal) {
  shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${COMMON}\n${RIGS[rig]}`);
  if (withNormal) {
    shader.vertexShader = shader.vertexShader
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3( normal );\nvec3 kwPos = vec3( position );\nkwDeform( kwPos, objectNormal );')
      .replace('#include <begin_vertex>', 'vec3 transformed = kwPos;');
  } else {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      'vec3 transformed = vec3( position );\nvec3 kwNrm = vec3( normal );\nkwDeform( transformed, kwNrm );',
    );
  }
}

// rig: 'bird' | 'quad' | 'marine' | null (static). opts: roughness, metalness, envMapIntensity, hip [y, z] (quad).
export function createRigMaterial(ctx, rig, { roughness = 0.8, metalness = 0, envMapIntensity = 1, hip = [1, 0.8], name = 'wildlife' } = {}) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness, metalness, envMapIntensity });
  mat.name = name;
  const hipU = { value: new THREE.Vector2(hip[0], hip[1]) };
  if (rig) {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = ctx.uniforms.uTime;
      shader.uniforms.uHip = hipU;
      injectVertex(shader, rig, true);
    };
    mat.customProgramCacheKey = () => `kw-${rig}`;
  }
  patchUnderwater(mat, ctx.uniforms);
  mat.userData.hip = hipU;
  return mat;
}

export function createRigDepthMaterial(ctx, rig, { hip = [1, 0.8] } = {}) {
  const mat = new THREE.MeshDepthMaterial();
  const hipU = { value: new THREE.Vector2(hip[0], hip[1]) };
  if (rig) {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = ctx.uniforms.uTime;
      shader.uniforms.uHip = hipU;
      injectVertex(shader, rig, false);
    };
    mat.customProgramCacheKey = () => `kw-depth-${rig}`;
  }
  return mat;
}
