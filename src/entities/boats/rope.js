// A dynamic line (towline, tie line, anchor rode) as a thin tube whose vertices are rewritten each frame along a
// sagging curve. One draw call; no geometry allocation after creation.

import * as THREE from 'three';
import { patchUnderwater } from '../../render/shaderChunks.js';

export function createRope(ctx, { segments = 20, sides = 6, radius = 0.03, color = '#d6a53a', name = 'rope', parent = null } = {}) {
  const ring = sides + 1;
  const count = (segments + 1) * ring;
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const idx = [];
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < sides; j++) {
      const a = i * ring + j;
      const b = a + ring;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const aNor = new THREE.BufferAttribute(nor, 3).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', aPos);
  geo.setAttribute('normal', aNor);
  geo.setIndex(idx);
  // Lines can dip below the surface (anchor rode), so they take the shared underwater look.
  const mat = patchUnderwater(new THREE.MeshStandardMaterial({ color, roughness: 0.75 }), ctx.uniforms);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.visible = false;
  mesh.name = name;
  (parent ?? ctx.scene).add(mesh);

  const pts = Array.from({ length: segments + 1 }, () => new THREE.Vector3());
  const tan = new THREE.Vector3();
  const n1 = new THREE.Vector3();
  const n2 = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  return {
    mesh,
    // a, b: world endpoints; sag metres at mid-span; floor(x, z) keeps the line from passing under the sea surface
    // (it floats along it instead).
    set(a, b, sag = 0.3, floor = null) {
      mesh.visible = true;
      for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        const p = pts[i].lerpVectors(a, b, t);
        p.y -= sag * 4 * t * (1 - t);
        if (floor) {
          const f = floor(p.x, p.z) + radius * 0.6;
          if (p.y < f) p.y = f;
        }
      }
      for (let i = 0; i <= segments; i++) {
        const p = pts[i];
        tan.subVectors(pts[Math.min(segments, i + 1)], pts[Math.max(0, i - 1)]).normalize();
        n1.crossVectors(tan, up);
        if (n1.lengthSq() < 1e-6) n1.set(1, 0, 0);
        n1.normalize();
        n2.crossVectors(n1, tan).normalize();
        for (let j = 0; j <= sides; j++) {
          const a2 = (j / sides) * Math.PI * 2;
          const c = Math.cos(a2);
          const s = Math.sin(a2);
          const k = (i * ring + j) * 3;
          const nx = n1.x * c + n2.x * s;
          const ny = n1.y * c + n2.y * s;
          const nz = n1.z * c + n2.z * s;
          pos[k] = p.x + nx * radius;
          pos[k + 1] = p.y + ny * radius;
          pos[k + 2] = p.z + nz * radius;
          nor[k] = nx;
          nor[k + 1] = ny;
          nor[k + 2] = nz;
        }
      }
      aPos.needsUpdate = true;
      aNor.needsUpdate = true;
    },
    hide() {
      mesh.visible = false;
    },
  };
}
