// Required public members per system (the bold names in SPEC.md §6). main.js warns when a created system lacks any
// of them, and tests/contract.test.mjs checks that every stub satisfies this list. Getters count as members.
// `name` is reserved on every system object: core sets it to the registry name.

export const REQUIRED = {
  season: ['openerActive', 'nextOpener', 'speciesMix', 'priceFor', 'forecast', 'closedWaters', 'isClosedWater'],
  sky: [
    'sunDirection', 'moonDirection', 'sunLight', 'hemiLight', 'shadowFocus', 'daylight', 'sunElevationDeg', 'isNight',
    'envMap', 'weather', 'setWeather',
  ],
  water: ['mesh', 'heightAt', 'sample', 'stamp', 'addOccluder', 'removeOccluder'],
  terrain: ['heightAt', 'surfaceAt', 'forestDensity', 'sunVisibilityAt'],
  places: ['list', 'get', 'nearest', 'within', 'streams', 'districtAt', 'spawn'],
  fleet: ['tenders', 'nearestTender', 'boats'],
  seiner: [
    'object3d', 'position', 'heading', 'speed', 'velocity', 'throttle', 'rudder', 'maxSpeed', 'speedLimit',
    'controlsEnabled', 'grounded', 'engineLoad', 'mooring', 'anchored', 'deckLights', 'boatName', 'forward', 'sternPoint',
    'bowPoint', 'powerBlockPoint', 'skiffMountPoint', 'setPose', 'setSpeedLimit', 'lockControls', 'setMooring',
    'setBoatName', 'horn',
  ],
  skiff: [
    'object3d', 'position', 'heading', 'state', 'busy', 'release', 'holdAt', 'towToward', 'tieOff', 'closeTo', 'towOff',
    'setTowHeading', 'returnTo', 'stow', 'ferry', 'endPoint',
  ],
  net: [
    'state', 'length', 'depth', 'payout', 'pursed', 'hauled', 'bottomContact', 'corkline', 'polygon', 'gap',
    'containsPoint', 'begin', 'close', 'purse', 'haul', 'stow',
  ],
  fish: ['schools', 'nearestSchool', 'schoolsWithin', 'schoolsInside', 'harvest', 'sonarReturns', 'spawnSchool'],
  fishing: ['state', 'setNumber', 'lastSet', 'canSet', 'abort', 'hud'],
  wildlife: ['bears', 'whales', 'birds', 'nearestBear'],
  player: ['active', 'object3d', 'position', 'canGoAshore', 'goAshore', 'returnToBoat'],
  economy: [
    'cash', 'hold', 'holdLbs', 'capacityLbs', 'fuel', 'fuelCapacity', 'upgrades', 'modifiers', 'catalog', 'stats',
    'addCatch', 'deliver', 'refuel', 'buy', 'addCash', 'useFuel', 'fuelEmpty',
  ],
  discovery: ['discovered', 'sightings', 'isDiscovered', 'discover', 'progress'],
  cameraRig: ['mode', 'setMode', 'cycle', 'suggest', 'setTarget', 'focus', 'shake', 'binoculars'],
  audio: ['unlock', 'play', 'setVolumes', 'muted'],
  ui: ['visible', 'toast', 'radio', 'hint', 'openMap', 'openLogbook'],
  postfx: ['enabled', 'setEnabled'],
};

export function missingMembers(name, sys) {
  return (REQUIRED[name] ?? []).filter((k) => !(k in sys));
}
