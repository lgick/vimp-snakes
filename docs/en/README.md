# VIMP Snakes Documentation

`vimp-snakes` is a game plugin for the [VIMP engine](https://github.com/lgick/vimp-engine)
— a free-for-all snake arena: one endless round on one circular map, snakes
that never stop moving, crystals that are both the growth and the score.
Rules, simulation and rendering entities specific to this game are loaded
dynamically by the engine at runtime through the plugin contract
(`GameManifest`/`HostPlugin`/`ClientPlugin`).

For anything not specific to this game — the P2P transport, the master
server, the browser host's Worker infrastructure, the client MVC/render
framework, the generic Rust engine crate — see the engine's own docs:
[vimp-engine/docs/en/](https://github.com/lgick/vimp-engine/blob/main/docs/en/README.md).

## Sections

| Page | Covers |
| --- | --- |
| [getting-started.md](getting-started.md) | Local setup: install, Rust toolchain, building the WASM core, `npm run dev`, linking against a local engine checkout, tests, headless scenarios |
| [architecture.md](architecture.md) | This plugin's layout, how it plugs into the engine, the core's boundary, the four decisions the code depends on |
| [gameplay.md](gameplay.md) | Gameplay: the arena, controls, crystals, the boost, crashes and kills, the score and the three ratings, bots, chat commands, what this game does NOT have |
| [core.md](core.md) | Rust game core (`vimp-snakes-core`): layout, ABI (commands/events/frames), the motion model, collisions, crystals, bots, prediction, tests |
| [configuration.md](configuration.md) | This plugin's own configuration: `game.js`/`client.js` halves, auth form, sounds, snapshot schema, game data (model, palette, theme, map) |
| [extending.md](extending.md) | Adding content: a snake class, a crystal tier, a colour, a sound, a client part, a chat command |

## Where to start

- **I want to run a match locally** → [getting-started.md](getting-started.md)
- **I want to understand the game rules** → [gameplay.md](gameplay.md)
- **I want to change how a snake moves or dies** → [core.md](core.md)
- **I want to add content** → [extending.md](extending.md)
- **I want to understand how this plugs into the engine** → [architecture.md](architecture.md), then the engine's own [plugin-api.md](https://github.com/lgick/vimp-engine/blob/main/docs/en/plugin-api.md)

> Documentation is maintained alongside the code: whenever functionality changes, the relevant page is updated in the same change (a rule codified in [CLAUDE.md](../../CLAUDE.md)).
