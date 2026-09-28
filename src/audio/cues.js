// Event cues: every discrete game event that makes a sound (fish, fishing, the boat, wildlife, weather, feedback,
// radio, UI clicks). audio.js subscribes to EVENTS at create time — before the UI exists — and forwards them here once
// the audio graph is built, so the hint check below sees the UI's shown-set before the UI updates it.

import { clamp, radioTiming } from './params.js';
import { thunderDelay } from './scene.js';

export const EVENTS = [
  'fish:jump',
  'fish:spooked',
  'skiff:splash',
  'fishing:skiffReleased',
  'fishing:closedUp',
  'fishing:snag',
  'fishing:setComplete',
  'economy:delivered',
  'economy:goal',
  'economy:purchase',
  'place:discovered',
  'camera:sighting',
  'ui:radio',
  'ui:hint',
  'ui:toast',
  'game:mode',
  'game:toTitle',
  'boat:teleport',
  'boat:horn',
  'boat:mooring',
  'boat:collision',
  'player:step',
  'bear:encounter',
  'wildlife:blow',
  'wildlife:breach',
  'sky:lightning',
];

const STEP_SURFACES = new Set(['gravel', 'sand', 'grass', 'forest', 'alder', 'rock', 'snow', 'water', 'skiff']);
// Seconds the music is lifted after a plugged set or a season goal (the triumph piece runs ~35 s).
const TRIUMPH_S = 38;

// deps: { ac, player, mixer, L (listener), shared { triumphUntil, radioBusyUntil }, panOf(x, z), resetWorld(keepRadio) }
export function createCues(ctx, { ac, player, mixer, L, shared, panOf, resetWorld }) {
  const S = () => ctx.systems;
  const rnd = Math.random;
  const tmp = new ctx.THREE.Vector3();
  const pos = (x, y, z) => ({ x, y, z });
  const warned = new Set();
  let lastMooring = null;
  let lastUiClick = -1e9;

  // VHF: calls queue behind each other (up to ~6 s of backlog); the music and world duck while one plays.
  function radio(text) {
    const now = ac.currentTime;
    const tm = radioTiming(text);
    const wait = Math.max(0, shared.radioBusyUntil - now);
    if (wait > 6) return;
    player.play('radio', { params: { text }, delay: wait, priority: 9 });
    shared.radioBusyUntil = now + wait + tm.total + 0.1;
    mixer.duck(wait + tm.duck);
  }

  const seiner = () => S().seiner;
  const at = (name, x, y, z, opts = {}) => player.play(name, { position: pos(x, y, z), ...opts });

  const handlers = {
    'fish:jump'(e) {
      if (!Number.isFinite(e.x) || !Number.isFinite(e.z)) return;
      at('fish-jump', e.x, e.y ?? 0, e.z, { params: { species: e.species, size: e.size, style: e.style }, rate: 0.92 + 0.16 * rnd() });
    },
    'fish:spooked'(e) {
      if (Number.isFinite(e.x)) at('boil', e.x, 0, e.z, { params: { size: 1 } });
    },
    'skiff:splash'(e) {
      if (Number.isFinite(e.x)) at('splash', e.x, 0, e.z, { params: { size: 3 } });
    },
    'fishing:skiffReleased'() {
      const s = seiner();
      if (!s?.position) return;
      if (typeof s.sternPoint === 'function') s.sternPoint(tmp);
      else tmp.copy(s.position);
      at('skiff-release', tmp.x, tmp.y, tmp.z);
    },
    'fishing:closedUp'() {
      const s = seiner();
      if (s?.position) at('clunk', s.position.x, (s.position.y ?? 0) + 1.5, s.position.z, { params: { strength: 0.5 }, rate: 1.2 });
    },
    'fishing:snag'(e) {
      const s = seiner();
      const x = Number.isFinite(e.x) ? e.x : s?.position?.x;
      const z = Number.isFinite(e.z) ? e.z : s?.position?.z;
      if (Number.isFinite(x)) at('snag', x, 1, z);
    },
    'fishing:setComplete'(r) {
      player.play('stinger', { params: { rating: r.rating, cited: !!r.cited }, delay: 0.35 });
      if (r.rating === 'plugged' || (r.rating === 'good' && (r.totalLbs ?? 0) >= 20000)) shared.triumphUntil = ac.currentTime + TRIUMPH_S;
    },
    'economy:delivered'() {
      player.play('cash-register', { delay: 0.1 });
    },
    'economy:goal'() {
      player.play('stinger', { params: { rating: 'plugged' }, delay: 0.2, volume: 0.9 });
      shared.triumphUntil = ac.currentTime + TRIUMPH_S;
    },
    'economy:purchase'() {
      player.play('ui-blip', { volume: 0.8, rate: 0.9 });
    },
    'place:discovered'(p) {
      // Memorial places (Awa'uq) are marked quietly: no chord.
      if (!p.memorial) player.play('discovery', { params: { kind: p.kind, memorial: false }, delay: 0.15 });
    },
    'camera:sighting'() {
      player.play('ui-blip', { volume: 0.9 });
    },
    'ui:radio'(p) {
      const m = ctx.state.mode;
      if (p.text && m !== 'title' && m !== 'loading') radio(p.text);
    },
    'ui:hint'(p) {
      if (!p.from || !p.text || ctx.state.mode === 'title' || ctx.state.mode === 'loading') return;
      // The UI shows each hint once per save; its shown-set is still unchanged here (audio subscribes first).
      const shown = S().ui?.serialize?.()?.hintsShown;
      if (Array.isArray(shown) && shown.includes(p.id)) return;
      radio(p.text);
    },
    'ui:toast'(p) {
      if (p.kind === 'discovery' || p.kind === 'goal' || ctx.state.mode === 'title') return;
      const warn = p.kind === 'warn' || p.kind === 'warning';
      player.play('ui-toast', { volume: warn ? 0.9 : 0.6, rate: warn ? 0.84 : 1 });
    },
    'game:mode'(e) {
      if ((e.prev === 'paused' || e.prev === 'map') && e.mode === 'play') player.play('ui-close', { volume: 0.5 });
    },
    'game:toTitle'() {
      resetWorld();
    },
    'boat:teleport'(e) {
      if (e.reason !== 'boot') resetWorld(true);
    },
    'boat:horn'() {
      const s = seiner();
      if (s?.position) at('horn', s.position.x, (s.position.y ?? 0) + 8, s.position.z, { send: 0.5 });
    },
    'boat:mooring'(e) {
      const s = seiner();
      if (!s?.position) return;
      if (typeof s.bowPoint === 'function') s.bowPoint(tmp);
      else tmp.copy(s.position);
      const m = e.mooring;
      if (m?.kind === 'anchor') at('anchor-chain', tmp.x, (tmp.y ?? 0) + 1, tmp.z, { params: { mode: 'drop' } });
      else if (m?.kind === 'dock') at('collision', s.position.x, 1, s.position.z, { params: { kind: 'boat', strength: 0.25 } });
      else if (!m && lastMooring?.kind === 'anchor') at('anchor-chain', tmp.x, (tmp.y ?? 0) + 1, tmp.z, { params: { mode: 'haul' } });
      lastMooring = m ?? null;
    },
    'boat:collision'(e) {
      const s = seiner();
      const x = Number.isFinite(e.x) ? e.x : s?.position?.x;
      const z = Number.isFinite(e.z) ? e.z : s?.position?.z;
      if (!Number.isFinite(x)) return;
      at('collision', x, 0.5, z, { params: { kind: e.kind === 'boat' ? 'boat' : 'ground', strength: clamp((Number(e.speed) || 2) / 6, 0.15, 1.2) } });
    },
    'player:step'(e) {
      const p = S().player?.position;
      const surface = STEP_SURFACES.has(e.surface) ? e.surface : 'gravel';
      const q = p ? pos(p.x, p.y ?? 0, p.z) : pos(L.x, L.y - 1.6, L.z);
      player.play('footstep', { position: q, params: { surface, run: !!e.run }, rate: 0.94 + 0.12 * rnd() });
    },
    'bear:encounter'(e) {
      const b = S().wildlife?.bears?.find?.((x) => x.id === e.bearId);
      const x = Number.isFinite(e.x) ? e.x : b?.position?.x;
      const z = Number.isFinite(e.z) ? e.z : b?.position?.z;
      if (!Number.isFinite(x)) return;
      const y = (b?.position?.y ?? S().terrain?.heightAt?.(x, z) ?? 0) + 1;
      if (e.stage === 'watch') at('bear-huff', x, y, z, { params: { huffs: 2, intensity: 0.7 } });
      else if (e.stage === 'charge') at('bear-charge', x, y, z, { priority: 8 });
      else if (e.stage === 'retreat') at('bear-huff', x, y, z, { params: { huffs: 1, intensity: 0.4, pops: 0 } });
    },
    'wildlife:blow'(e) {
      if (!Number.isFinite(e.x)) return;
      const orca = e.kind === 'orca';
      at('whale-blow', e.x, 1, e.z, { params: { strength: orca ? 0.45 : 1 }, rate: orca ? 1.5 : 0.95 + 0.1 * rnd() });
    },
    'wildlife:breach'(e) {
      if (!Number.isFinite(e.x)) return;
      if (e.stage === 'splash') at('breach', e.x, 0, e.z);
      else if (e.stage === 'lunge') at('splash', e.x, 0, e.z, { params: { size: 3.5 } });
    },
    'sky:lightning'(e) {
      const d = Number(e.distance) || 2500;
      const pan = Number.isFinite(e.x) && Number.isFinite(e.z) ? panOf(e.x, e.z) * 0.6 : 0;
      player.play('thunder', { delay: thunderDelay(d), params: { distance: d, intensity: clamp(Number(e.intensity) || 0.8, 0.2, 1.2) }, pan, send: 0.6 });
    },
  };

  // UI clicks for every interactive button (the title menu and panels also call play('ui-click'); deduped).
  function onDomClick(e) {
    const el = e.target?.closest?.('button, [role="button"], .ui-interactive a, input[type="checkbox"], select');
    if (!el) return;
    const now = performance.now();
    if (now - lastUiClick < 80) return;
    lastUiClick = now;
    player.play('ui-click', { volume: 0.4 });
  }

  return {
    event(name, p) {
      const fn = handlers[name];
      if (!fn) return;
      try {
        fn(p ?? {});
      } catch (err) {
        if (!warned.has(name)) console.error(`[audio] ${name} cue failed`, err);
        warned.add(name);
      }
    },
    // True right after a DOM click played its tick (the title menu also calls play('ui-click') for the same click).
    clickedRecently() {
      return performance.now() - lastUiClick < 80;
    },
    attachDom() {
      if (typeof document === 'undefined') return () => {};
      document.addEventListener('click', onDomClick, true);
      return () => document.removeEventListener('click', onDomClick, true);
    },
  };
}
