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
    KeyConfig, PANEL_CRYSTALS, PANEL_DEAD, SnakeConfig, SnakesConfig, WorldConfig,
};
use crate::crystals::{CrystalField, roll_tier};
use crate::motion::SPINE_LEN;
use crate::snake::{KeyBits, Snake};

/// Strings the core pushes into the panel's `activeKey` cell. There is no
/// weapon in this game, so the cell shows the drive mode instead.
const MODE_CRUISE: &str = "CRUISE";
const MODE_BOOST: &str = "BOOST";

/// Positions a dead snake spreads its crystals over.
const DEATH_DROP_SPOTS: usize = 24;

/// Tries a core-side respawn makes at finding a spot clear of other snakes
/// before falling back to a map respawn point. A budget of random throws —
/// the deterministic walk of `find_spawn_from` is bounded by the number of
/// slots instead, and must not borrow this number: stopping a full-coverage
/// walk a third of the way in means returning an OCCUPIED point while a free
/// one is still on the list.
const RESPAWN_ATTEMPTS: usize = 24;

/// Clearance a respawn keeps from every existing body, in world units.
const RESPAWN_CLEARANCE: f32 = 140.0;

/// How far ahead a bot looks when deciding whether it is about to die.
const BOT_LOOKAHEAD: f32 = 220.0;

/// Reverses the low `bits` bits of `i`, turning a counter into the van der
/// Corput sequence: every prefix of the walk samples the whole range.
///
/// The candidates it reorders are the map's OWN respawn points
/// (`SnakesSim::spawn_slots`), not a spiral of the core's own making — the
/// geometry lives in `src/data/maps/arena.js` and is written into the map, so
/// duplicating the formula here could only mean the two drifting apart. The
/// order matters for the same reason it matters there: the plain index order
/// of a sunflower crawls outwards from the middle, while the bit-reversed one
/// covers the whole disc from the very first candidates.
fn reverse_bits(i: usize, bits: u32) -> usize {
    let mut out = 0;

    for bit in 0..bits {
        out = (out << 1) | ((i >> bit) & 1);
    }

    out
}

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
    /// The map's respawn points, as the engine last sent them. Kept because
    /// `spawn_actor` has to search for a free spot and the map is only
    /// handed in on the fixed step.
    ///
    /// Refreshed in the same place as `Arena` (`on_fixed_step`), so the
    /// candidates and the boundary always come from one and the same map: a
    /// hot map swap (`ArenaScaler`) leaves both stale until the next step,
    /// never one of them.
    spawn_slots: Vec<[f32; 3]>,
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
            boost: Self::boost_byte(snake),
        })
    }

    /// The `boost` byte of the wire row. Two flags, not one: bit 0 is the
    /// boost, bit 1 the spawn grace the client blinks on
    /// (`src/client/parts/Snake.js`). Packed into the existing byte on
    /// purpose — the width and the field order of `s1` are contract
    /// (`tests/config/contract.test.js`).
    fn boost_byte(snake: &Snake) -> u8 {
        snake.boosting as u8 | (snake.in_grace() as u8) << 1
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

    /// Is there room for a snake at `point` — no living body within
    /// `RESPAWN_CLEARANCE` of it?
    fn is_clear(&self, point: [f32; 2]) -> bool {
        self.is_clear_except(point, None)
    }

    /// The same, ignoring one snake. `reset_actor` respawns a snake that is
    /// still alive and still dragging its old body: counting that body would
    /// move the player away from a spot nobody else is anywhere near, and a
    /// long enough snake could block the search outright.
    fn is_clear_except(&self, point: [f32; 2], skip: Option<u32>) -> bool {
        self.snakes.iter().all(|(id, other)| {
            Some(*id) == skip || !other.alive || !other.path.touches(point, RESPAWN_CLEARANCE, 0)
        })
    }

    /// `point` with a heading straight at the arena centre: a fresh snake must
    /// never start by driving at the edge it cannot cross.
    fn facing_centre(&self, point: [f32; 2]) -> [f32; 3] {
        let dx = self.arena.centre[0] - point[0];
        let dy = self.arena.centre[1] - point[1];

        [point[0], point[1], dy.atan2(dx).to_degrees()]
    }

    /// A spot far enough from every existing body to be worth spawning on.
    /// Falls back to a map respawn point, and then to the arena centre — a
    /// crowded arena must still hand out a position rather than refuse one.
    fn find_spawn(&self, rng: &mut Rng, map_points: &[[f32; 3]]) -> [f32; 3] {
        for _ in 0..RESPAWN_ATTEMPTS {
            let point = self.arena.random_point(rng, self.world.edge_margin);

            if self.is_clear(point) {
                return self.facing_centre(point);
            }
        }

        map_points
            .first()
            .copied()
            .unwrap_or([self.arena.centre[0], self.arena.centre[1], 0.0])
    }

    /// The same search without an `Rng`, for the one path that has none: the
    /// engine's `spawn_actor`, whose signature it dictates.
    ///
    /// The engine hands out the map's respawn points by index and cannot know
    /// which of them are occupied — a series of joins and leaves, or two
    /// players entering on the same tick, lands two snakes on one point. So
    /// the requested spot is honoured when it is free and searched around when
    /// it is not.
    ///
    /// The candidates are the map's own respawn points, walked in bit-reversed
    /// order (`reverse_bits`) starting at `seed` (the game id), so two snakes
    /// spawning on the same tick do not try the same spots in the same order.
    /// EVERY slot is tried before giving up: this walk is deterministic and
    /// finite, and stopping early would return an occupied point while a free
    /// one was still on the list. That holds for a list of ANY length — the
    /// counter runs over the full range of the bit-reversal, not over the
    /// number of slots, see the comment at the loop.
    ///
    /// `skip` is the snake being respawned, if it already exists (see
    /// `is_clear_except`).
    fn find_spawn_from(&self, seed: u32, requested: [f32; 3], skip: Option<u32>) -> [f32; 3] {
        let slots = self.spawn_slots.len();

        // no disc yet — `Arena` is rebuilt from `ctx.map` on the fixed step and
        // there has not been one. There is nothing to search, so the engine's
        // point stands, exactly as it did before this search existed.
        if self.arena.radius <= 0.0 || self.is_clear_except([requested[0], requested[1]], skip) {
            return requested;
        }

        let seed = seed as usize;

        // a map with no respawn list at all: there is nothing to walk, and the
        // subtraction below would underflow. The fallback scan is exactly the
        // case for it
        if slots == 0 {
            return self.find_spawn_off_slots(seed, requested, skip);
        }

        let bits = usize::BITS - (slots - 1).leading_zeros();

        // the counter is walked over the FULL range of the permutation, not
        // over the number of slots: `reverse_bits` is a bijection on
        // `[0, 2^bits)` and nothing else. Walking `0..slots` instead sends
        // part of the images past `slots`, and the indices those images would
        // have covered are then unreachable for EVERY seed — five points, and
        // number 3 is never tried. The overshooting images are skipped here,
        // so every index below `slots` still comes up exactly once, at the
        // price of at most `2 * slots` iterations outside the hot loop.
        let span = 1usize << bits;
        let mut tried = 0;

        for attempt in 0..span {
            let k = reverse_bits((seed + attempt) % span, bits);

            // the image is past the end of the list: not a candidate
            let Some(slot) = self.spawn_slots.get(k) else {
                continue;
            };

            tried += 1;

            let point = [slot[0], slot[1]];

            if self.is_clear_except(point, skip) {
                return self.facing_centre(point);
            }
        }

        debug_assert_eq!(tried, slots, "the walk must visit every slot exactly once");

        self.find_spawn_off_slots(seed, requested, skip)
    }

    /// Last resort of `find_spawn_from`: every respawn point of the map is
    /// taken (or the map declares fewer of them than the room seats), and the
    /// snake still needs somewhere to stand.
    ///
    /// Deliberately NOT the map's spiral and making no claim to be: this is a
    /// scan of the disc the core itself owns, and the only properties it has
    /// to have are «inside the arena», «deterministic» (scenarios run with
    /// `--determinism`) and «spread out». Anything that reads the map's
    /// geometry belongs in `src/data/maps/arena.js`, which is where the
    /// candidates above come from.
    fn find_spawn_off_slots(
        &self,
        seed: usize,
        requested: [f32; 3],
        skip: Option<u32>,
    ) -> [f32; 3] {
        const RINGS: usize = 64;
        const SPAN: f32 = 0.9;

        let golden = std::f32::consts::PI * (3.0 - 5.0f32.sqrt());
        let limit = (self.arena.radius - self.world.edge_margin).max(0.0) * SPAN;
        let mut best: Option<([f32; 2], f32)> = None;

        for attempt in 0..RINGS {
            let k = reverse_bits((seed + attempt) % RINGS, 6);
            let r = limit * ((k as f32 + 0.5) / RINGS as f32).sqrt();
            let theta = k as f32 * golden;
            let point = [
                self.arena.centre[0] + theta.cos() * r,
                self.arena.centre[1] + theta.sin() * r,
            ];

            if self.is_clear_except(point, skip) {
                return self.facing_centre(point);
            }

            // …and if nothing is clear, the roomiest candidate still beats the
            // requested point: standing inside someone is certain death the
            // moment the spawn grace runs out
            let room = self.room_at(point, skip);

            match best {
                Some((_, best_room)) if best_room >= room => {}
                _ => best = Some((point, room)),
            }
        }

        match best {
            Some((point, _)) => self.facing_centre(point),
            None => requested,
        }
    }

    /// Distance from `point` to the nearest living body, ignoring `skip`.
    fn room_at(&self, point: [f32; 2], skip: Option<u32>) -> f32 {
        self.snakes
            .iter()
            .filter(|(id, other)| Some(**id) != skip && other.alive)
            .map(|(_, other)| other.path.distance_to(point))
            .fold(f32::INFINITY, f32::min)
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
    fn revive(
        &mut self,
        id: u32,
        rng: &mut Rng,
        map_points: &[[f32; 3]],
        events: &mut Vec<CoreEvent>,
    ) {
        let spot = self.find_spawn(rng, map_points);
        let start = self.world.start_crystals;

        let Some(snake) = self.snakes.get_mut(&id) else {
            return;
        };

        let grace = self.world.spawn_grace_seconds;

        let Some(model) = self.models.get(&snake.model) else {
            return;
        };

        snake.respawn(spot[0], spot[1], spot[2], start, grace, model);

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
            spawn_slots: Vec::new(),
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

        // the engine's point is a suggestion, not a placement: it does not know
        // which of them are occupied
        let [x, y, angle_deg] = self.find_spawn_from(game_id, [x, y, angle_deg], None);

        let mut snake = Snake::new(
            model_name,
            team_id,
            color,
            x,
            y,
            angle_deg,
            self.world.spawn_grace_seconds,
        );

        snake.crystals = self.world.start_crystals;
        // after the crystals: the body is as long as they say it is
        snake.lay_out_body(&model);

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
        let grace = self.world.spawn_grace_seconds;
        let [x, y] = self.arena.clamp_inside([x, y], self.world.edge_margin);
        // the snake being reset is still alive and still dragging its old
        // body: its own body must not be what pushes it off a free point
        let [x, y, angle_deg] = self.find_spawn_from(game_id, [x, y, angle_deg], Some(game_id));

        if let Some(snake) = self.snakes.get_mut(&game_id) {
            if let Some(model) = self.models.get(&snake.model) {
                snake.team_id = team_id;
                snake.respawn(x, y, angle_deg, start, grace, model);
            }
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
        // a bot HAS an rng, so it gets the ordinary randomised search rather
        // than the deterministic walk `spawn_actor` falls back to
        let [x, y] = self.arena.clamp_inside([x, y], self.world.edge_margin);
        let spot = if self.is_clear([x, y]) {
            [x, y, angle_deg]
        } else {
            self.find_spawn(rng, &[[x, y, angle_deg]])
        };

        self.spawn_actor(
            world, events, game_id, model_name, team_id, spot[0], spot[1], spot[2],
        )?;

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

        let map_points: Vec<[f32; 3]> = map.respawns.values().next().cloned().unwrap_or_default();

        // kept for `find_spawn_from`, which runs from `spawn_actor` — outside
        // the fixed step, where the map is not in hand. Compared before the
        // clone: the map changes rarely, the step runs 120 times a second
        if self.spawn_slots != map_points {
            self.spawn_slots = map_points.clone();
        }

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

            // the spawn grace: frozen in place, so the step is spent burning
            // the grace down instead of moving. Sections 2 and 3 skip it too —
            // it neither kills nor dies nor eats while it blinks
            if snake.in_grace() {
                snake.tick_grace(dt);

                continue;
            }

            let Some(model) = self.models.get(&snake.model) else {
                continue;
            };

            let outcome = snake.step(dt, model, &bits);

            // taken before the loop consumes the vector
            let burned = outcome.burned.len();

            for spot in outcome.burned {
                let tier = roll_tier(ctx.rng, &world);

                self.field.drop_at(spot, tier, ctx.rng, &world);
            }

            if burned > 0 {
                Self::push_vitals(ctx.events, *id, snake, model);

                ctx.events.push(CoreEvent::Custom {
                    data: json!({
                        "type": "burn",
                        "id": *id,
                        "burned": burned,
                        "total": snake.crystals,
                    }),
                });
            }

            if outcome.mode_changed {
                ctx.events.push(CoreEvent::PanelActive {
                    id: *id,
                    field: if snake.boosting {
                        MODE_BOOST
                    } else {
                        MODE_CRUISE
                    }
                    .to_string(),
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
            if !snake.alive || snake.in_grace() {
                continue;
            }

            let Some(model) = self.models.get(&snake.model) else {
                continue;
            };

            let head = snake.head();
            let radius = snake.radius(model);
            // which way this head is pointing — the fault test below
            let facing = [snake.angle.cos(), snake.angle.sin()];

            // the edge of the disc: the boundary catches the snake, not its
            // centreline, so the body radius is the margin
            if !self.arena.contains(head, radius) {
                kills.push((*id, None));

                continue;
            }

            for (other_id, other) in snakes.iter() {
                // a snake's own body is explicitly harmless: the head passes
                // over its own tail, which is the rule the game was asked for
                if other_id == id || !other.alive || other.in_grace() {
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

                // ***** WHOSE FAULT IT IS *****
                //
                // A snake dies for driving its head INTO somebody — and only
                // the one that drove dies. The other is not touched: it ran
                // into nothing.
                //
                // Which of the two drove is read off the geometry: the
                // contact has to lie AHEAD of the head that is being judged.
                // Two snakes meeting head on are both heading into each other
                // and both die, as they always did; but a head that arrives
                // from the side or from behind — somebody else's, swinging
                // into a snake driving straight — is that somebody's crash
                // alone. It used to take out both.
                if other.path.touches_ahead(head, reach, facing) {
                    kills.push((*id, Some(*other_id)));

                    break;
                }
            }
        }

        // ***** 3. pickups, for whoever survived *****
        for (id, snake) in snakes.iter_mut() {
            if !snake.alive || snake.in_grace() || kills.iter().any(|(dead, _)| dead == id) {
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

    const DT: f32 = 1.0 / 120.0;
    /// `spawnGraceSeconds` of the fixture, in fixed steps.
    const GRACE_STEPS: usize = 240;

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

    /// The shipped config with the crystal field switched off — these cases
    /// are about who moves and who kills, and a crystal picked up on the way
    /// would change both the radius and the length mid-test.
    fn config_json(grace: f32) -> serde_json::Value {
        let mut model = crate::config::fixtures::model_json();

        model["world"]["maxCrystals"] = json!(0);
        model["world"]["spawnGraceSeconds"] = json!(grace);

        json!({
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

    /// `MAP_JSON` with a respawn list of its own — the candidates
    /// `find_spawn_from` walks come from the map, so a test about them needs
    /// to be able to write it.
    fn map_json_with_respawns(points: &[[f32; 3]]) -> String {
        let list = points
            .iter()
            .map(|p| format!("[{}, {}, {}]", p[0], p[1], p[2]))
            .collect::<Vec<_>>()
            .join(", ");

        MAP_JSON.replace(
            r#""respawns": { "players": [[1280, 1280, 0]] }"#,
            &format!(r#""respawns": {{ "players": [{list}] }}"#),
        )
    }

    fn game_with_grace(grace: f32) -> GameState {
        let value = config_json(grace);
        let cfg: SnakesConfig = serde_json::from_value(value.clone()).unwrap();
        let engine: EngineConfig = serde_json::from_value(value).unwrap();
        let mut game = GameState::new(engine, &cfg);

        game.load_map(MAP_JSON).unwrap();

        game
    }

    #[test]
    fn a_snake_in_its_spawn_grace_stays_where_it_was_put() {
        let mut game = game_with_grace(2.0);

        game.spawn_actor(1, "s1", 1, 400.0, 1280.0, 0.0).unwrap();

        let start = game.actor_position(1).unwrap();

        for _ in 0..GRACE_STEPS - 1 {
            game.step(DT);
        }

        assert_eq!(
            game.actor_position(1).unwrap(),
            start,
            "frozen for the grace"
        );

        // …and the moment it runs out, the snake is an ordinary snake again
        for _ in 0..120 {
            game.step(DT);
        }

        assert!(
            game.actor_position(1).unwrap()[0] > start[0] + 200.0,
            "did not resume: {:?}",
            game.actor_position(1)
        );
    }

    #[test]
    fn a_snake_in_its_spawn_grace_is_driven_through_and_not_killed() {
        let mut game = game_with_grace(2.0);

        game.spawn_actor(1, "s1", 1, 400.0, 1280.0, 0.0).unwrap();

        // let the runner out of ITS grace first, so only the newcomer is
        // protected when the two meet
        for _ in 0..GRACE_STEPS {
            game.step(DT);
        }

        // straight ahead of the runner, close enough to be reached well
        // inside the newcomer's own grace
        game.spawn_actor(2, "s1", 1, 900.0, 1280.0, 180.0).unwrap();

        for _ in 0..GRACE_STEPS {
            game.step(DT);
        }

        assert!(
            game.actor_position(1).unwrap()[0] > 900.0,
            "never got there"
        );
        assert!(game.is_alive(1), "the runner died on a snake in grace");
        assert!(game.is_alive(2), "the newcomer was killed during its grace");
    }

    #[test]
    fn without_the_grace_the_same_run_is_a_crash() {
        // the control: it is the grace that saves them above, not the geometry
        let mut game = game_with_grace(0.0);

        // head on, so the two actually meet: with no grace both are moving
        // from the first step
        game.spawn_actor(1, "s1", 1, 400.0, 1280.0, 0.0).unwrap();
        game.spawn_actor(2, "s1", 1, 900.0, 1280.0, 180.0).unwrap();

        for _ in 0..GRACE_STEPS {
            game.step(DT);
        }

        assert!(!game.is_alive(1), "the runner drove through a live snake");
    }

    #[test]
    fn a_head_swinging_in_from_the_side_kills_only_the_one_that_swung() {
        // the fault rule: a collision belongs to whoever drove into it. Snake
        // 1 goes straight east and touches nothing; snake 2 crosses its line
        // from the north and runs into it just behind the head. Both used to
        // die here, which took out the player who did nothing.
        let mut game = game_with_grace(0.0);

        game.spawn_actor(1, "s1", 1, 400.0, 1280.0, 0.0).unwrap();
        game.spawn_actor(2, "s1", 1, 440.0, 1210.0, 90.0).unwrap();

        for _ in 0..GRACE_STEPS {
            game.step(DT);
        }

        assert!(!game.is_alive(2), "the one that drove in survived");
        assert!(game.is_alive(1), "the snake driving straight was taken out");
    }

    #[test]
    fn a_snake_enters_the_arena_with_its_whole_body() {
        // a bare head that grows by driving is invisible for the first
        // seconds of a life — and the spawn grace is spent frozen, so it
        // would not even be growing
        let mut game = game_with_grace(2.0);
        let model = game.sim.models.get("s1").unwrap().clone();

        game.spawn_actor(1, "s1", 1, 800.0, 1280.0, 0.0).unwrap();

        let snake = game.sim.snakes.get(&1).unwrap();
        let length = snake.path.length();

        assert!(
            (length - crate::motion::length_for(snake.crystals, &model)).abs() < 1.0,
            "spawned with a body of {length}"
        );

        // laid out BEHIND the head, so the snake does not spawn on top of
        // where it is about to drive
        let tail = snake.path.nodes().last().copied().unwrap();

        assert!(tail[0] < snake.head()[0], "the body was laid out forwards");
    }

    #[test]
    fn snakes_spawned_on_one_point_are_spread_out_instead_of_stacked() {
        // the engine hands out respawn points by index and never checks
        // whether one is taken: `RoundManager.changeTeam` derives the index
        // from the team size, so a series of joins and leaves puts two players
        // on one spot. The core is the last place that can notice.
        let mut game = game_with_grace(2.0);

        // one step so the sim has an arena: it is rebuilt from `ctx.map` on
        // the fixed step, and the trait has no map-load hook to do it earlier
        game.step(DT);

        // one point, eight snakes, no steps between them — nothing but the
        // clearance search stands between this and a heap
        for id in 1..=8u32 {
            game.spawn_actor(id, "s1", 1, 1280.0, 1280.0, 0.0).unwrap();
        }

        let spots: Vec<[f32; 2]> = (1..=8u32)
            .map(|id| {
                let p = game.actor_position(id).unwrap();

                [p[0], p[1]]
            })
            .collect();

        for (i, a) in spots.iter().enumerate() {
            for b in &spots[i + 1..] {
                let gap = (a[0] - b[0]).hypot(a[1] - b[1]);

                assert!(gap >= RESPAWN_CLEARANCE, "{a:?} and {b:?} are {gap} apart");
            }
        }
    }

    #[test]
    fn the_map_points_are_the_candidates_before_the_fallback_scan_is() {
        // the relocation walks the map's OWN respawn points first: the core
        // must not invent a geometry of its own while the map declares one
        let mut game = game_with_grace(2.0);
        let free = [700.0, 1500.0, 0.0];

        game.load_map(&map_json_with_respawns(&[[1280.0, 1280.0, 0.0], free]))
            .unwrap();
        game.step(DT);

        game.spawn_actor(1, "s1", 1, 1280.0, 1280.0, 0.0).unwrap();
        // the same (now occupied) point: the second snake has to land on the
        // other point of the map, exactly, and not somewhere near it
        game.spawn_actor(2, "s1", 1, 1280.0, 1280.0, 0.0).unwrap();

        let spot = game.actor_position(2).unwrap();

        assert!(
            (spot[0] - free[0]).abs() < 0.01 && (spot[1] - free[1]).abs() < 0.01,
            "expected the map's free point {free:?}, got {spot:?}"
        );
    }

    #[test]
    fn a_map_point_count_that_is_not_a_power_of_two_loses_no_point() {
        // five points: the bit-reversal is a permutation of eight, and a walk
        // counted in FIVES sends three of its images past the end of the list
        // while never producing index 3 at all. The one free point of the map
        // is exactly that index — a walk that skips it would fall through to
        // the disc scan and stand the snake somewhere off the map's geometry
        let mut game = game_with_grace(2.0);
        let taken = [
            [1280.0, 1280.0, 0.0],
            [700.0, 1280.0, 0.0],
            [1860.0, 1280.0, 0.0],
        ];
        let free = [1280.0, 680.0, 0.0];
        let points = [taken[0], taken[1], taken[2], free, [1280.0, 1880.0, 0.0]];

        game.load_map(&map_json_with_respawns(&points)).unwrap();
        game.step(DT);

        // everything but index 3, each snake on the point it asks for
        for (i, id) in [0usize, 1, 2, 4].iter().zip(1u32..) {
            let p = points[*i];

            game.spawn_actor(id, "s1", 1, p[0], p[1], p[2]).unwrap();
        }

        // an occupied point: the search has to find the only free one
        game.spawn_actor(5, "s1", 1, points[0][0], points[0][1], 0.0)
            .unwrap();

        let spot = game.actor_position(5).unwrap();

        assert!(
            (spot[0] - free[0]).abs() < 0.01 && (spot[1] - free[1]).abs() < 0.01,
            "expected the map's free point {free:?}, got {spot:?}"
        );
    }

    #[test]
    fn a_crowd_past_the_map_points_still_gets_room_instead_of_a_heap() {
        // one point on the map and forty snakes: the map's list runs out and
        // the fallback scan of the disc takes over. Nobody may be left
        // standing inside somebody else — a stack dies together the moment
        // the spawn grace expires
        let mut game = game_with_grace(2.0);

        game.step(DT);

        for id in 1..=40u32 {
            game.spawn_actor(id, "s1", 1, 1280.0, 1280.0, 0.0).unwrap();
        }

        let spots: Vec<[f32; 2]> = (1..=40u32)
            .map(|id| {
                let p = game.actor_position(id).unwrap();

                [p[0], p[1]]
            })
            .collect();

        let mut stacked = 0;

        // the yardstick is the clearance the search itself keeps, not a
        // token unit of world: a test that only forbids literally the same
        // coordinates would pass on a heap and miss the regression of the
        // fallback scan it is written for
        for (i, a) in spots.iter().enumerate() {
            for b in &spots[i + 1..] {
                if (a[0] - b[0]).hypot(a[1] - b[1]) < RESPAWN_CLEARANCE {
                    stacked += 1;
                }
            }
        }

        assert_eq!(stacked, 0, "{stacked} pairs of snakes stand too close");
    }

    #[test]
    fn a_map_without_respawn_points_still_places_the_snake() {
        // the walk has nothing to walk and the subtraction that sizes it would
        // underflow: the fallback scan has to take over instead of panicking
        let mut game = game_with_grace(2.0);

        game.load_map(&MAP_JSON.replace(
            r#""respawns": { "players": [[1280, 1280, 0]] }"#,
            r#""respawns": {}"#,
        ))
        .unwrap();
        game.step(DT);

        game.spawn_actor(1, "s1", 1, 1280.0, 1280.0, 0.0).unwrap();
        game.spawn_actor(2, "s1", 1, 1280.0, 1280.0, 0.0).unwrap();

        let a = game.actor_position(1).unwrap();
        let b = game.actor_position(2).unwrap();
        let gap = (a[0] - b[0]).hypot(a[1] - b[1]);

        assert!(gap >= RESPAWN_CLEARANCE, "{a:?} and {b:?} are {gap} apart");
    }

    #[test]
    fn a_respawning_snake_is_not_pushed_off_a_free_point_by_its_own_body() {
        // `reset_actor` runs while the snake is still alive and still dragging
        // its old body. Counting that body would relocate a player nobody else
        // is anywhere near
        let mut game = game_with_grace(0.0);

        game.step(DT);
        game.spawn_actor(1, "s1", 1, 1280.0, 1280.0, 0.0).unwrap();

        // let it grow a body to trip over
        for _ in 0..120 {
            game.step(DT);
        }

        let head = game.actor_position(1).unwrap();

        // asking for the spot it is standing on: only its own body is there
        game.reset_actor(1, 1, head[0], head[1], 0.0);

        let spot = game.actor_position(1).unwrap();

        assert!(
            (spot[0] - head[0]).abs() < 0.01 && (spot[1] - head[1]).abs() < 0.01,
            "the snake was moved off its own free point: {head:?} -> {spot:?}"
        );
    }

    #[test]
    fn a_spawn_point_that_is_already_free_is_left_exactly_where_it_was() {
        // the search is a fallback, not a re-roll: an uncontested respawn
        // point must reach the snake unchanged, or the map's layout stops
        // meaning anything
        let mut game = game_with_grace(2.0);

        game.step(DT);
        game.spawn_actor(1, "s1", 1, 900.0, 1100.0, 45.0).unwrap();

        let spot = game.actor_position(1).unwrap();

        assert!((spot[0] - 900.0).abs() < 0.01, "{spot:?}");
        assert!((spot[1] - 1100.0).abs() < 0.01, "{spot:?}");
    }

    /// `config_json` with a full pocket of crystals and no grace: the boost
    /// needs something to burn and a snake that is actually moving.
    fn game_with_crystals(start: u32) -> GameState {
        let mut value = config_json(0.0);

        value["models"]["s1"]["world"]["startCrystals"] = json!(start);

        let cfg: SnakesConfig = serde_json::from_value(value.clone()).unwrap();
        let engine: EngineConfig = serde_json::from_value(value).unwrap();
        let mut game = GameState::new(engine, &cfg);

        game.load_map(MAP_JSON).unwrap();

        game
    }

    /// The `burn` payloads of one step, in order.
    fn burn_events(game: &mut GameState) -> Vec<serde_json::Value> {
        let events: Vec<serde_json::Value> =
            serde_json::from_str(&game.take_events_json()).unwrap();

        events
            .into_iter()
            .filter(|e| e["type"] == "custom" && e["data"]["type"] == "burn")
            .map(|e| e["data"].clone())
            .collect()
    }

    #[test]
    fn the_boost_reports_every_crystal_it_burns() {
        // the host cannot take the burnt crystals off the score without an
        // event: `crystals` fires on pickups only, and `total` alone is reset
        // by a respawn
        let mut game = game_with_crystals(200);

        game.spawn_actor(1, "s1", 1, 1280.0, 1280.0, 0.0).unwrap();

        let before = game.sim.snakes.get(&1).unwrap().crystals;

        game.take_events_json();
        game.apply_input(1, 1, "down", "boost");

        let mut burns: Vec<serde_json::Value> = Vec::new();

        // a second of boost at `boostDrainPerSecond` of the fixture
        for _ in 0..120 {
            game.step(DT);
            burns.extend(burn_events(&mut game));
        }

        let after = game.sim.snakes.get(&1).unwrap().crystals;

        assert!(!burns.is_empty(), "a second of boost burnt nothing");

        let reported: u64 = burns.iter().map(|b| b["burned"].as_u64().unwrap()).sum();

        assert_eq!(
            reported,
            u64::from(before - after),
            "reported {reported}, spent {}",
            before - after
        );
        assert_eq!(
            burns.last().unwrap()["total"].as_u64().unwrap(),
            u64::from(after),
            "the last `total` is not what the snake carries"
        );
        assert!(
            burns.iter().all(|b| b["id"].as_u64() == Some(1)),
            "a burn was reported for somebody else"
        );
    }

    #[test]
    fn driving_without_the_boost_burns_nothing() {
        let mut game = game_with_crystals(200);

        game.spawn_actor(1, "s1", 1, 1280.0, 1280.0, 0.0).unwrap();
        game.take_events_json();

        for _ in 0..120 {
            game.step(DT);

            assert!(
                burn_events(&mut game).is_empty(),
                "a cruising snake burnt crystals"
            );
        }
    }

    #[test]
    fn the_boost_byte_carries_the_boost_in_bit_0_and_the_grace_in_bit_1() {
        let mut snake = Snake::new("s1", 1, 0, 0.0, 0.0, 0.0, 2.0);

        assert_eq!(SnakesSim::boost_byte(&snake), 0b10);

        snake.boosting = true;

        assert_eq!(SnakesSim::boost_byte(&snake), 0b11);

        snake.tick_grace(2.0);

        assert_eq!(SnakesSim::boost_byte(&snake), 0b01);
    }

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
