// WP-NET: the set (SPEC §6.12). State machine in ./fishing/core.js; the brailer visual in ./fishing/brailer.js.

import { createFishingCore } from './fishing/core.js';
import { createBrailer } from './fishing/brailer.js';
import { createDebugTools } from './fishing/debug.js';

export async function create(ctx) {
  const { THREE } = ctx;
  const rng = ctx.rng.fork('fishing');
  const core = createFishingCore(ctx, { rng });
  const brailer = createBrailer(ctx);
  const tools = createDebugTools(ctx);
  core.debug.pilot = tools.pilot;
  core.debug.cam = tools.cam;
  core.debug.stage = (opts) => tools.stage(core, opts);
  const tip = new THREE.Vector3();
  const hatch = new THREE.Vector3();
  const dip = new THREE.Vector3();
  const stern = new THREE.Vector3();
  const bag = { x: 0, z: 0 };

  function updateBrailer(dt) {
    const s = ctx.systems.seiner;
    const net = ctx.systems.net;
    const set = core.set;
    const accepted = set?.acceptedLbs ?? 0;
    // Water hauls and seized catches: nothing to brail, so no brailer.
    const active = core.state === 'brailing' && accepted > 0 && s?.position && net?.bagCentroid;
    if (!active) {
      brailer.update(dt, null);
      return;
    }
    if (typeof s.powerBlockPoint === 'function') s.powerBlockPoint(tip);
    else tip.copy(s.position).setY(s.position.y + 9);
    tip.y += 0.6;
    if (typeof s.sternPoint === 'function') s.sternPoint(stern);
    else stern.copy(s.position).setY(s.position.y + 1.5);
    const h = s.heading ?? 0;
    // Fish hold hatch: amidships just aft of the house, on deck.
    hatch.set(s.position.x - Math.sin(h) * 1.5, stern.y + 0.2, s.position.z + Math.cos(h) * 1.5);
    net.bagCentroid(bag);
    // Dip where the bag is, pulled in toward the hull so the whip can reach.
    const dx = bag.x - s.position.x;
    const dz = bag.z - s.position.z;
    const d = Math.hypot(dx, dz) || 1;
    const reach = Math.min(d, 8);
    dip.set(s.position.x + (dx / d) * reach, (ctx.systems.water?.heightAt?.(bag.x, bag.z) ?? 0) + 0.2, s.position.z + (dz / d) * reach);
    // A scoop holds one brailer load; a small catch half-fills it, and the bag thins out as it is brailed.
    const p = set.brailDur > 0 ? Math.min(1, set.brailT / set.brailDur) : 1;
    const loaded = Math.min(1, Math.max(0.2, accepted / ctx.config.net.phases.brailLoadLbs)) * (1 - p * 0.55);
    const r = brailer.update(dt, { active: true, boomTip: tip, hatch, dip, loaded });
    if (r?.scooped) {
      const scoops = Math.max(1, Math.ceil(set.brailDur / brailer.cycle));
      const lbs = Math.min(accepted - (set.brailedLbs ?? 0), accepted / scoops);
      if (lbs >= 1) {
        set.brailedLbs = (set.brailedLbs ?? 0) + lbs;
        ctx.events.emit('fishing:brail', { x: dip.x, z: dip.z, lbs: Math.round(lbs) });
      }
    }
  }

  const sys = {
    get state() {
      return core.state;
    },
    get setNumber() {
      return core.setNumber;
    },
    get lastSet() {
      return core.lastSet;
    },
    get stats() {
      return core.stats;
    },
    hud: core.hud,
    canSet: () => core.canSet(),
    abort: () => core.abort(),
    debug: core.debug,
    core,
    brailer,

    update(dt) {
      core.update(dt);
      updateBrailer(dt);
    },

    debugState() {
      const set = core.set;
      return {
        state: core.state,
        setNumber: core.setNumber,
        phaseT: set ? +set.phaseT.toFixed(1) : 0,
        hook: !!set?.hook,
        tied: !!set?.tied,
        payout: +core.hud.payout.toFixed(3),
        distanceToSkiff: core.hud.distanceToSkiff,
        inHook: core.hud.inHook,
        tension: +core.hud.tension.toFixed(2),
        pursed: +core.hud.pursed.toFixed(3),
        hauled: +core.hud.hauled.toFixed(3),
        stall: core.hud.stall,
        message: core.hud.message,
        lastSet: core.lastSet
          ? { n: core.lastSet.setNumber, lbs: core.lastSet.totalLbs, rating: core.lastSet.rating, value: core.lastSet.value }
          : null,
      };
    },

    serialize: () => core.serialize(),
    restore: (d) => core.restore(d),
    reset: () => core.reset(),
  };

  ctx.events.on('boat:teleport', () => {
    if (core.state !== 'idle') core.hardStop();
  });
  ctx.events.on('game:toTitle', () => {
    if (core.state !== 'idle') core.hardStop();
  });

  return sys;
}
