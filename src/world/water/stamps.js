// Stamp bookkeeping for the foam/ripple field (pure; preallocated, no per-call allocation).
//
// 'foam' stamps are levels: each frame's calls are queued and max-blended into the foam field by the GPU pass, which
// also decays the field with a ~4 s half-life, so stamping every frame is frame-rate independent.
// 'ripple' stamps are events: each call spawns one expanding ring kept in a ring buffer of 128 (oldest dropped).
// At most 512 calls per frame are accepted across all callers; stamps outside the field window are ignored.

export const MAX_STAMPS_PER_FRAME = 512;
export const MAX_RIPPLES = 128;
export const FOAM_HALF_LIFE = 4; // s
export const WAKE_HALF_LIFE = 18; // s, lingering wake trail channel
export const RIPPLE_LIFE = 5.5; // s (plus a little for big rings)

export function createStampQueue({ fieldSize = 1024 } = {}) {
  const foam = new Float32Array(MAX_STAMPS_PER_FRAME * 4); // x, z, radius, strength
  const ripples = new Float32Array(MAX_RIPPLES * 5); // x, z, birth time, radius, strength
  const q = {
    fieldSize,
    centreX: 0,
    centreZ: 0,
    foam,
    foamCount: 0,
    callsThisFrame: 0,
    dropped: 0,
    ignored: 0,
    ripples,
    rippleHead: 0, // next write slot
    rippleCount: 0,
    now: 0,

    setCentre(x, z) {
      q.centreX = x;
      q.centreZ = z;
    },

    inside(x, z) {
      const h = q.fieldSize / 2;
      return Math.abs(x - q.centreX) <= h && Math.abs(z - q.centreZ) <= h;
    },

    // Returns true if accepted.
    stamp(x, z, radius, strength, kind = 'foam') {
      if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
      if (q.callsThisFrame >= MAX_STAMPS_PER_FRAME) {
        q.dropped++;
        return false;
      }
      q.callsThisFrame++;
      if (!q.inside(x, z)) {
        q.ignored++;
        return false;
      }
      const r = Math.min(40, Math.max(0.5, Number.isFinite(radius) ? radius : 2));
      const s = Math.min(1, Math.max(0, Number.isFinite(strength) ? strength : 1));
      if (s <= 0) return false;
      if (kind === 'ripple') {
        const o = q.rippleHead * 5;
        ripples[o] = x;
        ripples[o + 1] = z;
        ripples[o + 2] = q.now;
        ripples[o + 3] = r;
        ripples[o + 4] = s;
        q.rippleHead = (q.rippleHead + 1) % MAX_RIPPLES;
        q.rippleCount = Math.min(MAX_RIPPLES, q.rippleCount + 1);
        return true;
      }
      const o = q.foamCount * 4;
      foam[o] = x;
      foam[o + 1] = z;
      foam[o + 2] = r;
      foam[o + 3] = s;
      q.foamCount++;
      return true;
    },

    rippleLife(radius) {
      return RIPPLE_LIFE + radius * 0.05;
    },

    // Iterates live ripples (oldest first): fn(x, z, age, radius, strength). Expired ones are skipped.
    forEachRipple(fn) {
      const n = q.rippleCount;
      for (let k = 0; k < n; k++) {
        const slot = (q.rippleHead - n + k + MAX_RIPPLES) % MAX_RIPPLES;
        const o = slot * 5;
        const age = q.now - ripples[o + 2];
        if (age < 0 || age > q.rippleLife(ripples[o + 3])) continue;
        fn(ripples[o], ripples[o + 1], age, ripples[o + 3], ripples[o + 4]);
      }
    },

    liveRipples() {
      let n = 0;
      q.forEachRipple(() => n++);
      return n;
    },

    // Called after the GPU consumed this frame's foam stamps.
    endFrame() {
      q.foamCount = 0;
      q.callsThisFrame = 0;
    },

    clear() {
      q.foamCount = 0;
      q.callsThisFrame = 0;
      q.rippleCount = 0;
      q.rippleHead = 0;
      q.dropped = 0;
      q.ignored = 0;
    },
  };
  return q;
}

// Per-frame multiplicative decay for a half-life (frame-rate independent).
export function decayFactor(dt, halfLife) {
  return Math.pow(0.5, Math.max(0, dt) / halfLife);
}
