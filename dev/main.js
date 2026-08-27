// Entry point of the local standalone launch (`npm run dev`): a match against
// bots right in the tab — no master, no OAuth, no lobby screen. It is not part
// of the plugin build (--mode client|host) and is never published (files: ["dist"]).
import 'vimp-engine/style.css';
import { startStandaloneGame } from 'vimp-engine/standalone';
import hostPlugin from '../src/host/index.js';
import clientPlugin from '../src/client/index.js';
// This file does not exist until `npm run core:build` — Vite fails to resolve
// it, and that is the first thing `npm run dev` breaks on in a fresh checkout.
import wasmUrl from '../core/pkg-web/vimp_snakes_core_bg.wasm?url';

await startStandaloneGame({
  hostPlugin,
  clientPlugin,
  wasmUrl,
  container: document.getElementById('game'),
  // dev asset root: build/img (staged by `predev`) and build/sounds (the
  // product of `npm run audio:process`). The engine client reads them as
  // `${assetsBase}img/` and `${assetsBase}sounds/`.
  assetsBase: '/build/',
  playerName: localStorage.getItem('vimp_dev_nick') || 'Player',
  playerModel: 's1',
  // no startupVotes: this game declares `noSpectators`, so the player is in
  // the only team there is from the moment they connect and there is nothing
  // to answer. `['teamChange', 'players']` would only print «this is your
  // current team» into the chat on every launch
  startupCommands: ['/bot 3'],
  devMode: true,
});
