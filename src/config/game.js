import snapshot from './snapshot.js';
import models from '../data/models.js';
import weapons from '../data/weapons.js';
import maps from '../data/maps/index.js';

// HostPlugin.gameConfig — the authoritative description of the game: what the
// engine meta needs (teams, panel, stat, room form) and what it hands over to
// the Rust core untouched (models, weapons, playerKeys, snapshot).
//
// The engine asserts eight paths right after import — roomDefaults.maxPlayers,
// snapshot, parts.models, parts.weapons, parts.friendlyFire, panel.fields,
// playerKeys, teams. The ninth, `spectatorTeam`, is required of every game
// EXCEPT one that declares `noSpectators` (see teams below), which is checked
// instead for holding exactly one team. Everything else is read lazily, which
// is why a typo elsewhere surfaces as a black canvas rather than an error: run
// `npm run check:contract` after every change here.
//
// ***** THE ONE STRUCTURAL DECISION IN THIS FILE *****
//
// Snakes has no rounds and no engine-managed death. A snake that crashes is
// killed, emptied and respawned BY THE CORE; the core deliberately never emits
// `CoreEvent::Death`. That is not a shortcut, it is the only way to get the
// game the design asks for, and it follows from three facts about the engine:
//
//   * a round ends only through `reportKill` with a killer
//     (`RoundManager._checkTeamWipe`), so not reporting kills is what makes
//     the round endless;
//   * there is NO per-player respawn inside a round — the only spawn primitive
//     is private to `_startRound()` — so a game where death is routine has to
//     own its own respawn;
//   * therefore the engine never writes `score`/`deaths` either, which leaves
//     the playing columns of the stat table free for the one number this
//     game actually ranks by — the score, crystals eaten plus a flat bonus per
//     kill. `src/host/StatBridge.js` writes it (and the rank next to it),
//     reached from `onCoreEvent` through `src/host/createModules.js`.
export default {
  title: 'Vimp Snakes',

  parts: {
    models,
    // snakes have no weapons; the key is a mandatory path, see the file
    weapons,
    // no friendly fire concept either — a snake kills by being in the way —
    // but the path is asserted at boot, so it exists and stays false
    friendlyFire: false,

    // Nothing else lives here on purpose. A free-form `parts.*` key does reach
    // the client config — but NOT a part: a part is constructed with
    // `(data, assets, dependencies)`, and `dependencies` only ever holds the
    // three engine services. So the palette and the arena colours are plain
    // imports on the client side (`src/data/palette.js`, `src/data/theme.js`)
    // and the simulation numbers live in `models` (see the note there).
  },

  // the binary protocol layout; the engine passes it to both cores and to the
  // client, knowing nothing about the meaning of a field
  snapshot,

  // Engine event -> name in the sound registry. ALL of them are null on
  // purpose: every one of these five cues fires off the engine's round and
  // kill machinery, which this game does not use. The two sounds it does have
  // are played by the parts through `soundManager`, positionally — the pickup
  // by `Crystal.destroy()`, the death by the result overlay.
  soundCues: {
    roundStart: null,
    victory: null,
    defeat: null,
    frag: null,
    death: null,
  },

  // No `initialVote`: there is no vote to offer. A joining player is already
  // in the only team there is (see `noSpectators` below), so the engine hands
  // them a snake instead of a question.

  maps,
  currentMap: 'arena',
  mapScale: 1,
  // fallback for a map without its own setId
  mapSetId: 'c1',
  mapsInVote: 1,

  // The engine merges this object SHALLOWLY over hostDefaults, so overriding
  // `timers` replaces the whole thing — every key it had has to be restated
  // here, not just the two that change.
  //
  // roundTime and mapTime are pinned at roomTimeMax (1 hour), the ceiling the
  // host clamps to. With `endlessRound` the round timer expiring now does
  // nothing at all rather than restarting the round, but the hour stays: the
  // panel's time cell counts down off it, and mapTime still owns the map.
  timers: {
    // leave alone: the CORE's step is read from the engine hostDefaults, not
    // from here, so changing this desyncs the Worker loop from the physics
    timeStep: 1000 / 120,
    networkSendRate: 4,

    roundTime: 3600000,
    mapTime: 3600000,

    roomTimeMin: 10000,
    roomTimeMax: 3600000,

    voteTime: 10000,
    timeBlockedVote: 30000,
    teamChangeGracePeriod: 10000,
    roundRestartDelay: 5000,
    mapChangeDelay: 2000,
    rttPingInterval: 3000,
    idleCheckInterval: 30000,
  },

  // starting profile of a player with no saved record on the auth service.
  // The engine keeps it as opaque JSON — the game is the only reader
  playerState: {
    defaultState: { best: 0, eaten: 0 },
  },

  // One team: everyone is a snake, there is a single stat table and nothing to
  // be on the other side of. `noSpectators` is the engine flag that makes that
  // literal — no spectator team, no `spectatorTeam` key, no vote on the way
  // in: `ParticipantManager.createHuman` puts the player straight into
  // `players` and `RoundManager.admitPlayer` gives them a snake as soon as
  // their first frame is acknowledged. Without it every joiner sat in the stat
  // table as a spectator row until they answered a vote.
  noSpectators: true,

  // The second engine flag, and deliberately a separate one: it silences every
  // round restart the engine starts by itself. The one that matters here is
  // "fewer than two active humans -> stat.reset() + new round", which wiped the
  // scoreboard for everyone whenever the room emptied to a single player; the
  // round timer below and the team wipe are covered by the same flag.
  endlessRound: true,

  teams: {
    players: 1,
  },

  // bots: the name prefix the engine numbers, and the model they spawn with
  scripted: {
    namePrefix: 'Snake',
    defaultModel: 's1',
  },

  // Action name -> bit and kind. The engine ships this table into both cores
  // verbatim and never interprets it: `type: 1` (one-shot) is a CONVENTION
  // the core implements — `down` arms the bit, exactly one fixed step consumes
  // it, `up` is ignored. Every name here must have a key in keySetList[1]
  // (src/config/client.js) or it can never be pressed.
  //
  // A snake is always moving: there is no forward and no brake. A and D turn,
  // W boosts while held, R is the respawn the death overlay presses for you.
  playerKeys: {
    left: { key: 1 << 0 },
    right: { key: 1 << 1 },
    boost: { key: 1 << 2 },
    respawn: { key: 1 << 3, type: 1 },
  },

  // HUD, host half: `key` is the short wire key, `value` the starting amount.
  // The key 't' is reserved by the engine for the round time — never declare
  // it here, and always declare a type: 'time' cell for it on the client.
  //
  // Three numbers, and only one of them is shown: `score` accumulates for the
  // whole visit and survives death, while `crystals` (what the snake CARRIES —
  // a crash empties it, the boost burns it, the core writes it) and `dead` are
  // data the client reads rather than displays. They stay declared because
  // invariant 6 (panelContract) makes the client name every host field.
  // `src/host/StatBridge.js` is the only writer of `score`.
  panel: {
    fields: {
      // carried right now: the geometry of the snake and the fuel of the boost
      crystals: { key: 'c', value: 0 },
      // crystals eaten over the whole visit plus a flat bonus per kill
      score: { key: 's', value: 0 },
      // 0 while alive; otherwise "crystals + 1", which is how the client tells
      // "dead with zero crystals" from "alive" through a channel whose values
      // floor at 0. `src/client/index.js` shows the result overlay off it.
      dead: { key: 'd', value: 0 },
    },
    // Cell showing the "active weapon". There is no weapon, so the core uses
    // it for the drive mode and pushes CoreEvent::PanelActive with the literal
    // string it should read. Leaving this null is not an option: the panel
    // then sends the literal key 'null' to every client.
    activeKey: 'wa',
  },

  // Statistics table, host half. `key` is the column index on the wire,
  // matched positionally by src/config/client.js.
  //
  // Two columns are the engine's and must keep their names: `name` (nickname)
  // and `latency` (ping). `status` is the engine's too — RoundManager writes
  // '' into it when a player is admitted — so the column stays even though
  // this game never reports a death.
  //
  // The one playing column — `score` — is written by THIS GAME, not by the
  // engine (see the note at the top of the file), and carries bodyMethod '='
  // (replace) rather than '+' (accumulate): `src/host/StatBridge.js` keeps the
  // running total itself and reports the result, so a re-sent value is
  // harmless and a dropped one self-heals on the next event.
  //
  // The `rank` column is gone: by Tab the client no longer shows this room at
  // all but the game's global daily top ten, which it fetches for itself
  // (`modules.stat.params.mode: 'leaderboard'` in src/config/client.js). The
  // schema stays anyway — the engine keeps writing `name`, `status` and
  // `latency` into its own table (RoundManager, RTTManager), and dropping the
  // columns would break those paths.
  //
  // `deaths`, `eaten` and `kills` are gone on purpose too: the engine never
  // fills `deaths` here, and the other two are inputs to the score rather than
  // numbers a player reads — StatBridge still counts them internally.
  stat: {
    name: {
      key: 0,
      bodyMethod: '=',
      headSync: true,
      headMethod: '#',
    },
    status: {
      key: 1,
      bodyMethod: '=',
      bodyValue: '',
      headValue: '',
    },
    score: {
      key: 2,
      bodyMethod: '=',
      bodyValue: 0,
      headMethod: '+',
      headValue: 0,
    },
    latency: {
      key: 3,
      bodyMethod: '=',
    },
  },

  // The ceiling of the room, and the only one there is: the master no longer
  // caps it (`HostRegistry` reads this very number out of the manifest), so
  // what is written here is what a room may hold. The map has to be able to
  // seat them — `src/data/maps/arena.js` keeps 64 respawn points and grows the
  // disc with the crowd, and `npm run check:contract` fails the build if the
  // points ever stop covering this number.
  roomDefaults: {
    maxPlayers: 32,
  },

  // The lobby "create server" form. The names must be exactly the keys the
  // host honours (maxPlayers, map, roundTime, mapTime, friendlyFire) —
  // anything else is accepted by the form and silently dropped.
  //
  // roundTime and mapTime are deliberately absent: the round is endless by
  // design, and a room that could shorten it would restart the arena every few
  // minutes. friendlyFire is absent because the game has no such rule.
  roomForm: [
    {
      name: 'maxPlayers',
      control: 'text',
      label: 'Max players',
      numeric: true,
    },
    { name: 'map', control: 'select', label: 'Map', source: 'maps' },
  ],
};
