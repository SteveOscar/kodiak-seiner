// GLSL mirrors of surface.js (height function) and landcover.js (cover formulas). Keep the constants in sync; the
// JS modules are the reference. Uniforms expected by TK_HEIGHT: tkHeight (R32F DEM, texelFetch), tkSize, tkHalf.

import { DETAIL, L0, OUTSIDE_DEPTH, OUTSIDE_FALLOFF } from './surface.js';
import { COVER, ALDER_T0, ALDER_T1 } from './landcover.js';

const f = (v) => (Number.isInteger(v) ? `${v}.0` : `${v}`);

// Value noise over the shared lattice (surface.js LATTICE: byte(i, j) = floor(hash2(i & 255, j & 255) * 256)).
// Two bit-identical flavours: TK_NOISE fetches the four corners from the RGBA8 lattice texture (one texelFetch; best in
// vertex shaders), TK_NOISE_ALU recomputes the hash (best in long fragment shaders, where dependent fetches stall).
const NOISE_BODY = /* glsl */ `
vec3 tkNoiseD( vec2 x ) {
  vec2 i = floor( x );
  vec2 fr = x - i;
  vec4 q = tkCorners( ivec2( i ) );
  vec2 u = fr * fr * fr * ( fr * ( fr * 6.0 - 15.0 ) + 10.0 );
  vec2 du = 30.0 * fr * fr * ( fr * ( fr - 2.0 ) + 1.0 );
  float k = q.x - q.y - q.z + q.w;
  return vec3( du.x * ( q.y - q.x + k * u.y ), du.y * ( q.z - q.x + k * u.x ), q.x + ( q.y - q.x ) * u.x + ( q.z - q.x ) * u.y + k * u.x * u.y );
}
float tkNoise( vec2 x ) {
  vec2 i = floor( x );
  vec2 fr = x - i;
  vec4 q = tkCorners( ivec2( i ) );
  vec2 u = fr * fr * fr * ( fr * ( fr * 6.0 - 15.0 ) + 10.0 );
  return q.x + ( q.y - q.x ) * u.x + ( q.z - q.x ) * u.y + ( q.x - q.y - q.z + q.w ) * u.x * u.y;
}
`;

export const TK_NOISE = /* glsl */ `
uniform highp sampler2D tkLattice;
vec4 tkCorners( ivec2 i ) { return texelFetch( tkLattice, i & 255, 0 ); }
${NOISE_BODY}`;

export const TK_NOISE_ALU = /* glsl */ `
float tkLat( ivec2 p ) {
  p &= 255;
  uint h = ( uint( p.x ) * 0x27d4eb2du ) ^ ( uint( p.y ) * 0x165667b1u );
  h = ( h ^ ( h >> 15u ) ) * 0x85ebca6bu;
  h ^= h >> 13u;
  h *= 0xc2b2ae35u;
  h ^= h >> 16u;
  return float( h >> 24u ) * ( 1.0 / 255.0 );
}
vec4 tkCorners( ivec2 i ) {
  return vec4( tkLat( i ), tkLat( i + ivec2( 1, 0 ) ), tkLat( i + ivec2( 0, 1 ) ), tkLat( i + ivec2( 1, 1 ) ) );
}
${NOISE_BODY}`;

export const TK_HEIGHT = /* glsl */ `
uniform highp sampler2D tkHeight;
uniform float tkSize;
uniform float tkHalf;
#define TK_L0 ${f(L0)}
int tkIdx( int i ) {
  int n = int( tkSize );
  if ( i < 0 ) i = -1 - i;
  else if ( i > n - 1 ) i = 2 * n - 1 - i;
  return clamp( i, 0, n - 1 );
}
float tkTexel( int i, int j ) { return texelFetch( tkHeight, ivec2( i, j ), 0 ).r; }
// Clamped Catmull-Rom of the mirrored DEM. Returns (h, dh/dx, dh/dz).
vec3 tkCR( vec2 p ) {
  float invT = tkSize / ( 2.0 * tkHalf );
  vec2 fp = ( p + tkHalf ) * invT - 0.5;
  vec2 i1f = floor( fp );
  vec2 t = fp - i1f;
  ivec2 i1 = ivec2( i1f );
  vec2 t2 = t * t;
  vec2 t3 = t2 * t;
  vec4 wx = vec4( -0.5 * t3.x + t2.x - 0.5 * t.x, 1.5 * t3.x - 2.5 * t2.x + 1.0, -1.5 * t3.x + 2.0 * t2.x + 0.5 * t.x, 0.5 * t3.x - 0.5 * t2.x );
  vec4 wz = vec4( -0.5 * t3.y + t2.y - 0.5 * t.y, 1.5 * t3.y - 2.5 * t2.y + 1.0, -1.5 * t3.y + 2.0 * t2.y + 0.5 * t.y, 0.5 * t3.y - 0.5 * t2.y );
  vec4 dx = vec4( -1.5 * t2.x + 2.0 * t.x - 0.5, 4.5 * t2.x - 5.0 * t.x, -4.5 * t2.x + 4.0 * t.x + 0.5, 1.5 * t2.x - t.x );
  vec4 dz = vec4( -1.5 * t2.y + 2.0 * t.y - 0.5, 4.5 * t2.y - 5.0 * t.y, -4.5 * t2.y + 4.0 * t.y + 0.5, 1.5 * t2.y - t.y );
  int c0 = tkIdx( i1.x - 1 ), c1 = tkIdx( i1.x ), c2 = tkIdx( i1.x + 1 ), c3 = tkIdx( i1.x + 2 );
  int r0 = tkIdx( i1.y - 1 ), r1 = tkIdx( i1.y ), r2 = tkIdx( i1.y + 1 ), r3 = tkIdx( i1.y + 2 );
  vec4 row0 = vec4( tkTexel( c0, r0 ), tkTexel( c1, r0 ), tkTexel( c2, r0 ), tkTexel( c3, r0 ) );
  vec4 row1 = vec4( tkTexel( c0, r1 ), tkTexel( c1, r1 ), tkTexel( c2, r1 ), tkTexel( c3, r1 ) );
  vec4 row2 = vec4( tkTexel( c0, r2 ), tkTexel( c1, r2 ), tkTexel( c2, r2 ), tkTexel( c3, r2 ) );
  vec4 row3 = vec4( tkTexel( c0, r3 ), tkTexel( c1, r3 ), tkTexel( c2, r3 ), tkTexel( c3, r3 ) );
  vec4 a = vec4( dot( wx, row0 ), dot( wx, row1 ), dot( wx, row2 ), dot( wx, row3 ) );
  vec4 b = vec4( dot( dx, row0 ), dot( dx, row1 ), dot( dx, row2 ), dot( dx, row3 ) );
  float h = dot( wz, a );
  float lo = min( min( row1.y, row1.z ), min( row2.y, row2.z ) );
  float hi = max( max( row1.y, row1.z ), max( row2.y, row2.z ) );
  return vec3( clamp( h, lo, hi ), dot( wz, b ) * invT, dot( dz, a ) * invT );
}
float tkOutside( vec2 p ) {
  float over = max( abs( p.x ), abs( p.y ) ) - tkHalf;
  return over <= 0.0 ? 0.0 : smoothstep( 0.0, ${f(OUTSIDE_FALLOFF)}, over );
}
vec3 tkSmooth( vec2 p ) {
  vec3 s = tkCR( p );
  float o = tkOutside( p );
  return vec3( s.x + ( ${f(OUTSIDE_DEPTH)} - s.x ) * o, s.yz * ( 1.0 - o ) );
}
`;

// Detail displacement (surface.js detail()); needs TK_NOISE.
export const TK_DETAIL = /* glsl */ `
float tkRidge( float n ) { float v = 2.0 * n - 1.0; return 1.0 - sqrt( v * v + 0.04 ); }
float tkRidgeD( float n ) { float v = 2.0 * n - 1.0; return -2.0 * v / sqrt( v * v + 0.04 ); }
// Procedural displacement (see surface.js detail()). xy = gradient, z = displacement.
vec3 tkDetail( vec2 p, float h, vec2 g ) {
  float s = length( g );
  float rock = smoothstep( ${f(DETAIL.rockSlope0)}, ${f(DETAIL.rockSlope1)}, s );
  vec3 d = vec3( 0.0 );
  if ( rock > 0.0 ) {
    float w = 1.0 / ${f(DETAIL.rockWave)};
    vec3 n1 = tkNoiseD( p * w + vec2( 17.3, -4.1 ) );
    vec3 n2 = tkNoiseD( p * ( w * 2.03 ) + vec2( -9.7, 31.2 ) );
    float amp = rock * ${f(DETAIL.rockAmp)};
    d.z += amp * ( 0.68 * tkRidge( n1.z ) + 0.32 * tkRidge( n2.z ) - 0.55 );
    d.xy += amp * ( 0.68 * tkRidgeD( n1.z ) * n1.xy * w + 0.32 * tkRidgeD( n2.z ) * n2.xy * ( w * 2.03 ) );
  }
  float land = smoothstep( 0.6, 3.0, h ) * ( 1.0 - rock );
  if ( land > 0.0 ) {
    float w = 1.0 / ${f(DETAIL.humpWave)};
    vec3 n = tkNoiseD( p * w + vec2( 3.7, 11.9 ) );
    d.z += land * ${f(DETAIL.humpAmp)} * ( n.z * 2.0 - 1.0 );
    d.xy += land * ${f(DETAIL.humpAmp)} * 2.0 * n.xy * w;
  }
  return d;
}
`;

export const TK_COVER = /* glsl */ `
float tkForest( vec2 p, float h, float s, float sd, float spruce, float dev ) {
  if ( spruce <= 0.001 || dev >= 0.999 ) return 0.0;
  float nt = tkNoise( p / 160.0 + vec2( 41.7, -13.2 ) );
  float elev = smoothstep( 1.2, 4.0, h ) * ( 1.0 - smoothstep( ${f(COVER.treeline0)}, ${f(COVER.treeline1)}, h + 22.0 * ( nt - 0.5 ) ) );
  float steep = 1.0 - smoothstep( ${f(COVER.forestSlope0)}, ${f(COVER.forestSlope1)}, s );
  float shore = smoothstep( ${f(COVER.forestShore0)}, ${f(COVER.forestShore1)}, -sd );
  float c = spruce * elev * steep * shore * ( 1.0 - dev );
  float edge = tkNoise( p / 230.0 + vec2( -7.1, 3.3 ) );
  float d = smoothstep( 0.42, 0.62, c + ( edge - 0.5 ) * 0.55 );
  float glade = tkNoise( p / 95.0 + vec2( 19.4, 71.1 ) );
  return d * smoothstep( 0.1, 0.3, glade );
}
float tkAlder( vec2 p, float h, float s, float forest, float dev, float wet ) {
  float band = smoothstep( 4.0, 14.0, h ) * ( 1.0 - smoothstep( 88.0, 132.0, h ) );
  float slope = smoothstep( 0.1, 0.3, s ) * ( 1.0 - smoothstep( 1.15, 1.5, s ) );
  float patchN = tkNoise( p / 120.0 + vec2( 7.3, -3.9 ) ) * 0.7 + tkNoise( p / 37.0 + vec2( -2.2, 5.1 ) ) * 0.3;
  float thicket = smoothstep( ${f(ALDER_T0)}, ${f(ALDER_T1)}, patchN * 0.62 + smoothstep( 0.06, 0.34, wet ) * 0.62 );
  return band * slope * thicket * ( 1.0 - forest ) * ( 1.0 - dev );
}
float tkSnow( vec2 p, float h, vec2 g, float s, float pen, float curv ) {
  float line0 = ${f(COVER.snowLineKodiak)} + ( ${f(COVER.snowLinePeninsula)} - ${f(COVER.snowLineKodiak)} ) * pen;
  float north = g.y / ( s + 0.05 );
  float line = line0 - 30.0 * north * smoothstep( 0.1, 0.45, s ) + 26.0 * ( tkNoise( p / 70.0 + vec2( 3.1, -8.4 ) ) - 0.5 );
  line -= 7.0 * clamp( curv, 0.0, 4.0 );
  return smoothstep( line - 7.0, line + 7.0, h ) * ( 1.0 - smoothstep( 1.2 - 0.35 * pen, 1.7 - 0.3 * pen, s + 0.25 * pen * max( 0.0, -curv ) ) );
}
// Rock score (see landcover.js rockScore): solid rock from COVER.rock0, ledges through turf from COVER.ledge0.
float tkRockScore( vec2 p, float h, float s, float sd, float curv ) {
  float crest = clamp( -curv, 0.0, 4.0 ) * 0.09 * smoothstep( 0.45, 0.9, s );
  float alt = 1.0 + 0.28 * smoothstep( 80.0, 220.0, h );
  float sea = 0.3 * ( 1.0 - smoothstep( 4.0, 40.0, -sd ) ) * smoothstep( 0.5, 3.0, h ) * smoothstep( 0.35, 0.8, s );
  float n = ( tkNoise( p / 41.0 + vec2( 5.5, -2.7 ) ) - 0.5 ) * 0.22 + ( tkNoise( p / 13.0 + vec2( -3.1, 8.2 ) ) - 0.5 ) * 0.12;
  return s * alt + crest + sea + n;
}
float tkScree( vec2 p, float h, float s, float rock, float wet ) {
  float n = tkNoise( p / 57.0 + vec2( 1.9, -6.6 ) );
  float high = smoothstep( 125.0, 175.0, h + 50.0 * ( n - 0.5 ) );
  float steep = smoothstep( 0.95, 1.3, s );
  float chute = smoothstep( 0.25, 0.5, wet ) * smoothstep( 1.0, 1.35, s ) * smoothstep( 85.0, 135.0, h );
  float patchy = smoothstep( 0.38, 0.6, tkNoise( p / 23.0 + vec2( -4.4, 2.8 ) ) * 0.6 + n * 0.4 );
  return min( 1.0, high * steep * patchy + chute * 0.6 ) * ( 1.0 - rock );
}
`;
