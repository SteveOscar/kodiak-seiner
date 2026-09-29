// WP-PLACES: chimney smoke and cannery steam plume envelope (src/world/places/smoke.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PLUME, plumePuff } from '../src/world/places/smoke.js';

const AGES = Array.from({ length: 41 }, (_, i) => i / 40);
const WINDS = [0, 1, 3, 6, 10, 14, 25];

test('no puff is ever visible more than ~40 m above its source', () => {
  for (const steam of [0, 1]) {
    for (const windSpeed of WINDS) {
      for (const age of AGES) {
        const p = plumePuff({ age, steam, windSpeed });
        assert.ok(p.rise + p.size * 0.5 <= 40, `top ${(p.rise + p.size * 0.5).toFixed(1)} m (steam ${steam}, wind ${windSpeed}, age ${age})`);
        if (p.rise + p.size * 0.5 >= PLUME.ceiling) assert.equal(p.alphaTop, 0);
      }
    }
  }
});

test('plumes bend over downwind: stronger wind carries puffs further and holds them lower', () => {
  const calm = plumePuff({ age: 0.8, steam: 1, windSpeed: 1 });
  const windy = plumePuff({ age: 0.8, steam: 1, windSpeed: 10 });
  assert.ok(windy.along > calm.along * 5);
  assert.ok(windy.rise < calm.rise * 0.75);
  // Rising slows with age: most of the rise happens in the first half of the life.
  const half = plumePuff({ age: 0.5, steam: 1, windSpeed: 4 });
  const end = plumePuff({ age: 1, steam: 1, windSpeed: 4 });
  assert.ok(half.rise > end.rise * 0.7);
});

test('stretched puff quads keep their front-face winding', () => {
  // The vertex shader places each quad corner at dir * y + perp * x. A mirrored basis (determinant < 0) flips the
  // triangles, and the FrontSide material then culls every puff.
  const src = readFileSync(new URL('../src/world/places/smoke.js', import.meta.url), 'utf8');
  const m = src.match(/vec2 perp = vec2\(\s*(-?)dir\.([xy])\s*,\s*(-?)dir\.([xy])\s*\)/);
  assert.ok(m, 'perp definition found');
  for (const a of [0, 0.7, 2.1, 3.5, 5.2]) {
    const dir = { x: Math.cos(a), y: Math.sin(a) };
    const perp = { x: (m[1] ? -1 : 1) * dir[m[2]], y: (m[3] ? -1 : 1) * dir[m[4]] };
    // Columns (perp, dir) map quad x and y.
    const det = perp.x * dir.y - dir.x * perp.y;
    assert.ok(det > 0.99, `det ${det.toFixed(2)} at angle ${a}`);
  }
});
