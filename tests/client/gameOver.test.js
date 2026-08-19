import { describe, it, expect, beforeEach } from 'vitest';
import GameOver, {
  OVERLAY_ID,
  RESPAWN_KEY_CODE,
  parsePanel,
} from '../../src/client/gameOver.js';

// The result screen is the game's own DOM, driven by nothing but PANEL_DATA
// (see the note atop src/client/gameOver.js). Two wire keys reach it: `d`, the
// death signal encoded as crystals + 1, and `s`, the running score.
function card() {
  return document.getElementById(OVERLAY_ID);
}

function texts() {
  const root = card();

  return {
    crystals: root.querySelector(`.${OVERLAY_ID}-score span`).textContent,
    total: root.querySelector(`.${OVERLAY_ID}-total span`).textContent,
    hidden: root.hidden,
  };
}

describe('GameOver', () => {
  let overlay;

  beforeEach(() => {
    document.body.innerHTML = '';
    overlay = new GameOver();
    overlay.mount();
  });

  it('stays out of the way until the snake crashes', () => {
    overlay.onPanel(['c:12', 's:12', 'd:0']);

    expect(texts().hidden).toBe(true);
  });

  it('shows the haul of the life and the score that survives it', () => {
    overlay.onPanel(['s:41', 'd:13']);

    // the host encodes the final carried count as crystals + 1
    expect(texts()).toEqual({ crystals: '12', total: '41', hidden: false });
  });

  it('reads the score of the same frame the death arrives in', () => {
    // a kill can land the score and the death flag in one payload, and the
    // card must not show the total of the previous frame
    overlay.onPanel(['s:5', 'd:0']);
    overlay.onPanel(['s:30', 'd:6']);

    expect(texts().total).toBe('30');
  });

  it('hides again once the panel says the snake is alive', () => {
    overlay.onPanel(['s:9', 'd:4']);
    overlay.onPanel(['d:0']);

    expect(texts().hidden).toBe(true);
  });

  it('forgets the score on a fresh authorization', () => {
    overlay.onPanel(['s:30', 'd:6']);
    overlay.reset();
    overlay.onPanel(['d:1']);

    expect(texts()).toEqual({ crystals: '0', total: '0', hidden: false });
  });

  it('presses the respawn key on OK', () => {
    const seen = [];

    window.addEventListener('keydown', event => seen.push(event.keyCode));
    window.addEventListener('keyup', event => seen.push(event.keyCode));

    overlay.onPanel(['s:3', 'd:2']);
    card().querySelector('button').click();

    expect(seen).toEqual([RESPAWN_KEY_CODE, RESPAWN_KEY_CODE]);
    expect(texts().hidden).toBe(true);
  });

  it('builds its DOM once', () => {
    overlay.mount();

    expect(document.querySelectorAll(`#${OVERLAY_ID}`)).toHaveLength(1);
  });

  it('survives a panel payload that arrives before the mount', () => {
    const fresh = new GameOver();

    expect(() => fresh.onPanel(['s:1', 'd:2'])).not.toThrow();
  });
});

describe('parsePanel', () => {
  it('keeps only the pairs, dropping the bare hide keys', () => {
    // a BARE key (no colon) is how the engine hides a cell
    expect(parsePanel(['c:12', 'wa', 'd:0'])).toEqual({ c: 12, d: 0 });
  });

  it('accepts nothing at all', () => {
    expect(parsePanel()).toEqual({});
  });
});
