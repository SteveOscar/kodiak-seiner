// WP-UI polish: informational prompts (fishing-find-fish) are dimmed, and the next-step line points to the dock's
// buyer when tied up with fish aboard. Pure logic from src/ui/lib/logic.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../src/ui/lib/logic.js';

test('informational prompts: the find-fish id or an info flag, never ordinary actions', () => {
  assert.equal(L.isInfoPrompt({ id: 'fishing-find-fish', label: 'Jumpers 420 m NE — get within 150 m to let go', hold: false }), true);
  assert.equal(L.isInfoPrompt({ id: 'tutorial-find-fish', label: 'x' }), true, 'any package can use the -find-fish suffix');
  assert.equal(L.isInfoPrompt({ id: 'landmark', label: 'x', info: true }), true);
  assert.equal(L.isInfoPrompt({ id: 'fishing-letgo', label: "Let 'er go! (no fish close)" }), false);
  assert.equal(L.isInfoPrompt({ id: 'fishing-find-fish-now', label: 'x' }), false, 'suffix match only');
  assert.equal(L.isInfoPrompt({ id: 'deliver', label: 'x', info: 'yes' }), false, 'only a literal true flag');
  assert.equal(L.isInfoPrompt({ label: 'no id' }), false);
  assert.equal(L.isInfoPrompt(null), false);
});

test('next-step line: tied up at a fish buyer with fish aboard says sell here', () => {
  const base = { control: 'boat', fishing: 'idle', freeExplore: false, open: true, holdLbs: 0, capacityLbs: 60000, fuelFrac: 1, fuelEmpty: false, hours: 10, moored: 'dock', sellHere: true, tender: { name: 'Sea Venture', nm: 1.8 }, opensToday: null, interactId: null };
  // Empty hold at a buyer: still go fishing.
  assert.match(L.nextStep(base), /Cast off/);
  // Fish aboard: sell here, with the E prompt on screen or not, in or out of a period, full hold or night.
  assert.equal(L.nextStep({ ...base, holdLbs: 1240, interactId: 'deliver' }), 'Sell your catch here (E) · 1,240 lb');
  assert.match(L.nextStep({ ...base, holdLbs: 1240 }), /^Sell your catch here/);
  assert.match(L.nextStep({ ...base, holdLbs: 40000 }), /^Sell your catch here/, 'not "Deliver to the Sea Venture"');
  assert.match(L.nextStep({ ...base, holdLbs: 59000 }), /^Sell your catch here/, 'not "Hold’s full — deliver to a tender"');
  assert.match(L.nextStep({ ...base, open: false, holdLbs: 800 }), /^Sell your catch here/, 'not "Closed — deliver"');
  assert.match(L.nextStep({ ...base, open: false, hours: 23, holdLbs: 800, interactId: 'deliver' }), /^Sell your catch here/);
  assert.match(L.nextStep({ ...base, holdLbs: 800, fuelFrac: 0.1 }), /^Sell your catch here/, 'sell first, then fuel up');
  // A dock without a buyer, or at anchor: the tender lines as before.
  assert.match(L.nextStep({ ...base, sellHere: false, holdLbs: 40000 }), /Deliver to the Sea Venture/);
  assert.match(L.nextStep({ ...base, moored: 'anchor', holdLbs: 40000 }), /Deliver to the Sea Venture/);
  assert.match(L.nextStep({ ...base, moored: null, holdLbs: 1240 }), /jumpers/);
  // A tender's delivery prompt already says it.
  assert.equal(L.nextStep({ ...base, moored: null, holdLbs: 59000, interactId: 'deliver' }), null);
  // During a set or ashore the line stays quiet.
  assert.equal(L.nextStep({ ...base, holdLbs: 1240, fishing: 'brailing' }), null);
  assert.equal(L.nextStep({ ...base, holdLbs: 1240, control: 'foot' }), null);
});
