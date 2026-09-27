// Procedural textures for the sea, baked once on the GPU (first beforeRender):
//   detail   512² RGBA8, tileable: rg = surface slope (unit RMS) as 0.5 + s / 8, b = squared slope / 16 (mip-averaged
//            -> variance for Toksvig-style roughness), a = 0.5 + height / 4. The encodings are affine, so mip averages
//            decode to mean slope and mean squared slope. Spectrum is wind-aligned along +x.
//   foamNoise 256² RGBA8, tileable: r = foam density (bright foam around bubble holes), g = fbm, b = wind streaks.
// Both are NoColorSpace data textures with mipmaps and anisotropic filtering.

const DETAIL_WAVES = 96;

function detailSpectrum(rng) {
  const waves = [];
  const seen = new Set();
  let guard = 0;
  while (waves.length < DETAIL_WAVES && guard++ < 10000) {
    const mag = Math.exp(Math.log(3) + rng.next() * (Math.log(46) - Math.log(3)));
    let theta;
    if (rng.next() < 0.25) theta = rng.next() * Math.PI * 2;
    else {
      // Wind-aligned: cos^2 spread around +x (both travel senses give the same slopes pattern shape).
      do theta = (rng.next() - 0.5) * Math.PI;
      while (rng.next() > Math.cos(theta) ** 2);
    }
    const nx = Math.round(mag * Math.cos(theta));
    const nz = Math.round(mag * Math.sin(theta));
    if (nx === 0 && nz === 0) continue;
    const key = `${nx},${nz}`;
    if (seen.has(key) || seen.has(`${-nx},${-nz}`)) continue;
    seen.add(key);
    const n = Math.hypot(nx, nz);
    waves.push([nx, nz, Math.pow(n, -1.15) * (0.7 + 0.6 * rng.next()), rng.next() * Math.PI * 2]);
  }
  // Normalise so the RMS slope magnitude is 1.
  let ms = 0;
  for (const [nx, nz, a] of waves) ms += 0.5 * (a * 2 * Math.PI) ** 2 * (nx * nx + nz * nz);
  const s = 1 / Math.sqrt(ms);
  const data = new Float32Array(DETAIL_WAVES * 4);
  waves.forEach(([nx, nz, a, p], i) => data.set([nx, nz, a * s, p], i * 4));
  return data;
}

const FULLSCREEN_VERT = /* glsl */ `
void main() { gl_Position = vec4( position.xy, 0.0, 1.0 ); }
`;

const DETAIL_FRAG = /* glsl */ `
uniform vec4 uWaves[${DETAIL_WAVES}];
uniform float uSize;
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec2 s = vec2( 0.0 );
  float h = 0.0;
  for ( int i = 0; i < ${DETAIL_WAVES}; i ++ ) {
    vec4 w = uWaves[ i ];
    float th = 6.283185307179586 * dot( w.xy, uv ) + w.w;
    s += w.z * 6.283185307179586 * w.xy * cos( th );
    h += w.z * sin( th );
  }
  gl_FragColor = vec4( clamp( s / 8.0 + 0.5, 0.0, 1.0 ), min( dot( s, s ) / 16.0, 1.0 ), clamp( h * 0.25 + 0.5, 0.0, 1.0 ) );
}
`;

const FOAM_FRAG = /* glsl */ `
uniform float uSize;
vec2 hash2( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.xx + p3.yz ) * p3.zy );
}
float hash1( vec2 p ) { return hash2( p ).x; }
// Periodic value noise with integer period.
float vnoise( vec2 p, float period ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  float a = hash1( mod( i, period ) );
  float b = hash1( mod( i + vec2( 1.0, 0.0 ), period ) );
  float c = hash1( mod( i + vec2( 0.0, 1.0 ), period ) );
  float d = hash1( mod( i + vec2( 1.0, 1.0 ), period ) );
  return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );
}
float fbm( vec2 p, float period ) {
  float s = 0.0;
  float a = 0.5;
  for ( int i = 0; i < 5; i ++ ) {
    s += a * vnoise( p, period );
    p *= 2.0;
    period *= 2.0;
    a *= 0.5;
  }
  return s / 0.97;
}
// Periodic Worley F1: distance to the nearest jittered feature point.
float worleyF1( vec2 p, float period ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  float f1 = 8.0;
  for ( int y = -1; y <= 1; y ++ ) {
    for ( int x = -1; x <= 1; x ++ ) {
      vec2 o = vec2( float( x ), float( y ) );
      vec2 c = o + hash2( mod( i + o, period ) ) * 0.85 + 0.075 - f;
      f1 = min( f1, dot( c, c ) );
    }
  }
  return sqrt( f1 );
}
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec2 wuv = uv + ( vec2( fbm( uv * 4.0 + 3.1, 4.0 ), fbm( uv * 4.0 + 7.7, 4.0 ) ) - 0.5 ) * 0.09;
  // Foam density: bright foam around dark holes of three sizes (bubbles). Thresholding it by a foam level makes
  // foam dissolve naturally: holes grow and join until only a lacy network, then scattered flecks, remain.
  float h1 = worleyF1( wuv * 11.0, 11.0 );
  float h2 = worleyF1( wuv * 27.0 + 0.37, 27.0 );
  float h3 = worleyF1( wuv * 61.0 + 0.71, 61.0 );
  float g = fbm( uv * 8.0, 8.0 );
  float dens = smoothstep( 0.08, 0.6, h1 ) * 0.5 + smoothstep( 0.06, 0.5, h2 ) * 0.32 + smoothstep( 0.1, 0.5, h3 ) * 0.18;
  dens = clamp( dens * ( 0.75 + 0.5 * g ), 0.0, 1.0 );
  float streak = fbm( vec2( uv.x * 3.0, uv.y * 24.0 ), 3.0 );
  gl_FragColor = vec4( dens, g, streak, 1.0 );
}
`;

export function bakeTextures({ THREE, renderer, rng }) {
  const quad = new THREE.BufferGeometry();
  quad.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy?.() ?? 1);

  const make = (size, type, anisotropy) => {
    const rt = new THREE.WebGLRenderTarget(size, size, {
      type,
      format: THREE.RGBAFormat,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      anisotropy: Math.min(aniso, anisotropy),
    });
    rt.texture.colorSpace = THREE.NoColorSpace;
    return rt;
  };

  const detailRT = make(512, THREE.UnsignedByteType, 4);
  const foamRT = make(256, THREE.UnsignedByteType, 4);

  const detailMat = new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: DETAIL_FRAG,
    uniforms: { uWaves: { value: detailSpectrum(rng) }, uSize: { value: 512 } },
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const foamMat = new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: FOAM_FRAG,
    uniforms: { uSize: { value: 256 } },
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(quad, detailMat);
  mesh.frustumCulled = false;

  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  renderer.autoClear = false;
  renderer.setRenderTarget(detailRT);
  renderer.render(mesh, cam);
  mesh.material = foamMat;
  renderer.setRenderTarget(foamRT);
  renderer.render(mesh, cam);
  renderer.setRenderTarget(prevTarget);
  renderer.autoClear = prevAutoClear;

  detailMat.dispose();
  foamMat.dispose();
  quad.dispose();
  return { detail: detailRT.texture, foamNoise: foamRT.texture, targets: [detailRT, foamRT] };
}

// 1x1 stand-ins used until the bake has run (and under Node).
export function placeholderTextures(THREE) {
  const flat = new THREE.DataTexture(new Uint8Array([128, 128, 0, 128]), 1, 1, THREE.RGBAFormat);
  flat.needsUpdate = true;
  const grey = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1, THREE.RGBAFormat);
  grey.needsUpdate = true;
  const zero = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
  zero.needsUpdate = true;
  return { detail: flat, foamNoise: grey, zero };
}
