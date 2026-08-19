// The wire layout of the game (gameConfig.snapshot): one block per entity
// kind. The engine never learns what a field means — only how many bytes it
// takes and whether it interpolates (docs/ai/06-snapshot-protocol.md).
//
// The field ORDER is positionally bound to `core/src/game.rs` — `SnakeRow` and
// `CrystalRow` push their values in exactly this sequence. Nothing validates
// the correspondence: swapping two entries here without swapping them there
// produces garbage instead of an error.

// Points of the resampled spine carried per snake. The core keeps a dense
// path; the wire carries a FIXED resample of it, because a snapshot row has a
// fixed width. 16 points survive Catmull-Rom on the client at any body length
// and cost ~130 bytes per snake per frame.
export const SPINE_POINTS = 16;

// [p0x, p0y, p1x, p1y, …] — p0 is the head. Every component interpolates, so
// a remote snake glides between the 30 frames per second instead of stepping.
const spineFields = Array.from({ length: SPINE_POINTS }, (_, i) => [
  { name: `p${i}x`, ty: 'f32', interp: 'lerp' },
  { name: `p${i}y`, ty: 'f32', interp: 'lerp' },
]).flat();

export default {
  // The snake: continuous state, so `hot` — the only class the render-rate
  // buffer carries, and it carries only indexed8 / indexedNoNull8. The key is
  // the model name (`src/data/models.js`); renaming the model renames the
  // block.
  s1: {
    id: 1,
    kind: 'indexed8',
    class: 'hot',
    fields: [
      ...spineFields,

      // facing of the head, for the eyes and for the boost flame. Separate
      // from the spine because p0→p1 is a chord, not a tangent, and at low
      // speed the two disagree visibly
      { name: 'angle', ty: 'f32', interp: 'lerpAngle' },

      // half-thickness in world units; grows with the crystal count, so it
      // has to interpolate or a snake pops a size on every pickup
      { name: 'radius', ty: 'f32', interp: 'lerp' },

      // score of this snake — the number the stat table sorts by. u16 caps it
      // at 65535, which no match reaches
      { name: 'crystals', ty: 'u16' },

      // index into SNAKE_COLORS (`src/data/palette.js`)
      { name: 'color', ty: 'u8' },

      // 1 while the boost key is held: the client draws the trail for it
      { name: 'boost', ty: 'u8' },
    ],
  },

  // Crystals. They never move, there can be ~60 of them, and they only ever
  // appear and disappear — packing them into the hot buffer every tick would
  // cost ~50 KB/s to re-send a constant. So: `indexed32` + class 'event',
  // packed as a DELTA (a row on spawn, a null row on pickup), which rides the
  // reliable channel and arrives through take_frames() as
  // `{ "<id36>": [fields] | null }` — the persistent-entity shape, so the
  // engine's factory creates and destroys one Part per crystal.
  //
  // A client that joins mid-match would miss every crystal spawned before it,
  // so the core re-sends the whole field whenever an actor spawns.
  cr: {
    id: 2,
    kind: 'indexed32',
    class: 'event',
    fields: [
      { name: 'x', ty: 'f32' },
      { name: 'y', ty: 'f32' },
      // index into `world.tiers` (`src/data/models.js`): size and score
      { name: 'tier', ty: 'u8' },
      // index into CRYSTAL_COLORS (`src/data/palette.js`)
      { name: 'color', ty: 'u8' },
    ],
  },

  // The movable bodies of the map (`physicsDynamic`). This block belongs to
  // the ENGINE: it is packed by the engine half of the core, under the map's
  // `setId` as the key, and its row is fixed at [x, y, angle]. This game has
  // no dynamic bodies, and the block is still mandatory — the packer refuses
  // a key it does not know, and `npm run sim` dies on the first tick with
  // "unknown snapshot key 'c1'".
  c1: {
    id: 3,
    kind: 'indexedNoNull8',
    class: 'hot',
    fields: [
      { name: 'x', ty: 'f32', interp: 'lerp' },
      { name: 'y', ty: 'f32', interp: 'lerp' },
      { name: 'angle', ty: 'f32', interp: 'lerpAngle' },
    ],
  },
};
