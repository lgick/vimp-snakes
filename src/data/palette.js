// The colour table of the game. The core never sees a colour: it rolls an
// INDEX into this array through the engine Rng and ships that index as a `u8`
// field of the snake and crystal blocks. The client is the only side that
// turns an index into a number.
//
// Keeping the mapping in one file is what makes it safe: a colour inserted in
// the middle would otherwise recolour every snake already on the wire, because
// the index is the whole identity. Append, never insert.
export const SNAKE_COLORS = [
  0xff4d4d, // red
  0xff9f1c, // orange
  0xffd23f, // yellow
  0x9bde3c, // lime
  0x2ec4b6, // teal
  0x3ab7ff, // sky
  0x5468ff, // indigo
  0xb15cff, // violet
  0xff5cc8, // pink
  0xf7f7f7, // white
  0x7de2d1, // mint
  0xffa4a4, // salmon
];

// Crystals use their own, cooler table so that a crystal is never mistaken for
// a very small snake at a glance.
export const CRYSTAL_COLORS = [
  0x7ef9ff, // ice
  0x9ad0ff, // pale blue
  0xc8b6ff, // lavender
  0xbcffdb, // seafoam
  0xffe98a, // pale gold
  0xffb3c6, // rose
];

// Three tiers, ascending. `value` is BOTH the crystal count a snake gains and
// the score it is worth — the two are the same number by design, the stat
// table shows the sum. `radius` is the pick-up radius and the drawn size.
//
// The core reads these numbers from `gameConfig.parts.models.s1.crystalTiers`
// (the `game` half of the init JSON carries `models`, and nothing else of
// `parts`), so this array is the single source and both sides import it.
export const CRYSTAL_TIERS = [
  { value: 1, radius: 8 },
  { value: 3, radius: 13 },
  { value: 8, radius: 20 },
];

export default SNAKE_COLORS;
