# Этап 1: ядро — буст возвращает событие `burn`

Репозиторий: `/Users/dmitry/Sites/my/vimp-snakes`, только каталог `core/`.
Решение пользователя 2: ускорение сжигает кристаллы и вычитает их из score.

## Зачем

Ядро сообщает хосту о подобранных кристаллах, но о сожжённых не сообщает
ничем. `Snake::step` (`core/src/snake.rs:281-327`) списывает кристаллы в
цикле буста и складывает координаты россыпи в `StepOutcome::burned`
(`core/src/snake.rs:58-59`), а `SnakesSim` их только рассыпает по карте.
Из-за этого:

- хост не знает о трате и не может уменьшить `score`;
- ячейка кристаллов в панели во время буста врёт: `push_vitals`
  (`core/src/game.rs:220`) при сжигании не зовётся.

## Текущий код

`core/src/game.rs`, блок «***** 1. движение *****», ~строки 967-973:

```rust
let outcome = snake.step(dt, model, &bits);

for spot in outcome.burned {
    let tier = roll_tier(ctx.rng, &world);

    self.field.drop_at(spot, tier, ctx.rng, &world);
}
```

Ниже в том же цикле — `if outcome.mode_changed { … }`; частичный перенос
поля `burned` этому не мешает (`mode_changed` — `bool`, `Copy`).

Образец события подбора, ~строки 1075-1092 (тот же файл), на него нужно
равняться по форме:

```rust
Self::push_vitals(ctx.events, *id, snake, model);

ctx.events.push(CoreEvent::Custom {
    data: json!({
        "type": "crystals",
        "id": *id,
        "total": snake.crystals,
        "gained": value,
    }),
});
```

## Шаги

1. Перед циклом россыпи взять длину: `let burned = outcome.burned.len();`
   — цикл потребляет вектор, после него длину не спросить.
2. После цикла, если `burned > 0`:

```rust
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
```

3. **Отдельный тип события, а не отрицательный `gained`.** У события
   `crystals` `gained` положителен по контракту; на этом стоят тесты
   (`tests/host/statBridge.test.js`) и ветка `_onCrystals`
   (`src/host/StatBridge.js:152`). Отрицательное значение сломало бы обе
   стороны молча.
4. `core/src/motion.rs` НЕ трогать: сжигание живёт в `snake.rs::step`,
   а `motion.rs` общий для хоста и предиктора — правка там рассинхронизует
   предсказание (`core/src/client/predictor.rs`, паритет-сьют).
5. Клиентский предиктор править не нужно: он не считает кристаллы, а
   события `Custom` до него не доходят.

## Тест

В `core/src/game.rs`, в существующий `mod tests` (рядом с
`the_boost_byte_carries_the_boost_in_bit_0_and_the_grace_in_bit_1`,
~строка 1741) — тест в том же стиле:

- собрать симуляцию с одной змеёй, выдать ей кристаллов заведомо больше
  `boost_min_crystals`;
- прогнать шаги с зажатым бустом на секунду
  (`boost_drain_per_second = 6` в `src/data/models.js`, в фикстуре ядра
  своё значение — брать из фикстуры);
- собрать из событий все `Custom` с `type == "burn"`;
- проверить: сумма `burned` равна убыли `crystals`, а `total` последнего
  события равен текущему `snake.crystals`.

Отдельно убедиться, что при езде без буста ни одного `burn` не приходит.

## Проверка выхода

```bash
cd /Users/dmitry/Sites/my/vimp-snakes
npm run core:test        # cargo test --workspace
npm run core:build       # ОБЯЗАТЕЛЬНО: пересобирает pkg-web и pkg-node
npm test                 # tests/core/nodeCore.test.js идёт по pkg-node
```

Без `core:build` тесты и dev-сборка молча работают со старым wasm — это
самая частая ловушка в этом репозитории.

## Готово, когда

- `npm run core:test` зелёный, новый тест на `burn` в нём есть;
- `npm run core:build` выполнен;
- `npm test` и `npx eslint .` зелёные (хост ещё не обрабатывает `burn` —
  неизвестный `type` игнорируется в `default` ветке
  `StatBridge.onCoreEvent`, это нормально до этапа 5).
