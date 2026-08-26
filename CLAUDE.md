# CLAUDE.md

## Overview

`@vimp-games/snakes` is a game plugin for the VIMP engine: the engine owns
networking, rounds, chat, panel and stat; this package owns the game. Only
`dist/` is published. The full contract lives in the engine repository under
`docs/ai/` (`03-host-plugin`, `04-client-plugin`, `05-wasm-core`,
`06-snapshot-protocol`, `10-pitfalls`) — read it there, it is not copied here.

Snake arena: one circular map, always-moving snakes, `A`/`D` to turn, `W` to
boost at the cost of crystals, `R` to respawn. Crystals grow you and are the
score. The edge and other snakes' bodies kill; your own tail does not.

## Boundaries

- `src/host/` runs in a **Web Worker**: no DOM, no PixiJS, no `window`.
- `src/client/` runs in the **main thread**: PixiJS parts, bakers and the
  result screen.
- `core/` (Rust) owns **all** movement and collisions. There is no physics:
  a snake is a polyline and everything lethal is a distance test.
  `core/src/motion.rs` is shared by the host step and the client predictor —
  moving logic out of it desynchronises prediction from the server.

## Five decisions the code depends on

0. **Game ids are STRINGS.** The engine hands them out as
   `counter.toString(10)` and keys its participant Map by them, while the core
   writes them into `custom` events as numbers — everything crossing that seam
   goes through `String()`. Getting it wrong froze the panel and the stat
   table at zero (`tests/host/statBridge.integration.test.js` guards it).
1. **`CoreEvent::Death` is never emitted.** A round only ends through a
   reported kill, and there is no per-player respawn inside a round, so the
   core owns death and respawn outright. The engine therefore never writes
   `score`/`deaths` either — `src/host/StatBridge.js` does, off `custom`
   events, reached from `onCoreEvent` through a module-scope handle set in
   `createModules` (that hook's context is only `{ vimp, panel }`).
2. **The arena is derived from the map grid**, by one formula in
   `core/src/arena.rs`, `src/client/parts/Arena.js` and
   `src/data/maps/arena.js`. A free-form `gameConfig.parts.*` key reaches the
   client config but never a part and never the core, which is why the palette
   and the theme are plain imports (`src/data/palette.js`, `theme.js`). The
   grid size follows the crowd: the core reports a `population` custom event,
   `src/host/ArenaScaler.js` rebuilds the map with `buildArena(count)` and
   hot-swaps it through `coreAdapter.createMap` + `socketManager.sendMap` —
   never through the engine's own map change, which would wipe the scores.
3. **Turning has one function, two sources.** Keys and the pointer target
   (`MoveInput.aim`, a world point from the engine's `apply_aim`) both reduce
   to the clamped step of `motion::step_angle`, so a mouse never out-turns
   `turnSpeed` — and the target must enter the predictor's input history
   (`InputSnapshot`), not just the key mask.
4. **The player block carries `cos`/`sin`, not the angle.** The drift detector
   compares components numerically, and a raw angle crossing ±PI reads there as
   a 6.28 rad divergence.

## Contract constants

- `ENGINE_API_VERSION` is always imported from
  `vimp-engine/config/opcodes.js`, never written as a literal.
- `PLAYER_STATE_LEN = 8` — `[x, y, cos, sin, crystals, length, alive, grace]`;
  the last slot is the spawn grace, and the predictor freezes on it.
- `SPINE_POINTS = 16` — the resampled body carried per snake row. Declared in
  `src/config/snapshot.js`, `core/src/motion.rs` and
  `src/client/parts/Snake.js`; `tests/config/contract.test.js` compares them.
- `players_json()` must emit rows in **schema order**: it is the payload a
  joining client gets as its first full frame.
- Hot snapshot buffers are `indexed8` / `indexedNoNull8` only; crystals are an
  `indexed32` **delta** block (`cr`), re-sent in full whenever an actor spawns.
- `src/config/auth.js` must declare the `model` parameter — the engine expects
  that exact name.

## Order of work

1. snapshot schema and `src/config/` — decide what travels the wire first;
2. Rust simulation in `core/`, with `npm run core:test` green (the parity suite
   in `core/src/client/predictor.rs` is the one that catches a movement change
   applied to only one half);
3. `npm run check:contract` and `npm run sim` — the machine reads the
   invariants the browser only hints at;
4. rendering: `src/client/parts/` and bakers.

## Commands

```bash
npm run core:build      # REQUIRED before npm run dev
npm run core:test
npm run check:contract
npm test && npx eslint .
npm run build
npm run dev
```

Headless run, from the **engine** checkout with this package linked:

```bash
npm run sim -- --game <path to vimp-snakes> --scenario <path>/scenarios/<name>.json
```

The sim loads the **built** plugin, so `npm run build` first or you are
testing the previous version. `scenarios/` holds five: `movement`
(drift-watching), `crash-and-respawn`, `growth` (bots, crystals, boost),
`pointer` (mouse/touch steering, also drift-watching) and `bots` (`/bot` as a
set: 6 → 2 → refused → 0). All pass with `--determinism`; `roundLifecycle`
skips by design, this game has no round end.

Chat commands: the engine parses **none** of its own, so `chatCommands` in
`src/host/index.js` is the whole set a player can type — `/bot <count>`
(exact number of bots, `/bot 0` clears them) plus `/name`, `/nr`, `/rank` from
`src/host/metaCommands.js`. `/timeleft` and `/mapname` are deliberately absent:
this game has no round or map that ends.

Any functional change updates the tests covering it in the same change;
`npx eslint .` and `npm test` end every change green.
