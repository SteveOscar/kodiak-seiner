// Seiner helm and state rules, DOM-free: throttle lever, owner-keyed speed limits and control locks, mooring
// (anchor / dock), tow input from the skiff, the title autopilot, and the hull step. The seiner system wraps this
// with the model, water sampling and effects.
//
// Throttle is a lever: W/S nudge it (a tap = one 10% notch, holding slides it), it stays where it is left, and it
// stops at neutral when passing through (release and press again to go astern). A gamepad stick drives it directly.

import { createOwnerMap } from './ownerMap.js';
import { SEINER_TUNING, createHullState, resetMotion, stepHull, wrapAngle } from './handling.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function normalizeMooring(m) {
  if (!m || typeof m !== 'object') return null;
  if (m.kind === 'anchor') return { kind: 'anchor' };
  if (m.kind === 'dock') return { kind: 'dock', placeId: m.placeId ?? null };
  return null;
}

export function createSeinerController({ tuning = SEINER_TUNING, emit = () => {} } = {}) {
  const hull = createHullState();
  const limits = createOwnerMap();
  const locks = createOwnerMap();
  let mooring = null;
  let anchor = null;
  let lever = 0;
  let detent = 0; // +1 blocks further up-travel until the key is released, -1 down-travel
  let holdUp = 0;
  let holdDown = 0;
  const tow = { x: 0, z: 0, fresh: false };
  const cmd = { throttle: 0, steer: 0, maxSpeed: 12, reverseSpeed: 3, speedLimit: null, held: false, anchor: null, external: null };

  // Passing through neutral stops there; the same key must be released before the lever goes on.
  function moveLever(after) {
    const before = lever;
    if (before < 0 && after >= 0) {
      lever = 0;
      detent = 1;
    } else if (before > 0 && after <= 0) {
      lever = 0;
      detent = -1;
    } else {
      lever = clamp(after, -1, 1);
    }
  }

  function dropAnchor() {
    const fx = Math.sin(hull.heading);
    const fz = -Math.cos(hull.heading);
    const d = tuning.length * 0.45 + tuning.anchorScope * 0.72;
    anchor = { x: hull.x + fx * d, z: hull.z + fz * d };
  }

  const ctl = {
    hull,
    tuning,
    get lever() {
      return lever;
    },
    get anchorPoint() {
      return anchor;
    },
    get mooring() {
      return mooring;
    },
    get anchored() {
      return !!mooring;
    },
    get speedLimit() {
      return limits.min();
    },
    get controlsEnabled() {
      return locks.size() === 0;
    },
    lockOwners: () => locks.owners(),
    limitOwners: () => limits.owners(),

    setSpeedLimit(owner, mps) {
      limits.set(owner, typeof mps === 'number' && Number.isFinite(mps) ? Math.max(0, mps) : null);
    },

    lockControls(owner, locked) {
      locks.set(owner, locked ? true : null);
      if (locked) {
        lever = 0;
        detent = 0;
      }
    },

    // Emits boat:mooring only on an actual change of kind/place.
    setMooring(m, { silent = false } = {}) {
      const next = normalizeMooring(m);
      const same = (mooring === null && next === null) || (mooring && next && mooring.kind === next.kind && mooring.placeId === next.placeId);
      mooring = next;
      if (next?.kind === 'anchor') {
        if (!same || !anchor) dropAnchor();
      } else {
        anchor = null;
      }
      limits.set('mooring', next ? 0 : null);
      if (next) lever = 0;
      if (!same && !silent) emit('boat:mooring', { mooring: next });
      return next;
    },

    setPose(x, z, heading = hull.heading) {
      hull.x = x;
      hull.z = z;
      hull.heading = wrapAngle(heading);
      resetMotion(hull);
      hull.roll = hull.pitch = hull.heave = 0;
      lever = 0;
      detent = 0;
      if (mooring?.kind === 'anchor') dropAnchor();
    },

    // External velocity from the skiff pulling the seiner off the net (m/s, world x/z). Consumed on the next step.
    applyTow(vx, vz) {
      tow.x = vx;
      tow.z = vz;
      tow.fresh = true;
    },

    // Helm input for one frame. allowed = play mode, control 'boat', controls unlocked. Returns true when the player
    // applied throttle (which clears a mooring).
    helm({ up = false, down = false, upPressed = false, downPressed = false, pad = 0, allowed = true, dt = 0 }) {
      if (!allowed) {
        lever = 0;
        detent = 0;
        holdUp = holdDown = 0;
        return false;
      }
      let applied = false;
      if (Math.abs(pad) > 0.12) {
        lever = clamp(pad, -1, 1);
        detent = 0;
        applied = Math.abs(pad) > 0.3;
      } else {
        if (!up) holdUp = 0;
        if (!down) holdDown = 0;
        if (!up && detent > 0) detent = 0;
        if (!down && detent < 0) detent = 0;
        if (upPressed && !down) {
          if (detent !== 1) moveLever(Math.round((Math.floor(lever * 10 + 1e-6) / 10 + 0.1) * 100) / 100);
          applied = true;
        } else if (downPressed && !up) {
          if (detent !== -1) moveLever(Math.round((Math.ceil(lever * 10 - 1e-6) / 10 - 0.1) * 100) / 100);
          applied = true;
        }
        if (up && !down) {
          holdUp += dt;
          if (holdUp > 0.28 && detent !== 1) moveLever(lever + 0.62 * dt);
        } else if (down && !up) {
          holdDown += dt;
          if (holdDown > 0.28 && detent !== -1) moveLever(lever - 0.62 * dt);
        }
      }
      if (applied && mooring) ctl.setMooring(null);
      return applied;
    },

    // Advance the hull. opts: { steer, allowed, maxSpeed, reverseSpeed, autopilot: {heading, throttle}|null }.
    step(dt, env, opts = {}) {
      const allowed = opts.allowed !== false;
      cmd.maxSpeed = opts.maxSpeed ?? 12;
      cmd.reverseSpeed = opts.reverseSpeed ?? 3;
      cmd.speedLimit = limits.min();
      cmd.held = mooring?.kind === 'dock';
      cmd.anchor = mooring?.kind === 'anchor' ? anchor : null;
      if (opts.autopilot && !mooring) {
        const ap = opts.autopilot;
        cmd.throttle = ap.throttle ?? 0.4;
        cmd.steer = clamp(wrapAngle((ap.heading ?? hull.heading) - hull.heading) * 2.2, -1, 1);
      } else {
        cmd.throttle = allowed ? lever : 0;
        cmd.steer = allowed ? clamp(opts.steer ?? 0, -1, 1) : 0;
      }
      if (tow.fresh) {
        cmd.external = tow;
        tow.fresh = false;
      } else {
        cmd.external = null;
      }
      const events = stepHull(hull, cmd, env, dt, tuning);
      if (!cmd.external) tow.x = tow.z = 0;
      for (const e of events) emit('boat:collision', { speed: e.speed, x: e.x, z: e.z, kind: e.type });
      return events;
    },

    reset() {
      limits.clear();
      locks.clear();
      mooring = null;
      anchor = null;
      lever = 0;
      detent = 0;
      resetMotion(hull);
    },
  };
  return ctl;
}
