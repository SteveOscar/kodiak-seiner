// Exposure from daylight. Pure logic (no THREE/DOM; unit-tested).
//
// sky.sceneKey is the display luminance of a white horizontal surface under the current natural light. Exposure
// compensates only partly (power < 1) so dusk still reads darker than noon and night darker than dusk, and stays
// within [min, max] so emissive lights keep their intended brightness.

export const EXPOSURE = {
  noonKey: 0.85, // sceneKey of a clear midday
  base: 1.0, // exposure at noonKey
  power: 0.42,
  min: 0.8,
  max: 2.3,
  brightenRate: 1.4, // e-folds per second when the scene gets darker (eyes open up)
  darkenRate: 2.6, // e-folds per second when the scene gets brighter
  // Metering: a bounded view-dependent correction toward a log-average exposed luminance of meterTarget.
  meterTarget: 0.2,
  meterStrength: 0.6,
  meterMinEv: -1.1,
  meterMaxEv: 0.45,
};

export function targetExposure(sceneKey, cfg = EXPOSURE) {
  const k = Math.max(1e-6, Number.isFinite(sceneKey) ? sceneKey : cfg.noonKey);
  const e = cfg.base * (cfg.noonKey / k) ** cfg.power;
  return Math.min(cfg.max, Math.max(cfg.min, e));
}

// When the sky system is stubbed there is no sceneKey: approximate it from daylight (0..1).
export function sceneKeyFromDaylight(daylight, cfg = EXPOSURE) {
  const d = Math.min(1, Math.max(0, Number.isFinite(daylight) ? daylight : 1));
  return cfg.noonKey * 10 ** (-1.6 * (1 - d));
}

// Multiplier for the metered frame: log2Lum is the log-average scene luminance before exposure (null = unmetered).
export function meterCorrection(log2Lum, baseExposure, cfg = EXPOSURE) {
  if (!Number.isFinite(log2Lum) || !(baseExposure > 0)) return 1;
  const exposed = log2Lum + Math.log2(baseExposure);
  const ev = (Math.log2(cfg.meterTarget) - exposed) * cfg.meterStrength;
  return 2 ** Math.min(cfg.meterMaxEv, Math.max(cfg.meterMinEv, ev));
}

// Smooth adaptation in log space; dt in real seconds.
export function adaptExposure(current, target, dt, cfg = EXPOSURE) {
  if (!(current > 0)) return target;
  const rate = target > current ? cfg.brightenRate : cfg.darkenRate;
  const k = 1 - Math.exp(-rate * Math.max(0, dt));
  return Math.exp(Math.log(current) + (Math.log(target) - Math.log(current)) * k);
}
