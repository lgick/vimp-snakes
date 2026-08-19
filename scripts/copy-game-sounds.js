import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Copies the processed sounds into dist/sounds/ — the asset the client reads
// as `${assetsBase}sounds/<file>.<codec>`.
//
// Source order matters:
//   build/sounds/    — the product of `npm run audio:process` (ffmpeg);
//   assets/sounds/   — placeholders shipped with the template.
//
// The fallback is deliberate: the first build of a freshly scaffolded game
// must be green WITHOUT ffmpeg installed. Once you run `npm run audio:process`
// on your own assets/audio-raw/, build/sounds/ wins and the placeholders stop
// being used.
// Run: node scripts/copy-game-sounds.js (build:assets)

const processedDir = fileURLToPath(new URL('../build/sounds/', import.meta.url));
const placeholderDir = fileURLToPath(
  new URL('../assets/sounds/', import.meta.url),
);
const distDir = fileURLToPath(new URL('../dist/sounds/', import.meta.url));

const sourceDir = fs.existsSync(processedDir) ? processedDir : placeholderDir;

// dist/ is the packaged asset; build/sounds/ is also the dev asset root of
// `npm run dev` (assetsBase '/build/'), so the placeholders are staged there
// as well — otherwise a developer without ffmpeg plays a silent match
const targetDirs =
  sourceDir === placeholderDir
    ? [distDir, fileURLToPath(new URL('../build/sounds/', import.meta.url))]
    : [distDir];

if (!fs.existsSync(sourceDir)) {
  console.error(
    `Error: no sounds found (looked in '${processedDir}' and ` +
      `'${placeholderDir}'). Run 'npm run audio:process' first.`,
  );
  process.exit(1);
}

for (const targetDir of targetDirs) {
  // full replacement, not a merge: a file deleted from the source would
  // otherwise survive in dist/ and travel into the published tarball
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.cpSync(sourceDir, targetDir, { recursive: true });

  console.log(`copied sounds: ${sourceDir} -> ${targetDir}`);
}

if (sourceDir === placeholderDir) {
  console.warn(
    '  using the template placeholders — run `npm run audio:process` to ' +
      'build your own sounds from assets/audio-raw/',
  );
}
