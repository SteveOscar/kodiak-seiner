// GPU terrain sun shadow: marches the DEM toward uSunDir for every texel of a world-covering R8 target (same uv and
// orientation as uHeightMap) with a soft penumbra. Recomputed when the sun moves more than ~0.5°, spread over a few
// frames in row bands, then cross-faded from the previous result so mountain shadows sweep smoothly instead of
// stepping. The published texture (uniforms.uTerrainShadow.value) is one persistent target.

import * as THREE from 'three';
import { passMaterial } from './gpuPrep.js';
import { PENUMBRA, RAY_LIFT, RAY_START, RAY_GROW, RAY_ADD, RAY_STEPS, MAX_TERRAIN } from './sunvis.js';

const f = (v) => (Number.isInteger(v) ? `${v}.0` : `${v}`);

const MARCH_FRAG = /* glsl */ `
uniform sampler2D tkHeightTex;
uniform float tkHalf;
uniform vec3 sunDir;
varying vec2 vUv;
float hAt( vec2 p, float lod ) { return textureLod( tkHeightTex, ( p + tkHalf ) / ( 2.0 * tkHalf ), lod ).r; }
void main() {
  vec2 p = ( vUv * 2.0 - 1.0 ) * tkHalf;
  float hl = length( sunDir.xz );
  float vis = 1.0;
  if ( sunDir.y <= -0.03 ) {
    vis = 0.0;
  } else if ( hl > 1e-4 ) {
    vec2 d = sunDir.xz / hl;
    float tanE = sunDir.y / hl;
    float y0 = max( hAt( p, 0.0 ), 0.0 ) + ${f(RAY_LIFT)};
    float minM = 1.0;
    float t = ${f(RAY_START)};
    for ( int i = 0; i < ${RAY_STEPS}; i ++ ) {
      float ry = y0 + t * tanE;
      if ( ry > ${f(MAX_TERRAIN)} ) break;
      float lod = clamp( log2( t / 90.0 ), 0.0, 3.0 );
      float m = ( ry - hAt( p + d * t, lod ) ) / t;
      minM = min( minM, m );
      if ( minM < -${f(PENUMBRA)} ) break;
      t = t * ${f(RAY_GROW)} + ${f(RAY_ADD)};
    }
    float s = clamp( ( minM + ${f(PENUMBRA)} ) / ( 2.0 * ${f(PENUMBRA)} ), 0.0, 1.0 );
    vis = s * s * ( 3.0 - 2.0 * s ) * clamp( ( sunDir.y + 0.03 ) / 0.06, 0.0, 1.0 );
  }
  gl_FragColor = vec4( vis, 0.0, 0.0, 1.0 );
}`;

const BLEND_FRAG = /* glsl */ `
uniform sampler2D prevTex;
uniform sampler2D nextTex;
uniform float mixT;
varying vec2 vUv;
void main() {
  gl_FragColor = vec4( mix( texture2D( prevTex, vUv ).r, texture2D( nextTex, vUv ).r, mixT ), 0.0, 0.0, 1.0 );
}`;

export function createShadowPass({ runner, heightTex, half, size = 1024, bands = 8, blendSeconds = 1.6 }) {
  const make = () =>
    new THREE.WebGLRenderTarget(size, size, {
      format: THREE.RedFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      generateMipmaps: false,
    });
  let prev = make();
  let next = make();
  let work = make();
  const output = make();
  output.texture.name = 'terrain-shadow';

  const marchMat = passMaterial(MARCH_FRAG, {
    tkHeightTex: { value: heightTex },
    tkHalf: { value: half },
    sunDir: { value: new THREE.Vector3(0, 1, 0) },
  });
  const blendMat = passMaterial(BLEND_FRAG, { prevTex: { value: null }, nextTex: { value: null }, mixT: { value: 1 } });

  const computedSun = new THREE.Vector3(0, -2, 0); // sun of the last started computation
  let band = -1; // band being computed into `work`, -1 when idle
  let mixT = 1;
  let computations = 0;
  const cos05 = Math.cos((0.5 * Math.PI) / 180);
  const cosJump = Math.cos((6 * Math.PI) / 180);

  function blend(t) {
    blendMat.uniforms.prevTex.value = prev.texture;
    blendMat.uniforms.nextTex.value = next.texture;
    blendMat.uniforms.mixT.value = t;
    runner.run(blendMat, output);
  }

  function marchInto(target, sun, scissor) {
    marchMat.uniforms.sunDir.value.copy(sun);
    runner.run(marchMat, target, scissor);
  }

  // Immediate full recompute, no cross-fade (first frame, time jumps).
  function computeNow(sun) {
    computedSun.copy(sun);
    marchInto(next, sun, null);
    band = -1;
    mixT = 1;
    blend(1);
    computations++;
  }

  return {
    texture: output.texture,
    get computations() {
      return computations;
    },
    get busy() {
      return band >= 0 || mixT < 1;
    },
    // Call once per frame with the normalized sun direction and real dt.
    update(sun, realDt) {
      const dot = sun.dot(computedSun);
      if (computedSun.y < -1.5 || dot < cosJump) {
        computeNow(sun);
        return;
      }
      if (band < 0 && dot < cos05 && !(sun.y < -0.05 && computedSun.y < -0.05)) {
        computedSun.copy(sun);
        band = 0;
      }
      if (band >= 0) {
        const rows = Math.ceil(size / bands);
        marchInto(work, computedSun, [0, band * rows, size, rows]);
        band++;
        if (band >= bands) {
          band = -1;
          // The fade restarts from what is on screen now, toward the fresh result.
          blendMat.uniforms.prevTex.value = output.texture;
          blendMat.uniforms.nextTex.value = output.texture;
          blendMat.uniforms.mixT.value = 0;
          runner.run(blendMat, prev);
          const t = next;
          next = work;
          work = t;
          mixT = 0;
          computations++;
        }
      }
      if (mixT < 1) {
        mixT = Math.min(1, mixT + realDt / blendSeconds);
        blend(mixT * mixT * (3 - 2 * mixT));
      }
    },
    dispose() {
      for (const t of [prev, next, work, output]) t.dispose();
      marchMat.dispose();
      blendMat.dispose();
    },
  };
}
