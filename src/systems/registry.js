// System registry. Order here is creation order AND per-frame update order. Each module exports
// `async function create(ctx)` returning the system object (see SPEC.md §System contract). A module that fails to
// load or throws in create() is replaced by its stub from ./stubs.js so the rest of the game still runs; the failure
// is reported in window.__KODIAK__.systemStatus and on the console.

export const SYSTEMS = [
  { name: 'season', load: () => import('../game/season.js') },
  { name: 'sky', load: () => import('../world/sky.js') },
  { name: 'water', load: () => import('../world/water.js') },
  { name: 'terrain', load: () => import('../world/terrain.js') },
  { name: 'places', load: () => import('../world/places.js') },
  { name: 'fleet', load: () => import('../entities/fleet.js') },
  { name: 'seiner', load: () => import('../entities/seiner.js') },
  { name: 'skiff', load: () => import('../entities/skiff.js') },
  { name: 'net', load: () => import('../entities/net.js') },
  { name: 'fish', load: () => import('../entities/fish.js') },
  { name: 'fishing', load: () => import('../game/fishing.js') },
  { name: 'wildlife', load: () => import('../entities/wildlife.js') },
  { name: 'player', load: () => import('../entities/player.js') },
  { name: 'economy', load: () => import('../game/economy.js') },
  { name: 'discovery', load: () => import('../game/discovery.js') },
  { name: 'cameraRig', load: () => import('../render/cameraRig.js') },
  { name: 'audio', load: () => import('../audio/audio.js') },
  { name: 'ui', load: () => import('../ui/ui.js') },
  { name: 'postfx', load: () => import('../render/postfx.js') },
];
