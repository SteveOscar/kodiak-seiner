// Free Explore "Where to?" panel: jump instantly to any place in the archipelago (T, the pause menu, or the chart).
// Backed by ctx.systems.season.travel.teleportTargets()/teleport() (src/game/travel.js).

import { h, clear, button, setText } from './dom.js';

const DISTRICT_ORDER = ['northeast', 'afognak', 'eastside', 'alitak', 'southwest', 'northwest', 'mainland'];

const KIND_LABEL = {
  town: 'Town',
  village: 'Village',
  harbor: 'Harbor',
  cannery: 'Cannery',
  hatchery: 'Hatchery',
  landmark: 'Landmark',
  cape: 'Cape',
  bay: 'Bay',
  strait: 'Strait',
  island: 'Island',
  river: 'Salmon stream',
  lake: 'Lake — hike from the beach',
  peak: 'Peak — hike from the beach',
  lighthouse: 'Light',
  wildlife: 'Wildlife',
  history: 'History',
  viewpoint: 'Viewpoint — hike from the beach',
  tender: 'Tender',
};

export function createTeleportPanel(ctx, { close, resume }) {
  const travel = () => ctx.systems.season?.travel ?? null;
  const search = h('input.tp-search', { type: 'text', placeholder: 'Search places — bays, villages, capes, peaks…', spellcheck: false, autocomplete: 'off' });
  const list = h('div.tp-list');
  const note = h('div.tp-note');
  let rows = [];
  let sel = 0;

  const el = h('div.ui-panel.panel-teleport', null, [
    h('div.panel-card.ui-interactive', null, [
      h('div.panel-kicker', { text: 'Free Explore' }),
      h('h2.panel-title', { text: 'Where to?' }),
      h('div.panel-sub', { text: 'Jump anywhere in the archipelago — or click open water on the chart (M).' }),
      h('div.panel-rule'),
      h('div.tp-bar', null, [search, button('Surprise me', () => surprise(), { cls: 'small' })]),
      note,
      list,
      h('div.panel-actions', null, [button('Close', () => close(), { key: 'Esc' })]),
    ]),
  ]);

  function go(target) {
    const r = travel()?.teleport?.(target);
    if (r?.ok) {
      resume();
      return;
    }
    setText(note, r?.reason ?? 'Teleport is not available');
  }

  function surprise() {
    const t = travel()?.teleportTargets?.() ?? [];
    if (t.length) go(t[Math.floor(Math.random() * t.length)]);
  }

  function render() {
    const q = search.value.trim().toLowerCase();
    const disc = ctx.systems.discovery;
    const targets = (travel()?.teleportTargets?.() ?? []).filter(
      (t) => !q || t.name.toLowerCase().includes(q) || (KIND_LABEL[t.placeKind] ?? '').toLowerCase().includes(q) || (t.districtName ?? '').toLowerCase().includes(q),
    );
    const groups = new Map();
    for (const t of targets) {
      const key = t.district ?? `z:${t.districtName}`;
      if (!groups.has(key)) groups.set(key, { name: t.districtName, items: [] });
      groups.get(key).items.push(t);
    }
    const order = [...groups.keys()].sort((a, b) => rank(a) - rank(b) || String(groups.get(a).name).localeCompare(groups.get(b).name));
    clear(list);
    rows = [];
    for (const key of order) {
      const g = groups.get(key);
      list.append(h('div.tp-group', { text: g.name }));
      g.items.sort((a, b) => a.name.localeCompare(b.name));
      for (const t of g.items) {
        const seen = t.placeId ? disc?.isDiscovered?.(t.placeId) : true;
        const row = h('button.tp-row', { type: 'button', onclick: () => go(t) }, [
          h('span.tp-name', { text: t.name }),
          h('span.tp-kind', { text: KIND_LABEL[t.placeKind] ?? t.placeKind ?? '' }),
          seen ? h('span.tp-seen', { title: 'Discovered', text: '●' }) : null,
        ]);
        row.addEventListener('mouseenter', () => select(rows.indexOf(row)));
        rows.push(row);
        list.append(row);
      }
    }
    if (!rows.length) list.append(h('div.tp-empty', { text: 'No places match.' }));
    select(0);
  }

  function rank(key) {
    const i = DISTRICT_ORDER.indexOf(key);
    return i < 0 ? DISTRICT_ORDER.length : i;
  }

  function select(i) {
    if (!rows.length) return;
    sel = Math.max(0, Math.min(rows.length - 1, i));
    rows.forEach((r, n) => r.classList.toggle('on', n === sel));
    rows[sel].scrollIntoView?.({ block: 'nearest' });
  }

  search.addEventListener('input', render);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') select(sel + 1);
    else if (e.key === 'ArrowUp') select(sel - 1);
    else if (e.key === 'Enter') rows[sel]?.click();
    else return;
    e.preventDefault();
    e.stopPropagation();
  });

  return {
    id: 'teleport',
    el,
    show() {
      const can = travel()?.canTeleport?.() ?? { ok: false, reason: 'Teleport is not available' };
      setText(note, can.ok ? '' : can.reason);
      search.value = '';
      render();
      setTimeout(() => search.focus({ preventScroll: true }), 30);
    },
    hide() {
      search.blur();
    },
  };
}
