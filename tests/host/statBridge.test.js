import { describe, it, expect, beforeEach, vi } from 'vitest';
import StatBridge from '../../src/host/StatBridge.js';

// The bridge is the only writer of the scoring columns in this game: the
// engine fills score and deaths off its kill reports, and this core never
// reports a kill (src/config/game.js). Everything the player is ranked by —
// eaten, kills, score — is accumulated here and nowhere else.
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

    expect(statOf(stat, '3')).toEqual({ eaten: 5, kills: 0, score: 5 });
  });

  it('keeps the counters across a death and a respawn', () => {
    bridge.onCoreEvent({ type: 'crystals', id: 3, total: 12, gained: 12 }, {});
    bridge.onCoreEvent({ type: 'death', id: 3, crystals: 12, crashes: 1, killer: null }, {});
    bridge.onCoreEvent({ type: 'respawn', id: 3 }, {});
    bridge.onCoreEvent({ type: 'crystals', id: 3, total: 8, gained: 5 }, {});

    expect(statOf(stat, '3')).toEqual({ eaten: 17, kills: 0, score: 17 });
  });

  it('hands the killer the whole score of the victim', () => {
    bridge.onCoreEvent({ type: 'crystals', id: 3, total: 20, gained: 20 }, {});
    bridge.onCoreEvent({ type: 'crystals', id: 7, total: 5, gained: 5 }, {});

    bridge.onCoreEvent(
      { type: 'death', id: 3, crystals: 20, crashes: 1, killer: 7 },
      {},
    );

    expect(statOf(stat, '7')).toEqual({ eaten: 5, kills: 1, score: 25 });
    // the victim keeps everything it had earned
    expect(statOf(stat, '3')).toEqual({ eaten: 20, kills: 0, score: 20 });
  });

  it('pays the killer before it touches the victim', () => {
    // the order is the whole point: reading the victim's score after its own
    // bookkeeping would award nothing for killing the leader
    bridge.onCoreEvent({ type: 'crystals', id: 3, total: 20, gained: 20 }, {});
    stat.updateUser.mockClear();

    bridge.onCoreEvent(
      { type: 'death', id: 3, crystals: 20, crashes: 1, killer: 7 },
      {},
    );

    const [first] = stat.updateUser.mock.calls;

    expect(first[0]).toBe('7');
    expect(first[2].score).toBe(20);
  });

  it('awards nothing when the arena edge did the killing', () => {
    bridge.onCoreEvent({ type: 'crystals', id: 3, total: 9, gained: 9 }, {});
    stat.updateUser.mockClear();

    bridge.onCoreEvent({ type: 'death', id: 3, crystals: 9, crashes: 1, killer: null }, {});

    expect(stat.updateUser.mock.calls.every(call => call[0] === '3')).toBe(true);
    expect(statOf(stat, '3')).toEqual({ eaten: 9, kills: 0, score: 9 });
  });

  it('does not pay a snake for running into itself', () => {
    bridge.onCoreEvent({ type: 'crystals', id: 3, total: 9, gained: 9 }, {});
    bridge.onCoreEvent({ type: 'death', id: 3, crystals: 9, crashes: 1, killer: 3 }, {});

    expect(statOf(stat, '3')).toEqual({ eaten: 9, kills: 0, score: 9 });
  });

  it('writes the same three numbers into the HUD panel', () => {
    bridge.onCoreEvent({ type: 'crystals', id: 3, total: 4, gained: 4 }, { panel });

    expect(panel.updateUser).toHaveBeenCalledWith('3', 'eaten', 4, 'set');
    expect(panel.updateUser).toHaveBeenCalledWith('3', 'kills', 0, 'set');
    expect(panel.updateUser).toHaveBeenCalledWith('3', 'score', 4, 'set');
  });

  it('starts a game id over when it changes hands', () => {
    bridge.onCoreEvent({ type: 'crystals', id: 3, total: 12, gained: 12 }, {});

    // a player leaves and a new one is given the same id: the engine builds a
    // new Participant, and the counters must not be inherited
    participants.map.set('3', { gameId: '3', teamId: TEAM_ID });
    bridge.onCoreEvent({ type: 'crystals', id: 3, total: 4, gained: 4 }, {});

    expect(statOf(stat, '3')).toEqual({ eaten: 4, kills: 0, score: 4 });
  });

  it('zeroes every counter on an explicit reset', () => {
    bridge.onCoreEvent({ type: 'crystals', id: 3, total: 12, gained: 12 }, {});
    bridge.reset('3');
    bridge.onCoreEvent({ type: 'crystals', id: 3, total: 2, gained: 2 }, {});

    expect(statOf(stat, '3')).toEqual({ eaten: 2, kills: 0, score: 2 });
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
});
