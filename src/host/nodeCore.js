// Loading the WASM core, both shapes of it. `wasmUrl` arrives from the
// manifest and differs between the two runtimes (docs/ai/03-host-plugin.md):
//
//   browser — the hashed `.wasm` asset (entries.wasm): the `--target web`
//             glue is imported and `init()` fetches the binary by that URL;
//   Node    — a file: URL of the `--target nodejs` glue (entries.wasmNode),
//             used by `npm run sim`: that build pulls the wasm in itself, and
//             fetch() cannot read file: URLs anyway.
//
// Both halves of the plugin branch through THIS file: a headless run that used
// a different core than the browser would prove nothing.
//
// The web glue is loaded by a dynamic import on purpose. As a static one it
// would make `src/host/index.js` unimportable in Node until `npm run
// core:build` has run — and with it `npm run check:contract` and every unit
// test of the host half.

export const isNodeCore = wasmUrl => (wasmUrl ?? '').endsWith('.js');

// @vite-ignore: the path is a runtime value, Vite must not try to resolve it
export const loadNodeCore = wasmUrl => import(/* @vite-ignore */ wasmUrl);

export const loadWebCore = () => import('../../core/pkg-web/vimp_snakes_core.js');
