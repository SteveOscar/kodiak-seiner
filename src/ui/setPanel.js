// Fishing phase widgets from fishing.hud (SPEC §6.12): payout, distance to the skiff, hold timer and in-the-hook
// estimate, the purse tension gauge with its green band, haul progress, the skiff-pull dial, the brailer count-up,
// depth under the stern and bottom warnings. A low, wide console under the caption line so the crow's-nest view of
// the net stays clear. Updated at the HUD rate; needles and bars glide with CSS transitions.

import { h, svg, setText, setStyle, toggle } from './dom.js';
import { tensionState, bearingDistance, pullAdvice } from './lib/logic.js';
import { int, mmss, fathoms, headingDeg, deltaDeg } from './lib/format.js';

const PHASE_LABEL = {
  setting: 'Setting',
  holding: 'Holding',
  closing: 'Closing up',
  pursing: 'Pursing',
  hauling: 'Hauling',
  brailing: 'Brailing',
};

const PHASES = ['setting', 'holding', 'closing', 'pursing', 'hauling', 'brailing'];

// Arc path on a gauge centred at (cx, cy) from fraction a to b (0 = left, 1 = right along the top semicircle).
function arc(cx, cy, r, a, b) {
  const p = (f) => {
    const t = Math.PI * (1 - f);
    return [cx + Math.cos(t) * r, cy - Math.sin(t) * r];
  };
  const [x0, y0] = p(a);
  const [x1, y1] = p(b);
  return `M${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 0 1 ${x1.toFixed(2)},${y1.toFixed(2)}`;
}

function bar(label) {
  const fill = h('div.bar-fill');
  const value = h('span.bar-value');
  const el = h('div.set-bar', null, [h('div.bar-head', null, [h('span.bar-label', { text: label }), value]), h('div.bar-track', null, [fill])]);
  return { el, fill, value };
}

// A stat tile: small-caps label over a monospace value.
function tile(label, cls) {
  const labelEl = h('span.stat-label', { text: label });
  const val = h('span.stat-val');
  const el = h(`div.set-stat.${cls}`, null, [labelEl, h('div.stat-line', null, [val])]);
  return { el, labelEl, val, line: el.lastChild };
}

export function createSetPanel(ctx) {
  const phaseEl = h('span.set-phase');
  const setNoEl = h('span.set-no');
  const closedEl = h('span.set-closed.hidden', { text: 'Closed waters' });
  const depthVal = h('span.depth-val');
  const depth = h('span.set-depth', null, [depthVal, h('span.depth-cap', { text: 'under the stern' })]);
  const messageEl = h('div.set-message');

  const payout = bar('Seine out');
  const haul = bar('Bag dried up');
  const rings = bar('Rings up');
  const brail = bar('Brailed');

  const skiff = tile('Skiff', 'stat-skiff');
  // A small arrow in the skiff tile: where the skiff lies relative to the bow (round hauls close back on it).
  const skiffArrow = svg('svg', { viewBox: '-8 -8 16 16', class: 'skiff-arrow' }, [svg('path', { d: 'M0,-6.5 L4.2,4.5 L0,2.2 L-4.2,4.5 Z' })]);
  skiff.line.prepend(skiffArrow);
  const skiffBadge = h('span.stat-badge', { text: 'in range' });
  skiff.line.append(skiffBadge);
  const hook = tile('In the hook', 'stat-hook');
  const hold = tile('Holding', 'stat-hold');

  // Purse tension gauge.
  const G = { cx: 60, cy: 56, r: 44 };
  const bandPath = svg('path', { class: 'g-band', fill: 'none' });
  const lowPath = svg('path', { class: 'g-low', fill: 'none' });
  const highPath = svg('path', { class: 'g-high', fill: 'none' });
  const needle = svg('g', { class: 'g-needle' }, [svg('line', { x1: G.cx, y1: G.cy, x2: G.cx, y2: G.cy - G.r + 4 }), svg('circle', { cx: G.cx, cy: G.cy, r: 4.2 })]);
  const ticks = [];
  for (let i = 0; i <= 10; i++) {
    const t = Math.PI * (1 - i / 10);
    const r0 = G.r + 6;
    const r1 = G.r + (i % 5 === 0 ? 11 : 9);
    ticks.push(svg('line', { x1: G.cx + Math.cos(t) * r0, y1: G.cy - Math.sin(t) * r0, x2: G.cx + Math.cos(t) * r1, y2: G.cy - Math.sin(t) * r1, class: 'g-tick' }));
  }
  const gaugeSvg = svg('svg', { viewBox: '0 -2 120 66', class: 'tension-svg' }, [
    svg('path', { d: arc(G.cx, G.cy, G.r, 0, 1), class: 'g-track', fill: 'none' }),
    lowPath,
    highPath,
    bandPath,
    ...ticks,
    needle,
  ]);
  const tensionZone = h('span.tension-zone');
  const tension = h('div.set-tension', null, [gaugeSvg, h('div.tension-cap', null, [h('span.stat-label', { text: 'Tension' }), tensionZone])]);

  // Skiff-pull dial (heading-up: the boat points up; arrows show where the skiff is pulling and where it should).
  const pullArrow = svg('g', { class: 'pull-arrow' }, [svg('line', { x1: 32, y1: 32, x2: 32, y2: 9 }), svg('path', { d: 'M32,5 L27,13 L37,13 Z' })]);
  const idealArrow = svg('g', { class: 'pull-ideal' }, [svg('line', { x1: 32, y1: 32, x2: 32, y2: 8 }), svg('path', { d: 'M32,4.5 L28.5,10.5 L35.5,10.5 Z' })]);
  const pullSvg = svg('svg', { viewBox: '0 0 64 64', class: 'pull-svg' }, [
    svg('circle', { cx: 32, cy: 32, r: 27, class: 'pull-ring' }),
    idealArrow,
    pullArrow,
    svg('path', { d: 'M32,21 C35,24 35.6,29 35.4,38 L34.2,43 L29.8,43 L28.6,38 C28.4,29 29,24 32,21 Z', class: 'pull-boat' }),
  ]);
  const pullState = h('span.pull-state');
  const keyA = h('span.keycap.tiny', { text: 'A' });
  const keyD = h('span.keycap.tiny', { text: 'D' });
  const pull = h('div.set-pull', null, [pullSvg, h('div.pull-cap', null, [h('span.stat-label', { text: 'Skiff pull' }), h('span.pull-keys', null, [keyA, keyD]), pullState])]);

  const brailBig = h('div.brail-big');
  const brailFish = h('div.brail-fish');
  const brailCount = h('div.set-brail-count', null, [brailBig, brailFish]);

  const main = h('div.set-main', null, [payout.el, rings.el, haul.el, brail.el]);
  const stats = h('div.set-stats', null, [skiff.el, hook.el, hold.el]);

  const bottomEl = h('span.bottom-warn');
  const wheelEl = h('span.wheel-warn', { text: 'Stern near the corks!' });
  const foot = h('div.set-foot', null, [bottomEl, wheelEl]);
  const stallEl = h('div.set-stall');
  const abortEl = h('div.set-abort', null, [h('span.abort-fill'), h('span.abort-text', { text: 'Aborting the set — hauling back…' })]);

  const panel = h('div.hud-set.hud-panel', null, [
    h('div.set-head', null, [setNoEl, phaseEl, closedEl, depth]),
    stallEl,
    h('div.set-body', null, [tension, brailCount, main, stats, pull]),
    foot,
    abortEl,
  ]);
  const el = h('div.hud-set-wrap', null, [messageEl, panel]);

  const show = (node, on) => toggle(node, 'hidden', !on);
  let lastBand = '';
  let lastPhase = '';

  function update() {
    const f = ctx.systems.fishing;
    const hud = f?.hud;
    const phase = hud?.phase ?? f?.state ?? 'idle';
    const active = PHASES.includes(phase);
    toggle(el, 'active', active);
    // The message line also carries the idle rocky-bottom caution, but only beside a "Let 'er go" prompt: where a set
    // can't start (too shallow, closed, moving) the warning would be noise.
    let idleWarn = null;
    if (!active && hud?.bottomWarning && ctx.state.control === 'boat') {
      const offer = ctx.interact?.current?.action?.id ?? '';
      if (offer.startsWith('fishing-letgo')) idleWarn = hud.bottomWarning;
    }
    // While brailing the console's count-up already says it; skip the duplicate caption.
    const line = active ? (phase === 'brailing' && /^Brailing/i.test(hud?.message ?? '') ? null : hud?.message) : idleWarn;
    setText(messageEl, line ?? '');
    toggle(messageEl, 'hidden', !line);
    toggle(messageEl, 'warn', !active && !!idleWarn);
    if (!active) {
      lastPhase = phase;
      return;
    }
    if (phase !== lastPhase) {
      lastPhase = phase;
      for (const p of PHASES) toggle(panel, `ph-${p}`, p === phase);
    }
    setText(setNoEl, `Set ${hud.setNumber || f?.setNumber || 1}`);
    toggle(closedEl, 'hidden', !hud.closedWater);
    setText(phaseEl, `${PHASE_LABEL[phase] ?? phase}${hud.hook && (phase === 'setting' || phase === 'holding') ? ' · hook' : ''}${hud.tied ? ' · tied off' : ''}`);

    const netLen = Number(ctx.systems.net?.length) || ctx.config.net.length;
    const pay = Math.max(0, Math.min(1, hud.payout ?? 0));
    show(payout.el, phase === 'setting' || phase === 'holding');
    setStyle(payout.fill, 'transform', `scaleX(${pay.toFixed(3)})`);
    setText(payout.value, `${fathoms(pay * netLen)} / ${fathoms(netLen)} fm`);

    const d = hud.distanceToSkiff;
    const skiffOn = Number.isFinite(d) && (phase === 'setting' || phase === 'holding' || phase === 'closing');
    show(skiff.el, skiffOn);
    if (skiffOn) {
      setText(skiff.val, `${int(d)} m`);
      const s = ctx.systems.seiner;
      const k = ctx.systems.skiff?.position;
      const ok = s?.position && k && Number.isFinite(k.x);
      toggle(skiffArrow, 'hidden', !ok);
      if (ok) {
        const rel = deltaDeg(bearingDistance(s.position.x, s.position.z, k.x, k.z).bearingDeg, headingDeg(s.heading ?? 0));
        setStyle(skiffArrow, 'transform', `rotate(${rel.toFixed(0)}deg)`);
      }
    }
    toggle(skiff.el, 'ready', !!hud.closeReady && phase === 'setting');

    const est = Number(hud.inHook) || 0;
    show(hook.el, phase !== 'brailing');
    setText(hook.labelEl, phase === 'setting' || phase === 'holding' ? (hud.hook ? 'In the hook' : 'Inside the net') : 'In the net');
    setText(hook.val, est > 0 ? `~${int(est)}` : '—');

    show(hold.el, phase === 'holding');
    setText(hold.val, mmss(hud.holdSeconds ?? 0));

    // Purse.
    show(tension, phase === 'pursing');
    show(rings.el, phase === 'pursing');
    if (phase === 'pursing') {
      const ts = tensionState(hud.tension, hud.tensionBand);
      const band = `${ts.lo.toFixed(3)}:${ts.hi.toFixed(3)}`;
      if (band !== lastBand) {
        lastBand = band;
        bandPath.setAttribute('d', arc(G.cx, G.cy, G.r, ts.lo, ts.hi));
        lowPath.setAttribute('d', arc(G.cx, G.cy, G.r, 0, ts.lo));
        highPath.setAttribute('d', arc(G.cx, G.cy, G.r, ts.hi, 1));
      }
      setStyle(needle, 'transform', `rotate(${(-90 + ts.t * 180).toFixed(1)}deg)`);
      setText(tensionZone, ts.zone === 'good' ? 'steady' : ts.zone === 'low' ? 'too slow' : 'too fast');
      toggle(tension, 'zone-low', ts.zone === 'low');
      toggle(tension, 'zone-high', ts.zone === 'high');
      const pr = Math.max(0, Math.min(1, hud.pursed ?? 0));
      setStyle(rings.fill, 'transform', `scaleX(${pr.toFixed(3)})`);
      setText(rings.value, `${Math.round(pr * 100)}%`);
    }

    // Haul.
    show(haul.el, phase === 'hauling');
    if (phase === 'hauling') {
      const hv = Math.max(0, Math.min(1, hud.hauled ?? 0));
      setStyle(haul.fill, 'transform', `scaleX(${hv.toFixed(3)})`);
      setText(haul.value, `${Math.round(hv * 100)}%`);
    }

    // Skiff pull dial.
    const pulling = phase === 'pursing' || phase === 'hauling';
    show(pull, pulling);
    if (pulling) {
      const sh = ctx.systems.seiner?.heading ?? 0;
      const rel = headingDeg((hud.towHeading ?? sh) - sh);
      setStyle(pullArrow, 'transform', `rotate(${rel}deg)`);
      const ideal = hud.idealTowHeading;
      toggle(idealArrow, 'hidden', !Number.isFinite(ideal));
      if (Number.isFinite(ideal)) setStyle(idealArrow, 'transform', `rotate(${headingDeg(ideal - sh)}deg)`);
      // How far the pull is from the line off the net, and which key brings it round.
      const adv = pullAdvice(hud.towHeading ?? sh, ideal);
      setText(pullState, adv.state === 'none' ? '' : adv.key ? 'swing the pull' : 'on line');
      toggle(pull, 'off', adv.state === 'off');
      toggle(pull, 'near', adv.state === 'near');
      toggle(keyA, 'lit', adv.key === 'A');
      toggle(keyD, 'lit', adv.key === 'D');
    }

    // Brailing.
    show(brailCount, phase === 'brailing');
    show(brail.el, phase === 'brailing');
    if (phase === 'brailing') {
      setText(brailBig, `${int(hud.brailLbs ?? 0)} lb`);
      setText(brailFish, `${int(hud.brailFish ?? 0)} fish aboard`);
      const bp = Math.max(0, Math.min(1, hud.brailProgress ?? 0));
      setStyle(brail.fill, 'transform', `scaleX(${bp.toFixed(3)})`);
      setText(brail.value, hud.acceptedLbs ? `of ${int(hud.acceptedLbs)} lb` : '');
    }
    show(stats, phase !== 'brailing');

    // Stalls and warnings.
    const stall = hud.stall;
    const stallText = stall === 'wheel' ? 'Net’s in the wheel!' : stall === 'snag' ? 'Hung up on the bottom!' : stall === 'foul' ? 'Rings fouled — ease off' : '';
    setText(stallEl, stallText ? `${stallText}${hud.stallSeconds > 0.5 ? `  ${Math.ceil(hud.stallSeconds)} s` : ''}` : '');
    toggle(stallEl, 'hidden', !stallText);
    const dep = Number(hud.depthUnderStern);
    setText(depthVal, Number.isFinite(dep) ? `${dep < 10 ? dep.toFixed(1) : Math.round(dep)} m` : '—');
    toggle(depth, 'shoal', Number.isFinite(dep) && dep < (Number(ctx.systems.net?.depth) || 16));
    setText(bottomEl, hud.bottomWarning ?? '');
    toggle(bottomEl, 'hidden', !hud.bottomWarning);
    toggle(bottomEl, 'rocky', /rock/i.test(hud.bottomWarning ?? ''));
    const wheel = (hud.wheelDanger ?? 0) > 0.35 && phase === 'pursing';
    toggle(wheelEl, 'hidden', !wheel);
    show(foot, !!hud.bottomWarning || wheel);
    const ab = Number(hud.abortProgress) || 0;
    toggle(abortEl, 'hidden', ab <= 0.05);
    if (ab > 0.05) setStyle(abortEl, '--p', Math.min(1, ab).toFixed(2));
  }

  return { el, update };
}
