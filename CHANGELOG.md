# Changelog

All notable changes to `@vimp-games/snakes` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.15.7] - 2026-10-05

### Added

- Chat texts for the engine's host-migration messages `s:7` ("Host
  changed"), `s:8` ("You are no longer the host (connection lost)") and
  `s:9`–`s:11` ("Host changed: the previous host was lagging / went
  inactive / had a poor connection").
- Chat texts for the engine's "Change host" vote notices `v:6`–`v:15`
  ("Usage: /changehost" … "Host vote cancelled").

### Fixed

- A core restored from `serialize_state` replays the match exactly: snakes,
  bots and crystals keep their order in the dump (a list of `[id, value]`
  pairs instead of a JSON object, whose keys `serde_json` sorted as strings),
  and the sweep counter, the arena and the spawn slots are dumped too. Dumps
  in the old format still load.

## [0.15.6] - 2026-09-29

### Changed

- Rebuilt against `vimp-engine-core` 0.23.1 and `vimp-engine` 0.35.6.

## [0.15.5] - 2026-09-29

### Changed

- Rebuilt against `vimp-engine-core` 0.23.0.

## [0.15.4] - 2026-09-27

### Changed

- Rebuilt against `vimp-engine` 0.35.3.

## [0.15.0] - 2026-09-25

### Changed

- Sound near the listener is continuous now: the game declares its player
  extent for spatial sound in `src/config/sounds.js` (`mode: 'topDown'`,
  `innerRadius: 14` world units — the snake's `baseRadius`). A crystal picked
  up under the head no longer jumps into one ear with a change of timbre.
  `virtualElevation` is deliberately left at the engine default, one world
  unit here being one screen pixel. An engine without `parts.sounds.spatial`
  support ignores the block and sounds as it did before — no version bump is
  required.
