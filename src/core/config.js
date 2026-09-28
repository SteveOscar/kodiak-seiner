// Global tunables. Systems read from here rather than hard-coding numbers that other systems depend on.
// Units: metres, seconds, radians. +x = east, -z = north, +y = up. Sea level is y = 0.

export const config = {
  world: {
    half: 8000, // world spans x,z in [-half, half]; matches public/terrain/kodiak_meta.json worldHalf
    vertScale: 0.2, // game metres per real metre above sea level (horizontal scale is ~1:11.75)
    depthScale: 0.4, // game metres per real metre below sea level
    shelfBase: 0.4, // seabed depth at the waterline (m); see heightmap.js
    shelfSlope: 0.1, // extra seabed depth per metre offshore, capping the source bathymetry near the coast
    minOpenDepth: 8, // open water away from the shelf is at least this deep (the source under-reads enclosed bays)
    outsideDepth: -60, // seabed height beyond the heightmap
    boundary: 7850, // soft boundary for boats and players (|x| or |z| beyond this is pushed back); 7850 keeps
    // the passage round Cape Alitak into Alitak Bay
  },

  time: {
    minutesPerSecond: 1, // game minutes per real second while playing
    startDay: 0, // day index; day 0 = config.time.seasonStart
    seasonStart: { month: 7, day: 6 }, // July 6: the Kodiak general, pink-focused opening
    startHours: 5.5,
    openerStart: 6, // on a fishing day the period opens (hours)
    openerEnd: 22, // and closes
    timezoneOffset: -8, // AKDT, for sun position
    latitude: 57.65,
    longitude: -153.4,
  },

  // ADF&G fishing periods (game abstraction). Waters are closed on other days; explore or wait at anchor/harbor.
  season: {
    fishingDays: [0, 2, 5, 9, 13, 17, 21, 25, 29, 34, 40, 47], // day indices (day 0 = Jul 6)
    closedRadius: [150, 350], // game metres around stream mouths
  },

  // New-game spawn: nearest open water (>= minShore m offshore) to the City of Kodiak.
  spawn: { lat: 57.79, lon: -152.407, minShore: 60, heading: Math.PI * 0.75 },

  boat: {
    length: 17.7, // 58-foot limit seiner
    maxSpeed: 12, // m/s at full throttle (base engine)
    reverseSpeed: 3,
    turnRate: 0.45, // rad/s at speed
    groundingDepth: 2.2, // seabed shallower than this stops the seiner
  },

  net: {
    length: 380, // corkline length in metres (base seine, ~208 fathoms)
    maxLength: 457, // legal cap: 250 fathoms (5 AAC 18.332)
    depth: 16, // web depth in metres (base seine); where the seabed is shallower the leadline rests on the bottom
    maxDepth: 22, // ~325 meshes hung
    closeDistance: 22, // seiner must come within this of the skiff end to close up
    // Target real-time phase durations (seconds) for a typical set.
    phases: { layout: [45, 60], hold: [0, 90], close: [8, 12], purse: [15, 25], haul: [25, 35], brailPerLoadS: 1, brailLoadLbs: 1500, brailMaxS: 15 },
  },

  fish: {
    // Real-world averages. Price is the base ex-vessel price in dollars per pound.
    // count: school size range; radius m; depth m below surface; speed m/s; jumpsPerMin per school;
    // capture: fraction captured by a clean set; leadlineEscape: multiplier on escapes under the leadline.
    species: {
      pink: { label: 'Pink (humpy)', code: 440, lbs: 3.6, price: 0.32, count: [1500, 15000], median: 5000, radius: [10, 30], depth: [1, 4], speed: { migrating: 0.9, milling: 0.3 }, jumpsPerMin: [10, 30], capture: [0.6, 0.85], leadlineEscape: 1 },
      chum: { label: 'Chum (dog)', code: 450, lbs: 8.5, price: 0.55, count: [300, 3000], median: 900, radius: [8, 20], depth: [2, 6], speed: { migrating: 0.8, milling: 0.3 }, jumpsPerMin: [2, 6], capture: [0.6, 0.85], leadlineEscape: 1.3, finning: true, soundsAfterSpooks: 2 },
      sockeye: { label: 'Sockeye (red)', code: 420, lbs: 6.0, price: 1.15, count: [200, 2500], median: 700, radius: [8, 20], depth: [3, 10], speed: { migrating: 1.2, milling: 0.5 }, jumpsPerMin: [2, 5], capture: [0.4, 0.7], leadlineEscape: 2 },
      coho: { label: 'Coho (silver)', code: 430, lbs: 7.5, price: 0.95, count: [100, 1200], median: 400, radius: [6, 15], depth: [1, 5], speed: { migrating: 1.0, milling: 0.4 }, jumpsPerMin: [4, 10], capture: [0.4, 0.7], leadlineEscape: 1.5 },
      // Kings (≥ 28 in) must be released by Kodiak seiners: bycatch only, never sold.
      king: { label: 'King (chinook)', code: 410, lbs: 18, price: 0, count: [0, 3], bycatchChance: 0.15, release: true },
    },
    // Run timing on the game calendar (day 0 = Jul 6): [start, peak start, peak end, end].
    runs: {
      sockeye: [0, 0, 15, 45],
      pink: [0, 20, 35, 50],
      chum: [0, 5, 20, 35],
      coho: [35, 45, 60, 75],
    },
  },

  economy: {
    startingCash: 2500,
    holdCapacityLbs: 60000,
    crewShare: 0.3, // skiffman + 2 deckhands at 10% each, paid on every delivery
    fuelCapacity: 3000, // gallons
    fuelPerHourAtFull: 38, // gallons per game hour: 38 * engineLoad^1.5 + idle
    fuelIdlePerHour: 1.5, // generator, RSW
    fuelPrice: 4.6, // dollars per gallon in town
    fuelPremiumAway: 0.4, // extra per gallon at villages, canneries and tenders
    towCost: 750, // tow to the nearest tender when out of fuel (plus a fill to 25%)
    advanceLimit: -10000, // cannery advance: cash may go this negative; repaid from fish tickets
    goals: [
      { gross: 10000, label: 'Covered the grub and fuel bill' },
      { gross: 40000, label: 'Permit loan paid off' },
      { gross: 75000, label: 'Made the boat payment' },
    ],
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
