// Bull kelp (Nereocystis) beds in rocky nearshore shallows: each plant is a floating bulb with a spray of long golden-
// brown blades streaming down-current, drawn as a textured card lying on the sea surface (render band 100, depthWrite
// off) that rides water.heightAt and turns with the tidal stream.

import * as THREE from 'three';
import { patchUnderwater } from '../../../render/shaderChunks.js';
import { SUN_LIGHT_PATCH } from './common.js';

function drawKelpTexture(size = 256) {
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size });
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, size, size);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // Blades stream toward +u from the bulb near u = 0.1 as a narrow, wavy comet tail (the card is 4x longer than wide,
  // so v is stretched: blade widths here are drawn narrow).
  const bx = size * 0.1;
  const by = size * 0.5;
  const blade = (len, endOff, w, phase, col) => {
    g.fillStyle = col;
    g.beginPath();
    const steps = 24;
    const top = [];
    const bot = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = bx + t * len;
      const y = by + endOff * Math.pow(t, 0.7) + Math.sin(t * 9 + phase) * size * 0.035 * t;
      const ww = w * (0.25 + 0.95 * Math.sin(Math.min(1, t * 1.15) * Math.PI * 0.92)) * (1 + 0.25 * Math.sin(t * 23 + phase));
      top.push([x, y - ww]);
      bot.push([x, y + ww]);
    }
    g.moveTo(top[0][0], top[0][1]);
    for (const [x, y] of top) g.lineTo(x, y);
    for (let i = bot.length - 1; i >= 0; i--) g.lineTo(bot[i][0], bot[i][1]);
    g.closePath();
    g.fill();
  };
  // Darker blades underneath, olive-amber ones on top.
  for (let k = 0; k < 26; k++) {
    const top = k >= 12;
    const len = size * (0.55 + rnd() * 0.37);
    const endOff = (rnd() - 0.5) * size * 0.8;
    const w = size * (0.012 + rnd() * 0.018);
    const col = top ? `rgba(${80 + rnd() * 18},${68 + rnd() * 12},${28 + rnd() * 8},0.9)` : `rgba(${50 + rnd() * 12},${44 + rnd() * 10},${20 + rnd() * 6},0.92)`;
    blade(len, endOff, w, rnd() * 6, col);
  }
  // Stipe trailing back from the bulb, then the bulb itself.
  g.strokeStyle = 'rgba(64,50,22,0.75)';
  g.lineWidth = size * 0.03;
  g.beginPath();
  g.moveTo(bx, by);
  g.quadraticCurveTo(bx - size * 0.05, by + size * 0.08, 0, by - size * 0.04);
  g.stroke();
  const grad = g.createRadialGradient(bx - size * 0.01, by - size * 0.03, size * 0.006, bx, by, size * 0.07);
  grad.addColorStop(0, 'rgba(150,126,70,1)');
  grad.addColorStop(0.5, 'rgba(84,66,30,1)');
  grad.addColorStop(1, 'rgba(48,38,18,1)');
  g.fillStyle = grad;
  g.beginPath();
  g.ellipse(bx, by, size * 0.04, size * 0.1, 0, 0, Math.PI * 2);
  g.fill();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

export function createKelpLayer({ ctx, sunScale, capacity = 1400 }) {
  const { uniforms } = ctx;
  const tex = drawKelpTexture(256);
  const mat = new THREE.MeshStandardMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    roughness: 0.55,
    metalness: 0,
    side: THREE.DoubleSide,
    alphaTest: 0.02,
  });
  mat.name = 'kelp';
  const own = { tkSunScale: sunScale };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, own);
    for (const k of ['uTerrainShadow', 'uWorldHalf', 'uSunDir', 'uSunColor']) shader.uniforms[k] = uniforms[k];
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec4 iPos;
attribute vec4 iRot;
uniform sampler2D uTerrainShadow;
uniform float uWorldHalf;
varying float kpShadow;`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `vec3 objectNormal = vec3( 0.0, 1.0, 0.0 );
  vec3 kpL = position * iPos.w;
  vec3 kpW = vec3( kpL.x * iRot.x - kpL.z * iRot.y, 0.0, kpL.x * iRot.y + kpL.z * iRot.x ) + iPos.xyz;
  kpShadow = textureLod( uTerrainShadow, clamp( ( iPos.xz + uWorldHalf ) / ( 2.0 * uWorldHalf ), 0.0, 1.0 ), 0.0 ).r;`,
      )
      .replace('#include <begin_vertex>', 'vec3 transformed = kpW;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform vec3 uSunDir;\nuniform vec3 uSunColor;\nuniform float tkSunScale;\nvarying float kpShadow;`)
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
  // Blades trail off just under the surface: thinner and tinted by the water column toward their tips.
  {
    float kpTip = smoothstep( 0.3, 1.0, vMapUv.x );
    diffuseColor.a *= 1.0 - 0.45 * kpTip;
    diffuseColor.rgb = mix( diffuseColor.rgb, uWaterScatter * 1.6, kpTip * 0.4 );
  }`,
      )
      .replace('#include <lights_fragment_begin>', SUN_LIGHT_PATCH('kpShadow'));
  };
  mat.customProgramCacheKey = () => 'kelp-v4';
  patchUnderwater(mat, uniforms);

  const quad = new THREE.BufferGeometry();
  // Card lying on the water, bulb near the local origin, blades toward +x.
  quad.setAttribute('position', new THREE.Float32BufferAttribute([-0.1, 0, -0.16, 0.9, 0, -0.16, 0.9, 0, 0.16, -0.1, 0, 0.16], 3));
  quad.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  quad.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2));
  quad.setIndex([0, 2, 1, 0, 3, 2]);
  const g = new THREE.InstancedBufferGeometry();
  g.index = quad.index;
  for (const [k, v] of Object.entries(quad.attributes)) g.setAttribute(k, v);
  const P = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  const R = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  P.setUsage(THREE.DynamicDrawUsage);
  R.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('iPos', P);
  g.setAttribute('iRot', R);
  g.instanceCount = 0;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = 'kelp';
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = 100;
  mesh.receiveShadow = true;
  ctx.scene.add(mesh);

  // Plants: base positions (x, z, size, phase) kept on the CPU; y and heading are refreshed round-robin.
  let base = new Float32Array(0);
  let n = 0;
  let cursor = 0;
  const cur = { x: 0, z: 0 };
  const heading = new Float32Array(capacity);
  return {
    mesh,
    get count() {
      return n;
    },
    // data: stride 8 from the scatter layer (x, y, z, size, cos, sin, tint, phase)
    setPlants(data, count, stride, camX, camZ) {
      n = Math.min(count, capacity);
      base = new Float32Array(n * 4);
      const order = [];
      for (let i = 0; i < n; i++) order.push(i);
      order.sort((a, b) => Math.hypot(data[a * stride] - camX, data[a * stride + 2] - camZ) - Math.hypot(data[b * stride] - camX, data[b * stride + 2] - camZ));
      for (let k = 0; k < n; k++) {
        const o = order[k] * stride;
        base[k * 4] = data[o];
        base[k * 4 + 1] = data[o + 2];
        base[k * 4 + 2] = data[o + 3];
        base[k * 4 + 3] = data[o + 7];
        heading[k] = Math.atan2(data[o + 5], data[o + 4]);
        P.array[k * 4] = data[o];
        P.array[k * 4 + 1] = 0.02;
        P.array[k * 4 + 2] = data[o + 2];
        P.array[k * 4 + 3] = data[o + 3];
        R.array[k * 4] = data[o + 4];
        R.array[k * 4 + 1] = data[o + 5];
      }
      cursor = 0;
      g.instanceCount = n;
      for (const a of [P, R]) {
        a.clearUpdateRanges();
        a.needsUpdate = true;
      }
    },
    // Ride the swell and turn with the tide. Nearest plants every frame, the rest round-robin.
    update(dt, budget = 110) {
      if (!n) return;
      const water = ctx.systems.water;
      const hAt = water?.heightAt;
      const near = Math.min(n, 40);
      let done = 0;
      const doOne = (k) => {
        const x = base[k * 4];
        const z = base[k * 4 + 1];
        let y = 0;
        try {
          y = hAt ? hAt(x, z) : 0;
        } catch {
          y = 0;
        }
        P.array[k * 4 + 1] = (Number.isFinite(y) ? y : 0) + 0.05;
        if ((k + ctx.time.frame) % 16 === 0) {
          ctx.tide?.currentAt?.(x, z, cur);
          const sp = Math.hypot(cur.x, cur.z);
          if (sp > 0.02) {
            const target = Math.atan2(cur.z, cur.x) + (base[k * 4 + 3] - 0.5) * 0.9;
            let d = target - heading[k];
            d = Math.atan2(Math.sin(d), Math.cos(d));
            heading[k] += d * Math.min(1, dt * 16 * 0.4);
            R.array[k * 4] = Math.cos(heading[k]);
            R.array[k * 4 + 1] = Math.sin(heading[k]);
          }
        }
        done++;
      };
      for (let k = 0; k < near; k++) doOne(k);
      while (done < budget && n > near) {
        doOne(near + (cursor % (n - near)));
        cursor++;
        if (cursor > n) cursor = 0;
      }
      P.clearUpdateRanges();
      P.addUpdateRange(0, n * 4);
      P.needsUpdate = true;
      R.clearUpdateRanges();
      R.addUpdateRange(0, n * 4);
      R.needsUpdate = true;
    },
  };
}
