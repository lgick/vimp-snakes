# Vimp Snakes

A VIMP game plugin (`@vimp-games/snakes`): a snake arena.

## The game

One circular arena. Snakes are always moving; you steer, you never stop.
Crystals appear at random in three sizes — eat them to grow, and the bigger the
crystal the more you grow and the more you score.

| Key | Does |
| --- | --- |
| `A` / `D` | turn left / right |
| `W` | boost — nearly double speed, paid for in crystals, which drop behind you |
| `R` | respawn after a crash (the OK button of the result screen presses it for you) |

Mouse and touch are the second way to play, and the only one a phone has:
**press and hold** — the snake turns towards the point under the pointer, no
faster than the keys would turn it; **double tap and keep holding** — boost,
for as long as the finger stays down. Releasing hands the snake back to
whatever heading it had, and taking hold of `A`/`D` cancels the pointer
target. The channel is muted while the chat or the stat table is open, so
typing a message never steers the snake.

Three ways it ends and only one of them is your fault:

- your head touches the boundary of the disc — you crash;
- your head touches **another** snake's body — you crash, and everything you
  were carrying scatters over the map where you died;
- your head touches **your own** tail — nothing happens, it passes over.

One number follows you and a crash does not reset it: **score** — the crystals
you have eaten plus a flat **15** per snake that ran into you. The victim keeps
its own score; what it was carrying scatters on the map for whoever gets there
first, so killing the leader is still worth it, just not twice. The HUD shows
the score alone; what you are carrying right now is told by the size of your
snake. A kill is also worth a point of **rank**, the number `/rank` reports and
the one that survives the session.

The first two seconds of a life are yours: a fresh snake stands still and
blinks, kills nobody and cannot be killed. Long enough to read the arena, and
long enough for whoever was flying at that spot to steer around you.

The heavier you get the wider you steer: 3.4 rad/s empty, falling with the
square root of the crystals down to a floor of 1.4. A leader stays steerable
and stops being nimble — the fastest snake in the arena is a small one.

The stat table (`Tab`) is a single leaderboard ranked by score, ties broken by
rank. Everyone is a player: there are no teams, no spectators and nothing to
vote on.

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

### In the lobby, against another player

`npm run dev` is a single tab against bots. To play this game through the
lobby master (two tabs, a real room), link both halves and start the master
from the engine checkout:

```bash
# once, in this package and in ~/Sites/my/vimp-tanks
npm link

# once, in the engine checkout — BOTH games in ONE command, or the second
# link overwrites the first
cd ~/Sites/my/vimp
npm link @vimp-games/tanks @vimp-games/snakes

npm run dev            # master on https://localhost:3002
```

The master builds its game catalog from `node_modules/@vimp-games/*` when
`GAMES_MATRIX` is unset, sorted by id — so `snakes` comes first and is the
lobby's **active** game, which is what makes the `Create server` button
clickable (the lobby can only host the active game). To pin a different one,
start the master with the catalog spelled out:

```bash
GAMES_MATRIX='[{"id":"tanks","package":"@vimp-games/tanks"}]' npm run dev
```

This package must be built (`npm run core:build && npm run build`) before the
master starts: the catalog reads `dist/manifest.json`, not the sources.

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
never writes `score` or `deaths`, which is why `src/host/StatBridge.js` keeps
the whole scoring model instead — eaten, kills and score, per game id — off the
core's `custom` events. See the note atop `src/config/game.js`.

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

**The arena grows with the crowd.** The area per snake is the difficulty curve,
so the grid is a function of how many are in the room: `buildArena(count)` in
`src/data/maps/arena.js` owns the law, `src/host/ArenaScaler.js` owns when it
applies, and the core's `population` custom event is what triggers it. The
resize is a `coreAdapter.createMap` plus a MAP_DATA re-send, not an engine map
change: the round, the panel and the stat table survive it untouched.

## Headless verification

From the **engine** checkout, with this package linked:

```bash
npm run sim -- --game <path to vimp-snakes> --scenario <path>/scenarios/movement.json
```

| Scenario | Exercises |
| --- | --- |
| `movement.json` | cruising and turning, with prediction drift checked against tight thresholds |
| `crash-and-respawn.json` | driving into the boundary, staying dead, the respawn key |
| `growth.json` | two players, three bots, crystals, the boost, `/bot` |
| `pointer.json` | steering to a point with the mouse/finger, the keyboard taking over mid-run, the double-tap boost |
| `bots.json` | `/bot <count>` as a SET: six bots, then two, then a refused count, then none |

All five are expected to pass with `--determinism`.
The sim runs the **built** plugin (`dist/`), so `npm run build` before it or
you are testing the previous version. Two invariants skip by
design: `roundLifecycle` (this game has no round end) and, in two of the four
scenarios, `predictionDrift` (a crash and a respawn are legitimate one-off
spikes — `movement.json` and `pointer.json` are the two that watch for drift
that *grows*).

## Sounds without ffmpeg

The real pipeline is `assets/audio-raw/*.wav` → `npm run audio:process` →
`build/sounds/*.{webm,mp3}`. That needs ffmpeg, so the package also ships
ready-made placeholders in `assets/sounds/`: when `build/sounds/` is absent,
`scripts/copy-game-sounds.js` falls back to them and the first build stays green
on a bare machine. The two cues are `pickup` and `death`, both played
positionally by `src/client/parts/Snake.js`.

## Engine

The engine versions this game builds against are the pins themselves —
`vimp-engine` in `package.json` and `vimp-engine-core` in `Cargo.toml`.

Game id: `snakes`. The plugin contract lives in the engine repository
under `docs/ai/`.
