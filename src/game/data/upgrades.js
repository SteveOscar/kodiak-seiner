// Upgrade catalog (bought at the Kodiak harbour) and the modifiers they produce. Pure module.
//
// Each item has tiers bought in order; `upgrades[id]` is the number of tiers owned. The spotter plane is a day
// charter (consumable) rather than a tier. Legal gear caps: 250 fathoms (457 m) of corkline, ~325 meshes (22 m) deep.

export const FATHOM = 1.8288;
export const fathoms = (m) => Math.round(m / FATHOM);
// Stretched mesh in the seine web: a 22 m deep seine hangs about 325 meshes.
export const meshes = (depthM) => Math.round((depthM / 22) * 325);

export const SPOTTER_ID = 'spotter';

export const UPGRADES = [
  {
    id: 'purseWinch',
    name: 'Hydraulic purse winch',
    category: 'deck',
    blurb: 'A bigger two-speed winch drum. Rings come up faster and steadier — fewer fish slip under the lead.',
    tiers: [{ price: 6000, label: 'Two-speed purse winch', effect: { purseRate: 1.35 } }],
  },
  {
    id: 'powerBlock',
    name: 'Power block',
    category: 'deck',
    blurb: 'A bigger block on the boom hauls the seine back aboard faster, so the bag dries up sooner.',
    tiers: [
      { price: 8500, label: '24-inch power block', effect: { haulRate: 1.3 } },
      { price: 14000, label: '28-inch block + triplex assist', effect: { haulRate: 1.55 } },
    ],
  },
  {
    id: 'engine',
    name: 'Main engine',
    category: 'boat',
    blurb: 'More horsepower to run between the grounds and the tenders.',
    tiers: [
      { price: 20000, label: 'Engine rebuild', effect: { maxSpeed: 1.1 } },
      { price: 25000, label: 'New 600 hp diesel', effect: { maxSpeed: 1.2 } },
    ],
  },
  {
    id: 'seineDepth',
    name: 'Deeper seine',
    category: 'gear',
    blurb: 'Hang more web so the leads fish deeper. Sockeye swim deep and dive under a shallow seine.',
    tiers: [
      { price: 7500, label: '280 meshes (19 m)', effect: { netDepth: 19 } },
      { price: 9000, label: '325 meshes (22 m) — legal max', effect: { netDepth: 22 } },
    ],
  },
  {
    id: 'seineLength',
    name: 'Longer seine',
    category: 'gear',
    blurb: 'Add shackles of corkline for a bigger circle — up to the legal 250 fathoms.',
    tiers: [
      { price: 8000, label: '225 fathoms (411 m)', effect: { netLength: 411 } },
      { price: 9500, label: '250 fathoms (457 m) — legal max', effect: { netLength: 457 } },
    ],
  },
  {
    id: 'sonar',
    name: 'Sonar',
    category: 'electronics',
    blurb: 'Searchlight sonar shows marks and depth under the boat — not species. Reach out further.',
    tiers: [
      { price: 4500, label: 'Sonar range 300 m', effect: { sonarRange: 300 } },
      { price: 8500, label: 'Sonar range 500 m', effect: { sonarRange: 500 } },
    ],
  },
  {
    id: 'rsw',
    name: 'RSW system',
    category: 'hold',
    blurb: 'Refrigerated sea water keeps the catch cold. Processors pay a premium for chilled fish.',
    tiers: [{ price: 12000, label: 'RSW chiller (+5¢/lb)', effect: { rswBonus: 0.05 } }],
  },
  {
    id: 'hold',
    name: 'Hold expansion',
    category: 'hold',
    blurb: 'Rebuild the fish hold and tanks to carry more between deliveries.',
    tiers: [{ price: 11000, label: '75,000 lb hold', effect: { holdLbs: 75000 } }],
  },
  {
    id: 'deckLights',
    name: 'LED deck floods',
    category: 'boat',
    blurb: 'Bright LED floods on the mast and house for working late sets into the dusk.',
    tiers: [{ price: 1500, label: 'LED floods', effect: { deckLightsLevel: 2 } }],
  },
];

export const SPOTTER = {
  id: SPOTTER_ID,
  name: 'Spotter plane charter',
  category: 'charter',
  blurb: 'A Super Cub flies the grounds for the day and radios the schools it sees onto your chart. Not allowed in the Mainland District.',
  price: 1200,
};

export function baseModifiers(config) {
  return {
    maxSpeed: config.boat.maxSpeed,
    netLength: config.net.length,
    netDepth: config.net.depth,
    purseRate: 1,
    haulRate: 1,
    sonarRange: 150,
    holdLbs: config.economy.holdCapacityLbs,
    rswBonus: 0,
    deckLights: true,
    deckLightsLevel: 1,
    spotterUntilDay: -1,
  };
}

// Modifiers for owned tiers, clamped to the legal gear caps. maxSpeed effects multiply the base speed.
export function computeModifiers(config, upgrades = {}, spotterUntilDay = -1) {
  const m = baseModifiers(config);
  for (const item of UPGRADES) {
    const owned = Math.max(0, Math.min(item.tiers.length, upgrades[item.id] ?? 0));
    for (let i = 0; i < owned; i++) {
      for (const [k, v] of Object.entries(item.tiers[i].effect)) {
        m[k] = k === 'maxSpeed' ? config.boat.maxSpeed * v : v;
      }
    }
  }
  m.netLength = Math.min(m.netLength, config.net.maxLength);
  m.netDepth = Math.min(m.netDepth, config.net.maxDepth);
  m.spotterUntilDay = spotterUntilDay;
  return m;
}

export function upgradeById(id) {
  return UPGRADES.find((u) => u.id === id) ?? null;
}

// Catalog rows for the harbour menu at the current state.
export function catalogRows(config, upgrades, { cash = 0, day = 0, spotterUntilDay = -1 } = {}) {
  const rows = UPGRADES.map((u) => {
    const level = Math.max(0, Math.min(u.tiers.length, upgrades[u.id] ?? 0));
    const next = u.tiers[level] ?? null;
    return {
      id: u.id,
      name: u.name,
      category: u.category,
      blurb: u.blurb,
      level,
      maxLevel: u.tiers.length,
      owned: level > 0,
      maxed: !next,
      current: level > 0 ? u.tiers[level - 1].label : baseLabel(u.id, config),
      next: next?.label ?? null,
      price: next?.price ?? null,
      affordable: !!next && cash >= next.price,
      tiers: u.tiers.map((t) => ({ label: t.label, price: t.price })),
    };
  });
  rows.push({
    id: SPOTTER.id,
    name: SPOTTER.name,
    category: SPOTTER.category,
    blurb: SPOTTER.blurb,
    level: spotterUntilDay >= day ? 1 : 0,
    maxLevel: 1,
    owned: spotterUntilDay >= day,
    maxed: spotterUntilDay >= day,
    consumable: true,
    current: spotterUntilDay >= day ? 'Chartered' : 'None',
    next: 'Charter for one fishing day',
    price: SPOTTER.price,
    affordable: cash >= SPOTTER.price,
    tiers: [{ label: 'One-day charter', price: SPOTTER.price }],
  });
  return rows;
}

function baseLabel(id, config) {
  switch (id) {
    case 'purseWinch':
      return 'Stock purse winch';
    case 'powerBlock':
      return '20-inch power block';
    case 'engine':
      return 'Tired 402 hp diesel';
    case 'seineDepth':
      return `${meshes(config.net.depth)} meshes (${config.net.depth} m)`;
    case 'seineLength':
      return `${fathoms(config.net.length)} fathoms (${config.net.length} m)`;
    case 'sonar':
      return 'Sonar range 150 m';
    case 'rsw':
      return 'Iced, no RSW';
    case 'hold':
      return `${config.economy.holdCapacityLbs.toLocaleString('en-US')} lb hold`;
    case 'deckLights':
      return 'Halogen floods';
    default:
      return 'Stock';
  }
}
