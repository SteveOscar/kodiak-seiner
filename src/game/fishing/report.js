// Catch bookkeeping for a set (DOM-free): kings released, hold overflow, the fishing:setComplete payload (SPEC §7).

import { FISHING_TUNING } from '../../entities/net/tuning.js';

export const SPECIES = ['pink', 'chum', 'sockeye', 'coho', 'king'];

export const emptyCatch = () => ({ pink: 0, chum: 0, sockeye: 0, coho: 0, king: 0 });

// Integer, non-negative counts for every species (tolerates stubs returning partial or odd objects).
export function sanitizeCatch(c) {
  const out = emptyCatch();
  if (!c || typeof c !== 'object') return out;
  for (const k of SPECIES) {
    const v = Number(c[k]);
    out[k] = Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
  }
  return out;
}

export const totalFish = (c) => SPECIES.reduce((a, k) => a + (c?.[k] ?? 0), 0);

export function lbsOf(c, speciesTable) {
  return SPECIES.reduce((a, k) => a + (c?.[k] ?? 0) * (speciesTable[k]?.lbs ?? 0), 0);
}

// Kings (≥ 28 in) go back over the side; everything else goes to the hold.
export function splitKings(caught, speciesTable) {
  const keep = { ...caught };
  const released = emptyCatch();
  for (const k of SPECIES) {
    if (speciesTable[k]?.release) {
      released[k] = keep[k];
      keep[k] = 0;
    }
  }
  return { keep, released };
}

// Why fish left the net: under the leadline, over sunk corks (hauling hard in current), out through the open gap,
// through a snag's hole, let go over the corks with a plugged hold, or spilled drying up the bag above the clean-set
// capture ceiling (WP-FISH's harvest; nothing the skipper did).
export const ESCAPE_CAUSES = ['leads', 'corks', 'gap', 'hole', 'overflow', 'spill'];

export const emptyEscapes = () => ({ leads: 0, corks: 0, gap: 0, hole: 0, overflow: 0, spill: 0 });

export function sanitizeEscapes(e) {
  const out = emptyEscapes();
  if (!e || typeof e !== 'object') return out;
  for (const k of ESCAPE_CAUSES) {
    const v = Number(e[k]);
    out[k] = Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
  }
  return out;
}

export function addCatches(a, b) {
  const out = emptyCatch();
  for (const k of SPECIES) out[k] = (a?.[k] ?? 0) + (b?.[k] ?? 0);
  return out;
}

export function rateSet({ caughtFish, caughtLbs, value, overflowFish, waterHaul }, t = FISHING_TUNING) {
  if (waterHaul) return 'water haul';
  if (overflowFish > 0 || caughtLbs >= t.pluggedLbs) return 'plugged';
  if (caughtLbs >= t.goodLbs || value >= t.goodValue) return 'good';
  return 'fair';
}

// The fishing:setComplete payload. accepted/overflow come from economy.addCatch; forfeited is the catch seized
// with a closed-waters citation (never added to the hold).
export function buildSetReport({
  setNumber,
  caught,
  accepted,
  overflow,
  kingsReleased,
  forfeited = emptyCatch(),
  speciesTable,
  priceFor,
  minutes,
  cited = false,
  fine = 0,
  aborted = false,
  escaped = 0,
  escapes = null,
  valuedAt = null,
  valuedAtId = null,
  tuning = FISHING_TUNING,
}) {
  const c = sanitizeCatch(caught);
  const acc = sanitizeCatch(accepted);
  const released = addCatches(sanitizeCatch(kingsReleased), sanitizeCatch(overflow));
  const lbs = {};
  let totalLbs = 0;
  let value = 0;
  for (const k of SPECIES) {
    const l = acc[k] * (speciesTable[k]?.lbs ?? 0);
    lbs[k] = Math.round(l * 10) / 10;
    totalLbs += l;
    value += l * (priceFor(k) ?? 0);
  }
  const caughtFish = totalFish(c);
  const caughtLbs = lbsOf(c, speciesTable);
  const waterHaul = aborted || caughtFish < tuning.waterHaulFish;
  const overflowFish = totalFish(sanitizeCatch(overflow));
  return {
    setNumber,
    caught: c,
    accepted: acc,
    released,
    lbs,
    totalLbs: Math.round(totalLbs),
    value: Math.round(value * 100) / 100,
    minutes: Math.max(0, Math.round(minutes)),
    waterHaul,
    rating: rateSet({ caughtFish, caughtLbs, value, overflowFish, waterHaul }, tuning),
    cited: !!cited,
    // Extras (documented in notes/WP-NET.md).
    forfeited: sanitizeCatch(forfeited),
    fine,
    aborted,
    escaped: Math.max(0, Math.round(escaped)),
    // Counts by cause; `escaped` is leads + corks + gap + hole + spill (overflow is also in `released`).
    escapes: sanitizeEscapes(escapes),
    // Tender whose price `value` uses (the nearest buying tender at brailing), or null for the market estimate.
    valuedAt: valuedAt ?? null,
    valuedAtId: valuedAtId ?? null,
  };
}

// "~2,400" style estimate: two significant figures.
export function roundEstimate(n) {
  if (!(n > 0)) return 0;
  const mag = Math.pow(10, Math.max(0, Math.floor(Math.log10(n)) - 1));
  return Math.round(n / mag) * mag;
}
