// Wildlife spray: whale blows, breach eruptions, water streaming off a breaching body, fluke drips, bear and
// diving-bird splashes. One instanced draw of camera-facing quads (render band 200, depthWrite false). Particles are
// written once into a ring buffer at spawn and animated on the GPU (ballistic with drag, per-kind gravity, wind drift
// for mist), so the CPU pays only for spawns.
//
// Look: droplets are motion-streaked along their screen velocity; sheets are ragged, noise-broken chunks of white
// water; mist and blows are soft puffs lit as little spheres (wrap diffuse from the key light, Henyey-Greenstein
// forward scattering so backlit spray glows at golden hour, sky ambient from below). Lighting follows WP-SKY's mist
// (uSkyColor ambient + uSunColor * PI key radiance) so the spray sits in the same light as the sky's own vapour.
//
// Readability (SPEC §9 "a distant blow"): each burst scales about its emitter to at least k x distance (blows
// k = 0.022, about fifteen pixels tall at any range beyond ~200 m; splashes 0.004), and blows are fogged at half density,
// so a humpback's blow still reads kilometres away.

import * as THREE from 'three';

const CAP = 4096;
export const KIND = { droplet: 0, sheet: 1, mist: 2, blow: 3 };

const VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec4 aP; // spawn position, start time
attribute vec4 aV; // velocity, drag
attribute vec4 aL; // life, size0, size1, kind
attribute vec4 aO; // emitter origin, reference size
attribute vec4 aX; // streak factor, gravity, seed, opacity
uniform float uTime;
uniform vec3 uWind;
varying vec2 vQ;
varying vec2 vQv;
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
  float g = aX.y;
  float ex = exp( - drag * age );
  float e = drag > 0.0 ? ( 1.0 - ex ) / drag : age;
  vec3 p = aP.xyz + aV.xyz * e;
  p.y -= 0.5 * g * age * age;
  vec3 vel = aV.xyz * ex - vec3( 0.0, g * age, 0.0 );
  if ( kind > 1.5 ) {
    vec3 w = uWind * ( age * ( kind > 2.5 ? 0.55 : 0.4 ) * smoothstep( 0.0, 0.35, t ) );
    p += w;
  }
  float d = distance( aO.xyz, cameraPosition );
  float S = max( 1.0, ( kind > 2.5 ? 0.022 : 0.004 ) * d / max( aO.w, 0.05 ) );
  p = aO.xyz + ( p - aO.xyz ) * S;
  float size = mix( aL.y, aL.z, kind > 1.5 ? sqrt( t ) : t ) * S;
  float alpha;
  if ( kind < 0.5 ) alpha = ( 1.0 - t * t ) * 0.9;
  else if ( kind < 1.5 ) alpha = smoothstep( 0.0, 0.05, t ) * ( 1.0 - t * t ) * 0.8;
  else if ( kind < 2.5 ) alpha = smoothstep( 0.0, 0.1, t ) * ( 1.0 - t ) * ( 1.0 - t ) * 0.34;
  else alpha = smoothstep( 0.0, 0.03, t ) * pow( 1.0 - t, 1.8 ) * mix( 0.72, 0.95, smoothstep( 1.0, 4.0, S ) );
  alpha *= aX.w;
  // Water that falls back through the surface is gone.
  if ( kind < 1.5 && p.y < aO.y - 0.15 * S && age > 0.08 ) alpha = 0.0;
  vec4 mvPosition = viewMatrix * vec4( p, 1.0 );
  // Motion streak: stretch along the screen-space velocity (about a 1/25 s exposure), capped.
  vec2 vv = ( viewMatrix * vec4( vel, 0.0 ) ).xy;
  float sp = length( vv );
  vec2 dir = sp > 1e-3 ? vv / sp : vec2( 0.0, 1.0 );
  // Right-handed basis (perp, dir) keeps the quad's winding front-facing.
  vec2 perp = vec2( dir.y, -dir.x );
  float el = 1.0 + min( 9.0, aX.x * sp * S * 0.04 / max( size, 1e-3 ) );
  vec2 off = dir * position.y * size * el + perp * position.x * size;
  mvPosition.xy += off;
  gl_Position = projectionMatrix * mvPosition;
  vQ = position.xy;
  vQv = dir * position.y + perp * position.x;
  vAlpha = alpha;
  vWorld = p;
  vSeed = aX.z;
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
varying vec2 vQ;
varying vec2 vQv;
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
  float n = 0.0;
  if ( vKind < 0.5 ) {
    shape = pow( 1.0 - r2, 1.5 );
  } else if ( vKind < 1.5 ) {
    n = kwNoise( vQ * 2.6 + vSeed * 41.0 ) * 0.65 + kwNoise( vQ * 6.0 - vSeed * 13.0 ) * 0.35;
    shape = smoothstep( 1.0, 0.25, r2 ) * smoothstep( 0.2, 0.62, n + 0.3 * ( 1.0 - r2 ) - 0.15 * vT );
  } else {
    n = kwNoise( vQ * 2.1 + vSeed * 17.0 + vT * 1.3 ) * 0.55 + kwNoise( vQ * 4.7 - vSeed * 9.0 ) * 0.3 + kwNoise( vQ * 9.0 + vSeed * 5.0 ) * 0.15;
    // Wisps: the edge erodes as the puff ages, so old mist frays instead of hanging as a round ball.
    shape = ( 1.0 - smoothstep( 0.0, 1.0, r2 ) ) * smoothstep( 0.2 + 0.25 * vT, 0.75, n + 0.35 * ( 1.0 - r2 ) );
  }
  float a = vAlpha * shape;
  if ( a < 0.003 ) discard;
  // Each sprite shades as a small sphere: view-space normal from the quad position, taken to world space.
  vec3 nv = vec3( vQv, sqrt( max( 0.0, 1.0 - r2 ) ) );
  vec3 N = normalize( nv * mat3( viewMatrix ) );
  vec3 L = normalize( uSunDir );
  vec3 V = normalize( vWorld - cameraPosition );
  float c = dot( V, L );
  float sunUp = smoothstep( -0.04, 0.03, L.y );
  vec3 key = uSunColor * PI * sunUp;
  // Spray is white: soften the key's hue a little so golden light warms it without turning it orange.
  key = mix( key, vec3( dot( key, vec3( 0.2126, 0.7152, 0.0722 ) ) ), 0.25 );
  float up = 0.5 + 0.5 * N.y;
  vec3 col;
  if ( vKind > 1.5 ) {
    // Mist and blows are optically thin: mostly scattering (strongly forward, so a blow against the low sun
    // glows), little self-shading.
    float gg = 0.75;
    float hg = ( 1.0 - gg * gg ) / pow( 1.0 + gg * gg - 2.0 * gg * c, 1.5 );
    float diff = clamp( ( dot( N, L ) + 0.8 ) / 1.8, 0.0, 1.0 );
    col = ( uSkyColor * ( 0.8 + 0.3 * up ) + key * ( 0.25 + 0.3 * diff + 0.07 * hg ) ) * 0.85;
  } else {
    float gg = 0.55;
    float hg = ( 1.0 - gg * gg ) / pow( 1.0 + gg * gg - 2.0 * gg * c, 1.5 ) * 0.08;
    float wrap = vKind > 0.5 ? 0.2 : 0.35;
    float diff = clamp( ( dot( N, L ) + wrap ) / ( 1.0 + wrap ), 0.0, 1.0 );
    col = ( uSkyColor * ( 0.6 + 0.5 * up ) + key * ( 0.12 + 0.7 * diff + hg ) ) * ( vKind < 0.5 ? 0.9 : 0.86 );
    // Droplets catch glints of the sun.
    if ( vKind < 0.5 ) col += key * pow( max( 0.0, dot( reflect( V, N ), L ) ), 24.0 ) * 1.5;
  }
  gl_FragColor = vec4( col, a );
#if defined( KODIAK_SKY_FOG ) && defined( USE_FOG ) && defined( FOG_EXP2 )
  gl_FragColor.rgb = kodiakApplyFog( gl_FragColor.rgb, vWorld, fogColor, fogDensity * ( vKind > 2.5 ? 0.5 : 0.85 ) );
  // A blow always stands out a little brighter than the haze behind it (a readability cheat for distant blows
  // against a bright golden-hour horizon).
  if ( vKind > 2.5 ) gl_FragColor.rgb = max( gl_FragColor.rgb, kodiakFogTint( V, fogColor ) * 1.45 );
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
  const X = new Float32Array(CAP * 4);
  const attrs = [
    ['aP', P],
    ['aV', V],
    ['aL', Li],
    ['aO', O],
    ['aX', X],
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
    side: THREE.DoubleSide,
    fog: true,
  });
  Object.assign(mat.uniforms, {
    uTime: U.uTime,
    uWind: wind,
    uSunDir: U.uSunDir,
    uSunColor: U.uSunColor,
    uSkyColor: U.uSkyColor,
    uHorizonColor: U.uHorizonColor,
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
  const G = { droplet: 9.81, sheet: 7.5, mist: -0.2, blow: 0.35 };

  // One particle. o = emitter origin [x, y, z, refSize]; x = [streak, gravity, seed, opacity].
  function emit(x, y, z, vx, vy, vz, drag, life, s0, s1, kind, ox, oy, oz, ref, delay = 0, streak = 0, gravity = null, opacity = 1) {
    const i = head;
    head = (head + 1) % CAP;
    const t = U.uTime.value + delay;
    const o = i * 4;
    P[o] = x;
    P[o + 1] = y;
    P[o + 2] = z;
    P[o + 3] = t;
    V[o] = vx;
    V[o + 1] = vy;
    V[o + 2] = vz;
    V[o + 3] = drag;
    Li[o] = life;
    Li[o + 1] = s0;
    Li[o + 2] = s1;
    Li[o + 3] = kind;
    O[o] = ox;
    O[o + 1] = oy;
    O[o + 2] = oz;
    O[o + 3] = ref;
    X[o] = streak;
    X[o + 1] = gravity ?? (kind === KIND.droplet ? G.droplet : kind === KIND.sheet ? G.sheet : kind === KIND.mist ? G.mist : G.blow);
    X[o + 2] = Math.random();
    X[o + 3] = opacity;
    if (i < dirtyMin) dirtyMin = i;
    if (i > dirtyMax) dirtyMax = i;
    aliveUntil = Math.max(aliveUntil, t + life);
    spawned++;
  }

  const R = Math.random;
  const TAU = Math.PI * 2;
  const fx = {
    // Humpback (height ~4.5 m, bushy) or orca (~2 m, narrow) blow at the blowhole: a fast narrow jet, a bushy head
    // that blooms and slows at the top and drifts downwind, a lingering haze, and heavier drops falling out of it.
    blow(x, y, z, { height = 4.5, width = 1, heading = 0 } = {}) {
      const hx = Math.sin(heading) * 0.25;
      const hz = -Math.cos(heading) * 0.25;
      const drag = 2.4;
      for (let i = 0; i < 14; i++) {
        const v = height * drag * (1.0 + 0.25 * R());
        const a = R() * TAU;
        const spread = 0.05 * width;
        emit(x + (R() - 0.5) * 0.15, y + 0.1, z + (R() - 0.5) * 0.15, Math.cos(a) * spread * v + hx, v, Math.sin(a) * spread * v + hz, drag, 1.0 + 0.7 * R(), 0.12 * width + 0.04 * height, 0.35 * width + 0.08 * height, KIND.blow, x, y, z, height, i * 0.012, 0.25);
      }
      const n = Math.round(18 + height * 3);
      for (let i = 0; i < n; i++) {
        const u = i / n;
        const v = height * drag * (0.8 + 0.35 * R());
        const a = R() * TAU;
        const spread = (0.09 + 0.11 * R()) * width;
        const s0 = 0.2 * width + 0.05 * height;
        const s1 = (0.24 + 0.16 * R()) * height * width * 0.55 + 0.25;
        emit(x + (R() - 0.5) * 0.25 * width, y + 0.1, z + (R() - 0.5) * 0.25 * width, Math.cos(a) * spread * v + hx, v, Math.sin(a) * spread * v + hz, drag, 2.6 + R() * 1.8, s0, s1, KIND.blow, x, y, z, height, 0.04 + u * 0.3);
      }
      for (let i = 0; i < 6; i++) {
        const h = height * (0.45 + 0.5 * R());
        emit(x + (R() - 0.5) * width, y + h, z + (R() - 0.5) * width, (R() - 0.5) * 0.4, 0.25, (R() - 0.5) * 0.4, 1, 4.5 + 2 * R(), 0.12 * height * width + 0.3, 0.32 * height * width + 0.6, KIND.mist, x, y, z, height, 0.5 + R() * 0.4, 0, null, 0.55);
      }
      for (let i = 0; i < 16; i++) {
        const a = R() * TAU;
        emit(x, y + height * (0.4 + 0.5 * R()), z, Math.cos(a) * 1.2, 1 + R() * 2.5, Math.sin(a) * 1.2, 0.3, 1.1 + R() * 0.6, 0.035, 0.03, KIND.droplet, x, y, z, height, 0.3 + R() * 0.3, 1);
      }
    },
    // Crown splash `size` metres across (bear pounce ~1.5, bird dive ~0.5, sea lion ~1.6).
    splash(x, y, z, { size = 1, count = null, up = 1, mist = true } = {}) {
      const n = count ?? Math.round(12 + size * 10);
      for (let i = 0; i < n; i++) {
        const a = R() * TAU;
        const sp = size * (0.6 + 1.3 * R());
        const vy = up * Math.sqrt(size) * (2.2 + 3.4 * R());
        emit(x + Math.cos(a) * size * 0.2, y, z + Math.sin(a) * size * 0.2, Math.cos(a) * sp, vy, Math.sin(a) * sp, 0.6, 0.6 + 0.5 * R() * Math.sqrt(size), 0.02 + size * 0.018, 0.015 + size * 0.012, KIND.droplet, x, y, z, size, 0, 1);
      }
      for (let i = 0; i < Math.round(n * 0.35); i++) {
        const a = R() * TAU;
        const sp = size * (0.4 + 0.7 * R());
        emit(x, y, z, Math.cos(a) * sp, up * Math.sqrt(size) * (1.4 + 2.2 * R()), Math.sin(a) * sp, 1.2, 0.6 + 0.5 * R() * Math.sqrt(size), size * 0.12 + 0.04, size * 0.22 + 0.06, KIND.sheet, x, y, z, size, 0, 0.3);
      }
      if (mist) {
        for (let i = 0; i < Math.round(3 + size * 1.5); i++) {
          const a = R() * TAU;
          const r = size * (0.2 + 0.5 * R());
          emit(x + Math.cos(a) * r, y + 0.25 * size * R(), z + Math.sin(a) * r, Math.cos(a) * size * 0.3, size * (0.3 + 0.5 * R()), Math.sin(a) * size * 0.3, 1.4, 1.8 + 1.8 * R(), size * 0.2 + 0.1, size * 0.5 + 0.3, KIND.mist, x, y, z, size, 0.1 * R(), 0, null, 0.8);
        }
      }
    },
    // A humpback landing after a breach (`heading` = its travel): jets of white water erupting along the falling
    // body, a ragged crown thrown out all round, a rain of streaking drops, and (a moment later) a slow drifting pall
    // of mist.
    breach(x, y, z, { heading = 0, scale = 1 } = {}) {
      const fx_ = Math.sin(heading);
      const fz = -Math.cos(heading);
      const k = scale;
      const ref = 12 * k;
      const rk = Math.sqrt(k);
      // Entry jets along the body, tallest at the chest.
      [-5, -2.5, 0, 2.5, 5].forEach((s, j) => {
        const px = x + fx_ * s * k;
        const pz = z + fz * s * k;
        const tall = 1 - Math.abs(s + 1) / 8;
        for (let i = 0; i < 20; i++) {
          const a = R() * TAU;
          const v = (8 + 9 * R()) * rk * (0.6 + 0.5 * tall);
          const sp = 0.06 + 0.2 * R();
          emit(px + (R() - 0.5) * 2.2 * k, y, pz + (R() - 0.5) * 2.2 * k, Math.cos(a) * sp * v, v, Math.sin(a) * sp * v, 0.5, 1.4 + 1.0 * R(), (0.35 + 0.35 * R()) * k, (1.0 + 0.9 * R()) * k, KIND.sheet, x, y, z, ref, j * 0.04 + R() * 0.12, 0.55);
        }
      });
      // The crown: sheets thrown outward and up all round.
      for (let i = 0; i < 80; i++) {
        const a = R() * TAU;
        const sp = (3 + 6 * R()) * rk;
        const along = (R() - 0.5) * 11 * k;
        const px = x + fx_ * along + Math.cos(a) * 2 * k;
        const pz = z + fz * along + Math.sin(a) * 2 * k;
        emit(px, y, pz, Math.cos(a) * sp, (3 + 6 * R()) * rk, Math.sin(a) * sp, 0.6, 1.0 + 0.9 * R(), (0.3 + 0.35 * R()) * k, (0.8 + 0.8 * R()) * k, KIND.sheet, x, y, z, ref, 0.08 + R() * 0.25, 0.45);
      }
      // Drops everywhere.
      for (let i = 0; i < 560; i++) {
        const a = R() * TAU;
        const sp = (1.5 + 8 * R()) * rk;
        const along = (R() - 0.5) * 12 * k;
        emit(x + fx_ * along, y + R() * 1.5 * k, z + fz * along, Math.cos(a) * sp, (4 + 13 * R()) * rk, Math.sin(a) * sp, 0.2, 1.3 + 1.3 * R(), 0.075 * k, 0.06 * k, KIND.droplet, x, y, z, ref, R() * 0.45, 1);
      }
      // The pall of mist left hanging and drifting.
      for (let i = 0; i < 18; i++) {
        const a = R() * TAU;
        const r = (1 + 6 * R()) * k;
        const along = (R() - 0.5) * 10 * k;
        emit(x + Math.cos(a) * r + fx_ * along, y + (0.5 + 4 * R()) * k, z + Math.sin(a) * r + fz * along, Math.cos(a) * 1.2, 1 + 2.5 * R(), Math.sin(a) * 1.2, 0.8, 4 + 4 * R(), (1.6 + 1.2 * R()) * k, (4.5 + 3.5 * R()) * k, KIND.mist, x, y, z, ref, 0.6 + R() * 0.9, 0, null, 0.38);
      }
    },
    // Water pouring off a rising body at (x, y, z) moving with velocity (vx, vy, vz): falling streaks and small sheets.
    shed(x, y, z, vx, vy, vz, size = 1, count = 4) {
      for (let i = 0; i < count; i++) {
        emit(x + (R() - 0.5) * size, y + (R() - 0.5) * size * 0.5, z + (R() - 0.5) * size, vx * 0.7 + (R() - 0.5) * 1.5, vy * 0.6 - R() * 1.5, vz * 0.7 + (R() - 0.5) * 1.5, 0.3, 0.9 + 0.6 * R(), 0.05 * size + 0.04, 0.04 * size + 0.03, KIND.droplet, x, y, z, 8, 0, 1.2);
      }
      emit(x, y, z, vx * 0.6 + (R() - 0.5) * 1.5, vy * 0.5, vz * 0.6 + (R() - 0.5) * 1.5, 0.8, 0.8 + 0.5 * R(), 0.25 * size, 0.45 * size, KIND.sheet, x, y, z, 8, 0, 0.6, null, 0.7);
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
