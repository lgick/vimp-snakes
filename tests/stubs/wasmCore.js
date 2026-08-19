// Stand-in for core/pkg-web/ in the unit tests (see the alias in
// vitest.config.js). The web build of the core is a product of
// `npm run core:build:web`; a unit test never instantiates it, but Vite
// resolves the dynamic import of src/host/nodeCore.js at transform time, so
// without this module every test that touches a plugin half would fail in a
// fresh checkout with "Failed to resolve import".
//
// It throws rather than pretending to be a core: a test that DOES need the
// simulation belongs in tests/core/, against the real Node build.
const notBuilt = () => {
  throw new Error(
    'the WASM core is not available in unit tests — run `npm run core:build` ' +
      'and use tests/core/ (the integration project) for the real thing',
  );
};

export default notBuilt;
export const GameCore = notBuilt;
export const ClientCore = notBuilt;
