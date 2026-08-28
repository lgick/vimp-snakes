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

    // ***** the two badge inks *****
    //
    // A badge is painted in one of these and outlined in the other; which is
    // which is decided per body colour by `badgeInk` in
    // `src/client/parts/Snake.js`. The ink is NOT mixed with the body colour,
    // and that is the whole point: a badge lightened out of the body vanishes
    // on exactly the snakes whose body is already light — a white snake's
    // diamond came out at 1.04:1 against it, which is invisible.
    //
    // `inkDark` is the tone of `pupil` above, so eyes and badges speak one
    // language.
    inkDark: 0x101828,
    inkLight: 0xfdfdff,
    // the diamond's outline, in the ink it is NOT filled with, as a fraction
    // of the body radius: it reads over the outer stroke and the darker inner
    // one alike, and over the boost glow
    diamondStroke: 0.18,

    // the crown sprite: size in radii, and how far along the facing it is
    // pushed off the head's centre, also in radii — it rides the forehead
    // rather than the middle of the head
    crownScale: 1.9,
    crownLift: 0.44,
    // gold is the crown's identity and stays, but gold on a yellow head is
    // 1.04:1 — so the crown is drawn twice, a dark silhouette slightly larger
    // underneath and the gold one on top. `crownOutlineScale` is how much
    // larger, as a multiplier of the sprite's scale
    crownTint: 0xffd76b,
    crownOutline: 0x101828,
    crownOutlineScale: 1.16,
  },
};

export default ARENA;
