// WP-FISH: jump signatures and poses, and the salmon geometry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from '../src/core/rng.js';
import { createJump, jumpPose, dueEvents, MAX_JUMP_DEVIATION } from '../src/entities/fish/jumps.js';
import { JUMP_STYLES, FISH_LENGTH } from '../src/entities/fish/species.js';
import { createSalmonGeometry } from '../src/entities/fish/salmonGeometry.js';

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function sample(species, n = 200, opts = {}) {
  const rng = createRng(7);
  const out = [];
  for (let i = 0; i < n; i++) out.push(createJump({ rng, species, x: 10, z: -20, surfaceY: 0.2, heading: 1.1, now: 5, ...opts }));
  return out;
}

test('every jump (and every leg of a coho tail-walk) points within ±25° of the school heading', () => {
  for (const species of ['pink', 'chum', 'sockeye', 'coho', 'king']) {
    for (const j of sample(species)) {
      assert.ok(Math.abs(wrap(j.heading - 1.1)) <= MAX_JUMP_DEVIATION + 1e-9, `${species} ${j.heading}`);
      for (let t = 0; t <= j.dur; t += 0.05) {
        const p = jumpPose(j, t);
        assert.ok(Math.abs(wrap(p.heading - 1.1)) <= MAX_JUMP_DEVIATION + 1e-9, `${species} leg heading`);
        for (const k of ['x', 'y', 'z', 'pitch', 'roll', 'bend']) assert.ok(Number.isFinite(p[k]), k);
      }
    }
  }
});

test('jump signatures: pink short popcorn, sockeye clean head-first, chum flat on its side, coho high and repeated, king rolls', () => {
  const peak = (j) => {
    let m = -Infinity;
    for (let t = 0; t <= j.dur; t += 0.01) m = Math.max(m, jumpPose(j, t).y - j.surfaceY);
    return m;
  };
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const pinks = sample('pink');
  const socks = sample('sockeye');
  const chums = sample('chum');
  const cohos = sample('coho');
  const kings = sample('king');
  assert.ok(mean(pinks.map(peak)) < mean(socks.map(peak)), 'pinks jump lower than sockeye');
  assert.ok(mean(cohos.map(peak)) > mean(socks.map(peak)), 'coho jump highest');
  assert.ok(mean(kings.map(peak)) < 0.25, 'kings barely break the surface');
  assert.ok(mean(pinks.map((j) => j.dur)) < 1.2, 'popcorn jumps are quick');
  assert.equal(new Set(pinks.map((j) => j.style)).size, 1);
  assert.equal(pinks[0].style, 'popcorn');
  assert.equal(socks[0].style, 'leap');
  assert.equal(chums[0].style, 'flop');
  assert.equal(cohos[0].style, 'tailwalk');
  assert.equal(kings[0].style, 'roll');
  // Sockeye re-enter head-first (nose down); chum land flat on their side.
  for (const j of socks.slice(0, 20)) {
    const a = j.segs[0];
    assert.ok(jumpPose(j, a.t0 + a.dur * 0.92).pitch < -0.6, 'sockeye head-first');
  }
  for (const j of chums.slice(0, 20)) {
    const a = j.segs[0];
    const p = jumpPose(j, a.t0 + a.dur * 0.9);
    assert.ok(Math.abs(Math.abs(p.roll) - Math.PI / 2) < 0.45, `chum roll ${p.roll}`);
    assert.ok(Math.abs(p.pitch) < 0.35, 'chum lands flat');
  }
  // Coho: several leaps with tail-walking between them.
  assert.ok(cohos.every((j) => j.segs.filter((s) => s.kind === 'arc').length >= 2));
  assert.ok(cohos.some((j) => j.segs.some((s) => s.kind === 'walk')));
  // Splash sizes: chum biggest, sockeye smallest.
  assert.ok(JUMP_STYLES.chum.splash > JUMP_STYLES.pink.splash && JUMP_STYLES.pink.splash > JUMP_STYLES.sockeye.splash);
});

test('jump events: exit before entry, entry at the landing point, all events delivered once', () => {
  for (const j of sample('coho', 20)) {
    const seen = [];
    for (let t = 0; t <= j.dur + 0.1; t += 1 / 60) seen.push(...dueEvents(j, t));
    assert.equal(seen.length, j.events.length);
    const kinds = seen.map((e) => e.kind);
    assert.ok(kinds.indexOf('exit') < kinds.indexOf('entry'));
    const arcs = j.segs.filter((s) => s.kind === 'arc');
    assert.equal(kinds.filter((k) => k === 'entry').length, arcs.length);
  }
});

test('bag thrash jumps are free (not bound to a heading) and short', () => {
  const rng = createRng(1);
  const hs = [];
  for (let i = 0; i < 100; i++) {
    const j = createJump({ rng, species: 'pink', styleKey: 'bag', free: true, x: 0, z: 0, heading: 0 });
    hs.push(j.heading);
    assert.ok(j.dur < 1.2);
  }
  assert.ok(hs.some((h) => Math.abs(wrap(h)) > Math.PI / 2), 'bag jumps go every which way');
});

test('salmon geometry: closed outward-facing body, forked tail, fins, three LODs', () => {
  const counts = {};
  for (const detail of ['high', 'mid', 'low']) {
    const g = createSalmonGeometry({ detail });
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const part = g.getAttribute('aPart');
    counts[detail] = g.index.count / 3;
    g.computeBoundingBox();
    assert.ok(Math.abs(g.boundingBox.min.z + 0.5) < 1e-6 && Math.abs(g.boundingBox.max.z - 0.5) < 1e-6, 'unit length, snout at −z');
    let inward = 0;
    for (let i = 0; i < p.count; i++) {
      if (part.getX(i) !== 0 || p.getZ(i) < -0.45 || p.getZ(i) > 0.3) continue;
      if (p.getX(i) * n.getX(i) + p.getY(i) * n.getY(i) < -1e-4) inward++;
    }
    assert.equal(inward, 0, `${detail}: inward normals`);
    const parts = new Set();
    for (let i = 0; i < part.count; i++) parts.add(part.getX(i));
    assert.ok(parts.has(0) && parts.has(1) && parts.has(2), `${detail}: body, fins, caudal`);
    if (detail !== 'low') assert.ok(parts.has(3), 'paired fins');
    // Forked tail: the fork notch is well forward of the lobe tips.
    let notch = Infinity;
    for (let i = 0; i < p.count; i++) if (part.getX(i) === 2 && Math.abs(p.getY(i)) < 0.005 && p.getZ(i) > 0.35) notch = Math.min(notch, p.getZ(i));
    assert.ok(notch < 0.46, 'forked caudal fin');
  }
  assert.ok(counts.high > counts.mid && counts.mid > counts.low && counts.low < 100);
  assert.ok(Object.values(FISH_LENGTH).every((l) => l > 0.4 && l < 1.1));
});
