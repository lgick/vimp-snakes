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

const SIZE = 20; // cells per side
const STEP = 128; // world units per cell -> 2560 x 2560, radius 1280
const TILE = 1; // the single tile value; purely a render-layer marker

const RADIUS = (SIZE * STEP) / 2;
const CENTRE = RADIUS;

// Respawn points: a ring well inside the boundary, every snake facing the
// centre so that a fresh spawn never starts by driving into the wall.
//
// The LENGTH of this list is the hard capacity of the team on this map — the
// engine hands the points out sequentially and refuses the next joiner when
// they run out. 16 covers roomDefaults.maxPlayers (8) with room for bots.
const RESPAWN_COUNT = 16;
const RESPAWN_RING = 640;

const respawns = Array.from({ length: RESPAWN_COUNT }, (_, i) => {
  const theta = (i / RESPAWN_COUNT) * Math.PI * 2;
  const x = CENTRE + Math.cos(theta) * RESPAWN_RING;
  const y = CENTRE + Math.sin(theta) * RESPAWN_RING;

  // [x, y, angleDeg] — DEGREES, not radians: the core converts them itself.
  // Facing the centre is theta + 180.
  return [
    Math.round(x),
    Math.round(y),
    Math.round(((theta * 180) / Math.PI + 180) % 360),
  ];
});

export default {
  // which parts.gameSets entry builds this map (src/config/client.js)
  setId: 'c1',
  scale: 1,
  step: STEP,

  // no solid tiles: the only boundary is the circle, enforced by the core
  physicsStatic: [],
  physicsDynamic: [],

  // one entry so the Arena part is constructed; the tile list is never drawn
  layers: { 1: [TILE] },

  map: Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => TILE)),

  // one playing team, so one entry
  respawns: {
    players: respawns,
  },
};
