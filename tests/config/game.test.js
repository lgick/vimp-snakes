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

  it('has a spectator team among the teams', () => {
    expect(gameConfig.teams).toHaveProperty(gameConfig.spectatorTeam);
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
