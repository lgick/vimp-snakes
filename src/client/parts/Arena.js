import { Container, Graphics } from 'pixi.js';
import { ARENA } from '../../data/theme.js';

// The playfield: a disc. The engine splits MAP_DATA into one instance per
// render layer of `layers` (src/data/maps/arena.js) and hands each one:
//
//   { type: 'static', map, step, layer, tiles, physicsStatic, spriteSheet,
//     scale }
//
// Nothing here reads `tiles`. The grid of that map carries no geometry — every
// cell holds the same value and `physicsStatic` is empty — only a SIZE, and the
// disc is derived from it by the same formula the core uses (core/src/arena.rs):
//
//   radius = min(cols, rows) * step / 2,  centre = (cols * step / 2, rows * step / 2)
//
// The one entry in `layers` exists purely so this part gets constructed at all:
// the engine builds map parts by iterating that object, so an empty one means
// an empty canvas.
//
// Note what is NOT here: `step` arrives ALREADY multiplied by the map scale, so
// scaling the container again would draw the world twice as large as the
// simulation.
const RING_ALPHA = 0.5;

export default class Arena extends Container {
  constructor(data) {
    super();

    // Paint order is `zIndex` and nothing else: the engine marks the stage
    // sortable and calls stage.sortChildren() on every addChild, and PixiJS v8
    // sorts by zIndex there. A `layer` property alone does nothing at all.
    this.zIndex = 0;

    // an ARRAY is a row of the `c1` snapshot block — a movable body of the map,
    // live position included ([x, y, angle]). This map declares no
    // physicsDynamic, so no such row is ever packed; the branch exists so that
    // adding one is a drawing problem, not a crash inside the render tick.
    if (Array.isArray(data) || data.type === 'dynamic') {
      return;
    }

    this._draw(data);
  }

  _draw({ map, step }) {
    const rows = map.length;
    const cols = map[0]?.length ?? 0;

    const width = cols * step;
    const height = rows * step;
    const radius = Math.min(width, height) / 2;
    const cx = width / 2;
    const cy = height / 2;

    const { background, floor, edge, edgeWidth, rings, ringColor } = ARENA;
    const graphics = new Graphics();

    // the void outside the disc: a square behind everything, so the boundary
    // reads as an edge of the world rather than as a painted line on a floor
    graphics.rect(-width, -height, width * 3, height * 3);
    graphics.fill(background);

    graphics.circle(cx, cy, radius);
    graphics.fill(floor);

    // faint concentric rings — a snake at cruise speed over an empty floor has
    // nothing to judge its motion against
    for (let i = 1; i < rings; i += 1) {
      graphics.circle(cx, cy, (radius * i) / rings);
      graphics.stroke({ color: ringColor, width: 2, alpha: RING_ALPHA });
    }

    // the boundary itself, drawn INSIDE the radius (alignment 1) so that what
    // the player sees is exactly where the core kills them
    graphics.circle(cx, cy, radius);
    graphics.stroke({ color: edge, width: edgeWidth, alignment: 1 });

    this.addChild(graphics);
  }

  // the arena never changes between two MAP_DATA payloads: a new map arrives
  // as a CLEAR of this setId followed by fresh instances
  update() {}

  destroy() {
    super.destroy({ children: true });
  }
}
