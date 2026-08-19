// Turns the core's custom events into the two things the engine keeps for a
// player: the stat table and the saved profile.
//
// Why this class exists at all. In every other VIMP game the engine fills the
// stat table itself, off the kill reports. This one never reports a kill (see
// the note atop src/config/game.js), so nothing would ever be written — and
// the column the game ranks by is not kills anyway, it is crystals.
//
// The engine does allow it: `Stat.updateUser(gameId, teamId, { column: value })`
// resolves the column BY NAME against `gameConfig.stat`, so any column declared
// there can be written by whoever holds the instance. The catch is who holds
// it: `stat` is handed to `createModules` and to nothing else — the
// `onCoreEvent` context is exactly `{ vimp, panel }`. Hence a module created
// there, kept by `createModules.js`, and called from `onCoreEvent`.
//
// Both columns are declared with `bodyMethod: '='`: the core reports totals,
// not deltas, so a re-sent event is harmless and a missed one self-heals.
export default class StatBridge {
  constructor({ participants, stat }) {
    this._participants = participants;
    this._stat = stat;
  }

  // `data` is the payload of a CoreEvent::Custom. Ids arrive stringified by
  // the adapter, so every one of them goes through Number().
  onCoreEvent(data, vimp) {
    if (!data || typeof data !== 'object') {
      return;
    }

    const gameId = Number(data.id);

    switch (data.type) {
      case 'crystals':
        this._write(gameId, { score: Number(data.total) || 0 });
        break;

      case 'death':
        // the table shows what a snake is carrying NOW, so a crash empties it;
        // `crashes` is a running total, which is why the column replaces
        // rather than accumulates
        this._write(gameId, {
          score: 0,
          deaths: Number(data.crashes) || 0,
        });
        this._recordBest(gameId, Number(data.crystals) || 0, vimp);
        break;

      case 'respawn':
        this._write(gameId, { score: 0 });
        break;

      default:
        break;
    }
  }

  _write(gameId, values) {
    const participant = this._participants.get(gameId);

    if (!participant) {
      return;
    }

    this._stat.updateUser(gameId, participant.teamId, values);
  }

  // The per-(user, game) profile the engine keeps on the auth service: opaque
  // JSON, seeded from `gameConfig.playerState.defaultState`, flushed on round
  // end, map change and departure. It is the only place a personal record can
  // outlive the match.
  _recordBest(gameId, crystals, vimp) {
    if (!vimp?.getPlayerState) {
      return;
    }

    const state = vimp.getPlayerState(gameId);

    if (!state) {
      return;
    }

    const best = Math.max(Number(state.best) || 0, crystals);
    const eaten = (Number(state.eaten) || 0) + crystals;

    vimp.setPlayerState(gameId, { ...state, best, eaten });
  }
}
