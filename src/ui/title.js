// Title screen over the live title cinematic: the KODIAK SEINER mark, the menu (Continue when a save exists, New
// Season, Free Explore, Settings, Controls, Credits), the boat-name field, and a film-style caption naming the place
// the cinematic is showing. Every new game (New Season, Free Explore) first asks where to start (./startPicker.js).

import { h, svgFrom, clear, setText, toggle } from './dom.js';
import { salmonMarkSVG } from './lib/art.js';
import { money, calendar, clockTime } from './lib/format.js';
import { createStartPicker } from './startPicker.js';

const NAME_KEY = 'kodiak-seiner:boatName';

export function createTitle(ctx, root, { saves, openPanel, confirm, onStart }) {
  const mark = svgFrom(salmonMarkSVG({ stroke: 'currentColor', width: 1.05 }));
  const logo = h('div.title-logo', null, [
    h('div.title-mark', null, [mark]),
    h('div.title-word', null, [...'KODIAK'].map((c, i) => h('span.tl', { text: c, style: { animationDelay: `${0.25 + i * 0.07}s` } }))),
    h('div.title-sub', null, [h('span.title-rule'), h('span.title-seiner', { text: 'SEINER' }), h('span.title-rule')]),
    h('div.title-tag', { text: 'Salmon purse seining in the Kodiak Archipelago' }),
  ]);

  const menu = h('div.title-menu.ui-interactive');
  const nameInput = h('input.title-name-input', { type: 'text', maxlength: 24, spellcheck: false, autocomplete: 'off', 'aria-label': 'Boat name' });
  const nameRow = h('label.title-name.ui-interactive', null, [h('span.title-name-fv', { text: 'F/V' }), nameInput, h('span.title-name-hint', { text: 'your boat' })]);
  const captionPlace = h('div.caption-place');
  const captionSub = h('div.caption-sub', { text: 'Kodiak Island, Alaska' });
  const caption = h('div.title-caption', null, [h('div.caption-rule'), captionPlace, captionSub]);
  const footKeys = h('span.title-foot-keys', { text: '↑ ↓ choose · Enter select' });
  const foot = h('div.title-foot', null, [h('span', { text: 'Terrain: AWS Terrain Tiles (Mapzen) · three.js' }), footKeys]);
  const col = h('div.title-col', null, [logo, menu, nameRow]);
  const el = h('div.ui-title', null, [h('div.title-scrim'), col, caption, foot]);
  root.append(el);

  let items = [];
  let sel = 0;
  let shots = null;
  let lastShot = null;
  let shotT = 0;
  import('../render/camera/titleShots.js')
    .then((m) => {
      shots = Array.isArray(m.TITLE_SHOTS) ? m.TITLE_SHOTS : null;
    })
    .catch(() => {
      shots = null;
    });

  function storedName() {
    try {
      return localStorage.getItem(NAME_KEY) || null;
    } catch {
      return null;
    }
  }
  function storeName(n) {
    try {
      localStorage.setItem(NAME_KEY, n);
    } catch {
      // storage unavailable
    }
  }
  function boatName() {
    const v = nameInput.value.trim().replace(/\s+/g, ' ').slice(0, 24);
    return v || 'Northern Dawn';
  }
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      nameInput.blur();
    }
    e.stopPropagation();
  });
  nameInput.addEventListener('change', () => {
    const n = boatName();
    nameInput.value = n;
    storeName(n);
  });

  const picker = createStartPicker(ctx, el, {
    onPick: ({ mode, startAt }) => begin(mode === 'explore', startAt),
    onCancel: () => {
      setText(footKeys, '↑ ↓ choose · Enter select');
      select(sel);
    },
  });

  // New Season and Free Explore both ask where to start first; without any places to offer, start at the spawn.
  function startGame(freeExplore) {
    nameInput.blur();
    if (picker.open(freeExplore ? 'explore' : 'season')) setText(footKeys, '↑ ↓ choose · Enter start here · Esc back');
    else begin(freeExplore, null);
  }

  function begin(freeExplore, startAt) {
    const n = boatName();
    storeName(n);
    ctx.systems.seiner?.setBoatName?.(n);
    onStart?.();
    ctx.game.start({ newGame: true, freeExplore, startAt });
  }

  function build() {
    clear(menu);
    const info = saves.saveInfo();
    items = [];
    const add = (label, fn, sub = null, cls = '') => {
      const b = h(`button.title-item${cls ? `.${cls}` : ''}`, { type: 'button' }, [h('span.ti-label', { text: label }), sub ? h('span.ti-sub', { text: sub }) : null]);
      const idx = items.length;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        b.blur();
        ctx.systems.audio?.play?.('ui-click', { volume: 0.5 });
        fn();
      });
      b.addEventListener('mouseenter', () => select(idx));
      menu.append(b);
      items.push({ el: b, fn });
    };
    if (info) {
      const d = Number.isFinite(info.day) ? calendar(info.day, ctx.config.time.seasonStart).label : info.date ?? '';
      const sub = [info.boatName ? `F/V ${info.boatName}` : null, d ? `${d}${Number.isFinite(info.hours) ? `, ${clockTime(info.hours)}` : ''}` : null, Number(info.seasonGross) > 0 ? `${money(info.seasonGross)} gross` : null].filter(Boolean).join(' · ');
      add('Continue', () => {
        const ok = saves.loadSave();
        if (!ok) ctx.systems.ui?.toast?.('That save could not be loaded.', { kind: 'warn' });
      }, sub, 'primary');
    }
    add(
      'New Season',
      () => {
        if (info) confirm({ title: 'Start a new season?', text: 'Your saved season will be replaced the next time the game saves.', ok: 'Start fresh', onOk: () => startGame(false) });
        else startGame(false);
      },
      info ? null : 'July 6 — the Kodiak general opener',
      info ? '' : 'primary',
    );
    add('Free Explore', () => startGame(true), 'No clock on the fishing, no fuel bill');
    add('Settings', () => openPanel('settings'));
    add('Controls', () => openPanel('help'));
    add('Credits', () => openPanel('credits'));
    select(0);
    if (!nameInput.value) nameInput.value = storedName() ?? info?.boatName ?? ctx.systems.seiner?.boatName ?? 'Northern Dawn';
  }

  function select(i) {
    if (!items.length) return;
    sel = (i + items.length) % items.length;
    items.forEach((it, k) => it.el.classList.toggle('sel', k === sel));
  }

  const api = {
    el,
    show() {
      picker.reset();
      setText(footKeys, '↑ ↓ choose · Enter select');
      build();
      toggle(el, 'on', true);
      el.classList.remove('leaving');
      lastShot = null;
    },
    hide() {
      toggle(el, 'on', false);
      nameInput.blur();
      // The picker stays on screen while the title fades out; show() puts the menu back.
      picker.deactivate();
    },
    // Keyboard navigation (raw keys; only while no sub-panel is open and the name field is not focused).
    tick(realDt, { panelOpen }) {
      shotT += realDt;
      if (shotT > 0.25) {
        shotT = 0;
        const id = ctx.systems.cameraRig?.debugState?.()?.titleShot ?? null;
        if (id !== lastShot) {
          lastShot = id;
          const shot = shots?.find((s) => s.id === id);
          toggle(caption, 'in', false);
          if (shot) {
            setTimeout(() => {
              setText(captionPlace, shot.label);
              toggle(caption, 'in', true);
            }, 700);
          }
        }
      }
      if (picker.active) {
        if (!panelOpen) picker.tick();
        return;
      }
      if (panelOpen || document.activeElement === nameInput) return;
      const I = ctx.input;
      if (I?.keyPressed?.('ArrowDown') || I?.keyPressed?.('KeyS')) select(sel + 1);
      if (I?.keyPressed?.('ArrowUp') || I?.keyPressed?.('KeyW')) select(sel - 1);
      if (I?.keyPressed?.('Enter') || I?.keyPressed?.('Space')) items[sel]?.fn();
    },
    get boatName() {
      return boatName();
    },
    get startPicker() {
      return picker;
    },
  };
  return api;
}
