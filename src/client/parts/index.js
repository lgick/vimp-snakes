import Arena from './Arena.js';
import Snake from './Snake.js';
import Crystal from './Crystal.js';

// ClientPlugin.parts: class name -> class. The names are the ones
// parts.gameSets and parts.entitiesOnCanvas use (src/config/client.js) —
// all three lists must agree, and entitiesOnCanvas is the one that actually
// registers a class with the factory.
export default {
  Arena,
  Snake,
  Crystal,
};
