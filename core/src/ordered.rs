//! `IndexMap<u32, T>` in a state dump, as an ORDERED list of `[id, value]`
//! pairs. The derive would write a JSON object, and `serde_json` (built
//! without `preserve_order`) keeps object keys sorted as strings — "15"
//! before "6". The iteration order of snakes, bots and crystals decides who
//! eats a crystal first and in which order the Rng is drawn, so a reordered
//! restore replays a different match.

use indexmap::IndexMap;
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

pub fn serialize<T: Serialize, S: Serializer>(
    map: &IndexMap<u32, T>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    indexmap::map::serde_seq::serialize(map, serializer)
}

/// The same for a borrowed map (`SnakesDump` holds references).
#[allow(clippy::trivially_copy_pass_by_ref)]
pub fn serialize_ref<T: Serialize, S: Serializer>(
    map: &&IndexMap<u32, T>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serialize(*map, serializer)
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Stored<T> {
    Pairs(Vec<(u32, T)>),
    // a dump written before this format: the order is lost already, and
    // ascending ids is the best guess left. The key is read as a String: an
    // untagged enum buffers its input, and a buffered "6" no longer parses
    // as a u32 the way serde_json's own map keys do
    Object(std::collections::BTreeMap<String, T>),
}

pub fn deserialize<'de, T: Deserialize<'de>, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<IndexMap<u32, T>, D::Error> {
    match Stored::deserialize(deserializer)? {
        Stored::Pairs(pairs) => Ok(pairs.into_iter().collect()),
        Stored::Object(object) => {
            let mut pairs = object
                .into_iter()
                .map(|(key, value)| {
                    key.parse::<u32>()
                        .map(|key| (key, value))
                        .map_err(D::Error::custom)
                })
                .collect::<Result<Vec<_>, _>>()?;

            pairs.sort_by_key(|(key, _)| *key);

            Ok(pairs.into_iter().collect())
        }
    }
}
