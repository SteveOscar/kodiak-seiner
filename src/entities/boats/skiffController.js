// Seine skiff behaviour, DOM-free. The skiff system supplies an env each step (seiner pose points, current, depth)
// and renders the pose; this module owns the state machine and the 2-D motion.
//
// States: 'stowed' | 'released' (sliding off the ramp) | 'holding' | 'tied' | 'towing' | 'closing' | 'towingOff' |
//         'returning' (incl. the winch up the ramp) | 'ferry'.
// Positions are {x, z}; headings follow the world convention (0 = north, clockwise).

import { hullWaypoint } from './hullRoute.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const approach = (v, t, tau, dt) => v + (t - v) * (1 - Math.exp(-dt / Math.max(1e-4, tau)));
const wrap = (a) => {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
};
const bearing = (fx, fz, tx, tz) => Math.atan2(tx - fx, -(tz - fz));

export const SKIFF_TUNING = Object.freeze({
  runSpeed: 6.5, // m/s running light
  ferrySpeed: 5.5,
  holdEffort: 0.3,
  turnRate: 1.5, // rad/s
  dropSeconds: 1.4,
  winchSeconds: 2.2,
  towLine: 24, // m from the seiner's bitt to the skiff's bitt when towing off
  towPull: 0.55, // m/s the seiner is pulled at full strain
  shoreDepth: 0.7, // stop this deep when running the end ashore / landing
  arriveRadius: 2.5,
  hullHalfLength: 9.3, // seiner hull capsule the skiff steers around (stem to centre, incl. rake)
  hullHalfBeam: 3.2,
  hullMargin: 3, // skiff centre to the seiner's side while passing
});

export function createSkiffController({ tuning = SKIFF_TUNING, emit = () => {} } = {}) {
  const T = tuning;
  const s = {
    state: 'stowed',
    x: 0,
    z: 0,
    heading: 0,
    speed: 0, // m/s along the heading (through the water)
    vx: 0,
    vz: 0,
    effort: 0, // 0..1 engine effort (visuals: squat, prop wash, exhaust)
    strain: 0, // 0..1 load on the towline / net end
    arrived: false,
    anim: 0, // 0..1 drop or winch progress
    animFrom: null, // {x, z, heading} where the winch started
    target: { x: 0, z: 0 },
    targetEffort: 0,
    towHeading: 0,
    towSide: 'port',
    tiePoint: null, // shore point for 'tied'
    follow: null, // () => {x, z}
    onArrive: null,
    pending: null, // command issued while the drop animation runs
    phase: '', // sub-phase within a state
    route: { side: 0 }, // side of the seiner a detour around its hull keeps to
    waypoint: null, // {x, z} being steered for while going round the hull, else null
  };
  const wpOut = { x: 0, z: 0, side: 0 };
  const wpKeep = { x: 0, z: 0 };
  const hull = { x: 0, z: 0, heading: 0, halfLength: T.hullHalfLength, halfBeam: T.hullHalfBeam };
  const hullOf = (sn) => {
    if (!sn) return null;
    hull.x = sn.x;
    hull.z = sn.z;
    hull.heading = sn.heading ?? 0;
    hull.halfLength = sn.halfLength ?? T.hullHalfLength;
    hull.halfBeam = sn.halfBeam ?? T.hullHalfBeam;
    return hull;
  };
  // Where to steer for on the way to (tx, tz): a waypoint round the seiner when the straight run crosses its hull.
  const steerFor = (tx, tz, sn) => {
    const wp = sn ? hullWaypoint(s.x, s.z, tx, tz, hullOf(sn), { margin: T.hullMargin, state: s.route }, wpOut) : null;
    s.waypoint = wp ? ((wpKeep.x = wp.x), (wpKeep.z = wp.z), wpKeep) : null;
    return wp;
  };

  const setState = (st) => {
    if (s.state !== st) {
      const prev = s.state;
      s.state = st;
      s.route.side = 0;
      emit('skiff:state', { state: st, prev });
    }
  };

  function fire() {
    const cb = s.onArrive;
    s.onArrive = null;
    if (cb) {
      try {
        cb();
      } catch (err) {
        console.error('[skiff] onArrive threw', err);
      }
    }
  }

  // Walks from (fx, fz) toward (tx, tz) and returns the last point that is at least `depth` deep, so the skiff noses
  // into the beach instead of driving up it.
  function landingPoint(fx, fz, tx, tz, depthAt, depth) {
    if (!depthAt || depthAt(tx, tz) >= depth) return { x: tx, z: tz };
    const len = Math.hypot(tx - fx, tz - fz);
    const n = Math.max(2, Math.ceil(len / 1.5));
    let last = { x: fx, z: fz };
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const x = fx + (tx - fx) * t;
      const z = fz + (tz - fz) * t;
      if (depthAt(x, z) < depth) break;
      last = { x, z };
    }
    return last;
  }

  const ctl = {
    s,
    tuning: T,
    get busy() {
      return (
        s.state === 'released' ||
        s.state === 'returning' ||
        ((s.state === 'closing' || s.state === 'ferry') && !s.arrived)
      );
    },

    release(env) {
      if (s.state !== 'stowed') return false;
      s.anim = 0;
      s.arrived = false;
      s.pending = null;
      s.effort = 0;
      s.speed = 0;
      if (env?.seiner) s.heading = env.seiner.heading;
      setState('released');
      return true;
    },

    holdAt(x, z) {
      if (s.state === 'released') {
        s.pending = () => ctl.holdAt(x, z);
        return;
      }
      if (s.state === 'stowed') return;
      s.target.x = x;
      s.target.z = z;
      s.arrived = false;
      s.follow = null;
      s.tiePoint = null;
      s.targetEffort = T.holdEffort;
      setState('holding');
    },

    towToward(x, z, effort = 0.6) {
      if (s.state === 'released') {
        s.pending = () => ctl.towToward(x, z, effort);
        return;
      }
      if (s.state === 'stowed') return;
      s.target.x = x;
      s.target.z = z;
      s.targetEffort = clamp(effort, 0, 1);
      s.arrived = false;
      s.follow = null;
      s.tiePoint = null;
      setState('towing');
    },

    tieOff(point, env) {
      if (!point) return;
      if (s.state === 'released') {
        s.pending = () => ctl.tieOff(point, env);
        return;
      }
      if (s.state === 'stowed') return;
      const lp = landingPoint(s.x, s.z, point.x, point.z, env?.depthAt, T.shoreDepth + 0.3);
      s.target.x = lp.x;
      s.target.z = lp.z;
      s.tiePoint = { x: point.x, z: point.z };
      s.arrived = false;
      s.follow = null;
      s.phase = 'run';
      setState('tied');
    },

    // follow: () => {x, z} (moving target, e.g. the seiner's quarter) or a fixed {x, z}.
    closeTo(follow, onArrive) {
      if (s.state === 'released') {
        s.pending = () => ctl.closeTo(follow, onArrive);
        return;
      }
      if (s.state === 'stowed') return;
      s.follow = typeof follow === 'function' ? follow : null;
      if (!s.follow && follow) {
        s.target.x = follow.x;
        s.target.z = follow.z;
      }
      s.onArrive = onArrive ?? null;
      s.arrived = false;
      s.tiePoint = null;
      setState('closing');
    },

    towOff(side = 'port', seinerHeading = 0) {
      if (s.state === 'stowed' || s.state === 'released') return;
      s.towSide = side === 'starboard' ? 'starboard' : 'port';
      s.towHeading = wrap(seinerHeading + (s.towSide === 'port' ? -Math.PI / 2 : Math.PI / 2));
      s.follow = null;
      s.tiePoint = null;
      s.arrived = false;
      s.phase = 'position';
      setState('towingOff');
    },

    setTowHeading(h) {
      if (Number.isFinite(h)) s.towHeading = wrap(h);
    },

    returnTo(onArrive) {
      if (s.state === 'stowed') {
        s.onArrive = onArrive ?? null;
        fire();
        return;
      }
      s.onArrive = onArrive ?? null;
      s.follow = null;
      s.tiePoint = null;
      s.arrived = false;
      s.phase = 'approach';
      s.anim = 0;
      setState('returning');
    },

    stow() {
      s.onArrive = null;
      s.follow = null;
      s.tiePoint = null;
      s.pending = null;
      s.arrived = true;
      s.anim = 1;
      s.speed = 0;
      s.effort = 0;
      s.strain = 0;
      setState('stowed');
    },

    ferry(from, to, onArrive, env) {
      if (from) {
        s.x = from.x;
        s.z = from.z;
      }
      const lp = to ? landingPoint(s.x, s.z, to.x, to.z, env?.depthAt, T.shoreDepth) : { x: s.x, z: s.z };
      s.target.x = lp.x;
      s.target.z = lp.z;
      s.route.side = 0;
      if (to) {
        // Head off round the anchored seiner when it lies between the skiff and the beach (or the ramp).
        const wp = steerFor(lp.x, lp.z, env?.seiner);
        s.heading = wp ? bearing(s.x, s.z, wp.x, wp.z) : bearing(s.x, s.z, to.x, to.z);
      }
      s.onArrive = onArrive ?? null;
      s.follow = null;
      s.tiePoint = null;
      s.arrived = false;
      s.speed = 0;
      s.pending = null;
      s.phase = 'run';
      setState('ferry');
    },

    // env: { seiner: {x, z, heading, speed, stern: {x,z}, mount: {x,z}, bitt(side) -> {x,z}}, current(x,z) -> {x,z},
    //        depthAt(x, z) }
    step(dt, env) {
      if (!(dt > 0)) return;
      dt = Math.min(dt, 0.1);
      const sn = env.seiner;
      const cur = env.current ? env.current(s.x, s.z) : { x: 0, z: 0 };
      let effortTarget = 0;
      let strainTarget = 0;
      let vx = 0;
      let vz = 0;

      // avoid: steer round the seiner's hull when it lies across the run (the remaining distance is then the way
      // round, so the skiff does not slow down at the waypoint).
      const drive = (tx, tz, maxSpeed, radius = T.arriveRadius, avoid = false) => {
        const dTarget = Math.hypot(tx - s.x, tz - s.z);
        let d = dTarget;
        let sx = tx;
        let sz = tz;
        const wp = avoid ? steerFor(tx, tz, sn) : null;
        if (!avoid) s.waypoint = null;
        if (wp) {
          sx = wp.x;
          sz = wp.z;
          d = Math.hypot(sx - s.x, sz - s.z) + Math.hypot(tx - sx, tz - sz);
        }
        if (d > 0.3) {
          const want = bearing(s.x, s.z, sx, sz);
          const err = wrap(want - s.heading);
          s.heading = wrap(s.heading + clamp(err, -T.turnRate * dt, T.turnRate * dt));
          const align = Math.max(0, Math.cos(err));
          const sp = Math.min(maxSpeed, 0.8 + d * 0.55) * (0.25 + 0.75 * align);
          s.speed = approach(s.speed, sp, 1.1, dt);
        } else {
          s.speed = approach(s.speed, 0, 0.6, dt);
        }
        const fx = Math.sin(s.heading);
        const fz = -Math.cos(s.heading);
        // Moving through the water; the helmsman crabs against the set so the track still ends on target.
        vx = fx * s.speed;
        vz = fz * s.speed;
        effortTarget = clamp(s.speed / maxSpeed, 0.15, 1);
        return dTarget <= radius;
      };

      // Station keeping: bow into the stream, thrust cancels it.
      const stationKeep = (x, z, effort) => {
        const into = Math.hypot(cur.x, cur.z) > 0.03 ? Math.atan2(-cur.x, cur.z) : s.heading;
        s.heading = wrap(s.heading + clamp(wrap(into - s.heading), -0.4 * dt, 0.4 * dt));
        s.speed = approach(s.speed, 0, 0.8, dt);
        vx = (x - s.x) * 0.8 - cur.x;
        vz = (z - s.z) * 0.8 - cur.z;
        effortTarget = effort;
      };

      switch (s.state) {
        case 'stowed':
          if (sn) {
            s.x = sn.mount.x;
            s.z = sn.mount.z;
            s.heading = sn.heading;
          }
          s.speed = 0;
          effortTarget = 0;
          break;

        case 'released': {
          s.anim = Math.min(1, s.anim + dt / T.dropSeconds);
          if (sn) {
            // Slide aft off the stern roller and settle 5 m behind the transom.
            const fx = Math.sin(sn.heading);
            const fz = -Math.cos(sn.heading);
            const k = s.anim * s.anim;
            const bx = sn.stern.x - fx * 5.5;
            const bz = sn.stern.z - fz * 5.5;
            s.x = sn.mount.x + (bx - sn.mount.x) * k;
            s.z = sn.mount.z + (bz - sn.mount.z) * k;
            s.heading = sn.heading;
          }
          if (s.anim >= 1) {
            emit('skiff:splash', { x: s.x, z: s.z });
            s.target.x = s.x;
            s.target.z = s.z;
            s.targetEffort = T.holdEffort;
            s.arrived = true;
            s.speed = 0;
            setState('holding');
            const p = s.pending;
            s.pending = null;
            if (p) p();
          }
          break;
        }

        case 'holding':
          if (!s.arrived && drive(s.target.x, s.target.z, T.runSpeed * 0.6, T.arriveRadius, true)) s.arrived = true;
          if (s.arrived) stationKeep(s.target.x, s.target.z, s.targetEffort);
          strainTarget = 0.25;
          break;

        case 'towing': {
          // Pull toward the target against the stream; the net end limits progress, so the skiff creeps.
          const want = bearing(s.x, s.z, s.target.x, s.target.z);
          const d = Math.hypot(s.target.x - s.x, s.target.z - s.z);
          if (d > 1) s.heading = wrap(s.heading + clamp(wrap(want - s.heading), -0.8 * dt, 0.8 * dt));
          const fx = Math.sin(s.heading);
          const fz = -Math.cos(s.heading);
          const e = s.targetEffort;
          const creep = d > 1.5 ? 0.25 + e * 0.9 : 0;
          s.speed = approach(s.speed, creep, 2, dt);
          vx = fx * s.speed + cur.x * (1 - e * 0.85);
          vz = fz * s.speed + cur.z * (1 - e * 0.85);
          effortTarget = 0.35 + e * 0.65;
          strainTarget = 0.35 + e * 0.65;
          break;
        }

        case 'tied':
          if (s.phase === 'run') {
            if (drive(s.target.x, s.target.z, T.runSpeed * 0.7, 1.8, true)) {
              s.phase = 'tied';
              s.arrived = true;
            }
          } else {
            // Nosed into the beach with the line ashore: hold station, bow to the tie point.
            const want = s.tiePoint ? bearing(s.x, s.z, s.tiePoint.x, s.tiePoint.z) : s.heading;
            s.heading = wrap(s.heading + clamp(wrap(want - s.heading), -0.5 * dt, 0.5 * dt));
            s.speed = approach(s.speed, 0, 0.6, dt);
            vx = (s.target.x - s.x) * 0.5;
            vz = (s.target.z - s.z) * 0.5;
            effortTarget = 0.08;
          }
          strainTarget = 0.2;
          break;

        case 'closing': {
          const t = s.follow ? s.follow() : s.target;
          if (t) {
            s.target.x = t.x;
            s.target.z = t.z;
          }
          if (!s.arrived) {
            if (drive(s.target.x, s.target.z, T.runSpeed * 0.75, 3.2, true)) {
              s.arrived = true;
              fire();
            }
          } else {
            // Alongside: ride with the target.
            const d = Math.hypot(s.target.x - s.x, s.target.z - s.z);
            vx = (s.target.x - s.x) * 1.2;
            vz = (s.target.z - s.z) * 1.2;
            if (sn) s.heading = wrap(s.heading + clamp(wrap(sn.heading - s.heading), -0.6 * dt, 0.6 * dt));
            s.speed = approach(s.speed, Math.min(3, d), 0.5, dt);
            effortTarget = 0.25;
          }
          strainTarget = 0.3;
          break;
        }

        case 'towingOff': {
          if (!sn) break;
          const bitt = sn.bitt(s.towSide);
          const fx = Math.sin(s.towHeading);
          const fz = -Math.cos(s.towHeading);
          const tx = bitt.x + fx * T.towLine;
          const tz = bitt.z + fz * T.towLine;
          if (s.phase === 'position') {
            if (drive(tx, tz, T.runSpeed * 0.7, 4, true)) s.phase = 'pull';
            strainTarget = 0.1;
          } else {
            // On the line: hold the tow heading at line's length, dragging the seiner.
            s.heading = wrap(s.heading + clamp(wrap(s.towHeading - s.heading), -0.9 * dt, 0.9 * dt));
            vx = (tx - s.x) * 1.4 + (sn.vx ?? 0);
            vz = (tz - s.z) * 1.4 + (sn.vz ?? 0);
            s.speed = approach(s.speed, 0.6, 1, dt);
            effortTarget = 0.9;
            strainTarget = 1;
          }
          break;
        }

        case 'returning': {
          if (!sn) {
            ctl.stow();
            break;
          }
          const fx = Math.sin(sn.heading);
          const fz = -Math.cos(sn.heading);
          if (s.phase === 'approach') {
            // Come up astern, lined up with the ramp.
            const ax = sn.stern.x - fx * 7;
            const az = sn.stern.z - fz * 7;
            if (drive(ax, az, T.runSpeed, 3, true)) {
              s.phase = 'winch';
              s.anim = 0;
              s.animFrom = { x: s.x, z: s.z, heading: s.heading };
            }
          } else {
            s.anim = Math.min(1, s.anim + dt / T.winchSeconds);
            const k = s.anim < 0.5 ? 2 * s.anim * s.anim : 1 - (-2 * s.anim + 2) ** 2 / 2;
            const f = s.animFrom;
            s.x = f.x + (sn.mount.x - f.x) * k;
            s.z = f.z + (sn.mount.z - f.z) * k;
            s.heading = wrap(f.heading + wrap(sn.heading - f.heading) * k);
            s.speed = 0;
            effortTarget = 0.1;
            if (s.anim >= 1) {
              const cb = s.onArrive;
              s.onArrive = null;
              ctl.stow();
              s.onArrive = cb;
              fire();
            }
          }
          break;
        }

        case 'ferry':
          if (!s.arrived) {
            if (drive(s.target.x, s.target.z, T.ferrySpeed, 2, true)) {
              s.arrived = true;
              s.phase = 'landed';
              fire();
            }
          } else {
            s.speed = approach(s.speed, 0, 0.5, dt);
            vx = (s.target.x - s.x) * 0.6;
            vz = (s.target.z - s.z) * 0.6;
            effortTarget = 0.05;
          }
          break;
        default:
          break;
      }

      const inWater = s.state !== 'stowed' && !(s.state === 'released') && !(s.state === 'returning' && s.phase === 'winch');
      if (inWater) {
        // Moving boats are carried by the stream too (station keeping above already cancels it).
        const carried = s.state === 'holding' || s.state === 'towing' || s.state === 'tied' || (s.state === 'closing' && s.arrived) || (s.state === 'towingOff' && s.phase === 'pull') || (s.state === 'ferry' && s.arrived);
        if (!carried) {
          vx += cur.x;
          vz += cur.z;
        }
        // Never drive onto the beach.
        if (env.depthAt) {
          const nx = s.x + vx * dt;
          const nz = s.z + vz * dt;
          const dn = env.depthAt(nx, nz);
          if (dn < 0.35 && dn < env.depthAt(s.x, s.z)) {
            vx = 0;
            vz = 0;
            s.speed = Math.min(s.speed, 0);
          }
        }
        s.x += vx * dt;
        s.z += vz * dt;
      }
      s.vx = vx;
      s.vz = vz;
      s.effort = approach(s.effort, effortTarget, 0.6, dt);
      s.strain = approach(s.strain, strainTarget, 0.8, dt);
    },

    // Seiner pull from the towline this frame (m/s world), or null.
    towPull() {
      if (s.state !== 'towingOff' || s.phase !== 'pull') return null;
      const k = T.towPull * s.strain;
      return { x: Math.sin(s.towHeading) * k, z: -Math.cos(s.towHeading) * k };
    },
  };
  return ctl;
}
