// Species mix of the salmon on the grounds at a place and date. Pure module; season.js feeds it stream distances,
// the district and how enclosed the water is.
//
// Kodiak patterns encoded here: pinks everywhere and strongest in the Northwest Kodiak and Eastside districts and
// near Kitoi Bay; sockeye strongest off the big sockeye systems (Karluk, Ayakulik, Upper Station, Frazer) and the
// enhanced Spiridon (Telrod Cove) and Kitoi returns; chum in the bays and at bay heads; coho late, at Kitoi, Afognak
// and in the bays. Kings are bycatch only (config.fish.species.king) and never part of the mix.

import { runStrength } from './calendar.js';

export const MIX_SPECIES = ['pink', 'chum', 'sockeye', 'coho'];

export const BASE_ABUNDANCE = { pink: 1.6, chum: 0.3, sockeye: 0.18, coho: 0.25 };

export const MAJOR_SOCKEYE = /karluk|ayakulik|red river|upper station|akalura|frazer|dog salmon|spiridon|telrod|kitoi/i;
export const LATE_COHO = /kitoi|afognak|buskin|pasagshak|malina|litnik|american|olds|saltery/i;

export const DISTRICT_MULT = {
  northwest: { pink: 1.35 },
  eastside: { pink: 1.35 },
  afognak: { pink: 1.15, coho: 1.4 },
  southwest: { sockeye: 1.5 },
  alitak: { sockeye: 1.4, pink: 1.1 },
  mainland: { chum: 1.5, pink: 1.1 },
  northeast: {},
};

// Hatchery release groups by hatchery name.
export function hatcherySpecies(name) {
  const s = String(name ?? '').toLowerCase();
  if (s.includes('kitoi')) return { pink: 3, chum: 1.5, coho: 2.5, sockeye: 5 };
  if (s.includes('pillar')) return { sockeye: 1.5, coho: 1.5, pink: 0.5 };
  return { pink: 1.5, chum: 1, coho: 1 };
}

const INFLUENCE_M = 1400; // game metres over which a stream's returning fish dominate the mix

// streams: [{ distance, species: [...], id, name }]; hatcheries: [{ distance, name }]; district: id; enclosure 0..1
export function speciesMixAt({ day, runs, streams = [], hatcheries = [], district = null, enclosure = 0 }) {
  const boost = { pink: 0, chum: 0, sockeye: 0, coho: 0 };
  for (const st of streams) {
    const w = Math.exp(-(st.distance ?? Infinity) / INFLUENCE_M);
    if (w < 0.01) continue;
    const key = `${st.id ?? ''} ${st.name ?? ''}`;
    for (const sp of st.species ?? []) if (sp in boost) boost[sp] += (sp === 'pink' ? 0.8 : 1.2) * w;
    if ((st.species ?? []).includes('sockeye') && MAJOR_SOCKEYE.test(key)) boost.sockeye += 6 * w;
    if ((st.species ?? []).includes('coho') && LATE_COHO.test(key)) boost.coho += 1.5 * w;
  }
  for (const h of hatcheries) {
    const w = Math.exp(-(h.distance ?? Infinity) / INFLUENCE_M);
    if (w < 0.01) continue;
    for (const [sp, v] of Object.entries(hatcherySpecies(h.name))) boost[sp] += v * w;
  }
  const dm = DISTRICT_MULT[district] ?? {};
  const e = Math.max(0, Math.min(1, enclosure));
  const encl = { pink: 1.1 - 0.25 * e, chum: 0.5 + 1.8 * e, sockeye: 1 - 0.15 * e, coho: 0.8 + 0.5 * e };
  const w = {};
  let sum = 0;
  for (const sp of MIX_SPECIES) {
    w[sp] = BASE_ABUNDANCE[sp] * runStrength(runs[sp], day) * (1 + boost[sp]) * (dm[sp] ?? 1) * encl[sp];
    sum += w[sp];
  }
  const out = { pink: 0, chum: 0, sockeye: 0, coho: 0, king: 0 };
  if (sum <= 0) {
    out.pink = 1;
    return out;
  }
  for (const sp of MIX_SPECIES) out[sp] = w[sp] / sum;
  return out;
}

// The species that leads the mix.
export function leadingSpecies(mix) {
  let best = 'pink';
  for (const sp of MIX_SPECIES) if ((mix[sp] ?? 0) > (mix[best] ?? 0)) best = sp;
  return best;
}
