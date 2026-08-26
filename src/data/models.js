import { CRYSTAL_TIERS } from './palette.js';

// Snake classes (gameConfig.parts.models). The engine passes this object
// verbatim into BOTH cores — the authoritative one and the predictor — so
// every number here is gameplay, not decoration (core/src/config.rs, struct
// SnakeConfig).
//
// The key is the model name: it is the snapshot block key of the snake
// (`src/config/snapshot.js`), the value of the `model` field of the auth form
// and `gameConfig.scripted.defaultModel`.
//
// Why the world rules live INSIDE a model: the `game` half of the init JSON is
// assembled by the engine and its field set is fixed — `friendlyFire`,
// `models`, `weapons`, `playerKeys`, `panel`. A free-form `parts.*` key
// reaches the CLIENT config and never the core. With exactly one snake class,
// nesting the arena and crystal-field rules under it is the one place both
// cores can actually read them from.
export default {
  s1: {
    // ***** movement *****

    // world units per second. A snake never stops — there is no throttle and
    // no brake, only the two turn keys and the boost
    baseSpeed: 260,

    // multiplier while `boost` is held
    boostFactor: 1.9,

    // radians per second at zero crystals — the BASE of the turn rate, not
    // the whole of it. Fast enough to circle a rival, slow enough that a
    // long snake cannot fold onto its own neck
    turnSpeed: 3.4,

    // turnSpeed(c) = max(turnSpeedMin, turnSpeed - turnSpeedFalloff *
    // sqrt(crystals)). The mirror image of radiusGain: the fatter a snake
    // grows the heavier it steers, but never below the floor — a leader must
    // stay steerable, only stop being nimble
    turnSpeedFalloff: 0.18,
    turnSpeedMin: 1.4,

    // ***** body *****

    // half-thickness of a snake with zero crystals, in world units
    baseRadius: 14,

    // radius = baseRadius + radiusGain * sqrt(crystals) — square root on
    // purpose: linear growth makes a leader a wall nobody can pass
    radiusGain: 1.6,

    // length of the body polyline at zero crystals, in world units
    baseLength: 150,

    // world units of body added per crystal
    lengthPerCrystal: 9,

    // spacing of the dense path history the core keeps. Smaller means a
    // smoother body and more memory per snake; the wire always carries the
    // 16-point resample regardless
    pointSpacing: 6,

    // ***** boost *****

    // crystals burned per second while boosting; they are dropped back onto
    // the map behind the tail, so a boosting leader feeds the pack
    boostDrainPerSecond: 6,

    // boosting is refused below this many crystals — otherwise a snake could
    // shrink past its own minimum length
    boostMinCrystals: 2,

    // ***** the world (read by the core, one instance, see the note above) ***

    world: {
      // crystals present on the map at once. Also the practical ceiling of
      // the `cr` block: it is indexed32, so the id space is not the limit —
      // the bandwidth of a full resync is
      maxCrystals: 60,

      // seconds between natural spawns while below maxCrystals
      spawnInterval: 0.35,

      // relative weights of `tiers` below, same order: small ones are the
      // background, big ones are worth crossing the map for
      tierWeights: [70, 25, 5],

      // tiers, mirrored from palette.js so the client draws exactly what the
      // core scores
      tiers: CRYSTAL_TIERS,

      // how many crystals a dead snake gives back, as a fraction of what it
      // had. Below 1 so that a long chain of kills does not inflate the map
      dropRatio: 0.8,

      // world units of clearance a natural spawn keeps from the arena edge
      edgeMargin: 60,

      // starting crystal count of a freshly spawned or respawned snake
      startCrystals: 0,

      // seconds a fresh snake stays frozen and untouchable: it does not move,
      // does not kill and cannot be killed, and blinks on every client. Long
      // enough for a rival flying at the spawn point to steer around it
      spawnGraceSeconds: 2,
    },
  },
};
