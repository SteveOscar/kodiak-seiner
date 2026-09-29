// Pure scene analysis for the audio director (no WebAudio, no DOM): where the listener is, what is near it, and when
// scheduled world sounds are due. Everything here takes plain numbers/objects so it is unit-testable in Node.

import { clamp, smoothstep, TUNING } from './params.js';

// Settlement ambience weights by place kind: harbour/town bustle, cannery machinery, quiet villages.
export const SETTLEMENT = {
  town: { hum: 1, clink: 0.6, machinery: 0.35, gulls: 1 },
  harbor: { hum: 0.7, clink: 1, machinery: 0.15, gulls: 1 },
  cannery: { hum: 0.8, clink: 0.2, machinery: 1, gulls: 1 },
  hatchery: { hum: 0.35, clink: 0, machinery: 0.45, gulls: 0.5 },
  village: { hum: 0.3, clink: 0.35, machinery: 0, gulls: 0.5 },
  landmark: { hum: 0.3, clink: 0, machinery: 0.2, gulls: 0.2 },
};

// Loudest settlement around (x, z): → { level, hum, clink, machinery, gulls, place } (all 0..1; place may be null).
// Only places with a settlement kind and (for landmarks) a 3D model count; memorial places are always silent.
export function settlementAt(places, x, z) {
  const out = { level: 0, hum: 0, clink: 0, machinery: 0, gulls: 0, place: null };
  if (!Array.isArray(places)) return out;
  for (const p of places) {
    const w = SETTLEMENT[p?.kind];
    if (!w || p.memorial || !Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
    if (p.kind === 'landmark' && !p.model) continue;
    const r = Math.max(60, p.radius ?? 200);
    const d = Math.hypot(p.x - x, p.z - z);
    const lv = smoothstep(r + 650, r * 0.6, d);
    if (lv <= 0) continue;
    out.hum = Math.max(out.hum, lv * w.hum);
    out.clink = Math.max(out.clink, lv * w.clink);
    out.machinery = Math.max(out.machinery, lv * w.machinery);
    out.gulls = Math.max(out.gulls, lv * w.gulls);
    if (lv > out.level) {
      out.level = lv;
      out.place = p;
    }
  }
  return out;
}

// Where marina sounds come from: the dock if the place has one, else its centre, scattered a little.
export function harborPoint(place, r = Math.random) {
  if (!place) return null;
  const c = place.dock ?? place;
  const a = r() * Math.PI * 2;
  const d = 15 + r() * 70;
  return { x: c.x + Math.cos(a) * d, z: c.z + Math.sin(a) * d };
}

// Listener context from the camera rig and control state.
// → { interior 0..1 (in the wheelhouse), onFoot, height (m above the local surface) }
export function listenerContext({ camMode = 'chase', control = 'boat', camY = 10, groundY = 0 } = {}) {
  const onFoot = control === 'foot' || camMode === 'foot';
  return {
    interior: camMode === 'bridge' && !onFoot ? 1 : 0,
    onFoot,
    height: Math.max(0, camY - Math.max(0, groundY)),
  };
}

// The point on the shore nearest the listener (from the signed shore distance and the offshore gradient), where surf
// breaks are placed. → { x, z } or null when the listener is far offshore or deep inland.
export function shorePoint(x, z, shoreDist, grad, maxDist = 420) {
  if (!Number.isFinite(shoreDist) || shoreDist > maxDist || shoreDist < -300) return null;
  const gx = grad?.x ?? 0;
  const gz = grad?.z ?? 0;
  const len = Math.hypot(gx, gz);
  if (len < 1e-6) return { x, z };
  // Offshore unit vector: walk back toward the waterline (a touch past it, where the waves break).
  const back = shoreDist + 6;
  return { x: x - (gx / len) * back, z: z - (gz / len) * back };
}

// Beach material behind the surf from the seabed class at the waterline: gravel rattles, sand hisses, rock booms.
export function beachGravel(seabed) {
  switch (seabed) {
    case 'gravel':
      return 1;
    case 'rock':
      return 0.55;
    case 'sand':
      return 0.15;
    case 'mud':
      return 0;
    default:
      return 0.5;
  }
}

// One brailer scoop from WP-NET's fishing:brail {x, z, lbs}. The event fires as the brailer dips into the bag (phase
// ~0.19 of its cycle) and the brailer dumps over the hatch at ~0.70. loadLbs is a full brailer load and progress (0..1
// through brailing) thins the bag. → { dipVolume, dumpCount (salmon thumping into the hold), dumpDelay (s) }
export function brailScoop({ lbs = 0, loadLbs = 1500, progress = 0, cycle = 2.8 } = {}) {
  const k = clamp((Number(lbs) || 0) / Math.max(1, Number(loadLbs) || 1500), 0.15, 1);
  const thin = 1 - 0.45 * clamp(Number(progress) || 0, 0, 1);
  const c = Number(cycle) > 0 ? Number(cycle) : 2.8;
  return {
    dipVolume: 0.6 + 0.35 * k,
    dumpCount: Math.round(clamp(3 + 15 * k * thin, 3, 18)),
    dumpDelay: clamp((0.7 - 0.19) * c, 0.4, 3),
  };
}

// The brailer whip's hydraulic demand, seconds after the last scoop: hoisting the full bag out and swinging it over
// the hatch (to ~0.62 of the cycle), else idling. → rate for hydraulicParams
export function brailWhipRate(sinceScoop, cycle = 2.8) {
  const c = Number(cycle) > 0 ? Number(cycle) : 2.8;
  return sinceScoop >= 0 && sinceScoop < 0.43 * c ? 0.75 : 0.18;
}

// A disturbed haulout stampeding into the sea (wildlife:disturbed): a burst of roars and barks from the herd while
// bodies plunge in, scaled by the colony (a haulout is 8-35 animals, the Marmot rookery ~150).
// → { roars: [{ t, bull, rate }], plunges: [{ t, size }], chorus 0..1, dur (s), level }
export function stampedePlan(members = 16, r = Math.random) {
  const n = clamp(Number(members) || 16, 3, 200);
  const crowd = clamp(Math.sqrt(n / 20), 0.5, 2.6);
  const roarN = Math.round(clamp(2 + n / 15, 3, 5));
  const plungeN = Math.round(clamp(3 + n / 12, 4, 8));
  const dur = clamp(3.5 + crowd * 1.6, 4, 8);
  const roars = [];
  for (let i = 0; i < roarN; i++) roars.push({ t: (i / roarN) * dur * 0.55 + r() * 0.35, bull: i === 0 || r() < 0.3, rate: 0.88 + 0.3 * r() });
  const plunges = [];
  // Bodies hit the water from ~0.4 s, densest early (the rush off the rocks), a few stragglers late.
  for (let i = 0; i < plungeN; i++) plunges.push({ t: 0.4 + Math.pow(r(), 1.6) * dur * 0.7, size: 1.4 + 1.4 * r() });
  plunges.sort((a, b) => a.t - b.t);
  return { roars, plunges, chorus: clamp(0.35 + 0.25 * crowd, 0.35, 1), dur, level: clamp(0.65 + 0.12 * crowd, 0.65, 0.95) };
}

// A call the UI starts to caption (ui:radioShown {from, channel, tip}) matched to the ui:radio / ui:hint that queued it;
// the UI reorders (Pete's tips jump routine traffic). Oldest pending call from the same sender with the same tip flag,
// preferring the same channel. pending: [{ from, channel, tip }] → index or -1.
export const radioChannel = (c, fallback = '16') => String(c ?? fallback).replace(/^ch\s*/i, '');
export function matchRadio(pending, shown) {
  if (!Array.isArray(pending) || !shown) return -1;
  const from = String(shown.from || 'VHF');
  const ch = radioChannel(shown.channel);
  let best = -1;
  for (let i = 0; i < pending.length; i++) {
    const p = pending[i];
    if (!p || p.from !== from || !!p.tip !== !!shown.tip) continue;
    if (p.channel === ch) return i;
    if (best < 0) best = i;
  }
  return best;
}

// Seconds from a lightning flash to its thunder (sound travels ~3 s/km), capped so a far strike still reads as one.
export function thunderDelay(distance) {
  const d = Math.max(0, Number(distance) || 0);
  return Math.min(9, d / TUNING.speedOfSound);
}

// Nearest item of `list` (objects with .position {x,z} or x/z) to (x, z) within maxDist, optionally filtered.
// → { item, distance } | null
export function nearestOf(list, x, z, maxDist = Infinity, filter = null) {
  let best = null;
  let bd = maxDist;
  if (!list) return null;
  for (const it of list) {
    if (!it || (filter && !filter(it))) continue;
    const p = it.position ?? it;
    const px = p.x;
    const pz = p.z;
    if (!Number.isFinite(px) || !Number.isFinite(pz)) continue;
    const d = Math.hypot(px - x, pz - z);
    if (d < bd) {
      bd = d;
      best = it;
    }
  }
  return best ? { item: best, distance: bd } : null;
}

// Up to n nearest items within maxDist, nearest first. → [{ item, distance }]
export function nearestN(list, x, z, n, maxDist = Infinity, filter = null) {
  const out = [];
  if (!list || n <= 0) return out;
  for (const it of list) {
    if (!it || (filter && !filter(it))) continue;
    const p = it.position ?? it;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
    const d = Math.hypot(p.x - x, p.z - z);
    if (d > maxDist) continue;
    if (out.length < n) out.push({ item: it, distance: d });
    else if (d < out[out.length - 1].distance) out[out.length - 1] = { item: it, distance: d };
    else continue;
    out.sort((a, b) => a.distance - b.distance);
  }
  return out;
}

// Gull activity around the listener from the wildlife bird list: followers near the boat, working flocks over fish or
// bait, the bag swarm and resting gulls. → { near 0..1, working 0..1, swarm bool, sources: [bird] (within range) }
export function gullScene(birds, x, z, range = 180) {
  const out = { near: 0, working: 0, swarm: false, count: 0, sources: [] };
  if (!Array.isArray(birds)) return out;
  let n = 0;
  let w = 0;
  let s = 0;
  for (const b of birds) {
    if (b?.kind !== 'gull' || !b.position) continue;
    const d = Math.hypot(b.position.x - x, b.position.z - z);
    if (d > range) continue;
    const k = 1 - d / range;
    n += k;
    if (b.role === 'work' || b.role === 'frenzy') w += k;
    if (b.role === 'swarm') s += k;
    if (out.sources.length < 24) out.sources.push(b);
  }
  out.count = out.sources.length;
  out.near = clamp(n / 6, 0, 1);
  out.working = clamp(w / 5, 0, 1);
  out.swarm = s > 2;
  return out;
}

// Hull slap strength from the seiner's motion: the bow dropping into a sea (pitch rate, rad/s, bow-down positive)
// and the local sea height, plus way on. → 0 (no slap) .. ~1.2
export function slapStrength({ pitchRate = 0, speed = 0, hs = 0.5 } = {}) {
  const drop = Math.max(0, pitchRate);
  const sea = smoothstep(0.15, 1.6, hs);
  const way = 0.35 + 0.65 * smoothstep(1, 9, Math.abs(speed));
  const s = smoothstep(0.02, 0.14, drop) * (0.25 + 0.9 * sea) * way;
  return s < 0.08 ? 0 : Math.min(1.2, s);
}

// Mean seconds between soft lapping slaps when the boat lies still (anchored, drifting, docked).
export function lapInterval(hs = 0.5) {
  return clamp(4.5 - 3.2 * smoothstep(0.1, 1.2, hs), 1.1, 4.5);
}

// Sea-lion chorus rate (roars per second) at a haulout from the listener's distance; the Marmot rookery is noisier.
export function sealionRate(distance, members = 20) {
  if (!Number.isFinite(distance) || distance > 1400) return 0;
  const crowd = clamp(members / 25, 0.15, 2.5);
  return crowd * 0.4 * smoothstep(1400, 250, distance) + 0.02;
}

// Exponential waiting time for a Poisson process with the given mean interval (s).
export function poissonWait(mean, r = Math.random) {
  const u = Math.min(0.999999, Math.max(1e-6, r()));
  return -Math.log(1 - u) * Math.max(0.01, mean);
}

// Pause/menu muffle: world and ambience are low-passed and lowered while the game is paused or the chart is open, and
// lowered under the title music.
export function muffleFor(mode) {
  if (mode === 'paused' || mode === 'map') return { cutoff: 900, gain: 0.45 };
  // The title is the music's moment: the world stays as a backdrop under it.
  if (mode === 'title') return { cutoff: 20000, gain: 0.4 };
  return { cutoff: 20000, gain: 1 };
}
