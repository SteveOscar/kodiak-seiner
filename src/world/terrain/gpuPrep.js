// One-off GPU passes run in create(): the DEM float texture, a terrain info texture (gradient, curvature, sky
// visibility) and three tileable procedural detail textures (rock, ground, gravel). Everything is generated here —
// no downloaded art.

import * as THREE from 'three';
import { TK_NOISE_ALU, TK_COVER } from './glsl.js';
import { COVER } from './landcover.js';

// Full-screen triangle; the vertex shader ignores the camera.
export function createPassRunner(renderer) {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const mesh = new THREE.Mesh(geom);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const prevClear = new THREE.Color();
  return {
    run(material, target, scissor = null) {
      const prevTarget = renderer.getRenderTarget();
      const prevAuto = renderer.autoClear;
      const prevScissorTest = renderer.getScissorTest();
      const prevXr = renderer.xr.enabled;
      renderer.getClearColor(prevClear);
      const prevAlpha = renderer.getClearAlpha();
      const prevShadowAuto = renderer.shadowMap.autoUpdate;
      renderer.xr.enabled = false;
      renderer.autoClear = false;
      mesh.material = material;
      renderer.setRenderTarget(target);
      if (scissor) {
        target.scissor.set(scissor[0], scissor[1], scissor[2], scissor[3]);
        target.scissorTest = true;
      } else {
        target.scissorTest = false;
      }
      renderer.render(scene, camera);
      target.scissorTest = false;
      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = prevAuto;
      renderer.setScissorTest(prevScissorTest);
      renderer.setClearColor(prevClear, prevAlpha);
      renderer.shadowMap.autoUpdate = prevShadowAuto;
      renderer.xr.enabled = prevXr;
    },
    dispose() {
      geom.dispose();
    },
  };
}

export const PASS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}`;

export function passMaterial(fragmentShader, uniforms = {}, defines = {}) {
  return new THREE.ShaderMaterial({
    vertexShader: PASS_VERT,
    fragmentShader,
    uniforms,
    defines,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
}

// R32F DEM with a box-filtered mip chain. Vertex shaders use texelFetch (exact); passes use textureLod.
export function createHeightTexture(heights, size) {
  const tex = new THREE.DataTexture(heights, size, size, THREE.RedFormat, THREE.FloatType);
  tex.mipmaps = [{ data: heights, width: size, height: size }];
  for (let w = size, prev = heights; w > 1; ) {
    const n = w >> 1;
    const next = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      const r0 = 2 * j * w;
      const r1 = r0 + w;
      for (let i = 0; i < n; i++) next[j * n + i] = 0.25 * (prev[r0 + 2 * i] + prev[r0 + 2 * i + 1] + prev[r1 + 2 * i] + prev[r1 + 2 * i + 1]);
    }
    tex.mipmaps.push({ data: next, width: n, height: n });
    prev = next;
    w = n;
  }
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const AO_FRAG = /* glsl */ `
uniform sampler2D tkHeightTex;
uniform float tkHalf;
varying vec2 vUv;
float hAt( vec2 p, float lod ) { return textureLod( tkHeightTex, ( p + tkHalf ) / ( 2.0 * tkHalf ), lod ).r; }
void main() {
  vec2 p = ( vUv * 2.0 - 1.0 ) * tkHalf;
  float h0 = max( hAt( p, 0.0 ), 0.0 );
  float occ = 0.0;
  for ( int k = 0; k < 14; k ++ ) {
    float a = ( float( k ) + 0.37 ) * 6.2831853 / 14.0;
    vec2 d = vec2( cos( a ), sin( a ) );
    float maxTan = 0.0;
    float t = 9.0;
    for ( int s = 0; s < 13; s ++ ) {
      float hq = hAt( p + d * t, clamp( log2( t / 36.0 ), 0.0, 4.0 ) );
      maxTan = max( maxTan, ( hq - h0 ) / t );
      t *= 1.42;
    }
    float e = atan( maxTan );
    occ += sin( e ) * sin( e ) * 0.5 + sin( e ) * 0.5;
  }
  gl_FragColor = vec4( 1.0 - occ / 14.0, 0.0, 0.0, 1.0 );
}`;

const INFO_FRAG = /* glsl */ `
uniform highp sampler2D tkHeightTex;
uniform sampler2D tkAo;
uniform float tkSize;
uniform float tkHalf;
varying vec2 vUv;
float hT( ivec2 ij ) {
  int n = int( tkSize ) - 1;
  return texelFetch( tkHeightTex, clamp( ij, ivec2( 0 ), ivec2( n ) ), 0 ).r;
}
void main() {
  ivec2 ij = ivec2( gl_FragCoord.xy );
  float T = 2.0 * tkHalf / tkSize;
  float h = hT( ij );
  float gx = ( hT( ij + ivec2( 1, 0 ) ) - hT( ij - ivec2( 1, 0 ) ) ) / ( 2.0 * T );
  float gz = ( hT( ij + ivec2( 0, 1 ) ) - hT( ij - ivec2( 0, 1 ) ) ) / ( 2.0 * T );
  float ring = 0.0;
  ring += hT( ij + ivec2( 2, 0 ) ) + hT( ij + ivec2( -2, 0 ) ) + hT( ij + ivec2( 0, 2 ) ) + hT( ij + ivec2( 0, -2 ) );
  ring += hT( ij + ivec2( 2, 2 ) ) + hT( ij + ivec2( -2, 2 ) ) + hT( ij + ivec2( 2, -2 ) ) + hT( ij + ivec2( -2, -2 ) );
  float c1 = ring / 8.0 - h;
  float c2 = textureLod( tkHeightTex, vUv, 3.0 ).r - h;
  float curv = 0.55 * c1 + 0.45 * c2 * 0.35;
  float ao = texture2D( tkAo, vUv ).r;
  gl_FragColor = vec4( gx, gz, curv, ao );
}`;

export function createInfoTextures(renderer, runner, heightTex, size, half, anisotropy = 4) {
  const aoSize = size >> 1;
  const ao = new THREE.WebGLRenderTarget(aoSize, aoSize, {
    format: THREE.RedFormat,
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
  });
  const aoMat = passMaterial(AO_FRAG, { tkHeightTex: { value: heightTex }, tkHalf: { value: half } });
  runner.run(aoMat, ao);

  const info = new THREE.WebGLRenderTarget(size, size, {
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.MirroredRepeatWrapping,
    wrapT: THREE.MirroredRepeatWrapping,
    generateMipmaps: true,
    depthBuffer: false,
    anisotropy: Math.min(anisotropy, renderer.capabilities.getMaxAnisotropy()),
  });
  const infoMat = passMaterial(INFO_FRAG, {
    tkHeightTex: { value: heightTex },
    tkAo: { value: ao.texture },
    tkSize: { value: size },
    tkHalf: { value: half },
  });
  runner.run(infoMat, info);
  aoMat.dispose();
  infoMat.dispose();
  ao.dispose();
  return info;
}

// Periodic noise helpers for tileable textures (per = period in lattice cells, per axis).
const PERIODIC = /* glsl */ `
float pHash( vec2 c, vec2 per ) {
  c = mod( c, per );
  uvec2 u = uvec2( c );
  uint h = u.x * 0x8da6b343u ^ u.y * 0xd8163841u ^ uint( per.x * 7.0 + per.y ) * 0xcb1ab31fu;
  h = ( h ^ ( h >> 16u ) ) * 0x7feb352du;
  h = ( h ^ ( h >> 15u ) ) * 0x846ca68bu;
  h ^= h >> 16u;
  return float( h ) * ( 1.0 / 4294967296.0 );
}
float pNoise( vec2 p, vec2 per ) {
  vec2 i = floor( p );
  vec2 f = p - i;
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  float a = pHash( i, per );
  float b = pHash( i + vec2( 1.0, 0.0 ), per );
  float c = pHash( i + vec2( 0.0, 1.0 ), per );
  float d = pHash( i + vec2( 1.0, 1.0 ), per );
  return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );
}
float pFbm( vec2 p, vec2 per, int oct ) {
  float s = 0.0, a = 0.5, n = 0.0;
  for ( int i = 0; i < 8; i ++ ) {
    if ( i >= oct ) break;
    s += a * pNoise( p, per );
    n += a;
    p *= 2.0;
    per *= 2.0;
    a *= 0.5;
  }
  return s / n;
}
// Periodic Voronoi: x = F1, y = F2, z = cell id hash.
vec3 pVoronoi( vec2 p, vec2 per ) {
  vec2 i = floor( p );
  vec2 f = p - i;
  float f1 = 8.0, f2 = 8.0, id = 0.0;
  for ( int y = -1; y <= 1; y ++ ) {
    for ( int x = -1; x <= 1; x ++ ) {
      vec2 g = vec2( float( x ), float( y ) );
      vec2 c = i + g;
      vec2 o = vec2( pHash( c, per ), pHash( c + vec2( 17.0, 31.0 ), per ) ) * 0.8 + 0.1;
      float d = length( g + o - f );
      if ( d < f1 ) { f2 = f1; f1 = d; id = pHash( c + vec2( 7.0, 3.0 ), per ); }
      else if ( d < f2 ) f2 = d;
    }
  }
  return vec3( f1, f2, id );
}
`;

// Each generator writes RG = normal xy (0.5 +- 0.5), B = albedo variation (0.5 = neutral), A = height.
const DETAIL_FRAG = /* glsl */ `
${PERIODIC}
uniform int kind;
uniform float texSize;
varying vec2 vUv;
float heightFn( vec2 uv, out float alb ) {
  if ( kind == 0 ) {
    // Rock: weathered greywacke/slate with faint bedding (v runs up the cliff in the side projections), irregular
    // fractures and lichen-scale grain.
    float base = pFbm( uv * 5.0, vec2( 5.0 ), 6 );
    float warp = pFbm( uv * 3.0 + 7.3, vec2( 3.0 ), 3 );
    float bed = pNoise( vec2( uv.x * 3.0 + warp * 2.0, uv.y * 17.0 + warp * 4.0 ), vec2( 3.0, 17.0 ) );
    vec3 v = pVoronoi( uv * vec2( 6.0, 4.0 ) + vec2( warp, base ) * 0.9, vec2( 6.0, 4.0 ) );
    float crack = smoothstep( 0.0, 0.05, v.y - v.x );
    float grain = pFbm( uv * 40.0, vec2( 40.0 ), 3 );
    float face = v.z;
    alb = 0.5 + ( base - 0.5 ) * 0.9 + ( face - 0.5 ) * 0.22 + ( grain - 0.5 ) * 0.3 + ( bed - 0.5 ) * 0.25 - ( 1.0 - crack ) * 0.22;
    return base * 0.55 + bed * 0.15 + face * 0.1 + crack * 0.1 + grain * 0.1;
  } else if ( kind == 3 ) {
    // Cliff macro (sampled triplanar at ~60 m so crags keep their structure at a distance): vertical erosion flutes
    // (v runs up the face in the side projections), horizontal bedding and blocky fractures.
    float warp = pFbm( uv * vec2( 2.0, 1.0 ) + 3.1, vec2( 2.0, 1.0 ), 3 );
    float f1 = 1.0 - abs( 2.0 * pNoise( vec2( uv.x * 13.0 + warp * 3.0, uv.y * 2.0 ), vec2( 13.0, 2.0 ) ) - 1.0 );
    float f2 = 1.0 - abs( 2.0 * pNoise( vec2( uv.x * 29.0 + warp * 5.0, uv.y * 5.0 + 0.3 ), vec2( 29.0, 5.0 ) ) - 1.0 );
    float bed = pNoise( vec2( uv.x * 3.0 + warp * 1.5, uv.y * 11.0 ), vec2( 3.0, 11.0 ) );
    vec3 v = pVoronoi( uv * vec2( 4.0, 6.0 ) + vec2( warp * 0.7, 0.0 ), vec2( 4.0, 6.0 ) );
    float block = smoothstep( 0.0, 0.07, v.y - v.x );
    float grain = pFbm( uv * 24.0, vec2( 24.0 ), 3 );
    alb = 0.5 + ( f1 - 0.5 ) * 0.55 + ( f2 - 0.5 ) * 0.2 + ( bed - 0.5 ) * 0.45 + ( v.z - 0.5 ) * 0.2 + ( grain - 0.5 ) * 0.25 - ( 1.0 - block ) * 0.06;
    return ( f1 * 0.45 + f2 * 0.2 + bed * 0.2 + v.z * 0.15 ) * ( 0.85 + 0.15 * block );
  } else if ( kind == 1 ) {
    // Ground: grass and moss tussocks with fine blade speckle.
    vec3 v = pVoronoi( uv * 14.0, vec2( 14.0 ) );
    float tuft = 1.0 - smoothstep( 0.0, 0.75, v.x );
    float fine = pFbm( uv * 64.0, vec2( 64.0 ), 3 );
    float streak = pNoise( vec2( uv.x * 180.0, uv.y * 36.0 ), vec2( 180.0, 36.0 ) );
    alb = 0.5 + ( tuft - 0.5 ) * 0.45 + ( fine - 0.5 ) * 0.45 + ( streak - 0.5 ) * 0.25 + ( v.z - 0.5 ) * 0.3;
    return tuft * 0.6 + fine * 0.3 + streak * 0.1;
  }
  // Gravel: rounded pebbles of mixed stone and size, a few cobbles, fine grit between.
  vec3 v1 = pVoronoi( uv * 13.0, vec2( 13.0 ) );
  vec3 v2 = pVoronoi( uv * 34.0 + 0.37, vec2( 34.0 ) );
  float peb1 = sqrt( clamp( 1.0 - v1.x * v1.x * 3.0, 0.0, 1.0 ) ) * smoothstep( 0.0, 0.12, v1.y - v1.x );
  float peb2 = sqrt( clamp( 1.0 - v2.x * v2.x * 3.0, 0.0, 1.0 ) ) * smoothstep( 0.0, 0.1, v2.y - v2.x );
  float big = step( 0.62, v1.z );
  float grit = pFbm( uv * 96.0, vec2( 96.0 ), 2 );
  float h = max( peb1 * big, peb2 * 0.7 ) + grit * 0.15;
  float id = big > 0.5 && peb1 * big > peb2 * 0.7 ? v1.z : v2.z;
  alb = 0.5 + ( id - 0.5 ) * 1.05 + ( grit - 0.5 ) * 0.25 - ( 1.0 - smoothstep( 0.05, 0.35, h ) ) * 0.14;
  return h;
}
void main() {
  float e = 1.0 / texSize;
  float alb, a2;
  float h = heightFn( vUv, alb );
  float hx = heightFn( vUv + vec2( e, 0.0 ), a2 ) - heightFn( vUv - vec2( e, 0.0 ), a2 );
  float hy = heightFn( vUv + vec2( 0.0, e ), a2 ) - heightFn( vUv - vec2( 0.0, e ), a2 );
  float strength = kind == 0 ? 7.0 : kind == 1 ? 4.0 : kind == 3 ? 5.0 : 9.0;
  vec3 n = normalize( vec3( -hx * strength, -hy * strength, 1.0 ) );
  gl_FragColor = vec4( n.xy * 0.5 + 0.5, clamp( alb, 0.0, 1.0 ), clamp( h, 0.0, 1.0 ) );
}`;

export function createDetailTextures(renderer, runner, size = 512, anisotropy = 4) {
  const mat = passMaterial(DETAIL_FRAG, { kind: { value: 0 }, texSize: { value: size } });
  const aniso = Math.min(anisotropy, renderer.capabilities.getMaxAnisotropy());
  const make = (kind) => {
    const rt = new THREE.WebGLRenderTarget(size, size, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      generateMipmaps: true,
      depthBuffer: false,
      anisotropy: aniso,
    });
    mat.uniforms.kind.value = kind;
    runner.run(mat, rt);
    return rt;
  };
  const out = { rock: make(0), ground: make(1), gravel: make(2), cliff: make(3) };
  mat.dispose();
  return out;
}

// Static land-cover weights baked per DEM texel (same formulas as landcover.js / glsl.js TK_COVER), so the terrain
// fragment shader reads three textures instead of evaluating ~20 noises per pixel.
//   A: R forest density, G alder, B rock score (0.9..1.9 -> 0..1), A snow
//   B: R lake, G fireweed, B lupine, A 131 m macro variation
//   C: R drainage wetness, G 470 m macro variation, B 29 m variation, A scree
const COVER_FRAG = /* glsl */ `
${TK_NOISE_ALU}
${TK_COVER}
uniform highp sampler2D tkHeightTex;
uniform sampler2D tkInfo;
uniform sampler2D tkRegion;
uniform sampler2D tkDrain;
uniform sampler2D uHeightMap;
uniform float tkHalf;
uniform float tkSize;
uniform int tkWhich;
varying vec2 vUv;
void main() {
  ivec2 ij = ivec2( gl_FragCoord.xy );
  vec2 p = ( vUv * 2.0 - 1.0 ) * tkHalf;
  float h = texelFetch( tkHeightTex, ij, 0 ).r;
  vec4 info = texelFetch( tkInfo, ij, 0 );
  vec2 g = info.xy;
  float s = length( g );
  float sd = texture2D( uHeightMap, vUv ).g;
  vec3 reg = texture2D( tkRegion, vUv ).rgb;
  float wet = texture2D( tkDrain, vUv ).r;
  float forest = h > 0.0 ? tkForest( p, h, s, sd, reg.r, reg.g ) : 0.0;
  float score = tkRockScore( p, h, s, sd, info.z );
  if ( tkWhich == 0 ) {
    float alder = h > 0.0 ? tkAlder( p, h, s, forest, reg.g, wet ) : 0.0;
    float snow = tkSnow( p, h, g, s, reg.b, info.z );
    gl_FragColor = vec4( forest, alder, clamp( score - 0.9, 0.0, 1.0 ), snow );
  } else if ( tkWhich == 1 ) {
    float coarse = length( texelFetch( tkInfo, ij >> 3, 3 ).xy );
    float lake = smoothstep( 1.0, 1.6, h ) * ( 1.0 - smoothstep( 0.0015, 0.006, s ) ) * ( 1.0 - smoothstep( -60.0, -40.0, sd ) );
    lake *= 1.0 - smoothstep( 0.01, 0.03, coarse );
    float alpine = smoothstep( 95.0, 150.0, h );
    float meadow = ( 1.0 - alpine ) * ( 1.0 - smoothstep( 0.35, 0.7, s ) ) * smoothstep( 2.5, 5.0, h ) * ( 1.0 - forest ) * ( 1.0 - reg.g );
    float fire = smoothstep( 0.62, 0.8, tkNoise( p / 64.0 + vec2( 12.1, 5.3 ) ) ) * meadow;
    float lup = smoothstep( 0.7, 0.84, tkNoise( p / 48.0 + vec2( -3.7, 22.9 ) ) ) * meadow * ( 1.0 - smoothstep( 12.0, 40.0, h ) );
    float m2 = tkNoise( p / 131.0 + vec2( -8.3, 2.2 ) );
    gl_FragColor = vec4( lake, fire, lup, m2 );
  } else {
    float rock = smoothstep( ${COVER.rock0.toFixed(3)}, ${COVER.rock1.toFixed(3)}, score );
    float scree = h > 0.0 ? tkScree( p, h, s, rock, wet ) : 0.0;
    float m1 = tkNoise( p / 470.0 + vec2( 3.1, 9.7 ) );
    // Wavelengths stay >= ~3.5 texels (7.8 m) so the bake does not alias into a texel checker.
    float m3 = tkNoise( p / 29.0 + vec2( 1.7, -4.4 ) ) * 0.6 + tkNoise( p / 53.0 + vec2( -6.2, 3.3 ) ) * 0.4;
    gl_FragColor = vec4( wet, m1, m3, scree );
  }
}`;

export function createCoverTextures(renderer, runner, { heightTex, info, region, drain, heightMap, size, half, anisotropy = 4 }) {
  const mat = passMaterial(COVER_FRAG, {
    tkHeightTex: { value: heightTex },
    tkInfo: { value: info },
    tkRegion: { value: region },
    tkDrain: { value: drain },
    uHeightMap: { value: heightMap },
    tkHalf: { value: half },
    tkSize: { value: size },
    tkWhich: { value: 0 },
  });
  const make = (which) => {
    const rt = new THREE.WebGLRenderTarget(size, size, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.MirroredRepeatWrapping,
      wrapT: THREE.MirroredRepeatWrapping,
      generateMipmaps: true,
      depthBuffer: false,
      anisotropy: Math.min(anisotropy, renderer.capabilities.getMaxAnisotropy()),
    });
    mat.uniforms.tkWhich.value = which;
    runner.run(mat, rt);
    return rt;
  };
  const out = { a: make(0), b: make(1), c: make(2) };
  mat.dispose();
  return out;
}
