import { describe, it, expect, beforeEach, vi } from 'vitest';
import StatBridge from '../../src/host/StatBridge.js';

// The bridge is the only writer of the scoring columns in this game: the
// engine fills score and deaths off its kill reports, and this core never
// reports a kill (src/config/game.js). The score is accumulated here and
// nowhere else; `eaten` and `kills` stay internal counters feeding it, and the
// only columns published are `score` and the engine's `rank`.
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

  it('keeps the counters across a death and a respawn', () => {
    bridge.onCoreEvent({ type: 'crystals', id: 3, total: 12, gained: 12 }, {});
    bridge.onCoreEvent({ type: 'death', id: 3, crystals: 12, crashes: 1, killer: null }, {});
    bridge.onCoreEvent({ type: 'respawn', id: 3 }, {});
    bridge.onCoreEvent({ type: 'crystals', id: 3, total: 8, gained: 5 }, {});

    expect(statOf(stat, '3')).toEqual({ score: 17 });
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

  it('pays the killer one rank point through the engine facade', () => {
    // this game never emits CoreEvent::Death, so RoundManager.reportKill —
    // the engine's own rank writer — never runs; the bridge does it instead
    const vimp = { addPlayerRank: vi.fn(), setPlayerState: vi.fn() };

    bridge.onCoreEvent(
      { type: 'death', id: 3, crystals: 9, crashes: 1, killer: 7 },
      { vimp },
    );

    expect(vimp.addPlayerRank).toHaveBeenCalledTimes(1);
    expect(vimp.addPlayerRank).toHaveBeenCalledWith('7', 1);
  });

  it('leaves the rank alone on an edge crash and on a suicide', () => {
    const vimp = { addPlayerRank: vi.fn(), setPlayerState: vi.fn() };

    bridge.onCoreEvent(
      { type: 'death', id: 3, crystals: 9, crashes: 1, killer: null },
      { vimp },
    );
    bridge.onCoreEvent(
      { type: 'death', id: 3, crystals: 9, crashes: 2, killer: 3 },
      { vimp },
    );

    expect(vimp.addPlayerRank).not.toHaveBeenCalled();
  });

  it('survives an engine build without addPlayerRank', () => {
    const vimp = { setPlayerState: vi.fn() };

    expect(() => bridge.onCoreEvent(
      { type: 'death', id: 3, crystals: 9, crashes: 1, killer: 7 },
      { vimp },
    )).not.toThrow();

    expect(statOf(stat, '7')).toEqual({ score: 15 });
  });

  it('writes the score, and only the score, into the HUD panel', () => {
    bridge.onCoreEvent({ type: 'crystals', id: 3, total: 4, gained: 4 }, { panel });

    expect(panel.updateUser).toHaveBeenCalledWith('3', 'score', 4, 'set');
    expect(panel.updateUser).toHaveBeenCalledTimes(1);
  });

  it('publishes the rank the engine keeps, next to the score', () => {
    // the bridge counts no rank of its own: `addPlayerRank` moves it and
    // `getPlayerRank` reads it back at publish time
    const vimp = { getPlayerRank: vi.fn(() => 4) };

    bridge.onCoreEvent({ type: 'crystals', id: 3, total: 4, gained: 4 }, { vimp });

    expect(vimp.getPlayerRank).toHaveBeenCalledWith('3');
    expect(statOf(stat, '3')).toEqual({ score: 4, rank: 4 });
  });

  it('writes no rank at all when the engine has none for the id', () => {
    // the column is bodyMethod '=', so publishing undefined would replace the
    // last known rank with an empty cell
    const vimp = { getPlayerRank: vi.fn(() => undefined) };

    bridge.onCoreEvent({ type: 'crystals', id: 3, total: 4, gained: 4 }, { vimp });

    expect(statOf(stat, '3')).toEqual({ score: 4 });
  });

  it('survives an engine build without getPlayerRank', () => {
    expect(() => bridge.onCoreEvent(
      { type: 'crystals', id: 3, total: 4, gained: 4 },
      { vimp: {}, panel },
    )).not.toThrow();

    expect(statOf(stat, '3')).toEqual({ score: 4 });
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
    expect(state.best).toBe(14);
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
  // zero, however high the rank the master returned
  describe('newcomers', () => {
    it('writes the row of a participant nobody has scored for yet', () => {
      const vimp = { getPlayerRank: vi.fn(() => 120) };

      bridge.onCoreEvent({ type: 'population', count: 2 }, { vimp, panel });

      expect(statOf(stat, '3')).toEqual({ score: 0, rank: 120 });
      expect(statOf(stat, '7')).toEqual({ score: 0, rank: 120 });
    });

    it('writes it once and leaves the row to the events after that', () => {
      const vimp = { getPlayerRank: vi.fn(() => 1) };

      bridge.onCoreEvent({ type: 'population', count: 2 }, { vimp, panel });
      stat.updateUser.mockClear();

      bridge.onCoreEvent({ type: 'population', count: 2 }, { vimp, panel });

      expect(stat.updateUser).not.toHaveBeenCalled();
    });

    it('publishes a row again when the id changes hands', () => {
      const vimp = { getPlayerRank: vi.fn(() => 5) };

      bridge.onCoreEvent({ type: 'population', count: 2 }, { vimp, panel });

      // the engine builds a fresh Participant per join: same id, new player
      participants.map.set('3', { gameId: '3', teamId: TEAM_ID });
      stat.updateUser.mockClear();

      bridge.onCoreEvent({ type: 'population', count: 2 }, { vimp, panel });

      expect(statOf(stat, '3')).toEqual({ score: 0, rank: 5 });
      expect(statOf(stat, '7')).toBe(null);
    });

    it('survives an engine without the rank getters', () => {
      expect(() =>
        bridge.onCoreEvent({ type: 'population', count: 2 }, { vimp: {}, panel }),
      ).not.toThrow();

      expect(statOf(stat, '3')).toEqual({ score: 0 });
    });
  });
});
