import { describe, it, expect } from 'vitest';
import gameConfig from '../../src/config/game.js';
import maps from '../../src/data/maps/index.js';

// Starter test of the config invariants the build itself depends on. Keep it
// growing with the config: a silent mismatch here surfaces as a game missing
// from the lobby, not as a stack trace.
describe('gameConfig', () => {
  it('names an existing current map', () => {
    expect(Object.keys(maps)).toContain(gameConfig.currentMap);
  });

  // noSpectators: the engine gate demands exactly one team and no
  // spectatorTeam key — a leftover second team would be a team nobody can
  // ever reach, and the boot gate refuses the config outright
  it('declares one team and no spectators', () => {
    expect(gameConfig.noSpectators).toBe(true);
    expect(Object.keys(gameConfig.teams)).toEqual(['players']);
    expect(gameConfig.spectatorTeam).toBeUndefined();
  });

  // the round is endless in the engine's terms too: nothing it starts by
  // itself may wipe the stat table, which is this game's only score
  it('asks the engine to leave the round alone', () => {
    expect(gameConfig.endlessRound).toBe(true);
    expect(gameConfig.initialVote).toBeUndefined();
  });

  it('gives every playing team respawns for a full room', () => {
    const playing = Object.keys(gameConfig.teams).filter(
      team => team !== gameConfig.spectatorTeam,
    );

    for (const map of Object.values(maps)) {
      for (const team of playing) {
        expect(map.respawns[team]?.length ?? 0).toBeGreaterThanOrEqual(
          gameConfig.roomDefaults.maxPlayers,
        );
      }
    }
  });

  it('builds the room form out of the fields the host honours', () => {
    const honoured = [
      'maps',
      'maxPlayers',
      'map',
      'roundTime',
      'mapTime',
      'friendlyFire',
    ];

    for (const field of gameConfig.roomForm) {
      expect(honoured).toContain(field.name);
    }
  });
});
