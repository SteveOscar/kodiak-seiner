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

const LAYER_REFLECT = 1;

export function createReflection({ THREE, renderer, scene, camera, scale = 0.5 }) {
  const size = new THREE.Vector2();
  renderer.getDrawingBufferSize(size);
  const w = () => Math.max(64, Math.round(size.x * scale));
  const h = () => Math.max(36, Math.round(size.y * scale));
  const depthTexture = new THREE.DepthTexture(w(), h(), THREE.FloatType);
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

    resize() {
      renderer.getDrawingBufferSize(size);
      target.setSize(w(), h());
    },

    // lights: Light objects that must light the pass (enabled on layer 1 for its duration only).
    render(lights) {
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
      reflCam.fov = camera.fov;
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
      depthTexture.dispose();
    },
  };
  return refl;
}
