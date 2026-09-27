// Tiny DOM helpers for the UI modules.

import { keycapify } from './lib/logic.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// h('div.panel.ui-interactive', { onclick }, [children...]) — tag with optional .classes and #id.
export function h(sel, attrs = null, children = null) {
  const m = /^([a-z0-9-]+)?(#[\w-]+)?((?:\.[\w-]+)*)$/i.exec(sel) ?? [];
  const el = document.createElement(m[1] || 'div');
  if (m[2]) el.id = m[2].slice(1);
  if (m[3]) el.className = m[3].slice(1).replace(/\./g, ' ');
  if (attrs) applyAttrs(el, attrs);
  append(el, children);
  return el;
}

export function svg(tag, attrs = null, children = null) {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  append(el, children);
  return el;
}

// An element from trusted, module-authored SVG markup (icons, the logo mark).
export function svgFrom(markup) {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstElementChild;
}

function applyAttrs(el, attrs) {
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}

export function append(el, children) {
  if (children === null || children === undefined || children === false) return el;
  if (Array.isArray(children)) {
    for (const c of children) append(el, c);
    return el;
  }
  el.append(children instanceof Node ? children : document.createTextNode(String(children)));
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

// Sets textContent only when it changed (cheap guard for throttled HUD writes).
export function setText(el, text) {
  const t = String(text ?? '');
  if (el.__t !== t) {
    el.__t = t;
    el.textContent = t;
  }
}

export function setStyle(el, prop, value) {
  const key = `__s_${prop}`;
  if (el[key] !== value) {
    el[key] = value;
    el.style.setProperty(prop, value);
  }
}

export function toggle(el, cls, on) {
  const k = `__c_${cls}`;
  const v = !!on;
  if (el[k] !== v) {
    el[k] = v;
    el.classList.toggle(cls, v);
  }
}

export function keycap(label, extra = '') {
  return h(`span.keycap${extra ? `.${extra}` : ''}`, { text: label });
}

// Text with "Space", "(L)", "hold E" rendered as keycaps.
export function richText(text) {
  const frag = document.createDocumentFragment();
  for (const seg of keycapify(text)) frag.append(seg.key ? keycap(seg.key, 'inline') : document.createTextNode(seg.text));
  return frag;
}

export function button(label, onClick, { cls = '', disabled = false, title = null, key = null } = {}) {
  const b = h(`button.btn${cls ? `.${cls.split(' ').join('.')}` : ''}`, { type: 'button', title: title ?? undefined }, [key ? keycap(key, 'btn-key') : null, h('span.btn-label', { text: label })]);
  b.disabled = !!disabled;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    // Keyboard Space/Enter belong to the game and the panels' own routing, not to a focused button.
    b.blur();
    if (!b.disabled) onClick?.(e);
  });
  return b;
}
