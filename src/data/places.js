// Named places, salmon streams, fishing districts and developed footprints of the Kodiak archipelago.
// Pure data + helpers (no THREE, no DOM): importable from any module and from Node tests.
//
// Export names and function signatures are FROZEN (other work packages import them statically). WP-PLACES owns the
// contents and may add fields; never rename or remove one.
//
// Place:     { id, name, kind, lat, lon, radius (discovery, game m), blurb, services?, onFoot?, landing?, dock?,
//              model?, district?, memorial? }
//            kind: town | village | harbor | cannery | hatchery | landmark | cape | bay | strait | island | river |
//                  lake | peak | lighthouse | wildlife | history | viewpoint
//            services ⊆ ['sell','fuel','upgrades','ice','rest']; dock = { lat, lon, heading } (water point to tie up)
//            landing = { lat, lon } beach where the skiff lands for onFoot places
//            memorial: true → quiet logbook card, no bonus, no celebratory toast (e.g. Awa'uq / Refuge Rock)
// Stream:    { id, name, lat, lon (mouth), species: [...], closedRadius (game m, 150–350) }
// District:  { id, name, label: { lat, lon }, polygon: [{ lat, lon }, ...] }
// Footprint: { id, lat, lon, radius (game m) } — developed ground: terrain skips vegetation here
// Closed:    { id, name, lat, lon, radius (game m), reason } — extra no-fishing / no-approach zones (e.g. Marmot
//            Island sea lion rookery buffer)

export const PLACES = [
  {
    id: 'kodiak',
    name: 'City of Kodiak',
    kind: 'town',
    lat: 57.79,
    lon: -152.407,
    radius: 450,
    blurb:
      "Alaska's largest fishing port by value in most years, on the site of the Alutiiq village of Sun'aq. Russian traders moved here from Three Saints Bay in the 1790s.",
    services: ['sell', 'fuel', 'upgrades', 'ice', 'rest'],
    dock: { lat: 57.787, lon: -152.398, heading: 2.4 },
    district: 'northeast',
  },
];

export const STREAMS = [
  { id: 'karluk', name: 'Karluk River', lat: 57.57, lon: -154.46, species: ['sockeye', 'pink', 'coho'], closedRadius: 250 },
];

export const DISTRICTS = [];

export const FOOTPRINTS = [{ id: 'kodiak', lat: 57.79, lon: -152.407, radius: 350 }];

export const CLOSED_AREAS = [];

// Resolves lat/lon to world coordinates with ctx.geo (or createGeo(config.world.half)).
// → { places: [{ ...p, x, z, dock?: { x, z, heading }, landing?: { x, z } }], streams: [{ ...s, x, z }],
//     districts: [{ ...d, label: { x, z }, polygon: [{ x, z }] }], footprints: [{ ...f, x, z }],
//     closedAreas: [{ ...c, x, z }] }
export function resolve(geo) {
  const at = (o) => ({ ...o, ...geo.toWorld(o.lat, o.lon) });
  return {
    places: PLACES.map((p) => {
      const r = at(p);
      if (p.dock) r.dock = { ...geo.toWorld(p.dock.lat, p.dock.lon), heading: p.dock.heading ?? 0 };
      if (p.landing) r.landing = geo.toWorld(p.landing.lat, p.landing.lon);
      return r;
    }),
    streams: STREAMS.map(at),
    districts: DISTRICTS.map((d) => ({
      ...d,
      label: geo.toWorld(d.label.lat, d.label.lon),
      polygon: (d.polygon ?? []).map((q) => geo.toWorld(q.lat, q.lon)),
    })),
    footprints: FOOTPRINTS.map(at),
    closedAreas: CLOSED_AREAS.map(at),
  };
}

let footprintCache = null;
let footprintGeo = null;

// True when (x, z) lies inside a developed footprint.
export function isDeveloped(x, z, geo) {
  if (!footprintCache || footprintGeo !== geo) {
    footprintCache = FOOTPRINTS.map((f) => ({ ...geo.toWorld(f.lat, f.lon), r2: f.radius * f.radius }));
    footprintGeo = geo;
  }
  for (const f of footprintCache) {
    const dx = x - f.x;
    const dz = z - f.z;
    if (dx * dx + dz * dz < f.r2) return true;
  }
  return false;
}

// Point-in-polygon for district lookup; polygon = [{ x, z }].
export function pointInPolygon(x, z, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}
