// Start-location choices for a new game (the title screen's "Where do you start?" panel). Pure: no DOM, no ctx.
//
// New Season offers the working ports (towns, villages, harbors, canneries), the City of Kodiak first and
// recommended (its own harbors and cannery row fold into it); Free Explore offers every non-memorial place plus
// "Surprise me", Kodiak first. The City of Kodiak starts at the classic spawn (places.spawn). Free Explore starts at
// the teleport arrival pose (season.travel.teleportTargets(): open water, facing the place, for sightseeing). A New
// Season away from Kodiak starts off the port in open water with the bow toward sea room and Uncle Pete's school
// (seasonStartPose): the arrival pose sits ~70 m off the beach facing it, so the first throttle would run aground.
//
//   buildStartOptions({ mode: 'season'|'explore', places, districts, targets, spawn, closedWaters?, isOpenWater?,
//                       sea?, netDepth?, limit?, cache? })
//     → [{ id, placeId, name, kind, kindLabel, district, districtName, group, groupName, line, blurb, services,
//          recommended, home, surprise, pose: { x, z, heading } | null }]
//   filterStartOptions(options, query)    search by name, kind, district or nearby grounds, best match first
//                                         ("Surprise me" only unfiltered)
//   groupStartOptions(options)            [{ id, name, options }] in list order
//   preselectIndex(options, lastId)       the remembered choice, else Kodiak, else 0
//   startAtFor(option)                    ctx.game.start's startAt: null for Kodiak (the classic spawn), else the pose
//   pickSurprise(options, random)         a random place from the list (any option with a pose)
//   readLastStart(storage) / rememberStart(storage, mode, id)   last choice per mode (localStorage-like storage)
//   seasonStartPose(pose, sea, { place, others, closedWaters, netDepth, limit })  a New Season start near `pose`
//   seasonPoseFor(placeId, pose, { sea, places, closedWaters, netDepth, limit, cache })  the same for a port, cached
//   clearOfClosedWaters(pose, closedWaters, { isOk, face })      a start outside the stream closures (the fallback
//                                         when there is no seabed to search: the Karluk arrival sits inside the
//                                         Karluk River markers)

export const START_KEY = 'kodiak-seiner:startAt';
export const HOME_ID = 'kodiak';
export const SURPRISE_ID = 'surprise';
export const WORKING_KINDS = ['town', 'village', 'harbor', 'cannery'];
export const DISTRICT_ORDER = ['northeast', 'afognak', 'eastside', 'alitak', 'southwest', 'northwest', 'mainland'];
const GROUND_KINDS = ['bay', 'strait', 'cape'];
const GROUND_RADIUS = 3200; // game m: bays, straits and capes this close count as the port's grounds

export const KIND_LABEL = {
  town: 'Town',
  village: 'Village',
  harbor: 'Harbor',
  cannery: 'Cannery',
  hatchery: 'Hatchery',
  landmark: 'Landmark',
  cape: 'Cape',
  bay: 'Bay',
  strait: 'Strait',
  island: 'Island',
  river: 'Salmon stream',
  lake: 'Lake',
  peak: 'Peak',
  lighthouse: 'Light',
  wildlife: 'Wildlife',
  history: 'History',
  viewpoint: 'Viewpoint',
};

const SERVICE_LABEL = { sell: 'buys fish', fuel: 'fuel', ice: 'ice', upgrades: 'boatyard', rest: 'rest' };
const SERVICE_ORDER = ['sell', 'fuel', 'ice', 'upgrades', 'rest'];

// The blurb's opening, for the detail line: the first sentence, or the first two when the first is only a few words
// ("Nuniaq in Alutiiq.").
export function firstSentence(text, minLength = 40) {
  const parts = String(text ?? '')
    .trim()
    .split(/(?<=[.!?])(?<!\b(?:St|Mt|Ft|Pt|Capt|Lt|Dr|Mr|Mrs|No|[A-Z])\.)\s+(?=[A-Z0-9'"‘“])/);
  if (!parts[0]) return '';
  return parts[0].length < minLength && parts[1] ? `${parts[0]} ${parts[1]}` : parts[0];
}

// Names of the nearest bays, straits and capes within `radius` m of the place (nearest first).
export function nearbyGrounds(place, places, { max = 2, radius = GROUND_RADIUS } = {}) {
  if (!place || !Number.isFinite(place.x)) return [];
  return (places ?? [])
    .filter((q) => q && q !== place && GROUND_KINDS.includes(q.kind) && !q.memorial && Number.isFinite(q.x))
    .map((q) => ({ q, d: Math.hypot(q.x - place.x, q.z - place.z) }))
    .filter((o) => o.d <= radius)
    .sort((a, b) => a.d - b.d)
    .slice(0, max)
    .map((o) => o.q.name);
}

export function servicesText(services) {
  const s = SERVICE_ORDER.filter((k) => services?.includes?.(k)).map((k) => SERVICE_LABEL[k]);
  if (!s.length) return 'No harbor services';
  const text = s.join(' · ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function districtRank(id) {
  const i = DISTRICT_ORDER.indexOf(id);
  return i < 0 ? DISTRICT_ORDER.length : i;
}

function validPose(p) {
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.z);
}

// New Season starts away from Kodiak: with `sea` ({ depthAt, shoreDistance }: the heightmap) the start is
// seasonStartPose() off the arrival pose; without it (stubbed terrain), closedWaters ([{ x, z, radius }],
// season.closedWaters) and isOpenWater(x, z) only move a start that would sit inside stream markers to just outside
// them. Free Explore keeps the teleport pose: fishing is always open there. `cache` (a Map) keeps the searched poses
// between panel openings; the seabed does not change.
export function buildStartOptions({ mode = 'season', places = [], districts = [], targets = [], spawn = null, closedWaters = null, isOpenWater = null, sea = null, netDepth = SEASON_START.netDepth, limit = SEASON_START.limit, cache = null } = {}) {
  const explore = mode === 'explore';
  const districtName = (id) => districts?.find?.((d) => d.id === id)?.name ?? null;
  const poseOf = new Map();
  for (const t of targets ?? []) {
    if (t && t.placeId && t.kind !== 'tender' && validPose(t)) poseOf.set(t.placeId, { x: t.x, z: t.z, heading: Number.isFinite(t.heading) ? t.heading : 0, districtName: t.districtName ?? null });
  }
  // New Season lists the City of Kodiak once: its harbors and cannery row (inside the town's radius) are the same start.
  const homePlace = (places ?? []).find((p) => p?.id === HOME_ID) ?? null;
  const inTown = (p) => !!homePlace && p !== homePlace && Number.isFinite(p.x) && Math.hypot(p.x - homePlace.x, p.z - homePlace.z) <= (homePlace.radius ?? 450);
  const out = [];
  for (const p of places ?? []) {
    if (!p || p.memorial || !p.id) continue;
    if (!explore && (!WORKING_KINDS.includes(p.kind) || inTown(p))) continue;
    const home = p.id === HOME_ID;
    const t = poseOf.get(p.id) ?? null;
    let pose = home && validPose(spawn) ? { x: spawn.x, z: spawn.z, heading: Number.isFinite(spawn.heading) ? spawn.heading : 0 } : t ? { x: t.x, z: t.z, heading: t.heading } : null;
    if (!pose) continue;
    if (!explore && !home) {
      const found = sea ? seasonPoseFor(p.id, pose, { sea, places, closedWaters, netDepth, limit, cache }) : null;
      if (found) pose = found;
      else if (closedWaters?.length) pose = clearOfClosedWaters(pose, closedWaters, { isOk: isOpenWater ?? undefined, face: p }) ?? pose;
    }
    const kindLabel = KIND_LABEL[p.kind] ?? (p.kind ? p.kind.charAt(0).toUpperCase() + p.kind.slice(1) : 'Place');
    const grounds = nearbyGrounds(p, places);
    const dName = districtName(p.district) ?? t?.districtName ?? 'Kodiak Archipelago';
    out.push({
      id: p.id,
      placeId: p.id,
      name: p.name,
      kind: p.kind,
      kindLabel,
      district: p.district ?? null,
      districtName: dName,
      group: home ? 'home' : p.district ?? 'other',
      groupName: home ? (explore ? 'Start' : 'Home port') : dName,
      grounds,
      line: grounds.length ? `${kindLabel} · ${grounds.join(', ')}` : kindLabel,
      blurb: firstSentence(p.blurb),
      services: explore ? null : servicesText(p.services),
      recommended: home && !explore,
      home,
      surprise: false,
      pose,
    });
  }
  out.sort((a, b) => (b.home ? 1 : 0) - (a.home ? 1 : 0) || districtRank(a.district) - districtRank(b.district) || String(a.districtName).localeCompare(String(b.districtName)) || a.name.localeCompare(b.name));
  if (explore && out.length) {
    const at = out[0].home ? 1 : 0;
    out.splice(at, 0, {
      id: SURPRISE_ID,
      placeId: null,
      name: 'Surprise me',
      kind: null,
      kindLabel: 'Anywhere',
      district: null,
      districtName: null,
      group: 'home',
      groupName: 'Start',
      grounds: [],
      line: 'A random place in the archipelago',
      blurb: 'Somewhere in the archipelago, picked at random.',
      services: null,
      recommended: false,
      home: false,
      surprise: true,
      pose: null,
    });
  }
  return out;
}

// Lower case, accents and apostrophes dropped, other punctuation as spaces: "Awa’uq" matches "awauq", "St. Paul"
// matches "st paul".
function searchText(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’‘`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// How well an option matches a query already passed through searchText: 0 its whole name, 1 the start of its name, 2
// the start of a word in its name, 3 elsewhere in its name, 4 its kind or district, 5 its nearby grounds; -1 no match.
export function matchRank(option, q) {
  if (!q) return -1;
  const name = searchText(option?.name);
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  if (` ${name}`.includes(` ${q}`)) return 2;
  if (name.includes(q)) return 3;
  if ([option?.kindLabel, option?.districtName].some((s) => searchText(s).includes(q))) return 4;
  if ((option?.grounds ?? []).some((s) => searchText(s).includes(q))) return 5;
  return -1;
}

// Matches, best first: the group holding the best match leads, and inside each group the best matches come first, so
// the preselected first row is the place the player named ("deadman" → Deadman Bay, not a village whose grounds
// include it). Groups stay contiguous for groupStartOptions.
export function filterStartOptions(options, query) {
  const q = searchText(query);
  if (!q) return [...(options ?? [])];
  const hits = [];
  (options ?? []).forEach((o, i) => {
    const rank = o && !o.surprise ? matchRank(o, q) : -1;
    if (rank >= 0) hits.push({ o, i, rank });
  });
  const group = new Map();
  for (const h of hits) {
    const g = group.get(h.o.group);
    if (!g) group.set(h.o.group, { rank: h.rank, first: h.i });
    else g.rank = Math.min(g.rank, h.rank);
  }
  const g = (h) => group.get(h.o.group);
  hits.sort((a, b) => g(a).rank - g(b).rank || g(a).first - g(b).first || a.rank - b.rank || a.i - b.i);
  return hits.map((h) => h.o);
}

export function groupStartOptions(options) {
  const groups = [];
  for (const o of options ?? []) {
    let g = groups.at(-1);
    if (!g || g.id !== o.group) {
      g = { id: o.group, name: o.groupName, options: [] };
      groups.push(g);
    }
    g.options.push(o);
  }
  return groups;
}

export function preselectIndex(options, lastId) {
  if (!options?.length) return -1;
  const i = lastId ? options.findIndex((o) => o.id === lastId) : -1;
  if (i >= 0) return i;
  const h = options.findIndex((o) => o.home);
  return h >= 0 ? h : 0;
}

export function startAtFor(option) {
  if (!option || option.home || !validPose(option.pose)) return null;
  return { x: option.pose.x, z: option.pose.z, heading: option.pose.heading ?? 0 };
}

export function pickSurprise(options, random = Math.random) {
  const pool = (options ?? []).filter((o) => !o.surprise && validPose(o.pose));
  if (!pool.length) return null;
  const r = Number(random());
  return pool[Math.min(pool.length - 1, Math.max(0, Math.floor((Number.isFinite(r) ? r : 0) * pool.length)))];
}

export function readLastStart(storage) {
  try {
    const raw = storage?.getItem?.(START_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export function rememberStart(storage, mode, id) {
  if (!storage || !id || (mode !== 'season' && mode !== 'explore')) return;
  const v = { ...readLastStart(storage), [mode]: String(id) };
  try {
    storage.setItem(START_KEY, JSON.stringify(v));
  } catch {
    // storage full or unavailable: the next panel preselects Kodiak
  }
}

// Where Uncle Pete's tutorial school spawns around a New Season start, mirrored from the fish sim
// (src/entities/fish/sim.js TUTORIAL, tutorialSpot and spawnTutorial). "Clean" water is at least the net depth + 4 m
// deep everywhere within 80 m, 100 m off the coast. The sim takes the clean spots with the most margin 380–420 m out
// (sampled every 10 m and 3°), else those on the nearest clean ring out to 700 m, and of them one of the three nearest
// the bow. With no clean spot but some water that deep it takes the spot with the most margin; with none at all, a
// random point 380–700 m out with 8 m under it and 60 m off the coast, half the tries within a radian of the bow.
// tests/ui-start.test.mjs holds the two in step.
export const TUTORIAL_SPOT = { rMin: 380, rMax: 420, rFar: 700, rStep: 10, degStep: 3, margin: 4, clear: 80, minShore: 100, randomDepth: 8, randomShore: 60, randomSpread: 1 };

// A New Season start: `depth` m of water and `shore` m of sea room under the boat (past the ~150 m reach of the
// "Go ashore" prompt), and a straight run to the school with at least runDepth m (grounding is at 2.2 m) along the
// line and runWidth m either side. The school's circle (the sim's 80 m) keeps circleDepth m (a let-go needs more than
// 6 m under the stern). A start that relies on the sim's random drop needs every acceptable point in the cone off the
// bow to be safe and at least coneShare of the cone acceptable (the sim's 28 aimed tries then all but never miss).
// maxMove: how far from the arrival pose the search goes. limit: the fish sim's world edge. netDepth: the base seine.
export const SEASON_START = { depth: 8, shore: 160, runDepth: 6, runWidth: 20, runStep: 15, circleDepth: 6, coneShare: 0.25, maxFromPlace: 1000, maxMove: 1500, step: 50, limit: 7400, netDepth: 16 };

// The New Season start nearest `pose` (the arrival pose off the port) with `depth` m under it and `shore` m of sea
// room, at the port (within maxFromPlace m of `place` and no nearer any of `others`), with the bow toward where the
// tutorial school will spawn, from which the school can only land in safe water a clear straight run away: every spot
// the sim could pick for it, or (where no water is deep enough for the sim to choose) every acceptable point in the
// cone off the bow its random drop aims at. → { x, z, heading, school: { x, z } | null, risk: 0 }. With no such start,
// the one whose random drop is least likely to land unsafe (risk: that chance), else the nearest start facing the
// longest clear run (risk 1); null when there is no open water at all. sea: { depthAt(x, z) ≥ 0, shoreDistance(x, z) }.
export function seasonStartPose(pose, sea, { place = null, others = null, closedWaters = null, netDepth = SEASON_START.netDepth, limit = SEASON_START.limit, tuning = {} } = {}) {
  if (!validPose(pose) || typeof sea?.depthAt !== 'function' || typeof sea?.shoreDistance !== 'function') return null;
  const S = { ...SEASON_START, ...tuning };
  const T = TUTORIAL_SPOT;
  const circles = (closedWaters ?? []).filter((c) => c && Number.isFinite(c.x) && Number.isFinite(c.z) && Number.isFinite(c.radius));
  const closed = (x, z) => circles.some((c) => (x - c.x) ** 2 + (z - c.z) ** 2 <= c.radius * c.radius);
  const inBounds = (x, z) => Math.abs(x) <= limit && Math.abs(z) <= limit;
  const depth = (x, z) => sea.depthAt(x, z);
  const need = netDepth + T.margin;
  const TAU = Math.PI * 2;

  // The sim's minDepthAround: the centre plus two rings of 16.
  const around = (x, z) => {
    let m = depth(x, z);
    for (const r of [T.clear * 0.5, T.clear]) {
      for (let i = 0; i < 16 && m > 0; i++) {
        const a = (i / 16) * TAU;
        m = Math.min(m, depth(x + Math.cos(a) * r, z + Math.sin(a) * r));
      }
    }
    return m;
  };
  // How far a straight run from (x, z) along heading a stays in runDepth m of water, runWidth m either side (≤ max).
  const clearTo = (x, z, a, max) => {
    const ux = Math.sin(a);
    const uz = -Math.cos(a);
    let len = 0;
    for (let s = S.runStep; s <= max + S.runStep - 1e-6; s += S.runStep) {
      const d = Math.min(s, max);
      if ([0, -S.runWidth, S.runWidth].some((w) => depth(x + ux * d - uz * w, z + uz * d + ux * w) < S.runDepth)) break;
      len = d;
    }
    return len;
  };
  const offset = (a, h) => Math.abs(((a - h + 3 * Math.PI) % TAU) - Math.PI);

  // What the sim does from (x, z): { spots } it chooses among (most margin first), or { random: true }.
  const schoolFrom = (x, z) => {
    const ring = (rMin, rMax) => {
      const out = [];
      for (let r = rMin; r <= rMax + 1e-6; r += T.rStep) {
        for (let deg = 0; deg < 360; deg += T.degStep) {
          const a = (deg * Math.PI) / 180;
          const px = x + Math.sin(a) * r;
          const pz = z - Math.cos(a) * r;
          if (!inBounds(px, pz) || depth(px, pz) < need || sea.shoreDistance(px, pz) < T.minShore || closed(px, pz)) continue;
          out.push({ x: px, z: pz, a, r, m: around(px, pz) });
        }
      }
      return out;
    };
    const near = ring(T.rMin, T.rMax);
    let clean = near.filter((c) => c.m >= need);
    if (!clean.length) {
      const far = ring(T.rMax + T.rStep, T.rFar);
      clean = far.filter((c) => c.m >= need);
      const r0 = Math.min(...clean.map((c) => c.r));
      clean = clean.filter((c) => c.r <= r0 + 20);
      if (!clean.length) {
        const all = near.concat(far);
        if (!all.length) return { random: true };
        // The first spot with the most margin, in scan order (the sim's stable sort).
        return { spots: [all.reduce((b, c) => (c.m > b.m ? c : b))] };
      }
    }
    const best = Math.max(...clean.map((c) => c.m));
    return { spots: clean.filter((c) => c.m >= best - 1).sort((p, q) => q.m - p.m) };
  };

  // A heading at the best spot from which the three spots nearest the bow (the sim's pick) are all safe and a clear
  // run away.
  const aimAtSpots = (x, z, spots) => {
    const reach = new Map();
    const safe = (s) => {
      if (!reach.has(s)) reach.set(s, s.m >= S.circleDepth && clearTo(x, z, s.a, s.r) >= s.r);
      return reach.get(s);
    };
    for (const t of spots) {
      if (!safe(t)) continue;
      const near = [...spots].sort((p, q) => offset(p.a, t.a) - offset(q.a, t.a)).slice(0, 3);
      if (near.every(safe)) return { heading: t.a, school: { x: t.x, z: t.z }, risk: 0 };
    }
    return null;
  };

  // A heading whose cone (the sim's aimed tries: ±randomSpread rad, 380–700 m) holds only safe acceptable points, and
  // enough of them: the school then lands in that cone. Cones are tried most acceptable water first; each ray's
  // safety is worked out only when a cone needs it. bestEffort: the cone with the smallest share of unsafe points
  // instead (risk), for a port where no start is safe.
  const aimAtRandom = (x, z, bestEffort = false) => {
    const nA = 120;
    const radii = [];
    for (let r = T.rMin; r <= T.rFar; r += 20) radii.push(r);
    const pts = [];
    for (let i = 0; i < nA; i++) {
      const a = (i / nA) * TAU;
      const ray = [];
      for (const r of radii) {
        const px = x + Math.sin(a) * r;
        const pz = z - Math.cos(a) * r;
        if (inBounds(px, pz) && depth(px, pz) >= T.randomDepth && sea.shoreDistance(px, pz) >= T.randomShore && !closed(px, pz)) ray.push({ px, pz, r });
      }
      pts.push(ray);
    }
    const unsafeOn = new Map();
    const unsafe = (i) => {
      if (!unsafeOn.has(i)) {
        const ray = pts[i];
        const run = ray.length ? clearTo(x, z, (i / nA) * TAU, ray.at(-1).r) : 0;
        unsafeOn.set(i, ray.filter((p) => run < p.r || around(p.px, p.pz) < S.circleDepth).length);
      }
      return unsafeOn.get(i);
    };
    const k = Math.ceil((T.randomSpread / TAU) * nA);
    const cones = [];
    for (let h = 0; h < nA; h++) {
      let na = 0;
      for (let j = -k; j <= k; j++) na += pts[(h + j + nA) % nA].length;
      const share = na / ((2 * k + 1) * radii.length);
      if (share >= (bestEffort ? 1e-9 : S.coneShare)) cones.push({ h, na, share });
    }
    cones.sort((p, q) => q.share - p.share);
    if (!bestEffort) {
      for (const c of cones) {
        let bad = 0;
        for (let j = -k; j <= k && !bad; j++) bad = unsafe((c.h + j + nA) % nA);
        if (!bad) return { heading: (c.h / nA) * TAU, school: null, risk: 0 };
      }
      return null;
    }
    // The chance the school lands unsafe: in the cone when one of the sim's 28 aimed tries hits acceptable water, else
    // anywhere in the ring.
    let acc = 0;
    let bad = 0;
    for (let i = 0; i < nA; i++) {
      acc += pts[i].length;
      bad += unsafe(i);
    }
    let best = null;
    for (const c of cones) {
      let cb = 0;
      for (let j = -k; j <= k; j++) cb += unsafe((c.h + j + nA) % nA);
      const miss = (1 - c.share) ** 28;
      const risk = (1 - miss) * (cb / c.na) + miss * (acc ? bad / acc : 1);
      if (!best || risk < best.risk) best = { heading: (c.h / nA) * TAU, school: null, risk };
    }
    return best;
  };

  // At the port: within maxFromPlace m of it and no nearer another port (ports in the same harbour excepted).
  const atPort = (x, z) => {
    if (!validPose(place)) return true;
    const d = Math.hypot(x - place.x, z - place.z);
    return d <= S.maxFromPlace && (others ?? []).every((o) => !validPose(o) || d <= Math.hypot(x - o.x, z - o.z));
  };
  const ok = (x, z) => inBounds(x, z) && depth(x, z) >= S.depth && sea.shoreDistance(x, z) >= S.shore && !closed(x, z) && atPort(x, z);
  const n = Math.floor(S.maxMove / S.step);
  const cands = [];
  for (let i = -n; i <= n; i++) {
    for (let j = -n; j <= n; j++) {
      const d = Math.hypot(i, j) * S.step;
      if (d <= S.maxMove) cands.push({ x: pose.x + i * S.step, z: pose.z + j * S.step, d });
    }
  }
  cands.sort((p, q) => p.d - q.d);

  const starts = [];
  for (const c of cands) {
    if (!ok(c.x, c.z)) continue;
    const plan = schoolFrom(c.x, c.z);
    const aim = plan.spots ? aimAtSpots(c.x, c.z, plan.spots) : aimAtRandom(c.x, c.z);
    if (aim) return { x: c.x, z: c.z, ...aim };
    starts.push({ c, random: !plan.spots });
  }
  // No safe start: the least risky random drop, else the nearest start facing the longest clear run.
  let least = null;
  for (const { c, random } of starts) {
    const aim = random ? aimAtRandom(c.x, c.z, true) : null;
    if (aim && (!least || aim.risk < least.risk - 1e-9)) least = { x: c.x, z: c.z, ...aim };
  }
  if (least) return least;
  for (const { c } of starts) {
    const run = longestRun(c.x, c.z);
    if (run !== null) return { x: c.x, z: c.z, heading: run, school: null, risk: 1 };
  }
  return null;

  // The heading (every 5°) with the longest clear run out to 400 m; null when even the first 100 m is blocked.
  function longestRun(x, z) {
    let best = null;
    let bestLen = 99;
    for (let deg = 0; deg < 360; deg += 5) {
      const a = (deg * Math.PI) / 180;
      const len = clearTo(x, z, a, 400);
      if (len > bestLen) {
        best = a;
        bestLen = len;
      }
    }
    return best;
  }
}

// seasonStartPose for a place's arrival pose as { x, z, heading } (null when it finds nothing), at that port: no nearer
// another working port than this one (ports within SAME_HARBOR m of it share its waters). Kept in `cache` (a Map,
// optional) by place, pose and net depth.
export const SAME_HARBOR = 600;
export function seasonPoseFor(placeId, pose, { sea, places = [], closedWaters = null, netDepth = SEASON_START.netDepth, limit = SEASON_START.limit, cache = null } = {}) {
  if (!validPose(pose)) return null;
  const key = `${placeId}:${Math.round(pose.x)}:${Math.round(pose.z)}:${netDepth}`;
  if (cache?.has(key)) return cache.get(key);
  const place = (places ?? []).find((p) => p?.id === placeId && validPose(p)) ?? null;
  const others = place
    ? places.filter((q) => q && q !== place && !q.memorial && WORKING_KINDS.includes(q.kind) && validPose(q) && Math.hypot(q.x - place.x, q.z - place.z) > SAME_HARBOR)
    : [];
  const r = seasonStartPose(pose, sea, { place, others, closedWaters, netDepth, limit });
  const out = r ? { x: r.x, z: r.z, heading: r.heading } : null;
  cache?.set(key, out);
  return out;
}

// A pose outside every closed-water circle ([{ x, z, radius }]): unchanged when already clear, else the nearest point
// just beyond the circle it is in (margin m) that isOk(x, z) accepts (open water with sea room) and no other circle
// covers, facing `face` when given. null when nothing qualifies.
export function clearOfClosedWaters(pose, closedWaters, { isOk = () => true, face = null, margin = 60, steps = 72 } = {}) {
  if (!validPose(pose)) return null;
  const circles = (closedWaters ?? []).filter((c) => c && Number.isFinite(c.x) && Number.isFinite(c.z) && Number.isFinite(c.radius));
  const inside = (x, z) => circles.find((c) => Math.hypot(x - c.x, z - c.z) < c.radius) ?? null;
  const c = inside(pose.x, pose.z);
  if (!c) return pose;
  const a0 = Math.atan2(pose.z - c.z, pose.x - c.x);
  for (let ring = 0; ring < 6; ring++) {
    const r = c.radius + margin + ring * 40;
    for (let i = 0; i <= steps; i++) {
      // Alternate either side of the direction the pose already lies in: the smallest move out of the markers.
      const k = i === 0 ? 0 : (i % 2 ? 1 : -1) * Math.ceil(i / 2);
      const a = a0 + (k * Math.PI * 2) / steps;
      const x = c.x + Math.cos(a) * r;
      const z = c.z + Math.sin(a) * r;
      if (inside(x, z) || !isOk(x, z)) continue;
      const heading = face && Number.isFinite(face.x) && Math.hypot(face.x - x, face.z - z) > 1 ? Math.atan2(face.x - x, -(face.z - z)) : pose.heading ?? 0;
      return { x, z, heading };
    }
  }
  return null;
}
