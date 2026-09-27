// Environment map (SPEC §4.3): a sky-only scene (dome with clouds, no sun disc, stars, lights, terrain or particles)
// rendered by a CubeCamera into a persistent 256² HalfFloat cube, then PMREM-filtered into one persistent target.
// sky.envMap is that target's texture: the same object for the whole session, valid right after create().

import * as THREE from 'three';

const LAYER_REFLECT = 1;

export function createEnvCapture(renderer, envDomeMaterial) {
  const envScene = new THREE.Scene();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const dome = new THREE.Mesh(geo, envDomeMaterial);
  dome.frustumCulled = false;
  dome.renderOrder = -1000;
  dome.layers.enable(LAYER_REFLECT);
  envScene.add(dome);

  const cubeTarget = new THREE.WebGLCubeRenderTarget(256, {
    type: THREE.HalfFloatType,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
  });
  const cubeCamera = new THREE.CubeCamera(0.1, 10, cubeTarget);
  cubeCamera.layers.set(LAYER_REFLECT);
  cubeCamera.position.set(0, 20, 0);
  envScene.add(cubeCamera);
  const pmrem = new THREE.PMREMGenerator(renderer);
  let envTarget = null;
  const prevClear = new THREE.Color();

  function capture() {
    const prevTarget = renderer.getRenderTarget();
    const prevFace = renderer.getActiveCubeFace();
    const prevMip = renderer.getActiveMipmapLevel();
    const prevAutoClear = renderer.autoClear;
    const prevAlpha = renderer.getClearAlpha();
    renderer.getClearColor(prevClear);
    const prevScissorTest = renderer.getScissorTest();
    renderer.autoClear = true;
    renderer.setClearColor(0x000000, 1);
    cubeCamera.updateMatrixWorld(true);
    cubeCamera.update(renderer, envScene);
    // The first call allocates PMREM's internal targets and returns our persistent target; later calls reuse it.
    envTarget = envTarget ? pmrem.fromCubemap(cubeTarget.texture, envTarget) : pmrem.fromCubemap(cubeTarget.texture);
    renderer.setRenderTarget(prevTarget, prevFace, prevMip);
    renderer.autoClear = prevAutoClear;
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.setScissorTest(prevScissorTest);
  }

  capture();
  // PMREM's GGX pre-filter takes 256 samples per texel per LOD (~10 ms of GPU per refresh). The sky-only environment
  // is smooth (no sun disc), so a fraction of the samples is indistinguishable; the material is internal to
  // PMREMGenerator and allocated by the first fromCubemap(), hence the guarded access.
  const ggx = pmrem._ggxMaterial;
  if (ggx?.defines && 'GGX_SAMPLES' in ggx.defines) {
    ggx.defines.GGX_SAMPLES = 24;
    ggx.needsUpdate = true;
    capture();
  }
  envTarget.texture.name = 'sky.envMap';
  const height = envTarget.texture.image.height;
  const maxMip = Math.log2(height) - 2;
  const envMapDefines = {
    ENVMAP_TYPE_CUBE_UV: '',
    CUBEUV_TEXEL_WIDTH: 1 / (3 * Math.max(2 ** maxMip, 7 * 16)),
    CUBEUV_TEXEL_HEIGHT: 1 / height,
    CUBEUV_MAX_MIP: `${maxMip}.0`,
  };

  return {
    get texture() {
      return envTarget.texture;
    },
    get target() {
      return envTarget;
    },
    envMapDefines,
    capture,
    dispose() {
      cubeTarget.dispose();
      envTarget?.dispose();
      pmrem.dispose();
    },
  };
}
