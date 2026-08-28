# Extending the Game

Every recipe below ends the same way: `npx eslint .`, `npm test`,
`npm run check:contract`, and — if anything under `core/` or `src/data/`
changed — `npm run core:build && npm run core:test`, then the headless
scenarios (see [getting-started.md](getting-started.md#headless-scenarios-npm-run-sim)).

## A new snake class

The game ships one class, `s1`, and the model key is load-bearing in four
places at once: the snapshot block key, the auth form's `model` option,
`gameConfig.scripted.defaultModel`, and the `gameSets` entry that decides
which part draws it.

1. **`src/data/models.js`** — add `s2` with the full field set (movement,
   body, boost). It needs its own `world` block only if it should change the
   arena rules; the core reads `world` off the model of the snake it is
   stepping, so two classes with different `world` blocks in one match is a
   contradiction — keep the arena rules identical, or keep one class.
2. **`src/config/snapshot.js`** — a new block keyed `s2` with the **same**
   field list as `s1` and a unique `id`.
3. **`src/config/client.js`** — `parts.gameSets.s2 = ['Snake']`.
4. The auth form picks the option up automatically: `src/config/auth.js`
   builds its `options` from `Object.keys(models)`.
5. `npm run core:build` (the model reaches the core through the init JSON) and
   `npm run check:contract`.

Changing an existing model's numbers needs no schema work — but it **is** a
motion change: run `npm run core:test` (the predictor parity suite) and the
`movement.json` scenario.

## A new crystal tier

`CRYSTAL_TIERS` in `src/data/palette.js` is the single source: `models.js`
imports it into `world.tiers`, the core scores off it and `Crystal.js` scales
the baked gem by its `radius`.

1. Append `{ value, radius }` — **append**, because the tier index travels on
   the wire as a `u8`.
2. Add a matching weight to `world.tierWeights` in `src/data/models.js`: the
   two arrays must be the same length and in the same order (the core
   validates it and refuses the config otherwise).
3. `npm run core:build`, then `growth.json` to see it spawn.

## A new colour

`SNAKE_COLORS` / `CRYSTAL_COLORS` in `src/data/palette.js`. **Append, never
insert**: the core rolls an index and ships that index, so inserting in the
middle recolours every snake already on the wire. Nothing else needs to
change — the client takes the index modulo the palette length, so the core
never learns how long the table is.

## A new sound

1. Drop the source into `assets/audio-raw/<name>.wav`.
2. `npm run audio:process` (needs ffmpeg) → `build/sounds/<name>.{webm,mp3}`.
3. Register it in `src/config/sounds.js`:
   `newCue: { file: '<name>', priority, volume }`. Both codecs must exist —
   `npm run check:contract` fails on a missing pair.
4. Play it from a part through the `soundManager` service, positionally:

   ```js
   this._sound?.play('newCue', { x, y });
   ```

   Add the part to `componentDependencies.soundManager` in
   `src/config/client.js` if it is not there yet. Do **not** route it through
   `gameConfig.soundCues` — all five engine cues are `null` here on purpose.

Without ffmpeg the build still works: `scripts/copy-game-sounds.js` falls back
to the ready-made pairs in `assets/sounds/`.

## A new client part

1. Write the class in `src/client/parts/<Name>.js`. The contract is
   `constructor(data, assets, dependencies, context)`, `update(data)`,
   `destroy()`, extending a PixiJS `Container`; `data` is the field array of
   its snapshot block, **in schema order**.
2. Export it from `src/client/parts/index.js`.
3. Register it in `src/config/client.js` — in `gameSets` (which block builds
   it) **and** in `entitiesOnCanvas` (which canvas it lives on). The second is
   the one the factory reads; a class missing there answers "Constructor for X
   not found" at the first frame that needs it.
4. Anything it needs from the engine goes in `componentDependencies`
   (`renderer`, `soundManager`, `assetsBase`, `localPlayer`, `accolades` — an
   unknown name is silently `undefined`).
5. Cover it in `tests/client/parts.test.js`.

Textures: prefer a **baker** over an image. Add the function to
`src/client/bakers/`, export it from `bakers/index.js` and name it in
`parts.bakedAssets` with the `component` that receives it in `assets`. Bake
white and tint per instance — that is what keeps sixty crystals in one batch.
This package ships no images at all, and `assetsBase` is only used for sounds.

## A badge for a place (`accolades`)

The engine hands out numbers and the game decides what a number looks like.
`accolades` is the fifth service of the dependency pool: `placeOf(id)` answers
`{ daily, monthly }` — the entity's place in the game's global daily and
monthly top, or `null` for anyone not in it (a bot, a guest, an entity with no
player behind it). The host recomputes the places from the same public top the
lobby draws and pushes them only when they change, so a badge follows the
player onto any server and vanishes the moment the place does.

Two rules, both learned the hard way:

1. **Keep the service, never the answer.** Parts are built from the first
   frame, long before the first places arrive, so a badge decided in the
   constructor would be missing for exactly the players who have one. Ask at
   draw time — `src/client/parts/Snake.js` calls `placeOf` every `update`.
2. **A place is not a boolean.** `daily` is a number or `null`, and `0` is not
   a place — compare against `null`/`undefined`, not for truthiness.

To add a badge of your own: name `accolades` in `componentDependencies` for
the part, bake its texture white if it needs one (`src/client/bakers/`, see
`crown.js`) and put its numbers in `src/data/theme.js` next to `SNAKE.accolade`
rather than in the drawing code. Then cover it in `tests/client/parts.test.js`
with a stub service — the two badges of this game are tested that way.

**A badge must not be derived from the body colour.** Use `badgeInk(color)`
from `src/client/parts/Snake.js`, which returns `[fill, edge]` — the more
contrasting of the two fixed inks and its opposite for the outline. Lightening
or darkening the body is what made the diamonds invisible on a white snake.
This binds `SNAKE_COLORS` too: appending a colour is no longer free, it has to
pass the contrast cases of `tests/client/parts.test.js` (3:1 against both badge
inks) alongside the old "append, never insert" rule of `src/data/palette.js`.

## A new chat command

The engine parses no commands of its own: `HostPlugin.chatCommands` is the
whole set a player can type.

1. Write the module (see `src/host/botCommand.js` or
   `src/host/metaCommands.js`): `{ name: '/foo', handler(ctx, gameId, args) }`.
   The context is `{ participants, chat, scripted, roundManager,
   voteCoordinator, timerManager, playerDataSync, teams, spectatorTeam,
   spectatorId, isDevMode }`.
2. Add it to the `chatCommands` array in `src/host/index.js`.
3. If it answers in chat, add the message code to
   `src/host/systemMessages.js` (group `g` — the engine owns
   `s`/`v`/`m`/`c`/`n`, and the codes are merged by a blind `Object.assign`,
   so a code in an engine group overwrites an engine message without a word)
   and the text at the **same index** in
   `modules.chat.params.messages.g` (`src/config/client.js`).
4. Cover it in `tests/host/`.

## A new map

The arena is derived from the map grid, so a second map is a second grid — not
a second geometry format. Add `src/data/maps/<name>.js` exporting the same
shape `buildArena` produces (`setId`, `scale`, `step`, `physicsStatic`,
`physicsDynamic`, `layers`, `map`, `respawns`), register it in
`src/data/maps/index.js`, and make sure it has at least
`roomDefaults.maxPlayers` respawn points — `npm run check:contract` fails the
build otherwise. `npm run build` exports it to `dist/maps/<name>.json`.

Note that `src/host/ArenaScaler.js` rebuilds **`arena`** specifically
(`buildArena(count)`); a second map would need its own sizing law or would
have to opt out of scaling.

## Changing how a snake moves or dies

All of it lives in `core/` and is shared between the host and the predictor:

| Change | Where | Then |
| --- | --- | --- |
| turn rate, speed, growth curves | `core/src/motion.rs` + `src/data/models.js` | `npm run core:build`, `npm run core:test`, `movement.json` |
| what kills whom | `core/src/game.rs` (section 2 of the fixed step) | `npm run core:test`, `crash-and-respawn.json`, `growth.json` |
| crystal field rules | `core/src/crystals.rs` + `world` in `models.js` | `npm run core:build`, `growth.json` |
| bot behaviour | `core/src/game.rs`, `drive_bot` | `bots.json` |
| the wire | `src/config/snapshot.js` + the row builders in `game.rs` | `npm run check:contract`, every scenario |

Moving logic **out** of `motion.rs` is the one change to avoid: it is the file
the client predictor and the authoritative step share, and the parity suite
in `core/src/client/predictor.rs` is what notices when only one half moved.

---

[← Previous: Configuration](configuration.md)
