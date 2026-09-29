// The audio director: reads the game world every frame (camera, weather, sea, boats, gear, wildlife, settlements) and
// turns it into bed parameters, scheduled world one-shots and the music cue; discrete game events go through cues.js.
// All cross-system reads use optional chaining so stubbed or missing neighbours simply go quiet.

import {
  TUNING,
  DIESELS,
  clamp,
  smoothstep,
  oceanParams,
  lapStep,
  washInterval,
  windParams,
  gustStep,
  rainParams,
  newEngineState,
  engineStep,
  dieselVoice,
  skiffEffortFor,
  hydraulicParams,
  hullWashParams,
  gullInterval,
  musicCue,
} from './params.js';
import {
  settlementAt,
  harborPoint,
  listenerContext,
  shorePoint,
  beachGravel,
  brailWhipRate,
  nearestOf,
  nearestN,
  gullScene,
  slapStrength,
  lapInterval,
  sealionRate,
  poissonWait,
  muffleFor,
} from './scene.js';
import { resolve as resolvePlaces } from '../data/places.js';
import { createCues } from './cues.js';

const BED_HZ = 30; // bed parameter writes per second
const SLOW_HZ = 3; // scene scans (birds, places, fleet) per second
// How far the listener may sit from the avatar per camera mode (metres).
const EAR_REACH = { chase: 16, crowsnest: 3, bridge: 8, foot: 7 };

export function createDirector(ctx, audio) {
  const { ac, mixer, player, beds, music } = audio;
  const THREE = ctx.THREE;
  const S = () => ctx.systems;
  const rnd = Math.random;

  const fwd = new THREE.Vector3();
  const up = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const grad = { x: 0, z: 0 };
  const bagXZ = { x: 0, z: 0 };

  const L = { x: 0, y: 5, z: 0, fx: 0, fz: -1, fy: 0, rx: 1, rz: 0 }; // listener + right vector (for pans)
  const env = {
    mode: 'loading',
    ctx: { interior: 0, onFoot: false, height: 10 },
    shore: 1000,
    hs: 0.6,
    wind: 5,
    rain: 0,
    fog: 0,
    daylight: 1,
    forest: 0,
    ocean: null,
    settlement: { level: 0, hum: 0, clink: 0, machinery: 0, gulls: 0, place: null },
    gulls: { near: 0, working: 0, swarm: false, count: 0, sources: [] },
    eagle: null,
    bear: null,
    haulout: null,
    stream: null,
    light: null,
    fleet: [],
  };

  const eng = { main: newEngineState(), skiff: newEngineState(), fleet: [newEngineState(), newEngineState()], fleetIds: [null, null] };
  let gust = { value: 0.5, v: 0, target: 0.5, timer: 0 };
  const lapper = { env: 0, next: 0, target: 0 };
  const timers = { surf: 2, gull: 3, eagle: 12, bearHuff: 30, bearSplash: 8, sealion: 1, clink: 2, lap: 2, fog: 8, cork: 0.5, ring: 0.5, rig: 3 };
  let bedAcc = 0;
  let simAcc = 0;
  let slowAcc = 1;
  let hsAcc = 1;
  let meterAcc = 0;
  let pitchPrev = null;
  let skiffParked = 0;
  let rollPrev = null;
  let rollDir = 0;
  let pitchMin = 0;
  let fishingPrev = 'idle';
  let brailT = 0;
  let hauledPrev = null;
  let dawnDay = -1;
  // Shared with the event cues (cues.js): music triumph window, the radio queue, the last brailer scoop (audio time)
  // and a stampeding haulout ({ id, until }).
  const shared = { triumphUntil: -1, radioBusyUntil: 0, brailAt: -1e9, stampede: null };
  let places = null;
  let streams = null;
  let lights = null;

  const pos = (x, y, z) => ({ x, y, z });
  const panOf = (x, z) => {
    const dx = x - L.x;
    const dz = z - L.z;
    const d = Math.hypot(dx, dz) || 1;
    return clamp(((dx * L.rx + dz * L.rz) / d) * 0.85, -0.85, 0.85);
  };
  const distTo = (x, y, z) => Math.hypot(x - L.x, (y ?? 0) - L.y, z - L.z);
  const living = () => env.mode === 'play' || env.mode === 'title' || env.mode === 'cutscene';

  function placeData() {
    if (places) return;
    try {
      const P = S().places;
      const data = resolvePlaces(ctx.geo);
      places = Array.isArray(P?.list) && P.list.length ? P.list : data.places;
      streams = Array.isArray(P?.streams) && P.streams.length ? P.streams : data.streams;
      lights = places.filter((p) => p.kind === 'lighthouse');
    } catch {
      places = [];
      streams = [];
      lights = [];
    }
  }

  // ------------------------------------------------------------------------------------------------ listener
  function updateListener() {
    const cam = ctx.camera;
    const ov = ctx.debug?.cameraOverride;
    if (ov?.pos && ov?.look) {
      L.x = ov.pos[0];
      L.y = ov.pos[1];
      L.z = ov.pos[2];
      fwd.set(ov.look[0] - L.x, ov.look[1] - L.y, ov.look[2] - L.z).normalize();
      up.set(0, 1, 0);
    } else {
      L.x = cam.position.x;
      L.y = cam.position.y;
      L.z = cam.position.z;
      fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
      up.set(0, 1, 0).applyQuaternion(cam.quaternion);
      // Gameplay cameras hang well back from (or high above) the boat; the ears stay with the crew: in the crow's
      // nest on the mast, a few metres off the stern in chase, beside the deckhand on foot.
      const mode = S().cameraRig?.mode;
      const reach = EAR_REACH[mode];
      if (reach && ctx.state.mode !== 'title') {
        const a = ctx.game?.avatar?.();
        if (a && Number.isFinite(a.x)) {
          const ax = a.x;
          const ay = (a.y ?? 0) + (mode === 'crowsnest' ? 9 : 2);
          const az = a.z;
          const dx = L.x - ax;
          const dy = L.y - ay;
          const dz = L.z - az;
          const d = Math.hypot(dx, dy, dz);
          if (d > reach) {
            const k = reach / d;
            L.x = ax + dx * k;
            L.y = ay + dy * k;
            L.z = az + dz * k;
          }
        }
      }
    }
    if (!Number.isFinite(L.x) || !Number.isFinite(L.y) || !Number.isFinite(L.z)) {
      L.x = 0;
      L.y = 10;
      L.z = 0;
    }
    if (!Number.isFinite(fwd.x) || !Number.isFinite(fwd.y) || !Number.isFinite(fwd.z) || fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    if (!Number.isFinite(up.x) || !Number.isFinite(up.y) || !Number.isFinite(up.z) || up.lengthSq() < 1e-6) up.set(0, 1, 0);
    L.fx = fwd.x;
    L.fy = fwd.y;
    L.fz = fwd.z;
    const h = Math.hypot(fwd.x, fwd.z) || 1;
    L.rx = -fwd.z / h;
    L.rz = fwd.x / h;
    const l = ac.listener;
    if (l.positionX) {
      l.positionX.value = L.x;
      l.positionY.value = L.y;
      l.positionZ.value = L.z;
      l.forwardX.value = fwd.x;
      l.forwardY.value = fwd.y;
      l.forwardZ.value = fwd.z;
      l.upX.value = up.x;
      l.upY.value = up.y;
      l.upZ.value = up.z;
    } else {
      l.setPosition?.(L.x, L.y, L.z);
      l.setOrientation?.(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
    player.setListener(L.x, L.y, L.z);
  }

  // ----------------------------------------------------------------------------------------------- scene scan
  function scanSlow() {
    placeData();
    const w = S().sky?.weather;
    env.wind = Number.isFinite(w?.windSpeed) ? w.windSpeed : 5;
    env.rain = Number.isFinite(w?.rain) ? w.rain : 0;
    env.fog = Number.isFinite(w?.fog) ? w.fog : 0;
    const dl = S().sky?.daylight;
    env.daylight = Number.isFinite(dl) ? dl : 1;
    env.settlement = settlementAt(places, L.x, L.z);
    const wl = S().wildlife;
    env.gulls = gullScene(wl?.birds, L.x, L.z, 200);
    env.eagle = nearestOf(wl?.birds, L.x, L.z, 450, (b) => b.kind === 'eagle');
    env.bear = nearestOf(wl?.bears, L.x, L.z, 320);
    const ho = nearestOf(wl?.sites?.haulouts, L.x, L.z, 1500);
    // The Marmot Island rookery is a roaring crowd; islet and point haulouts are a dozen or two animals.
    env.haulout = ho ? { ...ho, members: ho.item.members?.length ?? (ho.item.kind === 'rookery' ? 60 : 16) } : null;
    env.stream = nearestOf(streams, L.x, L.z, 260);
    env.light = env.fog > 0.55 ? nearestOf(lights, L.x, L.z, 3200) : null;
    const boats = S().fleet?.boats;
    env.fleet = nearestN(boats, L.x, L.z, 2, 480, (b) => b.kind !== 'skiff' && b.object3d?.visible !== false);
    const t = S().terrain;
    if (env.ctx.onFoot && t) {
      const f = Number(t.forestDensity?.(L.x, L.z)) || 0;
      const surf = t.surfaceAt?.(L.x, L.z);
      env.forest = Math.max(f, surf === 'alder' ? 0.6 : surf === 'forest' ? 0.8 : 0);
    } else env.forest = 0;
  }

  function sampleSea() {
    const water = S().water;
    let hs = NaN;
    if (env.shore > -40) hs = Number(water?.seaStateAt?.(L.x, L.z));
    if (!Number.isFinite(hs)) {
      const sw = S().sky?.weather?.swell;
      hs = (Number.isFinite(sw) ? sw : 0.5) + 0.02 * env.wind * env.wind * 0.1;
    }
    env.hs = clamp(hs, 0, 6);
  }

  // ----------------------------------------------------------------------------------------------- the beds
  // dt: real seconds since the last bed update; sdt: simulated seconds (0 while paused).
  function updateBeds(dt, sdt) {
    const hm = ctx.heightmap;
    const sd = hm?.shoreDistance?.(L.x, L.z);
    env.shore = Number.isFinite(sd) ? sd : 1000;
    const groundY = env.ctx.onFoot ? Number(S().terrain?.heightAt?.(L.x, L.z) ?? hm?.heightAt?.(L.x, L.z)) || 0 : 0;
    env.ctx = listenerContext({ camMode: S().cameraRig?.mode, control: ctx.state.control, camY: L.y, groundY });
    const interior = env.ctx.interior;

    // Sea: a slow swell breathing through the deep layer and a lagging surge in the surf layer.
    const p = oceanParams({ shoreDist: env.shore, camHeight: env.ctx.height, hs: env.hs, windSpeed: env.wind, interior });
    env.ocean = p;
    const t = ac.currentTime;
    const w1 = Math.sin(2 * Math.PI * p.swellHz * t);
    const w2 = Math.sin(2 * Math.PI * p.swellHz * 1.618 * t + 1.3);
    const w3 = Math.sin(2 * Math.PI * p.swellHz * 0.53 * t + 4.1);
    const sw = 0.5 + 0.5 * (0.6 * w1 + 0.25 * w2 + 0.15 * w3);
    const sl = 0.5 + 0.5 * (0.6 * Math.sin(2 * Math.PI * p.swellHz * (t - 1.1)) + 0.4 * w2);
    const lp = lapStep(lapper, dt, p.lapRate, rnd);
    beds.setOcean(p, { deep: 1 - p.swellDepth * (1 - sw), surf: 1 - Math.min(0.85, p.swellDepth * 1.5) * (1 - sl), lap: lp * (0.7 + 0.3 * sw) });

    // Wind with gusts; rigging whistle on deck, leaves on foot.
    gust = gustStep(gust, dt, rnd());
    const wp = windParams({ windSpeed: env.wind, gust: gust.value, camHeight: env.ctx.height, interior, onFoot: env.ctx.onFoot });
    beds.setWind(wp);
    beds.whistle.need(wp.whistleGain, dt)?.set(wp, gust.value);
    const fol = env.ctx.onFoot ? env.forest * 0.055 * (0.25 + smoothstep(1, 14, env.wind * (0.7 + 0.6 * gust.value))) : 0;
    beds.foliage.need(fol, dt)?.set(fol);

    // Rain (the wheelhouse roof drums).
    const rp = rainParams({ rain: env.rain, interior });
    beds.rain.need(rp.patterGain + rp.hissGain, dt)?.set(rp, interior);

    // Settlements.
    const st = env.settlement;
    const hum = st.hum * TUNING.harbor.hum * (1 - 0.5 * interior);
    const mach = st.machinery * 0.018 * (1 - 0.5 * interior);
    beds.harbor.need(hum + mach, dt)?.set(hum, mach);

    // Streams (heard close by, mostly on foot).
    const sm = env.stream;
    const sLevel = sm ? 0.1 * smoothstep(260, 40, sm.distance) : 0;
    const sb = beds.stream.need(sLevel, dt);
    if (sb && sm) {
      sb.em.setPos(sm.item.x, 1, sm.item.z);
      sb.set(sLevel);
    }

    updateBoat(dt, sdt, interior);
    updateSkiff(dt, sdt);
    updateGear(dt, sdt);
    updateFleet(dt, sdt);
  }

  // Main engine, genset, hull wash, hull slaps.
  function updateBoat(dt, simDt, interior) {
    const s = S().seiner;
    if (!s?.position) {
      beds.main.set(dieselVoice(eng.main), 0);
      return;
    }
    const title = env.mode === 'title';
    const running = title || !s.mooring;
    const fishing = S().fishing?.state ?? 'idle';
    const demand = fishing === 'pursing' ? 0.5 : fishing === 'hauling' ? 0.42 : fishing === 'brailing' ? 0.3 : 0;
    const throttle = title ? 0.55 : Number(s.throttle) || 0;
    const load = title ? 0.5 : clamp(Number(s.engineLoad) || 0, 0, 1);
    const ev = engineStep(eng.main, { throttle, load, running, demand }, DIESELS.main, simDt);
    const ex = s.position.x;
    const ey = (s.position.y ?? 0) + 3;
    const ez = s.position.z;
    if (ev === 'start' && !title) player.play('starter', { position: pos(ex, ey, ez), volume: 0.9 });
    const d = distTo(ex, ey, ez);
    const v = dieselVoice(eng.main, DIESELS.main);
    beds.main.em.setPos(ex, ey, ez);
    beds.main.em.setDistance(d, ac.currentTime);
    const fuelRough = S().economy?.fuelEmpty && !ctx.state.freeExplore ? 0.05 : 0.009;
    beds.main.set(v, TUNING.engine.main, { muffle: interior * 0.62, jitter: fuelRough });

    // Generator while the main engine is off (anchored, tied up).
    const gs = eng.main.phase === 'off' && eng.main.rpm < 100 && !title ? TUNING.engine.genset : 0;
    const g = beds.genset.need(gs, dt);
    if (g) {
      g.em.setPos(ex, ey - 1, ez);
      g.em.setDistance(d, ac.currentTime);
      g.set(gs);
    }

    // Bow wave and wake rush.
    const hw = hullWashParams(s.speed ?? 0);
    const hb = beds.hullWash.need(d < 400 ? hw.gain : 0, dt);
    if (hb) {
      if (typeof s.bowPoint === 'function') s.bowPoint(tmp);
      else tmp.set(ex, 0, ez);
      hb.em.setPos(tmp.x, 0.5, tmp.z);
      hb.em.setDistance(distTo(tmp.x, 0.5, tmp.z), ac.currentTime);
      const surge = 0.75 + 0.35 * Math.sin(ac.currentTime * 2.1) * Math.sin(ac.currentTime * 0.77);
      hb.set(hw, surge);
    }

    // Slaps: the bow landing at the bottom of each pitch, or soft lapping at rest.
    if (simDt > 0 && d < 90) {
      const pitch = Number(s.pitch);
      if (Number.isFinite(pitch)) {
        if (pitchPrev !== null) {
          const rate = (pitch - pitchPrev) / simDt;
          if (rate < 0) pitchMin = Math.min(pitchMin, rate);
          else if (pitchMin < 0) {
            const sgt = slapStrength({ pitchRate: -pitchMin, speed: s.speed ?? 0, hs: env.hs });
            if (sgt > 0) {
              if (typeof s.bowPoint === 'function') s.bowPoint(tmp);
              player.play('hull-slap', { position: pos(tmp.x, 0.3, tmp.z), params: { strength: sgt }, rate: 0.9 + 0.2 * rnd(), volume: 1 - 0.4 * interior });
            }
            pitchMin = 0;
          }
        }
        pitchPrev = pitch;
      }
      // Blocks, shackles and the boom knocking as she rolls at rest.
      const roll = Number(s.roll);
      if (Number.isFinite(roll) && Math.abs(s.speed ?? 0) < 1.5) {
        if (rollPrev !== null) {
          const rr0 = roll - rollPrev;
          timers.rig -= simDt;
          if (rollDir !== 0 && Math.sign(rr0) !== rollDir && Math.abs(rr0) < 0.02 && timers.rig <= 0 && rnd() < 0.35 * smoothstep(0.15, 1, env.hs)) {
            timers.rig = 2 + 4 * rnd();
            player.play('clink', { position: pos(ex + (rnd() - 0.5) * 4, ey + 4 + 4 * rnd(), ez + (rnd() - 0.5) * 4), rate: 0.55 + 0.25 * rnd(), volume: 0.7 * (1 - 0.5 * interior) });
          }
          if (Math.abs(rr0) > 1e-5) rollDir = Math.sign(rr0);
        }
        rollPrev = roll;
      }
      if (Math.abs(s.speed ?? 0) < 1.5) {
        timers.lap -= simDt;
        if (timers.lap <= 0) {
          timers.lap = poissonWait(lapInterval(env.hs));
          const a = rnd() * Math.PI * 2;
          const h = s.heading ?? 0;
          const along = (rnd() - 0.5) * 14;
          const x = ex + Math.sin(h) * along + Math.cos(a) * 2.5;
          const z = ez - Math.cos(h) * along + Math.sin(a) * 2.5;
          player.play('hull-slap', { position: pos(x, 0.2, z), params: { strength: 0.15 + 0.35 * smoothstep(0.1, 1.2, env.hs) * rnd(), soft: true }, rate: 0.9 + 0.3 * rnd(), volume: 1 - 0.5 * interior });
        }
      }
    }
  }

  function updateSkiff(dt, simDt) {
    const sk = S().skiff;
    const st = sk?.state;
    const eff = Number.isFinite(sk?.effort) ? sk.effort : skiffEffortFor(st);
    const effort = clamp(Number(eff) || 0, 0, 1);
    // A skiff lying at the beach (waiting for a hiker) shuts down after a while.
    const parked = Math.abs(Number(sk?.speed) || 0) < 0.3 && effort < 0.08;
    skiffParked = parked ? skiffParked + simDt : 0;
    const running = !!sk?.position && st !== 'stowed' && st !== 'tied' && eff !== null && eff !== undefined && skiffParked < 10;
    const ev = engineStep(eng.skiff, { throttle: effort, load: effort * 0.8, running }, DIESELS.skiff, simDt);
    const x = sk?.position?.x ?? 0;
    const y = (sk?.position?.y ?? 0) + 0.8;
    const z = sk?.position?.z ?? 0;
    if (ev === 'start') player.play('starter', { position: pos(x, y, z), rate: 1.35, volume: 0.7, params: { dur: 0.6 } });
    const b = beds.skiff.need(eng.skiff.on > 0.002 ? eng.skiff.on : 0, dt);
    if (b) {
      b.em.setPos(x, y, z);
      b.em.setDistance(distTo(x, y, z), ac.currentTime);
      b.set(dieselVoice(eng.skiff, DIESELS.skiff), TUNING.engine.skiff);
    }
  }

  // Hydraulics (purse winch, power block, brailer whip), corks through the block, the bag and the brailer.
  function updateGear(dt, simDt) {
    const f = S().fishing;
    const s = S().seiner;
    const net = S().net;
    const state = f?.state ?? 'idle';
    if (state !== fishingPrev) {
      onFishingState(state, fishingPrev);
      fishingPrev = state;
    }
    let mode = null;
    let rate = 0;
    const hauled = Number(net?.hauled);
    const dh = Number.isFinite(hauled) && hauledPrev !== null && simDt > 0 ? (hauled - hauledPrev) / simDt : 0;
    if (Number.isFinite(hauled)) hauledPrev = hauled;
    if (state === 'pursing') {
      mode = 'purse';
      const tension = Number(f?.hud?.tension);
      rate = f?.hud?.stall ? 0.12 : Number.isFinite(tension) ? clamp(0.25 + tension, 0, 1.2) : 0.6;
    } else if (state === 'hauling') {
      mode = 'haul';
      rate = clamp(0.35 + dh * 30, 0.2, 1.4);
    } else if (state === 'brailing') {
      mode = 'haul';
      brailT += simDt;
      // The whip hoists after each scoop (fishing:brail, see cues.js); water hauls never scoop, so it idles.
      rate = brailWhipRate(ac.currentTime - shared.brailAt, f?.brailer?.cycle);
    } else if (state === 'report' && net?.state && net.state !== 'stowed') {
      mode = 'haul';
      rate = 0.3;
    } else if (state === 'setting' && s) {
      mode = 'pay';
      rate = clamp(Math.abs(s.speed ?? 0) / 6, 0, 1.2);
    }
    const hp = hydraulicParams({ mode: mode === 'pay' ? null : mode, rate, engineRpm: eng.main.rpm || 1200 });
    const hb = beds.hydraulics.need(hp.gain, dt);
    if (s?.position) {
      if (mode === 'haul' && typeof s.powerBlockPoint === 'function') s.powerBlockPoint(tmp);
      else if (mode === 'pay' && typeof s.sternPoint === 'function') s.sternPoint(tmp);
      else tmp.set(s.position.x, (s.position.y ?? 0) + 2, s.position.z);
    }
    if (hb && s?.position) {
      hb.em.setPos(tmp.x, tmp.y, tmp.z);
      hb.em.setDistance(distTo(tmp.x, tmp.y, tmp.z), ac.currentTime);
      hb.set(hp);
    }

    // Corks and rings clacking over the stern roller / through the block.
    const corkRate = mode === 'pay' ? Math.min(6, rate * 5) : mode === 'haul' && state === 'hauling' ? hydraulicParams({ mode, rate }).corkRate : 0;
    if (corkRate > 0.05 && simDt > 0 && s?.position) {
      timers.cork -= simDt;
      if (timers.cork <= 0) {
        timers.cork = poissonWait(1 / corkRate);
        player.play('cork', { position: pos(tmp.x, tmp.y, tmp.z), rate: 0.85 + 0.3 * rnd(), volume: mode === 'pay' ? 0.7 : 0.9 });
      }
    }

    // The seine rushing off the stern while setting; purse rings knocking along the purse line while pursing.
    const payLevel = mode === 'pay' ? 0.22 * smoothstep(0.3, 5, Math.abs(s?.speed ?? 0)) : 0;
    const pb = beds.payout.need(payLevel, dt);
    if (pb && s?.position) {
      pb.em.setPos(tmp.x, tmp.y, tmp.z);
      pb.em.setDistance(distTo(tmp.x, tmp.y, tmp.z), ac.currentTime);
      pb.set(payLevel, Math.abs(s.speed ?? 0));
    }
    if (mode === 'purse' && simDt > 0 && s?.position) {
      timers.ring -= simDt;
      if (timers.ring <= 0) {
        timers.ring = 0.5 + 1.6 * rnd() / Math.max(0.3, rate);
        player.play('clunk', { position: pos(tmp.x, tmp.y, tmp.z), params: { strength: 0.18 + 0.15 * rnd() }, rate: 1.5 + 0.4 * rnd(), volume: 0.8 });
      }
    }

    // The bag boiling with thrashing fish as it dries up alongside (brailer scoops and dumps: fishing:brail in cues.js).
    // While brailing it empties with the brailed pounds; a water haul's bag is empty.
    let bagLevel = 0;
    if (state === 'hauling' && Number.isFinite(hauled)) bagLevel = 0.32 * smoothstep(0.5, 0.9, hauled);
    else if (state === 'brailing') {
      const accepted = Number(f?.hud?.acceptedLbs);
      const prog = clamp(Number(f?.hud?.brailProgress) || 0, 0, 1);
      if (Number.isFinite(accepted)) bagLevel = accepted > 0 ? 0.3 * Math.max(0.2, 1 - prog) : 0;
      else bagLevel = 0.3 * Math.max(0.25, 1 - brailT / 14);
    }
    const bg = beds.bag.need(bagLevel, dt);
    if (bg && s?.position) {
      const bp = bagPoint(s, net);
      bg.em.setPos(bp.x, 0.3, bp.z);
      bg.em.setDistance(distTo(bp.x, 0.3, bp.z), ac.currentTime);
      bg.set(bagLevel);
    }
  }

  // Where the dried-up bag lies: the net's bag centroid pulled in toward the hull (as WP-NET's brailer reaches it).
  function bagPoint(s, net) {
    if (typeof net?.bagCentroid === 'function' && net.bagCentroid(bagXZ)) {
      const dx = bagXZ.x - s.position.x;
      const dz = bagXZ.z - s.position.z;
      const d = Math.hypot(dx, dz) || 1;
      const reach = Math.min(d, 8);
      return { x: s.position.x + (dx / d) * reach, z: s.position.z + (dz / d) * reach };
    }
    const h = (s.heading ?? 0) + Math.PI / 2;
    return { x: s.position.x + Math.sin(h) * 6, z: s.position.z - Math.cos(h) * 6 };
  }

  function updateFleet(dt, simDt) {
    for (let i = 0; i < 2; i++) {
      const slot = env.fleet[i];
      const b = slot?.item;
      const id = b?.id ?? null;
      if (id !== eng.fleetIds[i]) {
        eng.fleetIds[i] = id;
        eng.fleet[i] = newEngineState();
      }
      const st = eng.fleet[i];
      const speed = Math.abs(Number(b?.speed) || 0);
      const running = !!b && (speed > 0.3 || b.state !== 'anchored');
      engineStep(st, { throttle: clamp(speed / 9, 0, 1), load: clamp(speed / 10, 0, 1), running }, DIESELS.fleet, simDt);
      const big = b && (b.kind === 'tender' || b.kind === 'ferry' || b.kind === 'cutter' || b.type === 'tender' || b.type === 'ferry' || b.type === 'cutter');
      const level = b ? st.on * TUNING.engine.fleet * (big ? 1.2 : 1) : 0;
      const e = beds.fleet[i].need(level, dt);
      if (e && b) {
        const y = (b.position.y ?? 0) + 3;
        e.em.setPos(b.position.x, y, b.position.z);
        e.em.setDistance(distTo(b.position.x, y, b.position.z), ac.currentTime);
        const v = dieselVoice(st, DIESELS.fleet);
        if (big) v.cycleHz *= 0.72;
        e.set(v, level);
      }
    }
  }

  // ------------------------------------------------------------------------------------------ world one-shots
  function updateWorld(dt) {
    // Surf breaking on the nearest beach.
    const p = env.ocean;
    if (p && p.washLevel > 0.015) {
      timers.surf -= dt;
      if (timers.surf <= 0) {
        timers.surf = washInterval(env.hs, rnd());
        ctx.heightmap.shoreGradient?.(L.x, L.z, grad);
        const sp = shorePoint(L.x, L.z, env.shore, grad);
        if (sp) {
          const seabed = ctx.heightmap.seabedAt?.(sp.x + grad.x * 12, sp.z + grad.z * 12);
          player.play('surf-break', { params: { level: clamp(p.washLevel, 0, 1), gravel: beachGravel(seabed) }, pan: panOf(sp.x, sp.z) });
        }
      }
    }

    // Gulls around the boat, over working birds and in the harbour.
    const g = env.gulls;
    const harborGulls = env.settlement.gulls;
    if (g.count > 0 || harborGulls > 0.15) {
      timers.gull -= dt;
      if (timers.gull <= 0) {
        timers.gull = poissonWait(gullInterval({ near: g.near, working: g.working, swarm: g.swarm, harbor: harborGulls, daylight: env.daylight }));
        let at = null;
        if (g.count > 0) {
          const b = g.sources[Math.floor(rnd() * g.count)];
          at = pos(b.position.x, b.position.y ?? 10, b.position.z);
        } else if (env.settlement.place) {
          const hp = harborPoint(env.settlement.place, rnd);
          at = pos(hp.x, 12 + 15 * rnd(), hp.z);
        }
        if (at) player.play('gull', { position: at, params: { excited: g.working > 0.25 || g.swarm }, rate: 0.92 + 0.16 * rnd() });
      }
    }

    // Bald eagle chitter.
    if (env.eagle) {
      timers.eagle -= dt;
      if (timers.eagle <= 0) {
        timers.eagle = 14 + 40 * rnd();
        const b = env.eagle.item;
        player.play('eagle', { position: pos(b.position.x, b.position.y ?? 20, b.position.z), rate: 0.95 + 0.1 * rnd() });
      }
    }

    // Bears: pouncing splashes at the stream mouth, the odd huff.
    if (env.bear) {
      const b = env.bear.item;
      const bx = b.position.x;
      const bz = b.position.z;
      const by = b.position.y ?? 0;
      if (b.state === 'fishing') {
        timers.bearSplash -= dt;
        if (timers.bearSplash <= 0) {
          timers.bearSplash = 5 + 14 * rnd();
          player.play('splash', { position: pos(bx, by, bz), params: { size: 1.2 + 0.8 * rnd() }, volume: 0.8 });
        }
      }
      if (env.bear.distance < 160) {
        timers.bearHuff -= dt;
        if (timers.bearHuff <= 0) {
          timers.bearHuff = 30 + 60 * rnd();
          player.play('bear-huff', { position: pos(bx, by + 1, bz), params: { huffs: 1 + Math.floor(rnd() * 2), intensity: 0.45, pops: 0 } });
        }
      }
    }

    // Sea lions roaring on a haulout; up to 3.5x as hard for a while after a stampede (wildlife:disturbed, cues.js).
    if (env.haulout) {
      const st = shared.stampede;
      const left = st && (st.id === env.haulout.item.id || st.id === null) ? (st.until - ac.currentTime) / 90 : 0;
      const rate = sealionRate(env.haulout.distance, env.haulout.members) * (1 + 2.5 * clamp(left, 0, 1));
      if (rate > 0.03) {
        timers.sealion -= dt;
        if (timers.sealion <= 0) {
          timers.sealion = poissonWait(1 / rate);
          const h = env.haulout.item;
          player.play('sealion', { position: pos(h.x + (rnd() - 0.5) * 50, 2, h.z + (rnd() - 0.5) * 50), params: { bull: rnd() < 0.3 }, rate: 0.9 + 0.2 * rnd() });
        }
      }
    }

    // Halyards slapping masts in a harbour.
    if (env.settlement.clink > 0.1 && env.settlement.place) {
      timers.clink -= dt;
      if (timers.clink <= 0) {
        timers.clink = poissonWait(1 / Math.max(0.05, env.settlement.clink * TUNING.harbor.clinkRate * (0.6 + env.wind / 12)));
        const hp = harborPoint(env.settlement.place, rnd);
        player.play('clink', { position: pos(hp.x, 6 + 4 * rnd(), hp.z), rate: 0.9 + 0.2 * rnd() });
      }
    }

    // A lighthouse diaphone in thick fog.
    if (env.light) {
      timers.fog -= dt;
      if (timers.fog <= 0) {
        timers.fog = 30;
        const li = env.light.item;
        player.play('foghorn', { position: pos(li.x, 20, li.z), volume: 0.7 });
      }
    }
  }

  // ------------------------------------------------------------------------------------------------- music
  function updateMusic() {
    const now = ac.currentTime;
    const current = music.finished ? null : music.cue;
    const cue = musicCue({ mode: env.mode, hours: ctx.clock.hours, day: ctx.clock.day, fishing: S().fishing?.state ?? 'idle', dawnDay, triumphUntil: shared.triumphUntil, now, current });
    if (cue === 'dawn' && current !== 'dawn') dawnDay = ctx.clock.day;
    if (cue !== current || (music.finished && cue === null)) music.setCue(cue);
    music.tick();
  }

  // -------------------------------------------------------------------------------------------------- events
  function onFishingState(state, prev) {
    const s = S().seiner;
    const at = s?.position ? pos(s.position.x, (s.position.y ?? 0) + 2, s.position.z) : null;
    if (state === 'pursing' && at) player.play('clunk', { position: at, params: { strength: 0.8, hiss: true } });
    if (prev === 'pursing' && state === 'hauling' && at) player.play('rings-up', { position: at });
    if (state === 'brailing') brailT = 0;
    if (state === 'idle') hauledPrev = null;
  }

  function resetWorld(keepRadio = false) {
    const radioLive = keepRadio && shared.radioBusyUntil > ac.currentTime;
    if (!radioLive) player.stopAll();
    pitchPrev = null;
    pitchMin = 0;
    rollPrev = null;
    hauledPrev = null;
    for (const k of ['surf', 'gull', 'sealion', 'clink', 'lap']) timers[k] = 0.5 + rnd();
  }

  const cues = createCues(ctx, { ac, player, mixer, L, shared, panOf, resetWorld });

  return {
    env,
    L,
    eng,
    // Game events arrive here through audio.js (see cues.js).
    event: (name, p) => cues.event(name, p),
    clickedRecently: () => cues.clickedRecently(),
    attachDom: () => cues.attachDom(),

    frame(realDt) {
      env.mode = ctx.state.mode;
      updateListener();
      mixer.setMuffle(muffleFor(env.mode));
      slowAcc += realDt;
      if (slowAcc >= 1 / SLOW_HZ) {
        slowAcc = 0;
        scanSlow();
      }
      hsAcc += realDt;
      if (hsAcc >= 0.5) {
        hsAcc = 0;
        sampleSea();
      }
      bedAcc += realDt;
      simAcc += ctx.time.dt;
      if (bedAcc >= 1 / BED_HZ) {
        updateBeds(bedAcc, simAcc);
        bedAcc = 0;
        simAcc = 0;
      }
      if (living() && realDt > 0) updateWorld(realDt);
      cues.tick(realDt);
      updateMusic();
      player.collect();
      meterAcc += realDt;
      if (meterAcc >= 0.2) {
        meterAcc = 0;
        mixer.sample();
      }
    },

    reset() {
      resetWorld();
      eng.main = newEngineState();
      eng.skiff = newEngineState();
      dawnDay = -1;
      shared.triumphUntil = -1;
      brailT = 0;
      fishingPrev = 'idle';
      shared.radioBusyUntil = 0;
      shared.brailAt = -1e9;
      shared.stampede = null;
      cues.clearRadio();
    },

    stats() {
      return {
        mode: env.mode,
        interior: env.ctx.interior,
        onFoot: env.ctx.onFoot,
        height: +env.ctx.height.toFixed(1),
        shore: Math.round(env.shore),
        hs: +env.hs.toFixed(2),
        wind: +env.wind.toFixed(1),
        gust: +gust.value.toFixed(2),
        rain: +env.rain.toFixed(2),
        settlement: env.settlement.place ? `${env.settlement.place.id} ${env.settlement.level.toFixed(2)}` : null,
        gulls: { near: +env.gulls.near.toFixed(2), working: +env.gulls.working.toFixed(2), swarm: env.gulls.swarm, sources: env.gulls.count },
        eagle: env.eagle ? Math.round(env.eagle.distance) : null,
        bear: env.bear ? Math.round(env.bear.distance) : null,
        haulout: env.haulout ? Math.round(env.haulout.distance) : null,
        stream: env.stream ? Math.round(env.stream.distance) : null,
        fleet: env.fleet.map((f) => `${f.item.id} ${Math.round(f.distance)}m`),
        engine: { phase: eng.main.phase, rpm: Math.round(eng.main.rpm), load: +eng.main.load.toFixed(2), on: +eng.main.on.toFixed(2) },
        skiff: { phase: eng.skiff.phase, rpm: Math.round(eng.skiff.rpm), on: +eng.skiff.on.toFixed(2) },
        ocean: env.ocean ? { deep: +env.ocean.deepGain.toFixed(3), surf: +env.ocean.surfGain.toFixed(3), wash: +env.ocean.washLevel.toFixed(3) } : null,
        dawnDay,
        triumph: shared.triumphUntil > ac.currentTime,
      };
    },

  };
}
