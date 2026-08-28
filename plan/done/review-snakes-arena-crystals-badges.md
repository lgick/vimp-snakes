# Ревью плана `snakes-chat-color-rename-spawn` и исправление трёх дефектов

Статус: **✅ выполнен** (2026-08-28).

Все три дефекта из ревью подтверждены по коду и исправлены. Порядок работ был
2 → 3 → 1, как и предписано ревью: дефект 3 — следствие дефекта 2.

## Проблема 2. Змея за пределами круга — ✅ выполнен

Подтверждено всё три причины.

- **Шаг 2.1 ✅** `core/src/game.rs`: `reseat_stranded()` — в начале
  `on_fixed_step`, сразу после обновления `self.arena` и `self.spawn_slots` и
  до секции 1. Пересаживает живых змей в grace, чьё тело не целиком внутри
  диска; остаток грейса отдаётся обратно нетронутым (`Snake::grace_left()`,
  новый геттер в `core/src/snake.rs`). Закрывает и 2A (спавн по устаревшей
  арене), и 2B (сжатие поверх замороженной змеи).
- **Шаг 2.2 ✅** Три копипаста margin сведены в `spawn_margin_of(game_id)` /
  `spawn_margin_for(model_name)`; фолбэк при неизвестной модели —
  `widest_spawn_margin()`, а не голый `edge_margin`. Ранний возврат
  `find_spawn_from` при `radius <= 0` оставлен, в комментарии зафиксировано,
  что страховкой служит `reseat_stranded`.
- **Шаг 2.3 ✅** `src/host/ArenaScaler.js`: `_delivered` ключуется по
  `socketId`, прунинг безусловный на каждом `_broadcast`.
- **Шаг 2.4 ✅ (с отступлением от буквы плана)** В движке
  `RoundManager.overrideMapData` подменяет ОБЕ копии: `_currentMapData` (её
  отдаёт `sendMap` подключающемуся) и `_scaledMapData` — через
  `scaleMapData()`. Буквальная правка из плана (`sendMap` отдаёт
  `_scaledMapData`) неверна для движка в целом: клиент масштабирует карту сам
  (`client/main.js`, applyMapData), и при `mapScale !== 1` карта была бы
  умножена дважды. Для snakes (`scale: 1`) поведение то же.
  `CHANGELOG.md` → `[Unreleased] / Fixed`, `docs/ai/03-host-plugin.md` и
  сигнатура в `docs/{en,ru,_ru}/host.md` обновлены. `ENGINE_API_VERSION` не
  менялся.
- **Шаг 2.5 ✅** Тесты: `a_spawn_on_a_stale_arena_is_reseated_on_the_next_step`,
  `a_grace_snake_caught_by_a_shrink_is_reseated_not_stranded` (Rust);
  «не принимает переиспользованный gameId за уже обслуженного клиента»
  (`tests/host/arenaScaler.test.js`); в движке — три случая в
  `tests/host/RoundManager.test.js`, включая `sendMap` после `overrideMapData`.

## Проблема 3. Недостижимые кристаллы — ✅ выполнен

- **Шаг 3.1 ✅** `CrystalField::drop_at` принимает `&Arena` и подтягивает точку
  внутрь диска (`clamp_inside(point, edge_margin)`). Оба вызова обновлены;
  `SnakesSim::kill` получил параметр `arena: &Arena`.
- **Шаг 3.2 ✅** `retain_inside` вызывается и по `arena_changed`, и раз в
  `SWEEP_EVERY_STEPS = 120` шагов (счётчик `since_sweep`).
- **Шаг 3.3 ✅** Тесты: `a_drop_outside_the_disc_is_pulled_in`
  (`core/src/crystals.rs`), `a_death_at_the_boundary_leaves_no_unreachable_crystals`
  (`core/src/game.rs`).
  Сценарий с проверкой «все кристаллы внутри» **не добавлен**: формат
  `scenarios/*.json` не содержит языка утверждений (только `divergence` и набор
  инвариантов раннера, который живёт в репозитории движка). Свойство закрыто
  Rust-тестами; все шесть существующих сценариев проходят с `--determinism`.

## Проблема 1. Скины топ-10 на светлых змеях — ✅ выполнен

- **Шаги 1.1–1.4 ✅** В `src/client/parts/Snake.js` — экспортируемые
  `luminance`, `contrast`, `badgeInk`; `lighten` удалён за ненадобностью.
  В `src/data/theme.js` `diamondLighten` заменён на `inkDark`/`inkLight`/
  `diamondStroke`/`crownOutline`/`crownOutlineScale`. Ромбы заливаются краской
  и обводятся антиподом; корона — два спрайта одной текстуры (тёмный силуэт
  под золотым).

  **Отступление от буквы плана:** порог светлоты 0.5 из шага 1.1 не даёт
  обещанных 3:1. Проверка по палитре: `pink` (L = 0.33) попадает в «тёмные» и
  получает белила с контрастом 2.71. `badgeInk` выбирает ту краску, что
  контрастнее, — минимум по палитре 4.06 (`indigo`).
- **Шаг 1.5 ✅** Четыре случая в `tests/client/parts.test.js`: контраст ромбов
  и силуэта короны по всей `SNAKE_COLORS`, два спрайта короны и их видимость.

## Прочие замечания ревью

1. **✅** `request_resync()` убран из `revive`, оставлен в `spawn_actor` /
   `reset_actor`; причина зафиксирована в комментарии. `crash-and-respawn.json`
   проходит.
2. **✅** DRY margin — см. шаг 2.2.
3. **Не подтверждено, правка не нужна.** `ChatColors` действительно не снимает
   цвет, но `Participant` создаётся с `chatColor = null`
   (`packages/engine/src/host/meta/player/Participant.js`), а `remove()`
   выбрасывает участника целиком — новый игрок на переиспользованном gameId
   получает новый объект и наследовать чужой цвет не может.
4. **✅** В шапку `src/host/ChatColors.js` дописано, что боты красятся тоже и
   почему это намеренно.
5. **✅** `find_spawn_off_slots` больше не имеет выхода без проверки: ветка
   `None` возвращает `facing_centre(arena.centre)`, параметр `requested` удалён
   за ненадобностью.
6. **✅** Формула диска приведена к одной формулировке
   `radius = min(cols, rows) * step / 2` в `core/src/arena.rs`,
   `src/data/maps/arena.js` и `src/client/parts/Arena.js`.

## Документация — ✅ выполнен

`docs/{en,ru}/core.md` (спавн по устаревшей арене и `reseat_stranded`;
инвариант «кристалл никогда не за диском»; ресинк только на входе),
`docs/{en,ru}/architecture.md` (`_delivered` по socketId, карта в силе для
вошедшего), `docs/{en,ru}/gameplay.md` и `docs/{en,ru}/extending.md` (краски
бейджей и обязательная проверка контраста для нового цвета палитры).

## Проверка

`npm run core:build`, `npm run core:test` (107), `npm run check:contract`,
`npm test` (157) и `npx eslint .` — зелёные. `npm run build` собран, все шесть
сценариев проходят с `--determinism`. В движке — `npm test` (1711) и линт.
