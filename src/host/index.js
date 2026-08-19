import { ENGINE_API_VERSION } from 'vimp-engine/config/opcodes.js';
import gameConfig from '../config/game.js';
import authSchema from '../config/auth.js';
import clientConfig from '../config/client.js';
import createModules, { getStatBridge } from './createModules.js';
import spawnCommand from './spawnCommand.js';
import systemMessages from './systemMessages.js';
import { isNodeCore, loadNodeCore, loadWebCore } from './nodeCore.js';

// HostPlugin — the game half of the authoritative match, Worker-safe: no DOM,
// no PixiJS, no Node globals. Default export of the host entry
// (vite build --mode host); the engine loads it by GameManifest.entries.host.
//
// Every field below is dereferenced by the engine without a guard, so a
// missing one is a TypeError far from its cause (docs/ai/03-host-plugin.md).
export default {
  id: 'snakes',
  // never a literal: a number written by hand agrees with the engine on the
  // day it is typed and silently disagrees after the next release
  engineApi: ENGINE_API_VERSION,

  // wasmUrl comes from the manifest: init() loads by an explicit URL instead
  // of the glue module's own import.meta.url resolution, which does not
  // survive inside a Worker
  async createCore(coreConfigJson, { wasmUrl } = {}) {
    if (isNodeCore(wasmUrl)) {
      const node = await loadNodeCore(wasmUrl);

      return new node.GameCore(coreConfigJson);
    }

    const { default: init, GameCore } = await loadWebCore();

    // module_or_path — the wasm-bindgen init() option name
    await init({ module_or_path: wasmUrl });

    return new GameCore(coreConfigJson);
  },

  gameConfig,
  authSchema,

  // REQUIRED array — the engine iterates it unguarded; `[]` for no commands
  chatCommands: [spawnCommand],

  // merged into the engine chat registry by a blind Object.assign: a code in
  // an engine group would overwrite an engine message without a word
  systemMessages,

  // the engine calls it and reads exactly one key off the result: `scripted`
  createModules,

  // the client half of the config has no file of its own on the client: the
  // host builds it and sends it over
  buildClientGameConfig: () => clientConfig,

  // Only `custom` core events reach a plugin — panelSet, panelActive, death
  // and shake are consumed by the engine itself. This game's core emits three
  // of them (crystals, death, respawn) because it owns the whole life cycle
  // the engine would otherwise run; see src/host/StatBridge.js for what they
  // become, and the note atop src/config/game.js for why.
  //
  // The context is exactly { vimp, panel }: no stat, no chat, no participants.
  onCoreEvent(data, { vimp } = {}) {
    getStatBridge()?.onCoreEvent(data, vimp);
  },
};
