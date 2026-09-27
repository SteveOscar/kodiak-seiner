// The set, as a state machine (SPEC §6.12). DOM-free: constructible under Node with fake systems.
//
//   idle → setting → holding → closing → pursing → hauling → brailing → report → idle
//
// Offers go through ctx.interact (priority 100) only while control === 'boat'; speed limits and control locks use
// the seiner's owner APIs with owner 'fishing'. Every cross-system call tolerates stubs or missing systems.

import { FISHING_TUNING as T, NET_TUNING as NT } from '../../entities/net/tuning.js';
import { polylineDistance } from '../../entities/net/geom.js';
import { HINTS, PETE } from './hints.js';
import { createWinch } from './winch.js';
import {
  buildSetReport,
  emptyCatch,
  lbsOf,
  roundEstimate,
  sanitizeCatch,
  splitKings,
  totalFish,
} from './report.js';

const TAU = Math.PI * 2;
const wrapAngle = (a) => ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
const headingOf = (vx, vz) => Math.atan2(vx, -vz);
const fmt = (n) => Math.round(n).toLocaleString('en-US');

export function createFishingCore(ctx, { rng }) {
  const { THREE, events, config, heightmap } = ctx;
  const S = () => ctx.systems;
  const stern = new THREE.Vector3();
  const bow = new THREE.Vector3();
  const endP = new THREE.Vector3();
  const cur = { x: 0, z: 0 };
  const grad = { x: 0, z: 0 };
  const winch = createWinch();
  const hinted = new Set();
  const citeRng = rng.fork('citation');
  const noiseRng = rng.fork('estimate');

  let set = null; // the set in progress
  let warnedUntil = -1; // closed-waters warning: a second Space within this window sets anyway
  let msg = null;
  let msgT = 0;
  let backT = 0; // Backspace held
  let lastSnagCount = 0;
  let escapeOff = null;

  const hud = {
    phase: 'idle',
    payout: 0,
    distanceToSkiff: null,
    tension: 0,
    tensionBand: [...T.winch.band],
    pursed: 0,
    hauled: 0,
    inHook: 0,
    holdSeconds: 0,
    depthUnderStern: 0,
    bottomWarning: null,
    towHeading: 0,
    message: null,
    // Extras for the UI.
    setNumber: 0,
    hook: false,
    tied: false,
    closeReady: false,
    stall: null, // 'wheel' | 'snag' | 'foul' | null
    stallSeconds: 0,
    idealTowHeading: null,
    brailLbs: 0,
    brailFish: 0,
    brailProgress: 0,
    acceptedLbs: 0,
    abortProgress: 0,
    closedWater: false,
    wheelDanger: 0, // 0..1: stern closing on the corkline
  };

  const newStats = () => ({
    sets: 0,
    waterHauls: 0,
    fish: 0,
    lbs: 0,
    value: 0,
    bestSetLbs: 0,
    citations: 0,
    snags: 0,
    wraps: 0,
    fouls: 0,
    aborted: 0,
    kingsReleased: 0,
  });

  const core = {
    state: 'idle',
    setNumber: 0,
    lastSet: null,
    stats: newStats(),
    hud,
    winch,
    get set() {
      return set;
    },

    canSet() {
      const s = S().seiner;
      if (core.state !== 'idle') return { ok: false, reason: 'A set is under way' };
      if (ctx.state.control !== 'boat') return { ok: false, reason: 'Get back aboard first' };
      if (!s?.position) return { ok: false, reason: 'No boat' };
      const netState = S().net?.state ?? 'stowed';
      if (netState !== 'stowed') return { ok: false, reason: 'The seine is still in the water' };
      const sk = S().skiff;
      if (sk && sk.state !== 'stowed') return { ok: false, reason: 'The skiff is not aboard' };
      if (s.anchored) return { ok: false, reason: 'Pick up the anchor first' };
      if (s.grounded) return { ok: false, reason: 'Hard aground' };
      sternPoint(stern);
      const open = ctx.state.freeExplore || !!S().season?.openerActive?.(stern.x, stern.z);
      if (!open) return { ok: false, reason: closedReason() };
      const depth = heightmap.depthAt(stern.x, stern.z);
      if (depth <= T.minDepth) return { ok: false, reason: `Too shallow to set: ${depth.toFixed(1)} m (need ${T.minDepth} m)` };
      return { ok: true, reason: null };
    },

    // Haul back and call it a water haul.
    abort() {
      if (!set || core.state === 'idle' || core.state === 'report') return false;
      if (core.state === 'brailing') {
        finishSet();
        return true;
      }
      set.aborting = true;
      set.abortT = 0;
      S().seiner?.lockControls?.('fishing', true);
      S().seiner?.setSpeedLimit?.('fishing', T.speed.pursing);
      const sk = S().skiff;
      if (sk && !S().net?.closed && sk.state !== 'stowed' && sk.state !== 'returning') {
        safe(() => sk.returnTo(() => {}));
      }
      toast('Haul it back — water haul', 'warn');
      enter('hauling');
      return true;
    },

    update(dt) {
      if (msgT > 0) msgT = Math.max(0, msgT - dt);
      if (msgT <= 0) msg = null;
      const playing = ctx.state.mode === 'play';
      if (dt > 0 && playing) {
        if (set) {
          set.phaseT += dt;
          set.elapsed += dt;
        }
        step(dt);
        backspace(dt);
      }
      refreshHud();
    },

    reset() {
      hardStop();
      core.setNumber = 0;
      core.lastSet = null;
      core.stats = newStats();
      hinted.clear();
      warnedUntil = -1;
    },

    serialize() {
      return { setNumber: core.setNumber, lastSet: core.lastSet, stats: { ...core.stats } };
    },

    restore(d) {
      if (!d) return;
      core.setNumber = Number.isFinite(d.setNumber) ? d.setNumber : 0;
      core.lastSet = d.lastSet ?? null;
      core.stats = { ...newStats(), ...(d.stats ?? {}) };
    },

    // Teleports, loads and title returns end any set instantly (no report).
    hardStop,

    // Scripting helpers for smoke scenarios and tests.
    debug: {
      auto: { purse: false, haul: false },
      letGo: (opts = {}) => letGo({ tie: !!opts.tie, force: opts.force !== false, confirm: true }),
      tieOff: () => tieOff(),
      holdHook: () => holdHook(),
      closeUp: () => startClose(),
      finishClose: () => finishClose(),
      ringsUp: () => ringsUp(),
      brail: () => startBrail(),
      finishBrail: () => set && (set.brailT = set.brailDur),
      trueInside: () => trueInside(),
    },
  };

  // --- helpers -----------------------------------------------------------------------------------------------

  function safe(fn) {
    try {
      return fn();
    } catch (err) {
      console.warn('[fishing] neighbour call failed:', err?.message ?? err);
      return undefined;
    }
  }

  function sternPoint(out) {
    const s = S().seiner;
    if (typeof s?.sternPoint === 'function') return s.sternPoint(out);
    const p = s?.position ?? { x: 0, y: 0, z: 0 };
    const h = s?.heading ?? 0;
    return out.set(p.x - Math.sin(h) * 8.8, p.y + 1.5, p.z + Math.cos(h) * 8.8);
  }

  function clockHours() {
    return ctx.clock.day * 24 + ctx.clock.hours;
  }

  function closedReason() {
    const n = safe(() => S().season?.nextOpener?.());
    if (n && Number.isFinite(n.day)) {
      const date = ctx.clock.date(n.day).label;
      const h = n.hours ?? config.time.openerStart;
      const when = n.day === ctx.clock.day ? `today at ${ctx.clock.timeLabel(h)}` : `${date}, ${ctx.clock.timeLabel(h)}`;
      return `Waters closed — next opener ${when}`;
    }
    return 'Waters closed — no opener scheduled';
  }

  function isClosedWater(x, z) {
    if (ctx.state.freeExplore) return false;
    return !!safe(() => S().season?.isClosedWater?.(x, z));
  }

  function setMessage(text, seconds = 3.5) {
    msg = text;
    msgT = seconds;
    hud.message = text;
  }

  function toast(text, kind = 'info', duration = 3.5) {
    const ui = S().ui;
    if (ui?.toast) safe(() => ui.toast(text, { kind, duration }));
    else events.emit('ui:toast', { text, kind, duration });
  }

  function radio(from, text, channel = '10') {
    const ui = S().ui;
    if (ui?.radio) safe(() => ui.radio(from, text, channel));
    else events.emit('ui:radio', { from, text, channel });
  }

  function hint(key) {
    if (!tutorialActive() || hinted.has(key)) return;
    hinted.add(key);
    events.emit('ui:hint', { id: `pete-${key}`, text: HINTS[key], from: PETE });
  }

  function tutorialActive() {
    return core.stats.sets === 0 && core.setNumber <= 1;
  }

  function enter(state) {
    const prev = core.state;
    if (prev === state) return;
    core.state = state;
    if (set) set.phaseT = 0;
    refreshHud();
    events.emit('fishing:state', { state, prev });
  }

  function seinerNear(px, pz) {
    const s = S().seiner;
    if (!s?.position) return Infinity;
    sternPoint(stern);
    if (typeof s.bowPoint === 'function') s.bowPoint(bow);
    else bow.copy(s.position);
    return Math.min(
      Math.hypot(px - stern.x, pz - stern.z),
      Math.hypot(px - s.position.x, pz - s.position.z),
      Math.hypot(px - bow.x, pz - bow.z),
    );
  }

  function skiffEndXZ() {
    const g = S().net?.gap?.();
    if (g) return g.a;
    const sk = S().skiff;
    if (typeof sk?.endPoint === 'function') {
      sk.endPoint(endP);
      return { x: endP.x, z: endP.z };
    }
    return null;
  }

  function trueInside() {
    const net = S().net;
    const poly = net?.polygon?.();
    if (!poly) return 0;
    const schools = safe(() => S().fish?.schoolsInside?.(poly)) ?? [];
    let n = 0;
    for (const sc of schools) {
      if (!sc || sc.state === 'captured' || sc.state === 'gone') continue;
      n += Number.isFinite(sc.count) ? sc.count : totalFish(sc.mix);
    }
    return n;
  }

  // ±30% estimate that wanders slowly through the set.
  function estimate() {
    if (!set) return 0;
    const n = trueInside();
    const t = set.elapsed;
    const e = Math.sin(t * 0.21 + set.noise[0]) * 0.6 + Math.sin(t * 0.47 + set.noise[1]) * 0.4;
    return roundEstimate(n * (1 + T.estimateNoise * e * 0.95));
  }

  function beachPointFrom(x, z) {
    const sd = heightmap.shoreDistance(x, z);
    heightmap.shoreGradient(x, z, grad);
    let px = x - grad.x * (sd + 2);
    let pz = z - grad.z * (sd + 2);
    for (let k = 0; k < 12 && heightmap.heightAt(px, pz) < 0.1; k++) {
      px -= grad.x * 2.5;
      pz -= grad.z * 2.5;
    }
    const y = Math.max(0, S().terrain?.heightAt?.(px, pz) ?? heightmap.heightAt(px, pz));
    return new THREE.Vector3(px, y, pz);
  }

  function inTieRange(x, z) {
    const sd = heightmap.shoreDistance(x, z);
    return sd > 0 && sd <= T.tieOffRange;
  }

  // --- transitions --------------------------------------------------------------------------------------------

  // force: skip canSet (debug); confirm: the closed-waters warning was already given.
  function letGo({ tie = false, force = false, confirm = false } = {}) {
    if (core.state !== 'idle') return false;
    const cs = core.canSet();
    if (!cs.ok && !force) {
      setMessage(cs.reason);
      return false;
    }
    const s = S().seiner;
    if (!s?.position) return false;
    sternPoint(stern);
    const closed = isClosedWater(stern.x, stern.z);
    if (closed && !confirm && ctx.time.elapsed > warnedUntil) {
      warnedUntil = ctx.time.elapsed + 6;
      setMessage('Closed waters! Space again to set anyway — the troopers may cite you', 6);
      toast('Inside the closed-waters markers', 'warn', 5);
      hint('closed');
      return false;
    }
    core.setNumber += 1;
    set = {
      number: core.setNumber,
      startClock: clockHours(),
      startElapsed: ctx.time.elapsed,
      elapsed: 0,
      phaseT: 0,
      drop: { x: stern.x, z: stern.z },
      closedWater: closed,
      tied: false,
      hook: false,
      holdSeconds: 0,
      noise: [noiseRng.range(0, TAU), noiseRng.range(0, TAU)],
      estimateCache: 0,
      estimateT: 0,
      towTarget: null,
      closeT: 0,
      arrived: false,
      wheelT: 0,
      wheelStall: 0,
      towHeading: s.heading ?? 0,
      escaped: 0,
      harvest: null,
      brailT: 0,
      brailDur: 0,
      cited: false,
      fine: 0,
      aborting: false,
      aborted: false,
      skiffHome: false,
      reportT: 0,
      closedEstimate: 0,
    };
    const sk = S().skiff;
    if (sk?.release) safe(() => sk.release());
    const net = S().net;
    let began = false;
    if (net?.begin) began = safe(() => net.begin(sk?.endPoint ? sk : { x: stern.x, z: stern.z })) !== false;
    if (!began && net?.begin) safe(() => net.begin({ x: stern.x, z: stern.z }));
    s.setSpeedLimit?.('fishing', T.speed.setting);
    safe(() => S().cameraRig?.suggest?.('crowsnest'));
    events.emit('fishing:skiffReleased', { x: stern.x, z: stern.z });
    toast("Let 'er go!", 'fishing', 2.5);
    enter('setting');
    hint('letgo');
    if (tie) tieOff();
    lastSnagCount = net?.snagCount ?? 0;
    return true;
  }

  function tieOff() {
    if (!set || set.tied || (core.state !== 'setting' && core.state !== 'holding')) return false;
    const e = skiffEndXZ() ?? set.drop;
    const beach = beachPointFrom(e.x, e.z);
    const sk = S().skiff;
    if (sk?.tieOff) safe(() => sk.tieOff(beach));
    set.tied = true;
    set.hook = true;
    set.tiePoint = { x: beach.x, z: beach.z };
    toast('Skiff end tied off to the beach', 'fishing', 3);
    return true;
  }

  function holdHook() {
    if (!set || core.state !== 'setting') return false;
    S().net?.holdEnd?.();
    set.hook = true;
    enterHolding();
    return true;
  }

  function enterHolding() {
    set.holdSeconds = 0;
    set.towTarget = null;
    S().seiner?.setSpeedLimit?.('fishing', T.speed.holding);
    enter('holding');
    hint(set.hook ? 'hook' : 'hold');
  }

  function startClose() {
    if (!set || (core.state !== 'setting' && core.state !== 'holding')) return false;
    const net = S().net;
    if (net?.state === 'paying') net.holdEnd?.();
    set.closeT = 0;
    set.arrived = false;
    const s = S().seiner;
    s?.setSpeedLimit?.('fishing', T.speed.closing);
    const sk = S().skiff;
    if (sk?.closeTo) {
      safe(() =>
        sk.closeTo(s?.object3d ?? s?.position, () => {
          if (set) set.arrived = true;
        }),
      );
    }
    toast('Close up!', 'fishing', 2.5);
    enter('closing');
    return true;
  }

  function finishClose() {
    if (!set || core.state !== 'closing') return false;
    const net = S().net;
    const est = estimate();
    net?.close?.();
    set.closedEstimate = est;
    const poly = net?.polygon?.();
    events.emit('fishing:closedUp', { polygon: poly ? poly.map((p) => ({ x: p.x, z: p.z })) : null, estimate: est });
    toast(est > 0 ? `Closed up — looks like ~${fmt(est)} in the net` : 'Closed up — not much showing inside', 'fishing', 4);
    // The skiff runs a line to the far side from the net body and pulls the seiner off it.
    const side = net?.bodySide ?? net?.side ?? 1;
    const s = S().seiner;
    set.towHeading = wrapAngle((s?.heading ?? 0) - side * (Math.PI / 2));
    const sk = S().skiff;
    if (sk?.towOff) safe(() => sk.towOff(s, side > 0 ? 'port' : 'starboard'));
    safe(() => sk?.setTowHeading?.(set.towHeading));
    s?.lockControls?.('fishing', true);
    s?.setSpeedLimit?.('fishing', T.speed.pursing);
    winch.reset();
    set.wheelT = 0;
    set.wheelStall = 0;
    enter('pursing');
    hint('purse');
    return true;
  }

  function ringsUp() {
    if (!set || core.state !== 'pursing') return false;
    toast('Rings up!', 'fishing', 3);
    setMessage('Rings up!', 2.5);
    enter('hauling');
    S().net?.haul?.(haulRate(false));
    hint('ringsUp');
    return true;
  }

  function startBrail() {
    if (!set || core.state !== 'hauling' || set.aborting) return false;
    const net = S().net;
    net?.brail?.();
    const species = config.fish.species;
    const harvest = sanitizeCatch(safe(() => S().fish?.harvest?.()) ?? emptyCatch());
    const { keep, released: kings } = splitKings(harvest, species);
    set.harvest = harvest;
    set.kings = kings;
    // Closed waters: a trooper may be watching.
    if (set.closedWater && !ctx.state.freeExplore && citeRng.chance(T.citation.chance)) {
      set.cited = true;
      set.fine = T.citation.fine;
      set.forfeited = keep;
      set.accepted = emptyCatch();
      set.overflow = emptyCatch();
      const boat = S().seiner?.boatName ?? 'Northern Dawn';
      radio(
        'AWT P/V Enforcer',
        `${boat}, Alaska Wildlife Troopers vessel Enforcer on one-six. You set inside the closed-waters markers. Stand by for boarding — your catch is seized.`,
        '16',
      );
      safe(() => S().economy?.addCash?.(-set.fine, 'Closed-waters citation'));
      toast(`Cited for fishing closed waters — $${fmt(set.fine)} fine, catch forfeited`, 'warn', 6);
    } else {
      set.forfeited = emptyCatch();
      const r = totalFish(keep) > 0 ? safe(() => S().economy?.addCatch?.(keep)) : null;
      set.accepted = sanitizeCatch(r?.accepted ?? keep);
      set.overflow = sanitizeCatch(r?.overflow ?? emptyCatch());
    }
    set.acceptedLbs = lbsOf(set.accepted, species);
    const loads = set.acceptedLbs / config.net.phases.brailLoadLbs;
    set.brailDur =
      set.acceptedLbs > 0
        ? Math.min(config.net.phases.brailMaxS, Math.max(2, loads * config.net.phases.brailPerLoadS))
        : 2.5;
    set.brailT = 0;
    const over = totalFish(set.overflow);
    if (over > 0) {
      setMessage(`Plugged! Let ${fmt(over)} go over the corks`, 6);
      toast(`Plugged! Hold's full — let ${fmt(over)} go over the corks`, 'warn', 6);
    }
    if (kings.king > 0) toast(`Released ${kings.king} king${kings.king > 1 ? 's' : ''} over the side`, 'info', 4);
    enter('brailing');
    hint(totalFish(harvest) >= T.waterHaulFish ? 'brail' : 'waterHaul');
    return true;
  }

  function finishSet() {
    if (!set) return;
    const species = config.fish.species;
    const season = S().season;
    const priceFor = (k) => safe(() => season?.priceFor?.(k)) ?? species[k]?.price ?? 0;
    const payload = buildSetReport({
      setNumber: set.number,
      caught: set.aborted ? emptyCatch() : set.harvest ?? emptyCatch(),
      accepted: set.aborted ? emptyCatch() : set.accepted ?? emptyCatch(),
      overflow: set.overflow ?? emptyCatch(),
      kingsReleased: set.kings ?? emptyCatch(),
      forfeited: set.forfeited ?? emptyCatch(),
      speciesTable: species,
      priceFor,
      minutes: (clockHours() - set.startClock) * 60,
      cited: set.cited,
      fine: set.fine,
      aborted: set.aborted,
      escaped: set.escaped,
    });
    core.lastSet = payload;
    const st = core.stats;
    st.sets++;
    if (payload.waterHaul) st.waterHauls++;
    if (payload.cited) st.citations++;
    if (payload.aborted) st.aborted++;
    st.fish += totalFish(payload.accepted);
    st.lbs += payload.totalLbs;
    st.value += payload.value;
    st.bestSetLbs = Math.max(st.bestSetLbs, payload.totalLbs);
    st.kingsReleased += set.kings?.king ?? 0;
    events.emit('fishing:setComplete', payload);
    const s = S().seiner;
    s?.lockControls?.('fishing', false);
    s?.setSpeedLimit?.('fishing', null);
    const sk = S().skiff;
    if (sk && sk.state !== 'stowed' && sk.state !== 'returning') {
      safe(() =>
        sk.returnTo(() => {
          if (set) set.skiffHome = true;
        }),
      );
    }
    set.reportT = 0;
    enter('report');
  }

  function hardStop() {
    const was = core.state;
    const s = S().seiner;
    s?.lockControls?.('fishing', false);
    s?.setSpeedLimit?.('fishing', null);
    if (was !== 'idle' || set) {
      safe(() => S().net?.stow?.());
      const sk = S().skiff;
      if (sk && sk.state !== 'stowed') safe(() => sk.stow?.());
    }
    set = null;
    msg = null;
    msgT = 0;
    backT = 0;
    winch.reset();
    if (was !== 'idle') {
      core.state = 'idle';
      events.emit('fishing:state', { state: 'idle', prev: was });
    }
  }

  // --- per-state behaviour -----------------------------------------------------------------------------------

  function offer(o) {
    if (ctx.state.control !== 'boat') return;
    ctx.interact?.offer?.({ priority: 100, ...o });
  }

  function haulRate(boost) {
    const mod = S().economy?.modifiers?.haulRate ?? 1;
    return (NT.haul.bagTarget / NT.haul.seconds) * mod * (boost ? NT.haul.boost : 1);
  }

  function steerTow(dt) {
    const steer = ctx.input?.axis?.('steer') ?? 0;
    set.towHeading = wrapAngle(set.towHeading + steer * T.towTurnRate * dt);
    safe(() => S().skiff?.setTowHeading?.(set.towHeading));
  }

  // Stern over the corkline (away from the ends made fast alongside) for > 3 s puts the net in the wheel.
  function wheelCheck(dt) {
    const net = S().net;
    const sim = net?.model?.sim;
    if (!sim || sim.count < 20) return;
    sternPoint(stern);
    const d = polylineDistance(stern.x, stern.z, sim.x, sim.z, 8, sim.count - 7);
    hud.wheelDanger = Math.max(0, Math.min(1, 1 - (d - T.wheel.distance) / 6));
    if (set.wheelStall > 0) {
      set.wheelStall = Math.max(0, set.wheelStall - dt);
      return;
    }
    if (d < T.wheel.distance) set.wheelT += dt;
    else set.wheelT = Math.max(0, set.wheelT - dt * 2);
    if (set.wheelT > T.wheel.seconds) {
      set.wheelT = 0;
      set.wheelStall = T.wheel.stall;
      core.stats.wraps++;
      setMessage("Net's in the wheel! Clearing it…", T.wheel.stall);
      toast("Net's in the wheel!", 'warn', 4);
      safe(() => S().cameraRig?.shake?.(0.5));
      hint('tow');
    } else if (set.wheelT > 0.8) {
      hint('tow');
    }
  }

  function snagCheck() {
    const net = S().net;
    const n = net?.snagCount ?? 0;
    if (n > lastSnagCount) {
      lastSnagCount = n;
      core.stats.snags++;
      const p = net.snagPoint ?? { x: 0, z: 0 };
      events.emit('fishing:snag', { x: p.x, z: p.z });
      setMessage('Hung up on the bottom! Pursing stalled', 6);
      toast('Hung up on the rocks!', 'warn', 4);
    }
  }

  function step(dt) {
    const s = S().seiner;
    const net = S().net;
    switch (core.state) {
      case 'idle': {
        const cs = core.canSet();
        if (cs.ok) {
          sternPoint(stern);
          const closed = isClosedWater(stern.x, stern.z);
          const warned = ctx.time.elapsed <= warnedUntil;
          offer({
            id: 'fishing-letgo',
            key: 'action',
            label: closed && !warned ? "Let 'er go! (closed waters)" : "Let 'er go!",
            onPress: () => letGo({ confirm: closed && warned }),
          });
          // Only while under way: stopped off a beach, E belongs to "Go ashore".
          if (inTieRange(stern.x, stern.z) && Math.abs(s?.speed ?? 0) > T.tieOffMinSpeed) {
            offer({
              id: 'fishing-letgo-tie',
              key: 'interact',
              label: "Let 'er go — tie off to the beach",
              onPress: () => letGo({ tie: true, confirm: closed && warned }),
            });
          }
          if (tutorialActive() && s?.position) {
            const near = safe(() => S().fish?.nearestSchool?.(s.position.x, s.position.z, 700));
            if (near?.school) hint('spot');
          }
        }
        break;
      }
      case 'setting': {
        s?.setSpeedLimit?.('fishing', T.speed.setting);
        const frac = net?.length ? net.payout / net.length : 0;
        const e = skiffEndXZ();
        const dSkiff = e ? seinerNear(e.x, e.z) : Infinity;
        if (net?.state === 'out') {
          enterHolding();
          break;
        }
        const closeReady = frac >= 0.45 && dSkiff <= config.net.closeDistance;
        set.closeReady = closeReady;
        if (closeReady) {
          offer({ id: 'fishing-close', key: 'action', label: 'Close up!', onPress: startClose });
          hint('closeReady');
        } else if (frac >= T.holdEligible) {
          offer({ id: 'fishing-hold', key: 'action', label: 'Hold the hook', onPress: holdHook });
        }
        if (!set.tied && frac < 0.5 && e && inTieRange(e.x, e.z)) {
          offer({ id: 'fishing-tieoff', key: 'interact', label: 'Tie off to the beach', onPress: tieOff });
        }
        if (frac > 0.25) hint('circle');
        if (frac > 0.6 && dSkiff < 70) hint('closeReady');
        break;
      }
      case 'holding': {
        s?.setSpeedLimit?.('fishing', T.speed.holding);
        set.holdSeconds += dt;
        // An untied skiff tows its end up-current to keep the net open.
        const sk = S().skiff;
        if (!set.tied && sk?.towToward) {
          const e = skiffEndXZ();
          if (e) {
            ctx.tide?.currentAt?.(e.x, e.z, cur);
            const sp = Math.hypot(cur.x, cur.z);
            if (!set.towTarget || set.phaseT - (set.towTargetT ?? 0) > 20) {
              const k = sp > 0.02 ? 18 / sp : 0;
              set.towTarget = { x: e.x - cur.x * k, z: e.z - cur.z * k };
              set.towTargetT = set.phaseT;
            }
            safe(() => sk.towToward(set.towTarget.x, set.towTarget.z, Math.max(0.3, Math.min(1, sp / 0.35))));
          }
        }
        offer({ id: 'fishing-close', key: 'action', label: 'Close up!', onPress: startClose });
        if (set.hook && set.tied && !set.tieHinted) set.tieHinted = true;
        if ((net?.hookHealth ?? 1) < T.hookCollapse && set.holdSeconds > 3) {
          if (!msg) setMessage("The hook's collapsing — close up!", 3);
          hint('collapse');
        }
        break;
      }
      case 'closing': {
        s?.setSpeedLimit?.('fishing', T.speed.closing);
        set.closeT += dt;
        const e = skiffEndXZ();
        const d = e ? seinerNear(e.x, e.z) : 0;
        set.closeGap = d;
        if (!set.arrived && e && d < T.close.arriveDistance) set.arrived = true;
        // A skiff running its end in from the beach (hook) may take a while: time out only once it is close, so its
        // end never jumps across open water.
        const near = d < T.close.nearDistance;
        if ((set.arrived && set.closeT >= T.close.minSeconds) || (near && set.closeT >= T.close.timeout) || set.closeT >= T.close.hardTimeout) {
          finishClose();
        }
        break;
      }
      case 'pursing': {
        steerTow(dt);
        wheelCheck(dt);
        snagCheck();
        const held = !!ctx.input?.action?.('interact') || core.debug.auto.purse && autoHold();
        offer({ id: 'fishing-purse', key: 'interact', label: 'Hold to run the purse winch', hold: true });
        const stalled = set.wheelStall > 0 || !!net?.snagged;
        const extraLoad = net?.snagged ? 0.45 : 0.08 * (net?.bottomContact ?? 0);
        const r = winch.step(dt, { held: held && set.wheelStall <= 0, pursed: net?.pursed ?? 0, extraLoad });
        if (r.fouled) {
          core.stats.fouls++;
          setMessage('Rings fouled! Ease off the winch', T.winch.foulStall + 0.5);
          toast('Rings fouled!', 'warn', 3);
        }
        const mod = S().economy?.modifiers?.purseRate ?? 1;
        const rate = stalled ? 0 : NT.purse.base * mod * r.efficiency;
        net?.purse?.(rate);
        if ((net?.pursed ?? 0) >= 1) ringsUp();
        break;
      }
      case 'hauling': {
        if (set.aborting) {
          set.abortT += dt;
          net?.haul?.(1 / (NT.haul.abortSeconds * 0.8));
          const sim = net?.model?.sim;
          if (set.abortT >= NT.haul.abortSeconds || !net || (sim && sim.count <= 3)) {
            set.aborted = true;
            finishSet();
          }
          break;
        }
        steerTow(dt);
        wheelCheck(dt);
        const held = !!ctx.input?.action?.('interact') || core.debug.auto.haul;
        offer({ id: 'fishing-haul', key: 'interact', label: 'Hold to speed up the block', hold: true });
        const rate = set.wheelStall > 0 ? 0 : haulRate(held);
        net?.haul?.(rate);
        if (net?.corksUnder && !msg) setMessage('Corks going under — ease off the block!', 2);
        if (!net || (net.hauled ?? 1) >= NT.haul.bagTarget) startBrail();
        break;
      }
      case 'brailing': {
        set.brailT += dt;
        offer({ id: 'fishing-skip-brail', key: 'action', label: 'Skip brailing', onPress: () => (set.brailT = set.brailDur) });
        if (set.brailT >= set.brailDur) finishSet();
        break;
      }
      case 'report': {
        set.reportT += dt;
        const sk = S().skiff;
        if (net && net.state !== 'stowed') {
          net.haul?.(1 / NT.haul.finishSeconds);
          const sim = net.model?.sim;
          if (!sim || sim.count <= 3 || set.reportT > NT.haul.finishSeconds + 1.5) net.stow?.();
        }
        const home = !sk || sk.state === 'stowed' || set.skiffHome;
        if ((home && (!net || net.state === 'stowed')) || set.reportT > T.reportTimeout) {
          if (sk && sk.state !== 'stowed') safe(() => sk.stow?.());
          if (net && net.state !== 'stowed') net.stow?.();
          set = null;
          enter('idle');
        }
        break;
      }
    }
  }

  // Debug auto-winch: feathers E to keep the needle in the green band.
  function autoHold() {
    const [lo, hi] = winch.band;
    return winch.tension < lo + (hi - lo) * 0.55;
  }

  function backspace(dt) {
    if (core.state === 'idle' || core.state === 'report' || set?.aborting) {
      backT = 0;
      return;
    }
    if (ctx.input?.keyDown?.('Backspace')) {
      backT += dt;
      if (backT >= 1) {
        backT = 0;
        core.abort();
      }
    } else backT = 0;
  }

  function refreshHud() {
    const net = S().net;
    const s = S().seiner;
    hud.phase = core.state;
    hud.setNumber = core.setNumber;
    hud.payout = net?.length ? Math.min(1, (net.payout ?? 0) / net.length) : 0;
    hud.pursed = net?.pursed ?? 0;
    hud.hauled = net?.hauled ?? 0;
    hud.tension = core.state === 'pursing' ? winch.tension : 0;
    hud.tensionBand = winch.band;
    hud.hook = !!set?.hook;
    hud.tied = !!set?.tied;
    hud.closedWater = !!set?.closedWater;
    hud.abortProgress = backT;
    if (s?.position) {
      sternPoint(stern);
      hud.depthUnderStern = +heightmap.depthAt(stern.x, stern.z).toFixed(1);
    }
    const e = set ? skiffEndXZ() : null;
    hud.distanceToSkiff = e && core.state !== 'idle' ? Math.round(seinerNear(e.x, e.z)) : null;
    hud.closeReady = core.state === 'holding' || (core.state === 'setting' && !!set?.closeReady);
    hud.holdSeconds = set?.holdSeconds ?? 0;
    // In the hook / in the net estimate, refreshed twice a second.
    if (set && (core.state === 'setting' || core.state === 'holding' || core.state === 'closing')) {
      set.estimateT -= ctx.time.dt;
      if (set.estimateT <= 0) {
        set.estimateT = 0.5;
        set.estimateCache = estimate();
      }
      hud.inHook = set.estimateCache;
    } else if (set && (core.state === 'pursing' || core.state === 'hauling')) {
      hud.inHook = set.closedEstimate;
    } else hud.inHook = 0;
    // Bottom.
    const active = net && net.state !== 'stowed';
    if (active && (net.bottomContact ?? 0) > 0.08) {
      hud.bottomWarning = (net.rockFraction ?? 0) > 0.2 ? 'Leads on bottom — rocky!' : 'Leads on bottom';
    } else if (!active && s?.position && hud.depthUnderStern < (net?.depth ?? config.net.depth)) {
      hud.bottomWarning = heightmap.seabedAt(stern.x, stern.z) === 'rock' ? 'Rocky bottom — the lead will hang up' : null;
    } else hud.bottomWarning = null;
    // Skiff pull.
    if (set && (core.state === 'pursing' || core.state === 'hauling')) {
      hud.towHeading = set.towHeading;
      const sim = net?.model?.sim;
      if (sim && sim.count > 2 && s?.position) {
        const c = sim.centroid();
        const ax = stern.x - c.x;
        const az = stern.z - c.z;
        const al = Math.hypot(ax, az) || 1;
        ctx.tide?.currentAt?.(s.position.x, s.position.z, cur);
        hud.idealTowHeading = headingOf(ax / al - cur.x * 1.5, az / al - cur.z * 1.5);
      }
    } else {
      hud.towHeading = s?.heading ?? 0;
      hud.idealTowHeading = null;
    }
    // Stalls.
    hud.stall = null;
    hud.stallSeconds = 0;
    if (set?.wheelStall > 0) {
      hud.stall = 'wheel';
      hud.stallSeconds = set.wheelStall;
    } else if (net?.snagged) {
      hud.stall = 'snag';
      hud.stallSeconds = net.model?.snagTimer ?? 0;
    } else if (winch.stall > 0 && core.state === 'pursing') {
      hud.stall = 'foul';
      hud.stallSeconds = winch.stall;
    }
    // Brailing count-up.
    if (set && core.state === 'brailing') {
      const p = set.brailDur > 0 ? Math.min(1, set.brailT / set.brailDur) : 1;
      hud.brailProgress = p;
      hud.acceptedLbs = Math.round(set.acceptedLbs ?? 0);
      hud.brailLbs = Math.round((set.acceptedLbs ?? 0) * p);
      hud.brailFish = Math.round(totalFish(set.accepted) * p);
    } else if (core.state !== 'report') {
      hud.brailProgress = 0;
      hud.brailLbs = 0;
      hud.brailFish = 0;
    }
    hud.message = msg ?? guidance();
  }

  function guidance() {
    if (backT > 0.05) return 'Hold Backspace to abort the set…';
    switch (core.state) {
      case 'setting':
        if (hud.closeReady) return 'Alongside the skiff — close up!';
        return hud.payout < 0.2 ? 'Paying out — circle the school' : 'Bring her around to the skiff';
      case 'holding':
        return set?.hook ? 'Holding the hook' : 'Holding — close up when the fish are in';
      case 'closing':
        return (set?.closeGap ?? 0) > T.close.nearDistance ? 'Closing up — run down to meet the skiff' : 'Closing up — skiff bringing its end';
      case 'pursing':
        return 'Pursing — keep the tension in the green; A/D aim the skiff';
      case 'hauling':
        return set?.aborting ? 'Hauling back — water haul' : 'Hauling — drying up the bag';
      case 'brailing':
        return `Brailing — ${fmt(hud.brailLbs)} lbs aboard`;
      default:
        return null;
    }
  }

  escapeOff = events.on('fishing:escape', (e) => {
    if (set && Number.isFinite(e?.count)) set.escaped += e.count;
  });
  core.dispose = () => escapeOff?.();
  return core;
}
