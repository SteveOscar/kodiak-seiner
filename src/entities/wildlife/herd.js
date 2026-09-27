// Instanced drawing for one kind of animal: up to two LOD meshes sharing one material, filled every frame from the
// camera-following render hook. Culling is on the CPU per animal (frustum sphere test + projected pixel size), so
// the InstancedMeshes are never frustum-culled as a whole. `minPx` inflates tiny animals (birds at range) to a
// readable speck, capped by `maxScale`.

import * as THREE from 'three';
import { composeMatrix } from './math.js';

export class Herd {
  constructor(ctx, { name, geometries, material, depthMaterial = null, capacity = 64, castShadow = false, lodPx = 48, cullPx = 0.8, minPx = 0, maxScale = 1, tint = false, layers = null }) {
    this.name = name;
    this.capacity = capacity;
    this.lodPx = lodPx;
    this.cullPx = cullPx;
    this.minPx = minPx;
    this.maxScale = maxScale;
    this.lods = geometries.filter(Boolean).map((geo, i) => {
      const g = geo.clone();
      const anim = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
      const anim2 = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('aAnim', anim);
      g.setAttribute('aAnim2', anim2);
      const mesh = new THREE.InstancedMesh(g, material, capacity);
      mesh.name = `wildlife-${name}-lod${i}`;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = castShadow && i === 0;
      mesh.receiveShadow = true;
      if (depthMaterial) mesh.customDepthMaterial = depthMaterial;
      if (tint) {
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
        mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      }
      mesh.count = 0;
      mesh.visible = false;
      if (layers) for (const l of layers) mesh.layers.enable(l);
      ctx.scene.add(mesh);
      return { mesh, anim, anim2, n: 0 };
    });
    this.view = null;
    this.drawn = 0;
  }

  begin(view) {
    this.view = view;
    for (const l of this.lods) l.n = 0;
  }

  // Tests visibility and LOD for an animal of bounding `radius` at (x, y, z). Returns the scale multiplier to draw it
  // with and sets this.pickLod, or 0 when it is culled.
  test(x, y, z, radius) {
    const v = this.view;
    const dx = x - v.cam.x;
    const dy = y - v.cam.y;
    const dz = z - v.cam.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > v.maxDist) return 0;
    const px = (2 * radius * v.projScale) / Math.max(dist, 0.1);
    let mul = 1;
    if (this.minPx > 0 && px < this.minPx) mul = Math.min(this.maxScale, this.minPx / Math.max(px, 1e-3));
    if (px * mul < this.cullPx) return 0;
    const r = radius * mul;
    const planes = v.frustum.planes;
    for (let i = 0; i < 6; i++) {
      const p = planes[i];
      if (p.normal.x * x + p.normal.y * y + p.normal.z * z + p.constant < -r) return 0;
    }
    this.pickLod = px < this.lodPx && this.lods.length > 1 ? 1 : 0;
    this.lastPx = px;
    return mul;
  }

  // Writes one instance (call after test() returned > 0; `scale` should include its multiplier).
  write(x, y, z, heading, pitch, roll, scale, a0, a1, a2, a3, b0, b1, b2, b3, tint = null) {
    const l = this.lods[this.pickLod ?? 0];
    if (l.n >= this.capacity) return false;
    const i = l.n++;
    composeMatrix(l.mesh.instanceMatrix.array, i * 16, x, y, z, heading, pitch, roll, scale);
    const a = l.anim.array;
    a[i * 4] = a0;
    a[i * 4 + 1] = a1;
    a[i * 4 + 2] = a2;
    a[i * 4 + 3] = a3;
    const b = l.anim2.array;
    b[i * 4] = b0;
    b[i * 4 + 1] = b1;
    b[i * 4 + 2] = b2;
    b[i * 4 + 3] = b3;
    if (tint && l.mesh.instanceColor) {
      const c = l.mesh.instanceColor.array;
      c[i * 3] = tint[0];
      c[i * 3 + 1] = tint[1];
      c[i * 3 + 2] = tint[2];
    }
    return true;
  }

  // Convenience: test + write.
  push(x, y, z, heading, pitch, roll, scale, radius, a0 = 0, a1 = 0, a2 = 0, a3 = 0, b0 = 0, b1 = 0, b2 = 0, b3 = 0, tint = null) {
    const mul = this.test(x, y, z, radius * scale);
    if (!mul) return false;
    return this.write(x, y, z, heading, pitch, roll, scale * mul, a0, a1, a2, a3, b0, b1, b2, b3, tint);
  }

  end() {
    let drawn = 0;
    for (const l of this.lods) {
      const m = l.mesh;
      m.count = l.n;
      m.visible = l.n > 0;
      drawn += l.n;
      if (l.n > 0) {
        for (const attr of [m.instanceMatrix, l.anim, l.anim2, m.instanceColor]) {
          if (!attr) continue;
          attr.clearUpdateRanges();
          attr.addUpdateRange(0, l.n * attr.itemSize);
          attr.needsUpdate = true;
        }
      }
    }
    this.drawn = drawn;
  }

  hide() {
    for (const l of this.lods) {
      l.mesh.count = 0;
      l.mesh.visible = false;
    }
    this.drawn = 0;
  }

  triangles() {
    let t = 0;
    for (const l of this.lods) t += l.n * (l.mesh.geometry.index ? l.mesh.geometry.index.count / 3 : 0);
    return t;
  }
}

// Per-frame view data shared by every herd.
export function createView(THREE_) {
  const frustum = new THREE_.Frustum();
  const m = new THREE_.Matrix4();
  const view = { cam: new THREE_.Vector3(), frustum, projScale: 600, maxDist: 12000, fov: 55, dir: new THREE_.Vector3() };
  view.update = (camera, cssHeight) => {
    camera.updateMatrixWorld();
    m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(m, camera.coordinateSystem, camera.reversedDepth);
    view.cam.setFromMatrixPosition(camera.matrixWorld);
    view.fov = camera.fov;
    view.projScale = cssHeight / 2 / Math.tan(THREE_.MathUtils.degToRad(camera.fov) / 2);
    camera.getWorldDirection(view.dir);
    view.maxDist = Math.min(camera.far, 14000);
  };
  return view;
}
