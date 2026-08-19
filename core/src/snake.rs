//! One snake: the keys it holds, the body it drags and the two numbers the
//! rest of the game reads off it — the crystal count and whether it is alive.
//!
//! There is no Rapier body here and no collider. A snake's position IS
//! `path.head()`, and everything that can kill it (the arena edge, another
//! snake's body) is a distance test in `game.rs`. That is what keeps the
//! client's prediction exact: the predictor runs the same `step` against the
//! same `motion.rs`, with no physics solver in between to disagree about.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use vimp_engine_core::config::PLAYER_STATE_LEN;
use vimp_engine_core::physics::deg_to_rad;

use crate::config::{KeyConfig, SnakeConfig};
use crate::motion::{self, BodyPath, MoveInput};

/// The bits of the four actions, resolved once from `gameConfig.playerKeys`.
/// The engine ships that table verbatim and never interprets it — mapping a
/// name to a bit is this file's job, and so is the one-shot semantics of
/// `type: 1` (see `apply_key`).
#[derive(Clone, Copy, Default, Serialize, Deserialize)]
pub struct KeyBits {
    pub left: u32,
    pub right: u32,
    pub boost: u32,
    pub respawn: u32,
    /// Union of every `type: 1` bit — the ones a fixed step consumes.
    pub one_shot: u32,
}

impl KeyBits {
    pub fn from_config(keys: &IndexMap<String, KeyConfig>) -> Self {
        let mut bits = Self::default();

        for (name, cfg) in keys {
            match name.as_str() {
                "left" => bits.left = cfg.key,
                "right" => bits.right = cfg.key,
                "boost" => bits.boost = cfg.key,
                "respawn" => bits.respawn = cfg.key,
                _ => {}
            }

            if cfg.kind == 1 {
                bits.one_shot |= cfg.key;
            }
        }

        bits
    }
}

/// What one fixed step of a snake produced for the world around it.
#[derive(Default)]
pub struct StepOutcome {
    /// Crystals burned by the boost, at the point they were shed (the tail).
    pub burned: Vec<[f32; 2]>,
    /// The boost state flipped this step — the panel's mode cell follows it.
    pub mode_changed: bool,
}

#[derive(Serialize, Deserialize)]
pub struct Snake {
    pub model: String,
    pub team_id: u8,
    /// Index into SNAKE_COLORS (`src/data/palette.js`), rolled at spawn.
    pub color: u8,
    pub crystals: u32,
    /// How many times this snake has crashed — the stat table's fourth column.
    pub crashes: u32,
    pub alive: bool,
    pub angle: f32,
    pub speed: f32,
    pub boosting: bool,
    pub path: BodyPath,
    pub last_input_seq: u32,

    held_keys: u32,
    pending_keys: u32,
    /// World point the pointer last asked for, while it is held. `None` means
    /// «steered by the keyboard» — the two sources are exclusive per step.
    #[serde(default)]
    aim: Option<[f32; 2]>,
    /// Boost asked for by the pointer (a double tap held down), the analogue
    /// of holding the boost key.
    #[serde(default)]
    pointer_boost: bool,
    /// Fractional crystals owed to the boost; whole ones are shed as they
    /// accumulate, so the drain rate is exact regardless of the step size.
    boost_debt: f32,
}

impl Snake {
    pub fn new(model: &str, team_id: u8, color: u8, x: f32, y: f32, angle_deg: f32) -> Self {
        Self {
            model: model.to_string(),
            team_id,
            color,
            crystals: 0,
            crashes: 0,
            alive: true,
            angle: deg_to_rad(angle_deg),
            speed: 0.0,
            boosting: false,
            path: BodyPath::new(x, y),
            last_input_seq: 0,
            held_keys: 0,
            pending_keys: 0,
            aim: None,
            pointer_boost: false,
            boost_debt: 0.0,
        }
    }

    /// Back to a fresh snake at a new spot. Keeps identity — the colour, the
    /// team and the crash count survive — and drops everything else, which is
    /// what "respawn small" means.
    pub fn respawn(&mut self, x: f32, y: f32, angle_deg: f32, start_crystals: u32) {
        self.crystals = start_crystals;
        self.alive = true;
        self.angle = deg_to_rad(angle_deg);
        self.speed = 0.0;
        self.boosting = false;
        self.path.reset(x, y);
        self.held_keys = 0;
        self.pending_keys = 0;
        self.aim = None;
        self.pointer_boost = false;
        self.boost_debt = 0.0;
    }

    pub fn head(&self) -> [f32; 2] {
        self.path.head()
    }

    pub fn radius(&self, model: &SnakeConfig) -> f32 {
        motion::radius_for(self.crystals, model)
    }

    pub fn target_length(&self, model: &SnakeConfig) -> f32 {
        motion::length_for(self.crystals, model)
    }

    pub fn input(&self, bits: &KeyBits) -> MoveInput {
        MoveInput {
            left: self.held_keys & bits.left != 0,
            right: self.held_keys & bits.right != 0,
            boost: self.held_keys & bits.boost != 0 || self.pointer_boost,
            aim: self.aim,
        }
    }

    /// One raw pointer event (`GameSim::apply_aim`): bit 0 of `flags` is
    /// «pressed», bit 1 «this press was a double tap». Releasing the pointer
    /// drops both the target and the boost — a finger off the glass steers
    /// nothing. The predictor implements the identical rule.
    pub fn apply_aim(&mut self, x: f32, y: f32, flags: u32) {
        if flags & 1 == 0 {
            self.aim = None;
            self.pointer_boost = false;

            return;
        }

        self.aim = Some([x, y]);
        self.pointer_boost = flags & 2 != 0;
    }

    /// One raw wire event. `type: 0` keys are held — `down` sets the bit,
    /// `up` clears it. `type: 1` keys are one-shot — `down` arms a pending bit
    /// that exactly one fixed step consumes, and `up` is ignored entirely.
    /// The predictor implements the identical rule; a divergence here is a
    /// divergence in every match.
    pub fn apply_key(&mut self, action: &str, bit: u32, bits: &KeyBits) {
        if bit == 0 {
            return;
        }

        if bits.one_shot & bit != 0 {
            if action == "down" {
                self.pending_keys |= bit;
            }

            return;
        }

        if action == "down" {
            self.held_keys |= bit;

            // взявшись за клавиши, игрок отменяет прежнюю цель указателя:
            // иначе, отпустив A, змейка молча вернулась бы к старой точке
            if bit & (bits.left | bits.right) != 0 {
                self.aim = None;
            }
        } else {
            self.held_keys &= !bit;
        }
    }

    /// Consumes a pending one-shot press, if there is one.
    pub fn take_pending(&mut self, bit: u32) -> bool {
        if bit == 0 || self.pending_keys & bit == 0 {
            return false;
        }

        self.pending_keys &= !bit;

        true
    }

    /// Used by the bot manager, which drives a snake by writing masks rather
    /// than by sending wire events.
    pub fn set_held_keys(&mut self, keys: u32) {
        self.held_keys = keys;
    }

    pub fn press_once(&mut self, bit: u32) {
        self.pending_keys |= bit;
    }

    /// One fixed step: turn, move, lay the body down, pay for the boost.
    pub fn step(&mut self, dt: f32, model: &SnakeConfig, bits: &KeyBits) -> StepOutcome {
        let mut outcome = StepOutcome::default();
        let input = self.input(bits);

        let can_boost = self.crystals > model.boost_min_crystals;
        let boosting = input.boost && can_boost;

        outcome.mode_changed = boosting != self.boosting;
        self.boosting = boosting;

        let head = self.path.head();

        self.angle = motion::step_angle(head, self.angle, input, model, dt);
        self.speed = motion::speed_of(input, can_boost, model);

        let next = motion::advance_head(head[0], head[1], self.angle, self.speed, dt);

        self.path.advance(next, model.point_spacing);

        if boosting {
            self.boost_debt += model.boost_drain_per_second * dt;

            // whole crystals only: a boost tapped for a frame costs nothing
            // visible, a boost held costs exactly the configured rate
            while self.boost_debt >= 1.0 && self.crystals > model.boost_min_crystals {
                self.boost_debt -= 1.0;
                self.crystals -= 1;

                // shed behind the tail, so a boosting leader feeds the pack
                outcome
                    .burned
                    .push(self.path.nodes().last().copied().unwrap_or(next));
            }

            if self.crystals <= model.boost_min_crystals {
                self.boost_debt = 0.0;
            }
        } else {
            self.boost_debt = 0.0;
        }

        self.path.trim(self.target_length(model));

        outcome
    }

    /// The eight floats the per-user player block carries, plus the
    /// `centering` flag (unused here).
    ///
    /// Layout — positional, and mirrored by `Predictor::to_array` and by the
    /// scenario `divergence.thresholds`:
    ///
    /// ```text
    /// [x, y, cos(angle), sin(angle), crystals, length, alive, 0]
    /// ```
    ///
    /// Components 0 and 1 are world x/y, which is the contract level-0 drift
    /// detection assumes (`docs/ai/13-debugging.md`).
    ///
    /// The heading travels as its cosine and sine rather than as the angle,
    /// and that is not a stylistic choice. The drift detector compares the
    /// block COMPONENT BY COMPONENT as plain numbers; a raw angle crossing ±PI
    /// reads there as a 6.28 rad jump, so invariant 9 reports a divergence on
    /// every snake that happens to be pointing left. Raising the threshold
    /// past 2*PI would silence real drift along with it. Cosine and sine are
    /// continuous across the wrap, and the predictor recovers the angle with
    /// `atan2` — which also costs the block nothing, because the speed it
    /// replaces is not integrated state: both halves derive it from the held
    /// keys every step (`motion::speed_of`).
    pub fn prediction_state(&self, model: &SnakeConfig) -> ([f32; PLAYER_STATE_LEN], bool) {
        let head = self.head();

        (
            [
                head[0],
                head[1],
                self.angle.cos(),
                self.angle.sin(),
                self.crystals as f32,
                self.target_length(model),
                self.alive as u8 as f32,
                0.0,
            ],
            false,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::fixtures::{config, model};

    fn bits() -> KeyBits {
        KeyBits::from_config(&config().player_keys)
    }

    fn snake() -> Snake {
        Snake::new("s1", 1, 0, 0.0, 0.0, 0.0)
    }

    #[test]
    fn a_held_pointer_sets_the_aim_and_the_boost() {
        let bits = bits();
        let mut snake = snake();

        snake.apply_aim(30.0, -10.0, 3);

        let input = snake.input(&bits);

        assert_eq!(input.aim, Some([30.0, -10.0]));
        assert!(input.boost);
    }

    #[test]
    fn releasing_the_pointer_drops_the_aim_and_the_boost() {
        let bits = bits();
        let mut snake = snake();

        snake.apply_aim(30.0, -10.0, 3);
        snake.apply_aim(30.0, -10.0, 0);

        let input = snake.input(&bits);

        assert_eq!(input.aim, None);
        assert!(!input.boost);
    }

    #[test]
    fn a_turn_key_cancels_the_pointer_target() {
        let bits = bits();
        let mut snake = snake();

        snake.apply_aim(30.0, -10.0, 1);
        snake.apply_key("down", bits.left, &bits);

        assert_eq!(snake.input(&bits).aim, None);
    }

    #[test]
    fn a_respawn_forgets_the_pointer() {
        let bits = bits();
        let mut snake = snake();

        snake.apply_aim(30.0, -10.0, 3);
        snake.respawn(0.0, 0.0, 0.0, 0);

        let input = snake.input(&bits);

        assert_eq!(input.aim, None);
        assert!(!input.boost);
    }

    #[test]
    fn key_bits_read_the_names_and_the_one_shot_flag() {
        let bits = bits();

        assert_eq!(bits.left, 1);
        assert_eq!(bits.right, 2);
        assert_eq!(bits.boost, 4);
        assert_eq!(bits.respawn, 8);
        // only `respawn` is declared type: 1
        assert_eq!(bits.one_shot, 8);
    }

    #[test]
    fn a_held_key_stays_down_until_it_is_released() {
        let bits = bits();
        let mut snake = snake();

        snake.apply_key("down", bits.left, &bits);
        assert!(snake.input(&bits).left);

        snake.apply_key("up", bits.left, &bits);
        assert!(!snake.input(&bits).left);
    }

    #[test]
    fn a_one_shot_key_is_consumed_once_and_ignores_the_release() {
        let bits = bits();
        let mut snake = snake();

        snake.apply_key("down", bits.respawn, &bits);
        assert!(snake.take_pending(bits.respawn));
        assert!(!snake.take_pending(bits.respawn));

        // `up` must not arm it again
        snake.apply_key("up", bits.respawn, &bits);
        assert!(!snake.take_pending(bits.respawn));
    }

    #[test]
    fn a_snake_moves_every_step_without_any_key_held() {
        let bits = bits();
        let model = model();
        let mut snake = snake();

        snake.step(1.0 / 120.0, &model, &bits);

        let head = snake.head();

        assert!(head[0] > 0.0, "{head:?}");
        assert_eq!(snake.speed, model.base_speed);
    }

    #[test]
    fn the_body_settles_at_the_length_the_crystals_pay_for() {
        let bits = bits();
        let model = model();
        let mut snake = snake();

        snake.crystals = 10;

        for _ in 0..600 {
            snake.step(1.0 / 120.0, &model, &bits);
        }

        let expected = motion::length_for(10, &model);

        assert!(
            (snake.path.length() - expected).abs() < 1.0,
            "{} vs {expected}",
            snake.path.length()
        );
    }

    #[test]
    fn boosting_burns_crystals_and_sheds_them_behind() {
        let bits = bits();
        let model = model();
        let mut snake = snake();

        snake.crystals = 40;
        snake.apply_key("down", bits.boost, &bits);

        let mut burned = 0;

        // one second at 120 Hz -> boostDrainPerSecond crystals
        for _ in 0..120 {
            burned += snake.step(1.0 / 120.0, &model, &bits).burned.len();
        }

        assert_eq!(burned, model.boost_drain_per_second as usize);
        assert_eq!(snake.crystals, 40 - burned as u32);
        assert_eq!(snake.speed, model.base_speed * model.boost_factor);
    }

    #[test]
    fn boosting_stops_at_the_minimum_instead_of_going_negative() {
        let bits = bits();
        let model = model();
        let mut snake = snake();

        snake.crystals = 3;
        snake.apply_key("down", bits.boost, &bits);

        for _ in 0..1200 {
            snake.step(1.0 / 120.0, &model, &bits);
        }

        assert_eq!(snake.crystals, model.boost_min_crystals);
        // and with nothing left to burn, the speed drops back to cruise
        assert_eq!(snake.speed, model.base_speed);
    }

    #[test]
    fn respawn_keeps_the_identity_and_drops_the_body() {
        let model = model();
        let bits = bits();
        let mut snake = snake();

        snake.crystals = 50;
        snake.crashes = 2;

        for _ in 0..600 {
            snake.step(1.0 / 120.0, &model, &bits);
        }

        snake.respawn(100.0, 200.0, 90.0, 0);

        assert_eq!(snake.crystals, 0);
        assert_eq!(snake.crashes, 2, "crashes survive a respawn");
        assert_eq!(snake.color, 0, "colour survives a respawn");
        assert_eq!(snake.head(), [100.0, 200.0]);
        assert_eq!(snake.path.length(), 0.0);
    }
}
