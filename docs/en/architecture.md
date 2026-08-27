# Architecture (game plugin)

`vimp-snakes` is a **dynamic plugin** for the [VIMP engine](https://github.com/lgick/vimp-engine)
(published as `vimp-engine` / `vimp-engine-core`): a free-for-all snake arena
running entirely on the engine's P2P infrastructure (authoritative browser
host, WebRTC clients, Node.js master for lobby/signaling). This repo owns only
the game — transport, rooms, chat, the stat table, Worker handoff and the
client MVC/render framework live in the engine; see its
[architecture.md](https://github.com/lgick/vimp-engine/blob/main/docs/en/architecture.md)
for the full picture and the ADR on the engine/game split.

## Repository layout

```
index.html / vite.config.js — the plugin's Vite root (dev harness + two builds)
dev/main.js  — the standalone dev harness (`npm run dev`), never published
src/
  host/      — HostPlugin: core-event router, StatBridge (scoring), ArenaScaler
               (the map that grows with the crowd), ScriptedManager (bots),
               chat commands, g:* system messages
  client/    — ClientPlugin: parts/ (PixiJS entities), bakers/ (the crystal
               and crown textures), gameOver.js (the result overlay), game CSS
  config/    — game config halves (game.js, client.js, auth.js, sounds.js,
               snapshot.js)
  data/      — static data: maps/arena.js, models.js, palette.js, theme.js,
               weapons.js (empty by contract)
  host/nodeCore.js — one branch shared by both plugin halves: browser wasm
               asset vs Node glue (headless runs)
core/        — vimp-snakes-core (Rust → WASM, pkg-web/pkg-node): movement,
               collisions, crystals, bots, prediction (see core.md)
assets/      — authored inputs: audio-raw/ (raw sounds) and sounds/ (ready-made
               fallbacks); there are no images — every texture is baked
scenarios/   — headless scenarios for the engine's `npm run sim`
scripts/     — audio processing, image copy, map export to JSON, manifest
tests/       — host modules, client parts, config contracts, the JS↔WASM harness
```

`src/config/` and `src/data/` are read by the engine's host Worker, the client
bundle, and (for maps) the engine's master — all through the plugin contract
(`HostPlugin.gameConfig`, `ClientPlugin`, `GameManifest`), never by direct
import.

## How this plugin plugs into the engine

- **Host**: `host.worker.js` in the engine dynamically imports this package's
  `entries.host` (`src/host/index.js`, the `HostPlugin` default export) and
  calls `createCore()`, which loads this repo's WASM core. `ScriptedManager`
  implements the engine's scripted-module contract
  (`createMap`/`getCountsPerTeam`/`createScripted`/`removeScripted`/
  `removeOneForHuman`).
- **Client**: the engine's client dynamically imports `entries.client`
  (`src/client/index.js`, the `ClientPlugin` default export) after a room is
  picked, and calls `createClientCore()` — which must return
  `{ core, memory }`, the WASM memory being what the engine reads the hot
  buffer out of every render tick.
- **Both entries take `wasmUrl` in two shapes**: the hashed `.wasm` asset in a
  browser, and a `file:` URL of the Node glue (`entries.wasmNode`) under the
  engine's headless runner. The branch lives in `src/host/nodeCore.js` and is
  shared by both halves on purpose — a headless run on a different core than
  the browser's would prove nothing.
- **Master**: never executes plugin code — it only serves this package's
  `dist/manifest.json` and the exported map JSON under `/games/snakes/*`.

Full contract — the engine's
[plugin-api.md](https://github.com/lgick/vimp-engine/blob/main/docs/en/plugin-api.md).

## The core's boundary

Simulation only: movement, growth, collisions, the crystal field, bots and the
binary frame packing live in `core/` (Rust/WASM). Meta (chat, the stat table,
the participant registry, rooms, auth) is engine-owned JS, parameterised by
this plugin's config — with one deliberate exception, the scoring, which this
game writes itself (see below).

**There is no physics.** A snake is a polyline; the arena edge, other bodies
and crystals are distance tests. The engine's Rapier world is stepped and
stays empty. That is what makes the client's prediction exact — the predictor
runs the same `core/src/motion.rs` the host does, with no solver in between to
disagree about.

## The client side

Two of the engine's three network-smoothing mechanisms are used here:

- **Prediction** (`core/src/client/predictor.rs`): the local snake is
  simulated by a replica of the authoritative motion model (formulas shared
  with the authoritative side via `core/src/motion.rs`); the host confirms
  input (`lastInputSeq`), reconciliation replays unconfirmed input, and the
  discrepancy decays smoothly. The spawn grace is counted down by both halves
  in step, so the replica starts moving on the same tick the host does.
- **Interpolation** is fully engine-owned (no game-specific code).
- **Client-side action spawning** is deliberately absent: a snake has no
  weapon, and its only interactions are resolved authoritatively, so
  `hooks.onLocalAction` returns `null` and `try_action` is empty. Guessing a
  crash locally would mean showing the player a death the host might not agree
  with.

Rendering is built from engine MVC components + this plugin's PixiJS entities
(`src/client/parts/`) on one canvas (`vimp`); the crystal texture is baked at
startup from `src/client/bakers/`.

No part needs a game service: `componentDependencies` names only engine
services (`soundManager`, `localPlayer`, `accolades`). Colours and the arena
look are plain imports (`src/data/palette.js`, `src/data/theme.js`) because a
free-form `gameConfig.parts.*` key reaches the client config but never a part
— a part is constructed with `(data, assets, dependencies)`, and
`dependencies` only ever holds engine services.

## The four decisions the code depends on

1. **The core owns life and death; the engine is never told — so ONE LIFE IS
   ONE GAME.** `CoreEvent::Death` is never emitted. A round ends only through
   a reported kill, and there is no per-player respawn inside a round (the
   only spawn primitive is private to `RoundManager._startRound`), so the core
   has to own crash, drop and respawn outright. The engine therefore never
   writes `score`/`deaths` either — `src/host/StatBridge.js` does, off
   `custom` events, reached from `onCoreEvent` through a module-scope handle
   set in `createModules` (that hook's context is only `{ vimp, panel }`). Two
   engine flags in `src/config/game.js` make it official: `noSpectators` (one
   team, the joiner goes straight into it) and `endlessRound` (the engine
   never restarts the round or wipes the stat table by itself).

   The consequence is the scoring model. With no round to end and no death the
   engine hears about, the only boundary this game has is the crash, so the
   crash is what closes a game: the score of that life is reported with
   `vimp.addPlayerPoints(gameId, score)` + `vimp.finishPlayerGame(gameId)`,
   the counters are reset by the RESPAWN (not by the death — the result
   overlay reads the score off the panel after the crash), and a `burn` event
   from the core takes the boost's fuel back off the score.

   **The game reports a result; the engine splits it.** The daily best, the
   monthly sum and the all-time total are computed from that one number by the
   engine and the auth service, and the game does no "delta against today's
   value" arithmetic of its own. It does not decide *when* the number is
   written either: `vimp.flushPlayerData()` is a request, and the interval,
   the per-room queue and the backoff belong to `PlayerDataSync`. What comes
   back the other way is a place — the `accolades` client service — and the
   game's only say in it is how a place is drawn (a diamond pattern, a crown)
   and what `Tab` shows (`mode: 'leaderboard'`).
2. **Game ids are STRINGS.** The engine hands them out as
   `counter.toString(10)` and keys its participant Map by them, while the core
   writes them into `custom` events as numbers — everything crossing that seam
   goes through `String()`. Getting it wrong froze the panel and the stat
   table at zero (`tests/host/statBridge.integration.test.js` guards it).
3. **The arena is derived from the map grid, and grows with the crowd.** One
   formula in `core/src/arena.rs`, `src/client/parts/Arena.js` and
   `src/data/maps/arena.js`: `radius = cols * step / 2`. The grid size follows
   the population: the core reports a `population` custom event,
   `src/host/ArenaScaler.js` rebuilds the map with `buildArena(count)` and
   hot-swaps it through `coreAdapter.createMap` + `socketManager.sendMap` +
   `vimp.overrideMapData` — never through the engine's own map change, which
   would wipe the scores.
4. **Turning has one function, two sources.** Keys and the pointer target
   (`MoveInput.aim`, a world point from the engine's `apply_aim`) both reduce
   to the clamped step of `motion::step_angle`, so a mouse never out-turns
   `turnSpeed` — and the target must enter the predictor's input history
   (`InputSnapshot`), not just the key mask.

## Key invariants

- **Single PixiJS instance**: engine and plugin must share one PixiJS module
  instance at runtime. `pixi.js` is a peer dependency and is externalized from
  the client build (`vite.config.js`); the host page resolves it via an import
  map. Bundling a second copy in either side breaks interop between
  engine-owned renderer systems and this plugin's PixiJS objects.
- **Motion replica parity**: the authoritative step and the client prediction
  replica share the tick formulas (`core/src/motion.rs`); parity is locked in
  by cargo tests (`client::predictor::parity`) — any edit to motion or to the
  `models.js` coefficients requires `npm run core:test`.
- **The player block carries `cos`/`sin`, not the angle**
  (`PLAYER_STATE_LEN = 8`: `[x, y, cos, sin, crystals, length, alive, grace]`).
  The drift detector compares components numerically, and a raw angle crossing
  ±PI reads there as a 6.28 rad divergence. The last slot is the SECONDS of
  spawn grace left, not a flag: a flag would keep the replica frozen a round
  trip past the moment the host resumed.
- **`SPINE_POINTS = 16`** — the resampled body carried per snake row, declared
  in `src/config/snapshot.js`, `core/src/motion.rs` and
  `src/client/parts/Snake.js`; `tests/config/contract.test.js` compares them.
- The snapshot key schema (`src/config/snapshot.js`) is this plugin's data —
  an unregistered key breaks frame packing on both the host and the client,
  which is why the engine-owned `c1` (map dynamics) block is declared even
  though this game has no dynamic bodies.
- `ENGINE_API_VERSION` is always imported from `vimp-engine/config/opcodes.js`,
  never written as a literal; the engine checks it at plugin load time.

---

[Next: Gameplay →](gameplay.md)
