// Fog contract (SPEC §4.3): WP-SKY overrides the four built-in fog chunks with radial exponential fog + height
// falloff + a low cloud deck + key-light inscattering. The chunks read fogColor, fogDensity, cameraPosition,
// mvPosition and viewMatrix, plus optional kodiakFog* uniforms that sky injects by reference into UniformsLib.fog
// and every built-in ShaderLib entry. A material that lacks them (zero-initialised uniforms) still gets correct
// height fog with default parameters, just no inscatter and no cloud deck.
//
// Custom shaders that cannot use the chunks (the sky dome, clouds, other WPs' special cases) include
// <kodiak_sky_fog_pars> and call:
//   float kodiakFogDepth(vec3 cameraPos, vec3 worldPos, float density)   optical depth (fog = 1 - exp(-depth))
//   vec3  kodiakFogTint(vec3 viewDir, vec3 fogColor)                     fog colour seen along viewDir
//   vec3  kodiakApplyFog(vec3 color, vec3 worldPos, vec3 fogColor, float density)
// with fogColor/fogDensity = ctx.uniforms.uFogColor / uFogDensity.

export const FOG_PARS_GLSL = /* glsl */ `
uniform vec4 kodiakFogSun;      // xyz: key light direction, w: inscatter strength (0 = off)
uniform vec3 kodiakFogSunColor; // inscatter colour looking straight at the key light (linear HDR)
uniform vec4 kodiakFogParams;   // x: height falloff (m), y: altitude-independent fraction, z: haze ceiling (m), w: lobe exponent
uniform vec4 kodiakFogDeck;     // x: cloud-deck base (m), y: deck density (1/m, 0 = none), z: base raggedness (m)

float kodiakHash12( vec2 p ) {
	vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
	p3 += dot( p3, p3.yzx + 33.33 );
	return fract( ( p3.x + p3.y ) * p3.z );
}

float kodiakValueNoise( vec2 p ) {
	vec2 i = floor( p );
	vec2 f = fract( p );
	vec2 u = f * f * ( 3.0 - 2.0 * f );
	float a = kodiakHash12( i );
	float b = kodiakHash12( i + vec2( 1.0, 0.0 ) );
	float c = kodiakHash12( i + vec2( 0.0, 1.0 ) );
	float d = kodiakHash12( i + vec2( 1.0, 1.0 ) );
	return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );
}

float kodiakFogDepth( vec3 cam, vec3 wp, float density ) {
	float H = kodiakFogParams.x > 0.0 ? kodiakFogParams.x : 180.0;
	float a = kodiakFogParams.x > 0.0 ? kodiakFogParams.y : 0.3;
	vec3 d = wp - cam;
	float L = length( d );
	// Only the in-air part of the ray is fogged: the underwater part belongs to kodiak_underwater (seabed, fish and
	// net seen through the thin water surface must not turn into fog over deep water).
	if ( wp.y < 0.0 && cam.y > 0.0 ) {
		float airFrac = cam.y / ( cam.y - wp.y );
		L *= airFrac;
		wp = cam + d * airFrac;
	}
	float y0 = max( cam.y, 0.0 );
	float y1 = max( wp.y, 0.0 );
	float k = ( y1 - y0 ) / H;
	float e0 = exp( - y0 / H );
	float hf = abs( k ) < 1e-3 ? e0 * ( 1.0 - 0.5 * k ) : e0 * ( 1.0 - exp( - k ) ) / k;
	float tau = density * L * ( a + ( 1.0 - a ) * hf );
	if ( kodiakFogDeck.y > 0.0 ) {
		float base = kodiakFogDeck.x + kodiakFogDeck.z * ( kodiakValueNoise( wp.xz * 0.0031 ) + 0.5 * kodiakValueNoise( wp.xz * 0.0093 + 7.1 ) - 0.75 );
		float hi = max( cam.y, wp.y );
		float dy = abs( wp.y - cam.y );
		float above = dy < 0.01 ? ( hi > base ? L : 0.0 ) : L * clamp( ( hi - base ) / dy, 0.0, 1.0 );
		tau += kodiakFogDeck.y * above;
	}
	return tau;
}

vec3 kodiakFogTint( vec3 dir, vec3 baseColor ) {
	float c = max( dot( dir, kodiakFogSun.xyz ), 0.0 );
	float k = kodiakFogParams.w > 0.0 ? kodiakFogParams.w : 7.0;
	float lobe = 0.72 * pow( c, k ) + 0.28 * pow( c, 48.0 );
	return baseColor + kodiakFogSunColor * ( kodiakFogSun.w * lobe );
}

vec3 kodiakApplyFog( vec3 color, vec3 wp, vec3 baseColor, float density ) {
	vec3 d = wp - cameraPosition;
	float L = max( length( d ), 1e-3 );
	float f = 1.0 - exp( - kodiakFogDepth( cameraPosition, wp, density ) );
	return mix( color, kodiakFogTint( d / L, baseColor ), f );
}
`;

export const FOG_CHUNKS = {
  fog_pars_vertex: /* glsl */ `
#ifdef USE_FOG
	varying vec3 vFogWorldPos;
#endif
`,
  fog_vertex: /* glsl */ `
#ifdef USE_FOG
	vFogWorldPos = ( mvPosition.xyz - viewMatrix[ 3 ].xyz ) * mat3( viewMatrix );
#endif
`,
  fog_pars_fragment: /* glsl */ `
#ifdef USE_FOG
	uniform vec3 fogColor;
	varying vec3 vFogWorldPos;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
	#include <kodiak_sky_fog_pars>
#endif
`,
  fog_fragment: /* glsl */ `
#ifdef USE_FOG
	vec3 kFogRay = vFogWorldPos - cameraPosition;
	float kFogDist = length( kFogRay );
	#ifdef FOG_EXP2
		float fogFactor = 1.0 - exp( - kodiakFogDepth( cameraPosition, vFogWorldPos, fogDensity ) );
	#else
		float fogFactor = smoothstep( fogNear, fogFar, kFogDist );
	#endif
	gl_FragColor.rgb = mix( gl_FragColor.rgb, kodiakFogTint( kFogRay / max( kFogDist, 1e-3 ), fogColor ), fogFactor );
#endif
`,
};

// Shared uniform values. Plain objects (not THREE vectors) so UniformsUtils.clone/merge copy them by reference:
// every material compiled after install() sees live updates without per-material bookkeeping.
export function createFogUniforms() {
  return {
    kodiakFogSun: { value: { x: 0, y: 1, z: 0, w: 0 } },
    kodiakFogSunColor: { value: { r: 0, g: 0, b: 0 } },
    kodiakFogParams: { value: { x: 180, y: 0.3, z: 1500, w: 0 } },
    kodiakFogDeck: { value: { x: 400, y: 0, z: 30, w: 0 } },
  };
}

// Installs the chunk overrides and injects the shared uniforms. Must run before any fogged material compiles.
export function installFogChunks(THREE, fogUniforms) {
  THREE.ShaderChunk.kodiak_sky_fog_pars = FOG_PARS_GLSL;
  for (const [name, src] of Object.entries(FOG_CHUNKS)) THREE.ShaderChunk[name] = src;
  Object.assign(THREE.UniformsLib.fog, fogUniforms);
  for (const shader of Object.values(THREE.ShaderLib)) {
    if (shader?.uniforms && 'fogDensity' in shader.uniforms) Object.assign(shader.uniforms, fogUniforms);
  }
}
