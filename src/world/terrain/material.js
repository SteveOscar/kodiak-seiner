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
  rock: '#6c6861',
  rockDark: '#45433e',
  rockWarm: '#7a6e5f',
  lichen: '#8e9270',
  scree: '#827c71',
  snow: '#eef2f6',
  gravel: '#77756f',
  gravelWarm: '#857d70',
  sand: '#a79a7c',
  wrack: '#3b3524',
  seabedSand: '#a9996f',
  seabedGravel: '#7b7263',
  seabedRock: '#4d4a40',
  kelpBed: '#3d3a1e',
  mud: '#5b5443',
  lake: '#16303a',
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
#if defined( USE_ENVMAP ) && defined( TK_ENV_VS )
  // Diffuse IBL varies slowly with the normal, so it is sampled per vertex from the sky's PMREM (CubeUV) map.
  #define ENVMAP_TYPE_CUBE_UV
  uniform sampler2D envMap;
  uniform float envMapIntensity;
  uniform mat3 envMapRotation;
  #include <cube_uv_reflection_fragment>
#endif
float tkApproxH( vec2 p ) {
  float invT = tkSize / ( 2.0 * tkHalf );
  vec2 fp = clamp( ( p + tkHalf ) * invT - 0.5, vec2( 0.0 ), vec2( tkSize - 1.001 ) );
  ivec2 i = ivec2( floor( fp ) );
  vec2 t = fp - vec2( i );
  float a = tkTexel( i.x, i.y ), b = tkTexel( i.x + 1, i.y ), c = tkTexel( i.x, i.y + 1 ), d = tkTexel( i.x + 1, i.y + 1 );
  return mix( mix( a, b, t.x ), mix( c, d, t.x ), t.y );
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
  vec3 tkSm = tkSmooth( tkXZ );
  // Detail is resolved by levels 0-2; it fades out across level 2's morph band so level 3+ stays smooth.
  float tkDw = tkL < 2 ? 1.0 : ( tkL == 2 ? 1.0 - tkK : 0.0 );
#ifdef TK_DEBUG_NODETAIL
  vec3 tkDt = vec3( 0.0 );
#else
  vec3 tkDt = tkDw > 0.0 ? tkDetail( tkXZ, tkSm.x, tkSm.yz ) * tkDw : vec3( 0.0 );
#endif
  float tkY = tkSm.x + tkDt.z - position.y * tkP.w;
  vec3 objectNormal = normalize( vec3( -tkSm.y - tkDt.x, 1.0, -tkSm.z - tkDt.y ) );
  vec3 tkWorldPos = vec3( tkXZ.x, tkY, tkXZ.y );
#if defined( USE_ENVMAP ) && defined( TK_ENV_VS )
  vTkEnvIrr = PI * textureCubeUV( envMap, envMapRotation * objectNormal, 1.0 ).rgb * envMapIntensity;
#else
  vTkEnvIrr = vec3( 0.0 );
#endif
`;

const FRAG_PARS = /* glsl */ `
${TK_NOISE_ALU}
${TK_DETAIL}
uniform float tkHalf;
uniform sampler2D tkInfo;
uniform sampler2D tkCoverA;
uniform sampler2D tkCoverB;
uniform sampler2D tkCoverC;
uniform sampler2D tkRegion;
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

// Triplanar sample of a detail texture: .xyz = world-space normal perturbation, .w = albedo variation; hgt = height.
vec4 tkTri( sampler2D t, vec3 p, vec3 w, float scale, out float hgt ) {
  vec4 a = texture( t, p.zy / scale );
  vec4 b = texture( t, p.xz / scale );
  vec4 c = texture( t, p.xy / scale );
  hgt = a.a * w.x + b.a * w.y + c.a * w.z;
  vec2 na = a.rg * 2.0 - 1.0;
  vec2 nb = b.rg * 2.0 - 1.0;
  vec2 nc = c.rg * 2.0 - 1.0;
  vec3 n = vec3( 0.0, na.y, na.x ) * w.x + vec3( nb.x, 0.0, nb.y ) * w.y + vec3( nc.x, nc.y, 0.0 ) * w.z;
  return vec4( n, a.b * w.x + b.b * w.y + c.b * w.z );
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
    directLight.color *= receiveShadow ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
    #endif
    tkDirect( directLight, geometryNormal, geometryViewDir, tkDiffuse, tkShin, tkSpec, reflectedLight );
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
const FRAG_SURFACE = /* glsl */ `
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
  float tkSd = texture( uHeightMap, tkUVc ).g;
  float tkSh = texture( uTerrainShadow, tkUVc ).r;
  float tkNearTex = 1.0 - smoothstep( 0.5, 3.0, tkFw );

  vec3 tkAlbedo;
  float tkRough;
  vec3 tkPert = vec3( 0.0 );
  float tkUnder = 0.0;
  float tkLakeW = 0.0;
  float tkCaustic = 0.0;
  float tkSpec = 0.0;
  vec2 tkGd = tkG;

  if ( tkH < -0.6 ) {
    // ---- seabed: seen only through the water column (kodiak_underwater), so a cheap path.
    tkUnder = 1.0;
    float m2 = texture( tkCoverB, tkUV ).a;
    float rocky = smoothstep( 0.25, 0.55, tkS );
    vec4 gv = texture( tkGravelTex, tkPw.xz / 5.3 );
    vec3 bed = mix( ${col(PALETTE.seabedGravel)} * ( 0.7 + 0.6 * gv.b ), ${col(PALETTE.seabedSand)}, smoothstep( 20.0, 90.0, tkSd + ( m2 - 0.5 ) * 60.0 ) );
    bed = mix( bed, ${col(PALETTE.seabedRock)} * ( 0.75 + 0.5 * gv.b ), rocky );
    if ( tkH > -18.0 ) {
      float kelpy = rocky * smoothstep( 0.45, 0.7, tkNoise( tkPw.xz / 19.0 + vec2( 6.6, -1.1 ) ) ) * smoothstep( -16.0, -3.0, tkH );
      bed = mix( bed, ${col(PALETTE.kelpBed)}, kelpy * 0.8 );
      float cd = smoothstep( -12.0, -0.3, tkH ) * ( 1.0 - smoothstep( 60.0, 300.0, tkDist ) );
      if ( cd > 0.0 ) {
        vec2 cp = tkPw.xz / 2.3;
        float c1 = tkNoise( cp + vec2( uTime * 0.23, uTime * 0.11 ) );
        float c2 = tkNoise( cp * 1.37 + vec2( -uTime * 0.19, uTime * 0.21 ) + 5.0 );
        tkCaustic = pow( clamp( 1.0 - abs( c1 - c2 ) * 3.0, 0.0, 1.0 ), 5.0 ) * cd * 1.4;
      }
    }
    tkAlbedo = mix( bed, ${col(PALETTE.mud)}, smoothstep( 150.0, 400.0, tkSd ) * 0.6 );
    tkRough = 0.75;
    tkPert = vec3( gv.r * 2.0 - 1.0, 0.0, gv.g * 2.0 - 1.0 ) * 0.35 * tkNearTex;
  } else {
    // ---- land, beaches and the waterline. Layers are mixed in sequence so few values stay live at once (the
    // shader is register-bound on Apple GPUs).
    vec4 cA = texture( tkCoverA, tkUV ); // forest, alder, rock score, snow
    vec4 cB = texture( tkCoverB, tkUV ); // lake, fireweed, lupine, m2 (131 m)
    vec4 cC = texture( tkCoverC, tkUV ); // wetness, m1 (470 m), m3 (29 m), scree
    vec3 reg = texture( tkRegion, tkUVc ).rgb; // spruce potential, developed, peninsula
    float tkPen = reg.b;
    float m1 = cC.g;
    float m2 = cB.a;
    float m3 = cC.b;
    float wet = cC.r;

    // Detail displacement gradient (matches the vertex shader) near the camera.
    float tkNear = 1.0 - smoothstep( 500.0, 1400.0, tkDist );
#ifndef TK_DEBUG_NODETAIL
    if ( tkNear > 0.0 ) tkGd += tkDetail( tkPw.xz, tkH, tkG ).xy * tkNear;
#endif

    // Ground detail texture (two scales; the fine one only near).
    vec4 gr = texture( tkGroundTex, tkPw.xz / 13.7 + 0.31 );
    float grAlb = gr.b;
    vec2 grN = ( gr.rg * 2.0 - 1.0 ) * 0.4;
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
    land *= 0.8 + 0.4 * grAlb;
    // Wildflower meadows as distant tints (instanced flowers take over up close); developed ground is trodden.
    float flowerFar = smoothstep( 25.0, 90.0, tkDist );
    land = mix( land, ${col(PALETTE.fireweed)}, cB.g * ( 0.05 + 0.1 * flowerFar ) );
    land = mix( land, ${col(PALETTE.lupine)}, cB.b * ( 0.04 + 0.08 * flowerFar ) );
    land = mix( land, ${col(PALETTE.developed)} * ( 0.8 + 0.4 * grAlb ), reg.g * 0.35 * smoothstep( 0.25, 0.6, m3 + grAlb * 0.3 ) );
    tkLakeW = smoothstep( 0.35, 0.65, cB.r ) * ( 1.0 - tkOutF );
    tkRough = 0.93;
    tkPert = vec3( grN.x, 0.0, grN.y ) * 0.55;

    // 2. alder and salmonberry thickets: dark, clumpy crowns that read as bands along the gullies.
    if ( cA.g > 0.01 ) {
      // Per-pixel crowns only while each noise cell spans many pixels: further out value-noise cells read as squares.
      float clump = tkFw < 0.6 ? mix( tkNoise( tkPw.xz / 3.4 + vec2( 5.1, 1.7 ) ), m3, smoothstep( 0.15, 0.6, tkFw ) ) : m3;
      vec3 alderC = mix( ${col(PALETTE.alder)}, ${col(PALETTE.alderLight)}, smoothstep( 0.2, 0.8, clump ) ) * ( 0.75 + 0.5 * grAlb );
      // A soft ramp: sharpening the bilinear 7.8 m bake would print its texel grid on the canopy.
      float aw = smoothstep( 0.0, 0.7, cA.g ) * ( 0.85 + 0.3 * grAlb );
      land = mix( land, alderC, aw );
      tkPert = mix( tkPert, vec3( grN.x, 0.0, grN.y ) * 1.3, aw );
      tkRough = mix( tkRough, 0.88, aw );
    }

    // 3. spruce: canopy crowns read at distance, dark forest floor near (where the trees themselves stand).
    if ( cA.r > 0.0 ) {
      float crown = tkFw < 0.9 ? mix( tkNoise( tkPw.xz / 5.5 + vec2( 2.3, 8.8 ) ), m3, smoothstep( 0.25, 0.9, tkFw ) ) : m3;
      vec3 spruceC = mix( ${col(PALETTE.spruce)} * ( 0.8 + 0.45 * crown ), ${col(PALETTE.forestFloor)} * ( 0.8 + 0.4 * grAlb ), 1.0 - smoothstep( 120.0, 420.0, tkDist ) );
      float fw = cA.r * ( 1.0 - tkOutF * 0.5 );
      land = mix( land, spruceC, fw );
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
    float ribs = clamp( -tkCurv, -2.5, 2.5 ) * 0.11 - smoothstep( 0.12, 0.45, wet ) * 0.3;
    float solid = smoothstep( ${f(COVER.rock0)}, ${f(COVER.rock1)}, score + ribs + ( m3 - 0.5 ) * 0.28 + ( grAlb - 0.5 ) * 0.12 );
    // Away from the steepest cores, crags break into bedding ledges along the contour with turf between (phase from
    // the baked macro noise, so the bands wander and end instead of ringing the hill).
    float strata = smoothstep( 0.32, 0.6, tkNoise( vec2( tkH / 6.5 + m2 * 4.0, m3 * 3.0 + m1 * 5.0 ) ) );
    solid *= mix( 0.15 + 0.85 * strata, 1.0, smoothstep( ${f(COVER.rock1)}, ${f(COVER.rock1 + 0.4)}, score + ribs ) );
    float tkRockW = max( solid, outcrop );
    vec4 gv = vec4( 0.5 );
    if ( screeW > 0.01 || tkH < 3.0 ) {
      gv = tkNearTex > 0.0 ? mix( texture( tkGravelTex, tkPw.xz / 4.6 + 0.17 ), texture( tkGravelTex, tkPw.xz / 1.35 ), tkNearTex ) : texture( tkGravelTex, tkPw.xz / 4.6 + 0.17 );
    }
    if ( tkRockW > 0.01 || screeW > 0.01 ) {
      vec3 w = pow( abs( normalize( vec3( -tkGd.x, 1.0, -tkGd.y ) ) ), vec3( 4.0 ) );
      w /= ( w.x + w.y + w.z );
      float hgt;
      vec4 r = tkTri( tkCliffTex, tkPw + 11.0, w, 61.0, hgt );
      vec3 rockN = r.xyz * 0.7;
      float rockAlb = r.w;
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
        vec3 screeC = mix( ${col(PALETTE.scree)}, ${col(PALETTE.ash)}, tkPen * 0.6 ) * ( 0.62 + 0.5 * rockAlb + 0.3 * gv.b );
        land = mix( land, screeC, sw );
        tkPert = mix( tkPert, vec3( gv.r - 0.5, 0.0, gv.g - 0.5 ) + rockN * 0.4, sw );
      }
      if ( tkRockW > 0.01 ) {
        // Irregular edges: turf creeps over the low parts of the rock.
        tkRockW = smoothstep( 0.3, 0.6, tkRockW + ( hgt - 0.5 ) * 2.4 * tkRockW * ( 1.0 - tkRockW ) );
        vec3 rockC = mix( ${col(PALETTE.rock)}, ${col(PALETTE.rockWarm)}, smoothstep( 0.3, 0.8, m2 ) * 0.35 + tkPen * 0.35 );
        rockC = mix( rockC, ${col(PALETTE.rockDark)}, ( 1.0 - smoothstep( 0.25, 0.6, hgt ) ) * 0.8 );
        // Dark water streaks down the faces below the crest.
        rockC *= 1.0 - 0.25 * smoothstep( 0.1, 0.4, wet );
        rockC = mix( rockC, ${col(PALETTE.lichen)}, smoothstep( 0.55, 0.85, m3 ) * 0.35 );
        // Ledges are darker, mossy, half-buried stone.
        rockC = mix( rockC, mix( ${col(PALETTE.rockDark)}, land, 0.3 ), outcrop * 0.6 );
        // Moss and turf on the up-facing facets of broken rock.
        rockC = mix( rockC, land * 0.85, smoothstep( 0.72, 0.95, w.y ) * ( 1.0 - tkPen ) * 0.55 );
        // Thin fragments at the edge of a crag are shadowed, mossy stone rather than bare pale faces.
        rockC = mix( mix( ${col(PALETTE.rockDark)}, land, 0.35 ), rockC, smoothstep( 0.35, 0.85, tkRockW ) );
        land = mix( land, rockC * ( 0.55 + 0.9 * rockAlb ), tkRockW );
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
      float wrack = ( 1.0 - smoothstep( 0.0, 0.18, abs( tkH - 1.05 - ( bn - 0.5 ) * 0.5 ) ) ) * smoothstep( 0.35, 0.6, tkNoise( tkPw.xz / 3.1 ) ) * ( 1.0 - sandW * 0.6 );
      beachC = mix( beachC, ${col(PALETTE.wrack)}, wrack * 0.8 );
      float wet2 = 1.0 - smoothstep( 0.05, 0.5, tkH + ( bn - 0.5 ) * 0.25 );
      land = mix( land, beachC * ( 1.0 - 0.45 * wet2 ), beachW );
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

export function createTerrainMaterial({ uniforms, textures, lodUniform, heightTex, size, half, getEnvDefines = () => null }) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0.0 });
  mat.name = 'terrain';
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
        `${FRAG_SURFACE}
#ifdef TK_DEBUG_FLAT
  tkAlbedo = vec3( 0.2, 0.4, 0.1 );
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
  mat.customProgramCacheKey = () => `kodiak-terrain-v3|${JSON.stringify(getEnvDefines() ?? {})}`;
  patchUnderwater(mat, uniforms);
  return mat;
}
