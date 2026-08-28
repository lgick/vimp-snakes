# Расширение игры

Любой рецепт ниже заканчивается одинаково: `npx eslint .`, `npm test`,
`npm run check:contract`, а если менялось что-то в `core/` или `src/data/` —
`npm run core:build && npm run core:test`, затем headless-сценарии (см.
[getting-started.md](getting-started.md#headless-сценарии-npm-run-sim)).

## Новый класс змейки

В игре один класс, `s1`, и ключ модели несущий сразу в четырёх местах: ключ
блока снапшота, опция `model` в форме авторизации,
`gameConfig.scripted.defaultModel` и запись `gameSets`, решающая, какая часть
его рисует.

1. **`src/data/models.js`** — добавьте `s2` с полным набором полей (движение,
   тело, ускорение). Свой блок `world` ему нужен, только если он должен менять
   правила арены; ядро читает `world` с модели той змейки, которую шагает, так
   что два класса с разными `world` в одном матче — противоречие: либо правила
   арены одинаковые, либо класс остаётся один.
2. **`src/config/snapshot.js`** — новый блок с ключом `s2`, **тем же** списком
   полей, что у `s1`, и уникальным `id`.
3. **`src/config/client.js`** — `parts.gameSets.s2 = ['Snake']`.
4. Форма авторизации подхватит опцию сама: `src/config/auth.js` строит
   `options` из `Object.keys(models)`.
5. `npm run core:build` (модель попадает в ядро через init JSON) и
   `npm run check:contract`.

Правка чисел существующей модели схемы не требует — но это **изменение
движения**: запускайте `npm run core:test` (паритет предиктора) и сценарий
`movement.json`.

## Новый тир кристалла

`CRYSTAL_TIERS` в `src/data/palette.js` — единственный источник: `models.js`
импортирует его в `world.tiers`, ядро по нему начисляет, а `Crystal.js`
масштабирует по `radius` печёный самоцвет.

1. Допишите `{ value, radius }` — именно **допишите**: индекс тира едет на
   проводе как `u8`.
2. Добавьте соответствующий вес в `world.tierWeights` в `src/data/models.js`:
   массивы обязаны быть одной длины и одного порядка (ядро это проверяет и
   иначе отвергает конфиг).
3. `npm run core:build`, затем `growth.json` — посмотреть, как он появляется.

## Новый цвет

`SNAKE_COLORS` / `CRYSTAL_COLORS` в `src/data/palette.js`. **Дописывать,
никогда не вставлять**: ядро разыгрывает индекс и шлёт именно его, поэтому
вставка в середину перекрашивает всех уже уехавших на провод змеек. Больше
менять нечего — клиент берёт индекс по модулю длины палитры, так что ядру не
нужно знать её длину.

## Новый звук

1. Положите исходник в `assets/audio-raw/<name>.wav`.
2. `npm run audio:process` (нужен ffmpeg) → `build/sounds/<name>.{webm,mp3}`.
3. Зарегистрируйте в `src/config/sounds.js`:
   `newCue: { file: '<name>', priority, volume }`. Оба кодека обязаны быть —
   `npm run check:contract` падает на неполной паре.
4. Играйте из части через сервис `soundManager`, позиционно:

   ```js
   this._sound?.play('newCue', { x, y });
   ```

   Если части ещё нет в `componentDependencies.soundManager`
   (`src/config/client.js`), добавьте. Через `gameConfig.soundCues` — **не
   надо**: все пять движковых событий здесь `null` намеренно.

Без ffmpeg сборка всё равно работает: `scripts/copy-game-sounds.js`
подкладывает готовые пары из `assets/sounds/`.

## Новая клиентская часть

1. Напишите класс в `src/client/parts/<Name>.js`. Контракт —
   `constructor(data, assets, dependencies, context)`, `update(data)`,
   `destroy()`, наследование от `Container` PixiJS; `data` — массив полей его
   блока снапшота **в порядке схемы**.
2. Экспортируйте из `src/client/parts/index.js`.
3. Зарегистрируйте в `src/config/client.js` — в `gameSets` (какой блок его
   строит) **и** в `entitiesOnCanvas` (на каком канвасе живёт). Второе читает
   фабрика; класс, которого там нет, отвечает «Constructor for X not found» на
   первом же кадре, которому он нужен.
4. Всё, что нужно от движка, объявляется в `componentDependencies`
   (`renderer`, `soundManager`, `assetsBase`, `localPlayer`, `accolades` —
   незнакомое имя молча станет `undefined`).
5. Покройте в `tests/client/parts.test.js`.

Текстуры: **пекарь** лучше картинки. Функцию — в `src/client/bakers/`,
экспорт — в `bakers/index.js`, имя — в `parts.bakedAssets` с `component`,
который получит её в `assets`. Пеките белым и красьте `tint` — именно это
держит шестьдесят кристаллов в одном батче. Картинок пакет не поставляет
вовсе, а `assetsBase` используется только для звуков.

## Знак за место (`accolades`)

Движок раздаёт числа, а как число выглядит — решает игра. `accolades` — пятый
сервис пула зависимостей: `placeOf(id)` отвечает `{ daily, monthly }` — место
сущности в глобальном дневном и месячном топе игры или `null` для всех, кого
там нет (бот, гость, сущность без игрока). Места хост пересчитывает по тому же
публичному топу, что рисует лобби, и рассылает только при изменении, поэтому
знак едет за игроком на любой сервер и пропадает вместе с местом.

Два правила, оба выучены дорого:

1. **Храните сервис, а не ответ.** Части строятся по первому кадру, задолго до
   первых мест, поэтому знак, решённый в конструкторе, отсутствовал бы ровно у
   тех, у кого он есть. Спрашивайте на отрисовке — `src/client/parts/Snake.js`
   зовёт `placeOf` в каждом `update`.
2. **Место — не булево.** `daily` это число или `null`, а `0` местом не
   бывает: сравнивайте с `null`/`undefined`, а не на истинность.

Чтобы добавить свой знак: назовите `accolades` в `componentDependencies` этой
части, испеките текстуру белой, если она нужна (`src/client/bakers/`, см.
`crown.js`), а числа положите в `src/data/theme.js` рядом с `SNAKE.accolade`,
а не в код рисования. Покройте тестом в `tests/client/parts.test.js` с
заглушкой сервиса — оба знака этой игры протестированы именно так.

**Знак не должен выводиться из цвета тела.** Берите `badgeInk(color)` из
`src/client/parts/Snake.js`: он возвращает `[fill, edge]` — более контрастную
из двух постоянных красок и противоположную ей для обводки. Осветление или
затемнение тела — ровно то, из-за чего ромбы были невидимы на белой змейке.
Это связывает и `SNAKE_COLORS`: добавить цвет больше не бесплатно, он обязан
пройти проверки контраста в `tests/client/parts.test.js` (3:1 к обеим краскам
знака) вдобавок к старому правилу «дописывать, но не вставлять» из
`src/data/palette.js`.

## Новая чат-команда

Движок не разбирает ни одной своей команды: `HostPlugin.chatCommands` — весь
набор, который может набрать игрок.

1. Напишите модуль (см. `src/host/botCommand.js` или
   `src/host/metaCommands.js`): `{ name: '/foo', handler(ctx, gameId, args) }`.
   Контекст — `{ participants, chat, scripted, roundManager, voteCoordinator,
   timerManager, playerDataSync, teams, spectatorTeam, spectatorId,
   isDevMode }`.
2. Добавьте в массив `chatCommands` в `src/host/index.js`.
3. Если команда отвечает в чат, заведите код в `src/host/systemMessages.js`
   (группа `g` — движку принадлежат `s`/`v`/`m`/`c`/`n`, а коды сливаются
   слепым `Object.assign`, поэтому код в движковой группе перезапишет
   движковое сообщение без единого слова) и текст **под тем же индексом** в
   `modules.chat.params.messages.g` (`src/config/client.js`).
4. Покройте в `tests/host/`.

## Новая карта

Арена выводится из сетки карты, поэтому вторая карта — это вторая сетка, а не
второй формат геометрии. Добавьте `src/data/maps/<name>.js`, экспортирующий ту
же форму, что производит `buildArena` (`setId`, `scale`, `step`,
`physicsStatic`, `physicsDynamic`, `layers`, `map`, `respawns`),
зарегистрируйте в `src/data/maps/index.js` и убедитесь, что точек респавна не
меньше `roomDefaults.maxPlayers` — иначе `npm run check:contract` уронит
сборку. `npm run build` экспортирует её в `dist/maps/<name>.json`.

Учтите: `src/host/ArenaScaler.js` пересобирает именно **`arena`**
(`buildArena(count)`); второй карте понадобится собственный закон размера или
отказ от масштабирования.

## Изменить, как змейка движется и умирает

Всё это живёт в `core/` и делится между хостом и предиктором:

| Изменение | Где | Затем |
| --- | --- | --- |
| скорость поворота, скорость, кривые роста | `core/src/motion.rs` + `src/data/models.js` | `npm run core:build`, `npm run core:test`, `movement.json` |
| кто кого убивает | `core/src/game.rs` (проход 2 фиксированного шага) | `npm run core:test`, `crash-and-respawn.json`, `growth.json` |
| правила поля кристаллов | `core/src/crystals.rs` + `world` в `models.js` | `npm run core:build`, `growth.json` |
| поведение ботов | `core/src/game.rs`, `drive_bot` | `bots.json` |
| провод | `src/config/snapshot.js` + сборка строк в `game.rs` | `npm run check:contract`, все сценарии |

Единственное изменение, которого стоит избегать, — вынос логики **из**
`motion.rs`: это файл, который делят клиентский предиктор и авторитетный шаг, а
паритетный набор в `core/src/client/predictor.rs` как раз и замечает, что
сдвинулась только одна половина.

---

[← Назад: Конфигурация](configuration.md)
