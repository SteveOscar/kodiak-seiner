// How salmon leave (or stay in) a purse seine. Pure functions used by the simulation and the unit tests.
//
// Close-up: the part of a school inside the corkline is enclosed; a fringe (1 − f0, f0 ∈ [0.82, 0.9]) boils out as
// the ends come together. Until pursed, fish escape under the leadline at
//   λ = LAMBDA0 · leadlineEscape · (1 − pursed)² · (1 − 0.8 · bottomContact on smooth bottom) · deep · sounding · hole
// per second (SPEC §6.10). Once pursed they are trapped (a snag hole still leaks until the web is hauled). At brailing
// each species is capped at its clean-set ceiling (config capture[1]). With these constants a clean set (close-up
// ~10 s, rings up in ~20 s) lands in the species capture range and a sloppy one (a minute closed before pursing, slow
// pursing) lands in 15–40%. A school that sounds in the net, or was outside at close-up, is a water haul.

import { SPECIES, emptyCatch, KING_CAPTURE } from './species.js';

export const LAMBDA0 = 0.012; // base leadline escape rate (1/s) for an open (unpursed) closed net
export const PURSED = 0.98; // pursed fraction at which the bottom is shut
export const FRINGE = [0.82, 0.9]; // fraction of the enclosed fish still inside once the ends meet
export const GAP_LEAK = 0.004; // 1/s leak of a school milling in an open hook
export const HOOK_COLLAPSE = 0.4; // hook area below this fraction of its best area leaks faster
export const SOUNDING_ESCAPE = 8;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function leadlineEscapeRate({
  pursed = 0,
  leadlineEscape = 1,
  bottomContact = 0,
  smoothBottom = true,
  hole = false,
  fishDepth = 0,
  netDepth = 16,
  sounding = false,
} = {}) {
  if (pursed >= PURSED) return hole ? LAMBDA0 * 0.25 * leadlineEscape : 0;
  const open = (1 - clamp01(pursed)) ** 2;
  const bottom = smoothBottom ? 1 - 0.8 * clamp01(bottomContact) : 1;
  const depthRatio = netDepth > 0 ? fishDepth / netDepth : 1;
  const deep = depthRatio > 0.75 ? 1 + Math.min(6, 8 * (depthRatio - 0.75)) : 1;
  return LAMBDA0 * leadlineEscape * open * bottom * deep * (sounding ? SOUNDING_ESCAPE : 1) * (hole ? 1.25 : 1);
}

// Corks dragged under while hauling hard in a current (or when the net reports corksUnder).
export function haulEscapeRate({ hauled = 0, haulSpeed = 0, current = 0, corksUnder = false, leadlineEscape = 1 } = {}) {
  if (corksUnder) return 0.04 * leadlineEscape;
  if (hauled < 0.8) return 0;
  const fast = clamp01(haulSpeed * 30 - 1);
  const stream = clamp01((current - 0.2) / 0.3);
  return 0.05 * fast * stream * leadlineEscape;
}

export function captureRange(species, speciesCfg) {
  if (species === 'king') return KING_CAPTURE;
  return speciesCfg?.[species]?.capture ?? [0.5, 0.8];
}

// Enclose `fraction` of a school's mix at close-up. Returns the in-net record (the caller stores it on the school).
export function encloseSchool(mix, fraction, rng, { spooked = false } = {}) {
  const enclosed = emptyCatch();
  const live = emptyCatch();
  const f0 = (FRINGE[0] + (FRINGE[1] - FRINGE[0]) * rng.next()) * (spooked ? 0.9 : 1);
  for (const k of SPECIES) {
    enclosed[k] = Math.round((mix[k] ?? 0) * clamp01(fraction));
    live[k] = enclosed[k] * f0;
  }
  return { enclosed, live, f0, esc: emptyCatch(), sounded: false, trapped: false };
}

// Applies a per-species escape rate for dt seconds. rateOf(species) → 1/s. Returns the fish that left (floats).
export function applyEscape(rec, dt, rateOf, out = emptyCatch()) {
  for (const k of SPECIES) {
    out[k] = 0;
    const n = rec.live[k];
    if (n <= 0) continue;
    const lam = rateOf(k);
    if (lam <= 0) continue;
    const left = n * (1 - Math.exp(-lam * dt));
    rec.live[k] = n - left;
    rec.esc[k] += left;
    out[k] = left;
  }
  return out;
}

// Final count per species at brailing: what is still inside, capped at the clean-set ceiling.
export function harvestCounts(rec, speciesCfg) {
  const out = emptyCatch();
  for (const k of SPECIES) {
    const cap = Math.round((rec.enclosed[k] ?? 0) * captureRange(k, speciesCfg)[1]);
    out[k] = Math.max(0, Math.min(Math.round(rec.live[k] ?? 0), cap));
  }
  return out;
}

// Seabed kinds on which a leadline resting on the bottom seals the net.
export const isSmoothBottom = (kind) => kind === 'mud' || kind === 'sand' || kind === 'gravel';
