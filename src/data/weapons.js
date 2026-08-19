// Snakes have no weapons: a snake kills by being in the way, and the only
// "ability" is the boost, which is a movement key.
//
// The object still has to exist and still has to be exported. `parts.weapons`
// is one of the nine paths the Worker asserts the moment it imports the host
// plugin (docs/ai/03-host-plugin.md § gameConfig validation gate) — a missing
// one throws at boot with the path named, which is the good case; what is NOT
// allowed is quietly dropping the key and discovering it as a black canvas.
//
// It is also passed to both cores verbatim, where it deserialises into an
// empty map and is never read (core/src/config.rs).
export default {};
