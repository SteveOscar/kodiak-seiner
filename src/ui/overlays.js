// Binoculars overlay (twin-barrel vignette, reticle with a mil scale and bearing) while cameraRig.binoculars, and the
// photo-mode card that shows the free-camera keys for a few seconds.

import { h, setText, toggle, keycap } from './dom.js';
import { headingDeg, cardinal, SPECIES_INFO, nmLabel } from './lib/format.js';

const PLURAL = { pink: 'humpies', chum: 'dogs', sockeye: 'reds', coho: 'silvers', king: 'kings' };

export function createOverlays(ctx, root) {
  // Binoculars: a blurred union of two overlapping circles is cut out of a dark field, so the soft edge follows the
  // outline of the pair and the overlap in the middle stays clear.
  const bino = h('div.ui-bino');
  bino.innerHTML = `
    <svg class="bino-mask" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <filter id="binoSoft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="15"/></filter>
        <mask id="binoHoles" maskUnits="userSpaceOnUse" x="0" y="0" width="1600" height="900">
          <rect width="1600" height="900" fill="#fff"/>
          <g filter="url(#binoSoft)">
            <circle cx="578" cy="450" r="378" fill="#000"/>
            <circle cx="1022" cy="450" r="378" fill="#000"/>
          </g>
        </mask>
        <radialGradient id="binoTint" cx="50%" cy="50%" r="50%">
          <stop offset="0.55" stop-color="#000" stop-opacity="0"/>
          <stop offset="1" stop-color="#000" stop-opacity="0.28"/>
        </radialGradient>
      </defs>
      <rect width="1600" height="900" fill="url(#binoTint)"/>
      <rect width="1600" height="900" fill="#03080b" mask="url(#binoHoles)"/>
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
  const loggedTitle = h('div.bl-title');
  const loggedSub = h('div.bl-sub');
  const logged = h('div.bino-logged', null, [h('div.bl-kicker', { text: 'Logged on your chart' }), loggedTitle, loggedSub]);
  bino.append(binoBearing, binoHint, logged);
  // A school held in the glasses for a second becomes a charted sighting (cameraRig emits camera:sighting).
  let sighted = null;
  let loggedT = 0;
  ctx.events?.on?.('camera:sighting', (e) => {
    sighted = e ?? null;
  });

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
        toggle(binoHint, 'show', binoTime < 5 && loggedT <= 0);
        if (sighted) {
          const info = SPECIES_INFO[sighted.species];
          setText(loggedTitle, info ? `${info.name} school — ${PLURAL[sighted.species] ?? info.nick}` : 'A school of salmon');
          const p = ctx.systems.seiner?.position;
          const bits = [];
          if (Number.isFinite(sighted.heading)) bits.push(`heading ${cardinal(headingDeg(sighted.heading), 8)}`);
          if (p && Number.isFinite(sighted.x)) bits.push(`${nmLabel(Math.hypot(sighted.x - p.x, sighted.z - p.z), ctx.geo)} off`);
          setText(loggedSub, bits.join(' · '));
          loggedT = 3.4;
          toggle(logged, 'show', true);
          bino.classList.remove('hit');
          void bino.offsetWidth;
          bino.classList.add('hit');
        }
      }
      sighted = null;
      if (loggedT > 0) {
        loggedT -= realDt;
        if (loggedT <= 0 || !on) {
          loggedT = 0;
          toggle(logged, 'show', false);
        }
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
