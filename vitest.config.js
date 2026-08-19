import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Two projects (docs/ai/11-authoring-workflow.md):
//
//   unit        — configs, host meta and client parts in happy-dom;
//   integration — the real Rust core driven from Node through
//                 core/pkg-node/. The build is not part of `npm test`,
//                 so without `npm run core:build:node` the project has
//                 nothing to include and the suite still passes.
export default defineConfig({
  resolve: {
    // The plugin halves reach the web build of the core through a dynamic
    // import (src/host/nodeCore.js). Vite resolves it at TRANSFORM time, so
    // without the alias every unit test importing a plugin half would fail in
    // a checkout where `npm run core:build` has not run yet. The stub throws
    // if anything actually calls it.
    alias: [
      {
        find: /^.*\/core\/pkg-web\/.*\.js$/,
        replacement: path.resolve(
          import.meta.dirname,
          'tests/stubs/wasmCore.js',
        ),
      },
    ],
  },

  test: {
    globals: true,

    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'happy-dom',
          include: [
            'tests/config/**/*.test.js',
            'tests/client/**/*.test.js',
            'tests/host/**/*.test.js',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/core/**/*.test.js'],
        },
      },
    ],
  },
});
