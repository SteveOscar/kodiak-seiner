// The set report card (fishing:setComplete) and the fish ticket (economy:delivered), each a pausing panel.

import { h, clear, button, setText } from './dom.js';
import { escapeSummary, reportHeadline, reportRows, reportValue, ticketModel } from './lib/logic.js';
import { int, money, duration } from './lib/format.js';

export function createReportPanel(ctx, { close }) {
  const kicker = h('div.rep-kicker');
  const title = h('h2.rep-title');
  const line = h('p.rep-line');
  const rows = h('div.rep-rows');
  const totals = h('div.rep-totals');
  const extra = h('div.rep-extra');
  const el = h('div.ui-panel.panel-report', null, [
    h('div.panel-card.rep-card.ui-interactive', null, [
      kicker,
      title,
      h('div.rep-rule'),
      line,
      rows,
      totals,
      extra,
      h('div.panel-actions', null, [button('Continue', () => close(), { cls: 'primary', key: 'Space' })]),
    ]),
  ]);

  return {
    id: 'report',
    el,
    show(r) {
      const hd = reportHeadline(r);
      el.dataset.tone = hd.tone;
      const mins = Number(r?.minutes);
      setText(kicker, `Set ${r?.setNumber ?? ''}${Number.isFinite(mins) && mins > 0 ? ` · ${duration(mins / 60)}` : ''} · ${hd.kicker}`);
      setText(title, hd.title);
      setText(line, hd.line);
      clear(rows);
      const list = reportRows(r, ctx.config.fish.species);
      const maxLbs = Math.max(1, ...list.map((x) => x.lbs));
      for (const x of list) {
        const barW = Math.max(2, (x.lbs / maxLbs) * 100);
        rows.append(
          h('div.rep-row', null, [
            h('span.rep-chip', { style: { background: x.color } }),
            h('span.rep-name', { text: x.name }),
            h('span.rep-bar', null, [h('span.rep-bar-fill', { style: { width: `${barW}%`, background: x.color } })]),
            h('span.rep-count', { text: x.count > 0 ? `${int(x.count)} fish` : '' }),
            h('span.rep-lbs', { text: x.count > 0 ? `${int(x.lbs)} lb` : '' }),
            x.released > 0 ? h('span.rep-released', { text: x.species === 'king' ? `${int(x.released)} released` : `${int(x.released)} over the corks` }) : null,
          ]),
        );
      }
      toggle(rows, list.length === 0);
      clear(totals);
      if (!r?.waterHaul && !r?.cited) {
        const val = reportValue(r);
        const approx = val.approx ? '≈ ' : '';
        totals.append(
          stat('Brailed aboard', `${int(r?.totalLbs ?? 0)} lb`),
          stat(val.label, approx + money(r?.value ?? 0)),
          stat('Crew share (30%)', approx + money((r?.value ?? 0) * (ctx.config.economy?.crewShare ?? 0.3))),
        );
      }
      clear(extra);
      const esc = escapeSummary(r);
      if (esc?.cause) extra.append(h('p.rep-escape', { text: esc.text }));
      const notes = [];
      if (esc && !esc.cause) notes.push(esc.text);
      const kings = Number(r?.released?.king) || 0;
      if (kings > 0) notes.push(`${int(kings)} king${kings > 1 ? 's' : ''} released`);
      if (r?.cited) notes.push(`Fine ${money(r.fine ?? 0)} · catch forfeited`);
      const eco = ctx.systems.economy;
      if (eco && !r?.waterHaul && !r?.cited) {
        const lbs = typeof eco.holdLbs === 'function' ? eco.holdLbs() : 0;
        notes.push(`Hold ${int(lbs)} / ${int(eco.capacityLbs ?? 0)} lb`);
      }
      for (const n of notes) extra.append(h('span.rep-note', { text: n }));
    },
    hide() {},
  };
}

function stat(label, value) {
  return h('div.rep-stat', null, [h('span.rep-stat-l', { text: label }), h('span.rep-stat-v', { text: value })]);
}

function toggle(el, hidden) {
  el.classList.toggle('hidden', !!hidden);
}

// ---------------------------------------------------------------- fish ticket

export function createTicketPanel(ctx, { close }) {
  const paper = h('div.ticket.ui-interactive');
  const el = h('div.ui-panel.panel-ticket', null, [h('div.ticket-wrap', null, [paper, h('div.panel-actions.ticket-actions.ui-interactive', null, [button('Done', () => close(), { cls: 'primary', key: 'Space' })])])]);

  function field(label, value, cls = '') {
    return h(`div.tk-field${cls ? `.${cls}` : ''}`, null, [h('span.tk-l', { text: label }), h('span.tk-v', { text: value })]);
  }

  return {
    id: 'ticket',
    el,
    show(rec) {
      const m = ticketModel(rec, {
        speciesTable: ctx.config.fish.species,
        seasonStart: ctx.config.time.seasonStart,
        day: ctx.clock.day,
        hours: ctx.clock.hours,
        boatName: ctx.systems.seiner?.boatName,
        permit: ctx.systems.economy?.permit,
      });
      clear(paper);
      const lines = h('div.tk-table', null, [
        h('div.tk-tr.tk-th', null, ['Code', 'Species', 'No. fish', 'Pounds', 'Price/lb', 'Value'].map((t) => h('span', { text: t }))),
        ...m.lines.map((l) =>
          h('div.tk-tr', null, [
            h('span.tk-code', { text: l.code }),
            h('span.tk-sp', null, [h('span.tk-chip', { style: { background: l.color } }), l.species]),
            h('span.num', { text: l.count }),
            h('span.num', { text: l.lbs }),
            h('span.num', { text: l.price }),
            h('span.num', { text: l.value }),
          ]),
        ),
        ...Array.from({ length: Math.max(0, 4 - m.lines.length) }, () => h('div.tk-tr.tk-blank', null, [h('span'), h('span'), h('span'), h('span'), h('span'), h('span')])),
        h('div.tk-tr.tk-total', null, [h('span'), h('span', { text: 'Totals' }), h('span'), h('span.num', { text: m.totalLbs }), h('span'), h('span.num', { text: m.gross })]),
      ]);
      const settle = h('div.tk-settle', null, [
        h('div.tk-srow', null, [h('span', { text: 'Gross value' }), h('span.num', { text: m.gross })]),
        ...m.crew.map((c) => h('div.tk-srow.tk-crew', null, [h('span', { text: `Crew share — ${c.role} (10%)` }), h('span.num', { text: `−${c.share}` })])),
        m.advanceRepaid ? h('div.tk-srow.tk-crew', null, [h('span', { text: 'Cannery advance repaid' }), h('span.num', { text: `−${m.advanceRepaid}` })]) : null,
        h('div.tk-srow.tk-net', null, [h('span', { text: m.advanceRepaid ? 'Paid to vessel (after advance)' : 'Paid to vessel' }), h('span.num', { text: m.advanceRepaid ? money(m.rawNet - m.rawAdvance, { cents: true }) : m.net })]),
      ]);
      paper.append(
        h('div.tk-head', null, [
          h('div.tk-seal', null, [h('div.tk-seal-in', { text: 'ADF&G' })]),
          h('div.tk-titles', null, [h('div.tk-state', { text: 'State of Alaska · Department of Fish and Game' }), h('div.tk-name', { text: 'Salmon Fish Ticket' }), h('div.tk-form', { text: 'Commercial Fisheries Division · Kodiak Management Area' })]),
          h('div.tk-no', null, [h('span.tk-l', { text: 'Ticket no.' }), h('span.tk-no-v', { text: m.ticket })]),
        ]),
        h('div.tk-grid', null, [
          field('Date landed', m.date),
          field('Time landed', m.time),
          field('Vessel name', `F/V ${m.vessel}`, 'wide'),
          field('CFEC permit', m.permit),
          field('Gear', m.gear),
          field('Condition', m.condition),
          field('Delivery', '01 Round (whole)'),
          field('District', m.district, 'wide'),
          field('Stat area', m.statArea),
          field('Processor / tender', m.tender),
        ]),
        lines,
        settle,
        h('div.tk-sign', null, [
          h('div.tk-sig', null, [h('span.tk-sig-name', { text: `F/V ${m.vessel}` }), h('span.tk-l', { text: 'Signature of permit holder' })]),
          h('div.tk-sig', null, [h('span.tk-sig-name', { text: m.tender }), h('span.tk-l', { text: 'Received by' })]),
        ]),
        h('div.tk-stamp', { text: 'Paid' }),
      );
    },
    hide() {},
  };
}
