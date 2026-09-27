// Global tunables. Systems read from here rather than hard-coding numbers that other systems depend on.
// Units: metres, seconds, radians. +x = east, -z = north, +y = up. Sea level is y = 0.

export const config = {
  world: {
    half: 8000, // world spans x,z in [-half, half]; matches public/terrain/kodiak_meta.json worldHalf
    vertScale: 0.2, // game metres per real metre above sea level (horizontal scale is ~1:11.75)
    depthScale: 0.4, // game metres per real metre below sea level
    shelfBase: 0.4, // seabed depth at the waterline (m); see heightmap.js
    shelfSlope: 0.1, // extra seabed depth per metre offshore, capping the source bathymetry near the coast
    outsideDepth: -60, // seabed height beyond the heightmap
    boundary: 7600, // soft boundary for boats and players (|x| or |z| beyond this is pushed back)
  },

  time: {
    minutesPerSecond: 1, // game minutes per real second while playing
    startDay: 0, // day index; day 0 = config.time.seasonStart
    seasonStart: { month: 6, day: 20 }, // June 20
    startHours: 5.5,
    openerStart: 6, // daily fishing period opens (hours)
    openerEnd: 22, // and closes
    timezoneOffset: -8, // AKDT, for sun position
    latitude: 57.65,
    longitude: -153.4,
  },

  // New-game spawn: nearest open water (>= minShore m offshore) to the City of Kodiak.
  spawn: { lat: 57.79, lon: -152.407, minShore: 60, heading: Math.PI * 0.75 },

  boat: {
    length: 17.7, // 58-foot limit seiner
    maxSpeed: 12, // m/s at full throttle (base engine)
    reverseSpeed: 3,
    turnRate: 0.45, // rad/s at speed
  },

  net: {
    length: 380, // corkline length in metres (base seine)
    depth: 16, // web depth in metres (base seine); shallower water than this means the leadline drags bottom
    closeDistance: 22, // seiner must come within this of the skiff to close up
  },

  fish: {
    // Real-world averages. Price is the base ex-vessel price in dollars per pound.
    species: {
      pink: { label: 'Pink (humpy)', lbs: 3.6, price: 0.32 },
      chum: { label: 'Chum (dog)', lbs: 8.5, price: 0.55 },
      sockeye: { label: 'Sockeye (red)', lbs: 6.0, price: 1.15 },
      coho: { label: 'Coho (silver)', lbs: 7.5, price: 0.95 },
      king: { label: 'King (chinook)', lbs: 18, price: 2.1 },
    },
  },

  economy: {
    startingCash: 2500,
    holdCapacityLbs: 60000,
    crewShare: 0.3, // 3 deckhands at 10% each, paid on every delivery
    fuelCapacity: 1200, // gallons
    fuelPerHourAtFull: 38, // gallons per game hour at full throttle
    fuelPrice: 4.6, // dollars per gallon
  },

  render: {
    fov: 55,
    near: 0.5,
    far: 40000,
    maxPixelRatio: 2,
  },
};

// Quality presets; systems read ctx.quality.* and must degrade gracefully on 'low'.
export const QUALITY = {
  ultra: { name: 'ultra', pixelRatio: 2, shadows: true, shadowMapSize: 4096, waterSegments: 1, vegetation: 1.3, postfx: true },
  high: { name: 'high', pixelRatio: 1.5, shadows: true, shadowMapSize: 4096, waterSegments: 1, vegetation: 1, postfx: true },
  medium: { name: 'medium', pixelRatio: 1.5, shadows: true, shadowMapSize: 2048, waterSegments: 0.75, vegetation: 0.6, postfx: true },
  low: { name: 'low', pixelRatio: 1, shadows: false, shadowMapSize: 1024, waterSegments: 0.5, vegetation: 0.3, postfx: false },
};
