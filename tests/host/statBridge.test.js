import { describe, it, expect, beforeEach, vi } from 'vitest';
import StatBridge from '../../src/host/StatBridge.js';

// The bridge is the only writer of the scoring column in this game: the
// engine fills score and deaths off its kill reports, and this core never
// reports a kill (src/config/game.js). The score is accumulated here and
// nowhere else; `eaten` and `kills` stay internal counters feeding it, and
// `score` is the only column published — the rank column is gone, and the
// ratings are fed by the RESULT OF A GAME (one life) instead.
const TEAM_ID = 1;

/// The engine's participant map, reduced to `get`. The keys are STRINGS, as
/// `ParticipantManager._nextGameId()` makes them — a fixture keyed by numbers
/// is what hid the bug where the bridge looked its ids up as numbers and never
/// wrote a single cell. The objects are stable per id: the bridge compares them
/// by identity to notice that an id changed hands, so a fresh object means a
/// fresh player.
function participantsFor(ids) {
  const people = new Map(
    ids.map(gameId => [gameId, { gameId, teamId: TEAM_ID }]),
  );

  return {
    map: people,
    get: gameId => people.get(gameId) ?? null,
    getAll: () => [...people.values()],
  };
}

/// The values the stat table holds for one id after everything the bridge has
/// written so far. Every column is bodyMethod '=', so the last write wins.
function statOf(stat, gameId) {
  const calls = stat.updateUser.mock.calls.filter(call => call[0] === gameId);

  return calls.length ? calls.at(-1)[2] : null;
}

describe('StatBridge', () => {
  let stat;
  let panel;
  let participants;
  let bridge;

  beforeEach(() => {
    stat = { updateUser: vi.fn() };
    panel = { updateUser: vi.fn() };
    participants = participantsFor(['3', '7']);
    bridge = new StatBridge({ stat, participants });
  });

  it('sums the crystals gained, ignoring the carried total', () => {
    // the core writes the id as a number and the engine keys its participants
    // by strings, so both shapes must land on the same record; `total` is the
    // carried count, which a respawn resets and the boost burns without any
    // event at all
    bridge.onCoreEvent({ type: 'crystals', id: '3', total: 4, gained: 4 }, { stat });
    bridge.onCoreEvent({ type: 'crystals', id: 3, total: 2, gained: 1 }, { stat });

    expect(statOf(stat, '3')).toEqual({ score: 5 });
  });

  // one life is one game: the respawn is what starts the next one, and not
  // the death — the result overlay reads the score off the panel AFTER the
  // crash, and a zero there would show the player nothing of their game
  it('starts every counter over on the respawn, not on the death', () => {
    bridge.onCoreEvent({ type: 'crystals', id: 3, total: 12, gained: 12 }, {});
    bridge.onCoreEvent({ type: 'death', id: 3, crystals: 12, crashes: 1, killer: null }, { panel });

    expect(statOf(stat, '3')).toEqual({ score: 12 });
    expect(panel.updateUser).toHaveBeenLastCalledWith('3', 'score', 12, 'set');

    bridge.onCoreEvent({ type: 'respawn', id: 3 }, { panel });

    expect(statOf(stat, '3')).toEqual({ score: 0 });
    expect(panel.updateUser).toHaveBeenLastCalledWith('3', 'score', 0, 'set');

    bridge.onCoreEvent({ type: 'crystals', id: 3, total: 8, gained: 5 }, {});

    expect(statOf(stat, '3')).toEqual({ score: 5 });
  });

  // the boost burns what the snake carries and sheds it on the map: without
  // this the fastest way to a high score would be to boost forever
  it('takes the burnt crystals off the score', () => {
    bridge.onCoreEvent({ type: 'crystals', id: 3, gained: 20 }, {});
    bridge.onCoreEvent({ type: 'burn', id: 3, burned: 3, total: 17 }, { panel });

    expect(statOf(stat, '3')).toEqual({ score: 17 });
    expect(panel.updateUser).toHaveBeenLastCalledWith('3', 'score', 17, 'set');
  });

  it('never lets a burn push the score below zero', () => {
    // a fresh snake spawns holding `world.startCrystals` it never ate, and
    // can burn every one of them
    bridge.onCoreEvent({ type: 'crystals', id: 3, gained: 2 }, {});
    bridge.onCoreEvent({ type: 'burn', id: 3, burned: 9, total: 0 }, {});

    expect(statOf(stat, '3')).toEqual({ score: 0 });
  });

  // `eaten` means "swallowed", not "still carried": the lifetime total in the
  // saved profile is built on it, and the boost must not eat that history
  it('leaves the eaten total alone when the boost burns', () => {
    const vimp = {
      getPlayerState: vi.fn(() => ({ best: 0, eaten: 0 })),
      setPlayerState: vi.fn(),
    };

    bridge.onCoreEvent({ type: 'crystals', id: 3, gained: 20 }, {});
    bridge.onCoreEvent({ type: 'burn', id: 3, burned: 8, total: 12 }, {});
    bridge.onCoreEvent({ type: 'death', id: 3, killer: null }, { vimp });

    expect(vimp.setPlayerState).toHaveBeenCalledWith('3', { best: 12, eaten: 20 });
  });

  it('pays the killer a flat bonus of 15 per kill', () => {
    bridge.onCoreEvent({ type: 'crystals', id: 3, total: 20, gained: 20 }, {});
    bridge.onCoreEvent({ type: 'crystals', id: 7, total: 5, gained: 5 }, {});

    bridge.onCoreEvent(
      { type: 'death', id: 3, crystals: 20, crashes: 1, killer: 7 },
      {},
    );

    // 5 eaten + one kill worth KILL_BONUS, and nothing of the victim's 20
    expect(statOf(stat, '7')).toEqual({ score: 20 });
    // the victim keeps everything it had earned
    expect(statOf(stat, '3')).toEqual({ score: 20 });
  });

  it('takes nothing away from a victim with a big score', () => {
    bridge.onCoreEvent({ type: 'crystals', id: 3, total: 500, gained: 500 }, {});

    bridge.onCoreEvent(
      { type: 'death', id: 3, crystals: 500, crashes: 1, killer: 7 },
      {},
    );

    // killing the leader is worth the same 15 as killing a fresh snake
    expect(statOf(stat, '7')).toEqual({ score: 15 });
    expect(statOf(stat, '3')).toEqual({ score: 500 });
  });

  it('awards nothing when the arena edge did the killing', () => {
    bridge.onCoreEvent({ type: 'crystals', id: 3, total: 9, gained: 9 }, {});
    stat.updateUser.mockClear();

    bridge.onCoreEvent({ type: 'death', id: 3, crystals: 9, crashes: 1, killer: null }, {});

    expect(stat.updateUser.mock.calls.every(call => call[0] === '3')).toBe(true);
    expect(statOf(stat, '3')).toEqual({ score: 9 });
  });

  it('does not pay a snake for running into itself', () => {
    bridge.onCoreEvent({ type: 'crystals', id: 3, total: 9, gained: 9 }, {});
    bridge.onCoreEvent({ type: 'death', id: 3, crystals: 9, crashes: 1, killer: 3 }, {});

    expect(statOf(stat, '3')).toEqual({ score: 9 });
  });

  // ***** THE RESULT OF ONE GAME *****
  //
  // The rank calls this bridge used to make are gone: a death reports the
  // score of the life that just ended, and the engine decides how that lands
  // in the daily best, the monthly sum and the all-time total.
  it('reports the score of the life that just ended, once', () => {
    const vimp = {
      addPlayerPoints: vi.fn(),
      finishPlayerGame: vi.fn(),
      flushPlayerData: vi.fn(),
      setPlayerState: vi.fn(),
    };

    bridge.onCoreEvent({ type: 'crystals', id: 3, gained: 40 }, { vimp });
    bridge.onCoreEvent({ type: 'death', id: 3, killer: null }, { vimp });

    expect(vimp.addPlayerPoints).toHaveBeenCalledTimes(1);
    expect(vimp.addPlayerPoints).toHaveBeenCalledWith('3', 40);
    expect(vimp.finishPlayerGame).toHaveBeenCalledTimes(1);
    expect(vimp.finishPlayerGame).toHaveBeenCalledWith('3');
  });

  it('reports THIS life only, not the visit', () => {
    const vimp = {
      addPlayerPoints: vi.fn(),
      finishPlayerGame: vi.fn(),
      flushPlayerData: vi.fn(),
      setPlayerState: vi.fn(),
    };

    bridge.onCoreEvent({ type: 'crystals', id: 3, gained: 40 }, { vimp });
    bridge.onCoreEvent({ type: 'death', id: 3, killer: null }, { vimp });
    bridge.onCoreEvent({ type: 'respawn', id: 3 }, { vimp });
    bridge.onCoreEvent({ type: 'crystals', id: 3, gained: 7 }, { vimp });
    bridge.onCoreEvent({ type: 'death', id: 3, killer: null }, { vimp });

    expect(vimp.addPlayerPoints.mock.calls).toEqual([
      ['3', 40],
      ['3', 7],
    ]);
    expect(vimp.finishPlayerGame).toHaveBeenCalledTimes(2);
  });

  it('pushes a new daily best to auth at once, not on the next interval', () => {
    // a record has to be in the database by the time the player presses Tab
    const vimp = {
      addPlayerPoints: vi.fn(),
      finishPlayerGame: vi.fn(),
      flushPlayerData: vi.fn(),
      setPlayerState: vi.fn(),
      isPlayerRatingLoaded: vi.fn(() => true),
      getPlayerRating: vi.fn(() => ({ value: 30, placement: 4, total: 9 })),
    };

    bridge.onCoreEvent({ type: 'crystals', id: 3, gained: 44 }, { vimp });
    bridge.onCoreEvent({ type: 'death', id: 3, killer: null }, { vimp });

    expect(vimp.getPlayerRating).toHaveBeenCalledWith('3', 'day');
    expect(vimp.flushPlayerData).toHaveBeenCalledWith({ urgent: true });
  });

  it('lets an ordinary game wait for the engine interval', () => {
    // `urgent` bypasses the minimum interval AND the backoff; spending it on
    // every death spends the room's whole write budget on deaths. A game that
    // beats nothing changes no table anybody is looking at
    const vimp = {
      addPlayerPoints: vi.fn(),
      finishPlayerGame: vi.fn(),
      flushPlayerData: vi.fn(),
      setPlayerState: vi.fn(),
      isPlayerRatingLoaded: vi.fn(() => true),
      getPlayerRating: vi.fn(() => ({ value: 500, placement: 2, total: 9 })),
    };

    bridge.onCoreEvent({ type: 'crystals', id: 3, gained: 12 }, { vimp });
    bridge.onCoreEvent({ type: 'death', id: 3, killer: null }, { vimp });

    expect(vimp.flushPlayerData).toHaveBeenCalledWith({ urgent: false });
  });

  // `urgent` bypasses the engine's backoff, so spending it on a slice that is
  // NOT LOADED spends the room's whole write budget exactly while the auth
  // service is down — an unloaded slice reads as zero, and a zero makes every
  // death a record. Unknown therefore means "not a record"
  it('does not call an unloaded daily slice a record', () => {
    const vimp = {
      addPlayerPoints: vi.fn(),
      finishPlayerGame: vi.fn(),
      flushPlayerData: vi.fn(),
      setPlayerState: vi.fn(),
      isPlayerRatingLoaded: vi.fn(() => false),
      getPlayerRating: vi.fn(() => ({ value: 0, placement: null, total: 0 })),
    };

    bridge.onCoreEvent({ type: 'crystals', id: 3, gained: 5 }, { vimp });
    bridge.onCoreEvent({ type: 'death', id: 3, killer: null }, { vimp });

    expect(vimp.flushPlayerData).toHaveBeenCalledWith({ urgent: false });
  });

  // an old engine has neither call: the same rule applies, and the points are
  // not lost either way — they wait for the ordinary interval
  it('does not call an old engine without the rating calls a record', () => {
    const vimp = {
      addPlayerPoints: vi.fn(),
      finishPlayerGame: vi.fn(),
      flushPlayerData: vi.fn(),
      setPlayerState: vi.fn(),
    };

    bridge.onCoreEvent({ type: 'crystals', id: 3, gained: 5 }, { vimp });
    bridge.onCoreEvent({ type: 'death', id: 3, killer: null }, { vimp });

    expect(vimp.flushPlayerData).toHaveBeenCalledWith({ urgent: false });
  });

  it('pays the killer BEFORE the victim\'s counters are touched', () => {
    const vimp = {
      addPlayerPoints: vi.fn(),
      finishPlayerGame: vi.fn(),
      flushPlayerData: vi.fn(),
      setPlayerState: vi.fn(),
    };

    bridge.onCoreEvent({ type: 'crystals', id: 7, gained: 5 }, { vimp });
    bridge.onCoreEvent({ type: 'crystals', id: 3, gained: 9 }, { vimp });
    bridge.onCoreEvent({ type: 'death', id: 3, killer: 7 }, { vimp });

    // the killer's bonus is banked in THEIR game and reaches the ratings with
    // their own death, not with the victim's
    expect(statOf(stat, '7')).toEqual({ score: 20 });
    expect(vimp.addPlayerPoints).toHaveBeenCalledTimes(1);
    expect(vimp.addPlayerPoints).toHaveBeenCalledWith('3', 9);
  });

  it('never touches the rank the engine used to keep', () => {
    const vimp = {
      addPlayerRank: vi.fn(),
      getPlayerRank: vi.fn(() => 4),
      isPlayerRankLoaded: vi.fn(() => true),
      addPlayerPoints: vi.fn(),
      finishPlayerGame: vi.fn(),
      flushPlayerData: vi.fn(),
      setPlayerState: vi.fn(),
    };

    bridge.onCoreEvent({ type: 'crystals', id: 3, gained: 50 }, { vimp });
    bridge.onCoreEvent({ type: 'death', id: 3, killer: 7 }, { vimp });
    bridge.onCoreEvent({ type: 'population', count: 2 }, { vimp });

    expect(vimp.addPlayerRank).not.toHaveBeenCalled();
    expect(vimp.getPlayerRank).not.toHaveBeenCalled();
    expect(vimp.isPlayerRankLoaded).not.toHaveBeenCalled();
  });

  // an engine older than this game has none of the four calls above, and a
  // test stub has whatever it was given: every one of them is optional
  it('survives an engine build with none of the new calls', () => {
    expect(() => {
      bridge.onCoreEvent({ type: 'crystals', id: 3, gained: 9 }, { vimp: {}, panel });
      bridge.onCoreEvent({ type: 'burn', id: 3, burned: 2 }, { vimp: {}, panel });
      bridge.onCoreEvent({ type: 'death', id: 3, killer: 7 }, { vimp: {}, panel });
      bridge.onCoreEvent({ type: 'respawn', id: 3 }, { vimp: {}, panel });
      bridge.onCoreEvent({ type: 'population', count: 2 }, { vimp: {}, panel });
    }).not.toThrow();

    expect(statOf(stat, '7')).toEqual({ score: 15 });
  });

  it('writes the score, and only the score, into the HUD panel', () => {
    bridge.onCoreEvent({ type: 'crystals', id: 3, total: 4, gained: 4 }, { panel });

    expect(panel.updateUser).toHaveBeenCalledWith('3', 'score', 4, 'set');
    expect(panel.updateUser).toHaveBeenCalledTimes(1);
  });

  it('starts a game id over when it changes hands', () => {
    bridge.onCoreEvent({ type: 'crystals', id: 3, total: 12, gained: 12 }, {});

    // a player leaves and a new one is given the same id: the engine builds a
    // new Participant, and the counters must not be inherited
    participants.map.set('3', { gameId: '3', teamId: TEAM_ID });
    bridge.onCoreEvent({ type: 'crystals', id: 3, total: 4, gained: 4 }, {});

    expect(statOf(stat, '3')).toEqual({ score: 4 });
  });

  it('zeroes every counter on an explicit reset', () => {
    bridge.onCoreEvent({ type: 'crystals', id: 3, total: 12, gained: 12 }, {});
    bridge.reset('3');
    bridge.onCoreEvent({ type: 'crystals', id: 3, total: 2, gained: 2 }, {});

    expect(statOf(stat, '3')).toEqual({ score: 2 });
  });

  it('keeps a personal best of the score in the saved profile', () => {
    const vimp = {
      getPlayerState: vi.fn(() => ({ best: 8, eaten: 20 })),
      setPlayerState: vi.fn(),
    };

    bridge.onCoreEvent({ type: 'crystals', id: 3, total: 12, gained: 12 }, {});
    bridge.onCoreEvent({ type: 'death', id: 3, crystals: 12, crashes: 1 }, { vimp });

    expect(vimp.setPlayerState).toHaveBeenCalledWith('3', { best: 12, eaten: 32 });
  });

  it('does not lower a personal best', () => {
    const vimp = {
      getPlayerState: vi.fn(() => ({ best: 30, eaten: 30 })),
      setPlayerState: vi.fn(),
    };

    bridge.onCoreEvent({ type: 'crystals', id: 3, total: 5, gained: 5 }, {});
    bridge.onCoreEvent({ type: 'death', id: 3, crystals: 5, crashes: 2 }, { vimp });

    expect(vimp.setPlayerState).toHaveBeenCalledWith('3', { best: 30, eaten: 35 });
  });

  it('adds each crystal to the lifetime total exactly once', () => {
    // two deaths in one visit: the second flush must carry only what was eaten
    // after the first, or a long-lived player inflates the profile
    const state = { best: 0, eaten: 0 };
    const vimp = {
      getPlayerState: vi.fn(() => state),
      setPlayerState: vi.fn((gameId, next) => Object.assign(state, next)),
    };

    bridge.onCoreEvent({ type: 'crystals', id: 3, total: 10, gained: 10 }, {});
    bridge.onCoreEvent({ type: 'death', id: 3, crystals: 10, crashes: 1 }, { vimp });
    bridge.onCoreEvent({ type: 'respawn', id: 3 }, {});
    bridge.onCoreEvent({ type: 'crystals', id: 3, total: 4, gained: 4 }, {});
    bridge.onCoreEvent({ type: 'death', id: 3, crystals: 4, crashes: 2 }, { vimp });

    expect(state.eaten).toBe(14);
    // `best` is the top score of a single LIFE, so the second game's 4 does
    // not add to the first game's 10 — it loses to it
    expect(state.best).toBe(10);
  });

  it('ignores an id that is not a participant any more', () => {
    // a snake can crash on the same tick its player disconnects
    bridge.onCoreEvent({ type: 'crystals', id: 99, total: 5, gained: 5 }, { panel });

    expect(stat.updateUser).not.toHaveBeenCalled();
    expect(panel.updateUser).not.toHaveBeenCalled();
  });

  it('ignores an event type it does not know', () => {
    expect(() => bridge.onCoreEvent({ type: 'nothing', id: 3 })).not.toThrow();
    expect(() => bridge.onCoreEvent(null)).not.toThrow();
    expect(stat.updateUser).not.toHaveBeenCalled();
  });

  // a population report is the only hook this bridge gets when a participant
  // APPEARS: until a row is written it shows the column's bodyValue, a flat
  // zero
  describe('newcomers', () => {
    it('writes the row of a participant nobody has scored for yet', () => {
      bridge.onCoreEvent({ type: 'population', count: 2 }, { vimp: {}, panel });

      expect(statOf(stat, '3')).toEqual({ score: 0 });
      expect(statOf(stat, '7')).toEqual({ score: 0 });
    });

    it('writes it once and leaves the row to the events after that', () => {
      bridge.onCoreEvent({ type: 'population', count: 2 }, { vimp: {}, panel });
      stat.updateUser.mockClear();

      bridge.onCoreEvent({ type: 'population', count: 2 }, { vimp: {}, panel });

      expect(stat.updateUser).not.toHaveBeenCalled();
    });

    it('publishes a row again when the id changes hands', () => {
      bridge.onCoreEvent({ type: 'population', count: 2 }, { vimp: {}, panel });

      // the engine builds a fresh Participant per join: same id, new player
      participants.map.set('3', { gameId: '3', teamId: TEAM_ID });
      stat.updateUser.mockClear();

      bridge.onCoreEvent({ type: 'population', count: 2 }, { vimp: {}, panel });

      expect(statOf(stat, '3')).toEqual({ score: 0 });
      expect(statOf(stat, '7')).toBe(null);
    });

    // a join or a leave is a natural moment to persist what the room has
    // earned. It is a REQUEST: the interval and the per-server ceiling belong
    // to the engine now (PlayerDataSync), not to the game
    it('asks the engine to sync the profiles, without urging it', () => {
      const vimp = { flushPlayerData: vi.fn() };

      bridge.onCoreEvent({ type: 'population', count: 2 }, { vimp, panel });

      expect(vimp.flushPlayerData).toHaveBeenCalledWith();
    });
  });
});
