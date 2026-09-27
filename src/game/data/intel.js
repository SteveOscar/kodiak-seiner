// Discovery rules: token bonuses by place kind, chart intel notes (run-timing cards and hot spots) and wildlife
// kinds for the logbook. Pure module.

import { hashString } from '../../core/rng.js';

export const NICK = { pink: 'humpies', chum: 'dogs', sockeye: 'reds', coho: 'silvers', king: 'kings' };
export const SPECIES_LABEL = { pink: 'Pink', chum: 'Chum', sockeye: 'Sockeye', coho: 'Coho', king: 'King' };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// $25–$100 token for a first visit; memorials none.
export function discoveryBonus(place) {
  if (!place || place.memorial) return 0;
  switch (place.kind) {
    case 'peak':
    case 'viewpoint':
      return 100;
    case 'history':
    case 'wildlife':
      return 75;
    case 'town':
    case 'village':
    case 'harbor':
    case 'cannery':
    case 'hatchery':
    case 'lighthouse':
    case 'river':
    case 'lake':
    case 'landmark':
      return 50;
    case 'island':
    case 'strait':
      return 40;
    default:
      return 25;
  }
}

export const INTEL_KINDS = new Set(['cape', 'bay', 'strait', 'river', 'hatchery']);

// Every place kind that yields chart intel.
export function yieldsIntel(place) {
  return !!place && !place.memorial && INTEL_KINDS.has(place.kind);
}

function pick(key, arr) {
  return arr[hashString(key) % arr.length];
}

// Species that matter near a place, most important first: today's mix share, plus a boost for species running up
// the nearby streams. Kings never count.
export function notableSpecies(mix, streamSpecies = []) {
  const score = {};
  for (const s of ['pink', 'chum', 'sockeye', 'coho']) {
    let v = mix?.[s] ?? 0;
    if (streamSpecies.includes(s)) v += 0.2;
    score[s] = v;
  }
  const ranked = Object.entries(score)
    .filter(([, v]) => v > 0.08)
    .sort((a, b) => b[1] - a[1])
    .map(([s]) => s);
  return ranked.length ? ranked : ['pink'];
}

// Run-timing text for a list of species: "Reds peak Jul 6–21, done by Aug 20 · Humpies peak Jul 26–Aug 10".
export function runTimingText(species, runs, dateOf) {
  const parts = [];
  for (const s of species) {
    const r = runs[s];
    if (!r) continue;
    const a = dateOf(r[1]);
    const b = dateOf(r[2]);
    const end = dateOf(r[3]);
    const peak = a.label.split(' ')[0] === b.label.split(' ')[0] ? `${a.label}–${b.label.split(' ')[1]}` : `${a.label}–${b.label}`;
    parts.push(`${cap(NICK[s])} peak ${peak}, done by ${end.label}`);
  }
  return parts.join(' · ');
}

// Hot-spot note text for a cape, bay, strait or stream. Behaviour follows the species: dogs fin, humpies pop.
export function hotspotText(kind, name, species, key = name) {
  const sp = NICK[species[0]] ?? 'humpies';
  const sp2 = NICK[species[1]] ?? sp;
  const chum = species.includes('chum');
  switch (kind) {
    case 'cape':
      return pick(key, [
        `${cap(sp)} stack up off ${name} on the flood.`,
        `Hook off the point at ${name}: ${sp} round it tight to the beach on the flood.`,
        `${cap(sp)} hold in the eddy behind ${name} around slack water.`,
        `Watch the tide rip off ${name} early on the ebb — ${sp} showing along the edge.`,
      ]);
    case 'bay':
      return pick(key, [
        `${cap(sp)} mill at the head of ${name} on the high water.`,
        chum ? `Dogs finning along the beaches of ${name} — look for V-wakes at slack.` : `${cap(sp)} mill off the creek mouths in ${name} at slack water.`,
        `${cap(sp)} run the shoreline into ${name} on the flood; hook off the points going in.`,
        `Jumpers show at the mouth of ${name} at first light — ${sp} mostly, a few ${sp2}.`,
      ]);
    case 'strait':
      return pick(key, [
        `${cap(sp)} travel ${name} with the flood — set on the edges, out of the main current.`,
        `The tide runs hard through ${name}; ${sp} bunch up in the back-eddies at slack.`,
      ]);
    case 'hatchery':
      return pick(key, [
        `Hatchery ${sp} and ${sp2} crowd the terminal area off ${name} late in the run.`,
        `${cap(sp)} returning to ${name} mill off the bay mouth before they go in.`,
      ]);
    case 'river':
    case 'stream':
    default:
      return pick(key, [
        `${cap(sp)} stack up outside the ${name} markers on the flood.`,
        `${cap(sp)} mill off the ${name} mouth before a rain freshet — fish the edge of the closed waters.`,
        `${cap(sp)} bound for the ${name} follow the beach in on the flood.`,
      ]);
  }
}

// Wildlife kinds counted in the logbook. `aliases` maps the kind strings other systems may emit.
export const WILDLIFE = [
  { kind: 'bear', name: 'Kodiak brown bear', aliases: ['bear', 'brownbear', 'brown-bear', 'kodiakbear', 'sow', 'cub'] },
  { kind: 'eagle', name: 'Bald eagle', aliases: ['eagle', 'baldeagle', 'bald-eagle'] },
  { kind: 'gull', name: 'Glaucous-winged gull', aliases: ['gull', 'gulls', 'seagull'] },
  { kind: 'puffin', name: 'Tufted puffin', aliases: ['puffin', 'tuftedpuffin', 'puffins'] },
  { kind: 'humpback', name: 'Humpback whale', aliases: ['humpback', 'whale', 'humpbackwhale', 'humpback-whale'] },
  { kind: 'orca', name: 'Orca', aliases: ['orca', 'killerwhale', 'killer-whale', 'orcas'] },
  { kind: 'otter', name: 'Sea otter', aliases: ['otter', 'seaotter', 'sea-otter', 'otters'] },
  { kind: 'sealion', name: 'Steller sea lion', aliases: ['sealion', 'sea-lion', 'stellersealion', 'steller', 'sealions'] },
  { kind: 'seal', name: 'Harbor seal', aliases: ['seal', 'harborseal', 'harbor-seal', 'seals'] },
  { kind: 'deer', name: 'Sitka black-tailed deer', aliases: ['deer', 'blacktail', 'sitkadeer'] },
  { kind: 'goat', name: 'Mountain goat', aliases: ['goat', 'mountaingoat', 'mountain-goat'] },
];

export function wildlifeKind(kind) {
  const k = String(kind ?? '').toLowerCase().replace(/[\s_]/g, '');
  for (const w of WILDLIFE) if (w.aliases.includes(k) || w.kind === k) return w;
  return k ? { kind: k, name: cap(String(kind)), aliases: [k] } : null;
}
