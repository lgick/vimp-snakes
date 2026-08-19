import { defineConfig } from 'vite';
import path from 'node:path';

// Three modes in one file (docs/ai/02-packaging.md):
//
//   vite            — dev harness of `npm run dev`: index.html -> dev/main.js,
//                     a match against bots in the tab, no master;
//   vite build --mode client|host
//                   — the published halves, built by TWO independent runs:
//                     a chunk shared between them would drag DOM code
//                     (PixiJS) into the Worker-safe host bundle.
//
// PixiJS is a singleton supplied by the engine through an import map, so it
// stays external in the builds and deduped in dev — two PixiJS copies mean
// two extension registries, and objects of one copy fail inside the other.
const entries = {
  client: path.resolve(import.meta.dirname, 'src/client/index.js'),
  host: path.resolve(import.meta.dirname, 'src/host/index.js'),
};

export default defineConfig(({ command, mode }) => {
  if (command === 'serve') {
    return {
      server: {
        open: true,
        // `npm link vimp-engine` resolves the engine outside this package:
        // without the allowance Vite refuses to serve its sources
        fs: { allow: ['..'] },
      },
      resolve: { dedupe: ['pixi.js'] },
      optimizeDeps: {
        // the engine ships ESM sources: pre-bundling breaks its dynamic
        // imports and the boot config it shares with the SDK
        exclude: ['vimp-engine'],
        // ...but its npm dependencies must stay pre-bundled: as transitive
        // imports of an excluded package they would be served as CJS
        // sources, which the browser cannot resolve
        include: ['pixi.js', 'pixi.js/unsafe-eval', 'howler'],
      },
    };
  }

  const entry = entries[mode];

  if (!entry) {
    throw new Error(
      `vimp-snakes build: unknown --mode "${mode}" (expected "client" or "host")`,
    );
  }

  return {
    build: {
      outDir: 'dist',
      // both runs write into the same dist/ — the second must not wipe the first
      emptyOutDir: false,
      // the .wasm must stay a separate asset with a URL: base64 inlining costs
      // +33 %, breaks instantiateStreaming and duplicates the binary in both
      // bundles. build.lib is not used at all — it inlines assets regardless.
      assetsInlineLimit: 0,
      rollupOptions: {
        input: entry,
        // without it Vite tree-shakes the entry's default export (the plugin)
        preserveEntrySignatures: 'strict',
        external: [/^pixi\.js(\/.*)?$/],
        output: {
          format: 'es',
          entryFileNames: `${mode}-[hash].js`,
          assetFileNames: 'assets/[name]-[hash][extname]',
          inlineDynamicImports: true,
        },
      },
    },
  };
});
