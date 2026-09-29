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
  const options = S.buildStartOptions({ mode, places: R.places, districts: R.districts, targets, spawn, closedWaters: w.season.closedWaters, isOpenWater });
  return { w, options, targets, spawn, isOpenWater };
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

  // Every start is in open water outside the stream closures; outside the markers it is the teleport arrival pose.
  for (const o of rest) {
    assert.ok(isOpenWater(o.pose.x, o.pose.z), `${o.id} starts in open water`);
    assert.ok(!w.season.isClosedWater(o.pose.x, o.pose.z), `${o.id} starts inside closed waters`);
    const t = targets.find((x) => x.placeId === o.id);
    if (!w.season.isClosedWater(t.x, t.z)) assert.deepEqual(o.pose, { x: t.x, z: t.z, heading: t.heading }, o.id);
    else assert.ok(Math.hypot(o.pose.x - t.x, o.pose.z - t.z) < 700, `${o.id} moved just outside the markers`);
    assert.deepEqual(S.startAtFor(o), o.pose);
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
