# Changelog

All notable changes to `@vimp-games/snakes` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
