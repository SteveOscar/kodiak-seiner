// WP-BOATS: the player's seiner (SPEC §6.7). Helm, handling and mooring rules live in boats/seinerController.js
// (pure, unit-tested); this module wires input, water sampling, the procedural model, lights and effects.

import * as THREE from 'three';
import { createSeinerController } from './boats/seinerController.js';
import { SEINER_TUNING, waveAttitude } from './boats/handling.js';
import { buildSeinerModel } from './boats/seinerModel.js';
import { createParticlePool, createGlowSet, createLightPools, projScale } from './boats/fx.js';
import { setSeaPlane } from './boats/waterline.js';
import { createRope } from './boats/rope.js';
import { createDeckFloods } from './boats/floodLight.js';
import { crewMaterial } from './boats/crew.js';

const DEFAULT_NAME = 'Northern Dawn';
// Bow-wave foam stamps per side: [metres forward of amidships, offset outboard of the waterline, radius, strength].
const BOW_WAVE = [
  [7.2, 0.3, 0.9, 0.62],
  [5.4, 0.55, 1.1, 0.55],
  [2.8, 0.85, 1.3, 0.44],
  [-0.8, 1.3, 1.6, 0.32],
];
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export async function create(ctx) {
  const { scene, events, input, config } = ctx;
  const tuning = {
    ...SEINER_TUNING,
    length: config.boat.length ?? SEINER_TUNING.length,
    turnRate: config.boat.turnRate ?? SEINER_TUNING.turnRate,
    groundingDepth: config.boat.groundingDepth ?? SEINER_TUNING.groundingDepth,
    boundary: config.world.boundary ?? SEINER_TUNING.boundary,
  };
  const ctl = createSeinerController({ tuning, emit: (n, p) => events.emit(n, p) });
  const hull = ctl.hull;
  let boatName = DEFAULT_NAME;
  const model = buildSeinerModel(ctx, { name: boatName });
  const group = model.group;
  scene.add(group);

  // Deck floods (N): cone lights injected into the boat's own materials (see boats/floodLight.js) rather than scene
  // SpotLights, which every lit material in the world would pay for.
  const floods = createDeckFloods([
    { pos: [0, 9.75, 0.45], target: [0, 0.4, 7.2], angle: 1.0, range: 30 },
    { pos: [0, 5.95, -5.0], target: [0, 1.2, -13.5], angle: 0.85, range: 24 },
  ]);
  for (const m of [model.materials.paint, model.materials.rough, model.materials.metal, model.materials.hull, model.materials.deck, model.pileMaterial, crewMaterial()]) {
    floods.patch(m);
  }

  const glows = createGlowSet(ctx, model.lightDefs, { parent: group, name: 'seiner-lights' });
  const lightIndex = Object.fromEntries(model.lightDefs.map((l, i) => [l.id, i]));
  const smoke = createParticlePool(ctx, { max: 160, renderOrder: 201, name: 'seiner-exhaust', nearFade: [2, 8] });
  const spray = createParticlePool(ctx, { max: 420, renderOrder: 202, name: 'seiner-spray' });
  const pool = createLightPools(ctx, 1, { name: 'seiner-light-pool' });
  const rode = createRope(ctx, { segments: 12, sides: 5, radius: 0.035, color: '#3b3632', name: 'anchor-rode' });
  const rodeFrom = new THREE.Vector3();
  const rodeTo = new THREE.Vector3();

  ctx.systems.water?.addOccluder?.(model.occluder);

  const velocity = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const sample = { height: 0, normal: new THREE.Vector3(0, 1, 0) };
  const wave = { heave: 0, pitch: 0, roll: 0 };
  const current = { x: 0, z: 0 };
  const wind = { x: 0, z: 0 };
  let autopilot = null;
  let rippleTimer = 0;
  let boundaryToastAt = -1e9;
  let prevLever = 0;
  let smokeAcc = 0;
  let sprayAcc = 0;
  let night = 0;
  let pileLevel = 1;
  let sheaveAngle = 0;
  let deckLights = false;
  let lastEnv = null;
  let seaFloor = 0;
  const floorAtHull = () => seaFloor;

  const water = () => ctx.systems.water;
  const waterY = (x, z) => water()?.heightAt?.(x, z) ?? 0;

  function sampleHeight(x, z) {
    const w = water();
    if (w?.sample) {
      const s = w.sample(x, z, sample);
      return Number.isFinite(s?.height) ? s.height : 0;
    }
    return w?.heightAt?.(x, z) ?? 0;
  }

  const local = (v, out) => out.copy(v).applyMatrix4(group.matrixWorld);
  // Waterline half-beam d metres forward of amidships (bow-wave foam and spray hug the actual hull).
  const wlHalf = (d) => model.form.halfWidthAt(clamp(0.5 - d / model.form.L, 0, 1), 0.15);

  function applyPose() {
    // Loaded down a little below the design waterline, squatting at speed.
    const sq = 0.14 + 0.1 * (hull.speed / 12) ** 2;
    group.position.set(hull.x, hull.heave - sq, hull.z);
    group.rotation.set(hull.pitch, -hull.heading, -hull.roll, 'YXZ');
    group.updateMatrixWorld(true);
  }

  function obstacles() {
    const f = ctx.systems.fleet;
    if (f?.obstacles) return f.obstacles();
    return (f?.tenders ?? []).map((t) => ({
      id: t.id,
      x: t.position?.x ?? 0,
      z: t.position?.z ?? 0,
      heading: t.heading ?? 0,
      halfLength: 0,
      radius: t.radius ?? 12,
    }));
  }

  // Which navigation lights a vessel in this state shows (COLREGS: underway, at anchor, engaged in fishing).
  function updateLights(dt) {
    const sky = ctx.systems.sky;
    const daylight = sky?.daylight ?? ctx.uniforms.uDaylight.value ?? 1;
    const vis = sky?.weather?.visibility ?? 20000;
    const haze = clamp((3000 - vis) / 2500, 0, 1);
    const target = Math.max(clamp((0.5 - daylight) / 0.35, 0, 1), haze * 0.7);
    night += (target - night) * Math.min(1, dt * 2 + 0.02);
    const moored = !!ctl.mooring;
    const netOut = (ctx.systems.net?.state ?? 'stowed') !== 'stowed';
    const fishing = netOut || !['idle', 'report', undefined].includes(ctx.systems.fishing?.state);
    const underway = !moored;
    glows.setOn(lightIndex.port, underway);
    glows.setOn(lightIndex.starboard, underway);
    glows.setOn(lightIndex.stern, underway);
    glows.setOn(lightIndex.masthead, underway && !fishing);
    glows.setOn(lightIndex.anchor, moored);
    glows.setOn(lightIndex.fishRed, fishing);
    glows.setOn(lightIndex.fishWhite, fishing);
    for (const id of ['floodP', 'floodS', 'floodHP', 'floodHS']) glows.setOn(lightIndex[id], deckLights);
    glows.night = Math.max(night, deckLights ? 0.25 : 0);
    const fitted = ctx.systems.economy?.modifiers?.deckLights !== false;
    const floodI = deckLights ? (fitted ? 1 : 0.55) * (0.35 + 0.65 * night) : 0;
    floods.update(group, floodI * 9);
    // The floods spill onto the water around the hull.
    pool.night = floodI > 0 ? night : 0;
    if (floodI > 0 && night > 0.02) {
      const px = hull.x - Math.sin(hull.heading) * 2.5;
      const pz = hull.z + Math.cos(hull.heading) * 2.5;
      pool.set(0, px, waterY(px, pz) + 0.3, pz, 15, true, 0.5 * floodI);
    } else pool.set(0, 0, 0, 0, 0, false);
    pool.commit();
    const m = model.materials;
    // Lenses read as coloured glass by day and go dim at night: the glow sprites show which lights are actually lit,
    // so an unlit anchor or fishing light does not shine from the mast.
    m.lamp.color.setScalar(0.9 - 0.72 * night);
    const dark = clamp((0.32 - daylight) / 0.25, 0, 1);
    m.glass.emissiveIntensity = dark * (deckLights ? 0.45 : 0.22);
    m.glassCabin.emissiveIntensity = dark * 1.7;
  }

  function updateCrew(t, dt) {
    const net = ctx.systems.net?.state ?? 'stowed';
    const fs = ctx.systems.fishing?.state ?? 'idle';
    const skiffState = ctx.systems.skiff?.state ?? 'stowed';
    const [a, b] = model.crew;
    let actA = 'idle';
    let actB = 'idle';
    let lookA = 0;
    let lookB = 0;
    if (net === 'paying' || net === 'out' || fs === 'setting' || fs === 'holding') {
      actA = 'watch';
      actB = 'watch';
      lookB = 1.2;
    } else if (net === 'closed' || net === 'pursing' || fs === 'closing' || fs === 'pursing') {
      actA = 'watch';
      actB = 'winch';
    } else if (net === 'hauling' || fs === 'hauling') {
      actA = 'stack';
      actB = 'haul';
    } else if (net === 'brailing' || fs === 'brailing') {
      actA = 'watch';
      actB = 'coil';
    } else if (skiffState === 'returning') {
      actA = 'watch';
    } else if (ctl.mooring) {
      actA = Math.sin(t * 0.05) > 0.3 ? 'coil' : 'idle';
    } else {
      actA = Math.sin(t * 0.07 + 1) > 0.5 ? 'coil' : 'idle';
      lookB = Math.sin(t * 0.11) * 0.8;
    }
    const brace = clamp(hull.rollVel * 2, -1, 1);
    a.pose(t, actA, { brace, lookYaw: lookA });
    b.pose(t, actB, { brace, lookYaw: lookB });
    b.mesh.rotation.y = actB === 'haul' || actB === 'winch' ? Math.PI : Math.PI / 2;
  }

  function updatePileAndBlock(dt) {
    const net = ctx.systems.net;
    const st = net?.state ?? 'stowed';
    const len = net?.length || 1;
    const norm = (v) => (v > 1.5 ? v / len : v);
    let remaining = 1;
    if (st === 'paying' || st === 'out' || st === 'closed' || st === 'pursing') remaining = 1 - clamp(norm(net?.payout ?? 0), 0, 1);
    else if (st === 'hauling') remaining = clamp(norm(net?.hauled ?? 0), 0, 1);
    pileLevel += (remaining - pileLevel) * Math.min(1, dt * 1.5);
    model.pile.scale.y = 0.1 + 0.9 * pileLevel;
    model.pile.visible = pileLevel > 0.02 || st === 'stowed';
    if (st === 'hauling') sheaveAngle -= dt * (2.2 + (ctx.input.action?.('interact') ? 1.5 : 0));
    const sheave = model.block.userData.sheave;
    if (sheave) sheave.rotation.x = sheaveAngle;
    const swing = Math.sin(ctx.time.elapsed * 0.9) * 0.04;
    model.block.rotation.set(-hull.pitch * 0.85 + swing, 0, hull.roll * 0.85 + swing * 0.5);
  }

  function updateFlags() {
    const wx = wind.x - velocity.x;
    const wz = wind.z - velocity.z;
    const h = hull.heading;
    const lx = wx * Math.cos(h) + wz * Math.sin(h);
    const lz = -wx * Math.sin(h) + wz * Math.cos(h);
    const psi = Math.atan2(-lz, lx);
    for (const f of model.flags) f.rotation.y = psi;
    model.flagMaterial.userData.uniforms.uFlagWind.value = Math.hypot(wx, wz);
  }

  function lightFactor() {
    const u = ctx.uniforms;
    const d = ctx.systems.sky?.daylight ?? u.uDaylight.value ?? 1;
    const sun = u.uSunColor.value;
    const sky = u.uSkyColor.value;
    const k = 0.18 + 0.82 * d;
    return [(sun.r * 0.55 + sky.r * 0.6) * k, (sun.g * 0.55 + sky.g * 0.6) * k, (sun.b * 0.55 + sky.b * 0.6) * k];
  }

  function updateFx(dt) {
    const w = water();
    const speed = hull.speed;
    const aspeed = Math.abs(speed);
    const load = hull.engineLoad;
    const fwd = sys.forward(tmp);
    const rx = Math.cos(hull.heading);
    const rz = Math.sin(hull.heading);
    const stern = local(model.points.stern, tmp2);
    const L = tuning.length;

    // Wake: churned prop wash astern that lingers as a trail, the bow wave along the hull, and rings from the stem.
    // The Kelvin V itself comes from the water's wake simulation, forced by these moving stamps (WP-OCEAN).
    if (w?.stamp) {
      if (aspeed > 0.4 || load > 0.15) {
        // Foam is a level that maps to coverage (~0.6 reads as solid), so the prop wash stays lacy: a jittered core
        // that boils right under the transom, and wider, weaker stamps further aft so the trail spreads as it ages.
        const s = clamp(0.12 + clamp(aspeed / 12, 0, 1) * 0.32 + load * 0.12, 0, 0.58) * (0.85 + Math.random() * 0.3);
        const jx = (Math.random() - 0.5) * 1.1;
        w.stamp(stern.x + rx * jx, stern.z + rz * jx, 1.5 + aspeed * 0.07, s, 'foam');
        if (speed > 1.5) {
          const jy = (Math.random() - 0.5) * 2.2;
          w.stamp(stern.x - fwd.x * 9 + rx * jy, stern.z - fwd.z * 9 + rz * jy, 2.4 + aspeed * 0.12, s * 0.62, 'foam');
          w.stamp(stern.x - fwd.x * 20, stern.z - fwd.z * 20, 3.2 + aspeed * 0.15, s * 0.34, 'foam');
        }
        // Backing down: prop wash boils forward along the quarters.
        if (ctl.lever < -0.1 && load > 0.08) {
          for (const d of [0, 4.5]) w.stamp(stern.x + fwd.x * d, stern.z + fwd.z * d, 3.2, clamp(load * 1.1, 0, 0.9), 'foam');
        }
      }
      // Bow wave: white water climbing the flare and rolling aft along the waterline ("a bone in her teeth").
      const kb = clamp((speed - 2.5) / 8, 0, 1);
      if (kb > 0.02) {
        for (const side of [-1, 1]) {
          for (const [d, off, r0, k] of BOW_WAVE) {
            const lat = wlHalf(d) + off;
            const j = 0.85 + Math.random() * 0.3;
            w.stamp(hull.x + fwd.x * d + rx * side * lat, hull.z + fwd.z * d + rz * side * lat, r0 + aspeed * 0.04, kb * k * j, 'foam');
          }
        }
      }
      rippleTimer -= dt;
      if (aspeed > 3 && rippleTimer <= 0) {
        rippleTimer = 0.55;
        w.stamp(hull.x + fwd.x * L * 0.46, hull.z + fwd.z * L * 0.46, 3, clamp(aspeed / 12, 0.2, 0.8), 'ripple');
      }
    }

    // Bow spray: steady sheets at speed, bursts when the bow slams into a sea.
    const slam = Math.max(0, -hull.pitchVel - 0.04) * 6 + Math.max(0, wave.heave - hull.heave) * 0.8;
    const rate = speed > 3 ? (speed - 3) * 12 * (0.6 + slam * 2) : 0;
    sprayAcc += rate * dt;
    const lf = lightFactor();
    const sprayCol = [0.96, 0.98, 1.0];
    while (sprayAcc >= 1) {
      sprayAcc -= 1;
      const side = Math.random() < 0.5 ? -1 : 1;
      // Sheets peel off the flare where the bow wave climbs the hull.
      const d = 4.4 + Math.random() * 3.0;
      const lat = wlHalf(d) + 0.1 + Math.random() * 0.25;
      const bx = hull.x + fwd.x * d + rx * side * lat;
      const bz = hull.z + fwd.z * d + rz * side * lat;
      const up = 1.5 + Math.random() * 2.6 + slam * 4;
      const out = 2.4 + Math.random() * 2.8 + slam * 2;
      spray.emit({
        x: bx,
        y: waterY(bx, bz) + 0.2 + Math.random() * 0.4,
        z: bz,
        vx: velocity.x * 0.88 + rx * side * out,
        vy: up,
        vz: velocity.z * 0.88 + rz * side * out,
        life: 0.7 + Math.random() * 0.7,
        size0: 0.3 + Math.random() * 0.25,
        size1: 1.1 + Math.random() * 0.9 + slam,
        alpha: 0.5 + Math.random() * 0.3,
        color: sprayCol,
        drag: 0.9,
        gravity: 9.0,
      });
      // Fine droplets thrown higher and further than the mist, for sparkle.
      if (Math.random() < 0.6) {
        spray.emit({
          x: bx,
          y: waterY(bx, bz) + 0.3,
          z: bz,
          vx: velocity.x * 0.85 + rx * side * out * 1.3,
          vy: up * 1.25,
          vz: velocity.z * 0.85 + rz * side * out * 1.3,
          life: 0.6 + Math.random() * 0.5,
          size0: 0.12 + Math.random() * 0.08,
          size1: 0.2 + Math.random() * 0.12,
          alpha: 0.9,
          color: sprayCol,
          drag: 0.4,
          gravity: 9.8,
        });
      }
    }
    if (slam > 0.3 && speed > 7 && Math.random() < dt * 4) {
      for (let i = 0; i < 24; i++) {
        const side = i % 2 ? -1 : 1;
        const bx = hull.x + fwd.x * L * 0.42 + rx * side * Math.random() * 2;
        const bz = hull.z + fwd.z * L * 0.42 + rz * side * Math.random() * 2;
        spray.emit({
          x: bx, y: waterY(bx, bz) + 0.8, z: bz,
          vx: velocity.x + rx * side * (2 + Math.random() * 4), vy: 4 + Math.random() * 4, vz: velocity.z + rz * side * (2 + Math.random() * 4),
          life: 1.2 + Math.random() * 0.8, size0: 0.6, size1: 2.6 + Math.random() * 1.5, alpha: 0.5, color: sprayCol, drag: 1.1, gravity: 8,
        });
      }
    }
    spray.material.uniforms.uLight.value.setRGB(lf[0] * 1.3 + 0.03, lf[1] * 1.3 + 0.03, lf[2] * 1.3 + 0.035);
    // Falling spray dies at the local sea level (one sample at the hull, not one per particle).
    seaFloor = hull.heave - 0.15;
    spray.update(dt, { x: wind.x * 0.4, z: wind.z * 0.4 }, floorAtHull);

    // Exhaust: a faint haze at idle, thicker with load, sooty puffs when the throttle is opened.
    const running = !(ctl.mooring?.kind === 'dock');
    const opening = Math.max(0, ctl.lever - prevLever) / Math.max(dt, 1e-3);
    prevLever = ctl.lever;
    const top = local(model.points.stackTop, tmp2);
    smokeAcc += (running ? 2.5 + load * 10 : 0) * dt;
    const puffs = opening > 0.25 ? Math.min(3, Math.ceil(opening * 1.5)) : 0;
    // Diesel exhaust: sooty grey-brown puffs when the throttle opens, a thin blue-grey haze otherwise.
    const emitSmoke = (dark) => {
      const g = dark ? 0.13 + Math.random() * 0.06 : 0.42 + Math.random() * 0.1;
      smoke.emit({
        x: top.x + (Math.random() - 0.5) * 0.1,
        y: top.y,
        z: top.z + (Math.random() - 0.5) * 0.1,
        vx: velocity.x + (Math.random() - 0.5) * 0.5,
        vy: 1.6 + load * 2.2 + Math.random() * 0.8,
        vz: velocity.z + (Math.random() - 0.5) * 0.5,
        life: dark ? 2.6 + Math.random() * 1.2 : 1.8 + Math.random() * 1.0,
        size0: dark ? 0.35 : 0.28,
        size1: dark ? 2.2 + Math.random() * 1.0 : 1.4 + load * 1.1,
        alpha: dark ? 0.2 + Math.random() * 0.06 : 0.05 + load * 0.08,
        color: [g * 1.02, g, g * 0.96],
        drag: 0.75,
        buoyancy: 0.3,
      });
    };
    for (let i = 0; i < puffs; i++) emitSmoke(true);
    while (smokeAcc >= 1) {
      smokeAcc -= 1;
      emitSmoke(load > 0.85 && Math.random() < 0.06);
    }
    smoke.material.uniforms.uLight.value.setRGB(lf[0], lf[1], lf[2]);
    smoke.update(dt, wind);
  }

  const sys = {
    object3d: group,
    position: group.position,
    velocity,
    baseMaxSpeed: config.boat.maxSpeed,
    get heading() {
      return hull.heading;
    },
    set heading(h) {
      hull.heading = h;
    },
    get speed() {
      return hull.speed;
    },
    get throttle() {
      return ctl.lever;
    },
    get rudder() {
      return hull.rudder;
    },
    get maxSpeed() {
      return ctx.systems.economy?.modifiers?.maxSpeed ?? sys.baseMaxSpeed;
    },
    get speedLimit() {
      return ctl.speedLimit;
    },
    get controlsEnabled() {
      return ctl.controlsEnabled;
    },
    get grounded() {
      return hull.grounded;
    },
    get engineLoad() {
      return hull.engineLoad;
    },
    get mooring() {
      return ctl.mooring;
    },
    get anchored() {
      return ctl.anchored;
    },
    get deckLights() {
      return deckLights;
    },
    set deckLights(v) {
      deckLights = !!v;
    },
    get boatName() {
      return boatName;
    },
    get pitch() {
      return hull.pitch;
    },
    get roll() {
      return hull.roll;
    },
    get bump() {
      return hull.bump;
    },
    get anchorPoint() {
      return ctl.anchorPoint;
    },
    model,

    forward: (out = new THREE.Vector3()) => out.set(Math.sin(hull.heading), 0, -Math.cos(hull.heading)),
    sternPoint: (out = new THREE.Vector3()) => local(model.points.stern, out),
    bowPoint: (out = new THREE.Vector3()) => local(model.points.bow, out),
    powerBlockPoint(out = new THREE.Vector3()) {
      model.block.updateMatrixWorld(true);
      return out.set(0, -0.98, 0.02).applyMatrix4(model.block.matrixWorld);
    },
    skiffMountPoint: (out = new THREE.Vector3()) => model.skiffMount.getWorldPosition(out),
    // Where the skiff's towline makes fast ('port' | 'starboard').
    bittPoint: (side = 'port', out = new THREE.Vector3()) => local(side === 'starboard' ? model.points.bittStarboard : model.points.bittPort, out),
    // Helmsman's eye on the flying bridge (bridge camera, binoculars).
    eyePoint: (out = new THREE.Vector3()) => local(model.points.eye, out),

    setPose(x, z, heading = hull.heading) {
      ctl.setPose(x, z, heading);
      hull.heave = waterY(x, z);
      velocity.set(0, 0, 0);
      smoke.clear();
      spray.clear();
      applyPose();
    },
    setSpeedLimit: (owner, mps) => ctl.setSpeedLimit(owner, mps),
    lockControls: (owner, locked) => ctl.lockControls(owner, locked),
    setMooring: (m) => ctl.setMooring(m),
    setBoatName(n) {
      const next = String(n ?? '').trim().slice(0, 24) || DEFAULT_NAME;
      if (next === boatName) return;
      boatName = next;
      model.setName(boatName);
    },
    horn() {
      events.emit('boat:horn', {});
    },
    // Lets materials riding on or near the boat (the skiff) receive the deck floods.
    floodPatch: (material) => floods.patch(material),
    // Skiff pulling the seiner off the net (m/s, world); applied on the next step.
    applyTow: (vx, vz) => ctl.applyTow(vx, vz),
    // Title-mode autopilot (cleared automatically outside the title).
    setAutopilot(ap) {
      autopilot = ap ? { heading: ap.heading ?? hull.heading, throttle: ap.throttle ?? 0.4 } : null;
    },

    update(dt) {
      if (!(dt > 0)) return;
      const mode = ctx.state.mode;
      if (mode !== 'title') autopilot = null;
      const allowed = mode === 'play' && ctx.state.control === 'boat' && ctl.controlsEnabled;
      if (allowed) {
        if (input.pressed('horn')) sys.horn();
        if (input.pressed('lights')) deckLights = !deckLights;
      }
      const pad = input.pad ? -input.pad.ly + input.pad.rt - input.pad.lt : 0;
      ctl.helm({
        up: input.action('throttleUp'),
        down: input.action('throttleDown'),
        upPressed: input.pressed('throttleUp'),
        downPressed: input.pressed('throttleDown'),
        pad,
        allowed: allowed && !autopilot,
        dt,
      });

      ctx.tide?.currentAt?.(hull.x, hull.z, current);
      const wx = ctx.systems.sky?.weather;
      const ws = wx?.windSpeed ?? 0;
      wind.x = Math.sin(wx?.windDir ?? 0) * ws;
      wind.z = -Math.cos(wx?.windDir ?? 0) * ws;

      // Buoyancy: fit the sea surface under bow, stern, both sides and the middle.
      const f = sys.forward(tmp);
      const rx = Math.cos(hull.heading);
      const rz = Math.sin(hull.heading);
      const hl = tuning.length * 0.42;
      const hb = tuning.beam * 0.45;
      const hBow = sampleHeight(hull.x + f.x * hl, hull.z + f.z * hl);
      const hStern = sampleHeight(hull.x - f.x * hl, hull.z - f.z * hl);
      const hPort = sampleHeight(hull.x - rx * hb, hull.z - rz * hb);
      const hStb = sampleHeight(hull.x + rx * hb, hull.z + rz * hb);
      const hMid = sampleHeight(hull.x, hull.z);
      waveAttitude(hBow, hStern, hPort, hStb, hMid, tuning.length * 0.84, tuning.beam * 0.9, wave);
      setSeaPlane(model.hullSea, hull.x, hull.z, hMid, (hBow - hStern) / (2 * hl), (hStb - hPort) / (2 * hb), hull.heading, true);
      setSeaPlane(model.materials.sea, hull.x, hull.z, hMid, 0, 0, 0, false);
      lastEnv = {
        current,
        wind,
        wave,
        depthAt: ctx.heightmap.depthAt,
        shoreGradient: ctx.heightmap.shoreGradient,
        obstacles: obstacles(),
      };
      ctl.step(dt, lastEnv, {
        allowed,
        steer: allowed ? input.axis('steer') : 0,
        maxSpeed: sys.maxSpeed,
        reverseSpeed: config.boat.reverseSpeed ?? 3,
        autopilot,
      });
      velocity.set(hull.vx, 0, hull.vz);

      if (hull.beyondBoundary && mode === 'play' && ctx.time.elapsed - boundaryToastAt > 12) {
        boundaryToastAt = ctx.time.elapsed;
        ctx.systems.ui?.toast?.('Edge of the chart — the boat is turning back.', { kind: 'warn', duration: 4 });
      }

      applyPose();
      // Anchor chain from the bow roller down into the water toward the anchor.
      const ap = ctl.mooring?.kind === 'anchor' ? ctl.anchorPoint : null;
      if (ap) {
        local(model.points.anchorRoller, rodeFrom);
        rodeTo.set(ap.x, -3.5, ap.z);
        rode.set(rodeFrom, rodeTo, 0.6);
      } else rode.hide();
      const t = ctx.time.elapsed;
      model.radar.rotation.y = -t * 2.5;
      updateLights(dt);
      updateCrew(t, dt);
      updatePileAndBlock(dt);
      updateFlags();
      updateFx(dt);
      group.updateMatrixWorld(true);
    },

    frame(realDt) {
      // Keep lights/particles sized for the live camera (binoculars change the fov).
      const s = projScale(ctx.renderer, ctx.camera);
      glows.scale = s;
      smoke.material.uniforms.uScale.value = s;
      spray.material.uniforms.uScale.value = s;
      if (ctx.state.mode !== 'play' && ctx.state.mode !== 'title' && ctx.state.mode !== 'cutscene') updateLights(realDt);
    },

    debugState() {
      return {
        x: +hull.x.toFixed(1),
        z: +hull.z.toFixed(1),
        headingDeg: +(((hull.heading * 180) / Math.PI + 360) % 360).toFixed(1),
        speed: +hull.speed.toFixed(2),
        throttle: +ctl.lever.toFixed(2),
        rudder: +hull.rudder.toFixed(2),
        engineLoad: +hull.engineLoad.toFixed(2),
        roll: +((hull.roll * 180) / Math.PI).toFixed(1),
        pitch: +((hull.pitch * 180) / Math.PI).toFixed(1),
        mooring: ctl.mooring,
        grounded: hull.grounded,
        speedLimit: ctl.speedLimit,
        limitOwners: ctl.limitOwners(),
        lockOwners: ctl.lockOwners(),
        deckLights,
        name: boatName,
        particles: smoke.count + spray.count,
      };
    },

    serialize() {
      return { x: +hull.x.toFixed(2), z: +hull.z.toFixed(2), heading: +hull.heading.toFixed(4), name: boatName, mooring: ctl.mooring, deckLights };
    },

    restore(d) {
      if (!d || typeof d !== 'object') return;
      if (Number.isFinite(d.x) && Number.isFinite(d.z)) sys.setPose(d.x, d.z, Number.isFinite(d.heading) ? d.heading : hull.heading);
      if (d.name) sys.setBoatName(d.name);
      ctl.setMooring(d.mooring ?? null);
      deckLights = !!d.deckLights;
    },

    // New season: clears limits, locks and mooring; keeps the boat's name (chosen on the title screen).
    reset() {
      const wasMoored = !!ctl.mooring;
      ctl.reset();
      if (wasMoored) events.emit('boat:mooring', { mooring: null });
      deckLights = false;
      autopilot = null;
      smoke.clear();
      spray.clear();
      pileLevel = 1;
    },
  };

  sys.setPose(hull.x, hull.z, hull.heading);
  return sys;
}
