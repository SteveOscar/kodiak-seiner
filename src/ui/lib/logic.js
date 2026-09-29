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
    if (has('teleport')) return { type: 'open', panel: 'teleport' };
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
    if (top === 'teleport' && has('teleport')) return { type: 'close' };
    if (top === 'logbook' && has('map')) return { type: 'open', panel: 'map' };
    return null;
  }
  if (mode === 'play') {
    if (has('pause') || has('escape')) return { type: 'open', panel: 'pause' };
    if (has('map')) return { type: 'open', panel: 'map' };
    if (has('logbook')) return { type: 'open', panel: 'logbook' };
    if (has('help')) return { type: 'open', panel: 'help' };
    if (has('photo')) return { type: 'photo', on: true };
    if (has('teleport')) return { type: 'open', panel: 'teleport' };
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

// Which compass markers keep their text label: highest priority first, and a label is dropped when its estimated
// extent (charPx per character, centred on the marker) would overlap one already kept. Edge markers carry no label.
// Mutates and returns the markers (label set to '' when dropped).
export function dedupeCompassLabels(laid, pxPerDeg, charPx = 6.1, pad = 6) {
  const kept = [];
  for (const m of [...laid].sort((a, b) => (b.prio ?? 0) - (a.prio ?? 0))) {
    if (!m.label || m.edge) continue;
    const x = m.offsetDeg * pxPerDeg;
    const half = m.label.length * charPx * 0.5 + pad;
    if (kept.some(([a, b]) => x + half > a && x - half < b)) m.label = '';
    else kept.push([x - half, x + half]);
  }
  return laid;
}

// Skiff-pull advice while pursing/hauling: how far the pull is off the ideal line and which key swings it round
// (D turns the tow heading clockwise). Headings in radians (0 = north, clockwise).
export function pullAdvice(towHeading, idealHeading) {
  if (!Number.isFinite(idealHeading) || !Number.isFinite(towHeading)) return { off: 0, key: null, state: 'none' };
  const turn = deltaDeg(headingDeg(idealHeading), headingDeg(towHeading));
  const off = Math.abs(turn);
  if (off < 20) return { off, key: null, state: 'on' };
  return { off, key: turn > 0 ? 'D' : 'A', state: off < 55 ? 'near' : 'off' };
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

// ---------------------------------------------------------------- what to do next

// One quiet line for the status panel saying what the skipper should do next, or null when the moment speaks for
// itself (a set in progress, ashore, a tender's delivery prompt already on screen). Pure: every input is a plain value.
//   s = { control, fishing, freeExplore, open, holdLbs, capacityLbs, fuelFrac, fuelEmpty, hours,
//         moored ('dock'|'anchor'|null), sellHere (the dock buys fish), tender: {name, nm} | null,
//         opensToday ('6:00 AM' | null), interactId }
export function nextStep(s) {
  if (!s || s.control === 'foot' || (s.fishing && s.fishing !== 'idle')) return null;
  const cap = Math.max(1, Number(s.capacityLbs) || 1);
  const hold = Math.max(0, Number(s.holdLbs) || 0);
  // Tied up at a fish buyer with fish aboard: sell here rather than run to a tender, whatever else is going on.
  if (s.moored === 'dock' && s.sellHere && hold > 0) return `Sell your catch here (E) · ${int(hold)} lb`;
  const t = s.tender ? `the ${s.tender.name}${Number.isFinite(s.tender.nm) ? ` · ${s.tender.nm < 10 ? s.tender.nm.toFixed(1) : Math.round(s.tender.nm)} nm` : ''}` : 'a tender';
  if (!s.freeExplore && s.fuelEmpty) return s.interactId === 'tow' ? null : 'Out of fuel — call for a tow';
  if (s.interactId === 'deliver') return null;
  if (hold >= cap * 0.95) return `Hold’s full — deliver to ${t}`;
  if (!s.freeExplore && Number(s.fuelFrac) <= 0.2) return 'Fuel’s low — top off at a tender';
  if (s.open) {
    if (hold >= cap * 0.6) return `Deliver to ${t}`;
    if (s.moored === 'dock') return 'Cast off (W) and look for jumpers';
    if (s.moored === 'anchor') return 'Pick up the anchor (W) — the period is open';
    return 'Look for jumpers and working gulls';
  }
  if (hold > 0) return `Closed — deliver to ${t}`;
  if (s.hours >= 22 || s.hours < 4) {
    if (s.interactId === 'sleep') return 'Turn in — sleep until morning';
    return s.moored ? 'Night — rest here until morning' : 'Night — anchor or tie up, then sleep';
  }
  if (s.opensToday) return `Opener at ${s.opensToday} — scout for jumpers`;
  if (s.interactId === 'waitOpener') return 'Closed — wait here for the opener';
  return 'Closed — explore, or wait at anchor';
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

// Why fish got away, from fishing:setComplete.escapes { leads, corks, gap, hole, overflow } when fishing reports it
// (overflow is shown on the species rows and headline, so it is not counted here). Names the main cause with what
// to do about it; without a breakdown it reports the count alone.
const ESCAPE_WAY = {
  leads: ['under the leadline', 'Purse up faster.'],
  corks: ['over the corks on the haul', 'Ease off the block when the tide is running.'],
  gap: ['out through the gap before you closed up', 'Close up sooner.'],
  hole: ['through a hole torn on the bottom', 'Keep the leads off rocky ground.'],
};
export function escapeSummary(r) {
  const e = r?.escapes;
  if (e && typeof e === 'object') {
    const parts = Object.keys(ESCAPE_WAY).map((k) => [k, Math.max(0, Math.round(Number(e[k]) || 0))]);
    const total = parts.reduce((a, [, n]) => a + n, 0);
    if (total > 0) {
      const [cause, n] = parts.reduce((a, b) => (b[1] > a[1] ? b : a));
      const [way, lesson] = ESCAPE_WAY[cause];
      const text = n >= total ? `${int(total)} got away ${way}.` : `${int(total)} got away — most ${way} (${int(n)}).`;
      return { total, cause, text: `${text} ${lesson}` };
    }
    return null;
  }
  const n = Math.round(Number(r?.escaped) || 0);
  return n > 0 ? { total: n, cause: null, text: `${int(n)} got away` } : null;
}

// The set's value label: the tender it was priced at (valuedAt, the nearest buying tender), or an average-price
// estimate when fishing reports valuedAt: null (no tender in reach) or estimate; "today's prices" for payloads
// without the field.
export function reportValue(r) {
  const v = r?.valuedAt;
  const name = typeof v === 'string' ? v : v && typeof v === 'object' ? v.name ?? v.tender ?? v.place ?? null : null;
  const unpriced = !!r && typeof r === 'object' && Object.hasOwn(r, 'valuedAt') && !name;
  const approx = !!r?.estimate || unpriced || /^(average|estimate)$/i.test(String(name ?? ''));
  if (name && !approx) return { label: `At ${name} prices`, approx: false };
  if (approx) return { label: 'At today’s average price', approx: true };
  return { label: 'At today’s prices', approx: false };
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

// VHF caption pacing. Pinned calls (Uncle Pete's tutorial tips and his other calls) stay full-size for their whole
// life — at least pinMinLife seconds — and routine traffic waits in the queue until a pinned call has been read
// (pinQuiet seconds after it finishes typing), so a broadcast never buries the instruction a new player needs.
export const RADIO_PACING = { gap: 0.55, pinMinLife: 12, pinQuiet: 6 };

export function isPinnedRadio(r) {
  return !!(r?.tip || r?.pin || /\bPete\b/.test(String(r?.from ?? '')));
}

export function radioLife(text, { pinned = false, tip = false } = {}, cps = 42, P = RADIO_PACING) {
  const base = radioDuration(text, cps) + (tip ? 3 : 0);
  return pinned ? Math.max(P.pinMinLife, base) : base;
}

// A pinned card still being read: routine traffic and Skipper's-notes cards hold until it is done.
export function pinnedReading(cards, P = RADIO_PACING) {
  return (cards ?? []).some((c) => c && !c.dead && c.pinned && c.t < Math.min(c.life, c.typing + P.pinQuiet));
}

// Index of the queued transmission that may start now, or -1. One call at a time: the newest caption types out plus
// a short gap first. Pinned calls jump the queue; routine calls wait while a pinned call is being read.
export function nextRadio(queue, cards, P = RADIO_PACING) {
  if (!queue?.length) return -1;
  const live = (cards ?? []).filter((c) => c && !c.dead);
  const cur = live[live.length - 1];
  if (cur && cur.t < cur.typing + P.gap) return -1;
  const pin = queue.findIndex((q) => q?.pinned);
  if (pin >= 0) return pin;
  return pinnedReading(live, P) ? -1 : 0;
}

// Cards to retire so at most `max` stay up: the oldest unpinned card below the newest first, then the oldest.
export function radioOverflow(cards, max) {
  const live = (cards ?? []).filter((c) => c && !c.dead);
  const out = [];
  while (live.length > max) {
    let i = live.findIndex((c, n) => n < live.length - 1 && !c.pinned);
    if (i < 0) i = 0;
    out.push(live.splice(i, 1)[0]);
  }
  return out;
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

// Prompts that only inform (Space repeats guidance rather than acting): drawn dimmed in the prompt bar. interact.js
// publishes { id, label, hold } only, so the id suffix is the reliable signal; an `info: true` flag is honoured too.
export function isInfoPrompt(o) {
  return !!o && (o.info === true || /-find-fish$/.test(String(o.id ?? '')));
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
