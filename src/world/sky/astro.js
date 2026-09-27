// Sun and moon positions for the Kodiak archipelago. Pure maths: no THREE, no DOM (unit-tested under Node).
//
// Sun: NOAA solar position algorithm (the NOAA Solar Calculator spreadsheet equations, ~0.01° accuracy).
// Moon: truncated ELP/Meeus series (six largest longitude terms, four latitude terms; ~0.3°), enough for rise/set
// times, phase and the terminator direction.
//
// Game frame: +x east, +y up, -z north. Directions are unit arrays [x, y, z].
//
// Clock shift: at 153.4°W on UTC-8 the real sun reaches its highest point at ~14:18 AKDT in early July, so a literal
// clock puts Jul 6 sunrise at 05:23 and sunset at 23:12. The game's day is designed around sunrise ~05:10 / sunset
// ~22:35 (SPEC §6.1, the 06:00-22:00 opener, golden hour at 20:30, twilight at 22:45). SOLAR_CLOCK_SHIFT_HOURS maps a
// game clock reading to the real AKDT instant it represents; every other quantity (latitude, declination, day
// length, twilight depth, moon) is real. Set it to 0 for the literal clock.

export const KODIAK = { lat: 57.65, lon: -153.4, tz: -8 };
export const SEASON_YEAR = 2026;
export const SOLAR_CLOCK_SHIFT_HOURS = 0.425;

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const mod = (a, n) => ((a % n) + n) % n;

// Julian day at 0h UT of the given Gregorian date.
export function julianDay0(year, month, day) {
  let y = year;
  let m = month;
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  const a = Math.floor(y / 100);
  const b = 2 - a + Math.floor(a / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + day + b - 1524.5;
}

// Julian day for a local clock reading on a 1-based day of year (non-leap calendar, like core/clock.js).
export function julianDayLocal(dayOfYear, localHours, { year = SEASON_YEAR, tz = KODIAK.tz, shift = SOLAR_CLOCK_SHIFT_HOURS } = {}) {
  return julianDay0(year, 1, 1) + (dayOfYear - 1) + (localHours + shift - tz) / 24;
}

// Local horizontal direction (game frame) from azimuth (radians from north, clockwise) and elevation (radians).
export function dirFromAzEl(az, el, out = [0, 0, 0]) {
  const c = Math.cos(el);
  out[0] = Math.sin(az) * c;
  out[1] = Math.sin(el);
  out[2] = -Math.cos(az) * c;
  return out;
}

// NOAA solar position. Returns { dir, elevation (deg, geometric), apparentElevation (deg, refracted), azimuth (deg),
// declination (deg), eqTime (min), hourAngle (deg), apparentLongitude (deg), ra (deg) }.
export function sunPosition(jd, lat = KODIAK.lat, lon = KODIAK.lon) {
  const T = (jd - 2451545) / 36525;
  const L0 = mod(280.46646 + T * (36000.76983 + T * 0.0003032), 360);
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C =
    Math.sin(M * RAD) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * M * RAD) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(appLong * RAD)) * DEG;
  const ra = mod(Math.atan2(Math.cos(eps * RAD) * Math.sin(appLong * RAD), Math.cos(appLong * RAD)) * DEG, 360);
  const y = Math.tan((eps / 2) * RAD) ** 2;
  const eqTime =
    4 *
    DEG *
    (y * Math.sin(2 * L0 * RAD) -
      2 * e * Math.sin(M * RAD) +
      4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD) -
      0.5 * y * y * Math.sin(4 * L0 * RAD) -
      1.25 * e * e * Math.sin(2 * M * RAD));
  // True solar time from the UT fraction of the day.
  const utMinutes = mod((jd + 0.5 - Math.floor(jd + 0.5)) * 1440, 1440);
  const tst = mod(utMinutes + eqTime + 4 * lon, 1440);
  const ha = tst / 4 < 0 ? tst / 4 + 180 : tst / 4 - 180;
  const cosZen =
    Math.sin(lat * RAD) * Math.sin(decl * RAD) + Math.cos(lat * RAD) * Math.cos(decl * RAD) * Math.cos(ha * RAD);
  const zen = Math.acos(Math.max(-1, Math.min(1, cosZen))) * DEG;
  const elevation = 90 - zen;
  // Azimuth from north, clockwise.
  const azDen = Math.cos(lat * RAD) * Math.sin(zen * RAD);
  let azimuth;
  if (Math.abs(azDen) < 1e-9) azimuth = 180;
  else {
    const c = Math.max(-1, Math.min(1, (Math.sin(lat * RAD) * Math.cos(zen * RAD) - Math.sin(decl * RAD)) / azDen));
    const a = Math.acos(c) * DEG;
    azimuth = ha > 0 ? mod(a + 180, 360) : mod(540 - a, 360);
  }
  return {
    dir: dirFromAzEl(azimuth * RAD, elevation * RAD),
    elevation,
    apparentElevation: elevation + refraction(elevation),
    azimuth,
    declination: decl,
    eqTime,
    hourAngle: ha,
    apparentLongitude: appLong,
    ra,
  };
}

// Atmospheric refraction (degrees) for a geometric elevation (degrees), NOAA approximation.
export function refraction(elev) {
  if (elev > 85) return 0;
  const te = Math.tan(elev * RAD);
  let r;
  if (elev > 5) r = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
  else if (elev > -0.575) r = 1735 + elev * (-518.2 + elev * (103.4 + elev * (-12.79 + elev * 0.711)));
  else r = -20.772 / te;
  return r / 3600;
}

// Greenwich mean sidereal time (degrees) for a Julian day.
export function gmst(jd) {
  const d = jd - 2451545;
  const T = d / 36525;
  return mod(280.46061837 + 360.98564736629 * d + T * T * (0.000387933 - T / 38710000), 360);
}

// Rotation (row-major 3x3, 9 numbers) taking equatorial unit vectors (x to RA 0h, z to the celestial north pole)
// into the local game frame, for local sidereal time lstDeg at latitude latDeg. Its transpose maps game directions
// back to the equatorial frame (used to rotate the star field).
export function equatorialToLocal(lstDeg, latDeg = KODIAK.lat, out = new Array(9)) {
  const t = lstDeg * RAD;
  const p = latDeg * RAD;
  const st = Math.sin(t);
  const ct = Math.cos(t);
  const sp = Math.sin(p);
  const cp = Math.cos(p);
  out[0] = -st; out[1] = ct; out[2] = 0;
  out[3] = cp * ct; out[4] = cp * st; out[5] = sp;
  out[6] = sp * ct; out[7] = sp * st; out[8] = -cp;
  return out;
}

export function applyMat3(m, v, out = [0, 0, 0]) {
  const x = v[0];
  const y = v[1];
  const z = v[2];
  out[0] = m[0] * x + m[1] * y + m[2] * z;
  out[1] = m[3] * x + m[4] * y + m[5] * z;
  out[2] = m[6] * x + m[7] * y + m[8] * z;
  return out;
}

// Moon position. Returns { dir, elevation (deg), azimuth (deg), ra, dec (deg), eclipticLongitude (deg),
// distanceKm, phase (0 new → 0.5 full → 1), illumination (0..1 lit fraction) }.
export function moonPosition(jd, lat = KODIAK.lat, lon = KODIAK.lon, sunApparentLongitude = null) {
  const d = jd - 2451545;
  const Lp = mod(218.3164477 + 13.17639648 * d, 360);
  const D = mod(297.8501921 + 12.19074912 * d, 360);
  const M = mod(357.5291092 + 0.98560028 * d, 360);
  const Mp = mod(134.9633964 + 13.06499295 * d, 360);
  const F = mod(93.272095 + 13.22935024 * d, 360);
  const s = (x) => Math.sin(x * RAD);
  const lambda =
    Lp +
    6.289 * s(Mp) +
    1.274 * s(2 * D - Mp) +
    0.658 * s(2 * D) +
    0.214 * s(2 * Mp) -
    0.186 * s(M) -
    0.114 * s(2 * F);
  const beta = 5.128 * s(F) + 0.2806 * s(Mp + F) + 0.2777 * s(Mp - F) + 0.1732 * s(2 * D - F);
  const distanceKm = 385001 - 20905 * Math.cos(Mp * RAD);
  const eps = (23.439291 - 0.0000004 * d) * RAD;
  const l = lambda * RAD;
  const b = beta * RAD;
  const ra = mod(Math.atan2(Math.sin(l) * Math.cos(eps) - Math.tan(b) * Math.sin(eps), Math.cos(l)) * DEG, 360);
  const dec = Math.asin(Math.sin(b) * Math.cos(eps) + Math.cos(b) * Math.sin(eps) * Math.sin(l)) * DEG;
  const lst = gmst(jd) + lon;
  const H = (lst - ra) * RAD;
  const p = lat * RAD;
  const dr = dec * RAD;
  const north = Math.cos(p) * Math.sin(dr) - Math.sin(p) * Math.cos(dr) * Math.cos(H);
  const east = -Math.cos(dr) * Math.sin(H);
  const up = Math.sin(p) * Math.sin(dr) + Math.cos(p) * Math.cos(dr) * Math.cos(H);
  const len = Math.hypot(north, east, up);
  const dir = [east / len, up / len, -north / len];
  const elevation = Math.asin(dir[1]) * DEG;
  const azimuth = mod(Math.atan2(east, north) * DEG, 360);
  const sunLong = sunApparentLongitude ?? sunPosition(jd, lat, lon).apparentLongitude;
  const elong = mod(lambda - sunLong, 360);
  const cosPsi = Math.cos(b) * Math.cos((lambda - sunLong) * RAD);
  return {
    dir,
    elevation,
    azimuth,
    ra,
    dec,
    eclipticLongitude: mod(lambda, 360),
    distanceKm,
    phase: elong / 360,
    illumination: (1 - cosPsi) / 2,
  };
}

// Everything the sky needs for one instant of game time.
export function skyAstronomy(dayOfYear, localHours, opts = {}) {
  const lat = opts.lat ?? KODIAK.lat;
  const lon = opts.lon ?? KODIAK.lon;
  const jd = julianDayLocal(dayOfYear, localHours, opts);
  const sun = sunPosition(jd, lat, lon);
  const moon = moonPosition(jd, lat, lon, sun.apparentLongitude);
  const lst = gmst(jd) + lon;
  return { jd, sun, moon, lst, starRotation: equatorialToLocal(lst, lat) };
}

// Finds when the sun's centre crosses `altitudeDeg` (default: standard sunrise/sunset, -0.833° = refraction +
// semidiameter) on a day. Returns { sunrise, sunset, noon, noonElevation, minElevation } in game-clock hours
// (null when the sun never crosses).
export function sunTimes(dayOfYear, { altitudeDeg = -0.833, ...opts } = {}) {
  const elevAt = (h) => sunPosition(julianDayLocal(dayOfYear, h, opts), opts.lat, opts.lon).elevation;
  let sunrise = null;
  let sunset = null;
  let noon = 0;
  let noonElevation = -90;
  let minElevation = 90;
  const step = 1 / 60;
  let prev = elevAt(0);
  for (let h = step; h <= 24 + 1e-9; h += step) {
    const e = elevAt(h);
    if (e > noonElevation) {
      noonElevation = e;
      noon = h;
    }
    minElevation = Math.min(minElevation, e);
    if (prev < altitudeDeg && e >= altitudeDeg && sunrise === null) sunrise = refine(elevAt, h - step, h, altitudeDeg);
    if (prev >= altitudeDeg && e < altitudeDeg && sunset === null) sunset = refine(elevAt, h - step, h, altitudeDeg);
    prev = e;
  }
  return { sunrise, sunset, noon, noonElevation, minElevation };
}

function refine(f, a, b, target) {
  let lo = a;
  let hi = b;
  const rising = f(b) > f(a);
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    const above = f(mid) >= target;
    if (above === rising) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

// "5:07" style label for a fractional hour.
export function hhmm(h) {
  const t = Math.round(mod(h, 24) * 60);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}
