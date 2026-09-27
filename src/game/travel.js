// Fast travel from the chart, plus the fade used by every "time passes" transition (travel, tow, sleep, waiting for
// an opener, tying up).
//
// Rules (SPEC §6.15): only with control 'boat', fishing idle and the skiff stowed; targets are a place's dock or a
// tender standoff (heightmap.nearestWater({minShore: 40})). Cost: the run takes the chart distance in nautical miles
// divided by the displayed cruising speed (70% of maxSpeed in knots) in game hours — the numbers the HUD and chart
// show — and burns fuel at 60% engine load for that time. Then clock.skip + game.teleport. Distance follows water
// (Dijkstra over the heightmap, src/game/data/route.js); where the chart has no water connection (the DEM closes
// Kupreanof Strait and Whale Passage) the run is estimated at 1.35× the straight line.
//
//   const t = createTravel(ctx)   (season exposes one as ctx.systems.season.travel)
//   t.targets()                   [{ id, kind: 'place'|'tender', name, x, z, heading, placeId?, tenderId?, discovered }]
//   t.preview(target)             { ok, reason, name, distance, nm, hours, gallons, fuelCost, arrive: {day, hours, label},
//                                   warnings: [..], route: [{x, z}], reachable }
//   t.go(target)                  same shape; performs the trip (the map UI closes itself afterwards)
// target: a target from targets(), a place id, a place object, a tender object or { kind, id }.

import { createRoutePlanner } from './data/route.js';
import { fuelBurnPerHour, fuelPriceAt, round2 } from './data/market.js';
import { dateOf, clockLabel, isOpenAt, nextOpenerAfter } from './data/calendar.js';

export const TRAVEL_SPEED_FRACTION = 0.7;
export const TRAVEL_LOAD = 0.6;
export const NO_ROUTE_FACTOR = 1.35;
const TENDER_ABEAM = 12; // m between the tender's centreline and the seiner's: rafted up on the starboard side, fenders out

// ---- fade overlay (DOM; a no-op under Node) ----

let fadeEl = null;
let fadeTimer = null;
export function showFade(ctx, { title = '', subtitle = '', holdMs = 900, fadeMs = 1100 } = {}) {
  if (typeof ctx?.systems?.ui?.fade === 'function') {
    try {
      ctx.systems.ui.fade({ title, subtitle, holdMs, fadeMs });
      return;
    } catch {
      // fall through to our own overlay
    }
  }
  if (typeof document === 'undefined' || !document.body) return;
  if (!fadeEl) {
    fadeEl = document.createElement('div');
    fadeEl.className = 'kodiak-rules-fade';
    Object.assign(fadeEl.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '60',
      pointerEvents: 'none',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '10px',
      background: 'radial-gradient(ellipse at center, #0b1620 0%, #05090d 70%)',
      color: '#ece6da',
      opacity: '0',
      transition: 'none',
    });
    const t = document.createElement('div');
    Object.assign(t.style, { font: "400 34px/1.2 Georgia, 'Iowan Old Style', serif", letterSpacing: '0.02em', textShadow: '0 2px 18px rgba(0,0,0,0.6)' });
    const s = document.createElement('div');
    Object.assign(s.style, { font: '500 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif', letterSpacing: '0.18em', textTransform: 'uppercase', color: '#b9c3c8' });
    const rule = document.createElement('div');
    Object.assign(rule.style, { width: '48px', height: '2px', background: '#ff7a1a', opacity: '0.85' });
    fadeEl.append(t, rule, s);
    document.body.appendChild(fadeEl);
  }
  const [t, rule, s] = fadeEl.children;
  t.textContent = title;
  s.textContent = subtitle;
  rule.style.display = title ? 'block' : 'none';
  fadeEl.style.transition = 'none';
  fadeEl.style.opacity = '1';
  clearTimeout(fadeTimer);
  fadeTimer = setTimeout(() => {
    fadeEl.style.transition = `opacity ${fadeMs}ms ease-in-out`;
    fadeEl.style.opacity = '0';
  }, holdMs);
}

// Bow-in berth at a dock point: heading toward the shore (against the offshore gradient), backed off BERTH_OFFSET m.
export const BERTH_OFFSET = 10;
export function berthPose(heightmap, x, z, fallbackHeading = 0) {
  const g = heightmap.shoreGradient(x, z);
  if (Math.hypot(g.x, g.z) < 0.5) return { x, z, heading: fallbackHeading };
  const heading = Math.atan2(-g.x, g.z);
  return { x: x + g.x * BERTH_OFFSET, z: z + g.z * BERTH_OFFSET, heading: ((heading % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) };
}

export function durationLabel(hours) {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  if (h <= 0) return `${m} min`;
  if (m === 60) return `${h + 1} h`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

// ---- travel ----

export function createTravel(ctx) {
  const { config, heightmap, geo } = ctx;
  const planner = createRoutePlanner(heightmap, { half: config.world.half, boundary: config.world.boundary });
  let lastFrom = null;

  const seiner = () => ctx.systems.seiner;
  const places = () => ctx.systems.places?.list ?? [];
  const tenders = () => ctx.systems.fleet?.tenders ?? [];

  const dockCache = new Map();
  // Berth pose at a place: bow in to the pier head with the stern to open water (the chase camera then sits over the
  // water looking at the boat and the town), backed off the dock point so the bow clears the pier. Places without a
  // dock berth at the nearest open water.
  function dockOf(place) {
    const key = `${place.id}:${Math.round(place.x)}:${Math.round(place.z)}`;
    if (dockCache.has(key)) return dockCache.get(key);
    let d = null;
    if (place.dock && Number.isFinite(place.dock.x)) d = berthPose(heightmap, place.dock.x, place.dock.z, place.dock.heading ?? 0);
    else {
      const w = heightmap.nearestWater(place.x, place.z, { minShore: 30 });
      if (w) d = berthPose(heightmap, w.x, w.z, 0);
    }
    dockCache.set(key, d);
    return d;
  }

  function tenderStandoff(t) {
    const p = t.position ?? t.object3d?.position;
    if (!p) return null;
    const h = t.heading ?? 0;
    const sx = p.x + Math.cos(h) * TENDER_ABEAM;
    const sz = p.z + Math.sin(h) * TENDER_ABEAM;
    const w = heightmap.nearestWater(sx, sz, { minShore: 40 }) ?? { x: sx, z: sz };
    return { x: w.x, z: w.z, heading: h };
  }

  function isTravelPlace(p) {
    return !!p && !p.memorial && (p.dock || (p.services?.length ?? 0) > 0);
  }

  const api = {
    targets({ includeUndiscovered = false } = {}) {
      const disc = ctx.systems.discovery;
      const out = [];
      for (const p of places()) {
        if (!isTravelPlace(p)) continue;
        const discovered = p.id === 'kodiak' || !disc?.isDiscovered || disc.isDiscovered(p.id);
        if (!discovered && !includeUndiscovered) continue;
        const d = dockOf(p);
        if (d) out.push({ id: `place:${p.id}`, kind: 'place', placeId: p.id, name: p.name, services: p.services ?? [], discovered, ...d });
      }
      for (const t of tenders()) {
        const s = tenderStandoff(t);
        if (s) out.push({ id: `tender:${t.id}`, kind: 'tender', tenderId: t.id, name: t.name, services: t.services ?? [], discovered: true, buying: t.buying !== false, ...s });
      }
      return out;
    },

    resolveTarget(target) {
      if (!target) return null;
      if (typeof target === 'string') {
        const [kind, id] = target.includes(':') ? target.split(':') : ['place', target];
        return api.resolveTarget({ kind, id });
      }
      if (target.kind === 'tender' || target.tenderId || target.buying !== undefined && target.services && !target.kind) {
        const id = target.tenderId ?? target.id;
        const t = tenders().find((x) => x.id === id || `tender:${x.id}` === id) ?? (target.position ? target : null);
        const s = t && tenderStandoff(t);
        return s ? { id: `tender:${t.id}`, kind: 'tender', tenderId: t.id, name: t.name, ...s } : null;
      }
      const id = target.placeId ?? (typeof target.id === 'string' ? target.id.replace(/^place:/, '') : null);
      const p = ctx.systems.places?.get?.(id) ?? places().find((q) => q.id === id) ?? (Number.isFinite(target.x) && target.name ? target : null);
      if (!p) return null;
      const d = dockOf(p);
      return d ? { id: `place:${p.id}`, kind: 'place', placeId: p.id, name: p.name, services: p.services ?? [], ...d } : null;
    },

    canTravel() {
      const mode = ctx.state.mode;
      if (mode !== 'play' && mode !== 'map' && mode !== 'paused') return { ok: false, reason: 'Not now' };
      if (ctx.state.control !== 'boat') return { ok: false, reason: 'Get back aboard first' };
      if ((ctx.systems.fishing?.state ?? 'idle') !== 'idle') return { ok: false, reason: 'Finish the set first' };
      if ((ctx.systems.skiff?.state ?? 'stowed') !== 'stowed') return { ok: false, reason: 'Get the skiff aboard first' };
      if (!seiner()) return { ok: false, reason: 'No boat' };
      return { ok: true };
    },

    preview(target) {
      const t = api.resolveTarget(target);
      if (!t) return { ok: false, reason: 'Unknown destination' };
      const s = seiner();
      const from = s?.position ?? { x: 0, z: 0 };
      const key = `${Math.round(from.x / 50)}:${Math.round(from.z / 50)}`;
      if (key !== lastFrom) {
        planner.invalidate();
        lastFrom = key;
      }
      const r = planner.route(from.x, from.z, t.x, t.z);
      const distance = r.reachable ? r.distance : r.straight * NO_ROUTE_FACTOR;
      const nm = geo.toNauticalMiles(distance);
      const maxSpeed = s?.maxSpeed ?? ctx.systems.economy?.modifiers?.maxSpeed ?? config.boat.maxSpeed;
      const knots = geo.toKnots(TRAVEL_SPEED_FRACTION * maxSpeed);
      const hours = nm / Math.max(0.5, knots);
      const free = !!ctx.state.freeExplore;
      const gallons = free ? 0 : Math.ceil(hours * fuelBurnPerHour(TRAVEL_LOAD, config.economy));
      const eco = ctx.systems.economy;
      const fuelCost = round2(gallons * fuelPriceAt({ kind: 'town' }, config.economy));
      const clock = ctx.clock;
      const endAbs = clock.day * 24 + clock.hours + hours;
      const arriveDay = Math.floor(endAbs / 24);
      const arriveHours = endAbs - arriveDay * 24;
      const warnings = [];
      const season = ctx.systems.season;
      const openNow = season?.openerActive?.() ?? isOpenAt(config, clock.day, clock.hours);
      const openThen = isOpenAt(config, arriveDay, arriveHours);
      if (openNow && !openThen) warnings.push('The period closes before you arrive');
      else if (openNow) warnings.push(`Costs ${durationLabel(hours)} of the open period`);
      const nx = nextOpenerAfter(config, clock.day, clock.hours);
      if (nx && !openNow && endAbs > nx.day * 24 + nx.hours) warnings.push('You will miss the start of the next opener');
      if (!r.reachable) warnings.push('No charted water route — running the long way round');
      const out = {
        ok: true,
        target: t,
        name: t.name,
        kind: t.kind,
        distance: Math.round(distance),
        nm: Math.round(nm * 10) / 10,
        knots: Math.round(knots * 10) / 10,
        hours,
        duration: durationLabel(hours),
        gallons,
        fuelCost,
        arrive: { day: arriveDay, hours: arriveHours, label: `${dateOf(config, arriveDay).weekdayShort} ${dateOf(config, arriveDay).label}, ${clockLabel(arriveHours)}` },
        warnings,
        reachable: r.reachable,
        route: r.path,
      };
      const can = api.canTravel();
      if (!can.ok) return { ...out, ok: false, reason: can.reason };
      if (Math.hypot(t.x - from.x, t.z - from.z) < 60) return { ...out, ok: false, reason: 'You are already here' };
      if (!free && eco && gallons > (eco.fuel ?? 0)) return { ...out, ok: false, reason: `Not enough fuel (${gallons.toLocaleString('en-US')} gal needed)` };
      return out;
    },

    go(target) {
      const p = api.preview(target);
      if (!p.ok) return p;
      const s = seiner();
      const t = p.target;
      showFade(ctx, { title: `Running to ${t.name}`, subtitle: `${p.nm} nm · ${p.duration}${p.gallons ? ` · ${p.gallons.toLocaleString('en-US')} gal` : ''}`, holdMs: 1300, fadeMs: 1200 });
      if (s?.mooring) s.setMooring?.(null);
      ctx.game.teleport(t.x, t.z, t.heading, { reason: 'travel' });
      ctx.clock.skip(p.hours, 'travel');
      if (p.gallons) ctx.systems.economy?.useFuel?.(p.gallons, 'travel');
      if (t.kind === 'place') s?.setMooring?.({ kind: 'dock', placeId: t.placeId });
      planner.invalidate();
      lastFrom = null;
      ctx.events.emit('travel:arrived', { id: t.id, name: t.name, kind: t.kind, hours: p.hours, gallons: p.gallons, nm: p.nm });
      return p;
    },

    invalidate() {
      planner.invalidate();
      lastFrom = null;
    },
  };
  return api;
}
