// WP-UI QA fixes: radio pacing that keeps Uncle Pete's tips readable, and the set report's escape cause and value
// labels. Pure logic from src/ui/lib/logic.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../src/ui/lib/logic.js';

// Mirrors messages.js: enqueue, pump (nextRadio), age, retire at life, trim the stack (radioOverflow).
function simulate(arrivals, { seconds = 40, dt = 0.05, max = 2 } = {}) {
  const queue = [];
  const cards = [];
  const log = [];
  let t = 0;
  const pending = [...arrivals].sort((a, b) => a.at - b.at);
  while (t < seconds) {
    while (pending.length && pending[0].at <= t) {
      const r = pending.shift();
      queue.push({ ...r, pinned: L.isPinnedRadio(r) });
    }
    const i = L.nextRadio(queue, cards);
    if (i >= 0) {
      const r = queue.splice(i, 1)[0];
      const card = { id: r.id, t: 0, typing: r.text.length / 42, life: L.radioLife(r.text, { pinned: r.pinned, tip: r.tip }), pinned: r.pinned, shownAt: t };
      cards.push(card);
      for (const c of L.radioOverflow(cards, max)) {
        c.dead = true;
        c.retiredAt = t;
        cards.splice(cards.indexOf(c), 1);
      }
      log.push({ id: r.id, at: t, stack: cards.map((c) => c.id) });
    }
    for (const c of cards) {
      c.t += dt;
      if (c.t > c.life) {
        c.dead = true;
        c.expiredAt = t;
      }
    }
    for (let k = cards.length - 1; k >= 0; k--) if (cards[k].dead) cards.splice(k, 1);
    t += dt;
  }
  return log;
}

const TIP = "See those humpies popping? That's a school milling. Get up close — not on top of 'em — and hit Space to let the skiff go.";
const ADFG = 'Attention all Kodiak seiners: closed waters are in effect at the mouths of the Karluk and Ayakulik; stay outside the markers.';
const NOAA = 'NOAA weather for Kodiak waters: southwest wind 10 knots, seas 3 feet, patchy fog in the morning.';

test('tips and Pete calls are pinned; routine traffic is not', () => {
  assert.equal(L.isPinnedRadio({ tip: true, from: 'Uncle Pete' }), true);
  assert.equal(L.isPinnedRadio({ from: 'Uncle Pete', text: 'Morning!' }), true);
  assert.equal(L.isPinnedRadio({ from: 'ADF&G Kodiak' }), false);
  assert.equal(L.isPinnedRadio({ from: 'F/V Double Eagle', pin: true }), true);
  assert.equal(L.isPinnedRadio(null), false);
  // A tip stays up at least 12 s even when it is short.
  assert.ok(L.radioLife('Hit Space.', { pinned: true, tip: true }) >= 12);
  assert.ok(L.radioLife(TIP, { pinned: true, tip: true }) >= 12);
  assert.ok(L.radioLife('Short chatter.', {}) < 12);
});

test('a tip is not collapsed or pushed off by broadcasts arriving right behind it (QA [16])', () => {
  // The let-go tip at 6:00, then ADF&G at 6:02, Double Eagle and NOAA twice within a few seconds of real time.
  const log = simulate([
    { id: 'tip', at: 0, tip: true, from: 'Uncle Pete', text: TIP },
    { id: 'adfg', at: 1.5, from: 'ADF&G Kodiak', text: ADFG },
    { id: 'eagle', at: 3, from: 'F/V Double Eagle', text: 'Double Eagle, anybody seeing fish off Spruce Cape?' },
    { id: 'noaa1', at: 5, from: 'NOAA', text: NOAA },
    { id: 'noaa2', at: 7, from: 'NOAA', text: NOAA },
  ]);
  const tip = log.find((e) => e.id === 'tip');
  assert.equal(tip.at, 0);
  const typing = TIP.length / 42;
  // Routine traffic waits until the tip has been typed and read.
  const firstOther = log.find((e) => e.id !== 'tip');
  assert.ok(firstOther.at >= typing + L.RADIO_PACING.pinQuiet - 0.06, `routine call started at ${firstOther.at}`);
  // The tip stays in the stack (full-size: pinned) for at least 12 s even as two more calls arrive.
  for (const e of log.filter((x) => x.at < 12)) assert.ok(e.stack.includes('tip'), `tip missing from the stack at ${e.at}: ${e.stack}`);
  // Nothing is lost that the queue can hold; the routine calls all play afterwards, in order.
  assert.deepEqual(log.map((e) => e.id), ['tip', 'adfg', 'eagle', 'noaa1', 'noaa2']);
});

test('a tip jumps queued chatter but still waits for the call being typed', () => {
  const log = simulate([
    { id: 'cg', at: 0, from: 'Coast Guard', text: ADFG },
    { id: 'noaa', at: 0.5, from: 'NOAA', text: NOAA },
    { id: 'tip', at: 1, tip: true, from: 'Uncle Pete', text: 'Now purse her up. Hold E on the winch — keep the needle in the green.' },
  ]);
  assert.deepEqual(log.map((e) => e.id), ['cg', 'tip', 'noaa']);
  const cg = log[0];
  const tip = log[1];
  assert.ok(tip.at >= cg.at + ADFG.length / 42 + L.RADIO_PACING.gap - 0.06);
});

test('stack overflow retires the oldest unpinned card before a pinned one', () => {
  const a = { id: 'a', pinned: true };
  const b = { id: 'b', pinned: false };
  const c = { id: 'c', pinned: false };
  assert.deepEqual(L.radioOverflow([a, b, c], 2).map((x) => x.id), ['b']);
  assert.deepEqual(L.radioOverflow([b, a, c], 2).map((x) => x.id), ['b']);
  // Only pinned cards below the newest: the oldest goes.
  const d = { id: 'd', pinned: true };
  assert.deepEqual(L.radioOverflow([a, d, c], 2).map((x) => x.id), ['a']);
  assert.deepEqual(L.radioOverflow([a, c], 2), []);
});

test('Skipper’s-notes cards wait while a pinned call is being read', () => {
  const card = { pinned: true, t: 1, typing: 3, life: 12 };
  assert.equal(L.pinnedReading([card]), true);
  assert.equal(L.pinnedReading([{ ...card, t: 9.5 }]), false);
  assert.equal(L.pinnedReading([{ ...card, dead: true }]), false);
  assert.equal(L.pinnedReading([{ pinned: false, t: 0, typing: 3, life: 8 }]), false);
});

test('set report names the main escape cause and what to do about it (QA [38] / newplayer haul finding)', () => {
  const gap = L.escapeSummary({ escaped: 1820, escapes: { leads: 300, corks: 0, gap: 1040, hole: 0, overflow: 480 } });
  assert.equal(gap.cause, 'gap');
  assert.equal(gap.total, 1340); // overflow is shown on the species rows, not here
  assert.match(gap.text, /^1,340 got away — most out through the gap before you closed up \(1,040\)\. Close up sooner\.$/);
  const corks = L.escapeSummary({ escapes: { corks: 2060 } });
  assert.equal(corks.cause, 'corks');
  assert.match(corks.text, /^2,060 got away over the corks on the haul\. Ease off the block/);
  // No breakdown yet: the count alone, without guessing a cause.
  assert.deepEqual(L.escapeSummary({ escaped: 812 }), { total: 812, cause: null, text: '812 got away' });
  assert.equal(L.escapeSummary({ escaped: 0 }), null);
  assert.equal(L.escapeSummary({ escapes: { leads: 0, overflow: 50 } }), null);
  assert.equal(L.escapeSummary(null), null);
});

test('set report value label follows valuedAt / estimate', () => {
  assert.deepEqual(L.reportValue({ value: 4169 }), { label: 'At today’s prices', approx: false });
  assert.deepEqual(L.reportValue({ valuedAt: 'Sea Venture' }), { label: 'At Sea Venture prices', approx: false });
  assert.deepEqual(L.reportValue({ valuedAt: { id: 'sea-venture', name: 'Sea Venture' } }), { label: 'At Sea Venture prices', approx: false });
  assert.deepEqual(L.reportValue({ estimate: true }), { label: 'At today’s average price', approx: true });
  assert.deepEqual(L.reportValue({ valuedAt: 'average' }), { label: 'At today’s average price', approx: true });
  // fishing's payload: valuedAt null = no buying tender in reach, valued at the market estimate.
  assert.deepEqual(L.reportValue({ valuedAt: null, valuedAtId: null }), { label: 'At today’s average price', approx: true });
  // All-zero escapes (a clean set) say nothing.
  assert.equal(L.escapeSummary({ escaped: 0, escapes: { leads: 0, corks: 0, gap: 0, hole: 0, overflow: 0 } }), null);
});
