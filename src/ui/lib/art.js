// Procedural line art for the UI (pure string builders, no DOM): the leaping-salmon mark on the title screen and the
// small glyphs used on the HUD and chart.

// Straight salmon, facing right, snout at x = 100, tail tip at x = 0, centre line y = 0 (SVG y down). Each entry is a
// path of absolute commands whose coordinate pairs are bent afterwards, so control points bend with their curves.
const BODY = [
  'M100,1',
  'C98,-3 94,-6 86,-9.4',
  'C76,-12.4 62,-13.4 52,-12.4',
  'C40,-11.2 28,-7.6 17,-3.6',
  // Caudal fin: broad, gently forked lobes.
  'Q10.5,-5.6 1.2,-13.2 Q3.9,-5.6 7.4,0 Q3.9,5.4 1.4,12.4 Q10.5,5.4 17,3.4',
  'C28,7.2 40,11.2 54,12.2',
  'C66,12.8 78,10.8 88,7',
  'C94,4.6 98,3 100,1',
];

const DETAILS = [
  // Dorsal fin.
  'M63,-13.1 C61,-17.6 58.6,-20.2 55.2,-21 C54.6,-18 53.8,-14.8 52.2,-12.5',
  // Adipose fin.
  'M30.2,-7.4 C29.6,-10 27.6,-11 25.6,-10.8 C26,-9.2 26,-7.8 25.4,-6.2',
  // Anal fin.
  'M35.5,9.6 C33.4,13.2 30.4,15 27.6,14.8 C28.4,12.4 28.4,9.6 27.6,7.2',
  // Pelvic fin.
  'M53.5,12.2 C51.6,15 49.4,16.4 47,16.6 C47.6,14.8 47.6,13.2 47,11.7',
  // Pectoral fin.
  'M80.5,3.4 C77.4,5.4 74,7.2 70.4,7.8 C72.6,6 74.8,4.6 76.4,3',
  // Gill cover.
  'M85.4,-8.6 C82.4,-4.2 82,1.4 84.2,6.6',
  // Mouth.
  'M100,1 L94.6,2.2',
];

const LATERAL = 'M83,-1.4 C70,-2.4 52,-2.2 36,-1.2 C28,-0.6 22,-0.2 17.4,0';

// Spots across the back and tail (pink salmon carry big oval spots on the back and caudal fin).
const SPOTS = [
  [60, -9.2], [54, -8.6], [47, -8.4], [40, -7], [33, -5.4], [67, -9.6], [26, -3.6],
  [9.2, -6.2], [9.4, 5.8],
];

function bendPoint(x, y, R, rot) {
  const th = (x - 50) / R;
  const r = R - y;
  let px = 50 + r * Math.sin(th);
  let py = R - r * Math.cos(th);
  // Rotate about the body centre so the fish rises out of the water.
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const dx = px - 50;
  const dy = py;
  px = 50 + dx * c - dy * s;
  py = dx * s + dy * c;
  return [px, py];
}

function bendPath(d, R, rot, ox, oy) {
  return d.replace(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g, (_, a, b) => {
    const [x, y] = bendPoint(Number(a), Number(b), R, rot);
    return `${(x + ox).toFixed(2)},${(y + oy).toFixed(2)}`;
  });
}

// SVG markup of the leaping salmon over a swell line. `R` is the bend radius (smaller = more arched).
export function salmonMarkSVG({ stroke = 'currentColor', width = 1.15, R = 60, rotDeg = -8, waves = true, cls = 'salmon-mark' } = {}) {
  const rot = (rotDeg * Math.PI) / 180;
  const ox = 10;
  const oy = 33;
  const body = bendPath(BODY.join(' '), R, rot, ox, oy);
  const details = DETAILS.map((d) => bendPath(d, R, rot, ox, oy));
  const lateral = bendPath(LATERAL, R, rot, ox, oy);
  const spots = SPOTS.map(([x, y]) => {
    const [px, py] = bendPoint(x, y, R, rot);
    return `<ellipse cx="${(px + ox).toFixed(2)}" cy="${(py + oy).toFixed(2)}" rx="0.95" ry="0.7" />`;
  }).join('');
  const [ex, ey] = bendPoint(92.4, -2.6, R, rot);
  const wave = waves
    ? `<g class="salmon-waves" fill="none" stroke="${stroke}" stroke-width="${width * 0.8}" stroke-linecap="round">
        <path d="M2,72 C14,66 24,66 36,71 S58,77 70,71 S94,64 118,70" />
        <path class="w2" d="M14,79 C26,75 36,75 47,78.5 S68,83 80,78.5 S98,74 108,77" opacity="0.6" />
        <path class="w3" d="M30,85 C40,82.5 48,82.5 56,84.6 S72,87.4 82,84.6" opacity="0.35" />
      </g>
      <g class="salmon-drops" fill="${stroke}" stroke="none"><circle cx="17" cy="58" r="0.9"/><circle cx="12" cy="52" r="0.6"/><circle cx="22" cy="51" r="0.55"/><circle cx="103" cy="56" r="0.7"/><circle cx="108" cy="50" r="0.5"/></g>`
    : '';
  return `<svg class="${cls}" viewBox="0 0 120 92" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <g fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round">
      <path class="salmon-body" d="${body}" />
      ${details.map((d) => `<path d="${d}" />`).join('')}
      <path d="${lateral}" stroke-dasharray="0.6 2.2" stroke-width="${width * 0.8}" />
    </g>
    <g fill="${stroke}" opacity="0.8">${spots}</g>
    <circle cx="${(ex + ox).toFixed(2)}" cy="${(ey + oy).toFixed(2)}" r="1.25" fill="none" stroke="${stroke}" stroke-width="${width * 0.8}" />
    <circle cx="${(ex + ox + 0.25).toFixed(2)}" cy="${(ey + oy - 0.2).toFixed(2)}" r="0.45" fill="${stroke}" />
    ${wave}
  </svg>`;
}

// Small glyphs (24×24 viewBox, stroke = currentColor).
export const GLYPHS = {
  anchor:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="4.6" r="2"/><path d="M12 6.6V21M7.5 10h9M4 14.5c.6 3.8 4 6.5 8 6.5s7.4-2.7 8-6.5M4 14.5l-1.6 1.6M4 14.5l2 .8M20 14.5l1.6 1.6M20 14.5l-2 .8"/></g></svg>',
  tender:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M2.5 14h19l-2.6 4.6H5.2z"/><path d="M14 14V9.2h4.2V14M16 9.2V6M6 14V11l5-3"/></g></svg>',
  fish:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3 12c3-4.2 9.5-5.6 14-2.4L21 7v10l-4-2.6C12.5 17.6 6 16.2 3 12z"/><circle cx="7.4" cy="11.2" r=".8" fill="currentColor"/></g></svg>',
  flag:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 21V3.5M6 4.5h11l-2.6 3.8L17 12H6"/></g></svg>',
  note:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M5 3.5h10.5L19 7v13.5H5z"/><path d="M15.5 3.5V7H19M8 11h8M8 14.5h8M8 18h5"/></g></svg>',
  binoculars:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6.5" cy="15.5" r="4"/><circle cx="17.5" cy="15.5" r="4"/><path d="M10 14.5h4M4 12.5l2.2-7.5h3L10 12M20 12.5l-2.2-7.5h-3L14 12"/></g></svg>',
  radio:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="6" y="7.5" width="12" height="14" rx="1.6"/><path d="M9 7.5V2.5M9 11.5h6M9 14.5h6"/><circle cx="12" cy="18.2" r="1.3"/></g></svg>',
  wave:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 14c2.5-3 5-3 7.5 0s5 3 7.5 0 3.5-2.4 5-1.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  sun:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/></g></svg>',
  moon:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.5 15.5A7.5 7.5 0 0 1 9 4.3 7.8 7.8 0 1 0 19.8 14a7.3 7.3 0 0 1-2.3 1.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  paw:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="currentColor"><ellipse cx="12" cy="15.5" rx="5" ry="4.2"/><circle cx="6" cy="9.5" r="1.8"/><circle cx="9.6" cy="6.4" r="1.8"/><circle cx="14.4" cy="6.4" r="1.8"/><circle cx="18" cy="9.5" r="1.8"/></g></svg>',
  pin:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 21.5s-6.5-6.4-6.5-11.2a6.5 6.5 0 0 1 13 0C18.5 15.1 12 21.5 12 21.5z"/><circle cx="12" cy="10.2" r="2.3"/></g></svg>',
  camera:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M3 7.5h4l1.6-2.5h6.8L17 7.5h4v12H3z"/><circle cx="12" cy="13.4" r="3.8"/></g></svg>',
};
