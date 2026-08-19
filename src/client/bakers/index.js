import crystalGem from './crystalGem.js';

// ClientPlugin.bakers: baker name -> function. The names are the ones
// parts.bakedAssets refers to (src/config/client.js); an entry naming a baker
// that is not here is skipped in silence, and the part gets an empty `assets`.
//
// The snakes have no baker: their body is a stroked path whose width changes
// with the crystal count every frame, so there is nothing constant to bake.
export default {
  crystalGem,
};
