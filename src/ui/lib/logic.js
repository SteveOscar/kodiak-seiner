// Pure UI logic (DOM-free): key routing per mode, compass and sonar projection, gauges, set-report headlines,
// fish-ticket model, keycap parsing. Unit-tested in tests/ui.test.mjs.

import { SPECIES, SPECIES_INFO, bearing, deltaDeg, headingDeg, money, int, price, clockTime, calendar, speciesName } from './format.js';

// ---------------------------------------------------------------- key routing (SPEC §4.2)

// Which UI action a frame's key presses trigger. Only the UI reacts to pause, map, logbook, help and photo keys.
//   mode     core mode: 'title' | 'play' | 'paused' | 'map' | 'photo' | 'cutscene' | 'loading'
//   top      id of the top-most open UI panel ('pause', 'settings', 'logbook', 'help', 'harbor', 'report', 'ticket',
//            'controls', 'credits', 'confirm', 'map') or null
//   keys     Set of pressed UI actions this frame: 'pause' (Esc/P), 'escape' (Esc only), 'map', 'logbook', 'help',
//            'photo', 'confirm' (Space/Enter)
// Returns { type: 'open', panel } | { type: 'close' } | { type: 'back' } | { type: 'photo', on } | null.
export function routeKeys(mode, top, keys) {
  if (!keys || keys.size === 0) return null;
  const has = (k) => keys.has(k);
  if (mode === 'loading' || mode === 'cutscene') return null;
  if (mode === 'title') {
    if (top && (has('escape') || has('pause'))) return { type: 'back' };
    return null;
  }
  if (mode === 'photo') {
    if (has('photo') || has('escape') || has('pause')) return { type: 'photo', on: false };
    return null;
  }
  if (mode === 'map') {
    if (has('map') || has('escape') || has('pause')) return { type: 'close' };
    if (has('logbook')) return { type: 'open', panel: 'logbook' };
    return null;
  }
  if (mode === 'paused') {
    if (!top) return has('pause') || has('escape') ? { type: 'open', panel: 'pause' } : null;
    if (top === 'report' || top === 'ticket') {
      if (has('confirm') || has('escape') || has('pause')) return { type: 'close' };
      return null;
    }
    if (has('escape') || (has('pause') && top !== 'confirm')) return { type: 'back' };
    if (top === 'logbook' && has('logbook')) return { type: 'close' };
    if (top === 'help' && has('help')) return { type: 'close' };
    if (top === 'logbook' && has('map')) return { type: 'open', panel: 'map' };
    return null;
  }
  if (mode === 'play') {
    if (has('pause') || has('escape')) return { type: 'open', panel: 'pause' };
    if (has('map')) return { type: 'open', panel: 'map' };
    if (has('logbook')) return { type: 'open', panel: 'logbook' };
    if (has('help')) return { type: 'open', panel: 'help' };
    if (has('photo')) return { type: 'photo', on: true };
  }
  return null;
}

// ---------------------------------------------------------------- compass strip

// Places markers on a heading-up strip spanning ±halfSpan degrees. Each marker { bearingDeg } gets offsetDeg
// (relative to the heading, clamped to the span) and edge (-1 left, 0 inside, +1 right).
export function compassLayout(heading, markers, halfSpan = 70) {
  const hd = headingDeg(heading);
  return markers.map((m) => {
    const d = deltaDeg(m.bearingDeg, hd);
    const edge = d > halfSpan ? 1 : d < -halfSpan ? -1 : 0;
    return { ...m, offsetDeg: edge ? edge * halfSpan : d, rawOffsetDeg: d, edge };
  });
}

// Bearing (degrees) and distance from (x, z) to a target.
export function bearingDistance(x, z, tx, tz) {
  return { bearingDeg: headingDeg(bearing(x, z, tx, tz)), distance: Math.hypot(tx - x, tz - z) };
}

// Continuous (unwrapped) heading in degrees, so a strip can translate smoothly across north.
export function unwrapDeg(prev, next) {
  if (!Number.isFinite(prev)) return next;
  return prev + deltaDeg(next, prev);
}

// ---------------------------------------------------------------- sonar

// Heading-up plan-position projection of sonar marks. Returns [{u, v, r, strength, depth}] with u to starboard and
// v ahead, both in units of the range (|r| <= 1).
export function sonarProject(x, z, heading, returns, range) {
  const out = [];
  if (!Array.isArray(returns) || !(range > 0)) return out;
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  for (const m of returns) {
    if (!m || !Number.isFinite(m.x) || !Number.isFinite(m.z)) continue;
    const dx = m.x - x;
    const dz = m.z - z;
    // forward = (sin h, -cos h), starboard = (cos h, sin h)
    const v = (dx * s - dz * c) / range;
    const u = (dx * c + dz * s) / range;
    const r = Math.hypot(u, v);
    if (r > 1) continue;
    out.push({ u, v, r, strength: Math.max(0, Math.min(1, Number(m.strength) || 0.5)), depth: Number(m.depth) || 0 });
  }
  return out;
}

// ---------------------------------------------------------------- gauges

// Hold gauge segments in species order: [{ species, lbs, frac (of capacity), color }].
export function holdSegments(hold, capacityLbs, speciesTable) {
  const cap = Math.max(1, Number(capacityLbs) || 1);
  const out = [];
  for (const k of SPECIES) {
    const n = Number(hold?.[k]) || 0;
    if (n <= 0) continue;
    const lbs = n * (speciesTable?.[k]?.lbs ?? 0);
    if (lbs <= 0) continue;
    out.push({ species: k, lbs, frac: lbs / cap, color: SPECIES_INFO[k].color });
  }
  let total = 0;
  for (const s of out) {
    s.frac = Math.max(0, Math.min(1 - total, s.frac));
    total += s.frac;
  }
  return out;
}

export function fuelLevel(fuel, capacity) {
  const f = Math.max(0, Math.min(1, (Number(fuel) || 0) / Math.max(1, Number(capacity) || 1)));
  return { frac: f, tone: f <= 0.1 ? 'danger' : f <= 0.2 ? 'warn' : 'ok' };
}

// Purse tension: position of the needle and whether it sits in the green band.
export function tensionState(tension, band = [0.4, 0.7]) {
  const t = Math.max(0, Math.min(1, Number(tension) || 0));
  const lo = Number(band?.[0]) || 0;
  const hi = Number(band?.[1]) || 1;
  return { t, lo, hi, zone: t < lo ? 'low' : t > hi ? 'high' : 'good' };
}

// ---------------------------------------------------------------- set report

const totalFish = (c) => SPECIES.reduce((a, k) => a + (Number(c?.[k]) || 0), 0);

// Headline for the set report card from a fishing:setComplete payload.
export function reportHeadline(r) {
  const accepted = totalFish(r?.accepted);
  const overflow = Math.max(0, totalFish(r?.released) - (Number(r?.released?.king) || 0));
  if (r?.cited) {
    return { title: 'Cited', kicker: 'Closed waters', line: 'The Wildlife Troopers wrote you up — the catch is forfeited.', tone: 'bad' };
  }
  if (r?.aborted) return { title: 'Water haul', kicker: 'Set aborted', line: 'Hauled back empty. Shake it off and look for jumpers.', tone: 'muted' };
  if (r?.waterHaul || r?.rating === 'water haul') {
    return { title: 'Water haul', kicker: 'Skunked', line: 'Nothing but seawater. Watch which way they’re jumping and lay it out ahead of them.', tone: 'muted' };
  }
  if (r?.rating === 'plugged') {
    return {
      title: 'Plugged!',
      kicker: 'Big set',
      line: overflow > 0 ? `Hold’s full — let ${int(overflow)} go over the corks.` : 'The bag’s so full the corks are sinking. Nice set, Cap.',
      tone: 'great',
    };
  }
  if (r?.rating === 'good') return { title: 'Good set', kicker: 'Fish aboard', line: `${int(accepted)} fish brailed aboard. That’ll pay for the fuel.`, tone: 'good' };
  return { title: 'A few fish', kicker: 'Fair set', line: `${int(accepted)} fish aboard. Better than a water haul.`, tone: 'fair' };
}

// Species rows for the report (accepted counts and lbs, kings released).
export function reportRows(r, speciesTable) {
  const rows = [];
  for (const k of SPECIES) {
    const count = Number(r?.accepted?.[k]) || 0;
    const released = Number(r?.released?.[k]) || 0;
    if (count <= 0 && released <= 0) continue;
    const lbs = Number.isFinite(r?.lbs?.[k]) ? r.lbs[k] : count * (speciesTable?.[k]?.lbs ?? 0);
    rows.push({ species: k, name: speciesName(k, { nick: true }), color: SPECIES_INFO[k].color, count, lbs, released });
  }
  return rows;
}

// ---------------------------------------------------------------- fish ticket

// Normalised fish ticket fields from an economy:delivered receipt (tolerates the stub's partial receipts).
export function ticketModel(rec, { speciesTable, seasonStart, day, hours, boatName, permit } = {}) {
  const lines = (rec?.lines ?? []).map((l) => {
    const k = l.species;
    const code = l.code ?? SPECIES_INFO[k]?.code ?? '';
    const lbs = Number(l.lbs) || (Number(l.count) || 0) * (speciesTable?.[k]?.lbs ?? 0);
    const p = Number(l.price) || 0;
    const value = Number.isFinite(l.value) ? l.value : lbs * p;
    return {
      code: String(code),
      species: speciesName(k),
      color: SPECIES_INFO[k]?.color ?? '#999',
      count: int(l.count ?? 0),
      lbs: int(lbs),
      price: price(p),
      value: money(value, { cents: true }),
      rawLbs: lbs,
      rawValue: value,
    };
  });
  const totalLbs = Number.isFinite(rec?.totalLbs) ? rec.totalLbs : lines.reduce((a, l) => a + l.rawLbs, 0);
  const gross = Number.isFinite(rec?.gross) ? rec.gross : lines.reduce((a, l) => a + l.rawValue, 0);
  const crewShare = Number.isFinite(rec?.crewShare) ? rec.crewShare : gross * 0.3;
  const net = Number.isFinite(rec?.net) ? rec.net : gross - crewShare;
  const cal = calendar(day ?? 0, seasonStart);
  const crew = Array.isArray(rec?.crew) && rec.crew.length
    ? rec.crew.map((c) => ({ role: c.role ?? 'Crew', share: money(c.share ?? 0, { cents: true }) }))
    : ['Skiffman', 'Deckhand', 'Deckhand'].map((role) => ({ role, share: money(crewShare / 3, { cents: true }) }));
  return {
    ticket: rec?.ticket && rec.ticket !== 'STUB' ? rec.ticket : `K26-${String(100000 + Math.floor(Math.abs(gross * 7)) % 900000)}`,
    date: rec?.date ?? `${cal.label}, ${cal.year}`,
    time: rec?.time ?? clockTime(hours ?? 12),
    vessel: rec?.vessel ?? boatName ?? 'Northern Dawn',
    permit: rec?.permit ?? permit ?? 'S01K-00000',
    gear: rec?.gear ?? '01 Purse seine',
    condition: rec?.condition ?? 'Iced',
    district: rec?.district ?? 'Kodiak Management Area',
    statArea: rec?.statArea ?? '259-00',
    tender: rec?.tender ?? 'Tender',
    lines,
    totalLbs: int(totalLbs),
    gross: money(gross, { cents: true }),
    crewShare: money(crewShare, { cents: true }),
    crew,
    advanceRepaid: Number(rec?.advanceRepaid) > 0 ? money(rec.advanceRepaid, { cents: true }) : null,
    net: money(net, { cents: true }),
    rawNet: net,
    rawAdvance: Math.max(0, Number(rec?.advanceRepaid) || 0),
    rawGross: gross,
  };
}

// ---------------------------------------------------------------- text

// Splits hint/tutorial text into plain and keycap segments: "Hit Space", "Hold E", "(L)", "A and D", "A/D".
export function keycapify(text) {
  const s = String(text ?? '');
  const re = /\b(Space|Esc|Shift|Enter|Backspace|F1)\b|\(([A-Z])\)|\b((?:hit|press|hold|tap|Hold|Hit|Press|Tap)\s+)([A-Z])\b|\b([A-Z])(\s+and\s+|\/)([A-Z])\b(?=\s+(?:aim|steer|turn|keys))/g;
  const out = [];
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    const push = (t) => t && out.push({ text: t });
    push(s.slice(last, m.index));
    if (m[1]) out.push({ key: m[1] });
    else if (m[2]) {
      out.push({ text: '' });
      out.push({ key: m[2] });
    } else if (m[4]) {
      push(m[3]);
      out.push({ key: m[4] });
    } else if (m[5]) {
      out.push({ key: m[5] });
      push(m[6]);
      out.push({ key: m[7] });
    }
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last) });
  return out.filter((x) => x.key || x.text);
}

// How long a radio caption stays up (seconds, real time) including its typewriter time.
export function radioDuration(text, cps = 42) {
  const n = String(text ?? '').length;
  return Math.min(16, n / cps + 2.8 + n / 60);
}

export function toastDuration(opts) {
  const d = Number(opts?.duration);
  return Number.isFinite(d) && d > 0 ? Math.min(12, d) : 4;
}

// Short label for a key binding code ('KeyE' -> 'E', 'Space' -> 'Space', 'ArrowUp' -> '↑').
export function keyLabel(code) {
  const c = String(code ?? '');
  if (c.startsWith('Key')) return c.slice(3);
  if (c.startsWith('Digit')) return c.slice(5);
  const map = { Space: 'Space', Escape: 'Esc', Enter: 'Enter', ShiftLeft: 'Shift', ShiftRight: 'Shift', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Slash: '/', Backspace: '⌫', interact: 'E', action: 'Space' };
  return map[c] ?? c;
}

// ---------------------------------------------------------------- timing

// Fixed-rate gate: due(dt) is true at most `hz` times per second of accumulated time.
export function createThrottle(hz) {
  const period = 1 / Math.max(0.001, hz);
  let acc = period; // first call is due
  return {
    due(dt) {
      acc += Math.max(0, Number(dt) || 0);
      if (acc >= period) {
        acc = acc % period;
        return true;
      }
      return false;
    },
    force() {
      acc = period;
    },
  };
}

// Tide text for the HUD from ctx.tide.state().
export function tideLabel(t) {
  if (!t) return { stage: '—', text: 'Tide —', arrow: '' };
  const stage = t.stage === 'flood' ? 'Flood' : t.stage === 'ebb' ? 'Ebb' : 'Slack';
  const hrs = Number(t.hoursToSlack);
  const h = Number.isFinite(hrs) ? Math.max(0, hrs) : null;
  const m = h === null ? null : Math.round(h * 60);
  const when = m === null ? '' : m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
  let text;
  if (t.stage === 'slack') text = `Slack water${Number(t.flow) >= 0 ? ' · ebb next' : ' · flood next'}`;
  else text = `${stage} tide${when ? ` · slack in ${when}` : ''}`;
  return { stage: t.stage ?? 'slack', text, arrow: t.stage === 'flood' ? '▲' : t.stage === 'ebb' ? '▼' : '◆' };
}

export { bearing, deltaDeg, headingDeg, money };
