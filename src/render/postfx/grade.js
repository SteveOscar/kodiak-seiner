// Grade folded into the OutputPass (one full-resolution pass instead of two): in linear HDR before tone mapping it
// adds bloom, a gentle white balance, a night-vision shift (blue, desaturated shadows when the scene is dark),
// saturation, log-space contrast and a mild vignette; after sRGB encoding it dithers by ±½ LSB against sky banding.

import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { OutputShader } from 'three/addons/shaders/OutputShader.js';
import * as THREE from 'three';

const PARS = /* glsl */ `
uniform sampler2D tBloom;
uniform float uBloom;
uniform float uExposure;
uniform vec3 uBalance;
uniform float uSaturation;
uniform float uContrast;
uniform float uNight;
uniform float uVignette;
uniform vec2 uAspect;
float kGradeLuma( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }
vec3 kGrade( vec3 c ) {
	c += texture2D( tBloom, vUv ).rgb * uBloom;
	c *= uBalance;
	// Night vision: dark tones lose colour and drift blue (Purkinje shift).
	float y = kGradeLuma( c * uExposure );
	float scot = uNight * ( 1.0 - smoothstep( 0.015, 0.35, y ) );
	c = mix( c, vec3( kGradeLuma( c ) ) * vec3( 0.78, 0.9, 1.16 ), scot * 0.55 );
	float l = kGradeLuma( c );
	c = max( mix( vec3( l ), c, uSaturation ), 0.0 );
	// Contrast around exposed mid-grey, in log space (keeps HDR highlights intact).
	float mid = 0.18 / max( uExposure, 1e-3 );
	c = mid * pow( max( c, vec3( 1e-7 ) ) / mid, vec3( uContrast ) );
	vec2 q = ( vUv - 0.5 ) * uAspect;
	return c * ( 1.0 - uVignette * smoothstep( 0.15, 0.95, dot( q, q ) * 2.2 ) );
}
`;

function gradedFragmentShader() {
  let src = OutputShader.fragmentShader;
  const read = 'gl_FragColor = texture2D( tDiffuse, vUv );';
  const pars = 'varying vec2 vUv;';
  if (!src.includes(read) || !src.includes(pars)) return null;
  src = src.replace(pars, `${pars}\n${PARS}`);
  src = src.replace(read, `${read}\n\t\t\tgl_FragColor.rgb = kGrade( gl_FragColor.rgb );`);
  src = src.replace(
    /}\s*$/,
    /* glsl */ `
			#ifdef SRGB_TRANSFER
				float kDither = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
				gl_FragColor.rgb += ( kDither - 0.5 ) / 255.0;
			#endif
		}`,
  );
  return src;
}

// An OutputPass whose shader also grades. `bloomPass.texture` is sampled when the bloom pass is enabled.
export function createGradedOutputPass(bloomPass) {
  const pass = new OutputPass();
  const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  black.needsUpdate = true;
  Object.assign(pass.uniforms, {
    tBloom: { value: black },
    uBloom: { value: 0.06 },
    uExposure: { value: 1 },
    uBalance: { value: new THREE.Vector3(1, 1, 1) },
    uSaturation: { value: 1.06 },
    uContrast: { value: 1.05 },
    uNight: { value: 0 },
    uVignette: { value: 0.16 },
    uAspect: { value: new THREE.Vector2(1, 1) },
  });
  const src = gradedFragmentShader();
  if (src) {
    pass.material.fragmentShader = src;
    pass.material.needsUpdate = true;
  }
  const baseRender = pass.render.bind(pass);
  pass.graded = !!src;
  pass.render = (renderer, writeBuffer, readBuffer, dt, maskActive) => {
    const on = bloomPass?.enabled !== false;
    pass.uniforms.tBloom.value = on ? bloomPass.texture : black;
    if (!on) pass.uniforms.uBloom.value = 0;
    baseRender(renderer, writeBuffer, readBuffer, dt, maskActive);
  };
  pass.setSize = (width, height) => {
    const a = width / Math.max(1, height);
    pass.uniforms.uAspect.value.set(Math.sqrt(a), 1 / Math.sqrt(a));
  };
  return pass;
}
