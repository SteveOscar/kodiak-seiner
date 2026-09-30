// "Where do you start?": the start-location panel over the title cinematic, shown before every new game (New Season
// and Free Explore). It takes the title column's place on the left of the screen. The choices, their order and the
// preselection come from ./lib/start.js; title.js starts the game with the pick.
//
//   const picker = createStartPicker(ctx, titleEl, { onPick({ mode, option, startAt }), onCancel() })
//   picker.open('season' | 'explore')   → false when there is nothing to choose (stubbed places): start directly
//   picker.tick()                       raw keys while open: ↑/↓ (W/S) choose, Enter/Space start, Esc back
//   picker.deactivate()                 stop taking input but stay on screen (the title fades out around it)
//   picker.warm()                       work out the New Season starts in idle time while the title plays
//   picker.reset()                      back to the title menu instantly (title.show)

import { h, clear, button, setText } from './dom.js';
import { calendar } from './lib/format.js';
import { buildStartOptions, filterStartOptions, groupStartOptions, preselectIndex, pickSurprise, readLastStart, rememberStart, seasonPoseFor, startAtFor } from './lib/start.js';

function localStore() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function createStartPicker(ctx, host, { onPick, onCancel }) {
  const kicker = h('div.sp-kicker');
  const sub = h('div.sp-sub');
  const search = h('input.sp-search', { type: 'text', placeholder: 'Search places — bays, villages, capes, peaks…', spellcheck: false, autocomplete: 'off', 'aria-label': 'Search places' });
  const bar = h('div.sp-bar', null, [search]);
  const list = h('div.sp-list', { role: 'listbox', 'aria-label': 'Start locations' });
  const detailMeta = h('div.sp-meta');
  const detailBlurb = h('div.sp-blurb');
  const detail = h('div.sp-detail', null, [detailMeta, detailBlurb]);
  const startBtn = button('Start here', () => pick(), { cls: 'primary sp-start', key: 'Enter' });
  const backBtn = button('Back', () => cancel(), { cls: 'sp-back', key: 'Esc' });
  const el = h('div.start-picker.ui-interactive', { role: 'dialog', 'aria-label': 'Where do you start?' }, [
    kicker,
    h('h2.sp-title', { text: 'Where do you start?' }),
    sub,
    h('div.sp-rule'),
    bar,
    list,
    detail,
    h('div.sp-actions', null, [backBtn, startBtn]),
  ]);
  host.append(el);

  let mode = 'season';
  let all = [];
  let shown = [];
  let rows = [];
  let sel = -1;
  let active = false;
  let armed = false;
  // The panel opens under the cursor that clicked New Season / Free Explore: hover only moves the selection once the
  // pointer has actually moved, so the preselected choice survives the click.
  let lastPointer = null;
  let openPointer = null;
  window.addEventListener('mousemove', (e) => {
    lastPointer = { x: e.clientX, y: e.clientY };
  }, { passive: true });

  // New Season starts away from Kodiak search the seabed (lib/start.js seasonStartPose); the results hold for the
  // session. warm() works them out one port per idle slice while the title plays, so the panel opens without a pause.
  const seasonPoses = new Map();
  let warming = null;

  function targetsNow() {
    try {
      return ctx.systems.season?.travel?.teleportTargets?.() ?? [];
    } catch (err) {
      console.error('[ui] start targets failed', err);
      return [];
    }
  }

  function seaArgs() {
    const hm = ctx.heightmap;
    const sea = hm && typeof hm.depthAt === 'function' && typeof hm.shoreDistance === 'function' ? hm : null;
    return { sea, closedWaters: ctx.systems.season?.closedWaters ?? null, netDepth: ctx.config.net?.depth ?? 16, cache: seasonPoses };
  }

  function options(m) {
    const places = ctx.systems.places;
    const hm = ctx.heightmap;
    const minDepth = (ctx.config.boat?.groundingDepth ?? 2.2) + 1.5;
    const isOpenWater = hm ? (x, z) => hm.shoreDistance(x, z) >= 40 && hm.heightAt(x, z) < -minDepth : null;
    return buildStartOptions({
      mode: m,
      places: places?.list ?? [],
      districts: places?.districts ?? [],
      targets: targetsNow(),
      spawn: places?.spawn ?? null,
      isOpenWater,
      ...seaArgs(),
    });
  }

  function warm() {
    if (warming || !seaArgs().sea) return;
    const targets = targetsNow();
    const byPlace = new Map(targets.filter((t) => t.placeId && t.kind !== 'tender').map((t) => [t.placeId, t]));
    // The ports New Season lists (listed without the seabed search: cheap), each searched in its own slice.
    const queue = buildStartOptions({ mode: 'season', places: ctx.systems.places?.list ?? [], targets, spawn: ctx.systems.places?.spawn ?? null })
      .filter((o) => !o.home && byPlace.has(o.id))
      .map((o) => o.id);
    const idle = typeof requestIdleCallback === 'function' ? (f) => requestIdleCallback(f, { timeout: 1000 }) : (f) => setTimeout(f, 50);
    warming = { stop: false };
    const job = warming;
    const step = () => {
      if (job.stop) return;
      if (!queue.length) {
        if (warming === job) warming = null;
        return;
      }
      const id = queue.shift();
      try {
        seasonPoseFor(id, byPlace.get(id), { ...seaArgs(), places: ctx.systems.places?.list ?? [] });
      } catch (err) {
        console.error('[ui] start pose failed', id, err);
      }
      idle(step);
    };
    idle(step);
  }

  function stopWarming() {
    if (warming) warming.stop = true;
    warming = null;
  }

  function render(lastId = null) {
    shown = filterStartOptions(all, mode === 'explore' ? search.value : '');
    clear(list);
    rows = [];
    for (const g of groupStartOptions(shown)) {
      list.append(h('div.sp-group', { text: g.name }));
      for (const o of g.options) {
        const i = rows.length;
        const row = h(`button.sp-row${o.recommended ? '.sp-rec' : ''}${o.surprise ? '.sp-surprise' : ''}`, { type: 'button', role: 'option', dataset: { id: o.id } }, [
          h('span.sp-name', { text: o.name }),
          h('span.sp-line', { text: o.recommended ? 'Recommended for your first season' : mode === 'explore' ? o.kindLabel : o.line }),
        ]);
        row.addEventListener('mousemove', (e) => {
          if (openPointer && Math.hypot(e.clientX - openPointer.x, e.clientY - openPointer.y) < 4) return;
          openPointer = null;
          if (sel !== i) select(i, { scroll: false });
        });
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          row.blur();
          select(i, { scroll: false });
          pick();
        });
        rows.push(row);
        list.append(row);
      }
    }
    if (!rows.length) list.append(h('div.sp-empty', { text: 'No places match.' }));
    select(lastId !== null ? preselectIndex(shown, lastId) : 0, { center: lastId !== null });
    list.scrollTop = lastId !== null ? list.scrollTop : 0;
    moreHint();
  }

  // A soft fade at the bottom edge while more of the list is below.
  function moreHint() {
    list.classList.toggle('more', list.scrollTop + list.clientHeight < list.scrollHeight - 2);
  }
  list.addEventListener('scroll', moreHint, { passive: true });

  function select(i, { scroll = true, center = false } = {}) {
    if (!rows.length) {
      sel = -1;
      setText(detailMeta, '');
      setText(detailBlurb, '');
      startBtn.disabled = true;
      return;
    }
    sel = Math.max(0, Math.min(rows.length - 1, i));
    rows.forEach((r, n) => {
      r.classList.toggle('on', n === sel);
      r.setAttribute('aria-selected', n === sel ? 'true' : 'false');
    });
    if (scroll) rows[sel].scrollIntoView?.({ block: center ? 'center' : 'nearest' });
    const o = shown[sel];
    const meta = o.surprise ? 'Anywhere in the archipelago' : [o.districtName, mode === 'explore' ? o.line : o.services].filter(Boolean).join(' · ');
    setText(detailMeta, meta);
    setText(detailBlurb, o.blurb ?? '');
    startBtn.disabled = false;
  }

  function pick() {
    if (!active || sel < 0) return;
    const chosen = shown[sel];
    const option = chosen.surprise ? pickSurprise(all) : chosen;
    if (!option) return;
    rememberStart(localStore(), mode, chosen.id);
    ctx.systems.audio?.play?.('ui-click', { volume: 0.5 });
    active = false;
    search.blur();
    onPick?.({ mode, option, startAt: startAtFor(option) });
  }

  function cancel() {
    if (!active) return;
    api.reset();
    ctx.systems.audio?.play?.('ui-click', { volume: 0.35 });
    onCancel?.();
  }

  search.addEventListener('input', () => render(null));
  // The search box keeps focus in Free Explore, and the game's key routing ignores keys typed into a text field, so
  // the panel handles its own keys here.
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') select(sel + 1);
    else if (e.key === 'ArrowUp') select(sel - 1);
    else if (e.key === 'Enter') pick();
    else if (e.key === 'Escape') cancel();
    else {
      e.stopPropagation();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  });

  const api = {
    el,
    get active() {
      return active;
    },
    get mode() {
      return mode;
    },
    // Snapshot for tests and the smoke harness: the listed ids in order and the selected one.
    debugState() {
      return { active, mode, ids: shown.map((o) => o.id), selected: shown[sel]?.id ?? null };
    },
    open(m) {
      mode = m === 'explore' ? 'explore' : 'season';
      all = options(mode);
      if (!all.length) return false;
      const start = calendar(ctx.config.time?.startDay ?? 0, ctx.config.time?.seasonStart);
      setText(kicker, mode === 'explore' ? 'Free Explore' : `New Season · ${start.long}`);
      setText(sub, mode === 'explore' ? 'Start anywhere in the archipelago. In the game, T jumps again.' : 'Choose your home waters. Wherever you start, Uncle Pete will put you onto a school of humpies nearby.');
      bar.hidden = mode !== 'explore';
      search.value = '';
      host.classList.add('picking');
      host.dataset.picking = mode;
      el.classList.add('on');
      active = true;
      armed = false;
      openPointer = lastPointer ? { ...lastPointer } : null;
      render(readLastStart(localStore())[mode] ?? null);
      requestAnimationFrame(moreHint);
      if (mode === 'explore') setTimeout(() => active && search.focus({ preventScroll: true }), 40);
      return true;
    },
    tick() {
      if (!active) return;
      // Skip the frame the panel opened on: the Enter that chose New Season (or accepted the confirm) is still down.
      if (!armed) {
        armed = true;
        return;
      }
      if (document.activeElement === search) return;
      const I = ctx.input;
      const kp = (c) => !!I?.keyPressed?.(c);
      if (kp('ArrowDown') || kp('KeyS')) select(sel + 1);
      else if (kp('ArrowUp') || kp('KeyW')) select(sel - 1);
      else if (kp('Enter') || kp('Space')) pick();
      else if (kp('Escape')) cancel();
    },
    deactivate() {
      active = false;
      search.blur();
      stopWarming();
    },
    // Work out the New Season starts in idle time (title.show); stops when the game starts.
    warm,
    reset() {
      active = false;
      search.blur();
      el.classList.remove('on');
      host.classList.remove('picking');
      delete host.dataset.picking;
    },
  };
  return api;
}
