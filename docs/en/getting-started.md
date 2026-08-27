# Local Setup (game plugin)

This repository builds `@vimp-games/snakes`, a game plugin for the
[VIMP engine](https://github.com/lgick/vimp-engine). For engine-side local
setup (running the master server, the lobby, the auth service), see the
engine's own
[getting-started.md](https://github.com/lgick/vimp-engine/blob/main/docs/en/getting-started.md).

## Requirements

- **Node.js 20.11+** (the package declares `engines.node >= 20.11`), npm;
- **Rust toolchain** (`rustup` + `wasm-pack`) — required to build this
  plugin's WASM core, which the engine's browser host and every client load;
- **ffmpeg** — optional, only for re-processing sounds.

## Install

```bash
git clone https://github.com/lgick/vimp-snakes.git
cd vimp-snakes
npm install
```

`vimp-engine` is a regular npm dependency here (not a workspace symlink) —
this plugin only imports its public `exports` surface (`./config/*`,
`./standalone`, `./style.css`).

`pixi.js` is a **peer dependency**, not bundled: the client build
externalizes it (`vite.config.js`), and at runtime it must resolve to the same
module instance the engine uses, supplied via an import map on the host page.
Two independent PixiJS copies (engine + plugin each bundling their own) crash
at runtime — each copy has its own extension/pipe registry and uid counters,
and objects created by one copy (this plugin's bakers and `parts/`) aren't
valid input to the other's renderer.

## Rust toolchain

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # rustc + cargo
rustup target add wasm32-unknown-unknown
brew install wasm-pack        # or: cargo install wasm-pack
```

## Build

```bash
npm run core:build       # both WASM targets (web + nodejs)
npm run core:build:web   # browser/Worker → core/pkg-web/
npm run core:build:node  # Node.js (tests, headless runner) → core/pkg-node/
npm run core:test        # cargo test --workspace, including the parity suite
npm run build            # full plugin build: client+host bundles, assets, manifest.json → dist/
```

`npm run core:build` is **not optional and not a later step**: the dev harness
(`dev/main.js`) imports the wasm out of `core/pkg-web/`, so until the Rust
core has been built once Vite fails to resolve the import and `npm run dev`
dies on startup.

`npm run build` produces `dist/manifest.json` (a `GameManifest`), the
client/host JS bundles, exported map JSON (`dist/maps/arena.json`) and the
sound assets — everything the engine's master serves under `/games/snakes/*`
and everything the host Worker/client dynamically import. If `core/pkg-node/`
is built, `build:manifest` also copies it into `dist/core-node/` and declares
`entries.wasmNode` on that copy: `dist/` is the only published content
(`files: ["dist"]`), so a manifest pointing outside it would work in this
checkout and break in the installed package.

## Playing a match locally (`npm run dev`)

The fastest loop needs neither the engine checkout nor the master server: the
engine's [standalone SDK](https://github.com/lgick/vimp-engine/blob/main/docs/en/standalone.md)
runs the authoritative host, the client and this plugin inside one browser tab
— no lobby screen, no OAuth.

```bash
npm run core:build      # WASM (only core/pkg-web/ is needed for dev)
npm run audio:process   # sounds → build/sounds/ (needs ffmpeg; optional)
npm run dev             # Vite dev server, opens the tab
```

The tab enters as `Player` (override with `localStorage.vimp_dev_nick`) and
asks for three bots — `dev/main.js` holds every option
(`startStandaloneGame`, `assetsBase`, `startupCommands`). There are **no
`startupVotes`**: this game declares `noSpectators`, so the player is in the
only team there is from the moment they connect.

`assetsBase` is `/build/` here:

- **sounds** — `build/sounds/`, the product of `npm run audio:process`; when
  it is missing, `predev` stages the ready-made placeholders from
  `assets/sounds/` instead, so the match has sound on a bare machine;
- **images** — there are none: every texture in this game is either drawn with
  `Graphics` or baked procedurally at startup, so `copy-game-images.js` finds
  no `assets/img/` and reports a no-op.

WebRTC isn't used at all in this mode, and `npm run build` is not needed:
Vite serves `src/**` and `core/pkg-web/*.wasm` directly.

## Playing a match through the lobby (a local engine checkout)

To develop against a local, unpublished copy of this plugin, build it once and
link the two checkouts **into each other**:

```bash
cd vimp-snakes && npm run core:build && npm run build   # WASM + dist/

cd vimp-snakes && npm link                    # registers @vimp-games/snakes globally
cd vimp/packages/engine && npm link           # registers vimp-engine globally

# in the engine checkout — every game in ONE command, or the second
# link overwrites the first
cd vimp && npm link @vimp-games/tanks @vimp-games/snakes
cd vimp-snakes && npm link vimp-engine        # plugin ← engine

cd vimp && npm run dev                        # master on https://localhost:3002
```

The reverse link matters as much as the forward one: without it this plugin's
`vimp-engine/*` imports resolve to a registry copy inside its own
`node_modules` — a second module instance with its own, silently skewed
`ENGINE_API_VERSION`. Note that `npm install` in either repository replaces
the symlinks with registry copies, so the `npm link <name>` commands have to be
repeated afterwards.

The master builds its game catalog from `node_modules/@vimp-games/*` when
`GAMES_MATRIX` is unset, sorted by id — so `snakes` comes first and is the
lobby's **active** game, which is what makes the `Create server` button
clickable. To pin a different one:

```bash
GAMES_MATRIX='[{"id":"tanks","package":"@vimp-games/tanks"}]' npm run dev
```

This package must be built before the master starts: the catalog reads
`dist/manifest.json`, not the sources. In dev the engine then serves this
plugin's `src/**` and `core/pkg-web/*.wasm` straight through Vite `/@fs/`
(HMR), so client/host JS edits need no rebuild at all.

## Tests

Stack: **Vitest** + happy-dom. `vitest.config.js` splits the run into two
projects:

- `unit` — `tests/config/**` (contract and game-config invariants),
  `tests/host/**` (`hostPlugin`, `statBridge`, `statBridge.integration`,
  `arenaScaler`), `tests/client/**` (`parts`, `gameOver`) — happy-dom;
- `integration` — `tests/core/**`, the real core driven from Node through
  `core/pkg-node/`. The build is not part of `npm test`, so without
  `npm run core:build:node` the project has nothing to include and the suite
  still passes.

A Vite alias redirects `core/pkg-web/*.js` to `tests/stubs/wasmCore.js`, so
unit tests import the plugin halves in a checkout where the core has never
been built; the stub throws if anything actually calls it.

Project rule: **any code change ends with a green `npx eslint .` and
`npm test`**; editing motion in the core or the `models.js` coefficients
additionally requires `npm run core:test` (the predictor parity suite).

## The static contract check

```bash
npm run check:contract     # vimp-contract --game .
```

A text-only pass over this plugin's configs that checks the engine↔game
contract before anything is built: snapshot block ids and classes, the panel
contract (every host field named by the client), key sets against
`playerKeys`, the auth schema, sound pairs, map images, and that the map has
at least `roomDefaults.maxPlayers` respawn points. Run it after every edit
under `src/config/` or `src/data/`.

## Headless scenarios (`npm run sim`)

The engine ships a headless runner that closes the loop
"host → binary frame → `ClientCore` → hot buffer → scene" in one Node process
and checks the engine's invariants. It runs from the **engine** checkout with
this package linked, and it loads the **built** plugin — so `npm run build`
first, or you are testing the previous version:

```bash
cd vimp
npm run sim -- --game ../vimp-snakes --scenario ../vimp-snakes/scenarios/movement.json --determinism
```

| Scenario | Exercises |
| --- | --- |
| `movement.json` | cruising and turning, with prediction drift checked against tight thresholds |
| `crash-and-respawn.json` | driving into the boundary, staying dead, the respawn key |
| `growth.json` | two players, three bots, crystals, the boost, `/bot` |
| `pointer.json` | steering to a point with mouse/finger, the keyboard taking over mid-run, the double-tap boost |
| `bots.json` | `/bot <count>` as a SET: six bots, then two, then a refused count, then none |

All five are expected to pass with `--determinism`. Two invariants skip by
design: `roundLifecycle` (this game has no round end) and, in three of the
five scenarios, `predictionDrift` (a crash and a respawn are legitimate
one-off spikes — `movement.json` and `pointer.json` are the two that watch for
drift that *grows*).

The runner exercises the **real** core, so it needs the same
`vimp-engine-core` version the engine build expects. When working against a
local engine checkout, patch cargo locally — do **not** commit this:

```toml
# Cargo.toml, workspace root
[patch.crates-io]
vimp-engine-core = { path = "../vimp/packages/engine/core" }
```

Scenario format and threshold calibration — the engine's
[debugging.md](https://github.com/lgick/vimp-engine/blob/main/docs/en/debugging.md).

---

[Next: Architecture →](architecture.md)
