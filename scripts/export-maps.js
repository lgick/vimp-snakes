import { mkdir, writeFile } from 'node:fs/promises';
import maps from '../src/data/maps/index.js';

// Serialises the maps from JS modules into static JSON: the format the Rust
// core loads (load_map) and the master serves without rebuilding the halves
// (GameManifest.maps -> /games/<id>/maps/<name>).
// Run: node scripts/export-maps.js -> dist/maps/<name>.json

const outDir = new URL('../dist/maps/', import.meta.url);

await mkdir(outDir, { recursive: true });

for (const [name, map] of Object.entries(maps)) {
  // the URL constructor encodes spaces, fs decodes them back on write
  const file = new URL(`${name}.json`, outDir);

  await writeFile(file, JSON.stringify(map));
  console.log(`exported: ${name}.json`);
}
