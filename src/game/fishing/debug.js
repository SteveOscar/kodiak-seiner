// Smoke-test helpers (browser only when used): a helmsman that drives the seiner by dispatching real keydown/keyup
// events (so input goes through src/core/input.js exactly like a player's), and camera framings for screenshots.

const TAU = Math.PI * 2;
const wrap = (a) => ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
const headingOf = (vx, vz) => Math.atan2(vx, -vz);

export function createDebugTools(ctx) {
  const down = new Set();
  let task = null;
  let raf = 0;
  const log = [];

  function key(code, on) {
    if (typeof window === 'undefined') return;
    if (on && !down.has(code)) {
      down.add(code);
      window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code }));
    } else if (!on && down.has(code)) {
      down.delete(code);
      window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code }));
    }
  }

  function steerTo(want, deadband = 0.04) {
    const s = ctx.systems.seiner;
    const err = wrap(want - (s?.heading ?? 0));
    key('KeyA', err < -deadband);
    key('KeyD', err > deadband);
    return err;
  }

  function tick() {
    raf = 0;
    if (!task) return;
    const s = ctx.systems.seiner;
    if (s?.position && ctx.state.mode === 'play') {
      try {
        const done = task(s);
        if (done) stop();
      } catch (err) {
        console.warn('[pilot] task failed', err);
        stop();
      }
    }
    if (task) raf = requestAnimationFrame(tick);
  }

  function run(fn) {
    stop();
    task = fn;
    if (typeof requestAnimationFrame !== 'undefined') raf = requestAnimationFrame(tick);
  }

  function stop() {
    task = null;
    if (raf && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(raf);
    raf = 0;
    for (const c of [...down]) key(c, false);
  }

  const pilot = {
    log,
    stop,
    key,
    // Circle (cx, cz) at radius r with throttle held; turn = -1 counter-clockwise (to port, as seen on a north-up
    // chart), +1 clockwise. Stops by itself after `turns` revolutions or when `until()` is true.
    circle({ cx, cz, r = 60, turn = -1, turns = 1.05, throttle = true, until = null } = {}) {
      let swept = 0;
      let last = null;
      run((s) => {
        const dx = s.position.x - cx;
        const dz = s.position.z - cz;
        const d = Math.hypot(dx, dz) || 1;
        const ang = Math.atan2(dz, dx);
        if (last !== null) swept += Math.abs(wrap(ang - last));
        last = ang;
        // Tangent for the chosen direction plus a radial correction toward the circle.
        const tx = turn < 0 ? dz / d : -dz / d;
        const tz = turn < 0 ? -dx / d : dx / d;
        const k = Math.max(-0.8, Math.min(0.8, (d - r) / 25));
        const vx = tx - (dx / d) * k;
        const vz = tz - (dz / d) * k;
        steerTo(headingOf(vx, vz));
        key('KeyW', throttle);
        return (until && until()) || swept >= turns * TAU;
      });
    },
    // Run to a point, then stop.
    goto({ x, z, within = 8, throttle = true } = {}) {
      run((s) => {
        const dx = x - s.position.x;
        const dz = z - s.position.z;
        const d = Math.hypot(dx, dz);
        steerTo(headingOf(dx, dz));
        key('KeyW', throttle && d > within);
        return d <= within;
      });
    },
    // Steer at a moving point (target() → {x, z} | null) until within `within` metres.
    toward({ target, within = 10, throttle = true, seconds = 60 } = {}) {
      const t0 = ctx.time.elapsed;
      run((s) => {
        const p = target?.();
        if (!p) return true;
        const dx = p.x - s.position.x;
        const dz = p.z - s.position.z;
        const d = Math.hypot(dx, dz);
        steerTo(headingOf(dx, dz));
        key('KeyW', throttle && d > within);
        return d <= within || ctx.time.elapsed - t0 >= seconds;
      });
    },
    // Hold a heading for `seconds`.
    heading({ deg, seconds = 5, throttle = true } = {}) {
      const t0 = ctx.time.elapsed;
      const want = (deg * Math.PI) / 180;
      run(() => {
        steerTo(want);
        key('KeyW', throttle);
        return ctx.time.elapsed - t0 >= seconds;
      });
    },
    // Feather E on the purse winch to keep the needle in the band (real key events).
    purse() {
      run(() => {
        const f = ctx.systems.fishing;
        if (f?.state !== 'pursing') {
          key('KeyE', false);
          return f?.state !== 'closing' && f?.state !== 'pursing';
        }
        const [lo, hi] = f.hud.tensionBand;
        const t = f.hud.tension;
        if (t > lo + (hi - lo) * 0.7) key('KeyE', false);
        else if (t < lo + (hi - lo) * 0.35) key('KeyE', true);
        return false;
      });
    },
    get busy() {
      return !!task;
    },
  };

  // Look-dev helper: lays a round haul instantly around (x, z) — the seiner is walked around the circle and the net
  // pays out from its real stern point — then advances the set to `phase` ('laid' | 'holding' | 'closing' |
  // 'pursing' | 'hauling' | 'brailing'). pursed / hauled preset those phases. Spawns a milling school at the centre.
  function stage(core, { x, z, r = 58, phase = 'laid', frac = 0.975, pursed = 0.55, hauled = 0.5, school = true, schoolAt = null, species = 'pink', count = 5000 } = {}) {
    const S = ctx.systems;
    const s = S.seiner;
    const net = S.net;
    if (!s?.setPose || !net?.model) return 'no seiner/net';
    core.hardStop();
    if (school) S.fish?.spawnSchool?.({ x: x + (schoolAt?.dx ?? 0), z: z + (schoolAt?.dz ?? 0), species, count, milling: true, spookable: false });
    const pose = (a) => s.setPose(x + Math.cos(a) * r, z + Math.sin(a) * r, wrap(a));
    pose(0);
    s.update?.(0);
    core.debug.letGo({ force: true });
    const stern = { x: 0, y: 0, z: 0 };
    const V = new ctx.THREE.Vector3();
    let laid = false;
    let wait = 0;
    run(() => {
      const sk = S.skiff;
      if (!laid) {
        if (sk && sk.state === 'released') return false;
        for (let a = 0; a >= -frac * TAU; a -= 0.5 / r) {
          pose(a);
          s.sternPoint(V);
          stern.x = V.x;
          stern.z = V.z;
          net.model.sim.pay(stern.x, stern.z, Math.sin(a), -Math.cos(a));
        }
        laid = true;
        if (phase === 'laid') return true;
        if (phase === 'holding') {
          core.debug.holdHook();
          return true;
        }
        core.debug.closeUp();
        if (phase === 'closing') return true;
        core.debug.finishClose();
        net.model.pursed = phase === 'pursing' ? pursed : 1;
        if (phase === 'pursing') return true;
        core.debug.ringsUp();
        return false;
      }
      // Hauling: take the corkline aboard once the ends have settled alongside.
      wait += 1;
      if (wait < 90) return false;
      const sim = net.model.sim;
      const want = phase === 'brailing' ? 0.905 : hauled;
      const metres = Math.max(0, (want - net.hauled) * Math.max(1, sim.inWater / Math.max(0.05, 1 - net.hauled)));
      if (metres > 0.5) sim.haul(Math.min(metres, 6), 3);
      return net.hauled >= want - 0.01 || metres <= 0.5;
    });
    return 'staging ' + phase;
  }

  // Screenshot framings. Returns the camera override that was applied.
  function cam(mode = null, opts = {}) {
    if (!mode) {
      ctx.debug.cameraOverride = null;
      return null;
    }
    const s = ctx.systems.seiner;
    const net = ctx.systems.net;
    if (!s?.position) return null;
    const p = s.position;
    const h = s.heading ?? 0;
    const fx = Math.sin(h);
    const fz = -Math.cos(h);
    const rx = Math.cos(h);
    const rz = Math.sin(h);
    let c = null;
    const sim = net?.model?.sim;
    if (sim && sim.count > 2) c = sim.centroid();
    const bag = c ?? { x: p.x + fx * 30, z: p.z + fz * 30 };
    let pos;
    let look;
    switch (mode) {
      case 'crow': {
        // The crow's nest: up the mast, looking over the net.
        pos = [p.x - fx * 1.5, p.y + (opts.height ?? 16), p.z - fz * 1.5];
        look = [bag.x, 0, bag.z];
        break;
      }
      case 'chase': {
        const back = opts.back ?? 34;
        pos = [p.x - fx * back + rx * (opts.side ?? 6), p.y + (opts.height ?? 11), p.z - fz * back + rz * (opts.side ?? 6)];
        look = [p.x + fx * 10, p.y + 2, p.z + fz * 10];
        break;
      }
      case 'wide': {
        const dx = bag.x - p.x;
        const dz = bag.z - p.z;
        const d = Math.hypot(dx, dz) || 1;
        const back = opts.back ?? 70;
        pos = [p.x - (dx / d) * back + rx * 20, opts.height ?? 55, p.z - (dz / d) * back + rz * 20];
        look = [(p.x + bag.x) / 2, 0, (p.z + bag.z) / 2];
        break;
      }
      case 'bag': {
        const side = net?.side ?? 1;
        const b = c ?? { x: p.x + rx * side * 8, z: p.z + rz * side * 8 };
        pos = [p.x + rx * side * 22 - fx * 14, p.y + (opts.height ?? 8), p.z + rz * side * 22 - fz * 14];
        look = [b.x * 0.7 + p.x * 0.3, 0.5, b.z * 0.7 + p.z * 0.3];
        break;
      }
      case 'block': {
        const side = net?.side ?? 1;
        pos = [p.x + rx * side * 16 - fx * 20, p.y + (opts.height ?? 7), p.z + rz * side * 16 - fz * 20];
        look = [p.x - fx * 4, p.y + 4, p.z - fz * 4];
        break;
      }
      case 'under': {
        // Low over the water beside the net, to see the web hanging below the corks.
        const i = Math.floor((sim?.count ?? 1) * (opts.at ?? 0.5));
        const nx = sim ? sim.x[i] : bag.x;
        const nz = sim ? sim.z[i] : bag.z;
        const dx = nx - bag.x;
        const dz = nz - bag.z;
        const d = Math.hypot(dx, dz) || 1;
        pos = [nx + (dx / d) * 14, opts.height ?? 4, nz + (dz / d) * 14];
        look = [nx - (dx / d) * 6, -4, nz - (dz / d) * 6];
        break;
      }
      default:
        return null;
    }
    ctx.debug.cameraOverride = { pos, look };
    return ctx.debug.cameraOverride;
  }

  return { pilot, cam, stage };
}
