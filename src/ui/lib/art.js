// Procedural line art for the UI (pure string builders, no DOM): the leaping-salmon mark on the title screen and the
// small glyphs used on the HUD and chart.

// The leaping salmon is built along a curved spine (snout to the wrist of the tail) with a depth profile measured off
// a bright ocean salmon, so the outline stays anatomically smooth at any pose; fins, gill cover, eye, lateral line and
// spots sit in the spine's local frame. The tail fin keeps the spine's direction at the wrist, flicked slightly up.

// Half-depths (fractions of spine length) of the back and belly from snout (s = 0) to the wrist of the tail (s = 1).
const PROFILE = [
  [0, 0, 0],
  [0.03, 0.03, 0.02],
  [0.08, 0.058, 0.043],
  [0.15, 0.084, 0.066],
  [0.25, 0.104, 0.085],
  [0.38, 0.113, 0.094],
  [0.5, 0.107, 0.09],
  [0.62, 0.091, 0.077],
  [0.74, 0.07, 0.059],
  [0.85, 0.05, 0.043],
  [0.93, 0.039, 0.035],
  [1, 0.036, 0.033],
];

// Catmull-Rom through the profile knots, so the outline has no flats or bumps at the knots.
function profileAt(s) {
  const n = PROFILE.length;
  let i = 1;
  while (i < n - 1 && s > PROFILE[i][0]) i++;
  const k0 = PROFILE[Math.max(0, i - 2)];
  const k1 = PROFILE[i - 1];
  const k2 = PROFILE[i];
  const k3 = PROFILE[Math.min(n - 1, i + 1)];
  const t = Math.max(0, Math.min(1, (s - k1[0]) / (k2[0] - k1[0])));
  const cr = (a, b, c, d) => {
    const m1 = ((c - a) / (k2[0] - k0[0] || 1)) * (k2[0] - k1[0]);
    const m2 = ((d - b) / (k3[0] - k1[0] || 1)) * (k2[0] - k1[0]);
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * b + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * c + (t3 - t2) * m2;
  };
  return [Math.max(0, cr(k0[1], k1[1], k2[1], k3[1])), Math.max(0, cr(k0[2], k1[2], k2[2], k3[2]))];
}

// Cubic spine sampled by arc length: frame(s) → { p, back (unit tangent toward the tail), up (dorsal normal) }.
function makeSpine(P) {
  const at = (t) => {
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    return [a * P[0][0] + b * P[1][0] + c * P[2][0] + d * P[3][0], a * P[0][1] + b * P[1][1] + c * P[2][1] + d * P[3][1]];
  };
  const N = 200;
  const pts = [];
  const len = [0];
  for (let i = 0; i <= N; i++) pts.push(at(i / N));
  for (let i = 1; i <= N; i++) len.push(len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const L = len[N];
  const frame = (s) => {
    const target = Math.max(0, Math.min(1, s)) * L;
    let i = 1;
    while (i < N && len[i] < target) i++;
    const f = (target - len[i - 1]) / Math.max(1e-9, len[i] - len[i - 1]);
    const p = [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f];
    const tx = pts[i][0] - pts[i - 1][0];
    const ty = pts[i][1] - pts[i - 1][1];
    const tl = Math.hypot(tx, ty) || 1;
    const back = [tx / tl, ty / tl];
    // SVG y points down, so the dorsal side of a fish swimming toward -back is the left-hand normal.
    return { p, back, up: [-back[1], back[0]] };
  };
  return { L, frame };
}

const f2 = (v) => v.toFixed(2);
const pt = (q) => `${f2(q[0])},${f2(q[1])}`;
// Point in a local frame: origin o, `b` units toward the tail, `u` units toward the back.
const loc = (o, fr, b, u) => [o[0] + fr.back[0] * b + fr.up[0] * u, o[1] + fr.back[1] * b + fr.up[1] * u];

// Smooth open path through points (Catmull-Rom as cubic Béziers).
function smooth(points, move = true) {
  let d = move ? `M${pt(points[0])}` : '';
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${pt(c1)} ${pt(c2)} ${pt(p2)}`;
  }
  return d;
}

// SVG markup of the leaping salmon over a swell line. Smaller `R` arches the leap more; `rotDeg` tips it.
export function salmonMarkSVG({ stroke = 'currentColor', width = 1.15, R = 60, rotDeg = -8, waves = true, cls = 'salmon-mark' } = {}) {
  const arch = Math.max(0.3, Math.min(1.6, 60 / Math.max(10, R)));
  const rot = ((rotDeg + 8) * Math.PI) / 180;
  const cx = 62;
  const cy = 34;
  const turn = (x, y) => [cx + (x - cx) * Math.cos(rot) - (y - cy) * Math.sin(rot), cy + (x - cx) * Math.sin(rot) + (y - cy) * Math.cos(rot)];
  // Snout high on the right, wrist of the tail low on the left: the arc of a fish clearing the water. The head dips
  // below the chord and the tail rises above it, more so with a stronger arch.
  const head = [106, 27];
  const wrist = [22, 51];
  const ha = (3 + 7 * arch) * (Math.PI / 180);
  const ta = -(26 + 14 * arch) * (Math.PI / 180);
  const P = [
    turn(...head),
    turn(head[0] - Math.cos(ha) * 30, head[1] - Math.sin(ha) * 30),
    turn(wrist[0] + Math.cos(ta) * 30, wrist[1] + Math.sin(ta) * 30),
    turn(...wrist),
  ];
  const { L, frame } = makeSpine(P);
  const edge = (s, side) => {
    const fr = frame(s);
    const [d, v] = profileAt(s);
    return loc(fr.p, fr, 0, side > 0 ? d * L * 1.08 : -v * L * 1.08);
  };

  // Body outline: back from snout to wrist, the tail fin, belly back to the snout.
  const S = 36;
  const backPts = [];
  const bellyPts = [];
  for (let i = 0; i <= S; i++) {
    const s = i / S;
    backPts.push(edge(s, 1));
    bellyPts.push(edge(s, -1));
  }
  const w = frame(1);
  // The caudal fin follows the wrist, flicked a little toward the back.
  const flick = 0.16;
  const tf = {
    back: [w.back[0] * Math.cos(flick) - w.back[1] * Math.sin(flick), w.back[1] * Math.cos(flick) + w.back[0] * Math.sin(flick)],
  };
  tf.up = [-tf.back[1], tf.back[0]];
  const wristTop = backPts[S];
  const wristBot = bellyPts[S];
  const upTip = loc(w.p, tf, 13, 10.5);
  const notch = loc(w.p, tf, 8.6, 0.3);
  const lowTip = loc(w.p, tf, 12.6, -9.8);
  const tail =
    ` C${pt(loc(wristTop, tf, 4.5, 1.2))} ${pt(loc(upTip, tf, -5.5, -3.2))} ${pt(upTip)}` +
    ` C${pt(loc(upTip, tf, -1.6, -4.4))} ${pt(loc(notch, tf, 0.6, 3.4))} ${pt(notch)}` +
    ` C${pt(loc(notch, tf, 0.6, -3.4))} ${pt(loc(lowTip, tf, -1.6, 4.2))} ${pt(lowTip)}` +
    ` C${pt(loc(lowTip, tf, -5.5, 3))} ${pt(loc(wristBot, tf, 4.5, -1.2))} ${pt(wristBot)}`;
  const body = `${smooth(backPts)}${tail}${smooth([...bellyPts].reverse(), false)} Z`;

  // Fins: a leading edge rising from the body, a swept tip, a trailing edge back to the body.
  const fin = (s0, s1, side, tipBack, tipOut) => {
    const a = edge(s0, side);
    const b = edge(s1, side);
    const fa = frame(s0);
    const tip = loc(a, fa, tipBack, side * tipOut);
    return `M${pt(a)} C${pt(loc(a, fa, tipBack * 0.25, side * tipOut * 0.7))} ${pt(loc(tip, fa, -1.4, side * 0.4))} ${pt(tip)} C${pt(loc(tip, fa, 0.6, -side * tipOut * 0.45))} ${pt(loc(b, fa, -0.4, side * 1.4))} ${pt(b)}`;
  };
  const details = [
    fin(0.37, 0.5, 1, 6.6, 7), // dorsal
    fin(0.8, 0.855, 1, 3, 2.8), // adipose
    fin(0.53, 0.58, -1, 4, 3.6), // pelvic
    fin(0.72, 0.79, -1, 4.8, 4), // anal
  ];
  // Pectoral fin: a swept stroke low behind the gill.
  {
    const fr = frame(0.2);
    const [, v] = profileAt(0.2);
    const a = loc(fr.p, fr, 0, -v * L * 0.45);
    details.push(`M${pt(a)} C${pt(loc(a, fr, 3, -0.8))} ${pt(loc(a, fr, 6, -2.2))} ${pt(loc(a, fr, 8, -3.2))} C${pt(loc(a, fr, 5.6, -1.4))} ${pt(loc(a, fr, 3, -0.4))} ${pt(loc(a, fr, 1, -0.1))}`);
  }
  // Gill cover: a curve across the head.
  {
    const s = 0.165;
    const fr = frame(s);
    const [d, v] = profileAt(s);
    const top = loc(fr.p, fr, 0, d * L * 0.8);
    const bot = loc(fr.p, fr, 0, -v * L * 0.78);
    details.push(`M${pt(top)} C${pt(loc(top, fr, 2.4, -2.2))} ${pt(loc(bot, fr, 2.4, 2.2))} ${pt(bot)}`);
  }
  // Mouth.
  {
    const fr = frame(0.012);
    const m = loc(fr.p, fr, 0, -0.3);
    details.push(`M${pt(m)} L${pt(loc(m, fr, 5.2, -1.3))}`);
  }
  // Lateral line.
  const lat = [];
  for (let i = 0; i <= 12; i++) {
    const s = 0.19 + (i / 12) * 0.76;
    const fr = frame(s);
    const [d] = profileAt(s);
    lat.push(loc(fr.p, fr, 0, d * L * 0.16));
  }
  const lateral = smooth(lat);
  // Spots on the back and the tail lobes.
  const spots = [];
  for (let i = 0; i < 8; i++) {
    const s = 0.27 + i * 0.085;
    const fr = frame(s);
    const [d] = profileAt(s);
    spots.push(loc(fr.p, fr, 0, d * L * (0.58 + 0.12 * Math.sin(i * 2.3))));
  }
  spots.push(loc(w.p, tf, 8.5, 5.6), loc(w.p, tf, 11.5, 8.6), loc(w.p, tf, 8.2, -5), loc(w.p, tf, 11.4, -7.8));
  const spotSvg = spots.map((q) => `<ellipse cx="${f2(q[0])}" cy="${f2(q[1])}" rx="0.95" ry="0.7" />`).join('');
  const ef = frame(0.07);
  const [ed] = profileAt(0.07);
  const eye = loc(ef.p, ef, 0, ed * L * 0.34);

  const wave = waves
    ? `<g class="salmon-waves" fill="none" stroke="${stroke}" stroke-width="${width * 0.8}" stroke-linecap="round">
        <path d="M2,72 C14,66 24,66 36,71 S58,77 70,71 S94,64 118,70" />
        <path class="w2" d="M14,79 C26,75 36,75 47,78.5 S68,83 80,78.5 S98,74 108,77" opacity="0.6" />
        <path class="w3" d="M30,85 C40,82.5 48,82.5 56,84.6 S72,87.4 82,84.6" opacity="0.35" />
      </g>
      <g class="salmon-drops" fill="${stroke}" stroke="none"><circle cx="15" cy="62" r="0.9"/><circle cx="10" cy="56" r="0.6"/><circle cx="21" cy="57" r="0.55"/><circle cx="27" cy="63" r="0.5"/><circle cx="8" cy="64" r="0.45"/></g>`
    : '';
  return `<svg class="${cls}" viewBox="0 0 120 92" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <g class="salmon-lines" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round">
      <path class="salmon-body" d="${body}" pathLength="100" />
      ${details.map((d) => `<path d="${d}" />`).join('')}
      <path d="${lateral}" stroke-dasharray="0.6 2.2" stroke-width="${width * 0.8}" />
    </g>
    <g class="salmon-spots" fill="${stroke}" fill-opacity="0.8">${spotSvg}</g>
    <g class="salmon-eye">
      <circle cx="${f2(eye[0])}" cy="${f2(eye[1])}" r="1.25" fill="none" stroke="${stroke}" stroke-width="${width * 0.8}" />
      <circle cx="${f2(eye[0] + 0.25)}" cy="${f2(eye[1] - 0.2)}" r="0.45" fill="${stroke}" />
    </g>
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
