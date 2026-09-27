// Formatting helpers for the UI (pure, DOM-free, importable from Node tests).

export const SPECIES = ['pink', 'chum', 'sockeye', 'coho', 'king'];

// Display names, ADF&G species codes and the gauge colours used across the HUD, report and fish ticket.
export const SPECIES_INFO = {
  pink: { name: 'Pink', nick: 'humpy', code: 440, color: '#ef9fb0' },
  chum: { name: 'Chum', nick: 'dog', code: 450, color: '#c3ad6f' },
  sockeye: { name: 'Sockeye', nick: 'red', code: 420, color: '#e2574a' },
  coho: { name: 'Coho', nick: 'silver', code: 430, color: '#c8d4dc' },
  king: { name: 'King', nick: 'chinook', code: 410, color: '#8ea6c6' },
};

const MINUS = '−';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// The season is set in 2026 (July 6, 2026 is a Monday), matching the fish-ticket dates.
const SEASON_YEAR = 2026;

const finite = (x, d = 0) => (Number.isFinite(Number(x)) ? Number(x) : d);

export function int(x) {
  const n = Math.round(finite(x));
  return (n < 0 ? MINUS : '') + Math.abs(n).toLocaleString('en-US');
}

// "$1,234", "−$1,200", "$0.32" (cents), "+$50" (sign).
export function money(x, { cents = false, sign = false } = {}) {
  const v = finite(x);
  const a = Math.abs(v);
  const body = cents
    ? a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : Math.round(a).toLocaleString('en-US');
  const neg = v < 0 && (cents ? a >= 0.005 : Math.round(a) > 0);
  return `${neg ? MINUS : sign && v > 0 ? '+' : ''}$${body}`;
}

// "$0.32/lb" style price.
export function price(x) {
  return `${money(x, { cents: true })}`;
}

// "$12.4k", "$1.2M", "$840".
export function compactMoney(x) {
  const v = finite(x);
  const a = Math.abs(v);
  const s = v < 0 ? MINUS : '';
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e4) return `${s}$${Math.round(a / 1e3)}k`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(1)}k`;
  return `${s}$${Math.round(a)}`;
}

export function pct(x) {
  return `${Math.round(Math.max(0, Math.min(1, finite(x))) * 100)}%`;
}

// "5:42 AM"
export function clockTime(hours) {
  let h = ((finite(hours) % 24) + 24) % 24;
  let hh = Math.floor(h);
  let m = Math.floor((h - hh) * 60 + 1e-6);
  if (m >= 60) {
    m = 0;
    hh = (hh + 1) % 24;
  }
  const h12 = ((hh + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
}

// Calendar for a season day index. seasonStart = { month (1-12), day }.
export function calendar(dayIndex, seasonStart = { month: 7, day: 6 }) {
  const d = new Date(Date.UTC(SEASON_YEAR, seasonStart.month - 1, seasonStart.day + Math.floor(finite(dayIndex))));
  const m = d.getUTCMonth();
  const wd = WEEKDAYS[d.getUTCDay()];
  return {
    month: m + 1,
    date: d.getUTCDate(),
    label: `${MONTHS[m]} ${d.getUTCDate()}`,
    long: `${wd}, ${MONTHS_LONG[m]} ${d.getUTCDate()}`,
    weekday: wd,
    weekdayShort: wd.slice(0, 3),
    year: SEASON_YEAR,
  };
}

// "1 h 20 min", "45 min", "3 h".
export function duration(hours) {
  const total = Math.max(0, Math.round(finite(hours) * 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h <= 0) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

// "1h 20m" compact form for the HUD.
export function shortDuration(hours) {
  const total = Math.max(0, Math.round(finite(hours) * 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h <= 0) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// "1:05" from seconds.
export function mmss(seconds) {
  const s = Math.max(0, Math.floor(finite(seconds)));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const TAU = Math.PI * 2;

// Game heading (radians, 0 = north, clockwise) -> integer degrees 0..359.
export function headingDeg(h) {
  const d = Math.round((((finite(h) % TAU) + TAU) % TAU) * (180 / Math.PI));
  return d % 360;
}

const POINTS16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const POINTS8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export function cardinal(deg, points = 8) {
  const d = ((finite(deg) % 360) + 360) % 360;
  if (points === 16) return POINTS16[Math.round(d / 22.5) % 16];
  return POINTS8[Math.round(d / 45) % 8];
}

// Heading (radians, 0 = north, clockwise) from one world point to another. +x = east, -z = north.
export function bearing(fromX, fromZ, toX, toZ) {
  return Math.atan2(toX - fromX, -(toZ - fromZ));
}

// Signed smallest difference a - b in degrees, in (-180, 180].
export function deltaDeg(a, b) {
  let d = (((finite(a) - finite(b)) % 360) + 540) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

// Nautical miles label from a game distance; geo.toNauticalMiles when available.
export function nmLabel(metres, geo) {
  const nm = geo?.toNauticalMiles ? geo.toNauticalMiles(metres) : finite(metres) / 1852;
  if (nm < 0.1) return `${Math.max(0, Math.round(finite(metres)))} m`;
  return `${nm < 10 ? nm.toFixed(1) : Math.round(nm)} nm`;
}

export const FATHOM = 1.8288;
export const fathoms = (m) => Math.round(finite(m) / FATHOM);

// Degrees + decimal minutes: 57°47.2′N
export function latLonLabel(lat, lon) {
  const f = (v, pos, neg) => {
    const a = Math.abs(finite(v));
    const d = Math.floor(a);
    const m = (a - d) * 60;
    return `${d}°${m.toFixed(1).padStart(4, '0')}′${v >= 0 ? pos : neg}`;
  };
  return `${f(lat, 'N', 'S')}  ${f(lon, 'E', 'W')}`;
}

export function plural(n, word, many = `${word}s`) {
  return `${int(n)} ${Math.round(Math.abs(finite(n))) === 1 ? word : many}`;
}

export function capitalize(s) {
  const t = String(s ?? '');
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

export function speciesName(k, { nick = false } = {}) {
  const i = SPECIES_INFO[k];
  if (!i) return capitalize(k);
  return nick ? `${i.name} (${i.nick})` : i.name;
}
