// Weather presets and smooth transitions. Pure logic (no THREE/DOM).
//
// The public `weather` object (sky.weather) is mutated in place every frame so consumers can hold a reference:
//   { preset, cloudCover 0..1, fog 0..1, rain 0..1, windDir (heading the wind blows TOWARD, radians, 0 = north,
//     clockwise), windSpeed m/s, swell (significant swell height, metres), visibility (m, at sea level),
//     cloudBase (m, game height of the low cloud deck), mist 0..1 (low cloud / mist-bank abundance),
//     darkness 0..1 (storm gloom), transition 0..1 (1 = settled) }
//
// Kodiak summer weather: prevailing south-westerlies (blowing toward the NE); gales come up from the south-east
// ahead of Gulf of Alaska lows (blowing toward the NW).

const DEG = Math.PI / 180;

export const PRESETS = {
  clear: { cloudCover: 0.12, fog: 0, rain: 0, windDir: 50 * DEG, windSpeed: 4, swell: 0.35, visibility: 21000, cloudBase: 330, mist: 0.12, darkness: 0 },
  partly: { cloudCover: 0.42, fog: 0, rain: 0, windDir: 45 * DEG, windSpeed: 6, swell: 0.55, visibility: 16000, cloudBase: 300, mist: 0.35, darkness: 0 },
  overcast: { cloudCover: 0.93, fog: 0.12, rain: 0, windDir: 30 * DEG, windSpeed: 7, swell: 0.8, visibility: 9000, cloudBase: 114, mist: 0.8, darkness: 0.1 },
  fog: { cloudCover: 0.75, fog: 1, rain: 0, windDir: 60 * DEG, windSpeed: 2.5, swell: 0.4, visibility: 600, cloudBase: 150, mist: 1, darkness: 0.05 },
  rain: { cloudCover: 1, fog: 0.35, rain: 0.45, windDir: 20 * DEG, windSpeed: 9, swell: 1.1, visibility: 5500, cloudBase: 108, mist: 0.9, darkness: 0.3 },
  storm: { cloudCover: 1, fog: 0.5, rain: 1, windDir: 315 * DEG, windSpeed: 17, swell: 2.4, visibility: 2600, cloudBase: 92, mist: 1, darkness: 0.62 },
};

export const PRESET_NAMES = Object.keys(PRESETS);
const NUMERIC = ['cloudCover', 'fog', 'rain', 'windSpeed', 'swell', 'cloudBase', 'mist', 'darkness'];

const smooth = (t) => t * t * (3 - 2 * t);
const wrapAngle = (a) => ((((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;

// Smooth 1D value noise in [-1, 1] (deterministic), for gusts and wind veer.
export function noise1(x, seed = 0) {
  const i = Math.floor(x);
  const f = x - i;
  const h = (n) => {
    const s = Math.sin((n + seed * 57.13) * 127.1) * 43758.5453;
    return (s - Math.floor(s)) * 2 - 1;
  };
  return h(i) + (h(i + 1) - h(i)) * smooth(f);
}

export function createWeather(initial = 'partly') {
  const start = PRESETS[initial] ? initial : 'partly';
  const base = { ...PRESETS[start] };
  const from = { ...base };
  const to = { ...base };
  let t = 1;
  let duration = 0;
  let lastNow = 0;

  const weather = {
    preset: start,
    ...base,
    windDir: base.windDir,
    visibility: base.visibility,
    transition: 1,
  };

  // Visibility interpolates in log space (600 m → 60 km must not linger near the thick end).
  // Clouds build before the rain starts and the rain stops before the clouds break.
  const LEADS = new Set(['cloudCover', 'mist']);
  const LAGS = new Set(['rain', 'darkness']);
  function blend(k) {
    const early = 1 - (1 - k) * (1 - k);
    const late = k * k;
    for (const key of NUMERIC) {
      const rising = to[key] > from[key];
      let kk = k;
      if (LEADS.has(key)) kk = rising ? early : late;
      else if (LAGS.has(key)) kk = rising ? late : early;
      base[key] = from[key] + (to[key] - from[key]) * kk;
    }
    base.windDir = from.windDir + wrapAngle(to.windDir - from.windDir) * k;
    base.visibility = Math.exp(Math.log(from.visibility) + (Math.log(to.visibility) - Math.log(from.visibility)) * k);
  }

  const api = {
    weather,
    // Starts a transition; returns false for unknown presets. seconds <= 0 applies instantly.
    set(preset, seconds = 20) {
      if (!PRESETS[preset]) return false;
      Object.assign(from, base);
      Object.assign(to, PRESETS[preset]);
      weather.preset = preset;
      duration = Math.max(0, seconds);
      t = duration > 0 ? 0 : 1;
      if (t >= 1) {
        blend(1);
        api.update(0, lastNow);
      }
      return true;
    },
    get transitioning() {
      return t < 1;
    },
    // Advances the transition by dt seconds and applies slow natural variation (gusts, veer) at time `now` (s).
    update(dt, now = 0) {
      lastNow = now;
      if (t < 1) {
        t = Math.min(1, t + dt / Math.max(1e-3, duration));
        blend(smooth(t));
      }
      for (const key of NUMERIC) weather[key] = base[key];
      weather.visibility = base.visibility;
      const gust = 1 + 0.18 * noise1(now / 9, 1) + 0.07 * noise1(now / 2.3, 2);
      weather.windSpeed = Math.max(0, base.windSpeed * gust);
      weather.windDir = wrapAngle(base.windDir + 9 * DEG * noise1(now / 60, 3));
      if (weather.windDir < 0) weather.windDir += 2 * Math.PI;
      weather.transition = t;
      return weather;
    },
  };
  api.update(0, 0);
  return api;
}

// Sea-level fog density (1/m) for the sky's fog chunks: Koschmieder with a 2% contrast threshold.
export function fogDensityForVisibility(visibility) {
  return 3.912 / Math.max(50, visibility);
}
