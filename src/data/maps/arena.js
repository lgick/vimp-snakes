// The single map of the game: a circular arena. There is no tile art and
// there are no walls — the boundary is a CIRCLE, and a circle is not a thing
// the tile grid can express.
//
// So the grid carries no geometry, only a size: both halves derive the arena
// from it, identically and without a config channel of their own —
//
//     radius = cols * step * scale / 2,  centre = (radius, radius)
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

// The respawn points of a `size`-cell arena: [x, y, angleDeg] each, DEGREES,
// not radians — the core converts them itself. Every snake faces the centre so
// that a fresh spawn never starts by driving into the wall.
function buildRespawns(size) {
  const radius = (size * STEP) / 2;
  const centre = radius;

  return Array.from({ length: RESPAWN_COUNT }, (_, i) => {
    const r = radius * RESPAWN_SPAN * Math.sqrt((i + 0.5) / RESPAWN_COUNT);
    const theta = i * GOLDEN_ANGLE;
    const x = centre + Math.cos(theta) * r;
    const y = centre + Math.sin(theta) * r;

    return [
      Math.round(x),
      Math.round(y),
      Math.round((((theta * 180) / Math.PI + 180) % 360 + 360) % 360),
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
