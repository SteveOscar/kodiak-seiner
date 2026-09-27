// Rain and drizzle streaks around the camera (render band 200). One instanced draw: every streak lives at a fixed
// world position inside a box that wraps around the camera, falls with the wind, and is stretched along its
// velocity in screen space. No per-frame CPU work beyond uniforms.

import * as THREE from 'three';

const MAX_DROPS = 14000;
const BOX = new THREE.Vector3(70, 36, 70);

export function createRain(ctx, rng) {
  const base = new THREE.InstancedBufferGeometry();
  // Quad: x = across (-1..1), y = along (0 = head, 1 = tail).
  base.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0], 3));
  base.setIndex([0, 1, 2, 0, 2, 3]);
  const seeds = new Float32Array(MAX_DROPS * 4);
  for (let i = 0; i < MAX_DROPS * 4; i++) seeds[i] = rng.next();
  base.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
  base.instanceCount = 0;
  base.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);

  const material = new THREE.ShaderMaterial({
    name: 'sky-rain',
    transparent: true,
    depthWrite: false,
    depthTest: true,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uBox: { value: BOX.clone() },
        uWind: { value: new THREE.Vector2() },
        uFall: { value: 8 },
        uLength: { value: 0.045 },
        uWidth: { value: 0.012 },
        uColor: { value: new THREE.Color() },
        uAlpha: { value: 0.3 },
        uFlash: { value: 0 },
      },
    ]),
    vertexShader: /* glsl */ `
      attribute vec4 aSeed;
      uniform float uTime;
      uniform vec3 uBox;
      uniform vec2 uWind;
      uniform float uFall;
      uniform float uLength;
      uniform float uWidth;
      varying vec2 vQuad;
      varying float vFade;
      #include <fog_pars_vertex>
      void main() {
        float speed = 0.8 + 0.4 * aSeed.w;
        vec3 vel = vec3( uWind.x, - uFall, uWind.y ) * speed;
        vec3 origin = cameraPosition - 0.5 * uBox;
        vec3 p = aSeed.xyz * uBox + vel * uTime;
        p = origin + mod( p - origin, uBox );
        vec3 tail = p - vel * uLength;
        vec4 hv = viewMatrix * vec4( p, 1.0 );
        vec4 tv = viewMatrix * vec4( tail, 1.0 );
        vec4 hc = projectionMatrix * hv;
        vec4 tc = projectionMatrix * tv;
        vec2 hs = hc.xy / hc.w;
        vec2 ts = tc.xy / tc.w;
        vec2 axis = hs - ts;
        float len = length( axis );
        vec2 across = len > 1e-5 ? vec2( - axis.y, axis.x ) / len : vec2( 1.0, 0.0 );
        vec4 mvPosition = mix( hv, tv, position.y );
        vec4 clip = projectionMatrix * mvPosition;
        float dist = - mvPosition.z;
        float w = uWidth * clamp( 1.0 / max( dist, 0.5 ), 0.0, 1.0 ) + 1.2 / 720.0;
        clip.xy += across * position.x * w * clip.w;
        gl_Position = clip;
        vQuad = position.xy;
        vec3 rel = p - cameraPosition;
        float edge = max( abs( rel.x ) / uBox.x, max( abs( rel.y ) / uBox.y, abs( rel.z ) / uBox.z ) ) * 2.0;
        vFade = smoothstep( 1.0, 0.7, edge ) * smoothstep( 1.2, 4.0, dist ) * ( hv.z < -0.3 ? 1.0 : 0.0 );
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uAlpha;
      uniform float uFlash;
      varying vec2 vQuad;
      varying float vFade;
      #include <fog_pars_fragment>
      void main() {
        float across = 1.0 - vQuad.x * vQuad.x;
        float along = smoothstep( 0.0, 0.25, vQuad.y ) * smoothstep( 1.0, 0.55, vQuad.y );
        float a = uAlpha * across * along * vFade;
        if ( a < 0.002 ) discard;
        gl_FragColor = vec4( uColor * ( 1.0 + 1.2 * uFlash ), a );
        #include <fog_fragment>
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new THREE.Mesh(base, material);
  mesh.name = 'sky-rain';
  mesh.frustumCulled = false;
  mesh.renderOrder = 200;
  mesh.visible = false;
  ctx.scene.add(mesh);

  const u = material.uniforms;
  return {
    mesh,
    // rain 0..1, wind vector (m/s toward), ambient/key colours, lightning flash 0..1, time (s).
    update(rain, windX, windZ, ambient, key, flash, time) {
      // Wrapped so float precision never degrades over a long session (a one-frame reshuffle every 10 min).
      u.uTime.value = time % 600;
      const q = ctx.quality?.name === 'low' ? 0.45 : 1;
      const n = Math.floor(MAX_DROPS * q * Math.min(1, rain * 1.1));
      base.instanceCount = n;
      mesh.visible = n > 16;
      if (!mesh.visible) return;
      const drizzle = 1 - Math.min(1, rain / 0.7);
      u.uFall.value = 8.5 - 4.5 * drizzle;
      u.uWind.value.set(windX * 0.85, windZ * 0.85);
      u.uLength.value = 0.075 - 0.03 * drizzle;
      u.uWidth.value = 0.009 - 0.003 * drizzle;
      u.uAlpha.value = 0.12 + 0.14 * rain;
      u.uColor.value.setRGB(ambient.r * 1.6 + key.r * 0.06, ambient.g * 1.6 + key.g * 0.06, ambient.b * 1.6 + key.b * 0.06);
      u.uFlash.value = flash;
    },
    dispose() {
      base.dispose();
      material.dispose();
    },
  };
}
