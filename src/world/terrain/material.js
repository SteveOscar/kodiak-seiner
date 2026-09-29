// Terrain material: MeshStandardMaterial patched for CDLOD displacement (vertex) and slope/height/aspect/shore/
// drainage splatting with triplanar rock, detail normals and macro variation (fragment).
//
// Lighting is a lean replacement of three's physical chunks (which evaluate a DFG lookup, multiple-scattering terms
// and full GGX for every light): Lambert sun lit by uSunColor x uTerrainShadow x the sky's shadow map, a normalized
// Blinn-Phong highlight only where the ground is wet, glassy or snowy, Lambert-only spot/point lights, ambient +
// hemisphere + IBL irradiance sampled per vertex, and IBL reflections only on wet ground and lakes. Seabed fragments
// get kodiak_underwater through patchUnderwater(), whose world-position varying the fragment code reuses.

import * as THREE from 'three';
import { patchUnderwater } from '../../render/shaderChunks.js';
import { TK_NOISE, TK_NOISE_ALU, TK_HEIGHT, TK_DETAIL } from './glsl.js';
import { COVER } from './landcover.js';

const f = (v) => (Number.isInteger(v) ? `${v}.0` : `${v}`);
const col = (hex) => {
  const c = new THREE.Color(hex);
  return `vec3( ${c.r.toFixed(5)}, ${c.g.toFixed(5)}, ${c.b.toFixed(5)} )`;
};

// Palette (sRGB hex -> linear). SPEC §9: grass #4f8a3a -> #7fb35a in sun, alder #3c6b2e, spruce #1f3a26, rock #5b5751,
// snow #eef2f6.
export const PALETTE = {
  grassLush: '#3c743b',
  grassBright: '#528745',
  grassDeep: '#2b6233',
  grassDry: '#7b8f4d',
  rye: '#9aa95f',
  tundra: '#6e7c47',
  tundraBrown: '#7b7155',
  alder: '#1f461d',
  alderLight: '#336128',
  spruce: '#1b3822',
  forestFloor: '#2a3a20',
  rock: '#5f5b55',
  rockDark: '#3a3834',
  rockWarm: '#7a6e5f',
  lichen: '#8e9270',
  lichenOrange: '#a8783a',
  scree: '#827c71',
  snow: '#eef2f6',
  gravel: '#77756f',
  gravelWarm: '#857d70',
  sand: '#a79a7c',
  wrack: '#4a4230',
  seabedSand: '#a9996f',
  seabedGravel: '#7b7263',
  seabedRock: '#4d4a40',
  kelpBed: '#3d3a1e',
  mud: '#5b5443',
  lake: '#16303a',
  fern: '#2c5a2c',
  seedhead: '#768f4a',
  fireweed: '#c43a86',
  lupine: '#6a5bd0',
  developed: '#86866a',
  ash: '#8a8174',
};

const VERT_PARS = /* glsl */ `
${TK_NOISE}
${TK_HEIGHT}
${TK_DETAIL}
attribute vec4 tkNode;
uniform vec4 tkLod[ 9 ];
uniform vec3 uCameraPos;
varying vec3 vTkEnvIrr;
#ifdef TK_DBG_LEVELS
varying vec2 vTkLevel;
#endif
#if defined( USE_ENVMAP ) && defined( TK_ENV_VS )
  // Diffuse IBL varies slowly with the normal, so it is sampled per vertex from the sky's PMREM (CubeUV) map.
  #define ENVMAP_TYPE_CUBE_UV
  uniform sampler2D envMap;
  uniform float envMapIntensity;
  uniform mat3 envMapRotation;
  #include <cube_uv_reflection_fragment>
#endif
// Height for the morph distance: one fetch from the 4x-downsampled DEM mip. Any deterministic function of (x, z)
// keeps shared edge vertices identical between neighbouring quadrants; the error is metres against morph bands of
// hundreds of metres.
float tkApproxH( vec2 p ) {
  float n = tkSize * 0.25;
  ivec2 i = ivec2( clamp( ( p + tkHalf ) * ( n / ( 2.0 * tkHalf ) ), vec2( 0.0 ), vec2( n - 1.0 ) ) );
  return texelFetch( tkHeight, i, 2 ).r;
}
`;

const VERT_MAIN = /* glsl */ `
  // CDLOD: grid index (position.xz), skirt flag (position.y), node = (x0, z0, size, level).
  int tkL = int( tkNode.w + 0.5 );
  vec4 tkP = tkLod[ tkL ];
  float tkS = tkP.z;
  vec2 tkXZ = tkNode.xy + position.xz * tkS;
  float tkD = distance( vec3( tkXZ.x, tkApproxH( tkXZ ), tkXZ.y ), uCameraPos );
  float tkK = clamp( ( tkD - tkP.x ) * tkP.y, 0.0, 1.0 );
  tkXZ -= mod( position.xz, 2.0 ) * tkS * tkK;
#ifdef TK_PROF_CHEAPVS
  vec3 tkSm = vec3( tkApproxH( tkXZ ), 0.0, 0.0 );
#else
  vec3 tkSm = tkSmooth( tkXZ );
#endif
  // Detail displacement lives on levels 0-1 and fades out across level 1's morph band (quadtree.js DETAIL_LEVEL).
  float tkDw = tkL < 1 ? 1.0 : ( tkL == 1 ? 1.0 - tkK : 0.0 );
#if defined( TK_DEBUG_NODETAIL ) || defined( TK_CHEAP )
  vec3 tkDt = vec3( 0.0 );
#else
  vec3 tkDt = tkDw > 0.0 ? tkDetail( tkXZ, tkSm.x, tkSm.yz ) * tkDw : vec3( 0.0 );
#endif
  float tkY = tkSm.x + tkDt.z - position.y * tkP.w;
  vec3 objectNormal = normalize( vec3( -tkSm.y - tkDt.x, 1.0, -tkSm.z - tkDt.y ) );
  vec3 tkWorldPos = vec3( tkXZ.x, tkY, tkXZ.y );
#ifdef TK_DBG_LEVELS
  vTkLevel = vec2( float( tkL ), tkK );
#endif
#if defined( USE_ENVMAP ) && defined( TK_ENV_VS ) && !defined( TK_PROF_NOENV )
  vTkEnvIrr = PI * textureCubeUV( envMap, envMapRotation * objectNormal, 1.0 ).rgb * envMapIntensity;
#else
  vTkEnvIrr = vec3( 0.0 );
#endif
`;

const FRAG_PARS = /* glsl */ `
#ifdef TK_FRAG_ALU
${TK_NOISE_ALU}
#else
${TK_NOISE}
#endif
${TK_DETAIL}
uniform float tkHalf;
uniform sampler2D tkInfo;
uniform sampler2D tkCoverA;
uniform sampler2D tkCoverB;
uniform sampler2D tkCoverC;
uniform sampler2D tkRockTex;
uniform sampler2D tkCliffTex;
uniform sampler2D tkGroundTex;
uniform sampler2D tkGravelTex;
uniform sampler2D uHeightMap;
uniform sampler2D uTerrainShadow;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float tkSunScale;
uniform float uTime;
uniform float uRain;
uniform vec2 uWindDir;
varying vec3 vTkEnvIrr;
#ifdef TK_DBG_LEVELS
varying vec2 vTkLevel;
#endif

// Triplanar sample of a detail texture: .xyz = world-space normal perturbation, .w = albedo variation; hgt = height.
// Projections with negligible weight (the pow-4 blend leaves one or two on most facets) are skipped.
vec4 tkTri( sampler2D t, vec3 p, vec3 w, float scale, out float hgt ) {
  vec4 n = vec4( 0.0 );
  hgt = 0.0;
  if ( w.x > 0.03 ) {
    vec4 a = texture( t, p.zy / scale );
    vec2 na = a.rg * 2.0 - 1.0;
    n += vec4( 0.0, na.y, na.x, a.b ) * w.x;
    hgt += a.a * w.x;
  }
  if ( w.y > 0.03 ) {
    vec4 b = texture( t, p.xz / scale );
    vec2 nb = b.rg * 2.0 - 1.0;
    n += vec4( nb.x, 0.0, nb.y, b.b ) * w.y;
    hgt += b.a * w.y;
  }
  if ( w.z > 0.03 ) {
    vec4 c = texture( t, p.xy / scale );
    vec2 nc = c.rg * 2.0 - 1.0;
    n += vec4( nc.x, nc.y, 0.0, c.b ) * w.z;
    hgt += c.a * w.z;
  }
  float ws = ( w.x > 0.03 ? w.x : 0.0 ) + ( w.y > 0.03 ? w.y : 0.0 ) + ( w.z > 0.03 ? w.z : 0.0 );
  hgt /= ws;
  return n / ws;
}
`;

const LIGHT_PARS = /* glsl */ `
void tkDirect( const in IncidentLight L, const in vec3 n, const in vec3 v, const in vec3 diff, const in float shin, const in float specW, inout ReflectedLight rl ) {
  float ndl = saturate( dot( n, L.direction ) );
  vec3 irr = ndl * L.color;
  rl.directDiffuse += irr * diff * RECIPROCAL_PI;
  if ( specW > 0.001 ) {
    vec3 h = normalize( L.direction + v );
    float vh = 1.0 - saturate( dot( h, v ) );
    float fr = 0.04 + 0.96 * vh * vh * vh * vh * vh;
    rl.directSpecular += irr * ( specW * fr * ( shin + 8.0 ) * ( 0.125 * RECIPROCAL_PI ) * pow( saturate( dot( n, h ) ), shin ) );
  }
}
`;

// Replaces lights_physical_fragment .. lights_fragment_end. View-space position/direction come from the world
// position (no vViewPosition varying).
const LIGHTS_MAIN = /* glsl */ `
  vec3 geometryPosition = ( viewMatrix * vec4( tkPw, 1.0 ) ).xyz;
  vec3 geometryNormal = normal;
  vec3 geometryViewDir = normalize( - geometryPosition );
  vec3 tkDiffuse = diffuseColor.rgb;
  float tkShin = exp2( 2.0 + 9.0 * ( 1.0 - tkRough ) );
  IncidentLight directLight;
#if ( NUM_DIR_LIGHTS > 0 )
  DirectionalLight directionalLight;
  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
  DirectionalLightShadow directionalLightShadow;
  #endif
  #pragma unroll_loop_start
  for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
    directionalLight = directionalLights[ i ];
    getDirectionalLightInfo( directionalLight, directLight );
    if ( dot( directLight.direction, tkSunView ) > 0.9995 ) directLight.color = uSunColor * tkSunScale * tkSh * ( 1.0 + tkCaustic );
    #if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
    directionalLightShadow = directionalLightShadows[ i ];
    #ifndef TK_PROF_NOSHADOW
    directLight.color *= receiveShadow ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
    #endif
    #endif
    tkDirect( directLight, geometryNormal, geometryViewDir, tkDiffuse, tkShin, tkSpec, reflectedLight );
    // Sun through grass blades and leaves: slopes seen against a low sun glow.
    reflectedLight.directDiffuse += directLight.color * tkDiffuse * ( tkTransW * pow( saturate( dot( -geometryViewDir, directLight.direction ) ), 5.0 ) );
  }
  #pragma unroll_loop_end
#endif
#if ( NUM_SPOT_LIGHTS > 0 )
  SpotLight spotLight;
  #pragma unroll_loop_start
  for ( int i = 0; i < NUM_SPOT_LIGHTS; i ++ ) {
    spotLight = spotLights[ i ];
    getSpotLightInfo( spotLight, geometryPosition, directLight );
    reflectedLight.directDiffuse += saturate( dot( geometryNormal, directLight.direction ) ) * directLight.color * tkDiffuse * RECIPROCAL_PI;
  }
  #pragma unroll_loop_end
#endif
#if ( NUM_POINT_LIGHTS > 0 )
  PointLight pointLight;
  #pragma unroll_loop_start
  for ( int i = 0; i < NUM_POINT_LIGHTS; i ++ ) {
    pointLight = pointLights[ i ];
    getPointLightInfo( pointLight, geometryPosition, directLight );
    reflectedLight.directDiffuse += saturate( dot( geometryNormal, directLight.direction ) ) * directLight.color * tkDiffuse * RECIPROCAL_PI;
  }
  #pragma unroll_loop_end
#endif
  vec3 irradiance = getAmbientLightIrradiance( ambientLightColor ) + vTkEnvIrr;
#if ( NUM_HEMI_LIGHTS > 0 )
  #pragma unroll_loop_start
  for ( int i = 0; i < NUM_HEMI_LIGHTS; i ++ ) {
    irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );
  }
  #pragma unroll_loop_end
#endif
  reflectedLight.indirectDiffuse += irradiance * tkDiffuse * ( 0.96 * RECIPROCAL_PI );
#if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
  if ( tkSpec > 0.02 ) {
    float tkNv = 1.0 - saturate( dot( geometryNormal, geometryViewDir ) );
    float tkFr = 0.04 + 0.96 * tkNv * tkNv * tkNv * tkNv * tkNv * ( 1.0 - tkRough );
    reflectedLight.indirectSpecular += getIBLRadiance( geometryViewDir, geometryNormal, tkRough ) * ( tkFr * tkSpec );
  }
#endif
`;

// Computes tkAlbedo, tkRough, tkSpec, tkN (world normal), tkSh (terrain sun visibility), tkAO, tkUnder, tkLakeW,
// tkCaustic, tkSunView. Static cover weights come from the baked cover textures; per-pixel work is limited to what
// depends on the exact height, detail textures near the camera, and lighting.
// Seabed under more than ~4.6 optical depths of water in every channel is invisible once kodiak_underwater has
// attenuated it: such fragments write the water-column colour directly and skip the surface and lighting work.
const DEEP_SEABED_EXIT = /* glsl */ `
  if ( vKWorldPos.y < -1.5 ) {
    float kDepth = -vKWorldPos.y;
    float kLen = length( cameraPosition - vKWorldPos );
    float kPath = cameraPosition.y > 0.0 ? kDepth * kLen / max( cameraPosition.y - vKWorldPos.y, 1e-3 ) : kLen;
    if ( kPath * min( uWaterAbsorb.x, min( uWaterAbsorb.y, uWaterAbsorb.z ) ) > 4.6 ) {
      gl_FragColor = vec4( uWaterScatter, 1.0 );
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      #include <fog_fragment>
      return;
    }
  }
`;

const FRAG_SURFACE = /* glsl */ `
${DEEP_SEABED_EXIT}
  vec3 tkPw = vKWorldPos;
  float tkDist = length( cameraPosition - tkPw );
  vec2 tkUV = ( tkPw.xz + tkHalf ) / ( 2.0 * tkHalf );
  vec2 tkUVc = clamp( tkUV, 0.0, 1.0 );
  float tkFw = max( length( fwidth( tkPw.xz ) ), 1e-4 ); // metres per pixel
  float tkH = tkPw.y;

  vec4 tkI = texture( tkInfo, tkUV );
  float tkOut = max( abs( tkPw.x ), abs( tkPw.z ) ) - tkHalf;
  float tkOutF = tkOut > 0.0 ? smoothstep( 0.0, 3200.0, tkOut ) : 0.0;
  vec2 tkMir = vec2( tkUV.x < 0.0 || tkUV.x > 1.0 ? -1.0 : 1.0, tkUV.y < 0.0 || tkUV.y > 1.0 ? -1.0 : 1.0 );
  vec2 tkG = tkI.xy * tkMir * ( 1.0 - tkOutF );
  float tkS = length( tkG );
  float tkCurv = tkI.z;
  float tkAO = mix( tkI.w, 1.0, tkOutF );
  float tkSd = tkH < 6.0 ? textureLod( uHeightMap, tkUVc, 0.0 ).g : -500.0;
  float tkSh = texture( uTerrainShadow, tkUVc ).r;
  float tkNearTex = 1.0 - smoothstep( 0.5, 3.0, tkFw );

  vec3 tkAlbedo;
  float tkRough;
  vec3 tkPert = vec3( 0.0 );
  float tkUnder = 0.0;
  float tkLakeW = 0.0;
  float tkCaustic = 0.0;
  float tkSpec = 0.0;
  float tkTransW = 0.0;
  vec2 tkGd = tkG;

  if ( tkH < -0.6 ) {
    // ---- seabed: seen only through the water column (kodiak_underwater), so a cheap path.
    tkUnder = 1.0;
    float m2 = texture( tkCoverC, tkUV ).g;
    float rocky = smoothstep( 0.25, 0.55, tkS );
    vec4 gv = texture( tkGravelTex, tkPw.xz / 5.3 );
    vec3 bed = mix( ${col(PALETTE.seabedGravel)} * ( 0.7 + 0.6 * gv.b ), ${col(PALETTE.seabedSand)}, smoothstep( 20.0, 90.0, tkSd + ( m2 - 0.5 ) * 60.0 ) );
    bed = mix( bed, ${col(PALETTE.seabedRock)} * ( 0.75 + 0.5 * gv.b ), rocky );
    if ( tkH > -18.0 ) {
      float kelpy = rocky * smoothstep( 0.45, 0.7, tkNoise( tkPw.xz / 19.0 + vec2( 6.6, -1.1 ) ) ) * smoothstep( -16.0, -3.0, tkH );
      bed = mix( bed, ${col(PALETTE.kelpBed)}, kelpy * 0.8 );
      // Caustics: a fine, soft network (~1 m cells) that fades with depth, with distance, at grazing view angles
      // (where the foreshortened pattern reads as long worms) and once a pixel spans more than a few centimetres.
      float tkViewUp = abs( cameraPosition.y - tkPw.y ) / max( tkDist, 1e-3 );
      float cd = ( 1.0 - smoothstep( 1.0, 9.0, -tkH ) ) * ( 1.0 - smoothstep( 25.0, 110.0, tkDist ) )
        * smoothstep( 0.2, 0.55, tkViewUp ) * ( 1.0 - smoothstep( 0.06, 0.25, tkFw ) );
      if ( cd > 0.001 ) {
        vec2 cp = tkPw.xz / 0.95;
        float c1 = tkNoise( cp + vec2( uTime * 0.21, uTime * 0.1 ) );
        float c2 = tkNoise( cp * 1.41 + vec2( -uTime * 0.17, uTime * 0.19 ) + 5.0 );
        float c3 = tkNoise( cp * 2.3 + vec2( uTime * 0.12, -uTime * 0.23 ) + 11.0 );
        float net = clamp( 1.0 - abs( c1 - c2 ) * 3.2, 0.0, 1.0 ) * ( 0.65 + 0.35 * c3 );
        tkCaustic = net * net * cd * 0.7;
      }
    }
    tkAlbedo = mix( bed, ${col(PALETTE.mud)}, smoothstep( 150.0, 400.0, tkSd ) * 0.6 );
    tkRough = 0.75;
    tkPert = vec3( gv.r * 2.0 - 1.0, 0.0, gv.g * 2.0 - 1.0 ) * 0.35 * tkNearTex;
  } else {
    // ---- land, beaches and the waterline. Layers are mixed in sequence so few values stay live at once (the
    // shader is register-bound on Apple GPUs).
    vec4 cA = texture( tkCoverA, tkUV ); // forest, alder, rock score, snow
    vec4 cB = texture( tkCoverB, tkUV ); // lake, wildflowers, developed, peninsula
    vec4 cC = texture( tkCoverC, tkUV ); // wetness, m2 (131 m), m3 (29 m), scree
    float tkPen = cB.a;
    float tkDev = cB.b;
    float m1 = tkNoise( tkPw.xz / 470.0 + vec2( 3.1, 9.7 ) );
    float m2 = cC.g;
    float m3 = cC.b;
    float wet = cC.r;

    // Detail displacement gradient (matches the vertex shader) near the camera.
    float tkNear = 1.0 - smoothstep( 500.0, 1400.0, tkDist );
#ifndef TK_DEBUG_NODETAIL
    if ( tkNear > 0.0 ) tkGd += tkDetail( tkPw.xz, tkH, tkG ).xy * tkNear;
#endif

    // Mid-scale relief the 7.8 m DEM cannot carry (normal only; heightAt is unaffected): soil-creep hummocks and
    // V-shaped rills running down the fall line, which is where Kodiak's alder grows in fingers. Each octave fades out
    // before its wavelength drops below a few pixels, so distant slopes stay stable.
    float tkRill = 1.0; // 0 in a rill trough
    float tkMos = 0.5; // vegetation mosaic, 0.5 = neutral
    float tkLandW = smoothstep( 0.6, 2.5, tkH );
#ifndef TK_PROF_NORELIEF
    if ( tkFw < 2.4 && tkLandW > 0.0 ) {
      float o1 = 1.0 - smoothstep( 1.0, 2.4, tkFw );
      float o2 = 1.0 - smoothstep( 0.6, 1.8, tkFw );
      vec3 n1 = tkNoiseD( tkPw.xz / 23.0 + vec2( 4.7, -2.1 ) );
      vec2 rel = n1.xy * ( 0.6 / 23.0 ) * o1;
      if ( o2 > 0.0 ) {
        vec3 n2 = tkNoiseD( tkPw.xz / 8.5 + vec2( -1.3, 9.2 ) );
        rel += n2.xy * ( 0.32 / 8.5 ) * o2;
        tkMos = mix( 0.5, n2.z * 0.6 + n1.z * 0.4, o2 );
      }
      float slopeW = smoothstep( 0.2, 0.55, tkS ) * ( 1.0 - smoothstep( 1.5, 2.2, tkS ) ) * ( 1.0 - smoothstep( 0.9, 2.3, tkFw ) );
      if ( slopeW > 0.0 ) {
        // The stretched noise is evaluated in the two fixed orientations (of four, 45° apart) nearest the fall line and
        // blended: rotating the lookup by the local gradient itself would swirl, since world positions are large.
        float ang = atan( tkG.y, tkG.x ) * ${f(4 / Math.PI)};
        ang = ang < 0.0 ? ang + 4.0 : ang;
        float k0 = floor( ang );
        float bw = smoothstep( 0.0, 1.0, ang - k0 );
        vec2 rg = vec2( 0.0 );
        float rc = 0.0;
        for ( int i = 0; i < 2; i ++ ) {
          float a = ( k0 + float( i ) ) * ${f(Math.PI / 4)};
          vec2 gd = vec2( cos( a ), sin( a ) );
          vec2 tt = vec2( -gd.y, gd.x );
          vec3 nr = tkNoiseD( vec2( dot( tkPw.xz, tt ) / 15.0, dot( tkPw.xz, gd ) / 90.0 ) + vec2( 11.3 + float( i ) * 5.1, 2.9 ) );
          float c = 2.0 * nr.z - 1.0;
          // Rounded V: the crease is softened over |c| < ~0.12 so it does not alias.
          float cr = c / sqrt( c * c + 0.015 );
          float wi = i == 0 ? 1.0 - bw : bw;
          rg += wi * cr * 2.0 * ( nr.x * tt / 15.0 + nr.y * gd / 90.0 );
          rc += wi * smoothstep( 0.0, 0.45, abs( c ) );
        }
        rel += rg * 0.6 * slopeW;
        tkRill = mix( 1.0, rc, slopeW );
      }
      tkGd += rel * tkLandW;
    }
#endif

    // Ground detail texture (two scales; the fine one only near; neither once it has averaged out by distance).
    float grAlb = 0.5;
    vec2 grN = vec2( 0.0 );
    vec4 gr;
    if ( tkFw < 2.4 ) {
      gr = texture( tkGroundTex, tkPw.xz / 13.7 + 0.31 );
      float gf = 1.0 - smoothstep( 1.4, 2.4, tkFw );
      grAlb = mix( 0.5, gr.b, gf );
      grN = ( gr.rg * 2.0 - 1.0 ) * 0.4 * gf;
    }
    if ( tkNearTex > 0.0 ) {
      gr = texture( tkGroundTex, tkPw.xz / 3.3 );
      grAlb = mix( grAlb, gr.b * 0.6 + grAlb * 0.4, tkNearTex );
      grN += ( gr.rg * 2.0 - 1.0 ) * tkNearTex * 0.8;
    }

    // 1. grass: emerald lowland meadows, lusher and deeper along drainages, drier olive on crests and sunny south
    // faces, yellow beach rye by the shore, olive-brown alpine tundra up high.
    float alpine = smoothstep( 92.0, 150.0, tkH + ( m2 - 0.5 ) * 50.0 );
    float wetW = smoothstep( 0.1, 0.45, wet );
    vec3 land = mix( ${col(PALETTE.grassLush)}, ${col(PALETTE.grassBright)}, smoothstep( 0.25, 0.75, m2 * 0.45 + m3 * 0.55 ) );
    // Patchwork of meadow plants (grass, ferns, cow parsnip): value and hue mottling at 10-30 m.
    land *= 0.84 + 0.32 * m3;
    land = mix( land, land * vec3( 1.12, 1.02, 0.78 ), smoothstep( 0.55, 0.85, m3 ) * ( 1.0 - wetW ) * 0.6 );
    land = mix( land, ${col(PALETTE.grassDeep)}, wetW * 0.75 );
    float south = -tkG.y / ( tkS + 0.05 );
    float dry = clamp( smoothstep( 0.0, 1.6, -tkCurv ) * 0.45 + south * smoothstep( 0.2, 0.7, tkS ) * 0.3 + ( m1 - 0.55 ) * 0.9, 0.0, 0.6 ) * ( 1.0 - wetW );
    land = mix( land, ${col(PALETTE.grassDry)}, dry );
    land = mix( land, ${col(PALETTE.rye)}, ( 1.0 - smoothstep( 2.0, 6.0, tkH ) ) * smoothstep( -80.0, -20.0, tkSd ) * 0.6 );
    land = mix( land, mix( ${col(PALETTE.tundra)}, ${col(PALETTE.tundraBrown)}, smoothstep( 0.35, 0.8, m3 ) * 0.6 + tkPen * 0.35 ), alpine );
    // Mosaic of meadow communities a few metres across: dark fern and cow-parsnip beds, pale seed-head swards; rill
    // troughs run lush and dark.
    land = mix( land, ${col(PALETTE.fern)}, smoothstep( 0.56, 0.74, tkMos ) * 0.6 * ( 1.0 - alpine * 0.6 ) );
    land = mix( land, ${col(PALETTE.seedhead)}, smoothstep( 0.42, 0.24, tkMos ) * 0.4 * ( 1.0 - wetW ) );
    land = mix( land, ${col(PALETTE.grassDeep)} * 0.85, ( 1.0 - tkRill ) * 0.55 * ( 1.0 - alpine * 0.5 ) );
    land *= 0.8 + 0.4 * grAlb;
    // Wildflower meadows as distant tints (instanced flowers take over up close); developed ground is trodden.
    float flowerFar = smoothstep( 25.0, 90.0, tkDist );
    land = mix( land, ${col(PALETTE.fireweed)}, max( 0.0, 2.0 * cB.g - 1.0 ) * ( 0.05 + 0.1 * flowerFar ) );
    land = mix( land, ${col(PALETTE.lupine)}, max( 0.0, 1.0 - 2.0 * cB.g ) * ( 0.04 + 0.08 * flowerFar ) );
    land = mix( land, ${col(PALETTE.developed)} * ( 0.8 + 0.4 * grAlb ), tkDev * 0.35 * smoothstep( 0.25, 0.6, m3 + grAlb * 0.3 ) );
    tkLakeW = smoothstep( 0.35, 0.65, cB.r ) * ( 1.0 - tkOutF );
    tkRough = 0.93;
    tkPert = vec3( grN.x, 0.0, grN.y ) * 0.55;
    tkTransW = 0.4 * tkLandW * ( 1.0 - alpine * 0.6 );

    // 2. alder and salmonberry thickets: dark, clumpy crowns that read as bands along the gullies and as fingers down
    // the rills of mid slopes.
    float tkAlderW = max( cA.g, ( 1.0 - tkRill ) * ${f(COVER.rillAlder)} * smoothstep( 5.0, 16.0, tkH ) * ( 1.0 - smoothstep( 88.0, 125.0, tkH ) ) * ( 1.0 - cA.r ) * ( 1.0 - tkDev ) );
    if ( tkAlderW > 0.01 ) {
      // Per-pixel crowns only while each noise cell spans many pixels: further out value-noise cells read as squares.
      // Two octaves on rotated lattices so the value-noise cells never line up into squares.
      float clump = m3;
      if ( tkFw < 0.6 ) {
        vec2 q1 = mat2( 0.8, -0.6, 0.6, 0.8 ) * tkPw.xz / 3.4;
        vec2 q2 = mat2( 0.38, 0.92, -0.92, 0.38 ) * tkPw.xz / 1.9;
        clump = mix( tkNoise( q1 + vec2( 5.1, 1.7 ) ) * 0.65 + tkNoise( q2 - vec2( 2.3, 8.1 ) ) * 0.35, m3, smoothstep( 0.15, 0.6, tkFw ) );
      }
      vec3 alderC = mix( ${col(PALETTE.alder)}, ${col(PALETTE.alderLight)}, smoothstep( 0.15, 0.85, clump ) ) * ( 0.75 + 0.5 * grAlb );
      // A soft ramp: sharpening the bilinear 7.8 m bake would print its texel grid on the canopy.
      float aw = smoothstep( 0.0, 0.7, tkAlderW ) * ( 0.85 + 0.3 * grAlb );
      land = mix( land, alderC, aw );
      tkPert = mix( tkPert, vec3( grN.x, 0.0, grN.y ) * 1.3, aw );
      tkRough = mix( tkRough, 0.88, aw );
    }

    // 3. spruce: canopy crowns read at distance, dark forest floor near (where the trees themselves stand).
    if ( cA.r > 0.0 ) {
      float crown = tkFw < 0.9 ? mix( tkNoise( mat2( 0.8, 0.6, -0.6, 0.8 ) * tkPw.xz / 5.5 + vec2( 2.3, 8.8 ) ), m3, smoothstep( 0.25, 0.9, tkFw ) ) : m3;
      vec3 spruceC = mix( ${col(PALETTE.spruce)} * ( 0.8 + 0.45 * crown ), ${col(PALETTE.forestFloor)} * ( 0.8 + 0.4 * grAlb ), 1.0 - smoothstep( 120.0, 420.0, tkDist ) );
      float fw = cA.r * ( 1.0 - tkOutF * 0.5 );
      land = mix( land, spruceC, fw );
      tkTransW *= 1.0 - fw * 0.6;
      tkPert *= 1.0 - fw * 0.6;
    }

    // 4-5. rock and scree. Solid rock on cliffs and crags, ledges along the contour where the ground is merely steep,
    // loose scree below; both take their structure from the cliff macro texture (flutes, bedding) so crags read at
    // any distance.
    float screeW = cC.a;
    float score = 0.9 + cA.b;
    float outcrop = 0.0;
    float ledgeFade = 1.0 - smoothstep( 160.0, 320.0, tkDist );
    if ( score > ${f(COVER.ledge0)} && ledgeFade > 0.0 ) {
      // Outcrops are lenses stretched along the contour (bedding ledges) near the camera only: further out they read as
      // stains, and the baked score already carries the rockiness.
      vec2 along = normalize( vec2( -tkG.y, tkG.x ) + 1e-4 );
      vec2 lc = vec2( dot( tkPw.xz, along ) / 26.0, tkH / 4.5 );
      float n = tkNoise( lc + vec2( 3.3, 1.1 ) ) * 0.7 + tkNoise( lc * 2.7 + 7.7 ) * 0.3;
      outcrop = smoothstep( 0.66, 0.8, n ) * smoothstep( ${f(COVER.ledge0)}, ${f(COVER.rock0)}, score ) * ledgeFade * 0.8;
    }
    // Rock follows the ribs and crests (convex), turf and scree fill the gullies (concave, wet), so crags break into
    // dendritic bands instead of round stains.
    float ribs = clamp( -tkCurv, -2.5, 2.5 ) * 0.07 - smoothstep( 0.12, 0.45, wet ) * 0.3;
    float solid = smoothstep( ${f(COVER.rock0 - 0.12)}, ${f(COVER.rock1)}, score + ribs + ( m3 - 0.5 ) * 0.28 + ( grAlb - 0.5 ) * 0.12 );
    // Where the ground is only just steep enough, rock shows on the ribs between the fall-line rills and turf fills
    // the rill troughs, so outcrops fray into streaks instead of ending in a hard outline.
    solid *= mix( smoothstep( 0.25, 0.85, tkRill ), 1.0, smoothstep( ${f(COVER.rock1 - 0.1)}, ${f(COVER.rock1 + 0.25)}, score + ribs ) );
    // Away from the steepest cores, crags break into bedding ledges along the contour with turf between (phase from
    // the baked macro noise, so the bands wander and end instead of ringing the hill).
    if ( solid > 0.0 ) {
      float strata = smoothstep( 0.32, 0.6, tkNoise( vec2( tkH / 6.5 + m2 * 4.0, m3 * 3.0 + m1 * 5.0 ) ) );
      solid *= mix( 0.5 + 0.5 * strata, 1.0, smoothstep( ${f(COVER.rock1)}, ${f(COVER.rock1 + 0.4)}, score + ribs ) );
    }
    float tkRockW = max( solid, outcrop );
    vec4 gv = vec4( 0.5 );
    if ( screeW > 0.01 || tkH < 3.0 ) {
      gv = tkNearTex > 0.0 ? mix( texture( tkGravelTex, tkPw.xz / 4.6 + 0.17 ), texture( tkGravelTex, tkPw.xz / 1.35 ), tkNearTex ) : texture( tkGravelTex, tkPw.xz / 4.6 + 0.17 );
    }
#ifdef TK_PROF_NOROCK
    tkRockW = 0.0; screeW = 0.0;
#endif
    if ( tkRockW > 0.01 || screeW > 0.01 ) {
      vec3 w = pow( abs( normalize( vec3( -tkGd.x, 1.0, -tkGd.y ) ) ), vec3( 4.0 ) );
      w /= ( w.x + w.y + w.z );
      float hgt;
      vec4 r = tkTri( tkCliffTex, tkPw + 11.0, w, 61.0, hgt );
      vec3 rockN = r.xyz * 1.25;
      float rockAlb = r.w;
      // Mid-scale crags (19 m): the faces, ribs and gullies that catch a low sun from a kilometre or so away.
      float midW = ( 1.0 - smoothstep( 1.2, 2.6, tkFw ) ) * step( 0.01, tkRockW );
      if ( midW > 0.0 ) {
        float hm;
        vec4 rm = tkTri( tkCliffTex, tkPw * 1.7 + 5.3, w, 61.0, hm );
        rockN += rm.xyz * 1.3 * midW;
        rockAlb = mix( rockAlb, rockAlb * 0.5 + rm.w * 0.5, midW );
        hgt = mix( hgt, hgt * 0.5 + hm * 0.5, midW );
      }
      if ( tkNearTex > 0.0 && tkRockW > 0.01 ) {
        float h1;
        vec4 r2 = tkTri( tkRockTex, tkPw, w, 9.5, h1 );
        rockN += r2.xyz * 1.4 * tkNearTex;
        rockAlb = mix( rockAlb, r2.w * 0.5 + rockAlb * 0.5, tkNearTex );
        hgt = mix( hgt, h1 * 0.45 + hgt * 0.55, tkNearTex );
      }
      // Scree: grey talus streaked down the fall line, green creeping in where it thins out.
      if ( screeW > 0.01 ) {
        float sw = smoothstep( 0.2, 0.65, screeW + ( hgt - 0.5 ) * 0.6 * screeW + ( gv.a - 0.5 ) * 0.3 * screeW );
        vec3 screeC = mix( ${col(PALETTE.scree)}, ${col(PALETTE.ash)}, tkPen * 0.6 ) * ( 0.55 + 0.45 * rockAlb + 0.3 * gv.b );
        // Turf and moss creep over the thinner talus.
        screeC = mix( screeC, land * 0.9, ( 1.0 - smoothstep( 0.35, 0.9, screeW ) ) * 0.5 * ( 1.0 - tkPen ) );
        land = mix( land, screeC, sw );
        tkTransW *= 1.0 - sw;
        tkPert = mix( tkPert, vec3( gv.r - 0.5, 0.0, gv.g - 0.5 ) + rockN * 0.4, sw );
      }
      if ( tkRockW > 0.01 ) {
        // Irregular edges: turf creeps over the low parts of the rock, and a few metres of noise rag the outline.
        float edgeN = tkFw < 1.6 ? mix( tkNoise( tkPw.xz / 4.1 + vec2( 2.2, -7.3 ) ), 0.5, smoothstep( 0.5, 1.6, tkFw ) ) : 0.5;
        tkRockW = smoothstep( 0.36, 0.56, tkRockW + ( ( hgt - 0.5 ) * 2.4 + ( edgeN - 0.5 ) * 1.6 ) * tkRockW * ( 1.0 - tkRockW ) );
        vec3 rockC = mix( ${col(PALETTE.rock)}, ${col(PALETTE.rockWarm)}, smoothstep( 0.3, 0.8, m2 ) * 0.2 + tkPen * 0.35 );
        rockC = mix( rockC, ${col(PALETTE.rockDark)}, ( 1.0 - smoothstep( 0.25, 0.6, hgt ) ) * 0.8 );
        // Dark water streaks down the faces below the crest.
        rockC *= 1.0 - 0.25 * smoothstep( 0.1, 0.4, wet );
        rockC = mix( rockC, ${col(PALETTE.lichen)}, smoothstep( 0.45, 0.85, m3 ) * 0.45 );
        // Ledges are darker, mossy, half-buried stone.
        rockC = mix( rockC, mix( ${col(PALETTE.rockDark)}, land, 0.3 ), outcrop * 0.6 );
        // Moss and turf on the up-facing facets of broken rock.
        rockC = mix( rockC, land * 0.85, smoothstep( 0.72, 0.95, w.y ) * ( 1.0 - tkPen ) * 0.55 );
        // Thin fragments at the edge of a crag are shadowed, mossy stone rather than bare pale faces.
        rockC = mix( mix( ${col(PALETTE.rockDark)}, land, 0.35 ), rockC, smoothstep( 0.35, 0.85, tkRockW ) );
        // Crustose lichen: pale grey-green and a few orange spots on the rock up close.
        if ( tkNearTex > 0.0 ) {
          float lc = tkNoise( tkPw.xz / 1.7 + tkPw.y * 0.31 );
          rockC = mix( rockC, ${col(PALETTE.lichen)} * 1.15, smoothstep( 0.62, 0.8, lc ) * 0.45 * tkNearTex );
          rockC = mix( rockC, ${col(PALETTE.lichenOrange)}, smoothstep( 0.86, 0.95, lc ) * 0.5 * tkNearTex );
        }
        land = mix( land, rockC * ( 0.3 + 0.95 * rockAlb ), tkRockW );
        tkTransW *= 1.0 - tkRockW;
        tkRough = mix( tkRough, 0.82, tkRockW );
        tkPert = mix( tkPert, rockN, tkRockW );
      }
    }

    // 6. beach: gravel with sand pockets, a dark wet band at the waterline and a wrack line of dried kelp.
    if ( tkH < 3.0 ) {
      float bn = tkNoise( tkPw.xz / 17.0 + vec2( 4.4, 1.9 ) );
      float beachW = ( 1.0 - smoothstep( ${f(COVER.beachTop - 0.55)}, ${f(COVER.beachTop + 0.55)}, tkH + ( bn - 0.5 ) * 0.9 ) ) * smoothstep( -70.0, -35.0, tkSd ) * ( 1.0 - tkRockW * 0.85 );
      float sandW = ( 1.0 - smoothstep( 0.06, 0.16, tkS ) ) * smoothstep( 0.35, 0.6, tkNoise( tkPw.xz / 60.0 ) );
      vec3 beachC = mix( mix( ${col(PALETTE.gravel)}, ${col(PALETTE.gravelWarm)}, m2 ) * ( 0.62 + 0.76 * gv.b ), ${col(PALETTE.sand)} * ( 0.85 + 0.3 * grAlb ), sandW );
      // Wrack line: a ragged string of dried kelp and eelgrass at the last high tide, broken into clumps.
      float wrack = 0.0;
      if ( tkFw < 0.9 ) {
        float wl = abs( tkH - 1.05 - ( bn - 0.5 ) * 0.4 + ( tkNoise( tkPw.xz / 1.3 ) - 0.5 ) * 0.08 );
        wrack = ( 1.0 - smoothstep( 0.02, 0.07, wl ) ) * smoothstep( 0.4, 0.62, tkNoise( tkPw.xz / 2.2 + 7.1 ) ) * ( 1.0 - sandW * 0.6 ) * ( 1.0 - smoothstep( 0.4, 0.9, tkFw ) );
      }
      beachC = mix( beachC, ${col(PALETTE.wrack)} * ( 0.8 + 0.5 * gv.b ), wrack * 0.85 );
      float wet2 = 1.0 - smoothstep( 0.05, 0.5, tkH + ( bn - 0.5 ) * 0.25 );
      land = mix( land, beachC * ( 1.0 - 0.45 * wet2 ), beachW );
      tkTransW *= 1.0 - beachW;
      tkRough = mix( tkRough, mix( mix( 0.9, 0.95, sandW ), 0.32, wet2 ), beachW );
      tkSpec = max( tkSpec, wet2 * beachW * 0.9 );
      tkPert = mix( tkPert, vec3( gv.r - 0.5, 0.0, gv.g - 0.5 ) * ( 1.4 - sandW ), beachW );
      // Just below the waterline blend toward the seabed look.
      tkUnder = 1.0 - smoothstep( -0.6, 0.05, tkH );
      land = mix( land, ${col(PALETTE.seabedGravel)} * ( 0.7 + 0.6 * gv.b ), tkUnder );
    }

    // 7. snow patches: baked weight sharpened with per-pixel noise.
    if ( cA.a > 0.01 ) {
      float snowN = tkFw < 1.5 ? mix( tkNoise( tkPw.xz / 9.0 + vec2( 1.3, 7.7 ) ), 0.5, smoothstep( 0.4, 1.5, tkFw ) ) : 0.5;
      float snowW = smoothstep( 0.3, 0.7, cA.a + ( snowN - 0.5 ) * 0.35 * cA.a + ( m3 - 0.5 ) * 0.3 * cA.a );
      land = mix( land, ${col(PALETTE.snow)} * ( 0.92 + 0.08 * grAlb ), snowW );
      tkTransW *= 1.0 - snowW;
      tkRough = mix( tkRough, 0.55, snowW );
      tkSpec = max( tkSpec, snowW * 0.3 );
      tkPert *= 1.0 - snowW * 0.7;
      land *= 1.0 - 0.25 * uRain * ( 1.0 - snowW );
    } else {
      land *= 1.0 - 0.25 * uRain;
    }
    tkRough = mix( tkRough, tkRough * 0.6, uRain );
    tkSpec = max( tkSpec, uRain * 0.35 );

    // 8. lakes: dark, glassy, gently rippled.
    if ( tkLakeW > 0.01 ) {
      vec3 rip = tkNoiseD( tkPw.xz / 3.0 + uWindDir * uTime * 0.35 ) + tkNoiseD( tkPw.xz / 1.3 - uWindDir.yx * uTime * 0.5 ) * 0.5;
      land = mix( land, ${col(PALETTE.lake)}, tkLakeW );
      tkTransW *= 1.0 - tkLakeW;
      tkRough = mix( tkRough, 0.07, tkLakeW );
      tkSpec = max( tkSpec, tkLakeW );
      tkPert = mix( tkPert, vec3( rip.x, 0.0, rip.y ) * 0.05 * ( 1.0 - smoothstep( 50.0, 400.0, tkDist ) ), tkLakeW );
    }
    tkAlbedo = land;
  }

  // Gullies and crevices hold shadow; AO also scales indirect light below.
  tkAlbedo *= mix( 0.72 + 0.28 * smoothstep( 0.35, 0.95, tkAO ), 1.0, tkUnder );
  vec3 tkN = normalize( normalize( vec3( -tkGd.x, 1.0, -tkGd.y ) ) + tkPert );
  vec3 tkSunView = normalize( ( viewMatrix * vec4( uSunDir, 0.0 ) ).xyz );
`;

// Reflection-pass surface (TK_CHEAP): the same baked cover weights and palette without detail textures, per-pixel
// noise or triplanar rock. The planar water reflection is half resolution and wave-distorted, so this is visually
// indistinguishable there at a fraction of the cost.
const FRAG_SURFACE_CHEAP = /* glsl */ `
  vec3 tkPw = vKWorldPos;
  vec2 tkUV = ( tkPw.xz + tkHalf ) / ( 2.0 * tkHalf );
  vec2 tkUVc = clamp( tkUV, 0.0, 1.0 );
  float tkH = tkPw.y;
#ifdef TK_PROF_NOINFO
  vec4 tkI = vec4( 0.1, 0.1, 0.0, 0.8 );
#else
  vec4 tkI = texture( tkInfo, tkUV );
#endif
  float tkOut = max( abs( tkPw.x ), abs( tkPw.z ) ) - tkHalf;
  float tkOutF = tkOut > 0.0 ? smoothstep( 0.0, 3200.0, tkOut ) : 0.0;
  vec2 tkMir = vec2( tkUV.x < 0.0 || tkUV.x > 1.0 ? -1.0 : 1.0, tkUV.y < 0.0 || tkUV.y > 1.0 ? -1.0 : 1.0 );
  vec2 tkG = tkI.xy * tkMir * ( 1.0 - tkOutF );
  float tkAO = mix( tkI.w, 1.0, tkOutF );
  float tkSh = texture( uTerrainShadow, tkUVc ).r;
  float tkUnder = 0.0;
  float tkCaustic = 0.0;
  float tkTransW = 0.0;
#ifdef TK_PROF_NOCOVER
  vec4 cA = vec4( 0.2, 0.3, 0.1, 0.0 ), cB = vec4( 0.0, 0.5, 0.0, 0.0 ), cC = vec4( 0.2, 0.5, 0.5, 0.0 );
#else
  vec4 cA = texture( tkCoverA, tkUV );
  vec4 cB = texture( tkCoverB, tkUV );
  vec4 cC = texture( tkCoverC, tkUV );
#endif
  float alpine = smoothstep( 92.0, 150.0, tkH + ( cC.g - 0.5 ) * 50.0 );
  vec3 land = mix( ${col(PALETTE.grassLush)}, ${col(PALETTE.grassBright)}, smoothstep( 0.25, 0.75, cC.g * 0.45 + cC.b * 0.55 ) ) * ( 0.84 + 0.32 * cC.b );
  land = mix( land, ${col(PALETTE.grassDeep)}, smoothstep( 0.1, 0.45, cC.r ) * 0.75 );
  land = mix( land, ${col(PALETTE.tundra)}, alpine );
  land = mix( land, ${col(PALETTE.alder)} * 1.2, smoothstep( 0.0, 0.7, cA.g ) );
  land = mix( land, ${col(PALETTE.spruce)}, cA.r * ( 1.0 - tkOutF * 0.5 ) );
  land = mix( land, ${col(PALETTE.scree)} * 0.85, smoothstep( 0.2, 0.65, cC.a ) );
  float rockW = smoothstep( ${f(COVER.rock0)}, ${f(COVER.rock1)}, 0.9 + cA.b );
  land = mix( land, ${col(PALETTE.rock)}, rockW );
  land = mix( land, ${col(PALETTE.gravel)} * 0.85, ( 1.0 - smoothstep( ${f(COVER.beachTop - 0.55)}, ${f(COVER.beachTop + 0.55)}, tkH ) ) * ( 1.0 - rockW * 0.85 ) );
  land = mix( land, ${col(PALETTE.snow)}, smoothstep( 0.3, 0.7, cA.a ) );
  float tkLakeW = smoothstep( 0.35, 0.65, cB.r ) * ( 1.0 - tkOutF );
  land = mix( land, ${col(PALETTE.lake)}, tkLakeW );
  land *= 1.0 - 0.25 * uRain;
  float tkRough = mix( 0.93, 0.15, tkLakeW );
  float tkSpec = tkLakeW * 0.6;
  vec3 tkAlbedo = land * ( 0.72 + 0.28 * smoothstep( 0.35, 0.95, tkAO ) );
  vec3 tkN = normalize( vec3( -tkG.x, 1.0, -tkG.y ) );
  vec3 tkSunView = normalize( ( viewMatrix * vec4( uSunDir, 0.0 ) ).xyz );
`;

// cheap: the reflection-pass variant (FRAG_SURFACE_CHEAP, no detail displacement).
export function createTerrainMaterial({ uniforms, textures, lodUniform, heightTex, size, half, getEnvDefines = () => null, cheap = false }) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0.0 });
  mat.name = cheap ? 'terrain-reflection' : 'terrain';
  if (cheap) mat.defines = { TK_CHEAP: 1 };
  const own = {
    tkHeight: { value: heightTex },
    tkSize: { value: size },
    tkHalf: { value: half },
    tkLod: lodUniform,
    tkInfo: { value: textures.info },
    tkCoverA: { value: textures.coverA },
    tkCoverB: { value: textures.coverB },
    tkCoverC: { value: textures.coverC },
    tkLattice: { value: textures.lattice },
    tkRegion: { value: textures.region },
    tkRockTex: { value: textures.rock },
    tkCliffTex: { value: textures.cliff },
    tkGroundTex: { value: textures.ground },
    tkGravelTex: { value: textures.gravel },
    tkSunScale: { value: 1 },
  };
  mat.userData.tk = own;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, own);
    for (const k of ['uCameraPos', 'uHeightMap', 'uTerrainShadow', 'uSunDir', 'uSunColor', 'uTime', 'uRain', 'uWindDir']) {
      shader.uniforms[k] = uniforms[k];
    }
    const env = getEnvDefines();
    const envDefs = env && 'CUBEUV_TEXEL_WIDTH' in env ? `#define TK_ENV_VS\n${['CUBEUV_TEXEL_WIDTH', 'CUBEUV_TEXEL_HEIGHT', 'CUBEUV_MAX_MIP'].map((k) => `#define ${k} ${env[k]}`).join('\n')}\n` : '';
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${envDefs}${VERT_PARS}`)
      .replace('#include <beginnormal_vertex>', VERT_MAIN)
      .replace('#include <begin_vertex>', 'vec3 transformed = tkWorldPos;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n#ifdef TK_DBG_UNLIT\n  gl_FragColor = vec4( 0.2, 0.4, 0.1, 1.0 ); return;\n#endif')
      .replace(
        '#include <map_fragment>',
        `${cheap ? FRAG_SURFACE_CHEAP : `#ifdef TK_PROF_CHEAPFRAG\n${FRAG_SURFACE_CHEAP}\n#else\n${FRAG_SURFACE}\n#endif`}
#ifdef TK_DEBUG_FLAT
  tkAlbedo = vec3( 0.2, 0.4, 0.1 );
#endif
#ifdef TK_PROF_NOLIGHT
  gl_FragColor = vec4( tkAlbedo * dot( tkN, normalize( uSunDir ) ), 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  return;
#endif
#ifdef TK_DBG_LEVELS
  {
    // LOD debug: hue per level, darkening toward the next level as the vertices morph.
    vec3 lc = 0.5 + 0.5 * cos( 6.2831 * ( vTkLevel.x * 0.17 + vec3( 0.0, 0.33, 0.67 ) ) );
    tkAlbedo = lc * ( 1.0 - 0.6 * vTkLevel.y ) * 0.35;
  }
#endif
  diffuseColor.rgb = tkAlbedo;`,
      )
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = tkRough;')
      .replace(
        '#include <normal_fragment_begin>',
        `float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;
vec3 normal = normalize( ( viewMatrix * vec4( tkN, 0.0 ) ).xyz );
vec3 nonPerturbedNormal = normal;`,
      )
      .replace('#include <lights_physical_pars_fragment>', `#include <lights_physical_pars_fragment>\n${LIGHT_PARS}`)
      .replace('#include <lights_physical_fragment>', LIGHTS_MAIN)
      .replace('#include <lights_fragment_begin>', '')
      .replace('#include <lights_fragment_maps>', '')
      .replace('#include <lights_fragment_end>', '')
      .replace(
        '#include <aomap_fragment>',
        `{
  float tkOcc = mix( 0.35 + 0.65 * tkAO, 1.0, tkUnder );
  reflectedLight.indirectDiffuse *= tkOcc;
  reflectedLight.indirectSpecular *= mix( tkOcc, 1.0, tkLakeW );
}`,
      );
  };
  mat.customProgramCacheKey = () => `kodiak-terrain-v4|${cheap ? 'cheap' : 'full'}|${JSON.stringify(getEnvDefines() ?? {})}`;
  patchUnderwater(mat, uniforms);
  return mat;
}
