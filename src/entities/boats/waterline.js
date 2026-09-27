// Local sea level for the shared kodiak_underwater chunk on boat hulls. The chunk treats y < 0 as underwater, but a
// hull riding a swell sits in troughs and on crests, so bands of topsides above the real surface would be tinted
// (and wetted bottoms on a crest left dry). This shifts the chunk's world height by a plane fitted to the sea under
// the boat: sea(x, z) = a*x + b*z + c. Apply after patchUnderwater().

import * as THREE from 'three';

export function createSeaPlane() {
  return { value: new THREE.Vector4(0, 0, 0, 1) };
}

export function patchWaterline(material, seaUniform) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.call(material, shader, renderer);
    shader.uniforms.uKSea = seaUniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec4 uKSea;')
      .replace(
        '#include <kodiak_underwater_vertex>',
        '#include <kodiak_underwater_vertex>\nvKWorldPos.y -= (uKSea.x * vKWorldPos.x + uKSea.y * vKWorldPos.z + uKSea.z) * uKSea.w;',
      );
  };
  const prevKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${prevKey ? prevKey() : ''}|ksea`;
  material.needsUpdate = true;
  return material;
}

// Fit the plane from samples at a hull's centre (cx, cz, h0) with gradients along its forward (gf) and right (gr)
// axes for heading `heading`. slopes = false keeps only the level (for materials shared by boats far apart).
export function setSeaPlane(uniform, cx, cz, h0, gf = 0, gr = 0, heading = 0, slopes = true) {
  const fx = Math.sin(heading);
  const fz = -Math.cos(heading);
  const rx = Math.cos(heading);
  const rz = Math.sin(heading);
  const gx = slopes ? gf * fx + gr * rx : 0;
  const gz = slopes ? gf * fz + gr * rz : 0;
  uniform.value.set(gx, gz, h0 - gx * cx - gz * cz, 1);
}
