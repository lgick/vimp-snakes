import { Graphics, Rectangle } from 'pixi.js';

// Procedural texture of a crystal: a faceted gem. Baked ONCE per canvas at
// startup, before any part exists — this is why the package ships no images.
//
// It is drawn WHITE and tinted per crystal in the part: one baked texture
// serves every colour and every tier (the part scales it), and the draw calls
// stay batched — which matters here, since sixty of these are on screen at
// once.
//
// A baker owns what it returns. The engine re-bakes on a WebGL context restore
// and destroys the previous result together with its TextureSource, so never
// return a view onto a shared atlas or a texture someone else holds.
//
// `params` comes from parts.bakedAssets ({ radius, facets }); `renderer` is the
// Pixi renderer of the canvas being baked.
export default function crystalGem(params, renderer) {
  const { radius, facets } = params;
  const size = radius * 2;
  const graphics = new Graphics();

  const point = (r, i, offset = 0) => {
    const angle = ((i + offset) / facets) * Math.PI * 2 - Math.PI / 2;

    return [radius + Math.cos(angle) * r, radius + Math.sin(angle) * r];
  };

  // outer body
  const outer = [];

  for (let i = 0; i < facets; i += 1) {
    outer.push(point(radius * 0.94, i));
  }

  graphics.poly(outer.flat());
  graphics.fill({ color: 0xffffff, alpha: 0.85 });

  // inner facet, rotated half a step: two overlapping polygons read as cut
  // stone once they are tinted, and cost one more draw call than one does
  const inner = [];

  for (let i = 0; i < facets; i += 1) {
    inner.push(point(radius * 0.5, i, 0.5));
  }

  graphics.poly(inner.flat());
  graphics.fill({ color: 0xffffff, alpha: 1 });

  const texture = renderer.generateTexture({
    target: graphics,
    frame: new Rectangle(0, 0, size, size),
  });

  graphics.destroy(true);

  return texture;
}
