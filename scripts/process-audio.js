import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

// ffmpeg pipeline: normalises loudness (EBU R128) and emits BOTH .webm and
// .mp3 for every source sound — the client's codec list is ['webm', 'mp3']
// and it picks per browser support, so a missing .mp3 breaks Safari only.
//
// assets/audio-raw/*  ->  build/sounds/*.{mp3,webm}
//
// Optional for a fresh checkout: without ffmpeg the build falls back to the
// placeholders in assets/sounds/ (see copy-game-sounds.js).
// Run: npm run audio:process

const execPromise = promisify(exec);

const sourceDir = 'assets/audio-raw';
const outputDir = 'build/sounds';

const AUDIO_EXTENSIONS = ['.wav', '.mp3', '.flac', '.aiff', '.ogg', '.m4a'];

// loudness targets (EBU R128)
const LOUDNESS = {
  // integrated loudness, a good balance for games and web content
  I: -16,
  // loudness range: keeps quiet and loud sounds apart without extremes
  LRA: 7,
  // true peak: a safe ceiling against clipping
  TP: -1.5,
};

// leading silence trim
const SILENCE_THRESHOLD = '-50dB';

const CODEC_SETTINGS = {
  MP3_QUALITY: '2', // VBR ~190 kbps
  WEBM_BITRATE: '96k', // Opus bitrate
};

async function isFfmpegInstalled() {
  try {
    await execPromise('ffmpeg -version');

    return true;
  } catch {
    return false;
  }
}

async function main() {
  console.log('--- Starting Audio Processing ---');

  if (!(await isFfmpegInstalled())) {
    console.error('Error: ffmpeg is not installed.');
    process.exit(1);
  }

  try {
    await fs.access(sourceDir);
  } catch {
    console.error(`Error: source directory '${sourceDir}' not found.`);
    process.exit(1);
  }

  await fs.mkdir(outputDir, { recursive: true });
  console.log(`> output directory: ${outputDir}`);

  const sourceFiles = await fs.readdir(sourceDir);

  for (const file of sourceFiles) {
    const extension = path.extname(file).toLowerCase();

    if (!AUDIO_EXTENSIONS.includes(extension)) {
      continue;
    }

    const sourcePath = path.join(sourceDir, file);
    const baseName = path.basename(file, extension);
    const outputMp3 = path.join(outputDir, `${baseName}.mp3`);
    const outputWebm = path.join(outputDir, `${baseName}.webm`);

    console.log(`\nprocessing: ${file}`);

    const audioFilters = [
      `silenceremove=start_periods=1:start_threshold=${SILENCE_THRESHOLD}`,
      `loudnorm=I=${LOUDNESS.I}:LRA=${LOUDNESS.LRA}:tp=${LOUDNESS.TP}`,
    ].join(',');

    const command = [
      'ffmpeg',
      '-nostdin',
      `-i "${sourcePath}"`,
      '-hide_banner -loglevel error -y',
      `-af "${audioFilters}"`,
      `-c:a libmp3lame -q:a ${CODEC_SETTINGS.MP3_QUALITY} "${outputMp3}"`,
      `-c:a libopus -b:a ${CODEC_SETTINGS.WEBM_BITRATE} "${outputWebm}"`,
    ].join(' ');

    try {
      await execPromise(command);
      console.log(`done: ${outputMp3}, ${outputWebm}`);
    } catch (error) {
      console.error(`error processing: ${file}`);
      console.error(error.stderr);
    }
  }

  console.log('\nAll files processed.');
}

main().catch(error => {
  console.error('\nCritical script error:', error);
  process.exit(1);
});
