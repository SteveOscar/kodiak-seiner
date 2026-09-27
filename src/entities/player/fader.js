// Fade-to-black for the on-foot transitions (ferry cut, bear retreat). A screen-space quad drawn last in the main
// pass: clip-space positions (camera-independent, unaffected by near/far or reversed-Z), no depth test, top of the
// glow band. It is not world geometry, so it deliberately skips the fog chunks.

import * as THREE from 'three';

export function createFader(ctx) {
  const material = new THREE.ShaderMaterial({
    name: 'player-fader',
    uniforms: { uAlpha: { value: 0 }, uColor: { value: new THREE.Color('#05080b') } },
    vertexShader: /* glsl */ `
      void main() {
        gl_Position = vec4( position.xy, 0.0, 1.0 );
      }`,
    fragmentShader: /* glsl */ `
      uniform float uAlpha;
      uniform vec3 uColor;
      void main() {
        gl_FragColor = vec4( uColor, uAlpha );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.name = 'player-fader';
  mesh.frustumCulled = false;
  mesh.renderOrder = 449;
  mesh.visible = false;
  mesh.matrixAutoUpdate = false;
  ctx.scene.add(mesh);

  // Timeline: to black over `inS`, hold, back over `outS`; `onBlack` runs once when fully black.
  let seq = null;
  const fader = {
    get alpha() {
      return material.uniforms.uAlpha.value;
    },
    get busy() {
      return !!seq;
    },
    start({ inS = 0.5, holdS = 0.5, outS = 0.8, onBlack = null, onDone = null } = {}) {
      seq = { t: 0, inS, holdS, outS, onBlack, onDone, fired: false };
      mesh.visible = true;
    },
    // Snap to black immediately (e.g. when a transition must hide a jump this frame).
    black() {
      material.uniforms.uAlpha.value = 1;
      mesh.visible = true;
    },
    clear() {
      seq = null;
      material.uniforms.uAlpha.value = 0;
      mesh.visible = false;
    },
    update(dt) {
      if (!seq) return;
      seq.t += dt;
      const { t, inS, holdS, outS } = seq;
      let a;
      if (t < inS) a = t / inS;
      else if (t < inS + holdS) a = 1;
      else a = 1 - (t - inS - holdS) / outS;
      a = Math.min(1, Math.max(0, a));
      material.uniforms.uAlpha.value = a * a * (3 - 2 * a);
      if (!seq.fired && t >= inS) {
        seq.fired = true;
        const cb = seq.onBlack;
        try {
          cb?.();
        } catch (err) {
          console.error('[player] fade callback threw', err);
        }
      }
      if (seq && seq.t >= inS + holdS + outS) {
        const done = seq.onDone;
        seq = null;
        material.uniforms.uAlpha.value = 0;
        mesh.visible = false;
        try {
          done?.();
        } catch (err) {
          console.error('[player] fade callback threw', err);
        }
      }
    },
  };
  return fader;
}
