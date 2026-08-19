// Sound registry of the client. Every entry must ship as a webm + mp3 PAIR:
// the client walks codecList and takes the first codec the browser supports,
// so a missing .mp3 breaks Safari only — i.e. never for the author.
//
// `file` is the base name in dist/sounds/ (assets/sounds/ or, after
// `npm run audio:process`, build/sounds/). Do NOT set `path`: the engine
// overwrites it with `${assetsBase}sounds/`, and a hand-written one only
// works until the game is served from the lobby.
//
// Both cues are played by parts through `soundManager`, never through
// `gameConfig.soundCues`: those five cues fire off the engine's round and kill
// machinery, which this game does not use (see src/config/game.js).
//
// `pickup` still points at the file named `shot` — the scaffold's audio, kept
// so the game has sound from the first run. Dropping a better take into
// `assets/audio-raw/` and re-running `npm run audio:process` is a change to
// `file` here and to nothing else.
const sounds = {
  pickup: { file: 'shot', priority: 80, volume: 0.35 },
  death: { file: 'death', priority: 150, volume: 0.5 },
};

export default {
  codecList: ['webm', 'mp3'],
  sounds,
};
