// Seine rendering: instanced corks, the corkline/leadline/purse-line ropes, the translucent web curtain under water,
// purse rings, the net climbing into the power block, and the pile on the stern deck. Everything except the pile
// is written in world space every frame from the simulation snapshot (see net.js `frameData`).

import {
  corkMaterial,
  createPixelUniform,
  createRibbonBatch,
  ribbonMaterial,
  ringMaterial,
  solidWebMaterial,
  webMaterial,
} from './materials.js';
import { NET_TUNING } from './tuning.js';

export const CORK_SPACING = 1.25;
const ROWS = 6;
const RING_EVERY = 3;
const MAX_CORKS = 560;
const MAX_RINGS = 90;
const PILE_CORKS = 54;
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;
// Cubic Bezier through x0..x3 / y0..y3 / z0..z3 at t, written into out.
function bez(x0, x1, x2, x3, y0, y1, y2, y3, z0, z1, z2, z3, t, out) {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  out.x = a * x0 + b * x1 + c * x2 + d * x3;
  out.y = a * y0 + b * y1 + c * y2 + d * y3;
  out.z = a * z0 + b * z1 + c * z2 + d * z3;
  return out;
}

function corkGeometry(THREE) {
  // Spindle-shaped seine float, long axis along +Z.
  const pts = [];
  const L = 0.34;
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    const r = 0.112 * Math.pow(Math.sin(Math.PI * t), 0.55) + (i === 0 || i === 8 ? 0.018 : 0);
    pts.push(new THREE.Vector2(r, (t - 0.5) * L));
  }
  const g = new THREE.LatheGeometry(pts, 10);
  g.rotateX(Math.PI / 2);
  return g;
}

function pileGeometry(THREE) {
  // A heap of web on the stern deck, local: x across the beam, z fore-aft, y up. Unit height at the crest.
  const nx = 22;
  const nz = 18;
  const W = 4.4;
  const D = 3.8;
  const pos = [];
  const uv = [];
  const idx = [];
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const u = i / nx - 0.5;
      const v = j / nz - 0.5;
      const r = Math.min(1, Math.hypot(u * 2, v * 2) ** 2.2);
      const fold = 0.07 * Math.sin(u * 23 + v * 7) * Math.sin(v * 19 - u * 5) + 0.05 * Math.sin(u * 41 + v * 31);
      const h = Math.max(0, (1 - r) ** 0.55 * (0.85 + 0.15 * Math.cos(u * 3.1)) + fold * (1 - r));
      pos.push(u * W * (1 - 0.05 * h), h, v * D * (1 - 0.05 * h));
      uv.push(u * W * 1.6 + fold * 3, v * D * 1.6 + h * 2);
    }
  }
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      const b = a + 1;
      const c = a + nx + 1;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aNetUv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return { geometry: g, width: W, depth: D };
}

export function createNetView(ctx, { maxNodes = 201 } = {}) {
  const { THREE, scene } = ctx;
  const pixel = createPixelUniform();
  const group = new THREE.Group();
  group.name = 'net';
  scene.add(group);

  const col = (hex) => new THREE.Color(hex);
  const C = {
    corkYellow: col('#e0ac2c'),
    corkWhite: col('#ece6d6'),
    corkOrange: col('#e2742a'),
    corkline: col('#d8cfb0'),
    leadline: col('#2b2e2c'),
    purse: col('#6f6a5c'),
    line: col('#c9b98f'),
    web: col('#2b4634'),
  };

  // --- corks ---------------------------------------------------------------------------------------------------
  const corkMesh = new THREE.InstancedMesh(corkGeometry(THREE), corkMaterial(ctx), MAX_CORKS);
  corkMesh.name = 'net-corks';
  corkMesh.frustumCulled = false;
  corkMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  corkMesh.count = 0;
  for (let i = 0; i < MAX_CORKS; i++) {
    // Mostly sun-faded yellow, a white every seventh, and orange bunt corks at the skiff end.
    const c = i < 14 ? C.corkOrange : i % 7 === 3 ? C.corkWhite : C.corkYellow;
    corkMesh.setColorAt(i, c);
  }
  corkMesh.instanceColor.needsUpdate = true;
  group.add(corkMesh);
  const cm = corkMesh.instanceMatrix.array;

  // --- rings ---------------------------------------------------------------------------------------------------
  const ringMesh = new THREE.InstancedMesh(new THREE.TorusGeometry(0.13, 0.021, 6, 14), ringMaterial(ctx), MAX_RINGS);
  ringMesh.name = 'net-rings';
  ringMesh.frustumCulled = false;
  ringMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  ringMesh.count = 0;
  group.add(ringMesh);
  const rm = ringMesh.instanceMatrix.array;

  // --- ropes and lifted bundles ---------------------------------------------------------------------------------
  const ropes = createRibbonBatch(ctx, ribbonMaterial(ctx, { pixel, minPixels: 1.3 }), 2 * maxNodes + 600, 'net-ropes');
  group.add(ropes.mesh);
  const bundles = createRibbonBatch(
    ctx,
    ribbonMaterial(ctx, { pixel, minPixels: 2.2, web: true, color: '#ffffff' }),
    260,
    'net-bundles',
  );
  group.add(bundles.mesh);

  // --- web curtain -----------------------------------------------------------------------------------------------
  const cols = maxNodes + 2;
  const wv = cols * (ROWS + 1);
  const wPos = new Float32Array(wv * 3);
  const wUv = new Float32Array(wv * 2);
  const wNrm = new Float32Array(wv * 3);
  for (let i = 0; i < wv; i++) wNrm[i * 3 + 1] = 1;
  const wIdx = new Uint32Array((cols - 1) * ROWS * 6);
  {
    let k = 0;
    for (let c = 0; c < cols - 1; c++) {
      for (let r = 0; r < ROWS; r++) {
        const a = c * (ROWS + 1) + r;
        const b = a + ROWS + 1;
        wIdx[k++] = a;
        wIdx[k++] = b;
        wIdx[k++] = a + 1;
        wIdx[k++] = a + 1;
        wIdx[k++] = b;
        wIdx[k++] = b + 1;
      }
    }
  }
  const webGeo = new THREE.BufferGeometry();
  const aWPos = new THREE.BufferAttribute(wPos, 3).setUsage(THREE.DynamicDrawUsage);
  const aWUv = new THREE.BufferAttribute(wUv, 2).setUsage(THREE.DynamicDrawUsage);
  const aWNrm = new THREE.BufferAttribute(wNrm, 3).setUsage(THREE.DynamicDrawUsage);
  webGeo.setAttribute('position', aWPos);
  webGeo.setAttribute('aNetUv', aWUv);
  webGeo.setAttribute('normal', aWNrm);
  webGeo.setIndex(new THREE.BufferAttribute(wIdx, 1));
  webGeo.setDrawRange(0, 0);
  const webMesh = new THREE.Mesh(webGeo, webMaterial(ctx));
  webMesh.name = 'net-web';
  webMesh.renderOrder = -100;
  webMesh.frustumCulled = false;
  webMesh.matrixAutoUpdate = false;
  group.add(webMesh);

  // --- pile on deck ----------------------------------------------------------------------------------------------
  const pile = pileGeometry(THREE);
  const pileMesh = new THREE.Mesh(pile.geometry, solidWebMaterial(ctx, { color: '#3a6a45', cell: 0.05 }));
  pileMesh.name = 'net-pile';
  pileMesh.castShadow = !!ctx.quality?.shadows;
  pileMesh.receiveShadow = !!ctx.quality?.shadows;
  pileMesh.matrixAutoUpdate = false;
  pileMesh.matrixWorldAutoUpdate = false;
  pileMesh.visible = false;
  scene.add(pileMesh);

  // Scratch state.
  const leadX = new Float32Array(cols);
  const leadY = new Float32Array(cols);
  const leadZ = new Float32Array(cols);
  const cx = new Float32Array(cols);
  const cy = new Float32Array(cols);
  const cz = new Float32Array(cols);
  const colU = new Float32Array(cols);
  const hang = new Float32Array(cols);
  const v3 = new THREE.Vector3();
  const v3b = new THREE.Vector3();
  const m4 = new THREE.Matrix4();
  const m4b = new THREE.Matrix4();
  const pileTop = new THREE.Vector3();
  const pileLocal = new THREE.Vector3();
  let nCork = 0;
  let nRing = 0;

  function setCork(x, y, z, dirx, diry, dirz, s) {
    if (nCork >= MAX_CORKS) return;
    const o = nCork * 16;
    let l = Math.hypot(dirx, diry, dirz);
    if (l < 1e-6) {
      dirx = 0;
      diry = 0;
      dirz = 1;
      l = 1;
    }
    const zx = dirx / l;
    const zy = diry / l;
    const zz = dirz / l;
    // x axis = horizontal perpendicular, y = z × x
    let xx = zz;
    let xy = 0;
    let xz = -zx;
    const xl = Math.hypot(xx, xz);
    if (xl < 1e-5) {
      xx = 1;
      xz = 0;
    } else {
      xx /= xl;
      xz /= xl;
    }
    const yx = zy * xz - zz * xy;
    const yy = zz * xx - zx * xz;
    const yz = zx * xy - zy * xx;
    cm[o] = xx * s;
    cm[o + 1] = xy * s;
    cm[o + 2] = xz * s;
    cm[o + 3] = 0;
    cm[o + 4] = yx * s;
    cm[o + 5] = yy * s;
    cm[o + 6] = yz * s;
    cm[o + 7] = 0;
    cm[o + 8] = zx * s;
    cm[o + 9] = zy * s;
    cm[o + 10] = zz * s;
    cm[o + 11] = 0;
    cm[o + 12] = x;
    cm[o + 13] = y;
    cm[o + 14] = z;
    cm[o + 15] = 1;
    nCork++;
  }

  function setRing(x, y, z, yaw, tilt) {
    if (nRing >= MAX_RINGS) return;
    const o = nRing * 16;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const ct = Math.cos(tilt);
    const st = Math.sin(tilt);
    // Torus lies in its local XY plane; hang it vertically, yawed along the leadline and tilted a little.
    rm[o] = c;
    rm[o + 1] = 0;
    rm[o + 2] = -s;
    rm[o + 3] = 0;
    rm[o + 4] = s * st;
    rm[o + 5] = ct;
    rm[o + 6] = c * st;
    rm[o + 7] = 0;
    rm[o + 8] = s * ct;
    rm[o + 9] = -st;
    rm[o + 10] = c * ct;
    rm[o + 11] = 0;
    rm[o + 12] = x;
    rm[o + 13] = y;
    rm[o + 14] = z;
    rm[o + 15] = 1;
    nRing++;
  }

  // Catenary-ish sag point between a and b at t with extra drop `sag` (m).
  function sagPoint(ax, ay, az, bx, by, bz, t, sag, out) {
    out.set(lerp(ax, bx, t), lerp(ay, by, t) - sag * 4 * t * (1 - t), lerp(az, bz, t));
    return out;
  }

  const view = {
    group,
    pileMesh,
    pixel,

    // f: see net.js frameData(). camera: the render camera (already positioned for this frame).
    update(f, camera) {
      const cam = camera.position;
      const fovRad = (camera.fov * Math.PI) / 180;
      const height = ctx.renderer?.domElement?.clientHeight || 720;
      pixel.value = (2 * Math.tan(fovRad / 2)) / Math.max(200, height);

      updatePile(f);
      nCork = 0;
      nRing = 0;
      ropes.begin();
      bundles.begin();
      const active = f.state !== 'stowed' && f.count > 0;
      webMesh.visible = active;
      if (active) {
        buildColumns(f);
        drawCorks(f, cam);
        drawWeb(f);
        drawLines(f);
        drawRings(f);
        drawBundles(f, cam);
      }
      drawPileCorks(f, cam);
      ropes.finish();
      bundles.finish();
      corkMesh.count = nCork;
      corkMesh.instanceMatrix.clearUpdateRanges();
      corkMesh.instanceMatrix.addUpdateRange(0, nCork * 16);
      corkMesh.instanceMatrix.needsUpdate = true;
      ringMesh.count = nRing;
      ringMesh.instanceMatrix.clearUpdateRanges();
      ringMesh.instanceMatrix.addUpdateRange(0, nRing * 16);
      ringMesh.instanceMatrix.needsUpdate = true;
      corkMesh.visible = nCork > 0;
      ringMesh.visible = nRing > 0;
    },

    dispose() {
      scene.remove(group);
      scene.remove(pileMesh);
    },
  };

  // Corkline (column tops) and leadline (column bottoms) for every laid node, plus the tail while paying out.
  let nCols = 0;
  function buildColumns(f) {
    const s = f.sim;
    const c = f.count;
    const D = f.webDepth;
    const p = f.pursed;
    const hauling = f.state === 'hauling' || f.state === 'brailing';
    const gatherX = f.gather.x;
    const gatherZ = f.gather.z;
    const lagT = NET_TUNING.lagSeconds;
    let u = 0;
    for (let i = 0; i < c; i++) {
      cx[i] = s.x[i];
      cz[i] = s.z[i];
      let yy = s.y[i] - 0.02;
      if (f.corksUnder && i > c - 14) yy -= 0.45 * smooth(c - 14, c - 4, i);
      cy[i] = yy;
      colU[i] = u;
      if (i < c - 1) u += s.rest[i];
      const bed = s.seabed[i];
      let h = Math.min(D, Math.max(0.6, bed - 0.12));
      let lx = s.x[i] - Math.max(-2.5, Math.min(2.5, s.vx[i] * lagT));
      let lz = s.z[i] - Math.max(-2.5, Math.min(2.5, s.vz[i] * lagT));
      if (hauling) {
        // Rings aboard: the bottom of the bag is gathered up beside the hull.
        const g = 0.9;
        lx = lerp(lx, gatherX, g);
        lz = lerp(lz, gatherZ, g);
        h = lerp(Math.max(1.5, D * 0.22), 1.1, smooth(0.6, 1.0, f.hauled));
      } else if (p > 0) {
        const g = 0.93 * Math.pow(p, 1.15);
        lx = lerp(lx, gatherX, g);
        lz = lerp(lz, gatherZ, g);
        h = lerp(h, Math.max(1.5, D * 0.22), smooth(0.35, 1.0, p));
      }
      hang[i] = h;
      leadX[i] = lx;
      leadY[i] = -h;
      leadZ[i] = lz;
    }
    nCols = c;
    if (f.tail && c > 0) {
      // The net sliding off the stern ramp: the last column sits on the water under the stern.
      const i = c;
      cx[i] = f.tail.x;
      cz[i] = f.tail.z;
      cy[i] = f.tailWaterY;
      colU[i] = u + Math.hypot(f.tail.x - s.x[c - 1], f.tail.z - s.z[c - 1]);
      hang[i] = Math.min(D * 0.35, 4);
      leadX[i] = f.tail.x;
      leadY[i] = -hang[i];
      leadZ[i] = f.tail.z;
      nCols = c + 1;
    }
  }

  function drawCorks(f, cam) {
    const s = f.sim;
    const c = f.count;
    const t = f.time;
    // Corks sit at fixed positions along the rope, counted from the skiff end, so each keeps its colour.
    const total = colU[nCols - 1] ?? 0;
    const nC = Math.min(MAX_CORKS - PILE_CORKS - 30, Math.floor(total / CORK_SPACING) + 1);
    let seg = 0;
    for (let k = 0; k < nC; k++) {
      const sArc = k * CORK_SPACING;
      while (seg < nCols - 2 && colU[seg + 1] < sArc) seg++;
      const a = seg;
      const b = Math.min(nCols - 1, seg + 1);
      const L = colU[b] - colU[a];
      const tt = L > 1e-6 ? Math.min(1, Math.max(0, (sArc - colU[a]) / L)) : 0;
      const x = lerp(cx[a], cx[b], tt);
      const z = lerp(cz[a], cz[b], tt);
      const bob = 0.035 * Math.sin(t * 2.3 + k * 1.7) + 0.02 * Math.sin(t * 3.7 + k * 0.9);
      const y = lerp(cy[a], cy[b], tt) + 0.07 + bob;
      const d = Math.hypot(x - cam.x, y - cam.y, z - cam.z);
      const sc = Math.min(3, Math.max(1, (d * 0.0042) / 0.22)) * (k < 14 ? 1.25 : 1);
      setCork(x, y, z, cx[b] - cx[a], (cy[b] - cy[a]) * 0.3 + 0.03 * Math.sin(t * 1.9 + k), cz[b] - cz[a], sc);
    }
    if (c === 0) return;
    void s;
  }

  function drawWeb(f) {
    const n = nCols;
    if (n < 2) {
      webGeo.setDrawRange(0, 0);
      return;
    }
    const bowl = f.state === 'hauling' || f.state === 'brailing' ? 0.3 : 0.25 * f.pursed;
    for (let i = 0; i < n; i++) {
      const top = cy[i] - 0.06;
      const dx = leadX[i] - cx[i];
      const dz = leadZ[i] - cz[i];
      const span = Math.hypot(dx, dz, leadY[i] - top);
      const sag = bowl * Math.hypot(dx, dz);
      // Horizontal normal across the curtain (the web hangs vertically; lit as a wall, not a sunlit floor).
      const a = Math.max(0, i - 1);
      const b = Math.min(n - 1, i + 1);
      let nx = cz[b] - cz[a];
      let nz = cx[a] - cx[b];
      const nl = Math.hypot(nx, nz) || 1;
      nx /= nl;
      nz /= nl;
      for (let r = 0; r <= ROWS; r++) {
        const t = r / ROWS;
        const v = i * (ROWS + 1) + r;
        // Rows bunch toward the top so the selvage and corks read crisply near the surface.
        const tt = t * t * 0.35 + t * 0.65;
        wPos[v * 3] = lerp(cx[i], leadX[i], tt);
        wPos[v * 3 + 1] = lerp(top, leadY[i], tt) - sag * 4 * tt * (1 - tt);
        wPos[v * 3 + 2] = lerp(cz[i], leadZ[i], tt);
        wUv[v * 2] = colU[i];
        wUv[v * 2 + 1] = tt * span;
        wNrm[v * 3] = nx;
        wNrm[v * 3 + 1] = 0.25;
        wNrm[v * 3 + 2] = nz;
      }
    }
    for (const a of [aWPos, aWUv, aWNrm]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * (ROWS + 1) * a.itemSize);
      a.needsUpdate = true;
    }
    webGeo.setDrawRange(0, (n - 1) * ROWS * 6);
  }

  function drawLines(f) {
    const n = nCols;
    // Corkline rope, threaded through the corks.
    ropes.line(C.corkline, 0.024);
    for (let i = 0; i < n; i++) ropes.point(cx[i], cy[i] + 0.07, cz[i]);
    ropes.end();
    // Leadline along the bottom of the web.
    ropes.line(C.leadline, 0.04);
    for (let i = 0; i < n; i++) ropes.point(leadX[i], leadY[i], leadZ[i]);
    ropes.end();
    // Skiff end: a line from the first cork up to the skiff's towing bitt (or ashore when tied off).
    if (f.skiffEnd) {
      const e = f.skiffEnd;
      const d = Math.hypot(e.x - cx[0], e.z - cz[0]);
      if (d > 0.4) {
        ropes.line(C.line, 0.03);
        const steps = Math.max(2, Math.min(16, Math.ceil(d / 3)));
        for (let k = 0; k <= steps; k++) {
          sagPoint(cx[0], cy[0] + 0.05, cz[0], e.x, e.y, e.z, k / steps, Math.min(0.6, d * 0.03), v3);
          if (f.shore && k > 0 && k < steps) v3.y = Math.max(v3.y, f.groundAt(v3.x, v3.z) + 0.05);
          ropes.point(v3.x, v3.y, v3.z);
        }
        ropes.end();
      }
    }
    // Seiner end tied to the stern while the net is out (towing), or the bunt end tied alongside after close-up.
    if (f.towLine) {
      const a = f.towLine.from;
      const b = f.towLine.to;
      const d = Math.hypot(b.x - a.x, b.z - a.z, b.y - a.y);
      ropes.line(C.line, 0.03);
      const steps = Math.max(2, Math.min(10, Math.ceil(d / 2)));
      for (let k = 0; k <= steps; k++) {
        sagPoint(a.x, a.y, a.z, b.x, b.y, b.z, k / steps, Math.min(0.5, d * 0.04), v3);
        ropes.point(v3.x, v3.y, v3.z);
      }
      ropes.end();
    }
    if (f.buntLine) {
      const a = f.buntLine.from;
      const b = f.buntLine.to;
      ropes.line(C.line, 0.03);
      for (let k = 0; k <= 6; k++) {
        sagPoint(a.x, a.y, a.z, b.x, b.y, b.z, k / 6, 0.25, v3);
        ropes.point(v3.x, v3.y, v3.z);
      }
      ropes.end();
    }
  }

  function drawRings(f) {
    const n = f.count;
    const hauling = f.state === 'hauling' || f.state === 'brailing';
    const davit = f.davit;
    // Purse line runs through the rings.
    const ringIdx = [];
    for (let i = 0; i < n; i += RING_EVERY) ringIdx.push(i);
    if (hauling) {
      // Rings up: hung in a bunch on the davit, dripping.
      if (davit) {
        const up = smooth(0, 2.2, f.ringsUpSeconds);
        for (let j = 0; j < ringIdx.length; j++) {
          const i = ringIdx[j];
          const hx = davit.x + Math.sin(j * 2.1) * 0.05;
          const hz = davit.z + Math.cos(j * 1.7) * 0.05;
          const hy = davit.y - 0.35 - (j % 12) * 0.018;
          const wx = lerp(leadX[i] ?? davit.x, hx, up);
          const wy = lerp((leadY[i] ?? -1) - 0.5, hy, up);
          const wz = lerp(leadZ[i] ?? davit.z, hz, up);
          setRing(wx, wy, wz, j * 0.37, 0.2 * Math.sin(j));
        }
      }
      return;
    }
    let prevYaw = 0;
    ropes.line(C.purse, 0.025);
    if (f.pursed > 0 && davit) ropes.point(davit.x, davit.y, davit.z);
    for (let j = 0; j < ringIdx.length; j++) {
      const i = ringIdx[j];
      const a = Math.max(0, i - 1);
      const b = Math.min(nCols - 1, i + 1);
      const yaw = Math.atan2(leadX[b] - leadX[a], leadZ[b] - leadZ[a]) || prevYaw;
      prevYaw = yaw;
      const drop = lerp(0.65, 0.25, f.pursed);
      const y = leadY[i] - drop;
      setRing(leadX[i], y, leadZ[i], yaw, 0.25 * Math.sin(f.time * 0.7 + j));
      ropes.point(leadX[i], y - 0.1, leadZ[i]);
    }
    if (f.pursed > 0 && davit) ropes.point(davit.x, davit.y, davit.z);
    else if (f.tail) ropes.point(f.tail.x, f.tail.y, f.tail.z);
    ropes.end();
  }

  // Lifted net: sliding off the stern ramp while paying out, and climbing to the power block while hauling.
  function drawBundles(f, cam) {
    const t = f.time;
    if (f.tail && nCols >= 2) {
      const i = nCols - 2;
      const a = { x: cx[i], y: cy[i], z: cz[i] };
      const b = f.tail;
      bundles.line(C.web, 0.4);
      for (let k = 0; k <= 8; k++) {
        const tt = k / 8;
        sagPoint(a.x, a.y, a.z, b.x, b.y, b.z, tt, 0.4, v3);
        bundles.point(v3.x, v3.y, v3.z, lerp(0.42, 0.3, tt));
      }
      bundles.end();
      // A few corks tumbling off the ramp, moving with the payout.
      const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      const off = (f.payout % CORK_SPACING) / CORK_SPACING;
      for (let k = 0; k < Math.floor(d / CORK_SPACING); k++) {
        const tt = Math.min(1, (k + 1 - off) * (CORK_SPACING / Math.max(d, 1e-3)));
        sagPoint(a.x, a.y + 0.1, a.z, b.x, b.y + 0.15, b.z, 1 - tt, 0.35, v3);
        setCork(v3.x, v3.y, v3.z, b.x - a.x, b.y - a.y, b.z - a.z, 1);
      }
    }
    const hauling = f.state === 'hauling' || f.state === 'brailing';
    if (hauling && f.block && f.entry) {
      const e = f.entry;
      const blk = f.block;
      const top = f.pileTopWorld;
      // Outboard (horizontal, from the block toward where the web leaves the water).
      let ox = e.x - blk.x;
      let oz = e.z - blk.z;
      const ol = Math.hypot(ox, oz) || 1;
      ox /= ol;
      oz /= ol;
      const sway = Math.sin(t * 1.3) * 0.18 + Math.sin(t * 2.9) * 0.06;
      const moving = f.state === 'hauling' ? 1 : 0.3;
      // Rising web: leaves the water in a wide sheet on the working quarter, bellies outboard under its own weight
      // and narrows into the sheave.
      const r0x = e.x;
      const r0y = e.y - 0.35;
      const r0z = e.z;
      const r1x = e.x + ox * 1.1;
      const r1y = e.y + 2.8;
      const r1z = e.z + oz * 1.1;
      const r2x = blk.x + ox * 0.9;
      const r2y = blk.y - 2.2;
      const r2z = blk.z + oz * 0.9;
      const r3x = blk.x;
      const r3y = blk.y - 0.3;
      const r3z = blk.z;
      const rise = (tt, out) => {
        bez(r0x, r1x, r2x, r3x, r0y, r1y, r2y, r3y, r0z, r1z, r2z, r3z, tt, out);
        const k = tt * (1 - tt) * 4;
        out.x += -oz * sway * k;
        out.z += ox * sway * k;
        return out;
      };
      bundles.line(C.web, 0.7);
      for (let k = 0; k <= 14; k++) {
        const tt = k / 14;
        rise(tt, v3);
        bundles.point(v3.x, v3.y, v3.z, lerp(0.85, 0.3, Math.sqrt(tt)));
      }
      bundles.end();
      // Corkline along the outboard edge, leadline along the inboard edge.
      ropes.line(C.corkline, 0.026);
      for (let k = 0; k <= 12; k++) {
        const tt = k / 12;
        rise(tt, v3);
        const w = lerp(0.42, 0.14, Math.sqrt(tt));
        ropes.point(v3.x + ox * w, v3.y + 0.06, v3.z + oz * w);
      }
      ropes.end();
      ropes.line(C.leadline, 0.035);
      for (let k = 0; k <= 12; k++) {
        const tt = k / 12;
        rise(tt, v3);
        const w = lerp(0.42, 0.14, Math.sqrt(tt));
        ropes.point(v3.x - ox * w, v3.y - 0.04, v3.z - oz * w);
      }
      ropes.end();
      // Corks riding up the outboard edge at the haul speed.
      const phase = (f.hauledMetres % CORK_SPACING) / CORK_SPACING;
      const nUp = 11;
      for (let k = 0; k < nUp; k++) {
        const tt = Math.min(1, (k + phase * moving) / nUp);
        rise(tt, v3);
        rise(Math.min(1, tt + 0.05), v3b);
        const w = lerp(0.46, 0.16, Math.sqrt(tt));
        setCork(v3.x + ox * w, v3.y + 0.08, v3.z + oz * w, v3b.x - v3.x, v3b.y - v3.y, v3b.z - v3.z, 1);
      }
      if (top) {
        // Over the sheave and down to the pile, where the crew stack it: the web falls almost straight, spreading.
        const d0x = blk.x;
        const d0y = blk.y + 0.25;
        const d0z = blk.z;
        const d3x = top.x;
        const d3y = top.y + 0.1;
        const d3z = top.z;
        bundles.line(C.web, 0.3);
        for (let k = 0; k <= 10; k++) {
          const tt = k / 10;
          bez(
            d0x, d0x - ox * 0.3, d3x, d3x,
            d0y, d0y - 0.9, d3y + 1.5, d3y,
            d0z, d0z - oz * 0.3, d3z, d3z,
            tt, v3,
          );
          v3.x += -oz * sway * 0.25 * tt;
          v3.z += ox * sway * 0.25 * tt;
          bundles.point(v3.x, v3.y, v3.z, lerp(0.28, 0.42, tt * tt));
        }
        bundles.end();
      }
    }
    void cam;
  }

  function updatePile(f) {
    const m = f.seinerMatrix;
    if (!m || !f.pileLocal) {
      pileMesh.visible = false;
      return;
    }
    const frac = Math.max(0, f.pileFraction);
    const sxz = 0.5 + 0.5 * Math.sqrt(frac);
    const sy = Math.max(0.03, 1.25 * Math.pow(frac, 0.75));
    pileLocal.copy(f.pileLocal);
    m4b.makeScale(sxz, sy, sxz).setPosition(pileLocal);
    // Where the stacker lays the web down: the top of the heap (ours or the seiner model's own pile).
    pileTop.set(0, 1, 0.25).applyMatrix4(m4b).applyMatrix4(m);
    f.pileTopWorld = pileTop;
    if (!f.drawPile || frac <= 0.01) {
      pileMesh.visible = false;
      return;
    }
    pileMesh.matrix.multiplyMatrices(m, m4b);
    pileMesh.matrixWorld.copy(pileMesh.matrix);
    pileMesh.visible = true;
  }

  // Corks stacked along one edge of the pile (the cork pile), following the heap's surface.
  function drawPileCorks(f, cam) {
    if (!pileMesh.visible) return;
    const m = pileMesh.matrix;
    const frac = f.pileFraction;
    const nShow = Math.round(PILE_CORKS * Math.min(1, frac * 1.3));
    for (let k = 0; k < nShow; k++) {
      const row = k % 3;
      const along = Math.floor(k / 3) / (PILE_CORKS / 3 - 1);
      const u = 0.3 + row * 0.07;
      const v = (along - 0.5) * 0.85;
      const r = Math.min(1, Math.hypot(u * 2, v * 2) ** 2.2);
      const h = (1 - r) ** 0.55 * 0.9 + 0.08;
      v3.set(u * pile.width, h, v * pile.depth).applyMatrix4(m);
      v3b.set(u * pile.width + 0.4 * Math.sin(k), h, v * pile.depth + 1).applyMatrix4(m).sub(v3);
      setCork(v3.x, v3.y, v3.z, v3b.x, v3b.y * 0.2, v3b.z, 1);
    }
    void cam;
    void m4;
  }

  return view;
}
