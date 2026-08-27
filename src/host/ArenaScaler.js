import { arenaSizeFor, buildArena, PLAYER_STEP } from '../data/maps/arena.js';

// Grows and shrinks the arena with the crowd.
//
// ***** WHY THE MAP IS REBUILT AT RUNTIME AT ALL *****
//
// The area per snake is the whole difficulty curve of this game: on a disc
// tuned for eight, thirty-two snakes are a traffic jam where nobody survives
// the first minute. So the arena is a function of how many are in it —
// `src/data/maps/arena.js` owns the law, this class owns WHEN it is applied.
//
// ***** THE TWO CHANNELS, AND WHY NEITHER IS THE ENGINE'S *****
//
// The engine loads a map once per round and the room here has one endless
// round, so its own map path (`RoundManager.forceChangeMap`) is not an option:
// it clears the world, empties the panel and the stat table and takes every
// snake off the canvas. Nothing about a resize should cost a player their
// score.
//
// What a resize actually needs is exactly two messages, and the plugin holds
// both ends:
//
//   * `coreAdapter.createMap(mapData)` -> `GameCore.load_map`, which swaps
//     `ctx.map` and touches no actor. `core/src/game.rs` rebuilds `Arena` from
//     `ctx.map` on EVERY fixed step, so the new disc is live on the next one;
//   * `socketManager.sendMap(socketId, mapData)` -> MAP_DATA, which on the
//     client destroys the parts of this `setId`, rebuilds them from the
//     payload and re-runs `clientCore.set_map`. The client half derives the
//     ring from the same grid, so it needs no other channel and no new field.
//
// The client answers MAP_DATA with MAP_READY, and the engine's `mapReady`
// handler is a no-op for a player who is already loaded on this map name —
// the map name does not change here, only its size. That is what makes the
// re-send safe mid-match.
//
// ***** WHEN *****
//
// There is no join/leave hook in the host plugin contract. The core is what
// notices: `core/src/game.rs` emits a `population` custom event whenever the
// number of snakes changes, and `src/host/index.js` routes it here.
//
// Population is rounded up to `PLAYER_STEP` before the size is computed, and a
// shrink additionally waits until the room is a whole step below the size in
// force. One player toggling around a boundary therefore does not rebuild the
// map of everyone else twice a second.
//
// A snake left outside a shrunken disc dies on its next step, by the ordinary
// boundary rule — that is deliberate, and it is why the shrink is the slow
// direction.
export default class ArenaScaler {
  // `ctx` is the createModules context; `scriptedManager` is the bot manager
  // built next to this one — NOT `ctx.scripted`, which is the gameConfig
  // object of the same name and has no methods at all.
  constructor({ participants, coreAdapter, socketManager }, scriptedManager) {
    this._participants = participants;
    this._coreAdapter = coreAdapter;
    this._socketManager = socketManager;
    this._scriptedManager = scriptedManager;

    // population the current arena was built for, and the size it came out as
    this._population = null;
    this._size = null;
    this._mapData = null;

    // gameId -> the size that client last received. A player who joined
    // between two resizes was handed the CATALOG map by the engine, which is
    // the base size and not necessarily the one in force; the next event
    // catches them up.
    this._delivered = new Map();
  }

  // `data` is the payload of a CoreEvent::Custom. Everything that is not a
  // population report belongs to another bridge.
  onCoreEvent(data) {
    if (!data || data.type !== 'population') {
      return;
    }

    this._apply(Number(data.count) || 0);
  }

  // Rebuilds the map when the crowd has moved the size, and in any case makes
  // sure every loaded client is on the size in force.
  _apply(count) {
    const size = this._sizeFor(count);

    if (size !== this._size) {
      this._size = size;
      this._population = count;

      const mapData = buildArena(count);

      // the core first: a client that repaints before the core has the new
      // disc would draw a boundary the simulation is not enforcing yet
      this._coreAdapter.createMap(mapData);

      // the bot manager hands out respawn points off the map it was last
      // given; the old points belong to the old disc
      this._scriptedManager?.createMap(mapData);

      this._mapData = mapData;
      this._delivered.clear();
    }

    this._broadcast();
  }

  // The size for `count`, with the hysteresis: growing follows the law at
  // once, shrinking waits until the room is a full step below the population
  // the current arena was built for.
  _sizeFor(count) {
    if (this._size === null) {
      return arenaSizeFor(count);
    }

    const next = arenaSizeFor(count);

    if (next > this._size) {
      return next;
    }

    return count <= this._population - PLAYER_STEP ? next : this._size;
  }

  // Sends the map in force to every loaded client that has not got it yet. A
  // client still in the loading handshake is skipped: it is being handed the
  // catalog map by the engine right now, and it lands here on the next event.
  _broadcast() {
    if (!this._mapData) {
      return;
    }

    const humans = this._participants.getHumans();

    for (const user of humans) {
      if (!user.isReady || this._delivered.get(user.gameId) === this._size) {
        continue;
      }

      this._delivered.set(user.gameId, this._size);
      this._socketManager.sendMap(user.socketId, this._mapData);
    }

    // a room that has been running for hours has seen far more ids than it
    // holds; the bookkeeping must not grow with the ones that left
    if (this._delivered.size > humans.length) {
      const live = new Set(humans.map(user => user.gameId));

      for (const gameId of this._delivered.keys()) {
        if (!live.has(gameId)) {
          this._delivered.delete(gameId);
        }
      }
    }
  }

  // Re-sends the map in force to the core and to every client, without
  // touching the hysteresis.
  //
  // The engine's `RoundManager._startRound` hands the core `this._scaledMapData`
  // — the map the ROOM was loaded with, which is the base size and not the one
  // this class put in force. Anything that restarts the round therefore silently
  // reverts the arena to twenty cells, and the snakes it respawns are packed
  // into the middle of a disc that is about to grow back around them. `/bot N`
  // is the one path in this game that restarts a round (src/host/botCommand.js),
  // so it calls this immediately afterwards.
  //
  // `_size` and `_population` are deliberately left alone: nothing about the
  // crowd changed, only what the core happens to be holding.
  reapply() {
    if (!this._mapData) {
      return;
    }

    this._coreAdapter.createMap(this._mapData);
    this._scriptedManager?.createMap(this._mapData);

    // every client has to be told again: the engine's round restart re-sent
    // them the base map too
    this._delivered.clear();
    this._broadcast();
  }

  // The map currently in force, or null before the first population report.
  get mapData() {
    return this._mapData ?? null;
  }
}
