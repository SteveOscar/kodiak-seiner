// Wildlife spray: whale blows, breach crowns and falling sheets, bear and diving-bird splashes. One instanced draw of
// camera-facing quads (render band 200, depthWrite false). Particles are written once into a ring buffer at spawn and
// animated on the GPU (ballistic with drag, gravity per kind, wind drift for mist), so the CPU pays only for spawns.
//
// Readability (SPEC §9 "a distant blow"): each burst scales about its emitter as a whole to at least k × distance
// (blows k = 0.0055 of their real height, splashes 0.004), and blows are fogged at half density, so a humpback's
// blow still reads kilometres away, glowing when backlit at golden hour.

import * as THREE from 'three';

const CAP = 3072;
export const KIND = { droplet: 0, sheet: 1, mist: 2, blow: 3 };

const VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec4 aP; // spawn position, start time
attribute vec4 aV; // velocity, drag
attribute vec4 aL; // life, size0, size1, kind
attribute vec4 aO; // emitter origin, reference size
uniform float uTime;
uniform vec3 uWind;
varying vec2 vQ;
varying float vAlpha;
varying float vKind;
varying vec3 vWorld;
varying float vSeed;
varying float vT;
void main() {
  float age = uTime - aP.w;
  float life = aL.x;
  vKind = aL.w;
  if ( age < 0.0 || age > life ) { gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 ); vAlpha = 0.0; return; }
  float t = age / life;
  float kind = aL.w;
  float drag = aV.w;
  float e = drag > 0.0 ? ( 1.0 - exp( - drag * age ) ) / drag : age;
  vec3 p = aP.xyz + aV.xyz * e;
  float g = kind < 0.5 ? 9.81 : kind < 1.5 ? 7.5 : kind < 2.5 ? -0.25 : -0.45;
  p.y -= 0.5 * g * age * age;
  if ( kind > 1.5 ) p += uWind * ( age * ( kind > 2.5 ? 0.6 : 0.4 ) * smoothstep( 0.0, 0.35, t ) );
  float d = distance( aO.xyz, cameraPosition );
  float S = max( 1.0, ( kind > 2.5 ? 0.0055 : 0.004 ) * d / max( aO.w, 0.05 ) );
  p = aO.xyz + ( p - aO.xyz ) * S;
  float size = mix( aL.y, aL.z, kind > 1.5 ? sqrt( t ) : t ) * S;
  float alpha;
  if ( kind < 0.5 ) alpha = ( 1.0 - t * t ) * 0.9;
  else if ( kind < 1.5 ) alpha = smoothstep( 0.0, 0.06, t ) * ( 1.0 - t * t ) * 0.75;
  else if ( kind < 2.5 ) alpha = smoothstep( 0.0, 0.12, t ) * ( 1.0 - t ) * ( 1.0 - t ) * 0.32;
  else alpha = smoothstep( 0.0, 0.04, t ) * pow( 1.0 - t, 1.6 ) * 0.6;
  // Droplets and sheets that fall back through the surface are gone.
  if ( kind < 1.5 && p.y < aO.y - 0.1 * S && age > 0.08 ) alpha = 0.0;
  vec4 mvPosition = viewMatrix * vec4( p, 1.0 );
  mvPosition.xy += position.xy * size;
  gl_Position = projectionMatrix * mvPosition;
  vQ = position.xy;
  vAlpha = alpha;
  vWorld = p;
  vSeed = fract( aP.x * 0.137 + aP.z * 0.271 + aP.w * 1.37 );
  vT = t;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uHorizonColor;
uniform float uDaylight;
varying vec2 vQ;
varying float vAlpha;
varying float vKind;
varying vec3 vWorld;
varying float vSeed;
varying float vT;
float kwHash( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
float kwNoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( kwHash( i ), kwHash( i + vec2( 1.0, 0.0 ) ), u.x ), mix( kwHash( i + vec2( 0.0, 1.0 ) ), kwHash( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}
void main() {
  float r2 = dot( vQ, vQ );
  if ( r2 > 1.0 || vAlpha < 0.002 ) discard;
  float shape;
  if ( vKind < 0.5 ) shape = exp( - r2 * 3.2 ) * ( 1.0 - r2 );
  else if ( vKind < 1.5 ) shape = ( 1.0 - smoothstep( 0.25, 1.0, r2 ) ) * ( 0.45 + 0.55 * kwNoise( vQ * 3.0 + vSeed * 31.0 ) );
  else {
    float n = kwNoise( vQ * 2.2 + vSeed * 17.0 + vT * 1.5 ) * 0.6 + kwNoise( vQ * 5.0 - vSeed * 9.0 ) * 0.4;
    shape = ( 1.0 - smoothstep( 0.0, 1.0, r2 ) ) * smoothstep( 0.15, 0.75, n + 0.35 * ( 1.0 - r2 ) );
  }
  float a = vAlpha * shape;
  if ( a < 0.003 ) discard;
  vec3 V = normalize( vWorld - cameraPosition );
  vec3 L = normalize( uSunDir );
  float c = dot( V, L );
  // Henyey-Greenstein forward scattering: backlit spray and blows glow toward the sun.
  float gg = vKind > 1.5 ? 0.72 : 0.55;
  float hg = ( 1.0 - gg * gg ) / pow( 1.0 + gg * gg - 2.0 * gg * c, 1.5 );
  // Spray is white: the sun's hue is softened, and it never reads darker than the horizon haze behind it.
  vec3 sunC = mix( uSunColor, vec3( dot( uSunColor, vec3( 0.2126, 0.7152, 0.0722 ) ) ), 0.35 );
  vec3 sun = sunC * 3.14159 * step( -0.02, L.y ) * ( 0.6 + 0.3 * hg );
  vec3 amb = uSkyColor * 1.4 + uHorizonColor * 0.35;
  vec3 col = vec3( 0.95, 0.97, 1.0 ) * ( sun + amb ) * 0.55;
  col = max( col, uHorizonColor * ( vKind < 1.5 ? 1.35 : 1.1 ) );
  gl_FragColor = vec4( col, a );
#if defined( KODIAK_SKY_FOG ) && defined( USE_FOG ) && defined( FOG_EXP2 )
  gl_FragColor.rgb = kodiakApplyFog( gl_FragColor.rgb, vWorld, fogColor, fogDensity * ( vKind > 2.5 ? 0.5 : 0.8 ) );
#else
  #include <fog_fragment>
#endif
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createFx(ctx) {
  const U = ctx.uniforms;
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const P = new Float32Array(CAP * 4).fill(-1e4);
  const V = new Float32Array(CAP * 4);
  const Li = new Float32Array(CAP * 4);
  const O = new Float32Array(CAP * 4);
  const attrs = [
    ['aP', P],
    ['aV', V],
    ['aL', Li],
    ['aO', O],
  ].map(([n, a]) => {
    const at = new THREE.InstancedBufferAttribute(a, 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute(n, at);
    return at;
  });
  geo.instanceCount = CAP;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  const wind = { value: new THREE.Vector3() };
  const skyFog = THREE.ShaderChunk.kodiak_sky_fog_pars ? { KODIAK_SKY_FOG: '' } : {};
  const mat = new THREE.ShaderMaterial({
    name: 'wildlife-spray',
    defines: skyFog,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {}]),
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    fog: true,
  });
  Object.assign(mat.uniforms, {
    uTime: U.uTime,
    uWind: wind,
    uSunDir: U.uSunDir,
    uSunColor: U.uSunColor,
    uSkyColor: U.uSkyColor,
    uHorizonColor: U.uHorizonColor,
    uDaylight: U.uDaylight,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'wildlife-spray';
  mesh.frustumCulled = false;
  mesh.renderOrder = 200;
  mesh.visible = false;
  ctx.scene.add(mesh);

  let head = 0;
  let aliveUntil = -1;
  let dirtyMin = CAP;
  let dirtyMax = -1;
  let spawned = 0;

  function emit(x, y, z, vx, vy, vz, drag, life, s0, s1, kind, ox, oy, oz, ref, delay = 0) {
    const i = head;
    head = (head + 1) % CAP;
    const t = U.uTime.value + delay;
    P.set([x, y, z, t], i * 4);
    V.set([vx, vy, vz, drag], i * 4);
    Li.set([life, s0, s1, kind], i * 4);
    O.set([ox, oy, oz, ref], i * 4);
    if (i < dirtyMin) dirtyMin = i;
    if (i > dirtyMax) dirtyMax = i;
    aliveUntil = Math.max(aliveUntil, t + life);
    spawned++;
  }

  const R = Math.random;
  const fx = {
    // Humpback (height ~4.5 m, bushy) or orca (~2 m, narrow) blow at the blowhole.
    blow(x, y, z, { height = 4.5, width = 1, heading = 0 } = {}) {
      const n = Math.round(22 + height * 5);
      const hx = Math.sin(heading) * 0.35;
      const hz = -Math.cos(heading) * 0.35;
      for (let i = 0; i < n; i++) {
        const u = i / n;
        const up = height * (2.1 + 0.5 * R()) * (1 - 0.35 * u);
        const spread = (0.28 + 0.2 * R()) * width;
        const a = R() * Math.PI * 2;
        const delay = u * 0.45;
        emit(x + (R() - 0.5) * 0.3, y + 0.2, z + (R() - 0.5) * 0.3, Math.cos(a) * spread * up * 0.28 + hx, up, Math.sin(a) * spread * up * 0.28 + hz, 1.6 + R() * 0.6, 3.2 + R() * 1.6, 0.25 * width + 0.1 * height * 0.1, (0.55 + 0.35 * R()) * height * 0.32 * width + 0.4, KIND.blow, x, y, z, height, delay);
      }
      // A few heavier droplets falling out of the column.
      for (let i = 0; i < 10; i++) {
        const a = R() * Math.PI * 2;
        emit(x, y + height * 0.6 * R(), z, Math.cos(a) * 1.2, 2 + R() * 3, Math.sin(a) * 1.2, 0.4, 1.2 + R() * 0.6, 0.06, 0.04, KIND.droplet, x, y, z, height, 0.2);
      }
    },
    // Crown splash: `size` metres across (bear pounce ~1.5, bird dive ~0.5, breach ~14).
    splash(x, y, z, { size = 1, count = null, up = 1, mist = true } = {}) {
      const n = count ?? Math.round(10 + size * 8);
      for (let i = 0; i < n; i++) {
        const a = R() * Math.PI * 2;
        const sp = size * (0.8 + 1.4 * R());
        const vy = up * Math.sqrt(size) * (2.2 + 3.6 * R());
        emit(x + Math.cos(a) * size * 0.2, y, z + Math.sin(a) * size * 0.2, Math.cos(a) * sp, vy, Math.sin(a) * sp, 0.8, 0.7 + 0.5 * R() * Math.sqrt(size), size * 0.06 + 0.03, size * 0.04 + 0.02, KIND.droplet, x, y, z, size);
      }
      for (let i = 0; i < Math.round(n * 0.5); i++) {
        const a = R() * Math.PI * 2;
        const sp = size * (0.5 + 0.8 * R());
        emit(x, y, z, Math.cos(a) * sp, up * Math.sqrt(size) * (1.6 + 2.2 * R()), Math.sin(a) * sp, 1.2, 0.8 + 0.6 * R() * Math.sqrt(size), size * 0.14 + 0.05, size * 0.22 + 0.08, KIND.sheet, x, y, z, size);
      }
      if (mist) {
        for (let i = 0; i < Math.round(4 + size * 2); i++) {
          const a = R() * Math.PI * 2;
          const r = size * (0.2 + 0.5 * R());
          emit(x + Math.cos(a) * r, y + 0.25 * size * R(), z + Math.sin(a) * r, Math.cos(a) * size * 0.35, size * (0.3 + 0.6 * R()), Math.sin(a) * size * 0.35, 1.4, 2.2 + 2.2 * R(), size * 0.18 + 0.1, size * 0.5 + 0.4, KIND.mist, x, y, z, size, 0.15 * R());
        }
      }
    },
    // Water streaming off a rising body (breach exit): a sheet of drops at (x, y, z) moving with the body.
    shed(x, y, z, vx, vy, vz, size = 1) {
      for (let i = 0; i < 3; i++) {
        emit(x + (R() - 0.5) * size, y, z + (R() - 0.5) * size, vx * 0.6 + (R() - 0.5) * 2, vy * 0.5 + R(), vz * 0.6 + (R() - 0.5) * 2, 0.6, 0.9 + 0.5 * R(), 0.15 * size, 0.1 * size, KIND.sheet, x, y, z, 8);
      }
    },
    update() {
      const w = U.uWindDir?.value;
      const ws = U.uWindSpeed?.value ?? 5;
      if (w) wind.value.set(w.x * ws, 0, w.y * ws);
      mesh.visible = U.uTime.value < aliveUntil;
      if (dirtyMax >= dirtyMin) {
        for (const a of attrs) {
          a.clearUpdateRanges();
          a.addUpdateRange(dirtyMin * 4, (dirtyMax - dirtyMin + 1) * 4);
          a.needsUpdate = true;
        }
        dirtyMin = CAP;
        dirtyMax = -1;
      }
    },
    get active() {
      return mesh.visible;
    },
    get spawned() {
      return spawned;
    },
    mesh,
  };
  return fx;
}
