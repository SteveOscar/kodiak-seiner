// The seine's state and simulation, independent of rendering (constructible under Node with tests' fakeCtx()).
//
// Anchors: node 0 (the skiff end) follows the end anchor given to begin() — by default the skiff's endPoint — and
// is kept in the water when that point is ashore (tie-off). The seiner end pays out from seiner.sternPoint. After
// close() both ends are made fast to the seiner on the net side: the bunt end forward, the tow end under the power
// block, where hauling takes the corkline aboard.

import { bottomContactOf, createCorkline, snagChancePerSecond } from './sim.js';
import { pointInPolygon, polygonArea } from './geom.js';
import { NET_TUNING as T } from './tuning.js';

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const CARRY_NODES = 10; // corkline nodes carried around the transom with the skiff end at close-up

export function createNetModel(ctx, rng) {
  const { THREE, config, heightmap } = ctx;
  const sys_ = () => ctx.systems;
  const HALF_BEAM = 3.5;

  const tmp = new THREE.Vector3();
  const stern = new THREE.Vector3();
  const block = new THREE.Vector3();
  const endW = new THREE.Vector3();
  const cur = { x: 0, z: 0 };
  const grad = { x: 0, z: 0 };
  const pinA = { x: 0, z: 0 };
  const pinB = { x: 0, z: 0 };
  const closeFromA = { x: 0, z: 0 };
  const closeFromB = { x: 0, z: 0 };
  const inv = new THREE.Matrix4();
  const buntLocal = { r: HALF_BEAM + 1.1, f: -6.5 }; // seiner-frame offset of the skiff end after close-up

  // World-space attachment points, recomputed every update from the seiner pose.
  const pts = {
    bunt: new THREE.Vector3(),
    entry: new THREE.Vector3(),
    davit: new THREE.Vector3(),
    gather: new THREE.Vector3(),
    block: new THREE.Vector3(),
    stern: new THREE.Vector3(),
    rail: new THREE.Vector3(),
    pileLocal: new THREE.Vector3(),
    hasSeiner: false,
  };

  let sim = createCorkline(config.net.length);
  let anchor = null; // how to find the skiff end
  let closeT = 0; // seconds since close()
  let haulBase = 0; // metres in the water when hauling began
  let purseCmd = 0;
  let haulCmd = 0;
  let polyCache = [];
  const polyPool = [];
  const vecPool = [];
  let ashore = false;
  let crossA = false; // the skiff end is brought around the stern to the working side after close-up
  const crossFrom = { r: 0, f: 0 }; // seiner-frame start of that route

  const env = {
    currentAt: (x, z, out) => ctx.tide?.currentAt?.(x, z, out) ?? ((out.x = 0), (out.z = 0), out),
    heightAt: (x, z) => sys_().water?.heightAt?.(x, z) ?? 0,
    depthAt: (x, z) => heightmap.depthAt(x, z),
    isRock: (x, z) => heightmap.seabedAt(x, z) === 'rock',
    drift: T.drift,
    relax: T.relax,
    iterations: T.iterations,
    heightStride: 1,
    pinA: null,
    pinB: null,
    inflate: 0,
  };

  const model = {
    state: 'stowed',
    length: config.net.length,
    depth: config.net.depth,
    payout: 0,
    pursed: 0,
    hauled: 0,
    bottomContact: 0,
    rockFraction: 0,
    corkline: [],
    side: 1, // +1 starboard, −1 port: the working side after close-up (skiff end, purse davit, haul)
    bodySide: 1, // side of the seiner the net body lies on after close-up (the skiff tows off the other way)
    snagTimer: 0,
    snagCount: 0,
    snagPoint: { x: 0, z: 0 },
    hole: false,
    corksUnder: false,
    closed: false,
    area: 0,
    bestArea: 0,
    hookHealth: 1,
    strain: 1,
    purseRateEffective: 0,
    haulRateEffective: 0,
    hauledMetres: 0,
    ringsUpSeconds: 0,
    currentSpeed: 0,
    shoreTie: null, // {x, z} of the beach end when the skiff end is ashore
    pts,

    get sim() {
      return sim;
    },

    // Re-reads length/depth from upgrades (only while stowed, per SPEC §6.11).
    refreshGear() {
      if (model.state !== 'stowed') return;
      const mods = sys_().economy?.modifiers;
      const L = Math.min(config.net.maxLength, Math.max(100, mods?.netLength ?? config.net.length));
      const D = Math.min(config.net.maxDepth, Math.max(4, mods?.netDepth ?? config.net.depth));
      model.depth = D;
      if (Math.abs(L - model.length) > 0.01 || !sim) {
        model.length = L;
        sim = createCorkline(L);
      }
    },

    begin(endAnchor) {
      model.refreshGear();
      anchor = endAnchor ?? sys_().skiff ?? null;
      const p = anchorPoint(endW);
      if (!p) return false;
      sim.begin(p.x, p.z);
      model.state = 'paying';
      model.closed = false;
      model.pursed = 0;
      model.hauled = 0;
      model.hauledMetres = 0;
      model.snagTimer = 0;
      model.hole = false;
      model.corksUnder = false;
      model.bestArea = 0;
      model.hookHealth = 1;
      model.ringsUpSeconds = 0;
      haulBase = 0;
      closeT = 0;
      return true;
    },

    // Stop paying out: the seiner holds its end where the net currently leaves the stern.
    holdEnd() {
      if (model.state !== 'paying') return;
      sim.holdEnd();
      model.state = 'out';
    },

    // Both ends are made fast to the seiner on the side the net body lies on (the working side for the purse davit
    // and the haul): the skiff end is held in the seiner's frame just outside the rail, the tow end under the block.
    close() {
      if (model.state === 'stowed' || model.closed) return;
      if (model.state === 'paying') sim.holdEnd();
      const c = sim.centroid();
      const s = sys_().seiner;
      crossA = false;
      if (s?.position) {
        const h = s.heading ?? 0;
        const rx = Math.cos(h);
        const rz = Math.sin(h);
        const fx = Math.sin(h);
        const fz = -Math.cos(h);
        const px = sim.x[0] - s.position.x;
        const pz = sim.z[0] - s.position.z;
        const lr = px * rx + pz * rz;
        const lf = px * fx + pz * fz;
        const body = (c.x - s.position.x) * rx + (c.z - s.position.z) * rz;
        // Both ends are made fast on the side the net body lies on; the skiff tows the seiner off the other way.
        // Ending up with the skiff end on the far side would wrap the corkline under the hull.
        model.bodySide = Math.abs(body) > 1 ? Math.sign(body) : Math.abs(lr) > 0.5 ? Math.sign(lr) : 1;
        model.side = model.bodySide;
        crossA = Math.abs(lr) > 0.5 && Math.sign(lr) !== model.side;
        crossFrom.r = lr;
        crossFrom.f = lf;
        buntLocal.r = model.side * Math.min(HALF_BEAM + 2.2, Math.max(HALF_BEAM + 0.9, crossA ? 0 : Math.abs(lr)));
        buntLocal.f = Math.max(-7.5, Math.min(3, lf));
      }
      computePoints();
      closeFromA.x = sim.x[0];
      closeFromA.z = sim.z[0];
      closeFromB.x = sim.x[sim.count - 1];
      closeFromB.z = sim.z[sim.count - 1];
      closeT = 0;
      model.closed = true;
      model.state = 'closed';
      anchor = null;
      model.shoreTie = null;
    },

    // rate: pursed per second requested this frame (call every frame while pursing; 0 = winch stopped).
    purse(rate = 0) {
      if (model.state === 'closed' && rate > 0) model.state = 'pursing';
      purseCmd = Math.max(0, rate);
      return model.purseRateEffective;
    },

    // rate: hauled fraction per second requested this frame (call every frame while hauling).
    haul(rate = 0) {
      if (model.state === 'stowed') return model.haulRateEffective;
      if (model.state !== 'hauling') {
        // Finishing after brailing continues the same haul; anything else starts one.
        if (model.state !== 'brailing' || !haulBase) {
          haulBase = Math.max(1, sim.inWater);
          model.ringsUpSeconds = 0;
        }
        model.state = 'hauling';
      }
      haulCmd = Math.max(0, rate);
      return model.haulRateEffective;
    },

    brail() {
      if (model.state === 'hauling') {
        model.state = 'brailing';
        model.hole = false;
        model.corksUnder = false;
      }
    },

    stow() {
      model.state = 'stowed';
      buntLocal.r = HALF_BEAM + 1.1;
      buntLocal.f = -6.5;
      sim.reset();
      anchor = null;
      model.closed = false;
      model.payout = 0;
      model.pursed = 0;
      model.hauled = 0;
      model.bottomContact = 0;
      model.rockFraction = 0;
      model.snagTimer = 0;
      model.hole = false;
      model.corksUnder = false;
      model.area = 0;
      model.bestArea = 0;
      model.hookHealth = 1;
      model.hauledMetres = 0;
      model.shoreTie = null;
      polyCache = [];
      model.corkline.length = 0;
      purseCmd = 0;
      haulCmd = 0;
      model.refreshGear();
    },

    update(dt) {
      computePoints();
      if (model.state === 'stowed') {
        model.refreshGear();
        return;
      }
      const s = sys_().seiner;
      if (model.state === 'paying' && pts.hasSeiner) {
        const h = s?.heading ?? 0;
        sim.pay(stern.x, stern.z, Math.sin(h), -Math.cos(h));
        if (sim.full) model.state = 'out';
      }
      // Pins.
      let a = null;
      let b = null;
      if (model.closed) {
        closeT += dt;
        const k = smooth(0, crossA ? 2.6 : 1.6, closeT);
        if (crossA && s?.position && k < 1) {
          // Around the transom in the seiner's frame: a cubic whose control points sit well astern on each side,
          // so the end never passes through the hull and follows the boat as the skiff tows it.
          const h = s.heading ?? 0;
          const px = pinA.x;
          const pz = pinA.z;
          const u = 1 - k;
          const b0 = u * u * u;
          const b1 = 3 * u * u * k;
          const b2 = 3 * u * k * k;
          const b3 = k * k * k;
          const aft = -16;
          const r = crossFrom.r * (b0 + b1) + buntLocal.r * (b2 + b3);
          const f = crossFrom.f * b0 + aft * (b1 + b2) + buntLocal.f * b3;
          pinA.x = s.position.x + Math.cos(h) * r + Math.sin(h) * f;
          pinA.z = s.position.z + Math.sin(h) * r - Math.cos(h) * f;
          // The first few metres of corkline come around with the end rather than trailing into a loop by the stern.
          if (closeT > dt) {
            const dx = pinA.x - px;
            const dz = pinA.z - pz;
            const n = Math.min(CARRY_NODES, sim.count - 2);
            for (let i = 1; i <= n; i++) {
              const w = 1 - i / (n + 1);
              sim.x[i] += dx * w;
              sim.z[i] += dz * w;
            }
          }
        } else if (crossA && s?.position) {
          pinA.x = pts.bunt.x;
          pinA.z = pts.bunt.z;
        } else {
          pinA.x = closeFromA.x + (pts.bunt.x - closeFromA.x) * k;
          pinA.z = closeFromA.z + (pts.bunt.z - closeFromA.z) * k;
        }
        pinB.x = closeFromB.x + (pts.entry.x - closeFromB.x) * k;
        pinB.z = closeFromB.z + (pts.entry.z - closeFromB.z) * k;
        a = pinA;
        b = pinB;
      } else {
        const p = anchorPoint(endW);
        if (p) {
          keepInWater(p.x, p.z, pinA);
          a = pinA;
        }
        if (model.state !== 'paying' && s) {
          pinB.x = stern.x;
          pinB.z = stern.z;
          b = pinB;
        }
      }
      env.pinA = a;
      env.pinB = b;
      const hauling = model.state === 'hauling' || model.state === 'brailing';
      env.inflate = hauling ? 1 : model.closed ? 0.35 : 0;

      // Pursing: rate falls on a smooth bottom; a rocky bottom may hang the leadline up.
      model.purseRateEffective = 0;
      if (model.state === 'pursing' || model.state === 'closed') {
        if (model.snagTimer > 0) {
          model.snagTimer = Math.max(0, model.snagTimer - dt);
        } else if (purseCmd > 0) {
          const smoothBed = model.bottomContact * (1 - model.rockFraction);
          const eff = purseCmd * (1 - T.purse.smoothBottomSlow * Math.min(1, smoothBed * 1.25));
          model.purseRateEffective = eff;
          model.pursed = Math.min(1, model.pursed + eff * dt);
          const chance = snagChancePerSecond(model.bottomContact, model.rockFraction, purseCmd / T.purse.base) * dt;
          if (rng.next() < chance) snag();
        }
      }
      purseCmd = 0;

      // Hauling through the block.
      model.haulRateEffective = 0;
      if (model.state === 'hauling') {
        model.ringsUpSeconds += dt;
        const metres = haulCmd * dt * haulBase;
        const taken = sim.haul(metres, 3);
        model.hauledMetres += taken;
        model.haulRateEffective = dt > 0 ? taken / dt / haulBase : 0;
        model.hauled = Math.min(1, 1 - sim.inWater / haulBase);
        const max = (T.haul.bagTarget / T.haul.seconds) * T.haul.boost * haulRateMod();
        model.corksUnder = model.closed && haulCmd > T.haul.corksUnderAbove * max && model.currentSpeed > T.haul.corksUnderCurrent;
      } else if (model.state === 'brailing') {
        model.ringsUpSeconds += dt;
      }
      haulCmd = 0;

      sim.step(dt, env);
      model.strain = sim.strain;
      model.payout = sim.payout;

      // Leadline on the bottom: the web reaches the seabed where it is shallower than the hanging depth.
      let webDepth = model.depth;
      if (model.closed) webDepth *= 1 - T.purse.contactLift * model.pursed;
      if (hauling) webDepth = Math.max(1.2, model.depth * 0.22 * (1 - model.hauled));
      const bc = bottomContactOf(sim, webDepth);
      model.bottomContact = bc.contact;
      model.rockFraction = bc.rockFraction;

      // Current at the net (for corks going under while hauling).
      const c = sim.centroid();
      env.currentAt(c.x, c.z, cur);
      model.currentSpeed = Math.hypot(cur.x, cur.z);

      rebuildPolygon();
      model.area = polygonArea(polyCache);
      if (!model.closed && model.payout >= model.length * 0.5) {
        model.bestArea = Math.max(model.bestArea, model.area);
        model.hookHealth = model.bestArea > 0 ? model.area / model.bestArea : 1;
      }
      syncCorkline();
    },

    polygon() {
      return polyCache.length >= 3 ? polyCache : null;
    },

    gap() {
      if (model.state === 'stowed' || model.closed || sim.count < 1) return null;
      const a = { x: sim.x[0], z: sim.z[0] };
      const last = sim.count - 1;
      const paying = model.state === 'paying';
      const b = paying ? { x: sim.tailX, z: sim.tailZ } : { x: sim.x[last], z: sim.z[last] };
      return { a, b, width: Math.hypot(a.x - b.x, a.z - b.z) };
    },

    containsPoint(x, z) {
      return polyCache.length >= 3 && pointInPolygon(x, z, polyCache);
    },

    // Metres of corkline on deck (0..1), for the pile.
    get pileFraction() {
      if (model.state === 'stowed') return 1;
      const inWater = model.state === 'paying' ? model.payout : sim.inWater;
      return Math.max(0, Math.min(1, 1 - inWater / model.length));
    },

    // Where the skiff end is in the world (y included), or null.
    skiffEnd(out) {
      if (model.closed || model.state === 'stowed') return null;
      return anchorPoint(out);
    },

    bagCentroid(out = { x: 0, z: 0 }) {
      return sim.centroid(out);
    },

    // Seiner-local position of the pile centre on the stern deck.
    pileLocal() {
      return pts.hasSeiner ? pts.pileLocal : null;
    },
  };

  function haulRateMod() {
    return sys_().economy?.modifiers?.haulRate ?? 1;
  }

  function snag() {
    const lo = T.snag.stall[0];
    const hi = T.snag.stall[1];
    model.snagTimer = lo + (hi - lo) * rng.next();
    model.snagCount++;
    model.hole = true;
    // Report the snag at a rocky node that is on the bottom.
    for (let i = 0; i < sim.count; i++) {
      if (sim.rock[i] && sim.seabed[i] <= model.depth) {
        model.snagPoint.x = sim.x[i];
        model.snagPoint.z = sim.z[i];
        return;
      }
    }
    const c = sim.centroid();
    model.snagPoint.x = c.x;
    model.snagPoint.z = c.z;
  }

  function anchorPoint(out) {
    const a = anchor;
    if (!a) return null;
    try {
      if (typeof a === 'function') {
        const r = a(out);
        if (!r) return null;
        return out.set(r.x, r.y ?? 0, r.z);
      }
      if (typeof a.endPoint === 'function') return a.endPoint(out);
      if (a.isObject3D) return a.getWorldPosition(out);
      if (typeof a.x === 'number') return out.set(a.x, a.y ?? 0, a.z);
    } catch {
      return null;
    }
    return null;
  }

  // Tie-offs put the skiff end on the beach; the first node stays at the water's edge and a shore line runs up.
  function keepInWater(x, z, out) {
    const sd = heightmap.shoreDistance(x, z);
    if (sd < 1.5) {
      heightmap.shoreGradient(x, z, grad);
      out.x = x + grad.x * (1.5 - sd);
      out.z = z + grad.z * (1.5 - sd);
      model.shoreTie = model.shoreTie ?? { x: 0, z: 0 };
      model.shoreTie.x = x;
      model.shoreTie.z = z;
      ashore = true;
    } else {
      out.x = x;
      out.z = z;
      model.shoreTie = null;
      ashore = false;
    }
    return out;
  }

  function computePoints() {
    const s = sys_().seiner;
    if (!s?.position) {
      pts.hasSeiner = false;
      return;
    }
    pts.hasSeiner = true;
    const p = s.position;
    const h = s.heading ?? 0;
    const fx = Math.sin(h);
    const fz = -Math.cos(h);
    const rx = Math.cos(h);
    const rz = Math.sin(h);
    if (typeof s.sternPoint === 'function') s.sternPoint(stern);
    else stern.set(p.x - fx * 8.8, p.y + 1.5, p.z - fz * 8.8);
    if (typeof s.powerBlockPoint === 'function') s.powerBlockPoint(block);
    else block.set(p.x - fx * 4, p.y + 9, p.z - fz * 4);
    pts.stern.copy(stern);
    pts.block.copy(block);
    const deck = stern.y - p.y;
    const side = model.side;
    const along = (block.x - p.x) * fx + (block.z - p.z) * fz;
    const wy = (x, z) => sys_().water?.heightAt?.(x, z) ?? 0;
    const at = (out, r, f, y) => out.set(p.x + rx * r + fx * f, y, p.z + rz * r + fz * f);
    at(pts.bunt, buntLocal.r, buntLocal.f, 0);
    pts.bunt.y = wy(pts.bunt.x, pts.bunt.z);
    // The web comes up over the quarter below the block (the block hangs over the stern on most limit seiners).
    at(pts.entry, side * (HALF_BEAM - 0.3), Math.min(along, 0) - 0.6, 0);
    pts.entry.y = wy(pts.entry.x, pts.entry.z);
    at(pts.davit, side * (HALF_BEAM - 0.1), -1.5, p.y + deck + 2.6);
    at(pts.gather, side * (HALF_BEAM + 1.8), -2.5, 0);
    at(pts.rail, buntLocal.r - side * 1.2, buntLocal.f, p.y + deck + 0.9);
    if (s.object3d?.matrixWorld) {
      inv.copy(s.object3d.matrixWorld).invert();
      tmp.copy(stern).applyMatrix4(inv);
      // Pile centre: on deck, a little forward of the stern roller (the model faces −z, so forward is −z).
      pts.pileLocal.set(0, tmp.y, tmp.z - Math.sign(tmp.z || 1) * 2.7);
    }
  }

  function rebuildPolygon() {
    const c = sim.count;
    const tail = model.state === 'paying' && sim.tailActive;
    const m = tail ? c + 1 : c;
    while (polyPool.length < m) polyPool.push({ x: 0, z: 0 });
    polyCache = polyPool.slice(0, m);
    for (let i = 0; i < c; i++) {
      polyCache[i].x = sim.x[i];
      polyCache[i].z = sim.z[i];
    }
    if (tail) {
      polyCache[c].x = sim.tailX;
      polyCache[c].z = sim.tailZ;
    }
  }

  function syncCorkline() {
    const c = sim.count;
    while (vecPool.length < c) vecPool.push(new THREE.Vector3());
    const out = model.corkline;
    out.length = c;
    for (let i = 0; i < c; i++) out[i] = vecPool[i].set(sim.x[i], sim.y[i], sim.z[i]);
  }

  model.isAshore = () => ashore;
  // Chooses how often each node re-samples the water surface from the measured cost of water.heightAt.
  model.calibrateSurface = (now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())) => {
    const w = sys_().water;
    if (!w?.heightAt) return (env.heightStride = 1);
    const n = 300;
    const t0 = now();
    for (let i = 0; i < n; i++) w.heightAt(i * 3.1, -i * 2.3);
    const us = ((now() - t0) / n) * 1000;
    env.heightStride = Math.max(1, Math.min(8, Math.round(us / 1.2)));
    return env.heightStride;
  };
  model.env = env;
  return model;
}
