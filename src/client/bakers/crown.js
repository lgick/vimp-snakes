import { Graphics, Rectangle } from 'pixi.js';

// Procedural texture of a crown — the badge of the monthly top ten
// (snakes-v3). Baked ONCE per canvas at startup, like the crystal: this
// package ships no images.
//
// Drawn WHITE and tinted in the part (`SNAKE.accolade.crownTint`), so the one
// texture serves every snake and every colour, and the crowns of a whole
// arena stay in one batch. Baked pointing UP (-y); `Snake._drawHead` rotates
// it by the facing angle.
//
// A baker owns what it returns. The engine re-bakes on a WebGL context restore
// and destroys the previous result together with its TextureSource, so never
// return a view onto a shared atlas or a texture someone else holds.
//
// `params` comes from parts.bakedAssets ({ size, points }); `renderer` is the
// Pixi renderer of the canvas being baked.
export default function crown(params, renderer) {
  const { size, points } = params;
  const graphics = new Graphics();

  // The band at the bottom and a zigzag of `points` spikes over it, both in a
  // square of `size`. The shape is deliberately blunt: at the scale a snake
  // wears it — around three times its radius across — anything finer reads as
  // a smudge.
  const band = size * 0.26;
  const top = size * 0.08;
  const bottom = size - band;
  const step = size / points;

  const path = [0, bottom];

  for (let i = 0; i < points; i += 1) {
    // the middle spike is the tall one, the flanking ones a step lower
    const middle = (points - 1) / 2;
    const drop = (Math.abs(i - middle) / (middle || 1)) * size * 0.18;

    path.push(i * step, top + drop);
    path.push((i + 0.5) * step, bottom * 0.55);
  }

  path.push(size, top + size * 0.18, size, bottom);

  graphics.poly(path);
  graphics.fill({ color: 0xffffff, alpha: 0.92 });

  graphics.rect(0, bottom, size, band);
  graphics.fill({ color: 0xffffff, alpha: 1 });

  const texture = renderer.generateTexture({
    target: graphics,
    frame: new Rectangle(0, 0, size, size),
  });

  graphics.destroy(true);

  return texture;
}
