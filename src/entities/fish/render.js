// Fish rendering: schools near the camera as GPU-placed instanced salmon (a few stable "slots", the first reserved
// for the bag), jumpers and finning chum as CPU-posed instances, and the surface effects of every jump. All camera-
// dependent work runs from pipeline.beforeRender (after the camera and any debug override have moved).

import * as THREE from 'three';
import { createSalmonGeometry } from './salmonGeometry.js';
import { createSalmonMaterial, createSalmonLighting, SLOTS } from './salmonMaterial.js';
import { createFishFx } from './fx.js';
import { jumpPose, dueEvents } from './jumps.js';
import { SPECIES, SPECIES_INDEX, FISH_LENGTH } from './species.js';

const JUMPER_CAP = 128;
const FINNER_MAX = 24;
const SCHOOL_VIEW = 300; // schools farther than this (edge) from the camera get no individual fish
const FX_RANGE = 7000;

export function createFishRenderer(ctx, sim) {
  const { scene, camera, renderer } = ctx;
  const low = ctx.quality?.name === 'low';
  const caps = low ? [512, 96, 96, 96, 96, 96, 96, 96] : [1024, 136, 136, 136, 136, 136, 136, 136];
  const total = caps.reduce((a, b) => a + b, 0);
  const slotStart = [];
  caps.reduce((a, c, i) => ((slotStart[i] = a), a + c), 0);

  // --- school fish ---
  const geoHigh = createSalmonGeometry({ detail: 'high' });
  const geoMid = createSalmonGeometry({ detail: 'mid' });
  const geoLow = createSalmonGeometry({ detail: 'low' });
  const fishA = new Float32Array(total * 4);
  const fishB = new Float32Array(total * 4);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let k = 0; k < SLOTS; k++) {
    for (let i = 0; i < caps[k]; i++) {
      const j = slotStart[k] + i;
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd());
      fishA[j * 4] = Math.cos(a) * r;
      fishA[j * 4 + 1] = rnd() + rnd() - 1;
      fishA[j * 4 + 2] = Math.sin(a) * r;
      fishA[j * 4 + 3] = (i + 0.5) / caps[k];
      fishB[j * 4] = rnd();
      fishB[j * 4 + 1] = rnd();
      fishB[j * 4 + 2] = rnd();
      fishB[j * 4 + 3] = k;
    }
  }
  const attrA = new THREE.InstancedBufferAttribute(fishA, 4);
  const attrB = new THREE.InstancedBufferAttribute(fishB, 4);
  function schoolGeometry(base) {
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    for (const name of ['position', 'normal', 'aPart']) g.setAttribute(name, base.getAttribute(name));
    g.setAttribute('aFishA', attrA);
    g.setAttribute('aFishB', attrB);
    g.instanceCount = total;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    return g;
  }
  const matNear = createSalmonMaterial(ctx, { mode: 'school', lod: 'near' });
  const matFar = createSalmonMaterial(ctx, { mode: 'school', lod: 'far' });
  const matJump = createSalmonMaterial(ctx, { mode: 'jumper' });
  for (const k of ['uSlotA', 'uSlotB', 'uSlotC', 'uSlotD', 'uSlotE', 'uLodDist', 'uMaxDist']) matFar.uniforms[k] = matNear.uniforms[k];
  const updateLighting = createSalmonLighting(ctx, [matNear, matFar, matJump]);
  const U = matNear.uniforms;
  const nearMesh = new THREE.Mesh(schoolGeometry(geoMid), matNear);
  const farMesh = new THREE.Mesh(schoolGeometry(geoLow), matFar);
  for (const m of [nearMesh, farMesh]) {
    m.frustumCulled = false;
    m.name = 'fish-school';
    m.matrixAutoUpdate = false;
    scene.add(m);
  }
  nearMesh.name = 'fish-school-near';
  farMesh.name = 'fish-school-far';

  // --- jumpers + finners (CPU instances) ---
  const jumpGeo = geoHigh.clone();
  const jA = new Float32Array(JUMPER_CAP * 4);
  const jB = new Float32Array(JUMPER_CAP * 4);
  const attrJA = new THREE.InstancedBufferAttribute(jA, 4).setUsage(THREE.DynamicDrawUsage);
  const attrJB = new THREE.InstancedBufferAttribute(jB, 4).setUsage(THREE.DynamicDrawUsage);
  jumpGeo.setAttribute('aJumpA', attrJA);
  jumpGeo.setAttribute('aJumpB', attrJB);
  const jumpMesh = new THREE.InstancedMesh(jumpGeo, matJump, JUMPER_CAP);
  jumpMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  jumpMesh.count = 0;
  jumpMesh.frustumCulled = false;
  jumpMesh.name = 'fish-jumpers';
  jumpMesh.matrixAutoUpdate = false;
  scene.add(jumpMesh);

  const fx = createFishFx(ctx, { lighting: matNear.uniforms, quality: ctx.quality });

  // --- slots ---
  const slots = Array.from({ length: SLOTS }, (_, k) => ({ k, school: null, presence: 0, mill: 0, thrash: 0, speed: 0, fill: 0, wantOut: false }));
  const slotOfSchool = new Map();

  const tmpM = new THREE.Matrix4();
  const tmpQ = new THREE.Quaternion();
  const tmpE = new THREE.Euler(0, 0, 0, 'YXZ');
  const tmpP = new THREE.Vector3();
  const tmpS = new THREE.Vector3();
  const tmpV = new THREE.Vector3();
  const right = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const pose = {};
  const evs = [];
  const wakeList = [];
  // cpuMs: EMA of this module's beforeRender work (not part of perf().systemsMs, which times update/frame only).
  const stats = { slots: 0, fish: 0, jumpers: 0, finners: 0, splashes: 0, glints: 0, rings: 0, stamps: 0, cpuMs: 0 };
  let last = -1;

  const water = () => ctx.systems.water;
  const waterIsStub = () => water()?.mesh?.name === 'water-stub' || typeof water()?.stamp !== 'function';
  const surfaceY = (x, z) => {
    const h = water()?.heightAt?.(x, z);
    return Number.isFinite(h) ? h : 0;
  };
  const focus = () => ctx.systems.cameraRig?.focus ?? camera.position;
  function stamp(x, z, r, s, kind) {
    try {
      water()?.stamp?.(x, z, r, s, kind);
      stats.stamps++;
    } catch {
      // A broken neighbour must not take the fish down; the ring fallback still shows the jump.
    }
  }
  const inStampField = (x, z) => {
    const f = focus();
    return !waterIsStub() && Math.abs(x - f.x) < 470 && Math.abs(z - f.z) < 470;
  };

  function pixelWorld(dist) {
    const h = renderer?.domElement?.height ?? 720;
    return (dist * 2) / (camera.projectionMatrix.elements[5] * h);
  }

  // Stable slot assignment. Slot 0 (the big one) belongs to the "primary" school: the one in the net, else the
  // nearest (switching only when another is clearly nearer). Others take the small slots. Schools fade in and out
  // by presence so reassignments never pop.
  function assignSlots(dtReal) {
    const cam = camera.position;
    let bagSchool = null;
    for (const s of sim.schools) {
      if (!s.net || s.state === 'gone' || (s.state === 'captured' && !s.bag)) continue;
      if (!bagSchool || s.count > bagSchool.count) bagSchool = s;
    }
    const cands = [];
    const dist = new Map();
    for (const s of sim.schools) {
      if (s.state === 'gone') continue;
      if (s.state === 'captured' && !s.bag) continue;
      const d = Math.hypot(s.position.x - cam.x, s.position.z - cam.z, s.position.y - cam.y) - s.radius;
      dist.set(s, d);
      if (d > SCHOOL_VIEW && s !== bagSchool) continue;
      cands.push({ s, d: s === bagSchool ? -1e9 : d });
    }
    cands.sort((a, b) => a.d - b.d);
    const top = cands.slice(0, SLOTS);
    const want = new Set(top.map((c) => c.s));
    let primary = bagSchool;
    if (!primary) {
      const nearest = top[0] && top[0].d < 180 ? top[0].s : null;
      const cur = slots[0].school && !slots[0].wantOut ? slots[0].school : null;
      const curD = cur ? dist.get(cur) ?? Infinity : Infinity;
      primary = cur && want.has(cur) && curD < 220 && (!nearest || nearest === cur || dist.get(nearest) > curD * 0.6 - 5) ? cur : nearest;
    }
    for (const sl of slots) {
      if (sl.school && (!want.has(sl.school) || (sl.k === 0 && primary && sl.school !== primary) || (sl.k !== 0 && sl.school === primary))) {
        sl.wantOut = true;
      }
      if (sl.wantOut) {
        sl.presence = Math.max(0, sl.presence - dtReal * 2.5);
        if (sl.presence <= 0) {
          if (sl.school) slotOfSchool.delete(sl.school.id);
          sl.school = null;
          sl.wantOut = false;
        }
      } else if (sl.school) sl.presence = Math.min(1, sl.presence + dtReal * 1.2);
    }
    for (const { s } of top) {
      if (slotOfSchool.has(s.id)) continue;
      let pick = null;
      if (s === primary) pick = slots[0].school ? null : slots[0];
      else {
        for (let k = 1; k < SLOTS && !pick; k++) if (!slots[k].school) pick = slots[k];
        if (!pick && !primary && !slots[0].school) pick = slots[0];
      }
      if (!pick) continue;
      pick.school = s;
      pick.presence = 0;
      pick.wantOut = false;
      pick.mill = s.state === 'milling' || s.state === 'trapped' ? 1 : 0;
      slotOfSchool.set(s.id, pick.k);
    }
  }

  function writeSlots(dtReal) {
    const view = sim.view;
    let fishDrawn = 0;
    let used = 0;
    let lastUsed = -1;
    let lastNear = -1;
    const cam = camera.position;
    const lodDist = U.uLodDist.value;
    for (const sl of slots) {
      const k = sl.k;
      const s = sl.school;
      const A = U.uSlotA.value[k];
      const B = U.uSlotB.value[k];
      const C = U.uSlotC.value[k];
      const D = U.uSlotD.value[k];
      const E = U.uSlotE.value[k];
      if (!s) {
        B.w = 0;
        C.z = 0;
        continue;
      }
      used++;
      lastUsed = k;
      if (Math.hypot(s.position.x - cam.x, s.position.y - cam.y, s.position.z - cam.z) - s.radius * 1.3 < lodDist + 4) lastNear = k;
      const inBag = !!s.bag && (s.state === 'trapped' || s.state === 'captured');
      const milling = s.state === 'milling' || s.state === 'trapped' || inBag;
      sl.mill += ((milling ? 1 : 0) - sl.mill) * Math.min(1, dtReal * 0.6);
      const thrashTarget = inBag ? Math.min(1, 0.12 + 1.1 * view.hauled) : 0;
      sl.thrash += (thrashTarget - sl.thrash) * Math.min(1, dtReal * 1.2);
      const spd = s.state === 'spooked' ? 1 : s.state === 'migrating' ? 0.3 : 0.1;
      sl.speed += (spd - sl.speed) * Math.min(1, dtReal * 2);
      let count = s.count;
      if (s.state === 'captured') count = s.capturedCount * Math.max(0, 1 - (sim.now - s.capturedAt) / 7);
      const fill = Math.min(1, count / caps[k]);
      if (inBag) {
        const el = view.ellipse;
        A.set(el.x, -Math.max(0.25, s.bagDepth ?? 1), el.z, Math.max(1.2, el.a * 0.92));
        E.set(el.angle, Math.max(0.3, Math.min(1, el.b / Math.max(el.a, 1e-3))), s.hump ?? 0, 1);
        C.set(sl.mill, sl.thrash, sl.presence, view.hauled);
        B.set(s.heading ?? 0, sl.speed, Math.max(0.6, (s.bagDepth ?? 1) * 1.2), fill);
      } else {
        A.set(s.position.x, s.position.y, s.position.z, s.radius);
        E.set(0, 1, s.hump ?? 0, (s.millDir ?? 1) >= 0 ? 1 : -1);
        C.set(sl.mill, sl.thrash, sl.presence, 0);
        B.set(s.heading ?? 0, sl.speed, Math.min(3.5, Math.max(1.0, s.depth * 0.9)), fill);
      }
      const tot = Math.max(1, s.count || 1);
      const m = s.mix;
      const c0 = (m.pink ?? 0) / tot;
      const c1 = c0 + (m.chum ?? 0) / tot;
      const c2 = c1 + (m.sockeye ?? 0) / tot;
      const c3 = c2 + (m.coho ?? 0) / tot;
      if (s.count > 0) D.set(c0, c1, c2, c3);
      else D.set(s.species === 'pink' ? 1 : 0, ['pink', 'chum'].includes(s.species) ? 1 : 0, s.species !== 'coho' && s.species !== 'king' ? 1 : 0, s.species !== 'king' ? 1 : 0);
      fishDrawn += Math.round(fill * sl.presence * caps[k]);
    }
    stats.slots = used;
    stats.fish = fishDrawn;
    // Draw only the instance ranges of slots in use (slot k owns [slotStart[k], slotStart[k] + caps[k])).
    farMesh.visible = lastUsed >= 0;
    nearMesh.visible = lastNear >= 0;
    if (lastUsed >= 0) farMesh.geometry.instanceCount = slotStart[lastUsed] + caps[lastUsed];
    if (lastNear >= 0) nearMesh.geometry.instanceCount = slotStart[lastNear] + caps[lastNear];
  }

  function writeInstance(i, x, y, z, heading, pitch, roll, scale, species, bend, beatHz, beatAmp, seedV, hump, wet) {
    tmpE.set(pitch, -heading, roll, 'YXZ');
    tmpQ.setFromEuler(tmpE);
    tmpP.set(x, y, z);
    tmpS.setScalar(scale);
    tmpM.compose(tmpP, tmpQ, tmpS);
    jumpMesh.setMatrixAt(i, tmpM);
    jA[i * 4] = species;
    jA[i * 4 + 1] = bend;
    jA[i * 4 + 2] = beatHz;
    jA[i * 4 + 3] = beatAmp;
    jB[i * 4] = seedV;
    jB[i * 4 + 1] = hump;
    jB[i * 4 + 2] = wet;
  }

  // Sun glint off a leaping fish. The body is close to a cylinder along its axis, so some strip of it mirrors the sun
  // into the eye whenever the half vector (sun + view) is nearly perpendicular to the axis: backlit fish flash off
  // the back, front-lit fish off the flank.
  const axis = new THREE.Vector3();
  const half = new THREE.Vector3();
  function sunGlintAt(x, y, z, heading, pitch, roll, strength = 1) {
    const sunDir = ctx.uniforms.uSunDir.value;
    if (sunDir.y < 0.01) return;
    axis.set(Math.sin(heading) * Math.cos(pitch), Math.sin(pitch), -Math.cos(heading) * Math.cos(pitch));
    tmpV.set(camera.position.x - x, camera.position.y - y, camera.position.z - z).normalize();
    half.copy(sunDir).add(tmpV).normalize();
    const c = Math.abs(half.dot(axis));
    let intensity = (1 - smoothstep(0.04, 0.42, c)) * strength;
    // Brighter at grazing reflection (Fresnel) and with a low sun; a twisting fish flashes more (roll variety).
    const graze = 1 - Math.max(0, half.dot(tmpV));
    intensity *= 0.55 + 0.45 * graze + 0.2 * Math.min(1, Math.abs(roll));
    if (intensity < 0.16) return;
    const daylight = ctx.uniforms.uDaylight.value ?? 1;
    const d = camera.position.distanceTo(tmpP.set(x, y, z));
    const bino = camera.fov < 25 ? 1.35 : 1;
    // Drawn just in front of the flank (toward the eye) so the fish body never hides its own flash.
    const lift = Math.max(0.3, 2.5 * pixelWorld(d));
    fx.glint(x + tmpV.x * lift, y + tmpV.y * lift, z + tmpV.z * lift, {
      strength: Math.min(1.8, 1.7 * intensity) * (0.35 + 0.65 * daylight),
      px: (20 + 30 * Math.min(1, intensity)) * bino * (d < 60 ? 0.7 : 1),
      life: 0.2 + 0.18 * Math.random(),
    });
    stats.glints++;
  }
  const smoothstep = (a, b, v) => {
    const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };

  function jumpFx(j, e, dist) {
    const hx = Math.sin(j.heading);
    const hz = -Math.cos(j.heading);
    const y = j.surfaceY;
    const near = inStampField(e.x, e.z);
    if (e.kind === 'exit') {
      fx.splash(e.x, y, e.z, { strength: e.strength, size: j.size, hx, hz, distance: dist });
      jumpPose(j, e.t + 0.06, pose);
      sunGlintAt(pose.x, pose.y, pose.z, pose.heading, pose.pitch, pose.roll, 0.7);
      // Only the heavier exits ring the water; the re-entry always does.
      if (near && !j.bag && e.strength > 0.3) stamp(e.x, e.z, 1.0 + 1.2 * j.size, 0.14 + 0.12 * e.strength, 'ripple');
      if (!near) fx.ring(e.x, y + 0.06, e.z, { r0: 0.2, rMax: 2.2 + 2 * e.strength, life: 4.2 + Math.random() * 1.5, strength: 0.7 });
      stats.rings++;
    } else if (e.kind === 'entry') {
      const flat = j.style === 'flop' || j.style === 'thrash' ? 1 : 0;
      fx.splash(e.x, y, e.z, { strength: e.strength, size: j.size, hx, hz, flat, distance: dist });
      stats.splashes++;
      if (near) {
        stamp(e.x, e.z, 0.8 + 1.5 * e.strength, j.bag ? 0.1 : 0.12 + 0.18 * Math.min(1, e.strength), 'ripple');
      } else fx.ring(e.x, y + 0.06, e.z, { r0: 0.3, rMax: 3 + 3.5 * e.strength, life: 4.5 + Math.random() * 1.5, strength: 0.9 });
      stats.rings++;
      // Backlit spray catching the low sun.
      const sunDir = ctx.uniforms.uSunDir.value;
      tmpV.set(e.x - camera.position.x, 0, e.z - camera.position.z).normalize();
      const toward = tmpV.x * sunDir.x + tmpV.z * sunDir.z;
      if (sunDir.y > 0.02 && sunDir.y < 0.5 && toward > 0.6 && Math.random() < 0.7) {
        fx.glint(e.x, y + 0.25 * j.size, e.z, { strength: 0.6 + 0.6 * toward, px: 10 + 8 * e.strength, life: 0.22 });
        stats.glints++;
      }
    } else if (e.kind === 'walk') {
      fx.spray(e.x, y, e.z, { strength: e.strength, size: j.size, hx, hz });
      if (near && Math.random() < 0.2) stamp(e.x, e.z, 1.0, 0.25, 'ripple');
      if (near && Math.random() < 0.4) stamp(e.x, e.z, 0.6, 0.1, 'foam');
    } else if (e.kind === 'apex') {
      jumpPose(j, e.t, pose);
      sunGlintAt(pose.x, pose.y, pose.z, pose.heading, pose.pitch, pose.roll, 1);
      // Tail-walkers and twisters flash more than once.
      if (j.style === 'tailwalk' || j.style === 'thrash') {
        jumpPose(j, e.t + 0.12, pose);
        sunGlintAt(pose.x, pose.y, pose.z, pose.heading, pose.pitch, pose.roll + 0.8, 0.8);
      }
    }
  }

  const tmpFin = { x: 0, z: 0 };
  function finners(i0, dtReal) {
    // Milling chum finning: dorsal fins and tail tips cutting the surface, trailing V-wakes.
    wakeList.length = 0;
    let n = 0;
    const t = sim.now;
    const cam = camera.position;
    for (const s of sim.schools) {
      if (n >= FINNER_MAX) break;
      if (s.state !== 'milling' || (s.mix.chum ?? 0) < (s.count ?? 0) * 0.5 || s.depth > 4.5) continue;
      const d = Math.hypot(s.position.x - cam.x, s.position.z - cam.z);
      if (d > 950) continue;
      let h = 0;
      for (let c = 0; c < s.id.length; c++) h = (h * 31 + s.id.charCodeAt(c)) >>> 0;
      const per = Math.min(4, FINNER_MAX - n);
      for (let f = 0; f < per; f++) {
        const ph = ((h >> (f * 3)) % 100) / 100;
        // Each finner shows for a while, then slips down again.
        const vis = Math.sin(t * (0.09 + 0.03 * f) + ph * 6.28);
        if (vis < -0.2) continue;
        const r = s.radius * (0.35 + 0.5 * ph);
        const w = ((s.millDir ?? 1) * (0.35 + 0.2 * ph)) / Math.max(r, 3);
        const a = ph * 6.283 + t * w;
        tmpFin.x = s.position.x + Math.cos(a) * r;
        tmpFin.z = s.position.z + Math.sin(a) * r;
        const fwdX = w >= 0 ? -Math.sin(a) : Math.sin(a);
        const fwdZ = w >= 0 ? Math.cos(a) : -Math.cos(a);
        const head = Math.atan2(fwdX, -fwdZ);
        const len = FISH_LENGTH.chum * (0.95 + 0.1 * ph);
        const sy = surfaceY(tmpFin.x, tmpFin.z);
        const rise = Math.min(1, (vis + 0.2) / 0.25);
        // Back just awash: the dorsal fin and the upper tail lobe cut the surface.
        const y = sy - 0.045 * len - (1 - rise) * 0.3;
        const scale = len * Math.max(1, (3 * pixelWorld(d)) / len);
        writeInstance(i0 + n, tmpFin.x, y, tmpFin.z, head, 0.02, 0.04 * Math.sin(t * 1.3 + f), scale, SPECIES_INDEX.chum, 0.05 * Math.sin(t * 0.7 + f), 1.7, 1.1, ph, 0, 0.6);
        wakeList.push({ x: tmpFin.x + fwdX * len * 0.1, y: sy + 0.04, z: tmpFin.z + fwdZ * len * 0.1, heading: head, length: 3.2 + 2.2 * ph, strength: rise, phase: ph * 20 });
        if (inStampField(tmpFin.x, tmpFin.z) && Math.random() < dtReal * 1.2) stamp(tmpFin.x, tmpFin.z, 0.8, 0.3 * rise, 'ripple');
        n++;
      }
    }
    fx.setWakes(wakeList);
    stats.finners = n;
    return n;
  }

  let bagSprayAcc = 0;
  let nervousAcc = 0;
  function bagFx(dtReal) {
    const view = sim.view;
    const s = sim.schools.find((q) => q.bag && (q.state === 'trapped' || q.state === 'captured'));
    if (!s || view.phase !== 'pursed' || dtReal <= 0) return;
    const el = view.ellipse;
    const h = view.hauled;
    const fill = s.state === 'captured' ? Math.max(0, 1 - (sim.now - s.capturedAt) / 7) : 1;
    const dense = Math.min(1, s.count / 1500 + 0.25) * fill;
    stamp(el.x, el.z, Math.max(1.5, el.a * 0.6), Math.min(0.25, (0.04 + 0.18 * h * h) * dense), 'foam');
    bagSprayAcc += dtReal * (4 + 38 * h * h) * dense;
    const ca = Math.cos(el.angle);
    const sa = Math.sin(el.angle);
    while (bagSprayAcc >= 1) {
      bagSprayAcc -= 1;
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * 0.9;
      const lx = Math.cos(a) * r * el.a;
      const lz = Math.sin(a) * r * el.b;
      const x = el.x + lx * ca - lz * sa;
      const z = el.z + lx * sa + lz * ca;
      const y = surfaceY(x, z);
      const hd = Math.random() * Math.PI * 2;
      fx.spray(x, y, z, { strength: 0.25 + 0.5 * h * Math.random(), size: FISH_LENGTH[s.species] ?? 0.6, hx: Math.sin(hd), hz: -Math.cos(hd) });
      if (Math.random() < 0.06) stamp(x, z, 0.8 + Math.random(), 0.22, 'ripple');
      if (Math.random() < 0.18 * h) sunGlintAt(x, y + 0.1, z, hd, 0.2, Math.random() * 3, 0.9);
    }
  }

  function nervousWater(dtReal) {
    // Milling schools near the surface dimple it ("nervous water").
    nervousAcc += dtReal;
    if (nervousAcc < 0.2) return;
    const dt = nervousAcc;
    nervousAcc = 0;
    if (waterIsStub()) return;
    for (const s of sim.schools) {
      if (s.state !== 'milling' || s.depth > 3.5) continue;
      if (!inStampField(s.position.x, s.position.z)) continue;
      if (Math.random() < dt * (0.5 + s.count / 8000)) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * s.radius * 0.8;
        stamp(s.position.x + Math.cos(a) * r, s.position.z + Math.sin(a) * r, 0.8 + Math.random(), 0.22, 'ripple');
      }
    }
  }

  let hidden = false;
  let gallery = null;
  function frame() {
    const t0 = performance.now();
    if (hidden) {
      for (const o of [nearMesh, farMesh, jumpMesh, ...fx.objects]) o.visible = false;
      return;
    }
    render();
    stats.cpuMs += (performance.now() - t0 - stats.cpuMs) * 0.05;
  }

  function render() {
    const tReal = performance.now() / 1000;
    const dtReal = last < 0 ? 0 : Math.min(0.25, tReal - last);
    last = tReal;
    const simDt = ctx.time.dt;
    updateLighting();
    fx.setProjection(camera, renderer);
    assignSlots(simDt > 0 ? dtReal : 0);
    writeSlots(simDt > 0 ? dtReal : 0);

    // Jumpers.
    let n = 0;
    const cam = camera.position;
    for (const j of sim.jumps) {
      if (n >= JUMPER_CAP - FINNER_MAX) break;
      const t = sim.now - j.t0;
      if (t < 0) continue;
      const dist = Math.hypot(j.x - cam.x, j.z - cam.z);
      if (dist > FX_RANGE) {
        dueEvents(j, t, evs);
        continue;
      }
      if (simDt > 0) for (const e of dueEvents(j, t, evs)) jumpFx(j, e, dist);
      if (t > j.dur) continue;
      jumpPose(j, t, pose);
      if (pose.y < j.surfaceY - 0.55) continue;
      const len = j.size;
      // Minimum silhouette of ~5 px so a leaping fish still shows as a dark sliver over its splash far away.
      const scale = len * Math.max(1, (5 * pixelWorld(dist)) / len);
      writeInstance(n, pose.x, pose.y, pose.z, pose.heading, pose.pitch, pose.roll, scale, SPECIES_INDEX[j.species] ?? 0, pose.bend, pose.beatHz, pose.beatAmp, j.seed, j.hump, 1);
      n++;
    }
    stats.jumpers = n;
    n += finners(n, simDt > 0 ? dtReal : 0);
    // QA gallery: one fish of each species held broadside above the water.
    if (gallery) {
      const hump = gallery.hump ?? 0;
      gallery.list.forEach((sp, i) => {
        if (n >= JUMPER_CAP) return;
        const off = (i - (gallery.list.length - 1) / 2) * 1.25;
        // Nose to tail along the heading, so a camera abeam sees every fish broadside.
        const x = gallery.x + Math.sin(gallery.heading) * off * 1.1;
        const z = gallery.z - Math.cos(gallery.heading) * off * 1.1;
        writeInstance(n++, x, gallery.y, z, gallery.heading, 0, 0, FISH_LENGTH[sp], SPECIES_INDEX[sp], 0.06 * Math.sin(sim.now * 2 + i), 1.2, 0.35, 0.37 * (i + 1), sp === 'pink' ? hump : 0, 0.6);
      });
    }
    jumpMesh.count = n;
    jumpMesh.visible = n > 0;
    if (n) {
      jumpMesh.instanceMatrix.clearUpdateRanges();
      jumpMesh.instanceMatrix.addUpdateRange(0, n * 16);
      jumpMesh.instanceMatrix.needsUpdate = true;
      attrJA.clearUpdateRanges();
      attrJB.clearUpdateRanges();
      attrJA.addUpdateRange(0, n * 4);
      attrJB.addUpdateRange(0, n * 4);
      attrJA.needsUpdate = true;
      attrJB.needsUpdate = true;
    }
    if (simDt > 0) {
      bagFx(dtReal);
      nervousWater(dtReal);
    }
    fx.flush();
  }

  function reset() {
    for (const sl of slots) {
      sl.school = null;
      sl.presence = 0;
      sl.wantOut = false;
    }
    slotOfSchool.clear();
    jumpMesh.count = 0;
    fx.clear();
  }

  const remove = ctx.pipeline.beforeRender(frame);

  return {
    stats,
    slots,
    fx,
    reset,
    // QA: hide every fish object (paired GPU timing with and without fish in one session).
    setHidden(v) {
      hidden = !!v;
    },
    // QA: show a static row of species (null clears). { x, y, z, heading, list?, hump? }
    setGallery(g) {
      gallery = g ? { list: ['pink', 'chum', 'sockeye', 'coho', 'king'], y: 1, heading: 0, ...g } : null;
    },
    dispose() {
      remove?.();
    },
    liveParticles: () => fx.liveParticles(),
    meshes: [nearMesh, farMesh, jumpMesh],
    species: SPECIES,
  };
}
