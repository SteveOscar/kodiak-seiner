// Season (WP-RULES): the ADF&G fishing-period schedule and openerActive() as the single authority, district rules,
// species mix, prices, closed waters, the daily weather schedule and forecast, the fleet board, the VHF radio,
// sleeping / waiting for an opener / anchoring, and it installs the save manager (src/game/save.js) and fast travel
// (src/game/travel.js). Pure rules live in src/game/data/*.

import * as cal from './data/calendar.js';
import { buildWeatherPlan, presetAt, segmentKey, forecastFor } from './data/weather.js';
import { priceFor as priceRule, keyedRandom, spokenPrice, spokenDollars, formatMoney, fuelPriceAt } from './data/market.js';
import { speciesMixAt } from './data/runs.js';
import { FLEET, createBoard, creditThrough, boardRows, serializeBoard, restoreBoard } from './data/fleetBoard.js';
import { LINES, FROM, CHANNELS, WELCOME, WELCOME_NONE, EXPLORE_WELCOME } from './data/radioLines.js';
import { createRadio, fillTemplate } from './data/radio.js';
import { installSave } from './save.js';
import { createTravel, showFade } from './travel.js';
import { resolve as resolvePlaces, pointInPolygon } from '../data/places.js';
import { hashString } from '../core/rng.js';

const TENDER_CHANNELS = ['7A', '8', '18A', '67', '79A', '80A'];
const FALLBACK = {
  cape: ['Cape Ugat', 'Cape Uganik', 'Cape Kuliuk', 'Cape Ikolik', 'Cape Karluk', 'Cape Alitak', 'Cape Chiniak', 'Cape Greville', 'Cape Barnabas', 'Spruce Cape'],
  bay: ['Uyak Bay', 'Uganik Bay', 'Viekoda Bay', 'Kizhuyak Bay', 'Chiniak Bay', 'Ugak Bay', 'Kiliuda Bay', 'Alitak Bay', 'Olga Bay', 'Deadman Bay', 'Terror Bay', 'Zachar Bay'],
  harbor: ['Kodiak', 'Old Harbor', 'Larsen Bay', 'Port Lions', 'Ouzinkie'],
};
// Below go ashore (40) — closed days are for exploring, and a beach landing should win near shore — and below
// deliver / tie-up (60); above "Drop anchor" (30).
const WAIT_PRIORITY = 35;
// Sleep leads E at anchor. Tied up at a harbor with services it ranks below Sell (68), Fuel up (67) and Harbor
// services (64) — the harbor panel has its own Sleep and Wait buttons — but above Tie up / Deliver (60).
const SLEEP_PRIORITY = 70;
const SLEEP_AT_HARBOR_PRIORITY = 62;
// Before the first set of a season, ambient chatter comes this many times less often (Uncle Pete is teaching).
const TUTORIAL_AMBIENT_SCALE = 3;
// Seconds a coaching tip holds routine radio traffic: the UI's card life (typing + reading + 3 s) plus a margin.
const tipHoldSeconds = (text) => {
  const n = String(text ?? '').length;
  return Math.min(21, Math.min(16, n / 42 + 2.8 + n / 60) + 3 + 1.5);
};
// How a place is said on the radio: "City of Kodiak" → "Kodiak", "Awa'uq (Refuge Rock)" → "Awa'uq".
const spokenName = (n) => String(n).replace(/^City of /, '').replace(/\s*\(.*\)\s*$/, '');
const COMPASS8 = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];

export async function create(ctx) {
  const { config, clock, events, heightmap } = ctx;
  const rng = ctx.rng.fork('season');
  const seedOf = (salt) => Math.floor(rng.fork(salt).next() * 4294967296) >>> 0;
  const priceSeed = seedOf('prices');
  const fleetSeed = seedOf('fleet');
  const miscSeed = seedOf('misc');
  const weatherPlan = buildWeatherPlan(seedOf('weather'), 64);
  const radioRng = rng.fork('radio');
  const dateOf = (d) => cal.dateOf(config, d);

  // The eight fleet-board seiners. WP-BOATS may name its fleet seiners itself; if it does, the board adopts those
  // names on game:ready so the radio, the board and the boats on the water agree.
  let fleetList = FLEET.map((b) => ({ ...b }));
  let board = createBoard(fleetList);
  let lastOpen = null;
  let openDay = null;
  let lastSegKey = null;
  let lastAppliedPreset = null;
  let welcomeAt = null;
  let peteCount = 0;
  let peteNextAt = 0;
  let noaaDeferredDay = null;
  const announced = new Set();
  const mixCache = new Map();
  const districtCache = new Map();

  // ---- places data (static data first; the places system refines it on game:ready) ----
  const staticPlaces = resolvePlaces(ctx.geo);
  let streams = staticPlaces.streams;
  let districts = staticPlaces.districts;
  let closedAreas = staticPlaces.closedAreas;
  const closedWaters = [];

  function rebuildPlaces() {
    const p = ctx.systems.places;
    if (Array.isArray(p?.streams) && p.streams.length) streams = p.streams;
    if (Array.isArray(p?.districts) && p.districts.length) districts = p.districts;
    if (Array.isArray(p?.closedAreas)) closedAreas = p.closedAreas;
    else if (!closedAreas) closedAreas = [];
    closedWaters.length = 0;
    const [rMin, rMax] = config.season.closedRadius;
    for (const s of streams) {
      if (!Number.isFinite(s.x)) continue;
      closedWaters.push({ id: `stream:${s.id}`, streamId: s.id, name: `${s.name} closed waters`, x: s.x, z: s.z, radius: Math.max(rMin, Math.min(rMax, s.closedRadius ?? rMin)), reason: 'stream' });
    }
    for (const c of closedAreas ?? []) {
      if (!Number.isFinite(c.x)) continue;
      closedWaters.push({ id: `area:${c.id}`, streamId: null, name: c.name, x: c.x, z: c.z, radius: c.radius ?? 300, reason: c.reason ?? 'closed area' });
    }
    districtCache.clear();
    mixCache.clear();
  }
  rebuildPlaces();

  function closedWaterAt(x, z) {
    for (const c of closedWaters) {
      const dx = x - c.x;
      const dz = z - c.z;
      if (dx * dx + dz * dz <= c.radius * c.radius) return c;
    }
    return null;
  }

  function districtIdAt(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const key = `${Math.round(x / 100)}:${Math.round(z / 100)}`;
    if (districtCache.has(key)) return districtCache.get(key);
    let id = null;
    for (const d of districts ?? []) {
      if ((d.polygon?.length ?? 0) > 2 && pointInPolygon(x, z, d.polygon)) {
        id = cal.normalizeDistrict(d.id) ?? cal.normalizeDistrict(d.name);
        break;
      }
    }
    if (!id && (districts?.length ?? 0) === 0) id = cal.normalizeDistrict(ctx.systems.places?.districtAt?.(x, z));
    if (districtCache.size > 4000) districtCache.clear();
    districtCache.set(key, id);
    return id;
  }

  const districtLabel = (id) => {
    const d = (districts ?? []).find((q) => cal.normalizeDistrict(q.id) === id || cal.normalizeDistrict(q.name) === id);
    return d?.name ? (/district/i.test(d.name) ? d.name : `${d.name} District`) : cal.districtName(id);
  };

  // ---- openers ----

  function openerActive(x, z) {
    if (ctx.state.freeExplore) return true;
    const district = x === undefined || z === undefined ? null : districtIdAt(x, z);
    return cal.isOpenAt(config, clock.day, clock.hours, district);
  }

  function nextOpener(x, z) {
    const district = x === undefined || z === undefined ? null : districtIdAt(x, z);
    const n = cal.nextOpenerAfter(config, clock.day, clock.hours, district);
    if (!n) return null;
    const d = dateOf(n.day);
    return {
      ...n,
      date: d.label,
      label: `${d.weekdayShort} ${d.label}, ${cal.clockLabel(n.hours)}`,
      inHours: cal.hoursBetween(clock.day, clock.hours, n.day, n.hours),
      districtNames: n.districts === 'all' ? 'all districts' : n.districts.map(districtLabel),
    };
  }

  function openerStatus(x, z) {
    if (ctx.state.freeExplore) return { open: true, label: 'Free explore — always open' };
    const open = openerActive(x, z);
    if (open) return { open: true, label: `Open · closes ${cal.clockLabel(config.time.openerEnd)}`, closesIn: config.time.openerEnd - clock.hours };
    const n = nextOpener(x, z);
    if (!n) return { open: false, label: 'Season closed', next: null };
    const today = n.day === clock.day;
    return { open: false, label: `Closed · opens ${today ? 'today' : n.label.split(',')[0]} ${cal.clockLabel(n.hours)}`, next: n };
  }

  function exceptText(closed) {
    if (!closed?.length) return '';
    const order = (id) => (cal.DISTRICT_IDS.indexOf(id) + 100) % 100;
    const names = [...closed].sort((a, b) => order(a) - order(b)).map((id) => districtLabel(id).replace(/ District$/, ''));
    return names.length === 1 ? ` except the ${names[0]} District` : ` except the ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} Districts`;
  }

  // ---- species mix ----

  function enclosureAt(x, z) {
    let hits = 0;
    const dirs = 12;
    for (let k = 0; k < dirs; k++) {
      const a = (k / dirs) * Math.PI * 2;
      const cx = Math.cos(a);
      const cz = Math.sin(a);
      for (let r = 200; r <= 1600; r += 200) {
        if (heightmap.heightAt(x + cx * r, z + cz * r) > 0) {
          hits++;
          break;
        }
      }
    }
    return hits / dirs;
  }

  function speciesMix(x = ctx.systems.seiner?.position?.x ?? 0, z = ctx.systems.seiner?.position?.z ?? 0) {
    const key = `${clock.day}:${Math.round(x / 200)}:${Math.round(z / 200)}`;
    const hit = mixCache.get(key);
    if (hit) return { ...hit };
    const st = streams.map((s) => ({ id: s.id, name: s.name, species: s.species, distance: Math.hypot(s.x - x, s.z - z) }));
    const hatch = (ctx.systems.places?.list ?? staticPlaces.places)
      .filter((p) => p.kind === 'hatchery')
      .map((p) => ({ name: `${p.id} ${p.name}`, distance: Math.hypot(p.x - x, p.z - z) }));
    const mix = speciesMixAt({ day: clock.day, runs: config.fish.runs, streams: st, hatcheries: hatch, district: districtIdAt(x, z), enclosure: enclosureAt(x, z) });
    if (mixCache.size > 3000) mixCache.clear();
    mixCache.set(key, mix);
    return { ...mix };
  }

  // ---- prices ----

  function priceFor(species, tenderId = null) {
    const sp = config.fish.species[species];
    if (!sp) return 0;
    return priceRule({ seed: priceSeed, day: clock.day, species, buyerId: tenderId, basePrice: sp.price, rswBonus: ctx.systems.economy?.modifiers?.rswBonus ?? 0, release: !!sp.release });
  }

  // ---- weather ----

  function applyWeather(transition) {
    if (ctx.debug?.weatherPinned) return;
    const preset = presetAt(weatherPlan, clock.day, clock.hours);
    lastSegKey = segmentKey(weatherPlan, clock.day, clock.hours);
    if (preset === lastAppliedPreset && ctx.systems.sky?.weather?.preset === preset) return;
    lastAppliedPreset = preset;
    try {
      ctx.systems.sky?.setWeather?.(preset, transition);
    } catch (err) {
      console.warn('[season] sky.setWeather threw', err?.message ?? err);
    }
  }

  function forecast() {
    return forecastFor(weatherPlan, clock.day, clock.hours, dateOf);
  }

  // ---- fleet board ----

  function creditBoard() {
    return creditThrough(board, config, fleetSeed, clock.day, clock.hours);
  }

  function fleetBoard() {
    creditBoard();
    const eco = ctx.systems.economy;
    const player = {
      name: ctx.systems.seiner?.boatName ?? 'Northern Dawn',
      gross: eco?.stats?.seasonGross ?? 0,
      today: eco?.stats?.daily?.[clock.day]?.gross ?? 0,
    };
    return boardRows(board, config, fleetSeed, clock.day, clock.hours, ctx.state.freeExplore ? null : player);
  }

  // ---- radio ----

  const radio = createRadio({
    rng: radioRng,
    emit(msg) {
      const ui = ctx.systems.ui;
      if (typeof ui?.radio === 'function') ui.radio(msg.from, msg.text, msg.channel);
      else events.emit('ui:radio', msg);
    },
  });

  const tenders = () => ctx.systems.fleet?.tenders ?? [];
  const tenderChannel = (t) => (t?.channel ? String(t.channel) : TENDER_CHANNELS[hashString(String(t?.id ?? 'tender')) % TENDER_CHANNELS.length]);

  function nearestTender() {
    const s = ctx.systems.seiner?.position;
    const list = tenders().filter((t) => t.position);
    if (!list.length) return null;
    if (!s) return list[0];
    return list.reduce((a, b) => (Math.hypot(a.position.x - s.x, a.position.z - s.z) <= Math.hypot(b.position.x - s.x, b.position.z - s.z) ? a : b));
  }

  function nearName(kinds, fallback, origin = null) {
    const s = origin ?? ctx.systems.seiner?.position ?? { x: 0, z: 0 };
    const list = (ctx.systems.places?.list ?? staticPlaces.places)
      .filter((p) => kinds.includes(p.kind) && !p.memorial && Number.isFinite(p.x))
      .map((p) => ({ p, d: Math.hypot(p.x - s.x, p.z - s.z) }))
      .filter((o) => o.d < 7000)
      .sort((a, b) => a.d - b.d)
      .slice(0, 3);
    if (list.length) return spokenName(list[Math.floor(radioRng.next() * list.length)].p.name);
    return fallback[Math.floor(radioRng.next() * fallback.length)];
  }

  function tokens(speaker = null, extra = {}) {
    const others = fleetList.filter((b) => b.name !== speaker);
    const addressee = others[Math.floor(radioRng.next() * others.length)] ?? fleetList[0];
    const t = extra.tenderObj ?? nearestTender();
    const tid = t?.id ?? null;
    // Tenders describe their own anchorage; everyone else talks about the water around the player.
    const origin = extra.tenderObj?.position ?? null;
    return {
      me: ctx.systems.seiner?.boatName ?? 'Northern Dawn',
      boat: addressee.name,
      skipper: addressee.skipper,
      cape: () => nearName(['cape'], FALLBACK.cape),
      bay: () => nearName(['bay', 'strait'], FALLBACK.bay),
      place: () => nearName(['cape', 'bay', 'island', 'strait', 'landmark'], [...FALLBACK.cape, ...FALLBACK.bay], origin),
      harbor: () => nearName(['town', 'village', 'harbor', 'cannery'], FALLBACK.harbor),
      tender: t?.name ?? 'the tender',
      pinkc: () => spokenPrice(priceFor('pink', tid)),
      redc: () => spokenPrice(priceFor('sockeye', tid)),
      dogc: () => spokenPrice(priceFor('chum', tid)),
      silverc: () => spokenPrice(priceFor('coho', tid)),
      fuel: () => formatMoney(fuelPriceAt({ isTender: true }, config.economy), true),
      towFee: () => spokenDollars(config.economy.towCost),
      towTotal: () => spokenDollars(ctx.systems.economy?.towQuote?.()?.total ?? config.economy.towCost),
      weekday: dateOf(clock.day).weekday,
      date: dateOf(clock.day).label,
      ...extra,
    };
  }

  const pickFleet = () => fleetList[Math.floor(radioRng.next() * fleetList.length)];

  function adoptFleetNames() {
    const boats = ctx.systems.fleet?.boats;
    if (!Array.isArray(boats)) return;
    const named = boats.filter((b) => typeof b?.name === 'string' && b.name && !/tender|ferry|cutter|skiff|coast guard/i.test(`${b.kind ?? ''} ${b.type ?? ''} ${b.name}`));
    const unique = [...new Set(named.map((b) => b.name))];
    if (unique.length < 4) return;
    fleetList = FLEET.map((b, i) => ({ ...b, name: unique[i] ?? b.name }));
    board.boats.forEach((b, i) => {
      b.name = fleetList[i].name;
    });
  }

  // Builds a message from a category. kind: 'fleet' | 'tender' | 'pete' | 'uscg' | 'adfg'
  function compose(category, { kind = 'fleet', extra = {}, preset = null } = {}) {
    const line = radio.pickLine(LINES, category, preset ?? ctx.systems.sky?.weather?.preset ?? null);
    if (!line) return null;
    if (kind === 'tender') {
      const t = extra.tenderObj ?? nearestTender();
      if (!t) return null;
      extra = { ...extra, tenderObj: t };
      return { from: t.name, text: fillTemplate(line.text, tokens(null, extra)), channel: tenderChannel(t) };
    }
    if (kind === 'pete') return { from: FROM.pete, text: fillTemplate(line.text, tokens(null, extra)), channel: CHANNELS.fleet };
    if (kind === 'uscg') return { from: FROM.uscg, text: fillTemplate(line.text, tokens(null, extra)), channel: CHANNELS.uscg };
    const sp = pickFleet();
    return { from: sp.name, text: fillTemplate(line.text, tokens(sp.name, extra)), channel: CHANNELS.fleet };
  }

  function say(category, opts = {}, queue = {}) {
    const msg = compose(category, opts);
    if (msg) radio.push(msg, queue);
    return msg;
  }

  function ambient(category) {
    const explore = ctx.state.freeExplore;
    if (explore && (category === 'prices' || category === 'tender' || category === 'closed' || category === 'morning')) return compose('banter');
    if (category === 'tender' || (category === 'prices' && radioRng.next() < 0.35)) {
      if (!tenders().length) return compose('banter');
      return compose(category === 'prices' ? 'prices' : 'tender', { kind: category === 'tender' ? 'tender' : 'fleet' });
    }
    return compose(category);
  }

  // The first set of a season is Uncle Pete's tutorial (fishing's ui:hint tips). Until it is done — setNumber ≥ 1 and
  // fishing idle again — on a fishing day the radio keeps routine traffic down: no morning/opener chatter, NOAA and
  // Coast Guard broadcasts wait, ambient lines come TUTORIAL_AMBIENT_SCALE× less often.
  function firstSetPending() {
    if (ctx.state.freeExplore) return false;
    const f = ctx.systems.fishing;
    if (typeof f?.setNumber !== 'number') return false;
    return f.setNumber < 1 || (f.setNumber === 1 && (f.state ?? 'idle') !== 'idle');
  }
  const tutorialQuiet = () => firstSetPending() && cal.isFishingDay(config, clock.day);

  // Other systems may queue rate-limited radio through the season: season.radioSay({from, text, channel}, opts).
  function radioSay(msg, opts = {}) {
    if (!msg?.text) return false;
    return radio.push({ from: msg.from ?? 'VHF', text: msg.text, channel: String(msg.channel ?? CHANNELS.fleet) }, { priority: 2, ...opts });
  }

  // ---- scheduled broadcasts ----

  function escapementLine(day) {
    const karluk = Math.round((35000 + 10500 * day + keyedRandom(miscSeed, `weir:${day}`) * 9000) / 100) * 100;
    const r = keyedRandom(miscSeed, `pinkidx:${day}`);
    const trend = r < 0.25 ? 'below' : r < 0.8 ? 'within' : 'above';
    return `Karluk weir count to date is ${karluk.toLocaleString('en-US')} sockeye. Kodiak pink salmon escapement is tracking ${trend} the goal range.`;
  }

  function announcePeriod(period, reminder, delay = 0) {
    const d = dateOf(period.day);
    const except = exceptText(period.closed);
    const openNow = clock.day === period.day && clock.hours >= config.time.openerStart;
    const text = reminder
      ? openNow
        ? `Fish and Game Kodiak reminds all purse seiners: the Kodiak Management Area is open to purse seining today${except}, until 10 p.m.`
        : `Fish and Game Kodiak reminds all purse seiners: the Kodiak Management Area opens at 6 a.m. today${except}, until 10 p.m.`
      : `Attention all Kodiak purse seiners, this is Fish and Game Kodiak. By emergency order, all districts of the Kodiak Management Area${except} will open to purse seining from 6 a.m. until 10 p.m. ${d.long}.`;
    const last = period.day === config.season.fishingDays[config.season.fishingDays.length - 1];
    const then = {
      from: FROM.adfg,
      text: `Closed waters are in effect at all salmon streams — stay outside the markers. ${escapementLine(clock.day)}${last ? ' This is the last scheduled period of the season.' : ''}`,
      channel: CHANNELS.distress,
    };
    // A same-day reminder is only worth hearing before the period opens.
    const secsToOpen = ((config.time.openerStart - clock.hours) * 60) / Math.max(0.01, clock.scale);
    const ttl = reminder ? Math.max(5, secsToOpen - delay) : 240;
    radio.push({ from: FROM.adfg, text, channel: CHANNELS.distress, then, thenDelay: 5 }, { priority: 6, ttl, delay });
  }

  function noaaBroadcast(tag) {
    const f = forecast();
    const head = f.warning ? `...${f.warning.toUpperCase()}... ` : '';
    const issued = tag === 'am' ? '4 a.m.' : '4 p.m.';
    const first = `Marine forecast for Kodiak Island waters, issued ${issued} ${head}${f.todayText ? `${tag === 'am' ? 'Today' : 'This afternoon'}: ${f.todayText}` : `Tonight: ${f.tonightText}`}`;
    const second = `${f.todayText ? `Tonight: ${f.tonightText} ` : ''}${dateOf(clock.day + 1).weekday}: ${f.tomorrowText}`;
    radio.push({ from: FROM.noaa, text: first, channel: CHANNELS.noaa, then: { from: FROM.noaa, text: second, channel: CHANNELS.noaa }, thenDelay: 6 }, { priority: 3, ttl: 300 });
  }

  function uscgBroadcast() {
    const call = radio.pickLine(LINES, 'uscgCall');
    const body = compose('uscg', { kind: 'uscg' });
    if (!call || !body) return;
    radio.push({ from: FROM.uscg, text: call.text, channel: CHANNELS.distress, then: body, thenDelay: 5 }, { priority: 4, ttl: 300 });
  }

  function fleetReport(day) {
    const t = nearestTender();
    if (!t || ctx.state.freeExplore) return;
    const top = [...board.boats].filter((b) => b.last?.day === day).sort((a, b) => b.last.gross - a.last.gross).slice(0, 3);
    if (!top.length) return;
    const lbs = (n) => Math.round(n).toLocaleString('en-US');
    const parts = top.map((b) => `${b.name} ${lbs(b.last.lbs)}`);
    // The tender reads everyone's pounds to the nearest hundred, the player's too.
    const mine = ctx.systems.economy?.stats?.daily?.[day]?.lbs ?? 0;
    if (mine > 0) parts.push(`${ctx.systems.seiner?.boatName ?? 'Northern Dawn'} ${lbs(Math.max(100, Math.round(mine / 100) * 100))}`);
    radio.push({ from: t.name, text: `${t.name} with the daily deliveries: ${parts.join(', ')}. Thanks, fleet — see you next period.`, channel: tenderChannel(t) }, { priority: 3, ttl: 600 });
  }

  // Scheduled items fire once inside their window, so a time skip past a window never floods the radio.
  function scheduled() {
    const h = clock.hours;
    const day = clock.day;
    const explore = ctx.state.freeExplore;
    const tutorial = tutorialQuiet();
    const once = (key, fn) => {
      if (announced.has(key)) return;
      announced.add(key);
      fn();
    };
    if (!explore) {
      const tomorrow = cal.periodOn(config, day + 1);
      if (tomorrow && h >= 19 && h < 23.5) once(`eve:${day + 1}`, () => announcePeriod(tomorrow, false));
      const today = cal.periodOn(config, day);
      if (today && h >= 4.5 && h < 6.5 && !announced.has(`eve:${day}`)) once(`eve:${day}`, () => announcePeriod(today, true));
      if (today && h >= 22.3 && h < 23.8) once(`report:${day}`, () => fleetReport(day));
      if (today && h >= 21 && h < 21.5) once(`hourleft:${day}`, () => say('evening', {}, { priority: 1, ttl: 60 }));
      if (today && h >= 5.6 && h < 6 && !tutorial) once(`morning:${day}`, () => say('morning', {}, { priority: 1, ttl: 40 }));
    }
    // During the first set NOAA and the Coast Guard wait; the morning forecast then runs late (until noon).
    if (tutorial && h >= 6.25 && h < 9) noaaDeferredDay = day;
    if (!tutorial && h >= 6.25 && h < (noaaDeferredDay === day ? 12 : 9)) once(`noaa:${day}:am`, () => noaaBroadcast('am'));
    if (!tutorial && h >= 17.5 && h < 20.5) once(`noaa:${day}:pm`, () => noaaBroadcast('pm'));
    const uscgHour = 9 + keyedRandom(miscSeed, `uscg:${day}`) * 9;
    if (!tutorial && keyedRandom(miscSeed, `uscg-on:${day}`) < 0.7 && h >= uscgHour && h < uscgHour + 1.5) once(`uscg:${day}`, uscgBroadcast);
    if (announced.size > 400) {
      for (const k of [...announced].slice(0, 200)) announced.delete(k);
    }
  }

  // Pete's word on the opener, from the clock: "Opener's at six." before 05:50, then "Six o'clock's coming up.", then
  // "We're open." (the welcome can land late when the radio is busy).
  function openerWords() {
    const p = seiner()?.position;
    if (openerActive(p?.x, p?.z)) return { opener: "We're open.", go: "We're open — go get 'em." };
    const n = nextOpener(p?.x, p?.z);
    if (!n) return { opener: "Season's over.", go: 'Go have a look.' };
    if (n.day !== clock.day) return { opener: `Next opener's ${dateOf(n.day).weekday}.`, go: `Next opener's ${dateOf(n.day).weekday} — go have a look.` };
    if (n.inHours <= 1 / 6) return { opener: "Six o'clock's coming up.", go: "Six o'clock's coming up — get ready." };
    return { opener: "Opener's at six.", go: "Opens at six — go get 'em." };
  }

  function tutorialWelcome() {
    const s = ctx.systems.seiner;
    const me = s?.boatName ?? 'Northern Dawn';
    const words = openerWords();
    if (ctx.state.freeExplore) {
      radio.push({ from: FROM.pete, text: fillTemplate(EXPLORE_WELCOME[0], { me }), channel: CHANNELS.fleet }, { priority: 5, ttl: 60 });
      return;
    }
    const p = s?.position;
    const school = p ? (ctx.systems.fish?.schools ?? [])
      .filter((sc) => sc.state !== 'captured' && sc.state !== 'gone' && sc.position)
      .map((sc) => ({ sc, d: Math.hypot(sc.position.x - p.x, sc.position.z - p.z) }))
      .filter((o) => o.d < 1500)
      .sort((a, b) => (a.sc.species === 'pink' ? 0 : 1) - (b.sc.species === 'pink' ? 0 : 1) || a.d - b.d)[0] : null;
    if (!school) {
      radio.push({ from: FROM.pete, text: fillTemplate(WELCOME_NONE[0], { me, opener: words.opener }), channel: CHANNELS.fleet }, { priority: 5, ttl: 60 });
      return;
    }
    const dx = school.sc.position.x - p.x;
    const dz = school.sc.position.z - p.z;
    const brg = Math.atan2(dx, -dz);
    const dir = COMPASS8[Math.round((((brg * 180) / Math.PI + 360) % 360) / 45) % 8];
    let rel = (((brg - (s.heading ?? 0)) * 180) / Math.PI + 540) % 360 - 180;
    const relText = Math.abs(rel) < 25 ? 'dead ahead' : Math.abs(rel) > 155 ? 'right behind you' : `off your ${rel > 0 ? 'starboard' : 'port'} ${Math.abs(rel) < 70 ? 'bow' : Math.abs(rel) < 115 ? 'beam' : 'quarter'}`;
    // Boats and fish are real size, so Pete judges distance by eye in real miles, not chart miles: ~400 m is "a
    // quarter mile", 500–1,000 m "half a mile".
    const nm = school.d / 1852;
    const dist = nm < 0.15 ? 'a couple hundred yards' : nm < 0.27 ? 'a quarter mile' : nm < 0.75 ? 'half a mile' : nm < 1.25 ? 'about a mile' : `${Math.round(nm)} miles`;
    const text = fillTemplate(WELCOME[Math.floor(radioRng.next() * WELCOME.length)], { me, dist, dir, rel: relText, opener: words.opener, go: words.go });
    radio.push({ from: FROM.pete, text, channel: CHANNELS.fleet }, { priority: 8, ttl: 90 });
  }

  // ---- rest: sleep, wait for the opener, anchor ----

  const seiner = () => ctx.systems.seiner;

  function restBase() {
    const s = seiner();
    if (ctx.state.mode !== 'play' && ctx.state.mode !== 'paused') return { ok: false, reason: 'Not now' };
    if (ctx.state.control !== 'boat') return { ok: false, reason: 'Get back aboard first' };
    if ((ctx.systems.fishing?.state ?? 'idle') !== 'idle') return { ok: false, reason: 'Finish the set first' };
    if ((ctx.systems.skiff?.state ?? 'stowed') !== 'stowed') return { ok: false, reason: 'Get the skiff aboard first' };
    if (!s?.mooring) return { ok: false, reason: 'Anchor or tie up first' };
    return { ok: true };
  }

  function canSleep() {
    const b = restBase();
    if (!b.ok) return b;
    if (!(clock.hours >= 22 || clock.hours < 4)) return { ok: false, reason: 'Sleep after 10 PM' };
    return { ok: true };
  }

  function waitTarget() {
    const p = seiner()?.position;
    const n = nextOpener(p?.x, p?.z);
    if (!n) return null;
    const now = clock.day * 24 + clock.hours;
    let target = n.day * 24 + n.hours - 1; // 05:00, an hour before the period opens
    if (target <= now) target = n.day * 24 + n.hours;
    return { opener: n, hours: target - now };
  }

  function canWait() {
    const b = restBase();
    if (!b.ok) return b;
    if (ctx.state.freeExplore) return { ok: false, reason: 'Always open in Free Explore' };
    const p = seiner()?.position;
    if (openerActive(p?.x, p?.z)) return { ok: false, reason: 'The period is open' };
    const w = waitTarget();
    if (!w) return { ok: false, reason: 'No more periods this season' };
    if (w.hours < 1) return { ok: false, reason: 'Almost time' };
    return { ok: true, ...w };
  }

  function whereLabel() {
    const s = seiner();
    const m = s?.mooring;
    if (m?.kind === 'dock') {
      const pl = ctx.systems.places?.get?.(m.placeId);
      return pl ? `Tied up · ${pl.name}` : 'Tied up';
    }
    const p = s?.position;
    const near = p ? ctx.systems.places?.nearest?.(p.x, p.z, (q) => !q.memorial) : null;
    return near && near.distance < 2500 ? `At anchor · ${near.place.name}` : 'At anchor';
  }

  function skipTo(hours, reason, title) {
    const endAbs = clock.day * 24 + clock.hours + hours;
    const d = dateOf(Math.floor(endAbs / 24));
    const h = endAbs - Math.floor(endAbs / 24) * 24;
    showFade(ctx, { title: title ?? d.long, subtitle: `${cal.clockLabel(h)} · ${whereLabel()}`, holdMs: 1400, fadeMs: 1400 });
    clock.skip(hours, reason);
  }

  function sleep() {
    if (!canSleep().ok) return false;
    const h = clock.hours >= 22 ? 24 - clock.hours + 5 : 5 - clock.hours;
    skipTo(h, 'sleep');
    save.request('sleep');
    return true;
  }

  function waitForOpener() {
    const c = canWait();
    if (!c.ok) return false;
    skipTo(c.hours, 'wait');
    save.request('wait');
    return true;
  }

  function dropAnchor() {
    const s = seiner();
    if (!s || s.mooring) return false;
    s.setMooring?.({ kind: 'anchor' });
    ctx.systems.ui?.toast?.('Anchor down', { kind: 'info', duration: 2.5 });
    return true;
  }

  function offerRest() {
    const s = seiner();
    if (!s || ctx.state.control !== 'boat') return;
    const idle = (ctx.systems.fishing?.state ?? 'idle') === 'idle' && (ctx.systems.skiff?.state ?? 'stowed') === 'stowed';
    if (!idle) return;
    const p = s.position;
    if (s.mooring) {
      const harbor = s.mooring.kind === 'dock' && (ctx.systems.places?.get?.(s.mooring.placeId)?.services?.length ?? 0) > 0;
      if (canSleep().ok) ctx.interact.offer({ id: 'sleep', label: 'Sleep until morning', key: 'interact', priority: harbor ? SLEEP_AT_HARBOR_PRIORITY : SLEEP_PRIORITY, onPress: sleep });
      const w = canWait();
      if (w.ok) {
        const d = dateOf(w.opener.day);
        ctx.interact.offer({ id: 'waitOpener', label: `Wait for the opener — ${d.weekdayShort} ${d.label}`, key: 'interact', priority: WAIT_PRIORITY, onPress: waitForOpener });
      }
      return;
    }
    if (Math.abs(s.speed ?? 0) > 0.6 || ctx.systems.player?.active) return;
    const depth = heightmap.depthAt(p.x, p.z);
    if (depth < 3 || depth > 70) return;
    if (!ctx.state.freeExplore && openerActive(p.x, p.z) && clock.hours < 21) return;
    // Before the first set of a season the fish are the point; the half hour before the opener is no time to anchor.
    if (tutorialQuiet() && clock.hours < 21) return;
    ctx.interact.offer({ id: 'anchor', label: 'Drop anchor', key: 'interact', priority: 30, onPress: dropAnchor });
  }

  // ---- lifecycle ----

  const save = installSave(ctx, ctx.storage ?? undefined);
  const travel = createTravel(ctx);

  // Tracks which period is open so a skip that jumps from one open period into the next still reports both edges.
  function syncOpen(emitEvents) {
    const open = !ctx.state.freeExplore && cal.isOpenAt(config, clock.day, clock.hours);
    const nowDay = open ? clock.day : null;
    if (lastOpen === null || !emitEvents) {
      lastOpen = open;
      openDay = nowDay;
      return;
    }
    lastOpen = open;
    if (nowDay === openDay) {
      if (!open) checkSeasonEnd();
      return;
    }
    if (openDay !== null) {
      creditBoard();
      events.emit('opener:end', { day: openDay });
      if (nowDay === null) say('openerEnd', {}, { priority: 3, ttl: 30, delay: 1.5 });
    }
    if (nowDay !== null) {
      events.emit('opener:start', { day: nowDay });
      if (!tutorialQuiet()) say('openerStart', {}, { priority: 3, ttl: 30, delay: 1.5 });
    }
    openDay = nowDay;
    if (!open) checkSeasonEnd();
  }

  function checkSeasonEnd() {
    const days = config.season.fishingDays;
    const last = days[days.length - 1];
    if (announced.has('season:end') || ctx.state.freeExplore) return;
    if (clock.day < last || (clock.day === last && clock.hours < config.time.openerEnd)) return;
    announced.add('season:end');
    creditBoard();
    radio.push({ from: FROM.adfg, text: 'Fish and Game Kodiak: no further purse seine periods are scheduled in the Kodiak Management Area. Thanks for a safe season, everybody.', channel: CHANNELS.distress }, { priority: 5, ttl: 600, delay: 20 });
    events.emit('season:end', { day: last, board: fleetBoard() });
  }

  const offs = [
    events.on('game:ready', () => {
      rebuildPlaces();
      adoptFleetNames();
    }),
    events.on('game:start', (e) => {
      radio.clear();
      lastSegKey = null;
      lastAppliedPreset = null;
      syncOpen(false);
      applyWeather(0);
      creditBoard();
      welcomeAt = e?.newGame ? radio.time + 3.5 : null;
      // On a new season Pete's welcome comes first; Fish and Game's opening reminder and its closed-waters follow-up
      // come straight after it, so both are done before six and the opener belongs to Pete's tips.
      const today = cal.periodOn(config, clock.day);
      if (e?.newGame && !ctx.state.freeExplore && today && clock.hours < 6.5) {
        announced.add(`eve:${clock.day}`);
        announcePeriod(today, true, 12);
      }
      noaaDeferredDay = null;
      peteCount = 0;
      peteNextAt = radio.time + 150;
    }),
    events.on('game:toTitle', () => radio.clear()),
    events.on('time:skip', () => {
      // Anything queued before the skip is stale (yesterday's chatter, a reminder for a period now past).
      radio.clear();
      mixCache.clear();
      creditBoard();
      if (ctx.state.mode === 'play' || ctx.state.mode === 'paused' || ctx.state.mode === 'map') {
        syncOpen(true);
        lastAppliedPreset = null;
        applyWeather(0);
      }
    }),
    events.on('time:day', () => mixCache.clear()),
    events.on('fishing:setComplete', (e) => {
      if (!e) return;
      if (e.cited) say('cited', {}, { priority: 3, delay: 14, key: 'cited', cooldown: 300 });
      else if (e.rating === 'plugged') say('niceSet', {}, { priority: 4, delay: 5, key: 'niceSet', cooldown: 90 });
      else if (e.rating === 'good' && radioRng.next() < 0.55) say('goodSet', {}, { priority: 3, delay: 6, key: 'goodSet', cooldown: 180 });
      else if (e.waterHaul || e.rating === 'water haul') {
        if (radioRng.next() < 0.6) say('waterHaul', {}, { priority: 3, delay: 6, key: 'waterHaul', cooldown: 240 });
      }
    }),
    events.on('fishing:snag', () => {
      if (radioRng.next() < 0.45) say('snag', {}, { priority: 2, delay: 5, key: 'snag', cooldown: 300 });
    }),
    events.on('bear:encounter', (e) => {
      if (e?.stage === 'charge') say('bearCharge', {}, { priority: 3, delay: 8, key: 'bearCharge', cooldown: 600, ttl: 90 });
    }),
    events.on('economy:delivered', (r) => {
      const t = tenders().find((x) => x.name === r?.tender) ?? null;
      if (!t) return;
      const lbs = Math.round(r.lines?.reduce((a, l) => a + l.lbs, 0) ?? 0).toLocaleString('en-US');
      say('delivered', { kind: 'tender', extra: { tenderObj: t, lbs } }, { priority: 4, delay: 2, key: 'delivered', cooldown: 30 });
    }),
    events.on('economy:holdFull', () => say('holdFull', { kind: 'pete' }, { priority: 3, delay: 3, key: 'holdFull', cooldown: 900 })),
    events.on('economy:goal', (e) => {
      if (e?.label === 'Highliner') say('highliner', { kind: 'tender' }, { priority: 4, delay: 4 });
      else if (Number.isFinite(e?.index)) {
        const line = LINES.goal[Math.min(LINES.goal.length - 1, e.index)];
        radio.push({ from: FROM.pete, text: fillTemplate(line, tokens()), channel: CHANNELS.fleet }, { priority: 4, delay: 4, ttl: 120 });
      }
    }),
    // A coaching tip on the radio (ui:hint with a speaker): hold routine traffic while it is read.
    events.on('ui:hint', (e) => {
      if (e?.from && e.text && ctx.state.mode === 'play') radio.hold(tipHoldSeconds(e.text));
    }),
    // The seiner inside the Marmot Island rookery buffer: NOAA Fisheries reminds it of the no-approach zone.
    events.on('wildlife:disturbed', (e) => {
      if (!e?.closed || ctx.state.mode !== 'play') return;
      const site = ctx.systems.places?.get?.(e.siteId)?.name;
      const where = site ? spokenName(site) : 'Marmot Island';
      const me = seiner()?.boatName ?? 'Northern Dawn';
      const text = `${me}, NOAA Fisheries on one-six. You are inside the ${where} sea lion rookery buffer. Steller sea lion rookeries carry a three-mile no-approach zone — turn away now and stay outside three miles.`;
      radio.push({ from: FROM.nmfs, text, channel: CHANNELS.distress }, { priority: 5, ttl: 60, delay: 1.5, key: 'rookery', cooldown: 600 });
    }),
    events.on('weather:change', (e) => {
      if (ctx.state.mode !== 'play') return;
      if (e?.preset === 'fog') say('fogIn', {}, { priority: 2, delay: 20, key: 'fogIn', cooldown: 1200 });
      if (e?.preset === 'storm') say('blowIn', {}, { priority: 2, delay: 15, key: 'blowIn', cooldown: 1200 });
    }),
  ];

  const sys = {
    // Required API
    openerActive,
    nextOpener,
    speciesMix,
    priceFor,
    forecast,
    closedWaters,
    isClosedWater: (x, z) => !!closedWaterAt(x, z),

    // Extras for other systems and the UI
    closedWaterAt,
    districtAt: districtIdAt,
    districtName: districtLabel,
    openerStatus,
    period: (day = clock.day) => {
      const p = cal.periodOn(config, day);
      return p ? { ...p, date: dateOf(day).label, closedNames: p.closed.map(districtLabel) } : null;
    },
    schedule: () => config.season.fishingDays.map((d) => ({ day: d, date: dateOf(d).label, weekday: dateOf(d).weekdayShort, closed: cal.periodOn(config, d).closed, past: d < clock.day || (d === clock.day && clock.hours >= config.time.openerEnd) })),
    weatherPlan,
    scheduledWeather: (day = clock.day, hours = clock.hours) => presetAt(weatherPlan, day, hours),
    fleetBoard,
    get fleetNames() {
      return fleetList.map((b) => ({ name: b.name, skipper: b.skipper, homeport: b.homeport }));
    },
    tenderChannel,
    radioSay,
    say: (category, opts, queue) => say(category, opts, queue),
    canSleep,
    canWait,
    sleep,
    waitForOpener,
    dropAnchor,
    save,
    travel,

    update(dt) {
      if (ctx.state.mode !== 'play') return;
      syncOpen(true);
      if (!ctx.debug?.weatherPinned && segmentKey(weatherPlan, clock.day, clock.hours) !== lastSegKey) applyWeather(90);
      scheduled();
      if (welcomeAt !== null && radio.time >= welcomeAt) {
        welcomeAt = null;
        tutorialWelcome();
      }
      if (!ctx.state.freeExplore && clock.day <= 5 && lastOpen && peteCount < 4 && radio.time >= peteNextAt && (ctx.systems.fishing?.state ?? 'idle') === 'idle' && !tutorialQuiet()) {
        peteNextAt = radio.time + 190 + radioRng.next() * 140;
        const m = compose('pete', { kind: 'pete' });
        if (m && radio.push(m, { priority: 1, ttl: 30 })) peteCount++;
      }
      radio.update(dt, { open: lastOpen || !!ctx.state.freeExplore, hours: clock.hours, fishingDay: cal.isFishingDay(config, clock.day), preset: ctx.systems.sky?.weather?.preset ?? null, quiet: false, ambientScale: tutorialQuiet() ? TUTORIAL_AMBIENT_SCALE : 1 }, ambient);
      offerRest();
    },

    frame() {
      if (save.pending) save.flush();
    },

    debugState() {
      const p = seiner()?.position;
      const n = nextOpener();
      return {
        open: openerActive(p?.x, p?.z),
        district: p ? districtIdAt(p.x, p.z) : null,
        next: n ? n.label : null,
        weather: presetAt(weatherPlan, clock.day, clock.hours),
        pinned: !!ctx.debug?.weatherPinned,
        closedWaters: closedWaters.length,
        radioQueued: radio.queued,
        boardTop: board.boats.reduce((a, b) => (b.gross > a.gross ? b : a), board.boats[0])?.name,
      };
    },

    serialize() {
      return { v: 1, board: serializeBoard(board) };
    },
    restore(d) {
      board = restoreBoard(d?.board, fleetList);
    },
    reset() {
      board = createBoard(fleetList);
      announced.clear();
      radio.clear();
      mixCache.clear();
      lastOpen = null;
      openDay = null;
      lastSegKey = null;
      lastAppliedPreset = null;
      welcomeAt = null;
      noaaDeferredDay = null;
      save.suspend();
    },
    dispose() {
      for (const off of offs) off?.();
      save.uninstall();
    },
  };
  return sys;
}
