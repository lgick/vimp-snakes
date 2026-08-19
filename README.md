# Vimp Snakes

A VIMP game plugin (`@vimp-games/vimp-snakes`): a snake arena.

## The game

One circular arena. Snakes are always moving; you steer, you never stop.
Crystals appear at random in three sizes — eat them to grow, and the bigger the
crystal the more you grow and the more you score.

| Key | Does |
| --- | --- |
| `A` / `D` | turn left / right |
| `W` | boost — nearly double speed, paid for in crystals, which drop behind you |
| `R` | respawn after a crash (the OK button of the result screen presses it for you) |

Three ways it ends and only one of them is your fault:

- your head touches the boundary of the disc — you crash;
- your head touches **another** snake's body — you crash, and everything you
  were carrying scatters over the map where you died;
- your head touches **your own** tail — nothing happens, it passes over.

The stat table (`Tab`) is a single leaderboard ranked by crystals carried right
now. Everyone is a player; there are no teams.

## Run it

```bash
npm install
npm run core:build   # REQUIRED before npm run dev
npm run dev
```

`npm run core:build` is not optional and not a later step: the dev harness
(`dev/main.js`) imports the wasm out of `core/pkg-web/`, so until the Rust core
has been built once Vite fails to resolve the import and `npm run dev` dies on
startup. The same holds before the master is started against this package,
even in dev mode — build the core and then `npm run build` at least once.

## Commands

```bash
npm run core:build      # wasm-pack -> core/pkg-web (runtime) + core/pkg-node (tests)
npm run core:test       # cargo test --workspace, including the motion parity suite
npm run build           # dist/: both bundles, maps, sounds, manifest.json
npm run check:contract  # static engine<->game contract check (vimp-contract)
npm test                # vitest
npm run dev             # a match against bots in the tab
npm run audio:process   # ffmpeg: assets/audio-raw/ -> build/sounds/ (optional)
```

The headless runner lives in the engine checkout and is the primary
verification loop — see `scenarios/` below.

## Layout

| Path | What |
| --- | --- |
| `core/` | the Rust crate `vimp-snakes-core` — movement, growth, collisions |
| `src/host/` | HostPlugin: runs in a Web Worker, no DOM and no PixiJS |
| `src/client/` | ClientPlugin: render parts, bakers and the result screen |
| `src/config/` | game, client, auth, snapshot and sound configuration |
| `src/data/` | the map, the snake model, the palette and the arena theme |
| `scenarios/` | headless scenarios for `npm run sim` |
| `scripts/` | build steps: bundles -> `dist/` + `manifest.json` |
| `dev/` | the standalone dev harness — never published |

Only `dist/` is published (`files: ["dist"]`).

## Three decisions worth knowing before reading the code

**The core owns life and death; the engine is never told.** No
`CoreEvent::Death` is ever emitted. That is what makes the round endless (a
round only ends through a reported kill) and what makes respawning possible at
all (the engine has no per-player respawn inside a round — its only spawn
primitive is private to `_startRound`). The consequence is that the engine also
never writes `score` or `deaths`, which is why `src/host/StatBridge.js` writes
them instead, off the core's `custom` events. See the note atop
`src/config/game.js`.

**There is no physics.** A snake is a polyline; the arena edge, other bodies
and crystals are distance tests. The engine's Rapier world is stepped and stays
empty. That is what makes the client's prediction exact — the predictor runs
the same `core/src/motion.rs` the host does, with no solver in between to
disagree about.

**The arena is derived, not configured.** The `game` half of the init JSON is a
fixed field set, and a free-form `gameConfig.parts.*` key reaches the client and
never the core — so the disc comes out of the map grid by one formula both
halves apply (`core/src/arena.rs`, `src/client/parts/Arena.js`,
`src/data/maps/arena.js`).

## Headless verification

From the **engine** checkout, with this package linked:

```bash
npm run sim -- --game <path to vimp-snakes> --scenario <path>/scenarios/movement.json
```

| Scenario | Exercises |
| --- | --- |
| `movement.json` | cruising and turning, with prediction drift checked against tight thresholds |
| `crash-and-respawn.json` | driving into the boundary, staying dead, the respawn key |
| `growth.json` | two players, three bots, crystals, the boost, `/spawn` |

All three are expected to pass with `--determinism`. Two invariants skip by
design: `roundLifecycle` (this game has no round end) and, in two of the three
scenarios, `predictionDrift` (a crash and a respawn are legitimate one-off
spikes — `movement.json` is the one that watches for drift that *grows*).

## Sounds without ffmpeg

The real pipeline is `assets/audio-raw/*.wav` → `npm run audio:process` →
`build/sounds/*.{webm,mp3}`. That needs ffmpeg, so the package also ships
ready-made placeholders in `assets/sounds/`: when `build/sounds/` is absent,
`scripts/copy-game-sounds.js` falls back to them and the first build stays green
on a bare machine. The two cues are `pickup` and `death`, both played
positionally by `src/client/parts/Snake.js`.

## Engine

- `vimp-engine` `^0.10.0`
- `vimp-engine-core` `0.3.2`

Game id: `vimp-snakes`. The plugin contract lives in the engine repository
under `docs/ai/`.
