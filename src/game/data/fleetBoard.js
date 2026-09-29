// The fleet board: eight named Kodiak seiners whose season gross advances each fishing period, and the season-goal
// ladder paced on the same rate. Pure module.
//
// A "competent" player grosses about COMPETENT_DAILY per fishing day at an average point in the runs. Fleet boats fish
// at `rate` × that — around 0.8× on average, the highliner 1.2× — scaled by how strong the runs are that day
// (seasonFactor: 0.78 on Jul 6, ~1.3 at the pink peak, 0.36 on the last period), with day-to-day luck and the odd
// breakdown.
//
// Calibration (QA run qa/season/r3e, a scripted skipper at 1× time on build 4adc2d4): one set takes ~2 real minutes
// (setting 52 s, closing 8.5 s, pursing 16 s, hauling 32 s, brail + report 17 s) plus ~1.5–3 minutes running to the
// next school (0.5–1.7 km apart), so ~3.9 real minutes a set. It made 4 good sets between 06:00 and 21:30 on Jul 6
// (15.5 real minutes): 41,881 lb, $12,923 — $16.6k at an average run day. A competent human makes about three good
// sets a period (~0.75× the script): $12,500 at an average run day, ~$9.8k on Jul 6. A period is 16 real minutes
// open (1 game minute per real second) plus deliveries and moves: MINUTES_PER_PERIOD ≈ 17.5 (SPEC 8.1: 12 fishing
// days ≈ 3.5 h). The goals below land for that competent player near SPEC 8.3's times — $15k after ~1.4 periods
// (~25 min), $65k after ~5.1 periods (~1.5 h), $120k after ~8.6 periods (~2.5 h); the scripted skipper reaches them
// at ~20 min, ~70 min and ~2 h. On Jul 6 the top boat's median day is ~$11.7k (the script's $12.9k is highliner pace).

import { keyedRandom } from './market.js';
import { runStrength } from './calendar.js';

export const COMPETENT_DAILY = 12500;
export const MINUTES_PER_PERIOD = 17.5;

// Season goals on stats.seasonGross (labels as in config.economy.goals; the thresholds here are authoritative).
export const SEASON_GOALS = [
  { gross: 15000, label: 'Covered the grub and fuel bill', minutes: 25 },
  { gross: 65000, label: 'Permit loan paid off', minutes: 90 },
  { gross: 120000, label: 'Made the boat payment', minutes: 150 },
];
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

// What a competent player has grossed after `minutes` of real play (MINUTES_PER_PERIOD per fishing period, in order).
export function competentGrossAfter(config, minutes, perPeriod = MINUTES_PER_PERIOD) {
  let periods = Math.max(0, minutes / perPeriod);
  let gross = 0;
  for (const d of config.season.fishingDays) {
    if (periods <= 0) break;
    const part = Math.min(1, periods);
    gross += COMPETENT_DAILY * seasonFactor(config, d) * part;
    periods -= part;
  }
  return gross;
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
