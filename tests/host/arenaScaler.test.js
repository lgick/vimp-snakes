import { describe, it, expect, beforeEach, vi } from 'vitest';
import ArenaScaler from '../../src/host/ArenaScaler.js';
import {
  arenaSizeFor,
  BASE_PLAYERS,
  BASE_SIZE,
  buildArena,
  PLAYER_STEP,
} from '../../src/data/maps/arena.js';

// The scaler is the only thing that rebuilds the map under a running match.
// Two properties matter and neither is visible in the browser until a room is
// full: that the size follows the crowd, and that every loaded client ends up
// holding the size that is actually in force in the core.
const sizeOf = mapData => mapData.map.length;

function participantsFor(users) {
  return { getHumans: () => users };
}

function human(gameId, isReady = true) {
  return { gameId, socketId: `s${gameId}`, isReady };
}

describe('arenaSizeFor', () => {
  it('pins the size below the population it is tuned for', () => {
    expect(arenaSizeFor(0)).toBe(BASE_SIZE);
    expect(arenaSizeFor(1)).toBe(BASE_SIZE);
    expect(arenaSizeFor(BASE_PLAYERS)).toBe(BASE_SIZE);
  });

  it('grows the AREA linearly with the crowd', () => {
    // four times the players, twice the radius: the disc per snake is what
    // stays constant, not the width
    expect(arenaSizeFor(BASE_PLAYERS * 4)).toBe(BASE_SIZE * 2);
  });

  it('rounds the population up to a whole step', () => {
    expect(arenaSizeFor(BASE_PLAYERS + 1)).toBe(
      arenaSizeFor(BASE_PLAYERS + PLAYER_STEP),
    );
  });
});

describe('buildArena', () => {
  it('keeps every respawn point inside the disc, facing the centre', () => {
    for (const count of [0, 12, 32]) {
      const mapData = buildArena(count);
      const radius = (sizeOf(mapData) * mapData.step) / 2;

      for (const [x, y, angle] of mapData.respawns.players) {
        const dx = x - radius;
        const dy = y - radius;

        expect(Math.hypot(dx, dy)).toBeLessThan(radius);

        // the point faces the centre: the heading and the vector to the
        // centre agree to within the rounding of a whole degree
        const toCentre = (Math.atan2(-dy, -dx) * 180) / Math.PI;
        const diff = Math.abs(((angle - toCentre + 540) % 360) - 180);

        expect(diff).toBeLessThan(1);
      }
    }
  });

  it('keeps the respawn points further apart than a spawn clearance', () => {
    // core/src/game.rs RESPAWN_CLEARANCE — two snakes closer than this count
    // as sharing a spot
    const points = buildArena(0).respawns.players;

    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const gap = Math.hypot(
          points[i][0] - points[j][0],
          points[i][1] - points[j][1],
        );

        expect(gap).toBeGreaterThan(140);
      }
    }
  });
});

describe('ArenaScaler', () => {
  let coreAdapter;
  let socketManager;
  let scripted;
  let users;
  let scaler;

  beforeEach(() => {
    coreAdapter = { createMap: vi.fn() };
    socketManager = { sendMap: vi.fn() };
    scripted = { createMap: vi.fn() };
    users = [human(1), human(2)];
    scaler = new ArenaScaler(
      {
        participants: participantsFor(users),
        coreAdapter,
        socketManager,
      },
      scripted,
    );
  });

  it('ignores every custom event that is not a population report', () => {
    scaler.onCoreEvent({ type: 'crystals', id: 1, gained: 3 });
    scaler.onCoreEvent(null);

    expect(coreAdapter.createMap).not.toHaveBeenCalled();
    expect(socketManager.sendMap).not.toHaveBeenCalled();
  });

  it('loads the map into the core before it reaches any client', () => {
    scaler.onCoreEvent({ type: 'population', count: 2 });

    expect(coreAdapter.createMap).toHaveBeenCalledTimes(1);
    expect(scripted.createMap).toHaveBeenCalledWith(scaler.mapData);
    expect(socketManager.sendMap.mock.calls.map(call => call[0])).toEqual([
      's1',
      's2',
    ]);
    expect(sizeOf(scaler.mapData)).toBe(arenaSizeFor(2));
  });

  it('rebuilds and re-sends when the crowd crosses a step', () => {
    scaler.onCoreEvent({ type: 'population', count: 2 });
    socketManager.sendMap.mockClear();

    scaler.onCoreEvent({ type: 'population', count: BASE_PLAYERS * 4 });

    expect(sizeOf(scaler.mapData)).toBe(BASE_SIZE * 2);
    expect(socketManager.sendMap).toHaveBeenCalledTimes(2);
  });

  it('does not rebuild while the size is unchanged', () => {
    scaler.onCoreEvent({ type: 'population', count: 12 });
    coreAdapter.createMap.mockClear();
    socketManager.sendMap.mockClear();

    scaler.onCoreEvent({ type: 'population', count: 11 });

    expect(coreAdapter.createMap).not.toHaveBeenCalled();
    expect(socketManager.sendMap).not.toHaveBeenCalled();
  });

  it('shrinks only a whole step below the population it grew for', () => {
    scaler.onCoreEvent({ type: 'population', count: 20 });

    const grown = sizeOf(scaler.mapData);

    // one player short of the population it was built for: still the same disc
    scaler.onCoreEvent({ type: 'population', count: 19 });
    expect(sizeOf(scaler.mapData)).toBe(grown);

    scaler.onCoreEvent({ type: 'population', count: 20 - PLAYER_STEP });
    expect(sizeOf(scaler.mapData)).toBeLessThan(grown);
  });

  it('catches up a client that joined between two resizes', () => {
    scaler.onCoreEvent({ type: 'population', count: 2 });
    socketManager.sendMap.mockClear();

    // the newcomer was handed the CATALOG map by the engine, which is the base
    // size and not necessarily the one in force
    users.push(human(3));
    scaler.onCoreEvent({ type: 'population', count: 3 });

    expect(socketManager.sendMap.mock.calls.map(call => call[0])).toEqual([
      's3',
    ]);
  });

  it('skips a client still in the loading handshake', () => {
    users.push(human(3, false));
    scaler.onCoreEvent({ type: 'population', count: 3 });

    expect(socketManager.sendMap.mock.calls.map(call => call[0])).toEqual([
      's1',
      's2',
    ]);
  });

  it('forgets the clients that left', () => {
    scaler.onCoreEvent({ type: 'population', count: 2 });
    users.splice(0, 1);
    scaler.onCoreEvent({ type: 'population', count: 1 });

    // the id that left is gone from the bookkeeping; the one that stayed is
    // not re-sent a map it already has
    socketManager.sendMap.mockClear();
    scaler.onCoreEvent({ type: 'population', count: 1 });
    expect(socketManager.sendMap).not.toHaveBeenCalled();
  });
});
