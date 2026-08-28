// The single map of the game: a circular arena. There is no tile art and
// there are no walls — the boundary is a CIRCLE, and a circle is not a thing
// the tile grid can express.
//
// So the grid carries no geometry, only a size: both halves derive the arena
// from it, identically and without a config channel of their own —
//
//     radius = min(cols, rows) * step / 2,  centre = (cols * step / 2, rows * step / 2)
//
// (`step` is the one the engine hands out, i.e. already multiplied by `scale`;
// the grid here is square, so `min` is `cols` — the form is written out in
// full so that the three places that state it state the same thing.)
//
// The core reads it off `ctx.map` (`core/src/arena.rs`) and kills a snake
// whose head leaves the disc; `src/client/parts/Arena.js` reads the same
// numbers out of the MAP_DATA payload and draws the ring. Changing `SIZE` or
// `STEP` moves both at once, which is the whole point — a radius passed as a
// number in `gameConfig.parts` would reach the client and never the core (the
// `game` half of the init JSON is a fixed field set, see `src/data/models.js`).
//
// `layers` must not be empty even though nothing is drawn from tiles: the
// engine builds the map parts by iterating it, one part-construction per
// entry (`client/main.js` → applyMapData), so `layers: {}` means the Arena
// part is never constructed and the canvas stays black. One entry is what
// gets our part built and handed the map data.
//
// `physicsStatic` IS empty, and that is deliberate: an entry there would turn
// every cell into a static collider and fill the disc with solid rock.
//
// ***** WHY THIS FILE EXPORTS A FUNCTION *****
//
// The arena grows with the crowd (`src/host/ArenaScaler.js`): the number of
// cells is a function of how many snakes are in the room, so that the area
// per snake — and with it the odds of meeting one — stays what it is at eight
// players. The default export is the map the engine loads at round start and
// the one `scripts/export-maps.js` writes into `dist/maps/arena.json`; every
// later size is the same object rebuilt by `buildArena()` and hot-swapped
// through MAP_DATA. Nothing else in the game knows a size.

const STEP = 128; // world units per cell
const TILE = 1; // the single tile value; purely a render-layer marker

// The size the game is tuned at: 20 cells of 128 is a 2560-wide arena, radius
// 1280, and it is comfortable for eight snakes. Every other size is derived
// from this pair, so a retune of the base moves the whole curve.
export const BASE_SIZE = 20;
export const BASE_PLAYERS = 8;

// Population is rounded UP to a multiple of this before the size is computed:
// resizing on every single join would rebuild the map of everyone in the room
// for one newcomer. `src/host/ArenaScaler.js` adds the hysteresis that keeps
// a player toggling around a boundary from doing the same.
export const PLAYER_STEP = 4;

// Respawn points. The LENGTH of this list is the hard capacity of the team on
// this map — the engine hands the points out sequentially and refuses the next
// joiner when they run out. It is deliberately double `roomDefaults.maxPlayers`
// (32), so a full room still leaves the bots somewhere to appear.
const RESPAWN_COUNT = 64;

// Points are laid out as a sunflower spiral rather than a ring: sixty-four
// spawns on one circle sit ~60 units apart at the base size, which is inside a
// snake's own body. `sqrt` on the radius is what makes the spiral uniform by
// AREA — a linear radius piles two thirds of the points into the middle.
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

// how much of the radius the outermost respawn point is allowed to reach: a
// snake spawning at 0.72 R faces the centre with most of the disc ahead of it
const RESPAWN_SPAN = 0.72;

// How far a fresh snake's heading may deviate from "straight at the centre",
// in degrees. Strictly at the centre means every spawn of one wave converges
// on the same point; the deviation is a function of the index, never random,
// because this map is serialised into dist/maps/arena.json and the host and
// the client must read the same numbers out of it.
const RESPAWN_FAN_DEG = 25;

// The number of cells per side for a room of `count` participants.
//
// Area grows linearly with the crowd — `size = BASE_SIZE * sqrt(n / 8)` — so
// the disc per snake is constant and the arena never becomes either a corridor
// or an empty plain. Below the base population the size is pinned: a duel in a
// pond is worse than a duel in a lake.
export function arenaSizeFor(count) {
  const stepped = Math.ceil(Math.max(count, 0) / PLAYER_STEP) * PLAYER_STEP;
  const players = Math.max(stepped, BASE_PLAYERS);

  return Math.round(BASE_SIZE * Math.sqrt(players / BASE_PLAYERS));
}

// Bit-reversal of a `RESPAWN_COUNT`-wide index — the van der Corput sequence
// in base two, written as a permutation instead of a fraction.
//
// It is what fixes the real complaint behind this: the engine hands the points
// out strictly by index, `0, 1, 2, …`, and a sunflower spiral is uniform by
// area only TAKEN WHOLE. Its prefix is not — the first ten points of the plain
// order sit at radii 81…355 of a 1280 disc, so any small wave of joiners
// materialises in a heap in the middle and then drives at each other.
//
// Reversing the bits of the index reorders the SAME sixty-four points so that
// every prefix samples the whole range of radii: 0, 32, 16, 48, … Because the
// point set is untouched, the pairwise clearance the spiral already had (178
// units at the base size) is untouched with it.
const RESPAWN_BITS = Math.log2(RESPAWN_COUNT);

// The permutation is only a permutation while the count is a power of two:
// with 48 points `reverseBits` would return indices up to 63, pushing some
// points past RESPAWN_SPAN and handing out others twice — duplicate respawn
// points, and not one error to show for it. The map is built once at import
// time, so this throws where it can still be read.
if (!Number.isInteger(RESPAWN_BITS)) {
  throw new Error(
    `RESPAWN_COUNT must be a power of two (the order is bit-reversed), ` +
      `got ${RESPAWN_COUNT}`,
  );
}

function reverseBits(i) {
  let out = 0;

  for (let bit = 0; bit < RESPAWN_BITS; bit += 1) {
    out = (out << 1) | ((i >> bit) & 1);
  }

  return out;
}

// The respawn points of a `size`-cell arena: [x, y, angleDeg] each, DEGREES,
// not radians — the core converts them itself. Every snake faces the centre —
// fanned out by up to `RESPAWN_FAN_DEG` — so that a fresh spawn never starts
// by driving into the wall, and neighbours never start by driving into one
// another.
function buildRespawns(size) {
  const radius = (size * STEP) / 2;
  const centre = radius;

  return Array.from({ length: RESPAWN_COUNT }, (_, i) => {
    const k = reverseBits(i);
    const r = radius * RESPAWN_SPAN * Math.sqrt((k + 0.5) / RESPAWN_COUNT);
    const theta = k * GOLDEN_ANGLE;
    const x = centre + Math.cos(theta) * r;
    const y = centre + Math.sin(theta) * r;

    // the golden ratio again, this time as a low-discrepancy dither in [-1, 1]
    const fan = (((i * 0.6180339887) % 1) * 2 - 1) * RESPAWN_FAN_DEG;
    const facing = (theta * 180) / Math.PI + 180 + fan;

    return [
      Math.round(x),
      Math.round(y),
      Math.round(((facing % 360) + 360) % 360),
    ];
  });
}

// The map object itself, for a room of `count` participants. The shape is the
// engine's map payload: the same object goes to `coreAdapter.createMap()` and
// out to the clients on MAP_DATA, because `scale` is 1 and the engine's
// scaling pass is therefore a copy.
export function buildArena(count = 0) {
  const size = arenaSizeFor(count);

  return {
    // which parts.gameSets entry builds this map (src/config/client.js)
    setId: 'c1',
    scale: 1,
    step: STEP,

    // no solid tiles: the only boundary is the circle, enforced by the core
    physicsStatic: [],
    physicsDynamic: [],

    // one entry so the Arena part is constructed; the tile list is never drawn
    layers: { 1: [TILE] },

    map: Array.from({ length: size }, () =>
      Array.from({ length: size }, () => TILE),
    ),

    // one playing team, so one entry
    respawns: {
      players: buildRespawns(size),
    },
  };
}

// The map of an empty room: what `scripts/export-maps.js` writes to
// dist/maps/arena.json and what the engine loads before anyone has joined.
export default buildArena(0);
