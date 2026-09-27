// Seeded daily weather schedule for Kodiak in July and August, and NOAA-style marine forecast text. Pure module.
//
// Kodiak summers are mostly grey: fog in the mornings (worst on the south-west side and in Shelikof Strait), low
// overcast, drizzle off the Gulf, a handful of clear golden days, and a couple of south-east blows that get worse
// toward late August. Each day is one of a few types expanded into segments [{h, preset}] of sky presets
// (clear|partly|overcast|fog|rain|storm) plus nominal wind and seas for the forecast text.

import { createRng } from '../../core/rng.js';

export const PRESETS = ['clear', 'partly', 'overcast', 'fog', 'rain', 'storm'];

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const compass = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

// Seas (ft) that a sustained wind raises on the Kodiak shelf, plus background Gulf swell.
export const seasFor = (kt) => Math.max(1, Math.round(kt * 0.3));

function pickType(r, day) {
  const t = Math.min(1, day / 47);
  const w = {
    fog: 0.24 - 0.06 * t,
    overcast: 0.24,
    drizzle: 0.14 + 0.08 * t,
    partly: 0.2,
    clear: 0.18 - 0.04 * t,
  };
  let x = r.next() * Object.values(w).reduce((a, b) => a + b, 0);
  for (const [k, v] of Object.entries(w)) {
    x -= v;
    if (x <= 0) return k;
  }
  return 'overcast';
}

const round1 = (x) => Math.round(x * 2) / 2;

function expand(type, r, prev) {
  const dir = (base, spread) => (base + r.range(-spread, spread) + 360) % 360;
  const kt = (a, b) => Math.round(r.range(a, b) / 5) * 5 || 5;
  const wetBefore = prev && (prev.type === 'drizzle' || prev.type === 'blow');
  switch (type) {
    case 'opening':
      return { segs: [{ h: 0, preset: 'partly' }, { h: 16, preset: 'clear' }], am: { dir: 270, kt: 5 }, pm: { dir: 280, kt: 10 }, night: { dir: 300, kt: 5 } };
    case 'fog': {
      const burn = round1(r.range(8.5, 11));
      const after = r.chance(0.6) ? 'partly' : 'overcast';
      const segs = [{ h: 0, preset: wetBefore ? 'overcast' : 'fog' }];
      if (wetBefore) segs.push({ h: 3, preset: 'fog' });
      segs.push({ h: burn, preset: after });
      if (r.chance(0.35)) segs.push({ h: 19, preset: 'clear' });
      const d = dir(210, 30);
      return { segs, am: { dir: d, kt: 5 }, pm: { dir: d, kt: kt(5, 15) }, night: { dir: d, kt: 5 } };
    }
    case 'overcast': {
      const segs = [{ h: 0, preset: 'overcast' }];
      if (r.chance(0.25)) {
        segs.push({ h: round1(r.range(14, 17)), preset: 'rain' });
        segs.push({ h: 20.5, preset: 'overcast' });
      }
      const d = dir(225, 35);
      return { segs, am: { dir: d, kt: kt(8, 15) }, pm: { dir: d, kt: kt(10, 18) }, night: { dir: d, kt: 10 } };
    }
    case 'drizzle': {
      const segs = [{ h: 0, preset: 'rain' }, { h: round1(r.range(9, 12)), preset: 'overcast' }];
      if (r.chance(0.25)) segs.push({ h: 20, preset: 'fog' });
      const d = dir(140, 30);
      return { segs, am: { dir: d, kt: kt(10, 20) }, pm: { dir: d, kt: kt(10, 18) }, night: { dir: d, kt: 10 } };
    }
    case 'partly': {
      const segs = r.chance(0.2) ? [{ h: 0, preset: 'fog' }, { h: round1(r.range(7, 8.5)), preset: 'partly' }] : [{ h: 0, preset: 'partly' }];
      if (r.chance(0.5)) segs.push({ h: round1(r.range(16, 18.5)), preset: 'clear' });
      const d = dir(285, 40);
      return { segs, am: { dir: d, kt: kt(5, 12) }, pm: { dir: d, kt: kt(8, 15) }, night: { dir: d, kt: 5 } };
    }
    case 'clear': {
      const segs = [{ h: 0, preset: 'clear' }];
      if (r.chance(0.25)) segs.push({ h: 3, preset: 'fog' }, { h: round1(r.range(6.5, 8)), preset: 'clear' });
      const d = dir(315, 30);
      return { segs, am: { dir: d, kt: 5 }, pm: { dir: d, kt: kt(8, 15) }, night: { dir: d, kt: 5 } };
    }
    case 'blow': {
      const d = dir(130, 20);
      return {
        segs: [{ h: 0, preset: 'overcast' }, { h: round1(r.range(6, 8.5)), preset: 'rain' }, { h: round1(r.range(12, 15)), preset: 'storm' }],
        am: { dir: d, kt: kt(18, 25) },
        pm: { dir: d, kt: kt(35, 45) },
        night: { dir: d, kt: kt(35, 45) },
      };
    }
    case 'clearing': {
      const d = dir(235, 20);
      return {
        segs: [{ h: 0, preset: 'storm' }, { h: round1(r.range(4.5, 6.5)), preset: 'rain' }, { h: 11, preset: 'overcast' }, { h: round1(r.range(16, 18)), preset: 'partly' }],
        am: { dir: d, kt: kt(25, 30) },
        pm: { dir: d, kt: kt(12, 18) },
        night: { dir: (d + 40) % 360, kt: 10 },
      };
    }
    default:
      return { segs: [{ h: 0, preset: 'partly' }], am: { dir: 270, kt: 10 }, pm: { dir: 270, kt: 10 }, night: { dir: 270, kt: 5 } };
  }
}

// Builds a plan for `days` days: [{ day, type, segs: [{h, preset}], am, pm, night: {dir (deg, wind FROM), kt} }].
export function buildWeatherPlan(seed, days = 64) {
  const r = createRng((seed >>> 0) || 1);
  const blows = new Set();
  blows.add(r.int(11, 20));
  blows.add(r.int(31, 44));
  if (r.chance(0.5)) blows.add(r.int(23, 28));
  const plan = [];
  for (let day = 0; day < days; day++) {
    const prev = plan[day - 1];
    let type;
    if (day === 0) type = 'opening';
    else if (prev?.type === 'blow') type = 'clearing';
    else if (blows.has(day)) type = 'blow';
    else type = pickType(r, day);
    plan.push({ day, type, ...expand(type, r, prev) });
  }
  return plan;
}

function dayOf(plan, day) {
  if (!plan.length) return null;
  return plan[Math.max(0, Math.min(plan.length - 1, day))];
}

// Sky preset scheduled at (day, hours).
export function presetAt(plan, day, hours) {
  const d = dayOf(plan, day);
  if (!d) return 'partly';
  let p = d.segs[0].preset;
  for (const s of d.segs) if (s.h <= hours) p = s.preset;
  return p;
}

// Index of the segment active at (day, hours), used to detect boundaries: `${day}:${i}`.
export function segmentKey(plan, day, hours) {
  const d = dayOf(plan, day);
  if (!d) return `${day}:0`;
  let i = 0;
  d.segs.forEach((s, k) => {
    if (s.h <= hours) i = k;
  });
  return `${day}:${i}`;
}

// The preset that covers most of the daylight fishing window (06:00–22:00).
export function dominantPreset(plan, day) {
  const d = dayOf(plan, day);
  if (!d) return 'partly';
  const cover = {};
  for (let h = 6; h < 22; h += 0.5) {
    const p = presetAt(plan, day, h);
    cover[p] = (cover[p] ?? 0) + 1;
  }
  // Bad weather dominates the description when it takes a real bite out of the day.
  if ((cover.storm ?? 0) >= 6) return 'storm';
  return Object.entries(cover).sort((a, b) => b[1] - a[1])[0][0];
}

// Presets scheduled in [from, to) hours after the start of `day` (may run past midnight).
function presetsIn(plan, day, from, to) {
  const set = new Set();
  for (let t = from; t < to; t += 0.5) {
    const k = Math.floor(t / 24);
    set.add(presetAt(plan, day + k, t - k * 24));
  }
  return set;
}

function wxText(plan, day, from, to) {
  const d = dayOf(plan, day);
  const ps = presetsIn(plan, day, from, to);
  const out = [];
  const stormy = ps.has('storm');
  if (stormy || ps.has('rain')) out.push(stormy || d?.type === 'blow' || d?.type === 'clearing' ? 'Rain' : 'Drizzle');
  if (ps.has('fog')) {
    const morningOnly = from < 12 && !presetsIn(plan, day, 12, to).has('fog');
    out.push(out.length ? 'fog' : morningOnly ? 'Areas of fog in the morning' : 'Patchy fog');
  }
  return out.length ? `${out.join(' and ')}.` : '';
}

function windText(a, b) {
  const s = `${compass(a.dir)} wind ${a.kt} kt`;
  if (!b || (b.kt === a.kt && compass(b.dir) === compass(a.dir))) return `${s}.`;
  if (compass(b.dir) === compass(a.dir)) return `${s} ${b.kt > a.kt ? 'rising' : 'diminishing'} to ${b.kt} kt in the afternoon.`;
  return `${s} becoming ${compass(b.dir)} ${b.kt} kt in the afternoon.`;
}

function seasText(a, b) {
  const s1 = seasFor(a.kt);
  const s2 = b ? seasFor(b.kt) : s1;
  if (s2 === s1) return `Seas ${s1} ft.`;
  return `Seas ${s1} ft ${s2 > s1 ? 'building' : 'subsiding'} to ${s2} ft.`;
}

export function warningFor(...winds) {
  const max = Math.max(...winds.filter(Boolean).map((w) => w.kt));
  if (max >= 34) return 'Gale Warning';
  if (max >= 23) return 'Small Craft Advisory';
  return null;
}

// NOAA-style marine forecast for "Kodiak Island waters".
// → { today, tomorrow (dominant presets), warning, todayText, tonightText, tomorrowText, text, wind, seasFt }
export function forecastFor(plan, day, hours, dateOf) {
  const d = dayOf(plan, day);
  const n = dayOf(plan, day + 1);
  const tomorrowName = dateOf ? dateOf(day + 1).weekday : 'Tomorrow';
  if (!d || !n) {
    return { today: 'partly', tomorrow: 'partly', warning: null, text: 'Kodiak Island waters. Variable winds 10 kt. Seas 3 ft.', todayText: '', tonightText: '', tomorrowText: '', wind: { dir: 270, kt: 10, from: 'W' }, seasFt: 3 };
  }
  const afternoon = hours >= 15;
  const evening = hours >= 18 || hours < 3;
  const todayLabel = afternoon ? 'This afternoon' : 'Today';
  const todayText = evening
    ? ''
    : afternoon
      ? `${windText(d.pm)} ${seasText(d.pm)} ${wxText(plan, day, Math.max(15, hours), 22)}`.trim()
      : `${windText(d.am, d.pm)} ${seasText(d.am, d.pm)} ${wxText(plan, day, Math.max(5, hours), 22)}`.trim();
  const tonightText = `${windText(d.night)} ${seasText(d.night)} ${wxText(plan, day, 22, 29)}`.trim();
  const tomorrowText = `${windText(n.am, n.pm)} ${seasText(n.am, n.pm)} ${wxText(plan, day + 1, 5, 22)}`.trim();
  const warning = warningFor(afternoon ? null : d.am, d.pm, d.night, n.am, n.pm);
  const head = warning ? `...${warning.toUpperCase()}... ` : '';
  const text = `${head}Kodiak Island waters. ${evening ? '' : `${todayLabel}: ${todayText} `}Tonight: ${tonightText} ${tomorrowName}: ${tomorrowText}`;
  const nowWind = hours >= 22 || hours < 4 ? d.night : afternoon ? d.pm : d.am;
  return {
    today: dominantPreset(plan, day),
    tomorrow: dominantPreset(plan, day + 1),
    warning,
    todayText,
    tonightText,
    tomorrowText,
    text,
    wind: { ...nowWind, from: compass(nowWind.dir) },
    seasFt: seasFor(nowWind.kt),
  };
}
