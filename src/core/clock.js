// Game clock. ctx.clock.hours is local time of day in [0, 24); ctx.clock.day counts days since the season start.
// The clock only runs while ctx.state.mode === 'play' (the main loop calls update). Emits 'time:hour' on each whole
// hour and 'time:day' at midnight. advance() jumps forward (sleep, fast travel) and emits the skipped events once.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function createClock(config, events) {
  const t = config.time;
  const clock = {
    day: t.startDay,
    hours: t.startHours,
    scale: t.minutesPerSecond, // game minutes per real second
    frozen: false, // true = time does not advance (title screen, photo mode, debug)

    update(dt) {
      if (clock.frozen) return;
      clock.advance((dt * clock.scale) / 60, { silent: false });
    },

    // Advance by game hours. Emits one 'time:hour' per crossed hour (capped) and 'time:day' per crossed midnight.
    advance(hours, { silent = false } = {}) {
      const before = clock.day * 24 + clock.hours;
      const after = before + hours;
      clock.day = Math.floor(after / 24);
      clock.hours = after - clock.day * 24;
      if (silent) return;
      const firstHour = Math.floor(before) + 1;
      const lastHour = Math.floor(after);
      for (let h = Math.max(firstHour, lastHour - 48); h <= lastHour; h++) {
        const day = Math.floor(h / 24);
        const hour = h - day * 24;
        if (hour === 0) events.emit('time:day', { day });
        events.emit('time:hour', { day, hour });
      }
    },

    set(hours, day = clock.day) {
      clock.day = day;
      clock.hours = ((hours % 24) + 24) % 24;
    },

    // Calendar date for the current day index.
    date(dayIndex = clock.day) {
      let month = t.seasonStart.month - 1;
      let d = t.seasonStart.day + dayIndex;
      while (d > DAYS_IN_MONTH[month]) {
        d -= DAYS_IN_MONTH[month];
        month = (month + 1) % 12;
      }
      return { month: month + 1, day: d, label: `${MONTHS[month]} ${d}` };
    },

    // Day of year (1-based), for sun position.
    dayOfYear(dayIndex = clock.day) {
      const { month, day } = clock.date(dayIndex);
      let n = day;
      for (let m = 0; m < month - 1; m++) n += DAYS_IN_MONTH[m];
      return n;
    },

    // "5:42 AM" style label.
    timeLabel(hours = clock.hours) {
      const h = Math.floor(hours);
      const m = Math.floor((hours - h) * 60);
      const h12 = ((h + 11) % 12) + 1;
      return `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
    },

    isOpener(hours = clock.hours) {
      return hours >= t.openerStart && hours < t.openerEnd;
    },
  };
  return clock;
}
