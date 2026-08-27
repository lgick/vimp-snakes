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

// ***** WHAT MOVES THE RANK *****
//
// `rank` is the engine's cross-game number, the one `/rank` reports and the
// only one that outlives the session. Its built-in rule is ±1 per KILL, and
// in this game a kill is somebody driving into YOU: you cannot go and get
// one. A 20 000-tick headless run with bots ends with every kill credited to
// a bot and zero for the humans — which is exactly what "my rank is always 0"
// looks like from the inside.
//
// So the rank is fed by the thing a player actually does here: crystals. One
// point per `CRYSTALS_PER_RANK` swallowed, on top of the point per kill,
// counted off `eaten` — the counter that never goes down — so a crash costs
// nothing already earned.
const CRYSTALS_PER_RANK = 25;

// How often the accumulated rank/state is pushed to the auth service.
//
// The engine syncs profiles at the end of a round and at a map change
// (`RoundManager` -> `PlayerDataSync.flushAll`). This game has neither: the
// round is endless and the arena is rebuilt underneath the engine
// (src/host/ArenaScaler.js). Left alone, a match's rank would reach auth only
// when a participant LEAVES — and the host's own player, whose tab simply
// closes, would never be written at all. Hence `vimp.flushPlayerData()` on a
// timer of our own, and only when there is something new to send.
const FLUSH_INTERVAL_MS = 60_000;

export default class StatBridge {
  constructor({ participants, stat }) {
    this._participants = participants;
    this._stat = stat;
    // gameId -> { participant, eaten, kills, score, flushedEaten,
    //             rankedEaten, published }
    this._totals = new Map();
    // when the profiles were last pushed to auth, and whether anything has
    // changed since (see FLUSH_INTERVAL_MS)
    this._lastFlush = 0;
    this._rankDirty = false;
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

      // the core reports the crowd on every join and leave
      // (`src/host/ArenaScaler.js` resizes the arena off it). It is also the
      // only hook this bridge gets that fires when a participant APPEARS, and
      // a row nobody has written yet shows the column's `bodyValue` — a flat
      // zero — however high the rank the master returned for them
      case 'population':
        this._publishNewcomers(vimp, panel);
        // a join or a leave is a natural moment to persist what the room has
        // earned so far — the only other one this game has is a departure
        this._maybeFlush(vimp);
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

    // whole points only, and off the running total rather than this pickup:
    // twenty pickups of one crystal are worth the same as one of twenty
    while (record.eaten - record.rankedEaten >= CRYSTALS_PER_RANK) {
      record.rankedEaten += CRYSTALS_PER_RANK;
      this._addRank(gameId, 1, vimp);
    }

    this._publish(gameId, record, vimp, panel);
    this._maybeFlush(vimp);
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
        this._addRank(killerId, 1, vimp);

        this._publish(killerId, killer, vimp, panel);
      }
    }

    // the victim loses only what it was carrying, and the core empties that
    // panel cell itself; the three counters here survive the crash
    this._publish(gameId, victim, vimp, panel);
    this._recordBest(gameId, victim, vimp);
    this._maybeFlush(vimp);
  }

  // One rank point, and a note that auth is now behind. Bots have no profile
  // on the auth service, so the engine's own call is a no-op for them — the
  // flag is not, which is why it is set here and not by the callers.
  _addRank(gameId, delta, vimp) {
    // the optional call keeps old engine builds and test stubs working: this
    // game never emits CoreEvent::Death, so RoundManager.reportKill — the
    // only place the engine touches rank itself — never runs
    vimp?.addPlayerRank?.(gameId, delta);
    this._rankDirty = true;
  }

  // Pushes the profiles to auth if anything changed and the interval is up.
  // `Date.now()` and not a timer: `createModules` gets no TimerManager, and
  // the events this bridge already handles arrive many times a second.
  _maybeFlush(vimp) {
    if (!this._rankDirty || !vimp?.flushPlayerData) {
      return;
    }

    const now = Date.now();

    if (now - this._lastFlush < FLUSH_INTERVAL_MS) {
      return;
    }

    this._lastFlush = now;
    this._rankDirty = false;

    // best-effort by contract: the engine's promise never rejects, and a
    // failed PUT is retried by the next flush with the delta still owed
    vimp.flushPlayerData();
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
      // how much of `eaten` has already been paid out as rank
      rankedEaten: 0,
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
  // room. `PlayerDataSync.load` is asynchronous, so the rank may not have
  // arrived yet — a row written without it does not count as written, and
  // the next join or leave tries again (see `_publish`).
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
  // the stat table is the scoreboard everybody sees.
  //
  // `panel` is optional only because a caller may not have one; the engine
  // always passes it. It is safe to write here because the id got this far —
  // `_record()` found a participant, and the engine calls `panel.addUser()`
  // for every participant it creates. `Panel.updateUser` on an id it never
  // saw throws, so that order matters.
  //
  // The rank comes from the engine (`HostGame.getPlayerRank`), not from a
  // counter of our own — `vimp.addPlayerRank()` is what moves it. It is
  // written only once the engine says it has actually arrived: the column is
  // bodyMethod '=', and `getPlayerRank` answers 0 both for an id it does not
  // know and for one whose `PlayerDataSync.load()` is still in flight, so a
  // blind write puts a flat zero in the place of a rank of 120. An engine
  // build without `isPlayerRankLoaded` simply never gets the column written
  // by this bridge — a missing rank is a cell the player has not filled yet,
  // a wrong one is a lie the table keeps repeating.
  //
  // The row counts as PUBLISHED only when the rank made it in. Everything
  // 'population' owes a newcomer has to be in that row, and until the rank is
  // there the next join or leave has to try again — of which there are
  // exactly as many as there are joins and leaves.
  _publish(gameId, record, vimp, panel) {
    const { score } = record;
    const columns = { score };
    const rankReady = vimp?.isPlayerRankLoaded?.(gameId) ?? false;

    if (rankReady) {
      columns.rank = vimp.getPlayerRank(gameId);
    }

    record.published = rankReady;

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
