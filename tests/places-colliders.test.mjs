// WP-PLACES colliders: places.collidersNear(x, z, radius) covers what is rendered, uses the documented shapes and
// heading convention, and answers queries in microseconds from the grid built at create.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLayoutHeadless } from '../src/world/places/genFootprints.mjs';
import { createColliderGrid, colliderDistance, colBox } from '../src/world/places/colliders.js';
import { Builder, col } from '../src/world/places/kit.js';
import { KODIAK_LAYOUT, TURBINE } from '../src/world/places/city.js';

const { sys, ctx } = await buildLayoutHeadless();
const H = (x, z) => Math.max(ctx.heightmap.heightAt(x, z), 0);

test('collider shapes are well formed and the grid holds every built structure', () => {
  const all = sys.collidersNear(0, 0, 20000);
  assert.ok(all.length > 1500, `colliders ${all.length}`);
  assert.equal(all.length, sys.debugState().colliders);
  for (const c of all) {
    assert.ok(c.kind === 'circle' || c.kind === 'box');
    for (const k of ['x', 'z', 'y0', 'y1']) assert.ok(Number.isFinite(c[k]), `${c.kind}.${k}`);
    assert.ok(c.y1 > c.y0);
    if (c.kind === 'circle') assert.ok(c.r > 0 && c.r < 10);
    else assert.ok(c.hx > 0 && c.hz > 0 && Number.isFinite(c.rot) && Math.max(c.hx, c.hz) < 120);
    assert.ok(Object.isFrozen(c));
  }
});

test('box rot follows the heading convention: a kit box and its collider share every corner', () => {
  for (const rot of [0, 0.4, 1.3, -2.2, Math.PI]) {
    const S = { b: new Builder(), colliders: [] };
    const f = { x: 100, z: -50, rot };
    S.b.box({ ...f, y: 0 }, 3, 0, -2, 8, 4, 5, col('#ffffff'));
    colBox(S, f, 3, -2, 8, 5, 0, 4);
    const c = S.colliders[0];
    const p = S.b.pos;
    for (let i = 0; i < p.length; i += 3) assert.ok(colliderDistance(c, p[i], p[i + 2]) < 1e-6);
    // just outside each face centre is outside the box
    const cs = Math.cos(c.rot);
    const sn = Math.sin(c.rot);
    for (const [lx, lz] of [[c.hx + 0.05, 0], [-c.hx - 0.05, 0], [0, c.hz + 0.05], [0, -c.hz - 0.05]]) {
      const x = c.x + lx * cs - lz * sn;
      const z = c.z + lx * sn + lz * cs;
      assert.ok(colliderDistance(c, x, z) > 0.04, `rot ${rot}`);
    }
    // heading convention: local x = (cos rot, sin rot)
    assert.ok(Math.abs(Math.cos(c.rot) - Math.cos(-rot)) < 1e-9 && Math.abs(Math.sin(c.rot) - Math.sin(-rot)) < 1e-9);
  }
});

test('grid query: exact distances for circles and rotated boxes, radius honoured, no duplicates', () => {
  const g = createColliderGrid([
    { kind: 'box', x: 0, z: 0, hx: 30, hz: 1, rot: Math.PI / 2, y0: 0, y1: 3 }, // long wall running north-south
    { kind: 'circle', x: 10, z: 0, r: 1, y0: 0, y1: 5 },
  ]);
  assert.equal(g.near(0, 25, 0).length, 1); // inside the wall, 25 m south of its centre
  assert.equal(g.near(2.5, 0, 1).length, 0); // 1.5 m east of the wall face
  assert.equal(g.near(2.5, 0, 1.6).length, 1);
  assert.deepEqual(g.near(8.5, 0, 0.6).map((c) => c.kind), ['circle']);
  assert.equal(g.near(5, 0, 6).length, 2);
  assert.equal(g.near(0, 0, 100).length, 2);
  assert.equal(g.near(NaN, 0, 5).length, 0);
});

test('rendered geometry in the walker body band lies inside a collider', () => {
  let total = 0;
  let miss = 0;
  for (const m of sys.group.children) {
    if (!m.isMesh || m.isInstancedMesh || !/^places-/.test(m.name) || /glows|smoke/.test(m.name)) continue;
    const pos = m.geometry.attributes.position.array;
    for (let t = 0; t < pos.length; t += 9) {
      const x = (pos[t] + pos[t + 3] + pos[t + 6]) / 3;
      const y = (pos[t + 1] + pos[t + 4] + pos[t + 7]) / 3;
      const z = (pos[t + 2] + pos[t + 5] + pos[t + 8]) / 3;
      const g = H(x, z);
      if (y < g + 0.4 || y > g + 1.9) continue;
      total++;
      if (!sys.collidersNear(x, z, 0.35).some((c) => y >= c.y0 - 0.2 && y <= c.y1 + 0.2)) miss++;
    }
  }
  assert.ok(total > 5000, `sampled ${total}`);
  assert.ok(miss / total < 0.01, `${miss} of ${total} body-height triangles outside every collider`);
});

test('the props QA walked through are solid: cathedral, turbines, lights, markers, floats, houses', () => {
  const c = KODIAK_LAYOUT.cathedral;
  const cat = sys.collidersNear(c.x, c.z, 0).find((k) => k.kind === 'box');
  assert.ok(cat && cat.y1 - H(c.x, c.z) > 18, 'cathedral box reaches the domes');
  for (const t of sys.layout.turbines) {
    const tower = sys.collidersNear(t.x, t.z, 0).find((k) => k.kind === 'circle' && Math.abs(k.r - TURBINE.towerR0) < 1e-6);
    assert.ok(tower && tower.y1 >= t.hub, 'turbine tower up to the hub');
  }
  for (const l of sys.layout.lights) assert.ok(sys.collidersNear(l.x, l.z, 0).some((k) => k.y1 >= l.y - 2), 'light tower');
  for (const m of sys.layout.markers) assert.ok(sys.collidersNear(m.x, m.z, 0.3).some((k) => k.kind === 'circle'), 'marker post');
  // St. Paul Harbor floats sit at the waterline
  const floats = sys.collidersNear(5000, -1000, 120).filter((k) => k.kind === 'box' && Math.abs(k.y0 + 0.25) < 1e-6 && Math.abs(k.y1 - 0.5) < 1e-6);
  assert.ok(floats.length > 20, `floats ${floats.length}`);
  // the houses of Kodiak are solid from below the foundation to the roof
  const houses = sys.collidersNear(5120, -1330, 140).filter((k) => k.kind === 'box' && k.hx > 3 && k.hx < 7 && k.y1 - k.y0 > 6);
  assert.ok(houses.length > 60, `houses ${houses.length}`);
});

test('collidersNear costs microseconds and reuses an out array', () => {
  const out = [];
  const n = 20000;
  let hits = 0;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    const x = 4900 + (i % 200) * 2.2;
    const z = -1400 + Math.floor(i / 200) * 4.1;
    hits += sys.collidersNear(x, z, 2.5, out).length;
  }
  const us = ((performance.now() - t0) / n) * 1000;
  assert.ok(hits > 1000, `hits ${hits}`);
  assert.ok(us < 25, `${us.toFixed(2)} us per query`);
  assert.equal(sys.collidersNear(5036, -1238, 1, out), out);
});
