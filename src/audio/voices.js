// Voice limiter for one-shot sounds (pure bookkeeping; the WebAudio side supplies stop()).
// A new sound is admitted while fewer than `max` voices are live; otherwise it steals the lowest-priority, oldest
// voice whose priority is strictly lower (or equal and older than `stealAge` seconds), or is refused.

export function createVoiceTable(max = 28, { stealAge = 0.5 } = {}) {
  let live = [];
  let nextId = 1;
  const stats = { started: 0, refused: 0, stolen: 0, peak: 0 };
  return {
    stats,
    get count() {
      return live.length;
    },
    get max() {
      return max;
    },
    set max(v) {
      max = Math.max(1, v | 0);
    },
    list: () => live,

    // Drops voices that have finished by `now`.
    prune(now) {
      if (live.some((v) => v.end <= now)) live = live.filter((v) => v.end > now);
    },

    // → voice record or null. `stop` is called if the voice is stolen later.
    admit({ priority = 1, now = 0, end = now + 1, name = '', stop = null } = {}) {
      this.prune(now);
      if (live.length >= max) {
        let victim = null;
        for (const v of live) {
          const weaker = v.priority < priority || (v.priority === priority && now - v.start > stealAge);
          if (!weaker) continue;
          if (!victim || v.priority < victim.priority || (v.priority === victim.priority && v.start < victim.start)) victim = v;
        }
        if (!victim) {
          stats.refused++;
          return null;
        }
        live = live.filter((v) => v !== victim);
        stats.stolen++;
        try {
          victim.stop?.(now);
        } catch {
          // already stopped
        }
      }
      const v = { id: nextId++, priority, start: now, end, name, stop };
      live.push(v);
      stats.started++;
      stats.peak = Math.max(stats.peak, live.length);
      return v;
    },

    // Stops and forgets every voice (title, teleport, reset).
    clear(now = 0) {
      for (const v of live) {
        try {
          v.stop?.(now);
        } catch {
          // already stopped
        }
      }
      live = [];
    },

    byName() {
      const out = {};
      for (const v of live) out[v.name] = (out[v.name] ?? 0) + 1;
      return out;
    },
  };
}
