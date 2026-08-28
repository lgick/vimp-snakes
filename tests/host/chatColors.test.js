import { describe, it, expect, vi } from 'vitest';
import ChatColors from '../../src/host/ChatColors.js';
import { SNAKE_COLORS } from '../../src/data/palette.js';

// The engine colours a nickname by team, and this game has one team — so the
// chat borrows the colour the core handed the snake. The core reports it in a
// `spawn` custom event; this module is the only listener.
const participantsSpy = () => ({ setChatColor: vi.fn() });

describe('ChatColors', () => {
  it('paints the nickname with the snake colour of that index', () => {
    const participants = participantsSpy();
    const colors = new ChatColors({ participants });

    colors.onCoreEvent({ type: 'spawn', id: 3, color: 1 });

    expect(participants.setChatColor).toHaveBeenCalledWith('3', '#ff9f1c');
  });

  // ***** IDS ARE STRINGS ***** the core writes a number, the engine keys its
  // participants by strings (see the same note in StatBridge.js)
  it('looks the participant up by a string id', () => {
    const participants = participantsSpy();
    const colors = new ChatColors({ participants });

    colors.onCoreEvent({ type: 'spawn', id: 0, color: 0 });

    expect(participants.setChatColor.mock.calls[0][0]).toBe('0');
  });

  it('wraps an index past the end of the palette', () => {
    const participants = participantsSpy();
    const colors = new ChatColors({ participants });
    const wrapped = SNAKE_COLORS.length + 2;

    colors.onCoreEvent({ type: 'spawn', id: 1, color: wrapped });

    expect(participants.setChatColor).toHaveBeenCalledWith('1', '#ffd23f');
  });

  it('ignores every other core event', () => {
    const participants = participantsSpy();
    const colors = new ChatColors({ participants });

    colors.onCoreEvent({ type: 'respawn', id: 1 });
    colors.onCoreEvent({ type: 'population', count: 4 });
    colors.onCoreEvent(null);

    expect(participants.setChatColor).not.toHaveBeenCalled();
  });

  // an engine older than 0.22 has no such method: the game must run on it
  // with plain team-coloured nicknames rather than throw inside the Worker
  it('survives an engine without setChatColor', () => {
    const colors = new ChatColors({ participants: {} });

    expect(() => colors.onCoreEvent({ type: 'spawn', id: 1, color: 0 })).not.toThrow();
  });
});
