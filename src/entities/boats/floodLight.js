// Deck floods without scene lights: a real SpotLight would add a light loop to every lit material in the world
// (terrain, vegetation, buildings), so the seiner's floods are injected only into the materials of the boat, its crew
// and its skiff. Two cone lights in world space; colour is zero when the floods are off (no recompiles).

import * as THREE from 'three';

const COUNT = 2;

export function createDeckFloods(defs) {
  // defs: [{ pos: [x, y, z], target: [x, y, z], angle (half-angle, rad), range (m) }] in the boat's local frame.
  const local = defs.map((d) => ({
    pos: new THREE.Vector3(...d.pos),
    dir: new THREE.Vector3(...d.target).sub(new THREE.Vector3(...d.pos)).normalize(),
  }));
  const uniforms = {
    uFloodPos: { value: local.map(() => new THREE.Vector3()) },
    uFloodDir: { value: local.map(() => new THREE.Vector3(0, -1, 0)) },
    uFloodCone: { value: defs.map((d) => new THREE.Vector2(Math.cos(d.angle), d.range)) },
    uFloodColor: { value: new THREE.Color(0, 0, 0) },
  };
  const base = new THREE.Color(0xffdcae);
  const q = new THREE.Quaternion();
  const patched = new WeakSet();

  const VERT_PARS = /* glsl */ `
varying vec3 vFloodWorld;`;
  const VERT = /* glsl */ `
vFloodWorld = ( mvPosition.xyz - viewMatrix[ 3 ].xyz ) * mat3( viewMatrix );`;
  const FRAG_PARS = /* glsl */ `
varying vec3 vFloodWorld;
uniform vec3 uFloodPos[ ${COUNT} ];
uniform vec3 uFloodDir[ ${COUNT} ];
uniform vec2 uFloodCone[ ${COUNT} ];
uniform vec3 uFloodColor;`;
  // Lambert with a little wrap (bounce off the white deckhouse), soft cone edge, inverse-square-ish falloff.
  const FRAG = /* glsl */ `
if ( uFloodColor.r + uFloodColor.g + uFloodColor.b > 0.0 ) {
  vec3 fN = inverseTransformDirection( normal, viewMatrix );
  float fl = 0.0;
  for ( int i = 0; i < ${COUNT}; i ++ ) {
    vec3 d = uFloodPos[ i ] - vFloodWorld;
    float dist = max( length( d ), 0.05 );
    vec3 l = d / dist;
    float cone = smoothstep( uFloodCone[ i ].x, uFloodCone[ i ].x + 0.15, dot( -l, uFloodDir[ i ] ) );
    float att = ( 1.0 / ( 1.0 + 0.045 * dist * dist ) ) * ( 1.0 - smoothstep( uFloodCone[ i ].y * 0.6, uFloodCone[ i ].y, dist ) );
    fl += ( max( dot( fN, l ), 0.0 ) * 0.85 + 0.15 ) * cone * att;
  }
  reflectedLight.directDiffuse += BRDF_Lambert( diffuseColor.rgb ) * uFloodColor * fl;
}`;

  return {
    uniforms,
    // Patches a built-in lit material (Standard/Physical). Chains any existing onBeforeCompile.
    patch(material) {
      if (!material || patched.has(material)) return material;
      patched.add(material);
      const prev = material.onBeforeCompile;
      material.onBeforeCompile = (shader, renderer) => {
        prev?.call(material, shader, renderer);
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
          .replace('#include <project_vertex>', `#include <project_vertex>\n${VERT}`);
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
          .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${FRAG}`);
      };
      const prevKey = material.customProgramCacheKey?.bind(material);
      material.customProgramCacheKey = () => `${prevKey ? prevKey() : ''}|kflood`;
      material.needsUpdate = true;
      return material;
    },
    // Move the floods with the boat (call after its matrixWorld is current). intensity 0 = off.
    update(object3d, intensity) {
      object3d.getWorldQuaternion(q);
      for (let i = 0; i < local.length; i++) {
        uniforms.uFloodPos.value[i].copy(local[i].pos).applyMatrix4(object3d.matrixWorld);
        uniforms.uFloodDir.value[i].copy(local[i].dir).applyQuaternion(q);
      }
      uniforms.uFloodColor.value.copy(base).multiplyScalar(intensity);
    },
  };
}
