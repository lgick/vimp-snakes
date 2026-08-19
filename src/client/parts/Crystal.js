import { Container, Sprite } from 'pixi.js';
import { CRYSTAL_COLORS, CRYSTAL_TIERS } from '../../data/palette.js';

// One crystal. The engine builds it from the `cr` snapshot block and feeds it
// the field array of that block, in the order of src/config/snapshot.js:
//
//   [x, y, tier, colour]
//
// That block is `indexed32` + class `event` and is packed as a DELTA — a row
// when a crystal appears, a null row when it is eaten — so this class is
// constructed exactly once per crystal and destroyed exactly once. It never
// receives a second row and never animates: crystals do not move.
//
// Deliberately silent on destroy. The pickup cue is played by `Snake` when its
// crystal count goes up, because that is the event a player cares about, and
// because a map change destroys the whole field at once — which from here is
// indistinguishable from sixty simultaneous pickups.
const FIELD = {
  X: 0,
  Y: 1,
  TIER: 2,
  COLOR: 3,
};

/// Radius the baker drew at; the sprite is scaled from it to the tier size.
const BAKED_RADIUS = 32;

export default class Crystal extends Container {
  constructor(data, assets) {
    super();

    // above the arena floor, below the snakes
    this.zIndex = 2;

    this._sprite = new Sprite(assets.crystalGem);
    this._sprite.anchor.set(0.5);

    this.addChild(this._sprite);

    this.update(data);
  }

  update(data) {
    this.x = data[FIELD.X] || 0;
    this.y = data[FIELD.Y] || 0;

    const tier = CRYSTAL_TIERS[data[FIELD.TIER] || 0] ?? CRYSTAL_TIERS[0];

    this._sprite.scale.set(tier.radius / BAKED_RADIUS);

    // the index is free-running on the wire, so the palette can grow without
    // the core ever learning how long it is
    this._sprite.tint =
      CRYSTAL_COLORS[(data[FIELD.COLOR] || 0) % CRYSTAL_COLORS.length];

    // a fixed rotation derived from the position, so a field of crystals does
    // not read as a grid of identical stamps. Deterministic on purpose: every
    // client must draw the same crystal the same way.
    this._sprite.rotation = ((this.x + this.y) % 360) * (Math.PI / 180);
  }

  destroy() {
    // `true` destroys the children as well; the baked texture is NOT ours to
    // destroy — the engine re-uses it for every crystal on this canvas
    super.destroy({ children: true });
  }
}
