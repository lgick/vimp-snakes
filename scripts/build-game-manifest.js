import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ENGINE_API_VERSION } from 'vimp-engine/config/opcodes.js';
import hostDefaults from 'vimp-engine/config/hostDefaults.js';
import gameConfig from '../src/config/game.js';
import { rangeToPattern } from './lib/rangeToPattern.js';

// Writes dist/manifest.json — the only thing the master reads about a built
// game (docs/ai/02-packaging.md). Runs last, after both Vite bundles and the
// asset steps: it hashes what they produced.
// Run: node scripts/build-game-manifest.js (build:manifest)

const distPath = fileURLToPath(new URL('../dist/', import.meta.url));
const assetsPath = path.join(distPath, 'assets');
const mapsPath = path.join(distPath, 'maps');

// The nodejs build of the same core, for the engine's headless runner
// (`npm run sim`). Unlike the other entries it is a filesystem path relative
// to the manifest, and it must point INSIDE dist/ — dist/ is the only
// published content, so pkg-node is copied here rather than referenced in
// place (../core/pkg-node/ works in the checkout and breaks once installed).
const NODE_CORE_SRC = fileURLToPath(
  new URL('../core/pkg-node/', import.meta.url),
);
const NODE_CORE_DIR = 'core-node';
const NODE_CORE_ENTRY = `./${NODE_CORE_DIR}/vimp_snakes_core.js`;

function hashFile(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function findOne(dir, pattern) {
  const files = fs.readdirSync(dir).filter(name => pattern.test(name));

  if (files.length !== 1) {
    throw new Error(
      `expected exactly one file matching ${pattern} in ${dir}, found: ` +
        `${files.join(', ') || 'none'}`,
    );
  }

  return files[0];
}

const clientFile = findOne(distPath, /^client-.+\.js$/);
const hostFile = findOne(distPath, /^host-.+\.js$/);
const wasmFile = findOne(assetsPath, /\.wasm$/);

// clients compare this to detect a stale bundle
const version = createHash('sha256')
  .update(hashFile(path.join(distPath, clientFile)))
  .update(hashFile(path.join(distPath, hostFile)))
  .update(hashFile(path.join(assetsPath, wasmFile)))
  .digest('hex')
  .slice(0, 16);

const mapNames = fs
  .readdirSync(mapsPath)
  .filter(name => name.endsWith('.json'))
  .map(name => name.slice(0, -'.json'.length))
  .sort();

const mapsHash = createHash('sha256');
const maps = [];

for (const name of mapNames) {
  const raw = fs.readFileSync(path.join(mapsPath, `${name}.json`));

  mapsHash.update(name).update(raw);
  maps.push(JSON.parse(raw));
}

// A map may name images (spriteSheet.img, physicsDynamic[].img); the engine
// serves none of them, and a missing file fails silently at runtime — an
// empty canvas and a clean console. So it is a build gate. A procedural map
// names nothing and the gate is a no-op.
const requiredImages = [
  ...new Set(
    maps.flatMap(map => [
      map?.spriteSheet?.img,
      ...(map?.physicsDynamic ?? []).map(body => body?.img),
    ]),
  ),
]
  .filter(Boolean)
  .sort();

const missingImages = requiredImages.filter(
  file => !fs.existsSync(path.join(distPath, 'img', file)),
);

if (missingImages.length) {
  throw new Error(
    `maps reference image(s) missing from dist/img/: ${missingImages.join(', ')} — ` +
      'add them to assets/img/ and run `npm run build:assets`',
  );
}

// one value per roomForm field; roomForm is the single source of the names,
// which keeps roomDefaults from drifting away from the form
const roomValues = {
  maxPlayers: gameConfig.roomDefaults.maxPlayers,
  roundTime: hostDefaults.timers.roundTime,
  mapTime: hostDefaults.timers.mapTime,
  friendlyFire: gameConfig.parts.friendlyFire,
  map: gameConfig.currentMap,
};

// bounds of the numeric fields: the same numbers the host clamps by, not an
// independent copy. regExp remains the actual (native-shaped) constraint;
// min/max additionally travel to the client for the field-label hint and
// the custom range error (vimp-engine formBuilder.js collectFormErrors) —
// v3 text controls have no native min/max of their own
const { roomTimeMin, roomTimeMax } = hostDefaults.timers;
const roomTimeRegExp = rangeToPattern(roomTimeMin / 1000, roomTimeMax / 1000);
const roomTimeBounds = { min: roomTimeMin / 1000, max: roomTimeMax / 1000 };

const fieldRegExp = {
  maxPlayers: rangeToPattern(1, gameConfig.roomDefaults.maxPlayers),
  roundTime: roomTimeRegExp,
  mapTime: roomTimeRegExp,
};

const fieldBounds = {
  maxPlayers: { min: 1, max: gameConfig.roomDefaults.maxPlayers },
  roundTime: roomTimeBounds,
  mapTime: roomTimeBounds,
};

const roomForm = gameConfig.roomForm.map(field =>
  field.name in fieldRegExp
    ? { ...field, regExp: fieldRegExp[field.name], ...fieldBounds[field.name] }
    : field,
);

const hasNodeCore = fs.existsSync(NODE_CORE_SRC);

if (hasNodeCore) {
  fs.rmSync(path.join(distPath, NODE_CORE_DIR), {
    recursive: true,
    force: true,
  });

  fs.cpSync(NODE_CORE_SRC, path.join(distPath, NODE_CORE_DIR), {
    recursive: true,
    // wasm-pack drops a `.gitignore` with `*` next to the glue, and npm
    // applies ignore files inside dist/ too — with it the directory would
    // never reach the tarball. package.json stays: without it Node reads the
    // CommonJS glue as ESM (the package root is "type": "module").
    filter: src => path.basename(src) !== '.gitignore',
  });
}

const manifest = {
  id: 'snakes',
  engineApi: ENGINE_API_VERSION,
  version,
  title: 'Snakes',
  entries: {
    client: `/games/snakes/${clientFile}`,
    host: `/games/snakes/${hostFile}`,
    wasm: `/games/snakes/assets/${wasmFile}`,
    ...(hasNodeCore ? { wasmNode: NODE_CORE_ENTRY } : {}),
  },
  assetsBase: '/games/snakes/',
  maps: {
    version: mapsHash.digest('hex').slice(0, 16),
    list: mapNames,
  },
  roomDefaults: Object.fromEntries(
    roomForm.map(({ name }) => {
      if (!(name in roomValues)) {
        throw new Error(`roomForm field "${name}" has no value source`);
      }

      return [name, roomValues[name]];
    }),
  ),
  roomForm,
};

fs.writeFileSync(
  path.join(distPath, 'manifest.json'),
  JSON.stringify(manifest, null, 2),
);

console.log(`manifest written: ${path.join(distPath, 'manifest.json')}`);
console.log(`  version: ${version}`);
console.log(`  maps: ${mapNames.join(', ')}`);

if (hasNodeCore) {
  console.log(`  wasmNode: ${NODE_CORE_ENTRY}`);
} else {
  console.warn(
    `  wasmNode: skipped (no ${NODE_CORE_SRC}) — the headless run needs ` +
      '`npm run core:build:node` or an explicit --core flag',
  );
}
