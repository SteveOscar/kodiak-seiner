// Minimal stand-ins for every system. Each implements the full required API from src/systems/contract.js (SPEC.md §6)
// with simple behaviour, and a few are minimally functional so neighbours can self-test: a pink school near the spawn
// that harvest() returns when netted, a tender to deliver to, a Kodiak harbour, a skiff that moves between targets.
// Real modules must be supersets of these objects. Stubs must also construct under Node (tests/contract.test.mjs):
// no DOM access in create.

import * as THREE from 'three';
import { resolve as resolvePlaces, pointInPolygon } from '../data/places.js';

const SPECIES = ['pink', 'chum', 'sockeye', 'coho', 'king'];
const emptyCatch = () => ({ pink: 0, chum: 0, sockeye: 0, coho: 0, king: 0 });
const headingForward = (h, out = new THREE.Vector3()) => out.set(Math.sin(h), 0, -Math.cos(h));

function spawnOf(ctx) {
  const p = ctx.systems.places?.spawn;
  if (p) return p;
  const k = ctx.geo.toWorld(ctx.config.spawn.lat, ctx.config.spawn.lon);
  const w = ctx.heightmap.nearestWater(k.x, k.z, { minShore: ctx.config.spawn.minShore }) ?? k;
  return { x: w.x, z: w.z, heading: ctx.config.spawn.heading };
}

// Owner-keyed limits/locks shared by the seiner stub (and a reference for the real seiner).
function ownerMap() {
  const m = new Map();
  return {
    set(owner, v) {
      if (v === null || v === undefined || v === false) m.delete(owner);
      else m.set(owner, v);
    },
    min() {
      let r = null;
      for (const v of m.values()) r = r === null ? v : Math.min(r, v);
      return r;
    },
    size: () => m.size,
  };
}

export const STUBS = {
  season(ctx) {
    const days = ctx.config.season.fishingDays;
    const sys = {
      openerActive: () =>
        ctx.state.freeExplore || (days.includes(ctx.clock.day) && ctx.clock.inOpenerHours()),
      nextOpener() {
        const d = days.find((x) => x > ctx.clock.day || (x === ctx.clock.day && ctx.clock.hours < ctx.config.time.openerStart));
        return d === undefined ? null : { day: d, hours: ctx.config.time.openerStart, districts: 'all' };
      },
      speciesMix: () => ({ pink: 0.55, chum: 0.2, sockeye: 0.2, coho: 0.05, king: 0 }),
      priceFor: (species) => ctx.config.fish.species[species]?.price ?? 0,
      forecast: () => ({ today: 'partly', tomorrow: 'partly', text: 'Kodiak waters: variable winds 10 kt, seas 2 ft.' }),
      closedWaters: [],
      isClosedWater: () => false,
    };
    return sys;
  },

  sky(ctx) {
    const { scene, uniforms, clock } = ctx;
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
    const shadowFocus = new THREE.Vector3();
    const sys = {
      sunDirection: uniforms.uSunDir.value,
      moonDirection: new THREE.Vector3(-0.3, 0.4, 0.8).normalize(),
      sunLight: sun,
      hemiLight: hemi,
      shadowFocus,
      daylight: 1,
      sunElevationDeg: 40,
      isNight: false,
      envMap: null,
      weather: { preset: 'partly', cloudCover: 0.3, fog: 0, rain: 0, windDir: 0.8, windSpeed: 6, swell: 0.4, visibility: 20000 },
      setWeather(preset) {
        sys.weather.preset = preset;
        ctx.events.emit('weather:change', { preset });
      },
      update() {
        const a = ((clock.hours - 5.3) / 17.4) * Math.PI;
        const elev = Math.max(0.05, Math.sin(a)) * 0.9;
        uniforms.uSunDir.value.set(Math.cos(a) * 0.6, elev, -0.5).normalize();
        sys.sunElevationDeg = THREE.MathUtils.radToDeg(Math.asin(uniforms.uSunDir.value.y));
        sys.daylight = THREE.MathUtils.clamp(Math.sin(a) * 2, 0.05, 1);
        sys.isNight = sys.daylight < 0.2;
        sun.intensity = 2.4 * sys.daylight;
        hemi.intensity = 0.25 + 0.65 * sys.daylight;
        uniforms.uDaylight.value = sys.daylight;
        const w = sys.weather;
        uniforms.uWindDir.value.set(Math.sin(w.windDir), -Math.cos(w.windDir));
        uniforms.uWindSpeed.value = w.windSpeed;
      },
    };
    ctx.pipeline.beforeRender(() => {
      sun.position.copy(shadowFocus).addScaledVector(uniforms.uSunDir.value, 1500);
      sun.target.position.copy(shadowFocus);
    });
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
      addOccluder(m) {
        if (m) m.visible = false;
      },
      removeOccluder() {},
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
    return {
      mesh,
      heightAt: heightmap.heightAt,
      surfaceAt(x, z) {
        const h = heightmap.heightAt(x, z);
        if (h < 0) return 'water';
        if (h < 2) return 'gravel';
        if (h > 200) return 'snow';
        return heightmap.normalAt(x, z).y < 0.7 ? 'rock' : 'grass';
      },
      forestDensity: () => 0,
      sunVisibilityAt: () => 1,
    };
  },

  places(ctx) {
    const r = resolvePlaces(ctx.geo);
    const d2 = (p, x, z) => (p.x - x) ** 2 + (p.z - z) ** 2;
    const sys = {
      list: r.places,
      streams: r.streams,
      districts: r.districts,
      closedAreas: r.closedAreas,
      get: (id) => r.places.find((p) => p.id === id) ?? null,
      nearest(x, z, filter = () => true) {
        let best = null;
        let bd = Infinity;
        for (const p of r.places) {
          if (!filter(p)) continue;
          const d = d2(p, x, z);
          if (d < bd) {
            bd = d;
            best = p;
          }
        }
        return best ? { place: best, distance: Math.sqrt(bd) } : null;
      },
      within: (x, z, rad, filter = () => true) => r.places.filter((p) => filter(p) && d2(p, x, z) <= rad * rad),
      districtAt(x, z) {
        const d = r.districts.find((q) => q.polygon.length > 2 && pointInPolygon(x, z, q.polygon));
        return d ? d.name : 'Northeast Kodiak';
      },
      spawn: null,
    };
    const k = ctx.geo.toWorld(ctx.config.spawn.lat, ctx.config.spawn.lon);
    const w = ctx.heightmap.nearestWater(k.x, k.z, { minShore: ctx.config.spawn.minShore }) ?? k;
    sys.spawn = { x: w.x, z: w.z, heading: ctx.config.spawn.heading };
    return sys;
  },

  fleet(ctx) {
    const s = spawnOf(ctx);
    const p = ctx.heightmap.nearestWater(s.x + 600, s.z + 500, { minShore: 80 }) ?? { x: s.x + 600, z: s.z + 500 };
    const object3d = new THREE.Mesh(new THREE.BoxGeometry(8, 6, 30), new THREE.MeshStandardMaterial({ color: 0x8a2c22 }));
    object3d.position.set(p.x, 1.5, p.z);
    object3d.name = 'tender-stub';
    ctx.scene.add(object3d);
    const tender = {
      id: 'stub-tender',
      name: 'Stub Tender',
      placeId: 'kodiak',
      position: object3d.position,
      heading: 0,
      object3d,
      buying: true,
      radius: 20,
      services: ['sell', 'fuel'],
    };
    return {
      tenders: [tender],
      boats: [],
      nearestTender(x, z) {
        const d = Math.hypot(tender.position.x - x, tender.position.z - z);
        return { tender, distance: d };
      },
    };
  },

  seiner(ctx) {
    const { scene, input, heightmap, config, events } = ctx;
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
    const limits = ownerMap();
    const locks = ownerMap();
    let mooring = null;
    let name = 'Northern Dawn';
    const along = (d, h, out) => out.copy(group.position).addScaledVector(headingForward(sys.heading, fwd), d).setY(group.position.y + h);
    const sys = {
      object3d: group,
      position: group.position,
      heading: 0,
      speed: 0,
      velocity: new THREE.Vector3(),
      throttle: 0,
      rudder: 0,
      baseMaxSpeed: config.boat.maxSpeed,
      get maxSpeed() {
        return ctx.systems.economy?.modifiers?.maxSpeed ?? sys.baseMaxSpeed;
      },
      get speedLimit() {
        return limits.min();
      },
      get controlsEnabled() {
        return locks.size() === 0;
      },
      grounded: false,
      engineLoad: 0,
      get mooring() {
        return mooring;
      },
      get anchored() {
        return !!mooring;
      },
      deckLights: false,
      get boatName() {
        return name;
      },
      forward: (out = new THREE.Vector3()) => headingForward(sys.heading, out),
      sternPoint: (out = new THREE.Vector3()) => along(-9, 1.5, out),
      bowPoint: (out = new THREE.Vector3()) => along(9, 2, out),
      powerBlockPoint: (out = new THREE.Vector3()) => along(-4, 9, out),
      skiffMountPoint: (out = new THREE.Vector3()) => along(-7, 2.5, out),
      setPose(x, z, heading = sys.heading) {
        group.position.set(x, 0, z);
        sys.heading = heading;
        sys.speed = 0;
        sys.velocity.set(0, 0, 0);
      },
      setSpeedLimit: (owner, mps) => limits.set(owner, mps),
      lockControls: (owner, locked) => locks.set(owner, locked ? true : null),
      setMooring(m) {
        mooring = m ?? null;
        events.emit('boat:mooring', { mooring });
      },
      setBoatName(n) {
        name = String(n || 'Northern Dawn').slice(0, 24);
      },
      horn() {
        events.emit('boat:horn', {});
      },
      update(dt) {
        const driving = ctx.state.mode === 'play' && ctx.state.control === 'boat' && sys.controlsEnabled;
        const thr = driving ? input.axis('throttle') : 0;
        const steer = driving ? input.axis('steer') : 0;
        if (driving && input.pressed('horn')) sys.horn();
        if (driving && input.pressed('lights')) sys.deckLights = !sys.deckLights;
        if (mooring && Math.abs(thr) > 0.1) sys.setMooring(null);
        sys.throttle = thr;
        sys.rudder = steer;
        let target = thr >= 0 ? thr * sys.maxSpeed : thr * config.boat.reverseSpeed;
        if (sys.speedLimit !== null) target = Math.min(target, sys.speedLimit);
        if (mooring) target = 0;
        sys.speed += (target - sys.speed) * Math.min(1, dt * 0.6);
        sys.engineLoad = Math.abs(thr);
        sys.heading += steer * config.boat.turnRate * Math.min(1, Math.abs(sys.speed) / 4) * dt * Math.sign(sys.speed || 1);
        headingForward(sys.heading, fwd);
        const nx = group.position.x + fwd.x * sys.speed * dt;
        const nz = group.position.z + fwd.z * sys.speed * dt;
        if (heightmap.heightAt(nx + fwd.x * 9, nz + fwd.z * 9) < -config.boat.groundingDepth) {
          group.position.x = nx;
          group.position.z = nz;
          sys.grounded = false;
        } else if (!sys.grounded) {
          events.emit('boat:collision', { speed: Math.abs(sys.speed), x: nx, z: nz, kind: 'ground' });
          sys.speed = 0;
          sys.grounded = true;
        } else {
          sys.speed = Math.min(sys.speed, 0);
        }
        sys.velocity.copy(fwd).multiplyScalar(sys.speed);
        group.position.y = ctx.systems.water?.heightAt(group.position.x, group.position.z) ?? 0;
        group.rotation.set(0, -sys.heading, 0);
        group.updateMatrixWorld(true);
      },
      serialize: () => ({ x: group.position.x, z: group.position.z, heading: sys.heading, name, mooring }),
      restore(d) {
        if (!d) return;
        sys.setPose(d.x, d.z, d.heading);
        sys.setBoatName(d.name);
        mooring = d.mooring ?? null;
      },
      reset() {
        mooring = null;
        sys.deckLights = false;
      },
    };
    return sys;
  },

  skiff(ctx) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(3, 1.2, 6), new THREE.MeshStandardMaterial({ color: 0xb8bcc0 }));
    mesh.name = 'skiff-stub';
    ctx.scene.add(mesh);
    const target = new THREE.Vector3();
    const tmp = new THREE.Vector3();
    let onArrive = null;
    let follow = null;
    const sys = {
      object3d: mesh,
      position: mesh.position,
      heading: 0,
      state: 'stowed', // 'stowed' | 'released' | 'holding' | 'tied' | 'towing' | 'closing' | 'towingOff' | 'returning' | 'ferry'
      get busy() {
        return sys.state === 'closing' || sys.state === 'returning' || sys.state === 'ferry';
      },
      release() {
        ctx.systems.seiner?.sternPoint(target);
        mesh.position.copy(target);
        sys.state = 'holding';
      },
      holdAt(x, z) {
        target.set(x, 0, z);
        sys.state = 'holding';
      },
      towToward(x, z) {
        target.set(x, 0, z);
        sys.state = 'towing';
      },
      tieOff(point) {
        target.set(point.x, 0, point.z);
        sys.state = 'tied';
      },
      closeTo(obj, cb) {
        follow = obj?.isObject3D ? obj : null;
        if (!follow && obj) target.copy(obj);
        onArrive = cb ?? null;
        sys.state = 'closing';
      },
      towOff() {
        sys.state = 'towingOff';
      },
      setTowHeading() {},
      returnTo(cb) {
        follow = null;
        onArrive = () => {
          sys.stow();
          cb?.();
        };
        sys.state = 'returning';
      },
      stow() {
        sys.state = 'stowed';
        onArrive = null;
        follow = null;
      },
      ferry(from, to, cb) {
        mesh.position.copy(from);
        target.copy(to);
        onArrive = cb ?? null;
        sys.state = 'ferry';
      },
      endPoint: (out = new THREE.Vector3()) => out.copy(mesh.position),
      update(dt) {
        const s = ctx.systems.seiner;
        if (sys.state === 'stowed') {
          s?.skiffMountPoint?.(mesh.position);
          mesh.rotation.y = -(s?.heading ?? 0);
          return;
        }
        if (sys.state === 'returning') s?.sternPoint?.(target);
        if (follow) follow.getWorldPosition(target);
        tmp.subVectors(target, mesh.position).setY(0);
        const d = tmp.length();
        const step = Math.min(d, 6 * dt);
        if (d > 0.01) mesh.position.addScaledVector(tmp.normalize(), step);
        mesh.position.y = ctx.systems.water?.heightAt(mesh.position.x, mesh.position.z) ?? 0;
        if (d < 2 && onArrive && (sys.state === 'closing' || sys.state === 'returning' || sys.state === 'ferry')) {
          const cb = onArrive;
          onArrive = null;
          cb();
        }
      },
      reset() {
        sys.stow();
      },
    };
    return sys;
  },

  net(ctx) {
    return {
      state: 'stowed', // 'stowed' | 'paying' | 'out' | 'closed' | 'pursing' | 'hauling' | 'brailing'
      length: ctx.config.net.length,
      depth: ctx.config.net.depth,
      payout: 0,
      pursed: 0,
      hauled: 0,
      bottomContact: 0,
      corkline: [],
      polygon: () => null,
      gap: () => null,
      containsPoint: () => false,
      begin() {},
      close() {},
      purse() {},
      haul() {},
      stow() {},
    };
  },

  fish(ctx) {
    const s = spawnOf(ctx);
    const p = ctx.heightmap.nearestWater(s.x - 300, s.z + 550, { minShore: 120 }) ?? { x: s.x, z: s.z + 600 };
    const school = {
      id: 'stub-school',
      species: 'pink',
      mix: { pink: 3000, chum: 0, sockeye: 0, coho: 0, king: 0 },
      count: 3000,
      position: new THREE.Vector3(p.x, -2, p.z),
      velocity: new THREE.Vector3(),
      radius: 18,
      depth: 2,
      state: 'milling',
      targetStream: null,
      jumpRate: 20,
    };
    const schools = [school];
    const inside = (sc, polygon) => polygon && pointInPolygon(sc.position.x, sc.position.z, polygon);
    return {
      schools,
      nearestSchool(x, z, maxDist = Infinity) {
        const live = schools.filter((sc) => sc.state !== 'captured' && sc.state !== 'gone');
        let best = null;
        let bd = Infinity;
        for (const sc of live) {
          const d = Math.hypot(sc.position.x - x, sc.position.z - z);
          if (d < bd && d <= maxDist) {
            bd = d;
            best = sc;
          }
        }
        return best ? { school: best, distance: bd } : null;
      },
      schoolsWithin: (x, z, r) => schools.filter((sc) => Math.hypot(sc.position.x - x, sc.position.z - z) <= r),
      schoolsInside: (polygon) => schools.filter((sc) => inside(sc, polygon)),
      harvest() {
        const out = emptyCatch();
        const poly = ctx.systems.net?.polygon?.();
        for (const sc of schools) {
          if (sc.state === 'captured' || !inside(sc, poly)) continue;
          for (const k of SPECIES) out[k] += Math.round(sc.mix[k] * 0.7);
          sc.state = 'captured';
        }
        return out;
      },
      sonarReturns(x, z, range) {
        return schools
          .filter((sc) => sc.state !== 'captured' && Math.hypot(sc.position.x - x, sc.position.z - z) <= range)
          .map((sc) => ({ x: sc.position.x, z: sc.position.z, depth: sc.depth, strength: Math.min(1, sc.count / 5000) }));
      },
      spawnSchool({ x, z, species = 'pink', count = 3000 } = {}) {
        const sc = { ...school, id: `stub-${schools.length}`, species, count, mix: { ...emptyCatch(), [species]: count }, position: new THREE.Vector3(x, -2, z), state: 'milling' };
        schools.push(sc);
        return sc;
      },
    };
  },

  fishing(ctx) {
    return {
      state: 'idle', // 'idle' | 'setting' | 'holding' | 'closing' | 'pursing' | 'hauling' | 'brailing' | 'report'
      setNumber: 0,
      lastSet: null,
      canSet: () => ({ ok: false, reason: 'Fishing not available' }),
      abort() {},
      hud: { phase: 'idle', payout: 0, distanceToSkiff: null, tension: 0, tensionBand: [0.4, 0.7], pursed: 0, hauled: 0, inHook: 0, holdSeconds: 0, message: null },
    };
  },

  wildlife(ctx) {
    return { bears: [], whales: [], birds: [], nearestBear: () => null };
  },

  player(ctx) {
    return {
      active: false,
      object3d: null,
      position: new THREE.Vector3(),
      canGoAshore: () => ({ ok: false, reason: 'Not available', landing: null }),
      goAshore() {},
      returnToBoat() {},
    };
  },

  economy(ctx) {
    const cfg = ctx.config.economy;
    const lbsOf = (counts) => SPECIES.reduce((a, k) => a + (counts[k] ?? 0) * ctx.config.fish.species[k].lbs, 0);
    const sys = {
      cash: cfg.startingCash,
      hold: emptyCatch(),
      holdLbs: () => lbsOf(sys.hold),
      get capacityLbs() {
        return sys.modifiers.holdLbs;
      },
      fuel: cfg.fuelCapacity,
      fuelCapacity: cfg.fuelCapacity,
      get fuelEmpty() {
        return sys.fuel <= 0;
      },
      upgrades: {},
      catalog: [],
      stats: { seasonGross: 0, sets: 0, deliveries: 0, bestSetLbs: 0 },
      modifiers: {
        maxSpeed: ctx.config.boat.maxSpeed,
        netLength: ctx.config.net.length,
        netDepth: ctx.config.net.depth,
        purseRate: 1,
        haulRate: 1,
        sonarRange: 150,
        holdLbs: cfg.holdCapacityLbs,
        rswBonus: 0,
        deckLights: true,
        spotterUntilDay: -1,
      },
      addCatch(counts) {
        const accepted = emptyCatch();
        const overflow = emptyCatch();
        let room = sys.capacityLbs - sys.holdLbs();
        for (const k of SPECIES) {
          const lbs = ctx.config.fish.species[k].lbs;
          const fit = Math.max(0, Math.min(counts[k] ?? 0, Math.floor(room / lbs)));
          accepted[k] = fit;
          overflow[k] = (counts[k] ?? 0) - fit;
          room -= fit * lbs;
          sys.hold[k] += fit;
        }
        return { accepted, overflow, acceptedLbs: lbsOf(accepted) };
      },
      deliver(tender) {
        const lines = SPECIES.filter((k) => sys.hold[k] > 0 && !ctx.config.fish.species[k].release).map((k) => {
          const lbs = sys.hold[k] * ctx.config.fish.species[k].lbs;
          const price = ctx.systems.season?.priceFor?.(k, tender?.id) ?? ctx.config.fish.species[k].price;
          return { species: k, count: sys.hold[k], lbs, price, value: lbs * price };
        });
        const gross = lines.reduce((a, l) => a + l.value, 0);
        const crewShare = gross * cfg.crewShare;
        sys.hold = emptyCatch();
        sys.cash += gross - crewShare;
        const receipt = { ticket: 'STUB', tender: tender?.name ?? 'Tender', lines, gross, crewShare, net: gross - crewShare };
        ctx.events.emit('economy:delivered', receipt);
        return receipt;
      },
      refuel() {
        sys.fuel = sys.fuelCapacity;
      },
      buy: () => false,
      addCash(delta, reason) {
        sys.cash += delta;
        ctx.events.emit('economy:cash', { cash: sys.cash, delta, reason });
      },
      useFuel(gallons) {
        sys.fuel = Math.max(0, sys.fuel - gallons);
      },
    };
    return sys;
  },

  discovery(ctx) {
    const discovered = new Set();
    return {
      discovered,
      sightings: new Set(),
      isDiscovered: (id) => discovered.has(id),
      discover(id) {
        discovered.add(id);
      },
      progress: () => ({ places: [discovered.size, ctx.systems.places?.list?.length ?? 0], wildlife: [0, 0] }),
    };
  },

  cameraRig(ctx) {
    const { camera, input } = ctx;
    let yaw = 0;
    let pitch = 0.32;
    let dist = 48;
    const focus = new THREE.Vector3();
    const rig = {
      mode: 'chase',
      focus,
      binoculars: false,
      setMode(m) {
        rig.mode = m;
      },
      cycle() {},
      suggest() {},
      setTarget() {},
      shake() {},
      lateUpdate() {
        const s = ctx.systems.seiner;
        if (!s) return;
        yaw -= input.mouse.dx * 0.005;
        pitch = THREE.MathUtils.clamp(pitch + input.mouse.dy * 0.004, 0.05, 1.3);
        dist = THREE.MathUtils.clamp(dist * (1 + input.mouse.wheel * 0.1), 12, 400);
        focus.copy(s.position).setY(s.position.y + 4);
        const h = s.heading + yaw;
        camera.position.set(
          focus.x - Math.sin(h) * Math.cos(pitch) * dist,
          focus.y + Math.sin(pitch) * dist,
          focus.z + Math.cos(h) * Math.cos(pitch) * dist,
        );
        camera.lookAt(focus);
        ctx.systems.sky?.shadowFocus?.copy(focus);
      },
    };
    return rig;
  },

  audio(ctx) {
    return { play() {}, setVolumes() {}, muted: false, unlock() {} };
  },

  ui(ctx) {
    const emit = (name, payload) => ctx.events.emit(name, payload);
    return {
      visible: true,
      toast: (text, opts = {}) => emit('ui:toast', { text, kind: opts.kind ?? 'info', duration: opts.duration ?? 4 }),
      radio: (from, text, channel = '10') => emit('ui:radio', { from, text, channel }),
      hint: (id, text) => emit('ui:hint', { id, text }),
      openMap() {},
      openLogbook() {},
    };
  },

  postfx(ctx) {
    return { enabled: false, setEnabled() {} };
  },
};
