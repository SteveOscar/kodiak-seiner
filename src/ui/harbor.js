// Harbour menu (tied up at a place with services): sell the catch, take on fuel, the boatyard's upgrades with
// descriptions, effects and prices, and rest (sleep / wait for the opener). All actions go through economy and season.

import { h, clear, button, setText } from './dom.js';
import { money, int } from './lib/format.js';

const holdLbsLabel = (lbs) => `${int(lbs)} lb`;

const CATEGORY = { deck: 'Deck gear', gear: 'The seine', boat: 'The boat', electronics: 'Electronics', hold: 'Fish hold', charter: 'Charter' };
const ORDER = ['gear', 'deck', 'electronics', 'hold', 'boat', 'charter'];

export function createHarborPanel(ctx, { close, resume }) {
  const kicker = h('div.panel-kicker');
  const title = h('h2.panel-title');
  const services = h('div.hb-services');
  const left = h('div.hb-left');
  const right = h('div.hb-right');
  const el = h('div.ui-panel.panel-harbor', null, [
    h('div.panel-card.hb-card.ui-interactive', null, [
      h('div.hb-head', null, [h('div', null, [kicker, title]), services]),
      h('div.panel-rule'),
      h('div.hb-body', null, [left, right]),
      h('div.panel-actions', null, [button('Cast off', () => close(), { cls: 'primary', key: 'Esc' })]),
    ]),
  ]);
  let place = null;

  const eco = () => ctx.systems.economy;
  const season = () => ctx.systems.season;

  function section(t, children, cls = '') {
    return h(`div.hb-sec${cls ? `.${cls}` : ''}`, null, [h('div.hb-sec-h', { text: t }), ...children]);
  }

  function render() {
    const e = eco();
    const svc = place?.services ?? [];
    setText(kicker, place?.kind === 'town' ? 'Harbour' : place?.kind === 'cannery' ? 'Cannery dock' : 'Tied up');
    setText(title, place?.name ?? 'Harbour');
    clear(services);
    for (const s of svc) services.append(h('span.hb-chip', { text: { sell: 'Fish buyer', fuel: 'Fuel dock', upgrades: 'Boatyard', ice: 'Ice', rest: 'Rest' }[s] ?? s }));

    // Left column: the boat, selling, fuel, rest.
    clear(left);
    const lbs = typeof e?.holdLbs === 'function' ? e.holdLbs() : 0;
    const cap = Number(e?.capacityLbs) || 0;
    const gear = e?.gearSummary?.() ?? null;
    left.append(
      section('Your boat', [
        h('div.hb-kv', null, [h('span', { text: 'Cash' }), h(`span.hb-v${(e?.cash ?? 0) < 0 ? '.neg' : ''}`, { text: money(e?.cash ?? 0) })]),
        h('div.hb-kv', null, [h('span', { text: 'Hold' }), h('span.hb-v', { text: `${int(lbs)} / ${int(cap)} lb` })]),
        h('div.hb-kv', null, [h('span', { text: 'Fuel' }), h('span.hb-v', { text: `${int(e?.fuel ?? 0)} / ${int(e?.fuelCapacity ?? 0)} gal` })]),
        gear ? h('div.hb-kv', null, [h('span', { text: 'Seine' }), h('span.hb-v', { text: gear.seine })]) : null,
        gear ? h('div.hb-kv', null, [h('span', { text: 'Sonar · top speed' }), h('span.hb-v', { text: `${gear.sonar} · ${gear.speed}` })]) : null,
      ]),
    );
    if (svc.includes('sell')) {
      const can = lbs > 0;
      left.append(
        section('Fish buyer', [
          h('p.hb-p', { text: can ? `${holdLbsLabel(lbs)} aboard. The cannery pays today's price, less the crew's 30% share.` : 'Nothing in the hold to sell.' }),
          button(can ? 'Sell the catch' : 'Hold is empty', () => {
            const r = e?.deliver?.({ id: place.id, name: place.name });
            if (!r) ctx.systems.ui?.toast?.('Nothing to sell.', { kind: 'info' });
            render();
          }, { disabled: !can, cls: can ? 'primary' : '' }),
        ]),
      );
    }
    if (svc.includes('fuel')) {
      const q = e?.refuelQuote?.(place) ?? null;
      const want = q?.wanted ?? 0;
      const explore = !!ctx.state.freeExplore;
      left.append(
        section('Fuel dock', [
          h('p.hb-p', { text: want <= 0 ? 'Tanks are full.' : explore ? 'Top off the tanks — no charge in Free Explore.' : `${int(q.gallons)} gal at ${money(q.price, { cents: true })} — ${money(q.cost)}${q.gallons < want ? ' (all the cannery will front you)' : ''}.` }),
          button(want <= 0 ? 'Tanks full' : 'Fill the tanks', () => {
            const r = e?.refuel?.(place);
            if (r && !r.ok && r.reason) ctx.systems.ui?.toast?.(r.reason, { kind: 'warn' });
            render();
          }, { disabled: want <= 0 || (q?.gallons ?? 0) <= 0 }),
        ]),
      );
    }
    const sleep = season()?.canSleep?.() ?? { ok: false, reason: 'Not available' };
    const wait = season()?.canWait?.() ?? { ok: false, reason: 'Not available' };
    const rest = [];
    rest.push(
      h('div.hb-rest', null, [
        button('Sleep until morning', () => {
          resume();
          season()?.sleep?.();
        }, { disabled: !sleep.ok }),
        h('span.hb-reason', { text: sleep.ok ? 'Wake at 5:00 AM · autosaves' : sleep.reason ?? '' }),
      ]),
    );
    if (!ctx.state.freeExplore) {
      rest.push(
        h('div.hb-rest', null, [
          button('Wait for the opener', () => {
            resume();
            season()?.waitForOpener?.();
          }, { disabled: !wait.ok }),
          h('span.hb-reason', { text: wait.ok ? `${wait.opener?.label ?? 'Next period'} · autosaves` : wait.reason ?? '' }),
        ]),
      );
    }
    left.append(section('Rest', rest));

    // Right column: the boatyard.
    clear(right);
    if (!svc.includes('upgrades')) {
      right.append(section('Boatyard', [h('p.hb-p.muted', { text: 'Upgrades are fitted at the Kodiak boatyard — tie up at the City of Kodiak.' })]));
      const sp = (e?.catalog ?? []).find((r) => r.id === 'spotter');
      if (sp) right.append(section('Charter', [upgradeCard(sp)]));
      return;
    }
    const rows = [...(e?.catalog ?? [])].sort((a, b) => ORDER.indexOf(a.category) - ORDER.indexOf(b.category));
    const list = h('div.hb-upgrades');
    for (const r of rows) list.append(upgradeCard(r));
    right.append(section('Boatyard', [list], 'hb-yard'));
  }

  function upgradeCard(r) {
    const e = eco();
    const can = e?.canBuy?.(r.id) ?? { ok: !!r.affordable };
    const pips = h('span.up-pips');
    for (let i = 0; i < (r.maxLevel ?? 1); i++) pips.append(h(`span.up-pip${i < (r.level ?? 0) ? '.on' : ''}`));
    const priceLabel = r.maxed ? (r.consumable ? 'Chartered' : 'Fitted') : money(r.price ?? 0);
    const b = button(r.maxed ? (r.consumable ? 'Booked' : 'Maxed') : r.consumable ? 'Charter' : 'Buy', () => {
      const ok = e?.buy?.(r.id);
      if (!ok) ctx.systems.ui?.toast?.(e?.lastBuyError ?? 'Can’t buy that right now.', { kind: 'warn' });
      render();
    }, { disabled: r.maxed || !can.ok, cls: can.ok && !r.maxed ? 'primary small' : 'small' });
    return h(`div.up-card${r.maxed ? '.maxed' : ''}`, null, [
      h('div.up-top', null, [h('span.up-cat', { text: CATEGORY[r.category] ?? r.category }), pips]),
      h('div.up-name', { text: r.name }),
      h('p.up-blurb', { text: r.blurb ?? '' }),
      h('div.up-change', null, [h('span.up-now', { text: r.current ?? '' }), r.next && !r.maxed ? h('span.up-arrow', { text: '→' }) : null, r.next && !r.maxed ? h('span.up-next', { text: r.next }) : null]),
      h('div.up-buy', null, [h('span.up-price', { text: priceLabel }), !can.ok && !r.maxed && can.reason ? h('span.up-reason', { text: can.reason }) : null, b]),
    ]);
  }

  const onChange = () => {
    if (el.classList.contains('open')) render();
  };
  ctx.events.on('economy:cash', onChange);

  return {
    id: 'harbor',
    el,
    show(p) {
      place = p ?? eco()?.dockedAt?.() ?? null;
      render();
    },
    hide() {},
  };
}
