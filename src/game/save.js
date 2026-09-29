// Save games, settings and the Free Explore discovery log (localStorage).
//
//   kodiak-seiner:save      the career save: ctx.game.snapshot() + { saveFormat, savedAt, meta } for the Continue button
//   kodiak-seiner:settings  { quality, volumes: {master, music, sfx, ambience}, timeSpeed, invertY, fishingMode }
//                           fishingMode 'arcade' (default: the crew purses and hauls) | 'realistic' (winch, skiff
//                           pull, tide); fishing reads it at each let-go
//   kodiak-seiner:explore   Free Explore keeps only discovery.serialize()
//
// Autosaves (career): after a delivery, a purchase, sleeping or waiting for an opener, tying up at a harbor, and on
// game:toTitle — only when ctx.game.snapshot() is non-null (not mid-set, not ashore). Event-driven saves run on the
// next frame so every system has finished reacting; game:toTitle saves immediately (the mode changes right after).
// In Free Explore the same triggers (plus each discovery) write only the explore key; the career save is untouched.
//
// Module helpers for the UI work without a ctx (hasSave, saveInfo, getSettings, setSettings, deleteSave); the ones
// that need the game (saveNow, loadSave) use the ctx bound by installSave(ctx), which season.js calls in create().

export const SAVE_KEY = 'kodiak-seiner:save';
export const SETTINGS_KEY = 'kodiak-seiner:settings';
export const EXPLORE_KEY = 'kodiak-seiner:explore';
export const SAVE_FORMAT = 1; // wrapper format; the snapshot carries core's own `version`
export const SNAPSHOT_VERSION = 1; // must match SAVE_VERSION in src/main.js

export const DEFAULT_SETTINGS = Object.freeze({
  quality: 'high',
  volumes: Object.freeze({ master: 0.8, music: 0.6, sfx: 0.9, ambience: 0.8 }),
  timeSpeed: 1,
  invertY: false,
  fishingMode: 'arcade',
});

export const FISHING_MODES = Object.freeze(['arcade', 'realistic']);

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

let fallbackStorage = null;
export function defaultStorage() {
  try {
    if (typeof localStorage !== 'undefined' && typeof localStorage?.getItem === 'function') return localStorage;
  } catch {
    // Storage can throw in sandboxed iframes; fall through to memory.
  }
  if (!fallbackStorage) fallbackStorage = memoryStorage();
  return fallbackStorage;
}

function readJson(storage, key) {
  try {
    const s = storage.getItem(key);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

function writeJson(storage, key, value) {
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.warn(`[save] could not write ${key}:`, err?.message ?? err);
    return false;
  }
}

export function isValidSave(data) {
  return !!data && typeof data === 'object' && data.version === SNAPSHOT_VERSION && !!data.systems && !!data.clock && !data.freeExplore;
}

export function mergeSettings(base, patch) {
  const out = { ...DEFAULT_SETTINGS, ...(base ?? {}), volumes: { ...DEFAULT_SETTINGS.volumes, ...(base?.volumes ?? {}) } };
  if (patch) {
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'volumes') out.volumes = { ...out.volumes, ...(v ?? {}) };
      else if (v !== undefined) out[k] = v;
    }
  }
  out.timeSpeed = Math.max(0.25, Math.min(8, Number(out.timeSpeed) || 1));
  out.invertY = !!out.invertY;
  out.fishingMode = FISHING_MODES.includes(out.fishingMode) ? out.fishingMode : DEFAULT_SETTINGS.fishingMode;
  for (const k of Object.keys(out.volumes)) out.volumes[k] = Math.max(0, Math.min(1, Number(out.volumes[k]) || 0));
  return out;
}

export function createSaveManager(ctx, storage = defaultStorage()) {
  let suspended = false;
  let pending = null;
  const offs = [];

  const explore = () => !!ctx?.state?.freeExplore;

  function metaFor(snap) {
    const eco = snap.systems?.economy;
    const d = ctx?.clock?.date?.(snap.clock?.day) ?? null;
    return {
      day: snap.clock?.day ?? 0,
      hours: snap.clock?.hours ?? 0,
      date: d?.label ?? null,
      cash: eco?.cash ?? null,
      seasonGross: eco?.stats?.seasonGross ?? null,
      boatName: snap.systems?.seiner?.name ?? ctx?.systems?.seiner?.boatName ?? null,
      discovered: snap.systems?.discovery?.discovered?.length ?? null,
    };
  }

  const api = {
    SAVE_KEY,
    SETTINGS_KEY,
    EXPLORE_KEY,

    readSave() {
      const d = readJson(storage, SAVE_KEY);
      return isValidSave(d) ? d : null;
    },
    hasSave() {
      return !!api.readSave();
    },
    // { savedAt, day, date, hours, cash, seasonGross, boatName } for the title screen, or null.
    saveInfo() {
      const d = api.readSave();
      return d ? { savedAt: d.savedAt ?? null, ...(d.meta ?? metaFor(d)) } : null;
    },
    deleteSave() {
      try {
        storage.removeItem(SAVE_KEY);
      } catch {
        // ignore
      }
    },

    // Writes the save now. → { ok, reason?, explore? }
    saveNow(reason = 'manual') {
      if (!ctx?.game) return { ok: false, reason: 'no game' };
      if (explore()) return api.saveExplore(reason);
      let snap = null;
      try {
        snap = ctx.game.snapshot();
      } catch (err) {
        console.warn('[save] snapshot threw', err?.message ?? err);
        return { ok: false, reason: 'snapshot failed' };
      }
      if (!snap) return { ok: false, reason: 'not saveable now' };
      const data = { ...snap, saveFormat: SAVE_FORMAT, savedAt: Date.now(), reason, meta: metaFor(snap) };
      const ok = writeJson(storage, SAVE_KEY, data);
      if (ok) ctx.events?.emit('game:saved', { reason, explore: false });
      return { ok };
    },

    // Continue: loads the career save into the game. → boolean
    loadSave() {
      const d = api.readSave();
      if (!d || !ctx?.game) return false;
      suspended = true;
      pending = null;
      const ok = !!ctx.game.load(d);
      suspended = false;
      return ok;
    },

    readExplore() {
      return readJson(storage, EXPLORE_KEY);
    },
    hasExplore() {
      return !!api.readExplore();
    },
    saveExplore(reason = 'explore') {
      const disc = ctx?.systems?.discovery;
      if (typeof disc?.serialize !== 'function') return { ok: false, reason: 'no discovery' };
      const ok = writeJson(storage, EXPLORE_KEY, { saveFormat: SAVE_FORMAT, savedAt: Date.now(), reason, discovery: disc.serialize() });
      if (ok) ctx.events?.emit('game:saved', { reason, explore: true });
      return { ok, explore: true };
    },
    restoreExplore() {
      const d = api.readExplore();
      const disc = ctx?.systems?.discovery;
      if (d?.discovery && typeof disc?.restore === 'function') {
        disc.restore(d.discovery);
        return true;
      }
      return false;
    },

    getSettings() {
      return mergeSettings(readJson(storage, SETTINGS_KEY));
    },
    // Merges and stores settings; applies volumes and time speed live. → { settings, reload } (reload: quality changed)
    setSettings(patch = {}) {
      const before = api.getSettings();
      const next = mergeSettings(before, patch);
      writeJson(storage, SETTINGS_KEY, next);
      api.applySettings(next);
      return { settings: next, reload: next.quality !== before.quality };
    },
    applySettings(s = api.getSettings()) {
      if (!ctx) return;
      ctx.systems?.audio?.setVolumes?.({ ...s.volumes });
      if (ctx.clock && Number.isFinite(s.timeSpeed)) ctx.clock.scale = ctx.config.time.minutesPerSecond * s.timeSpeed;
    },

    // Queue an autosave for the next frame (flush()).
    request(reason) {
      if (suspended) return;
      pending = pending ?? reason;
    },
    flush() {
      if (!pending || suspended) return null;
      // The chart, photo mode or a cutscene can't be snapshotted; keep the request until play or pause resumes.
      const mode = ctx?.state?.mode;
      if (mode === 'map' || mode === 'photo' || mode === 'cutscene') return null;
      const reason = pending;
      pending = null;
      return api.saveNow(reason);
    },
    get pending() {
      return pending;
    },
    suspend() {
      suspended = true;
      pending = null;
    },
    resume() {
      suspended = false;
    },

    // Wires autosave triggers. Called once from season.create().
    install() {
      const ev = ctx.events;
      offs.push(
        ev.on('economy:delivered', () => api.request('delivery')),
        ev.on('economy:purchase', () => api.request('purchase')),
        ev.on('boat:mooring', (e) => {
          if (e?.mooring?.kind === 'dock') api.request('tie-up');
        }),
        ev.on('place:discovered', () => {
          if (explore()) api.request('discovery');
        }),
        ev.on('game:toTitle', () => {
          if (suspended) return;
          pending = null;
          api.saveNow('title');
        }),
        ev.on('game:start', (e) => {
          suspended = false;
          pending = null;
          if (e?.freeExplore && e?.newGame) api.restoreExplore();
        }),
        ev.on('game:ready', () => {
          // Saved volumes/time speed apply at boot; the settings panel (WP-UI) writes through setSettings.
          if (storage.getItem(SETTINGS_KEY)) api.applySettings();
        }),
      );
      return api;
    },
    uninstall() {
      for (const off of offs.splice(0)) off?.();
    },
  };
  return api;
}

// ---- module-level helpers bound to the running game ----

let active = null;

export function installSave(ctx, storage) {
  active?.uninstall();
  active = createSaveManager(ctx, storage).install();
  return active;
}

const current = () => active ?? createSaveManager(null);

export const hasSave = () => current().hasSave();
export const readSave = () => current().readSave();
export const saveInfo = () => current().saveInfo();
export const deleteSave = () => current().deleteSave();
export const saveNow = (reason) => current().saveNow(reason);
export const loadSave = () => current().loadSave();
export const getSettings = () => current().getSettings();
export const setSettings = (patch) => current().setSettings(patch);
export const hasExplore = () => current().hasExplore();
