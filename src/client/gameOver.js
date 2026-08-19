// The result screen shown after a crash.
//
// Why it exists at all: the engine's auth screen is a ONE-WAY door. AUTH_RESULT
// without an error hides `#auth`, starts the modules and sends MODULES_READY,
// and there is no port and no client path back to it (`client/main.js`,
// `client/components/view/Auth.js`). So "die, see your score, press OK, play
// again" has to be the game's own DOM.
//
// How it learns anything: through the panel. The host declares a `dead` field
// whose value is 0 while the snake is alive and `crystals + 1` once it has
// crashed — one plus, because panel values floor at 0 and "dead carrying
// nothing" has to be distinguishable from "alive". `ClientPlugin.hooks.onPanel`
// is called with the raw `key:value` array on every PANEL_DATA, which is the
// only per-frame hook a client plugin gets.
//
// How OK gets back to the host: a client plugin has no socket of its own. It
// does have the engine's `controls` module listening on `document`, so the
// button dispatches the `respawn` keycode as a synthetic keydown/keyup — the
// same path a real R press takes, gates and all.

const OVERLAY_ID = 'snakes-gameover';

/// Must match the `respawn` entry of keySetList[1] in src/config/client.js.
const RESPAWN_KEY_CODE = 82;

/// Wire keys of gameConfig.panel.fields — `d` is the death signal, `s` the
/// running total the card shows next to the haul of the life that just ended.
/// The panel arrives as `['c:12', 'd:0', …]`, and a BARE key (no colon) is the
/// engine's way of hiding a cell.
const KEY_DEAD = 'd';
const KEY_SCORE = 's';

// Synthesises one key event the engine's InputListener will accept.
//
// Two details that are easy to get wrong and silent when wrong: the listener
// is registered on `window`, not on `document`, and the handler reads the
// LEGACY `event.keyCode`. `keyCode` is not part of `KeyboardEventInit` in the
// spec — browsers honour it as an extension, but the property is a prototype
// getter, so an own property is defined over it as well rather than trusting
// that.
function dispatchKey(type, keyCode) {
  const event = new KeyboardEvent(type, { keyCode, bubbles: true });

  if (event.keyCode !== keyCode) {
    Object.defineProperty(event, 'keyCode', { value: keyCode });
    Object.defineProperty(event, 'which', { value: keyCode });
  }

  window.dispatchEvent(event);
}

function parsePanel(items) {
  const values = {};

  for (const item of items ?? []) {
    const colon = String(item).indexOf(':');

    if (colon > 0) {
      values[item.slice(0, colon)] = Number(item.slice(colon + 1));
    }
  }

  return values;
}

export default class GameOver {
  constructor() {
    this._root = null;
    this._crystals = null;
    this._total = null;
    this._visible = false;
    this._lastScore = 0;
  }

  /// Builds the DOM once, on authorization. Doing it lazily inside the panel
  /// hook would put a document write on the frame path.
  mount() {
    if (this._root || typeof document === 'undefined') {
      return;
    }

    const root = document.createElement('div');

    root.id = OVERLAY_ID;
    root.hidden = true;
    // Two numbers, because they answer two different questions: the haul is
    // what this life was worth and is gone now, the total is what the stat
    // table ranks by and survives the crash.
    root.innerHTML = `
      <div class="${OVERLAY_ID}-card">
        <h2>You crashed</h2>
        <p class="${OVERLAY_ID}-score"><span>0</span> crystals</p>
        <p class="${OVERLAY_ID}-total">Total score: <span>0</span></p>
        <button type="button">OK</button>
      </div>
    `;

    this._crystals = root.querySelector(`.${OVERLAY_ID}-score span`);
    this._total = root.querySelector(`.${OVERLAY_ID}-total span`);
    root.querySelector('button').addEventListener('click', () => this._respawn());

    document.body.appendChild(root);

    this._root = root;
  }

  /// One PANEL_DATA payload. Cheap and idempotent: it runs on every panel
  /// message, and most of them say nothing has changed.
  onPanel(items) {
    if (!this._root) {
      return;
    }

    const values = parsePanel(items);

    // read the score first: the host writes it and the death flag in the same
    // tick, and the card must not show the total of the previous frame
    if (KEY_SCORE in values) {
      this._lastScore = values[KEY_SCORE];
    }

    if (!(KEY_DEAD in values)) {
      return;
    }

    const dead = values[KEY_DEAD];

    if (dead > 0) {
      // the host encodes the final count as crystals + 1
      this._show(dead - 1);
    } else {
      this._hide();
    }
  }

  reset() {
    this._hide();
    this._lastScore = 0;
  }

  _show(crystals) {
    if (this._visible) {
      return;
    }

    this._visible = true;
    this._crystals.textContent = String(crystals);
    this._total.textContent = String(this._lastScore);
    this._root.hidden = false;
  }

  _hide() {
    if (!this._visible) {
      return;
    }

    this._visible = false;
    this._root.hidden = true;
  }

  _respawn() {
    // hide first: the authoritative confirmation is a frame away, and a card
    // that lingers after the click reads as a dead button
    this._hide();

    // Both halves of the press, in order: the engine's Controls model keeps a
    // `_pressedKeys` map and ignores a second `down` without a `up` in
    // between, so an unbalanced pair would work exactly once.
    for (const type of ['keydown', 'keyup']) {
      dispatchKey(type, RESPAWN_KEY_CODE);
    }
  }
}

export { OVERLAY_ID, RESPAWN_KEY_CODE, parsePanel };
