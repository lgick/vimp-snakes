import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { buildCoreConfig } from 'vimp-engine/lib/coreConfig.js';
import { SNAPSHOT_FORMAT_VERSION } from 'vimp-engine/config/opcodes.js';
import wsports from 'vimp-engine/config/wsports.js';
import gameConfig from '../../src/config/game.js';
import models from '../../src/data/models.js';
import mapData from '../../src/data/maps/arena.js';

// The `integration` project (node environment): the REAL Rust core, driven
// through the --target nodejs build, from the config the ENGINE assembles out
// of src/config/game.js. That combination is what makes this file worth
// having — `cargo test` proves the core is self-consistent, and this proves it
// agrees with the JavaScript.
//
// The Node build is not part of `npm test`, so without `npm run
// core:build:node` there is nothing to import and the whole file is skipped: a
// fresh checkout must not fail here, it must tell you the core is missing.
const gluePath = fileURLToPath(
  new URL('../../core/pkg-node/vimp_snakes_core.js', import.meta.url),
);

const hasCore = existsSync(gluePath);

const STEP = 1 / 120;

// A freshly spawned snake is frozen for `spawnGraceSeconds`: it neither moves
// nor kills nor dies (core/src/game.rs). Every case that wants to watch the
// snake MOVE has to burn that off first, or it measures a snake standing on
// its spawn point.
const GRACE_STEPS = Math.ceil(models.s1.world.spawnGraceSeconds / STEP) + 1;

const run = (core, steps) => {
  for (let i = 0; i < steps; i += 1) {
    core.step(STEP);
  }
};

describe.skipIf(!hasCore)('the Rust core through pkg-node', () => {
  const boot = async (options = {}) => {
    const { GameCore } = await import(gluePath);

    return new GameCore(JSON.stringify(buildCoreConfig(gameConfig, options)));
  };

  it('boots from the config the engine assembles', async () => {
    // This is the cross-language check. `SnakesConfig::validate` refuses a
    // config whose models are shaped differently than core/src/config.rs
    // expects, or whose panel is missing a field the core writes — so a
    // rename in src/config/game.js or src/data/models.js that the Rust side
    // has not followed throws right here, instead of as a HUD cell that never
    // updates.
    await expect(boot()).resolves.toBeTruthy();
  });

  it('drives a snake from the respawn the map declares', async () => {
    // a fixed seed: two runs of this test must produce the same match
    const core = await boot({ seed: 1 });

    core.load_map(JSON.stringify(mapData));

    // the second point, not the first: point 0 sits all but on the centre, and
    // a snake that drives through it comes out the far side further away than
    // it started
    const [x, y, angle] = mapData.respawns.players[1];

    core.spawn_actor(1, 's1', 1, x, y, angle);

    expect(core.is_alive(1)).toBe(true);

    // the spawn grace, then 120 steps of 1/120 s — the engine's own fixed
    // step. No key is held: a snake is always moving, which is the rule that
    // separates this game from everything the template ships.
    run(core, GRACE_STEPS + 120);

    const moved = core.position_of(1);
    const centre = (mapData.map.length * mapData.step) / 2;
    const distance = point => Math.hypot(point[0] - centre, point[1] - centre);

    // that respawn faces the centre of the disc — fanned off it by up to 25
    // degrees so that neighbours do not converge — so it drove inwards
    expect(distance(moved)).toBeLessThan(distance([x, y]));
  });

  it('turns on the key names the client binds', async () => {
    const core = await boot({ seed: 1 });

    core.load_map(JSON.stringify(mapData));

    const [x, y, angle] = mapData.respawns.players[0];

    core.spawn_actor(1, 's1', 1, x, y, angle);

    // 'right' is a name from gameConfig.playerKeys; the core resolves it to a
    // bit itself, and an unknown name is silently a no-op — which is exactly
    // what this asserts is not happening
    core.apply_input(1, 1, 'down', 'right');

    run(core, GRACE_STEPS + 120);

    expect(Math.abs(core.position_of(1)[1] - y)).toBeGreaterThan(20);
  });

  it('packs a frame the client half can be given', async () => {
    const core = await boot({ seed: 1 });

    core.load_map(JSON.stringify(mapData));

    const [x, y, angle] = mapData.respawns.players[0];

    core.spawn_actor(1, 's1', 1, x, y, angle);

    for (let i = 0; i < 60; i += 1) {
      core.step(1 / 120);
    }

    core.pack_body();
    core.pack_frame(1000, 1, false, 0, 0, false, null, 1);

    const bytes = core.frame_bytes();

    // the v3 frame header: [0] port, [1] version, then seq and serverTime
    expect(bytes[0]).toBe(wsports.server.SHOT_DATA);
    expect(bytes[1]).toBe(SNAPSHOT_FORMAT_VERSION);
    expect(bytes.length).toBeGreaterThan(14);
  });
});

describe.skipIf(hasCore)('the Rust core', () => {
  it('is not built — run `npm run core:build:node`', () => {
    expect(hasCore).toBe(false);
  });
});
