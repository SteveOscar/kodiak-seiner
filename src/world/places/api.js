// Public places API (SPEC §6.5) as pure logic over the resolved data: no THREE, no DOM, so tests build it in Node.

import { resolve, pointInPolygon, isDeveloped, SPAWN } from '../../data/places.js';

// filter: undefined | (place) => bool | kind string | [kinds]
function asFilter(filter) {
  if (!filter) return () => true;
  if (typeof filter === 'function') return filter;
  if (Array.isArray(filter)) return (p) => filter.includes(p.kind);
  if (typeof filter === 'string') return (p) => p.kind === filter;
  return () => true;
}

export function createPlacesApi({ geo, heightmap = null }) {
  const r = resolve(geo);
  const byId = new Map(r.places.map((p) => [p.id, p]));
  const streamById = new Map(r.streams.map((s) => [s.id, s]));

  const s0 = geo.toWorld(SPAWN.lat, SPAWN.lon);
  let spawn = { x: s0.x, z: s0.z, heading: (SPAWN.heading * Math.PI) / 180 };
  if (heightmap && heightmap.shoreDistance(spawn.x, spawn.z) < 60) {
    const w = heightmap.nearestWater(spawn.x, spawn.z, { minShore: 80 });
    if (w) spawn = { ...spawn, x: w.x, z: w.z };
  }

  const districtOf = (x, z) => r.districts.find((d) => d.polygon.length > 2 && pointInPolygon(x, z, d.polygon)) ?? null;

  const api = {
    list: r.places,
    streams: r.streams,
    districts: r.districts,
    closedAreas: r.closedAreas,
    footprints: r.footprints,
    spawn,

    get: (id) => byId.get(id) ?? null,
    stream: (id) => streamById.get(id) ?? null,

    nearest(x, z, filter) {
      const f = asFilter(filter);
      let best = null;
      let bd = Infinity;
      for (const p of r.places) {
        if (!f(p)) continue;
        const d = (p.x - x) ** 2 + (p.z - z) ** 2;
        if (d < bd) {
          bd = d;
          best = p;
        }
      }
      return best ? { place: best, distance: Math.sqrt(bd) } : null;
    },

    // Places within r metres, nearest first.
    within(x, z, rad, filter) {
      const f = asFilter(filter);
      const out = [];
      for (const p of r.places) {
        if (!f(p)) continue;
        const d = (p.x - x) ** 2 + (p.z - z) ** 2;
        if (d <= rad * rad) out.push([d, p]);
      }
      out.sort((a, b) => a[0] - b[0]);
      return out.map((e) => e[1]);
    },

    // Place whose discovery radius contains (x, z) (smallest radius wins), or null.
    placeAt(x, z, filter) {
      const f = asFilter(filter);
      let best = null;
      for (const p of r.places) {
        if (!f(p)) continue;
        if ((p.x - x) ** 2 + (p.z - z) ** 2 <= p.radius * p.radius && (!best || p.radius < best.radius)) best = p;
      }
      return best;
    },

    districtAt(x, z) {
      return districtOf(x, z)?.name ?? 'Northeast Kodiak';
    },
    districtIdAt(x, z) {
      return districtOf(x, z)?.id ?? 'northeast';
    },

    nearestStream(x, z, maxDist = Infinity) {
      let best = null;
      let bd = Infinity;
      for (const s of r.streams) {
        const d = Math.hypot(s.x - x, s.z - z);
        if (d < bd && d <= maxDist) {
          bd = d;
          best = s;
        }
      }
      return best ? { stream: best, distance: bd } : null;
    },

    // Closed waters (stream mouths within closedRadius, extra CLOSED_AREAS) containing (x, z), or null.
    closedAt(x, z) {
      for (const s of r.streams) {
        if ((s.x - x) ** 2 + (s.z - z) ** 2 <= s.closedRadius ** 2) return { kind: 'stream', id: s.id, name: s.name, x: s.x, z: s.z, radius: s.closedRadius };
      }
      for (const c of r.closedAreas) {
        if ((c.x - x) ** 2 + (c.z - z) ** 2 <= c.radius ** 2) return { kind: 'area', id: c.id, name: c.name, x: c.x, z: c.z, radius: c.radius, reason: c.reason };
      }
      return null;
    },

    isDeveloped: (x, z) => isDeveloped(x, z, geo),
  };
  return api;
}
