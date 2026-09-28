// WP-FOOT: going ashore and walking Kodiak on foot (SPEC §6.14).
//
//   aboard     inactive; offers "E — Go ashore" (priority 40) when the seiner is nearly stopped within ~150 m of a
//              walkable beach, fishing is idle and the skiff is stowed
//   launch     cutscene: the deckhand steps into the skiff on the ramp, the skiff drops off the stern
//   ferry      cutscene: the skiff runs the deckhand to the beach (long runs cut through a short fade)
//   disembark  cutscene: forward to the bow, hop off into the shallows
//   foot       play: WASD relative to the camera, Shift run, Space jump; slope rules, wading to knee depth; the
//              skiff waits nosed into the beach; "E — Back to the boat" near it
//   embark     cutscene: back aboard the skiff over the bow
//   return     cutscene: the skiff runs back and winches up the ramp; control returns to the boat
//   retreat    cutscene after a bear's bluff charge: fade, back at the skiff landing, a radio quip
//
// Only this system writes ctx.state.control (emits player:mode). The seiner is anchored (unless already moored) and
// locked (owner 'player') while the deckhand is away. Pure rules live in player/rules.js and player/controller.js,
// animation in player/anim.js, the figure in player/model.js.

import * as THREE from 'three';
import { FOOT_RULES, findLanding, stepOffPoint, dryPointAhead, perchPoint, onSummit, isHilltop, slopeBand } from './player/rules.js';
import { FOOT_TUNING, createFootState, placeFoot, stepFoot, standable } from './player/controller.js';
import { createAnimator, createPose, animate } from './player/anim.js';
import { buildDeckhand } from './player/model.js';
import { createFader } from './player/fader.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrap = (a) => {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
};
const headingOf = (dx, dz) => Math.atan2(dx, -dz);

const TUNE = Object.freeze({
  stoppedSpeed: 0.8, // m/s: "nearly stopped"
  boardRadius: 4.2, // metres from the skiff's bow (or 5.5 from its middle) to offer "Back to the boat"
  cutDistance: 70, // skiff runs longer than this are cut short behind a fade
  cutAfter: 3.2, // seconds of the run shown before the cut
  cutApproach: 30, // metres out from the destination where the run resumes after the cut
  asternOffset: 7, // metres astern of the seiner's stern where the returning skiff lines up with the ramp
  searchEvery: 1.2, // seconds between landing searches while the boat drifts (~1 ms each; 4x longer at rest)
  searchMove: 6, // or when the boat has moved this far
  perchEvery: 0.5,
  summitIdle: 2.5, // seconds standing still on a hilltop before the summit framing is suggested
});

const FRAMING = Object.freeze({
  ferry: Object.freeze({ kind: 'ferry', dist: 12, pitch: 0.32 }),
  board: Object.freeze({ kind: 'board', dist: 8, pitch: 0.3 }),
  summit: Object.freeze({ kind: 'summit', dist: 9, pitch: 0.16 }),
});

const QUIPS = [
  "Easy — easy. She's just bluffing. Come on back to the skiff, nice and slow.",
  "Saw that from the skiff. That sow means it. Let's give her the beach for a while.",
  'You okay? She came out of the alders like a freight train. Stay near the water a bit.',
  "Whoa. That's close enough for one day. Bears own this beach — we're just visiting.",
  "Heart still going? Mine isn't. Next time we sing on the way through the brush.",
];

export async function create(ctx) {
  const { scene, events, input, interact, camera } = ctx;
  const rng = ctx.rng.fork('player');
  const quipRng = rng.fork('quips');
  const figure = buildDeckhand(ctx);
  const group = figure.group;
  group.visible = false;
  scene.add(group);
  const fader = createFader(ctx);

  const pose = createPose();
  const anim = createAnimator(rng.next());
  const foot = createFootState(0, 0, 0);
  const position = group.position;
  const velocity = new THREE.Vector3();

  // Blend between wet and dry for the shared underwater tint: off while standing on the skiff's sole (below the
  // waterline inside the hull), on when wading.
  const uUnderwaterAmt = { value: 1 };
  {
    const prev = figure.material.onBeforeCompile;
    figure.material.onBeforeCompile = (shader, renderer) => {
      prev?.call(figure.material, shader, renderer);
      shader.uniforms.uUnderwaterAmt = uUnderwaterAmt;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uUnderwaterAmt;')
        .replace('#include <kodiak_underwater_fragment>', 'vec3 kDry = gl_FragColor.rgb;\n#include <kodiak_underwater_fragment>\ngl_FragColor.rgb = mix( kDry, gl_FragColor.rgb, uUnderwaterAmt );');
    };
  }

  const tmpV = new THREE.Vector3();
  const tmpV2 = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();
  const upAxis = new THREE.Vector3(0, 1, 0);
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');

  const seiner = () => ctx.systems.seiner;
  const skiff = () => ctx.systems.skiff;
  const ui = () => ctx.systems.ui;
  const terrainH = (x, z) => {
    const t = ctx.systems.terrain?.heightAt;
    const h = t ? t(x, z) : ctx.heightmap.heightAt(x, z);
    return Number.isFinite(h) ? h : ctx.heightmap.heightAt(x, z);
  };
  const coarseH = (x, z) => ctx.heightmap.heightAt(x, z);

  let phase = 'aboard';
  let active = false;
  let ownsCutscene = false;
  let phaseT = 0;
  let landing = null; // { x, z, y, shoreX, shoreZ, heading, placeId, ... } of the current trip
  let ferry = null; // { cut: bool, cutDone, t, onArrive }
  let script = null; // scripted walk/hop sequence during disembark/embark
  let ride = false; // riding in the skiff (root follows the seat)
  let rideLocal = new THREE.Vector3();
  let snapCamera = false;
  let lastStepCount = 0;
  let watch = null; // { bearId, x, z, until }
  let perchTimer = 0;
  const perchDone = new Map(); // placeId -> day
  let summits = null;
  let boundaryToastAt = -1e9;
  let boardOffer = false;
  let onTop = false; // standing on a local high point (a summit or ridge top with a view)
  let idleT = 0;

  // ---------------------------------------------------------------- landing search (cached)
  const search = { x: NaN, z: NaN, t: -1e9, result: { ok: false, reason: 'none' } };
  let exclusions = null;
  function excludeFn() {
    if (!exclusions) {
      const list = [];
      for (const p of ctx.systems.places?.list ?? []) if (p.memorial && Number.isFinite(p.x)) list.push({ x: p.x, z: p.z, r: Math.max(120, p.radius ?? 0) });
      for (const c of ctx.systems.places?.closedAreas ?? []) if (Number.isFinite(c.x)) list.push({ x: c.x, z: c.z, r: c.radius ?? 300 });
      exclusions = list;
    }
    return (x, z) => exclusions.some((e) => (e.x - x) ** 2 + (e.z - z) ** 2 < e.r * e.r);
  }

  function nearOnFootPlace(x, z) {
    let best = null;
    let bd = Infinity;
    for (const p of ctx.systems.places?.list ?? []) {
      if (!p.onFoot || p.memorial || !Number.isFinite(p.x)) continue;
      const l = p.landing ?? p;
      const d = Math.min(Math.hypot(l.x - x, l.z - z), Math.hypot(p.x - x, p.z - z) - (p.radius ?? 0));
      if (d < 260 && d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  }

  function runSearch(x, z) {
    const surfaceAt = ctx.systems.terrain?.surfaceAt;
    const res = findLanding(x, z, {
      heightAt: coarseH,
      shoreDistance: ctx.heightmap.shoreDistance,
      exclude: excludeFn(),
      surfaceAt: surfaceAt ? (px, pz) => surfaceAt(px, pz) : null,
    });
    if (res.ok) {
      const l = res.landing;
      l.y = terrainH(l.x, l.z);
      const place = nearOnFootPlace(l.x, l.z);
      l.placeId = place?.id ?? null;
      l.placeName = place?.name ?? null;
    }
    return res;
  }

  function landingNear(x, z, now) {
    const moved = Math.hypot(x - search.x, z - search.z);
    if (!(moved < TUNE.searchMove) || now - search.t > TUNE.searchEvery * (moved < 1 ? 4 : 1)) {
      search.x = x;
      search.z = z;
      search.t = now;
      search.result = runSearch(x, z);
    }
    return search.result;
  }

  function canGoAshore() {
    const s = seiner();
    if (active || ctx.state.control !== 'boat') return { ok: false, reason: 'Already ashore', landing: null };
    if (!s?.position) return { ok: false, reason: 'No boat', landing: null };
    if (Math.abs(s.speed ?? 0) > TUNE.stoppedSpeed) return { ok: false, reason: 'Slow down to go ashore', landing: null };
    const f = ctx.systems.fishing?.state ?? 'idle';
    if (f !== 'idle') return { ok: false, reason: 'Finish the set first', landing: null };
    const sk = skiff();
    if (sk && (sk.state ?? 'stowed') !== 'stowed') return { ok: false, reason: 'The skiff is out', landing: null };
    const r = landingNear(s.position.x, s.position.z, ctx.time.elapsed);
    if (!r.ok) {
      const reason = r.reason === 'steep' ? 'Too steep to land here' : r.reason === 'excluded' ? 'No landing here' : 'No beach within reach';
      return { ok: false, reason, landing: null };
    }
    return { ok: true, reason: null, landing: r.landing };
  }

  // ---------------------------------------------------------------- mode helpers
  function enterCutscene() {
    if (ctx.state.mode === 'play' || ctx.state.mode === 'cutscene') {
      ownsCutscene = true;
      if (ctx.state.mode !== 'cutscene') ctx.game?.setMode?.('cutscene');
    }
  }
  function leaveCutscene() {
    if (ownsCutscene && ctx.state.mode === 'cutscene') ctx.game?.setMode?.('play');
    ownsCutscene = false;
  }
  function setControl(control) {
    if (ctx.state.control === control) return;
    ctx.state.control = control;
    events.emit('player:mode', { control });
  }
  function setPhase(p) {
    phase = p;
    phaseT = 0;
  }

  // ---------------------------------------------------------------- skiff seat / bow in world space
  const skiffPoints = () => skiff()?.model?.points ?? null;
  function seatLocal(out) {
    const p = skiffPoints()?.seat;
    return p ? out.copy(p) : out.set(-0.4, -0.12, -0.6);
  }
  function bowLocal(out) {
    const p = skiffPoints()?.bow;
    return p ? out.copy(p) : out.set(0, 0.9, -2.9);
  }
  function skiffToWorld(local, out) {
    const o = skiff()?.object3d;
    if (!o) return out.copy(local);
    o.updateMatrixWorld?.(true);
    return out.copy(local).applyMatrix4(o.matrixWorld);
  }
  function skiffHeading() {
    return skiff()?.heading ?? 0;
  }
  function bowWorld(out) {
    return skiffToWorld(bowLocal(tmpV2), out);
  }
  // Where the deckhand steps ashore off the bow (and boards from): first wadeable point ahead of the bow.
  function boardPoint() {
    const h = skiffHeading();
    const b = bowWorld(new THREE.Vector3());
    const ux = Math.sin(h);
    const uz = -Math.cos(h);
    const p = stepOffPoint(terrainH, b.x, b.z, ux, uz) ?? (landing ? { x: landing.x, z: landing.z } : { x: b.x + ux * 2, z: b.z + uz * 2 });
    return { x: p.x, z: p.z, y: terrainH(p.x, p.z), heading: h };
  }

  // ---------------------------------------------------------------- scripted motion (disembark / embark)
  // Segments: { kind: 'walkLocal', to: Vector3 (skiff local), speed } | { kind: 'hop', to: () => {x,y,z}, dur, peak,
  // toLocal?: Vector3 } | { kind: 'walkTo', to: {x, z}, maxT } | { kind: 'wait', dur } | { kind: 'call', fn }
  const scriptPos = new THREE.Vector3();
  function runScript(dt) {
    if (!script) return null;
    const seg = script.list[script.i];
    if (!seg) {
      const done = script.onDone;
      script = null;
      done?.();
      return null;
    }
    seg.t = (seg.t ?? 0) + dt;
    const info = { speed: 0, onGround: true, vy: 0, jumped: false, landed: false, landSpeed: 0, heading: foot.heading };
    const next = () => {
      script.i++;
    };
    if (seg.kind === 'call') {
      seg.fn();
      next();
      return runScript(0);
    }
    if (seg.kind === 'wait') {
      if (seg.t >= seg.dur) next();
      return info;
    }
    if (seg.kind === 'walkLocal') {
      if (!seg.from) seg.from = rideLocal.clone();
      const len = Math.max(0.01, seg.from.distanceTo(seg.to));
      const u = clamp((seg.t * seg.speed) / len, 0, 1);
      rideLocal.lerpVectors(seg.from, seg.to, u);
      info.speed = u < 1 ? seg.speed : 0;
      const dir = tmpV.subVectors(seg.to, seg.from);
      info.localHeading = Math.atan2(dir.x, -dir.z);
      if (u >= 1) next();
      info.ride = true;
      return info;
    }
    if (seg.kind === 'hop') {
      if (!seg.a) {
        seg.a = position.clone();
        info.jumped = true;
      }
      const b = seg.toLocal ? skiffToWorld(seg.toLocal, tmpV) : seg.to();
      const u = clamp(seg.t / seg.dur, 0, 1);
      const top = Math.max(seg.a.y, b.y) + seg.peak;
      // Quadratic Bezier through the apex control point.
      const cy = 2 * top - 0.5 * (seg.a.y + b.y);
      const y = (1 - u) * (1 - u) * seg.a.y + 2 * u * (1 - u) * cy + u * u * b.y;
      const dy = 2 * (1 - u) * (cy - seg.a.y) + 2 * u * (b.y - cy);
      scriptPos.set(seg.a.x + (b.x - seg.a.x) * u, y, seg.a.z + (b.z - seg.a.z) * u);
      info.world = scriptPos;
      info.onGround = u >= 1;
      info.vy = dy / seg.dur;
      info.heading = Math.hypot(b.x - seg.a.x, b.z - seg.a.z) > 0.2 ? headingOf(b.x - seg.a.x, b.z - seg.a.z) : foot.heading;
      info.speed = Math.hypot(b.x - seg.a.x, b.z - seg.a.z) / seg.dur;
      if (u >= 1) {
        info.landed = true;
        info.landSpeed = Math.max(1.5, -info.vy);
        next();
      }
      return info;
    }
    if (seg.kind === 'walkTo') {
      const dx = seg.to.x - foot.x;
      const dz = seg.to.z - foot.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.35 || seg.t > (seg.maxT ?? 3)) {
        next();
        return info;
      }
      stepFoot(foot, { mx: dx / d * Math.min(1, d), mz: dz / d * Math.min(1, d), run: false, jump: false }, { heightAt: terrainH, dt, seaLevel: 0 }, FOOT_TUNING, FOOT_RULES);
      info.fromController = true;
      return info;
    }
    next();
    return info;
  }

  // ---------------------------------------------------------------- going ashore
  function goAshore() {
    const chk = canGoAshore();
    if (!chk.ok || ctx.state.mode !== 'play') return false;
    const s = seiner();
    const sk = skiff();
    landing = { ...chk.landing };
    if (!s.mooring) s.setMooring?.({ kind: 'anchor' });
    s.lockControls?.('player', true);
    enterCutscene();
    active = true;
    group.visible = true;
    ride = true;
    seatLocal(rideLocal);
    foot.heading = skiffHeading();
    setControl('foot');
    setPhase('launch');
    ferry = null;
    script = null;
    watch = null;
    placeRide();
    ui()?.hint?.('foot-controls', 'On foot: W A S D walk (relative to the camera), Shift runs, Space jumps. Walk back to the skiff and press E to return to the boat.');
    // A beat on the ramp, then the skiff drops off the stern.
    script = {
      i: 0,
      list: [
        { kind: 'wait', dur: 0.9 },
        { kind: 'call', fn: () => sk?.release?.() },
      ],
      onDone: null,
    };
    return true;
  }

  function startFerryOut() {
    const sk = skiff();
    const from = { x: sk?.position?.x ?? position.x, z: sk?.position?.z ?? position.z };
    const dist = Math.hypot(landing.shoreX - from.x, landing.shoreZ - from.z);
    ferry = { t: 0, cut: dist > TUNE.cutDistance, cutDone: false, arrived: false, dest: 'beach', startDist: dist };
    sk?.ferry?.(from, { x: landing.x, z: landing.z }, () => {
      if (ferry) ferry.arrived = true;
    });
    setPhase('ferry');
  }

  function cutFerry() {
    const sk = skiff();
    if (!ferry || !sk) return;
    ferry.cutDone = true;
    fader.start({
      inS: 0.45,
      holdS: 0.5,
      outS: 0.85,
      onBlack: () => {
        if (!ferry) return;
        if (ferry.dest === 'beach') {
          const hx = landing.shoreX - (seiner()?.position?.x ?? landing.shoreX);
          const hz = landing.shoreZ - (seiner()?.position?.z ?? landing.shoreZ);
          const len = Math.hypot(hx, hz) || 1;
          const from = { x: landing.shoreX - (hx / len) * TUNE.cutApproach, z: landing.shoreZ - (hz / len) * TUNE.cutApproach };
          sk.ferry(from, { x: landing.x, z: landing.z }, () => {
            if (ferry) ferry.arrived = true;
          });
        } else {
          const a = asternPoint();
          const dx = a.x - sk.position.x;
          const dz = a.z - sk.position.z;
          const len = Math.hypot(dx, dz) || 1;
          const from = { x: a.x - (dx / len) * TUNE.cutApproach, z: a.z - (dz / len) * TUNE.cutApproach };
          sk.ferry(from, a, () => {
            if (ferry) ferry.arrived = true;
          });
        }
        snapCamera = true;
      },
    });
  }

  function beginDisembark() {
    setPhase('disembark');
    const bow = bowLocal(new THREE.Vector3());
    const inside = new THREE.Vector3(0, seatLocal(tmpV).y, bow.z + 0.75);
    const bowTop = new THREE.Vector3(0, bow.y + 0.02, bow.z + 0.28);
    script = {
      i: 0,
      list: [
        { kind: 'wait', dur: 0.35 },
        { kind: 'walkLocal', to: inside, speed: 1.3 },
        { kind: 'hop', toLocal: bowTop, dur: 0.42, peak: 0.25 },
        { kind: 'call', fn: () => (ride = false) },
        {
          kind: 'hop',
          to: (() => {
            let target = null;
            return () => {
              if (!target) {
                const bp = boardPoint();
                target = new THREE.Vector3(bp.x, bp.y, bp.z);
              }
              target.y = terrainH(target.x, target.z);
              return target;
            };
          })(),
          dur: 0.62,
          peak: 0.35,
        },
        { kind: 'call', fn: () => placeFoot(foot, position.x, position.z, foot.heading, terrainH) },
        { kind: 'wait', dur: 0.15 },
        // A few steps up the beach, clear of the bow, so the camera settles behind the deckhand.
        {
          kind: 'walkTo',
          to: (() => {
            const h = skiffHeading();
            const bp = boardPoint();
            return { x: bp.x + Math.sin(h) * 2.6, z: bp.z - Math.cos(h) * 2.6 };
          })(),
          maxT: 2,
        },
      ],
      onDone: () => {
        setPhase('foot');
        leaveCutscene();
      },
    };
  }

  // ---------------------------------------------------------------- back to the boat
  function nearSkiff() {
    const sk = skiff();
    if (!sk?.position || sk.state !== 'ferry') return false;
    const b = bowWorld(tmpV);
    const dBow = Math.hypot(b.x - foot.x, b.z - foot.z);
    const dMid = Math.hypot(sk.position.x - foot.x, sk.position.z - foot.z);
    return dBow < TUNE.boardRadius || dMid < TUNE.boardRadius + 1.3;
  }

  function returnToBoat() {
    if (!active) return false;
    if (phase !== 'foot' && phase !== 'retreat') return false;
    const sk = skiff();
    if (!sk || sk.state !== 'ferry') {
      returnAboardNow();
      return true;
    }
    enterCutscene();
    watch = null;
    const far = !nearSkiff();
    const bp = boardPoint();
    const bow = bowLocal(new THREE.Vector3());
    const bowTop = new THREE.Vector3(0, bow.y + 0.02, bow.z + 0.28);
    const inside = new THREE.Vector3(0, seatLocal(tmpV).y, bow.z + 0.75);
    const seat = seatLocal(new THREE.Vector3());
    const steps = [
      { kind: 'walkTo', to: bp, maxT: 2.5 },
      { kind: 'hop', toLocal: bowTop, dur: 0.55, peak: 0.3 },
      { kind: 'call', fn: () => {
        ride = true;
        bowLocal(rideLocal);
        rideLocal.copy(bowTop);
      } },
      { kind: 'hop', toLocal: inside, dur: 0.38, peak: 0.12 },
      { kind: 'call', fn: () => rideLocal.copy(inside) },
      { kind: 'walkLocal', to: seat, speed: 1.3 },
      { kind: 'wait', dur: 0.3 },
    ];
    setPhase('embark');
    if (far) steps.unshift({ kind: 'wait', dur: 0.45 });
    if (far) {
      // Called from afar (API): fade and put the deckhand at the bow first.
      fader.start({
        inS: 0.4,
        holdS: 0.3,
        outS: 0.7,
        onBlack: () => {
          placeFoot(foot, bp.x, bp.z, bp.heading + Math.PI, terrainH);
          syncFromFoot();
          snapCamera = true;
        },
      });
    }
    script = { i: 0, list: steps, onDone: startFerryBack };
    return true;
  }

  function asternPoint() {
    const s = seiner();
    if (!s?.position) return { x: position.x, z: position.z };
    const st = s.sternPoint ? s.sternPoint(tmpV2) : tmpV2.copy(s.position);
    const h = s.heading ?? 0;
    return { x: st.x - Math.sin(h) * TUNE.asternOffset, z: st.z + Math.cos(h) * TUNE.asternOffset };
  }

  // Where a landed skiff floats: out from the waterline along the approach until there is ~0.8 m under it.
  function skiffBeachSpot(l) {
    const s = seiner();
    const ox = s?.position?.x ?? l.shoreX - 50;
    const oz = s?.position?.z ?? l.shoreZ;
    const dx = l.shoreX - ox;
    const dz = l.shoreZ - oz;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len;
    const uz = dz / len;
    for (let t = 0; t < 60; t += 0.5) {
      const x = l.shoreX - ux * t;
      const z = l.shoreZ - uz * t;
      if (ctx.heightmap.depthAt(x, z) >= 0.8) return { x, z };
    }
    return { x: l.shoreX - ux * 12, z: l.shoreZ - uz * 12 };
  }

  function startFerryBack() {
    const sk = skiff();
    const a = asternPoint();
    const from = { x: sk.position.x, z: sk.position.z };
    const dist = Math.hypot(a.x - from.x, a.z - from.z);
    ferry = { t: 0, cut: dist > TUNE.cutDistance, cutDone: false, arrived: false, dest: 'boat', startDist: dist };
    sk.ferry(from, a, () => {
      if (ferry) ferry.arrived = true;
    });
    setPhase('return');
  }

  function finishReturn() {
    const s = seiner();
    active = false;
    group.visible = false;
    ride = false;
    script = null;
    ferry = null;
    watch = null;
    landing = null;
    s?.lockControls?.('player', false);
    setControl('boat');
    setPhase('aboard');
    leaveCutscene();
    search.t = -1e9;
  }

  // Instant return (boat:teleport, reset, title, failures): no animation.
  function returnAboardNow({ silentMode = false, keepFade = false } = {}) {
    if (!keepFade) fader.clear();
    const sk = skiff();
    if (active && sk && sk.state !== 'stowed') sk.stow?.();
    const wasActive = active;
    active = false;
    group.visible = false;
    ride = false;
    script = null;
    ferry = null;
    watch = null;
    landing = null;
    seiner()?.lockControls?.('player', false);
    if (wasActive || ctx.state.control !== 'boat') setControl('boat');
    setPhase('aboard');
    if (!silentMode) leaveCutscene();
    else ownsCutscene = false;
    search.t = -1e9;
  }

  // ---------------------------------------------------------------- bears
  function bearById(id) {
    return (ctx.systems.wildlife?.bears ?? []).find?.((b) => b.id === id) ?? null;
  }

  function onBear(e) {
    if (!active || !e) return;
    const stage = e.stage;
    if (stage === 'watch') {
      const b = bearById(e.bearId);
      watch = { bearId: e.bearId, x: b?.position?.x ?? e.x, z: b?.position?.z ?? e.z, until: ctx.time.elapsed + 14 };
      // The UI already toasts the encounter itself; the player adds the once-per-save field advice.
      if (phase === 'foot') ui()?.hint?.('bear-watch', 'Back away slowly. Kodiak brown bears: stay calm, talk quietly, give her room — and never run from a bear.');
    } else if (stage === 'charge') {
      if (phase !== 'foot' || ctx.state.mode !== 'play') return;
      const b = bearById(e.bearId);
      watch = { bearId: e.bearId, x: b?.position?.x ?? e.x ?? foot.x, z: b?.position?.z ?? e.z ?? foot.z, until: ctx.time.elapsed + 6 };
      startRetreat();
    } else if (stage === 'retreat') {
      if (watch && (watch.bearId === e.bearId || !e.bearId)) watch.until = ctx.time.elapsed + 1.5;
    }
  }

  function startRetreat() {
    enterCutscene();
    setPhase('retreat');
    script = null;
    let backToBoat = false;
    fader.start({
      inS: 0.55,
      holdS: 0.75,
      outS: 1.1,
      onBlack: () => {
        const sk = skiff();
        const bp = sk?.state === 'ferry' ? boardPoint() : null;
        const near = bp ? ctx.systems.wildlife?.nearestBear?.(bp.x, bp.z) : null;
        if (!bp || (near && near.distance < 40)) {
          backToBoat = true;
          returnAboardNow({ keepFade: true });
          return;
        }
        // Back at the skiff on dry beach just above the bow, looking out at it.
        const ux = Math.sin(bp.heading);
        const uz = -Math.cos(bp.heading);
        const dryP = dryPointAhead(terrainH, bp.x, bp.z, ux, uz);
        let px = dryP?.x ?? bp.x + ux * 1.6;
        let pz = dryP?.z ?? bp.z + uz * 1.6;
        if (!standable(terrainH, px, pz)) {
          px = bp.x;
          pz = bp.z;
        }
        placeFoot(foot, px, pz, wrap(bp.heading + Math.PI), terrainH);
        syncFromFoot();
        watch = null;
        snapCamera = true;
      },
      onDone: () => {
        if (!backToBoat) setPhase('foot');
        leaveCutscene();
        ctx.systems.ui?.radio?.('Skiffman', QUIPS[Math.floor(quipRng.next() * QUIPS.length)], '10');
      },
    });
  }

  // ---------------------------------------------------------------- summits (spotting perches)
  function perchCandidates() {
    if (!summits) {
      summits = [];
      for (const p of ctx.systems.places?.list ?? []) {
        if ((p.kind === 'peak' || p.kind === 'viewpoint') && Number.isFinite(p.x) && !p.memorial) summits.push({ place: p, summit: null });
      }
    }
    return summits;
  }

  function checkPerch() {
    const disc = ctx.systems.discovery;
    if (!disc?.addPerch) return;
    for (const c of perchCandidates()) {
      const p = c.place;
      const r = p.radius ?? 200;
      if ((p.x - foot.x) ** 2 + (p.z - foot.z) ** 2 > (r + 400) ** 2) continue;
      if (!c.summit) c.summit = perchPoint(coarseH, p);
      if (!onSummit(foot.x, foot.y, foot.z, c.summit)) continue;
      const day = ctx.clock?.day ?? 0;
      if (perchDone.get(p.id) === day) continue;
      perchDone.set(p.id, day);
      disc.addPerch(p.id);
      events.emit('player:summit', { placeId: p.id, x: c.summit.x, z: c.summit.z });
    }
  }

  // ---------------------------------------------------------------- per-frame placement
  function placeRide() {
    const sk = skiff();
    if (!sk?.object3d) return;
    skiffToWorld(rideLocal, position);
    sk.object3d.getWorldQuaternion(tmpQ);
    // Stand upright-ish: follow the skiff's yaw fully and a third of its roll and pitch.
    euler.setFromQuaternion(tmpQ, 'YXZ');
    group.quaternion.setFromEuler(euler.set(euler.x * 0.35, euler.y, euler.z * 0.35, 'YXZ'));
    foot.x = position.x;
    foot.z = position.z;
    foot.y = position.y;
    foot.heading = skiffHeading();
  }

  function syncFromFoot() {
    position.set(foot.x, foot.y, foot.z);
    group.quaternion.setFromAxisAngle(upAxis, -foot.heading);
  }

  // Camera-relative move vector from WASD / left stick.
  const moveCmd = { mx: 0, mz: 0, run: false, jump: false };
  let drive = null; // QA override: { mx, mz (world), run, jump }
  function readMove() {
    if (drive) {
      moveCmd.mx = drive.mx ?? 0;
      moveCmd.mz = drive.mz ?? 0;
      moveCmd.run = !!drive.run;
      moveCmd.jump = !!drive.jump;
      drive.jump = false;
      return moveCmd;
    }
    const fwd = input.axis?.('throttle') ?? 0;
    const side = input.axis?.('steer') ?? 0;
    camera.getWorldDirection(tmpV);
    let fx = tmpV.x;
    let fz = tmpV.z;
    const l = Math.hypot(fx, fz);
    if (l < 1e-3) {
      fx = Math.sin(foot.heading);
      fz = -Math.cos(foot.heading);
    } else {
      fx /= l;
      fz /= l;
    }
    const rx = -fz;
    const rz = fx;
    moveCmd.mx = fx * fwd + rx * side;
    moveCmd.mz = fz * fwd + rz * side;
    moveCmd.run = !!input.action?.('sprint');
    moveCmd.jump = !!input.pressed?.('action');
    return moveCmd;
  }

  // Ground height under a foot placed at (lat, fwd) in the body frame, relative to the root.
  const groundAt = (lat, fwdOff) => {
    const h = foot.heading;
    const fx = Math.sin(h);
    const fz = -Math.cos(h);
    const rx = Math.cos(h);
    const rz = Math.sin(h);
    const x = position.x + fx * fwdOff + rx * lat;
    const z = position.z + fz * fwdOff + rz * lat;
    return terrainH(x, z) - position.y;
  };
  const flatGround = () => 0;

  let prevHeading = 0;
  const animIn = {
    dt: 0, speed: 0, slopeDeg: 0, onGround: true, vy: 0, jumped: false, landed: false, landSpeed: 0, sliding: false,
    depth: 0, turnRate: 0, mode: 'free', lookYaw: null, lookPitch: 0, boatRoll: 0, boatPitch: 0, scrambling: false,
  };

  function lookTarget() {
    // The bear when one is watching; otherwise the boat when standing and it is in front of us.
    let tx = null;
    let tz = null;
    let ty = 0;
    if (watch && ctx.time.elapsed < watch.until) {
      const b = bearById(watch.bearId);
      tx = b?.position?.x ?? watch.x;
      tz = b?.position?.z ?? watch.z;
      ty = (b?.position?.y ?? terrainH(tx, tz)) + 1;
    } else if (phase === 'foot' && foot.speed < 0.3 && Math.sin(ctx.time.elapsed * 0.31 + 1.3) + Math.sin(ctx.time.elapsed * 0.17) > -0.4) {
      const s = seiner();
      if (s?.position) {
        tx = s.position.x;
        tz = s.position.z;
        ty = 3;
      }
    }
    if (tx === null) {
      animIn.lookYaw = null;
      animIn.lookPitch = 0;
      return;
    }
    const dx = tx - position.x;
    const dz = tz - position.z;
    const d = Math.hypot(dx, dz);
    if (d > 2500 || d < 2) {
      animIn.lookYaw = null;
      animIn.lookPitch = 0;
      return;
    }
    const rel = wrap(headingOf(dx, dz) - foot.heading);
    if (Math.abs(rel) > 1.9 && !watch) {
      animIn.lookYaw = null;
      animIn.lookPitch = 0;
      return;
    }
    animIn.lookYaw = clamp(rel, -1.05, 1.05);
    animIn.lookPitch = clamp(Math.atan2(ty - (position.y + 1.6), d), -0.6, 0.5);
  }

  // ---------------------------------------------------------------- update
  function update(dt) {
    fader.update(dt);
    if (!active) {
      if (ctx.state.mode === 'play' && ctx.state.control === 'boat') {
        const chk = canGoAshore();
        if (chk.ok) {
          const name = chk.landing.placeName;
          interact.offer({ id: 'go-ashore', label: name ? `Go ashore — ${name}` : 'Go ashore', key: 'interact', priority: 40, onPress: goAshore });
        }
      }
      return;
    }
    if (!(dt > 0)) {
      group.updateMatrixWorld(true);
      return;
    }
    phaseT += dt;
    const sk = skiff();

    let info = null;
    let mode = 'free';
    animIn.jumped = false;
    animIn.landed = false;
    animIn.landSpeed = 0;
    animIn.scrambling = false;

    if (phase === 'launch') {
      info = runScript(dt);
      placeRide();
      mode = 'ride';
      // Once the skiff is in the water, run for the beach.
      if (!script && sk && sk.state !== 'released' && sk.state !== 'stowed') startFerryOut();
      else if (!script && (!sk || phaseT > 6)) startFerryOut();
    } else if ((phase === 'ferry' || phase === 'return') && !ferry) {
      returnAboardNow();
    } else if (phase === 'ferry' || phase === 'return') {
      placeRide();
      mode = 'ride';
      ferry.t += dt;
      if (ferry.cut && !ferry.cutDone && ferry.t > TUNE.cutAfter) cutFerry();
      if (ferry.arrived) {
        if (phase === 'ferry') {
          ferry = null;
          beginDisembark();
        } else if (!ferry.winching) {
          ferry.winching = true;
          sk?.returnTo?.(() => finishReturn());
        }
      } else if (ferry.t > (ferry.cut ? 28 : 40) && !fader.busy) {
        // Watchdog: the skiff should have arrived by now; finish behind a fade.
        const dest = phase;
        fader.start({
          inS: 0.4,
          holdS: 0.4,
          outS: 0.8,
          onBlack: () => {
            if (dest === 'ferry') {
              const spot = skiffBeachSpot(landing);
              sk?.ferry?.(spot, { x: landing.x, z: landing.z }, () => {});
              sk?.update?.(0.02);
              ferry = null;
              const bp = boardPoint();
              ride = false;
              placeFoot(foot, bp.x, bp.z, bp.heading, terrainH);
              syncFromFoot();
              setPhase('foot');
              leaveCutscene();
            } else {
              returnAboardNow({ keepFade: true });
            }
            snapCamera = true;
          },
        });
      }
      if (phase === 'return' && ferry?.winching && sk?.state === 'stowed' && active) finishReturn();
    } else if (phase === 'disembark' || phase === 'embark') {
      info = runScript(dt);
      if (ride) placeRide();
      mode = ride ? 'ride' : 'free';
    } else if (phase === 'retreat') {
      mode = fader.alpha > 0.5 ? 'free' : 'startled';
      stepFoot(foot, { mx: 0, mz: 0 }, { heightAt: terrainH, dt, seaLevel: 0 });
    } else if (phase === 'foot') {
      const playing = ctx.state.mode === 'play';
      const cmd = playing ? readMove() : { mx: 0, mz: 0, run: false, jump: false };
      stepFoot(foot, cmd, { heightAt: terrainH, dt, seaLevel: 0, boundary: ctx.config.world.boundary ?? 7600 });
      if (foot.boundary && ctx.time.elapsed - boundaryToastAt > 10) {
        boundaryToastAt = ctx.time.elapsed;
        ui()?.toast?.('Edge of the chart — time to turn back.', { kind: 'warn', duration: 4 });
      }
      if (watch && ctx.time.elapsed < watch.until) mode = 'wary';
      animIn.scrambling = slopeBand(foot.slopeDeg) === 'scramble' || (foot.slopeDeg > 44 && foot.speed > 0.1);
      // Board the skiff.
      boardOffer = playing && nearSkiff();
      if (boardOffer) interact.offer({ id: 'board-skiff', label: 'Back to the boat', key: 'interact', priority: 80, onPress: returnToBoat });
      perchTimer -= dt;
      if (perchTimer <= 0) {
        perchTimer = TUNE.perchEvery;
        checkPerch();
        onTop = foot.y > 20 && isHilltop(terrainH, foot.x, foot.z, foot.y);
      }
      idleT = foot.speed < 0.15 && foot.onGround ? idleT + dt : 0;
    }

    // Scripted positions (hops) override; walkTo already moved the controller.
    if (info?.world) {
      position.copy(info.world);
      foot.x = position.x;
      foot.y = position.y;
      foot.z = position.z;
      if (Number.isFinite(info.heading)) foot.heading = dampHeading(foot.heading, info.heading, dt, 14);
      group.quaternion.setFromAxisAngle(upAxis, -foot.heading);
    } else if (!ride) {
      syncFromFoot();
    }

    // ---- animation inputs
    const turn = dt > 0 ? wrap(foot.heading - prevHeading) / dt : 0;
    prevHeading = foot.heading;
    animIn.dt = dt;
    animIn.mode = mode;
    if (info && !info.fromController) {
      animIn.speed = info.speed;
      animIn.onGround = info.onGround;
      animIn.vy = info.vy;
      animIn.jumped = info.jumped;
      animIn.landed = info.landed;
      animIn.landSpeed = info.landSpeed;
      animIn.sliding = false;
      animIn.slopeDeg = 0;
      animIn.depth = ride ? 0 : Math.max(0, -position.y);
    } else {
      animIn.speed = ride ? 0 : foot.speed;
      animIn.onGround = ride ? true : foot.onGround;
      animIn.vy = foot.vy;
      animIn.jumped = foot.jumped;
      animIn.landed = foot.landed;
      animIn.landSpeed = foot.landSpeed;
      animIn.sliding = foot.sliding;
      animIn.slopeDeg = foot.speed > 0.1 ? foot.slopeDeg : 0;
      animIn.depth = ride ? 0 : foot.depth;
    }
    animIn.turnRate = clamp(turn, -6, 6);
    if (ride && sk?.object3d) {
      sk.object3d.getWorldQuaternion(tmpQ);
      euler.setFromQuaternion(tmpQ, 'YXZ');
      animIn.boatRoll = euler.z * 0.65;
      animIn.boatPitch = euler.x * 0.65;
    } else {
      animIn.boatRoll = 0;
      animIn.boatPitch = 0;
    }
    lookTarget();
    const walkingInSkiff = ride && info?.ride && info.speed > 0;
    if (walkingInSkiff) animIn.mode = 'free';
    animate(anim, pose, animIn, ride ? flatGround : groundAt);
    figure.applyPose(pose);
    uUnderwaterAmt.value = ride ? 0 : 1;

    // Footsteps: event + ripples in the shallows.
    if (anim.steps !== lastStepCount) {
      lastStepCount = anim.steps;
      const h = foot.heading;
      const side = anim.stepSide;
      const fx = position.x + Math.cos(h) * 0.1 * side;
      const fz = position.z + Math.sin(h) * 0.1 * side;
      const wet = !ride && foot.depth > 0.04;
      const surface = ride ? 'skiff' : wet ? 'water' : ctx.systems.terrain?.surfaceAt?.(fx, fz) ?? 'gravel';
      events.emit('player:step', { surface, run: anim.runAmt > 0.5 });
      if (wet) {
        const w = ctx.systems.water;
        w?.stamp?.(fx, fz, 0.6 + foot.speed * 0.15, clamp(0.35 + foot.depth, 0.3, 0.8), 'foam');
        w?.stamp?.(fx, fz, 0.8, 0.6, 'ripple');
      }
    }
    if (animIn.landed && !ride && foot.depth > 0.04) {
      ctx.systems.water?.stamp?.(position.x, position.z, 1.4, 0.8, 'ripple');
      ctx.systems.water?.stamp?.(position.x, position.z, 1.1, 0.7, 'foam');
    }

    velocity.set(foot.vx, foot.vy, foot.vz);
    group.updateMatrixWorld(true);
    if (snapCamera) {
      snapCamera = false;
      const rig = ctx.systems.cameraRig;
      if (rig?.setTarget && ctx.state.control === 'foot') {
        rig.setTarget(group);
        rig.setTarget(null);
      }
    }
  }

  function dampHeading(cur, want, dt, rate) {
    return wrap(cur + wrap(want - cur) * (1 - Math.exp(-rate * dt)));
  }

  // ---------------------------------------------------------------- events
  events.on('bear:encounter', onBear);
  events.on('boat:teleport', () => {
    if (active || ctx.state.control !== 'boat') returnAboardNow();
  });
  events.on('game:toTitle', () => {
    if (active) returnAboardNow({ silentMode: true });
  });
  events.on('game:mode', ({ mode }) => {
    // Something else took the screen mid-cutscene (title): drop our claim on it.
    if (mode === 'title') ownsCutscene = false;
  });

  const sys = {
    get active() {
      return active;
    },
    object3d: group,
    position,
    velocity,
    get heading() {
      return foot.heading;
    },
    get phase() {
      return phase;
    },
    get landing() {
      return landing;
    },
    get onGround() {
      return foot.onGround;
    },
    get sliding() {
      return foot.sliding;
    },
    get wading() {
      return !ride && foot.depth > 0.04;
    },
    // Framing the camera rig may adopt in foot mode (null = its own defaults): wider during the skiff runs, and a
    // lower, longer look out over the view after a few seconds standing still on a hilltop.
    get cameraFraming() {
      if (!active) return null;
      if (phase === 'launch' || phase === 'ferry' || phase === 'return') return FRAMING.ferry;
      if (phase === 'disembark' || phase === 'embark') return FRAMING.board;
      if (phase === 'foot' && onTop && idleT > TUNE.summitIdle) return FRAMING.summit;
      return null;
    },
    rules: FOOT_RULES,
    tuning: FOOT_TUNING,
    canGoAshore,
    goAshore,
    returnToBoat,

    // Debug / QA: jump straight to standing on the beach beside the landed skiff (no cutscene).
    debugAshore() {
      if (active) return phase === 'foot';
      const chk = canGoAshore();
      if (!chk.ok) return false;
      const s = seiner();
      const sk = skiff();
      landing = { ...chk.landing };
      if (!s.mooring) s.setMooring?.({ kind: 'anchor' });
      s.lockControls?.('player', true);
      active = true;
      group.visible = true;
      ride = false;
      setControl('foot');
      sk?.ferry?.(skiffBeachSpot(landing), { x: landing.x, z: landing.z }, () => {});
      sk?.update?.(0.02);
      const bp = boardPoint();
      placeFoot(foot, bp.x, bp.z, bp.heading, terrainH);
      syncFromFoot();
      setPhase('foot');
      snapCamera = true;
      return true;
    },
    // Debug / QA: move the deckhand (on foot) to (x, z).
    placeAt(x, z, headingDeg) {
      if (!active || phase !== 'foot') return false;
      placeFoot(foot, x, z, Number.isFinite(headingDeg) ? (headingDeg * Math.PI) / 180 : foot.heading, terrainH);
      syncFromFoot();
      group.updateMatrixWorld(true);
      snapCamera = true;
      return true;
    },
    // Debug / QA: drive the deckhand without keys. cmd = { mx, mz (world direction), run, jump } or { headingDeg,
    // run } or null to hand control back to the keyboard.
    debugDrive(cmd) {
      if (!cmd) {
        drive = null;
        return true;
      }
      if (Number.isFinite(cmd.headingDeg)) {
        const h = (cmd.headingDeg * Math.PI) / 180;
        drive = { mx: Math.sin(h) * (cmd.amount ?? 1), mz: -Math.cos(h) * (cmd.amount ?? 1), run: cmd.run, jump: cmd.jump };
      } else drive = { ...cmd };
      return true;
    },
    // Debug / QA: find the landing a boat at (x, z) would use.
    landingFrom(x, z) {
      return runSearch(x, z);
    },

    update,

    debugState() {
      return {
        active,
        phase,
        control: ctx.state.control,
        x: +foot.x.toFixed(1),
        y: +foot.y.toFixed(2),
        z: +foot.z.toFixed(1),
        headingDeg: Math.round((((foot.heading * 180) / Math.PI) % 360 + 360) % 360),
        speed: +foot.speed.toFixed(2),
        onGround: foot.onGround,
        sliding: foot.sliding,
        depth: +foot.depth.toFixed(2),
        slopeDeg: +foot.slopeDeg.toFixed(1),
        groundDeg: +foot.groundDeg.toFixed(1),
        ride,
        boardOffer,
        landing: landing ? { x: +landing.x.toFixed(1), z: +landing.z.toFixed(1), placeId: landing.placeId } : null,
        ashore: active ? null : canGoAshore().reason,
        fade: +fader.alpha.toFixed(2),
        onTop,
        framing: sys.cameraFraming?.kind ?? null,
      };
    },
    serialize() {
      return undefined;
    },
    restore() {},
    reset() {
      returnAboardNow({ silentMode: true });
      perchDone.clear();
      exclusions = null;
    },
  };
  return sys;
}
