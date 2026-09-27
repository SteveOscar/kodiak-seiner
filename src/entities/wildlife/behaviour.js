// Pure decision logic for the wildlife (no THREE, no DOM): the bear-encounter state machine, working-flock planning
// (30% of working flocks are over bait), sighting rules, and the population plans for bear sites.

import { hash01 } from './math.js';

// ---- bear encounters (SPEC §6.13)
export const ENCOUNTER = {
  watchDist: 30, // a bear stands and watches a person on foot inside this range
  chargeDist: 10, // closing to here provokes a bluff charge
  releaseDist: 48, // backing off past this ends the encounter
  watchMax: 22, // seconds a bear holds its ground before moving off on its own
  chargeTime: 1.8, // seconds of bluff charge
  retreatTime: 14, // seconds the bear spends leaving
  cooldown: 25, // seconds before the same bear engages again
};

export function createEncounter() {
  return { stage: 'none', t: 0, cooldownUntil: 0 };
}

// Advances one bear's encounter. Returns the new stage when it changes ('watch' | 'charge' | 'retreat' | 'none'),
// else null. `time` is sim seconds; `dist` metres from the bear to the person (Infinity when nobody is ashore).
export function stepEncounter(enc, { dist, onFoot, dt, time }, E = ENCOUNTER) {
  enc.t += dt;
  const to = (stage) => {
    enc.stage = stage;
    enc.t = 0;
    if (stage === 'none') enc.cooldownUntil = time + E.cooldown;
    return stage;
  };
  switch (enc.stage) {
    case 'none':
      if (onFoot && dist < E.watchDist && time >= enc.cooldownUntil) return to('watch');
      return null;
    case 'watch':
      if (!onFoot || dist > E.releaseDist || enc.t > E.watchMax) return to('retreat');
      if (dist < E.chargeDist) return to('charge');
      return null;
    case 'charge':
      if (enc.t > E.chargeTime) return to('retreat');
      return null;
    case 'retreat':
      if (enc.t > E.retreatTime) return to('none');
      return null;
    default:
      return to('none');
  }
}

// ---- working flocks
// Picks which nearby schools get a working flock (a deterministic ~45% of them by id, closest first) and how many
// bait flocks (no salmon) accompany them so bait flocks make up ~30% of all working flocks over time.
export function planFlocks(schools, { maxSchoolFlocks = 5, share = 0.45, baitFraction = 0.3, salt = 0 } = {}) {
  const chosen = [];
  for (const s of schools) {
    if (chosen.length >= maxSchoolFlocks) break;
    if (!s || s.state === 'captured' || s.state === 'gone' || s.state === 'sounding') continue;
    if (hash01(`flock:${s.id}`) < share) chosen.push(s.id);
  }
  const n = chosen.length;
  const bait = Math.floor((n * baitFraction) / (1 - baitFraction) + hash01(`bait:${salt}`));
  return { schoolIds: chosen, baitCount: bait };
}

// ---- sightings
// Projected size of an animal (pixels) given its characteristic size, distance and the camera's projection scale
// (viewport height / 2 / tan(fov / 2)): binoculars shrink the fov, so the same rule covers "within ~150 m by eye"
// and "through the glasses".
export const SIGHT_PX = 11;
export function seenWell({ size, dist, projScale, offAxisDeg, fovDeg, minPx = SIGHT_PX }) {
  if (!(dist > 0)) return false;
  const px = (size * projScale) / dist;
  if (px < minPx) return false;
  return offAxisDeg <= Math.max(6, fovDeg * 0.42);
}

// ---- bear populations
// Deterministic plan per bear site: Karluk always has a sow with cubs (and often a boar downstream); the O'Malley has
// several bears; road-system streams near town rarely have bears; elsewhere a mix of sows with 1-3 cubs, big boars
// and subadult siblings.
export function planBears(sites, rng) {
  const groups = [];
  const nearTown = new Set(['buskin', 'american', 'olds']);
  for (const s of sites) {
    const r = rng.fork(`bears:${s.id}`);
    let plan = [];
    if (s.streamId === 'karluk') {
      plan = [{ type: 'family', cubs: 2 + (r.next() < 0.5 ? 1 : 0) }];
      if (r.next() < 0.7) plan.push({ type: 'boar' });
    } else if (s.id === 'omalley') {
      plan = [{ type: 'family', cubs: 1 + Math.floor(r.next() * 3) }, { type: 'boar' }, { type: 'sow' }, { type: 'subadults' }];
    } else {
      const p = nearTown.has(s.streamId) ? 0.18 : 0.8;
      if (r.next() < p) {
        const u = r.next();
        plan.push(u < 0.45 ? { type: 'family', cubs: 1 + Math.floor(r.next() * 3) } : u < 0.78 ? { type: 'boar' } : { type: 'subadults' });
        if (!nearTown.has(s.streamId) && r.next() < 0.3) plan.push(r.next() < 0.5 ? { type: 'boar' } : { type: 'sow' });
      }
    }
    for (const g of plan) groups.push({ siteId: s.id, ...g });
  }
  return groups;
}
