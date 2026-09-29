// Tunables for the seine and the set (WP-NET). Durations are real seconds at the base upgrade level; purse and haul
// rates are further scaled by economy.modifiers.purseRate / haulRate.

export const NET_TUNING = {
  drift: 0.7, // corks follow this fraction of the surface current (web and leadline drag)
  relax: 0.8, // 1/s: how quickly a node's velocity settles to the drift
  iterations: 10, // constraint sweeps per substep
  lagSeconds: 1.1, // the leadline trails the corks by velocity × this (web bellies in current/tow)

  purse: {
    base: 1 / 15, // pursed per second with the tension in the green band (good feathering ~16-20 s)
    smoothBottomSlow: 0.2, // pursing is 20% slower with the leadline on a smooth bottom
    contactLift: 0.6, // the leadline rises this fraction of the web depth as pursed → 1
  },
  snag: { stall: [5, 10] }, // seconds a hang-up stalls pursing (the hole's +25% escape is applied by WP-FISH)
  haul: {
    bagTarget: 0.9, // hauled fraction at which the bag is "dried up" (~38 m of corkline left)
    seconds: 32, // haul duration without E
    boost: 1.5, // E speeds the block by this factor
    corksUnderAbove: 0.8, // fraction of the maximum block speed above which corks go under in current
    corksUnderCurrent: 0.18, // m/s of current at the bag that counts as "in current"
    finishSeconds: 3.5, // hauling the empty bag aboard after brailing
    abortSeconds: 7, // haul-back time after abort()
  },
};

export const FISHING_TUNING = {
  minDepth: 6, // m under the stern to let go
  tieOffRange: 90, // m from the drop point to the beach for "Tie off to the beach" (see notes: SPEC says 40)
  tieOffMinSpeed: 0.8, // m/s: the idle tie-off let-go is offered only under way (stopped, E is "Go ashore")
  holdEligible: 0.6, // payout fraction for "Hold the hook"
  letGo: {
    fishNear: 150, // m (+ school radius): "fish close". The new season's first set only lets go this close
    search: 1500, // m searched for the nearest school (bearing/distance cue)
    tenderClear: 60, // m of water to a tender's hull inside which no let-go is offered
    harbourRange: 90, // m from a harbour's dock point inside which no let-go is offered
  },
  // bringAround: holding a round haul short of the skiff lifts the 1.5 m/s tow limit to this so the player can run
  // around to it (the close is only offered alongside).
  speed: { setting: 7, holding: 1.5, closing: 3, pursing: 0.5, bringAround: 7 },
  payoutSlow: 0.6, // pay-out below this fraction of the setting speed limit reads "slow" on the HUD
  // liftGap: while closing with the skiff end farther than this, the seiner may run at bringAround speed to meet it.
  // holdRange: a round haul held (net all out) is offered the close-up within this of the skiff end (the skiff runs
  // its end in at ~5 m/s, so ~10 s), and keeps the offer out to liftGap (no flicker as the skiff tows).
  close: { minSeconds: 8.5, timeout: 24, hardTimeout: 75, nearDistance: 30, arriveDistance: 7, liftGap: 60, holdRange: 45 },
  wheel: { distance: 2.4, seconds: 3, stall: 6 },
  winch: {
    band: [0.42, 0.74],
    rampUp: 0.95, // winch speed per second while E is held
    rampDown: 1.6, // per second when released
    loadStart: 0.62, // tension at full speed at the start of pursing
    loadEnd: 1.12, // and at rings up (the bag gets heavy): feather E in the second half
    foulSeconds: 0.9, // continuous time above the band before the rings foul
    foulStall: 3,
  },
  towTurnRate: 0.7, // rad/s: A/D aim the skiff's pull
  hookCollapse: 0.4, // hook area below this fraction of its best leaks fish (message)
  estimateNoise: 0.3, // "In the hook: ~N" is within ±30%
  citation: { chance: 0.65, fine: 3000 },
  reportTimeout: 16, // s to wait for the skiff to return before stowing it
  goodLbs: 8000,
  goodValue: 2500,
  pluggedLbs: 30000,
  waterHaulFish: 25, // fewer fish than this is a water haul
};
