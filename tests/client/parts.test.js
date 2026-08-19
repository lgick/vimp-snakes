import { describe, it, expect, vi } from 'vitest';
import { Texture } from 'pixi.js';
import parts from '../../src/client/parts/index.js';
import crystalGem from '../../src/client/bakers/crystalGem.js';
import mapData from '../../src/data/maps/arena.js';
import { CRYSTAL_TIERS } from '../../src/data/palette.js';

// Parts are constructed inside the render tick, on a path with no try/catch
// anywhere: an exception in a constructor aborts the whole frame, so every
// entity of that frame is lost with it. These cases only build them — no WebGL
// context is created in happy-dom.
const { Arena, Snake, Crystal } = parts;

const SPINE_POINTS = 16;

/// A snake row: 16 spine points, then angle, radius, crystals, colour, boost.
/// `points` is head-first; missing ones collapse onto the head, the way a
/// just-spawned snake arrives.
function snakeRow({ points = [[100, 200]], angle = 0, radius = 14, crystals = 0, color = 0, boost = 0 } = {}) {
  const row = [];

  for (let i = 0; i < SPINE_POINTS; i += 1) {
    const [x, y] = points[Math.min(i, points.length - 1)];

    row.push(x, y);
  }

  row.push(angle, radius, crystals, color, boost);

  return row;
}

describe('Snake', () => {
  it('reads the head out of the first spine point', () => {
    const snake = new Snake(snakeRow({ points: [[100, 200]] }));

    // the graphics carry world coordinates, so the container itself stays at
    // the origin — see the note in Snake.js
    expect(snake.x).toBe(0);
    expect(snake.zIndex).toBe(3);
    expect(snake.children.length).toBe(2);

    snake.destroy();
  });

  it('draws a body of any length without throwing', () => {
    const points = Array.from({ length: SPINE_POINTS }, (_, i) => [
      1000 - i * 60,
      1000 + Math.sin(i) * 40,
    ]);

    const snake = new Snake(snakeRow({ points, radius: 28, crystals: 80 }));

    expect(() => snake.update(snakeRow({ points, boost: 1 }))).not.toThrow();

    snake.destroy();
  });

  it('plays a positional pickup when its crystal count goes up', () => {
    const soundManager = { registerSound: vi.fn() };
    const snake = new Snake(snakeRow({ crystals: 3 }), {}, { soundManager });

    // the first row establishes the baseline and must not fire
    expect(soundManager.registerSound).not.toHaveBeenCalled();

    snake.update(snakeRow({ points: [[10, 20]], crystals: 6 }));

    expect(soundManager.registerSound).toHaveBeenCalledWith('pickup', {
      position: { x: 10, y: 20 },
    });

    // …and a row that changes nothing else must not fire either
    soundManager.registerSound.mockClear();
    snake.update(snakeRow({ points: [[10, 20]], crystals: 6 }));

    expect(soundManager.registerSound).not.toHaveBeenCalled();

    snake.destroy();
  });

  it('plays the death cue at the head it last had', () => {
    const soundManager = { registerSound: vi.fn() };
    const snake = new Snake(snakeRow({ points: [[7, 9]] }), {}, { soundManager });

    snake.destroy();

    expect(soundManager.registerSound).toHaveBeenCalledWith('death', {
      position: { x: 7, y: 9 },
    });
  });

  it('survives a part with no sound manager at all', () => {
    const snake = new Snake(snakeRow());

    expect(() => snake.destroy()).not.toThrow();
  });
});

describe('Arena', () => {
  it('draws the disc from the map it is handed', () => {
    const [layer, tiles] = Object.entries(mapData.layers)[0];
    const part = new Arena({
      type: 'static',
      map: mapData.map,
      step: mapData.step,
      layer,
      tiles,
      physicsStatic: mapData.physicsStatic,
      scale: mapData.scale,
    });

    // under everything else
    expect(part.zIndex).toBe(0);
    expect(part.children.length).toBe(1);

    part.destroy();
  });

  it('survives a dynamic body it has nothing to draw for', () => {
    const part = new Arena({ type: 'dynamic', layer: 2, angle: 0 });

    expect(part.children.length).toBe(0);

    part.destroy();
  });
});

describe('Crystal', () => {
  const assets = { crystalGem: Texture.EMPTY };

  it('places and sizes itself by the snapshot row', () => {
    // [x, y, tier, colour] — the cr block of src/config/snapshot.js
    const crystal = new Crystal([300, 400, 2, 1], assets);

    expect(crystal.x).toBe(300);
    expect(crystal.y).toBe(400);
    expect(crystal.zIndex).toBe(2);
    expect(crystal.children[0].scale.x).toBeCloseTo(CRYSTAL_TIERS[2].radius / 32);

    crystal.destroy();
  });

  it('takes the colour index modulo the palette, so the core need not know it', () => {
    const low = new Crystal([0, 0, 0, 1], assets);
    const wrapped = new Crystal([0, 0, 0, 1 + 6 * 40], assets);

    expect(wrapped.children[0].tint).toBe(low.children[0].tint);

    low.destroy();
    wrapped.destroy();
  });

  it('falls back to the smallest tier for an index it does not know', () => {
    const crystal = new Crystal([0, 0, 99, 0], assets);

    expect(crystal.children[0].scale.x).toBeCloseTo(CRYSTAL_TIERS[0].radius / 32);

    crystal.destroy();
  });
});

describe('crystalGem baker', () => {
  it('bakes through the renderer it is given', () => {
    const renderer = { generateTexture: vi.fn(() => Texture.EMPTY) };
    const texture = crystalGem({ radius: 32, facets: 6 }, renderer);

    expect(renderer.generateTexture).toHaveBeenCalled();
    expect(texture).toBe(Texture.EMPTY);
  });
});
