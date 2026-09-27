// Procedural animation for the deckhand, DOM-free and THREE-free.
//
// Locomotion is authored as foot trajectories (stance sweep + swing arc per leg, phase-locked to distance travelled so
// feet do not skate) solved with analytic two-bone leg IK against the ground under each foot, so boots plant on
// slopes and in the shallows. The upper body is layered on top: pelvis bob/sway/yaw, counter-rotating chest, arm
// swing, lean from speed, acceleration and slope, a sprung crouch for landings, and head stabilisation with an
// optional look target. Special poses: jump (tuck), slide, scramble, wade, ride (braced in the skiff), startled,
// wary (bear watching).
//
// Bone frame: bind pose standing, facing -z, feet at y = 0; +x rotation swings a hanging limb forward and tips an
// upright segment backward.

export const SKELETON = Object.freeze({
  hipY: 0.98, // pelvis pivot
  hipJointY: 0.93,
  hipX: 0.095,
  kneeY: 0.51,
  ankleY: 0.09,
  spineY: 1.06,
  chestY: 1.28,
  neckY: 1.49,
  headY: 1.58,
  shoulderX: 0.192,
  shoulderY: 1.44,
  elbowY: 1.155,
  wristY: 0.905,
  thigh: 0.42,
  shin: 0.42,
});

export const BONE_NAMES = [
  'hips', 'spine', 'chest', 'neck', 'head',
  'upperArmL', 'foreArmL', 'handL', 'upperArmR', 'foreArmR', 'handR',
  'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR',
];

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const ease = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const damp = (v, t, rate, dt) => v + (t - v) * (1 - Math.exp(-rate * dt));
const frac = (x) => x - Math.floor(x);

export function createPose() {
  const rot = {};
  for (const n of BONE_NAMES) rot[n] = { x: 0, y: 0, z: 0 };
  return { rot, hips: { x: 0, y: SKELETON.hipY, z: 0 }, feet: { L: { fwd: 0, lat: -SKELETON.hipX, lift: 0, stance: true }, R: { fwd: 0, lat: SKELETON.hipX, lift: 0, stance: true } } };
}

export function createAnimator(seed = 0) {
  return {
    phase: 0,
    time: 0,
    moveAmt: 0,
    runAmt: 0,
    lean: 0,
    bank: 0,
    crouch: 0,
    crouchVel: 0,
    drop: 0,
    air: 0,
    slide: 0,
    wade: 0,
    scramble: 0,
    ride: 0,
    startle: 0,
    wary: 0,
    lookYaw: 0,
    lookPitch: 0,
    prevSpeed: 0,
    accel: 0,
    stepSide: 0, // last foot that planted (-1 L, 1 R)
    steps: 0, // count of footfalls (for footstep events)
    idleSeed: seed * 100,
  };
}

// Stride length (one step, metres) at speed v (m/s).
export function stepLength(v) {
  return Math.max(0.3, 0.4 + 0.26 * v - 0.006 * v * v);
}

// Two-bone IK in the sagittal plane: returns { thigh (rad, + forward from straight down), knee (rad bend >= 0),
// reach (0..1+) }. dx forward, dy down from the hip joint to the ankle.
export function legIK(dx, dy, L1 = SKELETON.thigh, L2 = SKELETON.shin, out = { thigh: 0, knee: 0, reach: 0 }) {
  const D0 = Math.hypot(dx, dy);
  const D = clamp(D0, Math.abs(L1 - L2) + 1e-3, (L1 + L2) * 0.9995);
  const beta = Math.atan2(dx, dy);
  const cosA = clamp((L1 * L1 + D * D - L2 * L2) / (2 * L1 * D), -1, 1);
  const cosK = clamp((L1 * L1 + L2 * L2 - D * D) / (2 * L1 * L2), -1, 1);
  out.thigh = beta + Math.acos(cosA);
  out.knee = Math.PI - Math.acos(cosK);
  out.reach = D0 / (L1 + L2);
  return out;
}

const ik = { thigh: 0, knee: 0, reach: 0 };

// in: { dt, speed, slopeDeg (+ uphill along facing), onGround, vy, jumped, landed, landSpeed, sliding, depth,
//       turnRate, mode: 'free'|'ride'|'startled'|'wary', lookYaw, lookPitch (rad, relative to facing; null = none),
//       boatRoll, boatPitch (ride), scrambling (bool) }
// groundAt(lat, fwd): ground height at a foot position relative to the root (metres; root y = ground under the body).
// Returns the pose (mutated in place). Emits footfalls by incrementing a.steps (a.stepSide = side that planted).
export function animate(a, pose, input, groundAt) {
  const dt = Math.min(0.1, Math.max(0, input.dt ?? 0));
  const S = SKELETON;
  a.time += dt;
  const v = input.speed ?? 0;
  const onGround = input.onGround !== false;
  const mode = input.mode ?? 'free';

  a.accel = damp(a.accel, dt > 0 ? (v - a.prevSpeed) / dt : 0, 8, dt);
  a.prevSpeed = v;
  a.moveAmt = damp(a.moveAmt, onGround ? smooth(0.06, 0.7, v) : a.moveAmt, 10, dt);
  a.runAmt = damp(a.runAmt, smooth(2.7, 4.3, v), 6, dt);
  a.air = damp(a.air, onGround ? 0 : 1, onGround ? 18 : 10, dt);
  a.slide = damp(a.slide, input.sliding ? 1 : 0, 6, dt);
  a.wade = damp(a.wade, clamp((input.depth ?? 0) / 0.4, 0, 1), 5, dt);
  a.ride = damp(a.ride, mode === 'ride' ? 1 : 0, 8, dt);
  a.startle = damp(a.startle, mode === 'startled' ? 1 : 0, mode === 'startled' ? 9 : 3, dt);
  a.wary = damp(a.wary, mode === 'wary' ? 1 : 0, 3, dt);
  const uphill = input.slopeDeg ?? 0;
  a.scramble = damp(a.scramble, input.scrambling && v > 0.05 ? 1 : 0, 4, dt);

  // Landing / take-off spring on the crouch (a little underdamped: the body has weight).
  if (input.landed) a.crouchVel += clamp((input.landSpeed ?? 0) * 0.075, 0, 0.9);
  if (input.jumped) a.crouchVel -= 0.55;
  const w = 15;
  const z = 0.5;
  a.crouchVel += (-w * w * a.crouch - 2 * z * w * a.crouchVel) * dt;
  a.crouch = clamp(a.crouch + a.crouchVel * dt, -0.08, 0.3);

  // Gait phase from distance travelled.
  const step = stepLength(v) * lerp(1, 0.62, clamp(Math.abs(uphill) / 50, 0, 1)) * lerp(1, 0.75, a.wade);
  const prevPhase = a.phase;
  if (onGround && !input.sliding) a.phase = frac(a.phase + (v * dt) / (2 * step));
  // Footfalls at phase 0 (left) and 0.5 (right).
  if (a.moveAmt > 0.3 && onGround && !input.sliding) {
    if (prevPhase > a.phase) {
      a.steps++;
      a.stepSide = -1;
    } else if (prevPhase < 0.5 && a.phase >= 0.5) {
      a.steps++;
      a.stepSide = 1;
    }
  }
  const phi = a.phase;
  const run = a.runAmt;
  const move = a.moveAmt * (1 - a.slide) * (1 - a.ride);
  const Sf = lerp(0.62, 0.36, run); // stance fraction
  const H = Math.min(step * Sf, lerp(0.34, 0.5, run)) * lerp(1, 0.7, a.scramble);
  const liftH = lerp(0.11, 0.3, run) + 0.16 * a.wade + 0.06 * a.scramble;

  // Lean: speed, acceleration, slope, scramble; bank into turns.
  const slopeRad = (clamp(uphill, -60, 60) * Math.PI) / 180;
  let leanT = 0.035 * move + 0.2 * run * move + clamp(a.accel * 0.03, -0.12, 0.15) * move;
  leanT += move * (slopeRad > 0 ? slopeRad * 0.42 : slopeRad * 0.18);
  leanT += a.scramble * 0.38 - a.slide * 0.35 - a.startle * 0.3 - a.wary * 0.05;
  a.lean = damp(a.lean, leanT, 6, dt);
  a.bank = damp(a.bank, clamp(-(input.turnRate ?? 0) * v * 0.035, -0.22, 0.22) * (onGround ? 1 : 0.4), 6, dt);

  // Look target (head), stabilised.
  const ly = input.lookYaw ?? null;
  const idleLook = Math.sin(a.time * 0.23 + a.idleSeed) * 0.35 * Math.max(0, Math.sin(a.time * 0.11 + a.idleSeed * 2)) * (1 - move);
  a.lookYaw = damp(a.lookYaw, ly === null ? idleLook : clamp(ly, -1.25, 1.25), 3.5, dt);
  a.lookPitch = damp(a.lookPitch, input.lookPitch ?? 0, 3, dt);

  // ------------------------------------------------------------------ feet
  const idleShift = Math.sin(a.time * 0.7 + a.idleSeed) * (1 - move);
  const legs = [
    { side: 'L', sign: -1, off: 0 },
    { side: 'R', sign: 1, off: 0.5 },
  ];
  let minGround = 0;
  const feet = pose.feet;
  for (const leg of legs) {
    const f = feet[leg.side];
    const p = frac(phi + leg.off);
    let fwd;
    let lift;
    let pitch;
    let stance;
    if (p < Sf) {
      const u = p / Sf;
      fwd = H * (1 - 2 * u);
      lift = 0;
      stance = true;
      pitch = 0.28 * (1 - smooth(0, 0.18, u)) * (1 - run * 0.6) - 0.55 * smooth(0.72, 1, u) * u;
    } else {
      const u = (p - Sf) / (1 - Sf);
      fwd = -H + 2 * H * ease(u);
      lift = liftH * Math.sin(Math.PI * Math.pow(u, lerp(0.85, 0.55, run)));
      stance = false;
      pitch = -0.45 * (1 - smooth(0, 0.45, u)) + 0.22 * smooth(0.6, 1, u);
    }
    // Idle stance: feet a little apart, weight shifting.
    const idleFwd = leg.sign * 0.035 + (leg.sign < 0 ? 0.02 : -0.01) * idleShift;
    fwd = lerp(idleFwd, fwd, move);
    lift *= move;
    pitch *= move;
    stance = stance || move < 0.3;
    let lat = leg.sign * lerp(0.115 + 0.012 * idleShift * leg.sign, 0.1, move);
    // Ride: braced wide in the skiff. Slide: feet forward, apart.
    lat = lerp(lat, leg.sign * 0.17, a.ride);
    fwd = lerp(fwd, leg.sign < 0 ? 0.14 : -0.12, a.ride);
    lat = lerp(lat, leg.sign * 0.16, a.slide);
    fwd = lerp(fwd, leg.sign < 0 ? 0.22 : 0.02, a.slide);
    lift = lerp(lift, 0.02, a.slide);
    // In the air: tuck on the way up, reach for the ground on the way down.
    const rising = clamp((input.vy ?? 0) / 4, -1, 1);
    const tuck = a.air * (0.12 + 0.08 * rising);
    fwd = lerp(fwd, leg.sign < 0 ? 0.12 : -0.1, a.air * 0.6);
    lift = lerp(lift, tuck + (leg.sign < 0 ? 0.06 : 0), a.air);
    pitch = lerp(pitch, -0.25, a.air * 0.5);
    f.fwd = fwd;
    f.lat = lat;
    f.lift = lift;
    f.pitch = pitch;
    f.stance = stance && a.air < 0.5;
    f.ground = a.air > 0.5 ? 0 : groundAt ? groundAt(lat, fwd) : 0;
    if (f.stance) minGround = Math.min(minGround, f.ground);
    else minGround = Math.min(minGround, f.ground * 0.5);
  }

  // ------------------------------------------------------------------ pelvis
  const bobWalk = -0.042 * (0.5 - 0.5 * Math.cos(2 * TAU * (phi - Sf / 2)));
  const bobRun = -0.035 + 0.045 * (0.5 - 0.5 * Math.cos(2 * TAU * (phi - Sf / 2)));
  const bob = lerp(bobWalk, bobRun, run) * move;
  a.drop = damp(a.drop, clamp(-minGround, 0, 0.32) * (1 - a.air), 14, dt);
  const breathe = Math.sin((a.time * TAU) / 4.2);
  const hipsY = S.hipY + bob - a.crouch - a.drop - 0.06 * a.scramble - 0.26 * a.slide - 0.07 * a.ride - 0.04 * a.wade - 0.03 * a.wary;
  pose.hips.y = hipsY;
  pose.hips.x = 0.018 * idleShift + Math.sin(phi * TAU) * 0.018 * move * (1 - run);
  pose.hips.z = 0;

  const R = pose.rot;
  const pelvisYaw = -lerp(0.11, 0.07, run) * Math.cos(TAU * phi) * move;
  const pelvisRoll = -0.05 * Math.cos(TAU * (phi - Sf / 2) * 2) * move * (1 - run * 0.5) + 0.03 * idleShift;
  const hipsPitch = -a.lean * 0.3;
  R.hips.x = hipsPitch;
  R.hips.y = pelvisYaw;
  R.hips.z = pelvisRoll + a.bank;
  R.spine.x = -a.lean * 0.35 - 0.012 * breathe * (1 - move);
  R.spine.y = -pelvisYaw * 0.45;
  R.spine.z = -pelvisRoll * 0.5;
  const chestYaw = -pelvisYaw * 0.9 + 0.05 * Math.cos(TAU * phi) * move * run;
  R.chest.x = -a.lean * 0.35 + 0.018 * breathe * (1 - move);
  R.chest.y = chestYaw + a.lookYaw * 0.22;
  R.chest.z = -pelvisRoll * 0.4 - a.bank * 0.3;
  // Ride: keep the torso upright against the skiff's roll and pitch.
  if (a.ride > 0) {
    R.hips.z += -(input.boatRoll ?? 0) * 0.5 * a.ride;
    R.chest.z += -(input.boatRoll ?? 0) * 0.4 * a.ride;
    R.spine.x += (input.boatPitch ?? 0) * 0.5 * a.ride;
  }
  // Head: counter the lean so the gaze stays level, then look.
  const torsoPitch = hipsPitch + R.spine.x + R.chest.x;
  R.neck.x = -torsoPitch * 0.45 + a.lookPitch * 0.3;
  R.neck.y = a.lookYaw * 0.32 - (pelvisYaw + R.spine.y + chestYaw) * 0.5;
  R.neck.z = -(R.hips.z + R.spine.z + R.chest.z) * 0.5;
  R.head.x = -torsoPitch * 0.45 + a.lookPitch * 0.7 + 0.03 * Math.sin(TAU * phi * 2) * move * run;
  R.head.y = a.lookYaw * 0.46;
  R.head.z = -(R.hips.z + R.spine.z + R.chest.z) * 0.4;

  // ------------------------------------------------------------------ legs (IK)
  const hipJointY = hipsY - (S.hipY - S.hipJointY);
  for (const leg of legs) {
    const f = feet[leg.side];
    const ankleY = S.ankleY + f.lift + f.ground;
    const dy = hipJointY - ankleY;
    const dx = f.fwd;
    legIK(dx, Math.max(0.05, dy), S.thigh, S.shin, ik);
    const thigh = R[`thigh${leg.side}`];
    const shin = R[`shin${leg.side}`];
    const foot = R[`foot${leg.side}`];
    thigh.x = ik.thigh - hipsPitch;
    thigh.y = -pelvisYaw * 0.9;
    thigh.z = Math.atan2(f.lat - leg.sign * S.hipX, Math.max(0.2, dy)) * 1 - R.hips.z;
    shin.x = -ik.knee;
    shin.y = 0;
    shin.z = 0;
    // Foot flat on the ground under it (slope along the stride) plus heel-strike / toe-off roll.
    const slopeAlong = f.stance && groundAt ? Math.atan2(groundAt(f.lat, f.fwd + 0.12) - groundAt(f.lat, f.fwd - 0.12), 0.24) : 0;
    const want = slopeAlong + f.pitch;
    foot.x = clamp(want - (ik.thigh - ik.knee), -0.9, 0.7);
    foot.y = 0;
    foot.z = -thigh.z * 0.6;
  }

  // ------------------------------------------------------------------ arms
  const swing = Math.cos(TAU * phi) * lerp(0.32, 0.78, run) * move;
  const armBase = 0.06 + 0.14 * run * move;
  const elbow = lerp(0.18, 1.35, run * move);
  for (const side of ['L', 'R']) {
    const sign = side === 'L' ? -1 : 1;
    const up = R[`upperArm${side}`];
    const fore = R[`foreArm${side}`];
    const hand = R[`hand${side}`];
    // Left arm swings with the right leg.
    const s = side === 'L' ? -swing : swing;
    let ax = armBase + s;
    let az = sign * (0.1 + 0.05 * run * move + 0.012 * breathe * (1 - move));
    let ex = elbow + Math.max(0, s) * lerp(0.35, 0.3, run);
    let hx = -0.1;
    let hz = 0;
    // Wading and descending: arms out for balance.
    const balance = Math.max(a.wade * 0.5, clamp(-uphill / 45, 0, 1) * 0.45 * move);
    az += sign * balance * 0.5;
    // Scramble: reach forward and down, alternating with the legs like a climb.
    ax = lerp(ax, 0.95 + 0.35 * (side === 'L' ? Math.cos(TAU * phi) : -Math.cos(TAU * phi)), a.scramble);
    ex = lerp(ex, 0.35, a.scramble);
    // Air: arms up and out.
    ax = lerp(ax, 0.55 + 0.2 * clamp((input.vy ?? 0) / 4, -1, 1), a.air * 0.8);
    az = lerp(az, sign * 0.55, a.air * 0.8);
    ex = lerp(ex, 0.6, a.air * 0.8);
    // Slide: surf pose.
    ax = lerp(ax, 0.3, a.slide);
    az = lerp(az, sign * 1.15, a.slide);
    ex = lerp(ex, 0.45, a.slide);
    // Ride: left hand on the gunwale, right easy at the side.
    if (side === 'L') {
      ax = lerp(ax, 0.12, a.ride);
      az = lerp(az, -0.5, a.ride);
      ex = lerp(ex, 0.25, a.ride);
    } else {
      ax = lerp(ax, 0.25, a.ride);
      az = lerp(az, 0.12, a.ride);
      ex = lerp(ex, 0.7, a.ride);
    }
    // Startled: arms up in front. Wary: hands a little out, shoulders tight.
    ax = lerp(ax, side === 'L' ? 1.25 : 1.1, a.startle);
    az = lerp(az, sign * 0.25, a.startle);
    ex = lerp(ex, 0.9, a.startle);
    ax = lerp(ax, 0.22, a.wary);
    az = lerp(az, sign * 0.28, a.wary);
    ex = lerp(ex, 0.55, a.wary);
    hx = lerp(hx, -0.5, a.wary + a.startle * 0.5);
    up.x = ax - (hipsPitch + R.spine.x + R.chest.x) * 0.4;
    up.y = 0;
    up.z = az;
    fore.x = ex;
    fore.y = sign * -0.25;
    fore.z = 0;
    hand.x = hx;
    hand.y = 0;
    hand.z = hz;
  }
  return pose;
}
