import { describe, it, expect, vi } from 'vitest';
import { Texture } from 'pixi.js';
import parts from '../../src/client/parts/index.js';
import crystalGem from '../../src/client/bakers/crystalGem.js';
import crown from '../../src/client/bakers/crown.js';
import mapData from '../../src/data/maps/arena.js';
import { CRYSTAL_TIERS } from '../../src/data/palette.js';

// Parts are constructed inside the render tick, on a path with no try/catch
// anywhere: an exception in a constructor aborts the whole frame, so every
// entity of that frame is lost with it. These cases only build them — no WebGL
// context is created in happy-dom.
const { Arena, Snake, Crystal } = parts;

const SPINE_POINTS = 16;

/// A snake row: 16 spine points, then angle, radius, crystals, colour, flags
/// (bit 0 boost, bit 1 spawn grace).
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

/// The engine's `accolades` service, reduced to the one method a part uses.
/// It always answers with an object: a bot, a guest or anybody outside the top
/// gets two nulls, and that is the normal path, not a failure.
function accoladesFor(places = {}) {
  return {
    placeOf: () => ({ daily: null, monthly: null, ...places }),
  };
}

/// The engine's `localPlayer` service, reduced to the one method a part uses.
/// Ids arrive as object keys of the frame, so they are strings on both sides.
function localPlayerFor(myId) {
  return { is: id => String(id) === String(myId) };
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

  it('blinks while the spawn grace bit is set and stops when it clears', () => {
    const snake = new Snake(snakeRow({ boost: 0b10 }));

    // the pulse never reaches full opacity, so «in grace» is readable at any
    // instant of it
    expect(snake.alpha).toBeLessThan(1);
    expect(snake.alpha).toBeGreaterThan(0);

    snake.update(snakeRow({ boost: 0 }));

    expect(snake.alpha).toBe(1);

    snake.destroy();
  });

  it('still draws the boost glow while the grace bit is set too', () => {
    const points = [[100, 200], [40, 200]];
    const snake = new Snake(snakeRow({ points }));
    const stroke = vi.spyOn(snake._body, 'stroke');

    // body + inner core, and nothing else
    snake.update(snakeRow({ points, boost: 0 }));
    expect(stroke).toHaveBeenCalledTimes(2);

    // bits 0 and 1 at once: blinking AND boosting — the glow is the third
    stroke.mockClear();
    snake.update(snakeRow({ points, boost: 0b11 }));

    expect(stroke).toHaveBeenCalledTimes(3);
    expect(snake.alpha).toBeLessThan(1);

    snake.destroy();
  });

  it('plays a positional pickup when its crystal count goes up', () => {
    const soundManager = { registerSound: vi.fn() };
    const snake = new Snake(
      snakeRow({ crystals: 3 }),
      {},
      { soundManager, localPlayer: localPlayerFor('01') },
      { id: '01' },
    );

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
    const snake = new Snake(
      snakeRow({ points: [[7, 9]] }),
      {},
      { soundManager, localPlayer: localPlayerFor('01') },
      { id: '01' },
    );

    snake.destroy();

    expect(soundManager.registerSound).toHaveBeenCalledWith('death', {
      position: { x: 7, y: 9 },
    });
  });

  it('survives a part with no sound manager at all', () => {
    const snake = new Snake(snakeRow());

    expect(() => snake.destroy()).not.toThrow();
  });

  it('says nothing for somebody else\'s snake', () => {
    const soundManager = { registerSound: vi.fn() };
    // built for entity '02' while the local player is '01'
    const snake = new Snake(
      snakeRow({ crystals: 3 }),
      {},
      { soundManager, localPlayer: localPlayerFor('01') },
      { id: '02' },
    );

    snake.update(snakeRow({ points: [[10, 20]], crystals: 6 }));
    snake.destroy();

    // the crystal was still drawn as eaten and the body still left the canvas
    // — only the two cues are gone
    expect(soundManager.registerSound).not.toHaveBeenCalled();
  });

  it('asks who the local player is at cue time, not at construction', () => {
    const soundManager = { registerSound: vi.fn() };
    // the local snake is built from the first shot, BEFORE the first player
    // block: the engine answers null until then, and a flag cached in the
    // constructor would mute the player for the whole match
    let myId = null;
    const localPlayer = { is: id => myId !== null && id === myId };
    const snake = new Snake(
      snakeRow({ crystals: 3 }),
      {},
      { soundManager, localPlayer },
      { id: '01' },
    );

    myId = '01';
    snake.update(snakeRow({ points: [[10, 20]], crystals: 6 }));

    expect(soundManager.registerSound).toHaveBeenCalledWith('pickup', {
      position: { x: 10, y: 20 },
    });

    snake.destroy();
  });

  it('stays silent, loudly, on an engine without the localPlayer service', () => {
    const soundManager = { registerSound: vi.fn() };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const snake = new Snake(snakeRow({ crystals: 3 }), {}, { soundManager }, { id: '01' });

    snake.update(snakeRow({ crystals: 6 }));
    snake.destroy();

    expect(soundManager.registerSound).not.toHaveBeenCalled();
    // once per part, not once per cue
    expect(error).toHaveBeenCalledTimes(1);

    error.mockRestore();
  });

  // ***** the top-ten badges *****

  it('wears nothing at all without a place in either top', () => {
    const snake = new Snake(
      snakeRow(),
      { crown: Texture.EMPTY },
      { accolades: accoladesFor() },
      { id: '01' },
    );
    const fill = vi.spyOn(snake._body, 'fill');

    snake.update(snakeRow());

    // the body is two strokes and no fill; the crown exists but is hidden
    expect(fill).not.toHaveBeenCalled();
    expect(snake._crown.visible).toBe(false);

    snake.destroy();
  });

  it('draws the daily diamonds down the body', () => {
    const points = Array.from({ length: SPINE_POINTS }, (_, i) => [
      1000 - i * 60,
      1000,
    ]);
    const plain = new Snake(snakeRow({ points }), {}, {}, { id: '01' });
    const plainFill = vi.spyOn(plain._body, 'fill');

    plain.update(snakeRow({ points }));
    expect(plainFill).not.toHaveBeenCalled();

    const top = new Snake(
      snakeRow({ points }),
      {},
      { accolades: accoladesFor({ daily: 4 }) },
      { id: '01' },
    );
    const topFill = vi.spyOn(top._body, 'fill');

    top.update(snakeRow({ points }));

    // one fill per diamond, spaced along the curve — a long snake wears
    // several of them
    expect(topFill.mock.calls.length).toBeGreaterThan(1);

    plain.destroy();
    top.destroy();
  });

  it('shows the monthly crown over the head and turns it with the snake', () => {
    const snake = new Snake(
      snakeRow({ points: [[10, 20]], angle: 0, radius: 20 }),
      { crown: Texture.EMPTY },
      { accolades: accoladesFor({ monthly: 1 }) },
      { id: '01' },
    );

    expect(snake._crown.visible).toBe(true);
    // baked pointing up, worn along the facing
    expect(snake._crown.rotation).toBeCloseTo(Math.PI / 2);

    snake.update(snakeRow({ points: [[10, 20]], angle: Math.PI, radius: 20 }));

    expect(snake._crown.rotation).toBeCloseTo(Math.PI + Math.PI / 2);

    snake.destroy();
  });

  it('wears both badges at once', () => {
    const points = [[100, 200], [40, 200], [-20, 200]];
    const snake = new Snake(
      snakeRow({ points }),
      { crown: Texture.EMPTY },
      { accolades: accoladesFor({ daily: 2, monthly: 9 }) },
      { id: '01' },
    );
    const fill = vi.spyOn(snake._body, 'fill');

    snake.update(snakeRow({ points }));

    expect(fill).toHaveBeenCalled();
    expect(snake._crown.visible).toBe(true);

    snake.destroy();
  });

  it('asks for the place at draw time, not at construction', () => {
    // the places arrive on their own port long after the first shot the part
    // is built from, and they change while the match runs: a badge decided in
    // the constructor would be missing for exactly the players who have one
    let places = { daily: null, monthly: null };
    const snake = new Snake(
      snakeRow(),
      { crown: Texture.EMPTY },
      { accolades: { placeOf: () => places } },
      { id: '01' },
    );

    expect(snake._crown.visible).toBe(false);

    places = { daily: 1, monthly: 1 };
    snake.update(snakeRow());

    expect(snake._crown.visible).toBe(true);

    // and it is taken away again the moment the place is lost
    places = { daily: null, monthly: null };
    snake.update(snakeRow());

    expect(snake._crown.visible).toBe(false);

    snake.destroy();
  });

  it('survives an engine with no accolades service and no baked crown', () => {
    const snake = new Snake(snakeRow(), {}, {}, { id: '01' });

    expect(() => snake.update(snakeRow())).not.toThrow();
    expect(snake._crown).toBe(null);
    expect(snake.children.length).toBe(2);

    snake.destroy();
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

describe('crown baker', () => {
  it('bakes a square of the size it is given', () => {
    const renderer = { generateTexture: vi.fn(() => Texture.EMPTY) };
    const texture = crown({ size: 64, points: 3 }, renderer);

    expect(texture).toBe(Texture.EMPTY);

    const [{ frame }] = renderer.generateTexture.mock.calls[0];

    expect(frame.width).toBe(64);
    expect(frame.height).toBe(64);
  });
});
