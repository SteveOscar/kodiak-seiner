// QA: verifies that the overridden fog chunks compile and fog correctly for every kind of material other systems
// use. Each material is drawn alone, at a near and a far distance, into a float target; the far pixel must equal the
// fog colour and the near pixel must keep most of the material colour. Called from the smoke harness via
// __KODIAK__.systems.sky.debugFogCheck(); never during play.

import * as THREE from 'three';

const FOG = new THREE.Color(0.2, 0.4, 0.6);
const BASE = new THREE.Color(1, 0, 0);

function shaderMaterial() {
  return new THREE.ShaderMaterial({
    fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uColor: { value: BASE.clone() } }]),
    vertexShader: /* glsl */ `
      #include <fog_pars_vertex>
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      #include <fog_pars_fragment>
      void main() {
        gl_FragColor = vec4( uColor, 1.0 );
        #include <fog_fragment>
      }
    `,
  });
}

const KINDS = {
  MeshStandardMaterial: () => new THREE.MeshStandardMaterial({ color: 0x000000, emissive: BASE, roughness: 1 }),
  MeshLambertMaterial: () => new THREE.MeshLambertMaterial({ color: 0x000000, emissive: BASE }),
  MeshBasicMaterial: () => new THREE.MeshBasicMaterial({ color: BASE }),
  PointsMaterial: () => new THREE.PointsMaterial({ color: BASE, size: 64, sizeAttenuation: false }),
  SpriteMaterial: () => new THREE.SpriteMaterial({ color: BASE }),
  LineBasicMaterial: () => new THREE.LineBasicMaterial({ color: BASE }),
  ShaderMaterial: shaderMaterial,
};

function objectFor(kind, material, dist) {
  if (kind === 'PointsMaterial') {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([dist, 20, 0], 3));
    return new THREE.Points(g, material);
  }
  if (kind === 'SpriteMaterial') {
    const s = new THREE.Sprite(material);
    s.position.set(dist, 20, 0);
    s.scale.setScalar(dist * 0.5);
    return s;
  }
  if (kind === 'LineBasicMaterial') {
    const pts = [];
    const span = dist * 0.3;
    for (let i = -20; i <= 20; i++) {
      const y = 20 + (i / 20) * span * 0.05;
      pts.push(dist, y, -span, dist, y, span);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return new THREE.LineSegments(g, material);
  }
  const m = new THREE.Mesh(new THREE.PlaneGeometry(dist, dist), material);
  m.position.set(dist, 20, 0);
  m.rotation.y = -Math.PI / 2;
  return m;
}

export function runFogCheck(renderer, fogUniforms) {
  const target = new THREE.WebGLRenderTarget(32, 32, { type: THREE.FloatType, depthBuffer: true });
  const cam = new THREE.PerspectiveCamera(20, 1, 0.5, 40000);
  cam.position.set(0, 20, 0);
  cam.lookAt(1, 20, 0);
  cam.updateMatrixWorld();
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(FOG.clone(), 0.004);
  // Neutralise the key-light lobe for the test (restored below).
  const sun = fogUniforms.kodiakFogSun.value;
  const savedW = sun.w;
  sun.w = 0;
  const prev = renderer.getRenderTarget();
  const prevClear = new THREE.Color();
  renderer.getClearColor(prevClear);
  const prevAlpha = renderer.getClearAlpha();
  renderer.setClearColor(0x000000, 1);
  const px = new Float32Array(4);
  const results = {};
  try {
    for (const [kind, make] of Object.entries(KINDS)) {
      const row = { compiled: true };
      for (const [label, dist] of [
        ['near', 15],
        ['far', 6000],
      ]) {
        const mat = make();
        const obj = objectFor(kind, mat, dist);
        scene.add(obj);
        renderer.setRenderTarget(target);
        renderer.clear();
        renderer.render(scene, cam);
        renderer.readRenderTargetPixels(target, 16, 16, 1, 1, px);
        scene.remove(obj);
        obj.geometry?.dispose?.();
        mat.dispose();
        row[label] = [px[0], px[1], px[2]].map((v) => +v.toFixed(3));
      }
      const far = row.far;
      const near = row.near;
      const farErr = Math.max(Math.abs(far[0] - FOG.r), Math.abs(far[1] - FOG.g), Math.abs(far[2] - FOG.b));
      row.farErr = +farErr.toFixed(3);
      // Near: mostly the base colour (red), clearly not the fog colour.
      row.pass = farErr < 0.02 && near[0] > 0.6 && near[0] > near[2];
      results[kind] = row;
    }
    // Underwater clip: a seabed patch 60 m down and ~300 m away is fogged only over the in-air part of the ray, so it
    // keeps most of its colour (the full path would fog it to ~30%).
    {
      const mat = new THREE.MeshBasicMaterial({ color: BASE });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), mat);
      m.position.set(300, -60, 0);
      const cam2 = cam.clone();
      cam2.lookAt(300, -60, 0);
      cam2.updateMatrixWorld();
      scene.add(m);
      renderer.setRenderTarget(target);
      renderer.clear();
      renderer.render(scene, cam2);
      renderer.readRenderTargetPixels(target, 16, 16, 1, 1, px);
      scene.remove(m);
      m.geometry.dispose();
      mat.dispose();
      const c = [px[0], px[1], px[2]].map((v) => +v.toFixed(3));
      results.underwaterClip = { compiled: true, near: c, pass: c[0] > 0.6 && c[0] > c[2] };
    }
  } catch (err) {
    results.error = String(err?.message ?? err);
  } finally {
    sun.w = savedW;
    renderer.setRenderTarget(prev);
    renderer.setClearColor(prevClear, prevAlpha);
    target.dispose();
  }
  const programErrors = renderer.info.programs?.filter((p) => p.diagnostics && !p.diagnostics.runnable).map((p) => p.name) ?? [];
  return { results, programErrors, allPass: Object.values(results).every((r) => r.pass) && !programErrors.length };
}
