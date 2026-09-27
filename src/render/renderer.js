// WebGL renderer, scene and main camera. The frame is drawn by ctx.pipeline.render(); the postfx system replaces
// pipeline.render with its composer. Anything that needs a hook before/after the main render (render targets such as
// reflection or foam maps) registers with pipeline.beforeRender(fn) / pipeline.afterRender(fn).

import * as THREE from 'three';

export function createRenderer({ canvas, config, quality }) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: !quality.postfx,
    powerPreference: 'high-performance',
    // Reversed-Z (EXT_clip_control) keeps depth precise from 0.5 m to 40 km, so distant coastlines do not z-fight
    // with the sea. three.js falls back to a normal depth buffer where the extension is missing.
    reversedDepthBuffer: true,
    stencil: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatio, config.render.maxPixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = !!quality.shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    config.render.fov,
    window.innerWidth / window.innerHeight,
    config.render.near,
    config.render.far,
  );
  camera.position.set(0, 60, 200);
  scene.add(camera); // so camera-attached objects (rain, spray) render

  const before = [];
  const after = [];
  const resizeHandlers = [];

  const pipeline = {
    beforeRender(fn) {
      before.push(fn);
      return () => before.splice(before.indexOf(fn), 1);
    },
    afterRender(fn) {
      after.push(fn);
      return () => after.splice(after.indexOf(fn), 1);
    },
    onResize(fn) {
      resizeHandlers.push(fn);
    },
    // Replaced by postfx. Must draw scene with camera to the default framebuffer.
    render(dt) {
      renderer.render(scene, camera);
    },
    frame(dt) {
      for (const fn of before) fn(dt);
      pipeline.render(dt);
      for (const fn of after) fn(dt);
    },
  };

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    for (const fn of resizeHandlers) fn(w, h);
  }
  window.addEventListener('resize', resize);

  return { renderer, scene, camera, pipeline, resize };
}
