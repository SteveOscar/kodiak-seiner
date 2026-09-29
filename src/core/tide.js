// Tide and surface current, shared by every system that drifts (net corks, skiff, seiner at rest, fish, flotsam).
// Sea level stays at y = 0 — there is no vertical tide in the geometry; `height` is informational (HUD, chart).
//
//   tide.state()            → { flow -1..1 (+ flood, − ebb), height -1..1, stage: 'flood'|'ebb'|'slack', hoursToSlack }
//   tide.currentAt(x, z, o) → surface current (m/s) in world x/z: a tidal stream along the local shore tangent,
//                             strongest near shore, plus 3% wind drift.
//
// The flood runs with the shore on its right (clockwise around the island on a north-up chart), the ebb the other
// way; fish/sim.js uses the same tangent. One cycle
// is 12.42 game hours (~12 real minutes at the default time speed), so a fishing day sees floods, ebbs and slacks.

const PERIOD = 12.42; // game hours, semidiurnal
const MAX = 0.5; // m/s tidal stream at the shore

export function createTide(clock, heightmap, getWeather) {
  const g = { x: 0, z: 0 };
  const tide = {
    period: PERIOD,
    maxStream: MAX,
    state(t = clock.day * 24 + clock.hours) {
      const p = (2 * Math.PI * t) / PERIOD;
      const flow = Math.sin(p);
      const stage = Math.abs(flow) < 0.25 ? 'slack' : flow > 0 ? 'flood' : 'ebb';
      // Next zero crossing of sin(p) (slack water) in game hours.
      const phase = ((p % Math.PI) + Math.PI) % Math.PI;
      const hoursToSlack = ((Math.PI - phase) / (2 * Math.PI)) * PERIOD;
      return { flow, height: -Math.cos(p), stage, hoursToSlack };
    },
    currentAt(x, z, out = { x: 0, z: 0 }) {
      heightmap.shoreGradient(x, z, g);
      const d = Math.max(0, heightmap.shoreDistance(x, z));
      const s = MAX * tide.state().flow * (0.35 + 0.65 * Math.exp(-d / 300));
      const w = getWeather?.() ?? { windDir: 0, windSpeed: 0 };
      out.x = -g.z * s + Math.sin(w.windDir) * w.windSpeed * 0.03;
      out.z = g.x * s - Math.cos(w.windDir) * w.windSpeed * 0.03;
      return out;
    },
  };
  return tide;
}
