// The logbook (L): places discovered (cards with blurbs and chart notes; memorial cards stay quiet), wildlife and a
// guide to reading jumpers, the season's catch with set history and fish tickets, and the season page (goals, the
// fleet board, fishing periods, the marine forecast).

import { h, clear, button, setText, svgFrom } from './dom.js';
import { money, int, compactMoney, calendar, clockTime, cardinal, SPECIES, SPECIES_INFO, speciesName, capitalize } from './lib/format.js';
import { GLYPHS } from './lib/art.js';

const TABS = [
  ['places', 'Places'],
  ['wildlife', 'Wildlife'],
  ['catch', 'Catch'],
  ['season', 'Season'],
];

const KIND_LABEL = {
  town: 'Town', village: 'Village', harbor: 'Harbor', cannery: 'Cannery', hatchery: 'Hatchery', landmark: 'Landmark',
  cape: 'Cape', bay: 'Bay', strait: 'Strait', island: 'Island', river: 'River', lake: 'Lake', peak: 'Peak',
  lighthouse: 'Light', wildlife: 'Wildlife', history: 'History', viewpoint: 'Viewpoint', stream: 'Salmon stream',
};

const JUMPERS = [
  ['pink', 'Short, low, frequent “popcorn” jumps with a small splash — big schools everywhere.'],
  ['sockeye', 'A clean, straight leap and a head-first re-entry with little splash. They swim deep.'],
  ['chum', 'A heavy jump that falls flat on its side with a big splash; finning V-wakes when milling.'],
  ['coho', 'High, twisting, repeated tail-walking jumps. Late in the season.'],
  ['king', 'Rarely jumps. Kings must be released.'],
];

const RATING = { plugged: 'Plugged', good: 'Good', fair: 'Fair', 'water haul': 'Water haul' };

export function createLogbook(ctx, { close, openTicket, history }) {
  const tabsEl = h('div.lb-tabs');
  const body = h('div.lb-body');
  const summary = h('div.lb-summary');
  const el = h('div.ui-panel.panel-logbook', null, [
    h('div.panel-card.lb-card.ui-interactive', null, [
      h('div.lb-head', null, [
        h('div', null, [h('div.panel-kicker', { text: 'Logbook' }), h('h2.panel-title.lb-boat')]),
        summary,
      ]),
      tabsEl,
      body,
      h('div.panel-actions', null, [button('Close', () => close(), { cls: 'primary', key: 'L' })]),
    ]),
  ]);
  let tab = 'places';
  const tabButtons = {};
  for (const [id, label] of TABS) {
    const b = button(label, () => {
      tab = id;
      render();
    }, { cls: 'lb-tab' });
    tabButtons[id] = b;
    tabsEl.append(b);
  }

  const S = () => ctx.systems;
  const safe = (fn, d) => {
    try {
      return fn() ?? d;
    } catch {
      return d;
    }
  };
  const dateOf = (day, hours) => `${calendar(day ?? 0, ctx.config.time.seasonStart).label}${Number.isFinite(hours) ? `, ${clockTime(hours)}` : ''}`;

  function cards() {
    const d = S().discovery;
    const list = safe(() => d?.cards?.(), null);
    if (Array.isArray(list)) return list;
    const out = [];
    for (const id of d?.discovered ?? []) {
      const p = S().places?.get?.(id);
      if (p) out.push({ id, name: p.name, kind: p.kind, blurb: p.blurb, memorial: !!p.memorial, day: 0, intel: [] });
    }
    return out;
  }

  function renderPlaces() {
    const list = [...cards()].reverse();
    const prog = safe(() => S().discovery?.progress?.(), null);
    const head = h('div.lb-progress', null, [
      prog?.places ? stat(`${prog.places[0]} of ${prog.places[1]}`, 'places') : null,
      prog?.streams ? stat(`${prog.streams[0]} of ${prog.streams[1]}`, 'salmon streams') : null,
      Number.isFinite(prog?.intel) ? stat(int(prog.intel), 'chart notes') : null,
    ]);
    body.append(head);
    if (!list.length) {
      body.append(empty('Nothing logged yet', 'Every bay, cape, village and stream you visit goes in here, with what the old hands know about it.'));
      return;
    }
    const grid = h('div.lb-grid');
    for (const c of list) {
      if (c.memorial) {
        grid.append(
          h('article.lb-place.memorial', null, [
            h('div.lb-memorial-mark'),
            h('h3.lb-place-name', { text: c.name }),
            h('p.lb-blurb', { text: c.blurb ?? '' }),
          ]),
        );
        continue;
      }
      grid.append(
        h('article.lb-place', null, [
          h('div.lb-place-top', null, [h('span.lb-kind', { text: KIND_LABEL[c.kind] ?? capitalize(c.kind) }), h('span.lb-when', { text: Number.isFinite(c.day) ? dateOf(c.day) : '' })]),
          h('h3.lb-place-name', { text: c.name }),
          c.blurb ? h('p.lb-blurb', { text: c.blurb }) : null,
          ...(c.intel ?? []).map((t) => h('p.lb-intel', null, [svgFrom(GLYPHS.note), h('span', { text: t })])),
          c.bonus > 0 ? h('span.lb-bonus', { text: `+${money(c.bonus)}` }) : null,
        ]),
      );
    }
    body.append(grid);
  }

  function renderWildlife() {
    const seen = safe(() => S().discovery?.wildlifeSeen?.(), []);
    const prog = safe(() => S().discovery?.progress?.(), null);
    const marks = safe(() => S().discovery?.recentSightings?.(), []);
    body.append(
      h('div.lb-progress', null, [
        prog?.wildlife ? stat(`${prog.wildlife[0]} of ${prog.wildlife[1]}`, 'kinds of wildlife') : null,
        stat(int(marks.length), 'fish marks on the chart'),
      ]),
    );
    const cols = h('div.lb-two');
    const left = h('div.lb-col');
    left.append(h('h3.lb-h', { text: 'Sightings' }));
    if (!seen.length) left.append(empty('No sightings yet', 'Kodiak brown bears fish the stream mouths; humpbacks blow offshore; puffins nest on the rocky islets. Binoculars (B) help.'));
    else {
      const byKind = new Map();
      for (const s of seen) if (!byKind.has(s.kind)) byKind.set(s.kind, s);
      for (const s of byKind.values()) {
        const near = Number.isFinite(s.x) ? S().places?.nearest?.(s.x, s.z, (p) => !p.memorial) : null;
        left.append(
          h('div.lb-sight', null, [
            svgFrom(GLYPHS.binoculars),
            h('div', null, [h('div.lb-sight-name', { text: s.name ?? capitalize(s.kind) }), h('div.lb-sight-meta', { text: `${dateOf(s.day, s.hours)}${near?.place ? ` · near ${near.place.name}` : ''}` })]),
          ]),
        );
      }
    }
    if (marks.length) {
      left.append(h('h3.lb-h', { text: 'Schools logged' }));
      for (const m of marks.slice(0, 8)) {
        const near = Number.isFinite(m.x) ? S().places?.nearest?.(m.x, m.z, (p) => !p.memorial) : null;
        const src = m.source === 'spotter' ? 'spotter plane' : m.source === 'perch' ? 'from a summit' : 'binoculars';
        const hd = Number.isFinite(m.heading) ? ` · heading ${cardinal((m.heading * 180) / Math.PI, 8)}` : '';
        left.append(
          h('div.lb-sight.lb-school', null, [
            h('span.lb-chip', { style: { background: SPECIES_INFO[m.species]?.color ?? '#7f8e93' } }),
            h('div', null, [
              h('div.lb-sight-name', { text: `${SPECIES_INFO[m.species] ? speciesName(m.species, { nick: true }) : 'Jumpers'}${hd}` }),
              h('div.lb-sight-meta', { text: `${dateOf(m.day, m.hours)}${near?.place ? ` · off ${near.place.name}` : ''} · ${src}` }),
            ]),
          ]),
        );
      }
    }
    const right = h('div.lb-col');
    right.append(h('h3.lb-h', { text: 'Reading jumpers' }));
    for (const [k, text] of JUMPERS) {
      right.append(h('div.lb-jumper', null, [h('span.lb-chip', { style: { background: SPECIES_INFO[k].color } }), h('div', null, [h('div.lb-jumper-name', { text: speciesName(k, { nick: true }) }), h('p.lb-jumper-text', { text })])]));
    }
    right.append(h('p.lb-foot', { text: 'Hold the binoculars on a jumper for a second to log the school on the chart.' }));
    cols.append(left, right);
    body.append(cols);
  }

  function renderCatch() {
    const eco = S().economy;
    const st = eco?.stats ?? {};
    const fst = S().fishing?.stats ?? {};
    const sets = history.sets;
    const tickets = history.tickets;
    const bestSetLbs = Math.max(st.bestSetLbs ?? 0, fst.bestSetLbs ?? 0);
    body.append(
      h('div.lb-stats', null, [
        bigStat(money(st.seasonGross ?? 0), 'season gross'),
        bigStat(int(st.sets ?? fst.sets ?? sets.length), 'sets'),
        bigStat(int(fst.waterHauls ?? sets.filter((s) => s.waterHaul).length), 'water hauls'),
        bigStat(int(st.deliveries ?? tickets.length), 'deliveries'),
        bigStat(`${int(st.lbsDelivered ?? 0)}`, 'lb delivered'),
        bigStat(`${int(bestSetLbs)}`, 'lb best set'),
        bigStat(money(st.crewPaid ?? 0), 'crew paid'),
        bigStat(`${int(st.fuelBurned ?? 0)}`, 'gal burned'),
      ]),
    );
    const cols = h('div.lb-two');
    const left = h('div.lb-col');
    left.append(h('h3.lb-h', { text: 'Sets' }));
    if (!sets.length) left.append(empty('No sets yet', 'Find a school of jumpers during an opener and let ’er go (Space).'));
    else {
      const t = h('div.lb-table');
      t.append(h('div.lb-tr.lb-th', null, [['#', ''], ['When', ''], ['Result', ''], ['Pounds', '.num'], ['Value', '.num']].map(([x, c]) => h(`span${c}`, { text: x }))));
      for (const s of [...sets].reverse().slice(0, 40)) {
        t.append(
          h(`div.lb-tr.r-${String(s.rating).replace(/\s/g, '-')}`, null, [
            h('span.lb-idx', { text: String(s.setNumber ?? '') }),
            h('span', { text: dateOf(s.day, s.hours) }),
            h('span', null, [h(`span.lb-rating`, { text: s.cited ? 'Cited' : RATING[s.rating] ?? capitalize(s.rating) })]),
            h('span.num', { text: int(s.totalLbs ?? 0) }),
            h('span.num', { text: money(s.value ?? 0) }),
          ]),
        );
      }
      left.append(t);
    }
    const right = h('div.lb-col');
    right.append(h('h3.lb-h', { text: 'Delivered by species' }));
    const fd = st.fishDelivered ?? {};
    const table = ctx.config.fish.species;
    const lbsBy = SPECIES.filter((k) => k !== 'king').map((k) => ({ k, lbs: (fd[k] ?? 0) * (table[k]?.lbs ?? 0), n: fd[k] ?? 0 }));
    const maxL = Math.max(1, ...lbsBy.map((x) => x.lbs));
    for (const x of lbsBy) {
      right.append(
        h('div.lb-sp', null, [
          h('span.lb-chip', { style: { background: SPECIES_INFO[x.k].color } }),
          h('span.lb-sp-name', { text: speciesName(x.k) }),
          h('span.lb-sp-bar', null, [h('span', { style: { width: `${(x.lbs / maxL) * 100}%`, background: SPECIES_INFO[x.k].color } })]),
          h('span.lb-sp-v', { text: `${int(x.lbs)} lb` }),
        ]),
      );
    }
    right.append(h('h3.lb-h', { text: 'Fish tickets' }));
    if (!tickets.length) right.append(h('p.lb-foot', { text: 'Deliver to a tender or a cannery dock to get a fish ticket.' }));
    for (const r of [...tickets].reverse().slice(0, 12)) {
      const b = h('button.lb-ticket', { type: 'button' }, [
        h('span.lb-ticket-no', { text: r.ticket ?? '' }),
        h('span', { text: `${r.date ?? ''} · ${r.tender ?? ''}` }),
        h('span.num', { text: `${int(r.totalLbs ?? (r.lines ?? []).reduce((a, l) => a + (l.lbs ?? 0), 0))} lb` }),
        h('span.num', { text: money(r.net ?? 0) }),
      ]);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        openTicket(r);
      });
      right.append(b);
    }
    cols.append(left, right);
    body.append(cols);
  }

  function renderSeason() {
    const eco = S().economy;
    const season = S().season;
    const gross = eco?.stats?.seasonGross ?? 0;
    const cols = h('div.lb-two');
    const left = h('div.lb-col');
    left.append(h('h3.lb-h', { text: 'Season goals' }));
    const goals = safe(() => eco?.goals?.(), null) ?? (ctx.config.economy.goals ?? []).map((g) => ({ label: g.label, gross: g.gross, reached: gross >= g.gross }));
    if (ctx.state.freeExplore) left.append(h('p.lb-foot', { text: 'Goals count in a career season, not in Free Explore.' }));
    for (const g of goals) {
      const frac = g.gross ? Math.min(1, gross / g.gross) : g.reached ? 1 : 0;
      left.append(
        h(`div.lb-goal${g.reached ? '.done' : ''}`, null, [
          h('div.lb-goal-top', null, [h('span.lb-goal-name', { text: g.label }), h('span.lb-goal-v', { text: g.reached ? 'Done' : g.gross ? `${compactMoney(gross)} / ${compactMoney(g.gross)}` : g.description ?? '' })]),
          h('div.lb-goal-track', null, [h('span', { style: { width: `${(frac * 100).toFixed(1)}%` } })]),
        ]),
      );
    }
    left.append(h('h3.lb-h', { text: 'Fishing periods' }));
    const sched = safe(() => season?.schedule?.(), null) ?? ctx.config.season.fishingDays.map((d) => ({ day: d, date: calendar(d, ctx.config.time.seasonStart).label, past: d < ctx.clock.day }));
    const chips = h('div.lb-periods');
    for (const p of sched) {
      const cal = calendar(p.day, ctx.config.time.seasonStart);
      const today = p.day === ctx.clock.day;
      chips.append(h(`span.lb-period${p.past ? '.past' : ''}${today ? '.today' : ''}`, { title: p.closed?.length ? `Closed: ${p.closed.join(', ')}` : '' }, [h('span.lb-period-wd', { text: cal.weekdayShort }), h('span', { text: cal.label }), p.closed?.length ? h('span.lb-period-x', { text: '*' }) : null]));
    }
    left.append(chips, h('p.lb-foot', { text: 'Open 6:00 AM – 10:00 PM on period days. * some districts closed — see the radio.' }));
    const fc = safe(() => season?.forecast?.(), null);

    const right = h('div.lb-col');
    right.append(h('h3.lb-h', { text: 'Kodiak fleet board' }));
    const board = safe(() => season?.fleetBoard?.(), []);
    if (!board.length) right.append(h('p.lb-foot', { text: 'The tenders radio the fleet’s deliveries each evening.' }));
    else {
      const t = h('div.lb-table.lb-board');
      t.append(h('div.lb-tr.lb-th', null, [['', ''], ['Boat', ''], ['Skipper', ''], ['Today', '.num'], ['Season', '.num']].map(([x, c]) => h(`span${c}`, { text: x }))));
      for (const r of board) {
        t.append(
          h(`div.lb-tr${r.player ? '.me' : ''}`, null, [
            h('span.lb-idx.lb-rank', { text: String(r.rank ?? '') }),
            h('span.lb-boat-name', { text: r.player ? `F/V ${r.name}` : r.name }),
            h('span', { text: r.skipper ?? '' }),
            h('span.num', { text: r.today ? compactMoney(r.today) : '—' }),
            h('span.num', { text: money(r.gross ?? 0) }),
          ]),
        );
      }
      right.append(t, h('p.lb-foot', { text: 'Top the board after the sixth period to be the season’s Highliner.' }));
    }
    if (fc?.text) right.append(h('h3.lb-h', { text: 'Marine forecast' }), h('p.lb-forecast', { text: fc.text }));
    cols.append(left, right);
    body.append(cols);
  }

  function stat(v, label) {
    return h('span.lb-prog', null, [h('b', { text: v }), ` ${label}`]);
  }
  function bigStat(v, label) {
    return h('div.lb-stat', null, [h('span.lb-stat-v', { text: v }), h('span.lb-stat-l', { text: label })]);
  }
  function empty(t, text) {
    return h('div.lb-empty', null, [h('div.lb-empty-t', { text: t }), h('p', { text })]);
  }

  function render() {
    for (const [id] of TABS) tabButtons[id].classList.toggle('on', id === tab);
    const s = S().seiner;
    setText(el.querySelector('.lb-boat'), `F/V ${s?.boatName ?? 'Northern Dawn'}`);
    const cal = calendar(ctx.clock.day, ctx.config.time.seasonStart);
    clear(summary);
    summary.append(h('span', { text: `${cal.long} · ${clockTime(ctx.clock.hours)}` }), h('span', { text: ctx.state.freeExplore ? 'Free explore' : `${money(S().economy?.stats?.seasonGross ?? 0)} season gross` }));
    clear(body);
    body.scrollTop = 0;
    if (tab === 'places') renderPlaces();
    else if (tab === 'wildlife') renderWildlife();
    else if (tab === 'catch') renderCatch();
    else renderSeason();
  }

  return {
    id: 'logbook',
    el,
    show(opts) {
      if (opts?.tab) tab = opts.tab;
      render();
    },
    hide() {},
  };
}
