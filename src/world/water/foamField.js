// GPU foam and ripple fields around cameraRig.focus.
//
// Foam: a toroidally wrapped, world-anchored window (texel = world metres / size, uv = fract(xz / size)). Each frame:
//   1. one full-target pass multiplies every texel by its decay factor (4 s half-life foam, 18 s wake trail) and by
//      0 where the texel's world position has just entered the window (stale data from the far side);
//   2. this frame's foam stamps are drawn as instanced soft discs with MAX blending (foam is a level).
// No ping-pong copies are needed and moving the window costs nothing.
// Ripples: a smaller window centred on the focus (snapped to texels) cleared every frame; live rings (<= 128) are
// drawn additively as slope packets (rg) plus a little froth (b).

import { decayFactor, FOAM_HALF_LIFE, WAKE_HALF_LIFE, MAX_STAMPS_PER_FRAME } from './stamps.js';

const MAX_INSTANCES = MAX_STAMPS_PER_FRAME * 2;

const QUAD_VERT_FOAM = /* glsl */ `
attribute vec4 iStamp; // uv centre (x, y), radius in uv, strength
varying vec2 vQ;
varying float vS;
void main() {
  vQ = position.xy;
  vS = iStamp.w;
  vec2 p = iStamp.xy + position.xy * iStamp.z;
  gl_Position = vec4( p * 2.0 - 1.0, 0.0, 1.0 );
}
`;

const QUAD_FRAG_FOAM = /* glsl */ `
varying vec2 vQ;
varying float vS;
void main() {
  float r = length( vQ );
  float f = 1.0 - smoothstep( 0.3, 1.0, r );
  gl_FragColor = vec4( vS * f, vS * f * 0.85, 0.0, 0.0 );
}
`;

const DECAY_VERT = /* glsl */ `
void main() { gl_Position = vec4( position.xy, 0.0, 1.0 ); }
`;

const DECAY_FRAG = /* glsl */ `
uniform vec2 uDecay;      // foam, wake multipliers
uniform vec4 uWindow;     // new window min corner (x, z), old centre (x, z)
uniform float uSize;
uniform float uRes;
uniform float uReset;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 w = uWindow.xy + mod( uv * uSize - uWindow.xy, uSize );
  vec2 d = abs( w - uWindow.zw );
  float keep = ( d.x <= uSize * 0.5 && d.y <= uSize * 0.5 && uReset < 0.5 ) ? 1.0 : 0.0;
  gl_FragColor = vec4( uDecay.x * keep, uDecay.y * keep, 0.0, 0.0 );
}
`;

const RIPPLE_VERT = /* glsl */ `
attribute vec4 iRing;  // centre uv (x, y), extent in metres, ring radius (m)
attribute vec4 iRing2; // width (m), amplitude, froth, splash radius (m)
uniform float uSize;
varying vec2 vD;       // metres from the ring centre
varying vec4 vRing;
varying float vSplash;
void main() {
  vD = position.xy * iRing.z;
  vRing = vec4( iRing.w, iRing2.x, iRing2.y, iRing2.z );
  vSplash = iRing2.w;
  vec2 p = iRing.xy + vD / uSize;
  gl_Position = vec4( p * 2.0 - 1.0, 0.0, 1.0 );
}
`;

const RIPPLE_FRAG = /* glsl */ `
varying vec2 vD;
varying vec4 vRing; // radius, width, amplitude, froth
varying float vSplash;
void main() {
  float rho = length( vD );
  float x = ( rho - vRing.x ) / vRing.y;
  float g = exp( - x * x );
  // d/drho of amp * cos(2.4 x) * exp(-x^2)
  float dh = vRing.z * ( -2.4 * sin( 2.4 * x ) - 2.0 * x * cos( 2.4 * x ) ) * g / vRing.y;
  vec2 dir = vD / max( rho, 1e-3 );
  // Froth only where the drop or fish broke the surface, briefly; the ring itself is slope only.
  float splash = exp( - rho * rho / ( vSplash * vSplash ) );
  gl_FragColor = vec4( dir * dh, vRing.w * splash, 0.0 );
}
`;

export function createFoamField({ THREE, renderer, size = 1024, res = 1024, rippleSize = 512, rippleRes = 1024 }) {
  const rtOpts = {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  };
  const foamRT = new THREE.WebGLRenderTarget(res, res, { ...rtOpts, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping });
  const rippleRT = new THREE.WebGLRenderTarget(rippleRes, rippleRes, { ...rtOpts, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping });
  foamRT.texture.colorSpace = THREE.NoColorSpace;
  rippleRT.texture.colorSpace = THREE.NoColorSpace;

  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const tri = new THREE.BufferGeometry();
  tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const decayMat = new THREE.ShaderMaterial({
    vertexShader: DECAY_VERT,
    fragmentShader: DECAY_FRAG,
    uniforms: {
      uDecay: { value: new THREE.Vector2(1, 1) },
      uWindow: { value: new THREE.Vector4() },
      uSize: { value: size },
      uRes: { value: res },
      uReset: { value: 1 },
    },
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.ZeroFactor,
    blendDst: THREE.SrcColorFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.SrcAlphaFactor,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const decayMesh = new THREE.Mesh(tri, decayMat);
  decayMesh.frustumCulled = false;

  const quad = new THREE.BufferGeometry();
  quad.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  quad.setIndex([0, 1, 2, 0, 2, 3]);

  const stampGeo = new THREE.InstancedBufferGeometry();
  stampGeo.index = quad.index;
  stampGeo.setAttribute('position', quad.getAttribute('position'));
  const stampData = new Float32Array(MAX_INSTANCES * 4);
  const stampAttr = new THREE.InstancedBufferAttribute(stampData, 4);
  stampAttr.setUsage(THREE.DynamicDrawUsage);
  stampGeo.setAttribute('iStamp', stampAttr);
  stampGeo.instanceCount = 0;
  const stampMat = new THREE.ShaderMaterial({
    vertexShader: QUAD_VERT_FOAM,
    fragmentShader: QUAD_FRAG_FOAM,
    blending: THREE.CustomBlending,
    blendEquation: THREE.MaxEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const stampMesh = new THREE.Mesh(stampGeo, stampMat);
  stampMesh.frustumCulled = false;

  const RIPPLE_MAX = 128;
  const ringGeo = new THREE.InstancedBufferGeometry();
  ringGeo.index = quad.index;
  ringGeo.setAttribute('position', quad.getAttribute('position'));
  const ringData = new Float32Array(RIPPLE_MAX * 4);
  const ringData2 = new Float32Array(RIPPLE_MAX * 4);
  const ringAttr = new THREE.InstancedBufferAttribute(ringData, 4);
  const ringAttr2 = new THREE.InstancedBufferAttribute(ringData2, 4);
  ringAttr.setUsage(THREE.DynamicDrawUsage);
  ringAttr2.setUsage(THREE.DynamicDrawUsage);
  ringGeo.setAttribute('iRing', ringAttr);
  ringGeo.setAttribute('iRing2', ringAttr2);
  ringGeo.instanceCount = 0;
  const ringMat = new THREE.ShaderMaterial({
    vertexShader: RIPPLE_VERT,
    fragmentShader: RIPPLE_FRAG,
    uniforms: { uSize: { value: rippleSize } },
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const ringMesh = new THREE.Mesh(ringGeo, ringMat);
  ringMesh.frustumCulled = false;

  const state = {
    centreX: 0,
    centreZ: 0,
    valid: false,
    reset: true,
    rippleCentreX: 0,
    rippleCentreZ: 0,
    rippleValid: false,
    stampsDrawn: 0,
    ringsDrawn: 0,
  };
  const texel = size / res;
  const rtexel = rippleSize / rippleRes;
  const clearColor = new THREE.Color();

  // Pushes a stamp (world x, z, radius, strength) with toroidal duplicates where it crosses the texture edge.
  let nInst = 0;
  function pushStamp(x, z, r, s) {
    const u = (((x / size) % 1) + 1) % 1;
    const v = (((z / size) % 1) + 1) % 1;
    const ru = r / size;
    const us = [u];
    const vs = [v];
    if (u - ru < 0) us.push(u + 1);
    if (u + ru > 1) us.push(u - 1);
    if (v - ru < 0) vs.push(v + 1);
    if (v + ru > 1) vs.push(v - 1);
    for (const uu of us) {
      for (const vv of vs) {
        if (nInst >= MAX_INSTANCES) return;
        stampData.set([uu, vv, ru, s], nInst * 4);
        nInst++;
      }
    }
  }

  return {
    size,
    rippleSize,
    foamTexture: foamRT.texture,
    rippleTexture: rippleRT.texture,
    state,

    // Runs the frame's passes. focus: {x, z} window centre; queue: stamps.js queue; dt: sim seconds.
    render(focusX, focusZ, queue, dt) {
      const prevTarget = renderer.getRenderTarget();
      const prevAutoClear = renderer.autoClear;
      renderer.getClearColor(clearColor);
      const prevAlpha = renderer.getClearAlpha();
      const prevScissorTest = renderer.getScissorTest();
      renderer.autoClear = false;
      renderer.setScissorTest(false);

      // Foam window: snap to texels so the world-anchored lattice is stable.
      const cx = Math.round(focusX / texel) * texel;
      const cz = Math.round(focusZ / texel) * texel;
      const oldX = state.valid ? state.centreX : cx;
      const oldZ = state.valid ? state.centreZ : cz;
      const u = decayMat.uniforms;
      u.uDecay.value.set(decayFactor(dt, FOAM_HALF_LIFE), decayFactor(dt, WAKE_HALF_LIFE));
      u.uWindow.value.set(cx - size / 2, cz - size / 2, oldX, oldZ);
      u.uReset.value = state.reset ? 1 : 0;
      renderer.setRenderTarget(foamRT);
      if (state.reset) {
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, false, false);
      }
      renderer.render(decayMesh, cam);
      state.reset = false;
      state.centreX = cx;
      state.centreZ = cz;
      state.valid = true;
      queue.setCentre(cx, cz);

      nInst = 0;
      const n = queue.foamCount;
      for (let i = 0; i < n; i++) {
        const o = i * 4;
        pushStamp(queue.foam[o], queue.foam[o + 1], queue.foam[o + 2], queue.foam[o + 3]);
      }
      state.stampsDrawn = nInst;
      if (nInst > 0) {
        stampGeo.instanceCount = nInst;
        stampAttr.clearUpdateRanges();
        stampAttr.addUpdateRange(0, nInst * 4);
        stampAttr.needsUpdate = true;
        renderer.render(stampMesh, cam);
      }

      // Ripples.
      const rcx = Math.round(focusX / rtexel) * rtexel;
      const rcz = Math.round(focusZ / rtexel) * rtexel;
      state.rippleCentreX = rcx;
      state.rippleCentreZ = rcz;
      state.rippleValid = true;
      renderer.setRenderTarget(rippleRT);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, false, false);
      let nr = 0;
      const half = rippleSize / 2;
      queue.forEachRipple((x, z, age, radius, strength) => {
        if (nr >= RIPPLE_MAX) return;
        const speed = 0.55 + 0.06 * radius;
        const rr = 0.3 * radius + speed * age;
        const w = 0.45 + 0.035 * radius + 0.12 * age;
        const life = queue.rippleLife(radius);
        const fade = (1 - age / life) ** 2;
        const amp = strength * (0.05 + 0.004 * radius) * fade / (1 + 0.08 * rr);
        const froth = strength * Math.max(0, 1 - age / 1.5) ** 2 * 0.8;
        const ext = rr + 3 * w;
        if (Math.abs(x - rcx) > half + ext || Math.abs(z - rcz) > half + ext) return;
        ringData.set([(x - rcx) / rippleSize + 0.5, (z - rcz) / rippleSize + 0.5, ext, rr], nr * 4);
        ringData2.set([w, amp, froth, 0.3 + 0.3 * radius], nr * 4);
        nr++;
      });
      state.ringsDrawn = nr;
      if (nr > 0) {
        ringGeo.instanceCount = nr;
        ringAttr.needsUpdate = true;
        ringAttr2.needsUpdate = true;
        renderer.render(ringMesh, cam);
      }

      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(clearColor, prevAlpha);
      renderer.autoClear = prevAutoClear;
      renderer.setScissorTest(prevScissorTest);
    },

    reset() {
      state.reset = true;
    },

    dispose() {
      foamRT.dispose();
      rippleRT.dispose();
      decayMat.dispose();
      stampMat.dispose();
      ringMat.dispose();
      tri.dispose();
      quad.dispose();
      stampGeo.dispose();
      ringGeo.dispose();
    },
  };
}
