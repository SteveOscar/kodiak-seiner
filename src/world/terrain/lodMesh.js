// One CDLOD-selected terrain mesh: a shared instanced grid quadrant (QUAD x QUAD quads plus a skirt ring) drawn once
// per selected quadrant. The main view and the planar water reflection each own one, with their own ranges, selection
// rules and material; both morph against the real camera position, so a mesh never cracks against itself.

import * as THREE from 'three';
import { createSelector, morphParams, QUAD } from './quadtree.js';

// One quadrant: (QUAD+1)^2 grid vertices plus a skirt ring. position = (i, skirt, j). Skirts face outward only: a
// crack between two quadrants is always seen from outside the quadrant whose skirt fills it.
export function createPatchGeometry() {
  const n = QUAD + 1;
  const pos = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) pos.push(i, 0, j);
  const border = [];
  for (let i = 0; i < QUAD; i++) border.push([i, 0]);
  for (let j = 0; j < QUAD; j++) border.push([QUAD, j]);
  for (let i = QUAD; i > 0; i--) border.push([i, QUAD]);
  for (let j = QUAD; j > 0; j--) border.push([0, j]);
  const skirtBase = pos.length / 3;
  for (const [i, j] of border) pos.push(i, 1, j);
  const idx = [];
  for (let j = 0; j < QUAD; j++) {
    for (let i = 0; i < QUAD; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  for (let k = 0; k < border.length; k++) {
    const [i0, j0] = border[k];
    const [i1, j1] = border[(k + 1) % border.length];
    const t0 = j0 * n + i0;
    const t1 = j1 * n + i1;
    const s0 = skirtBase + k;
    const s1 = skirtBase + ((k + 1) % border.length);
    idx.push(t0, t1, s0, t1, s1, s0);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

export const TRIANGLES_PER_QUADRANT = QUAD * QUAD * 2 + QUAD * 8;

/**
 * base        patch geometry to share (position + index)
 * bounds      quadtree.createBounds() result
 * ranges      per-level LOD ranges
 * material    terrain material; its lod uniform object is `lodUniform`
 * reflectOnly select only land seen in the camera mirrored about y = 0
 */
export function createLodMesh({ base, bounds, ranges, lodUniform, material, maxInstances = 4096, reflectOnly = false, name = 'terrain' }) {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = base.index;
  geometry.setAttribute('position', base.attributes.position);
  const nodeData = new Float32Array(maxInstances * 4);
  const nodeAttr = new THREE.InstancedBufferAttribute(nodeData, 4);
  nodeAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('tkNode', nodeAttr);
  geometry.instanceCount = 0;
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  geometry.boundingBox = new THREE.Box3(new THREE.Vector3(-1e5, -100, -1e5), new THREE.Vector3(1e5, 1000, 1e5));
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;

  let selector = null;
  function setRanges(r) {
    lodUniform.value = morphParams(r).map((m) => new THREE.Vector4(m.start, m.inv, m.spacing, m.skirt));
    selector = createSelector({ bounds, ranges: r, maxInstances, reflect: false, reflectOnly });
  }
  setRanges(ranges);

  // Near quadrants first so early depth rejection skips the hills hidden behind them.
  const keys = new Float32Array(maxInstances);
  const scratch = new Float32Array(maxInstances * 4);
  const idxArr = [];
  function sortFrontToBack(n, cx, cz) {
    idxArr.length = n;
    for (let i = 0; i < n; i++) {
      const k = i * 4;
      const hs = nodeData[k + 2] * 0.5;
      keys[i] = Math.max(0, Math.hypot(nodeData[k] + hs - cx, nodeData[k + 1] + hs - cz) - hs * 1.41);
      idxArr[i] = i;
    }
    idxArr.sort((a, b) => keys[a] - keys[b]);
    scratch.set(nodeData.subarray(0, n * 4));
    for (let i = 0; i < n; i++) {
      const src = idxArr[i] * 4;
      nodeData[i * 4] = scratch[src];
      nodeData[i * 4 + 1] = scratch[src + 1];
      nodeData[i * 4 + 2] = scratch[src + 2];
      nodeData[i * 4 + 3] = scratch[src + 3];
    }
  }

  let instances = 0;
  let limit = maxInstances;
  return {
    mesh,
    geometry,
    setRanges,
    set limit(v) {
      limit = v ?? maxInstances;
    },
    get instances() {
      return instances;
    },
    // camera position {x, y, z}, frustum planes (THREE.Frustum.planes) or null.
    select(cam, planes) {
      instances = Math.min(limit, selector.select(cam, planes, nodeData));
      sortFrontToBack(instances, cam.x, cam.z);
      geometry.instanceCount = instances;
      nodeAttr.clearUpdateRanges();
      nodeAttr.addUpdateRange(0, instances * 4);
      nodeAttr.needsUpdate = true;
      return instances;
    },
    clear() {
      instances = 0;
      geometry.instanceCount = 0;
    },
  };
}
