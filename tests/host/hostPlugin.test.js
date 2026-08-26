import { describe, it, expect, beforeEach, vi } from 'vitest';
import hostPlugin from '../../src/host/index.js';
import ScriptedManager from '../../src/host/ScriptedManager.js';
import botCommand from '../../src/host/botCommand.js';
import { getArenaScaler } from '../../src/host/createModules.js';
import {
  nameCommand,
  newRoundCommand,
  rankCommand,
} from '../../src/host/metaCommands.js';
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

  // the engine has no commands of its own any more: the registry is whatever
  // this array says, and a name registered twice would silently lose one half
  it('declares well-formed, unique chat commands', () => {
    const names = hostPlugin.chatCommands.map(command => command.name);

    for (const command of hostPlugin.chatCommands) {
      expect(command.name.startsWith('/')).toBe(true);
      expect(typeof command.handler).toBe('function');
    }

    expect(new Set(names).size).toBe(names.length);
  });

  // the round and the map here never end, so the two engine commands that
  // reported them would lie — this game simply does not register them
  it('leaves /timeleft and /mapname unregistered', () => {
    const names = hostPlugin.chatCommands.map(command => command.name);

    expect(names).toContain('/name');
    expect(names).toContain('/rank');
    expect(names).not.toContain('/timeleft');
    expect(names).not.toContain('/mapname');
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

describe('/bot', () => {
  // the command reaches the scaler through the module-scope handle
  // `createModules` sets — the same trick StatBridge uses, because a chat
  // command's context has neither the core adapter nor the socket manager in
  // it. So the modules have to exist before the handle answers.
  function buildArenaScaler() {
    hostPlugin.createModules({
      participants: { getHumans: () => [], maxPlayers: 16 },
      coreAdapter: { createMap: vi.fn() },
      socketManager: { sendMap: vi.fn() },
      panel: { reset: vi.fn() },
      stat: {},
      chat: {},
      scripted: {},
    });

    const scaler = getArenaScaler();

    vi.spyOn(scaler, 'reapply').mockImplementation(() => {});

    return scaler;
  }

  const botContext = (created, maxPlayers = 16) => ({
    chat: { pushSystem: vi.fn(), pushSystemByUser: vi.fn() },
    roundManager: { initiateNewRound: vi.fn() },
    participants: { maxPlayers },
    scripted: { createScripted: vi.fn(() => created), removeScripted: vi.fn() },
  });

  it('SETS the count: the old bots go before the new ones are made', () => {
    const ctx = botContext(3);

    botCommand.handler(ctx, '1', ['3']);

    expect(ctx.scripted.removeScripted).toHaveBeenCalled();
    expect(ctx.scripted.createScripted).toHaveBeenCalledWith(3);
    expect(ctx.chat.pushSystem).toHaveBeenCalledWith('BOTS_SET', [3]);
    // the round is endless, so without a restart the new bots would sit as
    // participants with no snake, forever
    expect(ctx.roundManager.initiateNewRound).toHaveBeenCalled();
  });

  it('empties the arena on /bot 0 without restarting the round', () => {
    const ctx = botContext(0);

    botCommand.handler(ctx, '1', ['0']);

    expect(ctx.scripted.removeScripted).toHaveBeenCalled();
    expect(ctx.scripted.createScripted).not.toHaveBeenCalled();
    expect(ctx.chat.pushSystem).toHaveBeenCalledWith('BOTS_SET', [0]);
    expect(ctx.roundManager.initiateNewRound).not.toHaveBeenCalled();
  });

  // the argument comes straight from a chat line: a typo must not wipe the
  // arena, so there is no default count at all
  it('refuses a missing or unreadable count and touches nothing', () => {
    const empty = botContext(1);
    const junk = botContext(1);
    const negative = botContext(1);

    botCommand.handler(empty, '1', []);
    botCommand.handler(junk, '1', ['abc']);
    botCommand.handler(negative, '1', ['-3']);

    for (const ctx of [empty, junk, negative]) {
      expect(ctx.chat.pushSystemByUser).toHaveBeenCalledWith(
        '1',
        'BOT_COUNT_INVALID',
      );
      expect(ctx.scripted.removeScripted).not.toHaveBeenCalled();
      expect(ctx.scripted.createScripted).not.toHaveBeenCalled();
    }
  });

  it('clamps the count to maxPlayers', () => {
    const ctx = botContext(16);

    botCommand.handler(ctx, '1', ['1e9']);

    expect(ctx.scripted.createScripted).toHaveBeenCalledWith(16);
  });

  it('reports the number actually created, not the number asked for', () => {
    const ctx = botContext(2);

    botCommand.handler(ctx, '1', ['5']);

    expect(ctx.chat.pushSystem).toHaveBeenCalledWith('BOTS_SET', [2]);
  });

  // the restart above hands the core `RoundManager._scaledMapData` — the map
  // the ROOM was loaded with, which is the BASE size and not the one the
  // scaler put in force. Without the re-apply, '/bot 20' places twenty snakes
  // on a twenty-cell disc that grows back around them a tick later.
  it('puts the size in force back after the restart', () => {
    const scaler = buildArenaScaler();
    const ctx = botContext(3);

    botCommand.handler(ctx, '1', ['3']);

    expect(scaler.reapply).toHaveBeenCalledTimes(1);
  });

  it('leaves the arena alone when nothing was restarted', () => {
    const scaler = buildArenaScaler();
    const ctx = botContext(0);

    botCommand.handler(ctx, '1', ['0']);

    expect(scaler.reapply).not.toHaveBeenCalled();
  });
});

// The commands the engine used to own: it has none of its own now, so a game
// that wants them declares them (src/host/metaCommands.js).
describe('meta chat commands', () => {
  const metaContext = (isDevMode = false) => ({
    chat: { pushSystem: vi.fn(), pushSystemByUser: vi.fn() },
    roundManager: { changeName: vi.fn(), initiateNewRound: vi.fn() },
    playerDataSync: { getRank: vi.fn(() => 7) },
    isDevMode,
  });

  it('/name hands the whole rest of the line to the engine', () => {
    const ctx = metaContext();

    nameCommand.handler(ctx, '1', ['Long', 'Snake']);

    expect(ctx.roundManager.changeName).toHaveBeenCalledWith('1', 'Long Snake');
  });

  it('/nr restarts the round in dev mode only', () => {
    const dev = metaContext(true);
    const prod = metaContext(false);

    newRoundCommand.handler(dev, '1', []);
    newRoundCommand.handler(prod, '1', []);

    expect(dev.roundManager.initiateNewRound).toHaveBeenCalled();
    expect(prod.roundManager.initiateNewRound).not.toHaveBeenCalled();
    expect(prod.chat.pushSystemByUser).toHaveBeenCalledWith(
      '1',
      'COMMANDS_NOT_FOUND',
    );
  });

  it('/rank answers the player alone, with the engine code', () => {
    const ctx = metaContext();

    rankCommand.handler(ctx, '1', []);

    expect(ctx.playerDataSync.getRank).toHaveBeenCalledWith('1');
    expect(ctx.chat.pushSystemByUser).toHaveBeenCalledWith('1', 'RANK', [7]);
  });
});
