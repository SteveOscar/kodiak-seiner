// WP-OCEAN planar reflection target: a resize (window or dynamic resolution via pipeline.setPixelRatio) must leave the
// colour and depth attachments the same size, or every later reflection pass hits an incomplete framebuffer
// (QA [10]/[11]/[18]). The pass also renders with a guard band past the screen edges (QA [9]).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createReflection, REFLECTION_GUARD } from '../src/world/water/reflection.js';

function mockRenderer(size) {
  let target = null;
  return {
    size,
    renders: 0,
    shadowMap: { needsUpdate: false },
    clippingPlanes: [],
    autoClear: true,
    getDrawingBufferSize: (v) => v.set(size.x, size.y),
    getRenderTarget: () => target,
    setRenderTarget(t) {
      target = t;
    },
    getScissorTest: () => false,
    setScissorTest() {},
    getClearColor: (c) => c.set(0, 0, 0),
    getClearAlpha: () => 1,
    setClearColor() {},
    clear() {},
    render() {
      this.renders++;
    },
  };
}

function attachmentsMatch(refl) {
  const t = refl.target;
  const d = t.depthTexture;
  return d === refl.depthTexture && d.image.width === t.width && d.image.height === t.height;
}

test('reflection resize keeps the depth attachment the same size as the colour target', () => {
  const size = { x: 1280, y: 720 };
  const renderer = mockRenderer(size);
  const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.5, 20000);
  const refl = createReflection({ THREE, renderer, scene: new THREE.Scene(), camera, scale: 0.5 });
  assert.ok(attachmentsMatch(refl));
  const first = refl.depthTexture;

  // Unchanged drawing buffer: nothing is reallocated.
  assert.equal(refl.resize(), false);
  assert.equal(refl.depthTexture, first);

  // Dynamic resolution step down (pixel ratio 0.875 of 640x360 -> 560x315): a new depth texture at the new size,
  // the old one released.
  let disposed = false;
  first.addEventListener('dispose', () => (disposed = true));
  size.x = 560;
  size.y = 315;
  assert.equal(refl.resize(), true);
  assert.notEqual(refl.depthTexture, first);
  assert.ok(disposed, 'old depth texture disposed');
  assert.ok(attachmentsMatch(refl));
  assert.equal(refl.target.width, Math.round(560 * 0.5 * (1 + REFLECTION_GUARD)));
  assert.equal(refl.rendered, false);

  // Several steps in a row, up and down (1.0 then 1.5 then back), each leaves matching attachments.
  for (const [x, y] of [
    [640, 360],
    [960, 540],
    [800, 450],
  ]) {
    size.x = x;
    size.y = y;
    const before = refl.depthTexture;
    assert.equal(refl.resize(), true);
    assert.notEqual(refl.depthTexture, before);
    assert.ok(attachmentsMatch(refl), `attachments match at ${x}x${y}`);
  }

  // A drawing-buffer change that bypassed pipeline.onResize is picked up by the next render.
  camera.position.set(0, 10, 0);
  camera.lookAt(0, 0, -100);
  size.x = 1500;
  size.y = 840;
  const stale = refl.depthTexture;
  assert.equal(refl.render([]), true);
  assert.notEqual(refl.depthTexture, stale);
  assert.ok(attachmentsMatch(refl));
  assert.equal(refl.target.width, Math.round(1500 * 0.5 * (1 + REFLECTION_GUARD)));
  assert.equal(renderer.renders, 1);
  assert.equal(renderer.getRenderTarget(), null, 'previous render target restored');
});

test('reflection pass covers the screen with a guard band at the edges', () => {
  const renderer = mockRenderer({ x: 1280, y: 720 });
  const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.5, 20000);
  camera.position.set(30, 12, -40);
  camera.lookAt(-200, 0, -600);
  camera.updateMatrixWorld();
  const refl = createReflection({ THREE, renderer, scene: new THREE.Scene(), camera, scale: 0.5 });
  assert.equal(refl.render([]), true);

  // Water-plane points seen at the main view's left/right edges and bottom edge.
  const ray = new THREE.Ray();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const P = new THREE.Vector3();
  const uv = new THREE.Vector4();
  const margin = 0.5 - 0.5 / (1 + REFLECTION_GUARD);
  for (const [nx, ny, axis] of [
    [1, -0.4, 'x'],
    [-1, -0.4, 'x'],
    [0.2, -1, 'y'],
  ]) {
    ray.origin.setFromMatrixPosition(camera.matrixWorld);
    ray.direction.set(nx, ny, 0.5).unproject(camera).sub(ray.origin).normalize();
    assert.ok(ray.intersectPlane(plane, P), 'edge ray meets the sea');
    uv.set(P.x, 0, P.z, 1).applyMatrix4(refl.textureMatrix);
    const u = uv[axis] / uv.w;
    const edgeDist = Math.min(u, 1 - u);
    assert.ok(Math.abs(edgeDist - margin) < 2e-3, `screen edge (${nx}, ${ny}) lands ${edgeDist.toFixed(4)} from the image edge, want ${margin.toFixed(4)}`);
  }
});
