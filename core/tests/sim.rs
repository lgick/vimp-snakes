// Integration tests of the simulation: they drive the real `GameCore` ABI —
// the very methods the host Worker calls — instead of the internals, so a
// change that breaks the host is caught here and not in the browser.

use vimp_engine_core::events::CoreEvent;
use vimp_snakes_core::GameCore;

const DT: f32 = 1.0 / 120.0;

/// Cells per side and cell size of the default map: a disc of radius 1280
/// centred on (1280, 1280), the shape of `src/data/maps/arena.js`.
const CELLS: usize = 20;
const STEP: f32 = 128.0;
const CENTRE: f32 = (CELLS as f32 * STEP) / 2.0;

/// Core config — a mirror of src/config/game.js + src/data/. The same flat
/// object is put into both halves of `{engine, game}`: each side ignores the
/// fields that are not its own.
///
/// `start_crystals` and `max_crystals` are parameters because there is no
/// public way to hand a snake crystals (the only legitimate source is eating
/// one) and no way to stop the field from refilling — and several of the
/// rules below only exist above a certain body length.
fn config_json(start_crystals: u32, max_crystals: usize) -> String {
    let flat = flat_config_json(start_crystals, max_crystals);

    serde_json::json!({ "engine": flat.clone(), "game": flat }).to_string()
}

fn flat_config_json(start_crystals: u32, max_crystals: usize) -> serde_json::Value {
    // 16 spine points -> 32 positional float fields, then angle, radius,
    // crystals, colour, boost. Built rather than written out: a hand-typed
    // list of 32 near-identical entries is a place for a typo to hide.
    let mut fields: Vec<serde_json::Value> = (0..16)
        .flat_map(|i| {
            [
                serde_json::json!({ "name": format!("p{i}x"), "ty": "f32", "interp": "lerp" }),
                serde_json::json!({ "name": format!("p{i}y"), "ty": "f32", "interp": "lerp" }),
            ]
        })
        .collect();

    fields.push(serde_json::json!({ "name": "angle", "ty": "f32", "interp": "lerpAngle" }));
    fields.push(serde_json::json!({ "name": "radius", "ty": "f32", "interp": "lerp" }));
    fields.push(serde_json::json!({ "name": "crystals", "ty": "u16" }));
    fields.push(serde_json::json!({ "name": "color", "ty": "u8" }));
    fields.push(serde_json::json!({ "name": "boost", "ty": "u8" }));

    serde_json::json!({
        "timeStep": DT,
        "friendlyFire": false,
        "mapScale": 1,
        "mapSetId": "c1",
        "models": {
            "s1": {
                "baseSpeed": 260.0,
                "boostFactor": 1.9,
                "turnSpeed": 3.4,
                "baseRadius": 14.0,
                "radiusGain": 1.6,
                "baseLength": 150.0,
                "lengthPerCrystal": 9.0,
                "pointSpacing": 6.0,
                "boostDrainPerSecond": 6.0,
                "boostMinCrystals": 2,
                "world": {
                    "maxCrystals": max_crystals,
                    "spawnInterval": 0.35,
                    "tierWeights": [70.0, 25.0, 5.0],
                    "tiers": [
                        { "value": 1, "radius": 8.0 },
                        { "value": 3, "radius": 13.0 },
                        { "value": 8, "radius": 20.0 }
                    ],
                    "dropRatio": 0.8,
                    "edgeMargin": 60.0,
                    "startCrystals": start_crystals
                }
            }
        },
        "weapons": {},
        "playerKeys": {
            "left": { "key": 1 },
            "right": { "key": 2 },
            "boost": { "key": 4 },
            "respawn": { "key": 8, "type": 1 }
        },
        "panel": {
            "crystals": { "value": 0 },
            "length": { "value": 0 },
            "dead": { "value": 0 }
        },
        "snapshot": {
            "version": 3,
            "port": 5,
            "keys": {
                "s1": { "id": 1, "kind": "indexed8", "class": "hot", "fields": fields },
                "cr": { "id": 2, "kind": "indexed32", "class": "event", "fields": [
                    { "name": "x", "ty": "f32" },
                    { "name": "y", "ty": "f32" },
                    { "name": "tier", "ty": "u8" },
                    { "name": "color", "ty": "u8" }
                ] },
                "c1": { "id": 3, "kind": "indexedNoNull8", "class": "hot", "fields": [
                    { "name": "x", "ty": "f32", "interp": "lerp" },
                    { "name": "y", "ty": "f32", "interp": "lerp" },
                    { "name": "angle", "ty": "f32", "interp": "lerpAngle" }
                ] }
            }
        },
        "seed": 42
    })
}

/// The circular arena. The grid carries no geometry — `physicsStatic` is
/// empty and every cell is the same value — only its size, which is what both
/// halves derive the disc from (`core/src/arena.rs`).
fn map_json(cells: usize, step: f32) -> String {
    let centre = (cells as f32 * step) / 2.0;

    serde_json::json!({
        "setId": "c1",
        "scale": 1,
        "step": step,
        "map": vec![vec![1; cells]; cells],
        "physicsStatic": Vec::<i32>::new(),
        "physicsDynamic": Vec::<i32>::new(),
        "respawns": {
            "players": [
                [centre, centre, 0.0],
                [centre + 200.0, centre, 180.0]
            ]
        }
    })
    .to_string()
}

fn make_core(start_crystals: u32, max_crystals: usize) -> GameCore {
    let mut core = GameCore::new(&config_json(start_crystals, max_crystals)).unwrap();

    core.load_map(&map_json(CELLS, STEP)).unwrap();

    core
}

fn steps(core: &mut GameCore, count: usize) {
    for _ in 0..count {
        core.step(DT);
    }
}

fn events(core: &mut GameCore) -> Vec<CoreEvent> {
    serde_json::from_str(&core.take_events()).unwrap()
}

/// One broadcast frame as bytes — the unit the determinism tests compare.
fn frame(core: &mut GameCore, seq: u32) -> Vec<u8> {
    core.pack_body().unwrap();
    core.pack_frame(1000.0 + seq as f64, seq, false, 0.0, 0.0, false, None, -1);

    core.frame_bytes()
}

/// players_data(): `{ model: { id: [row] } }`, the row in SCHEMA order —
/// 32 spine floats, angle, radius, crystals, colour, boost. It is what a
/// joining client receives as its first full frame, so the shape is not free.
fn player_data(core: &GameCore, id: u32) -> serde_json::Value {
    let data: serde_json::Value = serde_json::from_str(&core.players_data()).unwrap();

    data["s1"][id.to_string()].clone()
}

/// Index of `crystals` in that row: 16 spine points, then angle and radius.
const ROW_CRYSTALS: usize = 16 * 2 + 2;

fn crystals_of(core: &GameCore, id: u32) -> u64 {
    player_data(core, id)[ROW_CRYSTALS].as_u64().unwrap()
}

fn death_event(core: &mut GameCore) -> Option<serde_json::Value> {
    events(core).into_iter().find_map(|event| match event {
        CoreEvent::Custom { data } if data["type"] == "death" => Some(data),
        _ => None,
    })
}

#[test]
fn a_snake_moves_on_its_own_and_turns_with_the_keys() {
    let mut core = make_core(0, 0);

    core.spawn_actor(1, "s1", 1, CENTRE, CENTRE, 0.0).unwrap();

    // no key held: a snake is always moving
    steps(&mut core, 60);

    let straight = core.position_of(1);

    assert!(
        straight[0] > CENTRE + 100.0,
        "a snake must drive itself, x = {}",
        straight[0]
    );
    assert!((straight[1] - CENTRE).abs() < 1.0, "and go straight");

    core.apply_input(1, 7, "down", "right");
    steps(&mut core, 60);

    assert_eq!(core.last_input_seq(1), 7);
    assert!(
        core.position_of(1)[1] > CENTRE + 20.0,
        "holding right must curve it"
    );
}

#[test]
fn the_arena_edge_kills() {
    let mut core = make_core(0, 0);

    // just inside the rim, facing straight out of the disc
    core.spawn_actor(1, "s1", 1, CENTRE + 1100.0, CENTRE, 0.0)
        .unwrap();

    assert!(core.is_alive(1));

    // 180 units to the edge, under a second at cruise speed
    steps(&mut core, 120);

    assert!(!core.is_alive(1), "the boundary must catch it");
}

#[test]
fn a_crash_never_reports_a_death_to_the_engine() {
    // The structural decision of this game, as a test: reporting a kill is
    // what ends a round, and the round here is endless. If a CoreEvent::Death
    // ever appears, the engine will end the round, park the player as a
    // spectator and never respawn it — which is exactly the failure this whole
    // design exists to avoid. See the note atop core/src/game.rs.
    let mut core = make_core(0, 0);

    core.spawn_actor(1, "s1", 1, CENTRE + 1100.0, CENTRE, 0.0)
        .unwrap();

    events(&mut core);
    steps(&mut core, 120);

    let produced = events(&mut core);

    assert!(!core.is_alive(1), "the snake must have crashed");
    assert!(
        !produced
            .iter()
            .any(|event| matches!(event, CoreEvent::Death { .. })),
        "a crash must not reach the engine as a Death"
    );

    let death = produced
        .iter()
        .find_map(|event| match event {
            CoreEvent::Custom { data } if data["type"] == "death" => Some(data),
            _ => None,
        })
        .expect("a crash must reach the host plugin as a custom event");

    assert_eq!(death["id"], 1);
    assert_eq!(death["crashes"], 1);
}

#[test]
fn a_head_into_another_body_kills_only_the_one_that_ran_in() {
    let mut core = make_core(0, 0);

    // the victim-to-be lays a body down across the middle of the arena
    core.spawn_actor(1, "s1", 1, CENTRE, CENTRE, 0.0).unwrap();
    steps(&mut core, 120);

    let laid = core.position_of(1);

    // and the newcomer spawns on that body, well behind its head
    core.spawn_actor(2, "s1", 1, laid[0] - 90.0, CENTRE, 180.0)
        .unwrap();
    steps(&mut core, 1);

    assert!(!core.is_alive(2), "running into a body is fatal");
    assert!(core.is_alive(1), "being run into is not");
}

#[test]
fn a_snake_passes_over_its_own_tail() {
    // 60 crystals -> a 690-unit body; the tightest turn is a circle of 481
    // units, so a snake holding one direction must cross its own tail
    let mut core = make_core(60, 0);

    core.spawn_actor(1, "s1", 1, CENTRE, CENTRE, 0.0).unwrap();
    core.apply_input(1, 1, "down", "right");

    steps(&mut core, 600);

    assert!(
        core.is_alive(1),
        "the head passes over its own tail — that is the rule"
    );
}

#[test]
fn a_bot_hunts_crystals_and_grows_on_them() {
    // A bot rather than a scripted key schedule, for a reason worth writing
    // down: a snake holding one turn key traces a fixed 481-unit circle and
    // only ever sweeps that thin annulus — about 9% of the arena — so whether
    // it happens to eat anything is a coin flip on the seed. A bot steers at
    // the nearest crystal, which is both a reliable pickup test and the only
    // coverage the bot AI gets.
    let mut core = GameCore::new(&config_json(0, 40)).unwrap();

    core.load_map(&map_json(6, STEP)).unwrap();

    let centre = (6.0 * STEP) / 2.0;

    core.spawn_scripted_actor(1, "s1", 1, centre, centre, 0.0)
        .unwrap();

    steps(&mut core, 1200);

    assert!(core.is_alive(1), "a bot must not drive itself into the edge");
    assert!(
        crystals_of(&core, 1) > 0,
        "ten seconds of hunting a full field must feed it"
    );
}

#[test]
fn a_crash_reports_everything_the_snake_was_carrying() {
    let mut core = make_core(40, 60);

    core.spawn_actor(1, "s1", 1, CENTRE + 1100.0, CENTRE, 0.0)
        .unwrap();
    events(&mut core);
    steps(&mut core, 120);

    assert!(!core.is_alive(1));

    let death = death_event(&mut core).expect("a crash is reported to the plugin");

    // this number is what the host module writes into the stat table and what
    // the client's result overlay shows
    assert_eq!(death["crystals"], 40, "it died carrying what it had");
}

#[test]
fn a_dead_snake_waits_for_the_respawn_key() {
    let mut core = make_core(0, 0);

    core.spawn_actor(1, "s1", 1, CENTRE + 1100.0, CENTRE, 0.0)
        .unwrap();
    steps(&mut core, 120);

    assert!(!core.is_alive(1));

    // and it keeps waiting: nothing in the engine revives it, and nothing
    // here does either until the player asks
    steps(&mut core, 600);
    assert!(!core.is_alive(1));

    core.apply_input(1, 2, "down", "respawn");
    steps(&mut core, 1);

    assert!(core.is_alive(1), "the respawn key revives it");
    assert_eq!(
        crystals_of(&core, 1),
        0,
        "and it comes back at the configured starting size"
    );

    // the new body is somewhere inside the disc, not on the rim it died at
    let head = core.position_of(1);
    let dx = head[0] - CENTRE;
    let dy = head[1] - CENTRE;

    assert!(
        (dx * dx + dy * dy).sqrt() < 1280.0,
        "respawned inside the arena, at {head:?}"
    );
}

#[test]
fn a_dead_snake_is_still_a_participant() {
    // players_data() is what invariant 11 (actorLeak) compares against the
    // engine's participant list. The engine was never told the snake died, so
    // leaving the dead out of it would report a leak on the first crash.
    let mut core = make_core(0, 0);

    core.spawn_actor(1, "s1", 1, CENTRE + 1100.0, CENTRE, 0.0)
        .unwrap();
    steps(&mut core, 120);

    assert!(!core.is_alive(1));

    let data = player_data(&core, 1);

    assert!(data.is_array(), "the dead are still listed");
    assert_eq!(
        data.as_array().unwrap().len(),
        16 * 2 + 5,
        "and listed in the schema row shape a joining client decodes"
    );

    // …but they are not in the alive list the camera and the bots read
    assert!(core.alive_players().is_empty());
}

#[test]
fn the_crystal_block_is_a_delta_not_a_re_send() {
    let mut core = make_core(0, 60);

    core.spawn_actor(1, "s1", 1, CENTRE, CENTRE, 0.0).unwrap();
    steps(&mut core, 120);

    core.pack_body().unwrap();

    assert!(
        core.body_has_events(),
        "a crystal delta must put the frame on the reliable channel"
    );

    // the spawn interval is 0.35 s, far longer than one step, so a tick where
    // nothing appeared or was eaten must carry no crystal block at all
    let mut quiet = false;

    for _ in 0..20 {
        core.step(DT);
        core.pack_body().unwrap();

        if !core.body_has_events() {
            quiet = true;

            break;
        }
    }

    assert!(quiet, "an unchanged field must not be re-sent every tick");
}

#[test]
fn a_joining_snake_gets_the_whole_field_re_sent() {
    let mut core = make_core(0, 60);

    core.spawn_actor(1, "s1", 1, CENTRE, CENTRE, 0.0).unwrap();
    steps(&mut core, 120);
    core.pack_body().unwrap();

    // quiesce: drain the deltas accumulated so far
    for _ in 0..20 {
        core.step(DT);
        core.pack_body().unwrap();
    }

    core.spawn_actor(2, "s1", 1, CENTRE - 400.0, CENTRE, 180.0)
        .unwrap();
    core.pack_body().unwrap();

    assert!(
        core.body_has_events(),
        "a newcomer has seen none of the deltas — the field must be re-sent"
    );
}

#[test]
fn one_seed_gives_one_stream_of_frames() {
    let run = || {
        let mut core = make_core(0, 60);

        core.spawn_actor(1, "s1", 1, CENTRE, CENTRE, 0.0).unwrap();
        core.spawn_scripted_actor(2, "s1", 1, CENTRE + 300.0, CENTRE, 180.0)
            .unwrap();
        core.apply_input(1, 1, "down", "right");

        let mut frames = Vec::new();

        for seq in 0..120 {
            core.step(DT);
            frames.push(frame(&mut core, seq));
        }

        frames
    };

    assert_eq!(run(), run(), "the same seed must replay the same match");
}

#[test]
fn serialize_deserialize_round_trips_the_frame() {
    let mut core = make_core(0, 60);

    core.spawn_actor(1, "s1", 1, CENTRE, CENTRE, 0.0).unwrap();
    core.apply_input(1, 1, "down", "right");
    steps(&mut core, 120);

    let saved = core.serialize_state().unwrap();
    let expected = frame(&mut core, 1);

    let mut restored = make_core(0, 60);

    restored.deserialize_state(&saved).unwrap();

    assert_eq!(
        frame(&mut restored, 1),
        expected,
        "a restored core must pack the very same frame"
    );
}

// ***** the arena follows the crowd (plan/snakes-v2 stage 3) *****

/// Every `population` report in the queue, oldest first.
fn population_events(core: &mut GameCore) -> Vec<u64> {
    events(core)
        .into_iter()
        .filter_map(|event| match event {
            CoreEvent::Custom { data } if data["type"] == "population" => {
                data["count"].as_u64()
            }
            _ => None,
        })
        .collect()
}

#[test]
fn the_core_reports_the_population_once_per_change() {
    let mut core = make_core(0, 0);

    // an empty room still reports: the host has nothing to size the arena by
    // until it does
    steps(&mut core, 1);
    assert_eq!(population_events(&mut core), vec![0]);

    core.spawn_actor(1, "s1", 1, CENTRE, CENTRE, 0.0).unwrap();
    core.spawn_actor(2, "s1", 1, CENTRE + 200.0, CENTRE, 180.0)
        .unwrap();
    steps(&mut core, 1);
    assert_eq!(population_events(&mut core), vec![2]);

    // nothing changed: no report, however many steps run
    steps(&mut core, 30);
    assert_eq!(population_events(&mut core), Vec::<u64>::new());

    core.remove_actor(1);
    steps(&mut core, 1);
    assert_eq!(population_events(&mut core), vec![1]);
}

#[test]
fn a_restored_room_reports_its_population_again() {
    let mut core = make_core(0, 0);

    core.spawn_actor(1, "s1", 1, CENTRE, CENTRE, 0.0).unwrap();
    steps(&mut core, 1);
    assert_eq!(population_events(&mut core), vec![1]);

    // the handoff: a fresh host, the same match. Its arena is the catalog map
    // again, so the crowd has to be reported to it from scratch
    let dump = core.serialize_state().unwrap();
    let mut restored = make_core(0, 0);

    restored.deserialize_state(&dump).unwrap();
    steps(&mut restored, 1);

    assert_eq!(population_events(&mut restored), vec![1]);
}

#[test]
fn a_bigger_map_loaded_under_the_match_keeps_every_snake() {
    let mut core = make_core(0, 0);

    core.spawn_actor(1, "s1", 1, CENTRE, CENTRE, 0.0).unwrap();
    steps(&mut core, 60);

    let before = core.position_of(1);

    // twice the cells: the same world coordinates, a disc twice as wide
    core.load_map(&map_json(CELLS * 2, STEP)).unwrap();
    steps(&mut core, 1);

    let after = core.position_of(1);

    assert!(
        (after[0] - before[0]).abs() < 20.0 && (after[1] - before[1]).abs() < 20.0,
        "a resize must not move a snake: {before:?} -> {after:?}"
    );
    assert!(death_event(&mut core).is_none(), "a resize must not kill");
}

#[test]
fn a_snake_left_outside_a_shrunken_arena_dies_the_ordinary_way() {
    let mut core = make_core(0, 0);

    // out by the edge of the current disc, driving along it
    core.spawn_actor(1, "s1", 1, CENTRE + 1100.0, CENTRE, 90.0)
        .unwrap();
    steps(&mut core, 10);
    let _ = events(&mut core);

    // half the cells: the snake is now well outside the disc
    core.load_map(&map_json(CELLS / 2, STEP)).unwrap();
    steps(&mut core, 2);

    let death = death_event(&mut core).expect("the shrink must kill, not strand");

    assert_eq!(death["id"], 1);
    assert!(death["killer"].is_null(), "the edge has no killer");
}

#[test]
fn a_spawn_point_left_outside_the_arena_is_pulled_in() {
    let mut core = make_core(0, 0);

    // the engine hands out the respawn point of the map IT last loaded, which
    // after a shrink is a point of the larger disc
    core.load_map(&map_json(CELLS / 2, STEP)).unwrap();
    steps(&mut core, 1);

    core.spawn_actor(1, "s1", 1, CENTRE + 1100.0, CENTRE, 180.0)
        .unwrap();
    steps(&mut core, 2);

    assert!(
        death_event(&mut core).is_none(),
        "a spawn must not be dead on arrival"
    );

    let position = core.position_of(1);
    let radius = (CELLS / 2) as f32 * STEP / 2.0;
    let centre = radius;
    let distance = ((position[0] - centre).powi(2) + (position[1] - centre).powi(2)).sqrt();

    assert!(distance < radius, "spawned outside the disc: {position:?}");
}
