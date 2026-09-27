// When to re-capture the environment map (SPEC §4.3). Pure logic (no THREE/DOM; unit-tested).
//
// At most every 0.5 s; on > 2° of sun movement (moon movement at night); every 2 s while a weather transition runs;
// at once after an instant weather change or when the key light switches between sun and night; and every 20 s as a
// catch-all for drifting clouds.

export const ENV_POLICY = { minInterval: 0.5, sunDeg: 2, transitionInterval: 2, maxInterval: 20, coverDelta: 0.02, fogDelta: 0.02 };

// s: { since (s since last capture), captures, sunMovedDeg, moonMovedDeg, keyIsSun, keyFlip, transitioning,
//      coverDelta, fogDelta }
export function shouldCaptureEnv(s, P = ENV_POLICY) {
  if (!(s.captures > 0)) return true;
  if (s.since < P.minInterval) return false;
  if (s.sunMovedDeg > P.sunDeg) return true;
  if (!s.keyIsSun && s.moonMovedDeg > P.sunDeg) return true;
  if (s.keyFlip) return true;
  if (s.transitioning) {
    if (s.since >= P.transitionInterval) return true;
  } else if (Math.abs(s.coverDelta) > P.coverDelta || Math.abs(s.fogDelta) > P.fogDelta) {
    return true;
  }
  return s.since > P.maxInterval;
}
