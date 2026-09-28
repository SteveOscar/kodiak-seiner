// Title cinematic: a loop of golden-hour (and one dawn) shots of real places around Kodiak. Positions are world
// metres (see src/core/geo.js); heights are above whichever is higher of sea and terrain at that point, so the camera
// never clips a ridge; look targets are absolute world heights. 'seiner' shots place the player's boat on an
// autopilot run and frame it relative to its heading (az: degrees from the bow, clockwise).
//
// Shot: { id, label, hours, duration, fov,
//         kind: 'seiner', seiner: { x, z, headingDeg, throttle }, from/to: { az, dist, h }, lookH
//       | kind: 'path', from/to: { x, z, h }, lookFrom/lookTo: { x, z, y } }

export const TITLE_SHOTS = [
  {
    id: 'kodiak-departure',
    label: 'Leaving St. Paul Harbor',
    kind: 'seiner',
    hours: 22.0,
    duration: 13,
    fov: 50,
    seiner: { x: 5150, z: -1060, headingDeg: 120, throttle: 0.45 },
    from: { az: -72, dist: 34, h: 3.2 },
    to: { az: -24, dist: 25, h: 2.5 },
    lookH: 4.2,
  },
  {
    id: 'uyak-bay',
    label: 'Uyak Bay',
    kind: 'path',
    hours: 21.2,
    duration: 12,
    fov: 50,
    from: { x: -2650, z: -300, h: 120 },
    to: { x: -2700, z: 150, h: 85 },
    lookFrom: { x: -2720, z: 850, y: 0 },
    lookTo: { x: -2740, z: 1100, y: 0 },
  },
  {
    id: 'shelikof-sunset',
    label: 'Shelikof Strait off Cape Ugat',
    kind: 'seiner',
    hours: 22.1,
    duration: 14,
    fov: 50,
    seiner: { x: -2844, z: -2844, headingDeg: 319, throttle: 0.4 },
    from: { az: 196, dist: 42, h: 5.5 },
    to: { az: 168, dist: 30, h: 4.0 },
    lookH: 5,
  },
  {
    id: 'koniag-dawn',
    label: 'Dawn over the Koniag range',
    kind: 'path',
    hours: 5.7,
    duration: 13,
    fov: 55,
    from: { x: -2300, z: 600, h: 190 },
    to: { x: -2100, z: 800, h: 178 },
    lookFrom: { x: 0, z: 2300, y: 320 },
    lookTo: { x: 100, z: 2400, y: 300 },
  },
  {
    id: 'ugak-evening',
    label: 'Evening on Ugak Bay',
    kind: 'path',
    hours: 21.6,
    duration: 12,
    fov: 50,
    from: { x: 4330, z: 2230, h: 24 },
    to: { x: 4250, z: 2170, h: 17 },
    lookFrom: { x: 1400, z: 900, y: 255 },
    lookTo: { x: 1500, z: 950, y: 240 },
  },
  {
    // From Sitkalidak Strait into the sun over Three Saints Bay, where Shelikhov's 1784 post stood; the Old Harbor
    // fleet usually has a boat working the strait below.
    id: 'three-saints',
    label: 'Three Saints Bay',
    kind: 'path',
    hours: 21.5,
    duration: 13,
    fov: 50,
    from: { x: -60, z: 5930, h: 34 },
    to: { x: -150, z: 5870, h: 26 },
    lookFrom: { x: -690, z: 4700, y: 62 },
    lookTo: { x: -730, z: 4730, y: 55 },
  },
  {
    id: 'chiniak-dusk',
    label: 'Chiniak Bay at dusk',
    kind: 'path',
    hours: 22.6,
    duration: 13,
    fov: 50,
    from: { x: 5950, z: -380, h: 40 },
    to: { x: 5800, z: -560, h: 30 },
    lookFrom: { x: 5200, z: -1150, y: 20 },
    lookTo: { x: 5100, z: -1250, y: 25 },
  },
];

// Cut list with eased motion inside each shot. Returns { shot, index, t (0..1), local seconds }.
export function shotAt(shots, seconds) {
  const total = shots.reduce((a, s) => a + s.duration, 0);
  let t = ((seconds % total) + total) % total;
  for (let i = 0; i < shots.length; i++) {
    const s = shots[i];
    if (t < s.duration) return { shot: s, index: i, t: t / s.duration, local: t };
    t -= s.duration;
  }
  return { shot: shots[0], index: 0, t: 0, local: 0 };
}
