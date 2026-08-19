//! The authoritative simulation on top of the engine frame (`EngineSim`):
//! snakes, crystals, bots and the snapshot blocks. The engine owns the physics
//! world, the map, navigation, the RNG and the destroy queue and calls into
//! this file through `SimCtx` — see `docs/ai/05-wasm-core.md`.
//!
//! ***** THE ONE STRUCTURAL DECISION IN THIS FILE *****
//!
//! `CoreEvent::Death` is never emitted. Death and respawn are handled here,
//! start to finish, because the engine cannot do what this game needs:
//!
//!   * a round ends only through `reportKill` with a killer, so not reporting
//!     kills is what makes the round endless;
//!   * there is no per-player respawn inside a round — the only spawn
//!     primitive is private to `RoundManager._startRound()`.
//!
//! What the host plugin gets instead is `CoreEvent::Custom`, which the engine
//! routes to `HostPlugin.onCoreEvent` without interpreting it. See the same
//! note at the top of `src/config/game.js`.

use indexmap::IndexMap;
use rapier2d::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::json;

use vimp_engine_core::config::{EngineConfig, FieldValue, PLAYER_STATE_LEN};
use vimp_engine_core::events::CoreEvent;
use vimp_engine_core::nav::spatial::{SpatialEntity, SpatialGrid};
use vimp_engine_core::physics::round2;
use vimp_engine_core::rng::Rng;
use vimp_engine_core::sim::{GameDef, GameSim, SimCtx};
use vimp_engine_core::snapshot::Block;

use crate::arena::Arena;
use crate::config::{
    KeyConfig, SnakeConfig, SnakesConfig, WorldConfig, PANEL_CRYSTALS, PANEL_DEAD,
};
use crate::crystals::{roll_tier, CrystalField};
use crate::motion::SPINE_LEN;
use crate::snake::{KeyBits, Snake};

/// Strings the core pushes into the panel's `activeKey` cell. There is no
/// weapon in this game, so the cell shows the drive mode instead.
const MODE_CRUISE: &str = "CRUISE";
const MODE_BOOST: &str = "BOOST";

/// Positions a dead snake spreads its crystals over.
const DEATH_DROP_SPOTS: usize = 24;

/// Tries a core-side respawn makes at finding a spot clear of other snakes
/// before falling back to a map respawn point.
const RESPAWN_ATTEMPTS: usize = 24;

/// Clearance a respawn keeps from every existing body, in world units.
const RESPAWN_CLEARANCE: f32 = 140.0;

/// How far ahead a bot looks when deciding whether it is about to die.
const BOT_LOOKAHEAD: f32 = 220.0;

/// Marker type binding the config and the simulation together.
pub struct SnakesGame;

impl GameDef for SnakesGame {
    type Config = SnakesConfig;
    type Sim = SnakesSim;
}

/// The engine frame parametrised by this game — the type the ABI macro and
/// the tests work with.
pub type GameState = vimp_engine_core::game::EngineSim<SnakesGame>;

/// Row of the snake block (`Indexed8`). The order is positional — it must
/// match the `fields` of the `s1` key in `src/config/snapshot.js`:
/// 16 spine points, then angle, radius, crystals, colour, boost.
#[derive(Clone, Copy)]
struct SnakeRow {
    spine: [f32; SPINE_LEN],
    angle: f32,
    radius: f32,
    crystals: u16,
    color: u8,
    boost: u8,
}

impl SnakeRow {
    fn fields(&self) -> Vec<FieldValue> {
        let mut fields: Vec<FieldValue> = Vec::with_capacity(SPINE_LEN + 5);

        // every f32 goes out through round2: the packer writes what it is
        // given and the decoder rounds, so an unrounded value reaches the
        // client as a different number than the one the host kept
        for value in self.spine {
            fields.push(FieldValue::F32(round2(value)));
        }

        fields.push(FieldValue::F32(round2(self.angle)));
        fields.push(FieldValue::F32(round2(self.radius)));
        fields.push(FieldValue::U16(self.crystals));
        fields.push(FieldValue::U8(self.color));
        fields.push(FieldValue::U8(self.boost));

        fields
    }
}

/// Scripted snake. It steers for the nearest crystal and swerves when the
/// thing in front of it would kill it — enough to make an empty arena worth
/// looking at and to give a headless scenario something to crash into.
#[derive(Serialize, Deserialize)]
struct Bot {
    /// Seconds until the next wander re-roll.
    timer: f32,
    /// Random bias added to the desired heading, so bots do not converge on
    /// the same crystal in a straight line.
    wander: f32,
}

pub struct SnakesSim {
    key_bits: KeyBits,
    player_keys: IndexMap<String, KeyConfig>,
    models: IndexMap<String, SnakeConfig>,
    world: WorldConfig,

    arena: Arena,
    /// Number of snakes the host was last told about. The arena is a function
    /// of the crowd (`src/host/ArenaScaler.js`) and the host has no join/leave
    /// hook of its own, so the core is what reports the population — once per
    /// change, off the fixed step, which catches every path into and out of
    /// `snakes` including a handoff restore. `usize::MAX` means "nothing
    /// reported yet" and forces the next step to report.
    population: usize,
    field: CrystalField,
    snakes: IndexMap<u32, Snake>,
    bots: IndexMap<u32, Bot>,

    /// Colours are handed out in order rather than rolled. Random collides,
    /// and two identically coloured snakes on one screen is the exact thing
    /// the colour is there to prevent. The client takes it modulo the palette
    /// length, so the core never needs to know how long that is.
    next_color: u8,

    // snapshot accumulators, drained by build_snapshot_blocks
    pending_null: Vec<(String, u32)>,
    cached: IndexMap<u32, (String, SnakeRow)>,
}

impl SnakesSim {
    fn model_of(&self, snake: &Snake) -> Option<&SnakeConfig> {
        self.models.get(&snake.model)
    }

    /// The wire row of one snake, in the exact order `src/config/snapshot.js`
    /// declares. Built in one place because it is packed from two: the binary
    /// block every tick, and `players_json` — which is what a JOINING client
    /// receives as its first full frame, so a row shaped differently there is
    /// a newcomer rendering garbage until the next tick.
    fn row_of(&self, snake: &Snake) -> Option<SnakeRow> {
        let model = self.model_of(snake)?;

        Some(SnakeRow {
            spine: snake.path.resample(),
            angle: snake.angle,
            radius: snake.radius(model),
            crystals: snake.crystals.min(u16::MAX as u32) as u16,
            color: snake.color,
            boost: snake.boosting as u8,
        })
    }

    /// The panel value that follows the crystal count: how much the snake is
    /// carrying RIGHT NOW. Pushed on every change rather than every tick —
    /// the panel port is JSON on the reliable channel, and a HUD that repaints
    /// 30 times a second for nothing is the cheapest bandwidth there is to not
    /// spend.
    ///
    /// Body length used to be pushed here too and is not any more: the size of
    /// the snake on screen already says it, and the panel cell went to the
    /// three accumulating counters the host keeps (src/host/StatBridge.js).
    fn push_vitals(events: &mut Vec<CoreEvent>, id: u32, snake: &Snake, _model: &SnakeConfig) {
        events.push(CoreEvent::PanelSet {
            id,
            field: PANEL_CRYSTALS.to_string(),
            value: snake.crystals as f64,
        });
    }

    /// A spot far enough from every existing body to be worth spawning on.
    /// Falls back to a map respawn point, and then to the arena centre — a
    /// crowded arena must still hand out a position rather than refuse one.
    fn find_spawn(&self, rng: &mut Rng, map_points: &[[f32; 3]]) -> [f32; 3] {
        for _ in 0..RESPAWN_ATTEMPTS {
            let point = self.arena.random_point(rng, self.world.edge_margin);

            let clear = self.snakes.values().all(|other| {
                !other.alive || !other.path.touches(point, RESPAWN_CLEARANCE, 0)
            });

            if clear {
                // face the centre: a fresh snake must never start by driving
                // straight at the edge it cannot cross
                let dx = self.arena.centre[0] - point[0];
                let dy = self.arena.centre[1] - point[1];
                let angle = dy.atan2(dx).to_degrees();

                return [point[0], point[1], angle];
            }
        }

        map_points
            .first()
            .copied()
            .unwrap_or([self.arena.centre[0], self.arena.centre[1], 0.0])
    }

    /// Kills a snake: the crystals it carried go back onto the map along the
    /// body it was dragging, the panel learns it is dead, and the host plugin
    /// gets a `custom` event to update the stat table with.
    ///
    /// Deliberately NOT `CoreEvent::Death` — see the note at the top.
    fn kill(
        snakes: &mut IndexMap<u32, Snake>,
        field: &mut CrystalField,
        world: &WorldConfig,
        rng: &mut Rng,
        events: &mut Vec<CoreEvent>,
        id: u32,
        killer: Option<u32>,
    ) {
        let Some(snake) = snakes.get_mut(&id) else {
            return;
        };

        if !snake.alive {
            return;
        }

        let carried = snake.crystals;

        snake.alive = false;
        snake.boosting = false;
        snake.crashes += 1;
        snake.crystals = 0;

        let mut budget = (carried as f32 * world.drop_ratio).round() as u32;
        let spots = snake.path.sample_along(DEATH_DROP_SPOTS);

        for spot in spots {
            if budget == 0 {
                break;
            }

            // the biggest tier the remaining budget can pay for, so a big
            // snake leaves a pile worth crossing the arena for
            let tier = world
                .tiers
                .iter()
                .enumerate()
                .rev()
                .find(|(_, tier)| tier.value <= budget)
                .map(|(index, _)| index)
                .unwrap_or(0);

            if !field.drop_at(spot, tier as u8, rng, world) {
                break;
            }

            budget = budget.saturating_sub(world.tiers[tier].value.max(1));
        }

        // 0 means alive, so a death with zero crystals still has to be a
        // non-zero value — the panel floors at 0 and the client cannot tell
        // "absent" from "zero" otherwise
        events.push(CoreEvent::PanelSet {
            id,
            field: PANEL_DEAD.to_string(),
            value: carried as f64 + 1.0,
        });
        events.push(CoreEvent::PanelSet {
            id,
            field: PANEL_CRYSTALS.to_string(),
            value: 0.0,
        });

        events.push(CoreEvent::Custom {
            data: json!({
                "type": "death",
                "id": id,
                "crystals": carried,
                "crashes": snake.crashes,
                "killer": killer,
            }),
        });
    }

    /// Puts a dead snake back on the map. The engine is not involved: it never
    /// learned the snake had died.
    fn revive(&mut self, id: u32, rng: &mut Rng, map_points: &[[f32; 3]], events: &mut Vec<CoreEvent>) {
        let spot = self.find_spawn(rng, map_points);
        let start = self.world.start_crystals;

        let Some(snake) = self.snakes.get_mut(&id) else {
            return;
        };

        snake.respawn(spot[0], spot[1], spot[2], start);

        let Some(model) = self.models.get(&snake.model) else {
            return;
        };

        Self::push_vitals(events, id, snake, model);

        events.push(CoreEvent::PanelSet {
            id,
            field: PANEL_DEAD.to_string(),
            value: 0.0,
        });
        events.push(CoreEvent::PanelActive {
            id,
            field: MODE_CRUISE.to_string(),
        });
        events.push(CoreEvent::Custom {
            data: json!({ "type": "respawn", "id": id }),
        });

        // the newcomer's canvas has none of the crystal deltas so far
        self.field.request_resync();
    }

    /// Steers one bot for one AI tick.
    fn drive_bot(&mut self, id: u32, dt: f32, rng: &mut Rng) {
        let Some(bot) = self.bots.get_mut(&id) else {
            return;
        };

        bot.timer -= dt;

        if bot.timer <= 0.0 {
            bot.timer = rng.range(0.6, 2.0);
            bot.wander = rng.range(-0.9, 0.9);
        }

        let wander = bot.wander;
        let respawn_bit = self.key_bits.respawn;

        let Some(snake) = self.snakes.get(&id) else {
            return;
        };

        if !snake.alive {
            if let Some(snake) = self.snakes.get_mut(&id) {
                snake.press_once(respawn_bit);
            }

            return;
        }

        let head = snake.head();
        let angle = snake.angle;
        let Some(model) = self.model_of(snake) else {
            return;
        };
        let radius = snake.radius(model);

        // desired heading: the nearest crystal, nudged by the wander bias
        let mut want = angle + wander;
        let mut best = f32::MAX;

        for (_, crystal) in self.field.iter() {
            let dx = crystal.x - head[0];
            let dy = crystal.y - head[1];
            let d = dx * dx + dy * dy;

            if d < best {
                best = d;
                want = dy.atan2(dx) + wander * 0.25;
            }
        }

        // …unless something ahead would kill us, in which case turning away
        // outranks any crystal
        let probe = [
            head[0] + angle.cos() * BOT_LOOKAHEAD,
            head[1] + angle.sin() * BOT_LOOKAHEAD,
        ];

        let blocked = !self.arena.contains(probe, radius)
            || self.snakes.iter().any(|(other_id, other)| {
                *other_id != id && other.alive && other.path.touches(probe, radius * 2.0, 0)
            });

        if blocked {
            // steer back towards the centre — always a legal direction
            let dx = self.arena.centre[0] - head[0];
            let dy = self.arena.centre[1] - head[1];

            want = dy.atan2(dx);
        }

        let diff = vimp_engine_core::physics::normalize_angle(want - angle);
        let bits = self.key_bits;

        if let Some(snake) = self.snakes.get_mut(&id) {
            // a dead band around zero: without it a bot jitters left/right
            // every tick and never drives straight
            let keys = if diff > 0.05 {
                bits.right
            } else if diff < -0.05 {
                bits.left
            } else {
                0
            };

            snake.set_held_keys(keys);
        }
    }
}

impl GameSim<SnakesGame> for SnakesSim {
    fn new(cfg: &SnakesConfig, _engine_cfg: &EngineConfig) -> Self {
        // validate() has already proved models is non-empty
        let world = cfg
            .models
            .values()
            .next()
            .map(|model| model.world.clone())
            .expect("models is empty");

        Self {
            key_bits: KeyBits::from_config(&cfg.player_keys),
            player_keys: cfg.player_keys.clone(),
            models: cfg.models.clone(),
            world,
            arena: Arena::default(),
            population: usize::MAX,
            field: CrystalField::default(),
            snakes: IndexMap::new(),
            bots: IndexMap::new(),
            next_color: 0,
            pending_null: Vec::new(),
            cached: IndexMap::new(),
        }
    }

    fn spawn_actor(
        &mut self,
        _world: &mut PhysicsWorld,
        events: &mut Vec<CoreEvent>,
        game_id: u32,
        model_name: &str,
        team_id: u8,
        x: f32,
        y: f32,
        angle_deg: f32,
    ) -> Result<(), String> {
        let model = self
            .models
            .get(model_name)
            .ok_or_else(|| format!("unknown model '{model_name}'"))?
            .clone();

        let color = self.next_color;

        self.next_color = self.next_color.wrapping_add(1);

        let [x, y] = self.arena.clamp_inside([x, y], self.world.edge_margin);

        let mut snake = Snake::new(model_name, team_id, color, x, y, angle_deg);

        snake.crystals = self.world.start_crystals;

        Self::push_vitals(events, game_id, &snake, &model);

        events.push(CoreEvent::PanelSet {
            id: game_id,
            field: PANEL_DEAD.to_string(),
            value: 0.0,
        });
        events.push(CoreEvent::PanelActive {
            id: game_id,
            field: MODE_CRUISE.to_string(),
        });

        self.snakes.insert(game_id, snake);

        // this client has seen none of the crystal deltas so far
        self.field.request_resync();

        Ok(())
    }

    fn remove_actor(&mut self, _world: &mut PhysicsWorld, game_id: u32) {
        if let Some(snake) = self.snakes.shift_remove(&game_id) {
            self.cached.shift_remove(&game_id);
            self.pending_null.push((snake.model, game_id));
        }
    }

    fn reset_actor(
        &mut self,
        _world: &mut PhysicsWorld,
        game_id: u32,
        team_id: u8,
        x: f32,
        y: f32,
        angle_deg: f32,
    ) {
        let start = self.world.start_crystals;
        let [x, y] = self.arena.clamp_inside([x, y], self.world.edge_margin);

        if let Some(snake) = self.snakes.get_mut(&game_id) {
            snake.team_id = team_id;
            snake.respawn(x, y, angle_deg, start);
        }

        self.field.request_resync();
    }

    fn reset_all_vitals(&mut self, events: &mut Vec<CoreEvent>) {
        for (id, snake) in &self.snakes {
            let Some(model) = self.models.get(&snake.model) else {
                continue;
            };

            Self::push_vitals(events, *id, snake, model);

            events.push(CoreEvent::PanelSet {
                id: *id,
                field: PANEL_DEAD.to_string(),
                value: if snake.alive { 0.0 } else { 1.0 },
            });
        }
    }

    fn spawn_scripted_actor(
        &mut self,
        world: &mut PhysicsWorld,
        rng: &mut Rng,
        events: &mut Vec<CoreEvent>,
        game_id: u32,
        model_name: &str,
        team_id: u8,
        x: f32,
        y: f32,
        angle_deg: f32,
    ) -> Result<(), String> {
        self.spawn_actor(world, events, game_id, model_name, team_id, x, y, angle_deg)?;

        self.bots.entry(game_id).or_insert(Bot {
            timer: rng.range(0.2, 1.0),
            wander: rng.range(-0.9, 0.9),
        });

        Ok(())
    }

    fn remove_scripted_actor(&mut self, world: &mut PhysicsWorld, game_id: u32) {
        self.bots.shift_remove(&game_id);
        self.remove_actor(world, game_id);
    }

    fn apply_input(&mut self, game_id: u32, seq: u32, action: &str, key_name: &str) {
        let bit = self.player_keys.get(key_name).map(|k| k.key).unwrap_or(0);
        let bits = self.key_bits;

        if let Some(snake) = self.snakes.get_mut(&game_id) {
            snake.last_input_seq = seq;
            snake.apply_key(action, bit, &bits);
        }
    }

    fn apply_aim(&mut self, game_id: u32, seq: u32, x: f32, y: f32, flags: u32) {
        if let Some(snake) = self.snakes.get_mut(&game_id) {
            snake.last_input_seq = seq;
            snake.apply_aim(x, y, flags);
        }
    }

    fn last_input_seq(&self, game_id: u32) -> u32 {
        self.snakes
            .get(&game_id)
            .map(|snake| snake.last_input_seq)
            .unwrap_or(0)
    }

    fn is_alive(&self, game_id: u32) -> bool {
        self.snakes.get(&game_id).is_some_and(|snake| snake.alive)
    }

    fn actor_position(&self, _world: &PhysicsWorld, game_id: u32) -> Option<[f32; 2]> {
        let head = self.snakes.get(&game_id)?.head();

        Some([round2(head[0]), round2(head[1])])
    }

    fn prediction_state(
        &self,
        _world: &PhysicsWorld,
        game_id: u32,
    ) -> Option<([f32; PLAYER_STATE_LEN], bool)> {
        let snake = self.snakes.get(&game_id)?;
        let model = self.model_of(snake)?;

        Some(snake.prediction_state(model))
    }

    fn alive_players_flat(&self, _world: &PhysicsWorld) -> Vec<f32> {
        let mut out = Vec::new();

        for (id, snake) in &self.snakes {
            if !snake.alive {
                continue;
            }

            let head = snake.head();

            out.push(*id as f32);
            out.push(snake.team_id as f32);
            out.push(round2(head[0]));
            out.push(round2(head[1]));
        }

        out
    }

    /// Every snake, alive or not, as `{ model: { id: [row] } }`.
    ///
    /// Two contracts meet here, and both are easy to miss:
    ///
    ///   * a dead snake is still a participant — the engine was never told it
    ///     died — so leaving the dead out makes invariant 11 (`actorLeak`)
    ///     report a mismatch on the first crash of the match;
    ///   * the row must be in SCHEMA order, because this is what the host
    ///     sends a joining client as its first full frame (FIRST_SHOT_DATA).
    ///     A convenient debug shape here decodes as garbage there, and
    ///     invariant 3 (`fieldWidths`) is what says so.
    fn players_json(&self) -> String {
        use serde_json::{Map, Value};

        let mut by_model: Map<String, Value> = Map::new();

        for (game_id, snake) in &self.snakes {
            let Some(row) = self.row_of(snake) else {
                continue;
            };

            let mut arr: Vec<Value> = Vec::with_capacity(SPINE_LEN + 5);

            for value in row.spine {
                arr.push(Value::from(round2(value) as f64));
            }

            arr.push(Value::from(round2(row.angle) as f64));
            arr.push(Value::from(round2(row.radius) as f64));
            arr.push(Value::from(row.crystals));
            arr.push(Value::from(row.color));
            arr.push(Value::from(row.boost));

            by_model
                .entry(snake.model.clone())
                .or_insert_with(|| Value::Object(Map::new()))
                .as_object_mut()
                .unwrap()
                .insert(game_id.to_string(), Value::Array(arr));
        }

        Value::Object(by_model).to_string()
    }

    fn on_fixed_step(&mut self, ctx: &mut SimCtx, dt: f32) {
        let Some(map) = ctx.map.as_ref() else {
            return;
        };

        self.arena = Arena::from_map(map);

        if self.arena.radius <= 0.0 {
            return;
        }

        // the crowd changed: the host resizes the arena off this and nothing
        // else (`src/host/ArenaScaler.js`)
        if self.population != self.snakes.len() {
            self.population = self.snakes.len();

            ctx.events.push(CoreEvent::Custom {
                data: json!({ "type": "population", "count": self.population }),
            });
        }

        let map_points: Vec<[f32; 3]> = map
            .respawns
            .values()
            .next()
            .cloned()
            .unwrap_or_default();

        let world = self.world.clone();

        self.field.tick(dt, &self.arena, ctx.rng, &world);

        // ***** 1. respawn requests and movement *****
        //
        // The map is taken out of `self` for the pass so that the snakes can
        // be mutated while `self.models` and `self.field` are read; it goes
        // back at the end of the function.
        let mut snakes = std::mem::take(&mut self.snakes);
        let bits = self.key_bits;
        let mut revive: Vec<u32> = Vec::new();

        for (id, snake) in snakes.iter_mut() {
            if !snake.alive {
                if snake.take_pending(bits.respawn) {
                    revive.push(*id);
                }

                continue;
            }

            let Some(model) = self.models.get(&snake.model) else {
                continue;
            };

            let outcome = snake.step(dt, model, &bits);

            for spot in outcome.burned {
                let tier = roll_tier(ctx.rng, &world);

                self.field.drop_at(spot, tier, ctx.rng, &world);
            }

            if outcome.mode_changed {
                ctx.events.push(CoreEvent::PanelActive {
                    id: *id,
                    field: if snake.boosting { MODE_BOOST } else { MODE_CRUISE }.to_string(),
                });
            }
        }

        // ***** 2. what kills whom *****
        //
        // Collected first and applied after, so that two snakes running into
        // each other on the same step both die — resolving as we go would let
        // whichever is iterated first take the other out and survive.
        let mut kills: Vec<(u32, Option<u32>)> = Vec::new();

        for (id, snake) in snakes.iter() {
            if !snake.alive {
                continue;
            }

            let Some(model) = self.models.get(&snake.model) else {
                continue;
            };

            let head = snake.head();
            let radius = snake.radius(model);

            // the edge of the disc: the boundary catches the snake, not its
            // centreline, so the body radius is the margin
            if !self.arena.contains(head, radius) {
                kills.push((*id, None));

                continue;
            }

            for (other_id, other) in snakes.iter() {
                // a snake's own body is explicitly harmless: the head passes
                // over its own tail, which is the rule the game was asked for
                if other_id == id || !other.alive {
                    continue;
                }

                let Some(other_model) = self.models.get(&other.model) else {
                    continue;
                };

                let reach = radius + other.radius(other_model);
                let bounds = other.path.bounds();

                // broad phase: with eight snakes of ~200 nodes each, the AABB
                // is what keeps this from being 12 000 distance tests a step
                if head[0] < bounds[0] - reach
                    || head[0] > bounds[2] + reach
                    || head[1] < bounds[1] - reach
                    || head[1] > bounds[3] + reach
                {
                    continue;
                }

                if other.path.touches(head, reach, 0) {
                    kills.push((*id, Some(*other_id)));

                    break;
                }
            }
        }

        // ***** 3. pickups, for whoever survived *****
        for (id, snake) in snakes.iter_mut() {
            if !snake.alive || kills.iter().any(|(dead, _)| dead == id) {
                continue;
            }

            let Some(model) = self.models.get(&snake.model) else {
                continue;
            };

            let head = snake.head();
            let radius = snake.radius(model);

            if let Some(value) = self.field.take_at(head, radius, &world) {
                snake.crystals = snake.crystals.saturating_add(value);

                Self::push_vitals(ctx.events, *id, snake, model);

                // `gained` is what the host counts with: `total` is the
                // CARRIED amount, and that one is reset by a respawn and burnt
                // by the boost without an event of any kind — a host diffing
                // totals would miscount both.
                ctx.events.push(CoreEvent::Custom {
                    data: json!({
                        "type": "crystals",
                        "id": *id,
                        "total": snake.crystals,
                        "gained": value,
                    }),
                });
            }
        }

        // ***** 4. apply *****
        for (id, killer) in kills {
            Self::kill(
                &mut snakes,
                &mut self.field,
                &world,
                ctx.rng,
                ctx.events,
                id,
                killer,
            );
        }

        self.snakes = snakes;

        for id in revive {
            self.revive(id, ctx.rng, &map_points, ctx.events);
        }
    }

    /// Nothing of this game has a Rapier body, so no contact can involve it.
    fn on_contacts(&mut self, _ctx: &mut SimCtx, _pairs: &[(ColliderHandle, ColliderHandle)]) {}

    /// Same: no game body is ever queued for destruction.
    fn on_before_destroy(&mut self, _world: &PhysicsWorld, _handle: RigidBodyHandle) {}

    fn on_ai_tick(&mut self, ctx: &mut SimCtx, dt: f32) {
        if !self.bots.is_empty() {
            let ids: Vec<u32> = self.bots.keys().copied().collect();

            for id in ids {
                self.drive_bot(id, dt, ctx.rng);
            }
        }

        self.rebuild_spatial_grid(ctx.world, ctx.spatial);
    }

    fn refresh_cached(&mut self, _world: &PhysicsWorld) {
        // Collected first and applied after: `row_of` reads `self.models`
        // while the loop is walking `self.snakes`, and the writes land in
        // `self.cached` — three fields of one struct, which the borrow checker
        // will not let overlap through a method call.
        let mut updates: Vec<(u32, String, SnakeRow)> = Vec::new();
        let mut gone: Vec<(u32, String)> = Vec::new();

        for (game_id, snake) in &self.snakes {
            if !snake.alive {
                gone.push((*game_id, snake.model.clone()));

                continue;
            }

            if let Some(row) = self.row_of(snake) {
                updates.push((*game_id, snake.model.clone(), row));
            }
        }

        for (game_id, model) in gone {
            // a dead snake leaves the canvas: the null row removes it on every
            // client until it respawns
            if self.cached.shift_remove(&game_id).is_some() {
                self.pending_null.push((model, game_id));
            }
        }

        for (game_id, model, row) in updates {
            self.cached.insert(game_id, (model, row));
        }
    }

    fn build_snapshot_blocks(&mut self) -> (Vec<(String, Block)>, bool) {
        let mut blocks: Vec<(String, Block)> = Vec::new();
        // a removal row is an event: the frame carrying it must go over the
        // reliable channel, or a client can miss the removal forever
        let mut had_events = !self.pending_null.is_empty();

        // Indexed8 addresses rows by a single byte, so `as u8` truncates
        // silently. The invariant that makes it safe: the engine's
        // ParticipantManager hands out the lowest free game id, so ids stay
        // below the participant count — assert it instead of trusting it.
        let mut by_model: IndexMap<String, Vec<(u8, Option<SnakeRow>)>> = IndexMap::new();

        for (game_id, (model, row)) in &self.cached {
            debug_assert!(*game_id < 256, "Indexed8 block: game_id must fit in u8");
            by_model
                .entry(model.clone())
                .or_default()
                .push((*game_id as u8, Some(*row)));
        }

        for (model, game_id) in self.pending_null.drain(..) {
            debug_assert!(game_id < 256, "Indexed8 block: game_id must fit in u8");
            by_model
                .entry(model)
                .or_default()
                .push((game_id as u8, None));
        }

        for (model, rows) in by_model {
            let rows = rows
                .into_iter()
                .map(|(id, row)| (id, row.map(|r| r.fields())))
                .collect();

            blocks.push((model, Block::Indexed8(rows)));
        }

        // the crystal delta: spawns as rows, pickups as null rows, and the
        // whole field whenever a client has just joined
        if let Some(rows) = self.field.drain_block() {
            had_events = true;

            blocks.push(("cr".to_string(), Block::Indexed32(rows)));
        }

        (blocks, had_events)
    }

    fn remove_players_and_shots(&mut self, _world: &mut PhysicsWorld) -> Vec<String> {
        self.snakes.clear();
        self.cached.clear();
        self.pending_null.clear();
        self.field.clear();

        // every configured key, not only the ones in use: right after a map
        // change nobody is alive, and a partial CLEAR would leave stale
        // sprites on the clients
        let mut names: Vec<String> = self.models.keys().cloned().collect();

        names.push("cr".to_string());
        names
    }

    fn clear(&mut self) {
        self.population = usize::MAX;
        self.snakes.clear();
        self.bots.clear();
        self.cached.clear();
        self.pending_null.clear();
        self.field.clear();
    }

    fn serialize(&self) -> serde_json::Value {
        serde_json::to_value(SnakesDump {
            snakes: &self.snakes,
            bots: &self.bots,
            field: &self.field,
            next_color: self.next_color,
        })
        .unwrap_or(serde_json::Value::Null)
    }

    fn deserialize(&mut self, value: serde_json::Value) -> Result<(), String> {
        let dump: SnakesDumpOwned = serde_json::from_value(value).map_err(|e| e.to_string())?;

        // a restored room has a crowd nobody has reported yet: the arena of
        // the new host is the one the map catalog holds, not the one the old
        // host had grown
        self.population = usize::MAX;
        self.snakes = dump.snakes;
        self.bots = dump.bots;
        self.field = dump.field;
        self.next_color = dump.next_color;

        self.cached.clear();
        self.pending_null.clear();

        // the delta accumulators do not survive a restore: everything the
        // clients know is gone with them, so send the field afresh
        self.field.request_resync();

        Ok(())
    }

    fn rebuild_spatial_grid(&self, _world: &PhysicsWorld, spatial: &mut SpatialGrid) {
        spatial.clear();

        for (game_id, snake) in &self.snakes {
            if !snake.alive {
                continue;
            }

            let head = snake.head();

            spatial.insert(SpatialEntity {
                game_id: *game_id,
                team_id: snake.team_id,
                x: round2(head[0]),
                y: round2(head[1]),
            });
        }
    }
}

#[derive(Serialize)]
struct SnakesDump<'a> {
    snakes: &'a IndexMap<u32, Snake>,
    bots: &'a IndexMap<u32, Bot>,
    field: &'a CrystalField,
    next_color: u8,
}

#[derive(Deserialize)]
struct SnakesDumpOwned {
    snakes: IndexMap<u32, Snake>,
    bots: IndexMap<u32, Bot>,
    field: CrystalField,
    next_color: u8,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::motion::SPINE_POINTS;

    /// The row width the schema promises: 32 spine floats + angle + radius +
    /// crystals + colour + boost.
    #[test]
    fn the_snake_row_is_as_wide_as_the_schema_says() {
        let row = SnakeRow {
            spine: [0.0; SPINE_LEN],
            angle: 0.0,
            radius: 0.0,
            crystals: 0,
            color: 0,
            boost: 0,
        };

        assert_eq!(row.fields().len(), SPINE_POINTS * 2 + 5);
        assert_eq!(row.fields().len(), 37);
    }
}
