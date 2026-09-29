// Bull kelp (Nereocystis) beds in rocky nearshore shallows. Each plant is a round float (pneumatocyst) with a small
// spray of ribbon blades streaming down-current. Two instanced layers share one geometry:
//   'kelp'        render band 100, drawn over the water: the floats and the awash first third of the blades, dark
//                 olive-brown with a wet sheen (reduced diffuse sun, low roughness).
//   'kelp-under'  render band -100, drawn before the water: the full blades sinking from ~0.06 m to ~0.45 m below the
//                 surface, so the water layer (fresnel, reflection, sun glitter) and kodiak_underwater cover them.
// The card subdivisions ride water.heightAt at the float, undulate slowly, and fade out with distance (KELP_FADE) so
// far beds never read as floating debris. Four atlas variants (three fronds, one cluster of bare floats) keep a bed
// from repeating one shape.

import * as THREE from 'three';
import { patchUnderwater } from '../../../render/shaderChunks.js';
import { SUN_LIGHT_PATCH } from './common.js';

// Camera distance (m) over which the beds fade out; the scatter radius must reach KELP_FADE[1].
export const KELP_FADE = [70, 190];
// Card extents in plant-size units: the float sits at the local origin, blades stream toward +x.
export const KELP_CARD = { x0: -0.1, x1: 0.9, halfWidth: 0.25 };
// Blade sink below the surface (m) at the float end and at the tips of the card, for the under layer.
export const KELP_SINK = [0.06, 0.45];

// One atlas cell per variant (2 x 2 cells of W x H px, W:H matching the card's 1.0 : 0.5 so pixels stay square).
// mode 'surface': floats plus blade bases fading out along the first third; 'under': blades only.
function drawKelpAtlas(mode, W = 256, H = 128) {
  const size = [W * 2, H * 2];
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size[0], size[1]) : Object.assign(document.createElement('canvas'), { width: size[0], height: size[1] });
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, size[0], size[1]);
  const bulbU = (0 - KELP_CARD.x0) / (KELP_CARD.x1 - KELP_CARD.x0);
  for (let cell = 0; cell < 4; cell++) {
    let seed = 11 + cell * 7919;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const ox = (cell % 2) * W;
    const oy = Math.floor(cell / 2) * H;
    g.save();
    g.beginPath();
    g.rect(ox, oy, W, H);
    g.clip();
    const bx = ox + W * bulbU;
    const by = oy + H * 0.5;
    const floatsOnly = cell === 3;
    // Floats: frond variants carry one to three plants bunched together (a cluster, never a lone head-and-tail shape);
    // the bare-float variant is a loose cluster whose blades hang out of sight.
    const FLOATS = [
      [[0, 0, 1]],
      [[0, 0, 1], [W * 0.07, H * 0.17, 0.75]],
      [[0, 0, 1], [W * 0.04, -H * 0.18, 0.8], [W * 0.12, H * 0.12, 0.65]],
      [[0, 0, 1], [W * 0.1, H * 0.16, 0.8], [W * 0.05, -H * 0.2, 0.7]],
    ];
    const floats = FLOATS[cell];
    const blade = (x0, y0, len, dir, curl, w, phase, col) => {
      const steps = 22;
      const top = [];
      const bot = [];
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const a = dir + curl * t;
        const x = x0 + Math.cos(a) * t * len;
        const y = y0 + Math.sin(a) * t * len + Math.sin(t * 7 + phase) * H * 0.03 * t;
        // Ribbon: narrow at the float, widest past the middle, ruffled edges, rounded tip.
        const ww = w * (0.35 + 0.65 * Math.sin(Math.min(1, t * 1.1) * Math.PI * 0.85)) * (1 + 0.3 * Math.sin(t * 31 + phase * 3));
        const nx = -Math.sin(a);
        const ny = Math.cos(a);
        top.push([x + nx * ww, y + ny * ww]);
        bot.push([x - nx * ww, y - ny * ww]);
      }
      g.fillStyle = col;
      g.beginPath();
      g.moveTo(top[0][0], top[0][1]);
      for (const [x, y] of top) g.lineTo(x, y);
      for (let i = bot.length - 1; i >= 0; i--) g.lineTo(bot[i][0], bot[i][1]);
      g.closePath();
      g.fill();
    };
    // Blades: a few per float, in two loose bunches, irregular lengths; darker ones lie deeper.
    for (const [fx, fy, fs] of floats) {
      const nb = floatsOnly ? 2 : (floats.length > 1 ? 3 : 4) + Math.floor(rnd() * 3);
      const bunch = (rnd() - 0.5) * 0.5;
      for (let k = 0; k < nb; k++) {
        const deep = k % 2 === 0;
        const len = (floatsOnly ? W * (0.12 + rnd() * 0.12) : W * (0.42 + rnd() * 0.42)) * fs;
        // Blades trail nearly parallel down-current (a narrow streamer, not a fan).
        const dir = bunch * 0.5 + (k % 3 === 0 ? -1 : 1) * (0.02 + rnd() * 0.15);
        const curl = (rnd() - 0.5) * 0.6;
        const w = H * (0.03 + rnd() * 0.025);
        const r = deep ? 58 + rnd() * 10 : 74 + rnd() * 12;
        // Submerged blades are thin, translucent tissue: lower cover so the bed reads as a shadow in the water.
        const cover = (deep ? 0.88 : 0.93) * (mode === 'under' ? 0.55 : 1);
        const col = `rgba(${r | 0},${(r * 0.92 + 3) | 0},${(r * 0.45) | 0},${cover.toFixed(3)})`;
        blade(bx + fx, by + fy, len, dir, curl, w, rnd() * 6, col);
      }
    }
    if (mode === 'surface') {
      // Only the blade bases float awash; the rest are in the under layer.
      g.globalCompositeOperation = 'destination-in';
      const grad = g.createLinearGradient(bx, 0, bx + W * 0.42, 0);
      grad.addColorStop(0, 'rgba(0,0,0,0.95)');
      grad.addColorStop(0.35, 'rgba(0,0,0,0.6)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.fillRect(ox, oy, W, H);
      g.globalCompositeOperation = 'source-over';
      for (const [fx, fy, fs] of floats) {
        const rr = H * 0.08 * fs;
        const cx = bx + fx;
        const cy = by + fy;
        // Stipe stub trailing up-current, then the float: dark olive with a wet highlight.
        g.strokeStyle = 'rgba(58,52,26,0.8)';
        g.lineWidth = rr * 0.55;
        g.beginPath();
        g.moveTo(cx, cy);
        g.quadraticCurveTo(cx - rr * 1.6, cy + rr * 0.6, cx - rr * 2.6, cy - rr * 0.2);
        g.stroke();
        const bg = g.createRadialGradient(cx - rr * 0.3, cy - rr * 0.35, rr * 0.08, cx, cy, rr);
        bg.addColorStop(0, 'rgba(128,114,70,1)');
        bg.addColorStop(0.45, 'rgba(78,70,36,1)');
        bg.addColorStop(1, 'rgba(44,40,20,1)');
        g.fillStyle = bg;
        g.beginPath();
        g.arc(cx, cy, rr, 0, Math.PI * 2);
        g.fill();
      }
    }
    g.restore();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

function kelpMaterial({ ctx, sunScale, mode }) {
  const { uniforms } = ctx;
  const surface = mode === 'surface';
  const mat = new THREE.MeshStandardMaterial({
    map: drawKelpAtlas(mode),
    transparent: true,
    depthWrite: false,
    // Wet sheen on the awash floats; the submerged blades take their highlights from the water surface instead.
    roughness: surface ? 0.36 : 0.85,
    metalness: 0,
    side: THREE.DoubleSide,
    alphaTest: 0.02,
  });
  mat.name = surface ? 'kelp' : 'kelp-under';
  const own = { tkSunScale: sunScale, uKelpFade: { value: new THREE.Vector2(KELP_FADE[0], KELP_FADE[1]) } };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, own);
    for (const k of ['uTerrainShadow', 'uWorldHalf', 'uSunDir', 'uSunColor', 'uTime']) shader.uniforms[k] = uniforms[k];
    const lift = surface ? '0.04' : `-mix( ${KELP_SINK[0].toFixed(3)}, ${KELP_SINK[1].toFixed(3)}, kpT )`;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec4 iPos;
attribute vec4 iRot;
uniform sampler2D uTerrainShadow;
uniform float uWorldHalf;
uniform float uTime;
uniform vec2 uKelpFade;
varying float kpShadow;
varying float kpFade;`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `vec3 objectNormal = vec3( 0.0, 1.0, 0.0 );
  float kpT = clamp( position.x / ${KELP_CARD.x1.toFixed(3)}, 0.0, 1.0 );
  // Blades undulate slowly across the stream, more toward their tips.
  vec3 kpP = position;
  kpP.z += sin( uTime * 0.9 + iRot.z * 6.283 + kpT * 4.0 ) * 0.035 * kpT;
  vec3 kpL = kpP * iPos.w;
  vec3 kpW = vec3( kpL.x * iRot.x - kpL.z * iRot.y, ${lift}, kpL.x * iRot.y + kpL.z * iRot.x ) + iPos.xyz;
  kpShadow = textureLod( uTerrainShadow, clamp( ( iPos.xz + uWorldHalf ) / ( 2.0 * uWorldHalf ), 0.0, 1.0 ), 0.0 ).r;
  kpFade = 1.0 - smoothstep( uKelpFade.x, uKelpFade.y, length( cameraPosition.xz - iPos.xz ) );`,
      )
      .replace('#include <begin_vertex>', 'vec3 transformed = kpW;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n  vMapUv = ( vec2( uv.x, uv.y ) + vec2( mod( floor( iRot.z * 4.0 ), 2.0 ), floor( floor( iRot.z * 4.0 ) / 2.0 ) ) ) * 0.5;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform vec3 uSunDir;\nuniform vec3 uSunColor;\nuniform float tkSunScale;\nvarying float kpShadow;\nvarying float kpFade;`)
      .replace('#include <map_fragment>', '#include <map_fragment>\n  diffuseColor.a *= kpFade;\n  if ( diffuseColor.a < 0.01 ) discard;')
      // Wet, dark tissue: take roughly half the direct sun a dry leaf would.
      .replace('#include <lights_fragment_begin>', SUN_LIGHT_PATCH(`kpShadow * ${surface ? '0.5' : '0.7'}`));
  };
  mat.customProgramCacheKey = () => `kelp-v7-${mode}`;
  patchUnderwater(mat, uniforms);
  return mat;
}

export function createKelpLayer({ ctx, sunScale, capacity = 1400 }) {
  // Card subdivided along the blades (so the under layer can sink and undulate), float at the local origin.
  const SEG = 8;
  const pos = [];
  const uv = [];
  const nrm = [];
  const idx = [];
  for (let i = 0; i <= SEG; i++) {
    const u = i / SEG;
    const x = KELP_CARD.x0 + u * (KELP_CARD.x1 - KELP_CARD.x0);
    pos.push(x, 0, -KELP_CARD.halfWidth, x, 0, KELP_CARD.halfWidth);
    uv.push(u, 1, u, 0);
    nrm.push(0, 1, 0, 0, 1, 0);
    if (i < SEG) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setIndex(idx);
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  const P = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  const R = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  P.setUsage(THREE.DynamicDrawUsage);
  R.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('iPos', P);
  g.setAttribute('iRot', R);
  g.instanceCount = 0;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  const makeMesh = (mode, order) => {
    const mesh = new THREE.Mesh(g, kelpMaterial({ ctx, sunScale, mode }));
    mesh.name = mode === 'surface' ? 'kelp' : 'kelp-under';
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = order;
    mesh.receiveShadow = mode === 'surface';
    return mesh;
  };
  const mesh = makeMesh('surface', 100);
  const under = makeMesh('under', -100);
  ctx.scene.add(mesh);
  ctx.scene.add(under);

  // Plants: base positions (x, z, size, phase) kept on the CPU; y and heading are refreshed round-robin.
  let base = new Float32Array(0);
  let n = 0;
  let cursor = 0;
  const cur = { x: 0, z: 0 };
  const heading = new Float32Array(capacity);
  return {
    mesh,
    meshes: [mesh, under],
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
        P.array[k * 4 + 1] = 0;
        P.array[k * 4 + 2] = data[o + 2];
        P.array[k * 4 + 3] = data[o + 3];
        R.array[k * 4] = data[o + 4];
        R.array[k * 4 + 1] = data[o + 5];
        // Atlas variant and undulation phase.
        R.array[k * 4 + 2] = Math.min(0.999, data[o + 7]);
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
        P.array[k * 4 + 1] = Number.isFinite(y) ? y : 0;
        if ((k + ctx.time.frame) % 16 === 0) {
          ctx.tide?.currentAt?.(x, z, cur);
          const sp = Math.hypot(cur.x, cur.z);
          if (sp > 0.02) {
            const target = Math.atan2(cur.z, cur.x) + (base[k * 4 + 3] - 0.5) * 0.5;
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
