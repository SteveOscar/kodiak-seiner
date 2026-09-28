// One-shot player: named recipes from sfx.js, positioned in the world with a PannerNode relative to the listener
// (the camera), air absorption and sound travel time by distance, a global voice limit with priority stealing, and
// per-name concurrency caps so a popcorn school or a gull swarm never floods the mix.

import { SOUNDS } from './sfx.js';
import { createVoiceTable } from './voices.js';
import { airCutoff, travelDelay, TUNING, clamp } from './params.js';

// Rough durations for admission (the recipe returns the exact end once scheduled).
const EST = { 'surf-break': 7, thunder: 8, 'whale-blow': 3.2, breach: 3.5, radio: 4, stinger: 4, discovery: 5, horn: 2.2, 'anchor-chain': 4, sealion: 2 };
// Simultaneous voices per recipe.
const CAPS = { 'fish-jump': 6, splash: 5, gull: 4, footstep: 3, cork: 4, 'hull-slap': 3, clink: 2, 'surf-break': 3, 'whale-blow': 3, sealion: 4, eagle: 2, 'ui-click': 2, 'ui-toast': 2, radio: 3, thunder: 2, 'brail-dip': 2, 'brail-dump': 2, collision: 2, horn: 2, boil: 2, 'anchor-chain': 1 };

export function createPlayer(ac, kit, mixer, { maxVoices = TUNING.maxVoices } = {}) {
  const voices = createVoiceTable(maxVoices, { stealAge: 0.4 });
  const listener = { x: 0, y: 0, z: 0 };
  const trash = []; // { at, nodes }
  let refusedRange = 0;

  function countLive(name) {
    let n = 0;
    for (const v of voices.list()) if (v.name === name) n++;
    return n;
  }

  // Positional output chain: gain → air low-pass → panner → bus. The panner is static: one-shots are short.
  function positional(out, def, pos, d, busNode) {
    const lp = kit.filter('lowpass', airCutoff(d), 0.5);
    const p = ac.createPanner();
    p.panningModel = 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = def.ref ?? 10;
    p.rolloffFactor = def.rolloff ?? 1;
    p.maxDistance = 20000;
    if (p.positionX) {
      p.positionX.value = pos.x;
      p.positionY.value = pos.y ?? 0;
      p.positionZ.value = pos.z;
    } else p.setPosition(pos.x, pos.y ?? 0, pos.z);
    kit.chain(out, lp, p, busNode);
    return [lp, p];
  }

  const player = {
    voices,
    listener,
    SOUNDS,

    // → voice id | null. opts: { position {x,y,z}, volume, rate, delay (s), params (recipe args), bus, send (reverb
    // 0..1), rangeMul, pan (-1..1, non-positional only), priority }
    play(name, opts = {}) {
      const def = SOUNDS[name];
      if (!def) return null;
      const t0 = ac.currentTime;
      const raw = opts.position;
      const pos = raw && Number.isFinite(raw.x) && Number.isFinite(raw.z) ? { x: raw.x, y: Number.isFinite(raw.y) ? raw.y : 0, z: raw.z } : null;
      if (raw && !pos) return null;
      let d = 0;
      if (pos) {
        d = Math.hypot(pos.x - listener.x, (pos.y ?? 0) - listener.y, pos.z - listener.z);
        if (Number.isFinite(def.range) && d > def.range * (opts.rangeMul ?? 1)) {
          refusedRange++;
          return null;
        }
      }
      const cap = CAPS[name];
      if (cap && countLive(name) >= cap) return null;
      const delay = Math.max(0, opts.delay ?? 0) + (pos ? travelDelay(d) : 0);
      const t = t0 + 0.012 + delay;
      const est = EST[name] ?? 1.5;
      const v = voices.admit({ priority: opts.priority ?? def.priority ?? 1, now: t0, end: t + est, name });
      if (!v) return null;
      const vol = clamp((opts.volume ?? 1) * (def.level ?? 1), 0, 4);
      const out = kit.gain(vol);
      const busNode = mixer.bus[opts.bus ?? (def.bus === 'world' ? 'world' : def.bus)] ?? mixer.bus.world;
      const nodes = [out];
      if (pos) nodes.push(...positional(out, def, pos, d, busNode));
      else if (opts.pan) {
        const pn = kit.pan(opts.pan);
        kit.chain(out, pn, busNode);
        nodes.push(pn);
      } else out.connect(busNode);
      const sendAmt = opts.send ?? (def.reverb ? 0.9 : pos && d > 250 ? Math.min(0.7, (d - 250) / 1500) : 0);
      if (sendAmt > 0) {
        const sg = kit.gain(sendAmt);
        kit.chain(out, sg, mixer.worldSend);
        nodes.push(sg);
      }
      let end;
      try {
        end = def.fn(kit, out, t, { ...(opts.params ?? {}), rate: opts.rate ?? opts.params?.rate ?? 1 });
      } catch (err) {
        // A recipe bug must never take the game down; drop the voice.
        v.end = t0;
        out.disconnect();
        if (!player.__warned) console.error(`[audio] recipe "${name}" failed`, err);
        player.__warned = true;
        return null;
      }
      v.end = Math.max(t, Number.isFinite(end) ? end : t + est) + 0.05;
      v.stop = (at) => {
        const tt = Math.max(ac.currentTime, at ?? 0);
        out.gain.cancelScheduledValues(tt);
        out.gain.setTargetAtTime(0, tt, 0.015);
        v.end = tt + 0.1;
        trash.push({ at: tt + 0.15, nodes });
      };
      trash.push({ at: v.end + 0.1, nodes, v });
      return v.id;
    },

    setListener(x, y, z) {
      listener.x = x;
      listener.y = y;
      listener.z = z;
    },

    // Disconnects finished voices' output nodes (the sources stopped themselves) so the graph stays small.
    collect() {
      const t = ac.currentTime;
      voices.prune(t);
      if (!trash.length) return;
      let w = 0;
      for (let i = 0; i < trash.length; i++) {
        const e = trash[i];
        const at = e.v ? Math.max(e.at, e.v.end + 0.1) : e.at;
        if (at <= t) {
          for (const n of e.nodes) {
            try {
              n.disconnect();
            } catch {
              // already disconnected
            }
          }
        } else trash[w++] = e;
      }
      trash.length = w;
    },

    stopAll() {
      voices.clear(ac.currentTime);
    },

    stats() {
      return {
        live: voices.count,
        max: voices.max,
        byName: voices.byName(),
        ...voices.stats,
        outOfRange: refusedRange,
        pending: trash.length,
      };
    },
  };
  return player;
}
