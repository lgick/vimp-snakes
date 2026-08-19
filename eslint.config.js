import js from '@eslint/js';
import globals from 'globals';

// Minimal config: the split that matters is by environment. src/host/ runs
// inside a Web Worker (no DOM, no PixiJS) and src/client/ in the main thread;
// mixing their globals hides the mistake the engine cannot catch for you.
export default [
  js.configs.recommended,

  // build scripts and root configs
  {
    files: ['*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.es2023, ...globals.node },
    },
  },

  // host half: Worker-safe — no browser globals on purpose
  {
    files: ['src/host/**/*.js', 'src/config/**/*.js', 'src/data/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.es2023, ...globals.worker },
    },
  },

  // client half and the dev harness: main thread
  {
    files: ['src/client/**/*.js', 'dev/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.es2023, ...globals.browser },
    },
  },

  {
    files: ['tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.es2023,
        ...globals.node,
        ...globals.browser,
        // vitest globals: true
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        vi: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
      },
    },
  },

  {
    rules: {
      eqeqeq: ['error', 'always'],
      curly: ['error', 'all'],
      'no-var': 'error',
      'prefer-const': 'warn',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },

  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'build/**',
      'target/**',
      'core/pkg-web/**',
      'core/pkg-node/**',
      '**/.*',
      '**/_*',
    ],
  },
];
