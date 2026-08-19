//! The playfield: a disc, not a tile grid.
//!
//! There is no config channel for "arena radius" — the `game` half of the init
//! JSON is a fixed field set assembled by the engine, and a free-form
//! `gameConfig.parts.*` key reaches the client and never the core (see
//! `src/data/models.js`). So the disc is DERIVED from the map both sides
//! already have:
//!
//! ```text
//! radius = min(cols * step, rows * step) / 2,  centre = (w / 2, h / 2)
//! ```
//!
//! `src/data/maps/arena.js` documents the same formula and
//! `src/client/parts/Arena.js` draws it from the same numbers. Change the grid
//! size or the step and both halves move together, which is the whole point.

use vimp_engine_core::map::GameMap;
use vimp_engine_core::rng::Rng;

#[derive(Clone, Copy, Debug)]
pub struct Arena {
    pub centre: [f32; 2],
    pub radius: f32,
}

impl Default for Arena {
    fn default() -> Self {
        Self {
            centre: [0.0, 0.0],
            radius: 0.0,
        }
    }
}

impl Arena {
    /// `step` on `GameMap` is already scaled; `grid` is not scaled and is only
    /// used for its dimensions — the tile values carry no geometry in this
    /// game (`physicsStatic` is empty on purpose).
    pub fn from_map(map: &GameMap) -> Self {
        let rows = map.grid.len();
        let cols = map.grid.first().map(Vec::len).unwrap_or(0);

        let width = cols as f32 * map.step;
        let height = rows as f32 * map.step;

        Self {
            centre: [width / 2.0, height / 2.0],
            radius: width.min(height) / 2.0,
        }
    }

    /// Is the point inside the disc, keeping `margin` clear of the edge?
    /// A snake head is tested with its own body radius as the margin: the
    /// boundary catches the snake, not its centreline.
    pub fn contains(&self, point: [f32; 2], margin: f32) -> bool {
        let dx = point[0] - self.centre[0];
        let dy = point[1] - self.centre[1];
        let limit = (self.radius - margin).max(0.0);

        dx * dx + dy * dy <= limit * limit
    }

    /// A uniformly distributed point of the disc, `margin` clear of the edge.
    ///
    /// `sqrt` on the radius is not decoration: sampling the radius linearly
    /// piles two thirds of the crystals into the middle third of the arena.
    /// Every roll goes through the engine `Rng` — a match must replay the same
    /// way from the same seed.
    pub fn random_point(&self, rng: &mut Rng, margin: f32) -> [f32; 2] {
        let limit = (self.radius - margin).max(0.0);
        let theta = rng.range(0.0, core::f32::consts::TAU);
        let r = limit * rng.range(0.0, 1.0).sqrt();

        [
            self.centre[0] + theta.cos() * r,
            self.centre[1] + theta.sin() * r,
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn arena() -> Arena {
        // 20 cells of 128 -> 2560 across, radius 1280, centre (1280, 1280)
        Arena {
            centre: [1280.0, 1280.0],
            radius: 1280.0,
        }
    }

    #[test]
    fn the_centre_is_inside_and_the_corner_is_not() {
        let arena = arena();

        assert!(arena.contains([1280.0, 1280.0], 0.0));
        assert!(!arena.contains([0.0, 0.0], 0.0));
    }

    #[test]
    fn the_margin_shrinks_the_disc() {
        let arena = arena();

        assert!(arena.contains([2550.0, 1280.0], 0.0));
        assert!(!arena.contains([2550.0, 1280.0], 60.0));
    }

    #[test]
    fn random_points_stay_inside_the_margin() {
        let arena = arena();
        let mut rng = Rng::new(1234);

        for _ in 0..500 {
            let p = arena.random_point(&mut rng, 60.0);

            assert!(arena.contains(p, 59.0), "{p:?}");
        }
    }
}
