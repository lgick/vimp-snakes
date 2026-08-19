import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Lays the game images (map tile sheets, dynamic-body sprites) out for their
// two consumers:
//
//   build/img/ — dev root of the standalone launch (`npm run dev`): the SDK
//                gets assetsBase '/build/', so a tile lives at /build/img/<file>
//   dist/img/  — the packaged asset under GameManifest.assetsBase: the master
//                mounts dist/ at /games/<id>/
//
// Images need no processing step, so both targets are written in one pass.
// A scaffolded game draws everything procedurally and ships no images at all,
// so a missing assets/img/ is a no-op, not an error.
// Run: node scripts/copy-game-images.js (build:assets and predev)

const sourceDir = fileURLToPath(new URL('../assets/img/', import.meta.url));
const targetDirs = [
  fileURLToPath(new URL('../build/img/', import.meta.url)),
  fileURLToPath(new URL('../dist/img/', import.meta.url)),
];

if (!fs.existsSync(sourceDir)) {
  console.log(`no images: '${sourceDir}' does not exist — nothing to copy`);
  process.exit(0);
}

for (const targetDir of targetDirs) {
  // full replacement, not a merge: a file deleted from assets/img/ would
  // otherwise survive in dist/ and travel into the published tarball
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.cpSync(sourceDir, targetDir, { recursive: true });

  console.log(`copied images: ${sourceDir} -> ${targetDir}`);
}
