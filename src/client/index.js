import { ENGINE_API_VERSION } from 'vimp-engine/config/opcodes.js';
import styles from './style.css?inline';
import parts from './parts/index.js';
import bakers from './bakers/index.js';
import GameOver from './gameOver.js';
import { isNodeCore, loadNodeCore, loadWebCore } from '../host/nodeCore.js';

// ClientPlugin — the render half, main thread: PixiJS parts, procedural
// textures and the three hooks into the client core. Default export of the
// client entry (vite build --mode client); the engine loads it by
// GameManifest.entries.client.

// The result screen after a crash. It is a plugin-level singleton because the
// hooks below are plain functions with no instance to hang state on, and
// because there is exactly one local player per tab.
const gameOver = new GameOver();

export default {
  id: 'snakes',
  engineApi: ENGINE_API_VERSION,

  // MUST return { core, memory }: `memory` is the WebAssembly memory the
  // engine reads the hot buffer out of every render tick. Without it the
  // client silently renders nothing but the discrete frames.
  async createClientCore(clientConfigJson, { wasmUrl } = {}) {
    if (isNodeCore(wasmUrl)) {
      const node = await loadNodeCore(wasmUrl);

      // the Node build exposes no WASM memory: the headless client reads the
      // hot buffer by copy (hot_values()) instead of through a view
      return { core: new node.ClientCore(clientConfigJson), memory: null };
    }

    const { default: init, ClientCore } = await loadWebCore();
    const wasm = await init({ module_or_path: wasmUrl });

    return { core: new ClientCore(clientConfigJson), memory: wasm.memory };
  },

  parts,
  bakers,

  // CSS as a string — see src/client/style.css
  styles,

  // all three hooks are called unconditionally: an empty body is fine, a
  // missing hook is a crash
  hooks: {
    // the model is known only after authorization, and the predictor cannot
    // move a snake whose speed and turn rate it does not know
    onAuth(core, authData) {
      core.set_model(authData.model);

      // build the result screen now rather than on the first death: this is
      // the only hook that is not on the frame path
      gameOver.mount();
      gameOver.reset();
    },

    // The authoritative panel, and the only per-frame hook a client plugin
    // gets. The `dead` cell is how the host tells this tab that its snake
    // crashed and with how many crystals — see src/client/gameOver.js for why
    // the result screen has to be the game's own DOM.
    onPanel(core, panelData) {
      core.sync_panel(JSON.stringify(panelData));
      gameOver.onPanel(panelData);
    },

    // Nothing is drawn locally ahead of the authoritative frame: a snake has
    // no weapon, and its only interactions — the edge, other bodies, crystals
    // — are all resolved by the host. Guessing a crash locally would mean
    // showing a player a death the host might not agree with.
    onLocalAction() {
      return null;
    },
  },
};
