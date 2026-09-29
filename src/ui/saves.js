// Save/settings access for the UI. Prefers the running save manager (ctx.systems.season.save), then the module
// helpers in src/game/save.js (loaded lazily so a broken neighbour never stops the UI), then plain localStorage.

const SAVE_KEY = 'kodiak-seiner:save';
const SETTINGS_KEY = 'kodiak-seiner:settings';
const DEFAULTS = { quality: 'high', volumes: { master: 0.8, music: 0.6, sfx: 0.9, ambience: 0.8 }, timeSpeed: 1, invertY: false, fishingMode: 'arcade' };

function read(key) {
  try {
    const s = localStorage.getItem(key);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

export async function createSaves(ctx) {
  let mod = null;
  try {
    mod = await import('../game/save.js');
  } catch {
    mod = null;
  }
  const mgr = () => ctx.systems.season?.save ?? null;
  const call = (name, ...args) => {
    const m = mgr();
    if (typeof m?.[name] === 'function') return m[name](...args);
    if (typeof mod?.[name] === 'function') return mod[name](...args);
    return undefined;
  };

  return {
    hasSave() {
      const r = call('hasSave');
      if (r !== undefined) return !!r;
      const d = read(SAVE_KEY);
      return !!d && !!d.systems && !d.freeExplore;
    },
    saveInfo() {
      const r = call('saveInfo');
      if (r !== undefined) return r;
      const d = read(SAVE_KEY);
      if (!d?.systems || d.freeExplore) return null;
      return { savedAt: d.savedAt ?? null, day: d.clock?.day ?? 0, hours: d.clock?.hours ?? 0, cash: d.systems?.economy?.cash ?? null, seasonGross: d.systems?.economy?.stats?.seasonGross ?? null, boatName: d.systems?.seiner?.name ?? null };
    },
    loadSave() {
      const r = call('loadSave');
      if (r !== undefined) return !!r;
      const d = read(SAVE_KEY);
      return d ? !!ctx.game.load(d) : false;
    },
    saveNow(reason = 'manual') {
      const r = call('saveNow', reason);
      if (r !== undefined) return r;
      const snap = ctx.game.snapshot?.();
      if (!snap) return { ok: false };
      try {
        localStorage.setItem(SAVE_KEY, JSON.stringify({ ...snap, savedAt: Date.now() }));
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
    getSettings() {
      const r = call('getSettings');
      if (r !== undefined) return r;
      const s = read(SETTINGS_KEY) ?? {};
      return { ...DEFAULTS, ...s, volumes: { ...DEFAULTS.volumes, ...(s.volumes ?? {}) } };
    },
    setSettings(patch) {
      const r = call('setSettings', patch);
      if (r !== undefined) return r;
      const before = this.getSettings();
      const next = { ...before, ...patch, volumes: { ...before.volumes, ...(patch?.volumes ?? {}) } };
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      } catch {
        // storage unavailable
      }
      ctx.systems.audio?.setVolumes?.({ ...next.volumes });
      return { settings: next, reload: next.quality !== before.quality };
    },
  };
}
