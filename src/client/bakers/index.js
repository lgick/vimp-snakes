import crystalGem from './crystalGem.js';
import crown from './crown.js';

// ClientPlugin.bakers: baker name -> function. The names are the ones
// parts.bakedAssets refers to (src/config/client.js); an entry naming a baker
// that is not here is skipped in silence, and the part gets an empty `assets`.
//
// The snake's BODY has no baker: it is a stroked path whose width changes with
// the crystal count every frame, so there is nothing constant to bake. The
// crown it may wear over the head is constant, and does.
export default {
  crystalGem,
  crown,
};
