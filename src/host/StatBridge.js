// Turns the core's custom events into the three things the engine keeps for a
// player: the HUD panel, the stat table and the saved profile.
//
// Why this class exists at all. In every other VIMP game the engine fills the
// stat table itself, off the kill reports. This one never reports a kill (see
// the note atop src/config/game.js), so nothing would ever be written — and
// the columns the game ranks by are not the engine's anyway.
//
// The engine does allow it: `Stat.updateUser(gameId, teamId, { column: value })`
// resolves the column BY NAME against `gameConfig.stat`, so any column declared
// there can be written by whoever holds the instance. The catch is who holds
// it: `stat` is handed to `createModules` and to nothing else — the
// `onCoreEvent` context is exactly `{ vimp, panel }`. Hence a module created
// there, kept by `createModules.js`, and called from `onCoreEvent`.
//
// ***** THE SCORING MODEL *****
//
// ONE LIFE IS ONE GAME. The core knows one number: how many crystals a snake
// CARRIES. A crash empties it and the boost burns it, which makes it useless
// as a score of its own, so the three numbers are kept here, per game id, and
// all three are reset by a RESPAWN:
//
//   eaten  — crystals swallowed during this life;
//   kills  — snakes that crashed into this one during this life;
//   score  — eaten plus KILL_BONUS per kill, minus what the boost burnt.
//
// Reset on the respawn and not on the death: the result overlay
// (src/client/gameOver.js) reads the score out of the HUD panel AFTER the
// death, and zeroing it there would show the player a zero instead of their
// result.
//
// Only `score` is published: `eaten` and `kills` are the inputs of the formula
// (and of the saved profile), not columns of their own. The stat table shows
// name, status, score and ping and nothing else — the rank column is gone, and
// with it every rank call this bridge used to make: the ratings are fed by the
// RESULT OF A GAME now (see `_onDeath`), and the engine decides how that
// result lands in the daily, monthly and all-time slices.
//
// The core reports the crystals GAINED on a pickup, not just the new carried
// total, and that is what these add up. Diffing totals on this side would be
// wrong in both directions: a respawn hands out `world.startCrystals` without
// a pickup event, and the boost burns fuel through a `burn` event of its own.
//
// A kill pays a FIXED bonus and nothing else: the victim's score is not
// transferred and not lost. Handing over the whole score used to be the rule,
// but the victim's crystals already scatter on the map for the killer to eat,
// so the transfer was a second reward on top of the first and the leaders'
// scores ran away. The killer's bonus reaches the ratings with the KILLER's
// own death, together with the rest of their game.
//
// The counters start at zero when a participant is first seen and are dropped
// when the id changes hands: `reset(gameId)` does it explicitly, and
// `_record()` does it by itself when the participant object behind an id is a
// different one than last time (the engine builds a new Participant per join).
//
// ***** A KNOWN LIMITATION *****
//
// A player who leaves in the MIDDLE of a life does not hand that unfinished
// score to the ratings: `HostGame.removeUser` starts its final flush before
// the core reports the departure, so there is no moment left to report the
// result in. Catching that race costs more than it is worth, and by the rule
// this game is scored by ("the score at the END of a game") an unfinished
// game has nothing to report anyway.
//
// All the stat columns are declared with `bodyMethod: '='` and every panel
// write is a 'set': these are totals, not deltas, so a re-sent value is
// harmless and a dropped one self-heals on the next event.

// What one kill is worth in `score`, on top of the victim's crystals that
// scatter on the map anyway.
const KILL_BONUS = 15;

export default class StatBridge {
  constructor({ participants, stat }) {
    this._participants = participants;
    this._stat = stat;
    // gameId -> { participant, eaten, kills, score, flushedEaten, published }
    this._totals = new Map();
  }

  // `data` is the payload of a CoreEvent::Custom, `ctx` the `onCoreEvent`
  // context — `{ vimp, panel }` and nothing else.
  //
  // ***** IDS ARE STRINGS *****
  //
  // The core writes an id as a NUMBER into the JSON payload, while the engine
  // hands out game ids as strings (`ParticipantManager._nextGameId()` returns
  // `counter.toString(10)`) and keeps the participants in a Map keyed by them.
  // `Map.get(0)` therefore misses `'0'`, `_record()` returns null and not a
  // single cell is ever written — which is exactly what "the panel and the
  // table stay at zero" looked like. Everything below goes through String().
  onCoreEvent(data, ctx = {}) {
    if (!data || typeof data !== 'object') {
      return;
    }

    const { vimp, panel } = ctx;
    const gameId = String(data.id);

    switch (data.type) {
      case 'crystals':
        this._onCrystals(gameId, Number(data.gained) || 0, vimp, panel);
        break;

      // the boost eats what the snake carries and sheds it on the map: the
      // score has to follow, or boosting would be free
      case 'burn':
        this._onBurn(gameId, Number(data.burned) || 0, vimp, panel);
        break;

      case 'death':
        this._onDeath(gameId, data, vimp, panel);
        break;

      // a new life is a new game: the counters start over
      case 'respawn':
        this._onRespawn(gameId, vimp, panel);
        break;

      // the core reports the crowd on every join and leave
      // (`src/host/ArenaScaler.js` resizes the arena off it). It is also the
      // only hook this bridge gets that fires when a participant APPEARS, and
      // a row nobody has written yet shows the column's `bodyValue` — a flat
      // zero
      case 'population':
        this._publishNewcomers(vimp, panel);
        // a join or a leave is a natural moment to persist what the room has
        // earned so far. It is a REQUEST and not a decision: the interval
        // (and the per-server ceiling) belongs to the engine's PlayerDataSync
        vimp?.flushPlayerData?.();
        break;

      default:
        break;
    }
  }

  /// Drops the counters of one game id, so the next event starts them over.
  /// `_record()` reaches the same state on its own when it sees a different
  /// Participant object behind a familiar id.
  reset(gameId) {
    this._totals.delete(gameId);
  }

  // One pickup, worth `gained` crystals.
  _onCrystals(gameId, gained, vimp, panel) {
    const record = this._record(gameId);

    if (!record || gained <= 0) {
      return;
    }

    record.eaten += gained;
    record.score += gained;

    this._publish(gameId, record, vimp, panel);
  }

  // The boost burnt `burned` crystals. They come off the score and NOT off
  // `eaten`: `eaten` means "swallowed", not "still carried", and the lifetime
  // sum in `playerState.eaten` is built on it.
  _onBurn(gameId, burned, vimp, panel) {
    const record = this._record(gameId);

    if (!record || burned <= 0) {
      return;
    }

    // the floor matters: a snake that spawns with `world.startCrystals` can
    // burn fuel it never ate, and a negative score is not a thing
    record.score = Math.max(0, record.score - burned);

    this._publish(gameId, record, vimp, panel);
  }

  // A death pays the killer a flat KILL_BONUS, and then ENDS THE VICTIM'S
  // GAME. A suicide (`killer === gameId`) and a crash into the edge
  // (`killer === null`) pay nobody.
  _onDeath(gameId, data, vimp, panel) {
    const victim = this._record(gameId);

    if (!victim) {
      return;
    }

    const killerId = data.killer === null || data.killer === undefined
      ? null
      : String(data.killer);

    if (killerId !== null && killerId !== gameId) {
      const killer = this._record(killerId);

      if (killer) {
        killer.kills += 1;
        killer.score += KILL_BONUS;

        this._publish(killerId, killer, vimp, panel);
      }
    }

    // the victim keeps its cells until the respawn: the result overlay reads
    // the score off the panel after the death
    this._publish(gameId, victim, vimp, panel);

    // ***** THE RESULT OF ONE GAME *****
    //
    // The game reports a number; how it lands in the daily best, the monthly
    // sum and the all-time total is the platform's decision (`finishGame` in
    // the engine's PlayerDataSync). There is deliberately no "delta against
    // today's value" arithmetic on this side.
    //
    // The optional calls keep old engine builds and test stubs working — the
    // same reason `addPlayerRank` was called that way before them.
    vimp?.addPlayerPoints?.(gameId, victim.score);
    vimp?.finishPlayerGame?.(gameId);

    this._recordBest(gameId, victim, vimp);

    // urgent, unlike the request on 'population': a new daily best has to be
    // in the database by the time the player presses Tab, not a minute later
    vimp?.flushPlayerData?.({ urgent: true });
  }

  // A new life: the score starts at zero and the HUD says so.
  _onRespawn(gameId, vimp, panel) {
    const record = this._record(gameId);

    if (!record) {
      return;
    }

    record.eaten = 0;
    record.kills = 0;
    record.score = 0;
    // `eaten` restarts, so the watermark of what has already gone into the
    // lifetime profile has to restart with it — otherwise the next death
    // would subtract a total that no longer exists
    record.flushedEaten = 0;

    this._publish(gameId, record, vimp, panel);
  }

  /// The counters of one game id, created on first sight. Returns null for an
  /// id that is not a participant any more — a snake can crash on the same
  /// tick its player disconnects.
  _record(gameId) {
    const participant = this._participants.get(gameId);

    if (!participant) {
      return null;
    }

    const record = this._totals.get(gameId);

    // the engine builds a fresh Participant per join, so a different object
    // behind the same id means a different player: start their counters over
    if (record && record.participant === participant) {
      return record;
    }

    const fresh = {
      participant,
      eaten: 0,
      kills: 0,
      score: 0,
      // how much of `eaten` has already gone into the saved profile
      flushedEaten: 0,
      // whether the stat row has ever been written for this participant
      published: false,
    };

    this._totals.set(gameId, fresh);

    return fresh;
  }

  // Writes the row of every participant whose row has never been written.
  //
  // Only the first time: after that the row is owned by the events, and
  // rewriting it here would cost a stat message per join for everyone in the
  // room.
  _publishNewcomers(vimp, panel) {
    for (const participant of this._participants.getAll()) {
      const gameId = participant.gameId;
      // the record this participant already has, if it is theirs: `_record`
      // creates one as a side effect, and a method called "publish" has no
      // business seeding state for the whole room. A record left by a
      // PREVIOUS holder of this id is not theirs — `_record` is what starts
      // the counters over, so that case goes through it
      const cached = this._totals.get(gameId);
      const record =
        cached?.participant === participant ? cached : this._record(gameId);

      if (record && !record.published) {
        this._publish(gameId, record, vimp, panel);
      }
    }
  }

  // Both readers of the counters at once: the panel is the player's own HUD,
  // the stat table is the row the engine keeps for the room.
  //
  // `panel` is optional only because a caller may not have one; the engine
  // always passes it. It is safe to write here because the id got this far —
  // `_record()` found a participant, and the engine calls `panel.addUser()`
  // for every participant it creates. `Panel.updateUser` on an id it never
  // saw throws, so that order matters.
  //
  // One column and nothing else. The rank column used to be written here off
  // `vimp.getPlayerRank()`, gated on `isPlayerRankLoaded` so a not-yet-loaded
  // zero could not overwrite a real number; both are gone with the column
  // itself — by Tab the player now sees the global daily top ten, which the
  // client fetches for itself (`modules.stat.params.mode: 'leaderboard'`).
  _publish(gameId, record, vimp, panel) {
    const { score } = record;

    record.published = true;

    this._stat.updateUser(gameId, record.participant.teamId, { score });

    if (!panel) {
      return;
    }

    panel.updateUser(gameId, 'score', score, 'set');
  }

  // The per-(user, game) profile the engine keeps on the auth service: opaque
  // JSON, seeded from `gameConfig.playerState.defaultState`, flushed on round
  // end, map change and departure. It is the only place a personal record can
  // outlive the match.
  //
  // `best` is the top score of a single LIFE — the game the ratings are fed
  // with, not a running total across a visit. `eaten` is a lifetime sum across
  // matches, so only the part not flushed yet is added.
  _recordBest(gameId, record, vimp) {
    if (!vimp?.getPlayerState) {
      return;
    }

    const state = vimp.getPlayerState(gameId);

    if (!state) {
      return;
    }

    const gained = record.eaten - record.flushedEaten;

    record.flushedEaten = record.eaten;

    const best = Math.max(Number(state.best) || 0, record.score);
    const eaten = (Number(state.eaten) || 0) + gained;

    vimp.setPlayerState(gameId, { ...state, best, eaten });
  }
}
