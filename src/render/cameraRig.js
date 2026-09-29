// WP-BOATS: camera rig (SPEC §6.9). Modes: chase (orbit behind the seiner), crowsnest (high, looking down: frames the
// seiner and the skiff while setting), bridge (first person on the flying bridge), foot (third person on the player),
// title (cinematic loop of golden-hour shots) and free (photo mode fly-cam on raw keys). Binoculars zoom from the
// helmsman's eye. Mode switches crane smoothly between poses; teleports snap. The rig owns camera position,
// orientation, fov and near plane, and copies its focus into sky.shadowFocus.

import * as THREE from 'three';
import {
  clamp, lerp, damp, dampAngle, smoothDamp, wrapAngle, orbitPosition, occlusionFraction, shakeOffsets, easeInOut,
  easeInOutSine, crowsnestFrame, crowsnestCeiling, wobble, clearOrbit, insideCollider, lookAngles,
} from './camera/rigMath.js';
import { TITLE_SHOTS, shotAt } from './camera/titleShots.js';

const BOAT_MODES = ['chase', 'crowsnest', 'bridge'];
const MODES = ['chase', 'crowsnest', 'bridge', 'foot', 'title', 'free'];

export async function create(ctx) {
  const { camera, input, events, config } = ctx;
  const low = ctx.quality?.name === 'low';
  const baseFov = config.render.fov ?? 55;
  const focus = new THREE.Vector3();
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const mat4 = new THREE.Matrix4();
  const up = new THREE.Vector3(0, 1, 0);
  const tmpV = new THREE.Vector3();
  const tmpV2 = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();
  const orbit = { x: 0, y: 0, z: 0 };
  const shakeO = { yaw: 0, pitch: 0, roll: 0, y: 0 };

  let mode = 'chase';
  let boatMode = 'chase';
  let photoReturn = 'chase';
  let target = null;
  let lastCycleAt = -1e9;
  let lastLookAt = -1e9;
  let lastZoomAt = -1e9;
  let snapNext = true;
  let trauma = 0;
  let time = 0;
  let invertY = readInvertY();

  const desired = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fov: baseFov, near: 0.5 };
  const blend = { t: 1, dur: 0.9, pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fov: baseFov };

  const chase = { yaw: 0, pitch: 0.24, dist: 34, heading: 0, pull: 1, focus: new THREE.Vector3(), sx: { v: 0 }, sy: { v: 0 }, sz: { v: 0 } };
  const NEST_PITCH = 0.9;
  const NEST_HEIGHT = 60;
  const nest = { yaw: 0, pitch: NEST_PITCH, height: NEST_HEIGHT, heading: 0, focus: new THREE.Vector3(), sx: { v: 0 }, sz: { v: 0 }, d: NEST_HEIGHT / Math.sin(NEST_PITCH), p: NEST_PITCH, f: baseFov };
  const nestFrame = { dist: 0, pitch: 0, fov: 0, height: 0, shift: 0 };
  // Default bridge pitch looks down over the console to the bow, with the horizon in the upper third.
  const BRIDGE_PITCH = 0.17;
  const bridge = { yaw: 0, pitch: BRIDGE_PITCH };
  const foot = {
    yaw: 0, pitch: 0.3, dist: 6.5, pull: 1, focus: new THREE.Vector3(), sx: { v: 0 }, sy: { v: 0 }, sz: { v: 0 }, last: new THREE.Vector3(), moveHeading: 0,
    // Framing suggested by the player system (ferry, boarding, summit): blend weight and the last suggestion.
    frameK: 0, frame: null, lift: 0, clearPull: 1,
  };
  const footClear = { pitch: 0, frac: 1 };
  const footColliders = [];
  const hullBoxes = [
    { kind: 'box', x: 0, z: 0, hx: 3.2, hz: 9.0, rot: 0, y0: -4, y1: 3 },
    { kind: 'box', x: 0, z: 0, hx: 2.15, hz: 2.9, rot: 0, y0: -1, y1: 7.8 },
  ];
  const vegCache = new Map();
  const colliderOut = [[], []];
  const free = { pos: new THREE.Vector3(), yaw: 0, pitch: 0, fov: baseFov };
  const title = { t: 0, index: -1 };
  const bino = { k: 0, active: false, yaw: 0, pitch: 0, pending: null, logged: new Map() };

  function readInvertY() {
    try {
      return !!JSON.parse(localStorage.getItem('kodiak-seiner:settings') ?? '{}').invertY;
    } catch {
      return false;
    }
  }

  const seiner = () => ctx.systems.seiner;
  const waterY = (x, z) => ctx.systems.water?.heightAt?.(x, z) ?? 0;
  const groundY = (x, z) => {
    const t = ctx.systems.terrain?.heightAt;
    return t ? t(x, z) : ctx.heightmap.heightAt(x, z);
  };
  const surfaceY = (x, z) => Math.max(waterY(x, z), groundY(x, z));
  const minCamY = (x, z) => Math.max(waterY(x, z) + 1.5, groundY(x, z) + 2);

  function lookQuat(pos, look, roll = 0, out = desired.quat) {
    mat4.lookAt(pos, look, up);
    out.setFromRotationMatrix(mat4);
    if (roll) out.multiply(tmpQ.setFromAxisAngle(tmpV2.set(0, 0, 1), roll));
    return out;
  }
  function anglesQuat(yaw, pitch, roll = 0, out = desired.quat) {
    return out.setFromEuler(euler.set(-pitch, -yaw, roll, 'YXZ'));
  }
  function cameraAngles() {
    camera.getWorldDirection(tmpV);
    return { yaw: Math.atan2(tmpV.x, -tmpV.z), pitch: Math.asin(clamp(-tmpV.y, -1, 1)) };
  }

  function startBlend(dur = 0.9) {
    blend.pos.copy(camera.position);
    blend.quat.copy(camera.quaternion);
    blend.fov = camera.fov;
    blend.t = 0;
    blend.dur = dur;
  }

  function setModeInternal(m, { snap = false, dur = 0.9 } = {}) {
    if (!MODES.includes(m)) return;
    const prev = mode;
    if (m === prev) return;
    mode = m;
    if (BOAT_MODES.includes(m)) boatMode = m;
    if (m === 'free') {
      free.pos.copy(camera.position);
      const a = cameraAngles();
      free.yaw = a.yaw;
      free.pitch = -a.pitch;
      free.fov = camera.fov;
    }
    if (m === 'title') {
      title.t = 0;
      title.index = -1;
    }
    if (m === 'foot') {
      foot.yaw = cameraAngles().yaw;
      foot.pitch = 0.3;
    }
    if (m === 'chase' || m === 'crowsnest' || m === 'foot') snapFollowers();
    if (snap || prev === 'title') {
      snapNext = true;
      blend.t = 1;
    } else {
      startBlend(dur);
    }
    events.emit('camera:mode', { mode: m, prev });
  }

  // Put the smoothed followers on their targets (after teleports and mode entries).
  function snapFollowers() {
    const s = seiner();
    if (s) {
      chase.heading = s.heading;
      nest.heading = s.heading;
      chase.focus.set(s.position.x, s.position.y + 3.8, s.position.z);
      nest.focus.set(s.position.x, 0, s.position.z);
      chase.sx.v = chase.sy.v = chase.sz.v = nest.sx.v = nest.sz.v = 0;
      chase.pull = 1;
    }
    const t = footTarget();
    if (t) {
      t.getWorldPosition(foot.focus);
      foot.focus.y += 1.55;
      foot.last.copy(foot.focus);
      foot.sx.v = foot.sy.v = foot.sz.v = 0;
    }
  }

  function footTarget() {
    if (target) return target;
    const av = ctx.game?.avatar?.();
    return av?.control === 'foot' ? av.object3d : null;
  }

  // ------------------------------------------------------------------ look input
  function lookInput(dt, sens = 1) {
    const m = input.mouse ?? { dx: 0, dy: 0, buttons: 0 };
    let dx = 0;
    let dy = 0;
    if (m.buttons & 1 || m.locked) {
      dx = m.dx;
      dy = m.dy;
    }
    const lx = input.axis?.('lookX') ?? 0;
    const ly = input.axis?.('lookY') ?? 0;
    dx += lx * 520 * dt;
    dy += ly * 420 * dt;
    if (invertY) dy = -dy;
    if (dx || dy) lastLookAt = time;
    if (m.wheel) lastZoomAt = time;
    return { dx: dx * sens, dy: dy * sens, wheel: m.wheel ?? 0 };
  }

  // ------------------------------------------------------------------ modes
  function poseChase(dt, look) {
    const s = seiner();
    if (!s) return false;
    const snap = snapNext;
    chase.yaw = wrapAngle(chase.yaw - look.dx * 0.0045);
    chase.pitch = clamp(chase.pitch + look.dy * 0.0035, -0.04, 1.3);
    if (look.wheel) {
      chase.dist = clamp(chase.dist * (1 + look.wheel * 0.1), 11, 260);
    }
    const idle = time - lastLookAt > 3;
    const pitchHome = 0.17 + 0.16 * clamp((chase.dist - 18) / 120, 0, 1);
    if (idle) {
      chase.yaw = dampAngle(chase.yaw, 0, 1.4, dt);
      chase.pitch = damp(chase.pitch, pitchHome, 2.5, dt);
    }
    chase.heading = snap ? s.heading : dampAngle(chase.heading, s.heading, 0.65, dt);
    const f = s.forward(tmpV);
    const ahead = clamp(s.speed, -3, 12) * 0.55;
    const tx = s.position.x + f.x * ahead;
    const tz = s.position.z + f.z * ahead;
    const ty = s.position.y + 3.8;
    if (snap) chase.focus.set(tx, ty, tz);
    else {
      chase.focus.x = smoothDamp(chase.focus.x, tx, chase.sx, 0.22, dt);
      chase.focus.z = smoothDamp(chase.focus.z, tz, chase.sz, 0.22, dt);
      chase.focus.y = smoothDamp(chase.focus.y, ty, chase.sy, 0.55, dt);
    }
    const yaw = chase.heading + chase.yaw;
    orbitPosition(chase.focus.x, chase.focus.y, chase.focus.z, yaw, chase.pitch, chase.dist, orbit);
    const frac = occlusionFraction(chase.focus.x, chase.focus.y, chase.focus.z, orbit.x, orbit.y, orbit.z, groundY, 2, 18);
    chase.pull = snap ? frac : frac < chase.pull ? damp(chase.pull, frac, 0.08, dt) : damp(chase.pull, frac, 0.9, dt);
    orbitPosition(chase.focus.x, chase.focus.y, chase.focus.z, yaw, chase.pitch, Math.max(8, chase.dist * chase.pull), orbit);
    desired.pos.set(orbit.x, orbit.y, orbit.z);
    desired.pos.y = Math.max(desired.pos.y, minCamY(desired.pos.x, desired.pos.z));
    // Look a little above the boat so it sits in the lower third with the coast and sky above it.
    lookQuat(desired.pos, tmpV2.copy(chase.focus).setY(chase.focus.y + chase.dist * 0.07));
    desired.fov = baseFov;
    desired.near = low ? 2 : 0.5;
    focus.set(s.position.x, s.position.y, s.position.z);
    return true;
  }

  function poseCrowsnest(dt, look) {
    const s = seiner();
    if (!s) return false;
    const snap = snapNext;
    nest.yaw = wrapAngle(nest.yaw - look.dx * 0.004);
    nest.pitch = clamp(nest.pitch + look.dy * 0.003, 0.7, 1.52);
    if (look.wheel) nest.height = clamp(nest.height * (1 + look.wheel * 0.1), 35, 420);
    if (time - lastLookAt > 3) {
      nest.yaw = dampAngle(nest.yaw, 0, 2.2, dt);
      nest.pitch = damp(nest.pitch, NEST_PITCH, 3, dt);
    }
    nest.heading = snap ? s.heading : dampAngle(nest.heading, s.heading, 2.2, dt);
    const yaw = nest.heading + nest.yaw;
    const f = s.forward(tmpV);
    let cx = s.position.x + f.x * 16;
    let cz = s.position.z + f.z * 16;
    let pose = null;
    // While the skiff is off, frame the seiner and the net (the corkline runs out to the skiff's end); before the net
    // is in the water, the seiner and the skiff. The height stays under the weather's cloud deck: a wide set tilts the
    // view toward the horizon and widens the lens instead of climbing into the haze.
    const sk = ctx.systems.skiff;
    const poly = ctx.systems.net?.polygon?.();
    const hasPoly = Array.isArray(poly) && poly.length > 2;
    const skiffOut = !!(sk && sk.state && sk.state !== 'stowed' && sk.position);
    if (hasPoly || skiffOut) {
      const ux = Math.sin(yaw); // view forward on the water
      const uz = -Math.cos(yaw);
      const rx = Math.cos(yaw); // view right
      const rz = Math.sin(yaw);
      const box = { r0: Infinity, r1: -Infinity, f0: Infinity, f1: -Infinity };
      const add = (x, z) => {
        const r = x * rx + z * rz;
        const g = x * ux + z * uz;
        if (r < box.r0) box.r0 = r;
        if (r > box.r1) box.r1 = r;
        if (g < box.f0) box.f0 = g;
        if (g > box.f1) box.f1 = g;
      };
      add(s.position.x + f.x * 9, s.position.z + f.z * 9);
      add(s.position.x - f.x * 9, s.position.z - f.z * 9);
      if (hasPoly) {
        for (const p of poly) if (Number.isFinite(p?.x) && Number.isFinite(p?.z)) add(p.x, p.z);
      } else add(sk.position.x, sk.position.z);
      const pad = 22;
      pose = crowsnestFrame({
        across: box.r1 - box.r0 + pad,
        along: box.f1 - box.f0 + pad,
        pitch: nest.pitch,
        fovDeg: baseFov,
        aspect: camera.aspect || 16 / 9,
        ceiling: crowsnestCeiling(ctx.systems.sky?.weather?.cloudBase),
        floor: nest.height,
      }, nestFrame);
      const mr = (box.r0 + box.r1) / 2;
      const mf = (box.f0 + box.f1) / 2 + pose.shift;
      cx = rx * mr + ux * mf;
      cz = rz * mr + uz * mf;
    }
    const tDist = pose ? pose.dist : nest.height / Math.sin(nest.pitch);
    const tPitch = pose ? pose.pitch : nest.pitch;
    const tFov = pose ? pose.fov : baseFov;
    if (snap) {
      nest.focus.set(cx, 0, cz);
      nest.d = tDist;
      nest.p = tPitch;
      nest.f = tFov;
    } else {
      nest.focus.x = smoothDamp(nest.focus.x, cx, nest.sx, 0.7, dt);
      nest.focus.z = smoothDamp(nest.focus.z, cz, nest.sz, 0.7, dt);
      nest.d = damp(nest.d, tDist, 1.2, dt);
      nest.p = damp(nest.p, tPitch, 1.2, dt);
      nest.f = damp(nest.f, tFov, 1.2, dt);
    }
    nest.focus.y = s.position.y;
    orbitPosition(nest.focus.x, nest.focus.y, nest.focus.z, yaw, nest.p, nest.d, orbit);
    desired.pos.set(orbit.x, Math.max(orbit.y, groundY(orbit.x, orbit.z) + 25), orbit.z);
    lookQuat(desired.pos, nest.focus);
    desired.fov = nest.f;
    desired.near = low ? 2 : 0.5;
    focus.copy(nest.focus);
    return true;
  }

  function poseBridge(dt, look) {
    const s = seiner();
    if (!s) return false;
    bridge.yaw = clamp(bridge.yaw - look.dx * 0.004, -2.7, 2.7);
    bridge.pitch = clamp(bridge.pitch + look.dy * 0.0032, -0.6, 1.0);
    if (time - lastLookAt > 3) {
      bridge.yaw = damp(bridge.yaw, 0, 1.3, dt);
      bridge.pitch = damp(bridge.pitch, BRIDGE_PITCH, 2, dt);
    }
    const eye = s.eyePoint ? s.eyePoint(desired.pos) : desired.pos.copy(s.position).setY(s.position.y + 7.4);
    if (low) {
      // 24-bit depth on the low preset needs near >= 2 m: stand at the back of the flying bridge so the console and
      // windscreen stay beyond the near plane.
      const f = s.forward(tmpV);
      eye.addScaledVector(f, -2.3);
      eye.y += 0.4;
    }
    anglesQuat(s.heading + bridge.yaw, bridge.pitch - (s.pitch ?? 0) * 0.6, -(s.roll ?? 0) * 0.5);
    desired.fov = 62;
    desired.near = low ? 2 : 0.12;
    focus.copy(s.position);
    return true;
  }

  function poseFoot(dt, look) {
    const t = footTarget();
    if (!t) return poseChase(dt, look);
    const snap = snapNext;
    // The player system's suggested framing (ferry, boarding, summit), eased in while the player leaves the camera
    // alone. Touching the camera adopts the blended pose as the player's own, so nothing jumps.
    const fr = ctx.systems.player?.cameraFraming ?? null;
    if (fr && Number.isFinite(fr.dist) && Number.isFinite(fr.pitch)) foot.frame = fr;
    const idle = time - lastLookAt > 3 && time - lastZoomAt > 3;
    if ((look.dx || look.dy || look.wheel) && foot.frameK > 0.001 && foot.frame) {
      foot.dist = lerp(foot.dist, foot.frame.dist, foot.frameK);
      foot.pitch = lerp(foot.pitch, foot.frame.pitch, foot.frameK);
      foot.frameK = 0;
    }
    foot.yaw = wrapAngle(foot.yaw - look.dx * 0.0048);
    foot.pitch = clamp(foot.pitch + look.dy * 0.0038, -0.35, 1.35);
    if (look.wheel) foot.dist = clamp(foot.dist * (1 + look.wheel * 0.1), 2.2, 28);
    const summit = fr?.kind === 'summit';
    // Cutscenes (the skiff runs) take no camera input, so their framing applies at once.
    const kWant = fr && foot.frame && (idle || ctx.state.mode !== 'play') ? 1 : 0;
    foot.frameK = snap ? kWant : damp(foot.frameK, kWant, summit ? 1.3 : 0.6, dt);
    t.getWorldPosition(tmpV);
    const tx = tmpV.x;
    const ty = tmpV.y + 1.55;
    const tz = tmpV.z;
    const moved = Math.hypot(tx - foot.last.x, tz - foot.last.z);
    if (dt > 0 && moved / dt > 0.6) foot.moveHeading = Math.atan2(tx - foot.last.x, -(tz - foot.last.z));
    foot.last.set(tx, ty, tz);
    if (time - lastLookAt > 3 && dt > 0 && moved / dt > 0.6) foot.yaw = dampAngle(foot.yaw, foot.moveHeading, 3.5, dt);
    // On a summit, turn slowly to look out over the anchored boat.
    const sn = seiner();
    if (summit && idle && sn && dt > 0) {
      const a = lookAngles(tx, 0, tz, sn.position.x, 0, sn.position.z);
      foot.yaw = dampAngle(foot.yaw, a.yaw, 2.2, dt);
    }
    if (snap) foot.focus.set(tx, ty, tz);
    else {
      foot.focus.x = smoothDamp(foot.focus.x, tx, foot.sx, 0.12, dt);
      foot.focus.y = smoothDamp(foot.focus.y, ty, foot.sy, 0.2, dt);
      foot.focus.z = smoothDamp(foot.focus.z, tz, foot.sz, 0.12, dt);
    }
    const k = foot.frame ? foot.frameK : 0;
    const dist = foot.frame ? lerp(foot.dist, foot.frame.dist, k) : foot.dist;
    let pitch = foot.frame ? lerp(foot.pitch, foot.frame.pitch, k) : foot.pitch;
    // Foliage, props and the seiner's hull: lift the view over them, else pull in behind the person.
    gatherFootColliders(foot.focus.x, foot.focus.z, dist + 3);
    clearOrbit(foot.focus.x, foot.focus.y, foot.focus.z, foot.yaw, pitch, dist, footBlocked, { minT: 2.0, maxPitch: Math.max(pitch, 0.95) }, footClear);
    const liftWant = footClear.pitch - pitch;
    foot.lift = snap ? liftWant : damp(foot.lift, liftWant, liftWant > foot.lift ? 0.18 : 0.9, dt);
    foot.clearPull = snap ? footClear.frac : damp(foot.clearPull, footClear.frac, footClear.frac < foot.clearPull ? 0.08 : 0.7, dt);
    pitch += foot.lift;
    orbitPosition(foot.focus.x, foot.focus.y, foot.focus.z, foot.yaw, pitch, dist, orbit);
    const frac = Math.min(occlusionFraction(foot.focus.x, foot.focus.y, foot.focus.z, orbit.x, orbit.y, orbit.z, groundY, 0.6, 14), foot.clearPull);
    foot.pull = snap ? frac : frac < foot.pull ? damp(foot.pull, frac, 0.06, dt) : damp(foot.pull, frac, 0.6, dt);
    orbitPosition(foot.focus.x, foot.focus.y, foot.focus.z, foot.yaw, pitch, Math.max(1.2, dist * foot.pull), orbit);
    desired.pos.set(orbit.x, orbit.y, orbit.z);
    desired.pos.y = Math.max(desired.pos.y, waterY(orbit.x, orbit.z) + 1.2, groundY(orbit.x, orbit.z) + 0.8);
    lookQuat(desired.pos, foot.focus);
    desired.fov = lerp(baseFov, 60, summit || foot.frame?.kind === 'summit' ? k : 0);
    desired.near = 0.3;
    focus.set(tx, tmpV.y, tz);
    return true;
  }

  // Canopy top above the ground (m) at a point: alder/salmonberry thickets and spruce, from the terrain's landcover.
  // Cached on a 2 m grid; the queries are too costly to repeat per ray sample every frame.
  function vegTop(x, z) {
    const ix = Math.round(x / 2);
    const iz = Math.round(z / 2);
    const key = ix * 100003 + iz;
    let v = vegCache.get(key);
    if (v !== undefined) return v;
    const ter = ctx.systems.terrain;
    v = 0;
    const surf = ter?.surfaceAt?.(ix * 2, iz * 2);
    const alder = ter?.alderDensity?.(ix * 2, iz * 2) ?? (surf === 'alder' ? 0.8 : 0);
    // Spruce crowns come from the published tree colliders when there are any; else dense forest is a solid canopy.
    if (typeof ter?.collidersNear !== 'function' && (ter?.forestDensity?.(ix * 2, iz * 2) ?? 0) > 0.6) v = 14;
    else if (alder > 0.3) v = 2.2 + 1.8 * clamp(alder, 0, 1);
    if (vegCache.size > 4000) vegCache.clear();
    vegCache.set(key, v);
    return v;
  }

  function gatherFootColliders(x, z, r) {
    footColliders.length = 0;
    const srcs = [ctx.systems.terrain, ctx.systems.places];
    for (let i = 0; i < srcs.length; i++) {
      // Trees are circles around the trunk; their crowns reach ~5 m out, so the query is wider than the orbit.
      const list = srcs[i]?.collidersNear?.(x, z, r + 6, colliderOut[i]);
      if (Array.isArray(list)) for (const c of list) footColliders.push(c);
    }
    // The seiner: hull to the bulwarks, and the house up to the flying bridge.
    const s = seiner();
    if (s?.position && Math.hypot(s.position.x - x, s.position.z - z) < r + 12) {
      const h = s.heading ?? 0;
      const fx = Math.sin(h);
      const fz = -Math.cos(h);
      const [hullB, house] = hullBoxes;
      hullB.x = s.position.x;
      hullB.z = s.position.z;
      hullB.rot = h;
      hullB.y1 = s.position.y + 3;
      house.x = s.position.x + fx * 2.2;
      house.z = s.position.z + fz * 2.2;
      house.rot = h;
      house.y1 = s.position.y + 7.8;
      footColliders.push(hullB, house);
    }
  }

  function footBlocked(x, y, z) {
    for (let i = 0; i < footColliders.length; i++) {
      const c = footColliders[i];
      if (insideCollider(c, x, y, z, 0.35)) return true;
      // A tall circle is a spruce: its boughs form a cone from ~12% of the height to the tip.
      if (c?.kind === 'circle' && c.y1 - c.y0 > 5 && y > c.y0 && y < c.y1) {
        const h = c.y1 - c.y0;
        const crown = 0.3 * h * clamp((1 - (y - c.y0) / h) / 0.88, 0, 1);
        const dx = x - c.x;
        const dz = z - c.z;
        if (dx * dx + dz * dz < crown * crown * 0.8) return true;
      }
    }
    const top = vegTop(x, z);
    return top > 0 && y < groundY(x, z) + top + 0.3;
  }

  function poseTitle(dt) {
    title.t += dt;
    const { shot, index, t } = shotAt(TITLE_SHOTS, title.t);
    const s = seiner();
    if (index !== title.index) {
      title.index = index;
      snapNext = true;
      if (ctx.flags?.time === null || ctx.flags?.time === undefined) ctx.clock?.set?.(shot.hours, ctx.clock.day);
      if (shot.kind === 'seiner' && s) {
        s.setPose?.(shot.seiner.x, shot.seiner.z, (shot.seiner.headingDeg * Math.PI) / 180);
        s.setAutopilot?.({ heading: (shot.seiner.headingDeg * Math.PI) / 180, throttle: shot.seiner.throttle });
      } else {
        s?.setAutopilot?.(null);
      }
    }
    const e = easeInOutSine(t);
    if (shot.kind === 'seiner' && s) {
      const az = ((lerp(shot.from.az, shot.to.az, e)) * Math.PI) / 180 + s.heading;
      const dist = lerp(shot.from.dist, shot.to.dist, e);
      const x = s.position.x + Math.sin(az) * dist;
      const z = s.position.z - Math.cos(az) * dist;
      desired.pos.set(x, surfaceY(x, z) + lerp(shot.from.h, shot.to.h, e), z);
      const f = s.forward(tmpV);
      tmpV2.set(s.position.x + f.x * 3, s.position.y + shot.lookH, s.position.z + f.z * 3);
      focus.copy(s.position);
    } else {
      const x = lerp(shot.from.x, shot.to.x, e);
      const z = lerp(shot.from.z, shot.to.z, e);
      desired.pos.set(x, surfaceY(x, z) + lerp(shot.from.h, shot.to.h, e), z);
      tmpV2.set(lerp(shot.lookFrom.x, shot.lookTo.x, e), lerp(shot.lookFrom.y, shot.lookTo.y, e), lerp(shot.lookFrom.z, shot.lookTo.z, e));
      focus.copy(tmpV2).lerp(desired.pos, 0.4);
    }
    desired.pos.y = Math.max(desired.pos.y, minCamY(desired.pos.x, desired.pos.z));
    lookQuat(desired.pos, tmpV2);
    desired.fov = shot.fov ?? baseFov;
    desired.near = low ? 2 : 0.5;
    return true;
  }

  function poseFree(realDt) {
    const m = input.mouse ?? { dx: 0, dy: 0, buttons: 0, wheel: 0 };
    if (m.buttons & 1 || m.locked) {
      free.yaw = wrapAngle(free.yaw + m.dx * 0.0035 * (free.fov / baseFov));
      free.pitch = clamp(free.pitch - m.dy * 0.0035 * (free.fov / baseFov) * (invertY ? -1 : 1), -1.5, 1.5);
    }
    if (m.wheel) free.fov = clamp(free.fov * (1 + m.wheel * 0.08), 12, 85);
    const k = (c) => (input.keyDown?.(c) ? 1 : 0);
    const fwd = k('KeyW') + k('ArrowUp') - k('KeyS') - k('ArrowDown');
    const side = k('KeyD') + k('ArrowRight') - k('KeyA') - k('ArrowLeft');
    const vert = k('KeyE') + k('Space') - k('KeyQ') - k('KeyC');
    const alt = Math.max(0, free.pos.y - surfaceY(free.pos.x, free.pos.z));
    const speed = (8 + alt * 0.6) * (k('ShiftLeft') || k('ShiftRight') ? 4 : 1) * (k('AltLeft') ? 0.25 : 1);
    const cy = Math.cos(free.pitch);
    const fx = Math.sin(free.yaw) * cy;
    const fz = -Math.cos(free.yaw) * cy;
    const fy = Math.sin(free.pitch);
    const rx = Math.cos(free.yaw);
    const rz = Math.sin(free.yaw);
    const d = Math.min(realDt, 0.1) * speed;
    free.pos.x += (fx * fwd + rx * side) * d;
    free.pos.y += (fy * fwd + vert) * d;
    free.pos.z += (fz * fwd + rz * side) * d;
    free.pos.x = clamp(free.pos.x, -9500, 9500);
    free.pos.z = clamp(free.pos.z, -9500, 9500);
    free.pos.y = clamp(Math.max(free.pos.y, minCamY(free.pos.x, free.pos.z)), -10, 3000);
    desired.pos.copy(free.pos);
    anglesQuat(free.yaw, -free.pitch, 0);
    desired.fov = free.fov;
    desired.near = low ? 2 : 0.3;
    focus.set(free.pos.x + fx * 60, free.pos.y + fy * 60, free.pos.z + fz * 60);
    return true;
  }

  // ------------------------------------------------------------------ binoculars
  function binocularEye(out) {
    const s = seiner();
    if (mode === 'foot') {
      const t = footTarget();
      if (t) {
        t.getWorldPosition(out);
        out.y += 1.62;
        return out;
      }
    }
    if (mode === 'crowsnest') return out.copy(camera.position);
    if (s?.eyePoint) return s.eyePoint(out);
    return out.copy(camera.position);
  }

  function poseBinoculars(dt, look) {
    const sens = Math.max(0.12, camera.fov / baseFov);
    bino.yaw = wrapAngle(bino.yaw - look.dx * 0.0035 * sens);
    bino.pitch = clamp(bino.pitch + look.dy * 0.003 * sens, -0.8, 0.6);
    binocularEye(desired.pos);
    const s = seiner();
    const breathe = Math.sin(time * 1.9) * 0.0011 + wobble(time * 0.6, 7) * 0.0012;
    const drift = Math.sin(time * 0.7) * 0.0016 + wobble(time * 0.45, 9) * 0.0014;
    const boatRoll = mode === 'foot' ? 0 : (s?.roll ?? 0) * 0.12;
    anglesQuat(bino.yaw + drift, bino.pitch + breathe - (mode === 'foot' ? 0 : (s?.pitch ?? 0) * 0.15), -boatRoll);
    desired.fov = lerp(desired.fov, 12, easeInOut(bino.k));
    desired.near = low ? 2 : 0.5;
    return true;
  }

  // A jump seen through the glasses; held in view for ~1 s it becomes a logged sighting.
  events.on('fish:jump', (e) => {
    if (!bino.active || bino.k < 0.8 || !e) return;
    const dx = e.x - camera.position.x;
    const dz = e.z - camera.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 3500) return;
    camera.getWorldDirection(tmpV);
    const len = Math.hypot(dx, e.y - camera.position.y, dz) || 1;
    const cos = (tmpV.x * dx + tmpV.y * (e.y - camera.position.y) + tmpV.z * dz) / len;
    if (cos < Math.cos(THREE.MathUtils.degToRad(camera.fov * 0.6))) return;
    if (bino.logged.has(e.schoolId) && time - bino.logged.get(e.schoolId) < 90) return;
    if (!bino.pending || bino.pending.schoolId !== e.schoolId) {
      bino.pending = { schoolId: e.schoolId, species: e.species, heading: e.heading, x: e.x, z: e.z, since: time };
    }
  });

  function updateSighting() {
    const p = bino.pending;
    if (!p) return;
    if (!bino.active) {
      bino.pending = null;
      return;
    }
    const school = ctx.systems.fish?.schools?.find?.((sc) => sc.id === p.schoolId);
    const x = school?.position?.x ?? p.x;
    const z = school?.position?.z ?? p.z;
    camera.getWorldDirection(tmpV);
    const dx = x - camera.position.x;
    const dz = z - camera.position.z;
    const len = Math.hypot(dx, dz, camera.position.y) || 1;
    const cos = (tmpV.x * dx + tmpV.y * -camera.position.y + tmpV.z * dz) / len;
    if (cos < Math.cos(THREE.MathUtils.degToRad(camera.fov * 0.55))) {
      bino.pending = null;
      return;
    }
    if (time - p.since >= 1) {
      const heading = school?.velocity ? Math.atan2(school.velocity.x, -school.velocity.z) : p.heading;
      const sighting = { schoolId: p.schoolId, species: school?.species ?? p.species, heading, x, z, day: ctx.clock?.day, hours: ctx.clock?.hours };
      ctx.systems.discovery?.addSighting?.(sighting);
      events.emit('camera:sighting', sighting);
      bino.logged.set(p.schoolId, time);
      bino.pending = null;
    }
  }

  // ------------------------------------------------------------------ apply
  function apply(dt) {
    const ov = ctx.debug?.cameraOverride;
    if (blend.t < 1 && !snapNext) {
      blend.t = Math.min(1, blend.t + dt / blend.dur);
      const k = easeInOut(blend.t);
      camera.position.lerpVectors(blend.pos, desired.pos, k);
      camera.quaternion.slerpQuaternions(blend.quat, desired.quat, k);
      camera.fov = lerp(blend.fov, desired.fov, k);
    } else {
      camera.position.copy(desired.pos);
      camera.quaternion.copy(desired.quat);
      camera.fov = desired.fov;
      blend.t = 1;
    }
    // Never under the sea or inside a hill, even mid-blend.
    if (mode !== 'bridge' && mode !== 'foot') camera.position.y = Math.max(camera.position.y, minCamY(camera.position.x, camera.position.z));
    trauma = Math.max(0, trauma - dt * 1.1);
    if (trauma > 0 && !ov) {
      shakeOffsets(time, trauma, shakeO);
      camera.quaternion.multiply(tmpQ.setFromEuler(euler.set(shakeO.pitch, shakeO.yaw, shakeO.roll, 'YXZ')));
      camera.position.y += shakeO.y;
    }
    let near = desired.near;
    if (ov) {
      camera.fov = baseFov;
      near = low ? 2 : 0.5;
      focus.fromArray(ov.look);
    }
    if (camera.near !== near || Math.abs(camera.fov - (camera.userData.lastFov ?? 0)) > 1e-4) {
      camera.near = near;
      camera.userData.lastFov = camera.fov;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
    ctx.systems.sky?.shadowFocus?.copy?.(focus);
    snapNext = false;
  }

  function step(dt) {
    time += dt;
    const playing = ctx.state.mode === 'play';
    const look = playing ? lookInput(dt) : { dx: 0, dy: 0, wheel: 0 };
    if (playing && input.pressed?.('camera') && mode !== 'foot') rig.cycle();

    // Binoculars: from the gameplay modes only.
    const wantBino = playing && !ctx.debug?.cameraOverride && mode !== 'title' && mode !== 'free' && !!input.action?.('binoculars');
    if (wantBino !== bino.active) {
      bino.active = wantBino;
      if (wantBino) {
        const a = cameraAngles();
        bino.yaw = a.yaw;
        bino.pitch = clamp(a.pitch * 0.25, -0.2, 0.3);
        if (mode === 'crowsnest') bino.pitch = clamp(a.pitch * 0.4, 0, 0.6);
        startBlend(0.3);
      } else {
        startBlend(0.45);
        lastLookAt = time;
      }
    }
    bino.k = clamp(bino.k + (bino.active ? dt : -dt) / 0.28, 0, 1);

    let ok = false;
    if (mode === 'title') ok = poseTitle(dt);
    else if (bino.active) {
      const mk = { chase: poseChase, crowsnest: poseCrowsnest, bridge: poseBridge, foot: poseFoot }[mode] ?? poseChase;
      mk(dt, { dx: 0, dy: 0, wheel: 0 });
      ok = poseBinoculars(dt, look);
    } else if (mode === 'chase') ok = poseChase(dt, look);
    else if (mode === 'crowsnest') ok = poseCrowsnest(dt, look);
    else if (mode === 'bridge') ok = poseBridge(dt, look);
    else if (mode === 'foot') ok = poseFoot(dt, look);
    if (ok) apply(dt);
    updateSighting();
  }

  events.on('game:mode', ({ mode: m }) => {
    invertY = readInvertY();
    if (m === 'title') setModeInternal('title', { snap: true });
    else if (m === 'photo') {
      photoReturn = mode;
      setModeInternal('free', { snap: true });
    } else if (m === 'play' || m === 'cutscene') {
      if (mode === 'free') setModeInternal(photoReturn === 'free' ? boatMode : photoReturn, { snap: true });
      else if (mode === 'title') setModeInternal(ctx.state.control === 'foot' ? 'foot' : boatMode, { snap: true });
    }
  });
  events.on('player:mode', ({ control }) => {
    if (mode === 'title' || mode === 'free') return;
    setModeInternal(control === 'foot' ? 'foot' : boatMode, { dur: 1.2 });
  });
  events.on('boat:teleport', () => {
    snapNext = true;
    chase.yaw = 0;
    nest.yaw = 0;
    bridge.yaw = 0;
    blend.t = 1;
  });
  events.on('boat:collision', (e) => rig.shake(clamp((e?.speed ?? 2) / 5, 0.25, 1)));

  const rig = {
    get mode() {
      return mode;
    },
    focus,
    get binoculars() {
      return bino.active;
    },
    get fov() {
      return camera.fov;
    },
    setMode(m) {
      if (m === mode || !MODES.includes(m)) return;
      setModeInternal(m);
    },
    cycle() {
      lastCycleAt = time;
      const i = BOAT_MODES.indexOf(mode);
      setModeInternal(BOAT_MODES[(i + 1) % BOAT_MODES.length], { dur: 1.0 });
    },
    // Gameplay hint (e.g. crow's nest on skiff release); ignored if the player chose a camera in the last 10 s.
    suggest(m) {
      if (!BOAT_MODES.includes(m) || !BOAT_MODES.includes(mode)) return false;
      if (time - lastCycleAt < 10 || m === mode) return false;
      setModeInternal(m, { dur: 1.4 });
      return true;
    },
    setTarget(obj) {
      target = obj ?? null;
      if (target && mode === 'foot') snapFollowers();
    },
    shake(amount = 0.5) {
      trauma = clamp(trauma + amount, 0, 1);
    },
    // Jump the title cinematic to shot `index` (fraction `frac` into it). Title shots are listed in titleShots.js.
    seekTitle(index = 0, frac = 0) {
      const n = TITLE_SHOTS.length;
      const i = ((Math.floor(index) % n) + n) % n;
      let t = 0;
      for (let k = 0; k < i; k++) t += TITLE_SHOTS[k].duration;
      title.t = t + clamp(frac, 0, 0.999) * TITLE_SHOTS[i].duration;
      title.index = -1;
      return TITLE_SHOTS[i].id;
    },
    titleShots: TITLE_SHOTS.map((s) => s.id),
    // The title shot on screen: { id, label } while the cinematic runs, else null (for the title-screen caption).
    get titleShot() {
      if (mode !== 'title') return null;
      const s = TITLE_SHOTS[Math.max(0, title.index)];
      return s ? { id: s.id, label: s.label } : null;
    },

    lateUpdate(dt) {
      if (ctx.state.mode === 'photo') return;
      if (!(dt > 0) && !snapNext) {
        // Paused / map: hold the frame, but keep the shadow focus pinned.
        ctx.systems.sky?.shadowFocus?.copy?.(focus);
        return;
      }
      step(dt);
    },

    frame(realDt) {
      if (ctx.state.mode === 'photo' && mode === 'free') {
        time += realDt;
        poseFree(realDt);
        blend.t = 1;
        apply(realDt);
      }
    },

    debugState() {
      return {
        mode,
        boatMode,
        binoculars: bino.active,
        fov: +camera.fov.toFixed(1),
        near: camera.near,
        focus: [+focus.x.toFixed(1), +focus.y.toFixed(1), +focus.z.toFixed(1)],
        pos: [+camera.position.x.toFixed(1), +camera.position.y.toFixed(1), +camera.position.z.toFixed(1)],
        titleShot: mode === 'title' ? TITLE_SHOTS[Math.max(0, title.index)]?.id : null,
      };
    },

    reset() {
      boatMode = 'chase';
      chase.yaw = 0;
      chase.pitch = 0.24;
      chase.dist = 34;
      nest.height = NEST_HEIGHT;
      bino.logged.clear();
      snapNext = true;
    },
  };
  return rig;
}
