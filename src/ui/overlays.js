// Binoculars overlay (twin-barrel vignette, reticle with a mil scale and bearing) while cameraRig.binoculars, and the
// photo-mode card that shows the free-camera keys for a few seconds.

import { h, setText, toggle, keycap } from './dom.js';
import { headingDeg, cardinal } from './lib/format.js';

export function createOverlays(ctx, root) {
  // Binoculars: an SVG mask cuts two overlapping circles out of a dark field.
  const bino = h('div.ui-bino');
  bino.innerHTML = `
    <svg class="bino-mask" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <radialGradient id="binoEdge" cx="50%" cy="50%" r="50%">
          <stop offset="0.80" stop-color="#000" stop-opacity="0"/>
          <stop offset="0.93" stop-color="#000" stop-opacity="0.55"/>
          <stop offset="1" stop-color="#000" stop-opacity="1"/>
        </radialGradient>
        <mask id="binoHoles">
          <rect width="1600" height="900" fill="#fff"/>
          <circle cx="585" cy="450" r="395" fill="#000"/>
          <circle cx="1015" cy="450" r="395" fill="#000"/>
        </mask>
      </defs>
      <rect width="1600" height="900" fill="#03080b" mask="url(#binoHoles)"/>
      <circle cx="585" cy="450" r="395" fill="url(#binoEdge)"/>
      <circle cx="1015" cy="450" r="395" fill="url(#binoEdge)"/>
    </svg>
    <svg class="bino-reticle" viewBox="-200 -120 400 240" aria-hidden="true">
      <g fill="none" stroke="rgba(255,255,255,0.55)" stroke-width="0.9">
        <line x1="-150" y1="0" x2="-14" y2="0"/><line x1="14" y1="0" x2="150" y2="0"/>
        <line x1="0" y1="-90" x2="0" y2="-14"/><line x1="0" y1="14" x2="0" y2="46"/>
        ${Array.from({ length: 11 }, (_, i) => i - 5)
          .filter((i) => i !== 0)
          .map((i) => `<line x1="${i * 26}" y1="-4" x2="${i * 26}" y2="4"/>`)
          .join('')}
        ${Array.from({ length: 4 }, (_, i) => i + 1)
          .map((i) => `<line x1="-4" y1="${i * 22 + 14}" x2="4" y2="${i * 22 + 14}"/>`)
          .join('')}
      </g>
      <circle r="2" fill="rgba(255,140,60,0.9)"/>
    </svg>`;
  const binoBearing = h('div.bino-bearing');
  const binoHint = h('div.bino-hint', { text: 'Hold steady on jumpers to log the school on your chart' });
  bino.append(binoBearing, binoHint);

  const photo = h('div.ui-photo', null, [
    h('div.photo-card', null, [
      h('div.photo-title', { text: 'Photo mode' }),
      h('div.photo-keys', null, [
        row(['W', 'A', 'S', 'D'], 'fly'),
        row(['Space', 'Q'], 'up · down'),
        row(['Shift'], 'faster'),
        row(['Drag'], 'look'),
        row(['Wheel'], 'lens'),
        row(['H'], 'exit'),
      ]),
    ]),
  ]);
  root.append(bino, photo);

  function row(keys, text) {
    return h('span.photo-row', null, [...keys.map((k) => keycap(k, 'tiny')), h('span', { text })]);
  }

  let binoOn = false;
  let binoTime = 0;
  let photoT = 0;

  return {
    // Every frame: the binocular state flips instantly; the bearing text is throttled by the caller.
    frame(realDt, { mode }) {
      const on = mode === 'play' && !!ctx.systems.cameraRig?.binoculars;
      if (on !== binoOn) {
        binoOn = on;
        toggle(bino, 'on', on);
        toggle(root, 'bino-on', on);
        binoTime = 0;
      }
      if (on) {
        binoTime += realDt;
        toggle(binoHint, 'show', binoTime < 5);
      }
      if (mode === 'photo') {
        photoT += realDt;
        toggle(photo, 'on', photoT < 4.5);
      } else if (photoT) {
        photoT = 0;
        toggle(photo, 'on', false);
      }
    },
    update() {
      if (!binoOn) return;
      const cam = ctx.camera;
      const e = cam.matrixWorld.elements;
      const hd = headingDeg(Math.atan2(-e[8], e[10]));
      setText(binoBearing, `${String(hd).padStart(3, '0')}° ${cardinal(hd, 16)}   ·   ${Math.round(cam.fov)}° field`);
    },
  };
}
