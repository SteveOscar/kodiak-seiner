// WP-SKY postfx (SPEC §6.2): HDR MSAA scene target with a float depth texture → subtle half-res bloom → OutputPass
// with the grade folded in (bloom add, white balance, night shift, saturation, contrast, vignette, then ACES tone
// mapping + sRGB and a 1/255 dither against sky banding). Exposure adapts to daylight and is written to
// renderer.toneMappingExposure every frame, also when postfx is disabled (canvas path).
//
// API: enabled, setEnabled(bool), exposure, sceneTarget, depthTexture, bloomStrength, setBloomStrength(v).

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { BloomPass } from './postfx/bloom.js';
import { createGradedOutputPass } from './postfx/grade.js';
import { EXPOSURE, targetExposure, adaptExposure, sceneKeyFromDaylight, meterCorrection } from './postfx/exposure.js';
import { MeterPass } from './postfx/meter.js';

export async function create(ctx) {
  const { renderer, scene, camera, pipeline, quality, events } = ctx;
  const canvasRender = pipeline.render;
  let chain = null;
  let enabled = false;
  let exposure = 1;
  let snapExposure = true;
  let bloomStrength = 0.055;
  let correction = 1;
  const size = new THREE.Vector2();

  function deviceSize() {
    renderer.getDrawingBufferSize(size);
    return [Math.max(1, size.x), Math.max(1, size.y)];
  }

  function build() {
    const [w, h] = deviceSize();
    const sceneTarget = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      samples: 4,
      depthTexture: new THREE.DepthTexture(w, h, THREE.FloatType),
    });
    sceneTarget.texture.name = 'postfx.scene';
    const composer = new EffectComposer(renderer, sceneTarget);
    // The scene target is already in device pixels.
    composer.setPixelRatio(1);
    // Every pass reads the scene target and the output pass draws to the canvas, so the composer's second buffer is
    // never drawn in a frame: a plain target instead of an MSAA clone (QA timings use it as a scratch buffer).
    composer.renderTarget2.dispose();
    composer.renderTarget2 = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false });
    composer.renderTarget2.texture.name = 'postfx.scratch';
    const renderPass = new RenderPass(scene, camera);
    const meter = new MeterPass(renderer);
    const bloom = new BloomPass({ levels: 4, threshold: 1.15, knee: 0.55 });
    const output = createGradedOutputPass(bloom);
    composer.addPass(renderPass);
    composer.addPass(meter);
    composer.addPass(bloom);
    composer.addPass(output);
    chain = { composer, sceneTarget, renderPass, meter, bloom, output };
  }

  function render(dt) {
    const c = chain.composer;
    c.readBuffer = chain.sceneTarget;
    c.writeBuffer = c.renderTarget2;
    c.render(dt);
  }

  function setEnabled(on) {
    const want = !!on;
    if (want && !chain) {
      try {
        build();
      } catch (err) {
        console.error('[postfx] could not build the effect chain; using the canvas path', err);
        chain = null;
      }
    }
    enabled = want && !!chain;
    pipeline.render = enabled ? render : canvasRender;
    return enabled;
  }

  pipeline.onResize(() => {
    if (!chain) return;
    const [w, h] = deviceSize();
    chain.composer.setSize(w, h);
  });

  events.on('time:skip', () => {
    snapExposure = true;
  });

  const sys = {
    get enabled() {
      return enabled;
    },
    setEnabled,
    get exposure() {
      return exposure;
    },
    get sceneTarget() {
      return chain?.sceneTarget ?? null;
    },
    get depthTexture() {
      return chain?.sceneTarget?.depthTexture ?? null;
    },
    get bloomStrength() {
      return bloomStrength;
    },
    setBloomStrength(v) {
      bloomStrength = Math.max(0, Number(v) || 0);
    },

    // Exposure every frame, in every mode, whether or not the chain is enabled.
    frame(realDt) {
      const sky = ctx.systems.sky;
      const key = Number.isFinite(sky?.sceneKey) ? sky.sceneKey : sceneKeyFromDaylight(sky?.daylight ?? 1);
      const base = targetExposure(key);
      const meterLog = enabled && chain ? chain.meter.log2Lum : null;
      if (enabled && chain) chain.meter.tick(realDt);
      correction = meterCorrection(meterLog, base);
      const target = Math.min(EXPOSURE.max, Math.max(EXPOSURE.min * 0.75, base * correction));
      const jump = Math.abs(Math.log(target / exposure)) > 0.9;
      exposure = snapExposure || jump ? target : adaptExposure(exposure, target, realDt);
      snapExposure = false;
      renderer.toneMappingExposure = exposure;
      if (enabled && chain) {
        chain.bloom.exposure = exposure;
        const g = chain.output.uniforms;
        g.uExposure.value = exposure;
        g.uBloom.value = bloomStrength * (1 + 0.6 * (1 - (sky?.daylight ?? 1)));
        const night = 1 - Math.min(1, Math.max(0, ((sky?.daylight ?? 1) - 0.05) / 0.35));
        g.uNight.value = night;
        const dl = sky?.daylight ?? 1;
        const gold = Number.isFinite(sky?.golden) ? sky.golden : 0;
        // Cool at night, neutral by day, warm through the golden hour.
        g.uBalance.value.set(0.985 + 0.02 * dl + 0.12 * gold, 1.0 + 0.015 * gold, 1.03 - 0.035 * dl - 0.17 * gold);
        g.uSaturation.value = 1.07 - 0.12 * night;
        g.uContrast.value = 1.06;
      }
    },

    // QA helper: GPU time per pass (min of n interleaved samples; EXT_disjoint_timer_query_webgl2).
    async debugTimings(n = 30, skipScene = false) {
      if (!chain) return { enabled: false };
      const gl = renderer.getContext();
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      if (!ext) return { error: 'no timer query' };
      const c = chain.composer;
      const read = chain.sceneTarget;
      const write = c.renderTarget2;
      const jobs = {
        ...(skipScene ? {} : { scene: () => chain.renderPass.render(renderer, write, read) }),
        bloom: () => chain.bloom.render(renderer, write, read),
        output: () => {
          chain.output.renderToScreen = false;
          chain.output.render(renderer, write, read);
          chain.output.renderToScreen = true;
        },
      };
      const qs = Object.fromEntries(Object.keys(jobs).map((k) => [k, []]));
      for (let i = 0; i < n; i++) {
        for (const [k, fn] of Object.entries(jobs)) {
          const q = gl.createQuery();
          gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
          fn();
          gl.endQuery(ext.TIME_ELAPSED_EXT);
          qs[k].push(q);
        }
      }
      for (let tries = 0; tries < 200; tries++) {
        await new Promise((r) => setTimeout(r, 30));
        if (Object.values(qs).flat().every((q) => gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE))) break;
      }
      const out = {};
      for (const [k, list] of Object.entries(qs)) {
        const ms = list.map((q) => gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6).sort((a, b) => a - b);
        out[k] = +ms[0].toFixed(3);
        for (const q of list) gl.deleteQuery(q);
      }
      return out;
    },

    debugState() {
      return {
        enabled,
        exposure: +exposure.toFixed(3),
        meter: chain?.meter?.log2Lum == null ? null : +chain.meter.log2Lum.toFixed(2),
        correction: +correction.toFixed(3),
      };
    },
  };

  setEnabled(!!quality.postfx);
  sys.frame(0);
  return sys;
}

export { EXPOSURE };
