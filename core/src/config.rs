//! The game half of the init JSON (the engine half is
//! `vimp_engine_core::config`): snakes, keys, panel. Both cores get one string
//! of the shape `{engine: {...}, game: {...}}` — `engine` is parsed by the
//! engine crate, `game` by the structs below.
//!
//! The unit of the fixed step differs between the halves **on purpose**, and
//! the field names say so: the host gets `timeStep` in SECONDS
//! (`EngineConfig`), the client gets `timeStepMs` in MILLISECONDS
//! (`EngineClientConfig`). Do not "fix" one of them.
//!
//! Note where the world rules live: nested under the snake model, because the
//! engine assembles the `game` half from a FIXED field set — `friendlyFire`,
//! `models`, `weapons`, `playerKeys`, `panel` — and a free-form
//! `gameConfig.parts.*` key reaches the client config and never the core. See
//! the same note in `src/data/models.js`.

use indexmap::IndexMap;
use serde::Deserialize;

/// One entry of `gameConfig.playerKeys`: the bit of the key and its kind —
/// `0` held, `1` one-shot (consumed by exactly one fixed step).
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyConfig {
    pub key: u32,
    #[serde(default, rename = "type")]
    pub kind: u8,
}

/// Start value of a panel field (`gameConfig.panel.fields`).
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelValue {
    pub value: f64,
}

/// One crystal size (`world.tiers`, mirrored from `src/data/palette.js`).
/// `value` is both the crystals gained and the score awarded — one number by
/// design, the stat table sums it.
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrystalTier {
    pub value: u32,
    pub radius: f32,
}

/// Rules of the crystal field and of the arena. One instance per match; it is
/// read off the single snake model (see the module note).
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldConfig {
    pub max_crystals: usize,
    /// Seconds between natural spawns while below `max_crystals`.
    pub spawn_interval: f32,
    /// Relative weights of `tiers`, same order and same length.
    pub tier_weights: Vec<f32>,
    pub tiers: Vec<CrystalTier>,
    /// Fraction of its crystals a dead snake gives back to the map.
    pub drop_ratio: f32,
    /// World units a natural spawn keeps clear of the arena edge.
    pub edge_margin: f32,
    pub start_crystals: u32,
}

/// One snake class (`src/data/models.js`).
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnakeConfig {
    /// World units per second. A snake never stops.
    pub base_speed: f32,
    /// Speed multiplier while `boost` is held.
    pub boost_factor: f32,
    /// Turn rate (radians per second).
    pub turn_speed: f32,

    /// Half-thickness at zero crystals.
    pub base_radius: f32,
    /// `radius = base_radius + radius_gain * sqrt(crystals)`.
    pub radius_gain: f32,
    /// Body polyline length at zero crystals.
    pub base_length: f32,
    pub length_per_crystal: f32,
    /// Spacing of the dense path history kept by the core.
    pub point_spacing: f32,

    pub boost_drain_per_second: f32,
    pub boost_min_crystals: u32,

    pub world: WorldConfig,
}

/// Snakes have no weapons. The type exists because `parts.weapons` is one of
/// the nine paths the engine asserts and it is shipped into both cores — the
/// map is always empty and nothing reads it.
#[derive(Clone, Deserialize)]
pub struct WeaponConfig {}

/// The `game` half of the host init JSON (`GameCore::new`) — assembled by the
/// engine in `buildCoreConfig` from `HostPlugin.gameConfig`, so the field set
/// below is fixed by the engine, not by the game.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnakesConfig {
    #[serde(default)]
    pub friendly_fire: bool,
    pub models: IndexMap<String, SnakeConfig>,
    #[serde(default)]
    pub weapons: IndexMap<String, WeaponConfig>,
    pub player_keys: IndexMap<String, KeyConfig>,
    /// Start values of the panel: `crystals`, `length`, `dead`.
    pub panel: IndexMap<String, PanelValue>,
}

/// Panel field names the core writes. They are looked up by these exact
/// strings in `gameConfig.panel.fields`, so a rename there without a rename
/// here produces a panel value the client receives under the name `undefined`
/// — which invariant 6 (`panelContract`) is there to catch.
pub const PANEL_CRYSTALS: &str = "crystals";
pub const PANEL_LENGTH: &str = "length";
pub const PANEL_DEAD: &str = "dead";

impl SnakesConfig {
    /// Everything that must hold before the first tick. A crystal table whose
    /// weights and tiers disagree, or a panel missing a field the core writes,
    /// fails silently at runtime — as a wrong tier rolled forever, or as a HUD
    /// cell that never updates.
    pub fn validate(&self) -> Result<(), String> {
        if self.models.is_empty() {
            return Err("models is empty: there is no snake to spawn".to_string());
        }

        for key in [PANEL_CRYSTALS, PANEL_LENGTH, PANEL_DEAD] {
            if !self.panel.contains_key(key) {
                return Err(format!(
                    "panel field '{key}' is missing: the core writes it every match"
                ));
            }
        }

        for (name, model) in &self.models {
            let world = &model.world;

            if world.tiers.is_empty() {
                return Err(format!("model '{name}': world.tiers is empty"));
            }

            if world.tiers.len() != world.tier_weights.len() {
                return Err(format!(
                    "model '{name}': world.tiers has {} entries, tierWeights has {}",
                    world.tiers.len(),
                    world.tier_weights.len()
                ));
            }

            if world.tier_weights.iter().sum::<f32>() <= 0.0 {
                return Err(format!("model '{name}': world.tierWeights sum to zero"));
            }

            if model.point_spacing <= 0.0 {
                return Err(format!("model '{name}': pointSpacing must be positive"));
            }
        }

        Ok(())
    }
}

/// The `game` half of the client init JSON (`ClientCore::new`) — assembled by
/// the engine in `buildClientCoreConfig` from `CONFIG_DATA.prediction`.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnakesClientConfig {
    pub models: IndexMap<String, SnakeConfig>,
    #[serde(default)]
    pub weapons: IndexMap<String, WeaponConfig>,
    pub player_keys: IndexMap<String, KeyConfig>,
    /// Seed of the local PRNG. Deliberately NOT synchronised with the host:
    /// nothing the client rolls is authoritative.
    #[serde(default = "default_seed")]
    pub seed: u64,
}

fn default_seed() -> u64 {
    0x5644_4d49_5056_494d
}

/// Root init JSON of `GameCore::new`.
#[derive(Clone, Deserialize)]
pub struct RootConfig {
    pub engine: vimp_engine_core::config::EngineConfig,
    pub game: SnakesConfig,
}

/// Root init JSON of `ClientCore::new`.
#[derive(Clone, Deserialize)]
pub struct RootClientConfig {
    pub engine: vimp_engine_core::config::EngineClientConfig,
    pub game: SnakesClientConfig,
}

#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;

    pub fn model_json() -> serde_json::Value {
        serde_json::json!({
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
                "maxCrystals": 60,
                "spawnInterval": 0.35,
                "tierWeights": [70.0, 25.0, 5.0],
                "tiers": [
                    { "value": 1, "radius": 8.0 },
                    { "value": 3, "radius": 13.0 },
                    { "value": 8, "radius": 20.0 }
                ],
                "dropRatio": 0.8,
                "edgeMargin": 60.0,
                "startCrystals": 0
            }
        })
    }

    pub fn model() -> SnakeConfig {
        serde_json::from_value(model_json()).unwrap()
    }

    pub fn config() -> SnakesConfig {
        serde_json::from_value(serde_json::json!({
            "friendlyFire": false,
            "models": { "s1": model_json() },
            "weapons": {},
            "playerKeys": {
                "left": { "key": 1 },
                "right": { "key": 2 },
                "boost": { "key": 4 },
                "respawn": { "key": 8, "type": 1 }
            },
            "panel": {
                "crystals": { "value": 0.0 },
                "length": { "value": 0.0 },
                "dead": { "value": 0.0 }
            }
        }))
        .unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::config;
    use super::*;

    #[test]
    fn the_reference_config_validates() {
        assert!(config().validate().is_ok());
    }

    #[test]
    fn a_panel_without_the_crystal_field_is_refused() {
        let mut cfg = config();

        cfg.panel.shift_remove(PANEL_CRYSTALS);

        let err = cfg.validate().unwrap_err();

        assert!(err.contains(PANEL_CRYSTALS), "{err}");
    }

    #[test]
    fn tier_weights_must_match_tiers() {
        let mut cfg = config();

        cfg.models["s1"].world.tier_weights.pop();

        let err = cfg.validate().unwrap_err();

        assert!(err.contains("tierWeights"), "{err}");
    }
}
