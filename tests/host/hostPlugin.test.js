import { describe, it, expect, beforeEach, vi } from 'vitest';
import hostPlugin from '../../src/host/index.js';
import ScriptedManager from '../../src/host/ScriptedManager.js';
import StatBridge from '../../src/host/StatBridge.js';
import spawnCommand from '../../src/host/spawnCommand.js';
import mapData from '../../src/data/maps/arena.js';

// The only playing team of this game: everyone is a snake and there is nothing
// to be on the other side of (src/config/game.js).
const TEAM = 'players';
const CAPACITY = mapData.respawns[TEAM].length;

// The engine dereferences the fields below without a guard and calls the five
// scripted methods by name — both are contracts no browser run announces
// before it crashes.
describe('HostPlugin surface', () => {
  it('exports every field the engine reads', () => {
    expect(typeof hostPlugin.id).toBe('string');
    expect(typeof hostPlugin.engineApi).toBe('number');
    expect(typeof hostPlugin.createCore).toBe('function');
    expect(typeof hostPlugin.gameConfig).toBe('object');
    expect(typeof hostPlugin.authSchema).toBe('object');
    expect(typeof hostPlugin.createModules).toBe('function');
    expect(typeof hostPlugin.buildClientGameConfig).toBe('function');
    expect(typeof hostPlugin.onCoreEvent).toBe('function');
    expect(Array.isArray(hostPlugin.chatCommands)).toBe(true);
  });

  it('does not shadow an engine chat command', () => {
    const reserved = ['/name', '/nr', '/timeleft', '/mapname', '/rank'];

    for (const command of hostPlugin.chatCommands) {
      expect(command.name.startsWith('/')).toBe(true);
      expect(reserved).not.toContain(command.name);
    }
  });

  it('keeps its system message codes out of the engine groups', () => {
    // engine groups and their last index
    const reserved = { s: 6, v: 5, m: 1, c: 1, n: 1 };

    for (const code of Object.values(hostPlugin.systemMessages)) {
      const [group, index] = code.split(':');

      expect(Number(index) > (reserved[group] ?? -1)).toBe(true);
    }
  });

  it('survives a core event arriving before the modules exist', () => {
    // createModules has not run in this file, so the bridge is null — and a
    // throw here would take down the Worker
    expect(() =>
      hostPlugin.onCoreEvent({ type: 'crystals', id: 1, total: 3 }, {}),
    ).not.toThrow();
  });
});

// Minimal doubles of the engine modules: the manager only ever talks to these
// five, and a real one would drag the whole host runtime into a unit test.
function createContext({ teamSizes = { [TEAM]: 0 }, isFull = false } = {}) {
  const created = [];
  const sizes = { ...teamSizes };
  let nextId = 10;

  const participants = {
    isFull,
    getPlayableTeams: () => Object.keys(sizes),
    getTeamSize: team => sizes[team] ?? 0,
    createScripted: ({ team, model }) => {
      const gameId = (nextId += 1);

      created.push({ gameId, team, model, isScripted: true, teamId: 1 });
      sizes[team] += 1;

      return gameId;
    },
    get: gameId => created.find(item => item.gameId === gameId),
    getScripted: () => created,
    remove: gameId => {
      const index = created.findIndex(item => item.gameId === gameId);

      if (index !== -1) {
        sizes[created[index].team] -= 1;
        created.splice(index, 1);
      }
    },
  };

  return {
    participants,
    coreAdapter: { removePlayer: vi.fn() },
    panel: { addUser: vi.fn(), removeUser: vi.fn() },
    stat: { addUser: vi.fn(), removeUser: vi.fn(), updateUser: vi.fn() },
    scripted: hostPlugin.gameConfig.scripted,
  };
}

describe('ScriptedManager', () => {
  let ctx;
  let manager;

  beforeEach(() => {
    ctx = createContext();
    manager = new ScriptedManager(ctx);
    manager.createMap(mapData);
  });

  it('creates nothing before a map is known', () => {
    const fresh = new ScriptedManager(createContext());

    expect(fresh.createScripted(2)).toBe(0);
  });

  it('puts every bot in the only playing team', () => {
    expect(manager.createScripted(4)).toBe(4);
    expect(manager.getCountsPerTeam()).toEqual({ [TEAM]: 4 });
  });

  it('gives a bot an empty status, not a dead one', () => {
    // the engine never writes that cell in this game — it is never told anyone
    // died — so whatever is passed at creation is what the table shows forever
    manager.createScripted(1);

    expect(ctx.stat.addUser).toHaveBeenCalledWith(
      expect.any(Number),
      1,
      expect.objectContaining({ status: '', latency: 'BOT' }),
    );
  });

  it('stops at the respawn capacity of the team', () => {
    // the number of respawn points is the hard ceiling: past it the engine has
    // nowhere to put the actor
    expect(manager.createScripted(CAPACITY + 3, TEAM)).toBe(CAPACITY);
  });

  it('creates nothing once the team is out of respawn points', () => {
    const crowded = new ScriptedManager(
      createContext({ teamSizes: { [TEAM]: CAPACITY } }),
    );

    crowded.createMap(mapData);

    expect(crowded.createScripted(1)).toBe(0);
  });

  it('creates nothing once the room is full', () => {
    const full = new ScriptedManager(createContext({ isFull: true }));

    full.createMap(mapData);

    expect(full.createScripted(3)).toBe(0);
  });

  it('frees exactly one slot for a human', () => {
    manager.createScripted(2, TEAM);

    expect(manager.removeOneForHuman(TEAM)).toBe(true);
    expect(manager.getCountsPerTeam()).toEqual({ [TEAM]: 1 });
    expect(manager.removeOneForHuman('spectators')).toBe(false);
  });

  it('removes bots of one team or of all of them', () => {
    manager.createScripted(3, TEAM);

    manager.removeScripted('spectators');
    expect(manager.getCountsPerTeam()).toEqual({ [TEAM]: 3 });

    manager.removeScripted();
    expect(manager.getCountsPerTeam()).toEqual({});
  });
});

// The bridge is the only writer of the stat table in this game: the engine
// writes score and deaths off its kill reports, and this core never reports a
// kill (src/config/game.js).
describe('StatBridge', () => {
  let stat;
  let bridge;

  beforeEach(() => {
    stat = { updateUser: vi.fn() };
    bridge = new StatBridge({
      stat,
      participants: { get: gameId => (gameId === 3 ? { gameId, teamId: 1 } : null) },
    });
  });

  it('writes the crystal total into the score column', () => {
    // ids arrive stringified from the adapter
    bridge.onCoreEvent({ type: 'crystals', id: '3', total: 12 });

    expect(stat.updateUser).toHaveBeenCalledWith(3, 1, { score: 12 });
  });

  it('empties the score and records the crash count on a death', () => {
    bridge.onCoreEvent({ type: 'death', id: 3, crystals: 12, crashes: 4 });

    expect(stat.updateUser).toHaveBeenCalledWith(3, 1, { score: 0, deaths: 4 });
  });

  it('keeps a personal best in the saved profile', () => {
    const vimp = {
      getPlayerState: vi.fn(() => ({ best: 8, eaten: 20 })),
      setPlayerState: vi.fn(),
    };

    bridge.onCoreEvent({ type: 'death', id: 3, crystals: 12, crashes: 1 }, vimp);

    expect(vimp.setPlayerState).toHaveBeenCalledWith(3, { best: 12, eaten: 32 });
  });

  it('does not lower a personal best', () => {
    const vimp = {
      getPlayerState: vi.fn(() => ({ best: 30, eaten: 30 })),
      setPlayerState: vi.fn(),
    };

    bridge.onCoreEvent({ type: 'death', id: 3, crystals: 5, crashes: 2 }, vimp);

    expect(vimp.setPlayerState).toHaveBeenCalledWith(3, { best: 30, eaten: 35 });
  });

  it('ignores an id that is not a participant any more', () => {
    // a snake can crash on the same tick its player disconnects
    bridge.onCoreEvent({ type: 'crystals', id: 99, total: 5 });

    expect(stat.updateUser).not.toHaveBeenCalled();
  });

  it('ignores an event type it does not know', () => {
    expect(() => bridge.onCoreEvent({ type: 'nothing', id: 3 })).not.toThrow();
    expect(() => bridge.onCoreEvent(null)).not.toThrow();
    expect(stat.updateUser).not.toHaveBeenCalled();
  });
});

describe('/spawn', () => {
  const spawnContext = (created, maxPlayers = 16) => ({
    chat: { pushSystem: vi.fn() },
    roundManager: { initiateNewRound: vi.fn() },
    participants: { maxPlayers },
    scripted: { createScripted: vi.fn(() => created) },
  });

  it('reports the number actually created and restarts the round', () => {
    const ctx = spawnContext(2);

    spawnCommand.handler(ctx, 1, ['3']);

    expect(ctx.scripted.createScripted).toHaveBeenCalledWith(3);
    expect(ctx.chat.pushSystem).toHaveBeenCalledWith('BOTS_SPAWNED', [2]);
    // the round is endless, so without a restart the new bots would sit as
    // participants with no snake, forever
    expect(ctx.roundManager.initiateNewRound).toHaveBeenCalled();
  });

  it('defaults to a single bot', () => {
    const ctx = spawnContext(1);

    spawnCommand.handler(ctx, 1, []);

    expect(ctx.scripted.createScripted).toHaveBeenCalledWith(1);
  });

  // the argument comes straight from a chat line
  it('clamps the count to [1, maxPlayers]', () => {
    const negative = spawnContext(1);
    const huge = spawnContext(1);

    spawnCommand.handler(negative, 1, ['-3']);
    spawnCommand.handler(huge, 1, ['1e9']);

    expect(negative.scripted.createScripted).toHaveBeenCalledWith(1);
    expect(huge.scripted.createScripted).toHaveBeenCalledWith(16);
  });

  it('does not restart the round when nothing was created', () => {
    const ctx = spawnContext(0);

    spawnCommand.handler(ctx, 1, ['3']);

    expect(ctx.chat.pushSystem).toHaveBeenCalledWith('BOTS_SPAWNED', [0]);
    expect(ctx.roundManager.initiateNewRound).not.toHaveBeenCalled();
  });
});
