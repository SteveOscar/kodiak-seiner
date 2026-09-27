// Real-world lat/lon <-> game world (x, z). Must stay consistent with tools/fetch-dem.mjs, which wrote
// public/terrain/kodiak_meta.json. The frame is a local equirectangular projection centred at (LAT0, LON0) with a
// uniform horizontal scale of worldHalf metres per HALF_KM kilometres (~1:11.75).

export const LAT0 = 57.65;
export const LON0 = -153.4;
const HALF_KM = 94;
const KM_PER_DEG_LAT = 111.2;
const KM_PER_DEG_LON = 111.32 * Math.cos((LAT0 * Math.PI) / 180);

export function createGeo(worldHalf) {
  const metresPerKm = worldHalf / HALF_KM; // game metres per real kilometre
  return {
    metresPerKm,
    // Game metres per real metre (horizontal).
    horizontalScale: metresPerKm / 1000,

    toWorld(lat, lon) {
      const xKm = (lon - LON0) * KM_PER_DEG_LON;
      const nKm = (lat - LAT0) * KM_PER_DEG_LAT;
      return { x: xKm * metresPerKm, z: -nKm * metresPerKm };
    },

    toLatLon(x, z) {
      return {
        lat: LAT0 + -z / metresPerKm / KM_PER_DEG_LAT,
        lon: LON0 + x / metresPerKm / KM_PER_DEG_LON,
      };
    },

    // Nautical miles represented by a game distance (for HUD/chart labels).
    toNauticalMiles(metres) {
      return metres / metresPerKm / 1.852;
    },

    // Displayed knots for a game speed in m/s. Boats move far faster than the 1:11.75 map scale implies, so this is a
    // display fiction tuned so the base seiner's 12 m/s top speed reads as a realistic ~11 kn.
    toKnots(ms) {
      return ms * 0.92;
    },
  };
}
