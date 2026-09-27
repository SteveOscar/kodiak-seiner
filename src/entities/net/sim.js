// Corkline simulation (DOM-free, no three.js): a chain of floating nodes on the sea surface.
//
// Node 0 is the skiff end; nodes are laid in index order as the seiner pays out, so the highest laid index is the
// seiner (tow) end. Positions are x/z in world metres; y is sampled from the water surface by the caller's env.
// Segments are one-sided distance constraints (a rope can go slack but not stretch much). Velocities relax toward
// a fraction of the surface current: the web and leadline hanging below make the corks drift slower than the
// water around them. Hauling shortens the chain from the seiner end.

export const NODE_SPACING = 2.4;

export function nodeCountFor(length) {
  return Math.round(Math.min(200, Math.max(150, length / NODE_SPACING)));
}

const MAX_SUBSTEP = 1 / 30;
const CURRENT_REFRESH = 0.2; // s between surface-current samples

export function createCorkline(length) {
  const n = nodeCountFor(length);
  const seg = length / (n - 1);
  const x = new Float64Array(n);
  const z = new Float64Array(n);
  const vx = new Float64Array(n);
  const vz = new Float64Array(n);
  const ox = new Float64Array(n);
  const oz = new Float64Array(n);
  const y = new Float32Array(n);
  const seabed = new Float32Array(n); // seabed depth under each node (m, >= 0)
  const rock = new Uint8Array(n); // 1 where the seabed under the node is rock
  const rest = new Float64Array(n); // rest length of segment i -> i+1
  const ys = new Float32Array(n); // last sampled water height, its rate of change and age (see sampleSurface)
  const vy = new Float32Array(n);
  const age = new Float32Array(n).fill(1);
  const cur = { x: 0, z: 0 };
  const cx = new Float64Array(n); // drift target per node (refreshed every CURRENT_REFRESH seconds)
  const cz = new Float64Array(n);
  const bx = new Float64Array(n).fill(NaN); // where each node's seabed was last sampled
  const bz = new Float64Array(n);
  let currentAge = Infinity;
  let currentCount = -1;

  const sim = {
    n,
    seg,
    length,
    x,
    z,
    y,
    vx,
    vz,
    seabed,
    rock,
    rest,
    count: 0, // laid nodes (0..count-1 are in the water)
    full: false, // every node laid
    hauledLen: 0, // metres taken back aboard
    tailX: 0, // where the net leaves the boat while paying (stern), for payout and polygons
    tailZ: 0,
    tailActive: false,
    strain: 1, // chain length / rest length (> 1 = stretched by towing)

    reset() {
      bx.fill(NaN);
      currentAge = Infinity;
      sim.count = 0;
      sim.full = false;
      sim.hauledLen = 0;
      sim.tailActive = false;
      sim.strain = 1;
      rest.fill(seg);
    },

    // Drops the skiff end at (ax, az).
    begin(ax, az) {
      sim.reset();
      x[0] = ax;
      z[0] = az;
      vx[0] = vz[0] = 0;
      sim.count = 1;
      sim.tailX = ax;
      sim.tailZ = az;
      sim.tailActive = true;
    },

    // The seiner's stern is at (sx, sz): the net slides off the pile as the stern pulls away from the last laid
    // node, so nodes are laid along the stern's path. (fx, fz), when given, is the seiner's forward vector: going
    // astern toward the net pays nothing out. Returns metres paid out.
    pay(sx, sz, fx = 0, fz = 0) {
      sim.tailX = sx;
      sim.tailZ = sz;
      if (sim.count === 0 || sim.full) return sim.payout;
      let guard = 24;
      while (sim.count < n && guard-- > 0) {
        const i = sim.count - 1;
        const dx = sx - x[i];
        const dz = sz - z[i];
        const d = Math.hypot(dx, dz);
        if (d < seg) break;
        if ((fx !== 0 || fz !== 0) && dx * fx + dz * fz < 0) break;
        x[i + 1] = x[i] + (dx / d) * seg;
        z[i + 1] = z[i] + (dz / d) * seg;
        y[i + 1] = y[i];
        age[i + 1] = 1;
        bx[i + 1] = NaN;
        vx[i + 1] = vz[i + 1] = 0;
        sim.count++;
      }
      if (sim.count >= n) sim.full = true;
      return sim.payout;
    },

    // Metres of corkline in the water (the tail from the last node to the stern counts while paying).
    get payout() {
      if (sim.count === 0) return 0;
      let laid = 0;
      for (let i = 0; i < sim.count - 1; i++) laid += rest[i];
      if (sim.full || !sim.tailActive) return Math.min(length, laid);
      const i = sim.count - 1;
      return Math.min(length, laid + Math.min(seg, Math.hypot(sim.tailX - x[i], sim.tailZ - z[i])));
    },

    // Forces every node to re-sample the seabed on the next step (the cache otherwise refreshes per metre moved).
    invalidateSeabed() {
      bx.fill(NaN);
    },

    // Stops paying out: the current seiner end becomes the last node (the rest of the net stays on deck).
    holdEnd() {
      sim.tailActive = false;
    },

    // Takes `metres` of corkline aboard from the seiner end. Keeps at least `minNodes` in the water.
    haul(metres, minNodes = 3) {
      if (sim.count < 2 || metres <= 0) return 0;
      sim.tailActive = false;
      let left = metres;
      let taken = 0;
      while (left > 0 && sim.count >= 2) {
        const k = sim.count - 2;
        const take = Math.min(left, rest[k]);
        rest[k] -= take;
        left -= take;
        taken += take;
        if (rest[k] <= 1e-6) {
          if (sim.count <= minNodes) {
            rest[k] = 1e-3;
            break;
          }
          rest[k] = seg;
          sim.count--;
        }
      }
      sim.hauledLen += taken;
      return taken;
    },

    // Metres of corkline still in the water after hauling started.
    get inWater() {
      let laid = 0;
      for (let i = 0; i < sim.count - 1; i++) laid += rest[i];
      return laid;
    },

    // Advances the chain. env:
    //   currentAt(x, z, out)  surface current (m/s)
    //   heightAt(x, z)        water surface height
    //   depthAt(x, z)         seabed depth (m); isRock(x, z) → bool (both optional)
    //   drift                 fraction of the surface current the corks follow (0..1)
    //   relax                 1/s rate at which node velocity relaxes toward the drift
    //   pinA, pinB            {x, z} or null: node 0 / the last node follow these points
    //   inflate               0..1: outward push keeping a closed loop round (fish and water in the bag)
    //   closeGap              true when the loop is closed through the boat (for the inflate area)
    //   iterations            constraint sweeps per substep
    //   heightStride          refresh each node's water height every n-th step (1 = every step)
    step(dt, env) {
      if (sim.count === 0 || !(dt > 0)) return;
      const steps = Math.max(1, Math.ceil(dt / MAX_SUBSTEP));
      const h = dt / steps;
      currentAge += dt;
      if (currentAge >= CURRENT_REFRESH || currentCount !== sim.count) sampleCurrent(env);
      for (let s = 0; s < steps; s++) substep(h, env);
      sampleSurface(env, dt);
      measureStrain();
    },

    // Signed area (shoelace) of the loop through the laid nodes (+ tail while paying). Positive = counter-clockwise
    // when viewed from above with x east and z south (i.e. clockwise on a north-up chart).
    signedArea() {
      const c = sim.count;
      if (c < 3) return 0;
      let a = 0;
      const tail = sim.tailActive && !sim.full;
      const m = tail ? c + 1 : c;
      for (let i = 0; i < m; i++) {
        const j = (i + 1) % m;
        const xi = i < c ? x[i] : sim.tailX;
        const zi = i < c ? z[i] : sim.tailZ;
        const xj = j < c ? x[j] : sim.tailX;
        const zj = j < c ? z[j] : sim.tailZ;
        a += xi * zj - xj * zi;
      }
      return a / 2;
    },

    centroid(out = { x: 0, z: 0 }) {
      const c = sim.count;
      let sx = 0;
      let sz = 0;
      for (let i = 0; i < c; i++) {
        sx += x[i];
        sz += z[i];
      }
      out.x = c ? sx / c : 0;
      out.z = c ? sz / c : 0;
      return out;
    },
  };



  // The tidal stream varies over hundreds of metres and minutes: sample it on every 4th node a few times a second
  // and interpolate between.
  function sampleCurrent(env) {
    const c = sim.count;
    currentAge = 0;
    currentCount = c;
    const currentAt = env.currentAt;
    const drift = env.drift ?? 0.7;
    if (!currentAt) {
      cx.fill(0, 0, c);
      cz.fill(0, 0, c);
      return;
    }
    for (let i = 0; i < c; i += 4) {
      currentAt(x[i], z[i], cur);
      cx[i] = cur.x * drift;
      cz[i] = cur.z * drift;
    }
    const last = c - 1;
    if (last % 4 !== 0) {
      currentAt(x[last], z[last], cur);
      cx[last] = cur.x * drift;
      cz[last] = cur.z * drift;
    }
    for (let i = 0; i < c; i++) {
      const r = i % 4;
      if (r === 0 || i === last) continue;
      const i0 = i - r;
      const i1 = Math.min(i0 + 4, last);
      const t = (i - i0) / (i1 - i0);
      cx[i] = cx[i0] + (cx[i1] - cx[i0]) * t;
      cz[i] = cz[i0] + (cz[i1] - cz[i0]) * t;
    }
  }

  function substep(h, env) {
    const c = sim.count;
    const a = 1 - Math.exp(-(env.relax ?? 0.8) * h);
    const currentAt = env.currentAt;
    for (let i = 0; i < c; i++) {
      ox[i] = x[i];
      oz[i] = z[i];
      const tx = currentAt ? cx[i] : 0;
      const tz = currentAt ? cz[i] : 0;
      vx[i] += (tx - vx[i]) * a;
      vz[i] += (tz - vz[i]) * a;
      x[i] += vx[i] * h;
      z[i] += vz[i] * h;
    }
    if (env.inflate > 0 && c >= 6) inflate(h, env);
    pin(env);
    const iters = env.iterations ?? 10;
    const w0 = env.pinA ? 0 : 1;
    const wl = env.pinB && c > 1 ? 0 : 1;
    for (let it = 0; it < iters; it++) {
      if (it & 1) for (let i = c - 2; i >= 0; i--) solve(i, c, w0, wl);
      else for (let i = 0; i < c - 1; i++) solve(i, c, w0, wl);
      pin(env);
    }
    for (let i = 0; i < c; i++) {
      vx[i] = (x[i] - ox[i]) / h;
      vz[i] = (z[i] - oz[i]) / h;
      // Water drag caps how fast a towed net can be dragged through the water.
      const sp = Math.hypot(vx[i], vz[i]);
      if (sp > 4) {
        vx[i] *= 4 / sp;
        vz[i] *= 4 / sp;
      }
    }
  }

  function pin(env) {
    const c = sim.count;
    if (env.pinA) {
      x[0] = env.pinA.x;
      z[0] = env.pinA.z;
    }
    if (env.pinB && c > 1) {
      x[c - 1] = env.pinB.x;
      z[c - 1] = env.pinB.z;
    }
  }

  // One-sided distance constraint on segment i → i+1 (rope: slack is free). w0 / wl: inverse mass of the first and
  // last node (0 when pinned).
  function solve(i, c, w0, wl) {
    const dx = x[i + 1] - x[i];
    const dz = z[i + 1] - z[i];
    const d2 = dx * dx + dz * dz;
    const r = rest[i];
    if (d2 <= r * r || d2 < 1e-18) return;
    const wa = i === 0 ? w0 : 1;
    const wb = i + 1 === c - 1 ? wl : 1;
    const w = wa + wb;
    if (w === 0) return;
    const d = Math.sqrt(d2);
    const k = (d - r) / d / w;
    x[i] += dx * k * wa;
    z[i] += dz * k * wa;
    x[i + 1] -= dx * k * wb;
    z[i + 1] -= dz * k * wb;
  }


  // Pushes nodes outward along the loop normal while the enclosed area is below a round-ish target, so a closed
  // net holds a bag shape instead of collapsing into a line as it is hauled.
  function inflate(h, env) {
    const c = sim.count;
    let area = 0;
    let len = 0;
    for (let i = 0; i < c; i++) {
      const j = (i + 1) % c;
      area += x[i] * z[j] - x[j] * z[i];
      if (i < c - 1) len += rest[i];
    }
    area /= 2;
    len += Math.hypot(x[c - 1] - x[0], z[c - 1] - z[0]);
    const target = (0.72 * len * len) / (4 * Math.PI);
    const abs = Math.abs(area);
    if (abs >= target) return;
    const sign = area >= 0 ? 1 : -1;
    const push = Math.min(1.2, 2.4 * (1 - abs / target)) * env.inflate * h;
    for (let i = 1; i < c - 1; i++) {
      const tx = x[i + 1] - x[i - 1];
      const tz = z[i + 1] - z[i - 1];
      const tl = Math.hypot(tx, tz) || 1;
      // For a positive (shoelace) loop, (tz, -tx) points outward.
      x[i] += (sign * tz * push) / tl;
      z[i] += (-sign * tx * push) / tl;
    }
  }

  // Water heights can be expensive (wave inversion), so with env.heightStride = k each node is re-sampled every k-th
  // step on a rotating phase (the pinned ends every step) and extrapolated from its vertical velocity in between.
  let surfacePhase = 0;
  function sampleSurface(env, dt) {
    const c = sim.count;
    const k = Math.max(1, env.heightStride | 0);
    surfacePhase = (surfacePhase + 1) % k;
    for (let i = 0; i < c; i++) {
      age[i] += dt;
      if (!env.heightAt) {
        y[i] = 0;
      } else if (k === 1 || i === 0 || i === c - 1 || (i + surfacePhase) % k === 0 || age[i] > 0.5) {
        const h = env.heightAt(x[i], z[i]);
        vy[i] = age[i] > 0 && age[i] < 0.5 ? (h - ys[i]) / age[i] : 0;
        ys[i] = h;
        age[i] = 0;
        y[i] = h;
      } else {
        y[i] = ys[i] + vy[i] * age[i];
      }
      // The seabed only changes as a node moves: re-sample after a metre of travel.
      if (!(Math.abs(x[i] - bx[i]) + Math.abs(z[i] - bz[i]) < 1)) {
        bx[i] = x[i];
        bz[i] = z[i];
        seabed[i] = env.depthAt ? env.depthAt(x[i], z[i]) : 100;
        rock[i] = env.isRock ? (env.isRock(x[i], z[i]) ? 1 : 0) : 0;
      }
    }
  }

  function measureStrain() {
    const c = sim.count;
    let d = 0;
    let r = 0;
    for (let i = 0; i < c - 1; i++) {
      d += Math.hypot(x[i + 1] - x[i], z[i + 1] - z[i]);
      r += rest[i];
    }
    sim.strain = r > 0 ? d / r : 1;
  }

  rest.fill(seg);
  return sim;
}

// Fraction of laid nodes whose web reaches the seabed (leadline on the bottom), and how much of that is rock.
export function bottomContactOf(sim, webDepth, from = 0) {
  const c = sim.count;
  let touching = 0;
  let rocky = 0;
  let total = 0;
  for (let i = from; i < c; i++) {
    total++;
    if (sim.seabed[i] <= webDepth + 0.05) {
      touching++;
      if (sim.rock[i]) rocky++;
    }
  }
  return {
    contact: total ? touching / total : 0,
    rockFraction: touching ? rocky / touching : 0,
  };
}

// Snag chance per second on a rocky bottom (SPEC §6.11).
export function snagChancePerSecond(bottomContact, rockFraction, pursingSpeed) {
  return 0.02 * bottomContact * rockFraction * Math.max(0, pursingSpeed);
}
