// Start-location choices for a new game (the title screen's "Where do you start?" panel). Pure: no DOM, no ctx.
//
// New Season offers the working ports (towns, villages, harbors, canneries), the City of Kodiak first and
// recommended (its own harbors and cannery row fold into it); Free Explore offers every non-memorial place plus
// "Surprise me", Kodiak first. The City of Kodiak starts at the classic spawn (places.spawn); every other place starts
// at its Free Explore arrival pose (season.travel.teleportTargets(): open water, facing the place).
//
//   buildStartOptions({ mode: 'season'|'explore', places, districts, targets, spawn, closedWaters?, isOpenWater? })
//     → [{ id, placeId, name, kind, kindLabel, district, districtName, group, groupName, line, blurb, services,
//          recommended, home, surprise, pose: { x, z, heading } | null }]
//   filterStartOptions(options, query)    search by name, kind, district or nearby grounds ("Surprise me" only unfiltered)
//   groupStartOptions(options)            [{ id, name, options }] in list order
//   preselectIndex(options, lastId)       the remembered choice, else Kodiak, else 0
//   startAtFor(option)                    ctx.game.start's startAt: null for Kodiak (the classic spawn), else the pose
//   pickSurprise(options, random)         a random place from the list (any option with a pose)
//   readLastStart(storage) / rememberStart(storage, mode, id)   last choice per mode (localStorage-like storage)
//   clearOfClosedWaters(pose, closedWaters, { isOk, face })      a New Season start outside the stream closures
//                                         (the Karluk arrival sits inside the Karluk River markers)

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

// closedWaters ([{ x, z, radius }], season.closedWaters) and isOpenWater(x, z) move a New Season start that would
// sit inside stream markers to just outside them (Free Explore keeps the teleport pose: fishing is always open there).
export function buildStartOptions({ mode = 'season', places = [], districts = [], targets = [], spawn = null, closedWaters = null, isOpenWater = null } = {}) {
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
    if (!explore && !home && closedWaters?.length) pose = clearOfClosedWaters(pose, closedWaters, { isOk: isOpenWater ?? undefined, face: p }) ?? pose;
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

export function filterStartOptions(options, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return [...(options ?? [])];
  return (options ?? []).filter(
    (o) => !o.surprise && [o.name, o.kindLabel, o.districtName, ...(o.grounds ?? [])].some((s) => String(s ?? '').toLowerCase().includes(q)),
  );
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
