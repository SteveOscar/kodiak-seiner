// GPU stamp fields around cameraRig.focus: foam, the aerated wake trail, wake waves, and ripple rings.
//
// State: one toroidally wrapped, world-anchored window (texel = size / res metres, uv = fract(xz / size)), advanced
// by a single ping-pong pass per frame (moving the window costs nothing; texels that just entered it hold stale data
// from its far side and are zeroed):
//   r  foam level: this frame's foam stamps max-blended over the decayed field (4 s half-life), so stamping every
//      frame is frame-rate independent;
//   g  trail: churned, aerated water left by strong stamps only (prop wash, the skiff drop, brailing), decaying
//      slowly and diffusing, so a boat's track widens into a lingering pale band instead of a field of foam;
//   b  wake height (m) and a its vertical velocity: a damped 2D wave equation with a restoring term, forced by the
//      stamps as surface pressure (wakeSim.js holds the model, its constants and a CPU mirror for the tests). A
//      pressure patch moving faster than the wave speed leaves a Kelvin-like V whose interior rings with crests.
// This frame's stamps are first drawn into a force target (MAX blending): r = foam level, g = trail input, b = pressure.
// Only changes in pressure drive the waves (the pressure minus its moving average), so moving hulls,
// splashes and brailer dips make waves while steady stamps (a moored boat idling, drifting corklines) do
// not dig permanent dimples into the sea.
// Ripples: a smaller window centred on the focus (snapped to texels) cleared every frame; live rings (<= 128) are
// drawn additively as slope packets (rg) plus a little froth (b).

import { decayFactor, FOAM_HALF_LIFE, WAKE_HALF_LIFE, MAX_STAMPS_PER_FRAME } from './stamps.js';
import { WAKE, wakeParams } from './wakeSim.js';

const MAX_INSTANCES = MAX_STAMPS_PER_FRAME * 2;
const MIN_STEP = 1 / 40; // s between field steps

// Froth at the centre of a new ripple ring: none below strength 0.3, a brief white splash for big drops and dives.
export function rippleFroth(strength) {
  const t = Math.min(1, Math.max(0, (strength - 0.3) / 0.4));
  return strength * t * t * (3 - 2 * t) * 0.8;
}

const STAMP_VERT = /* glsl */ `
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

// r: foam level (soft disc), g: trail input (strong wash only), b: pressure (smooth bump). Weak stamps (corkline
// lace, the thin edges of a wash) barely push, so the waves come from hulls and splashes.
export const STAMP_FRAG = /* glsl */ `
varying vec2 vQ;
varying float vS;
void main() {
  float r = length( vQ );
  if ( r >= 1.0 ) discard;
  float f = 1.0 - smoothstep( 0.3, 1.0, r );
  float t = smoothstep( 0.15, 0.55, vS ) * 0.9;
  float b = 1.0 - r * r;
  gl_FragColor = vec4( vS * f, t * f, vS * smoothstep( 0.12, 0.45, vS ) * b * b, 0.0 );
}
`;

const FULL_VERT = /* glsl */ `
void main() { gl_Position = vec4( position.xy, 0.0, 1.0 ); }
`;

export const SIM_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uState;
uniform sampler2D uForce;
uniform sampler2D uPressureAvg;
uniform vec4 uWindow;   // new window min corner (x, z), old centre (x, z)
uniform vec2 uCentre;   // new centre (x, z)
uniform float uSize;
uniform float uRes;
uniform float uReset;
uniform vec2 uDecay;    // foam, trail multipliers
uniform vec4 uWave;     // lap coefficient, dt, restore * dt, force * dt
uniform vec3 uWave2;    // velocity damping multiplier, trail diffusion coefficient, pressure-average blend
uniform vec2 uSponge;   // absorbing band (window fraction)
uniform float uMaxH;    // soft height limit (m)
layout( location = 0 ) out highp vec4 oState;
layout( location = 1 ) out highp vec4 oAvg;

// Whether a world position lies in the old window (texels that were outside it hold stale data from the far side).
float keep( vec2 w ) {
  vec2 d = abs( w - uWindow.zw );
  return ( d.x <= uSize * 0.5 && d.y <= uSize * 0.5 && uReset < 0.5 ) ? 1.0 : 0.0;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  // This texel's world position in the new window. Neighbours are taken at +-1 texel without re-wrapping: across the
  // window seam that is wrong, but the seam lies inside the absorbing band and outside the rendered window.
  vec2 w = uWindow.xy + mod( uv * uSize - uWindow.xy, uSize );
  float e = 1.0 / uRes;
  float t = uSize / uRes;
  float k0 = keep( w );
  vec4 s = texture( uState, uv ) * k0;
  vec4 sl = texture( uState, uv - vec2( e, 0.0 ) ) * keep( w - vec2( t, 0.0 ) );
  vec4 sr = texture( uState, uv + vec2( e, 0.0 ) ) * keep( w + vec2( t, 0.0 ) );
  vec4 sd = texture( uState, uv - vec2( 0.0, e ) ) * keep( w - vec2( 0.0, t ) );
  vec4 su = texture( uState, uv + vec2( 0.0, e ) ) * keep( w + vec2( 0.0, t ) );
  vec4 f = texture( uForce, uv );
  float avg = texture( uPressureAvg, uv ).r * k0;
  float push = f.b - avg;
  vec4 lap = sl + sr + sd + su - 4.0 * s;

  float foam = max( s.r * uDecay.x, f.r );
  float trail = max( ( s.g + uWave2.y * lap.g ) * uDecay.y, f.g );

  // Symplectic Euler on the damped wave equation; the edge band absorbs outgoing waves so nothing wraps around.
  vec2 rel = abs( w - uCentre ) / uSize;
  float sponge = 1.0 - smoothstep( uSponge.x, uSponge.y, max( rel.x, rel.y ) );
  float v = ( s.a + uWave.x * lap.b - uWave.z * s.b - uWave.w * push ) * uWave2.x * sponge;
  v = clamp( v, -3.0 * uMaxH, 3.0 * uMaxH );
  float h = s.b + v * uWave.y;
  h = uMaxH * tanh( h / uMaxH ) * sponge;
  oState = vec4( foam, trail, h, v );
  oAvg = vec4( avg + uWave2.z * ( f.b - avg ), 0.0, 0.0, 1.0 );
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
  const wrapped = { ...rtOpts, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping };
  // Ping-pong state with a second attachment for the pressure average (one channel: a quarter of the bandwidth).
  const makeState = () => {
    const rt = new THREE.WebGLRenderTarget(res, res, { ...wrapped, count: 2 });
    rt.textures[1].format = THREE.RedFormat;
    rt.textures[1].minFilter = rt.textures[1].magFilter = THREE.NearestFilter;
    return rt;
  };
  const stateRT = [makeState(), makeState()];
  // Force/levels for one frame: 8 bits are plenty for 0..1 levels, and halve the bandwidth.
  const forceRT = new THREE.WebGLRenderTarget(res, res, {
    ...wrapped,
    type: THREE.UnsignedByteType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  });
  const rippleRT = new THREE.WebGLRenderTarget(rippleRes, rippleRes, { ...rtOpts, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping });
  for (const rt of [...stateRT, forceRT, rippleRT]) for (const t of rt.textures) t.colorSpace = THREE.NoColorSpace;
  stateRT[0].texture.name = 'water.field.a';
  stateRT[1].texture.name = 'water.field.b';
  let cur = 0;

  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const tri = new THREE.BufferGeometry();
  tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const simMat = new THREE.ShaderMaterial({
    vertexShader: FULL_VERT,
    fragmentShader: SIM_FRAG,
    uniforms: {
      uState: { value: stateRT[0].texture },
      uForce: { value: forceRT.texture },
      uPressureAvg: { value: stateRT[0].textures[1] },
      uWindow: { value: new THREE.Vector4() },
      uCentre: { value: new THREE.Vector2() },
      uSize: { value: size },
      uRes: { value: res },
      uReset: { value: 1 },
      uDecay: { value: new THREE.Vector2(1, 1) },
      uWave: { value: new THREE.Vector4() },
      uWave2: { value: new THREE.Vector3(1, 0, 0) },
      uSponge: { value: new THREE.Vector2(WAKE.sponge[0], WAKE.sponge[1]) },
      uMaxH: { value: WAKE.maxHeight },
    },
    glslVersion: THREE.GLSL3,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const simMesh = new THREE.Mesh(tri, simMat);
  simMesh.frustumCulled = false;

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
    vertexShader: STAMP_VERT,
    fragmentShader: STAMP_FRAG,
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
  let pendingDt = 0;
  let forceConsumed = true;
  const clearColor = new THREE.Color();

  // Pushes a stamp (world x, z, radius, strength) with toroidal duplicates where it crosses the texture edge.
  let nInst = 0;
  function put(u, v, ru, s) {
    if (nInst >= MAX_INSTANCES) return;
    const o = nInst * 4;
    stampData[o] = u;
    stampData[o + 1] = v;
    stampData[o + 2] = ru;
    stampData[o + 3] = s;
    nInst++;
  }
  function pushStamp(x, z, r, s) {
    const u = (((x / size) % 1) + 1) % 1;
    const v = (((z / size) % 1) + 1) % 1;
    const ru = r / size;
    const du = u - ru < 0 ? 1 : u + ru > 1 ? -1 : 0;
    const dv = v - ru < 0 ? 1 : v + ru > 1 ? -1 : 0;
    put(u, v, ru, s);
    if (du) put(u + du, v, ru, s);
    if (dv) put(u, v + dv, ru, s);
    if (du && dv) put(u + du, v + dv, ru, s);
  }

  // Ripple rings: a smaller window around the focus, redrawn every frame from the live rings.
  function renderRipples(focusX, focusZ, queue, parts) {
    if (!(parts & 8)) return;
    const rcx = Math.round(focusX / rtexel) * rtexel;
    const rcz = Math.round(focusZ / rtexel) * rtexel;
    state.rippleCentreX = rcx;
    state.rippleCentreZ = rcz;
    let nr = 0;
    const half = rippleSize / 2;
    queue.forEachRipple((x, z, age, radius, strength) => {
      if (nr >= RIPPLE_MAX) return;
      const speed = 0.55 + 0.06 * radius;
      const rr = 0.3 * radius + speed * age;
      const w = 0.45 + 0.035 * radius + 0.12 * age;
      const life = queue.rippleLife(radius);
      const fade = (1 - age / life) ** 2;
      const amp = (strength * (0.05 + 0.004 * radius) * fade) / (1 + 0.08 * rr);
      // Small rings (fish jumps, a dripping brailer) are slope only; froth grows in with the strength of the splash.
      const froth = rippleFroth(strength) * Math.max(0, 1 - age / 1.5) ** 2;
      const ext = rr + 3 * w;
      if (Math.abs(x - rcx) > half + ext || Math.abs(z - rcz) > half + ext) return;
      const o = nr * 4;
      ringData[o] = (x - rcx) / rippleSize + 0.5;
      ringData[o + 1] = (z - rcz) / rippleSize + 0.5;
      ringData[o + 2] = ext;
      ringData[o + 3] = rr;
      ringData2[o] = w;
      ringData2[o + 1] = amp;
      ringData2[o + 2] = froth;
      ringData2[o + 3] = 0.3 + 0.3 * radius;
      nr++;
    });
    state.ringsDrawn = nr;
    // No live rings: skip the pass and tell the surface not to sample the (stale) target.
    state.rippleValid = nr > 0;
    if (nr > 0) {
      renderer.setRenderTarget(rippleRT);
      renderer.clear(true, false, false);
      ringGeo.instanceCount = nr;
      ringAttr.needsUpdate = true;
      ringAttr2.needsUpdate = true;
      renderer.render(ringMesh, cam);
    }
  }

  let savedTarget = null;
  let savedAutoClear = true;
  let savedAlpha = 1;
  let savedScissor = false;
  function save() {
    savedTarget = renderer.getRenderTarget();
    savedAutoClear = renderer.autoClear;
    renderer.getClearColor(clearColor);
    savedAlpha = renderer.getClearAlpha();
    savedScissor = renderer.getScissorTest();
  }
  function restore() {
    renderer.setRenderTarget(savedTarget);
    renderer.setClearColor(clearColor, savedAlpha);
    renderer.autoClear = savedAutoClear;
    renderer.setScissorTest(savedScissor);
  }

  const field = {
    size,
    texel,
    rippleSize,
    get foamTexture() {
      return stateRT[cur].textures[0];
    },
    rippleTexture: rippleRT.texture,
    state,

    // Runs the frame's passes. focus: {x, z} window centre; queue: stamps.js queue; dt: sim seconds since the last run.
    // parts (QA timing only; forces a step): bit mask 1 stamps, 2 step, 8 ripples.
    render(focusX, focusZ, queue, dt, parts = 15) {
      save();
      renderer.autoClear = false;
      renderer.setScissorTest(false);
      renderer.setClearColor(0x000000, 0);

      // Window: snapped to texels so the world-anchored lattice is stable.
      const cx = Math.round(focusX / texel) * texel;
      const cz = Math.round(focusZ / texel) * texel;
      const oldX = state.valid ? state.centreX : cx;
      const oldZ = state.valid ? state.centreZ : cz;
      queue.setCentre(cx, cz);

      // The field steps at most every MIN_STEP seconds (it is smooth at 40 Hz and costs a full-window pass); stamps of
      // frames in between are max-blended into the force target until the next step, so none are lost.
      pendingDt += Math.max(0, dt);
      const qa = parts !== 15;
      const step = qa || state.reset || pendingDt >= MIN_STEP;

      // 1. This frame's stamps into the force target (cleared after it was consumed by a step).
      nInst = 0;
      const n = queue.foamCount;
      for (let i = 0; i < n; i++) {
        const o = i * 4;
        pushStamp(queue.foam[o], queue.foam[o + 1], queue.foam[o + 2], queue.foam[o + 3]);
      }
      state.stampsDrawn = nInst;
      renderer.setRenderTarget(forceRT);
      if (parts & 1 && forceConsumed) {
        renderer.clear(true, false, false);
        forceConsumed = false;
      }
      if (nInst > 0 && parts & 1) {
        stampGeo.instanceCount = nInst;
        stampAttr.clearUpdateRanges();
        stampAttr.addUpdateRange(0, nInst * 4);
        stampAttr.needsUpdate = true;
        renderer.render(stampMesh, cam);
      }

      // 2. Advance foam, trail and wake waves (ping-pong).
      if (!step) {
        renderRipples(focusX, focusZ, queue, parts);
        restore();
        return;
      }
      const sdt = qa ? dt : pendingDt;
      pendingDt = 0;
      forceConsumed = true;
      const p = wakeParams(sdt, texel);
      const u = simMat.uniforms;
      u.uState.value = stateRT[cur].textures[0];
      u.uPressureAvg.value = stateRT[cur].textures[1];
      u.uWindow.value.set(cx - size / 2, cz - size / 2, oldX, oldZ);
      u.uCentre.value.set(cx, cz);
      u.uReset.value = state.reset ? 1 : 0;
      u.uDecay.value.set(decayFactor(sdt, FOAM_HALF_LIFE), decayFactor(sdt, WAKE_HALF_LIFE));
      u.uWave.value.set(p.lap, p.dt, p.restore, p.force);
      u.uWave2.value.set(p.damp, p.diffuse, p.avgK);
      if (parts & 2) {
        cur = 1 - cur;
        renderer.setRenderTarget(stateRT[cur]);
        // Every texel is rewritten: clearing first lets tile-based GPUs skip loading the old contents.
        renderer.clear(true, false, false);
        renderer.render(simMesh, cam);
      }
      state.reset = false;
      state.centreX = cx;
      state.centreZ = cz;
      state.valid = true;

      renderRipples(focusX, focusZ, queue, parts);
      restore();
    },

    reset() {
      state.reset = true;
      forceConsumed = true;
      pendingDt = 0;
    },

    dispose() {
      for (const rt of [...stateRT, forceRT, rippleRT]) rt.dispose();
      simMat.dispose();
      stampMat.dispose();
      ringMat.dispose();
      tri.dispose();
      quad.dispose();
      stampGeo.dispose();
      ringGeo.dispose();
    },
  };
  return field;
}
