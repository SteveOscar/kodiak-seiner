// VHF radio scheduler: a rate-limited priority queue plus context-aware ambient chatter. Pure module: time is fed
// in via update(dt), output goes through the `emit({from, text, channel})` callback.

export function fillTemplate(text, tokens) {
  return text.replace(/\{(\w+)\}/g, (m, k) => {
    const v = tokens[k];
    if (v === undefined || v === null) return m;
    return typeof v === 'function' ? v() : String(v);
  });
}

// Ambient category weights by context.
export function ambientWeights({ open, hours, fishingDay, preset }) {
  const night = hours >= 23 || hours < 5;
  if (night) return { night: 1 };
  const w = {};
  if (open) {
    Object.assign(w, { jumpers: 4, sets: 4, prices: 1, weather: 1.5, bears: 0.8, wildlife: 1, banter: 1.5, tender: 1.2 });
    if (hours >= 20.5) w.evening = 3;
  } else {
    Object.assign(w, { closed: 3, prices: 1.2, weather: 1.5, bears: 1.2, wildlife: 1, banter: 2, tender: 0.6 });
    if (fishingDay && hours >= 4.5 && hours < 6) Object.assign(w, { morning: 6, jumpers: 1 });
    if (hours >= 22) w.night = 3;
  }
  if (preset === 'storm' || preset === 'fog') w.weather = (w.weather ?? 0) + 2.5;
  return w;
}

// Mean seconds between ambient lines.
export function ambientInterval({ open, hours }) {
  if (hours >= 23 || hours < 5) return [180, 320];
  return open ? [55, 110] : [90, 170];
}

// While the radio is held (a coaching tip is on screen), only messages at or above this priority may play.
export const HOLD_BYPASS_PRIORITY = 9;

export function createRadio({ rng, emit, minGap = 12, recentSize = 48 }) {
  let t = 0;
  let sinceLast = minGap;
  let nextAmbient = 20;
  let holdUntil = 0;
  const queue = [];
  const recent = [];
  const cooldowns = new Map();

  function weightedPick(weights) {
    const entries = Object.entries(weights).filter(([, v]) => v > 0);
    let x = rng.next() * entries.reduce((a, [, v]) => a + v, 0);
    for (const [k, v] of entries) {
      x -= v;
      if (x <= 0) return k;
    }
    return entries.length ? entries[entries.length - 1][0] : null;
  }

  const radio = {
    get time() {
      return t;
    },
    get queued() {
      return queue.length;
    },
    // True while hold() keeps routine traffic off the air.
    get held() {
      return t < holdUntil;
    },

    // Keeps routine traffic (queued and ambient) off the air for `seconds`, e.g. while a tip card is being read.
    // Queued messages wait (they still expire on their ttl); priority ≥ HOLD_BYPASS_PRIORITY plays anyway.
    hold(seconds) {
      holdUntil = Math.max(holdUntil, t + Math.max(0, Number(seconds) || 0));
    },

    // Queue a message. priority: higher first; ttl: seconds before it goes stale; key+cooldown: suppress repeats;
    // delay: seconds before it may play; gap: minimum silence before it (default minGap).
    push(msg, { priority = 1, ttl = 60, key = null, cooldown = 0, delay = 0, gap = null } = {}) {
      if (!msg?.text) return false;
      if (key) {
        const until = cooldowns.get(key);
        if (until !== undefined && until > t) return false;
        if (cooldown > 0) cooldowns.set(key, t + cooldown);
      }
      queue.push({ ...msg, priority, expires: t + delay + ttl, readyAt: t + delay, gap: gap ?? minGap, seq: t });
      return true;
    },

    // Picks an unused line from a category (strings or {t, wx}) that suits the sky preset.
    pickLine(lines, category, preset = null) {
      const list = lines[category];
      if (!list?.length) return null;
      const ok = list
        .map((l, i) => ({ text: typeof l === 'string' ? l : l.t, wx: typeof l === 'string' ? null : l.wx, id: `${category}:${i}` }))
        .filter((l) => !l.wx || !preset || l.wx.includes(preset));
      if (!ok.length) return null;
      const fresh = ok.filter((l) => !recent.includes(l.id));
      const pool = fresh.length ? fresh : ok;
      const line = pool[Math.floor(rng.next() * pool.length)];
      recent.push(line.id);
      if (recent.length > recentSize) recent.shift();
      return line;
    },

    // Advance time; plays at most one message. `ambient(category)` builds an ambient message or returns null.
    // ctx: { open, hours, fishingDay, preset, quiet, ambientScale } — ambientScale stretches the ambient interval.
    update(dt, ctx, ambient) {
      t += dt;
      sinceLast += dt;
      const held = t < holdUntil;
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].expires < t) queue.splice(i, 1);
      let best = -1;
      for (let i = 0; i < queue.length; i++) {
        const q = queue[i];
        if (q.readyAt > t || sinceLast < q.gap || (held && q.priority < HOLD_BYPASS_PRIORITY)) continue;
        if (best < 0 || q.priority > queue[best].priority || (q.priority === queue[best].priority && q.seq < queue[best].seq)) best = i;
      }
      if (best >= 0) {
        const q = queue.splice(best, 1)[0];
        sinceLast = 0;
        emit({ from: q.from, text: q.text, channel: q.channel });
        if (q.then) radio.push(q.then, { priority: q.priority + 1, ttl: 30, delay: q.thenDelay ?? 4, gap: 3 });
        return q;
      }
      if (!ctx || ctx.quiet || held) return null;
      nextAmbient -= dt;
      if (nextAmbient > 0 || queue.length) return null;
      const [a, b] = ambientInterval(ctx);
      nextAmbient = (a + (b - a) * rng.next()) * Math.max(1, ctx.ambientScale ?? 1);
      const cat = weightedPick(ambientWeights(ctx));
      const msg = cat ? ambient?.(cat) : null;
      if (msg) radio.push(msg, { priority: 0, ttl: 20 });
      return null;
    },

    // Seconds until the next ambient line (for tests and debug).
    get nextAmbient() {
      return nextAmbient;
    },
    set nextAmbient(v) {
      nextAmbient = v;
    },

    clear() {
      queue.length = 0;
      holdUntil = 0;
    },
  };
  return radio;
}
