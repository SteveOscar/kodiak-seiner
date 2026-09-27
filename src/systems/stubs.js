// Minimal stand-ins for every system, implementing the public API from SPEC.md with trivial behaviour. They let a
// system be developed and screenshotted while its neighbours are unfinished or broken, and they are the reference
// for the API shape. Real modules must be supersets of these objects.

import * as THREE from 'three';

const headingForward = (h, out = new THREE.Vector3()) => out.set(Math.sin(h), 0, -Math.cos(h));

export const STUBS = {
  season(ctx) {
    return {
      openerActive: () => ctx.clock.isOpener(),
      forecast: () => ({ today: 'clear', tomorrow: 'clear' }),
      speciesMix: () => ({ pink: 0.7, chum: 0.15, sockeye: 0.1, coho: 0.04, king: 0.01 }),
      priceFor: (species) => ctx.config.fish.species[species]?.price ?? 0,
      closedWaters: [],
      isClosedWater: () => false,
    };
  },

  sky(ctx) {
    const { scene, uniforms, clock, camera } = ctx;
    const sun = new THREE.DirectionalLight(0xfff1dd, 2.4);
    sun.castShadow = !!ctx.quality.shadows;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = sc.bottom = -120;
    sc.right = sc.top = 120;
    sc.near = 1;
    sc.far = 3000;
    scene.add(sun, sun.target);
    const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x3d4a33, 0.9);
    scene.add(hemi);
    scene.background = new THREE.Color(0x9fc3e6);
    scene.fog = new THREE.FogExp2(0xa9c4dc, 0.00012);
    const sys = {
      sunDirection: uniforms.uSunDir.value,
      sunLight: sun,
      hemiLight: hemi,
      daylight: 1,
      envMap: null,
      weather: { preset: 'clear', cloudCover: 0.3, fog: 0, rain: 0, windDir: 0.8, windSpeed: 6, swell: 0.4 },
      setWeather(preset) {
        sys.weather.preset = preset;
        ctx.events.emit('weather:change', { preset });
      },
      update() {
        const a = ((clock.hours - 6) / 12) * Math.PI;
        const elev = Math.max(0.05, Math.sin(a)) * 0.9;
        uniforms.uSunDir.value.set(Math.cos(a) * 0.6, elev, -0.5).normalize();
        sys.daylight = THREE.MathUtils.clamp(Math.sin(a) * 2, 0.05, 1);
        sun.intensity = 2.4 * sys.daylight;
        hemi.intensity = 0.25 + 0.65 * sys.daylight;
        sun.position.copy(camera.position).addScaledVector(uniforms.uSunDir.value, 1500);
        sun.target.position.copy(camera.position);
        uniforms.uDaylight.value = sys.daylight;
        const w = sys.weather;
        uniforms.uWindDir.value.set(Math.sin(w.windDir), -Math.cos(w.windDir));
        uniforms.uWindSpeed.value = w.windSpeed;
      },
    };
    return sys;
  },

  water(ctx) {
    const geo = new THREE.PlaneGeometry(60000, 60000, 1, 1).rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x1d4e6b, roughness: 0.25 }));
    mesh.receiveShadow = true;
    mesh.name = 'water-stub';
    ctx.scene.add(mesh);
    const up = new THREE.Vector3(0, 1, 0);
    return {
      mesh,
      heightAt: () => 0,
      sample: (x, z, out = { height: 0, normal: new THREE.Vector3() }) => {
        out.height = 0;
        out.normal.copy(up);
        return out;
      },
      stamp() {},
      update() {
        mesh.position.set(ctx.camera.position.x, 0, ctx.camera.position.z);
      },
    };
  },

  terrain(ctx) {
    const { heightmap, config, scene } = ctx;
    const N = 384;
    const half = config.world.half;
    const geo = new THREE.PlaneGeometry(2 * half, 2 * half, N, N).rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const h = heightmap.heightAt(pos.getX(i), pos.getZ(i));
      pos.setY(i, h);
      if (h < -0.5) c.setRGB(0.55, 0.5, 0.38);
      else if (h < 3) c.setRGB(0.62, 0.58, 0.46);
      else if (h < 120) c.setRGB(0.2, 0.36, 0.14);
      else if (h < 220) c.setRGB(0.33, 0.33, 0.3);
      else c.setRGB(0.92, 0.94, 0.96);
      colors.set([c.r, c.g, c.b], i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
    mesh.receiveShadow = true;
    mesh.name = 'terrain-stub';
    scene.add(mesh);
    return { mesh, heightAt: heightmap.heightAt };
  },

  places(ctx) {
    return {
      list: [],
      get: () => null,
      nearest: () => null,
      within: () => [],
    };
  },

  fleet(ctx) {
    return {
      tenders: [],
      nearestTender: () => null,
      boats: [],
    };
  },

  seiner(ctx) {
    const { scene, input, heightmap, config } = ctx;
    const group = new THREE.Group();
    const hull = new THREE.Mesh(new THREE.BoxGeometry(5.5, 3, 17.7), new THREE.MeshStandardMaterial({ color: 0xe8e4da }));
    hull.position.y = 0.8;
    hull.castShadow = true;
    const house = new THREE.Mesh(new THREE.BoxGeometry(4.5, 3, 5), new THREE.MeshStandardMaterial({ color: 0x2b5d8a }));
    house.position.set(0, 3.5, -3);
    group.add(hull, house);
    group.name = 'seiner-stub';
    scene.add(group);
    const fwd = new THREE.Vector3();
    const sys = {
      object3d: group,
      position: group.position,
      heading: 0,
      speed: 0,
      throttle: 0,
      rudder: 0,
      maxSpeed: config.boat.maxSpeed,
      controlsEnabled: true,
      grounded: false,
      forward: (out = new THREE.Vector3()) => headingForward(sys.heading, out),
      sternPoint: (out = new THREE.Vector3()) => out.copy(group.position).addScaledVector(headingForward(sys.heading, fwd), -9),
      bowPoint: (out = new THREE.Vector3()) => out.copy(group.position).addScaledVector(headingForward(sys.heading, fwd), 9),
      setPose(x, z, heading = sys.heading) {
        group.position.set(x, 0, z);
        sys.heading = heading;
        sys.speed = 0;
      },
      update(dt) {
        const driving = ctx.state.mode === 'play' && ctx.state.control === 'boat' && sys.controlsEnabled;
        const thr = driving ? input.axis('throttle') : 0;
        const steer = driving ? input.axis('steer') : 0;
        sys.throttle = thr;
        sys.rudder = steer;
        const target = thr >= 0 ? thr * sys.maxSpeed : thr * config.boat.reverseSpeed;
        sys.speed += (target - sys.speed) * Math.min(1, dt * 0.6);
        sys.heading += steer * config.boat.turnRate * Math.min(1, Math.abs(sys.speed) / 4) * dt * Math.sign(sys.speed || 1);
        headingForward(sys.heading, fwd);
        const nx = group.position.x + fwd.x * sys.speed * dt;
        const nz = group.position.z + fwd.z * sys.speed * dt;
        if (heightmap.heightAt(nx + fwd.x * 9, nz + fwd.z * 9) < -1) {
          group.position.x = nx;
          group.position.z = nz;
          sys.grounded = false;
        } else {
          sys.speed = 0;
          sys.grounded = true;
        }
        group.position.y = ctx.systems.water?.heightAt(group.position.x, group.position.z) ?? 0;
        group.rotation.set(0, -sys.heading, 0);
      },
    };
    return sys;
  },

  skiff(ctx) {
    return {
      object3d: null,
      state: 'stowed', // 'stowed' | 'released' | 'holding' | 'towing' | 'returning' | 'ferry'
      position: new THREE.Vector3(),
      release() {},
      holdAt() {},
      towToward() {},
      returnTo() {},
      stow() {},
    };
  },

  net(ctx) {
    return {
      state: 'stowed', // 'stowed' | 'paying' | 'out' | 'closed' | 'pursing' | 'hauling'
      payout: 0,
      length: ctx.config.net.length,
      pursed: 0,
      corkline: [],
      polygon: () => null,
      gap: () => null,
      containsPoint: () => false,
      begin() {},
      close() {},
      stow() {},
    };
  },

  fish(ctx) {
    return {
      schools: [],
      nearestSchool: () => null,
      schoolsWithin: () => [],
      schoolsInside: () => [],
      harvest: () => ({ pink: 0, chum: 0, sockeye: 0, coho: 0, king: 0 }),
      spawnSchool: () => null,
    };
  },

  fishing(ctx) {
    return { state: 'idle', setNumber: 0, lastSet: null, canAct: () => null };
  },

  wildlife(ctx) {
    return { bears: [], whales: [], birds: [] };
  },

  player(ctx) {
    return { active: false, object3d: null, position: new THREE.Vector3(), canGoAshore: () => false, goAshore() {}, returnToBoat() {} };
  },

  economy(ctx) {
    const cfg = ctx.config.economy;
    return {
      cash: cfg.startingCash,
      hold: { pink: 0, chum: 0, sockeye: 0, coho: 0, king: 0 }, // fish counts
      holdLbs: () => 0,
      capacityLbs: cfg.holdCapacityLbs,
      fuel: cfg.fuelCapacity,
      fuelCapacity: cfg.fuelCapacity,
      upgrades: {},
      addCatch() {},
      deliver: () => null,
      buy: () => false,
    };
  },

  discovery(ctx) {
    return { discovered: new Set(), isDiscovered: () => false, discover() {}, stats: {} };
  },

  cameraRig(ctx) {
    const { camera, input } = ctx;
    let yaw = 0;
    let pitch = 0.32;
    let dist = 48;
    const target = new THREE.Vector3();
    return {
      mode: 'chase',
      setMode() {},
      shake() {},
      lateUpdate(dt) {
        const s = ctx.systems.seiner;
        if (!s) return;
        yaw -= input.mouse.dx * 0.005;
        pitch = THREE.MathUtils.clamp(pitch + input.mouse.dy * 0.004, 0.05, 1.3);
        dist = THREE.MathUtils.clamp(dist * (1 + input.mouse.wheel * 0.1), 12, 400);
        target.copy(s.position).setY(s.position.y + 4);
        const h = s.heading + yaw;
        camera.position.set(
          target.x - Math.sin(h) * Math.cos(pitch) * dist,
          target.y + Math.sin(pitch) * dist,
          target.z + Math.cos(h) * Math.cos(pitch) * dist,
        );
        camera.lookAt(target);
      },
    };
  },

  audio(ctx) {
    return { play() {}, setMasterVolume() {}, muted: false, unlock() {} };
  },

  ui(ctx) {
    return { toast(text) { console.info('[toast]', text); }, radio() {}, openMap() {}, closeAll() {}, visible: true };
  },

  postfx(ctx) {
    return { enabled: false };
  },
};
