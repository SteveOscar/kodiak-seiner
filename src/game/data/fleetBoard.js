// The fleet board: eight named Kodiak seiners whose season gross advances each fishing period. Pure module.
//
// A "competent" player grosses about COMPETENT_DAILY per fishing day at an average point in the runs (the season
// goals in config.economy are paced on it). Fleet boats fish at `rate` × that — around 0.8× on average, the
// highliner 1.2× — scaled by how strong the runs are that day, with day-to-day luck and the odd breakdown.

import { keyedRandom } from './market.js';
import { runStrength } from './calendar.js';

export const COMPETENT_DAILY = 7500;
export const AVG_PRICE = 0.42; // $/lb across a typical Kodiak seine catch, for turning dollars into radio pounds

export const FLEET = [
  { name: 'Karluk Queen', skipper: 'Rudy', rate: 1.2, homeport: 'Kodiak' },
  { name: 'Kayla Rose', skipper: 'Dale', rate: 0.95, homeport: 'Kodiak' },
  { name: 'Arctic Tern', skipper: 'Marnie', rate: 0.9, homeport: 'Kodiak' },
  { name: 'Nordic Star', skipper: 'Lars', rate: 0.85, homeport: 'Kodiak' },
  { name: 'Miss Tammy', skipper: 'Tommy', rate: 0.8, homeport: 'Old Harbor' },
  { name: 'Silver Spray', skipper: 'Vic', rate: 0.72, homeport: 'Kodiak' },
  { name: 'Sitkalidak', skipper: 'Nick', rate: 0.68, homeport: 'Old Harbor' },
  { name: 'Double Eagle', skipper: 'Sonny', rate: 0.62, homeport: 'Larsen Bay' },
];

const VALUE_WEIGHT = { pink: 1, sockeye: 0.6, chum: 0.35, coho: 0.3 };

function rawValue(config, day) {
  let v = 0;
  for (const [s, w] of Object.entries(VALUE_WEIGHT)) v += runStrength(config.fish.runs[s], day) * w;
  return v;
}

// Run-strength multiplier for a fishing day, normalised so the season's fishing days average 1.
export function seasonFactor(config, day) {
  const days = config.season.fishingDays;
  const mean = days.reduce((a, d) => a + rawValue(config, d), 0) / Math.max(1, days.length);
  return mean > 0 ? rawValue(config, day) / mean : 1;
}

// Deterministic gross for one boat on one fishing day.
export function fleetDayGross(seed, config, day, boat) {
  const u = keyedRandom(seed, `fleet:${day}:${boat.name}`);
  const breakdown = keyedRandom(seed, `fleet-bd:${day}:${boat.name}`) < 0.05;
  if (breakdown) return 0;
  const luck = boat.rate >= 1.1 ? 0.75 + 0.5 * u : 0.55 + 0.9 * u;
  return Math.round(COMPETENT_DAILY * boat.rate * seasonFactor(config, day) * luck);
}

export function createBoard(fleet = FLEET) {
  return { credited: [], boats: fleet.map((b) => ({ ...b, gross: 0, last: null })) };
}

// Credits every fishing period that has closed by (day, hours) and was not yet credited. Returns the newly credited
// days (in order).
export function creditThrough(board, config, seed, day, hours) {
  const out = [];
  for (const d of config.season.fishingDays) {
    const closed = d < day || (d === day && hours >= config.time.openerEnd);
    if (!closed || board.credited.includes(d)) continue;
    for (const b of board.boats) {
      const g = fleetDayGross(seed, config, d, b);
      b.gross += g;
      b.last = { day: d, gross: g, lbs: Math.round(g / AVG_PRICE / 100) * 100 };
    }
    board.credited.push(d);
    out.push(d);
  }
  return out;
}

// Board rows sorted by gross, including the player and today's partial catch while a period is open.
// player = { name, gross } → [{ name, skipper, gross, today, player, rank }]
export function boardRows(board, config, seed, day, hours, player = null) {
  const t = config.time;
  const open = config.season.fishingDays.includes(day) && hours >= t.openerStart && !board.credited.includes(day);
  const frac = open ? Math.min(1, Math.max(0, (hours - t.openerStart) / (t.openerEnd - t.openerStart))) : 0;
  const rows = board.boats.map((b) => {
    const today = open ? Math.round(fleetDayGross(seed, config, day, b) * frac) : 0;
    return { name: b.name, skipper: b.skipper, gross: b.gross + today, today, player: false };
  });
  if (player) rows.push({ name: player.name, skipper: 'You', gross: player.gross, today: player.today ?? 0, player: true });
  rows.sort((a, b) => b.gross - a.gross || (a.player ? -1 : 1));
  rows.forEach((r, i) => (r.rank = i + 1));
  return rows;
}

export function serializeBoard(board) {
  return { credited: [...board.credited], boats: board.boats.map((b) => ({ name: b.name, gross: b.gross, last: b.last })) };
}

export function restoreBoard(data, fleet = FLEET) {
  const board = createBoard(fleet);
  if (!data) return board;
  board.credited = Array.isArray(data.credited) ? data.credited.filter(Number.isFinite) : [];
  board.boats.forEach((b, i) => {
    const s = data.boats?.find((x) => x.name === b.name) ?? data.boats?.[i];
    if (s) {
      b.gross = Number(s.gross) || 0;
      b.last = s.last ?? null;
    }
  });
  return board;
}
