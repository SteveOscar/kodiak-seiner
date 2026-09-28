// WP-UI: title screen, HUD, messages, chart, logbook, reports, fish tickets, harbour menu, pause/settings/help,
// binoculars and photo mode (SPEC §6.15 ui, §4.2 modes, §9 UI).
//
// The public methods only emit events (ui:toast, ui:radio, ui:hint, ui:open, ui:fade); everything visible is built
// from events, queued, and drained in frame(realDt). Only the UI reacts to the pause, map, logbook, help and photo
// keys; it owns the 'paused', 'map' and 'photo' modes it enters and resumes play when its last panel closes.
// #ui children default to pointer-events none; interactive widgets opt in with .ui-interactive.

import { routeKeys, createThrottle } from './lib/logic.js';
import { h } from './dom.js';
import { createHud } from './hud.js';
import { createMessages } from './messages.js';
import { createTitle } from './title.js';
import { createPausePanel, createSettingsPanel, createHelpPanel, createCreditsPanel, createConfirmPanel } from './menus.js';
import { createLogbook } from './logbook.js';
import { createMap } from './map.js';
import { createReportPanel, createTicketPanel } from './report.js';
import { createHarborPanel } from './harbor.js';
import { createOverlays } from './overlays.js';
import { createSaves } from './saves.js';

const WAYPOINT_REACHED = 60; // m
const MAX_SETS = 40;
const MAX_TICKETS = 16;

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

export async function create(ctx) {
  const { events } = ctx;
  const emit = (name, payload) => events.emit(name, payload);
  const hintsShown = new Set();
  const history = { sets: [], tickets: [] };
  let waypoint = null;
  let visible = true;
  let root = null;
  let messages = null;
  let map = null;
  const stack = [];

  const sys = {
    get visible() {
      return visible;
    },
    set visible(v) {
      visible = !!v;
      root?.classList.toggle('ui-hidden', !visible);
    },
    get waypoint() {
      return waypoint;
    },
    // --- required API: methods only emit; rendering happens from events.
    toast: (text, opts = {}) => emit('ui:toast', { text: String(text ?? ''), kind: opts.kind ?? 'info', duration: opts.duration ?? 4 }),
    radio: (from, text, channel = '16') => emit('ui:radio', { from, text: String(text ?? ''), channel: String(channel ?? '16') }),
    hint: (id, text) => emit('ui:hint', { id, text: String(text ?? '') }),
    openMap: () => emit('ui:open', { panel: 'map' }),
    openLogbook: (opts = {}) => emit('ui:open', { panel: 'logbook', opts }),
    // --- extras
    openHarbor: (place) => emit('ui:open', { panel: 'harbor', opts: place ?? null }),
    fade: (opts = {}) => emit('ui:fade', opts),
    setWaypoint(p) {
      waypoint = p && Number.isFinite(p.x) && Number.isFinite(p.z) ? { x: +p.x.toFixed(1), z: +p.z.toFixed(1) } : null;
      emit('ui:waypoint', { waypoint });
    },
    serialize() {
      return {
        hintsShown: [...hintsShown],
        waypoint,
        sets: history.sets.slice(-MAX_SETS),
        tickets: history.tickets.slice(-MAX_TICKETS),
      };
    },
    restore(d) {
      if (!d) return;
      hintsShown.clear();
      for (const id of d.hintsShown ?? []) if (typeof id === 'string') hintsShown.add(id);
      waypoint = d.waypoint && Number.isFinite(d.waypoint.x) ? { x: d.waypoint.x, z: d.waypoint.z } : null;
      history.sets = Array.isArray(d.sets) ? d.sets.slice(-MAX_SETS) : [];
      history.tickets = Array.isArray(d.tickets) ? d.tickets.slice(-MAX_TICKETS) : [];
    },
    reset() {
      hintsShown.clear();
      waypoint = null;
      history.sets = [];
      history.tickets = [];
    },
    debugState() {
      return { mode: ctx.state.mode, panels: [...stack], waypoint, hintsShown: hintsShown.size, sets: history.sets.length, tickets: history.tickets.length, ...(messages?.debugState?.() ?? {}), chartReady: !!map?.rasterReady };
    },
  };

  // Node (tests) or a missing #ui: the API still works, nothing is drawn.
  if (typeof document === 'undefined') return sys;
  root = document.getElementById('ui');
  if (!root) {
    root = document.createElement('div');
    root.id = 'ui';
    document.body.append(root);
  }
  root.dataset.mode = ctx.state.mode;
  // One design pixel per CSS pixel at ~1350×760; the HUD scales with the viewport within sensible limits.
  const applyScale = () => {
    const k = Math.max(0.8, Math.min(1.35, Math.min(window.innerHeight / 760, window.innerWidth / 1350) ** 0.6));
    root.style.setProperty('--k', k.toFixed(3));
  };
  applyScale();
  window.addEventListener('resize', applyScale);

  const saves = await createSaves(ctx);
  const scrim = h('div.ui-scrim');
  root.append(scrim);
  const hud = createHud(ctx, root);
  const overlays = createOverlays(ctx, root);
  messages = createMessages(ctx, root);
  const modalRoot = h('div.ui-modals');
  root.append(modalRoot);

  // ---------------------------------------------------------------- panel stack
  const panels = {};
  let changingMode = false;
  const inGame = () => ctx.state.mode !== 'title' && ctx.state.mode !== 'loading';
  const top = () => stack[stack.length - 1] ?? null;

  function setMode(mode) {
    if (ctx.state.mode === mode) return;
    changingMode = true;
    try {
      ctx.game.setMode(mode);
    } finally {
      changingMode = false;
    }
  }

  function syncStack() {
    stack.forEach((id, i) => {
      const p = panels[id];
      p.el.style.zIndex = String(20 + i);
      p.el.classList.toggle('is-top', i === stack.length - 1);
    });
    const modal = stack.some((id) => id !== 'map');
    root.classList.toggle('panel-open', modal);
    root.classList.toggle('map-open', stack.includes('map'));
  }

  function open(id, opts) {
    const p = panels[id];
    if (!p) return;
    if (id === 'map' && inGame() && ctx.state.mode !== 'play' && ctx.state.mode !== 'paused' && ctx.state.mode !== 'map') return;
    const i = stack.indexOf(id);
    if (i >= 0) stack.splice(i, 1);
    stack.push(id);
    try {
      p.show?.(opts);
    } catch (err) {
      console.error(`[ui] ${id}.show threw`, err);
    }
    p.el.classList.add('open');
    syncStack();
    if (inGame()) setMode(id === 'map' ? 'map' : 'paused');
    ctx.systems.audio?.play?.('ui-open', { volume: 0.4 });
  }

  function close(id = top()) {
    const i = stack.indexOf(id);
    if (i < 0) return;
    stack.splice(i, 1);
    const p = panels[id];
    p.el.classList.remove('open', 'is-top');
    try {
      p.hide?.();
    } catch (err) {
      console.error(`[ui] ${id}.hide threw`, err);
    }
    syncStack();
    if (!inGame()) return;
    if (!stack.length) setMode('play');
    else setMode(top() === 'map' ? 'map' : 'paused');
  }

  function closeAll({ silent = false } = {}) {
    while (stack.length) {
      const id = stack.pop();
      panels[id].el.classList.remove('open', 'is-top');
      try {
        panels[id].hide?.();
      } catch {
        // ignore
      }
    }
    syncStack();
    if (!silent && inGame() && ctx.state.mode !== 'play') setMode('play');
  }

  function resume() {
    closeAll();
  }

  function back() {
    const t = top();
    if (!t) return;
    if (panels[t].back?.()) return;
    close(t);
  }

  const confirm = (opts) => open('confirm', opts);

  function toTitle() {
    closeAll({ silent: true });
    pendingModals.length = 0;
    ctx.game.toTitle();
  }

  const register = (p) => {
    panels[p.id] = p;
    modalRoot.append(p.el);
  };
  register(createPausePanel(ctx, { open, close, saves, toTitle, resume }));
  register(createSettingsPanel(ctx, { saves, confirm, close: () => close('settings') }));
  register(createHelpPanel(ctx, { close: () => close('help') }));
  register(createCreditsPanel(ctx, { close: () => close('credits') }));
  const confirmPanel = createConfirmPanel(ctx, { close: () => close('confirm') });
  register(confirmPanel);
  register(createLogbook(ctx, { close: () => close('logbook'), openTicket: (r) => open('ticket', r), history }));
  map = createMap(ctx, { close: () => close('map'), getWaypoint: () => waypoint, setWaypoint: (p) => sys.setWaypoint(p) });
  register(map);
  register(createReportPanel(ctx, { close: () => close('report') }));
  register(createTicketPanel(ctx, { close: () => close('ticket') }));
  register(createHarborPanel(ctx, { close: () => close('harbor'), resume }));

  const title = createTitle(ctx, root, {
    saves,
    openPanel: (id) => open(id),
    confirm,
    onStart: () => {
      closeAll({ silent: true });
    },
  });

  // ---------------------------------------------------------------- events -> queues
  const pendingModals = [];
  let pendingOpen = null;

  events.on('ui:toast', (p) => {
    if (p?.text) messages.inbox.toasts.push({ text: String(p.text), kind: p.kind ?? 'info', duration: p.duration });
  });
  events.on('ui:radio', (p) => {
    if (p?.text) messages.inbox.radio.push({ from: p.from, text: String(p.text), channel: p.channel });
  });
  events.on('ui:hint', (p) => {
    if (!p?.id || !p.text || !inGame() || hintsShown.has(p.id)) return;
    hintsShown.add(p.id);
    if (p.from) messages.inbox.radio.push({ from: p.from, text: String(p.text), channel: p.channel ?? '10', tip: true });
    else messages.queueHint({ id: p.id, text: String(p.text) });
  });
  events.on('ui:open', (p) => {
    if (p?.panel) pendingOpen = { panel: p.panel, opts: p.opts };
  });
  events.on('ui:fade', (p) => messages.fade(p ?? {}));
  events.on('place:discovered', (p) => {
    if (p?.name && !p.memorial) messages.inbox.discoveries.push({ ...p });
  });
  events.on('fishing:setComplete', (r) => {
    if (!r) return;
    history.sets.push({
      setNumber: r.setNumber,
      day: ctx.clock.day,
      hours: +ctx.clock.hours.toFixed(2),
      rating: r.rating,
      waterHaul: !!r.waterHaul,
      cited: !!r.cited,
      totalLbs: r.totalLbs ?? 0,
      value: r.value ?? 0,
    });
    if (history.sets.length > MAX_SETS) history.sets.shift();
    pendingModals.push({ panel: 'report', data: r });
  });
  events.on('economy:delivered', (r) => {
    if (!r) return;
    history.tickets.push(JSON.parse(JSON.stringify(r)));
    if (history.tickets.length > MAX_TICKETS) history.tickets.shift();
    pendingModals.push({ panel: 'ticket', data: r });
  });
  events.on('opener:start', () => {
    if (ctx.state.mode !== 'play') return;
    messages.inbox.banners.push({ kicker: 'ADF&G · Kodiak', title: 'The period is open', sub: 'Purse seining until 10:00 PM — good fishing', tone: 'opener', life: 5 });
  });
  events.on('opener:end', () => {
    if (ctx.state.mode !== 'play') return;
    messages.inbox.banners.push({ kicker: 'ADF&G · Kodiak', title: 'The period has closed', sub: 'Waters are closed until the next opener', tone: 'closed', life: 5 });
  });
  events.on('game:mode', ({ mode, prev }) => {
    root.dataset.mode = mode;
    if (mode === 'title') {
      closeAll({ silent: true });
      pendingModals.length = 0;
      pendingOpen = null;
      messages.clearAll();
      hud.resetPrompts();
      title.show();
    } else if (prev === 'title' || prev === 'loading') {
      title.hide();
    }
    if (!changingMode && mode === 'play' && stack.length) closeAll({ silent: true });
    hudTick.force();
    hudBeat = false;
  });
  events.on('game:start', (e) => {
    hud.resetPrompts();
    hudTick.force();
    hudBeat = false;
    if (e?.newGame) {
      setTimeout(() => sys.hint('ui-controls', 'Throttle (W) (S), rudder (A) (D). Press F1 any time for the controls, (M) for the chart and (L) for the logbook.'), 9000);
    }
  });
  events.on('season:end', (e) => {
    const me = (e?.board ?? []).find((r) => r.player);
    const n = e?.board?.length ?? 0;
    messages.inbox.banners.push({
      kicker: 'ADF&G · Kodiak Management Area',
      title: 'The season is over',
      sub: me ? `Finished ${ordinal(me.rank)} of ${n} on the fleet board` : 'No more periods are scheduled',
      tone: me?.rank === 1 ? 'goal' : 'closed',
      life: 8,
    });
  });
  // Short, rate-limited cues for events that otherwise only live in the 3D view.
  const cueAt = {};
  const cue = (key, seconds, text, kind = 'warn') => {
    if ((cueAt[key] ?? -1e9) > time - seconds || ctx.state.mode !== 'play') return;
    cueAt[key] = time;
    sys.toast(text, { kind, duration: 4 });
  };
  events.on('boat:collision', (e) => {
    if (e?.kind === 'ground' && (e.speed ?? 0) > 0.8) cue('ground', 20, 'Touched bottom — back her off (S) into deeper water');
  });
  events.on('bear:encounter', (e) => {
    if (e?.stage === 'watch') cue('bear-watch', 60, 'A brown bear stands up to watch you. Back away slowly.');
    else if (e?.stage === 'charge') cue('bear-charge', 30, 'Bluff charge! Get back to the skiff.');
  });
  events.on('time:skip', () => map.refreshSide());
  events.on('game:ready', () => {
    setTimeout(() => map.schedule(), 1500);
  });
  ctx.pipeline?.onResize?.(() => map.onResize());

  // ---------------------------------------------------------------- per frame
  const hudTick = createThrottle(20);
  let hudBeat = false;
  const keys = new Set();
  let time = 0;

  function readKeys() {
    keys.clear();
    const I = ctx.input;
    if (!I) return keys;
    const kp = (c) => !!I.keyPressed?.(c);
    if (kp('Escape')) keys.add('escape');
    if (kp('Escape') || kp('KeyP') || (I.pressed?.('pause') && !kp('Escape'))) keys.add('pause');
    if (kp('KeyM') || I.pressed?.('map')) keys.add('map');
    if (kp('KeyL') || kp('KeyJ')) keys.add('logbook');
    if (kp('F1') || kp('Slash')) keys.add('help');
    if (kp('KeyH')) keys.add('photo');
    if (kp('Space') || kp('Enter')) keys.add('confirm');
    if (kp('ArrowUp') || kp('KeyW')) keys.add('up');
    if (kp('ArrowDown') || kp('KeyS')) keys.add('down');
    return keys;
  }

  sys.frame = (realDt) => {
    const dt = Math.min(0.25, Math.max(0, Number(realDt) || 0));
    time += dt;
    const mode = ctx.state.mode;

    // Requests from openMap/openLogbook/openHarbor.
    if (pendingOpen) {
      const req = pendingOpen;
      pendingOpen = null;
      if (inGame() && mode !== 'photo' && mode !== 'cutscene') open(req.panel, req.opts);
    }

    // Keys (only the UI reacts to pause, map, logbook, help, photo).
    const k = readKeys();
    const ae = document.activeElement;
    const typing = (ae?.tagName === 'INPUT' && ae.type === 'text') || ae?.tagName === 'TEXTAREA';
    if (k.size && !typing) {
      const t = top();
      const nav = mode === 'paused' && t && typeof panels[t]?.nav === 'function';
      if (k.has('confirm') && t === 'confirm') {
        // Enter/Space accepts a confirm dialog.
        confirmPanel.el.querySelector('.panel-actions .btn.primary')?.click();
      } else if (nav && (k.has('up') || k.has('down'))) {
        panels[t].nav(k.has('up') ? -1 : 1);
      } else if (nav && k.has('confirm')) {
        panels[t].activate?.();
      } else {
        const act = routeKeys(mode, t, k);
        if (act?.type === 'open') open(act.panel);
        else if (act?.type === 'close') close();
        else if (act?.type === 'back') back();
        else if (act?.type === 'photo') setMode(act.on ? 'photo' : 'play');
      }
    }

    // Set reports and fish tickets pause the game; they wait until play (or open over the harbour/pause menu).
    if (pendingModals.length && inGame()) {
      const t = top();
      const ok = mode === 'play' || (mode === 'paused' && t !== 'report' && t !== 'ticket' && t !== 'confirm');
      if (ok) {
        const m = pendingModals.shift();
        open(m.panel, m.data);
      }
    }

    messages.tick(dt, { mode: ctx.state.mode, hudVisible: visible && ctx.state.mode !== 'photo' });
    overlays.frame(dt, { mode: ctx.state.mode });
    if (ctx.state.mode === 'title') title.tick(dt, { panelOpen: stack.length > 0 });
    if (stack.includes('map')) map.tick(dt);

    const showHud = inGame() && ctx.state.mode !== 'photo';
    if (showHud) {
      hud.frame();
      // A 20 Hz beat alternating between the HUD panels and the sonar: each refreshes at 10 Hz on its own frames.
      if (hudTick.due(dt)) {
        hudBeat = !hudBeat;
        if (hudBeat) {
          hud.update(time);
          overlays.update();
          checkWaypoint();
        } else hud.updateSonar(time);
      }
    }
  };

  function checkWaypoint() {
    if (!waypoint || ctx.state.mode !== 'play') return;
    const p = ctx.systems.seiner?.position;
    if (!p) return;
    if (Math.hypot(p.x - waypoint.x, p.z - waypoint.z) < WAYPOINT_REACHED) {
      sys.setWaypoint(null);
      sys.toast('Waypoint reached', { kind: 'info', duration: 3 });
    }
  }

  return sys;
}
