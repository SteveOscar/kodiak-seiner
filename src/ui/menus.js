// Pause menu, settings, controls/help, credits and a small confirm dialog. Each panel is { id, el, show(opts),
// hide(), back?() }; ui.js stacks them and owns the mode changes.

import { h, clear, button, keycap, setText } from './dom.js';
import { calendar, clockTime, money } from './lib/format.js';

function card(cls, children) {
  return h(`div.ui-panel.${cls}`, null, [h('div.panel-card.ui-interactive', null, children)]);
}

// ---------------------------------------------------------------- pause

export function createPausePanel(ctx, { open, close, saves, toTitle, resume }) {
  const kicker = h('div.panel-kicker', { text: 'Paused' });
  const title = h('h2.panel-title');
  const sub = h('div.panel-sub');
  const list = h('div.menu-list');
  const note = h('div.panel-note');
  const el = card('panel-pause', [kicker, title, sub, h('div.panel-rule'), list, note]);

  // Keyboard: ↑/↓ (or W/S) move a highlight from Resume, Enter/Space picks it (Resume when the keys were not used).
  let items = [];
  let sel = 0;
  let kbd = false;
  const mark = () => items.forEach((b, i) => b.classList.toggle('kbd', kbd && i === sel));

  function item(label, key, fn, cls = '') {
    const b = button(label, fn, { cls: `menu-item ${cls}`.trim() });
    if (key) b.append(keycap(key, 'menu-key'));
    list.append(b);
    items.push(b);
    return b;
  }

  return {
    id: 'pause',
    el,
    show() {
      const c = ctx.clock;
      const cal = calendar(c.day, ctx.config.time.seasonStart);
      setText(title, `${cal.long}`);
      const s = ctx.systems.seiner;
      const bits = [`${clockTime(c.hours)}`, s?.boatName ? `F/V ${s.boatName}` : null, ctx.state.freeExplore ? 'Free explore' : money(ctx.systems.economy?.cash ?? 0)];
      setText(sub, bits.filter(Boolean).join(' · '));
      clear(list);
      items = [];
      sel = 0;
      kbd = false;
      item('Resume', 'Esc', () => resume(), 'primary');
      item('Chart', 'M', () => open('map'));
      if (ctx.state.freeExplore) item('Teleport…', 'T', () => open('teleport'));
      item('Logbook', 'L', () => open('logbook'));
      item('Settings', null, () => open('settings'));
      item('Controls', 'F1', () => open('help'));
      const f = ctx.systems.fishing;
      if (f && f.state && f.state !== 'idle' && f.state !== 'report') {
        item('Abort set — haul back', null, () => {
          try {
            f.abort?.();
          } catch (err) {
            console.warn('[ui] abort failed', err?.message ?? err);
          }
          resume();
        }, 'danger');
      }
      let snap = null;
      try {
        snap = ctx.game.snapshot?.();
      } catch {
        snap = null;
      }
      const explore = !!ctx.state.freeExplore;
      const info = saves.saveInfo();
      // Quitting where the game can't save throws away everything since the last save: ask first.
      const quit = explore || snap ? () => toTitle() : () => open('confirm', quitConfirm(ctx, { fishing: f, info, toTitle }));
      item(explore ? 'Quit to title' : snap ? 'Save & quit to title' : 'Quit to title', null, quit);
      if (explore) setText(note, 'Free Explore keeps your discoveries between visits.');
      else if (!snap) setText(note, `Can’t save ${f?.state && f.state !== 'idle' ? 'mid-set' : ctx.state.control === 'foot' ? 'while ashore' : 'right now'}${info?.savedAt ? ` — last save ${calendar(info.day ?? 0, ctx.config.time.seasonStart).label}, ${clockTime(info.hours ?? 0)}` : ''}.`);
      else setText(note, info?.savedAt ? `Last save ${calendar(info.day ?? 0, ctx.config.time.seasonStart).label}, ${clockTime(info.hours ?? 0)} · autosaves on deliveries, sleep and tie-ups` : 'Autosaves on deliveries, sleep and tie-ups.');
      mark();
    },
    hide() {},
    nav(d) {
      if (!items.length) return;
      sel = (sel + d + items.length) % items.length;
      kbd = true;
      mark();
    },
    activate() {
      items[sel]?.click();
    },
  };
}

// The "Quit without saving?" dialog: what is lost (the set in progress, or the trip ashore) and since when.
function quitConfirm(ctx, { fishing, info, toTitle }) {
  const midSet = !!(fishing?.state && fishing.state !== 'idle');
  const ashore = ctx.state.control === 'foot';
  const since = info?.savedAt ? `since your last save (${calendar(info.day ?? 0, ctx.config.time.seasonStart).label}, ${clockTime(info.hours ?? 0)})` : 'this season — there is no save yet';
  const what = fishing?.state === 'report' ? 'the set you just made and everything' : midSet ? 'the set in progress and everything' : ashore ? 'your trip ashore and everything' : 'everything';
  return {
    title: 'Quit without saving?',
    text: `The game can’t save ${midSet ? 'mid-set' : ashore ? 'while you’re ashore' : 'right now'}. You’ll lose ${what} ${since}.`,
    ok: 'Quit without saving',
    cancel: 'Cancel',
    onOk: () => toTitle(),
  };
}

// ---------------------------------------------------------------- settings

const QUALITIES = [
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
  ['ultra', 'Ultra'],
];
const SPEEDS = [
  [0.5, '½×'],
  [1, '1×'],
  [2, '2×'],
  [4, '4×'],
];
export const FISHING_MODE_OPTIONS = [
  ['arcade', 'Arcade'],
  ['realistic', 'Realistic'],
];
export const FISHING_MODE_HINTS = {
  arcade: 'Arcade: the crew purses and hauls for you',
  realistic: 'Realistic: run the winch, steer the skiff’s pull, watch the tide',
};
const fishingModeOf = (s) => (s?.fishingMode === 'realistic' ? 'realistic' : 'arcade');
const VOLUMES = [
  ['master', 'Master'],
  ['music', 'Music'],
  ['sfx', 'Effects'],
  ['ambience', 'Ambience'],
];

export function createSettingsPanel(ctx, { saves, confirm, close }) {
  const body = h('div.settings-body');
  const el = card('panel-settings', [h('div.panel-kicker', { text: 'Settings' }), h('h2.panel-title', { text: 'Wheelhouse settings' }), h('div.panel-rule'), body, h('div.panel-actions', null, [button('Done', () => close(), { cls: 'primary', key: 'Esc' })])]);

  function segmented(options, current, onPick) {
    const row = h('div.seg');
    for (const [value, label] of options) {
      const b = button(label, () => onPick(value), { cls: `seg-btn${value === current ? ' on' : ''}` });
      row.append(b);
    }
    return row;
  }

  function render() {
    clear(body);
    const s = saves.getSettings();
    const inGame = ctx.state.mode !== 'title' && ctx.state.mode !== 'loading';
    const active = ctx.quality?.name ?? s.quality;

    body.append(
      h('div.set-group', null, [
        h('div.set-label', null, [h('span', { text: 'Graphics quality' }), h('span.set-hint', { text: 'Changing it reloads the game' + (inGame ? ' — your season is saved first' : '') })]),
        segmented(QUALITIES, active, (q) => {
          if (q === active) return;
          const apply = () => {
            if (inGame) saves.saveNow('settings');
            const r = saves.setSettings({ quality: q });
            if (r?.reload !== false) setTimeout(() => location.reload(), 60);
          };
          if (inGame) confirm({ title: `Switch to ${q} quality?`, text: 'The game reloads to apply it. Progress since your last save is kept if you can save here; mid-set progress is lost.', ok: 'Reload', onOk: apply });
          else apply();
        }),
      ]),
    );

    const vol = h('div.set-group', null, [h('div.set-label', null, [h('span', { text: 'Sound' })])]);
    for (const [key, label] of VOLUMES) {
      const v = Math.round((s.volumes?.[key] ?? 0.8) * 100);
      const out = h('span.slider-val', { text: `${v}` });
      const input = h('input.slider', { type: 'range', min: 0, max: 100, step: 1, value: v, 'aria-label': label });
      input.addEventListener('input', () => {
        out.textContent = input.value;
        const next = { ...saves.getSettings().volumes, [key]: Number(input.value) / 100 };
        saves.setSettings({ volumes: next });
        ctx.systems.audio?.setVolumes?.(next);
      });
      // Hand keyboard focus back so Esc and the game keys keep working after a drag.
      input.addEventListener('change', () => input.blur());
      vol.append(h('label.slider-row', null, [h('span.slider-label', { text: label }), input, out]));
    }
    body.append(vol);

    body.append(
      h('div.set-group', null, [
        h('div.set-label', null, [h('span', { text: 'Time speed' }), h('span.set-hint', { text: `${fmtSpeed(s.timeSpeed)} of game time per real second` })]),
        segmented(SPEEDS, s.timeSpeed, (v) => {
          saves.setSettings({ timeSpeed: v });
          ctx.clock.scale = ctx.config.time.minutesPerSecond * v;
          render();
        }),
      ]),
    );

    // Fishing mode: a set in progress keeps the mode it was let go with.
    const fm = fishingModeOf(s);
    const setOn = !!ctx.systems.fishing && ctx.systems.fishing.state !== 'idle' && inGame;
    const fishing = h('div.set-group.set-fishing', null, [
      h('div.set-label', null, [h('span', { text: 'Fishing' }), h('span.set-hint', { text: FISHING_MODE_HINTS[fm] + (setOn ? ' — from the next set' : '') })]),
      segmented(FISHING_MODE_OPTIONS, fm, (v) => {
        if (v === fm) return;
        saves.setSettings({ fishingMode: v });
        render();
      }),
    ]);
    fishing.dataset.mode = fm;
    body.append(fishing);

    const inv = h('button.toggle', { type: 'button', role: 'switch', 'aria-checked': s.invertY ? 'true' : 'false' }, [h('span.toggle-knob')]);
    inv.classList.toggle('on', !!s.invertY);
    inv.addEventListener('click', (e) => {
      e.stopPropagation();
      const next = !saves.getSettings().invertY;
      saves.setSettings({ invertY: next });
      render();
    });
    body.append(h('div.set-group.set-inline', null, [h('div.set-label', null, [h('span', { text: 'Invert vertical look' }), h('span.set-hint', { text: 'Camera orbit, binoculars and photo mode' })]), inv]));
  }

  return {
    id: 'settings',
    el,
    show: render,
    hide() {},
  };
}

function fmtSpeed(v) {
  const m = Math.round((Number(v) || 1) * 60);
  return m >= 60 && m % 60 === 0 ? `${m / 60} minute${m === 60 ? '' : 's'}` : `${m} seconds`;
}

// ---------------------------------------------------------------- help / controls

const KEYS = [
  ['At the helm', [
    [['W', 'S'], 'Throttle ahead / astern'],
    [['A', 'D'], 'Rudder (aim the skiff while pursing)'],
    [['Space'], 'Let ’er go · hold the hook · close up'],
    [['E'], 'Interact · hold to run the purse winch'],
    [['C'], 'Camera: chase, crow’s nest, bridge'],
    [['B'], 'Binoculars (or hold right mouse)'],
    [['G'], 'Horn'],
    [['N'], 'Deck lights'],
    [['⌫'], 'Hold to abort a set'],
  ]],
  ['Screens', [
    [['M'], 'Chart and fast travel'],
    [['L'], 'Logbook'],
    [['H'], 'Photo mode'],
    [['Esc'], 'Pause · close'],
    [['F1'], 'This card'],
  ]],
  ['Ashore', [
    [['WASD'], 'Walk'],
    [['Shift'], 'Run'],
    [['Space'], 'Jump'],
  ]],
];

const MOUSE = ['Mouse', [
  [['Drag'], 'Look around'],
  [['Wheel'], 'Zoom'],
  [['R-btn'], 'Binoculars'],
]];

const STEPS = [
  ['Find the fish', 'Watch for jumpers and working gulls. Binoculars read a school’s species by its jumps; sonar shows marks under the boat.'],
  ['Let ’er go', 'Stop short of the school — not on top of it — and hit Space. The skiff holds the end.'],
  ['Lay it out', 'Run a wide circle back to the skiff, or lay it off a point and hold the hook.'],
  ['Close up', 'Alongside the skiff (or any time holding a hook), Space closes the net.'],
  ['Purse', 'Hold E on the winch and keep the needle in the green. A/D aim the skiff’s pull off the net.'],
  ['Haul and brail', 'The block dries up the bag, then the brailer swings the catch into the hold.'],
  ['Deliver', 'Come alongside a tender and press E. The fish ticket pays you, less the crew’s 30%.'],
];

const ARCADE_PURSE_STEP = 'The crew purses her up, hauls the bag alongside and brails the catch aboard — a few seconds. (Settings → Fishing: Realistic to run the winch yourself.)';

export function createHelpPanel(ctx, { close }) {
  const section = ([title, rows]) => {
    const sec = h('div.help-sec', null, [h('div.help-h', { text: title })]);
    for (const [keys, text] of rows) sec.append(h('div.help-row', null, [h('span.help-keys', null, keys.map((k) => keycap(k))), h('span.help-text', { text })]));
    return sec;
  };
  const helm = h('div.help-cols', null, [section(KEYS[0]), section(MOUSE)]);
  const pad = h('div.help-sec', null, [
    h('div.help-h', { text: 'Gamepad' }),
    h('p.help-pad', { text: 'Left stick drive · right stick look · A action · X interact · Y camera · LB binoculars · B horn · Start pause' }),
  ]);
  const screens = section(KEYS[1]);
  const rest = h('div.help-cols', null, [screens, section(KEYS[2]), pad]);
  // Free Explore: the chart teleports instead of fast travel, and T opens "Where to?".
  const chartRow = [...screens.querySelectorAll('.help-text')].find((x) => x.textContent === 'Chart and fast travel');
  const teleportRow = h('div.help-row', null, [h('span.help-keys', null, [keycap('T')]), h('span.help-text', { text: 'Where to? — teleport anywhere' })]);
  const steps = h('ol.help-steps');
  for (const [t, d] of STEPS) steps.append(h('li', null, [h('span.step-t', { text: t }), h('span.step-d', { text: d })]));
  // Arcade fishing (the default): the crew purses and hauls, so the winch and skiff-pull lines change.
  const purseStep = [...steps.querySelectorAll('.step-t')].find((x) => x.textContent === 'Purse')?.nextSibling ?? null;
  const helmRows = [...helm.querySelectorAll('.help-text')];
  const rudderRow = helmRows.find((x) => x.textContent === KEYS[0][1][1][1]);
  const interactRow = helmRows.find((x) => x.textContent === KEYS[0][1][3][1]);
  const el = card('panel-help', [
    h('div.help-top', null, [
      h('div', null, [h('div.panel-kicker', { text: 'Controls' }), h('h2.panel-title', { text: 'How to work a seine' })]),
      button('Close', () => close(), { cls: 'primary', key: 'Esc' }),
    ]),
    h('div.panel-rule'),
    h('div.help-grid', null, [h('div.help-left', null, [steps]), helm, rest]),
  ]);
  return {
    id: 'help',
    el,
    show() {
      const arcade = (ctx.systems.fishing?.hud?.mode ?? 'arcade') !== 'realistic';
      if (purseStep) purseStep.textContent = arcade ? ARCADE_PURSE_STEP : STEPS[4][1];
      if (rudderRow) rudderRow.textContent = arcade ? 'Rudder' : KEYS[0][1][1][1];
      if (interactRow) interactRow.textContent = arcade ? 'Interact' : KEYS[0][1][3][1];
      const ex = !!ctx.state.freeExplore;
      if (chartRow) chartRow.textContent = ex ? 'Chart and teleport' : 'Chart and fast travel';
      if (ex && chartRow) chartRow.parentElement.after(teleportRow);
      else teleportRow.remove();
    },
    hide() {},
  };
}

// ---------------------------------------------------------------- credits

export function createCreditsPanel(ctx, { close }) {
  const p = (text, cls = '') => h(`p${cls ? `.${cls}` : ''}`, { text });
  const el = card('panel-credits', [
    h('div.panel-kicker', { text: 'Credits' }),
    h('h2.panel-title', { text: 'Kodiak Seiner' }),
    h('div.panel-rule'),
    h('div.credits-body', null, [
      p('A game about salmon purse seining around a real-geography Kodiak Island, Alaska.', 'lead'),
      p('Kodiak is the homeland of the Alutiiq (Sugpiaq) people, who have fished, hunted and navigated these bays for more than seven thousand years.', 'ack'),
      h('div.credits-h', { text: 'Terrain and bathymetry' }),
      p('Derived from Terrain Tiles on the Registry of Open Data on AWS, produced by Mapzen / the Linux Foundation (Tilezen): 3DEP (formerly NED) and topobathy courtesy of the U.S. Geological Survey; ETOPO1 courtesy of the U.S. National Oceanic and Atmospheric Administration; GMTED2010 courtesy of the U.S. Geological Survey; SRTM courtesy of the U.S. Geological Survey / NASA. Resampled and rescaled for the game — not for navigation.'),
      h('div.credits-h', { text: 'Rendering' }),
      p('three.js — © 2010–2026 three.js authors, MIT License.'),
      h('div.credits-h', { text: 'Art and sound' }),
      p('Everything you see and hear is generated at runtime: geometry, shaders, canvas textures, the chart, and Web Audio. No downloaded assets or fonts.'),
      h('div.credits-h', { text: 'Thanks' }),
      p('To the Kodiak fleet — skippers, skiffmen, deckhands, tendermen and cannery crews — whose vocabulary this game borrows.'),
    ]),
    h('div.panel-actions', null, [button('Close', () => close(), { cls: 'primary', key: 'Esc' })]),
  ]);
  return { id: 'credits', el, show() {}, hide() {} };
}

// ---------------------------------------------------------------- confirm

export function createConfirmPanel(ctx, { close }) {
  const title = h('h2.panel-title');
  const text = h('p.confirm-text');
  const actions = h('div.panel-actions');
  const el = card('panel-confirm', [title, h('div.panel-rule'), text, actions]);
  return {
    id: 'confirm',
    el,
    show({ title: t = 'Are you sure?', text: body = '', ok = 'OK', cancel = 'Cancel', onOk } = {}) {
      setText(title, t);
      setText(text, body);
      clear(actions);
      actions.append(
        button(cancel, () => close(), { key: 'Esc' }),
        button(ok, () => {
          close();
          onOk?.();
        }, { cls: 'primary' }),
      );
    },
    hide() {},
  };
}
