//! The ONLY source of body math: pure functions and one plain data type, no
//! world state and no engine types. Both halves call them — the authoritative
//! `Snake::step` and the client `Predictor` — so every change here is a change
//! to both halves at once. Re-run `mod parity` in `client/predictor.rs` after
//! touching anything in this file.
//!
//! The model is deliberately free of inertia and of physics bodies: a snake's
//! velocity is written straight from the held keys, and collisions are
//! distance tests, not Rapier contacts. That is what makes the prediction
//! exact — the client integrates the same three lines the host does, and there
//! is no solver in between to disagree about.

use std::collections::VecDeque;

use serde::{Deserialize, Serialize};
use vimp_engine_core::physics::normalize_angle;

use crate::config::SnakeConfig;

/// Points of the resampled spine carried by one snapshot row. **Must equal
/// `SPINE_POINTS` in `src/config/snapshot.js`** — the schema there declares
/// `p0x…p15y` and the row built here fills them positionally. Nothing
/// validates the pairing; `tests/config/game.test.js` asserts it from the JS
/// side and `spine_len_matches_schema` from this one.
pub const SPINE_POINTS: usize = 16;

/// Flat `[x, y]` pairs of the spine.
pub const SPINE_LEN: usize = SPINE_POINTS * 2;

/// Turn keys held on this step.
#[derive(Clone, Copy, Default, Debug, PartialEq)]
pub struct MoveInput {
    pub left: bool,
    pub right: bool,
    pub boost: bool,
}

/// New facing angle (radians, normalised to [-PI, PI]).
pub fn step_angle(angle: f32, input: MoveInput, model: &SnakeConfig, dt: f32) -> f32 {
    let mut delta = 0.0;

    if input.left {
        delta -= model.turn_speed * dt;
    }

    if input.right {
        delta += model.turn_speed * dt;
    }

    normalize_angle(angle + delta)
}

/// Speed this step. There is no acceleration: a snake is either cruising or
/// boosting, and `can_boost` is the caller's answer to "are there crystals
/// left to burn" — the host and the predictor must agree on it.
pub fn speed_of(input: MoveInput, can_boost: bool, model: &SnakeConfig) -> f32 {
    if input.boost && can_boost {
        model.base_speed * model.boost_factor
    } else {
        model.base_speed
    }
}

/// Head position after one step.
pub fn advance_head(x: f32, y: f32, angle: f32, speed: f32, dt: f32) -> [f32; 2] {
    [x + angle.cos() * speed * dt, y + angle.sin() * speed * dt]
}

/// Half-thickness for a crystal count. Square root on purpose: linear growth
/// turns a leader into a wall nobody can get past.
pub fn radius_for(crystals: u32, model: &SnakeConfig) -> f32 {
    model.base_radius + model.radius_gain * (crystals as f32).sqrt()
}

/// Body polyline length for a crystal count.
pub fn length_for(crystals: u32, model: &SnakeConfig) -> f32 {
    model.base_length + model.length_per_crystal * crystals as f32
}

fn distance(a: [f32; 2], b: [f32; 2]) -> f32 {
    let dx = a[0] - b[0];
    let dy = a[1] - b[1];

    (dx * dx + dy * dy).sqrt()
}

fn lerp_point(a: [f32; 2], b: [f32; 2], t: f32) -> [f32; 2] {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

/// The body of a snake: a polyline from the head backwards.
///
/// `nodes[0]` is the live head and moves every step; the rest are frozen
/// breadcrumbs, dropped one `point_spacing` behind each other. Growing means
/// trimming less off the tail, so the body is always exactly as long as the
/// crystal count says — no per-segment bookkeeping anywhere.
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct BodyPath {
    nodes: VecDeque<[f32; 2]>,
}

impl BodyPath {
    /// A body collapsed onto one point, ready for the first `advance`.
    pub fn new(x: f32, y: f32) -> Self {
        let mut nodes = VecDeque::with_capacity(64);

        // two identical nodes: `advance` assumes a live head AND something
        // behind it to measure the spacing against
        nodes.push_back([x, y]);
        nodes.push_back([x, y]);

        Self { nodes }
    }

    pub fn reset(&mut self, x: f32, y: f32) {
        *self = Self::new(x, y);
    }

    pub fn head(&self) -> [f32; 2] {
        self.nodes.front().copied().unwrap_or([0.0, 0.0])
    }

    pub fn nodes(&self) -> impl Iterator<Item = &[f32; 2]> {
        self.nodes.iter()
    }

    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    /// Moves the head and lays a breadcrumb once it is `spacing` away from the
    /// previous one. The pushed point is a copy of the head: the old front
    /// freezes where it is and the new front becomes the live head.
    pub fn advance(&mut self, head: [f32; 2], spacing: f32) {
        if self.nodes.len() < 2 {
            self.reset(head[0], head[1]);

            return;
        }

        self.nodes[0] = head;

        if distance(self.nodes[0], self.nodes[1]) >= spacing {
            self.nodes.push_front(head);
        }
    }

    /// Total length of the polyline.
    pub fn length(&self) -> f32 {
        let mut total = 0.0;

        for i in 1..self.nodes.len() {
            total += distance(self.nodes[i - 1], self.nodes[i]);
        }

        total
    }

    /// Cuts the tail back to `target` world units, moving the last surviving
    /// node onto the exact cut point. A body shorter than `target` is left
    /// alone — that is a snake still growing into its new length.
    pub fn trim(&mut self, target: f32) {
        if target <= 0.0 {
            self.nodes.truncate(1);

            return;
        }

        let mut acc = 0.0;

        for i in 1..self.nodes.len() {
            let seg = distance(self.nodes[i - 1], self.nodes[i]);

            if acc + seg >= target {
                let t = if seg > 0.0 { (target - acc) / seg } else { 0.0 };

                self.nodes[i] = lerp_point(self.nodes[i - 1], self.nodes[i], t);
                self.nodes.truncate(i + 1);

                return;
            }

            acc += seg;
        }
    }

    /// `SPINE_POINTS` samples spread evenly from the head to the tail — the
    /// fixed-width form the snapshot row carries. A body of zero length
    /// collapses every sample onto the head, which is what a just-spawned
    /// snake should look like.
    pub fn resample(&self) -> [f32; SPINE_LEN] {
        let mut out = [0.0f32; SPINE_LEN];
        let head = self.head();

        for k in 0..SPINE_POINTS {
            out[k * 2] = head[0];
            out[k * 2 + 1] = head[1];
        }

        let total = self.length();

        if total <= f32::EPSILON || self.nodes.len() < 2 {
            return out;
        }

        let stride = total / (SPINE_POINTS - 1) as f32;

        // one walk down the polyline, emitting samples as their distance is
        // passed — O(nodes + points), not O(nodes * points)
        let mut node = 1;
        let mut travelled = 0.0;
        let mut seg = distance(self.nodes[0], self.nodes[1]);

        for k in 1..SPINE_POINTS {
            let want = stride * k as f32;

            while travelled + seg < want && node + 1 < self.nodes.len() {
                travelled += seg;
                node += 1;
                seg = distance(self.nodes[node - 1], self.nodes[node]);
            }

            let t = if seg > 0.0 {
                ((want - travelled) / seg).clamp(0.0, 1.0)
            } else {
                0.0
            };

            let p = lerp_point(self.nodes[node - 1], self.nodes[node], t);

            out[k * 2] = p[0];
            out[k * 2 + 1] = p[1];
        }

        out
    }

    /// Axis-aligned bounds, the broad phase of every head-vs-body test.
    pub fn bounds(&self) -> [f32; 4] {
        let mut b = [f32::MAX, f32::MAX, f32::MIN, f32::MIN];

        for node in &self.nodes {
            b[0] = b[0].min(node[0]);
            b[1] = b[1].min(node[1]);
            b[2] = b[2].max(node[0]);
            b[3] = b[3].max(node[1]);
        }

        b
    }

    /// True when `point` is within `reach` of any node.
    ///
    /// Nodes, not segments: with `pointSpacing` at 6 and the smallest body
    /// radius at 14, the worst case a node test misses is 3 units of a
    /// 14-unit disc, and the head moves 4.1 units per step even while
    /// boosting — so nothing tunnels and nobody can feel the difference. A
    /// segment test would be the honest version if either number changed.
    pub fn touches(&self, point: [f32; 2], reach: f32, skip_front: usize) -> bool {
        let reach_sq = reach * reach;

        for node in self.nodes.iter().skip(skip_front) {
            let dx = node[0] - point[0];
            let dy = node[1] - point[1];

            if dx * dx + dy * dy <= reach_sq {
                return true;
            }
        }

        false
    }

    /// Evenly spaced positions along the body — where a dead snake leaves its
    /// crystals. Returns at most `count` points, head first.
    pub fn sample_along(&self, count: usize) -> Vec<[f32; 2]> {
        if count == 0 || self.nodes.is_empty() {
            return Vec::new();
        }

        if count == 1 || self.nodes.len() < 2 {
            return vec![self.head()];
        }

        let step = (self.nodes.len() - 1) as f32 / (count - 1) as f32;

        (0..count)
            .map(|k| {
                let index = ((k as f32 * step).round() as usize).min(self.nodes.len() - 1);

                self.nodes[index]
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::fixtures::model;

    fn straight_path(len: f32, spacing: f32) -> BodyPath {
        let mut path = BodyPath::new(0.0, 0.0);
        let steps = (len / spacing).ceil() as usize;

        for i in 1..=steps {
            path.advance([i as f32 * spacing, 0.0], spacing);
        }

        path
    }

    #[test]
    fn spine_len_matches_schema() {
        // src/config/snapshot.js declares SPINE_POINTS = 16 -> 32 float fields
        assert_eq!(SPINE_POINTS, 16);
        assert_eq!(SPINE_LEN, 32);
    }

    #[test]
    fn turning_both_ways_cancels_out() {
        let model = model();
        let input = MoveInput {
            left: true,
            right: true,
            boost: false,
        };

        assert_eq!(step_angle(0.5, input, &model, 1.0 / 120.0), 0.5);
    }

    #[test]
    fn angle_stays_normalised() {
        let model = model();
        let input = MoveInput {
            right: true,
            ..MoveInput::default()
        };
        let mut angle = 0.0;

        for _ in 0..1000 {
            angle = step_angle(angle, input, &model, 1.0 / 120.0);
        }

        assert!(angle.abs() <= core::f32::consts::PI);
    }

    #[test]
    fn boost_is_refused_without_crystals() {
        let model = model();
        let input = MoveInput {
            boost: true,
            ..MoveInput::default()
        };

        assert_eq!(speed_of(input, true, &model), 260.0 * 1.9);
        assert_eq!(speed_of(input, false, &model), 260.0);
    }

    #[test]
    fn growth_is_linear_in_length_and_square_root_in_radius() {
        let model = model();

        assert_eq!(length_for(0, &model), 150.0);
        assert_eq!(length_for(10, &model), 240.0);

        assert_eq!(radius_for(0, &model), 14.0);
        assert!((radius_for(100, &model) - 30.0).abs() < 1e-4);
    }

    #[test]
    fn trim_cuts_the_polyline_to_exactly_the_target() {
        let mut path = straight_path(600.0, 6.0);

        path.trim(150.0);

        assert!((path.length() - 150.0).abs() < 1e-2, "{}", path.length());
    }

    #[test]
    fn trim_leaves_a_body_shorter_than_the_target_alone() {
        let mut path = straight_path(60.0, 6.0);
        let before = path.length();

        path.trim(150.0);

        assert!((path.length() - before).abs() < 1e-4);
    }

    #[test]
    fn resample_spreads_evenly_and_starts_at_the_head() {
        let mut path = straight_path(600.0, 6.0);

        path.trim(300.0);

        let spine = path.resample();
        let head = path.head();

        assert!((spine[0] - head[0]).abs() < 1e-3);
        assert!((spine[1] - head[1]).abs() < 1e-3);

        // a straight body along -x from the head: every sample one stride apart
        let stride = 300.0 / (SPINE_POINTS - 1) as f32;

        for k in 0..SPINE_POINTS {
            let expected = head[0] - stride * k as f32;

            assert!(
                (spine[k * 2] - expected).abs() < 0.5,
                "sample {k}: {} vs {expected}",
                spine[k * 2]
            );
        }
    }

    #[test]
    fn resample_of_a_fresh_body_collapses_onto_the_head() {
        let path = BodyPath::new(7.0, -3.0);
        let spine = path.resample();

        for k in 0..SPINE_POINTS {
            assert_eq!(spine[k * 2], 7.0);
            assert_eq!(spine[k * 2 + 1], -3.0);
        }
    }

    #[test]
    fn touches_finds_a_point_on_the_body_and_misses_one_beside_it() {
        let mut path = straight_path(600.0, 6.0);

        path.trim(300.0);

        assert!(path.touches([500.0, 0.0], 14.0, 0));
        assert!(!path.touches([500.0, 400.0], 14.0, 0));
    }

    #[test]
    fn advance_lays_a_breadcrumb_only_after_the_spacing() {
        let mut path = BodyPath::new(0.0, 0.0);

        path.advance([1.0, 0.0], 6.0);
        assert_eq!(path.node_count(), 2);

        path.advance([6.0, 0.0], 6.0);
        assert_eq!(path.node_count(), 3);
    }
}
