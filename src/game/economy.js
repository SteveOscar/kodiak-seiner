// Economy (WP-RULES): cash and the cannery advance, the fish hold, fuel burn / warnings / tow, deliveries and fish
// tickets, refuelling, tying up at harbors, the upgrade catalog and modifiers, and the season goals.
// Money rules live in src/game/data/market.js and the catalog in src/game/data/upgrades.js.

import { SPECIES, emptyCatch, lbsOf, fillHold, buildTicket, fuelBurnPerHour, fuelPriceAt, affordableGallons, towQuote, formatMoney, round2, spokenDollars } from './data/market.js';
import { UPGRADES, SPOTTER, SPOTTER_ID, computeModifiers, catalogRows, upgradeById, fathoms } from './data/upgrades.js';
import { dateOf as calDate, clockLabel, STAT_AREAS, normalizeDistrict, nextOpenerAfter, isOpenAt } from './data/calendar.js';
import { showFade } from './travel.js';
import { SEASON_GOALS } from './data/fleetBoard.js';

const DELIVER_RANGE = 35; // m of water between the hulls
const DELIVER_SPEED = 2; // m/s
const DOCK_RANGE = 90; // m from a harbor's dock point for "Tie up"
const HIGHLINER_FROM_PERIOD = 5; // index into fishingDays: the board counts from the sixth period on

export async function create(ctx) {
  const { config, clock, events } = ctx;
  const eco = config.economy;
  // Goal thresholds are paced on the fleet board's competent rate (data/fleetBoard.js); labels follow config.
  const goalList = SEASON_GOALS.map((g, i) => ({ gross: g.gross, label: eco.goals?.[i]?.label ?? g.label }));
  const table = config.fish.species;
  const rng = ctx.rng.fork('economy');
  const ticketBase = 300000 + Math.floor(rng.next() * 600000);
  const permit = `S01K-${String(10000 + Math.floor(rng.next() * 89999))}`;

  let ticketSeq = 0;
  let spotterUntilDay = -1;
  let fuelNoticeLevel = 1; // lowest warning threshold already announced (1 = none)
  let emptyAnnounced = false;
  let lastFuelEmit = eco.fuelCapacity;
  let advanceNoticed = false;
  let lastBuyError = null;

  const newStats = () => ({
    seasonGross: 0,
    sets: 0,
    deliveries: 0,
    bestSetLbs: 0,
    bestSetValue: 0,
    bestDelivery: 0,
    lbsDelivered: 0,
    fishDelivered: emptyCatch(),
    crewPaid: 0,
    fuelBurned: 0,
    fuelBought: 0,
    fuelSpend: 0,
    upgradesSpend: 0,
    fines: 0,
    bonuses: 0,
    tows: 0,
    advanceMax: 0,
    goals: [],
    daily: {},
  });

  const modifiers = computeModifiers(config, {}, -1);

  const sys = {
    cash: eco.startingCash,
    hold: emptyCatch(),
    fuel: eco.fuelCapacity,
    fuelCapacity: eco.fuelCapacity,
    upgrades: {},
    stats: newStats(),
    modifiers,
    permit,

    get capacityLbs() {
      return modifiers.holdLbs;
    },
    get fuelEmpty() {
      return sys.fuel <= 0;
    },
    get advance() {
      return Math.max(0, -sys.cash);
    },
    get catalog() {
      return catalogRows(config, sys.upgrades, { cash: sys.cash, day: clock.day, spotterUntilDay });
    },
    get lastBuyError() {
      return lastBuyError;
    },

    holdLbs: () => lbsOf(sys.hold, table),
    holdFraction: () => sys.holdLbs() / Math.max(1, modifiers.holdLbs),

    addCatch(counts) {
      const r = fillHold(sys.hold, counts ?? {}, modifiers.holdLbs, table);
      for (const k of SPECIES) sys.hold[k] = r.hold[k];
      if (!ctx.state.freeExplore) {
        sys.stats.bestSetLbs = Math.max(sys.stats.bestSetLbs, r.acceptedLbs);
      }
      const overflowFish = SPECIES.reduce((a, k) => a + (table[k]?.release ? 0 : r.overflow[k]), 0);
      if (overflowFish > 0 || sys.holdLbs() >= modifiers.holdLbs * 0.995) {
        events.emit('economy:holdFull', {});
        ctx.systems.ui?.toast?.(`Hold's plugged — ${Math.round(sys.holdLbs()).toLocaleString('en-US')} lb aboard. Deliver to a tender.`, { kind: 'warn', duration: 5 });
      }
      return { accepted: r.accepted, overflow: r.overflow, acceptedLbs: r.acceptedLbs };
    },

    // Sells the hold to a tender (or a cannery dock). → receipt (SPEC §7 economy:delivered) or null when empty.
    deliver(buyer) {
      const b = buyer ?? nearestBuyer();
      if (sys.holdLbs() <= 0) return null;
      const buyerId = b?.id ?? null;
      const season = ctx.systems.season;
      const priceOf = (sp) => {
        const p = season?.priceFor?.(sp, buyerId);
        return Number.isFinite(p) ? p : round2((table[sp]?.price ?? 0) + (modifiers.rswBonus ?? 0));
      };
      const t = buildTicket(sys.hold, table, priceOf, eco.crewShare);
      const pos = ctx.systems.seiner?.position ?? { x: 0, z: 0 };
      const districtId = season?.districtAt?.(pos.x, pos.z) ?? normalizeDistrict(ctx.systems.places?.districtAt?.(pos.x, pos.z));
      const district = season?.districtName?.(districtId) ?? ctx.systems.places?.districtAt?.(pos.x, pos.z) ?? 'Kodiak Management Area';
      const sub = String(10 + (Math.abs(Math.floor(pos.x / 900) * 7 + Math.floor(pos.z / 900) * 3) % 80)).padStart(2, '0');
      ticketSeq++;
      const before = sys.cash;
      sys.cash = round2(sys.cash + t.net);
      const d = calDate(config, clock.day);
      const receipt = {
        ticket: `K26-${String(ticketBase + ticketSeq).padStart(6, '0')}`,
        date: `${d.label}, 2026`,
        day: clock.day,
        time: clockLabel(clock.hours),
        tender: b?.name ?? 'Tender',
        tenderId: buyerId,
        district,
        statArea: `${STAT_AREAS[districtId] ?? 259}-${sub}`,
        permit,
        vessel: ctx.systems.seiner?.boatName ?? 'Northern Dawn',
        gear: '01 Purse seine',
        condition: modifiers.rswBonus > 0 ? 'RSW' : 'Iced',
        lines: t.lines,
        totalLbs: t.totalLbs,
        gross: t.gross,
        crewShare: t.crewShare,
        crew: t.crew,
        net: t.net,
        advanceRepaid: before < 0 ? round2(Math.min(-before, t.net)) : 0,
        cashAfter: sys.cash,
      };
      for (const k of SPECIES) {
        if (!table[k]?.release) sys.stats.fishDelivered[k] += sys.hold[k];
        sys.hold[k] = 0;
      }
      const st = sys.stats;
      st.seasonGross = round2(st.seasonGross + t.gross);
      st.deliveries++;
      st.lbsDelivered += t.totalLbs;
      st.crewPaid = round2(st.crewPaid + t.crewShare);
      st.bestDelivery = Math.max(st.bestDelivery, t.gross);
      const day = (st.daily[clock.day] ??= { gross: 0, lbs: 0 });
      day.gross = round2(day.gross + t.gross);
      day.lbs += t.totalLbs;
      events.emit('economy:cash', { cash: sys.cash, delta: t.net, reason: 'delivery' });
      events.emit('economy:delivered', receipt);
      checkGoals();
      return receipt;
    },

    refuelQuote(source) {
      const src = resolveFuelSource(source);
      const price = fuelPriceAt(src, eco);
      const wanted = Math.max(0, Math.floor(sys.fuelCapacity - sys.fuel));
      const gallons = affordableGallons(sys.cash, price, eco.advanceLimit, wanted);
      return { source: src?.name ?? null, price, wanted, gallons, cost: round2(gallons * price) };
    },

    // Fills the tanks at a place (by object or id) or tender; undefined = where we are. → { ok, gallons, cost, price }
    refuel(source) {
      const q = sys.refuelQuote(source);
      if (q.wanted <= 0) return { ok: false, reason: 'Tanks are full', ...q };
      if (q.gallons <= 0) return { ok: false, reason: 'The cannery won’t front you any more fuel', ...q };
      if (ctx.state.freeExplore) {
        sys.fuel = sys.fuelCapacity;
        onFuelChanged(true);
        return { ok: true, ...q, cost: 0 };
      }
      sys.fuel = Math.min(sys.fuelCapacity, sys.fuel + q.gallons);
      spend(q.cost, 'fuel');
      sys.stats.fuelBought += q.gallons;
      sys.stats.fuelSpend = round2(sys.stats.fuelSpend + q.cost);
      onFuelChanged(true);
      ctx.systems.ui?.toast?.(`Took on ${q.gallons.toLocaleString('en-US')} gal at ${formatMoney(q.price, true)} — ${formatMoney(q.cost)}`, { kind: 'info', duration: 4 });
      return { ok: true, ...q };
    },

    canBuy(id) {
      if (id === SPOTTER_ID) {
        const day = spotterDay();
        if (day === null) return { ok: false, reason: 'No more periods this season', price: SPOTTER.price };
        if (spotterUntilDay >= day) return { ok: false, reason: 'Already chartered', price: SPOTTER.price };
        if (sys.cash < SPOTTER.price) return { ok: false, reason: 'Not enough cash', price: SPOTTER.price };
        return { ok: true, price: SPOTTER.price, day };
      }
      const u = upgradeById(id);
      if (!u) return { ok: false, reason: 'Unknown upgrade' };
      const level = sys.upgrades[id] ?? 0;
      const tier = u.tiers[level];
      if (!tier) return { ok: false, reason: 'Already at the maximum', price: null };
      if (sys.cash < tier.price) return { ok: false, reason: 'Not enough cash', price: tier.price };
      if (!atUpgradeYard()) return { ok: false, reason: 'Tie up at the Kodiak harbor to have it fitted', price: tier.price };
      return { ok: true, price: tier.price, label: tier.label };
    },

    // Buys the next tier of an upgrade (or a spotter charter). Purchases need positive cash. → boolean
    buy(id) {
      const c = sys.canBuy(id);
      lastBuyError = c.ok ? null : c.reason;
      if (!c.ok) return false;
      if (id === SPOTTER_ID) {
        spotterUntilDay = c.day;
        spend(SPOTTER.price, 'spotter');
        recompute();
        const d = calDate(config, c.day);
        ctx.systems.ui?.toast?.(`Spotter plane chartered for ${c.day === clock.day ? 'today' : `${d.weekdayShort} ${d.label}`}`, { kind: 'purchase', duration: 4 });
        events.emit('economy:purchase', { id, level: 1, price: SPOTTER.price, day: c.day });
        return true;
      }
      sys.upgrades[id] = (sys.upgrades[id] ?? 0) + 1;
      spend(c.price, 'upgrade');
      sys.stats.upgradesSpend += c.price;
      recompute();
      ctx.systems.ui?.toast?.(`${c.label} fitted — ${formatMoney(c.price)}`, { kind: 'purchase', duration: 4 });
      events.emit('economy:purchase', { id, level: sys.upgrades[id], price: c.price });
      return true;
    },

    // Fines (negative), bonuses (positive). Cash never goes below the cannery advance limit.
    addCash(delta, reason = '') {
      const d = Number(delta) || 0;
      if (!d) return sys.cash;
      if (ctx.state.freeExplore && d < 0 && /fine|citation|trooper|penalt/i.test(reason)) return sys.cash;
      if (d < 0) {
        if (/fine|citation|trooper|penalt/i.test(reason)) sys.stats.fines = round2(sys.stats.fines - d);
        spend(-d, reason);
      } else {
        sys.cash = round2(sys.cash + d);
        if (/discover|bonus|token/i.test(reason)) sys.stats.bonuses = round2(sys.stats.bonuses + d);
        events.emit('economy:cash', { cash: sys.cash, delta: d, reason });
      }
      return sys.cash;
    },

    useFuel(gallons, reason = 'engine') {
      const g = Math.max(0, Number(gallons) || 0);
      if (!g || ctx.state.freeExplore) return sys.fuel;
      sys.fuel = Math.max(0, sys.fuel - g);
      sys.stats.fuelBurned += g;
      onFuelChanged(reason !== 'engine');
      return sys.fuel;
    },

    // What a tow costs right now: { gallons, fee, fuelCost, total } — the flat fee plus a fill to 25% at the tender.
    towQuote() {
      return towQuote(sys.fuel, sys.fuelCapacity, eco, fuelPriceAt({ isTender: true }, eco));
    },

    // Out of fuel: the nearest tender tows you alongside for the flat fee plus a fill to 25%.
    acceptTow() {
      const t = nearestTender();
      const s = ctx.systems.seiner;
      if (!s) return false;
      const q = sys.towQuote();
      const travel = ctx.systems.season?.travel;
      const dest = t ? travel?.resolveTarget?.(t) : travel?.resolveTarget?.('kodiak');
      showFade(ctx, { title: t ? `Under tow — ${t.name}` : 'Under tow to Kodiak', subtitle: `${formatMoney(q.total)} · ${formatMoney(q.fee)} tow + ${q.gallons.toLocaleString('en-US')} gal of diesel`, holdMs: 1600, fadeMs: 1300 });
      const dist = dest ? Math.hypot(dest.x - s.position.x, dest.z - s.position.z) : 0;
      if (s.mooring) s.setMooring?.(null);
      if (dest) ctx.game.teleport(dest.x, dest.z, dest.heading ?? s.heading, { reason: 'tow' });
      const hours = Math.min(8, Math.max(0.5, ctx.geo.toNauticalMiles(dist) / 6));
      clock.skip(hours, 'tow');
      sys.fuel = Math.max(sys.fuel, sys.fuelCapacity * 0.25);
      spend(q.total, 'tow');
      sys.stats.tows++;
      sys.stats.fuelBought += q.gallons;
      sys.stats.fuelSpend = round2(sys.stats.fuelSpend + q.fuelCost);
      onFuelChanged(true);
      if (dest?.kind === 'place') s.setMooring?.({ kind: 'dock', placeId: dest.placeId });
      events.emit('economy:tow', { tender: t?.name ?? null, cost: q.total, gallons: q.gallons, hours });
      return true;
    },

    // Ties up at a harbor's dock (snaps to the berth behind a short fade; autosaves via boat:mooring).
    tieUp(place) {
      const p = typeof place === 'string' ? ctx.systems.places?.get?.(place) : place;
      const s = ctx.systems.seiner;
      if (!p || !s) return false;
      const dock = dockOf(p);
      if (!dock) return false;
      showFade(ctx, { title: p.name, subtitle: 'Tied up', holdMs: 350, fadeMs: 900 });
      ctx.game.teleport(dock.x, dock.z, dock.heading, { reason: 'dock' });
      s.setMooring?.({ kind: 'dock', placeId: p.id });
      const services = (p.services ?? []).filter((x) => x !== 'rest');
      ctx.systems.ui?.toast?.(`Tied up at ${p.name}${services.length ? ` — ${services.map(serviceLabel).join(', ')}` : ''}`, { kind: 'info', duration: 4 });
      ctx.systems.ui?.hint?.('harbor', 'In the harbor: sell your catch, take on fuel, buy upgrades (Kodiak) and rest. E opens the harbor services; sleep after 10 PM or wait here for the next opener.');
      return true;
    },

    // Where we are tied up (place) or null.
    dockedAt() {
      const m = ctx.systems.seiner?.mooring;
      if (m?.kind !== 'dock') return null;
      return ctx.systems.places?.get?.(m.placeId) ?? null;
    },

    // Services available right now: { at: name, kind: 'place'|'tender'|null, services: [...] }
    services() {
      const p = sys.dockedAt();
      if (p) return { at: p.name, kind: 'place', placeId: p.id, services: p.services ?? [] };
      const t = tenderAlongside();
      if (t) return { at: t.name, kind: 'tender', tenderId: t.id, services: t.services ?? ['sell', 'fuel'] };
      return { at: null, kind: null, services: [] };
    },

    // Spotter plane flies the chartered day while a period is open, never over the Mainland District.
    spotterActive(x, z) {
      if (modifiers.spotterUntilDay < clock.day || spotterUntilDay < clock.day) return false;
      const season = ctx.systems.season;
      if (!(season?.openerActive?.(x, z) ?? isOpenAt(config, clock.day, clock.hours))) return false;
      if (x !== undefined && season?.districtAt?.(x, z) === 'mainland') return false;
      return true;
    },

    goals() {
      const out = goalList.map((g, i) => ({ id: `goal${i}`, label: g.label, gross: g.gross, reached: sys.stats.goals.includes(g.label) }));
      out.push({ id: 'highliner', label: 'Highliner', gross: null, reached: sys.stats.goals.includes('Highliner'), description: 'Top of the fleet board' });
      return out;
    },

    // Human-readable effect of the current modifiers, for the harbor menu.
    gearSummary() {
      return {
        seine: `${fathoms(modifiers.netLength)} fm × ${Math.round(modifiers.netDepth)} m`,
        sonar: `${modifiers.sonarRange} m`,
        hold: `${modifiers.holdLbs.toLocaleString('en-US')} lb`,
        speed: `${(ctx.geo.toKnots(modifiers.maxSpeed)).toFixed(1)} kn`,
      };
    },

    update(dt) {
      if (ctx.state.mode !== 'play') return;
      const s = ctx.systems.seiner;
      if (!s) return;
      if (!ctx.state.freeExplore && dt > 0) {
        const hours = (dt * clock.scale) / 60;
        const g = fuelBurnPerHour(s.engineLoad ?? 0, eco) * hours;
        if (g > 0 && sys.fuel > 0) {
          sys.fuel = Math.max(0, sys.fuel - g);
          sys.stats.fuelBurned += g;
          onFuelChanged(false);
        }
      }
      offers(s);
    },

    debugState() {
      return {
        cash: Math.round(sys.cash),
        holdLbs: Math.round(sys.holdLbs()),
        fuel: Math.round(sys.fuel),
        fuelEmpty: sys.fuelEmpty,
        gross: Math.round(sys.stats.seasonGross),
        deliveries: sys.stats.deliveries,
        upgrades: { ...sys.upgrades },
        goals: [...sys.stats.goals],
      };
    },

    serialize() {
      return {
        cash: sys.cash,
        hold: { ...sys.hold },
        fuel: sys.fuel,
        upgrades: { ...sys.upgrades },
        stats: JSON.parse(JSON.stringify(sys.stats)),
        spotterUntilDay,
        ticketSeq,
      };
    },

    restore(d) {
      if (!d) return;
      sys.cash = Number.isFinite(d.cash) ? d.cash : eco.startingCash;
      for (const k of SPECIES) sys.hold[k] = Math.max(0, Math.floor(d.hold?.[k] ?? 0));
      sys.fuel = Math.max(0, Math.min(sys.fuelCapacity, Number.isFinite(d.fuel) ? d.fuel : sys.fuelCapacity));
      sys.upgrades = {};
      for (const u of UPGRADES) {
        const lvl = Math.floor(d.upgrades?.[u.id] ?? 0);
        if (lvl > 0) sys.upgrades[u.id] = Math.min(u.tiers.length, lvl);
      }
      const st = newStats();
      Object.assign(st, d.stats ?? {});
      st.fishDelivered = { ...emptyCatch(), ...(d.stats?.fishDelivered ?? {}) };
      st.goals = Array.isArray(d.stats?.goals) ? [...d.stats.goals] : [];
      st.daily = d.stats?.daily && typeof d.stats.daily === 'object' ? { ...d.stats.daily } : {};
      sys.stats = st;
      spotterUntilDay = Number.isFinite(d.spotterUntilDay) ? d.spotterUntilDay : -1;
      ticketSeq = Number.isFinite(d.ticketSeq) ? d.ticketSeq : 0;
      recompute();
      syncFuelState();
    },

    reset() {
      sys.cash = eco.startingCash;
      for (const k of SPECIES) sys.hold[k] = 0;
      sys.fuel = eco.fuelCapacity;
      sys.upgrades = {};
      sys.stats = newStats();
      spotterUntilDay = -1;
      ticketSeq = 0;
      advanceNoticed = false;
      lastBuyError = null;
      recompute();
      syncFuelState();
    },
  };

  // ---- helpers ----

  function recompute() {
    Object.assign(modifiers, computeModifiers(config, sys.upgrades, spotterUntilDay));
  }

  function spend(amount, reason) {
    const a = Math.max(0, amount);
    const before = sys.cash;
    sys.cash = round2(Math.max(eco.advanceLimit, sys.cash - a));
    sys.stats.advanceMax = Math.max(sys.stats.advanceMax, -sys.cash);
    events.emit('economy:cash', { cash: sys.cash, delta: round2(sys.cash - before), reason });
    if (sys.cash < 0 && !advanceNoticed) {
      advanceNoticed = true;
      ctx.systems.ui?.toast?.(`The cannery fronts you an advance — ${formatMoney(-sys.cash)} owed, repaid from your fish tickets.`, { kind: 'warn', duration: 6 });
    }
  }

  function syncFuelState() {
    const s = ctx.systems.seiner;
    s?.setSpeedLimit?.('fuel', sys.fuel <= 0 && !ctx.state.freeExplore ? 2 : null);
    const f = sys.fuel / sys.fuelCapacity;
    fuelNoticeLevel = f <= 0.1 ? 0.1 : f <= 0.2 ? 0.2 : 1;
    emptyAnnounced = sys.fuel <= 0;
    lastFuelEmit = sys.fuel;
  }

  function onFuelChanged(force) {
    const f = sys.fuel / sys.fuelCapacity;
    const ui = ctx.systems.ui;
    if (f > fuelNoticeLevel + 0.05) fuelNoticeLevel = f > 0.25 ? 1 : f > 0.15 ? 0.2 : 0.1;
    if (sys.fuel > 0 && emptyAnnounced) {
      emptyAnnounced = false;
      ctx.systems.seiner?.setSpeedLimit?.('fuel', null);
    }
    if (f <= 0.2 && fuelNoticeLevel > 0.2 && sys.fuel > 0) {
      fuelNoticeLevel = 0.2;
      ui?.toast?.(`Fuel at 20% — ${Math.round(sys.fuel).toLocaleString('en-US')} gal. Top off at a tender or in town.`, { kind: 'warn', duration: 6 });
      ui?.hint?.('fuel', 'Tenders and harbors sell diesel. Come alongside a tender (E) or tie up in town, where it is cheapest.');
    }
    if (f <= 0.1 && fuelNoticeLevel > 0.1 && sys.fuel > 0) {
      fuelNoticeLevel = 0.1;
      ui?.toast?.(`Fuel at 10% — ${Math.round(sys.fuel).toLocaleString('en-US')} gal left!`, { kind: 'warn', duration: 6 });
      const t = nearestTender();
      if (t) ctx.systems.season?.say?.('lowFuel', { kind: 'tender', extra: { tenderObj: t } }, { priority: 3, key: 'lowFuel', cooldown: 600 });
    }
    if (sys.fuel <= 0 && !emptyAnnounced) {
      emptyAnnounced = true;
      ctx.systems.seiner?.setSpeedLimit?.('fuel', 2);
      ui?.toast?.('Out of fuel — limping on the fumes.', { kind: 'warn', duration: 6 });
      const t = nearestTender();
      const q = sys.towQuote();
      if (t) ctx.systems.season?.say?.('tow', { kind: 'tender', extra: { tenderObj: t, towFee: spokenDollars(q.fee), towTotal: spokenDollars(q.total) } }, { priority: 5, key: 'tow', cooldown: 300 });
      events.emit('economy:fuel', { fuel: 0, empty: true });
      lastFuelEmit = 0;
      return;
    }
    if (force || Math.abs(lastFuelEmit - sys.fuel) >= 25) {
      lastFuelEmit = sys.fuel;
      events.emit('economy:fuel', { fuel: sys.fuel, empty: sys.fuel <= 0 });
    }
  }

  function checkGoals() {
    if (ctx.state.freeExplore) return;
    const st = sys.stats;
    goalList.forEach((g, i) => {
      if (st.seasonGross >= g.gross && !st.goals.includes(g.label)) {
        st.goals.push(g.label);
        ctx.systems.ui?.toast?.(`Season goal: ${g.label} — ${formatMoney(g.gross)} gross`, { kind: 'goal', duration: 7 });
        events.emit('economy:goal', { label: g.label, gross: g.gross, index: i });
      }
    });
  }

  function checkHighliner(day) {
    if (ctx.state.freeExplore || sys.stats.goals.includes('Highliner')) return;
    const idx = config.season.fishingDays.indexOf(day);
    if (idx < HIGHLINER_FROM_PERIOD) return;
    const rows = ctx.systems.season?.fleetBoard?.();
    if (!rows?.length || !rows[0].player || rows[0].gross <= 0) return;
    sys.stats.goals.push('Highliner');
    ctx.systems.ui?.toast?.('Highliner! Top of the Kodiak fleet board.', { kind: 'goal', duration: 8 });
    events.emit('economy:goal', { label: 'Highliner', gross: sys.stats.seasonGross, index: goalList.length });
  }

  function spotterDay() {
    const t = config.time;
    if (isOpenAt(config, clock.day, clock.hours) || (config.season.fishingDays.includes(clock.day) && clock.hours < t.openerStart)) return clock.day;
    return nextOpenerAfter(config, clock.day, clock.hours)?.day ?? null;
  }

  function atUpgradeYard() {
    const p = sys.dockedAt();
    return !!p && (p.services ?? []).includes('upgrades');
  }

  const tenders = () => (ctx.systems.fleet?.tenders ?? []).filter((t) => t?.position);

  function nearestTender() {
    const s = ctx.systems.seiner?.position;
    const list = tenders();
    if (!s || !list.length) return null;
    let best = null;
    let bd = Infinity;
    for (const t of list) {
      const d = Math.hypot(t.position.x - s.x, t.position.z - s.z);
      if (d < bd) {
        bd = d;
        best = t;
      }
    }
    return best;
  }

  function tenderGap(t) {
    const s = ctx.systems.seiner?.position;
    if (!s || !t?.position) return Infinity;
    return Math.hypot(t.position.x - s.x, t.position.z - s.z) - (t.radius ?? 15);
  }

  function tenderAlongside() {
    const t = nearestTender();
    return t && tenderGap(t) < DELIVER_RANGE ? t : null;
  }

  function nearestBuyer() {
    const p = sys.dockedAt();
    if (p && (p.services ?? []).includes('sell')) return { id: p.id, name: p.name, isPlace: true };
    return nearestTender();
  }

  function resolveFuelSource(source) {
    if (source && typeof source === 'object') {
      if (source.position && (source.services || source.buying !== undefined)) return { ...source, isTender: true, name: source.name };
      return source;
    }
    if (typeof source === 'string') {
      const p = ctx.systems.places?.get?.(source);
      if (p) return p;
      const t = tenders().find((x) => x.id === source);
      if (t) return { ...t, isTender: true };
    }
    const docked = sys.dockedAt();
    if (docked) return docked;
    const t = tenderAlongside();
    if (t) return { ...t, isTender: true };
    return { kind: 'town', id: 'kodiak', name: 'Kodiak' };
  }

  function dockOf(p) {
    return ctx.systems.season?.travel?.resolveTarget?.({ kind: 'place', id: p.id, placeId: p.id }) ?? (p.dock && Number.isFinite(p.dock.x) ? p.dock : null);
  }

  const serviceLabel = (s) => ({ sell: 'fish buyer', fuel: 'fuel', upgrades: 'boatyard', ice: 'ice', rest: 'rest' })[s] ?? s;

  let harborCache = null;
  let harborList = null;
  function harborPlaces() {
    const list = ctx.systems.places?.list ?? [];
    if (list !== harborList) {
      harborList = list;
      harborCache = list.filter((p) => !p.memorial && (p.services?.length ?? 0) > 0);
    }
    return harborCache;
  }

  function offers(s) {
    if (ctx.state.control !== 'boat') return;
    if ((ctx.systems.fishing?.state ?? 'idle') !== 'idle') return;
    const I = ctx.interact;
    const speed = Math.abs(s.speed ?? 0);
    const holdLbs = sys.holdLbs();
    const docked = sys.dockedAt();
    const free = ctx.state.freeExplore;

    // Out of fuel: the tow offer (unless a tender is already alongside to refuel from).
    if (sys.fuel <= 0 && !free && !tenderAlongside() && !docked) {
      const t = nearestTender();
      const q = sys.towQuote();
      const price = `${formatMoney(q.total)} incl. ${q.gallons.toLocaleString('en-US')} gal diesel`;
      I.offer({ id: 'tow', label: t ? `Accept a tow from the ${t.name} — ${price}` : `Call for a tow — ${price}`, key: 'interact', priority: 66, onPress: () => sys.acceptTow() });
    }

    const t = tenderAlongside();
    if (t && speed < DELIVER_SPEED) {
      if (holdLbs > 0 && t.buying !== false) {
        I.offer({ id: 'deliver', label: `Deliver to the ${t.name}`, key: 'interact', priority: 60, onPress: () => sys.deliver(t) });
      } else if (!free && sys.fuel < sys.fuelCapacity * 0.97 && (t.services ?? ['fuel']).includes('fuel')) {
        const q = sys.refuelQuote(t);
        if (q.gallons > 0) I.offer({ id: 'refuel', label: `Take on fuel — ${q.gallons.toLocaleString('en-US')} gal · ${formatMoney(q.cost)}`, key: 'interact', priority: 59, onPress: () => sys.refuel(t) });
      }
    }

    // Tied up: Sell (68), Fuel up (67) and Harbor services (64) outrank the night's "Sleep until morning" (62 at a
    // harbor, see season.js); the harbor panel carries its own Sleep and Wait buttons.
    if (docked) {
      const svc = docked.services ?? [];
      if (holdLbs > 0 && svc.includes('sell')) {
        I.offer({ id: 'deliver', label: `Sell your catch at ${docked.name}`, key: 'interact', priority: 68, onPress: () => sys.deliver({ id: docked.id, name: docked.name }) });
      } else if (!free && svc.includes('fuel') && sys.fuel < sys.fuelCapacity * 0.9) {
        const q = sys.refuelQuote(docked);
        if (q.gallons > 0) I.offer({ id: 'refuel', label: `Fuel up — ${q.gallons.toLocaleString('en-US')} gal · ${formatMoney(q.cost)}`, key: 'interact', priority: 67, onPress: () => sys.refuel(docked) });
      }
      const ui = ctx.systems.ui;
      if (typeof ui?.openHarbor === 'function') {
        I.offer({ id: 'harbor', label: `${docked.name} — Harbor services`, key: 'interact', priority: 64, onPress: () => ui.openHarbor(docked) });
      }
      return;
    }

    if (speed < 3 && !s.mooring) {
      let best = null;
      let bd = DOCK_RANGE;
      for (const p of harborPlaces()) {
        const d0 = p.dock && Number.isFinite(p.dock.x) ? p.dock : null;
        if (!d0) {
          if (Math.hypot(p.x - s.position.x, p.z - s.position.z) > (p.radius ?? 300) + 200) continue;
        }
        const d = d0 ?? dockOf(p);
        if (!d) continue;
        const dist = Math.hypot(d.x - s.position.x, d.z - s.position.z);
        if (dist < bd) {
          bd = dist;
          best = p;
        }
      }
      if (best) I.offer({ id: 'tieUp', label: `Tie up at ${best.name}`, key: 'interact', priority: 60, onPress: () => sys.tieUp(best) });
    }
  }

  events.on('fishing:setComplete', (e) => {
    if (!e || ctx.state.freeExplore) return;
    sys.stats.sets++;
    const lbs = Number(e.totalLbs) || 0;
    sys.stats.bestSetLbs = Math.max(sys.stats.bestSetLbs, lbs);
    sys.stats.bestSetValue = Math.max(sys.stats.bestSetValue, Number(e.value) || 0);
  });
  events.on('opener:end', (e) => checkHighliner(e?.day ?? clock.day));
  events.on('game:start', () => syncFuelState());

  return sys;
}
