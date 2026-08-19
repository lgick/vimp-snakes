import { describe, it, expect, beforeEach } from 'vitest';
import ParticipantManager from 'vimp-engine/host/meta/player/ParticipantManager.js';
import Panel, { resetPanel } from 'vimp-engine/host/meta/modules/Panel.js';
import Stat, { resetStat } from 'vimp-engine/host/meta/modules/Stat.js';
import StatBridge from '../../src/host/StatBridge.js';
import gameConfig from '../../src/config/game.js';

// The unit tests above use doubles; this one wires the bridge to the REAL
// engine modules, because the bug it guards against lived exactly in the seam
// between them: the engine hands out game ids as STRINGS
// (`ParticipantManager._nextGameId()`), the core writes them into its custom
// events as NUMBERS, and a bridge that looked them up as numbers found no
// participant and wrote nothing — a panel and a stat table frozen at zero.
const TEAM = 'players';

describe('StatBridge against the engine modules', () => {
  let participants;
  let panel;
  let stat;
  let bridge;
  let gameId;

  beforeEach(() => {
    // both engine modules are singletons
    resetPanel();
    resetStat();

    participants = new ParticipantManager(
      gameConfig.teams,
      gameConfig.spectatorTeam,
      gameConfig.roomDefaults.maxPlayers,
      gameConfig.scripted,
    );
    panel = new Panel(gameConfig.panel);
    // `processUpdates` prefixes every batch with the round time
    panel.injectTimerManager({ getRoundTimeLeft: () => 0 });
    stat = new Stat(gameConfig.stat, gameConfig.teams);

    gameId = participants.createScripted({
      team: TEAM,
      model: gameConfig.scripted.defaultModel,
    });

    const participant = participants.get(gameId);

    stat.addUser(gameId, participant.teamId, { name: participant.name });
    panel.addUser(gameId);

    bridge = new StatBridge({ participants, stat });
  });

  it('gives out string game ids the core reports as numbers', () => {
    expect(typeof gameId).toBe('string');
  });

  it('moves a pickup into both the stat table and the HUD panel', () => {
    // the payload is shaped exactly like core/src/game.rs writes it
    bridge.onCoreEvent(
      { type: 'crystals', id: Number(gameId), total: 6, gained: 6 },
      { panel },
    );

    const [rows] = stat.getFull();
    const [, , columns] = rows.find(row => row[0] === gameId);

    expect(columns[gameConfig.stat.eaten.key]).toBe(6);
    expect(columns[gameConfig.stat.score.key]).toBe(6);

    const updates = panel.processUpdates();

    expect(updates[gameId]).toEqual(
      expect.arrayContaining([
        `${gameConfig.panel.fields.eaten.key}:6`,
        `${gameConfig.panel.fields.score.key}:6`,
      ]),
    );
  });

  it('hands a killer the victim score through the same path', () => {
    const victimId = participants.createScripted({
      team: TEAM,
      model: gameConfig.scripted.defaultModel,
    });
    const victim = participants.get(victimId);

    stat.addUser(victimId, victim.teamId, { name: victim.name });
    panel.addUser(victimId);

    bridge.onCoreEvent(
      { type: 'crystals', id: Number(victimId), total: 9, gained: 9 },
      { panel },
    );
    bridge.onCoreEvent(
      {
        type: 'death',
        id: Number(victimId),
        crystals: 9,
        crashes: 1,
        killer: Number(gameId),
      },
      { panel },
    );

    const [rows] = stat.getFull();
    const [, , columns] = rows.find(row => row[0] === gameId);

    expect(columns[gameConfig.stat.kills.key]).toBe(1);
    expect(columns[gameConfig.stat.score.key]).toBe(9);
  });
});
