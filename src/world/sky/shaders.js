// GLSL for the sky: shared atmosphere functions (mirroring atmosphere.js), the sky-view LUT pass, and the dome.
import { ATMOSPHERE, TRANSMITTANCE_SIZE, MULTISCATTER_SIZE } from './atmosphere.js';

const f = (x) => (Number.isInteger(x) ? `${x}.0` : String(x));
const v3 = (a) => `vec3(${a.map(f).join(', ')})`;

// Geometry of the dome's cloud layers (km above the observer) and their texture tiling (km per noise tile).
export const CLOUD_LAYER = { altitude: 1.6, tile: 26, detailScale: 2.7, cirrusAltitude: 7.5, cirrusTile: 70 };
// Game metres → real kilometres horizontally (the map is ~1:11.75): the sky scrolls as the boat travels.
export const GAME_TO_REAL_KM = 11.75 / 1000;

export function atmosphereGLSL(A = ATMOSPHERE) {
  return /* glsl */ `
#define ATM_BOTTOM ${f(A.bottom)}
#define ATM_TOP ${f(A.top)}
#define ATM_PI 3.14159265359
const vec3 RAYLEIGH_SCATTERING = ${v3(A.rayleighScattering)};
const float RAYLEIGH_SCALE = ${f(A.rayleighScale)};
const float MIE_SCATTERING = ${f(A.mieScattering)};
const float MIE_EXTINCTION = ${f(A.mieExtinction)};
const float MIE_SCALE = ${f(A.mieScale)};
const float MIE_G = ${f(A.mieG)};
const vec3 OZONE_ABSORPTION = ${v3(A.ozoneAbsorption)};
const float OZONE_CENTER = ${f(A.ozoneCenter)};
const float OZONE_WIDTH = ${f(A.ozoneWidth)};
const vec2 TRANSMITTANCE_SIZE = vec2(${f(TRANSMITTANCE_SIZE[0])}, ${f(TRANSMITTANCE_SIZE[1])});
const vec2 MS_SIZE = vec2(${f(MULTISCATTER_SIZE[0])}, ${f(MULTISCATTER_SIZE[1])});
const float SUN_ANGULAR_RADIUS = 0.00465;

uniform sampler2D uTransmittanceLUT;
uniform sampler2D uMultiScatterLUT;

float atmCoord( float x, float size ) { return 0.5 / size + x * ( 1.0 - 1.0 / size ); }

float atmDistToTop( float r, float mu ) {
	float disc = r * r * ( mu * mu - 1.0 ) + ATM_TOP * ATM_TOP;
	return max( 0.0, - r * mu + sqrt( max( 0.0, disc ) ) );
}
float atmDistToBottom( float r, float mu ) {
	float disc = r * r * ( mu * mu - 1.0 ) + ATM_BOTTOM * ATM_BOTTOM;
	return max( 0.0, - r * mu - sqrt( max( 0.0, disc ) ) );
}
bool atmHitsGround( float r, float mu ) {
	return mu < 0.0 && r * r * ( mu * mu - 1.0 ) + ATM_BOTTOM * ATM_BOTTOM >= 0.0;
}

vec3 atmTransmittance( float r, float mu ) {
	float H = sqrt( ATM_TOP * ATM_TOP - ATM_BOTTOM * ATM_BOTTOM );
	float rho = sqrt( max( 0.0, r * r - ATM_BOTTOM * ATM_BOTTOM ) );
	float d = atmDistToTop( r, mu );
	float dMin = ATM_TOP - r;
	float dMax = rho + H;
	float xMu = clamp( ( d - dMin ) / max( 1e-6, dMax - dMin ), 0.0, 1.0 );
	float xR = clamp( rho / H, 0.0, 1.0 );
	vec3 t = texture2D( uTransmittanceLUT, vec2( atmCoord( xMu, TRANSMITTANCE_SIZE.x ), atmCoord( xR, TRANSMITTANCE_SIZE.y ) ) ).rgb;
	float sinH = ATM_BOTTOM / r;
	float muH = - sqrt( max( 0.0, 1.0 - sinH * sinH ) );
	return t * smoothstep( - SUN_ANGULAR_RADIUS, SUN_ANGULAR_RADIUS, mu - muH );
}

vec3 atmMultiScatter( float r, float muS ) {
	vec2 uv = vec2( atmCoord( clamp( muS * 0.5 + 0.5, 0.0, 1.0 ), MS_SIZE.x ), atmCoord( clamp( ( r - ATM_BOTTOM ) / ( ATM_TOP - ATM_BOTTOM ), 0.0, 1.0 ), MS_SIZE.y ) );
	return texture2D( uMultiScatterLUT, uv ).rgb;
}

float atmRayleighPhase( float c ) { return 3.0 / ( 16.0 * ATM_PI ) * ( 1.0 + c * c ); }
float atmMiePhase( float c ) {
	float g2 = MIE_G * MIE_G;
	return 3.0 / ( 8.0 * ATM_PI ) * ( ( 1.0 - g2 ) * ( 1.0 + c * c ) ) / ( ( 2.0 + g2 ) * pow( max( 1e-4, 1.0 + g2 - 2.0 * MIE_G * c ), 1.5 ) );
}
`;
}

// Sky-view LUT: display radiance for every direction (absolute azimuth × non-linear elevation), both lights.
export const SKYVIEW_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = uv;
	gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

export const skyViewFrag = () => /* glsl */ `
${atmosphereGLSL()}
varying vec2 vUv;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform float uSunScale;
uniform vec3 uSunTint;
vec3 twilightTint( float y ) { return mix( vec3( 1.0 ), uSunTint, smoothstep( 0.0, 0.3, y ) ); }
uniform float uMoonScale;
uniform vec3 uAirglow;
uniform float uViewAlt;

void main() {
	float az = vUv.x * 2.0 * ATM_PI;
	float vv = ( vUv.y - 0.5 ) * 2.0;
	float el = sign( vv ) * vv * vv * 0.5 * ATM_PI;
	vec3 dir = vec3( sin( az ) * cos( el ), sin( el ), - cos( az ) * cos( el ) );
	float r = ATM_BOTTOM + uViewAlt;
	float mu = dir.y;
	bool ground = atmHitsGround( r, mu );
	float tMax = ground ? atmDistToBottom( r, mu ) : atmDistToTop( r, mu );
	vec3 L = vec3( 0.0 );
	vec3 thr = vec3( 1.0 );
	float tPrev = 0.0;
	float cS = dot( dir, uSunDir );
	float cM = dot( dir, uMoonDir );
	float pRS = atmRayleighPhase( cS );
	float pMS = atmMiePhase( cS );
	float pRM = atmRayleighPhase( cM );
	float pMM = atmMiePhase( cM );
	vec3 tintDir = twilightTint( dir.y );
	const int STEPS = 24;
	for ( int s = 0; s < STEPS; s ++ ) {
		float tn = pow( float( s + 1 ) / float( STEPS ), 2.0 ) * tMax;
		float dt = tn - tPrev;
		float t = tPrev + 0.3 * dt;
		tPrev = tn;
		vec3 p = vec3( 0.0, r, 0.0 ) + dir * t;
		float pr = length( p );
		float h = pr - ATM_BOTTOM;
		float rho = exp( - h / RAYLEIGH_SCALE );
		float mie = exp( - h / MIE_SCALE );
		float oz = max( 0.0, 1.0 - abs( h - OZONE_CENTER ) / OZONE_WIDTH );
		vec3 sR = RAYLEIGH_SCATTERING * rho;
		float sM = MIE_SCATTERING * mie;
		vec3 ext = sR + MIE_EXTINCTION * mie + OZONE_ABSORPTION * oz;
		vec3 up = p / pr;
		float muS = dot( up, uSunDir );
		float muM = dot( up, uMoonDir );
		vec3 S = uSunScale * tintDir * ( sR * ( atmTransmittance( pr, muS ) * pRS + atmMultiScatter( pr, muS ) ) + sM * ( atmTransmittance( pr, muS ) * pMS + atmMultiScatter( pr, muS ) ) );
		if ( uMoonScale > 0.0 ) {
			vec3 tM = atmTransmittance( pr, muM );
			vec3 mM = atmMultiScatter( pr, muM );
			S += uMoonScale * ( sR * ( tM * pRM + mM ) + sM * ( tM * pMM + mM ) );
		}
		vec3 st = exp( - ext * dt );
		L += thr * ( S - S * st ) / ext;
		thr *= st;
	}
	L += uAirglow * ( 1.0 + 1.5 * ( 1.0 - max( dir.y, 0.0 ) ) );
	gl_FragColor = vec4( L, 1.0 );
}
`;

// Fullscreen sky dome drawn at the far plane (reversed-Z aware). ENV_CAPTURE drops the sun disc, stars and moon
// disc and replaces the lower hemisphere with the sea/ground bounce colour.
export const DOME_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
	vec2 p = position.xy;
	vec3 viewRay = vec3( ( p.x + projectionMatrix[ 2 ][ 0 ] ) / projectionMatrix[ 0 ][ 0 ], ( p.y + projectionMatrix[ 2 ][ 1 ] ) / projectionMatrix[ 1 ][ 1 ], - 1.0 );
	vDir = viewRay * mat3( viewMatrix );
	#ifdef USE_REVERSED_DEPTH_BUFFER
		gl_Position = vec4( p, 0.0, 1.0 );
	#else
		gl_Position = vec4( p, 1.0, 1.0 );
	#endif
}
`;

export const domeFrag = () => /* glsl */ `
${atmosphereGLSL()}
#include <kodiak_sky_fog_pars>

varying vec3 vDir;
uniform sampler2D uSkyView;
uniform sampler2D uCloudNoise;
uniform vec3 uSunDirTrue;
uniform vec3 uMoonDir;
uniform vec3 uSunDisc;        // display radiance of the sun disc centre (transmittance applied)
uniform float uSunLightScale; // SUN_E × lift, for lighting clouds with the transmittance LUT
uniform vec3 uSunWarm;        // golden-hour bias on sunlight (matches the key light)
uniform vec3 uMoonLight;      // moonlight irradiance on clouds
uniform vec3 uMoonDisc;       // display radiance of the lit moon
uniform float uCloudCover;
uniform vec4 uCloudOffset;    // xy: cumulus offset (km), zw: cirrus offset (km)
uniform float uCloudEvolve;
uniform float uCirrus;
uniform float uScud;
uniform vec3 uCloudAmbient;   // sky light falling on cloud tops/sides
uniform vec3 uCloudBase;      // underside radiance of a thick deck
uniform mat3 uStarRot;
uniform float uStarVis;
uniform float uTime;
uniform float uAurora;
uniform float uLightning;
uniform vec3 uLightningDir;    // toward the strike, at cloud height
uniform vec3 uGroundColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform vec2 uFogBoost;       // x: extra density from a mist bank around the camera, y: its top height (m)

#define PI 3.14159265359
const float CLOUD_ALT = ${f(CLOUD_LAYER.altitude)};
const float CLOUD_TILE = ${f(CLOUD_LAYER.tile)};
const float CLOUD_DETAIL = ${f(CLOUD_LAYER.detailScale)};
const float CIRRUS_ALT = ${f(CLOUD_LAYER.cirrusAltitude)};
const float CIRRUS_TILE = ${f(CLOUD_LAYER.cirrusTile)};
const float VIEW_R = ATM_BOTTOM + 0.05;

vec3 skyLUT( vec3 dir ) {
	float az = atan( dir.x, - dir.z );
	float el = asin( clamp( dir.y, - 1.0, 1.0 ) );
	float v = 0.5 + 0.5 * sign( el ) * sqrt( abs( el ) / ( 0.5 * PI ) );
	return texture2D( uSkyView, vec2( fract( az / ( 2.0 * PI ) ), v ) ).rgb;
}

vec3 hash33( vec3 p ) {
	p = fract( p * vec3( 0.1031, 0.1030, 0.0973 ) );
	p += dot( p, p.yxz + 33.33 );
	return fract( ( p.xxy + p.yxx ) * p.zyx );
}

float hg( float c, float g ) {
	float g2 = g * g;
	return ( 1.0 - g2 ) / pow( max( 1e-4, 1.0 + g2 - 2.0 * g * c ), 1.5 );
}

float shellDistance( float mu, float alt ) {
	float rc = ATM_BOTTOM + alt;
	float b = VIEW_R * mu;
	return - b + sqrt( max( 0.0, b * b + rc * rc - VIEW_R * VIEW_R ) );
}

// Cloud coverage shape at noise uv (mirrors sky.js cloudShapeCPU).
float cloudShape( vec2 uv ) {
	vec4 a = texture2D( uCloudNoise, uv );
	vec4 b = texture2D( uCloudNoise, uv * CLOUD_DETAIL + vec2( 0.37, 0.61 ) + uCloudEvolve * vec2( 0.013, -0.009 ) );
	return a.r * 0.62 + b.g * 0.38 - ( b.a - 0.5 ) * 0.16;
}
float cloudThreshold() { return mix( 0.76, 0.06, uCloudCover ); }

vec4 clouds( vec3 dir, vec3 skyBehind ) {
	vec4 outc = vec4( 0.0 );
	if ( dir.y <= 0.0 ) return outc;
	float horizonFade = smoothstep( 0.0, 0.07, dir.y );
	float cS = dot( dir, uSunDirTrue );
	float cM = dot( dir, uMoonDir );

	// Cirrus (high, wispy; stays sunlit after sunset).
	if ( uCirrus > 0.01 ) {
		float tc = shellDistance( dir.y, CIRRUS_ALT );
		vec3 pc = dir * tc;
		vec2 uvc = ( pc.xz + uCloudOffset.zw ) / CIRRUS_TILE;
		float fib = texture2D( uCloudNoise, vec2( uvc.x * 0.8 + uvc.y * 0.3, uvc.y * 1.6 ) ).b;
		float mask = texture2D( uCloudNoise, uvc * 0.35 + 0.21 ).r;
		float dc = smoothstep( 0.55, 0.9, fib * ( 0.55 + 0.7 * mask ) ) * uCirrus * ( 1.0 - 0.75 * uCloudCover );
		if ( dc > 0.001 ) {
			vec3 upc = normalize( vec3( pc.x, VIEW_R + pc.y, pc.z ) );
			vec3 sunC = uSunLightScale * uSunWarm * atmTransmittance( ATM_BOTTOM + CIRRUS_ALT, dot( upc, uSunDirTrue ) );
			vec3 colc = uCloudAmbient * 0.9 + sunC * ( 0.035 + 0.05 * hg( cS, 0.7 ) ) + uMoonLight * 0.03 * hg( cM, 0.7 );
			float ap = 1.0 - exp( - tc / 120.0 );
			colc = mix( colc, skyBehind, ap * 0.8 );
			float ac = dc * 0.55 * horizonFade;
			outc.rgb = colc * ac;
			outc.a = ac;
		}
	}

	if ( uCloudCover < 0.01 ) return outc;
	float t = shellDistance( dir.y, CLOUD_ALT );
	vec3 p = dir * t;
	vec2 uv = ( p.xz + uCloudOffset.xy ) / CLOUD_TILE;
	float th = cloudThreshold();
	float shape = cloudShape( uv );
	float d = clamp( ( shape - th ) / 0.2, 0.0, 1.0 );
	float ovc = smoothstep( 0.7, 0.98, uCloudCover );
	// Scud: low, fast, ragged cloud under a rain or storm deck.
	float scudAmt = smoothstep( 0.35, 1.0, uScud );
	if ( d <= 0.0 && scudAmt <= 0.0 ) return outc;
	d = d * d * ( 3.0 - 2.0 * d );

	// Self-shadowing toward the sun (two taps along the sun's horizontal direction).
	vec2 sdir = uSunDirTrue.xz / max( length( uSunDirTrue.xz ), 1e-4 );
	float reach = clamp( 0.9 / max( uSunDirTrue.y, 0.12 ), 0.9, 6.0 ) / CLOUD_TILE;
	float s1 = clamp( ( cloudShape( uv + sdir * reach * 0.35 ) - th ) / 0.2, 0.0, 1.0 );
	float s2 = clamp( ( texture2D( uCloudNoise, uv + sdir * reach ).r * 0.62 + 0.19 - th ) / 0.2, 0.0, 1.0 );
	float occl = s1 * 0.6 + s2 * 0.4;
	float beer = exp( - ( occl * 1.8 + d * 0.6 ) * ( 0.5 + 0.8 * uCloudCover ) );
	float powder = 1.0 - 0.5 * exp( - d * 4.0 );

	vec3 up = normalize( vec3( p.x, VIEW_R + p.y, p.z ) );
	float muS = dot( up, uSunDirTrue );
	vec3 sunC = uSunLightScale * uSunWarm * atmTransmittance( ATM_BOTTOM + CLOUD_ALT, muS );
	float phase = mix( hg( cS, -0.1 ), hg( cS, 0.7 ), 0.5 );
	vec3 direct = sunC * phase * beer * powder * 0.2 * ( 1.0 - 0.85 * ovc );
	// Low sun: the bases catch light from below (warm undersides at sunset and in the long twilight).
	float under = smoothstep( 0.16, -0.02, muS ) * smoothstep( -0.12, -0.01, muS );
	vec3 underLit = sunC * under * ( 0.06 + 0.06 * hg( cS, 0.5 ) ) * ( 0.55 + 0.45 * ( 1.0 - d ) ) * ( 1.0 - 0.7 * ovc );
	// Overcast decks keep texture: thick lumps darker, thin patches brighter.
	float deckVar = mix( 1.0, 0.72 + 0.56 * smoothstep( 0.25, 0.8, 1.0 - shape + th * 0.4 ), ovc );
	vec3 amb = mix( uCloudAmbient, uCloudBase, clamp( uCloudCover * 1.05, 0.0, 1.0 ) ) * ( 0.98 - 0.32 * d * ( 1.0 - ovc ) ) * deckVar;
	vec3 moon = uMoonLight * ( 0.02 + 0.03 * hg( cM, 0.6 ) ) * beer;
	// Lightning lights the deck from inside: brightest around the strike, a dimmer flash everywhere.
	float strike = uLightning * ( 0.25 + 2.2 * pow( max( dot( dir, uLightningDir ), 0.0 ), 10.0 ) );
	vec3 col = amb + direct + underLit + moon + strike * vec3( 0.75, 0.8, 1.0 ) * ( 0.4 + 0.6 * d );
	float ap = 1.0 - exp( - t / 55.0 );
	col = mix( col, skyBehind, ap * ( 0.85 - 0.5 * uCloudCover ) );
	float alpha = ( 1.0 - exp( - d * ( 3.5 + 5.0 * uCloudCover ) ) ) * mix( horizonFade, 1.0, uCloudCover * uCloudCover );

	if ( scudAmt > 0.0 ) {
		float ts = shellDistance( dir.y, 0.65 );
		vec2 uvs = ( dir.xz * ts + uCloudOffset.xy * 2.6 ) / 9.0;
		float sh = texture2D( uCloudNoise, uvs ).g * 0.6 + texture2D( uCloudNoise, uvs * 2.3 + 0.4 ).a * 0.4;
		float ds = smoothstep( 0.62 - 0.3 * scudAmt, 0.95 - 0.25 * scudAmt, sh ) * scudAmt * smoothstep( 0.0, 0.12, dir.y );
		vec3 scudCol = uCloudBase * ( 0.52 + 0.2 * ( 1.0 - sh ) ) + strike * vec3( 0.5, 0.52, 0.6 );
		scudCol = mix( scudCol, skyBehind, ( 1.0 - exp( - ts / 25.0 ) ) * 0.6 );
		col = mix( col, scudCol, ds * 0.85 );
		alpha = max( alpha, ds * 0.85 );
	}
	// Composite over the cirrus.
	outc.rgb = col * alpha + outc.rgb * ( 1.0 - alpha );
	outc.a = alpha + outc.a * ( 1.0 - alpha );
	return outc;
}

#ifndef ENV_CAPTURE
// Galactic north pole and centre in the equatorial frame.
const vec3 GAL_POLE = vec3( -0.8676, -0.1981, 0.4560 );
const vec3 GAL_CENTER = vec3( -0.0548, -0.8734, -0.4838 );

vec3 starField( vec3 dir, float pix ) {
	vec3 eq = uStarRot * dir;
	vec3 col = vec3( 0.0 );
	const float N = 230.0;
	vec3 cell = floor( eq * N );
	vec3 h = hash33( cell );
	if ( h.x < 0.12 ) {
		vec3 sp = normalize( ( cell + 0.3 + 0.4 * hash33( cell + 17.0 ) ) / N );
		vec3 dd = eq - sp;
		float ang2 = dot( dd, dd );
		float sigma = max( pix * 0.55, 0.00035 );
		// Magnitudes follow N(<m) ~ 10^(0.45 m) up to m = 7; the sky brightness sets the limiting magnitude.
		float m = 7.0 + log( max( h.y, 1e-4 ) ) / ( 0.45 * 2.302585 );
		float lim = mix( 1.2, 6.4, uStarVis );
		float vis = smoothstep( lim + 0.4, lim - 0.6, m );
		float flux = 3.2 * pow( 10.0, - 0.4 * ( m - 0.5 ) ) * vis;
		float tw = 1.0 + ( 0.3 + 0.45 * ( 1.0 - dir.y ) ) * sin( uTime * ( 3.0 + 9.0 * h.z ) + h.x * 900.0 ) * step( m, 4.0 );
		vec3 tint = mix( vec3( 1.0, 0.8, 0.62 ), vec3( 0.74, 0.84, 1.0 ), h.z );
		col = tint * flux * tw * ( 0.00035 * 0.00035 / ( sigma * sigma ) ) * exp( - ang2 / ( 2.0 * sigma * sigma ) );
	}
	// Milky Way: a soft band with dust lanes, brighter toward the (low, southern) galactic centre.
	float b = dot( eq, GAL_POLE );
	vec3 gx = normalize( cross( GAL_POLE, vec3( 0.0, 0.0, 1.0 ) ) );
	vec3 gy = cross( GAL_POLE, gx );
	float l = atan( dot( eq, gy ), dot( eq, gx ) );
	vec2 guv = vec2( l / ( 2.0 * PI ) * 6.0, b * 3.0 );
	float cloudy = texture2D( uCloudNoise, guv ).r;
	float dust = smoothstep( 0.45, 0.75, texture2D( uCloudNoise, guv * 2.0 + 0.5 ).g ) * exp( - b * b / 0.004 );
	float band = exp( - b * b / ( 2.0 * 0.11 * 0.11 ) ) * ( 0.35 + 0.9 * cloudy ) * ( 1.0 - 0.75 * dust );
	float core = pow( max( dot( eq, GAL_CENTER ), 0.0 ), 3.0 );
	col += vec3( 0.75, 0.8, 1.0 ) * band * ( 0.6 + 1.6 * core ) * 0.0065 * uStarVis * uStarVis;
	return col;
}

vec3 moonDisc( vec3 dir, float pix ) {
	const float R = 0.0082;
	float c = dot( dir, uMoonDir );
	float ang = sqrt( max( 0.0, 2.0 * ( 1.0 - c ) ) );
	vec3 halo = uMoonDisc * ( 0.0009 * exp( - ang / 0.03 ) + 0.00025 * exp( - ang / 0.15 ) );
	if ( ang > R * 1.5 ) return halo;
	vec3 ref = abs( uMoonDir.y ) > 0.95 ? vec3( 1.0, 0.0, 0.0 ) : vec3( 0.0, 1.0, 0.0 );
	vec3 t1 = normalize( cross( uMoonDir, ref ) );
	vec3 t2 = cross( t1, uMoonDir );
	vec2 q = vec2( dot( dir, t1 ), dot( dir, t2 ) ) / R;
	float rr = dot( q, q );
	float edge = 1.0 - smoothstep( 1.0 - 1.5 * pix / R, 1.0 + 1.5 * pix / R, sqrt( rr ) );
	vec3 n = q.x * t1 + q.y * t2 - sqrt( max( 0.0, 1.0 - rr ) ) * uMoonDir;
	float lit = pow( max( dot( n, uSunDirTrue ), 0.0 ), 0.6 );
	float maria = texture2D( uCloudNoise, q * 0.16 + vec2( 0.31, 0.72 ) ).r;
	float albedo = 0.55 + 0.6 * smoothstep( 0.35, 0.6, maria );
	return uMoonDisc * ( lit * albedo + 0.015 ) * edge + halo;
}

vec3 sunDisc( vec3 dir, float pix ) {
	const float R = 0.0058;
	float c = dot( dir, uSunDirTrue );
	float ang = sqrt( max( 0.0, 2.0 * ( 1.0 - c ) ) );
	float disc = 1.0 - smoothstep( R - pix, R + pix, ang );
	float x = clamp( ang / R, 0.0, 1.0 );
	float limb = 0.6 + 0.4 * sqrt( 1.0 - x * x );
	return uSunDisc * disc * limb + uSunDisc * 0.0025 * exp( - ang / 0.012 );
}

// Aurora: vertical emitting sheets hanging over east-west tracks 450-700 km north (arcs low over the northern horizon,
// as seen from south of the auroral oval). Each view ray is intersected with a sheet (damped fixed-point iteration on
// the meandering track); the crossing altitude sets the colour (557.7 nm green low, 630 nm red high, a violet fringe
// at the very bottom) and folds seen edge-on glow brighter.
float auroraTrack( float east, float fk, float at ) {
	return 130.0 * ( texture2D( uCloudNoise, vec2( east / 1100.0 + at * 0.0005 + fk * 0.37, 0.17 + fk * 0.23 ) ).r - 0.5 )
		+ 45.0 * ( texture2D( uCloudNoise, vec2( east / 330.0 - at * 0.0014 + fk * 0.19, 0.53 + fk * 0.11 ) ).r - 0.5 );
}

vec3 aurora( vec3 dir ) {
	float north = - dir.z;
	if ( dir.y < 0.0 || north < 0.06 ) return vec3( 0.0 );
	vec3 acc = vec3( 0.0 );
	float at = uTime;
	for ( int k = 0; k < 2; k ++ ) {
		float fk = float( k );
		float base = 440.0 + 120.0 * fk;
		// The far arc meanders less and is fainter, so its lower border never draws a second wavy line under the first.
		float amp = 1.0 - 0.65 * fk;
		float t = base / north;
		for ( int it = 0; it < 4; it ++ ) {
			float tn = max( base + amp * auroraTrack( dir.x * t, fk, at ), 80.0 ) / north;
			t = mix( t, tn, 0.75 );
		}
		float east = dir.x * t;
		float h = sqrt( 6360.0 * 6360.0 + t * t + 2.0 * 6360.0 * t * dir.y ) - 6360.0;
		if ( h < 60.0 || h > 420.0 ) continue;
		// Edge-on folds: brightness grows with the sheet's apparent thickness along the ray.
		float slope = amp * ( auroraTrack( east + 10.0, fk, at ) - auroraTrack( east - 10.0, fk, at ) ) / 20.0;
		float cosN = abs( - slope * dir.x + north ) / ( sqrt( 1.0 + slope * slope ) * length( dir.xz ) + 1e-4 );
		float fold = min( 1.0 / max( cosN, 0.25 ), 3.0 );
		// Rays: striations drifting along the arc; strong rays make the curtain taller.
		float r1 = texture2D( uCloudNoise, vec2( east / 150.0 + at * 0.002, 0.31 + fk * 0.13 ) ).a;
		float r2 = texture2D( uCloudNoise, vec2( east / 42.0 - at * 0.006, 0.71 + fk * 0.09 ) ).g;
		float r = clamp( r1 * 0.7 + r2 * 0.55 - 0.15, 0.0, 1.0 );
		// The lower border is the brightest part of the curtain and glows softly downward: a hard step from bright
		// curtain to bare sky reads as a dark mountain ridge standing in front of the aurora.
		// The far arc has no crisp border at all: it only deepens the glow under the near one.
		float under = max( 99.0 - h, 0.0 );
		float sharp = 1.0 - fk;
		float lower = h >= 99.0 ? 1.0 : sharp * ( 0.72 * exp( - under / 4.5 ) + 0.28 * exp( - under / 14.0 ) ) + fk * exp( - under / 16.0 );
		float dh = max( h - 99.0, 0.0 );
		float band = lower * exp( - dh / ( 13.0 + 26.0 * r ) ) * ( 0.45 + 1.1 * r );
		float fringe = sharp * exp( - dh / 3.0 ) * ( h >= 99.0 ? 1.0 : exp( - under / 3.0 ) ) * ( 0.25 + 0.35 * r );
		// Thin N2 violet at the very bottom of bright rays only; the glow below the border stays green (a grey or violet
		// wash under the curtain reads as haze over land).
		float violet = sharp * exp( - ( h - 97.0 ) * ( h - 97.0 ) / 3.0 ) * smoothstep( 0.35, 0.8, r ) * 0.22;
		float tall = lower * exp( - dh / 50.0 ) * smoothstep( 0.6, 0.95, r ) * 0.18 * ( 1.0 - smoothstep( 160.0, 230.0, h ) );
		float red = smoothstep( 150.0, 210.0, h ) * exp( - max( h - 210.0, 0.0 ) / 60.0 ) * smoothstep( 0.45, 0.9, r ) * 0.12;
		// Brightness patches and gaps along the arc.
		float along = 0.1 + 0.9 * smoothstep( 0.3, 0.68, texture2D( uCloudNoise, vec2( east / 900.0 + at * 0.0009 + fk * 0.5, 0.41 + fk * 0.2 ) ).r );
		float pulse = 0.82 + 0.18 * sin( at * 0.37 + east * 0.004 + fk * 2.1 );
		vec3 col = vec3( 0.12, 1.0, 0.42 ) * ( band + tall ) + vec3( 0.45, 1.0, 0.62 ) * fringe + vec3( 0.8, 0.38, 0.85 ) * violet
			+ vec3( 0.95, 0.12, 0.32 ) * red;
		// Soft glow of unresolved structure around the curtain.
		float gh = ( h - 112.0 ) / 34.0;
		col += vec3( 0.1, 0.9, 0.45 ) * 0.14 * exp( - gh * gh );
		acc += col * along * pulse * fold * ( 1.0 - 0.62 * fk );
	}
	// Both arcs fade into the horizon haze instead of ending on a line.
	return acc * uAurora * 0.85 * smoothstep( 0.06, 0.2, north ) * smoothstep( 0.02, 0.17, dir.y );
}
#endif

float hazeDepth( vec3 dir ) {
	float H = kodiakFogParams.x > 0.0 ? kodiakFogParams.x : 180.0;
	float a = kodiakFogParams.x > 0.0 ? kodiakFogParams.y : 0.3;
	float ceilH = kodiakFogParams.z > 0.0 ? kodiakFogParams.z : 1500.0;
	float y0 = max( cameraPosition.y, 0.0 );
	float s = max( dir.y, 1e-3 );
	float hp = ( 1.0 - a ) * H * exp( - y0 / H ) / s;
	float cp = a * min( 30000.0, max( ceilH - y0, 0.0 ) / s );
	// A bank the camera is inside only fogs the sky over its own thickness.
	float bank = uFogBoost.x * min( 30000.0, max( uFogBoost.y - y0, 0.0 ) / s );
	return ( uFogDensity - uFogBoost.x ) * ( hp + cp ) + bank;
}

void main() {
	vec3 dir = normalize( vDir );
	float pix = length( fwidth( dir ) ) * 0.7 + 1e-5;
	vec3 base = skyLUT( dir );
	// The maritime haze greys the physical sky everywhere; the high sky keeps a deeper blue for the eye.
	base = max( mix( vec3( dot( base, vec3( 0.2126, 0.7152, 0.0722 ) ) ), base, 1.0 + 0.22 * smoothstep( 0.05, 0.75, dir.y ) ), vec3( 0.0 ) );
	vec3 sky = base;
	#ifndef ENV_CAPTURE
		float ext = exp( - 0.12 / max( dir.y + 0.02, 0.02 ) );
		if ( uStarVis > 0.001 && dir.y > -0.01 ) sky += starField( dir, pix ) * uStarVis * ext;
		sky += moonDisc( dir, pix ) * smoothstep( -0.01, 0.005, dir.y );
		if ( uAurora > 0.001 ) sky += aurora( dir ) * ext;
		vec3 sd = sunDisc( dir, pix ) * smoothstep( -0.004, 0.004, dir.y );
	#else
		vec3 sd = vec3( 0.0 );
	#endif
	sky += uLightning * ( 0.3 + 1.2 * pow( max( dot( dir, uLightningDir ), 0.0 ), 6.0 ) ) * vec3( 0.35, 0.37, 0.45 ) * smoothstep( -0.05, 0.3, dir.y );
	vec4 cl = clouds( dir, base );
	sky = ( sky + sd * ( 1.0 - cl.a ) ) * ( 1.0 - cl.a ) + cl.rgb + sd * cl.a * 0.04 * ( 1.0 - uCloudCover );
	float tau = hazeDepth( dir );
	sky = mix( sky, kodiakFogTint( dir, uFogColor ), 1.0 - exp( - tau ) );
	#ifdef ENV_CAPTURE
		vec3 below = mix( uGroundColor, kodiakFogTint( dir, uFogColor ), exp( min( dir.y, 0.0 ) * 30.0 ) * 0.8 );
		sky = mix( sky, below, smoothstep( 0.0, -0.02, dir.y ) );
	#endif
	gl_FragColor = vec4( max( sky, vec3( 0.0 ) ), 1.0 );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`;
