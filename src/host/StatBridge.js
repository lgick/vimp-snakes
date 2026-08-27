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
// The core knows one number: how many crystals a snake CARRIES. A crash empties
// it and the boost burns it, which makes it useless as a score. So the three
// numbers a player is ranked by are kept here, per game id, and none of them
// ever goes down:
//
//   eaten  — crystals swallowed, summed over every life;
//   kills  — snakes that crashed into this one;
//   score  — eaten plus KILL_BONUS per kill.
//
// Only `score` is published: `eaten` and `kills` are the inputs of the formula
// (and of the saved profile), not columns of their own — the stat table shows
// name, status, rank, score and ping and nothing else. The rank is not counted
// here at all: `vimp.addPlayerRank()` keeps it, and `vimp.getPlayerRank()` is
// read back at publish time.
//
// The core reports the crystals GAINED on a pickup, not just the new carried
// total, and that is what these add up. Diffing totals on this side would be
// wrong in both directions: a respawn hands out `world.startCrystals` without
// an event, and the boost burns fuel without one either.
//
// A kill pays a FIXED bonus and nothing else: the victim's score is not
// transferred and not lost. Handing over the whole score used to be the rule,
// but the victim's crystals already scatter on the map for the killer to eat,
// so the transfer was a second reward on top of the first and the leaders'
// scores ran away.
//
// There is no round in this game, so there is no moment to reset on either.
// The counters start at zero when a participant is first seen and are dropped
// when the id changes hands: `reset(gameId)` does it explicitly, and
// `_record()` does it by itself when the participant object behind an id is a
// different one than last time (the engine builds a new Participant per join).
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
    // gameId -> { participant, eaten, kills, score, flushedEaten }
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

      case 'death':
        this._onDeath(gameId, data, vimp, panel);
        break;

      // 'respawn' is deliberately not here: none of the three counters is
      // touched by a new life, that is the whole point of keeping them
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

  // A death pays the killer a flat KILL_BONUS plus one rank point, and then
  // touches the victim. A suicide (`killer === gameId`) and a crash into the
  // edge (`killer === null`) pay nobody — the engine convention is that a
  // suicide leaves the rank alone.
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

        // this game never emits CoreEvent::Death, so RoundManager.reportKill
        // — the only place the engine touches rank itself — never runs; the
        // optional call keeps old engine builds and test stubs working
        vimp?.addPlayerRank?.(killerId, 1);

        this._publish(killerId, killer, vimp, panel);
      }
    }

    // the victim loses only what it was carrying, and the core empties that
    // panel cell itself; the three counters here survive the crash
    this._publish(gameId, victim, vimp, panel);
    this._recordBest(gameId, victim, vimp);
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
    };

    this._totals.set(gameId, fresh);

    return fresh;
  }

  // Both readers of the counters at once: the panel is the player's own HUD,
  // the stat table is the scoreboard everybody sees.
  //
  // `panel` is optional only because a caller may not have one; the engine
  // always passes it. It is safe to write here because the id got this far —
  // `_record()` found a participant, and the engine calls `panel.addUser()`
  // for every participant it creates. `Panel.updateUser` on an id it never
  // saw throws, so that order matters.
  //
  // The rank comes from the engine (`HostGame.getPlayerRank`), not from a
  // counter of our own — `vimp.addPlayerRank()` is what moves it. A missing
  // method or a missing player gives `undefined`, and that is NOT written:
  // the column is bodyMethod '=', so an empty value would replace the last
  // known rank with a blank cell.
  _publish(gameId, record, vimp, panel) {
    const { score } = record;
    const rank = vimp?.getPlayerRank?.(gameId);
    const columns = { score };

    if (rank !== undefined && rank !== null) {
      columns.rank = rank;
    }

    this._stat.updateUser(gameId, record.participant.teamId, columns);

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
  // `best` is the top SCORE reached, not the crystals carried at the moment of
  // one crash — the score is what the table ranks by. `eaten` is a lifetime
  // sum across matches, so only the part not flushed yet is added.
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
