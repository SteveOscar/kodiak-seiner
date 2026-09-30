// Start location for a new game (src/ui/lib/start.js): the choices the title's "Where do you start?" panel lists for
// New Season and Free Explore, their poses, preselection and memory, and that a New Season started away from Kodiak
// still gets Uncle Pete's welcome pointing at fish near the boat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, memoryStorage } from './rules-helpers.test.mjs';
import { resolve } from '../src/data/places.js';
import { createGeo } from '../src/core/geo.js';
import { config } from '../src/core/config.js';
import { createPlacesApi } from '../src/world/places/api.js';
import * as S from '../src/ui/lib/start.js';
import { TUTORIAL, createFishSim } from '../src/entities/fish/sim.js';
import { createWorldAdapter } from '../src/entities/fish/world.js';
import { createRng } from '../src/core/rng.js';

const geo = createGeo(config.world.half);
const R = resolve(geo);
const realPlaces = { list: R.places, streams: R.streams, districts: R.districts, closedAreas: R.closedAreas };

async function realOptions(mode) {
  const w = await makeWorld({ places: realPlaces, start: false });
  const { heightmap } = w.ctx;
  const spawn = createPlacesApi({ geo, heightmap }).spawn;
  const minDepth = config.boat.groundingDepth + 1.5;
  const isOpenWater = (x, z) => heightmap.shoreDistance(x, z) >= 40 && heightmap.heightAt(x, z) < -minDepth;
  const targets = w.season.travel.teleportTargets();
  const options = S.buildStartOptions({ mode, places: R.places, districts: R.districts, targets, spawn, closedWaters: w.season.closedWaters, isOpenWater, sea: heightmap, netDepth: config.net.depth });
  return { w, options, targets, spawn, isOpenWater };
}

// Shallowest water on a straight run of `len` m from (x, z) along heading h, and within `r` m of a point.
function minAlong(hm, x, z, h, len) {
  let m = Infinity;
  for (let s = 0; s <= len; s += 5) m = Math.min(m, hm.depthAt(x + Math.sin(h) * s, z - Math.cos(h) * s));
  return m;
}
function minWithin(hm, x, z, r) {
  let m = hm.depthAt(x, z);
  for (const rr of [r / 2, r]) for (let i = 0; i < 32; i++) m = Math.min(m, hm.depthAt(x + Math.cos((i / 32) * Math.PI * 2) * rr, z + Math.sin((i / 32) * Math.PI * 2) * rr));
  return m;
}

test('New Season lists the working ports, the City of Kodiak first, recommended and at the classic spawn', async () => {
  const { w, options, targets, spawn, isOpenWater } = await realOptions('season');
  const kodiak = R.places.find((p) => p.id === 'kodiak');
  const expected = R.places.filter((p) => S.WORKING_KINDS.includes(p.kind) && !p.memorial && (p.id === 'kodiak' || Math.hypot(p.x - kodiak.x, p.z - kodiak.z) > kodiak.radius));
  assert.deepEqual(new Set(options.map((o) => o.id)), new Set(expected.map((p) => p.id)));
  for (const id of ['old-harbor', 'larsen-bay', 'karluk', 'akhiok', 'port-lions', 'ouzinkie', 'alitak-cannery']) assert.ok(options.some((o) => o.id === id), id);
  // Kodiak's own harbors and cannery row are the same start as the town.
  for (const id of ['st-paul-harbor', 'st-herman-harbor', 'cannery-row']) assert.ok(!options.some((o) => o.id === id), id);

  const [first, ...rest] = options;
  assert.equal(first.id, 'kodiak');
  assert.ok(first.recommended && first.home);
  assert.deepEqual(first.pose, { x: spawn.x, z: spawn.z, heading: spawn.heading });
  assert.equal(S.startAtFor(first), null, 'Kodiak starts at the classic spawn');
  assert.ok(rest.every((o) => !o.recommended && !o.home));

  // The rest are grouped by district in chart order, then by name.
  const ranks = rest.map((o) => S.DISTRICT_ORDER.indexOf(o.district));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  const groups = S.groupStartOptions(options);
  assert.equal(groups[0].id, 'home');
  assert.equal(new Set(groups.map((g) => g.id)).size, groups.length, 'each district is one contiguous group');
  for (const o of rest) {
    assert.equal(o.groupName, o.districtName);
    assert.ok(o.line.startsWith(o.kindLabel), o.line);
    assert.ok(o.blurb.length > 20 && o.blurb.length <= 220, `${o.id}: ${o.blurb}`);
    assert.ok(typeof o.services === 'string' && o.services.length, o.id);
  }
  assert.match(options.find((o) => o.id === 'larsen-bay').line, /Uyak Bay/);
  assert.equal(options.find((o) => o.id === 'alitak-cannery').services, 'Buys fish · fuel · ice');

  // Every start is at its port in open water outside the stream closures, bow toward open water: the first throttle
  // runs 300 m without touching bottom (the Free Explore arrival pose faced the beach from ~70 m off it).
  const hm = w.ctx.heightmap;
  const ports = R.places.filter((q) => S.WORKING_KINDS.includes(q.kind) && !q.memorial);
  for (const o of rest) {
    const p = R.places.find((q) => q.id === o.id);
    const d = Math.hypot(o.pose.x - p.x, o.pose.z - p.z);
    assert.ok(isOpenWater(o.pose.x, o.pose.z), `${o.id} starts in open water`);
    assert.ok(hm.depthAt(o.pose.x, o.pose.z) >= S.SEASON_START.depth && hm.shoreDistance(o.pose.x, o.pose.z) >= S.SEASON_START.shore, `${o.id} has sea room`);
    assert.ok(!w.season.isClosedWater(o.pose.x, o.pose.z), `${o.id} starts inside closed waters`);
    assert.ok(d <= S.SEASON_START.maxFromPlace, `${o.id} starts ${Math.round(d)} m from the port`);
    for (const q of ports) {
      if (q !== p && Math.hypot(q.x - p.x, q.z - p.z) > S.SAME_HARBOR) assert.ok(d <= Math.hypot(o.pose.x - q.x, o.pose.z - q.z), `${o.id} starts nearer ${q.id}`);
    }
    assert.ok(minAlong(hm, o.pose.x, o.pose.z, o.pose.heading, 300) > config.boat.groundingDepth + 3, `${o.id}: clear water 300 m ahead`);
    assert.deepEqual(S.startAtFor(o), o.pose);
  }
});

test('the start search mirrors the fish sim\'s tutorial placement', () => {
  assert.equal(S.TUTORIAL_SPOT.rMin, TUTORIAL.rMin);
  assert.equal(S.TUTORIAL_SPOT.rMax, TUTORIAL.rMax);
  assert.equal(S.TUTORIAL_SPOT.margin, TUTORIAL.margin);
  assert.equal(S.TUTORIAL_SPOT.clear, TUTORIAL.clear);
  assert.equal(S.SEASON_START.netDepth, config.net.depth);
});

test('New Season away from Kodiak: the real fish sim puts the tutorial school in water the set can circle, a clear run from the bow', async () => {
  const { w, options } = await realOptions('season');
  const hm = w.ctx.heightmap;
  const world = createWorldAdapter(w.ctx);
  const risky = [];
  for (const o of options.filter((x) => !x.home)) {
    const t = w.season.travel.teleportTargets().find((x) => x.placeId === o.id);
    const place = R.places.find((q) => q.id === o.id);
    const others = R.places.filter((q) => q !== place && S.WORKING_KINDS.includes(q.kind) && Math.hypot(q.x - place.x, q.z - place.z) > S.SAME_HARBOR);
    const r = S.seasonStartPose(t, hm, { place, others, closedWaters: w.season.closedWaters });
    assert.deepEqual({ x: r.x, z: r.z, heading: r.heading }, o.pose, o.id);
    if (r.risk > 0) {
      risky.push(o.id);
      continue;
    }
    for (let seed = 1; seed <= 12; seed++) {
      const sim = createFishSim({ config, rng: createRng(seed * 7919), world });
      const s = sim.spawnTutorial(o.pose.x, o.pose.z, o.pose.heading);
      const { x, z } = s.position;
      const d = Math.hypot(x - o.pose.x, z - o.pose.z);
      const brg = Math.atan2(x - o.pose.x, -(z - o.pose.z));
      const off = Math.abs(((((brg - o.pose.heading) * 180) / Math.PI + 540) % 360) - 180);
      assert.ok(d >= 370 && d <= 710, `${o.id} seed ${seed}: school ${Math.round(d)} m out`);
      assert.ok(off <= 60, `${o.id} seed ${seed}: school ${Math.round(off)}° off the bow`);
      assert.ok(minWithin(hm, x, z, 80) >= S.SEASON_START.circleDepth - 0.5, `${o.id} seed ${seed}: the circle round the school touches ${minWithin(hm, x, z, 80).toFixed(1)} m`);
      assert.ok(minAlong(hm, o.pose.x, o.pose.z, brg, d) >= S.SEASON_START.runDepth - 0.5, `${o.id} seed ${seed}: shoal between the boat and the school`);
    }
  }
  // Port Lions sits up a narrow inlet with no water deep enough for the sim to choose a spot, and no start nearer it
  // than Ouzinkie clears the sim's random drop: its start is the least risky one (notes/FIX-verify-start.md).
  assert.deepEqual(risky, ['port-lions']);
});

test('Port Lions: the tutorial school always lands where its first circle stays navigable', async () => {
  const { w, options } = await realOptions('season');
  const hm = w.ctx.heightmap;
  const world = createWorldAdapter(w.ctx);
  const o = options.find((x) => x.id === 'port-lions');
  for (let seed = 1; seed <= 40; seed++) {
    const sim = createFishSim({ config, rng: createRng(seed * 104729), world });
    const s = sim.spawnTutorial(o.pose.x, o.pose.z, o.pose.heading);
    const { x, z } = s.position;
    assert.ok(minWithin(hm, x, z, 80) >= 5.5, `seed ${seed}: circle touches ${minWithin(hm, x, z, 80).toFixed(1)} m`);
  }
});

test('Free Explore lists every non-memorial place plus Surprise me, Kodiak first, and no tenders', async () => {
  const { options } = await realOptions('explore');
  assert.equal(options[0].id, 'kodiak');
  assert.equal(options[1].id, S.SURPRISE_ID);
  assert.ok(options[1].surprise && !options[1].pose);
  const places = options.filter((o) => !o.surprise);
  assert.equal(places.length, R.places.filter((p) => !p.memorial).length);
  assert.ok(!options.some((o) => o.id === 'awauq'), 'the memorial is not a start');
  assert.ok(options.some((o) => o.id === 'st-paul-harbor'), 'the full teleport list');
  assert.ok(!options.some((o) => o.kind === 'tender'));
  assert.ok(!options.some((o) => o.recommended), 'nothing is "recommended" for exploring');
  // Surprise me picks a real place, never itself.
  const pick = S.pickSurprise(options, () => 0.999);
  assert.ok(pick && !pick.surprise && pick.pose);
  assert.equal(S.pickSurprise(options, () => 0).id, 'kodiak');
  assert.equal(S.startAtFor(options[1]), null);
});

test('search filters by name, kind, district and nearby grounds; Surprise me only shows unfiltered', async () => {
  const { options } = await realOptions('explore');
  assert.deepEqual(S.filterStartOptions(options, '  '), options);
  const uyak = S.filterStartOptions(options, 'UYAK').map((o) => o.id);
  assert.ok(uyak.includes('uyak-bay') && uyak.includes('larsen-bay'), uyak.join(','));
  assert.ok(!uyak.includes(S.SURPRISE_ID));
  const villages = S.filterStartOptions(options, 'village');
  assert.ok(villages.length >= 5 && villages.every((o) => o.kindLabel === 'Village' || /village/i.test(o.name) || /village/i.test(o.districtName)));
  assert.deepEqual(S.filterStartOptions(options, 'no such place'), []);
});

test('search puts the place the player named first: whole name, then name start, word start, kind/district, grounds', async () => {
  const { options } = await realOptions('explore');
  // "deadman" is in several villages' nearby grounds; Deadman Bay itself leads and is what Enter starts at.
  const deadman = S.filterStartOptions(options, 'deadman');
  assert.equal(deadman[0].id, 'deadman-bay', deadman.map((o) => o.id).join(','));
  assert.ok(deadman.some((o) => o.id === 'kaguyak'), 'grounds matches still listed');
  assert.equal(S.filterStartOptions(options, 'Deadman Bay')[0].id, 'deadman-bay');
  assert.equal(S.filterStartOptions(options, 'alitak')[0].id, 'alitak-bay');
  assert.equal(S.filterStartOptions(options, 'uyak')[0].id, 'uyak-bay');
  assert.equal(S.filterStartOptions(options, 'st paul')[0].id, 'st-paul-harbor');
  assert.equal(S.filterStartOptions(options, 'saints')[0].id, 'three-saints-bay');
  // Groups stay contiguous, so the panel draws each district header once.
  for (const q of ['deadman', 'bay', 'cape', 'kodiak', 'village']) {
    const groups = S.groupStartOptions(S.filterStartOptions(options, q)).map((g) => g.id);
    assert.equal(new Set(groups).size, groups.length, q);
  }
  const o = { name: 'Awa’uq Bay', kindLabel: 'Bay', districtName: 'Eastside Kodiak', grounds: ['Ugak Bay'] };
  assert.equal(S.matchRank(o, 'awauq bay'), 0);
  assert.equal(S.matchRank(o, 'awa'), 1);
  assert.equal(S.matchRank(o, 'bay'), 2);
  assert.equal(S.matchRank(o, 'uq b'), 3);
  assert.equal(S.matchRank(o, 'eastside'), 4);
  assert.equal(S.matchRank(o, 'ugak'), 5);
  assert.equal(S.matchRank(o, 'zzz'), -1);
});

test('seasonStartPose leaves the beach: sea room, bow to open water and the school, or null without water', () => {
  // A straight coast along z = 0 with land to the north; the seabed shelves 5 cm per m to 30 m deep.
  const sea = {
    depthAt: (x, z) => Math.max(0, Math.min(30, z * 0.05)),
    shoreDistance: (x, z) => z,
  };
  const beach = { x: 0, z: 70, heading: 0 }; // 70 m off, facing the beach (north)
  const r = S.seasonStartPose(beach, sea, { place: { x: 0, z: -50 } });
  assert.ok(r && r.risk === 0 && r.school, JSON.stringify(r));
  assert.ok(sea.depthAt(r.x, r.z) >= S.SEASON_START.depth && r.z >= S.SEASON_START.shore);
  assert.ok(Math.cos(r.heading) < 0, 'the bow points offshore (south), away from the beach');
  assert.ok(minAlong(sea, r.x, r.z, r.heading, 300) >= S.SEASON_START.depth);
  // The nearest such start: no farther out than the first lattice ring with a school spot in 20 m clean water.
  assert.ok(Math.hypot(r.x - beach.x, r.z - beach.z) <= 700, `${Math.round(Math.hypot(r.x - beach.x, r.z - beach.z))} m`);
  // Stream markers are avoided.
  const closed = [{ x: r.x, z: r.z, radius: 150 }];
  const r2 = S.seasonStartPose(beach, sea, { place: { x: 0, z: -50 }, closedWaters: closed });
  assert.ok(Math.hypot(r2.x - r.x, r2.z - r.z) > 150);
  // Not nearer another port than this one.
  const r3 = S.seasonStartPose(beach, sea, { place: { x: 0, z: -50 }, others: [{ x: 0, z: 400 }] });
  assert.ok(Math.hypot(r3.x, r3.z + 50) <= Math.hypot(r3.x, r3.z - 400));
  assert.equal(S.seasonStartPose(beach, { depthAt: () => 0, shoreDistance: () => -10 }), null);
  assert.equal(S.seasonStartPose(null, sea), null);
  // seasonPoseFor caches per place and pose.
  const cache = new Map();
  let calls = 0;
  const counted = { depthAt: (x, z) => (calls++, sea.depthAt(x, z)), shoreDistance: sea.shoreDistance };
  const a = S.seasonPoseFor('p', beach, { sea: counted, cache });
  const n = calls;
  assert.deepEqual(S.seasonPoseFor('p', beach, { sea: counted, cache }), a);
  assert.equal(calls, n, 'second lookup is cached');
  assert.deepEqual(Object.keys(a).sort(), ['heading', 'x', 'z']);
});

test('preselection: the remembered choice for the mode, else Kodiak, else the first', () => {
  const opts = [
    { id: 'kodiak', home: true },
    { id: S.SURPRISE_ID, surprise: true },
    { id: 'karluk' },
  ];
  assert.equal(S.preselectIndex(opts, 'karluk'), 2);
  assert.equal(S.preselectIndex(opts, S.SURPRISE_ID), 1);
  assert.equal(S.preselectIndex(opts, 'gone-place'), 0);
  assert.equal(S.preselectIndex(opts, null), 0);
  assert.equal(S.preselectIndex([{ id: 'a' }, { id: 'kodiak', home: true }], null), 1);
  assert.equal(S.preselectIndex([{ id: 'a' }, { id: 'b' }], 'zzz'), 0);
  assert.equal(S.preselectIndex([], 'a'), -1);

  const storage = memoryStorage();
  assert.deepEqual(S.readLastStart(storage), {});
  S.rememberStart(storage, 'season', 'larsen-bay');
  S.rememberStart(storage, 'explore', S.SURPRISE_ID);
  S.rememberStart(storage, 'bogus', 'x');
  assert.deepEqual(S.readLastStart(storage), { season: 'larsen-bay', explore: S.SURPRISE_ID });
  S.rememberStart(storage, 'season', 'old-harbor');
  assert.deepEqual(S.readLastStart(storage), { season: 'old-harbor', explore: S.SURPRISE_ID });
  storage.setItem(S.START_KEY, '{not json');
  assert.deepEqual(S.readLastStart(storage), {});
  storage.setItem(S.START_KEY, '["array"]');
  assert.deepEqual(S.readLastStart(storage), {});
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('full'); } };
  assert.deepEqual(S.readLastStart(broken), {});
  assert.doesNotThrow(() => S.rememberStart(broken, 'season', 'karluk'));
  assert.deepEqual(S.readLastStart(null), {});
});

test('options without a pose are dropped, and the helper tolerates stubbed places', () => {
  const places = [
    { id: 'kodiak', name: 'City of Kodiak', kind: 'town', x: 0, z: 0, radius: 450, district: 'northeast', blurb: 'Home.', services: ['sell'] },
    { id: 'st-paul-harbor', name: 'St. Paul Harbor', kind: 'harbor', x: 100, z: 50, district: 'northeast', blurb: 'In town.' },
    { id: 'far', name: 'Far Village', kind: 'village', x: 5000, z: 0, district: 'northwest', blurb: 'Far away from here, across the island.' },
    { id: 'nopose', name: 'No Pose', kind: 'village', x: 7000, z: 0, district: 'northwest', blurb: 'x' },
    { id: 'rock', name: 'Awa’uq', kind: 'history', x: 10, z: 10, memorial: true, blurb: 'x' },
    { id: 'cape', name: 'Cape Far', kind: 'cape', x: 5400, z: 100, district: 'northwest', blurb: 'A cape.' },
  ];
  const targets = [
    { id: 'place:far', kind: 'place', placeId: 'far', x: 4900, z: 10, heading: 1 },
    { id: 'place:st-paul-harbor', kind: 'place', placeId: 'st-paul-harbor', x: 120, z: 40, heading: 0 },
    { id: 'place:cape', kind: 'place', placeId: 'cape', x: 5500, z: 100, heading: 0 },
    { id: 'tender:t', kind: 'tender', tenderId: 't', x: 1, z: 1, heading: 0 },
  ];
  const districts = [{ id: 'northeast', name: 'Northeast Kodiak' }, { id: 'northwest', name: 'Northwest Kodiak' }];
  const season = S.buildStartOptions({ mode: 'season', places, districts, targets, spawn: { x: 5, z: 6, heading: 2 } });
  assert.deepEqual(season.map((o) => o.id), ['kodiak', 'far']);
  assert.equal(season[1].line, 'Village · Cape Far');
  assert.equal(season[1].services, 'No harbor services');
  // Without a spawn, Kodiak needs a teleport pose like any other place.
  assert.deepEqual(S.buildStartOptions({ mode: 'season', places, districts, targets }).map((o) => o.id), ['far']);
  const explore = S.buildStartOptions({ mode: 'explore', places, districts, targets, spawn: { x: 5, z: 6, heading: 2 } });
  assert.deepEqual(explore.map((o) => o.id), ['kodiak', S.SURPRISE_ID, 'st-paul-harbor', 'cape', 'far']);
  assert.deepEqual(S.buildStartOptions({}), []);
  assert.deepEqual(S.buildStartOptions({ mode: 'explore' }), [], 'no places: no Surprise me either');
});

test('a start inside closed waters moves just outside the markers, into water isOk accepts, facing the place', () => {
  const closed = [{ x: 0, z: 0, radius: 300 }, { x: 700, z: 0, radius: 200 }];
  const clear = { x: -1000, z: 0, heading: 0.5 };
  assert.equal(S.clearOfClosedWaters(clear, closed), clear, 'already clear: unchanged');
  const moved = S.clearOfClosedWaters({ x: 100, z: 0, heading: 0 }, closed, { face: { x: 0, z: -2000 } });
  const d = Math.hypot(moved.x, moved.z);
  assert.ok(d >= 300 && d <= 420, `just outside: ${d}`);
  assert.ok(Math.hypot(moved.x - 700, moved.z) >= 200, 'not inside the neighbouring closure');
  const want = Math.atan2(0 - moved.x, -(-2000 - moved.z));
  assert.ok(Math.abs(moved.heading - want) < 1e-9, 'faces the place');
  // Only the west side is water: the move goes round to it.
  const west = S.clearOfClosedWaters({ x: 100, z: 0, heading: 0 }, closed, { isOk: (x) => x < -200 });
  assert.ok(west.x < -200 && Math.hypot(west.x, west.z) >= 300);
  assert.equal(S.clearOfClosedWaters({ x: 100, z: 0 }, closed, { isOk: () => false }), null);
  assert.equal(S.clearOfClosedWaters(null, closed), null);
});

test('firstSentence keeps abbreviations whole and pads a very short opening with the next sentence', () => {
  assert.equal(S.firstSentence('Named for St. Herman, who reached Kodiak in 1794. It is quiet.'), 'Named for St. Herman, who reached Kodiak in 1794.');
  assert.equal(S.firstSentence('Nuniaq in Alutiiq. The 1964 tsunami left two houses standing. More.'), 'Nuniaq in Alutiiq. The 1964 tsunami left two houses standing.');
  assert.equal(S.firstSentence('The U.S. Coast Guard runs its largest base here. More.'), 'The U.S. Coast Guard runs its largest base here.');
  assert.equal(S.firstSentence(''), '');
  assert.equal(S.firstSentence(undefined), '');
});

test('a New Season started at Larsen Bay: Pete points at the fish near the boat, ADF&G reads the opener', async () => {
  const { options } = await realOptions('season');
  const larsen = options.find((o) => o.id === 'larsen-bay');
  const w = await makeWorld({ places: realPlaces, start: false });
  w.ctx.systems.fish.schools = [];
  w.ctx.game.start({ newGame: true });
  // What ctx.game.start({ startAt }) does before game:start, applied to the test world's mini game.
  w.ctx.game.teleport(larsen.pose.x, larsen.pose.z, larsen.pose.heading, { reason: 'start' });
  const q = w.ctx.systems.seiner.position;
  assert.ok(Math.hypot(q.x - larsen.pose.x, q.z - larsen.pose.z) < 1);
  // The tutorial school a quarter mile due south of the boat.
  w.ctx.systems.fish.schools = [{ id: 1, state: 'milling', species: 'pink', tutorial: true, position: { x: q.x, z: q.z + 400 } }];
  for (let t = 0; t < 20; t += 0.1) {
    w.ctx.clock.update(0.1);
    w.step(0.1);
  }
  const pete = w.radio.find((m) => m.from === 'Uncle Pete')?.text ?? '';
  assert.match(pete, /a quarter mile south of you/, pete);
  assert.ok(w.radio.some((m) => /Fish and Game/.test(m.text ?? '') || /ADF&G/.test(m.from ?? '')), 'the opening reminder airs');
  for (const m of w.radio) assert.doesNotMatch(m.text ?? '', /St\. Paul|breakwater|Near Island|Cannery Row/, m.text);
});
