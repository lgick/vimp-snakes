//! The playfield: a disc, not a tile grid.
//!
//! There is no config channel for "arena radius" — the `game` half of the init
//! JSON is a fixed field set assembled by the engine, and a free-form
//! `gameConfig.parts.*` key reaches the client and never the core (see
//! `src/data/models.js`). So the disc is DERIVED from the map both sides
//! already have:
//!
//! ```text
//! radius = min(cols, rows) * step / 2,  centre = (cols * step / 2, rows * step / 2)
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

    /// The nearest point of the disc to `point`, `margin` clear of the edge —
    /// unchanged if it is already inside.
    ///
    /// The arena is rebuilt under the running match when the room grows or
    /// shrinks (`src/host/ArenaScaler.js`), and the respawn point the engine
    /// hands out with a spawn comes from the map IT last loaded, which may be
    /// the previous, larger one. A snake dropped outside the disc would die on
    /// its first step; pulling it in is the difference between "the arena
    /// shrank" and "the room kills whoever joins during the shrink".
    ///
    /// A radius of zero means no map has been loaded yet — there is nothing to
    /// clamp to, so the point is returned as it came.
    pub fn clamp_inside(&self, point: [f32; 2], margin: f32) -> [f32; 2] {
        if self.radius <= 0.0 || self.contains(point, margin) {
            return point;
        }

        let dx = point[0] - self.centre[0];
        let dy = point[1] - self.centre[1];
        let dist = (dx * dx + dy * dy).sqrt();
        let limit = (self.radius - margin).max(0.0);

        if dist <= f32::EPSILON {
            return [self.centre[0], self.centre[1]];
        }

        let k = limit / dist;

        [self.centre[0] + dx * k, self.centre[1] + dy * k]
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
    fn clamp_inside_pulls_an_outside_point_onto_the_margin() {
        let arena = arena();
        let point = arena.clamp_inside([4000.0, 1280.0], 60.0);

        assert!(arena.contains(point, 59.0), "{point:?}");
        assert!((point[0] - (1280.0 + 1220.0)).abs() < 0.01, "{point:?}");
        assert!((point[1] - 1280.0).abs() < 0.01, "{point:?}");
    }

    #[test]
    fn clamp_inside_leaves_an_inside_point_alone() {
        let arena = arena();
        let point = arena.clamp_inside([1300.0, 1300.0], 60.0);

        assert_eq!(point, [1300.0, 1300.0]);
    }

    #[test]
    fn clamp_inside_without_a_map_is_a_no_op() {
        let arena = Arena::default();

        assert_eq!(arena.clamp_inside([4000.0, 1280.0], 60.0), [4000.0, 1280.0]);
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
