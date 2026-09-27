// Shared GLSL chunks registered by core at boot (before any system creates materials).
//
// kodiak_underwater — attenuates a fragment's colour along the part of the view ray that lies under the sea surface
// (y < 0), toward the water-column colour. Every material that can sit below y = 0 applies it (seabed terrain, fish,
// net web/leadline/rings, kelp, whales, pinnipeds, hull bottoms) so everything underwater shares one look and the
// water surface itself can stay a thin, mostly transparent layer. Values come from ctx.uniforms.uWaterAbsorb /
// uWaterScatter (owned by WP-OCEAN).
//
// Custom ShaderMaterial usage:
//   vertex:   #include <kodiak_underwater_pars_vertex>  ... after mvPosition is computed: #include <kodiak_underwater_vertex>
//   fragment: #include <kodiak_underwater_pars_fragment> ... after the lit linear colour is in gl_FragColor and before
//             tonemapping/colorspace/fog: #include <kodiak_underwater_fragment>
//   uniforms: include uWaterAbsorb and uWaterScatter (the shared objects from ctx.uniforms).
// Built-in materials: patchUnderwater(material, ctx.uniforms).

import * as THREE from 'three';

export function registerShaderChunks() {
  THREE.ShaderChunk.kodiak_underwater_pars_vertex = /* glsl */ `
varying vec3 vKWorldPos;`;
  // World position from mvPosition works for instanced and skinned meshes too.
  THREE.ShaderChunk.kodiak_underwater_vertex = /* glsl */ `
vKWorldPos = ( mvPosition.xyz - viewMatrix[ 3 ].xyz ) * mat3( viewMatrix );`;
  THREE.ShaderChunk.kodiak_underwater_pars_fragment = /* glsl */ `
varying vec3 vKWorldPos;
uniform vec3 uWaterAbsorb;
uniform vec3 uWaterScatter;`;
  THREE.ShaderChunk.kodiak_underwater_fragment = /* glsl */ `
{
  float kDepth = -vKWorldPos.y;
  if ( kDepth > 0.0 ) {
    float kLen = length( cameraPosition - vKWorldPos );
    float kPath = cameraPosition.y > 0.0 ? kDepth * kLen / max( cameraPosition.y - vKWorldPos.y, 1e-3 ) : kLen;
    vec3 kT = exp( -uWaterAbsorb * kPath );
    gl_FragColor.rgb = mix( uWaterScatter, gl_FragColor.rgb, kT );
  }
}`;
}

// onBeforeCompile patch for built-in mesh materials (Standard, Physical, Lambert, Phong, Basic).
export function patchUnderwater(material, uniforms) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.call(material, shader, renderer);
    shader.uniforms.uWaterAbsorb = uniforms.uWaterAbsorb;
    shader.uniforms.uWaterScatter = uniforms.uWaterScatter;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n#include <kodiak_underwater_pars_vertex>')
      .replace('#include <project_vertex>', '#include <project_vertex>\n#include <kodiak_underwater_vertex>');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n#include <kodiak_underwater_pars_fragment>')
      .replace('#include <opaque_fragment>', '#include <opaque_fragment>\n#include <kodiak_underwater_fragment>');
  };
  const prevKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${prevKey ? prevKey() : ''}|kuw`;
  material.needsUpdate = true;
  return material;
}
