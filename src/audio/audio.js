// WP-AUDIO (SPEC §6.16): everything procedural in WebAudio — no samples, no files. The sea, wind, rain and harbours,
// the seiner's diesel and gear, the skiff, wildlife, footsteps, VHF radio, feedback stingers and gentle generative
// folk music, positioned around the camera.
//
//   kit.js / dsp.js       shared noise and texture buffers, periodic waves, the reverb impulse, node helpers
//   mixer.js              buses, pause muffle, radio duck, reverb, glue compressor, limiter, soft clipper, meter
//   engine.js             one-shot player: positional PannerNodes, air absorption, travel delay, voice limit
//   beds.js               continuous layers (sea, wind, rain, settlements, engines, hydraulics, bag, streams)
//   sfx.js / instruments  one-shot recipes and musical voices;  composer.js / music.js: generative music
//   params.js / scene.js  pure mappings from game state to sound (unit-tested)
//   director.js           per-frame world reading and event handling;  qa.js: offline renders and spectrograms
//
// Public API: unlock(), play(name, {position, volume, rate, params}), setVolumes({master, music, sfx, ambience}),
// muted (get/set), plus ready, sounds, debugState(), qa. The AudioContext is created on the first user gesture
// (main.js calls unlock on pointerdown/keydown); under automation it starts at once and is measured but silent.

import { createKit, warmStep } from './kit.js';
import { createMixer } from './mixer.js';
import { createPlayer } from './engine.js';
import { createBeds } from './beds.js';
import { createMusic } from './music.js';
import { createDirector } from './director.js';
import { EVENTS } from './cues.js';
import { SOUNDS } from './sfx.js';
import { mergeVolumes, DEFAULT_VOLUMES } from './params.js';
import { createQa } from './qa.js';

const SETTINGS_KEY = 'kodiak-seiner:settings';

function savedVolumes() {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(SETTINGS_KEY) ?? '{}')?.volumes ?? null;
  } catch {
    return null;
  }
}

export async function create(ctx) {
  const win = typeof window !== 'undefined' ? window : null;
  const AC = win ? win.AudioContext ?? win.webkitAudioContext : null;
  const automation = typeof navigator !== 'undefined' && navigator.webdriver === true;
  const query = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
  // Headless QA runs are silent at the speakers unless ?audible is given; ?mute starts muted.
  const silentOutput = automation && !query.has('audible');

  let volumes = mergeVolumes(DEFAULT_VOLUMES, savedVolumes());
  let muted = query.has('mute');
  let A = null; // { ac, kit, mixer, player, beds, music, director, ready }
  let failure = null;
  let buildMs = 0;
  let detachDom = null;
  let lastPlayRefused = null;
  let frameError = null;

  function build() {
    const t0 = performance.now();
    const ac = new AC({ latencyHint: 'balanced' });
    const kit = createKit(ac);
    const mixer = createMixer(ac, kit, { silent: silentOutput });
    const player = createPlayer(ac, kit, mixer);
    const beds = createBeds(ac, kit, mixer);
    const music = createMusic(ac, kit, mixer.bus.music);
    const a = { ac, kit, mixer, player, beds, music, ready: true };
    a.director = createDirector(ctx, a);
    mixer.setVolumes(volumes);
    mixer.muted = muted;
    mixer.fadeIn(2.5);
    detachDom = a.director.attachDom();
    A = a;
    buildMs = performance.now() - t0;
  }

  // Subscribe now, before later systems (the UI), and forward to the director once it exists.
  const offs = EVENTS.map((name) => ctx.events.on(name, (p) => A?.director.event(name, p)));

  const onVisibility = () => {
    if (!A) return;
    if (document.hidden) A.ac.suspend?.().catch(() => {});
    else A.ac.resume?.().catch(() => {});
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);

  const toPos = (p) => {
    if (!p) return undefined;
    const x = Number(p.x);
    const z = Number(p.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return undefined;
    return { x, y: Number(p.y) || 0, z };
  };

  const qa = createQa(() => A, ctx);

  const sys = {
    // Creates/resumes the AudioContext; call from a user gesture. Cheap to call repeatedly.
    unlock() {
      if (!AC || failure) return false;
      if (!A) {
        // Chrome warns when a context is created without a user activation; wait for a real one (not Esc).
        const ua = typeof navigator !== 'undefined' ? navigator.userActivation : null;
        if (!automation && ua && !ua.isActive && !ua.hasBeenActive) return false;
        try {
          build();
        } catch (err) {
          failure = String(err?.message ?? err);
          return false;
        }
      }
      if (A.ac.state === 'suspended' && !(typeof document !== 'undefined' && document.hidden)) A.ac.resume().catch(() => {});
      return true;
    },

    // Plays a named one-shot (see sounds). opts: { position {x,y,z} (world; omitted = non-positional), volume, rate,
    // params (recipe arguments), delay } → voice id | null.
    play(name, opts = {}) {
      if (!A || !SOUNDS[name]) return null;
      if (name === 'ui-click' && A.director.clickedRecently()) return null;
      const id = A.player.play(name, {
        position: toPos(opts.position),
        volume: Number.isFinite(opts.volume) ? opts.volume : 1,
        rate: Number.isFinite(opts.rate) && opts.rate > 0 ? opts.rate : 1,
        params: opts.params,
        delay: Number.isFinite(opts.delay) ? opts.delay : 0,
      });
      if (id === null) lastPlayRefused = name;
      return id;
    },

    // Volumes 0..1 per channel (UI settings). Partial patches merge.
    setVolumes(v) {
      volumes = mergeVolumes(volumes, v);
      A?.mixer.setVolumes(volumes);
      return { ...volumes };
    },
    get volumes() {
      return { ...volumes };
    },
    get muted() {
      return muted;
    },
    set muted(m) {
      muted = !!m;
      if (A) A.mixer.muted = muted;
    },
    get ready() {
      return !!A && A.ac.state === 'running';
    },
    get sounds() {
      return Object.keys(SOUNDS);
    },
    get context() {
      return A?.ac ?? null;
    },
    qa,

    frame(realDt) {
      if (!A || A.ac.state !== 'running') return;
      try {
        A.director.frame(realDt);
        qa.tick();
      } catch (err) {
        // Sound must never take a frame down; report the first failure and keep going.
        if (!frameError) console.error('[audio] frame failed', err);
        frameError = String(err?.message ?? err);
      }
    },

    debugState() {
      if (!A) return { ready: false, state: AC ? 'locked' : 'unsupported', failure, muted, volumes };
      return {
        ready: A.ac.state === 'running',
        state: A.ac.state,
        sampleRate: A.ac.sampleRate,
        time: +A.ac.currentTime.toFixed(1),
        silentOutput,
        muted,
        volumes,
        buildMs: +buildMs.toFixed(1),
        voices: A.player.stats(),
        lastRefused: lastPlayRefused,
        frameError,
        beds: A.beds.active(),
        music: A.music.stats(),
        levels: A.mixer.levels(),
        scene: A.director.stats(),
      };
    },

    serialize() {
      return undefined;
    },
    restore() {},
    reset() {
      A?.director.reset();
      A?.player.stopAll();
    },
    dispose() {
      for (const off of offs) off?.();
      detachDom?.();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
      A?.beds.dispose();
      A?.ac.close?.().catch(() => {});
      A = null;
    },
  };

  if (automation && AC) sys.unlock();
  else if (AC) {
    // Build the shared noise/texture data in idle time on the title screen (most outputs run at 48 kHz), so the
    // first click or key press starts the sound without a hitch.
    const ric = win.requestIdleCallback?.bind(win) ?? ((f) => setTimeout(() => f({ timeRemaining: () => 6 }), 60));
    const step = (deadline) => {
      if (A) return;
      let done = false;
      do done = warmStep(48000);
      while (!done && deadline.timeRemaining() > 5);
      if (!done) ric(step, { timeout: 1500 });
    };
    ric(step, { timeout: 2500 });
  }
  return sys;
}
