# План: цвет ника в чате, переименование, хвост при спавне

## Контекст

Три доработки по итогам игры:

1. **Ник в чате бесцветный.** Цвет ника задаёт движок CSS-классом
   `line${teamId}` (`.line`, `.line1..3` в `vimp-engine/src/client/style.css`),
   а игра объявляет одну команду (`teams: { players: 1 }`) — значит все ники
   одного цвета. Цвет змеи же — индекс в `SNAKE_COLORS` (12 цветов), который
   назначает ядро (`next_color`, `core/src/game.rs`). Подменить `teamId`
   нельзя: на нём построены таблица stat и спавн. Сообщение игрока движок
   отправляет сам (`HostGame.pushMessage → chat.push(text, name, teamId)`) —
   игра в этот путь не вмешивается. Значит нужна правка движка.
2. **Имя игры.** В UI сейчас «Vimp Snakes»; по схеме `vimp-tanks` игровое имя
   должно быть коротким («Tank Battle»/«Tanks»), а репо-строки нести бренд
   движка в верхнем регистре («VIMP Tanks»).
3. **Хвост свежей змеи вылезает из круга.** `find_spawn` сэмплит голову с
   отступом `edge_margin` (60), а `lay_out_body` кладёт тело прямо назад на
   `base_length` (150). При радиусе 1280 голова на кольце 1220 даёт хвост на
   1370 — на 90 единиц за краем. Порядка ~23% респаунов. Головной тест
   (`arena.contains(head, radius)`) этого не ловит: змея не гибнет, но
   геометрия нарушена. Виновник — `find_spawn` (респаун после смерти и боты) и
   `clamp_inside(..., edge_margin)`, который сажает точку ровно на худшее
   кольцо.

Порядок работ: пункт 3 (замкнут в `core/`) → пункт 2 (строки) → пункт 1
(движок + релиз).

---

## Пункт 3 ✅ выполнен: тело целиком внутри диска при любом спавне

Всё в `core/src/game.rs` (+ тесты там же).

**Правило:** голова должна отстоять от края не меньше чем на
`edge_margin + длина тела`. Отступ радиальный, поэтому гарантия держится при
**любом** курсе — в том числе когда `find_spawn_from` сохраняет угол,
пришедший от движка, а не `facing_centre`.

1. Новый хелпер рядом с `facing_centre` (~строка 244):

   ```rust
   fn spawn_margin(&self, model: &SnakeConfig) -> f32 {
       self.world.edge_margin + motion::length_for(self.world.start_crystals, model)
   }
   ```

   `motion::length_for` уже существует (`core/src/motion.rs`) — ту же формулу
   использует `lay_out_body`.

2. Провести `margin: f32` параметром через три функции поиска вместо чтения
   `self.world.edge_margin` внутри:
   - `find_spawn` (256) — `arena.random_point(rng, margin)`, и фолбэк на
     `map_points.first()` пропустить через `arena.clamp_inside(point, margin)`;
   - `find_spawn_from` (291) — ранний возврат `requested` только если точка и
     свободна, и `arena.contains([x, y], margin)`; слоты карты, не проходящие
     `contains(..., margin)`, пропускать (не клампить: кламп может посадить на
     чужое тело);
   - `find_spawn_off_slots` (355) — `limit = (radius - margin).max(0.0) * SPAN`.

3. Четыре точки входа считают `margin` до клампа и передают его дальше:
   `spawn_actor` (646, модель уже склонирована), `reset_actor` (714),
   `spawn_scripted_actor` (756), `revive` (489 — модель взять до `find_spawn`,
   `margin` это `f32`, так что заимствование `self.models` снимается сразу и
   борроу-чекер не мешает).

4. Тесты (`core/src/game.rs`, рядом с существующими спавн-тестами ~1617/1714):
   новый тест прогоняет серию `spawn_actor`/`revive` с запросами в углы карты
   и проверяет, что **каждый** узел `snake.path` лежит в
   `arena.contains(node, 0.0)`. Существующие тесты на `RESPAWN_CLEARANCE`
   должны остаться зелёными.

5. Документация: `docs/en/core.md` и `docs/ru/core.md` — раздел про спавн:
   отступ спавна = `edgeMargin + длина тела`, и почему он радиальный. Нового
   конфигурационного ключа нет, `configuration.md` не трогаем.

---

## Пункт 2 ✅ выполнен: «Vimp Snakes» → игровое имя «Snakes», остальное «VIMP Snakes»

Точечные замены, по одной строке в файле:

| Файл | Было | Стало |
| --- | --- | --- |
| `src/config/auth.js:30` | `title: 'Vimp Snakes'` | `title: 'Snakes'` |
| `src/config/game.js:37` | `title: 'Vimp Snakes'` | `title: 'Snakes'` |
| `index.html:6` | `Vimp Snakes — dev` | `VIMP Snakes — dev` |
| `README.md:1` | `# Vimp Snakes` | `# VIMP Snakes` |
| `package.json:4` | `"Vimp Snakes — a VIMP game plugin"` | `"VIMP Snakes — …"` |
| `core/Cargo.toml:3` | `description = "Vimp Snakes — …"` | `"VIMP Snakes — …"` |
| `core/src/lib.rs:1` | `// Vimp Snakes — …` | `// VIMP Snakes — …` |
| `docs/en/configuration.md:29`, `docs/ru/configuration.md:29` | `\| \`title\` \| \`'Vimp Snakes'\` \|` | `'Snakes'` |

`scripts/build-game-manifest.js:160` уже `title: 'Snakes'` — без изменений.
`docs/{en,ru}/README.md` уже «VIMP Snakes» — без изменений. Не трогаем
`plan/**` (история) и `dist/**` (пересобирается). Идентификаторы
(`vimp-snakes`, `@vimp-games/snakes`, `vimp-snakes-core`) не меняются.

---

## Пункт 1 ✅ выполнен (кроме релиза движка): цвет ника в чате = цвет змеи

Опциональное поле цвета в чате движка + поставщик цвета на стороне игры.
Обратная совместимость полная: игра, которая цвет не задаёт, получает
прежний массив из трёх элементов и прежний CSS. `ENGINE_API_VERSION`
остаётся `4`.

### A. Движок (`/Users/dmitry/Sites/my/vimp/packages/engine`)

1. `src/host/meta/player/Participant.js` — поле `this.chatColor = null;`
   рядом с `teamId`.
2. `src/host/meta/player/ParticipantManager.js` — метод
   `setChatColor(gameId, color)`: принимает `#rgb`/`#rrggbb`, всё прочее
   пишет `null`. Это единственная точка, через которую игра задаёт цвет
   (менеджер уже приходит игре в ctx как `participants`).
3. `src/host/meta/modules/chat/Chat.js` — `push(message, name, teamId, color)`;
   четвёртый элемент добавляется в массив **только** если это строка, чтобы
   провод для игр без цвета не менялся.
4. `src/host/HostGame.js:1045` —
   `this._chat.push(message, user.name, user.teamId, user.chatColor)`.
5. `src/client/components/view/Chat.js`, `createLine` — если `message[3]`
   строка, `line.style.setProperty('--chat-name-color', message[3])`.
6. `src/client/style.css:399-413` — в каждом правиле `.lineN:before` цвет
   становится `var(--chat-name-color, <текущий hex>)`, так что цвет команды
   остаётся фолбэком.
7. `src/client/components/model/Chat.js` — обновить комментарий про форму
   массива (`[текст, имя, тип, цвет?]`).
8. Контракт и журнал: `docs/ai/03-host-plugin.md` (API `participants`) и
   `docs/ai/08-gameplay-meta.md` (чат) — описать `setChatColor`;
   `CHANGELOG.md` → `## [Unreleased] / ### Added`, при релизе минорный 0.22.0.
9. Тесты движка, покрывающие `Chat.push` / `HostGame.pushMessage`, дополнить
   случаем с цветом и без него.

### B. Игра (`vimp-snakes`)

1. `core/src/game.rs`, `spawn_actor` (~664, сразу после `let color = …`) —
   новое событие
   `CoreEvent::Custom { data: json!({ "type": "spawn", "id": game_id, "color": color }) }`.
   Боты покрываются автоматически: `spawn_scripted_actor` делегирует сюда.
2. `src/data/palette.js` — экспорт `cssColor(index)`
   (`'#' + SNAKE_COLORS[i % len].toString(16).padStart(6, '0')`). Клиент
   продолжает работать с числами, хост берёт строку отсюда — таблица цветов
   остаётся одна.
3. Новый `src/host/ChatColors.js` по образцу `src/host/StatBridge.js`:
   конструктор `{ participants }`, `onCoreEvent(data)` ловит
   `data.type === 'spawn'` и зовёт
   `participants.setChatColor(String(data.id), cssColor(data.color))`.
   **Id через `String()`** — решение 0 в `CLAUDE.md`.
4. `src/host/createModules.js` — создать модуль и отдать геттером, как
   `getStatBridge`/`getArenaScaler` (ctx `onCoreEvent` содержит только
   `{ vimp, panel }`, поэтому `participants` захватывается здесь).
   `src/host/index.js:79` — добавить `getChatColors()?.onCoreEvent(data);`.
5. `package.json` — `vimp-engine` на `^0.22.0` **после релиза движка**;
   единственный незакрытый шаг. Локально ничего линковать не потребовалось:
   `node_modules/vimp-engine` — жёсткие ссылки на файлы
   `/Users/dmitry/Sites/my/vimp/packages/engine`, правка движка видна сразу.
   Вызов `setChatColor` необязательный (`?.`), поэтому на 0.21 игра работает
   с ником цвета команды.
6. Тесты: юнит на `ChatColors` с поддельным `participants`; в `core/` — что
   `spawn_actor` кладёт событие `spawn` с индексом цвета.
7. Документация: `docs/{en,ru}/architecture.md` (новый host-модуль и цепочка
   ядро → хост → чат), `docs/{en,ru}/gameplay.md` (ник в чате красится
   цветом змеи), `docs/{en,ru}/core.md` (новое custom-событие `spawn`).

---

## Проверка

```bash
npm run core:build && npm run core:test   # пункт 3 + новое событие
npm run check:contract && npm run sim
npm test && npx eslint .
```

В движке — его собственный набор тестов и линт.

Живая проверка (после `npm link vimp-engine` и `npm run build`):

- комната на двух игроков + `/bot 3`: ник каждого в чате того же цвета, что
  его змея; системные сообщения остались красными;
- смерть и `r` десяток раз подряд у самого края — хвост свежей змеи ни разу
  не выходит за окружность;
- экран авторизации и лобби показывают «Snakes», вкладка dev-страницы —
  «VIMP Snakes — dev».

После утверждения план кладётся в `plan/` репозитория (правило 2
глобального `CLAUDE.md`) и по мере выполнения помечается «✅ выполнен».


---

## Что осталось

Только релизный шаг: выпустить `vimp-engine` 0.22.0 (запись уже лежит в
`## [Unreleased]` его `CHANGELOG.md`) и поднять зависимость в `package.json`
этой игры до `^0.22.0`. До этого цвет ника работает локально через жёсткие
ссылки в `node_modules`, а на опубликованной 0.21 деградирует до цвета
команды.

## Проверено

- `npm run core:build`, `npm run core:test` — 85 + 18 тестов зелёные (новые:
  `a_fresh_body_never_hangs_out_of_the_arena`,
  `a_spawn_tells_the_host_the_colour_it_handed_out`);
- `npm run check:contract`, `npm run build`, все шесть сценариев
  `npm run sim -- --scenario … --determinism` — без падений;
- `npm test` (152 теста, новый `tests/host/chatColors.test.js`), `npx eslint .`;
- движок: 1709 тестов и eslint зелёные, новые случаи в
  `tests/host/Chat.test.js` и `tests/host/ParticipantManager.test.js`.
