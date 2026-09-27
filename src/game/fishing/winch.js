// Purse winch mini-game (DOM-free). Holding E spools the winch up; the purse line's tension is winch speed × the
// load of the rings and bag, which grows as the bottom closes, plus a little swell. Keeping the needle in the band
// purses at full rate; above it the rings foul after a moment (stall); below it pursing is slow and fish escape.

import { FISHING_TUNING } from '../../entities/net/tuning.js';

export function createWinch(tuning = FISHING_TUNING.winch) {
  const w = {
    band: tuning.band,
    speed: 0, // drum speed 0..1
    tension: 0, // 0..1+ (gauge)
    foul: 0, // seconds spent above the band
    stall: 0, // seconds of stall remaining (fouled rings)
    fouledCount: 0,
    t: 0,

    reset() {
      w.speed = 0;
      w.tension = 0;
      w.foul = 0;
      w.stall = 0;
      w.t = 0;
    },

    // held: E down. pursed: 0..1. extraLoad: bottom drag / snag. Returns { efficiency 0..1.1, fouled (this step) }.
    step(dt, { held, pursed = 0, extraLoad = 0 }) {
      w.t += dt;
      let fouled = false;
      if (w.stall > 0) {
        w.stall = Math.max(0, w.stall - dt);
        w.speed = Math.max(0, w.speed - tuning.rampDown * 2 * dt);
      } else if (held) {
        w.speed = Math.min(1, w.speed + tuning.rampUp * dt);
      } else {
        w.speed = Math.max(0, w.speed - tuning.rampDown * dt);
      }
      const load = tuning.loadStart + (tuning.loadEnd - tuning.loadStart) * pursed + extraLoad;
      const swell = 0.045 * Math.sin(w.t * 1.7) + 0.025 * Math.sin(w.t * 4.3 + 1.1);
      const target = Math.max(0, w.speed * load + (w.speed > 0.05 ? swell : 0));
      w.tension += (target - w.tension) * (1 - Math.exp(-dt * 6));
      const [lo, hi] = w.band;
      if (w.tension > hi && w.stall <= 0) {
        w.foul += dt;
        if (w.foul >= tuning.foulSeconds) {
          w.stall = tuning.foulStall;
          w.foul = 0;
          w.fouledCount++;
          fouled = true;
        }
      } else {
        w.foul = Math.max(0, w.foul - dt * 1.5);
      }
      // The purse line closes at full rate while the tension sits in the band, whatever the drum speed that takes
      // (a heavy bag late in the purse needs less); below the band it closes in proportion to the tension.
      let efficiency = 0;
      if (w.stall <= 0) {
        if (w.tension >= lo) efficiency = w.tension > hi ? 1.05 : 1;
        else efficiency = Math.max(0, w.tension / lo) * 0.8;
      }
      return { efficiency, fouled };
    },

    inBand() {
      return w.tension >= w.band[0] && w.tension <= w.band[1];
    },
  };
  return w;
}
