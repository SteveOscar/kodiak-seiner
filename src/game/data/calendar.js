// ADF&G fishing-period calendar, district rules, run timing and calendar labels for the Kodiak Management Area.
// Pure module (no DOM, no THREE): season.js wraps it, tests import it directly.

export const SEASON_YEAR = 2026; // July 6, 2026 is a Monday; only used for weekday names

export const DISTRICT_IDS = ['afognak', 'northwest', 'southwest', 'alitak', 'eastside', 'northeast', 'mainland'];

export const DISTRICT_NAMES = {
  afognak: 'Afognak District',
  northwest: 'Northwest Kodiak District',
  southwest: 'Southwest Kodiak District',
  alitak: 'Alitak District',
  eastside: 'Eastside Kodiak District',
  northeast: 'Northeast Kodiak District',
  mainland: 'Mainland District',
};

// ADF&G statistical-area prefixes used on fish tickets.
export const STAT_AREAS = {
  afognak: 252,
  northwest: 253,
  southwest: 255,
  alitak: 257,
  eastside: 258,
  northeast: 259,
  mainland: 262,
};

// Districts that stay closed during a period (keyed by fishing-day index); every other district opens 06:00–22:00.
// The Mainland District (Katmai coast across Shelikof Strait) opens on alternate periods; the Alitak District holds
// the second period for early Upper Station / Frazer sockeye escapement.
export const PERIOD_CLOSURES = {
  0: ['mainland'],
  2: ['mainland', 'alitak'],
  9: ['mainland'],
  17: ['mainland'],
  25: ['mainland'],
  34: ['mainland'],
  47: ['mainland'],
};

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Maps a district id or display name ("Northwest Kodiak", "Mainland District", "nw") to a canonical id, or null.
export function normalizeDistrict(v) {
  if (!v) return null;
  const s = String(v).toLowerCase();
  if (DISTRICT_IDS.includes(s)) return s;
  if (s.includes('mainland') || s.includes('katmai') || s.includes('igvak')) return 'mainland';
  if (s.includes('afognak') || s.includes('shuyak')) return 'afognak';
  if (s.includes('alitak')) return 'alitak';
  if (s.includes('northwest') || s === 'nw') return 'northwest';
  if (s.includes('southwest') || s === 'sw') return 'southwest';
  if (s.includes('northeast') || s === 'ne') return 'northeast';
  if (s.includes('eastside') || s.includes('east side') || s === 'east') return 'eastside';
  return s;
}

export function districtName(id) {
  return DISTRICT_NAMES[id] ?? (id ? `${String(id).replace(/(^|[-_ ])(\w)/g, (m, a, b) => (a ? ' ' : '') + b.toUpperCase())} District` : 'Kodiak Management Area');
}

export function fishingDays(config) {
  return config.season.fishingDays;
}

export function isFishingDay(config, day) {
  return config.season.fishingDays.includes(day);
}

// The period on `day`, or null. { day, closed: [districtId] }
export function periodOn(config, day) {
  if (!isFishingDay(config, day)) return null;
  return { day, closed: PERIOD_CLOSURES[day] ?? [] };
}

export function districtOpenOn(config, day, districtId) {
  const p = periodOn(config, day);
  if (!p) return false;
  const id = normalizeDistrict(districtId);
  return !id || !p.closed.includes(id);
}

// True while a period is open at (day, hours) in the district (any district when districtId is null).
export function isOpenAt(config, day, hours, districtId = null) {
  const t = config.time;
  if (hours < t.openerStart || hours >= t.openerEnd) return false;
  return districtId ? districtOpenOn(config, day, districtId) : isFishingDay(config, day);
}

// Next period start strictly after (day, hours) — a period that is already open does not count — optionally for one
// district. → { day, hours, districts: 'all' | [ids open], closed: [ids] } or null after the season.
export function nextOpenerAfter(config, day, hours, districtId = null) {
  const start = config.time.openerStart;
  const id = normalizeDistrict(districtId);
  for (const d of config.season.fishingDays) {
    if (d < day || (d === day && hours >= start)) continue;
    const closed = PERIOD_CLOSURES[d] ?? [];
    if (id && closed.includes(id)) continue;
    const districts = closed.length ? DISTRICT_IDS.filter((x) => !closed.includes(x)) : 'all';
    return { day: d, hours: start, districts, closed: [...closed] };
  }
  return null;
}

// Hours from (day, hours) to (toDay, toHours); may be negative.
export function hoursBetween(day, hours, toDay, toHours) {
  return toDay * 24 + toHours - (day * 24 + hours);
}

// Relative run strength 0..1 for a run [start, peakStart, peakEnd, end] (day indices). Fish show early at 35% of
// peak, build linearly to the peak plateau and tail off to nothing at the end.
export function runStrength(run, day) {
  if (!run) return 0;
  const [a, b, c, d] = run;
  if (day < a || day > d) return 0;
  if (day >= b && day <= c) return 1;
  if (day < b) return 0.35 + 0.65 * ((day - a) / Math.max(1e-6, b - a));
  return Math.max(0, (d - day) / Math.max(1e-6, d - c));
}

// Calendar label for a day index: { month, date, label: 'Jul 8', long: 'Tuesday, July 8', weekday, weekdayShort }.
export function dateOf(config, dayIndex) {
  const s = config.time.seasonStart;
  const dt = new Date(Date.UTC(SEASON_YEAR, s.month - 1, s.day + dayIndex));
  const m = dt.getUTCMonth();
  const date = dt.getUTCDate();
  const wd = WEEKDAYS[dt.getUTCDay()];
  return {
    month: m + 1,
    date,
    label: `${MONTHS_SHORT[m]} ${date}`,
    long: `${wd}, ${MONTHS_LONG[m]} ${date}`,
    weekday: wd,
    weekdayShort: wd.slice(0, 3),
  };
}

// "6 a.m." / "10 p.m." / "5:30 a.m." as radio announcers say it.
export function spokenTime(hours) {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  const h12 = ((h + 11) % 12) + 1;
  const ap = h < 12 || h === 24 ? 'a.m.' : 'p.m.';
  if (h === 12 && m === 0) return 'noon';
  return m ? `${h12}:${String(m).padStart(2, '0')} ${ap}` : `${h12} ${ap}`;
}

// "5:00 AM" for UI captions.
export function clockLabel(hours) {
  const h = Math.floor(hours) % 24;
  const m = Math.floor((hours - Math.floor(hours)) * 60 + 1e-6);
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
