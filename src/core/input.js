// Keyboard, mouse and gamepad state, polled once per frame.
//
//   input.action('throttleUp')        held this frame
//   input.pressed('action')           went down this frame (edge)
//   input.released('action')          went up this frame
//   input.axis('steer')               -1..1 (keys or gamepad left stick x)
//   input.axis('throttle')            -1..1 (keys or gamepad left stick y / triggers)
//   input.mouse.dx / dy               pixels dragged this frame while a button is held (or pointer-locked)
//   input.mouse.buttons               bitmask (1 = left drag/orbit, 2 = right = binoculars)
//   input.mouse.wheel                 wheel delta this frame (positive = zoom out)
//   input.keyPressed('KeyF')          raw key edge, for debug keys
//
// Gameplay reads are suppressed while input.gameplayBlocked is true (menus, map, typing). UI code reads raw keys.

const BINDINGS = {
  throttleUp: ['KeyW', 'ArrowUp'],
  throttleDown: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  action: ['Space'], // release skiff / close up / jump on foot
  interact: ['KeyE', 'Enter'], // purse, deliver, dock, go ashore, board
  camera: ['KeyC'], // cycle camera mode
  map: ['KeyM'],
  logbook: ['KeyL', 'KeyJ'],
  pause: ['Escape', 'KeyP'],
  photo: ['KeyH'], // hide HUD
  sprint: ['ShiftLeft', 'ShiftRight'],
  horn: ['KeyG'],
  binoculars: ['KeyB'], // also: hold right mouse
  lights: ['KeyN'],
  help: ['F1', 'Slash'],
};

// Gamepad (standard mapping) button indices per action.
const PAD = { action: [0], interact: [2], camera: [3], map: [8], pause: [9], sprint: [10], horn: [1], binoculars: [4] };

export function createInput(target = window) {
  const down = new Set();
  const suppressed = new Set(); // held across a mode change; ignored until released
  const pressedKeys = new Set();
  const releasedKeys = new Set();
  const padDown = new Set();
  const padPrev = new Set();
  const mouse = { x: 0, y: 0, dx: 0, dy: 0, wheel: 0, buttons: 0, locked: false, clicked: false };
  let accDx = 0;
  let accDy = 0;
  let accWheel = 0;
  let clickedAcc = false;
  const pad = { lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0 };

  const onKeyDown = (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if (!down.has(e.code)) pressedKeys.add(e.code);
    down.add(e.code);
    if (e.code === 'Space' || e.code.startsWith('Arrow') || e.code === 'Tab' || e.code === 'F1') e.preventDefault();
  };
  const onKeyUp = (e) => {
    down.delete(e.code);
    suppressed.delete(e.code);
    releasedKeys.add(e.code);
  };
  const onBlur = () => {
    for (const c of down) releasedKeys.add(c);
    down.clear();
    suppressed.clear();
  };
  const onMouseDown = (e) => {
    if (e.target && e.target.id !== 'gl') return;
    mouse.buttons = e.buttons;
    clickedAcc = true;
  };
  const onMouseUp = (e) => {
    mouse.buttons = e.buttons;
  };
  const onMouseMove = (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    if (mouse.buttons || document.pointerLockElement) {
      accDx += e.movementX;
      accDy += e.movementY;
    }
  };
  const onWheel = (e) => {
    if (e.target && e.target.id !== 'gl') return;
    accWheel += Math.sign(e.deltaY) * Math.min(3, Math.abs(e.deltaY) / 50);
  };
  const onContext = (e) => {
    if (e.target && e.target.id === 'gl') e.preventDefault();
  };

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);
  target.addEventListener('blur', onBlur);
  target.addEventListener('mousedown', onMouseDown);
  target.addEventListener('mouseup', onMouseUp);
  target.addEventListener('mousemove', onMouseMove);
  target.addEventListener('wheel', onWheel, { passive: true });
  target.addEventListener('contextmenu', onContext);

  const dz = (v) => (Math.abs(v) < 0.15 ? 0 : v);
  const live = (c) => down.has(c) && !suppressed.has(c);
  const edge = (c) => pressedKeys.has(c) && !suppressed.has(c);

  const input = {
    mouse,
    pad,
    gameplayBlocked: false,

    // Called by the main loop at the start of each frame.
    frame() {
      mouse.dx = accDx;
      mouse.dy = accDy;
      mouse.wheel = accWheel;
      mouse.clicked = clickedAcc;
      mouse.locked = !!document.pointerLockElement;
      accDx = 0;
      accDy = 0;
      accWheel = 0;
      clickedAcc = false;

      padPrev.clear();
      for (const b of padDown) padPrev.add(b);
      padDown.clear();
      const gp = navigator.getGamepads ? [...navigator.getGamepads()].find((g) => g && g.connected) : null;
      if (gp) {
        gp.buttons.forEach((b, i) => b.pressed && padDown.add(i));
        pad.lx = dz(gp.axes[0] ?? 0);
        pad.ly = dz(gp.axes[1] ?? 0);
        pad.rx = dz(gp.axes[2] ?? 0);
        pad.ry = dz(gp.axes[3] ?? 0);
        pad.lt = gp.buttons[6]?.value ?? 0;
        pad.rt = gp.buttons[7]?.value ?? 0;
      } else {
        pad.lx = pad.ly = pad.rx = pad.ry = pad.lt = pad.rt = 0;
      }
    },

    // Called by the main loop at the end of each frame.
    endFrame() {
      pressedKeys.clear();
      releasedKeys.clear();
    },

    keyDown: (code) => live(code),
    keyPressed: (code) => edge(code),
    keyReleased: (code) => releasedKeys.has(code),

    action(name) {
      if (input.gameplayBlocked && name !== 'pause') return false;
      if (name === 'binoculars' && mouse.buttons & 2) return true;
      return (BINDINGS[name] ?? []).some(live) || (PAD[name] ?? []).some((b) => padDown.has(b));
    },
    pressed(name) {
      if (input.gameplayBlocked && name !== 'pause' && name !== 'map' && name !== 'logbook') return false;
      return (
        (BINDINGS[name] ?? []).some(edge) ||
        (PAD[name] ?? []).some((b) => padDown.has(b) && !padPrev.has(b))
      );
    },
    released(name) {
      return (
        (BINDINGS[name] ?? []).some((c) => releasedKeys.has(c)) ||
        (PAD[name] ?? []).some((b) => !padDown.has(b) && padPrev.has(b))
      );
    },
    axis(name) {
      if (input.gameplayBlocked) return 0;
      const k = (a, b) => (input.action(a) ? 1 : 0) - (input.action(b) ? 1 : 0);
      if (name === 'steer') return Math.max(-1, Math.min(1, k('right', 'left') + pad.lx));
      if (name === 'throttle') return Math.max(-1, Math.min(1, k('throttleUp', 'throttleDown') - pad.ly + pad.rt - pad.lt));
      if (name === 'lookX') return pad.rx;
      if (name === 'lookY') return pad.ry;
      return 0;
    },
    bindings: BINDINGS,

    // Called by core on every mode change: this frame's edges are dropped and keys currently held stay inert until
    // released, so a key that opened/closed a menu never also triggers gameplay.
    consume() {
      pressedKeys.clear();
      for (const c of down) suppressed.add(c);
      for (const b of padDown) padPrev.add(b);
    },

    dispose() {
      target.removeEventListener('keydown', onKeyDown);
      target.removeEventListener('keyup', onKeyUp);
      target.removeEventListener('blur', onBlur);
      target.removeEventListener('mousedown', onMouseDown);
      target.removeEventListener('mouseup', onMouseUp);
      target.removeEventListener('mousemove', onMouseMove);
      target.removeEventListener('wheel', onWheel);
      target.removeEventListener('contextmenu', onContext);
    },
  };
  return input;
}
