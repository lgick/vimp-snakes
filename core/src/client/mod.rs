//! The game half of the client core: prediction of the local snake
//! (`Predictor`). The network buffer, the interpolation, the hot buffer and
//! the frame queue are the engine's
//! (`vimp_engine_core::client::game::ClientState`).
//!
//! Two things this game does NOT need, and deliberately leaves empty:
//!
//!   * `try_action` — there is no weapon and nothing to spawn locally, so
//!     there is no locally predicted effect and nothing for
//!     `filter_frame_game` to de-duplicate. The `respawn` key is a request the
//!     host answers with a frame, not something to draw ahead of time.
//!   * a world copy — the local snake's only interactions (the arena edge,
//!     other bodies, crystals) are all resolved authoritatively, and guessing
//!     a death locally would mean showing the player a crash the host might
//!     not agree with.

pub mod predictor;

use indexmap::IndexMap;
use serde_json::{Map, Value};

use vimp_engine_core::client::game::{GameClientDef, RenderOverlay};
use vimp_engine_core::client::interpolator::{FrameData, InterpolatedGame};
use vimp_engine_core::client::unpack::{BlockData, DecodedSnapshot};
use vimp_engine_core::config::{EngineClientConfig, FieldValue, PLAYER_STATE_LEN};

use crate::config::{SnakeConfig, SnakesClientConfig};
use crate::motion::SPINE_LEN;
use predictor::Predictor;

/// Indices into the snake row — a positional contract with the `s1` key of
/// `src/config/snapshot.js` and with `SnakeRow` in `game.rs`. The full layout
/// is 32 spine floats, then:
///
/// ```text
/// [32] angle  [33] radius  [34] crystals  [35] colour  [36] boost
/// ```
///
/// Only the two this half has to READ are named; `render_overlay` writes the
/// row by pushing in order, so naming the write positions would be a second
/// copy of the same contract to keep in sync.
const ROW_CRYSTALS: usize = SPINE_LEN + 2;
const ROW_COLOR: usize = SPINE_LEN + 3;

/// Total width of the snake row.
const ROW_LEN: usize = SPINE_LEN + 5;

fn field_u16(fields: &[FieldValue], index: usize) -> u16 {
    match fields.get(index) {
        Some(FieldValue::U16(v)) => *v,
        Some(FieldValue::U8(v)) => *v as u16,
        _ => 0,
    }
}

fn field_u8(fields: &[FieldValue], index: usize) -> u8 {
    match fields.get(index) {
        Some(FieldValue::U8(v)) => *v,
        _ => 0,
    }
}

/// What the last authoritative row said about the local snake — the parts the
/// predictor does not carry.
#[derive(Clone, Copy)]
struct LocalMeta {
    color: u8,
    crystals: u16,
}

pub struct SnakesClient {
    models: IndexMap<String, SnakeConfig>,
    /// id of every snapshot key of the game — the predicted tail of the hot
    /// buffer starts with the key id of the snake block.
    key_ids: IndexMap<String, u8>,

    predictor: Predictor,

    model_name: Option<String>,
    meta: Option<LocalMeta>,
}

impl GameClientDef for SnakesClient {
    type Config = SnakesClientConfig;

    fn new(cfg: &Self::Config, engine_cfg: &EngineClientConfig) -> Self {
        let key_ids = engine_cfg
            .snapshot
            .keys
            .iter()
            .map(|(key, schema)| (key.clone(), schema.id))
            .collect();

        Self {
            models: cfg.models.clone(),
            key_ids,
            predictor: Predictor::new(engine_cfg.time_step_ms, &cfg.player_keys, &cfg.models),
            model_name: None,
            meta: None,
        }
    }

    fn on_server_state(
        &mut self,
        state: [f32; PLAYER_STATE_LEN],
        _centering: bool,
        server_time: f64,
        offset: f64,
        local_now: f64,
    ) {
        self.predictor
            .on_server_state(state, server_time, offset, local_now);
    }

    fn update(&mut self, local_now: f64) {
        self.predictor.update(local_now);
    }

    fn track_frame(&mut self, my_game_id: Option<u32>, frame: &FrameData) {
        if frame.camera.as_ref().is_some_and(|camera| camera.force_reset) {
            self.predictor.reset();
        }

        let (Some(my_id), Some(key)) = (my_game_id, self.model_name.clone()) else {
            return;
        };

        let Some(BlockData::Indexed8(items)) = frame.snapshot.block_by_key(&key) else {
            return;
        };

        match items.get(&(my_id as u8)) {
            // a null row means the snake left the canvas — it crashed, and the
            // result overlay is up until the player asks for a new one
            Some(None) => {
                self.meta = None;
                self.predictor.freeze(true);
            }
            Some(Some(row)) => {
                self.meta = Some(LocalMeta {
                    color: field_u8(row, ROW_COLOR),
                    crystals: field_u16(row, ROW_CRYSTALS),
                });
                self.predictor.freeze(false);
            }
            None => {}
        }
    }

    /// Nothing is drawn locally ahead of the authoritative frame, so there is
    /// no twin to drop.
    fn filter_frame_game(
        &mut self,
        _game: &mut Map<String, Value>,
        _my_game_id: Option<u32>,
        _local_now: f64,
    ) {
    }

    fn update_world(&mut self, _snapshot: &DecodedSnapshot) {}

    fn update_world_interpolated(&mut self, _game: &InterpolatedGame) {}

    /// The predicted tail of the hot buffer: key id, game id and then the
    /// fields of the snake row in schema order — the client part reads it
    /// exactly like an interpolated row, so the local snake and every remote
    /// one go through the same drawing code.
    fn render_overlay(&self, my_game_id: Option<u32>) -> Option<RenderOverlay> {
        let my_game_id = my_game_id?;
        let key_id = *self.key_ids.get(self.model_name.as_ref()?)?;
        let meta = self.meta?;
        let state = self.predictor.render_state()?;

        let mut tail: Vec<f32> = Vec::with_capacity(2 + ROW_LEN);

        tail.push(key_id as f32);
        tail.push(my_game_id as f32);
        tail.extend_from_slice(&state.spine);
        tail.push(state.angle);
        tail.push(state.radius);
        tail.push(meta.crystals as f32);
        tail.push(meta.color as f32);
        tail.push(state.boosting as u8 as f32);

        Some(RenderOverlay {
            camera: [state.x, state.y],
            tail,
        })
    }

    fn predicted_state(&self) -> Option<[f32; PLAYER_STATE_LEN]> {
        self.predictor
            .has_state()
            .then(|| self.predictor.state().to_array())
    }

    fn replayed_inputs(&self) -> Option<(f64, f64, usize)> {
        self.predictor.replayed_inputs()
    }

    fn apply_input(&mut self, action: &str, key_name: &str, local_now: f64) {
        self.predictor.apply_input(action, key_name, local_now);
    }

    fn apply_aim(&mut self, x: f32, y: f32, flags: u32, local_now: f64) {
        self.predictor.apply_aim(x, y, flags, local_now);
    }

    fn set_model(&mut self, model_name: &str) {
        self.predictor.set_model(model_name);

        if self.models.contains_key(model_name) {
            self.model_name = Some(model_name.to_string());
        }
    }

    fn set_active(&mut self, active: bool) {
        self.predictor.set_active(active);
    }

    /// The map carries no geometry this half needs — the arena is a disc the
    /// renderer draws and the host enforces — so this is a reset and nothing
    /// else.
    fn set_map(&mut self, _map_json: &str) -> Result<(), String> {
        self.predictor.reset();
        self.meta = None;

        Ok(())
    }

    /// Crystals and length reach the panel straight from the host; the
    /// predictor reads its crystal count out of the player block instead.
    fn sync_panel(&mut self, _items: &[String]) {}

    fn reset(&mut self) {
        self.predictor.reset();
        self.meta = None;
    }

    /// There is no arsenal to cycle.
    fn cycle_item(&mut self, _back: bool) {}

    /// No local effects — see the note at the top of the file.
    fn try_action(&mut self, _my_game_id: Option<u32>, _local_now: f64) -> Option<String> {
        None
    }
}

/// The client core of the game: engine orchestration + the prediction above.
pub type ClientState = vimp_engine_core::client::game::ClientState<SnakesClient>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_row_indices_match_the_schema_width() {
        assert_eq!(ROW_CRYSTALS, 34);
        assert_eq!(ROW_COLOR, 35);
        assert_eq!(ROW_LEN, 37);
    }
}
