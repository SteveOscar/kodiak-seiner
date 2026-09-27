// WebGL renderer, scene and main camera. The frame is drawn by ctx.pipeline.render(); the postfx system replaces
// pipeline.render with its composer. Anything that needs a hook before/after the main render (render targets such as
// reflection or foam maps) registers with pipeline.beforeRender(fn) / pipeline.afterRender(fn).

import * as THREE from 'three';

export function createRenderer({ canvas, config, quality }) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: !quality.postfx,
    powerPreference: 'high-performance',
    // Reversed-Z (EXT_clip_control). It only adds precision with a 32-bit float depth attachment, which the postfx scene
    // target provides; the canvas path (quality 'low') has 24-bit depth. three.js falls back where unsupported.
    reversedDepthBuffer: true,
    stencil: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatio, config.render.maxPixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = !!quality.shadows;
  renderer.shadowMap.type = THREE.PCFShadowMap; // soft in r186 via light.shadow.radius
  // The shadow map is redrawn once per frame (pipeline.frame sets needsUpdate), not on every secondary render.
  renderer.shadowMap.autoUpdate = false;
  // Counters accumulate over the whole frame (reset by main.js), so perf() sees every pass, not just the last.
  renderer.info.autoReset = false;

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
    // Hooks run every frame after the debug camera override: put camera-following work (sky dome, shadow box, rain,
    // camera-centred grids) and secondary renders here.
    beforeRender(fn) {
      before.push(fn);
      return () => {
        const i = before.indexOf(fn);
        if (i >= 0) before.splice(i, 1);
      };
    },
    afterRender(fn) {
      after.push(fn);
      return () => {
        const i = after.indexOf(fn);
        if (i >= 0) after.splice(i, 1);
      };
    },
    onResize(fn) {
      resizeHandlers.push(fn);
    },
    // Replaced by postfx. Must draw scene with camera to the default framebuffer.
    render(dt) {
      renderer.render(scene, camera);
    },
    frame(dt) {
      renderer.shadowMap.needsUpdate = true;
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
