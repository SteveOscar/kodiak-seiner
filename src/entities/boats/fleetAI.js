// Fleet seiner behaviour, DOM-free. Each boat works its grounds on a loop: run to a spot, search, lay a round-haul
// set (skiff out, circle back laying corks), close up, purse, haul (the cork circle shrinks to the boat), brail,
// and every few sets run alongside the tender to deliver. When the fishery is closed (or at night) it anchors off the
// tender. Visual only: no fish are caught.
//
// world: { fishing: bool, route(from, to) -> { status: 'running'|'done'|'failed', path }, current(x, z),
//          water(x, z) -> depth-and-clearance ok (bool), player: {x, z} | null }

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrap = (a) => {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
};
const bearing = (ax, az, bx, bz) => Math.atan2(bx - ax, -(bz - az));

export const FLEET_TUNING = Object.freeze({
  cruise: 9.5,
  searchSpeed: 3,
  setSpeed: 5.6,
  setRadius: 58,
  corkSpacing: 2.6,
  turnRate: 0.32,
  accel: 0.7,
  decel: 1.2,
  purse: [28, 40],
  haul: [45, 60],
  brail: [14, 20],
  search: [14, 34],
  deliver: [60, 95],
  setsPerDelivery: [2, 4],
});

export function createFleetBoatAI({ id, name, spots, tender, anchorage, rng = Math.random, tuning = FLEET_TUNING, start = null }) {
  const T = tuning;
  const range = ([a, b]) => a + (b - a) * rng();
  const s = {
    id,
    name,
    x: start?.x ?? spots[0]?.x ?? 0,
    z: start?.z ?? spots[0]?.z ?? 0,
    heading: start?.heading ?? rng() * TAU,
    speed: 0,
    targetSpeed: 0,
    state: 'plan',
    t: 0,
    dur: 0,
    after: null,
    path: null,
    seg: 0,
    req: null,
    spot: -1,
    setsDone: 0,
    setsBeforeDelivery: Math.round(range(T.setsPerDelivery)),
    set: null,
    skiff: { out: false, x: 0, z: 0, heading: 0, speed: 0 },
    corks: [],
    corks0: null,
    anchored: false,
    yield: 0,
  };

  function steer(targetHeading, targetSpeed, dt) {
    const err = wrap(targetHeading - s.heading);
    const rate = T.turnRate * clamp(0.35 + s.speed / 6, 0.35, 1.2);
    s.heading = wrap(s.heading + clamp(err, -rate * dt, rate * dt));
    const ts = targetSpeed * (0.35 + 0.65 * Math.max(0, Math.cos(err)));
    const a = ts > s.speed ? T.accel : T.decel;
    s.speed += clamp(ts - s.speed, -a * dt, a * dt);
  }

  function move(dt, world, carried = 1) {
    const c = world.current ? world.current(s.x, s.z) : { x: 0, z: 0 };
    s.x += Math.sin(s.heading) * s.speed * dt + c.x * dt * carried;
    s.z += -Math.cos(s.heading) * s.speed * dt + c.z * dt * carried;
  }

  function go(to, after, world) {
    s.req = world.route({ x: s.x, z: s.z }, to);
    s.after = after;
    s.state = 'route';
    s.t = 0;
  }

  function enter(state, dur = 0) {
    s.state = state;
    s.t = 0;
    s.dur = dur;
  }

  // Lay out a circle to one side that stays in open water.
  function planSet(world) {
    for (const dir of rng() < 0.5 ? [1, -1] : [-1, 1]) {
      for (const R of [T.setRadius, T.setRadius * 0.8]) {
        const rx = Math.cos(s.heading) * dir;
        const rz = Math.sin(s.heading) * dir;
        const cx = s.x + rx * R;
        const cz = s.z + rz * R;
        let ok = true;
        for (let i = 0; i < 12 && ok; i++) {
          const a = (i / 12) * TAU;
          if (!world.water(cx + Math.cos(a) * (R + 8), cz + Math.sin(a) * (R + 8))) ok = false;
        }
        if (ok) {
          return { cx, cz, R, dir, a0: Math.atan2(s.z - cz, s.x - cx), swept: 0, laid: 0, lastX: s.x, lastZ: s.z };
        }
      }
    }
    return null;
  }

  function releaseSkiff() {
    s.skiff.out = true;
    s.skiff.x = s.x - Math.sin(s.heading) * 11;
    s.skiff.z = s.z + Math.cos(s.heading) * 11;
    s.skiff.heading = s.heading + Math.PI;
    s.skiff.speed = 0;
    s.corks = [{ x: s.skiff.x, z: s.skiff.z }];
  }

  function skiffTo(tx, tz, speed, dt) {
    const d = Math.hypot(tx - s.skiff.x, tz - s.skiff.z);
    if (d > 0.5) {
      const h = bearing(s.skiff.x, s.skiff.z, tx, tz);
      s.skiff.heading = wrap(s.skiff.heading + clamp(wrap(h - s.skiff.heading), -1.2 * dt, 1.2 * dt));
      const v = Math.min(speed, d * 0.8);
      s.skiff.speed = v;
      s.skiff.x += Math.sin(s.skiff.heading) * v * dt;
      s.skiff.z += -Math.cos(s.skiff.heading) * v * dt;
    } else s.skiff.speed = 0;
    return d;
  }

  const ai = {
    s,
    step(dt, world) {
      s.t += dt;
      // Give way to the player.
      let slow = 1;
      if (world.player && s.speed > 1) {
        const dx = world.player.x - s.x;
        const dz = world.player.z - s.z;
        const d = Math.hypot(dx, dz);
        const ahead = (dx * Math.sin(s.heading) - dz * Math.cos(s.heading)) / Math.max(1, d);
        if (d < 70 && ahead > 0.3) {
          slow = clamp((d - 25) / 45, 0.15, 1);
          s.yield = dx * Math.cos(s.heading) + dz * Math.sin(s.heading) > 0 ? -0.35 : 0.35;
        } else s.yield *= 0.95;
      }

      switch (s.state) {
        case 'plan': {
          s.anchored = false;
          if (!world.fishing) {
            go(anchorage, 'anchor', world);
          } else if (s.setsDone >= s.setsBeforeDelivery && tender) {
            const side = rng() < 0.5 ? 1 : -1;
            const off = tender.beam / 2 + 5;
            const tx = tender.x + Math.cos(tender.heading) * off * side;
            const tz = tender.z + Math.sin(tender.heading) * off * side;
            s.deliverSide = side;
            go({ x: tx - Math.sin(tender.heading) * 30, z: tz + Math.cos(tender.heading) * 30 }, 'approach', world);
          } else {
            let i = Math.floor(rng() * spots.length);
            if (i === s.spot && spots.length > 1) i = (i + 1) % spots.length;
            s.spot = i;
            go(spots[i], 'search', world);
          }
          break;
        }
        case 'route': {
          const st = s.req?.status;
          steer(s.heading, 0, dt);
          move(dt, world);
          if (st === 'done') {
            s.path = s.req.path;
            s.seg = 1;
            s.req = null;
            enter('run');
          } else if (st === 'failed' || s.t > 20) {
            s.req = null;
            s.path = null;
            enter(world.fishing ? 'search' : 'anchor', world.fishing ? range(T.search) : 0);
          }
          break;
        }
        case 'run': {
          const p = s.path;
          if (!p || s.seg >= p.length) {
            enter(s.after ?? 'plan', s.after === 'search' ? range(T.search) : 0);
            break;
          }
          const w = p[s.seg];
          const d = Math.hypot(w.x - s.x, w.z - s.z);
          const last = s.seg === p.length - 1;
          if (d < (last ? 12 : 30)) {
            s.seg++;
            break;
          }
          const sp = last ? clamp(d / 12, 2.5, T.cruise) : T.cruise;
          steer(bearing(s.x, s.z, w.x, w.z) + s.yield, sp * slow, dt);
          move(dt, world);
          break;
        }
        case 'search': {
          // Slow looping while the skipper looks for jumpers.
          const spot = spots[Math.max(0, s.spot)] ?? { x: s.x, z: s.z };
          const d = Math.hypot(spot.x - s.x, spot.z - s.z);
          const h = d > 90 ? bearing(s.x, s.z, spot.x, spot.z) : s.heading + 0.25;
          steer(h + s.yield, T.searchSpeed * slow, dt);
          move(dt, world);
          if (s.t > s.dur && s.speed > 1.5) {
            const plan = planSet(world);
            if (plan) {
              s.set = plan;
              releaseSkiff();
              enter('set');
            } else {
              s.t = 0;
              s.dur = range(T.search);
            }
          }
          break;
        }
        case 'set': {
          const st = s.set;
          const ang = Math.atan2(s.z - st.cz, s.x - st.cx);
          // Tangent heading around the circle (dir +1 = starboard turn / clockwise).
          const tangent = st.dir > 0 ? bearing(0, 0, -Math.sin(ang), Math.cos(ang)) : bearing(0, 0, Math.sin(ang), -Math.cos(ang));
          const rErr = Math.hypot(s.x - st.cx, s.z - st.cz) - st.R;
          steer(tangent + clamp(rErr * 0.02, -0.3, 0.3) * st.dir, T.setSpeed, dt);
          move(dt, world, 0);
          const step = Math.hypot(s.x - st.lastX, s.z - st.lastZ);
          if (step >= T.corkSpacing) {
            const bx = s.x - Math.sin(s.heading) * 9;
            const bz = s.z + Math.cos(s.heading) * 9;
            s.corks.push({ x: bx, z: bz });
            st.lastX = s.x;
            st.lastZ = s.z;
            st.laid += step;
          }
          st.swept = Math.abs(wrap(ang - st.a0));
          const home = Math.hypot(s.skiff.x - s.x, s.skiff.z - s.z);
          if ((st.laid > st.R * 4 && home < 26) || st.laid > st.R * 7.5) enter('close');
          break;
        }
        case 'close': {
          const d = skiffTo(s.x, s.z, 2.5, dt);
          steer(bearing(s.x, s.z, s.skiff.x, s.skiff.z), d > 12 ? 1.5 : 0, dt);
          move(dt, world, 0);
          if (d < 9 || s.t > 25) enter('purse', range(T.purse));
          break;
        }
        case 'purse': {
          steer(s.heading, 0, dt);
          move(dt, world, 0.5);
          const side = s.set?.dir ?? 1;
          skiffTo(s.x + Math.cos(s.heading) * -side * 24, s.z + Math.sin(s.heading) * -side * 24, 2, dt);
          if (s.t > s.dur) {
            s.corks0 = s.corks.map((c) => ({ ...c }));
            s.hx = s.x;
            s.hz = s.z;
            enter('haul', range(T.haul));
          }
          break;
        }
        case 'haul': {
          steer(s.heading, 0, dt);
          move(dt, world, 0.3);
          const k = clamp(s.t / s.dur, 0, 1);
          const e = 1 - (1 - k) * (1 - k);
          const tx = s.x + Math.cos(s.heading) * (s.set?.dir ?? 1) * 6;
          const tz = s.z + Math.sin(s.heading) * (s.set?.dir ?? 1) * 6;
          s.corks = s.corks0.map((c) => ({ x: tx + (c.x - s.hx) * (1 - 0.94 * e) + (s.hx - tx) * (1 - e), z: tz + (c.z - s.hz) * (1 - 0.94 * e) + (s.hz - tz) * (1 - e) }));
          const side = s.set?.dir ?? 1;
          skiffTo(s.x + Math.cos(s.heading) * -side * 24, s.z + Math.sin(s.heading) * -side * 24, 2, dt);
          if (s.t > s.dur) enter('brail', range(T.brail));
          break;
        }
        case 'brail': {
          steer(s.heading, 0, dt);
          move(dt, world, 0.3);
          const k = clamp(s.t / s.dur, 0, 1);
          if (k > 0.7) s.corks = [];
          const sx = s.x - Math.sin(s.heading) * 10;
          const sz = s.z + Math.cos(s.heading) * 10;
          const d = skiffTo(sx, sz, 3, dt);
          if (s.t > s.dur && d < 3) {
            s.skiff.out = false;
            s.corks = [];
            s.corks0 = null;
            s.set = null;
            s.setsDone++;
            enter('plan');
          } else if (s.t > s.dur + 20) {
            s.skiff.out = false;
            s.corks = [];
            s.setsDone++;
            enter('plan');
          }
          break;
        }
        case 'approach': {
          // Final approach alongside the tender.
          const side = s.deliverSide ?? 1;
          const off = tender.beam / 2 + 3.6;
          const tx = tender.x + Math.cos(tender.heading) * off * side;
          const tz = tender.z + Math.sin(tender.heading) * off * side;
          const d = Math.hypot(tx - s.x, tz - s.z);
          steer(d > 6 ? bearing(s.x, s.z, tx, tz) : tender.heading, clamp(d / 6, 0, 3.5), dt);
          move(dt, world, 0);
          if (d < 2.5 || s.t > 60) enter('deliver', range(T.deliver));
          break;
        }
        case 'deliver': {
          const side = s.deliverSide ?? 1;
          const off = tender.beam / 2 + 3.6;
          s.x += (tender.x + Math.cos(tender.heading) * off * side - s.x) * Math.min(1, dt);
          s.z += (tender.z + Math.sin(tender.heading) * off * side - s.z) * Math.min(1, dt);
          s.heading = wrap(s.heading + clamp(wrap(tender.heading - s.heading), -0.2 * dt, 0.2 * dt));
          s.speed = 0;
          if (s.t > s.dur) {
            s.setsDone = 0;
            s.setsBeforeDelivery = Math.round(range(T.setsPerDelivery));
            s.heading = wrap(s.heading + side * 0.4);
            enter('plan');
          }
          break;
        }
        case 'anchor': {
          const d = Math.hypot(anchorage.x - s.x, anchorage.z - s.z);
          if (d > 20 && !s.anchored) {
            steer(bearing(s.x, s.z, anchorage.x, anchorage.z), clamp(d / 10, 0, 4), dt);
            move(dt, world);
          } else {
            s.anchored = true;
            steer(s.heading, 0, dt);
            // Lie to the stream.
            const c = world.current ? world.current(s.x, s.z) : { x: 0, z: 0 };
            if (Math.hypot(c.x, c.z) > 0.05) s.heading = wrap(s.heading + clamp(wrap(Math.atan2(-c.x, c.z) - s.heading), -0.05 * dt, 0.05 * dt));
          }
          if (world.fishing && s.t > 5) {
            s.anchored = false;
            enter('plan');
          }
          break;
        }
        default:
          enter('plan');
      }
    },
  };
  return ai;
}

// Two-waypoint shuttle for the ferry and the cutter: follow the current leg's path, dwell, request the next.
export function createShuttleAI({ id, name, stops, speed = 8, rng = Math.random, start = 0 }) {
  const s = { id, name, x: stops[start].x, z: stops[start].z, heading: 0, speed: 0, stop: start, state: 'dwell', t: 0, dur: stops[start].dwell ?? 20, path: null, seg: 0, req: null };
  return {
    s,
    step(dt, world) {
      s.t += dt;
      if (s.state === 'dwell') {
        s.speed = Math.max(0, s.speed - dt);
        if (s.t > s.dur) {
          const next = (s.stop + 1) % stops.length;
          s.req = world.route({ x: s.x, z: s.z }, stops[next]);
          s.next = next;
          s.state = 'route';
          s.t = 0;
        }
      } else if (s.state === 'route') {
        if (s.req?.status === 'done') {
          s.path = s.req.path;
          s.seg = 1;
          s.state = 'run';
        } else if (s.req?.status === 'failed' || s.t > 30) {
          s.stop = s.next;
          s.state = 'dwell';
          s.t = 0;
          s.dur = 10;
        }
      } else if (s.state === 'run') {
        const p = s.path;
        if (!p || s.seg >= p.length) {
          s.stop = s.next;
          s.state = 'dwell';
          s.t = 0;
          s.dur = stops[s.stop].dwell ?? 20;
          return;
        }
        const w = p[s.seg];
        const d = Math.hypot(w.x - s.x, w.z - s.z);
        const last = s.seg === p.length - 1;
        if (d < (last ? 8 : 40)) {
          s.seg++;
          return;
        }
        const target = last ? clamp(d / 25, 1, speed) : speed;
        const err = wrap(bearing(s.x, s.z, w.x, w.z) - s.heading);
        s.heading = wrap(s.heading + clamp(err, -0.12 * dt, 0.12 * dt));
        s.speed += clamp(target * Math.max(0.3, Math.cos(err)) - s.speed, -0.5 * dt, 0.3 * dt);
        s.x += Math.sin(s.heading) * s.speed * dt;
        s.z += -Math.cos(s.heading) * s.speed * dt;
      }
    },
  };
}
