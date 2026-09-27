// Exposure metering: a 1×1 pass takes the log-average luminance of 16×9 samples of the HDR scene (clamped so the sun
// disc cannot dominate), packs log2 into two bytes and reads it back asynchronously a few times per second. postfx
// uses it as a bounded correction on top of the daylight exposure, so looking into a sunrise darkens the frame and
// looking into a shadowed fjord opens it up a little.

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
varying vec2 vUv;
void main() {
	float acc = 0.0;
	for ( int j = 0; j < 9; j ++ ) {
		for ( int i = 0; i < 16; i ++ ) {
			vec2 uv = ( vec2( float( i ), float( j ) ) + 0.5 ) / vec2( 16.0, 9.0 );
			vec3 c = texture2D( tDiffuse, uv ).rgb;
			float l = clamp( dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-4, 8.0 );
			// Centre-weighted a little: the subject is usually mid-frame.
			float w = 1.0 + 0.5 * ( 1.0 - length( uv - 0.5 ) * 1.4 );
			acc += log2( l ) * w;
		}
	}
	float wsum = 0.0;
	for ( int j = 0; j < 9; j ++ ) for ( int i = 0; i < 16; i ++ ) {
		vec2 uv = ( vec2( float( i ), float( j ) ) + 0.5 ) / vec2( 16.0, 9.0 );
		wsum += 1.0 + 0.5 * ( 1.0 - length( uv - 0.5 ) * 1.4 );
	}
	float v = clamp( ( acc / wsum + 14.0 ) / 18.0, 0.0, 1.0 ) * 65535.0;
	float hi = floor( v / 256.0 );
	float lo = v - hi * 256.0;
	gl_FragColor = vec4( hi / 255.0, lo / 255.0, 0.0, 1.0 );
}
`;

export class MeterPass extends Pass {
  constructor(renderer) {
    super();
    this.needsSwap = false;
    this.renderer = renderer;
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.UnsignedByteType, depthBuffer: false, generateMipmaps: false });
    this.material = new THREE.ShaderMaterial({
      name: 'postfx-meter',
      uniforms: { tDiffuse: { value: null } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }
      `,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
    this.buffer = new Uint8Array(4);
    this.pending = false;
    this.interval = 0.2;
    this.clock = 0;
    this.log2Lum = null; // latest metered log2 luminance (pre-exposure)
    this.failed = false;
  }

  tick(dt) {
    this.clock += dt;
  }

  render(renderer, writeBuffer, readBuffer) {
    if (this.failed || this.pending || this.clock < this.interval) return;
    this.clock = 0;
    this.material.uniforms.tDiffuse.value = readBuffer.texture;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer);
    renderer.setRenderTarget(prev);
    this.pending = true;
    renderer
      .readRenderTargetPixelsAsync(this.target, 0, 0, 1, 1, this.buffer)
      .then(() => {
        const v = (this.buffer[0] * 256 + this.buffer[1]) / 65535;
        this.log2Lum = v * 18 - 14;
        this.pending = false;
      })
      .catch(() => {
        this.failed = true;
        this.pending = false;
      });
  }

  dispose() {
    this.target.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}
