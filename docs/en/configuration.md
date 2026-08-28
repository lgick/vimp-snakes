# Configuration (game plugin)

This page covers `vimp-snakes`'s own configuration — the game half of the
contract described in the engine's
[plugin-api.md](https://github.com/lgick/vimp-engine/blob/main/docs/en/plugin-api.md).
For the engine's own configuration (env vars, `hostDefaults`, master/lobby
config, ports/opcodes), see the engine's
[configuration.md](https://github.com/lgick/vimp-engine/blob/main/docs/en/configuration.md).

`src/config/game.js` (host half) and `src/config/client.js` (client half) are
exposed to the engine through `HostPlugin.gameConfig` and
`HostPlugin.buildClientGameConfig()`; `src/config/auth.js` through
`HostPlugin.authSchema`; `src/config/sounds.js` and `src/config/snapshot.js`
feed into the client config and the snapshot codec respectively.

Run `npm run check:contract` after every edit here: the engine asserts only
nine paths at boot and reads the rest lazily, so a typo surfaces as a black
canvas rather than an error.

## src/config/game.js — the game config

Imports the map, the snake model, the (empty) weapon table and the snapshot
schema from `src/data/` and `src/config/`.

### Core parameters

| Parameter | Value | Description |
| --- | --- | --- |
| `title` | `'Vimp Snakes'` | Shown by the lobby and the auth screen |
| `parts.models` | `src/data/models.js` | Snake classes; passed verbatim to both cores |
| `parts.weapons` | `{}` | No weapons — the path is asserted at boot, so it exists and stays empty |
| `parts.friendlyFire` | `false` | No such rule either; asserted, so it stays declared |
| `snapshot` | `src/config/snapshot.js` | The wire layout |
| `maps` / `currentMap` | `{ arena }` / `'arena'` | The single map |
| `mapScale` | `1` | The engine's scaling pass is a copy |
| `mapSetId` | `'c1'` | Fallback snapshot key for a map without its own |
| `mapsInVote` | `1` | There is nothing to vote on; the key is still read |
| `soundCues` | all five `null` | Every engine cue fires off round/kill machinery this game does not use |
| `playerState.defaultState` | `{ best: 0, eaten: 0 }` | The starting profile on the auth service — opaque to the engine, written by `StatBridge` |
| `noSpectators` | `true` | One team, the joiner goes straight into it, no vote on the way in |
| `endlessRound` | `true` | The engine never restarts the round or wipes the stat table by itself |
| `teams` | `{ players: 1 }` | Exactly one team — required by `noSpectators` |
| `scripted` | `namePrefix: 'Snake', defaultModel: 's1'` | Bot naming and class |
| `roomDefaults.maxPlayers` | `32` | The room ceiling, published in the manifest; the map must seat it |
| `roomForm` | `maxPlayers`, `map` | The lobby's create-server form. `roundTime`/`mapTime`/`friendlyFire` are deliberately absent |

`timers` is merged **shallowly** over the engine's `hostDefaults`, so
overriding it restates every key. `roundTime` and `mapTime` are pinned at
`roomTimeMax` (1 hour): with `endlessRound` an expiring round timer does
nothing, but the panel's time cell counts down off it. `timeStep` is
`1000/120` and must not be touched — the core's step is read from the engine's
`hostDefaults`, so changing it here desyncs the Worker loop from the
simulation.

### Stats (`stat`)

Four columns, matched positionally by `client.js`: `name` (0), `status` (1),
`score` (2), `latency` (3). `name` and `latency` are the engine's and must
keep their names; `status` is the engine's too (`RoundManager` writes `''`
into it when a player is admitted).

The one playing column — `score` — is written by **this game**
(`src/host/StatBridge.js`), not by the engine, and carries `bodyMethod: '='`
(replace) rather than `'+'` (accumulate): the bridge keeps the running total
itself, so a re-sent value is harmless and a dropped one self-heals on the
next event.

The `rank` column is **gone**: `Tab` no longer shows this room at all but the
game's global daily top ten, which the client fetches for itself (see
`modules.stat` below). The rest of the schema stays anyway — the engine keeps
writing `name`, `status` and `latency` into its own table, and dropping the
columns would break those paths. `deaths`, `eaten` and `kills` are absent on
purpose.

### Player rank/state (`playerState`)

The engine treats `state` as an opaque JSON blob; this game stores
`{ best, eaten }` — the best score of a SINGLE life ever played and a lifetime
crystal count — written by `StatBridge._recordBest` on every death.

The ratings themselves are not stored here. One life is one game: the bridge
reports its result with `vimp.addPlayerPoints(gameId, score)` +
`vimp.finishPlayerGame(gameId)` and then *asks* for a write with
`vimp.flushPlayerData({ urgent: true })` — the daily best, the monthly sum and
the all-time total are the engine's split of that one number, and how often it
reaches the database is the engine's decision too (see
[gameplay.md](gameplay.md#the-result-of-a-game)). Sync mechanics are the
engine's —
[auth.md](https://github.com/lgick/vimp-engine/blob/main/docs/en/auth.md#rank-and-state-loading-and-sync-host).

### HUD panel (`panel`)

`fields` are host fields with a short wire `key` and a starting value:
`crystals` → `c` (what the snake carries), `score` → `s` (the only visible
cell), `dead` → `d` (0 alive, `crystals + 1` dead — panel values floor at 0,
so "dead carrying nothing" needs the plus one). `activeKey: 'wa'` is the
engine's "active weapon" cell, which the core fills with `CRUISE`/`BOOST`;
leaving it `null` makes the panel send the literal key `'null'` to every
client.

The key `t` (round time) is the engine's and must never be declared here — but
the client must declare a `type: 'time'` field for it.

### Keys (`playerKeys`)

| Action | Bit | Kind |
| --- | --- | --- |
| `left` | `1 << 0` | held |
| `right` | `1 << 1` | held |
| `boost` | `1 << 2` | held |
| `respawn` | `1 << 3` | `type: 1` — one-shot, consumed by exactly one fixed step |

Every name here must have a key in `keySetList[1]` (`client.js`) or it can
never be pressed. There is no forward and no brake: a snake is always moving.

## src/config/client.js — the client half of CONFIG_DATA

Supplied through `HostPlugin.buildClientGameConfig()`, merged by the engine's
`buildClientConfig.js` with its own `clientDefaults.js` (recursively — which
is why disabling an engine key means overwriting it, not dropping it).

### `parts` — game entities

- **`gameSets`** — snapshot key (or map `setId`) → part classes:
  `s1: ['Snake']`, `cr: ['Crystal']`, `c1: ['Arena']`. A key without an entry
  is a black canvas.
- **`entitiesOnCanvas`** — part class → canvas; this is the **only**
  registration with the factory. All three parts live on `vimp`.
- **`bakedAssets`** — two entries, both baked **white** once per canvas at
  startup and then tinted and scaled by the part: the `crystalGem` baker draws
  a gem (radius 32, 6 facets), so every tier and colour is a `tint` + `scale`
  of that one texture and sixty crystals stay one batch; the `crown` baker
  draws the badge of the monthly top ten (size 64, 3 points). The snake's
  BODY has no baked asset: it is a stroked path whose width follows the
  crystal count every frame.
- **`componentDependencies`** — engine services only, and all three go to
  `Snake`: `soundManager` (a snake plays the pickup cue only for the player of
  *this* tab — thirty snakes eating at once is a wall of noise), `localPlayer`
  ("is this snake mine?") and `accolades` ("what place does this snake hold in
  the game's global top?" — the part asks at draw time and draws the diamonds
  of the daily top ten or the crown of the monthly one). `accolades` is the
  fifth service of the engine's pool and needs `ENGINE_API_VERSION` 4.

### Canvas and camera

One canvas, `vimp`: 960×600 at 16:10, `baseScale '1:1'` (the view shows
~1920 of the 2560-unit arena at the design width — the boundary is something
you approach, not a frame you always see), `dynamicCamera: true`,
`shakeCamera: false` (nothing in this game emits `CoreEvent::Shake`).

### `modules.controls`

- **`modes`** — `77: ''` disarms the engine's vote menu (`m`). The defaults
  are merged recursively, so the key has to be **overwritten**; dropping it
  would leave the engine's own value in place and the menu would keep opening,
  empty.
- **`keySetList`** — `[0]` spectator (`n`/`p`, unreachable in this game),
  `[1]` player: `65: left`, `68: right`, `87: boost`, `82: respawn`. Every
  action must be a key of `gameConfig.playerKeys` and vice versa.
- **`pointer`** — `keySets: [1]`, `doubleTapMs: 300`, `doubleTapPx: 40`,
  `sendIntervalMs: 50`. The engine sends the pointer channel only to games
  that declare this key, and only in the listed key sets.

### Texts and schemas

- **`chat.params.messages`** — the texts of the system message codes by group.
  Groups `s`/`v`/`m`/`c`/`n` are the engine's; `g` is this game's
  (`src/host/systemMessages.js`: `BOTS_SET`, `BOT_COUNT_INVALID`). Several
  engine texts are unreachable here, but **the index inside a group is the
  code** — dropping one shifts every text after it onto the wrong event, so
  they stay, worded for this game.
- **`panel`** — wire key → field name, and the field list whose **order is the
  order of the cells**. Only `score` is visible; the rest are declared because
  the panel contract requires the client to name every host field, and hidden
  by `style.css`.
- **`stat`** — `mode: 'leaderboard'`: `Tab` shows the game's global top
  instead of the room's table. The list is **pushed by the host** on the
  accolades port — the client asks nobody, and the host sends no rows of the
  room's own. This half is paired with `statMode: 'leaderboard'` in
  `src/config/game.js`, which is what stops that broadcast; contract rule
  `C11` fails the build if only one of the two is declared. `period: 'day'`
  (the best result of a single game over the UTC day), `limit: 10`, and three
  columns — `#`, `snake`, `score`. The order comes from auth, so
  `heads`, `bodies` and `sortList` are all gone: there is nothing to sort and
  no team in a global list. A player outside the top replaces its tenth row.
  The mode needs `ENGINE_API_VERSION` 4, and the engine draws only the bare
  `.stat-leaderboard` skeleton for it — the styling is this game's
  (`src/client/style.css`).
- **No `vote` module at all** — see [gameplay.md](gameplay.md#what-this-game-does-not-have).
- **`gameInform.list`** — `'{0} WINS!'`, `'SLITHER!'`, `'GAME OVER!'`; the
  indexes are fixed by the engine (winnerTeam, roundStart, gameOver).

## src/config/auth.js — the auth form

The entry screen the engine renders before a player joins. Three traps live
here, and each has already cost a debugging session in a real game:

- the container id is `fieldsId`, **not** `formId` — the engine resolves the
  wrong key to `null` and the screen dies with a TypeError on first render;
- there is **no nickname field** — identity comes from the lobby JWT;
- the model field must be named exactly **`model`** — the engine reads
  `params.model` when it creates the participant.

`validators` are functions and are not serialised to the client: they run on
the host when the answer comes back (`isValidModel`). The screen is shown
**once** — the engine has no path back to it, which is why the after-death
screen is this game's own overlay (`src/client/gameOver.js`).

## src/config/sounds.js — the sound catalog

Two cues: `pickup` (priority 80, volume 0.35) and `death` (150, 0.5), both
played positionally by the parts through `soundManager`. Every entry must ship
as a **webm + mp3 pair** — the client walks `codecList` and takes the first
codec the browser supports, so a missing `.mp3` breaks Safari only. Never set
`path`: the engine overwrites it with `${assetsBase}sounds/`.

## src/config/snapshot.js — the snapshot key schema

Three blocks — `s1`, `cr`, `c1` — described in
[core.md](core.md#frames). Two rules to keep in mind when editing:

- the **field order is positionally bound** to `SnakeRow`/`CrystalRow` in
  `core/src/game.rs`; nothing validates the correspondence, so swapping two
  entries here without swapping them there produces garbage, not an error;
- `SPINE_POINTS = 16` is exported from this file and duplicated in
  `core/src/motion.rs` and `src/client/parts/Snake.js`;
  `tests/config/contract.test.js` compares them.

## src/data/ — game data

### models.js

One snake class, `s1`. The key is the model name: it is the snapshot block key
of the snake, the value of the auth form's `model` field and
`gameConfig.scripted.defaultModel`.

| Group | Fields |
| --- | --- |
| movement | `baseSpeed` 260, `boostFactor` 1.9, `turnSpeed` 3.4, `turnSpeedFalloff` 0.18, `turnSpeedMin` 1.4 |
| body | `baseRadius` 14, `radiusGain` 1.6, `baseLength` 150, `lengthPerCrystal` 9, `pointSpacing` 6 |
| boost | `boostDrainPerSecond` 6, `boostMinCrystals` 2 |
| `world` | `maxCrystals` 60, `spawnInterval` 0.35, `tierWeights` `[70, 25, 5]`, `tiers` (from `palette.js`), `dropRatio` 0.8, `edgeMargin` 60, `startCrystals` 0, `spawnGraceSeconds` 2 |

**Why the world rules live inside a model**: the `game` half of the init JSON
is assembled by the engine from a fixed field set (`friendlyFire`, `models`,
`weapons`, `playerKeys`, `panel`), and a free-form `parts.*` key reaches the
client config and never the core. With exactly one snake class, nesting the
arena and crystal-field rules under it is the one place both cores can read
them from.

### palette.js

`SNAKE_COLORS` (12) and `CRYSTAL_COLORS` (6) — the core never sees a colour,
it rolls an **index** and ships it as a `u8`. **Append, never insert**: the
index is the whole identity, so a colour added in the middle recolours every
snake already on the wire. `CRYSTAL_TIERS` lives here too — `value` is both
the crystals gained and the score awarded, `radius` is both the pickup radius
and the drawn size; `models.js` imports it so the core scores exactly what the
client draws.

### theme.js

The look of the arena (`ARENA`: background, floor, edge and its width, the
concentric rings) and of the snake (`SNAKE`: inner stroke, Catmull-Rom
`smoothing`, eye/pupil colours, the boost glow). Imported **straight** by the
parts, not routed through the config — a `gameConfig.parts.arena` object would
never reach a part, and `dependencies` naming it would silently be `undefined`.

### maps/arena.js

The single map, and the only file in the game that knows a size. It exports a
**function**: `buildArena(count)` returns the map object for a room of `count`
participants, and the default export (`buildArena(0)`) is what
`scripts/export-maps.js` writes into `dist/maps/arena.json`.

| Constant | Value | Meaning |
| --- | --- | --- |
| `STEP` | 128 | world units per cell |
| `BASE_SIZE` / `BASE_PLAYERS` | 20 / 8 | the size the game is tuned at (2560 wide, radius 1280) |
| `PLAYER_STEP` | 4 | population is rounded up to a multiple of this before the size is computed |
| `RESPAWN_COUNT` | 64 | the hard capacity of the team on this map — deliberately double `maxPlayers` |
| `RESPAWN_SPAN` | 0.72 | how far out the outermost respawn point may sit |
| `RESPAWN_FAN_DEG` | 25 | how far a fresh heading may deviate from "straight at the centre" |

`arenaSizeFor(count) = round(BASE_SIZE * sqrt(max(stepped, 8) / 8))`.
Respawns are a sunflower spiral (`GOLDEN_ANGLE`, `sqrt` radius so the points
are uniform by **area**) walked in **bit-reversed** order, so every prefix of
the sequence samples the whole disc instead of piling into the middle;
`RESPAWN_COUNT` must therefore stay a power of two, and the file throws at
import time if it is not.

`layers` must not be empty even though nothing is drawn from tiles — the
engine builds map parts by iterating it, so `layers: {}` means the `Arena`
part is never constructed and the canvas stays black. `physicsStatic` **is**
empty on purpose: an entry there would turn every cell into a static collider
and fill the disc with rock.

---

[← Previous: Core](core.md) · [Next: Extending →](extending.md)
