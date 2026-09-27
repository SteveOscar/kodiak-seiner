// Subtle physically-flavoured bloom (Jimenez 2014 "Next Generation Post Processing in Call of Duty: AW"): a
// thresholded, Karis-averaged 13-tap downsample to half resolution, a mip chain of 13-tap downsamples, and a tent
// upsample chain accumulated back to half resolution. Leaves readBuffer untouched; GradePass adds `texture`.

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = uv;
	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const DOWN_FRAG = /* glsl */ `
uniform sampler2D tInput;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uKnee;
uniform float uExposure;
varying vec2 vUv;
float luma( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }
vec3 s( vec2 o ) { return texture2D( tInput, vUv + uTexel * o ).rgb; }
#ifdef FIRST
vec3 karis( vec3 a, vec3 b, vec3 c, vec3 d ) {
	vec3 m = ( a + b + c + d ) * 0.25;
	return m / ( 1.0 + luma( m * uExposure ) );
}
#endif
void main() {
	vec3 a = s( vec2( -2.0, 2.0 ) ), b = s( vec2( 0.0, 2.0 ) ), c = s( vec2( 2.0, 2.0 ) );
	vec3 d = s( vec2( -2.0, 0.0 ) ), e = s( vec2( 0.0 ) ), f = s( vec2( 2.0, 0.0 ) );
	vec3 g = s( vec2( -2.0, -2.0 ) ), h = s( vec2( 0.0, -2.0 ) ), i = s( vec2( 2.0, -2.0 ) );
	vec3 j = s( vec2( -1.0, 1.0 ) ), k = s( vec2( 1.0, 1.0 ) ), l = s( vec2( -1.0, -1.0 ) ), m = s( vec2( 1.0, -1.0 ) );
	#ifdef FIRST
		vec3 col = karis( j, k, l, m ) * 0.5 + ( karis( a, b, d, e ) + karis( b, c, e, f ) + karis( d, e, g, h ) + karis( e, f, h, i ) ) * 0.125;
		// Undo the Karis weighting's scale on the average so thresholds stay meaningful.
		col = col / max( 1.0 - luma( col * uExposure ), 0.02 );
		float br = luma( col * uExposure );
		float soft = clamp( br - uThreshold + uKnee, 0.0, 2.0 * uKnee );
		soft = soft * soft / ( 4.0 * uKnee + 1e-4 );
		float contrib = max( soft, br - uThreshold ) / max( br, 1e-4 );
		col *= contrib;
		col = min( col, vec3( 64.0 / max( uExposure, 0.1 ) ) );
	#else
		vec3 col = e * 0.125 + ( a + c + g + i ) * 0.03125 + ( b + d + f + h ) * 0.0625 + ( j + k + l + m ) * 0.125;
	#endif
	gl_FragColor = vec4( col, 1.0 );
}
`;

const UP_FRAG = /* glsl */ `
uniform sampler2D tInput;
uniform vec2 uTexel;
uniform float uWeight;
varying vec2 vUv;
vec3 s( vec2 o ) { return texture2D( tInput, vUv + uTexel * o ).rgb; }
void main() {
	vec3 col = ( s( vec2( -1.0, 1.0 ) ) + s( vec2( 1.0, 1.0 ) ) + s( vec2( -1.0, -1.0 ) ) + s( vec2( 1.0, -1.0 ) ) )
		+ ( s( vec2( 0.0, 1.0 ) ) + s( vec2( 0.0, -1.0 ) ) + s( vec2( -1.0, 0.0 ) ) + s( vec2( 1.0, 0.0 ) ) ) * 2.0
		+ s( vec2( 0.0 ) ) * 4.0;
	gl_FragColor = vec4( col * ( uWeight / 16.0 ), 1.0 );
}
`;

export class BloomPass extends Pass {
  constructor({ levels = 5, threshold = 1.2, knee = 0.6 } = {}) {
    super();
    this.needsSwap = false;
    this.levels = levels;
    this.exposure = 1;
    this.mips = [];
    for (let i = 0; i < levels; i++) {
      const t = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false });
      t.texture.name = `postfx.bloom${i}`;
      this.mips.push(t);
    }
    this.downFirst = new THREE.ShaderMaterial({
      name: 'bloom-prefilter',
      defines: { FIRST: '' },
      uniforms: { tInput: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: threshold }, uKnee: { value: knee }, uExposure: { value: 1 } },
      vertexShader: VERT,
      fragmentShader: DOWN_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.down = new THREE.ShaderMaterial({
      name: 'bloom-down',
      uniforms: { tInput: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 0 }, uKnee: { value: 1 }, uExposure: { value: 1 } },
      vertexShader: VERT,
      fragmentShader: DOWN_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.up = new THREE.ShaderMaterial({
      name: 'bloom-up',
      uniforms: { tInput: { value: null }, uTexel: { value: new THREE.Vector2() }, uWeight: { value: 1 } },
      vertexShader: VERT,
      fragmentShader: UP_FRAG,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    this.quad = new FullScreenQuad(null);
  }

  get texture() {
    return this.mips[0].texture;
  }

  setSize(width, height) {
    let w = Math.max(1, Math.floor(width / 2));
    let h = Math.max(1, Math.floor(height / 2));
    for (const m of this.mips) {
      m.setSize(w, h);
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
    }
  }

  render(renderer, writeBuffer, readBuffer) {
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    const q = this.quad;
    // Prefilter + first downsample from the full-resolution scene.
    q.material = this.downFirst;
    const u0 = this.downFirst.uniforms;
    u0.tInput.value = readBuffer.texture;
    u0.uTexel.value.set(1 / readBuffer.width, 1 / readBuffer.height);
    u0.uExposure.value = this.exposure;
    renderer.setRenderTarget(this.mips[0]);
    q.render(renderer);
    q.material = this.down;
    for (let i = 1; i < this.levels; i++) {
      const src = this.mips[i - 1];
      this.down.uniforms.tInput.value = src.texture;
      this.down.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      renderer.setRenderTarget(this.mips[i]);
      q.render(renderer);
    }
    q.material = this.up;
    for (let i = this.levels - 1; i > 0; i--) {
      const src = this.mips[i];
      this.up.uniforms.tInput.value = src.texture;
      this.up.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      this.up.uniforms.uWeight.value = 0.85;
      renderer.setRenderTarget(this.mips[i - 1]);
      q.render(renderer);
    }
    renderer.autoClear = prevAutoClear;
  }

  dispose() {
    for (const m of this.mips) m.dispose();
    this.downFirst.dispose();
    this.down.dispose();
    this.up.dispose();
    this.quad.dispose();
  }
}
