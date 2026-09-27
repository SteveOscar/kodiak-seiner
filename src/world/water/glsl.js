// GLSL for the sea surface. The displacement code mirrors src/world/water/waves.js exactly (same constants, same
// order of operations); shading follows SPEC §4.3 (linear HDR, fog chunks, tonemapping + colorspace last).
//
// Cost structure (the fragment shader is the expensive part of the sea):
//   - The vertex shader displaces the grid and also accumulates the surface derivatives of every component that the
//     local vertex lattice resolves (>= ~8 vertices per wavelength); they reach the fragment shader as varyings.
//   - The fragment shader evaluates per pixel only the components too short for the lattice but still resolved by
//     the pixel footprint. Components are packed shortest first, so the loop stops at the first lattice-resolved one.
//   - Components smaller than a pixel become slope variance (specular roughness) on either side.
//   - Distance-limited work (fine detail octaves, shore foam, rain) sits behind branches that use textureGrad, and
//     wind-only work (whitecaps) behind uniform branches.

import { MAX_WAVES, SURGE_K, SURGE_FADE, EXPO_SWELL, EXPO_WIND, EXPO_CHOP } from './waves.js';
import { FETCH_MAX, OUTSIDE_BLEND, OUTSIDE_DEPTH, OUTSIDE_SHORE } from './fetch.js';

const f = (v) => (Number.isInteger(v) ? `${v}.0` : `${v}`);

// Shared declarations + the env/displacement functions (vertex shader and the GPU/CPU verification pass).
export const WAVE_COMMON = /* glsl */ `
#define MAX_WAVES ${MAX_WAVES}
uniform vec4 uWaveA[MAX_WAVES]; // kx, kz, phase (relative to uGridCentre), open-ocean amplitude
uniform vec4 uWaveB[MAX_WAVES]; // sharpness q, wavelength, swell one-hot, wind one-hot (chop = 1 - both)
uniform vec4 uWaveC[MAX_WAVES]; // group envelope: wavenumber (xy), phase relative to uGridCentre, gain
uniform int uWaveCount;
uniform vec4 uWaveFade;         // fade start, fade end (x wavelength), fade centre relative to uGridCentre (xy)
uniform vec2 uGridCentre;
uniform vec4 uSurge;            // amplitude, phase
uniform sampler2D uHeightMap;
uniform float uWorldHalf;
uniform sampler2D uFetchA;
uniform sampler2D uFetchB;
uniform vec4 uSwellW0;
uniform vec4 uSwellW1;
uniform vec4 uWindW0;
uniform vec4 uWindW1;

float kExpo( float fetchM, float f0 ) {
  return ( 1.0 - exp( - fetchM / f0 ) ) / ( 1.0 - exp( - ${f(FETCH_MAX)} / f0 ) );
}

float kSurgeNoise( vec2 p ) {
  return 1.3 * sin( p.x * 0.021 + 1.3 * sin( p.y * 0.017 ) ) + 0.9 * sin( p.y * 0.031 - 0.8 * sin( p.x * 0.013 ) );
}

float kSurgeWindow( float shore ) {
  return smoothstep( -4.0, 3.0, shore ) * ( 1.0 - smoothstep( 18.0, 60.0, shore ) );
}

// env = ( depth, shore distance, swell exposure, wind exposure ); chop exposure derived from the wind fetch.
vec4 kWaveEnv( vec2 world, out float chopExpo ) {
  vec2 uv = ( world + uWorldHalf ) / ( 2.0 * uWorldHalf );
  vec2 hm = textureLod( uHeightMap, uv, 0.0 ).rg;
  vec4 fa = textureLod( uFetchA, uv, 0.0 );
  vec4 fb = textureLod( uFetchB, uv, 0.0 );
  float fs = dot( fa, uSwellW0 ) + dot( fb, uSwellW1 );
  float fw = dot( fa, uWindW0 ) + dot( fb, uWindW1 );
  float over = max( abs( world.x ), abs( world.y ) ) - uWorldHalf;
  if ( over > 0.0 ) {
    float o = min( over / ${f(OUTSIDE_BLEND)}, 1.0 );
    hm.r += ( - ${f(OUTSIDE_DEPTH)} - hm.r ) * o;
    hm.g += ( ${f(OUTSIDE_SHORE)} - hm.g ) * o;
    fs += ( ${f(FETCH_MAX)} - fs ) * o;
    fw += ( ${f(FETCH_MAX)} - fw ) * o;
  }
  chopExpo = 0.35 + 0.65 * kExpo( fw, ${f(EXPO_CHOP)} );
  return vec4( - hm.r, hm.g, kExpo( fs, ${f(EXPO_SWELL)} ), kExpo( fw, ${f(EXPO_WIND)} ) );
}

// Displacement of the undisplaced point (local = x0 - uGridCentre): the offset to add to (x0, 0, z0). For shading it
// also accumulates, with the unfaded amplitude, the derivatives of the components that a lattice of this spacing
// resolves and a pixel of footprint fpv would resolve:
//   d1 = ( dh/dx0, dh/dz0, dDx/dx0, dDz/dz0 ), d2 = ( dDx/dz0, dDz/dx0, sum a sin, sum a ),
//   d3 = ( slope variance of lattice-resolved but sub-pixel components, their resolved wind steepness, 0, 0 ).
// Components are visited longest first; once one is both flat here (past its distance fade) and too short for the
// lattice, so is every shorter one.
void kWave( vec2 local, vec4 env, float chopExpo, float spacing, float fpv, out vec3 disp, out vec4 d1, out vec4 d2, out vec4 d3 ) {
  disp = vec3( 0.0 );
  d1 = vec4( 0.0 );
  d2 = vec4( 0.0 );
  d3 = vec4( 0.0 );
  float dist = length( local - uWaveFade.zw );
  float depth = env.x;
  for ( int j = 0; j < MAX_WAVES; j ++ ) {
    if ( j >= uWaveCount ) break;
    int i = uWaveCount - 1 - j;
    vec4 B = uWaveB[ i ];
    float lam = B.y;
    float rv = smoothstep( 4.0, 8.0, lam / spacing );
    if ( rv == 0.0 && dist >= uWaveFade.y * lam ) break;
    vec4 A = uWaveA[ i ];
    float e = B.z * env.z + B.w * env.w + ( 1.0 - B.z - B.w ) * chopExpo;
    float a0 = A.w * e * smoothstep( 0.0, 1.0, depth / ( 0.07 * lam + 1.0 ) );
    if ( a0 == 0.0 ) continue;
    float k = 6.283185307179586 / lam;
    vec4 C = uWaveC[ i ];
    float rp = smoothstep( 2.5, 6.0, lam / fpv );
    float wN = rv * rp;
    d3.x += rv * ( 1.0 - rp ) * 0.5 * k * k * a0 * a0 * ( 1.0 + 0.5 * C.w * C.w );
    d3.y += B.w * k * a0 * wN;
    float a = a0 * ( 1.0 - smoothstep( uWaveFade.x * lam, uWaveFade.y * lam, dist ) );
    if ( a == 0.0 && wN == 0.0 ) continue;
    float ph = C.x * local.x + C.y * local.y - C.z;
    float g = 1.0 + C.w * sin( ph );
    a *= g;
    float th = A.x * local.x + A.y * local.y - A.z;
    float s = sin( th );
    float c = cos( th );
    vec2 dir = A.xy / k;
    disp.xz += B.x * a * dir * c;
    disp.y += a * s;
    if ( wN > 0.0 ) {
      float an = a0 * wN;
      float aw = an * g;
      vec2 da = an * C.w * cos( ph ) * C.xy;
      float qs = B.x * aw * s;
      float qc = B.x * c;
      d1.x += aw * A.x * c + da.x * s;
      d1.y += aw * A.y * c + da.y * s;
      d1.z += - qs * dir.x * A.x + qc * dir.x * da.x;
      d1.w += - qs * dir.y * A.y + qc * dir.y * da.y;
      d2.x += - qs * dir.x * A.y + qc * dir.x * da.y;
      d2.y += - qs * dir.y * A.x + qc * dir.y * da.x;
      d2.z += aw * s;
      d2.w += aw;
    }
  }
  float sw = kSurgeWindow( env.y );
  if ( uSurge.x > 0.0 && sw > 0.0 ) {
    vec2 world = local + uGridCentre;
    float fo = 1.0 - smoothstep( ${f(SURGE_FADE[0])}, ${f(SURGE_FADE[1])}, dist );
    disp.y += uSurge.x * ( 0.25 + 0.75 * env.z ) * sw * fo * sin( env.y * ${f(SURGE_K)} + uSurge.y + kSurgeNoise( world ) );
  }
}
`;

export const SURFACE_VERTEX = /* glsl */ `
${WAVE_COMMON}
uniform float uCellsHalf;
uniform float uS0;
uniform float uMaxFade;
uniform float uMaxLambda;
uniform float uPixelAngle;      // metres of footprint per metre of distance for one pixel (2 tan(fov/2) / height)
varying vec3 vWorld;
varying vec2 vLocal;
varying vec4 vEnv; // swell, wind, chop exposure, lattice spacing (m)
varying vec4 vD1;
varying vec4 vD2;
varying vec4 vD3;
#include <fog_pars_vertex>

void main() {
  vec2 g = position.xz;
  float tag = position.y;
  vec2 local = g;
  if ( tag > 0.0 ) {
    // Morph odd lattice vertices onto the next level's lattice in the outer 30% of each level (watertight rings).
    float R = tag * uCellsHalf;
    float cheb = max( abs( g.x ), abs( g.y ) );
    float m = clamp( ( cheb / R - 0.7 ) / 0.25, 0.0, 1.0 );
    vec2 fracPart = fract( g / tag * 0.5 ) * 2.0;
    local = g - fracPart * tag * m;
  }
  float chopExpo = 1.0;
#ifdef KX_VS_NOENV
  vec4 env = vec4( 60.0, 1000.0, 1.0, 1.0 );
#else
  vec4 env = kWaveEnv( local + uGridCentre, chopExpo );
#endif
  // Effective lattice spacing: continuous across levels (the morph zones already sample at the coarser spacing).
  float spacing = max( uS0, 2.0 * max( abs( local.x ), abs( local.y ) ) / uCellsHalf );
  // Pixel footprint along the view at this point (the long axis of a grazing pixel).
  vec3 toCam = cameraPosition - vec3( local.x + uGridCentre.x, 0.0, local.y + uGridCentre.y );
  float D = max( length( toCam ), 1e-3 );
  float fpv = uPixelAngle * D / max( abs( toCam.y ) / D, 0.02 );
  vec3 disp = vec3( 0.0 );
  vec4 d1 = vec4( 0.0 );
  vec4 d2 = vec4( 0.0 );
  vec4 d3 = vec4( 0.0 );
  bool nearFade = length( local - uWaveFade.zw ) < uMaxFade || env.y < 80.0;
#ifndef KX_VS_NOWAVE
  if ( nearFade || spacing * 4.0 < uMaxLambda ) kWave( local, env, chopExpo, spacing, fpv, disp, d1, d2, d3 );
#endif
  if ( tag < 0.0 ) disp = vec3( 0.0 );
  vec3 P = vec3( local.x + uGridCentre.x + disp.x, disp.y, local.y + uGridCentre.y + disp.z );
  if ( tag < -1.5 ) {
    // Outermost skirt: lift toward the camera's horizon line so no sky shows below the sea edge at altitude.
    P.y = max( 0.0, cameraPosition.y - 0.0015 * length( local ) );
  }
  vWorld = P;
  vLocal = local;
  vEnv = vec4( env.z, env.w, chopExpo, spacing );
  vD1 = d1;
  vD2 = d2;
  vD3 = d3;
  vec4 mvPosition = viewMatrix * vec4( P, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

export const SURFACE_FRAGMENT = /* glsl */ `
#include <common>
#define MAX_WAVES ${MAX_WAVES}
uniform vec4 uWaveA[MAX_WAVES];
uniform vec4 uWaveB[MAX_WAVES];
uniform vec4 uWaveC[MAX_WAVES];
uniform int uWaveCount;
uniform vec2 uGridCentre;
uniform vec4 uSurge;
uniform sampler2D uHeightMap;
uniform float uWorldHalf;
uniform sampler2D uTerrainShadow;

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uHorizonColor;
uniform float uDaylight;
uniform vec2 uWindDir;
uniform float uWindSpeed;
uniform float uRain;
uniform float uTime;
uniform vec3 uWaterScatter;
uniform vec3 uWaterAbsorb;

uniform sampler2D uDetail;     // tileable slope texture (textures.js encoding): rg slope, b mean squared slope
uniform sampler2D uFoamNoise;  // r bubbly foam cells, g fbm, b streaks
uniform sampler2D uFoamField;  // r foam level, g lingering wake
uniform sampler2D uRippleField; // rg ripple slope, b ring froth
uniform vec4 uFieldInfo;       // foam field size, centre x, centre z, 1 if valid
uniform vec4 uRippleInfo;      // ripple field size, centre x, centre z, 1 if valid

uniform vec3 uShelfColor;
uniform vec3 uSSSColor;
uniform vec3 uFoamColor;
uniform vec4 uSea;       // whitecap amount, detail strength, choppiness, local sea (Hs m)
uniform float uWindSteep; // open-ocean wind-sea steepness, sum of k a over the wind components
uniform vec4 uLight;     // key-light irradiance scale, env intensity, unused, shore foam amount
uniform float uCamUnder;
uniform sampler2D uReflTex;    // planar reflection of layer-1 geometry (linear HDR)
uniform sampler2D uReflDepth;  // its depth: sky pixels keep the cleared far value
uniform mat4 uReflMatrix;
uniform vec4 uRefl;            // amount, reversed depth (1/0), distortion, unused

#ifdef ENVMAP_TYPE_CUBE_UV
uniform sampler2D uEnvMap;
#include <cube_uv_reflection_fragment>
#endif

varying vec3 vWorld;
varying vec2 vLocal;
varying vec4 vEnv;
varying vec4 vD1;
varying vec4 vD2;
varying vec4 vD3;

#include <fog_pars_fragment>
#include <dithering_pars_fragment>

float kGGX( vec3 N, vec3 V, vec3 L, float a ) {
  vec3 H = normalize( V + L );
  float NoH = max( dot( N, H ), 0.0 );
  float NoL = max( dot( N, L ), 0.0 );
  float NoV = max( dot( N, V ), 1e-3 );
  float a2 = a * a;
  float d = NoH * NoH * ( a2 - 1.0 ) + 1.0;
  float D = a2 / ( 3.14159265 * d * d );
  float vis = 0.5 / ( NoL * sqrt( NoV * NoV * ( 1.0 - a2 ) + a2 ) + NoV * sqrt( NoL * NoL * ( 1.0 - a2 ) + a2 ) + 1e-5 );
  float F = 0.02 + 0.98 * pow( 1.0 - max( dot( V, H ), 0.0 ), 5.0 );
  return D * vis * F * NoL;
}

float kSurgeNoise( vec2 p ) {
  return 1.3 * sin( p.x * 0.021 + 1.3 * sin( p.y * 0.017 ) ) + 0.9 * sin( p.y * 0.031 - 0.8 * sin( p.x * 0.013 ) );
}

vec3 kHash32( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
  p3 += dot( p3, p3.yxz + 33.33 );
  return fract( ( p3.xxy + p3.yzz ) * p3.zyx );
}

// Rain: one drop per cell per period. Returns (ring-wave slope xy, splash): the splash is a tiny bright crown for the
// first ~0.1 s, then a capillary ring spreads and fades.
vec3 kRainRings( vec2 p, float t ) {
  vec2 cell = floor( p );
  vec2 fp = fract( p );
  vec3 h = kHash32( cell );
  float period = 0.7 + 0.6 * h.z;
  float age = fract( t / period + h.x * 7.0 );
  vec2 d = fp - ( 0.3 + 0.4 * h.xy );
  float r = length( d );
  float R = age * 0.42;
  float x = ( r - R ) * 13.0;
  float amp = ( 1.0 - age ) * ( 1.0 - age );
  float dh = sin( x * 2.6 ) * exp( - x * x ) * amp;
  float splash = ( 1.0 - smoothstep( 0.0, 0.1, age ) ) * ( 1.0 - smoothstep( 0.015, 0.05, r ) );
  return vec3( d / max( r, 1e-3 ) * dh, splash );
}

// White horses: one potential breaker per wind-frame cell (18 m downwind x 11 m crosswind); cover is the fraction
// of cells that break each cycle and size scales the patch. A breaker flares solid white for about a second, then
// its foam laces out and drifts downwind for a few seconds. Returns (fresh solid foam, aged lacy foam level).
vec2 kWhiteHorses( vec2 wp, float t, float cover, float ragged, float size ) {
  vec2 cellSize = vec2( 18.0, 11.0 );
  vec2 id = floor( wp / cellSize );
  vec2 f = wp - id * cellSize;
  vec3 h = kHash32( id + 17.3 );
  vec3 h2 = kHash32( id * 1.7 + 3.1 );
  float period = 7.0 + 6.0 * h2.x;
  float age = fract( t / period + h.z ) * period;
  float live = step( h2.y, cover );
  vec2 c = vec2( 4.0 + 10.0 * h.x + 2.2 * age, 2.5 + 6.0 * h.y );
  vec2 d = ( f - c ) / ( vec2( 1.2 + 0.4 * age, 2.0 + 0.55 * age + 1.2 * h2.z ) * size );
  float r = length( d ) + ragged;
  float fresh = ( 1.0 - smoothstep( 0.3, 0.75, r ) ) * smoothstep( 0.0, 0.35, age ) * ( 1.0 - smoothstep( 1.0, 2.6, age ) );
  float aged = ( 1.0 - smoothstep( 0.3, 1.05, r ) ) * smoothstep( 0.3, 1.0, age ) * ( 1.0 - smoothstep( 1.8, 6.0, age ) );
  return vec2( fresh, aged ) * live;
}

// Foam opacity for a foam level (0..1) over the baked bubble-density texture: dense foam first, holes last, with soft
// edges; thin foam is a translucent lace, thick foam opaque white.
float kFoamAt( float level, float dens ) {
  float cover = smoothstep( 0.86 - level, 1.18 - level, dens );
  return cover * smoothstep( 0.0, 0.2, level ) * ( 0.45 + 0.55 * smoothstep( 0.2, 0.75, level ) );
}

vec3 kSky( vec3 R, float rough ) {
#ifdef ENVMAP_TYPE_CUBE_UV
  return textureCubeUV( uEnvMap, R, rough ).rgb * uLight.y;
#else
  return mix( uHorizonColor, uSkyColor, pow( clamp( R.y, 0.0, 1.0 ), 0.5 ) );
#endif
}

// One octave of detail slope: two layers of the tileable slope texture drifting apart (evolving, not scrolling).
// Returns (slope xy, slope variance inside the footprint); explicit gradients so it may sit inside branches.
vec3 kDetailOctave( vec2 wp, vec2 gx, vec2 gy, float scale, vec2 v0, vec2 v1, vec2 o0, vec2 o1, float stretch ) {
  vec2 flip = vec2( 1.0, -1.0 );
  vec2 uv0 = wp / scale + v0 * uTime + o0;
  vec2 uv1 = ( wp / scale * stretch + v1 * uTime + o1 ) * flip;
  vec3 t0 = textureGrad( uDetail, uv0, gx / scale, gy / scale ).rgb * vec3( 8.0, 8.0, 16.0 ) - vec3( 4.0, 4.0, 0.0 );
  vec3 t1 = textureGrad( uDetail, uv1, gx / scale * stretch * flip, gy / scale * stretch * flip ).rgb * vec3( 8.0, 8.0, 16.0 ) - vec3( 4.0, 4.0, 0.0 );
  vec2 s = ( t0.rg + t1.rg * flip ) * 0.5;
  return vec3( s, max( 0.0, ( t0.b + t1.b ) * 0.25 - dot( s, s ) ) );
}

void main() {
#ifdef KX_E0
  gl_FragColor = vec4( vD1.x + vD2.x + vD3.x + vD3.y + vEnv.w + vWorld.y + vLocal.x, 0.0, 0.0, 1.0 ); return;
#endif
  vec3 P = vWorld;
  vec3 toCam = cameraPosition - P;
  float dist = length( toCam );
  vec3 V = toCam / max( dist, 1e-4 );
  vec2 local = vLocal;
  vec2 world0 = local + uGridCentre;

  // Environment at this pixel (mip-filtered: no shimmer at grazing angles).
  vec2 huv = ( world0 + uWorldHalf ) / ( 2.0 * uWorldHalf );
  vec2 hm = texture( uHeightMap, huv ).rg;
  float outside = clamp( ( max( abs( world0.x ), abs( world0.y ) ) - uWorldHalf ) / 600.0, 0.0, 1.0 );
  float depth = mix( - hm.r, 60.0, outside );
  float shore = mix( hm.g, 1000.0, outside );
  float terrainH = mix( hm.r, -60.0, outside );
  float es = vEnv.x;
  float ew = vEnv.y;
  float ec = vEnv.z;
  float spacing = vEnv.w;

  // Gerstner derivatives: the lattice-resolved part arrives from the vertex shader; add the components the lattice
  // cannot carry but the pixel resolves. Sub-pixel components widen the specular lobe instead (no aliasing).
  vec2 ldx = dFdx( local );
  vec2 ldy = dFdy( local );
  float fp = max( length( ldx ), length( ldy ) ) + 1e-4;
  float hx = vD1.x, hz = vD1.y, jxx = vD1.z, jzz = vD1.w;
  float jxz = vD2.x, jzx = vD2.y, hsum = vD2.z, asum = vD2.w;
  float variance = vD3.x, steepRes = vD3.y;
  float steepAll = uWindSteep * ew * smoothstep( 0.0, 1.0, depth / 3.1 );
  for ( int i = 0; i < MAX_WAVES; i ++ ) {
    if ( i >= uWaveCount ) break;
    vec4 B = uWaveB[ i ];
    float lam = B.y;
    float wv = 1.0 - smoothstep( 4.0, 8.0, lam / spacing );
    if ( wv <= 0.0 ) break;
    vec4 A = uWaveA[ i ];
    vec4 C = uWaveC[ i ];
    float e = B.z * es + B.w * ew + ( 1.0 - B.z - B.w ) * ec;
    float a = A.w * e * smoothstep( 0.0, 1.0, depth / ( 0.07 * lam + 1.0 ) );
    float k = 6.283185307179586 / lam;
    float resolved = smoothstep( 2.5, 6.0, lam / fp );
    variance += wv * ( 1.0 - resolved ) * 0.5 * k * k * a * a * ( 1.0 + 0.5 * C.w * C.w );
    a *= wv * resolved;
    steepRes += B.w * k * a;
    if ( a <= 0.0 ) continue;
    a *= 1.0 + C.w * sin( C.x * local.x + C.y * local.y - C.z );
    float th = A.x * local.x + A.y * local.y - A.z;
    float s = sin( th );
    float c = cos( th );
    vec2 dir = A.xy / k;
    float qs = B.x * a * s;
    jxx -= qs * dir.x * A.x;
    jxz -= qs * dir.x * A.y;
    jzx -= qs * dir.y * A.x;
    jzz -= qs * dir.y * A.y;
    hx += a * A.x * c;
    hz += a * A.y * c;
    hsum += a * s;
    asum += a;
  }
  vec3 Tx = vec3( 1.0 + jxx, hx, jzx );
  vec3 Tz = vec3( jxz, hz, 1.0 + jzz );
  vec3 Ng = normalize( cross( Tz, Tx ) );
  vec2 slope = - Ng.xz / max( Ng.y, 0.08 );
  float jac = ( 1.0 + jxx ) * ( 1.0 + jzz ) - jxz * jzx;
  float crestness = hsum / max( asum, 1e-3 );
#ifdef KX_E1
  gl_FragColor = vec4( slope, jac + crestness + variance + steepRes, 1.0 ); return;
#endif

  // Detail normals: three octaves in the wind frame; the finer two only where they are still resolved.
  vec2 wd = normalize( uWindDir + vec2( 1e-4, 0.0 ) );
  vec2 wside = vec2( - wd.y, wd.x );
  vec2 wp = vec2( dot( P.xz, wd ), dot( P.xz, wside ) );
  vec2 wgx = vec2( dot( ldx, wd ), dot( ldx, wside ) );
  vec2 wgy = vec2( dot( ldy, wd ), dot( ldy, wside ) );
  float detail = uSea.y * mix( 0.45, 1.0, ec );
  vec2 dslope = vec2( 0.0 );
  float dvar = 0.0;
  {
    vec3 o = kDetailOctave( wp, wgx, wgy, 26.0, vec2( 0.045, 0.0 ), vec2( 0.031 * 1.21, 0.012 ), vec2( 0.0 ), vec2( 0.37 ), 1.21 );
    float w0 = 0.11 * detail;
    dslope += o.xy * w0;
    dvar += o.z * w0 * w0;
  }
  float w1max = 0.1 * detail;
  float w1 = w1max * ( 1.0 - smoothstep( 250.0, 900.0, dist ) );
  if ( w1 > 0.0 ) {
    vec3 o = kDetailOctave( wp, wgx, wgy, 7.1, vec2( 0.09, 0.0 ), vec2( 0.066 * 1.17, - 0.03 * 1.17 ), vec2( 0.61 ), vec2( 0.13 ), 1.17 );
    dslope += o.xy * w1;
    dvar += o.z * w1 * w1;
  }
  dvar += 0.5 * ( w1max - w1 ) * ( w1max - w1 );
  float w2max = 0.08 * detail;
  float w2 = w2max * ( 1.0 - smoothstep( 60.0, 260.0, dist ) );
  if ( w2 > 0.0 ) {
    vec3 o = kDetailOctave( wp, wgx, wgy, 1.9, vec2( 0.16, 0.0 ), vec2( 0.12 * 1.13, 0.05 * 1.13 ), vec2( 0.29 ), vec2( 0.83 ), 1.13 );
    dslope += o.xy * w2;
    dvar += o.z * w2 * w2;
  }
  dvar += 0.5 * ( w2max - w2 ) * ( w2max - w2 );
  // Rotate detail slopes from the wind frame back to world.
  dslope = wd * dslope.x + wside * dslope.y;
#ifdef KX_E2
  gl_FragColor = vec4( slope + dslope, jac + crestness + variance + steepRes + dvar, 1.0 ); return;
#endif

  // Foam field (stamps) and ripples.
  float stampFoam = 0.0;
  float wake = 0.0;
  vec2 rslope = vec2( 0.0 );
  float froth = 0.0;
  // Beyond ~700 m stamps are sub-pixel, and the field has no mips: sampling it there would only thrash the cache.
  if ( uFieldInfo.w > 0.5 && dist < 700.0 ) {
    vec2 rel = abs( P.xz - uFieldInfo.yz ) / uFieldInfo.x;
    float inWin = 1.0 - smoothstep( 0.42, 0.5, max( rel.x, rel.y ) );
    vec4 ff = textureGrad( uFoamField, fract( P.xz / uFieldInfo.x ), ldx / uFieldInfo.x, ldy / uFieldInfo.x );
    stampFoam = ff.r * inWin;
    wake = ff.g * inWin;
    vec2 ruv = ( P.xz - uRippleInfo.yz ) / uRippleInfo.x + 0.5;
    if ( uRippleInfo.w > 0.5 && all( greaterThan( ruv, vec2( 0.0 ) ) ) && all( lessThan( ruv, vec2( 1.0 ) ) ) ) {
      vec4 rf = textureGrad( uRippleField, ruv, ldx / uRippleInfo.x, ldy / uRippleInfo.x );
      float rfade = 1.0 - smoothstep( 0.4, 0.5, max( abs( ruv.x - 0.5 ), abs( ruv.y - 0.5 ) ) );
      rslope = rf.rg * rfade;
      froth = rf.b * rfade;
    }
  }
  // A lingering wake is a smoother slick with a faint foam trail.
  dslope *= 1.0 - 0.55 * clamp( wake * 1.4, 0.0, 1.0 );

  // Rain beats down the short waves, dimples the surface with rings and fizzes with tiny splashes.
  vec2 rain = vec2( 0.0 );
  float rainSplash = 0.0;
  dslope *= 1.0 - 0.45 * uRain;
  if ( uRain > 0.02 && dist < 70.0 ) {
    float rf = uRain * ( 1.0 - smoothstep( 15.0, 70.0, dist ) );
    vec3 r1 = kRainRings( P.xz * 1.6, uTime );
    vec3 r2 = kRainRings( P.xz * 2.3 + 17.1, uTime * 1.13 );
    vec3 r3 = kRainRings( P.xz * 3.1 + 5.3, uTime * 0.91 );
    rain = ( r1.xy + r2.xy + r3.xy ) * 0.8 * rf;
    rainSplash = max( max( r1.z, r2.z ), r3.z ) * rf * ( 1.0 - smoothstep( 3.0, 16.0, dist ) );
  }

  vec2 totalSlope = slope + dslope + rslope + rain;
  vec3 N = normalize( vec3( - totalSlope.x, 1.0, - totalSlope.y ) );
  variance += dvar + uRain * 0.007;

  bool under = !gl_FrontFacing;
  // From above, back faces are only the lee slopes of steep crests seen through the crest itself: drop them.
  if ( under && uCamUnder < 0.5 ) discard;
  if ( under ) N = -N;
  float NoV = dot( N, V );
  if ( NoV < 0.02 ) {
    // Steep faces turned away from the viewer: bend the normal back so reflections stay sane.
    N = normalize( N + V * ( 0.02 - NoV ) );
    NoV = dot( N, V );
  }

  vec3 L = normalize( uSunDir );
  float sunUp = smoothstep( -0.035, 0.04, L.y );
  float shadow = texture( uTerrainShadow, huv ).r;
  vec3 sunRad = uSunColor * uLight.x * sunUp * shadow;
  float rough = sqrt( variance );

  // Colours of the water column (lit), shelf and sky ambient.
  float shallow = 1.0 - smoothstep( 0.6, 11.0, depth );
  vec3 ambient = mix( uHorizonColor, uSkyColor, 0.55 );
  vec3 body = uWaterScatter;
  body = mix( body, uShelfColor * ( 0.12 + 0.88 * uDaylight ) * mix( 0.55, 1.0, shadow ), shallow * 0.65 );

  if ( under ) {
    // Looking up from below: Snell's window (sky inside ~48.6 deg, total internal reflection outside).
    float cosI = abs( dot( V, N ) );
    float window = smoothstep( 0.6, 0.72, cosI );
    vec3 R = refract( -V, N, 1.33 );
    vec3 sky = kSky( normalize( R + vec3( 0.0, 1e-3, 0.0 ) ), 0.2 );
    vec3 col = mix( uWaterScatter * 0.7, sky * 0.8 + uWaterScatter * 0.3, window );
    col = mix( uWaterScatter, col, exp( - uWaterAbsorb * dist ) );
    gl_FragColor = vec4( col, 1.0 );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    return;
  }

  // Fresnel for a rough surface (sub-pixel facets tilted toward the viewer lower the grazing reflectance), and the
  // mean reflected ray of a rough patch climbs higher into the sky than the smooth mirror direction.
  float F = 0.02 + ( max( 1.0 - 1.6 * rough, 0.02 ) - 0.02 ) * pow( 1.0 - clamp( NoV, 0.0, 1.0 ), 5.0 );
  vec3 R = reflect( -V, N );
  if ( R.y < 0.0 ) R.y = - R.y * 0.5;
  R = normalize( R + vec3( 0.0, 0.002 + 0.9 * rough, 0.0 ) );
  vec3 refl = kSky( R, clamp( rough * 1.6, 0.0, 1.0 ) );
  if ( uRefl.x > 0.0 ) {
    // Mirrored terrain: project the flat-sea point, then shift by the view-space normal tilt.
    vec4 rp = uReflMatrix * vec4( P.x, 0.0, P.z, 1.0 );
    vec3 nv = ( viewMatrix * vec4( N - vec3( 0.0, 1.0, 0.0 ), 0.0 ) ).xyz;
    vec2 ruv = rp.xy / rp.w + nv.xy * uRefl.z;
    float calm = 1.0 - smoothstep( 0.05, 0.22, rough );
    if ( calm > 0.0 && all( greaterThan( ruv, vec2( 0.001 ) ) ) && all( lessThan( ruv, vec2( 0.999 ) ) ) ) {
      // Depth is not filterable: soften the silhouette with a 4-tap mask (reduced-resolution target).
      vec2 tx = 0.75 / vec2( textureSize( uReflDepth, 0 ) );
      vec4 dq = vec4(
        textureLod( uReflDepth, ruv + vec2( - tx.x, - tx.y ), 0.0 ).r,
        textureLod( uReflDepth, ruv + vec2( tx.x, - tx.y ), 0.0 ).r,
        textureLod( uReflDepth, ruv + vec2( - tx.x, tx.y ), 0.0 ).r,
        textureLod( uReflDepth, ruv + vec2( tx.x, tx.y ), 0.0 ).r );
      vec4 hq = uRefl.y > 0.5 ? step( vec4( 1e-7 ), dq ) : step( dq, vec4( 0.9999999 ) );
      float hit = dot( hq, vec4( 0.25 ) );
      refl = mix( refl, textureLod( uReflTex, ruv, 0.0 ).rgb, hit * calm * uRefl.x );
    }
  }

  // Sun: a sharp lobe for glints and a broad lobe for the sheen of the sun path.
  float aSharp = sqrt( 0.0016 + 2.0 * variance );
  float aBroad = sqrt( 0.03 + 2.0 * variance );
  vec3 spec = sunRad * ( 0.8 * kGGX( N, V, L, aSharp ) + 0.2 * kGGX( N, V, L, aBroad ) );
  spec = min( spec, vec3( 60.0 ) );

  // Light through thin crests toward a low sun: only the upper part of steep, backlit wave faces glows.
  vec2 Lh = normalize( L.xz + vec2( 1e-4 ) );
  vec2 Vh = normalize( - V.xz + vec2( 1e-4 ) );
  float back = pow( clamp( dot( Vh, Lh ), 0.0, 1.0 ), 4.0 ) * clamp( 1.0 - L.y * 1.6, 0.0, 1.0 );
  float crest = smoothstep( 0.25, 0.95, crestness );
  float face = clamp( dot( normalize( vec3( N.x, 0.0, N.z ) + 1e-4 ), vec3( - Lh.x, 0.0, - Lh.y ) ), 0.0, 1.0 );
  vec3 sss = uSSSColor * sunRad * back * crest * face * ( 0.02 + 0.1 * clamp( uSea.w * 0.5, 0.0, 1.0 ) ) * ( 1.0 - F );
#ifdef KX_E3
  gl_FragColor = vec4( refl + spec + sss + body * jac + froth + wake + stampFoam, 1.0 ); return;
#endif

  // Foam: whitecaps (crest compression in wind), stamps, wake, shore wash, ripple froth.
  vec2 fuv = P.xz * 0.17 + vec2( hx, hz ) * 0.3;
  vec3 fn = texture( uFoamNoise, fuv ).rgb;
  // Bubble density at two scales plus a slow variation, so foam holes are neither all one size nor evenly spread.
  vec3 fnB = texture( uFoamNoise, P.xz * 0.061 + vec2( hx, hz ) * 0.1 + 0.37 ).rgb;
  float cells = clamp( fn.r * 0.62 + fnB.r * 0.38 + ( fnB.g - 0.5 ) * 0.35, 0.0, 1.0 );
  float W = uSea.x;
  float whitecap = 0.0;
  float aer = 0.0; // aerated water under the foam (bubble clouds)
  if ( W > 0.002 ) {
    // Wind-frame textures: bubble lace stretched downwind, and a macro breakup field (crests break in segments).
    vec3 cw = texture( uFoamNoise, wp * vec2( 0.1, 0.19 ) + vec2( hx, hz ) * 0.25 ).rgb;
    vec3 wn = texture( uFoamNoise, wp * vec2( 0.021, 0.055 ) + 0.13 ).rgb;
    // Resolved crests: compression (1 - J) above a wind-dependent threshold (calibrated against the model's J
    // distribution: ~1% cover at 6 m/s, ~5% at 10 m/s, ~10% in a gale); the excess thickens the foam.
    float tJ = 0.082 - 0.022 * W;
    float excess = ( 1.0 - jac ) - tJ;
    float breakup = smoothstep( 0.45, 0.74, wn.g + 0.06 * W );
    float crestLevel = smoothstep( 0.0, 0.03, excess ) * breakup * ( 0.4 + 0.45 * smoothstep( 0.03, 0.1, excess ) );
    float rf = steepAll > 1e-4 ? clamp( steepRes / steepAll, 0.0, 1.0 ) : 1.0;
    // Where the steep wind waves are sub-pixel: sparse specks at the same density as the resolved crests, fading to
    // their mean cover once the specks themselves are sub-pixel (thresholding a mip-filtered texture would erase them).
    float wcFar = mix( smoothstep( 0.93 - 0.08 * W, 1.0, cw.r ), 0.06 * W, smoothstep( 0.25, 1.2, fp ) );
    wcFar *= smoothstep( 0.35, 0.7, wn.b + 0.2 * W );
    // Anisotropic footprint: at grazing angles a breaker is a thin bright dash, which should stay visible.
    float fpIso = sqrt( max( min( length( ldx ), length( ldy ) ), 1e-4 ) * fp );
    float horseFar = smoothstep( 0.9, 3.5, fpIso );
    // A breaking crest is bright whatever the wind; the wind sets how many break and how big they are.
    float horseAmt = smoothstep( 0.0, 0.06, W ) * smoothstep( 0.15, 0.5, ew ) * ( 0.75 + 0.25 * smoothstep( -0.2, 0.4, crestness ) );
    float ragged = ( wn.g - 0.5 ) * 0.6 + ( cw.r - 0.5 ) * 0.4;
    vec2 horses = kWhiteHorses( wp, uTime, 0.04 + 0.34 * W, ragged, 0.6 + 0.6 * W ) * horseAmt * ( 1.0 - horseFar );
    float wcLevel = mix( wcFar, crestLevel, rf ) * pow( W, 0.4 ) * ew;
    wcLevel = max( wcLevel, max( horses.y * 0.7, horseFar * ( 0.01 + 0.06 * W ) * W * horseAmt ) );
    whitecap = kFoamAt( min( 1.0, wcLevel ), cw.r );
    // The moment of breaking: a small, bright, nearly solid patch.
    whitecap = max( whitecap, kFoamAt( horses.x, cw.r * 0.5 + 0.5 ) );
    aer = max( wcLevel * 0.9, horses.x );
    if ( uWindSpeed > 12.0 ) {
      // Gale: foam blown into long streaks along the wind.
      float streak = texture( uFoamNoise, vec2( wp.x * 0.009, wp.y * 0.075 ) ).b;
      float gale = smoothstep( 12.0, 19.0, uWindSpeed ) * ew;
      whitecap = max( whitecap, kFoamAt( smoothstep( 0.58, 0.86, streak ) * 0.55 * gale, cw.r ) );
    }
  }

  float stampF = kFoamAt( clamp( stampFoam * 1.1, 0.0, 1.0 ), cells );
  // The lingering wake trail: faint streaky foam along the slick.
  float wakeF = kFoamAt( clamp( wake, 0.0, 1.0 ) * ( 0.35 + 0.4 * fn.g ), cells ) * 0.7;
  aer = max( aer, max( smoothstep( 0.0, 0.55, stampFoam ), wake * 0.5 ) );

  float shoreF = 0.0;
  if ( dist < 3200.0 && shore < 40.0 ) {
    // Surf: lines of breaking crests run in toward the beach (phase shared with the surge geometry), broken into
    // segments along the shore; spent foam drifts in behind them; a thin lacy swash edges the waterline. Everything
    // scales with the wave energy reaching this shore.
    float surgePhase = shore * ${f(SURGE_K)} + uSurge.y + kSurgeNoise( world0 );
    float energy = ( 0.25 + 0.75 * es ) * ( 0.45 + 0.55 * smoothstep( 0.06, 0.25, uSurge.x ) ) * uLight.w;
    float seg = smoothstep( 0.32, 0.68, fnB.g + 0.3 * sin( dot( world0, vec2( 0.041, 0.029 ) ) + uSurge.y * 0.21 ) );
    float zone = ( 1.0 - smoothstep( 8.0, 34.0, shore ) ) * smoothstep( 0.5, 4.0, shore );
    float crestLine = pow( max( sin( surgePhase ), 0.0 ), 5.0 ) * zone * mix( 0.3, 1.0, seg );
    float spent = smoothstep( 0.1, 0.9, sin( surgePhase - 1.1 ) ) * ( 1.0 - smoothstep( 2.0, 20.0, shore ) ) * 0.5;
    float swash = ( 1.0 - smoothstep( 0.0, 0.14 + 0.3 * uSurge.x, P.y - terrainH ) ) * smoothstep( -3.0, 1.0, shore );
    float shoreLevel = max( max( crestLine * 1.1, spent ) * energy, swash * ( 0.45 + 0.35 * energy ) );
    float shoreFade = 1.0 - smoothstep( 1800.0, 3200.0, dist );
    shoreF = kFoamAt( shoreLevel, cells ) * shoreFade;
    aer = max( aer, max( crestLine * energy, spent * energy * 0.6 ) * shoreFade );
  }
  float foam = max( max( whitecap, stampF ), max( shoreF, wakeF ) );
  foam = max( foam, kFoamAt( clamp( froth, 0.0, 1.0 ), cells ) );
  foam = max( foam, rainSplash * 0.9 );
  aer = max( aer, froth );

  // Foam lit by sun and sky (diffuse, slightly forward-scattering).
  vec3 foamLit = uFoamColor * ( sunRad * ( 0.35 + 0.65 * max( dot( N, L ), 0.0 ) ) * 0.55 + ambient * 0.9 + uWaterScatter * 0.5 );
  foamLit *= 0.8 + 0.2 * cells;

  // Aerated water: bubble clouds under the foam scatter light back up, a milky aquamarine that makes the layer
  // nearly opaque (prop wash, breaking crests, surf).
  float aerA = clamp( aer, 0.0, 1.0 ) * 0.8;
  vec3 aerCol = mix( uSSSColor, uFoamColor, 0.3 ) * ( ambient * 0.5 + sunRad * ( 0.05 + 0.08 * max( L.y, 0.0 ) ) );

  // Thin-layer composite (premultiplied, then un-premultiplied for fog and normal blending).
  float alpha = mix( 0.2, 1.0, F );
  alpha = mix( alpha, max( alpha, 0.92 ), aerA );
  vec3 premult = F * refl + ( alpha - F ) * mix( body, aerCol, aerA ) + spec + sss;
  alpha = mix( alpha, 1.0, foam );
  premult = mix( premult, foamLit, foam ) + spec * foam * 0.15;
  vec3 col = premult / alpha;
#ifdef KX_E4
  gl_FragColor = vec4( col, alpha ); return;
#endif

  gl_FragColor = vec4( col, alpha );
#ifdef DEBUG_VIEW
  {
    vec3 d = vec3( 0.0 );
    if ( DEBUG_VIEW == 1 ) d = vec3( foam );
    else if ( DEBUG_VIEW == 2 ) d = N * 0.5 + 0.5;
    else if ( DEBUG_VIEW == 3 ) d = spec;
    else if ( DEBUG_VIEW == 4 ) d = vec3( shadow );
    else if ( DEBUG_VIEW == 5 ) d = vec3( rough );
    else if ( DEBUG_VIEW == 6 ) d = vec3( alpha );
    else if ( DEBUG_VIEW == 7 ) d = vec3( dslope * 2.0 + 0.5, 0.5 );
    else if ( DEBUG_VIEW == 8 ) d = refl;
    else if ( DEBUG_VIEW == 9 ) d = vec3( F );
    else if ( DEBUG_VIEW == 10 ) d = premult;
    else if ( DEBUG_VIEW == 11 ) d = col;
    else if ( DEBUG_VIEW == 12 ) d = vec3( spacing / 16.0, fp / 16.0, 0.0 );
    if ( any( isnan( d ) ) ) d = vec3( 1.0, 0.0, 1.0 );
    if ( any( isinf( d ) ) ) d = vec3( 0.0, 1.0, 0.0 );
    gl_FragColor = vec4( d, 1.0 );
  }
#endif
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <dithering_fragment>
}
`;

// Opaque "abyss" plane at y = -40 in the water-column colour, so something is always under the thin surface.
export const ABYSS_VERTEX = /* glsl */ `
#include <fog_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

export const ABYSS_FRAGMENT = /* glsl */ `
uniform vec3 uWaterScatter;
#include <fog_pars_fragment>
void main() {
  gl_FragColor = vec4( uWaterScatter, 1.0 );
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// GPU/CPU check: renders the displaced position of N sample points (one per pixel of a 1-row float target) with the
// same kWave() the surface uses.
export const VERIFY_VERTEX = /* glsl */ `
${WAVE_COMMON}
attribute float aIndex;
uniform float uCount;
varying vec3 vP;
void main() {
  float chopExpo;
  vec2 world = position.xz;
  vec2 local = world - uGridCentre;
  vec4 env = kWaveEnv( world, chopExpo );
  vec3 d;
  vec4 d1, d2, d3;
  kWave( local, env, chopExpo, 1e5, 1e5, d, d1, d2, d3 );
  vP = vec3( world.x + d.x, d.y, world.y + d.z ) - vec3( uGridCentre.x, 0.0, uGridCentre.y );
  gl_PointSize = 1.0;
  gl_Position = vec4( ( aIndex + 0.5 ) / uCount * 2.0 - 1.0, 0.0, 0.5, 1.0 );
}
`;

export const VERIFY_FRAGMENT = /* glsl */ `
varying vec3 vP;
void main() {
  gl_FragColor = vec4( vP, 1.0 );
}
`;

// Underwater fallback (the camera rig keeps the camera above the sea; debug and photo cameras may not): a camera-space
// veil in the water-column colour, nearly opaque for level and downward views (long water paths), light when looking
// up at the surface, whose own back face already shows Snell's window.
export const VEIL_VERTEX = /* glsl */ `
uniform mat4 uInvViewProj;
varying vec3 vDir;
#include <fog_pars_vertex>
void main() {
  vec4 far = uInvViewProj * vec4( position.xy, 1.0, 1.0 );
  vDir = far.xyz / far.w - cameraPosition;
  vec4 mvPosition = vec4( 0.0, 0.0, -1.0, 1.0 );
  gl_Position = vec4( position.xy, 0.0, 1.0 );
  #include <fog_vertex>
}
`;

export const VEIL_FRAGMENT = /* glsl */ `
uniform vec3 uWaterScatter;
uniform vec3 uWaterAbsorb;
uniform float uDepth;
varying vec3 vDir;
#include <fog_pars_fragment>
void main() {
  vec3 d = normalize( vDir );
  float up = max( d.y, 0.0 );
  // Path to the surface looking up; looking level or down the water column is effectively unbounded.
  float path = up > 0.02 ? uDepth / up : 1e4;
  float a = 1.0 - exp( - dot( uWaterAbsorb, vec3( 0.2, 0.5, 0.3 ) ) * ( path + 4.0 ) );
  vec3 col = uWaterScatter * ( 0.8 + 0.6 * up );
  gl_FragColor = vec4( col, clamp( a, 0.25, 0.97 ) );
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
