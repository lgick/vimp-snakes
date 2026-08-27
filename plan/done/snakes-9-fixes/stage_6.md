# Этап 6 — колонки stat/panel (пункт 6) ✅ выполнен

## Требование

В stat — только `Name`, `Rank`, `Score`, `Ping`. В panel — только `Score`.

## Зависимости

Требует этапа 4 (формула `score` устоялась) и этапа 5 (ранг вообще меняется).

## Откуда StatBridge берёт ранг

Контекст `onCoreEvent` — это `{ vimp, panel }`, `playerDataSync` там нет. Но
`vimp.getPlayerRank(gameId)` уже существует (`HostGame.js:1014`) и ничего
нового в движке не требует. Значит `_publish` должен получать `vimp` — сейчас
он принимает `(gameId, record, panel)`, добавить четвёртым аргументом.

## Изменения

- **`src/config/game.js`**:
  - `stat` — убрать `eaten` и `kills`; состав становится `name`(0),
    `status`(1), `rank`(2), `score`(3), `latency`(4). `key` пронумеровать
    заново по порядку колонок.
  - `rank` объявить с `bodyMethod: '='`, `bodyValue: 0`; агрегат в шапке
    (`headMethod: '+'`) для ранга бессмысленен — оставить без `headMethod`,
    как у `status`/`latency`.
  - `status` остаётся: движок пишет в неё сам на сменах команды.
  - `panel.fields` — убрать `eaten` и `kills`. Остаются `score` (видимая),
    плюс служебные `crystals`, `dead` (сигнал для оверлея результата,
    `src/client/gameOver.js`). Это не «лишние поля» в смысле запроса: они не
    показываются, а инвариант 6 (panelContract) требует, чтобы клиент назвал
    каждое хостовое поле.
  - обновить комментарии над `panel` и `stat` — они сейчас перечисляют
    «четыре числа» и «шесть колонок».
- **`src/config/client.js`**:
  - `modules.stat.params.columns` → `['snake', 'status', 'rank', 'score',
    'ping']`;
  - `sortList.players` → сортировка по `score` (индекс 3) убыв.; вторым
    ключом взять `rank` (индекс 2) убыв. — `eaten` в таблице больше нет, а
    прежний тай-брейк ссылался именно на него;
  - `modules.panel.keys` — убрать `e`/`k`; `modules.panel.fields` — убрать
    `panel-eaten`/`panel-kills`, оставить `score`, `crystals`, `dead`,
    `mode`, `time`.
- **`src/host/StatBridge.js`**:
  - `_publish` перестаёт писать `eaten`/`kills` в stat и в panel;
  - пишет `rank`, читая `vimp?.getPlayerRank?.(gameId)` в момент публикации;
    `undefined`/`null` не писать вовсе, иначе ячейка покажет пустоту вместо
    прошлого значения;
  - счётчики `eaten` и `kills` в `_totals` **остаются** — `eaten` нужен
    формуле score и профилю (`_recordBest`), `kills` нужен формуле
    `kills * KILL_BONUS`; просто перестают публиковаться.
- **`src/client/style.css`** — блок ширин `nth-child(1..6)`
  (`style.css:56-77`) рассчитан на шесть колонок. Колонок становится пять,
  что совпадает со стандартной раскладкой движка, — переопределение можно
  убрать целиком; заодно удалить `#panel-eaten::before` и
  `#panel-kills::before` и перенести `eaten`/`kills` из списка скрытых.
  Проверить, что инвариант C6 (statColumns) при пяти колонках не требует
  escape-hatch.

## Тесты

- `tests/config/contract.test.js` — число и порядок колонок stat,
  соответствие `panel.fields` ↔ `gameConfig.panel.fields` (инвариант 6),
  сортировка.
- `tests/host/statBridge.test.js` / `statBridge.integration.test.js` — новый
  набор публикуемых полей; `rank` пишется из `vimp.getPlayerRank`; отсутствие
  метода на `vimp` не роняет публикацию.

## Проверка

```bash
npx eslint . && npm test
npm run check:contract
npm run build
```

Ручная: `npm run dev` — stat показывает пять колонок, panel — только Score.
