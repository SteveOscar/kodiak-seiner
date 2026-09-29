// WP-BOATS: the seine skiff (SPEC §6.8). Behaviour lives in boats/skiffController.js (pure, unit-tested); this
// module poses the model on the stern ramp or the sea, draws the towline / tie line, and makes the wake and splash.

import * as THREE from 'three';
import { createSkiffController } from './boats/skiffController.js';
import { buildSkiffModel, skiffSea } from './boats/skiffModel.js';
import { setSeaPlane } from './boats/waterline.js';
import { springStep } from './boats/handling.js';
import { createParticlePool, createGlowSet, projScale } from './boats/fx.js';
import { createRope } from './boats/rope.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const xz = (p) => (p ? { x: p.x, z: p.z } : null);

export async function create(ctx) {
  const { scene, events } = ctx;
  const ctl = createSkiffController({ emit: (n, p) => events.emit(n, p) });
  const s = ctl.s;
  const model = buildSkiffModel(ctx, { detail: 'full' });
  const group = model.group;
  scene.add(group);
  ctx.systems.water?.addOccluder?.(model.occluder);
  // Deck floods light the skiff too while it rides the stern or works alongside.
  group.traverse((o) => {
    if (o.isMesh && o.material && o !== model.occluder) ctx.systems.seiner?.floodPatch?.(o.material);
  });

  const line = createRope(ctx, { radius: 0.028, color: '#d9a93c', name: 'skiff-line' });
  const stake = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 1.3, 6), new THREE.MeshStandardMaterial({ color: 0x6b5236, roughness: 0.9 }));
  stake.visible = false;
  stake.castShadow = true;
  stake.name = 'tie-stake';
  scene.add(stake);
  const spray = createParticlePool(ctx, { max: 160, renderOrder: 203, name: 'skiff-spray' });
  const smoke = createParticlePool(ctx, { max: 60, renderOrder: 204, name: 'skiff-exhaust', falloff: 2.6, nearFade: [1.5, 6] });
  const glow = createGlowSet(ctx, [{ pos: model.points.light.toArray(), color: 0xfff2dc, size: 0.45, intensity: 1.4 }], { parent: group, name: 'skiff-light' });

  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const bagPoint = { x: 0, z: 0 };
  const qA = new THREE.Quaternion();
  const qB = new THREE.Quaternion();
  const mountPos = new THREE.Vector3();
  const mountQuat = new THREE.Quaternion();
  const mountScale = new THREE.Vector3();
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const sample = { height: 0, normal: new THREE.Vector3(0, 1, 0) };
  const att = { roll: 0, rollVel: 0, pitch: 0, pitchVel: 0, heave: 0, heaveVel: 0 };
  let splashPending = false;
  let wakeTimer = 0;
  let prevEffort = 0;
  let smokeAcc = 0;
  let tiedPoint = null;
  let seaFloor = 0;
  const floorAtSkiff = () => seaFloor;

  const water = () => ctx.systems.water;
  const seiner = () => ctx.systems.seiner;
  const waterY = (x, z) => water()?.heightAt?.(x, z) ?? 0;
  const heightOf = (x, z) => {
    const w = water();
    if (w?.sample) return w.sample(x, z, sample)?.height ?? 0;
    return w?.heightAt?.(x, z) ?? 0;
  };

  // Seiner view for the controller (plain {x, z} points).
  const sv = { x: 0, z: 0, heading: 0, vx: 0, vz: 0, stern: { x: 0, z: 0 }, mount: { x: 0, z: 0 }, bitt: null };
  function seinerView() {
    const sn = seiner();
    if (!sn) return null;
    sv.x = sn.position.x;
    sv.z = sn.position.z;
    sv.heading = sn.heading;
    sv.vx = sn.velocity?.x ?? 0;
    sv.vz = sn.velocity?.z ?? 0;
    const st = sn.sternPoint?.(tmp) ?? sn.position;
    sv.stern.x = st.x;
    sv.stern.z = st.z;
    const mt = sn.skiffMountPoint?.(tmp) ?? sn.position;
    sv.mount.x = mt.x;
    sv.mount.z = mt.z;
    sv.bitt = (side) => {
      const p = sn.bittPoint ? sn.bittPoint(side, tmp2) : null;
      if (p) return { x: p.x, z: p.z };
      const r = side === 'starboard' ? 1 : -1;
      return { x: sn.position.x + Math.cos(sn.heading) * 3 * r, z: sn.position.z + Math.sin(sn.heading) * 3 * r };
    };
    return sv;
  }
  const env = {
    seiner: null,
    current: (x, z) => ctx.tide?.currentAt?.(x, z) ?? { x: 0, z: 0 },
    depthAt: (x, z) => ctx.heightmap.depthAt(x, z),
  };

  events.on('skiff:splash', () => {
    splashPending = true;
  });
  events.on('boat:teleport', () => {
    if (s.state !== 'stowed' && s.state !== 'ferry') sys.stow();
  });

  function mountPose() {
    const sn = seiner();
    const mount = sn?.model?.skiffMount;
    if (mount) {
      mount.updateWorldMatrix(true, false);
      mount.matrixWorld.decompose(mountPos, mountQuat, mountScale);
    } else if (sn) {
      sn.skiffMountPoint?.(mountPos);
      mountQuat.setFromEuler(euler.set(0.2, -sn.heading, 0, 'YXZ'));
    }
  }

  function waterPose(dt, squat) {
    const f = [Math.sin(s.heading), -Math.cos(s.heading)];
    const r = [Math.cos(s.heading), Math.sin(s.heading)];
    const hl = 2.4;
    const hb = 1.2;
    const hBow = heightOf(s.x + f[0] * hl, s.z + f[1] * hl);
    const hStern = heightOf(s.x - f[0] * hl, s.z - f[1] * hl);
    const hPort = heightOf(s.x - r[0] * hb, s.z - r[1] * hb);
    const hStb = heightOf(s.x + r[0] * hb, s.z + r[1] * hb);
    const heave = (hBow + hStern + hPort + hStb) / 4;
    setSeaPlane(skiffSea, s.x, s.z, heave, (hBow - hStern) / (2 * hl), (hStb - hPort) / (2 * hb), s.heading, true);
    const pitchT = Math.atan2(hBow - hStern, hl * 2) + squat;
    const rollT = Math.atan2(hPort - hStb, hb * 2) + clamp(-s.speed * 0.01 * Math.sin(s.heading * 0), -0.1, 0.1);
    [att.pitch, att.pitchVel] = springStep(att.pitch, att.pitchVel, pitchT, 1.6, 0.5, dt);
    [att.roll, att.rollVel] = springStep(att.roll, att.rollVel, rollT, 1.8, 0.4, dt);
    [att.heave, att.heaveVel] = springStep(att.heave, att.heaveVel, heave - squat * 1.2, 1.2, 0.6, dt);
  }

  function applyWater() {
    group.position.set(s.x, att.heave, s.z);
    group.quaternion.setFromEuler(euler.set(att.pitch, -s.heading, -att.roll, 'YXZ'));
  }

  function updateFx(dt) {
    const w = water();
    const speed = Math.abs(s.speed);
    const inWater = s.state !== 'stowed' && s.state !== 'released' && !(s.state === 'returning' && s.phase === 'winch');
    const f = [Math.sin(s.heading), -Math.cos(s.heading)];
    if (w?.stamp && inWater) {
      const sx = s.x - f[0] * 2.9;
      const sz = s.z - f[1] * 2.9;
      if (speed > 0.6) w.stamp(sx, sz, 1.4 + speed * 0.25, clamp(speed / 6, 0.2, 0.9), 'foam');
      if (s.effort > 0.35) w.stamp(sx - f[0] * 1.5, sz - f[1] * 1.5, 1.6 + s.effort * 2.2, clamp(s.effort, 0, 1) * 0.85, 'foam');
      wakeTimer -= dt;
      if (speed > 2.5 && wakeTimer <= 0) {
        wakeTimer = 0.7;
        w.stamp(s.x + f[0] * 2.6, s.z + f[1] * 2.6, 1.5, 0.45, 'ripple');
      }
    }
    if (splashPending) {
      splashPending = false;
      if (w?.stamp) {
        w.stamp(s.x, s.z, 5, 1, 'foam');
        w.stamp(s.x, s.z, 3, 1, 'ripple');
        w.stamp(s.x, s.z, 6, 0.7, 'ripple');
      }
      for (let i = 0; i < 70; i++) {
        const a = Math.random() * Math.PI * 2;
        const v = 2 + Math.random() * 4;
        spray.emit({
          x: s.x + Math.cos(a) * (1 + Math.random() * 1.4),
          y: waterY(s.x, s.z) + 0.2,
          z: s.z + Math.sin(a) * (1 + Math.random() * 1.4),
          vx: Math.cos(a) * v,
          vy: 2.5 + Math.random() * 4.5,
          vz: Math.sin(a) * v,
          life: 0.9 + Math.random() * 0.7,
          size0: 0.3,
          size1: 1.2 + Math.random() * 1.2,
          alpha: 0.7,
          color: [0.95, 0.97, 1],
          drag: 0.8,
          gravity: 9,
        });
      }
    }
    // Bow spray at speed.
    if (inWater && speed > 3.5 && Math.random() < dt * (speed - 3) * 5) {
      const r = [Math.cos(s.heading), Math.sin(s.heading)];
      const side = Math.random() < 0.5 ? -1 : 1;
      spray.emit({
        x: s.x + f[0] * 2.3 + r[0] * side * 1.2,
        y: waterY(s.x, s.z) + 0.2,
        z: s.z + f[1] * 2.3 + r[1] * side * 1.2,
        vx: s.vx * 0.8 + r[0] * side * 2.5,
        vy: 1.5 + Math.random() * 2,
        vz: s.vz * 0.8 + r[1] * side * 2.5,
        life: 0.7,
        size0: 0.25,
        size1: 0.9,
        alpha: 0.5,
        color: [0.95, 0.97, 1],
        drag: 1,
        gravity: 9,
      });
    }
    // Exhaust: a light blue-grey diesel haze, a little denser when the skiffman opens the throttle or works hard.
    const opening = Math.max(0, s.effort - prevEffort) / Math.max(dt, 1e-3);
    prevEffort = s.effort;
    if (inWater) {
      smokeAcc += (1 + s.effort * 6) * dt + (opening > 0.4 ? 2 : 0);
      group.updateMatrixWorld(true);
      const top = tmp.copy(model.points.stack).applyMatrix4(group.matrixWorld);
      while (smokeAcc >= 1) {
        smokeAcc -= 1;
        const heavy = opening > 0.4 || s.effort > 0.7;
        const g = 0.55 + Math.random() * 0.1;
        smoke.emit({
          x: top.x, y: top.y, z: top.z,
          vx: s.vx + (Math.random() - 0.5) * 0.3, vy: 1.2 + s.effort * 1.2, vz: s.vz + (Math.random() - 0.5) * 0.3,
          life: 1.1 + Math.random() * 0.6, size0: 0.2, size1: heavy ? 1.5 : 1.0,
          alpha: heavy ? 0.14 : 0.07, color: [g * 0.94, g * 0.98, g * 1.06], drag: 0.9, buoyancy: 0.25,
        });
      }
    }
    const u = ctx.uniforms;
    const d = ctx.systems.sky?.daylight ?? u.uDaylight.value ?? 1;
    const k = 0.18 + 0.82 * d;
    const sun = u.uSunColor.value;
    const sky = u.uSkyColor.value;
    const lr = (sun.r * 0.55 + sky.r * 0.6) * k;
    const lg = (sun.g * 0.55 + sky.g * 0.6) * k;
    const lb = (sun.b * 0.55 + sky.b * 0.6) * k;
    spray.material.uniforms.uLight.value.setRGB(lr * 1.1, lg * 1.1, lb * 1.1);
    smoke.material.uniforms.uLight.value.setRGB(lr, lg, lb);
    const wx = ctx.systems.sky?.weather;
    const wind = { x: Math.sin(wx?.windDir ?? 0) * (wx?.windSpeed ?? 0), z: -Math.cos(wx?.windDir ?? 0) * (wx?.windSpeed ?? 0) };
    seaFloor = att.heave - 0.15;
    spray.update(dt, { x: wind.x * 0.4, z: wind.z * 0.4 }, floorAtSkiff);
    smoke.update(dt, wind);
  }

  function updateLines() {
    const sn = seiner();
    group.updateMatrixWorld(true);
    const bitt = tmp.copy(model.points.bitt).applyMatrix4(group.matrixWorld);
    if (s.state === 'towingOff' && sn) {
      const p = sn.bittPoint ? sn.bittPoint(s.towSide, tmp2) : tmp2.copy(sn.position).setY(2);
      const sag = 1.4 * (1 - s.strain) + 0.08;
      line.set(bitt, p, sag, waterY);
      stake.visible = false;
    } else if (s.state === 'tied' && s.tiePoint) {
      const ty = Math.max(0.3, (ctx.systems.terrain?.heightAt?.(s.tiePoint.x, s.tiePoint.z) ?? ctx.heightmap.heightAt(s.tiePoint.x, s.tiePoint.z)) + 0.9);
      tiedPoint = tiedPoint ?? new THREE.Vector3();
      tiedPoint.set(s.tiePoint.x, ty, s.tiePoint.z);
      if (s.phase === 'tied') {
        line.set(bitt, tiedPoint, 0.6, waterY);
        stake.position.set(tiedPoint.x, ty - 0.35, tiedPoint.z);
        stake.visible = true;
      } else {
        line.hide();
        stake.visible = false;
      }
    } else {
      line.hide();
      stake.visible = false;
    }
  }

  const sys = {
    object3d: group,
    position: group.position,
    get heading() {
      return s.heading;
    },
    get state() {
      return s.state;
    },
    get busy() {
      return ctl.busy;
    },
    get effort() {
      return s.effort;
    },
    get strain() {
      return s.strain;
    },
    get speed() {
      return s.speed;
    },
    get towHeading() {
      return s.towHeading;
    },
    model,

    release() {
      env.seiner = seinerView();
      return ctl.release(env);
    },
    holdAt(x, z) {
      ctl.holdAt(x, z);
    },
    towToward(x, z, effort = 0.6) {
      ctl.towToward(x, z, effort);
    },
    tieOff(point) {
      env.seiner = seinerView();
      ctl.tieOff(xz(point), env);
    },
    closeTo(target, onArrive) {
      const sn = seiner();
      let follow = null;
      if (target && (target === sn?.object3d || target === sn)) {
        // Bring the end to the seiner's stern quarter on the net's side (where the bag lies), so the corkline closes
        // without wrapping the hull; the skiff goes round the seiner if it is on the other side. Without a net, the
        // quarter on the skiff's own side.
        const side = (() => {
          const rx = Math.cos(sn.heading);
          const rz = Math.sin(sn.heading);
          const net = ctx.systems.net;
          const bag = net?.state && net.state !== 'stowed' ? net.bagCentroid?.(bagPoint) : null;
          if (bag && Number.isFinite(bag.x) && Number.isFinite(bag.z)) {
            const lat = (bag.x - sn.position.x) * rx + (bag.z - sn.position.z) * rz;
            if (Math.abs(lat) > 1) return lat > 0 ? 1 : -1;
          }
          const body = net?.bodySide ?? net?.side;
          if (net?.state && net.state !== 'stowed' && (body === 1 || body === -1)) return body;
          return (s.x - sn.position.x) * rx + (s.z - sn.position.z) * rz >= 0 ? 1 : -1;
        })();
        const off = new THREE.Vector3(side * 4.6, 0, 6.5);
        follow = () => {
          const p = tmp2.copy(off).applyMatrix4(sn.object3d.matrixWorld);
          return { x: p.x, z: p.z };
        };
      } else if (target?.isObject3D) {
        follow = () => {
          target.getWorldPosition(tmp2);
          return { x: tmp2.x, z: tmp2.z };
        };
      } else if (target) {
        follow = xz(target);
      }
      ctl.closeTo(follow, onArrive);
    },
    towOff(sn = seiner(), side = 'port') {
      ctl.towOff(side, sn?.heading ?? seiner()?.heading ?? 0);
    },
    setTowHeading(h) {
      ctl.setTowHeading(h);
    },
    returnTo(onArrive) {
      ctl.returnTo(onArrive);
    },
    stow() {
      ctl.stow();
      line.hide();
      stake.visible = false;
      att.pitch = att.roll = att.pitchVel = att.rollVel = att.heaveVel = 0;
      sys.update(0);
    },
    ferry(from, to, onArrive) {
      env.seiner = seinerView();
      const f = from ? xz(from) : xz(seiner()?.position);
      ctl.ferry(f, xz(to), onArrive, env);
      att.heave = waterY(s.x, s.z);
    },
    // Where the seine attaches: the tie stake ashore when tied, else the skiff's stern at the waterline.
    endPoint(out = new THREE.Vector3()) {
      if (s.state === 'tied' && s.phase === 'tied' && s.tiePoint) return out.set(s.tiePoint.x, 0, s.tiePoint.z);
      group.updateMatrixWorld(true);
      return out.copy(model.points.netEnd).applyMatrix4(group.matrixWorld);
    },
    bittPoint: (out = new THREE.Vector3()) => out.copy(model.points.bitt).applyMatrix4(group.matrixWorld),
    // Passenger spot for the on-foot ferry.
    seatPoint: (out = new THREE.Vector3()) => out.copy(model.points.seat).applyMatrix4(group.matrixWorld),

    update(dt) {
      env.seiner = seinerView();
      if (dt > 0) ctl.step(dt, env);
      const inWater = s.state !== 'stowed' && s.state !== 'released' && !(s.state === 'returning' && s.phase === 'winch');
      // Tow the seiner off the net.
      const pull = ctl.towPull();
      if (pull) seiner()?.applyTow?.(pull.x, pull.z);

      if (s.state === 'stowed') {
        mountPose();
        group.position.copy(mountPos);
        group.quaternion.copy(mountQuat);
        att.heave = mountPos.y;
      } else if (s.state === 'released' || (s.state === 'returning' && s.phase === 'winch')) {
        mountPose();
        if (dt > 0) waterPose(dt, 0);
        const k = s.state === 'released' ? s.anim : 1 - s.anim;
        const e = k * k;
        const wy = waterY(s.x, s.z);
        group.position.set(s.x, mountPos.y + (wy - mountPos.y) * e, s.z);
        qB.setFromEuler(euler.set(att.pitch, -s.heading, -att.roll, 'YXZ'));
        qA.copy(mountQuat);
        group.quaternion.slerpQuaternions(qA, qB, clamp(k * 1.2, 0, 1));
        if (s.state === 'released') att.heave = group.position.y;
      } else {
        const squat = s.effort * (s.state === 'towing' || s.state === 'towingOff' ? 0.13 : 0.06) + Math.abs(s.speed) * 0.008;
        if (dt > 0) waterPose(dt, squat);
        applyWater();
      }
      group.updateMatrixWorld(true);
      if (model.crew) model.crew.pose(ctx.time.elapsed, 'helm', { brace: clamp(att.rollVel * 3, -1, 1), lookYaw: s.state === 'towingOff' ? 2.6 : 0 });
      if (dt > 0) updateFx(dt);
      updateLines();
      const night = clamp((0.5 - (ctx.systems.sky?.daylight ?? 1)) / 0.35, 0, 1);
      glow.night = night;
      glow.setOn(0, inWater);
    },

    frame() {
      const sc = projScale(ctx.renderer, ctx.camera);
      glow.scale = sc;
      spray.material.uniforms.uScale.value = sc;
      smoke.material.uniforms.uScale.value = sc;
    },

    debugState() {
      return {
        state: s.state,
        phase: s.phase,
        busy: ctl.busy,
        x: +s.x.toFixed(1),
        z: +s.z.toFixed(1),
        headingDeg: +(((s.heading * 180) / Math.PI + 360) % 360).toFixed(0),
        effort: +s.effort.toFixed(2),
        strain: +s.strain.toFixed(2),
      };
    },

    reset() {
      sys.stow();
      spray.clear();
      smoke.clear();
    },
  };
  sys.update(0);
  return sys;
}
