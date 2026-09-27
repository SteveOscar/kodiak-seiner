// Discovery (WP-RULES): entering a place's radius discovers it (toast, logbook card, $25–$100 token; memorials are
// quiet), streams and fishing places add chart intel (run-timing cards and hot-spot notes), wildlife sightings for
// the logbook, fish sightings from binoculars / summit perches / the spotter plane for chart and compass markers.
// Rules live in src/game/data/intel.js.

import { resolve as resolvePlaces } from '../data/places.js';
import { discoveryBonus, yieldsIntel, notableSpecies, runTimingText, hotspotText, NICK, WILDLIFE, wildlifeKind } from './data/intel.js';
import { dateOf as calDate, clockLabel } from './data/calendar.js';

const CHECK_INTERVAL = 0.2; // s
const STREAM_REACH = 300; // m beyond a stream's closed-waters radius that counts as "seen the mouth"
const PERCH_RANGE = 3000;
const FISH_MARK_LIMIT = 48;
const FISH_MARK_HOURS = 3; // game hours a fish mark stays on the chart
const COMPASS8 = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];

export async function create(ctx) {
  const { clock, events, heightmap, config } = ctx;
  const staticData = resolvePlaces(ctx.geo);
  const dateOf = (d) => calDate(config, d);

  const discovered = new Set();
  const info = new Map(); // id → { day, hours, bonus }
  const sightings = new Set(); // records: { type: 'wildlife'|'fish', ... }
  const intel = [];
  const perches = [];
  const inside = new Set();
  const lastMark = new Map(); // schoolId → abs hours of the last mark
  let checkT = 0;
  let spotterT = 0;
  let spotterCallAt = -99;

  const places = () => ctx.systems.places?.list ?? staticData.places;
  const streams = () => ctx.systems.places?.streams ?? staticData.streams;
  const absHours = () => clock.day * 24 + clock.hours;
  const ui = () => ctx.systems.ui;

  function findPlace(id) {
    return ctx.systems.places?.get?.(id) ?? places().find((p) => p.id === id) ?? null;
  }
  function findStream(id) {
    const sid = String(id).replace(/^stream:/, '');
    return streams().find((s) => s.id === sid) ?? null;
  }

  // ---- intel ----

  function streamsNear(x, z, r) {
    return streams().filter((s) => Math.hypot(s.x - x, s.z - z) <= r);
  }

  function addIntel(entry) {
    if (intel.some((i) => i.id === entry.id)) return null;
    const tide = /flood/.test(entry.text) ? 'flood' : /ebb/.test(entry.text) ? 'ebb' : /slack/.test(entry.text) ? 'slack' : null;
    const e = { ...entry, tide, day: clock.day };
    intel.push(e);
    return e;
  }

  // Unit vector toward open water: the shore gradient, or the deepest of 8 directions where the gradient is flat.
  function offshoreDir(x, z) {
    const g = heightmap.shoreGradient(x, z);
    if (Math.hypot(g.x, g.z) > 0.5) return g;
    let best = { x: 0, z: 1 };
    let bd = -Infinity;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const d = heightmap.shoreDistance(x + Math.cos(a) * 300, z + Math.sin(a) * 300);
      if (d > bd) {
        bd = d;
        best = { x: Math.cos(a), z: Math.sin(a) };
      }
    }
    return best;
  }

  // Open water at least minDist from (x, z), searching out along the offshore direction and then fanning round.
  function outsidePoint(x, z, minDist, minShore) {
    const g = offshoreDir(x, z);
    const base = Math.atan2(g.z, g.x);
    for (const off of [0, 0.5, -0.5, 1, -1, 1.6, -1.6, Math.PI]) {
      const a = base + off;
      for (let r = minDist; r <= minDist + 700; r += 35) {
        const px = x + Math.cos(a) * r;
        const pz = z + Math.sin(a) * r;
        if (heightmap.shoreDistance(px, pz) >= minShore) return { x: px, z: pz };
      }
    }
    // Hemmed in (a lagoon or narrow arm): take the widest water just outside the closed radius.
    let best = null;
    let bd = 0;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const px = x + Math.cos(a) * minDist;
      const pz = z + Math.sin(a) * minDist;
      const d = heightmap.shoreDistance(px, pz);
      if (d > bd) {
        bd = d;
        best = { x: px, z: pz };
      }
    }
    return best ?? hotspotPoint(x, z, minShore);
  }

  function hotspotPoint(x, z, minShore) {
    return heightmap.nearestWater(x, z, { minShore, maxRadius: 1500 }) ?? { x, z };
  }

  // A river place and the stream it names are one fishery: its intel is the stream's.
  function streamForRiver(p) {
    const name = String(p.name ?? '').toLowerCase();
    let best = null;
    let bd = 900;
    for (const s of streams()) {
      const d = Math.hypot(s.x - p.x, s.z - p.z);
      const same = name && String(s.name ?? '').toLowerCase() === name;
      if (same || d < bd) {
        best = s;
        bd = same ? -1 : d;
      }
    }
    return best;
  }

  function intelForPlace(p) {
    if (!yieldsIntel(p)) return [];
    if (p.kind === 'river') {
      const s = streamForRiver(p);
      if (s) {
        discovered.add(`stream:${s.id}`);
        if (!info.has(`stream:${s.id}`)) info.set(`stream:${s.id}`, { day: clock.day, hours: clock.hours, bonus: 0 });
        return intelForStream(s);
      }
    }
    const near = streamsNear(p.x, p.z, 2500);
    const mix = ctx.systems.season?.speciesMix?.(p.x, p.z) ?? null;
    const species = notableSpecies(mix, near.flatMap((s) => s.species ?? []));
    const out = [];
    const minShore = p.kind === 'cape' ? 80 : 60;
    const pt = hotspotPoint(p.x, p.z, minShore);
    const hot = addIntel({ id: `intel:${p.id}:hot`, placeId: p.id, kind: 'hotspot', title: p.name, text: hotspotText(p.kind, p.name, species, p.id), x: pt.x, z: pt.z, species });
    if (hot) out.push(hot);
    if (p.kind === 'river' || p.kind === 'hatchery') {
      const runSpecies = species.filter((s) => config.fish.runs[s]);
      const card = addIntel({ id: `intel:${p.id}:run`, placeId: p.id, kind: 'run', title: `${p.name} run timing`, text: runTimingText(runSpecies, config.fish.runs, dateOf), x: p.x, z: p.z, species: runSpecies });
      if (card) out.push(card);
    }
    return out;
  }

  function intelForStream(s) {
    const species = (s.species ?? []).filter((k) => k !== 'king' && config.fish.runs[k]);
    const out = [];
    const card = addIntel({ id: `intel:stream:${s.id}:run`, streamId: s.id, kind: 'run', title: `${s.name} run timing`, text: `${runTimingText(species, config.fish.runs, dateOf)}. Closed waters ${Math.round(s.closedRadius ?? 200)} m around the mouth — stay outside the ADF&G markers.`, x: s.x, z: s.z, species });
    if (card) out.push(card);
    const pt = outsidePoint(s.x, s.z, (s.closedRadius ?? 200) + 80, 40);
    const hot = addIntel({ id: `intel:stream:${s.id}:hot`, streamId: s.id, kind: 'hotspot', title: s.name, text: hotspotText('stream', s.name, notableSpecies(null, species), s.id), x: pt.x, z: pt.z, species });
    if (hot) out.push(hot);
    return out;
  }

  // ---- discovery ----

  function discover(id, { silent = false } = {}) {
    if (!id || discovered.has(id)) return false;
    const isStream = String(id).startsWith('stream:');
    const p = isStream ? findStream(id) : findPlace(id);
    if (!p) return false;
    discovered.add(id);
    const memorial = !!p.memorial;
    const explore = !!ctx.state.freeExplore;
    const bonus = silent || memorial || explore || isStream ? 0 : discoveryBonus(p);
    info.set(id, { day: clock.day, hours: clock.hours, bonus });
    const newIntel = memorial ? [] : isStream ? intelForStream(p) : intelForPlace(p);
    if (silent) return true;
    if (bonus > 0) ctx.systems.economy?.addCash?.(bonus, `discovery: ${p.name}`);
    if (!memorial) {
      const extra = newIntel.length ? ' · chart note added' : '';
      const text = isStream ? `${p.name} · salmon stream — run timing on the chart` : `Discovered ${p.name}${bonus ? ` · +$${bonus}` : ''}${extra}`;
      ui()?.toast?.(text, { kind: 'discovery', duration: 5 });
      if (discovered.size >= 2) ui()?.hint?.('discovery', 'New places go in the logbook (L). Bays, capes and streams add fishing notes to the chart (M).');
    }
    events.emit('place:discovered', { id, name: p.name, kind: isStream ? 'stream' : p.kind, memorial, bonus, intel: newIntel.map((i) => i.id) });
    return true;
  }

  function checkAvatar() {
    const a = ctx.game?.avatar?.() ?? (ctx.systems.seiner?.position ? { ...ctx.systems.seiner.position, control: ctx.state.control } : null);
    if (!a || !Number.isFinite(a.x)) return;
    const onFoot = a.control === 'foot';
    for (const p of places()) {
      if (!Number.isFinite(p.x)) continue;
      const allowed = !p.onFoot || onFoot;
      const r = p.radius ?? 300;
      const d2 = (p.x - a.x) ** 2 + (p.z - a.z) ** 2;
      const isIn = inside.has(p.id);
      if (allowed && d2 <= r * r) {
        if (!isIn) {
          inside.add(p.id);
          events.emit('place:enter', { id: p.id });
        }
        if (!discovered.has(p.id)) discover(p.id);
      } else if (isIn && (!allowed || d2 > r * r * 1.21)) {
        inside.delete(p.id);
        events.emit('place:leave', { id: p.id });
      }
    }
    for (const s of streams()) {
      const id = `stream:${s.id}`;
      if (discovered.has(id) || !Number.isFinite(s.x)) continue;
      const r = (s.closedRadius ?? 200) + STREAM_REACH;
      if ((s.x - a.x) ** 2 + (s.z - a.z) ** 2 <= r * r) discover(id);
    }
  }

  // ---- sightings ----

  function fishRecords() {
    return [...sightings].filter((s) => s.type === 'fish');
  }

  function addSighting(s) {
    if (!s) return null;
    let { x, z } = s;
    const school = s.schoolId !== undefined ? ctx.systems.fish?.schools?.find((q) => q.id === s.schoolId) : null;
    if ((!Number.isFinite(x) || !Number.isFinite(z)) && school?.position) {
      x = school.position.x;
      z = school.position.z;
    }
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      const p = ctx.systems.seiner?.position;
      if (!p) return null;
      x = p.x;
      z = p.z;
    }
    const t = absHours();
    const rec = {
      type: 'fish',
      source: s.source ?? 'binoculars',
      schoolId: s.schoolId ?? null,
      species: s.species ?? school?.species ?? null,
      heading: Number.isFinite(s.heading) ? s.heading : null,
      x,
      z,
      t,
      day: clock.day,
      hours: clock.hours,
    };
    if (rec.schoolId !== null) {
      for (const old of sightings) {
        if (old.type === 'fish' && old.schoolId === rec.schoolId && t - old.t < 0.34) {
          Object.assign(old, rec);
          events.emit('discovery:sighting', old);
          return old;
        }
      }
    }
    sightings.add(rec);
    const fish = fishRecords();
    if (fish.length > FISH_MARK_LIMIT) sightings.delete(fish.sort((a, b) => a.t - b.t)[0]);
    events.emit('discovery:sighting', rec);
    return rec;
  }

  function addWildlife(e) {
    const w = wildlifeKind(e?.kind);
    if (!w) return null;
    for (const s of sightings) if (s.type === 'wildlife' && s.kind === w.kind) return null;
    const rec = { type: 'wildlife', kind: w.kind, name: w.name, x: e.x ?? null, z: e.z ?? null, day: clock.day, hours: clock.hours, t: absHours() };
    sightings.add(rec);
    if (ctx.state.mode === 'play') ui()?.toast?.(`First sighting: ${w.name}`, { kind: 'wildlife', duration: 4.5 });
    events.emit('discovery:wildlife', { kind: w.kind, name: w.name });
    return rec;
  }

  function addPerch(placeId) {
    const p = findPlace(placeId);
    if (!p) return false;
    const existing = perches.find((q) => q.placeId === placeId && q.day === clock.day);
    if (existing) return true;
    const y = Math.max(0, heightmap.heightAt(p.x, p.z)) + 4;
    perches.push({ placeId, name: p.name, x: p.x, y, z: p.z, day: clock.day });
    while (perches.length > 12) perches.shift();
    ui()?.toast?.(`Spotting from ${p.name} — jumpers within 3 km in sight of the summit show on the chart today.`, { kind: 'info', duration: 5 });
    events.emit('discovery:perch', { placeId, day: clock.day });
    return true;
  }

  const activePerches = () => perches.filter((q) => q.day === clock.day);

  function visibleFrom(perch, x, z) {
    const dx = x - perch.x;
    const dz = z - perch.z;
    const dist = Math.hypot(dx, dz);
    if (dist > PERCH_RANGE) return false;
    const dy = 0.5 - perch.y;
    const len = Math.hypot(dx, dy, dz) || 1;
    const hit = heightmap.raymarch({ x: perch.x, y: perch.y, z: perch.z }, { x: dx / len, y: dy / len, z: dz / len }, len - 25);
    return hit < 0;
  }

  events.on('fish:jump', (e) => {
    if (ctx.state.mode !== 'play' || !e) return;
    const ps = activePerches();
    if (!ps.length) return;
    const key = e.schoolId ?? `${Math.round(e.x / 100)}:${Math.round(e.z / 100)}`;
    const t = absHours();
    if (t - (lastMark.get(key) ?? -99) < 0.25) return;
    lastMark.set(key, t);
    if (ps.some((p) => visibleFrom(p, e.x, e.z))) addSighting({ source: 'perch', schoolId: e.schoolId ?? null, species: e.species, heading: e.heading, x: e.x, z: e.z });
  });
  events.on('wildlife:sighted', (e) => addWildlife(e));
  // Home waters: a new season starts in the St. Paul Harbor approaches, and a Kodiak skipper already knows the places
  // around the spawn, so they are logged quietly instead of greeting the player with a burst of toasts.
  events.on('game:start', (e) => {
    if (!e?.newGame) return;
    const a = ctx.game?.avatar?.() ?? ctx.systems.seiner?.position;
    if (!a || !Number.isFinite(a.x)) return;
    for (const p of places()) {
      if (p.onFoot || p.memorial || !Number.isFinite(p.x)) continue;
      const r = p.radius ?? 300;
      if ((p.x - a.x) ** 2 + (p.z - a.z) ** 2 <= r * r) {
        discover(p.id, { silent: true });
        inside.add(p.id);
      }
    }
    for (const s of streams()) {
      const r = (s.closedRadius ?? 200) + STREAM_REACH;
      if (Number.isFinite(s.x) && (s.x - a.x) ** 2 + (s.z - a.z) ** 2 <= r * r) discover(`stream:${s.id}`, { silent: true });
    }
  });
  events.on('boat:teleport', () => {
    // Re-evaluate enclosure without spurious leave/enter pairs on the next check.
    inside.clear();
  });

  function spotterSweep() {
    const eco = ctx.systems.economy;
    const s = ctx.systems.seiner?.position;
    if (!s || !eco?.spotterActive) return;
    let biggest = null;
    for (const sc of ctx.systems.fish?.schools ?? []) {
      if (!sc?.position || sc.state === 'captured' || sc.state === 'gone') continue;
      const d = Math.hypot(sc.position.x - s.x, sc.position.z - s.z);
      if (d > 6000 || !eco.spotterActive(sc.position.x, sc.position.z)) continue;
      addSighting({ source: 'spotter', schoolId: sc.id, species: sc.species, heading: Math.atan2(sc.velocity?.x ?? 0, -(sc.velocity?.z ?? 1)), x: sc.position.x, z: sc.position.z });
      if (!biggest || (sc.count ?? 0) > (biggest.sc.count ?? 0)) biggest = { sc, d };
    }
    const t = absHours();
    if (biggest && t - spotterCallAt > 1.5) {
      spotterCallAt = t;
      const { sc, d } = biggest;
      const brg = (Math.atan2(sc.position.x - s.x, -(sc.position.z - s.z)) * 180) / Math.PI;
      const vx = sc.velocity?.x ?? 0;
      const vz = sc.velocity?.z ?? 0;
      const moving = sc.state === 'milling' || Math.hypot(vx, vz) < 0.2 ? 'milling' : `moving ${COMPASS8[Math.round((((Math.atan2(vx, -vz) * 180) / Math.PI + 360) % 360) / 45) % 8]}`;
      const miles = d / 1852;
      const dist = miles < 0.4 ? 'a quarter mile' : miles < 0.8 ? 'half a mile' : miles < 1.3 ? 'a mile' : `${Math.round(miles)} miles`;
      const me = ctx.systems.seiner?.boatName ?? 'Northern Dawn';
      const text = `${me}, Two-Seven Kilo. Good body of ${NICK[sc.species] ?? 'fish'} about ${dist} ${COMPASS8[Math.round(((brg + 360) % 360) / 45) % 8]} of you, ${moving}. I'll put 'em on your chart.`;
      ctx.systems.season?.radioSay?.({ from: 'Spotter Two-Seven Kilo', text, channel: '10' }, { priority: 3, ttl: 60 });
    }
  }

  function pruneFish() {
    const t = absHours();
    for (const s of sightings) if (s.type === 'fish' && t - s.t > FISH_MARK_HOURS) sightings.delete(s);
  }

  function silentHome() {
    if (findPlace('kodiak')) {
      discovered.add('kodiak');
      info.set('kodiak', { day: 0, hours: config.time.startHours, bonus: 0 });
    }
  }

  const sys = {
    discovered,
    sightings,
    intel,
    perches,
    isDiscovered: (id) => discovered.has(id),
    discover: (id) => discover(id),
    addSighting,
    addPerch,
    addWildlife,
    activePerches,

    // Fish marks for the chart and compass: [{...record, age 0..1}] newest first.
    recentSightings(maxAgeHours = FISH_MARK_HOURS) {
      const t = absHours();
      return fishRecords()
        .filter((s) => t - s.t <= maxAgeHours)
        .sort((a, b) => b.t - a.t)
        .map((s) => ({ ...s, age: Math.min(1, (t - s.t) / maxAgeHours) }));
    },
    wildlifeSeen() {
      return [...sightings].filter((s) => s.type === 'wildlife');
    },

    progress() {
      const all = places().filter((p) => !p.memorial);
      const found = all.filter((p) => discovered.has(p.id)).length;
      const st = streams();
      const seen = new Set(sys.wildlifeSeen().map((s) => s.kind));
      return {
        places: [found, all.length],
        streams: [st.filter((s) => discovered.has(`stream:${s.id}`)).length, st.length],
        wildlife: [seen.size, Math.max(WILDLIFE.length, seen.size)],
        intel: intel.length,
        memorials: places().filter((p) => p.memorial && discovered.has(p.id)).length,
      };
    },

    // Logbook cards in discovery order.
    cards() {
      const out = [];
      for (const id of discovered) {
        const isStream = id.startsWith('stream:');
        const p = isStream ? findStream(id) : findPlace(id);
        if (!p) continue;
        const i = info.get(id) ?? { day: 0, hours: 0, bonus: 0 };
        const notes = intel.filter((n) => n.placeId === p.id || (isStream && n.streamId === p.id)).map((n) => n.text);
        out.push({
          id,
          name: p.name,
          kind: isStream ? 'stream' : p.kind,
          blurb: p.blurb ?? (isStream ? `Salmon stream: ${(p.species ?? []).filter((s) => s !== 'king').map((s) => NICK[s]).join(', ')}.` : ''),
          memorial: !!p.memorial,
          day: i.day,
          date: dateOf(i.day).label,
          time: clockLabel(i.hours),
          bonus: i.bonus,
          intel: notes,
          x: p.x,
          z: p.z,
        });
      }
      return out.sort((a, b) => a.day - b.day || (info.get(a.id)?.hours ?? 0) - (info.get(b.id)?.hours ?? 0));
    },

    update(dt) {
      if (ctx.state.mode !== 'play') return;
      checkT += dt;
      spotterT += dt;
      if (checkT >= CHECK_INTERVAL) {
        checkT = 0;
        checkAvatar();
      }
      if (spotterT >= 20) {
        spotterT = 0;
        spotterSweep();
        pruneFish();
      }
    },

    debugState() {
      const p = sys.progress();
      return { places: p.places, streams: p.streams, wildlife: p.wildlife, intel: intel.length, fishMarks: fishRecords().length, inside: [...inside].slice(0, 4) };
    },

    serialize() {
      return {
        discovered: [...discovered],
        info: Object.fromEntries(info),
        sightings: [...sightings].map((s) => ({ ...s })),
        intel: intel.map((i) => ({ ...i })),
        perches: perches.map((q) => ({ ...q })),
      };
    },

    restore(d) {
      if (!d) return;
      discovered.clear();
      info.clear();
      sightings.clear();
      intel.length = 0;
      perches.length = 0;
      for (const id of d.discovered ?? []) if (typeof id === 'string') discovered.add(id);
      for (const [k, v] of Object.entries(d.info ?? {})) info.set(k, v);
      for (const s of d.sightings ?? []) if (s && (s.type === 'fish' || s.type === 'wildlife')) sightings.add({ ...s });
      for (const i of d.intel ?? []) if (i?.id && i.text) intel.push({ ...i });
      for (const q of d.perches ?? []) if (q?.placeId) perches.push({ ...q });
      silentHome();
    },

    reset() {
      discovered.clear();
      info.clear();
      sightings.clear();
      intel.length = 0;
      perches.length = 0;
      inside.clear();
      lastMark.clear();
      checkT = 0;
      spotterT = 0;
      silentHome();
    },
  };
  silentHome();
  return sys;
}
