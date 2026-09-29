// Toasts, discovery/goal/opener banners, VHF radio captions, hints and the "time passes" fade. Everything here is
// rendered from events (ui:toast, ui:radio, ui:hint, place:discovered, opener:*) queued by ui.js and drained in
// frame(), so the UI never builds DOM from inside another system's update.

import { h, clear, keycap } from './dom.js';
import { keycapify, isPinnedRadio, nextRadio, pinnedReading, radioLife, radioOverflow, toastDuration } from './lib/logic.js';
import { GLYPHS } from './lib/art.js';
import { svgFrom } from './dom.js';
import { clockTime } from './lib/format.js';

const MAX_TOASTS = 4;
const MAX_RADIO = 2;
const MAX_RADIO_QUEUE = 6;
const CPS = 42; // typewriter characters per second
const KIND_LABEL = {
  cape: 'Cape', bay: 'Bay', strait: 'Strait', town: 'Town', village: 'Village', harbor: 'Harbor', cannery: 'Cannery',
  hatchery: 'Hatchery', landmark: 'Landmark', island: 'Island', river: 'River', lake: 'Lake', peak: 'Peak',
  lighthouse: 'Light', wildlife: 'Wildlife', history: 'History', viewpoint: 'Viewpoint', stream: 'Salmon stream',
};

export function createMessages(ctx, root) {
  const layer = h('div.ui-messages');
  const toastBox = h('div.toasts');
  const bannerBox = h('div.banners');
  const radioBox = h('div.radio-stack');
  const hintBox = h('div.hints');
  const fadeEl = h('div.ui-fade', null, [h('div.fade-title'), h('div.fade-rule'), h('div.fade-sub')]);
  layer.append(bannerBox, toastBox, radioBox, hintBox);
  root.append(layer, fadeEl);

  const toasts = []; // { el, t, life }
  const radios = []; // { el, t, life, typing, tip, pinned }
  const radioQueue = [];
  let banner = null; // { el, t, life }
  let bannerGap = 0; // seconds until the next banner may start (the last one is still fading out)
  const bannerQueue = [];
  const hintQueue = [];
  let hint = null;
  let fadeTimer = 0;
  let fadeHold = 0;

  function fadeTick(realDt) {
    fadeTimer -= realDt * 1000;
    if (fadeTimer <= fadeHold && fadeEl.classList.contains('hold')) fadeEl.classList.remove('hold');
    if (fadeTimer <= 0) fadeEl.classList.remove('on');
  }

  // Queues filled by event handlers; drained in frame().
  const inbox = { toasts: [], discoveries: [], radio: [], hints: [], banners: [] };

  function makeToast({ text, kind = 'info', duration }) {
    const el = h(`div.toast.toast-${kind}`, null, [h('span.toast-dot'), h('span.toast-text', { text })]);
    toastBox.append(el);
    requestAnimationFrame(() => el.classList.add('in'));
    toasts.push({ el, t: 0, life: toastDuration({ duration }) });
    while (toasts.length > MAX_TOASTS) retire(toasts.shift(), 0);
  }

  function retire(item, delay = 0) {
    if (!item || item.dead) return;
    item.dead = true;
    item.el.classList.remove('in');
    item.el.classList.add('out');
    setTimeout(() => item.el.remove(), 450 + delay);
  }

  function showBanner(b) {
    const el = h(`div.banner.banner-${b.tone ?? 'discovery'}`, null, [
      b.kicker ? h('div.banner-kicker', { text: b.kicker }) : null,
      h('div.banner-title', { text: b.title }),
      h('div.banner-rule'),
      b.sub ? h('div.banner-sub', { text: b.sub }) : null,
    ]);
    bannerBox.append(el);
    requestAnimationFrame(() => el.classList.add('in'));
    banner = { el, t: 0, life: b.life ?? 5 };
    layer.classList.add('has-banner');
  }

  // Typewriter: characters (and keycaps) fade in one after another via CSS animation delays.
  function typewriter(text, cps = 42) {
    const frag = document.createDocumentFragment();
    let i = 0;
    for (const seg of keycapify(text)) {
      if (seg.key) {
        const k = keycap(seg.key, 'inline');
        k.classList.add('tw');
        k.style.animationDelay = `${(i / cps).toFixed(3)}s`;
        frag.append(k);
        i += 2;
        continue;
      }
      // Group characters into words so line breaking stays natural.
      for (const word of seg.text.split(/(\s+)/)) {
        if (!word) continue;
        if (/^\s+$/.test(word)) {
          frag.append(document.createTextNode(word));
          i += word.length;
          continue;
        }
        const w = document.createElement('span');
        w.className = 'tw-word';
        for (const ch of word) {
          const c = document.createElement('span');
          c.className = 'tw';
          c.textContent = ch;
          c.style.animationDelay = `${(i / cps).toFixed(3)}s`;
          w.append(c);
          i++;
        }
        frag.append(w);
      }
    }
    return frag;
  }

  // One transmission at a time, like a real channel: a caption types out fully (plus a short beat) before the next
  // starts, at WP-AUDIO's radio voice pace (42 characters per second). Pinned cards (Uncle Pete's tips and calls)
  // jump the queue, hold routine traffic while they are read, and keep their full text for their whole life; the
  // rest collapse to one dimmed line once something newer arrives (lib/logic.js nextRadio / radioOverflow).
  function makeRadio({ from, text, channel, tip, pinned, hours }, cps = CPS) {
    const ch = String(channel ?? '16').replace(/^ch\s*/i, '');
    const el = h(`div.radio${tip ? '.radio-tip' : ''}${pinned ? '.pinned' : ''}`, null, [
      h('div.radio-head', null, [
        h('span.radio-ch', null, [svgFrom(GLYPHS.radio), h('span', { text: /^wx/i.test(ch) ? 'WX' : `CH ${ch}` })]),
        h('span.radio-from', { text: from || 'VHF' }),
        tip ? h('span.radio-tag', { text: 'Tip' }) : null,
        h('span.radio-time', { text: clockTime(Number.isFinite(hours) ? hours : ctx.clock?.hours ?? 0) }),
      ]),
      h('div.radio-text', null, typewriter(text, cps)),
    ]);
    radioBox.append(el);
    requestAnimationFrame(() => el.classList.add('in'));
    radios.push({ el, t: 0, life: radioLife(text, { pinned, tip }, cps), typing: String(text).length / cps, tip: !!tip, pinned: !!pinned });
    for (const r of radioOverflow(radios, MAX_RADIO)) {
      retire(r);
      radios.splice(radios.indexOf(r), 1);
    }
    ctx.events?.emit?.('ui:radioShown', { from: from || 'VHF', channel: ch, tip: !!tip });
  }

  function enqueueRadio(r) {
    radioQueue.push({ ...r, pinned: isPinnedRadio(r), hours: ctx.clock?.hours });
    while (radioQueue.length > MAX_RADIO_QUEUE) {
      const i = radioQueue.findIndex((q) => !q.pinned);
      radioQueue.splice(i < 0 ? 0 : i, 1);
    }
  }

  function pumpRadio() {
    const i = nextRadio(radioQueue, radios);
    if (i >= 0) makeRadio(radioQueue.splice(i, 1)[0]);
  }

  function makeHint({ text }) {
    clear(hintBox);
    const body = h('div.hint-text');
    for (const seg of keycapify(text)) body.append(seg.key ? keycap(seg.key, 'inline') : document.createTextNode(seg.text));
    const el = h('div.hint', null, [h('div.hint-head', { text: 'Skipper’s notes' }), body]);
    hintBox.append(el);
    requestAnimationFrame(() => el.classList.add('in'));
    hint = { el, t: 0, life: Math.max(7, String(text).length / 14 + 3) };
  }

  function discoveryBanner(d, toastText) {
    const bonus = /\+\$(\d+)/.exec(toastText ?? '')?.[1];
    const note = /chart note/.test(toastText ?? '') || (d.intel?.length ?? 0) > 0;
    const parts = [];
    if (bonus || d.bonus) parts.push(`+$${bonus ?? d.bonus}`);
    if (d.kind === 'stream') parts.push('run timing on the chart');
    else if (note) parts.push('chart note added');
    parts.push('logged');
    return { kicker: `${KIND_LABEL[d.kind] ?? 'Discovered'} · discovered`, title: d.name, sub: parts.join(' · '), tone: 'discovery', life: 5.2 };
  }

  const api = {
    layer,
    inbox,

    // Drains the event inbox and ages everything. Called from ui.frame (every frame; cheap when idle).
    tick(realDt, { mode, hudVisible }) {
      const inGame = mode !== 'title' && mode !== 'loading';
      if (!inGame) {
        inbox.toasts.length = 0;
        inbox.discoveries.length = 0;
        inbox.radio.length = 0;
        inbox.banners.length = 0;
      }
      if (inbox.discoveries.length || inbox.toasts.length) {
        const disc = inbox.discoveries.splice(0);
        for (const t of inbox.toasts.splice(0)) {
          const d = t.kind === 'discovery' ? disc.find((x) => x.name && t.text.includes(x.name)) : null;
          if (d) {
            d.used = true;
            bannerQueue.push(discoveryBanner(d, t.text));
          } else if (t.kind === 'goal') {
            bannerQueue.push({ kicker: 'Season goal', title: t.text.replace(/^Season goal:\s*/, '').split(' — ')[0], sub: t.text.split(' — ')[1] ?? '', tone: 'goal', life: 6.5 });
          } else makeToast(t);
        }
        for (const d of disc) if (!d.used && !d.memorial) bannerQueue.push(discoveryBanner(d, ''));
      }
      for (const b of inbox.banners.splice(0)) bannerQueue.push(b);
      for (const r of inbox.radio.splice(0)) enqueueRadio(r);
      // Messages hold still behind menus, the chart and photo mode, so nothing is missed while paused.
      const running = mode === 'play' || mode === 'cutscene';
      if (!running) {
        if (fadeTimer > 0) fadeTick(realDt);
        return;
      }
      pumpRadio();
      if (bannerGap > 0) bannerGap -= realDt;
      if (!banner && bannerGap <= 0 && bannerQueue.length && hudVisible) showBanner(bannerQueue.shift());
      if (!hint && hintQueue.length && mode === 'play' && !pinnedReading(radios)) makeHint(hintQueue.shift());

      for (const t of toasts) {
        t.t += realDt;
        if (t.t > t.life) retire(t);
      }
      for (let i = toasts.length - 1; i >= 0; i--) if (toasts[i].dead) toasts.splice(i, 1);
      for (const r of radios) {
        r.t += realDt;
        if (r.t > r.life) retire(r);
      }
      for (let i = radios.length - 1; i >= 0; i--) if (radios[i].dead) radios.splice(i, 1);
      if (banner) {
        banner.t += realDt;
        if (banner.t > banner.life) {
          retire(banner, 400);
          banner = null;
          bannerGap = 0.9;
          layer.classList.remove('has-banner');
        }
      }
      if (hint && mode === 'play') {
        hint.t += realDt;
        if (hint.t > hint.life) {
          retire(hint);
          hint = null;
        }
      }
      if (fadeTimer > 0) fadeTick(realDt);
    },

    queueHint(hint) {
      hintQueue.push(hint);
    },
    radioNow(r) {
      enqueueRadio(r);
    },

    // Full-screen "time passes" card (travel, sleep, waiting, tying up).
    fade({ title = '', subtitle = '', holdMs = 900, fadeMs = 1100 } = {}) {
      fadeEl.querySelector('.fade-title').textContent = title;
      fadeEl.querySelector('.fade-sub').textContent = subtitle;
      fadeEl.querySelector('.fade-rule').style.display = title ? '' : 'none';
      fadeEl.style.setProperty('--fade-ms', `${fadeMs}ms`);
      fadeEl.classList.add('on', 'hold');
      fadeTimer = holdMs + fadeMs;
      fadeHold = fadeMs;
    },

    clearAll() {
      for (const t of toasts) retire(t);
      for (const r of radios) retire(r);
      toasts.length = 0;
      radios.length = 0;
      radioQueue.length = 0;
      if (banner) retire(banner);
      banner = null;
      layer.classList.remove('has-banner');
      bannerQueue.length = 0;
      if (hint) retire(hint);
      hint = null;
      hintQueue.length = 0;
      for (const k of Object.keys(inbox)) inbox[k].length = 0;
    },

    debugState() {
      return { toasts: toasts.length, radio: radios.length, radioPinned: radios.filter((r) => r.pinned && !r.dead).length, radioQueued: radioQueue.length, banner: banner ? banner.el.querySelector('.banner-title')?.textContent : null, hintQueued: hintQueue.length + (hint ? 1 : 0) };
    },
  };
  return api;
}
