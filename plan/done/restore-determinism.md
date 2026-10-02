# Детерминизм восстановления из дампа (`serialize`/`deserialize`)

## Контекст

Этап 0 плана миграции хоста движка (`vimp/plan/host-migration/spike-results.md`,
раздел «Корректность восстановления») показал, что ядро, восстановленное через
`deserialize_state`, со временем расходится с исходным. На 57-м шаге после
восстановления лобовое столкновение змей 6 и 15 разрешилось по-разному: в
исходном ядре погибла 15, в восстановленном 6. `debug_json` при этом совпадал,
потому что позиций в нём нет. У tanks такого расхождения нет.

Зачем это нужно: этап 5 плана движка (`gameConfig.migration.midRound`)
продолжает раунд с того же тика. Пока восстановление недетерминировано,
включать `midRound` для snakes нельзя.

## Диагноз (проверен по коду)

**Корневая причина: дамп теряет порядок вставки во всех `IndexMap<u32, _>`.**

1. `SnakesSim::serialize` (`core/src/game.rs`, ~стр. 1504) вызывает
   `serde_json::to_value(SnakesDump { snakes, bots, field, next_color })`.
2. В workspace `Cargo.toml` у `serde_json` нет фичи `preserve_order`
   (`cargo tree -e features -i serde_json` показывает только `default`/`std`).
   Поэтому `serde_json::Value::Object` устроен как `BTreeMap<String, Value>`.
3. `IndexMap<u32, T>` сериализуется как JSON-объект с ключами-строками, и в
   `Value` они **сортируются лексикографически**: `0, 1, 10, 11, …, 19, 2, 20, …`.
   После `deserialize` в `IndexMap` попадает уже этот порядок. В исходном ядре
   змея 6 шла раньше 15, в восстановленном 15 идёт раньше 6. Это совпадает с
   симптомом.
4. Затронуты три коллекции:
   - `SnakesSim.snakes: IndexMap<u32, Snake>` (`game.rs:172`);
   - `SnakesSim.bots: IndexMap<u32, Bot>` (`game.rs:173`);
   - `CrystalField.crystals: IndexMap<u32, Crystal>` (`core/src/crystals.rs:37`).
5. Почему от порядка зависит результат (`on_fixed_step`, `game.rs` ~1150–1378,
   и `on_ai_tick` ~1387):
   - секция 1: `roll_tier`/`drop_at` при сжигании буста берут числа из `ctx.rng`
     в порядке обхода `snakes`. Другой порядок даёт другой поток `Rng`;
   - секция 3: `field.take_at` выдаёт кристалл тому, кто раньше в обходе, а
     внутри `take_at` (`crystals.rs:171`) первым находится кристалл, который
     раньше в `crystals`;
   - секция 4: `kill` (дроп кучи) тратит `rng` в порядке `kills`, а `kills`
     собирается в порядке обхода `snakes`;
   - `revive` вызывается в порядке `revive`, а этот вектор тоже собран обходом
     `snakes`;
   - `on_ai_tick` вызывает `drive_bot` в порядке `bots.keys()`, и
     `drive_bot` тратит `rng` (`timer`, `wander`).

   Итог: с первого шага после восстановления поток `Rng` и выбор кристаллов
   расходятся, позиции разъезжаются, и примерно через 57 шагов это видно на
   столкновении.

6. Почему tanks не страдает: там, по всей видимости, нет `IndexMap` с числовыми
   ключами в дампе или порядок не влияет на `Rng`. Для исправления это не важно.

**Почему не «tie-break по `game_id`»** (вариант из старого плана): от порядка
зависит не одна ничья, а порядок обращений к `Rng` и выбор кристалла в
нескольких местах. Сделать всё это независимым от порядка означает
перепроектировать шаг. Правильное исправление: **сохранять порядок в дампе**.
Лексикографическую сортировку нельзя чинить через `preserve_order`. Эта фича
глобальная, она меняет `serde_json` и в движке. Кроме того, если дамп хоть раз
пройдёт через JS-объект, JS сам пересортирует числовые ключи. Надёжный
формат: **массив пар `[[id, value], …]`**.

**Второстепенные потери (исправить заодно, ради точного совпадения):**

- `since_sweep` (`game.rs:161`) не попадает в дамп. После восстановления
  периодическая чистка `retain_inside` срабатывает на другом шаге. `Rng` она не
  тратит и в норме ничего не находит, но это всё равно скрытое расхождение
  состояния.
- `arena` (`game.rs:152`) и `spawn_slots` (`game.rs:170`) не попадают в дамп.
  Они пересчитываются в начале `on_fixed_step`, но:
  (а) `arena_changed` (~стр. 1100) сравнивает новую арену со старой
  `self.arena`. В восстановленном ядре там арена «свежего» экземпляра, поэтому
  на первом шаге возможен лишний `arena_changed = true`: внеплановая чистка и
  сброс `since_sweep`;
  (б) `spawn_actor`/`find_spawn_from` между `deserialize` и первым шагом
  работают с пустыми `spawn_slots` и чужой ареной.
- `population` намеренно сбрасывается в `usize::MAX`: это поведение, а не баг,
  оно покрыто тестом `a_restored_room_reports_its_population_again`. **Не
  трогать.**
- `cached`/`pending_null` и накопители `CrystalField` (`spawned`/`removed`/
  `resync`) это транзиентные накопители снапшота. Движок пересобирает их через
  `refresh_cached`, а `request_resync()` отправляет поле заново. На симуляцию
  они не влияют. **Не трогать.**
- `rebuild_spatial_grid` (старая гипотеза) не виновата. Сетку очищает и
  наполняет каждый `on_ai_tick`, а в коде snakes решения о столкновениях её не
  читают.

## Затрагиваемые файлы

- `core/src/ordered.rs`: **новый** модуль, сериализация `IndexMap<u32, T>` как
  упорядоченного списка пар;
- `core/src/lib.rs`: строка `mod ordered;` (pub не нужен);
- `core/src/game.rs`: `SnakesDump`/`SnakesDumpOwned`, `serialize`,
  `deserialize`, unit-тесты в `mod tests`;
- `core/src/crystals.rs`: атрибут на `crystals`;
- `core/src/arena.rs`: `Serialize, Deserialize` в derive у `Arena`;
- `core/tests/sim.rs`: интеграционный тест-репродукция;
- `CHANGELOG.md`, `docs/en/core.md`, `docs/ru/core.md`.

## Шаги

### Шаг 1. Тест-репродукция (сначала красный) ✅ выполнен

В `core/tests/sim.rs` рядом с `serialize_deserialize_round_trips_the_frame`
(~стр. 499) добавить тест
`a_restored_core_replays_the_match_step_for_step`. Использовать существующие
хелперы файла: `make_core`, `steps`, `frame`, константы `CENTRE`, `CELLS`,
`STEP`, `DT`.

```rust
#[test]
fn a_restored_core_replays_the_match_step_for_step() {
    // 30 bots: ids 0..29 cover both "2" < "10" orderings a sorted JSON object
    // would swap. Crystals on, so pickups and burns spend the Rng.
    const BOTS: u32 = 30;
    let mut core = make_core(20, 60);

    for id in 0..BOTS {
        let a = id as f32 * std::f32::consts::TAU / BOTS as f32;
        let r = 600.0;
        core.spawn_scripted_actor(
            id, "s1", 1,
            CENTRE + a.cos() * r, CENTRE + a.sin() * r,
            a.to_degrees() + 90.0,
        ).unwrap();
    }

    // ~60 s of play: graces expire, bots eat, boost, crash and respawn
    steps(&mut core, 120 * 60);
    // the dump expects drained snapshot accumulators
    let _ = frame(&mut core, 1);

    let dump = core.serialize_state().unwrap();
    let mut restored = make_core(20, 60);
    restored.deserialize_state(&dump).unwrap();

    for step in 0..600 {
        core.step(DT);
        restored.step(DT);

        for id in 0..BOTS {
            assert_eq!(core.is_alive(id), restored.is_alive(id),
                "step {step}: snake {id} alive state diverged");
            assert_eq!(core.position_of(id), restored.position_of(id),
                "step {step}: snake {id} position diverged");
        }
    }

    assert_eq!(frame(&mut core, 2), frame(&mut restored, 2),
        "the restored core must pack the very same frame");
}
```

Примечания для исполнителя:

- Сигнатуру `spawn_scripted_actor` сверить с её вызовом в
  `a_bot_hunts_crystals_and_grows_on_them` (`sim.rs:314`): `(game_id, model,
team, x, y, angle_deg)`. Модель в фикстуре называется `"s1"`.
- Первый аргумент `make_core`/`config_json` это стартовое число кристаллов,
  второй это `max_crystals` (см. `sim.rs:24`, `:144`). Если 30 ботов на
  стартовом радиусе 600 сразу врезаются друг в друга, увеличить радиус
  (арена 20×128 → радиус ≈1280) или уменьшить число ботов, но **не меньше
  12** (нужны id ≥ 10).
- Для «красного» прогона достаточно, чтобы тест упал до исправления:
  `npm run core:test` (или `cargo test --workspace -q a_restored_core`).
  Если не упал, проверить, что за 60 с действительно были пикапы и смерти (то
  есть что тратился `Rng`), и при необходимости увеличить время.

### Шаг 2. Модуль `core/src/ordered.rs` ✅ выполнен

```rust
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
    // a dump written before this format: order is lost already, ascending
    // ids is the best guess left
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
                .map(|(k, v)| k.parse::<u32>().map(|k| (k, v)).map_err(D::Error::custom))
                .collect::<Result<Vec<_>, _>>()?;
            pairs.sort_by_key(|(k, _)| *k);
            Ok(pairs.into_iter().collect())
        }
    }
}
```

Важно:

- Ключ в старом формате читать **как `String`**, а не как `u32`. В
  `untagged` содержимое буферизуется, и строковый ключ `"6"` уже не
  десериализуется в `u32`. `serde_json` умеет так только без буфера.
- `indexmap::map::serde_seq` доступен: в workspace включена фича `serde`
  (`indexmap = { version = "2.14.0", features = ["serde"] }`).
- Комментарии в Rust-коде пишутся на английском, как во всём `core/`.
- В `core/src/lib.rs` рядом с `pub mod snake;` добавить `mod ordered;`.

### Шаг 3. Применить формат к трём коллекциям ✅ выполнен

`core/src/game.rs`, структуры дампа (~стр. 1556–1571):

```rust
#[derive(Serialize)]
struct SnakesDump<'a> {
    #[serde(serialize_with = "crate::ordered::serialize_ref")]
    snakes: &'a IndexMap<u32, Snake>,
    #[serde(serialize_with = "crate::ordered::serialize_ref")]
    bots: &'a IndexMap<u32, Bot>,
    field: &'a CrystalField,
    next_color: u8,
    since_sweep: u32,
    arena: Arena,
    spawn_slots: &'a [[f32; 3]],
}

#[derive(Deserialize)]
struct SnakesDumpOwned {
    #[serde(deserialize_with = "crate::ordered::deserialize")]
    snakes: IndexMap<u32, Snake>,
    #[serde(deserialize_with = "crate::ordered::deserialize")]
    bots: IndexMap<u32, Bot>,
    field: CrystalField,
    next_color: u8,
    // `default`: a dump written before these fields still loads
    #[serde(default)]
    since_sweep: u32,
    #[serde(default)]
    arena: Option<Arena>,
    #[serde(default)]
    spawn_slots: Vec<[f32; 3]>,
}
```

`core/src/crystals.rs:37`:

```rust
#[serde(with = "crate::ordered")]
crystals: IndexMap<u32, Crystal>,
```

`core/src/arena.rs:20`: в derive добавить `Serialize, Deserialize` (импорт
`use serde::{Deserialize, Serialize};`). Поля `Arena` это `f32`/`[f32; 2]`,
дополнительно ничего не нужно. Проверить, что `serde` уже есть в зависимостях
крейта: он там есть.

### Шаг 4. `serialize`/`deserialize` в `SnakesSim` (`game.rs` ~1504–1534) ✅ выполнен

- `serialize`: заполнить новые поля
  `since_sweep: self.since_sweep, arena: self.arena, spawn_slots: &self.spawn_slots`.
- `deserialize`: после текущих присваиваний добавить
  ```rust
  self.since_sweep = dump.since_sweep;
  if let Some(arena) = dump.arena {
      self.arena = arena;
  }
  self.spawn_slots = dump.spawn_slots;
  ```
  Остальное оставить как есть: сброс `population = usize::MAX`, очистку
  `cached`/`pending_null`, `field.request_resync()`. Обновить комментарий над
  `population`: «арена нового хоста берётся из каталога карт» по-прежнему
  верно, потому что `self.arena` перезапишется на первом шаге из
  `ctx.map`.
- Порядок восстанавливается уже на этапе `serde`, руками ничего сортировать
  не нужно.

### Шаг 5. Unit-тесты формата (`game.rs`, `mod tests`) ✅ выполнен

1. `the_dump_keeps_the_iteration_order`: создать `SnakesSim` (как в
   соседних тестах модуля) или `GameCore` с id `[2, 10, 1, 15, 6]` в таком
   порядке вставки, затем `serialize()` → `deserialize()` в свежий экземпляр и
   проверить, что `snakes.keys()` идут в том же порядке. То же для
   `field.crystals`: можно проверить через `field.iter()` после нескольких
   `drop_at` и `take_at` в середине. Дополнительно проверить, что
   `serialize()["snakes"]` это JSON-**массив**.
2. `a_dump_in_the_old_object_format_still_loads`: вручную собрать
   `serde_json::Value` со `snakes`/`bots`/`field.crystals` в виде объектов
   `{"10": …, "2": …}` и без `since_sweep`/`arena`/`spawn_slots`, затем
   проверить, что `deserialize` проходит, а ключи идут по возрастанию
   (`2, 10`). Значение `Snake` для фикстуры проще всего получить так: взять
   `serialize()` живого ядра, достать элемент массива пар и переложить его в
   объект.

### Шаг 6. Прогон ✅ выполнен

```bash
npm run core:test                 # весь Rust, включая parity-suite
npx prettier --write CHANGELOG.md docs/en/core.md docs/ru/core.md
npx eslint . && npm test -- --silent
npm run core:build && npm run build
```

Детерминизм сценариев (`--determinism` в headless-раннере движка, см.
`docs/en/getting-started.md`) должен остаться зелёным. Формат дампа на
обычную симуляцию не влияет.

### Шаг 7. CHANGELOG и документация ✅ выполнен

- `CHANGELOG.md`, в `## [Unreleased]` добавить:
  ```
  ### Fixed

  - A core restored from `serialize_state` replays the match exactly: snakes,
    bots and crystals keep their order in the dump (a list of `[id, value]`
    pairs instead of a JSON object, whose keys `serde_json` sorted as strings),
    and the sweep counter, the arena and the spawn slots are dumped too.
    Dumps in the old format still load.
  ```
- `docs/en/core.md`, раздел `## Determinism` (~стр. 305): добавить абзац о
  том, что дамп `serialize_state` хранит `IndexMap` как списки пар
  (`core/src/ordered.rs`), потому что объект JSON теряет порядок, а от порядка
  обхода зависят поток `Rng` и выбор кристалла. Восстановленное ядро обязано
  повторять матч шаг в шаг (тест
  `a_restored_core_replays_the_match_step_for_step`).
- `docs/ru/core.md`, раздел `## Детерминизм` (~стр. 294): тот же абзац
  по-русски.
- В таблице `## Tests` у обоих файлов в строку `game.rs` дописать «порядок и
  обратную совместимость дампа».

### Шаг 8. Сообщить в план движка ✅ выполнен

Отметить в `vimp/plan/host-migration/…`, что для snakes восстановление
детерминировано и `migration.midRound` можно включать. Само включение
остаётся отдельным решением и в этот план не входит.

## Критерии готовности

- Тест из шага 1 красный до правок и зелёный после.
- `npm run core:test`, `npx eslint .`, `npm test` зелёные.
- Старый дамп (формат-объект) загружается.
- CHANGELOG и обе версии `core.md` обновлены. Коммит не делать.
