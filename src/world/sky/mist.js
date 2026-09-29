// Low cloud and mist banks (render band 300): ellipsoidal volumes placed by mistSites.js, drawn in one instanced
// draw. Each instance rasterises its ellipsoid's front faces (so anything in front of a bank occludes it correctly)
// and ray-marches a 3D-noise density inside, stopping at the terrain or the sea via uHeightMap. Density hugs the
// ground for mountain banks and the water for bay fog, so banks wrap slopes and pool in bays instead of reading as
// sprites. When the camera enters a bank its instance fades and the sky raises the global fog instead.

import * as THREE from 'three';
import { findMistSites, sitePresence } from './mistSites.js';

const MAX_INSTANCES = 44;
const VIEW_RANGE = 9500;

export function createMist(ctx, rng, mistNoiseTexture, fogUniforms, coverTexture) {
  const { uniforms, heightmap } = ctx;
  const sites = findMistSites(heightmap, rng, { peakSpacing: 420, maxPeaks: 320 });
  const presence = new Float32Array(sites.length);
  const target = new Float32Array(sites.length);

  const geo = new THREE.IcosahedronGeometry(1, 2);
  const params = new Float32Array(MAX_INSTANCES * 4);
  const paramAttr = new THREE.InstancedBufferAttribute(params, 4);
  paramAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aParams', paramAttr);

  const mistUniforms = {
    ...fogUniforms,
    fogColor: uniforms.uFogColor,
    fogDensity: uniforms.uFogDensity,
    uMistNoise: { value: mistNoiseTexture },
    uCoverNoise: { value: coverTexture },
    uHeightMap: uniforms.uHeightMap,
    uTerrainShadow: uniforms.uTerrainShadow,
    uWorldHalf: uniforms.uWorldHalf,
    uKeyDir: uniforms.uSunDir,
    uKeyColor: uniforms.uSunColor,
    uSkyColor: uniforms.uSkyColor,
    uTime: uniforms.uTime,
    uDrift: { value: new THREE.Vector3() },
    uDensity: { value: 1 },
    uOverhead: { value: 0 },
  };
  const material = new THREE.ShaderMaterial({
    name: 'sky-mist',
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.FrontSide,
    uniforms: mistUniforms,
    vertexShader: /* glsl */ `
      attribute vec4 aParams;
      varying vec3 vWorld;
      varying vec3 vCenter;
      varying vec3 vRadii;
      varying vec4 vParams;
      void main() {
        mat4 im = instanceMatrix;
        vCenter = im[ 3 ].xyz;
        vRadii = vec3( length( im[ 0 ].xyz ), length( im[ 1 ].xyz ), length( im[ 2 ].xyz ) );
        vParams = aParams;
        // The proxy is a little larger than the analytic ellipsoid so the polygon never clips it.
        vec4 wp = modelMatrix * im * vec4( position * 1.09, 1.0 );
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp sampler3D;
      uniform sampler3D uMistNoise;
      uniform sampler2D uCoverNoise;
      uniform sampler2D uHeightMap;
      uniform sampler2D uTerrainShadow;
      uniform float uWorldHalf;
      uniform vec3 uKeyDir;
      uniform vec3 uKeyColor;
      uniform vec3 uSkyColor;
      uniform vec3 fogColor;
      uniform float fogDensity;
      uniform vec3 uDrift;
      uniform float uDensity;
      uniform float uOverhead;
      varying vec3 vWorld;
      varying vec3 vCenter;
      varying vec3 vRadii;
      varying vec4 vParams;
      #include <kodiak_sky_fog_pars>

      // White-noise jitter: structured (interleaved-gradient) dithers show as hatching over the long chords.
      float hash12( vec2 p ) {
        vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
        p3 += dot( p3, p3.yzx + 33.33 );
        return fract( ( p3.x + p3.y ) * p3.z );
      }
      vec2 hmUv( vec2 xz ) { return ( xz + uWorldHalf ) / ( 2.0 * uWorldHalf ); }
      float groundAt( vec3 p ) { return max( textureLod( uHeightMap, hmUv( p.xz ), 1.0 ).r, 0.0 ); }

      void main() {
        vec3 ro = cameraPosition;
        vec3 rd = normalize( vWorld - ro );
        vec3 o = ( ro - vCenter ) / vRadii;
        vec3 d = rd / vRadii;
        float a = dot( d, d );
        float b = dot( o, d );
        float c = dot( o, o ) - 1.0;
        float disc = b * b - a * c;
        if ( disc <= 0.0 ) discard;
        float sq = sqrt( disc );
        float t0 = max( ( - b - sq ) / a, 0.0 );
        float t1 = ( - b + sq ) / a;
        if ( t1 <= t0 ) discard;
        float presence = vParams.x;
        float bay = vParams.y;
        float seed = vParams.z;
        // Fewer steps for banks that are small on screen.
        int nSteps = t0 > 4500.0 ? 6 : ( t0 > 1800.0 ? 9 : 13 );
        float dt = ( t1 - t0 ) / float( nSteps );
        float j = hash12( gl_FragCoord.xy + seed * 97.0 );
        float T = 1.0;
        vec3 L = vec3( 0.0 );
        float tSum = 0.0;
        float wSum = 0.0;
        float cosK = dot( rd, uKeyDir );
        float fwd = pow( max( cosK, 0.0 ), 6.0 );
        // Flattened phase function: thick mist scatters many times, so the back side is not dark.
        float phase = 0.5 + 1.7 * fwd + 0.25 * max( cosK, 0.0 );
        // Multiple scattering whitens a low, coloured sun inside the mist.
        vec3 keyW = mix( vec3( dot( uKeyColor, vec3( 0.2126, 0.7152, 0.0722 ) ) ), uKeyColor, 0.72 );
        // Terrain occlusion of the key light at the bank's middle (mist in a shadowed valley stays blue).
        // Four taps ~80 m apart: shadowed fog is a soft volume, not a sharp projected shape.
        vec3 pMid = ro + rd * ( 0.5 * ( t0 + t1 ) );
        float sh = texture2D( uTerrainShadow, hmUv( pMid.xz + vec2( 80.0, 30.0 ) ) ).r + texture2D( uTerrainShadow, hmUv( pMid.xz + vec2( -80.0, -30.0 ) ) ).r
          + texture2D( uTerrainShadow, hmUv( pMid.xz + vec2( -30.0, 80.0 ) ) ).r + texture2D( uTerrainShadow, hmUv( pMid.xz + vec2( 30.0, -80.0 ) ) ).r;
        float lit = mix( 1.0, sh * 0.25, 0.6 );
        vec3 keyRad = keyW * phase * lit;
        // Bays: a pool that thins toward a ragged, noisy top; its extent follows a slow 2D coverage field. Thin pools
        // (fine weather) are shallow and faint, so a clear morning keeps wisps on the water instead of a slab.
        vec2 cov2 = texture2D( uCoverNoise, vCenter.xz / 1900.0 + seed ).rg;
        float amount = clamp( presence / 0.6, 0.0, 1.0 );
        // Overhead gameplay camera (crow's nest): banks between the camera and the sea below fade so the set stays
        // readable; banks toward the horizon keep their look.
        float overhead = 1.0 - 0.92 * uOverhead * smoothstep( 0.2, 0.55, - rd.y );
        float tA = t0;
        vec3 pA = ro + rd * t0;
        float aboveA = pA.y - groundAt( pA );
        if ( aboveA < 0.0 ) discard;
        for ( int i = 0; i < 13; i ++ ) {
          if ( i >= nSteps ) break;
          float tB = t0 + float( i + 1 ) * dt;
          vec3 pB = ro + rd * tB;
          float aboveB = pB.y - groundAt( pB );
          bool hit = aboveB < 0.0;
          // The last segment is shortened to the terrain/sea crossing so a bank meets the ground with a clean edge.
          float seg = hit ? dt * aboveA / max( aboveA - aboveB, 1e-3 ) : dt;
          float k = 0.15 + 0.7 * fract( j + float( i ) * 0.618034 );
          float t = tA + seg * k;
          vec3 p = ro + rd * t;
          float above = mix( aboveA, hit ? 0.0 : aboveB, k );
          vec3 q = ( p - vCenter ) / vRadii;
          float r2 = dot( q, q );
          float edge = smoothstep( 1.0, 0.3, r2 );
          vec3 np = p * vec3( 1.0 / 560.0, 1.0 / 190.0, 1.0 / 560.0 ) + uDrift + seed * 7.0;
          float n = texture( uMistNoise, np ).r * 0.74 + texture( uMistNoise, np * 2.3 + vec3( 0.3, 0.1, 0.7 ) ).g * 0.36;
          float dens;
          float lift;
          if ( bay > 0.5 ) {
            vec2 cv = texture2D( uCoverNoise, p.xz / 1500.0 + seed * 3.1 ).rg;
            // The top height varies in plan (nearly constant through the layer's depth, so the march samples a smooth
            // field instead of speckle).
            float nt = texture( uMistNoise, p * vec3( 1.0 / 230.0, 1.0 / 900.0, 1.0 / 230.0 ) + uDrift * 1.7 + seed * 5.0 ).g;
            float top = vRadii.y * ( 0.3 + 0.8 * cv.r ) * ( 0.6 + 0.4 * amount ) * ( 0.4 + 1.2 * nt );
            float g = 1.0 - smoothstep( top * 0.2, top, p.y );
            float cover = smoothstep( 0.42, 0.78, n * 0.7 + cv.g * 0.35 + cov2.r * 0.25 + presence * 0.22 );
            // A soft foot where the pool meets the water, widening with distance: on glassy water the reflection has
            // no mist, so a crisp waterline reads as a hard white stripe.
            float foot = smoothstep( 0.0, 1.5 + t * 0.005, above );
            dens = g * cover * edge * foot * amount * 0.05;
            lift = clamp( p.y / max( top, 1.0 ), 0.0, 1.0 );
          } else {
            float hug = exp( - above / 70.0 ) * 0.85 + 0.3;
            float cover = max( 0.0, n * 1.3 - ( 1.12 - 0.5 * presence ) + edge * 0.55 - ( 1.0 - edge ) * 0.35 );
            dens = cover * edge * hug * ( 0.35 + 0.65 * presence ) * 0.011;
            lift = clamp( 0.5 + 0.5 * q.y + 0.25 * above / max( vRadii.y, 1.0 ), 0.0, 1.0 );
          }
          // Low presence thins the bank away entirely (clear days keep at most faint wisps).
          dens *= uDensity * smoothstep( 0.0, mix( 0.5, 0.12, bay ), presence ) * overhead;
          if ( dens > 1e-5 ) {
            float st = exp( - dens * seg );
            vec3 light = uSkyColor * ( 0.95 + 0.35 * lift ) + keyRad * ( 0.3 + 0.7 * lift );
            float w = T * ( 1.0 - st );
            L += w * light;
            tSum += w * t;
            wSum += w;
            T *= st;
          }
          if ( hit || T < 0.03 ) break;
          tA = tB;
          aboveA = aboveB;
        }
        float alpha = 1.0 - T;
        if ( alpha < 0.003 ) discard;
        // Distance fog on the bank itself (at its weighted depth), so far banks melt into the haze.
        float tm = wSum > 0.0 ? tSum / wSum : t0;
        vec3 pm = ro + rd * tm;
        float f = 1.0 - exp( - kodiakFogDepth( ro, pm, fogDensity ) );
        vec3 col = mix( L, kodiakFogTint( rd, fogColor ) * alpha, f );
        gl_FragColor = vec4( col, alpha );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });

  const mesh = new THREE.InstancedMesh(geo, material, MAX_INSTANCES);
  mesh.name = 'sky-mist';
  mesh.renderOrder = 300;
  mesh.frustumCulled = false;
  mesh.count = 0;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  ctx.scene.add(mesh);

  const active = []; // indices of sites currently drawn
  const tmpM = new THREE.Matrix4();
  const tmpS = new THREE.Vector3();
  const tmpP = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  let insideFog = 0;
  let insideTop = 0;
  let overhead = 0;
  let lastRefresh = -1e9;
  const lastCam = new THREE.Vector3(1e9, 0, 0);
  const drift = mistUniforms.uDrift.value;
  let forced = null;
  let lastEnv = null;

  // env: { mist, fog, cloudCover, hours, day, cloudBase, windSpeed, windX, windZ }
  function update(dt, realTime, env, camera) {
    // Crow's-nest view (high, looking down on the set): fade what lies between the camera and the sea.
    const mode = ctx.systems?.cameraRig?.mode;
    const want = mode === 'crowsnest' ? Math.min(1, Math.max(0, (camera.position.y - 20) / 30)) : 0;
    overhead += (want - overhead) * Math.min(1, (ctx.time?.realDt ?? dt) * 2.5);
    if (Math.abs(want - overhead) < 1e-3) overhead = want;
    mistUniforms.uOverhead.value = overhead;
    drift.x += (env.windX ?? 0) * dt / 420 * 0.6;
    drift.z += (env.windZ ?? 0) * dt / 420 * 0.6;
    drift.y += dt * 0.004;
    const cam = camera.position;
    const refresh = realTime - lastRefresh > 0.5 || cam.distanceToSquared(lastCam) > 150 * 150;
    lastEnv = env;
    if (refresh) {
      lastRefresh = realTime;
      lastCam.copy(cam);
      for (let i = 0; i < sites.length; i++) target[i] = forced ?? sitePresence(sites[i], env);
    }
    const k = Math.min(1, dt / 18);
    for (let i = 0; i < sites.length; i++) presence[i] += (target[i] - presence[i]) * (Math.abs(target[i] - presence[i]) > 0.9 ? 1 : k);
    return insideFog;
  }

  // Camera-dependent selection and back-to-front order; called from the pipeline's beforeRender.
  function prepare(camera) {
    const cam = camera.position;
    active.length = 0;
    insideFog = 0;
    insideTop = 0;
    for (let i = 0; i < sites.length; i++) {
      if (presence[i] < 0.02) continue;
      const s = sites[i];
      const dx = s.x - cam.x;
      const dz = s.z - cam.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > VIEW_RANGE * VIEW_RANGE) continue;
      // Inside (or grazing) the ellipsoid: hand over to the global fog.
      const ex = dx / s.rx;
      const ey = (s.y - cam.y) / s.ry;
      const ez = dz / s.rx;
      const e2 = ex * ex + ey * ey + ez * ez;
      const inside = 1 - Math.min(1, Math.max(0, (e2 - 0.8) / 0.7));
      if (inside > 0) {
        const f = inside * presence[i] * presence[i] * (s.kind === 'bay' ? 1 : 0.8) * (1 - 0.85 * overhead);
        if (f > insideFog) {
          insideFog = f;
          insideTop = s.y + s.ry * 0.8;
        }
      }
      const fade = 1 - inside;
      if (fade <= 0.01) continue;
      active.push({ i, d2, fade });
    }
    active.sort((a, b) => a.d2 - b.d2);
    if (active.length > MAX_INSTANCES) active.length = MAX_INSTANCES;
    active.reverse();
    for (let n = 0; n < active.length; n++) {
      const { i, fade } = active[n];
      const s = sites[i];
      tmpP.set(s.x, s.y, s.z);
      tmpS.set(s.rx, s.ry, s.rx * (0.8 + 0.4 * s.seed));
      quat.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, s.seed * Math.PI);
      tmpM.compose(tmpP, quat, tmpS);
      mesh.setMatrixAt(n, tmpM);
      params[n * 4] = presence[i] * fade;
      params[n * 4 + 1] = s.kind === 'bay' ? 1 : 0;
      params[n * 4 + 2] = s.seed;
      params[n * 4 + 3] = 0;
    }
    mesh.count = active.length;
    mesh.instanceMatrix.needsUpdate = true;
    paramAttr.needsUpdate = true;
    mesh.visible = active.length > 0;
  }

  return {
    mesh,
    sites,
    update,
    prepare,
    setDensity(v) {
      mistUniforms.uDensity.value = v;
    },
    debugActive() {
      return active.map(({ i, fade }) => {
        const s = sites[i];
        return { id: s.id, kind: s.kind, x: Math.round(s.x), y: Math.round(s.y), z: Math.round(s.z), rx: Math.round(s.rx), p: +(presence[i] * fade).toFixed(2) };
      });
    },
    get activeCount() {
      return active.length;
    },
    get insideFog() {
      return insideFog;
    },
    get insideTop() {
      return insideTop;
    },
    // 0..1: how far the overhead (crow's-nest) readability fade is engaged.
    get overhead() {
      return overhead;
    },
    // QA: pin every site's target presence (null restores weather-driven presence).
    debugForce(v) {
      forced = v;
      for (let i = 0; i < sites.length; i++) presence[i] = target[i] = v ?? sitePresence(sites[i], lastEnv ?? {});
    },
    snapPresence() {
      for (let i = 0; i < sites.length; i++) presence[i] = target[i];
    },
    refreshTargets(env) {
      for (let i = 0; i < sites.length; i++) target[i] = forced ?? sitePresence(sites[i], env);
    },
  };
}
