// Ambient fleet: tenders on the grounds, the eight fleet-board seiners, the Kodiak ferry route and the Coast Guard
// cutter. Positions resolve at runtime from src/data/places.js ids (hint lat/lon as a fallback) to the nearest open
// water deep enough for the vessel. Pure data.

// Tenders: 70-120 ft packers anchored on the grounds; they buy fish and sell fuel. `channel` is their VHF working
// channel for radio chatter.
export const TENDERS = [
  { id: 'sea-venture', name: 'Sea Venture', placeId: 'chiniak-bay', hint: [57.7131, -152.3557], channel: '9', hull: '#8e2b22', trim: '#f1efe8', length: 30, company: '#1c3a6b' },
  { id: 'pacific-star', name: 'Pacific Star', placeId: 'larsen-bay-cannery', hint: [57.5665, -153.94], channel: '68', hull: '#1c3354', trim: '#f1efe8', length: 33, company: '#b12a25' },
  { id: 'island-mist', name: 'Island Mist', placeId: 'old-harbor', hint: [57.036, -153.38], channel: '69', hull: '#264a33', trim: '#f1efe8', length: 26, company: '#e0b030' },
  { id: 'westward-wind', name: 'Westward Wind', placeId: 'uganik-cannery', hint: [57.892, -153.575], channel: '72', hull: '#17191c', trim: '#e9e6dc', length: 30, company: '#1f5fa8' },
  { id: 'norseman', name: 'Norseman', placeId: 'port-lions', hint: [57.9145, -152.72], channel: '8', hull: '#2e5680', trim: '#f1efe8', length: 24, company: '#c23a2a' },
  { id: 'alitak-provider', name: 'Alitak Provider', placeId: 'alitak-cannery', hint: [56.8797, -154.1458], channel: '71', hull: '#6e1f1b', trim: '#ebe8df', length: 28, company: '#2a6e3c' },
];

// Fishing grounds: spots are found at runtime near these anchors (0.4-1.8 km, 60-320 m off the beach).
export const GROUNDS = {
  chiniak: { anchors: ['chiniak-bay', 'woody-island'], hints: [[57.70, -152.30]], tender: 'sea-venture' },
  kiliuda: { anchors: ['kiliuda-bay'], hints: [[57.3082, -152.9497]], tender: 'island-mist' },
  sitkalidak: { anchors: ['old-harbor', 'sitkalidak-strait'], hints: [[57.036, -153.38]], tender: 'island-mist' },
  uyak: { anchors: ['uyak-bay', 'larsen-bay-cannery'], hints: [[57.60, -153.95]], tender: 'pacific-star' },
  uganik: { anchors: ['uganik-bay', 'uganik-cannery'], hints: [[57.875, -153.55]], tender: 'westward-wind' },
  kizhuyak: { anchors: ['kizhuyak-bay', 'port-lions'], hints: [[57.896, -152.721]], tender: 'norseman' },
  alitak: { anchors: ['alitak-bay', 'alitak-cannery'], hints: [[56.891, -154.112]], tender: 'alitak-provider' },
};

// The fleet-board seiners (names match src/game/data/fleetBoard.js so the board and the water agree).
export const FLEET_SEINERS = [
  { name: 'Karluk Queen', ground: 'uyak', hull: '#eceae3', stripe: '#1e5a3b', house: '#eceae3', skiff: '#1e5a3b' },
  { name: 'Kayla Rose', ground: 'chiniak', hull: '#1b2d49', stripe: '#eceae3', house: '#eceae3', skiff: '#b3342a' },
  { name: 'Arctic Tern', ground: 'chiniak', hull: '#eceae3', stripe: '#1f6b73', house: '#eceae3', skiff: '#1f6b73' },
  { name: 'Nordic Star', ground: 'uganik', hull: '#6b1f1f', stripe: '#eceae3', house: '#eceae3', skiff: '#6b1f1f' },
  { name: 'Miss Tammy', ground: 'sitkalidak', hull: '#eceae3', stripe: '#b3342a', house: '#eceae3', skiff: '#b3342a' },
  { name: 'Silver Spray', ground: 'kizhuyak', hull: '#8d969c', stripe: '#1c3152', house: '#eceae3', skiff: '#1c3152' },
  { name: 'Sitkalidak', ground: 'kiliuda', hull: '#2b4a2f', stripe: '#e3b22a', house: '#eceae3', skiff: '#2b4a2f' },
  { name: 'Double Eagle', ground: 'uyak', hull: '#16181b', stripe: '#c9a24a', house: '#eceae3', skiff: '#16181b' },
];

// M/V Tustumena ("the Rusty Tusty") of the Alaska Marine Highway: Kodiak - Ouzinkie - Port Lions.
export const FERRY = {
  id: 'tustumena',
  name: 'Tustumena',
  stops: [
    { placeId: 'kodiak', hint: [57.7594, -152.3796], dwell: 70 },
    { placeId: 'ouzinkie', hint: [57.9445, -152.5382], dwell: 45 },
    { placeId: 'port-lions', hint: [57.9145, -152.7216], dwell: 50 },
  ],
  speed: 8.5,
};

// USCGC Alex Haley (WMEC-39), homeported at Base Kodiak: slow patrol legs off Womens Bay.
export const CUTTER = {
  id: 'alex-haley',
  name: 'Alex Haley',
  patrol: [
    { placeId: 'uscg-base', hint: [57.7335, -152.4259], dwell: 90 },
    { placeId: 'st-paul-harbor-light', hint: [57.727, -152.44], dwell: 40 },
  ],
  speed: 3.5,
};

// Setnet and cannery skiffs pottering along beaches.
export const SKIFF_SITES = [
  { anchor: 'larsen-bay', hint: [57.548, -153.958] },
  { anchor: 'uganik-bay', hint: [57.875, -153.55] },
  { anchor: 'old-harbor', hint: [57.04, -153.35] },
];
