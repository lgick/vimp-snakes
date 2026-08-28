//! The crystal field: what snakes eat, and what a dead snake leaves behind.
//!
//! Crystals never move, so putting them in the hot buffer would spend ~50 KB/s
//! re-sending a constant. The `cr` block is `indexed32` + class `event` and is
//! packed as a **delta** — one row when a crystal appears, a `null` row when
//! it is eaten — which rides the reliable channel and reaches the client as
//! `{ "<id36>": [fields] | null }`, the shape its factory builds persistent
//! parts from.
//!
//! The price of a delta is that a client joining mid-match has missed every
//! row so far, so `request_resync()` re-sends the whole field; `game.rs` calls
//! it whenever an actor spawns.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use vimp_engine_core::config::FieldValue;
use vimp_engine_core::physics::round2;
use vimp_engine_core::rng::Rng;

use crate::arena::Arena;
use crate::config::WorldConfig;

#[derive(Clone, Copy, Serialize, Deserialize)]
pub struct Crystal {
    pub x: f32,
    pub y: f32,
    /// Index into `world.tiers`: size and score.
    pub tier: u8,
    /// Free-running index into CRYSTAL_COLORS. The client takes it modulo the
    /// palette length, so the core never needs to know how long that is.
    pub color: u8,
}

#[derive(Default, Serialize, Deserialize)]
pub struct CrystalField {
    crystals: IndexMap<u32, Crystal>,
    next_id: u32,
    spawn_timer: f32,

    // delta accumulators, drained once per packed frame. They are transient
    // by design: a restored snapshot re-sends everything instead.
    #[serde(skip)]
    spawned: Vec<u32>,
    #[serde(skip)]
    removed: Vec<u32>,
    #[serde(skip)]
    resync: bool,
}

impl CrystalField {
    pub fn len(&self) -> usize {
        self.crystals.len()
    }

    pub fn is_empty(&self) -> bool {
        self.crystals.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&u32, &Crystal)> {
        self.crystals.iter()
    }

    /// Re-send the whole field with the next packed frame. Called when an
    /// actor spawns: the newcomer's client has seen none of the deltas.
    pub fn request_resync(&mut self) {
        self.resync = true;
    }

    pub fn clear(&mut self) {
        self.crystals.clear();
        self.spawned.clear();
        self.removed.clear();
        self.spawn_timer = 0.0;
        self.resync = false;
    }

    /// Natural spawning, one crystal per `spawn_interval` while below the cap.
    pub fn tick(&mut self, dt: f32, arena: &Arena, rng: &mut Rng, world: &WorldConfig) {
        if self.crystals.len() >= world.max_crystals {
            // hold the timer at zero so the field refills immediately once
            // something is eaten, instead of after a leftover countdown
            self.spawn_timer = 0.0;

            return;
        }

        self.spawn_timer += dt;

        while self.spawn_timer >= world.spawn_interval {
            self.spawn_timer -= world.spawn_interval;

            let point = arena.random_point(rng, world.edge_margin);
            let tier = roll_tier(rng, world);

            self.insert(point, tier, rng);

            if self.crystals.len() >= world.max_crystals {
                self.spawn_timer = 0.0;

                break;
            }
        }
    }

    /// Drops a crystal at an exact spot — the boost tax and the pile a dead
    /// snake leaves. Refused once the field is full, so a chain of deaths
    /// cannot flood the map.
    ///
    /// The spot is pulled onto the disc first, and that is a hard invariant of
    /// the field rather than a nicety: BOTH callers drop along a body, and a
    /// body reaches outside the disc every time a snake dies on the boundary
    /// (which is how most of them die). A crystal left out there is
    /// UNREACHABLE for ever — see `retain_inside` for the arithmetic — and it
    /// keeps counting against `max_crystals`, so a few of them are enough to
    /// stop the field refilling at all. `clamp_inside` is a no-op on a point
    /// that is already in, and on a radius of zero (no map yet).
    ///
    /// The pile of a snake killed by the edge is therefore tucked slightly
    /// inwards. That is the right place for it: inside is where it can be
    /// collected.
    pub fn drop_at(
        &mut self,
        point: [f32; 2],
        tier: u8,
        rng: &mut Rng,
        world: &WorldConfig,
        arena: &Arena,
    ) -> bool {
        if self.crystals.len() >= world.max_crystals {
            return false;
        }

        self.insert(arena.clamp_inside(point, world.edge_margin), tier, rng);

        true
    }

    /// Drops every crystal the arena no longer holds, and returns how many
    /// went. Each one leaves a `null` row behind like an eaten one does.
    ///
    /// The disc is rebuilt under the running match (`src/host/ArenaScaler.js`
    /// shrinks it as the room empties), and a shrink leaves whatever stood in
    /// the old ring outside the new boundary. Those crystals are not merely
    /// awkward, they are UNREACHABLE: a head is stopped by the boundary at
    /// `radius - snake_radius`, and its pickup reach is `snake_radius +
    /// tier.radius`, so nothing can ever come within `radius + tier.radius`
    /// of the centre — the snake radius cancels and no snake, thin or fat,
    /// can get to them. Worse, they keep counting against `max_crystals`, so
    /// the field stops refilling and the arena starves on food nobody can
    /// eat. They go with the ground they stood on.
    pub fn retain_inside(&mut self, arena: &Arena) -> usize {
        let doomed: Vec<u32> = self
            .crystals
            .iter()
            .filter(|(_, crystal)| !arena.contains([crystal.x, crystal.y], 0.0))
            .map(|(&id, _)| id)
            .collect();

        for id in &doomed {
            self.crystals.shift_remove(id);
            self.removed.push(*id);
        }

        doomed.len()
    }

    /// Eats the first crystal whose disc overlaps `point`, and returns the
    /// crystals it is worth. `reach` is the snake's own radius — the tier's
    /// radius is added here so a big crystal is easier to catch.
    pub fn take_at(&mut self, point: [f32; 2], reach: f32, world: &WorldConfig) -> Option<u32> {
        let hit = self.crystals.iter().find(|(_, crystal)| {
            let tier = world
                .tiers
                .get(crystal.tier as usize)
                .copied()
                .unwrap_or(world.tiers[0]);
            let limit = reach + tier.radius;
            let dx = crystal.x - point[0];
            let dy = crystal.y - point[1];

            dx * dx + dy * dy <= limit * limit
        });

        let (&id, &crystal) = hit?;

        self.crystals.shift_remove(&id);
        self.removed.push(id);

        Some(
            world
                .tiers
                .get(crystal.tier as usize)
                .map(|tier| tier.value)
                .unwrap_or(1),
        )
    }

    /// The `cr` block for this frame, or `None` when nothing changed.
    ///
    /// Rows are `round2`-ed on the way out: the packer writes the `f32` it is
    /// given verbatim and the decoder rounds, so an unrounded value reaches
    /// the client as a different number than the one the host kept.
    pub fn drain_block(&mut self) -> Option<Vec<(u32, Option<Vec<FieldValue>>)>> {
        let resync = std::mem::take(&mut self.resync);
        let spawned = std::mem::take(&mut self.spawned);
        let mut removed = std::mem::take(&mut self.removed);

        // A crystal that appeared and was eaten between two frames never
        // existed as far as any client is concerned — sending only its removal
        // would ask every client to destroy a part it was never told to build.
        // Ids are never reused (`next_id` only counts up), so being in both
        // lists can only mean exactly that.
        removed.retain(|id| !spawned.contains(id));

        let spawned: Vec<u32> = spawned
            .into_iter()
            .filter(|id| self.crystals.contains_key(id))
            .collect();

        if !resync && spawned.is_empty() && removed.is_empty() {
            return None;
        }

        let mut rows: Vec<(u32, Option<Vec<FieldValue>>)> = Vec::new();

        if resync {
            for (&id, crystal) in &self.crystals {
                rows.push((id, Some(row_of(crystal))));
            }
        } else {
            for id in spawned {
                if let Some(crystal) = self.crystals.get(&id) {
                    rows.push((id, Some(row_of(crystal))));
                }
            }
        }

        for id in removed {
            rows.push((id, None));
        }

        (!rows.is_empty()).then_some(rows)
    }

    fn insert(&mut self, point: [f32; 2], tier: u8, rng: &mut Rng) {
        let id = self.next_id;

        self.next_id = self.next_id.wrapping_add(1);

        self.crystals.insert(
            id,
            Crystal {
                x: point[0],
                y: point[1],
                tier,
                color: (rng.range(0.0, 256.0) as u32 & 0xff) as u8,
            },
        );

        self.spawned.push(id);
    }
}

fn row_of(crystal: &Crystal) -> Vec<FieldValue> {
    // positional, and bound to the `cr` fields of src/config/snapshot.js
    vec![
        FieldValue::F32(round2(crystal.x)),
        FieldValue::F32(round2(crystal.y)),
        FieldValue::U8(crystal.tier),
        FieldValue::U8(crystal.color),
    ]
}

/// Weighted pick over `world.tier_weights`. Every roll goes through the engine
/// `Rng` — a match must replay identically from the same seed.
pub fn roll_tier(rng: &mut Rng, world: &WorldConfig) -> u8 {
    let total: f32 = world.tier_weights.iter().sum();
    let mut pick = rng.range(0.0, total);

    for (index, weight) in world.tier_weights.iter().enumerate() {
        if pick < *weight {
            return index as u8;
        }

        pick -= weight;
    }

    (world.tier_weights.len() - 1) as u8
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::fixtures::model;

    fn arena() -> Arena {
        Arena {
            centre: [1280.0, 1280.0],
            radius: 1280.0,
        }
    }

    fn world() -> WorldConfig {
        model().world
    }

    /// A disc big enough to hold every point these tests use, for the ones
    /// that are not about the boundary at all — `drop_at` clamps onto the
    /// disc, so a small arena would silently move the crystal under the test.
    fn anywhere() -> Arena {
        Arena {
            centre: [0.0, 0.0],
            radius: 1.0e6,
        }
    }

    #[test]
    fn the_field_fills_to_the_cap_and_stops() {
        let mut field = CrystalField::default();
        let mut rng = Rng::new(7);
        let world = world();

        field.tick(600.0, &arena(), &mut rng, &world);

        assert_eq!(field.len(), world.max_crystals);
    }

    #[test]
    fn a_crystal_within_reach_is_eaten_and_pays_its_tier() {
        let mut field = CrystalField::default();
        let mut rng = Rng::new(7);
        let mut world = world();

        // one tier only, so the value is known
        world.tiers.truncate(1);
        world.tier_weights.truncate(1);

        field.drop_at([100.0, 100.0], 0, &mut rng, &world, &anywhere());

        assert_eq!(field.take_at([500.0, 500.0], 14.0, &world), None);
        assert_eq!(field.take_at([105.0, 100.0], 14.0, &world), Some(1));
        assert!(field.is_empty());
    }

    #[test]
    fn the_first_block_after_a_spawn_carries_the_row() {
        let mut field = CrystalField::default();
        let mut rng = Rng::new(7);
        let world = world();

        field.drop_at([10.0, 20.0], 0, &mut rng, &world, &anywhere());

        let rows = field.drain_block().expect("a spawn is a delta");

        assert_eq!(rows.len(), 1);
        assert!(rows[0].1.is_some());

        // and nothing changed since, so there is no block at all
        assert!(field.drain_block().is_none());
    }

    #[test]
    fn eating_produces_a_null_row() {
        let mut field = CrystalField::default();
        let mut rng = Rng::new(7);
        let world = world();

        field.drop_at([10.0, 20.0], 0, &mut rng, &world, &anywhere());
        field.drain_block();

        field.take_at([10.0, 20.0], 30.0, &world);

        let rows = field.drain_block().expect("a pickup is a delta");

        assert_eq!(rows.len(), 1);
        assert!(rows[0].1.is_none(), "a removal is a null row");
    }

    #[test]
    fn a_crystal_born_and_eaten_between_frames_is_never_sent() {
        let mut field = CrystalField::default();
        let mut rng = Rng::new(7);
        let world = world();

        field.drop_at([10.0, 20.0], 0, &mut rng, &world, &anywhere());
        field.take_at([10.0, 20.0], 30.0, &world);

        assert!(field.drain_block().is_none());
    }

    #[test]
    fn a_resync_re_sends_every_crystal() {
        let mut field = CrystalField::default();
        let mut rng = Rng::new(7);
        let world = world();

        for i in 0..5 {
            field.drop_at([i as f32 * 10.0, 0.0], 0, &mut rng, &world, &anywhere());
        }

        field.drain_block();
        field.request_resync();

        let rows = field.drain_block().expect("a resync is always a block");

        assert_eq!(rows.len(), 5);
        assert!(rows.iter().all(|(_, row)| row.is_some()));
    }

    #[test]
    fn a_drop_outside_the_disc_is_pulled_in() {
        // `drop_at` is called with points taken off a BODY — the boost tax
        // behind the tail and the pile of a dead snake — and a snake dies at
        // the boundary more often than anywhere else, so those points are
        // routinely outside. A crystal left there can never be eaten and
        // still counts against `max_crystals`.
        let mut field = CrystalField::default();
        let mut rng = Rng::new(7);
        let world = world();
        let arena = Arena {
            centre: [0.0, 0.0],
            radius: 1000.0,
        };

        assert!(field.drop_at([5000.0, 0.0], 0, &mut rng, &world, &arena));

        let (_, crystal) = field.iter().next().expect("the drop was accepted");

        assert!(
            arena.contains([crystal.x, crystal.y], world.edge_margin),
            "dropped at {:?}, which is outside the disc",
            [crystal.x, crystal.y]
        );
    }

    #[test]
    fn a_shrunken_arena_drops_the_crystals_it_no_longer_holds() {
        let mut field = CrystalField::default();
        let mut rng = Rng::new(7);
        let world = world();
        let big = Arena { centre: [0.0, 0.0], radius: 1000.0 };
        let small = Arena { centre: [0.0, 0.0], radius: 500.0 };

        field.drop_at([0.0, 0.0], 0, &mut rng, &world, &big);
        field.drop_at([400.0, 0.0], 0, &mut rng, &world, &big);
        // inside the big disc, outside the small one — this is the crystal
        // the snake could see and never eat
        field.drop_at([800.0, 0.0], 0, &mut rng, &world, &big);
        field.drain_block();

        assert_eq!(field.retain_inside(&big), 0, "nothing to drop yet");

        assert_eq!(field.retain_inside(&small), 1);
        assert_eq!(field.len(), 2);

        // and the clients are told, or they would keep drawing it
        let rows = field.drain_block().expect("a stranded crystal is a delta");

        assert_eq!(rows.len(), 1);
        assert!(rows[0].1.is_none(), "a removal is a null row");
    }

    #[test]
    fn tier_weights_are_respected() {
        let mut rng = Rng::new(99);
        let world = world();
        let mut counts = [0usize; 3];

        for _ in 0..10_000 {
            counts[roll_tier(&mut rng, &world) as usize] += 1;
        }

        // weights are 70 / 25 / 5
        assert!(counts[0] > counts[1], "{counts:?}");
        assert!(counts[1] > counts[2], "{counts:?}");
    }
}
