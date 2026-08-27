# Этап 2 — повороты длинной змеи теряют пластичность (пункт 3) ✅ выполнен

## Требование

Чем длиннее змея, тем хуже она поворачивает. Сейчас `turnSpeed` — константа
`3.4` рад/с (`src/data/models.js:31`), независимо от длины и кристаллов.

Формула (решение пользователя):

```
turn_speed(c) = max(1.4, 3.4 - 0.18 * sqrt(c))

  c=0   -> 3.40   (ровно как сейчас — старые тесты остаются зелёными)
  c=25  -> 2.50
  c=100 -> 1.60
  c=200 -> 1.45
```

По духу это то же, что `radius_for`/`length_for` в `core/src/motion.rs`
(рост по `sqrt(crystals)`), но на убывание к полу.

## Изменения

- **`src/data/models.js`** — оставить `turnSpeed: 3.4` как базу, добавить
  `turnSpeedFalloff: 0.18` и `turnSpeedMin: 1.4`. Имя `turnSpeed` НЕ
  переименовывать: меньше задетых фикстур и тестов, а смысл «база» читается
  из соседей.
- **`core/src/config.rs`** — `SnakeConfig`: поля `turn_speed_falloff`,
  `turn_speed_min`; фикстуры обновить.
- **`core/src/motion.rs`** — новая `pub fn turn_speed_for(crystals: u32, model:
  &SnakeConfig) -> f32` рядом с `radius_for`/`length_for`. `step_angle`
  (`motion.rs:53`) сейчас берёт `model.turn_speed` напрямую — сделать явный
  параметр `max_turn: f32` вместо чтения из модели: у `step_angle` уже два
  вызывающих (хост и предиктор), и явный параметр не даёт им разойтись
  молча.
- **`core/src/snake.rs`** (`Snake::step`) — считает `turn_speed_for(self
  .crystals, model)` и передаёт в `step_angle`.
- **`core/src/client/predictor.rs`** — то же самое, из `crystals` серверного
  кадра (слот 4).

## Тесты

- `core/src/motion.rs` — юнит-тесты `turn_speed_for`: монотонно падает с
  ростом кристаллов, не опускается ниже `turn_speed_min`, при `c = 0` равна
  базе.
- `core/src/snake.rs` — существующие тесты поворота остаются зелёными
  (`crystals = 0` ⇒ прежний `turn_speed`).
- `core/src/client/predictor.rs::mod parity` — новые кейсы: короткая змея
  поворачивает быстро, длинная медленнее, обе половины совпадают.

## Проверка

```bash
npm run core:build && npm run core:test
npx eslint . && npm test
npm run build
```

Сценарии `movement` и `pointer` с `--determinism` (оба следят за дрейфом
предсказания — именно они ловят правку движения, применённую к одной
половине). Ручная: `npm run dev`, откормиться и сравнить отклик A/D.
