# CLAUDE.md

## Overview

`@vimp-games/snakes` is a game plugin for the VIMP engine: the engine owns
networking, rooms, chat, panel and stat; this package owns the game. Only
`dist/` is published. The plugin contract lives in the engine repo under
`docs/ai/` — read it there.

## Documentation

Bilingual docs live in `docs/en/` (canonical, ToC at `docs/en/README.md`) and
`docs/ru/` (identical structure). **Rule**: any functional change updates the
matching `docs/en/` and `docs/ru/` pages in the same change. Area → page:

- `src/config/*`, `src/data/*` → `configuration.md`
- rules (controls, crystals, boost, crashes, score/rank, bots, commands) →
  `gameplay.md`
- `core/` (the Rust simulation and the WASM ABI) → `core.md`
- `src/host/*`, `src/client/*` wiring → `architecture.md`
- new model/tier/colour/sound/part/command/map → `extending.md`
- build/link/test setup, `scenarios/`, the dev harness → `getting-started.md`

Engine-side concepts belong to the engine's repo — link out, don't duplicate.

## Boundaries

- `src/host/` runs in a **Web Worker**: no DOM, no PixiJS, no `window`.
- `src/client/` runs in the **main thread**: PixiJS parts, bakers, overlay.
- `core/` (Rust) owns **all** movement and collisions. There is no physics: a
  snake is a polyline and everything lethal is a distance test.
  `core/src/motion.rs` is shared by the host step and the client predictor —
  moving logic out of it desynchronises prediction from the server.

## The decisions the code depends on

Full reasoning: `docs/en/architecture.md`. In short:

0. **Game ids are STRINGS** on the engine side and numbers in core events —
   everything crossing that seam goes through `String()`.
1. **`CoreEvent::Death` is never emitted**: the core owns death and respawn, so
   `src/host/StatBridge.js` owns `score` *and* `rank` (a point per kill plus
   one per `CRYSTALS_PER_RANK` eaten, flushed with `vimp.flushPlayerData()`).
   `noSpectators` + `endlessRound` in `src/config/game.js` make that official.
2. **The arena is derived from the map grid** by one formula in
   `core/src/arena.rs`, `src/client/parts/Arena.js`, `src/data/maps/arena.js`,
   and it grows with the crowd through `src/host/ArenaScaler.js` — never
   through the engine's own map change, which would wipe the scores.
3. **Turning has one function, two sources**: keys and the pointer target both
   reduce to `motion::step_angle`, and the target must enter the predictor's
   input history.
4. A free-form `gameConfig.parts.*` key reaches the client config but never a
   part and never the core — hence the plain imports of `palette.js`/`theme.js`
   and the `world` block nested in the snake model.

## Contract constants

- `ENGINE_API_VERSION` is always imported from `vimp-engine/config/opcodes.js`.
- `PLAYER_STATE_LEN = 8` — `[x, y, cos, sin, crystals, length, alive, grace]`:
  cos/sin, not the angle, and grace in SECONDS, not a flag.
- `SPINE_POINTS = 16` — declared in `src/config/snapshot.js`,
  `core/src/motion.rs` and `src/client/parts/Snake.js`; the contract test
  compares them.
- `players_json()` emits rows in **schema order** (a joining client's first
  full frame); hot blocks are `indexed8`/`indexedNoNull8` only; `cr` is an
  `indexed32` delta re-sent in full on every actor spawn.
- `src/config/auth.js` must declare the `model` parameter under that name.

## Order of work

Snapshot schema and `src/config/` → the Rust simulation with
`npm run core:test` green (the parity suite in
`core/src/client/predictor.rs` catches a movement change applied to one half
only) → `npm run check:contract` and `npm run sim` → rendering.

## Commands

```bash
npm run core:build      # REQUIRED before npm run dev
npm run core:test
npm run check:contract
npm test && npx eslint .
npm run build
npm run dev
```

The headless runner lives in the engine checkout and loads the **built**
plugin (`npm run build` first); `scenarios/` holds five, all passing with
`--determinism`. See `docs/en/getting-started.md`.

Any functional change updates the tests covering it in the same change;
`npx eslint .` and `npm test` end every change green.
