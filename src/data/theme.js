// Look of the arena. Imported straight by `src/client/parts/Arena.js`, NOT
// routed through the config.
//
// The tempting alternative — a `gameConfig.parts.arena` object — does not
// reach a part: a part is constructed with `(data, assets, dependencies)`, and
// `dependencies` can only ever hold the three engine services (`renderer`,
// `soundManager`, `assetsBase`). Anything else named there is silently
// `undefined`, which is the quietest way there is to draw nothing. A plain
// import is bundled into the client and cannot go missing.
export const ARENA = {
  // the void outside the disc
  background: 0x0d1220,
  // the disc itself
  floor: 0x141c30,
  // the boundary that kills, drawn inside the radius so what is seen is what
  // the core enforces
  edge: 0x39507f,
  edgeWidth: 10,
  // faint concentric rings: a snake at cruise speed over an empty floor has
  // nothing to judge its motion against
  rings: 4,
  ringColor: 0x1d2947,
};

export const SNAKE = {
  // darker core stroke laid over the body, for a rounded look
  innerScale: 0.62,
  innerDarken: 0.55,
  // Catmull-Rom subdivisions per spine segment. 16 points * 4 is 60 vertices —
  // smooth at any body length and still one stroke.
  smoothing: 4,
  eye: 0xf7fbff,
  pupil: 0x101828,
  boostGlow: 0xffe98a,

  // ***** the top-ten badges (snakes-v3) *****
  //
  // A place in the game's global top is drawn on the snake itself: a diamond
  // pattern down the body for the daily top ten, a crown over the head for the
  // monthly one. Both are worn by the CURRENT place — lose it and it is gone
  // the moment the host resends the places.
  accolade: {
    // diamonds: how far apart along the smoothed curve they sit and how big
    // they are, both in body radii, so the pattern scales with the snake
    // instead of turning into dots on a fat one
    diamondEvery: 1.6,
    diamondLong: 0.9,
    diamondWide: 0.55,
    // the diamond is the body colour lifted towards white
    diamondLighten: 0.55,
    // the crown sprite: size in radii, and how far along the facing it is
    // pushed off the head's centre, also in radii — it rides the forehead
    // rather than the middle of the head
    crownScale: 1.9,
    crownLift: 0.44,
    crownTint: 0xffd76b,
  },
};

export default ARENA;
