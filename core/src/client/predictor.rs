//! Client-side prediction of the local snake: a replica of `crate::motion`
//! (the very same functions the authoritative `Snake::step` calls) plus the
//! reconciliation against the player block of every incoming frame.
//!
//! Reconciliation works in TIME, not in `seq`: the authoritative state is
//! stamped with `serverTime`, the input history with `performance.now`, and
//! the two are bridged by the clock `offset` the engine keeps. That is why
//! `replayed_inputs` reports a time window — it localises a drift in the
//! movement formula far better than an input counter.
//!
//! The replica carries a full `BodyPath`, not just a head: the local snake is
//! drawn from the predicted spine, so the body has to follow the head at
//! render rate like everyone else's does at frame rate.

use std::collections::VecDeque;

use indexmap::IndexMap;

use vimp_engine_core::config::PLAYER_STATE_LEN;

use crate::config::{KeyConfig, SnakeConfig};
use crate::motion::{self, BodyPath, MoveInput, SPINE_LEN};

/// Input older than this is dropped: replaying more than two seconds after a
/// stall costs more than the accuracy it buys.
const HISTORY_MAX_AGE: f64 = 2000.0;
/// Visual error left by a correction decays over ~100 ms instead of snapping.
const ERROR_DECAY_RATE: f64 = 10.0;
/// Beyond this the correction is a teleport (a respawn), not a drift — snap.
const ERROR_SNAP_DISTANCE: f32 = 100.0;
/// Cap of the render-tick accumulator (a backgrounded tab must not replay
/// minutes of movement in one frame).
const MAX_ACCUMULATED_TIME: f64 = 100.0;

/// Predicted state of the local snake, in the player-block layout
/// `[x, y, cos(angle), sin(angle), crystals, length, alive, 0]` — the same
/// order `Snake::prediction_state` packs, and the reason for the trigonometry
/// is documented there.
///
/// Speed is deliberately absent: it is not integrated state. Both halves
/// derive it from the held keys and the crystal count on every step
/// (`motion::speed_of`), so carrying it would be carrying a duplicate.
#[derive(Clone, Copy, Default)]
pub struct SnakeState {
    pub x: f32,
    pub y: f32,
    pub angle: f32,
    pub crystals: f32,
    pub length: f32,
    pub alive: bool,
}

impl SnakeState {
    pub fn from_array(s: [f32; PLAYER_STATE_LEN]) -> Self {
        Self {
            x: s[0],
            y: s[1],
            angle: s[3].atan2(s[2]),
            crystals: s[4],
            length: s[5],
            alive: s[6] > 0.5,
        }
    }

    pub fn to_array(self) -> [f32; PLAYER_STATE_LEN] {
        [
            self.x,
            self.y,
            self.angle.cos(),
            self.angle.sin(),
            self.crystals,
            self.length,
            self.alive as u8 as f32,
            0.0,
        ]
    }
}

/// What the renderer gets: the predicted spine with the visual error of the
/// last correction blended in. The error is applied to EVERY point, not only
/// the head — half a corrected snake is worse than a slightly late one.
pub struct RenderState {
    pub spine: [f32; SPINE_LEN],
    pub x: f32,
    pub y: f32,
    pub angle: f32,
    pub crystals: f32,
    pub radius: f32,
    pub boosting: bool,
}

/// Everything one replayed step needs to know about the player's intent:
/// the key mask AND the pointer, which carries a value the mask cannot hold.
/// Replay walks these, so a pointer target that never entered the history
/// would be a prediction that quietly disagrees with the host.
#[derive(Clone, Copy, Default)]
struct InputSnapshot {
    keys: u32,
    aim: Option<[f32; 2]>,
    pointer_boost: bool,
}

struct HistoryEntry {
    time: f64,
    input: InputSnapshot,
}

pub struct Predictor {
    step_ms: f64,
    models: IndexMap<String, SnakeConfig>,
    model: Option<SnakeConfig>,

    left_bit: u32,
    right_bit: u32,
    boost_bit: u32,

    active: bool,
    frozen: bool,
    has_state: bool,
    pending_reset: bool,

    state: SnakeState,
    path: BodyPath,

    input: InputSnapshot,
    history: VecDeque<HistoryEntry>,
    base_input: InputSnapshot,

    visual_error: [f32; 2],

    accumulator: f64,
    last_update_time: Option<f64>,
    last_replay: Option<(f64, f64, usize)>,
}

impl Predictor {
    pub fn new(
        step_ms: f64,
        player_keys: &IndexMap<String, KeyConfig>,
        models: &IndexMap<String, SnakeConfig>,
    ) -> Self {
        let bit = |name: &str| player_keys.get(name).map(|k| k.key).unwrap_or(0);

        Self {
            step_ms,
            models: models.clone(),
            model: None,
            left_bit: bit("left"),
            right_bit: bit("right"),
            boost_bit: bit("boost"),
            active: false,
            frozen: false,
            has_state: false,
            pending_reset: true,
            state: SnakeState::default(),
            path: BodyPath::default(),
            input: InputSnapshot::default(),
            history: VecDeque::new(),
            base_input: InputSnapshot::default(),
            visual_error: [0.0; 2],
            accumulator: 0.0,
            last_update_time: None,
            last_replay: None,
        }
    }

    pub fn set_model(&mut self, model_name: &str) {
        self.model = self.models.get(model_name).cloned();
    }

    pub fn set_active(&mut self, active: bool) {
        if active && !self.active {
            self.pending_reset = true;
        }

        self.active = active;

        if !active {
            self.has_state = false;
        }
    }

    /// A dead snake stops predicting: the authoritative state stops moving too,
    /// and predicting a corpse only produces corrections.
    pub fn freeze(&mut self, frozen: bool) {
        self.frozen = frozen;
    }

    pub fn reset(&mut self) {
        self.pending_reset = true;
        self.history.clear();
        self.base_input = InputSnapshot::default();
        self.input = InputSnapshot::default();
        self.visual_error = [0.0; 2];
        self.accumulator = 0.0;
        self.last_replay = None;
        self.path = BodyPath::default();
    }

    pub fn has_state(&self) -> bool {
        self.active && self.has_state && self.model.is_some()
    }

    pub fn state(&self) -> SnakeState {
        self.state
    }

    pub fn replayed_inputs(&self) -> Option<(f64, f64, usize)> {
        self.last_replay
    }

    /// Only the movement keys take part in the replica. `respawn` changes no
    /// predicted position — it is a request the host answers with a frame.
    pub fn apply_input(&mut self, action: &str, key_name: &str, local_time: f64) {
        let bit = match key_name {
            "left" => self.left_bit,
            "right" => self.right_bit,
            "boost" => self.boost_bit,
            _ => return,
        };

        if bit == 0 {
            return;
        }

        if action == "down" {
            self.input.keys |= bit;

            // как и у авторитетного `Snake::apply_key`: клавиша поворота
            // отменяет цель указателя
            if bit == self.left_bit || bit == self.right_bit {
                self.input.aim = None;
            }
        } else if action == "up" {
            self.input.keys &= !bit;
        }

        self.push_history(local_time);
    }

    /// Ввод указателем — той же историей, что и клавиши (`Snake::apply_aim`).
    pub fn apply_aim(&mut self, x: f32, y: f32, flags: u32, local_time: f64) {
        if flags & 1 == 0 {
            self.input.aim = None;
            self.input.pointer_boost = false;
        } else {
            self.input.aim = Some([x, y]);
            self.input.pointer_boost = flags & 2 != 0;
        }

        self.push_history(local_time);
    }

    fn push_history(&mut self, local_time: f64) {
        self.history.push_back(HistoryEntry {
            time: local_time,
            input: self.input,
        });
        self.trim_history(local_time);
    }

    pub fn update(&mut self, local_now: f64) {
        let Some(last) = self.last_update_time else {
            self.last_update_time = Some(local_now);

            return;
        };

        let elapsed = local_now - last;

        self.last_update_time = Some(local_now);

        let decay = (1.0 - (elapsed / 1000.0) * ERROR_DECAY_RATE).max(0.0) as f32;

        for value in &mut self.visual_error {
            *value *= decay;
        }

        if !self.has_state() || self.frozen {
            self.accumulator = 0.0;

            return;
        }

        self.accumulator = (self.accumulator + elapsed).min(MAX_ACCUMULATED_TIME);

        while self.accumulator >= self.step_ms {
            self.step(self.input);
            self.accumulator -= self.step_ms;
        }
    }

    /// The authoritative state of the local snake: rewind to it, then replay
    /// every input newer than the frame.
    pub fn on_server_state(
        &mut self,
        state: [f32; PLAYER_STATE_LEN],
        server_time: f64,
        offset: f64,
        local_now: f64,
    ) {
        if !self.active || self.model.is_none() {
            return;
        }

        let old = self.has_state.then_some(self.state);
        let respawned = old.is_some_and(|old| !old.alive) && state[6] > 0.5;

        self.state = SnakeState::from_array(state);
        self.has_state = true;

        // a respawn is a teleport with a brand new body: nothing of the old
        // path belongs to it, and blending the jump would drag the corpse's
        // shape across the arena
        if respawned || old.is_none() {
            self.path.reset(self.state.x, self.state.y);
        }

        let server_now_est = local_now + offset;
        let mut history_index = 0;
        let mut replay_input = self.base_input;
        let mut replayed = 0;
        let mut t = server_time;

        while history_index < self.history.len() && self.history[history_index].time + offset <= t {
            replay_input = self.history[history_index].input;
            history_index += 1;
        }

        while t + self.step_ms <= server_now_est {
            t += self.step_ms;

            while history_index < self.history.len()
                && self.history[history_index].time + offset <= t
            {
                replay_input = self.history[history_index].input;
                history_index += 1;
                replayed += 1;
            }

            self.step(replay_input);
        }

        self.accumulator = server_now_est - t;
        self.last_replay = Some((server_time - offset, local_now, replayed));

        let Some(old) = old else {
            self.pending_reset = false;
            self.visual_error = [0.0; 2];

            return;
        };

        if self.pending_reset || respawned {
            self.pending_reset = false;
            self.visual_error = [0.0; 2];

            return;
        }

        self.visual_error[0] += old.x - self.state.x;
        self.visual_error[1] += old.y - self.state.y;

        if self.visual_error[0].hypot(self.visual_error[1]) > ERROR_SNAP_DISTANCE {
            self.visual_error = [0.0; 2];
        }
    }

    pub fn render_state(&self) -> Option<RenderState> {
        if !self.has_state() {
            return None;
        }

        let model = self.model.as_ref()?;
        let crystals = self.state.crystals.max(0.0);
        let mut spine = self.path.resample();

        for k in 0..SPINE_LEN / 2 {
            spine[k * 2] += self.visual_error[0];
            spine[k * 2 + 1] += self.visual_error[1];
        }

        Some(RenderState {
            spine,
            x: self.state.x + self.visual_error[0],
            y: self.state.y + self.visual_error[1],
            angle: self.state.angle,
            crystals,
            radius: motion::radius_for(crystals as u32, model),
            boosting: self.boosting_now(),
        })
    }

    fn boosting_now(&self) -> bool {
        let Some(model) = &self.model else {
            return false;
        };

        (self.input.keys & self.boost_bit != 0 || self.input.pointer_boost)
            && self.state.crystals as u32 > model.boost_min_crystals
    }

    fn trim_history(&mut self, local_now: f64) {
        let min_time = local_now - HISTORY_MAX_AGE;

        while let Some(entry) = self.history.front() {
            if entry.time >= min_time {
                break;
            }

            self.base_input = entry.input;
            self.history.pop_front();
        }
    }

    /// One fixed step of the replica — the same order as `Snake::step`.
    ///
    /// The one thing it does NOT replicate is the boost drain: crystals are
    /// authoritative and arrive with the frame, so a locally predicted burn
    /// would be corrected a moment later for nothing. The consequence is
    /// bounded — a snake boosting through its last crystals predicts one
    /// reconciliation's worth of extra speed, and `speed` is a component of
    /// the player block, so `predicted_state` reports it if it ever matters.
    fn step(&mut self, input: InputSnapshot) {
        let Some(model) = &self.model else {
            return;
        };

        if self.path.node_count() < 2 {
            self.path.reset(self.state.x, self.state.y);
        }

        let dt = (self.step_ms / 1000.0) as f32;

        let move_input = MoveInput {
            left: input.keys & self.left_bit != 0,
            right: input.keys & self.right_bit != 0,
            boost: input.keys & self.boost_bit != 0 || input.pointer_boost,
            aim: input.aim,
        };

        let can_boost = self.state.crystals as u32 > model.boost_min_crystals;
        let head = [self.state.x, self.state.y];

        self.state.angle = motion::step_angle(head, self.state.angle, move_input, model, dt);

        let speed = motion::speed_of(move_input, can_boost, model);
        let head = motion::advance_head(
            self.state.x,
            self.state.y,
            self.state.angle,
            speed,
            dt,
        );

        self.state.x = head[0];
        self.state.y = head[1];

        self.path.advance(head, model.point_spacing);
        self.path.trim(self.state.length);
    }
}

/// Parity of the replica with the authoritative simulation. This is the ONE
/// test that catches `crate::motion` drifting apart between the two halves —
/// re-run it after every movement change (`npm run core:test`).
#[cfg(test)]
mod parity {
    use super::*;
    use crate::config::SnakesConfig;
    use crate::game::GameState;

    const DT: f32 = 1.0 / 120.0;
    const STEP_MS: f64 = 1000.0 / 120.0;

    /// 20 cells of 128 -> a disc of radius 1280 centred on (1280, 1280).
    const MAP_JSON: &str = r#"{
        "setId": "c1",
        "scale": 1,
        "step": 128,
        "physicsStatic": [],
        "physicsDynamic": [],
        "map": [
            [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
            [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
            [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
            [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
            [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
            [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
            [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
            [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
            [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
            [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
            [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
            [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
            [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
            [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
            [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
            [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
            [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
            [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
            [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
            [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1]
        ],
        "respawns": { "players": [[1280, 1280, 0]] }
    }"#;

    /// Same as the shipped config, with the crystal field switched off: this
    /// suite compares two movement formulas, and a crystal eaten by one half
    /// and not the other would test something else.
    ///
    /// `start_crystals` is a parameter because there is no public way to hand
    /// the authoritative snake crystals — the only legitimate source is eating
    /// one, and the field is off here — and the boost cannot be compared until
    /// both halves agree that it is allowed.
    fn config_json() -> serde_json::Value {
        config_json_with(0, 2)
    }

    fn config_json_with(start_crystals: u32, boost_min: u32) -> serde_json::Value {
        let mut model = crate::config::fixtures::model_json();

        model["world"]["maxCrystals"] = serde_json::json!(0);
        model["world"]["startCrystals"] = serde_json::json!(start_crystals);
        model["boostMinCrystals"] = serde_json::json!(boost_min);

        serde_json::json!({
            "timeStep": 1.0 / 120.0,
            "mapScale": 1.0,
            "mapSetId": "c1",
            "snapshot": {
                "version": 3,
                "port": 5,
                "keys": {
                    "s1": { "id": 1, "kind": "indexed8", "class": "hot", "fields": [
                        { "name": "x", "ty": "f32", "interp": "lerp" }
                    ] },
                    "c1": { "id": 3, "kind": "indexedNoNull8", "class": "hot", "fields": [
                        { "name": "x", "ty": "f32", "interp": "lerp" },
                        { "name": "y", "ty": "f32", "interp": "lerp" },
                        { "name": "angle", "ty": "f32", "interp": "lerpAngle" }
                    ] }
                }
            },
            "seed": 42,
            "friendlyFire": false,
            "models": { "s1": model },
            "weapons": {},
            "playerKeys": {
                "left": { "key": 1 },
                "right": { "key": 2 },
                "boost": { "key": 4 },
                "respawn": { "key": 8, "type": 1 }
            },
            "panel": {
                "crystals": { "value": 0.0 },
                "dead": { "value": 0.0 }
            }
        })
    }

    fn game_config() -> SnakesConfig {
        serde_json::from_value(config_json()).unwrap()
    }

    fn engine_config() -> vimp_engine_core::config::EngineConfig {
        serde_json::from_value(config_json()).unwrap()
    }

    fn key_bit(name: &str) -> u32 {
        game_config().player_keys[name].key
    }

    /// Steps both halves through one schedule of key masks
    /// ({ step index → new mask }) and returns their final head positions.
    fn simulate(steps: usize, schedule: &[(usize, u32)]) -> ([f32; 2], (f32, f32)) {
        let cfg = game_config();
        let mut game = GameState::new(engine_config(), &cfg);

        game.load_map(MAP_JSON).unwrap();
        game.spawn_actor(1, "s1", 1, 1280.0, 1280.0, 0.0).unwrap();

        let mut predictor = Predictor::new(STEP_MS, &cfg.player_keys, &cfg.models);

        predictor.set_model("s1");
        predictor.set_active(true);

        let (start, _) = game.prediction_state(1).unwrap();

        predictor.on_server_state(start, 0.0, 0.0, 0.0);

        // step() directly instead of update(): parity compares the formulas of
        // one tick, not the render-tick accumulator
        let mut mask = 0u32;
        let mut seq = 0u32;

        for i in 0..steps {
            if let Some((_, new_mask)) = schedule.iter().find(|(step, _)| *step == i) {
                for (name, key) in &cfg.player_keys {
                    if !matches!(name.as_str(), "left" | "right" | "boost") {
                        continue;
                    }

                    let was = mask & key.key != 0;
                    let now = new_mask & key.key != 0;

                    if was != now {
                        seq += 1;
                        game.apply_input(1, seq, if now { "down" } else { "up" }, name);
                    }
                }

                mask = *new_mask;
            }

            game.step(DT);
            predictor.step(InputSnapshot {
                keys: mask,
                ..InputSnapshot::default()
            });
        }

        let authoritative = game.actor_position(1).unwrap();
        let render = predictor.render_state().unwrap();

        (authoritative, (render.x, render.y))
    }

    fn expect_close(authoritative: [f32; 2], replica: (f32, f32), tolerance: f32) {
        assert!(
            (replica.0 - authoritative[0]).abs() < tolerance,
            "x: replica {} vs core {}",
            replica.0,
            authoritative[0]
        );
        assert!(
            (replica.1 - authoritative[1]).abs() < tolerance,
            "y: replica {} vs core {}",
            replica.1,
            authoritative[1]
        );
    }

    #[test]
    fn cruise_straight() {
        let (core, replica) = simulate(120, &[]);

        expect_close(core, replica, 0.5);
    }

    #[test]
    fn turn_right() {
        let (core, replica) = simulate(120, &[(0, key_bit("right"))]);

        expect_close(core, replica, 0.5);
    }

    #[test]
    fn turn_left_then_right() {
        let (core, replica) = simulate(
            240,
            &[(0, key_bit("left")), (80, key_bit("right")), (160, 0)],
        );

        expect_close(core, replica, 0.5);
    }

    /// Steps both halves through a schedule of pointer events
    /// ({ step index → (x, y, flags) }) and returns their final head
    /// positions. The pointer travels the same path as the keys: one call
    /// into the authoritative sim, one into the predictor's history.
    fn simulate_aim(steps: usize, schedule: &[(usize, f32, f32, u32)]) -> ([f32; 2], (f32, f32)) {
        let cfg = game_config();
        let mut game = GameState::new(engine_config(), &cfg);

        game.load_map(MAP_JSON).unwrap();
        game.spawn_actor(1, "s1", 1, 1280.0, 1280.0, 0.0).unwrap();

        let mut predictor = Predictor::new(STEP_MS, &cfg.player_keys, &cfg.models);

        predictor.set_model("s1");
        predictor.set_active(true);

        let (start, _) = game.prediction_state(1).unwrap();

        predictor.on_server_state(start, 0.0, 0.0, 0.0);

        let mut input = InputSnapshot::default();
        let mut seq = 0u32;

        for i in 0..steps {
            if let Some(&(_, x, y, flags)) = schedule.iter().find(|(step, ..)| *step == i) {
                seq += 1;
                game.apply_aim(1, seq, x, y, flags);

                if flags & 1 == 0 {
                    input.aim = None;
                    input.pointer_boost = false;
                } else {
                    input.aim = Some([x, y]);
                    input.pointer_boost = flags & 2 != 0;
                }
            }

            game.step(DT);
            predictor.step(input);
        }

        let authoritative = game.actor_position(1).unwrap();
        let render = predictor.render_state().unwrap();

        (authoritative, (render.x, render.y))
    }

    #[test]
    fn steering_to_a_point_stays_in_step() {
        // цель сбоку и сзади: змейка доворачивает несколько десятков шагов
        let (core, replica) = simulate_aim(240, &[(0, 1000.0, 1700.0, 1)]);

        expect_close(core, replica, 0.5);
    }

    #[test]
    fn releasing_the_pointer_stays_in_step() {
        let (core, replica) =
            simulate_aim(240, &[(0, 1000.0, 1700.0, 1), (60, 1000.0, 1700.0, 0)]);

        expect_close(core, replica, 0.5);
    }

    #[test]
    fn a_pointer_target_actually_turns_the_snake() {
        // без этого предыдущие два теста прошли бы на двух неподвижных углах
        let (straight, _) = simulate_aim(240, &[]);
        let (steered, _) = simulate_aim(240, &[(0, 1000.0, 1700.0, 1)]);

        assert!(
            (steered[1] - straight[1]).abs() > 100.0,
            "the pointer did not steer: {steered:?} vs {straight:?}"
        );
    }

    #[test]
    fn boost_is_refused_on_both_halves_without_crystals() {
        // a fresh snake starts at startCrystals (0), below boostMinCrystals,
        // so holding boost must change nothing on either side
        let (core, replica) = simulate(120, &[(0, key_bit("boost"))]);

        expect_close(core, replica, 0.5);
    }

    #[test]
    fn boosting_with_crystals_stays_in_step() {
        // 200 crystals is far more than half a second of drain can spend, so
        // both halves agree the boost is allowed for the whole run
        let json = config_json_with(200, 2);
        let cfg: SnakesConfig = serde_json::from_value(json.clone()).unwrap();
        let engine: vimp_engine_core::config::EngineConfig =
            serde_json::from_value(json).unwrap();

        let mut game = GameState::new(engine, &cfg);

        game.load_map(MAP_JSON).unwrap();
        game.spawn_actor(1, "s1", 1, 1280.0, 1280.0, 0.0).unwrap();
        game.apply_input(1, 1, "down", "boost");

        let mut predictor = Predictor::new(STEP_MS, &cfg.player_keys, &cfg.models);

        predictor.set_model("s1");
        predictor.set_active(true);
        predictor.on_server_state(game.prediction_state(1).unwrap().0, 0.0, 0.0, 0.0);

        let mask = cfg.player_keys["boost"].key;

        for _ in 0..60 {
            game.step(DT);
            predictor.step(InputSnapshot {
                keys: mask,
                ..InputSnapshot::default()
            });
        }

        let render = predictor.render_state().unwrap();
        let core = game.actor_position(1).unwrap();

        // it must actually have boosted, or this test passes on two halves
        // that agree only because neither of them moved fast
        assert!(
            core[0] - 1280.0 > 240.0,
            "the host did not boost: travelled {}",
            core[0] - 1280.0
        );

        // the host burns crystals and the replica does not, but neither
        // reaches the minimum here, so the positions must still agree
        expect_close(core, (render.x, render.y), 0.5);
    }

    #[test]
    fn the_predicted_spine_follows_the_predicted_head() {
        let cfg = game_config();
        let mut predictor = Predictor::new(STEP_MS, &cfg.player_keys, &cfg.models);

        predictor.set_model("s1");
        predictor.set_active(true);

        let mut state = [0.0f32; PLAYER_STATE_LEN];

        state[0] = 1280.0;
        state[1] = 1280.0;
        state[5] = 300.0; // length paid for by the crystals the host reports
        state[6] = 1.0;

        predictor.on_server_state(state, 0.0, 0.0, 0.0);

        for _ in 0..600 {
            predictor.step(InputSnapshot::default());
        }

        let render = predictor.render_state().unwrap();

        // head first, and the body trailing behind it along -x
        assert!((render.spine[0] - render.x).abs() < 1e-3);
        assert!((render.spine[1] - render.y).abs() < 1e-3);
        assert!(
            render.spine[SPINE_LEN - 2] < render.x - 250.0,
            "tail at {} vs head {}",
            render.spine[SPINE_LEN - 2],
            render.x
        );
    }
}
