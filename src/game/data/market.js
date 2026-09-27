// Money rules: ex-vessel prices, fish tickets, crew share, fuel burn and fuel prices. Pure module.

import { hashString, mulberry32 } from '../../core/rng.js';

export const SPECIES = ['pink', 'chum', 'sockeye', 'coho', 'king'];
export const emptyCatch = () => ({ pink: 0, chum: 0, sockeye: 0, coho: 0, king: 0 });

export const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

// Deterministic uniform [0, 1) for a key: independent of call order, so any day/tender/species can be priced alone.
export function keyedRandom(seed, key) {
  return mulberry32((hashString(key) ^ Math.imul(seed >>> 0, 2654435761)) >>> 0)();
}

// Daily price factor within ±15%: a market move shared by every buyer (±10%) plus the tender's own spread (±5%).
export function dailyPriceFactor(seed, day, species, buyerId = null) {
  const market = (keyedRandom(seed, `market:${day}:${species}`) * 2 - 1) * 0.1;
  const buyer = buyerId ? (keyedRandom(seed, `buyer:${day}:${buyerId}:${species}`) * 2 - 1) * 0.05 : 0;
  return 1 + market + buyer;
}

// Ex-vessel price in $/lb, rounded to cents. Kings are released by Kodiak seiners and never bought.
export function priceFor({ seed, day, species, buyerId = null, basePrice, rswBonus = 0, release = false }) {
  if (release || species === 'king' || !basePrice) return 0;
  return round2(basePrice * dailyPriceFactor(seed, day, species, buyerId) + rswBonus);
}

export function lbsOf(counts, speciesTable) {
  let lbs = 0;
  for (const k of SPECIES) lbs += (counts?.[k] ?? 0) * (speciesTable[k]?.lbs ?? 0);
  return Math.round(lbs * 10) / 10;
}

// Adds a catch to the hold up to capacity, in species order. Kings (release) never go in the hold.
// → { hold (new), accepted, overflow, acceptedLbs }
export function fillHold(hold, counts, capacityLbs, speciesTable) {
  const next = { ...emptyCatch(), ...hold };
  const accepted = emptyCatch();
  const overflow = emptyCatch();
  let room = capacityLbs - lbsOf(next, speciesTable);
  for (const k of SPECIES) {
    const n = Math.max(0, Math.floor(counts?.[k] ?? 0));
    const sp = speciesTable[k];
    if (!n) continue;
    if (!sp || sp.release) {
      overflow[k] = n;
      continue;
    }
    const fit = Math.max(0, Math.min(n, Math.floor((room + 1e-6) / sp.lbs)));
    accepted[k] = fit;
    overflow[k] = n - fit;
    room -= fit * sp.lbs;
    next[k] += fit;
  }
  return { hold: next, accepted, overflow, acceptedLbs: lbsOf(accepted, speciesTable) };
}

// Fish ticket lines, gross, crew share and net for a hold. priceOf(species) → $/lb.
// → { lines: [{species, code, count, lbs, price, value}], gross, crewShare, net, totalLbs, crew: [{role, share}] }
export function buildTicket(hold, speciesTable, priceOf, crewShare) {
  const lines = [];
  for (const k of SPECIES) {
    const count = hold?.[k] ?? 0;
    const sp = speciesTable[k];
    if (!count || !sp || sp.release) continue;
    const lbs = Math.round(count * sp.lbs * 10) / 10;
    const price = priceOf(k);
    lines.push({ species: k, code: sp.code, count, lbs, price, value: round2(lbs * price) });
  }
  const gross = round2(lines.reduce((a, l) => a + l.value, 0));
  const share = round2(gross * crewShare);
  const each = round2(share / 3);
  return {
    lines,
    gross,
    crewShare: share,
    net: round2(gross - share),
    totalLbs: Math.round(lines.reduce((a, l) => a + l.lbs, 0) * 10) / 10,
    crew: [
      { role: 'Skiffman', share: each },
      { role: 'Deckhand', share: each },
      { role: 'Deckhand', share: round2(share - 2 * each) },
    ],
  };
}

// Gallons per game hour at an engine load 0..1.
export function fuelBurnPerHour(load, eco) {
  const l = Math.max(0, Math.min(1, load || 0));
  return eco.fuelPerHourAtFull * Math.pow(l, 1.5) + eco.fuelIdlePerHour;
}

// $/gal at a fuel source: town (the City of Kodiak fuel dock) is base; villages, canneries and tenders add a premium.
export function fuelPriceAt(source, eco) {
  const town = source && (source.kind === 'town' || source.id === 'kodiak' || source.placeId === 'kodiak') && !source.isTender;
  return round2(eco.fuelPrice + (town ? 0 : eco.fuelPremiumAway));
}

// How many gallons can be bought at `price` without dropping cash below the advance limit.
export function affordableGallons(cash, price, advanceLimit, wanted) {
  if (price <= 0) return wanted;
  const credit = cash - advanceLimit;
  return Math.max(0, Math.min(wanted, Math.floor(credit / price)));
}

// Tow when out of fuel: flat fee plus a fill to `fillFraction` of capacity at the tender's fuel price.
export function towQuote(fuel, capacity, eco, tenderPrice, fillFraction = 0.25) {
  const gallons = Math.max(0, Math.round(capacity * fillFraction - fuel));
  return { gallons, fee: eco.towCost, fuelCost: round2(gallons * tenderPrice), total: round2(eco.towCost + gallons * tenderPrice) };
}

export function formatMoney(x, cents = false) {
  const neg = x < 0;
  const v = Math.abs(x);
  const s = cents ? v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : Math.round(v).toLocaleString('en-US');
  return `${neg ? '−' : ''}$${s}`;
}

export function formatLbs(x) {
  return `${Math.round(x).toLocaleString('en-US')} lb`;
}

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
export function numberWords(n) {
  n = Math.round(n);
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '');
  return String(n);
}

// Price as fishermen say it on the radio: 0.34 → "thirty-four", 1.2 → "a buck-twenty", 1.05 → "a buck-oh-five".
export function spokenPrice(p) {
  const cents = Math.round(p * 100);
  if (cents < 100) return numberWords(cents);
  const d = Math.floor(cents / 100);
  const c = cents % 100;
  const head = d === 1 ? 'a buck' : `${numberWords(d)} dollars`;
  if (!c) return head;
  return `${head}-${c < 10 ? `oh-${ONES[c]}` : numberWords(c)}`;
}
