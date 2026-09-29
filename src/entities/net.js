// WP-NET: the purse seine (SPEC §6.11). Simulation in ./net/model.js + ./net/sim.js, rendering in ./net/render.js.
// Commands come from fishing (src/game/fishing.js); fish read polygon()/gap()/containsPoint()/pursed/bottomContact.

import { createNetModel } from './net/model.js';
import { createNetView, CORK_SPACING } from './net/render.js';

export async function create(ctx) {
  const { THREE } = ctx;
  const rng = ctx.rng.fork('net');
  const model = createNetModel(ctx, rng.fork('snag'));
  const view = createNetView(ctx, { maxNodes: 201 });
  const water = () => ctx.systems.water;
  const skiffEnd = new THREE.Vector3();
  const towFrom = new THREE.Vector3();
  const towTo = new THREE.Vector3();
  const buntFrom = new THREE.Vector3();
  const tail = new THREE.Vector3();
  const shoreEnd = new THREE.Vector3();
  const bagCen = { x: 0, z: 0 };
  let foamTick = 0;
  // Arcade hauls run the block at ~100 m/s: the corks climbing into it advance at most this much per rendered frame so
  // they read as fast rather than strobing backwards.
  const VIS_HAUL_STEP = CORK_SPACING * 0.45;
  let lastHauledMetres = 0;
  let visHauledMetres = 0;

  const frame = {
    state: 'stowed',
    sim: null,
    count: 0,
    webDepth: 16,
    pursed: 0,
    hauled: 0,
    corksUnder: false,
    time: 0,
    gather: model.pts.gather,
    davit: null,
    block: null,
    entry: null,
    tail: null,
    tailWaterY: 0,
    skiffEnd: null,
    shore: false,
    groundAt: (x, z) => ctx.systems.terrain?.heightAt?.(x, z) ?? ctx.heightmap.heightAt(x, z),
    towLine: null,
    buntLine: null,
    seinerMatrix: null,
    pileLocal: null,
    pileFraction: 1,
    pileTopWorld: null,
    payout: 0,
    hauledMetres: 0,
    ringsUpSeconds: 0,
  };

  function frameData() {
    const m = model;
    const sim = m.sim;
    const pts = m.pts;
    const s = ctx.systems.seiner;
    frame.state = m.state;
    frame.sim = sim;
    frame.count = sim.count;
    frame.webDepth = m.depth;
    frame.pursed = m.pursed;
    frame.hauled = m.hauled;
    frame.corksUnder = m.corksUnder;
    frame.time = ctx.time.elapsed;
    frame.payout = m.payout;
    if (m.arcade) {
      const d = m.hauledMetres - lastHauledMetres;
      visHauledMetres = d < 0 ? m.hauledMetres : visHauledMetres + Math.min(d, VIS_HAUL_STEP);
      frame.hauledMetres = visHauledMetres;
    } else frame.hauledMetres = m.hauledMetres;
    lastHauledMetres = m.hauledMetres;
    frame.ringsUpSeconds = m.ringsUpSeconds;
    frame.seinerMatrix = s?.object3d?.matrixWorld ?? null;
    frame.drawPile = sys.drawsPile;
    frame.pileLocal = m.pileLocal();
    frame.pileFraction = m.pileFraction;
    frame.pileTopWorld = null;
    const active = m.state !== 'stowed' && sim.count > 0 && pts.hasSeiner;
    frame.davit = active && m.closed ? pts.davit : null;
    frame.block = pts.hasSeiner ? pts.block : null;
    frame.entry = pts.hasSeiner ? pts.entry : null;
    frame.gather = pts.gather;
    frame.tail = null;
    frame.towLine = null;
    frame.buntLine = null;
    frame.skiffEnd = null;
    frame.shore = false;
    if (!active) return frame;
    const last = sim.count - 1;
    if (m.state === 'paying' && sim.tailActive) {
      tail.copy(pts.stern);
      frame.tail = tail;
      frame.tailWaterY = water()?.heightAt?.(tail.x, tail.z) ?? 0;
    } else if (!m.closed) {
      towFrom.set(sim.x[last], sim.y[last] + 0.1, sim.z[last]);
      frame.towLine = { from: towFrom, to: pts.stern };
    }
    if (m.closed) {
      buntFrom.set(sim.x[0], sim.y[0] + 0.1, sim.z[0]);
      frame.buntLine = { from: buntFrom, to: pts.rail };
      if (m.state !== 'hauling' && m.state !== 'brailing') {
        towFrom.set(sim.x[last], sim.y[last] + 0.1, sim.z[last]);
        towTo.copy(pts.stern);
        frame.towLine = { from: towFrom, to: towTo };
      }
    } else if (m.shoreTie) {
      const g = frame.groundAt(m.shoreTie.x, m.shoreTie.z);
      shoreEnd.set(m.shoreTie.x, Math.max(0, g) + 0.3, m.shoreTie.z);
      frame.skiffEnd = shoreEnd;
      frame.shore = true;
    } else if (m.skiffEnd(skiffEnd)) {
      skiffEnd.y += 0.6;
      frame.skiffEnd = skiffEnd;
    }
    return frame;
  }

  function stampFoam(dt) {
    const w = water();
    if (!w?.stamp || model.state === 'stowed') return;
    const sim = model.sim;
    const c = sim.count;
    foamTick += dt;
    // Corks leave a faint lace of foam along the corkline (every 4th node, per the water budget).
    for (let i = 0; i < c; i += 4) w.stamp(sim.x[i], sim.z[i], 0.6, 0.06, 'foam');
    if (model.state === 'paying' && sim.tailActive) w.stamp(sim.tailX, sim.tailZ, 1.6, 0.3, 'foam');
    const hauling = model.state === 'hauling' || model.state === 'brailing';
    if (hauling && c >= 3) {
      // The bag boils with fish as it dries up.
      const cen = model.bagCentroid(bagCen);
      const r = Math.sqrt(Math.max(1, model.area) / Math.PI);
      const k = Math.min(1, Math.max(0, (model.hauled - 0.6) / 0.3));
      if (k > 0) w.stamp(cen.x, cen.z, Math.min(12, Math.max(2, r * 0.55)), 0.1 + 0.3 * k, 'foam');
      for (let i = 0; i < c; i += 4) w.stamp(sim.x[i], sim.z[i], 0.7, 0.06 + 0.12 * k, 'foam');
      const e = model.pts.entry;
      w.stamp(e.x, e.z, 1.4, 0.35, 'foam');
      if (foamTick > 0.35 && k > 0.2) {
        foamTick = 0;
        const a = Math.random() * Math.PI * 2;
        const rr = Math.random() * r * 0.8;
        w.stamp(cen.x + Math.cos(a) * rr, cen.z + Math.sin(a) * rr, 0.8 + Math.random(), 0.6, 'ripple');
      }
    }
  }

  const sys = {
    // Required surface (SPEC §6.11) — kept as plain fields mirrored from the model each update.
    state: 'stowed',
    get length() {
      return model.length;
    },
    get depth() {
      return model.depth;
    },
    payout: 0,
    pursed: 0,
    hauled: 0,
    bottomContact: 0,
    corkline: model.corkline,
    polygon: () => model.polygon(),
    gap: () => model.gap(),
    containsPoint: (x, z) => model.containsPoint(x, z),
    // opts.arcade: the crew purses and hauls (no snags, smooth-bottom slow-down or corks under).
    begin(endAnchor, opts) {
      const ok = model.begin(endAnchor, opts);
      mirror();
      return ok;
    },
    // opts.blend: seconds for the ends to come alongside.
    close(opts) {
      model.close(opts);
      mirror();
    },
    purse(rate) {
      const r = model.purse(rate);
      mirror();
      return r;
    },
    haul(rate) {
      const r = model.haul(rate);
      mirror();
      return r;
    },
    stow() {
      model.stow();
      mirror();
    },

    // Extras.
    holdEnd() {
      model.holdEnd();
      mirror();
    },
    brail() {
      model.brail();
      mirror();
    },
    drawsPile: true, // false when the seiner model has its own pile (it should scale it by pileFraction)
    get rockFraction() {
      return model.rockFraction;
    },
    get snagged() {
      return model.snagTimer > 0;
    },
    get snagCount() {
      return model.snagCount;
    },
    get snagPoint() {
      return model.snagPoint;
    },
    get hole() {
      return model.hole;
    },
    get corksUnder() {
      return model.corksUnder;
    },
    get closed() {
      return model.closed;
    },
    get side() {
      return model.side;
    },
    get bodySide() {
      return model.bodySide;
    },
    get area() {
      return model.area;
    },
    get hookHealth() {
      return model.hookHealth;
    },
    get strain() {
      return model.strain;
    },
    get pileFraction() {
      return model.pileFraction;
    },
    get purseRate() {
      return model.purseRateEffective;
    },
    get haulRate() {
      return model.haulRateEffective;
    },
    get currentSpeed() {
      return model.currentSpeed;
    },
    get shoreTie() {
      return model.shoreTie;
    },
    get arcade() {
      return model.arcade;
    },
    bagCentroid: (out) => model.bagCentroid(out),
    points: model.pts,
    model,
    view,

    update(dt) {
      if (dt > 0) {
        model.update(dt);
        stampFoam(dt);
      } else {
        model.refreshGear();
      }
      mirror();
    },

    debugState() {
      return {
        state: model.state,
        length: +model.length.toFixed(1),
        depth: model.depth,
        nodes: model.sim.count,
        payout: +model.payout.toFixed(1),
        pursed: +model.pursed.toFixed(3),
        hauled: +model.hauled.toFixed(3),
        bottomContact: +model.bottomContact.toFixed(2),
        rockFraction: +model.rockFraction.toFixed(2),
        area: Math.round(model.area),
        hookHealth: +model.hookHealth.toFixed(2),
        strain: +model.strain.toFixed(3),
        snagged: model.snagTimer > 0,
        hole: model.hole,
        corksUnder: model.corksUnder,
        side: model.side,
        bodySide: model.bodySide,
        heightStride: model.env.heightStride,
        viewMs: +viewMs.toFixed(3),
      };
    },

    reset() {
      model.stow();
      mirror();
    },
  };

  function mirror() {
    sys.state = model.state;
    sys.payout = model.payout;
    sys.pursed = model.pursed;
    sys.hauled = model.hauled;
    sys.bottomContact = model.bottomContact;
  }

  // Camera-dependent geometry (cork scale, ribbons) is written after the camera has its final pose.
  let viewMs = 0;
  const clockNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  ctx.pipeline.beforeRender(() => {
    try {
      const t0 = clockNow();
      view.update(frameData(), ctx.camera);
      viewMs += (clockNow() - t0 - viewMs) * 0.05;
    } catch (err) {
      if (!sys.__viewErrored) console.error('[net] view update failed', err);
      sys.__viewErrored = true;
    }
  });

  ctx.events.on('game:ready', () => {
    // The seabed classification is lazy and takes a few tens of ms; do it during boot rather than at the first set.
    ctx.heightmap.seabedAt(0, 0);
    // WP-BOATS' seiner carries its own seine pile (scaled from net.payout/hauled); draw ours only for other hulls.
    sys.drawsPile = !ctx.systems.seiner?.object3d?.getObjectByName?.('seine-pile');
    model.calibrateSurface();
  });

  return sys;
}
