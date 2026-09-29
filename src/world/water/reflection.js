// Planar reflection of the layer-1 world (terrain, sky dome, and any mesh that opts in with mesh.layers.enable(1))
// for calm water: mountains mirrored in a glassy fjord, boats doubled on a still morning.
//
// Rendered from pipeline.beforeRender at reduced resolution with a camera mirrored about y = 0 (Reflector-style
// lookAt, so handedness and culling stay correct), clipped by a global clipping plane (not an oblique projection;
// reversed-Z safe). The water shader reads it through uReflMatrix and uses the depth texture as a mask so the sky
// keeps coming from sky.envMap with per-pixel roughness; only geometry is taken from this pass.
//
// Shared-state hygiene: restores render target, clear colour/alpha, autoClear, scissor, clipping planes and the
// shadow-map update flag (a layer-1 pass must not redraw the shadow map with only layer-1 casters).
//
// The pass is rendered with a slightly wider field of view than the main camera (GUARD), so normal-tilted lookups
// near the screen edges still land on the image; the shader fades the reflection out over the outer margin.
//
// Resizing: three r186 RenderTarget.setSize resizes only the colour texture. A DepthTexture keeps its old image size,
// and the water surface samples it every frame, so it would be re-uploaded (immutable storage) at the old size before
// the target is bound again, leaving the framebuffer incomplete for the rest of the session. resize() therefore gives
// the target a new DepthTexture at the new size; callers must re-read refl.depthTexture afterwards.

const LAYER_REFLECT = 1;
export const REFLECTION_GUARD = 0.06; // extra half-extent of the reflection frustum (fraction of the main view)

export function createReflection({ THREE, renderer, scene, camera, scale = 0.5 }) {
  const size = new THREE.Vector2();
  renderer.getDrawingBufferSize(size);
  // The guard band widens the frustum, so the target grows with it to keep the texel density on screen.
  const w = () => Math.max(64, Math.round(size.x * scale * (1 + REFLECTION_GUARD)));
  const h = () => Math.max(36, Math.round(size.y * scale * (1 + REFLECTION_GUARD)));
  const makeDepth = () => {
    const d = new THREE.DepthTexture(w(), h(), THREE.FloatType);
    d.name = 'water.reflection.depth';
    return d;
  };
  const depthTexture = makeDepth();
  const target = new THREE.WebGLRenderTarget(w(), h(), {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    depthBuffer: true,
    depthTexture,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  target.texture.name = 'water.reflection';
  target.texture.colorSpace = THREE.NoColorSpace;

  const reflCam = new THREE.PerspectiveCamera();
  reflCam.layers.set(LAYER_REFLECT);
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0.05);
  const clipPlanes = [plane];
  const textureMatrix = new THREE.Matrix4();
  const bias = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);

  const camPos = new THREE.Vector3();
  const lookAt = new THREE.Vector3();
  const up = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const clearColor = new THREE.Color();
  const toggled = [];

  function mirror(v) {
    v.y = -v.y;
    return v;
  }

  const refl = {
    target,
    texture: target.texture,
    depthTexture,
    textureMatrix,
    rendered: false,

    // Matches the target to the drawing buffer. Returns true when it changed; refl.depthTexture is then a new object
    // and the previous image is gone (refl.rendered is false until the next render).
    resize() {
      renderer.getDrawingBufferSize(size);
      const W = w();
      const H = h();
      const d = refl.depthTexture;
      if (W === target.width && H === target.height && d.image.width === W && d.image.height === H) return false;
      target.setSize(W, H); // disposes the framebuffer and, through three, the old depth texture's GL storage
      const next = makeDepth();
      target.depthTexture = next;
      refl.depthTexture = next;
      d.dispose();
      refl.rendered = false;
      return true;
    },

    // QA: framebuffer completeness and attachment sizes (binds the target briefly; restores the previous one).
    status() {
      const gl = renderer.getContext();
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(target);
      const fb = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      renderer.setRenderTarget(prev);
      renderer.getDrawingBufferSize(size);
      return {
        complete: fb === gl.FRAMEBUFFER_COMPLETE,
        status: fb,
        color: [target.width, target.height],
        depth: [refl.depthTexture.image.width, refl.depthTexture.image.height],
        expected: [w(), h()],
      };
    },

    // lights: Light objects that must light the pass (enabled on layer 1 for its duration only).
    render(lights) {
      // Also catches drawing-buffer changes that bypass pipeline.onResize (renderer.setPixelRatio/setSize directly).
      refl.resize();
      camera.updateMatrixWorld();
      camPos.setFromMatrixPosition(camera.matrixWorld);
      if (camPos.y <= 0.05) {
        refl.rendered = false;
        return false;
      }
      // Reflect position, a look-at point and the up vector about the plane y = 0.
      mirror(reflCam.position.copy(camPos));
      tmp.set(0, 0, -1).applyMatrix4(camera.matrixWorld);
      mirror(lookAt.copy(tmp));
      up.set(0, 1, 0).applyMatrix4(camera.matrixWorld).sub(camPos);
      mirror(up);
      reflCam.up.copy(up);
      reflCam.lookAt(lookAt);
      const halfTan = Math.tan(((camera.fov * Math.PI) / 180) * 0.5) / (camera.zoom || 1);
      reflCam.fov = ((2 * Math.atan(halfTan * (1 + REFLECTION_GUARD))) * 180) / Math.PI;
      reflCam.aspect = camera.aspect;
      reflCam.near = camera.near;
      reflCam.far = camera.far;
      reflCam.updateProjectionMatrix();
      reflCam.updateMatrixWorld();

      const prevTarget = renderer.getRenderTarget();
      const prevAutoClear = renderer.autoClear;
      const prevClipping = renderer.clippingPlanes;
      const prevShadowUpdate = renderer.shadowMap.needsUpdate;
      const prevScissorTest = renderer.getScissorTest();
      renderer.getClearColor(clearColor);
      const prevAlpha = renderer.getClearAlpha();

      toggled.length = 0;
      for (const l of lights) {
        if (l && !l.layers.isEnabled(LAYER_REFLECT)) {
          l.layers.enable(LAYER_REFLECT);
          toggled.push(l);
        }
      }
      renderer.shadowMap.needsUpdate = false;
      renderer.clippingPlanes = clipPlanes;
      renderer.autoClear = true;
      renderer.setScissorTest(false);
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(target);
      renderer.clear(true, true, false);
      try {
        renderer.render(scene, reflCam);
      } finally {
        renderer.setRenderTarget(prevTarget);
        renderer.clippingPlanes = prevClipping;
        renderer.autoClear = prevAutoClear;
        renderer.setScissorTest(prevScissorTest);
        renderer.setClearColor(clearColor, prevAlpha);
        renderer.shadowMap.needsUpdate = prevShadowUpdate;
        for (const l of toggled) l.layers.disable(LAYER_REFLECT);
      }
      textureMatrix.multiplyMatrices(bias, reflCam.projectionMatrix).multiply(reflCam.matrixWorldInverse);
      refl.rendered = true;
      return true;
    },

    dispose() {
      target.dispose();
      refl.depthTexture.dispose();
    },
  };
  return refl;
}
