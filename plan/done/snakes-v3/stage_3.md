# Этап 3: движок — очки игры и предел синхронизации с БД ✅ выполнен

Репозиторий: `/Users/dmitry/Sites/my/vimp/packages/engine` (мастер внутри).
Тесты — в `/Users/dmitry/Sites/my/vimp/tests/{host,master}/`, запуск из
корня монорепо.

Файлы: `src/host/meta/modules/PlayerDataSync.js`, `src/host/HostGame.js`,
`src/host/meta/core/RoundManager.js`, `src/config/lobby.js`,
`src/master/lobby.js`, `src/master/PlayerDataProxy.js`,
`src/master/PlacementCache.js` (новый), `src/config/master.js`.

## 3.1 Общее для всех игр понятие «результат игры»

### Текущее состояние

`PlayerDataSync` (`src/host/meta/modules/PlayerDataSync.js`) держит на
участника запись `{ token, rank, pendingRankDelta, state, rankLoaded,
stateLoaded }` (`:55-64`), тянет `GET /auth/rank` и `/state` в `load()`
(`:51-101`), отдаёт `getRank`/`isRankLoaded`/`getState`, принимает
`addRank(id, delta)` (`:120-127`) и `setState`, синхронизирует `flush(id)`
(`:148-200`) и `flushAll()` (`:203-207`).

Вызывающие `addRank` два: `RoundManager.reportKill`
(`src/host/meta/core/RoundManager.js:635,639` — ±1 за килл) и
`HostGame.addPlayerRank` (`src/host/HostGame.js:1062`).

### Целевое API

```js
// очки ТЕКУЩЕЙ игры участника (жизнь, раунд, матч — что игра называет игрой)
addPoints(participantId, delta)

// игра участника закончилась: накопленное уходит в сумму и в максимум
finishGame(participantId)

// значения для показа: 'day' | 'month' | 'all'
getRating(participantId, period)     // { value, placement, total } | null
isRatingLoaded(participantId)
refreshPlacement(participantId, period)  // точечный перезапрос, троттлинг 30 с
```

Запись участника становится такой (имена важны, на них будут тесты):

```js
{
  token,
  state, stateLoaded, lastSyncedState,   // сериализованный, для сравнения
  ratings: {                              // значения на момент входа + локальные правки
    day:   { value: 0, placement: null, total: 0 },
    month: { value: 0, placement: null, total: 0 },
    all:   { value: 0, placement: null, total: 0 },
  },
  ratingsLoaded: false,
  currentGamePoints: 0,   // очки незавершённой игры
  pendingPoints: 0,       // сумма завершённых игр, ещё не отправленная
  pendingBest: 0,         // лучшая завершённая игра, ещё не отправленная
  placementRefreshedAt: { day: 0, month: 0, all: 0 },
  inFlight: false, flushAgain: false, lastFlushAt: 0,
}
```

`finishGame`:

```js
finishGame(participantId) {
  const entry = this._entries.get(participantId);
  if (!entry || entry.currentGamePoints <= 0) { return; }

  const points = entry.currentGamePoints;

  entry.currentGamePoints = 0;
  entry.pendingPoints += points;
  entry.pendingBest = Math.max(entry.pendingBest, points);

  // локальные значения — чтобы игрок видел правду до синхронизации
  entry.ratings.day.value = Math.max(entry.ratings.day.value, points);
  entry.ratings.month.value += points;
  // all-time НЕ двигаем: он суточный снимок (решение пользователя 5)
}
```

`load()` вместо `GET /auth/rank` тянет три среза одним обращением на
участника: `GET /auth/placement?period=day|month|all` (ответ
`{ placement, total, rank }` даёт и значение, и место). Три запроса на вход
— это дорого; поэтому **добавить на мастере агрегирующий роут**
`GET /auth/placements?game=` (этап 3.3), который делает три обращения к
auth за один поход хоста и кэшируется тем же `PlacementCache`. `GET
/auth/rank` больше не нужен ни хосту, ни лобби.

Совместимость: `addRank` оставить тонким алиасом `addPoints` и пометить
`@deprecated` — `RoundManager.reportKill` продолжает звать его (килл = 1
очко текущей игры), и это правильно: тогда «лучшая игра за день» есть у
любой игры платформы, а не только у snakes.

`RoundManager` должен закрывать игру там же, где сейчас синхронизирует
профили: перед `this._playerDataSync?.flushAll()` (строки 151 и 701)
вызвать `finishGame` для всех участников. Без этого у обычной игры
(с раундами) дневной максимум навсегда останется нулём.

### Прокладки в `HostGame`

Рядом с `getPlayerRank`/`addPlayerRank` (`src/host/HostGame.js:1031-1070`):

```js
addPlayerPoints(gameId, delta)          // → _playerDataSync.addPoints
finishPlayerGame(gameId)                // → _playerDataSync.finishGame
getPlayerRating(gameId, period)         // → getRating
isPlayerRatingLoaded(gameId)            // → isRatingLoaded
refreshPlayerPlacement(gameId, period)  // → refreshPlacement (async)
flushPlayerData({ urgent = false } = {})// → flushAll, см. 3.2
```

`getPlayerRank`/`addPlayerRank`/`isPlayerRankLoaded` остаются как алиасы на
`all`-срез и `addPlayerPoints` — их зовут старые игры, и молчаливая поломка
чужого пакета недопустима.

Чат-команды получают `playerDataSync` прямо в ctx
(`src/host/meta/core/CommandProcessor` → `metaCommands` игры), поэтому
`/rank` игры доберётся до `getRating`/`refreshPlacement` без `vimp`.

## 3.2 Предел синхронизации (решение пользователя 9)

### Что не так сейчас

`flush()` (`:148-200`) шлёт `PUT /auth/rank` **даже при
`pendingRankDelta === 0`** и `PUT /auth/state` **всегда**, а
`flushPlayerData()` — это `flushAll()`, то есть вся комната разом: 32
участника = 64 запроса и ~128 операций в БД в минуту, даже если очки
заработал один человек. Плюс собственного интервала у движка нет вовсе —
им сегодня владеет игра (`FLUSH_INTERVAL_MS` в snakes).

### Правила (все — в движке, игра их обойти не может)

1. **Грязные флаги.** `PUT /rank` уходит только при
   `pendingPoints > 0 || pendingBest > 0`; `PUT /state` — только если
   `JSON.stringify(state) !== entry.lastSyncedState`. После успеха
   `pendingPoints`/`pendingBest` уменьшаются на отправленное (тем же
   приёмом «вычесть после успеха», что и сейчас с `pendingRankDelta`, —
   `addPoints` во время `await` не теряется), `lastSyncedState`
   переписывается.
2. **Одна синхронизация в полёте на участника.** `entry.inFlight` +
   `entry.flushAgain`: повторный вызов во время запроса ставит флаг, а не
   стартует второй запрос; по завершении, если флаг стоит, — один повтор.
3. **Минимальный интервал владеет движок.** Новый блок конфига
   `src/config/lobby.js`:

```js
playerData: {
  rankUrl: '/auth/rank',        // остаётся для совместимости
  stateUrl: '/auth/state',
  placementsUrl: '/auth/placements',
  minFlushInterval: 60000,      // мс на участника
  flushJitter: 0.2,             // ±20 %
  maxRequestsPerSecond: 5,      // потолок очереди на комнату
  backoff: { baseMs: 2000, maxMs: 120000 },
  placementTtl: 30000,          // троттлинг refreshPlacement
},
```

   `flushAll()` из игры — просьба: участник, у которого с прошлой
   синхронизации прошло меньше `minFlushInterval`, пропускается.
   **Срочные границы интервал обходят:** `flushAll({ urgent: true })`,
   уход участника (`HostGame.removeUser`, `:889`) и
   `HostGame.destroy()` (`:635-646`).
4. **Джиттер ±20 %** на интервал каждой комнаты: сотни серверов по круглому
   таймеру дают синхронные пики на мастере.
5. **Очередь с потолком** `maxRequestsPerSecond` на комнату: flush комнаты
   на 32 игрока растягивается на секунды вместо залпа в 64 запроса.
   Простейшая реализация — последовательная отправка с интервалом
   `1000 / maxRequestsPerSecond` мс; `destroy()` ждёт опустошения очереди
   (он уже `await`-ит `flushAll`).
6. **Бэкофф.** На `5xx`/`429`/сетевую ошибку — экспоненциальная пауза
   комнаты от `baseMs` до `maxMs`, сбрасывается первым успехом. Сейчас
   неудача просто повторится следующим flush'ем, и сотня серверов будет
   молотить лежащий сервис синхронно.
7. **Актуальность.** Свои числа игрок видит из локальных значений
   (двигаются в `finishGame` мгновенно); запись в БД гарантирована на уходе
   участника и в `destroy()`; чужие видят изменение с задержкой не больше
   одного интервала. Потерять можно только последний неотправленный
   интервал резко закрытой вкладки-хоста — записать это в документацию как
   известное ограничение.

### Тело `PUT /auth/rank`

```json
{ "points": 640, "best": 400, "hostId": "…", "hostSecret": "…" }
```

`points` — сумма завершённых игр с прошлой синхронизации, `best` —
лучшая среди них. Поле `delta` не отправлять (auth принимает его алиасом
одну версию, этап 2.5).

## 3.3 Мастер

`src/master/lobby.js`, `src/master/PlayerDataProxy.js`, новый
`src/master/PlacementCache.js`, `src/config/master.js`.

1. **ETag на `GET /auth/leaderboard`** (`src/master/lobby.js:321-358`).
   Сейчас там `LeaderboardCache` (TTL `master:leaderboard:cacheTtl`, 15 с)
   и `Cache-Control: public, max-age=15`. Добавить: хеш тела (`crypto`
   `createHash('sha1')` от `JSON.stringify(json)`) в `ETag`, сравнение с
   `req.headers['if-none-match']`, ответ `304` без тела при совпадении.
   Это и есть «не изменилось — не отправляем» на стороне чтения.
2. **`PlacementCache`** — копия `LeaderboardCache.js` по устройству
   (TTL-`Map`, кэшируется только `status === 200`), ключ
   `${sha1(token)}:${game}:${period}`, TTL `master:placement:cacheTtl`
   (**30000**, место меняется медленно, а запрос тяжелее топа — оконная
   функция по леджеру).
3. **Агрегирующий роут `GET /auth/placements?game=`** — один поход хоста
   вместо трёх: внутри три `PlacementCache.get(token, game, period)`,
   ответ `{ day: {...}, month: {...}, all: {...} }`. Им пользуется
   `PlayerDataSync.load()`.
4. **Токен-бакет на `PUT /auth/rank` и `/auth/state` по `hostId`**
   (`registry.verifiedAttribution` уже даёт проверенный hostId): дефолт
   `master:playerData:writesPerMinute = 240` на комнату — с запасом над
   честной комнатой на 32 игрока при минутном интервале, но потолок для
   сломанного или злонамеренного сервера. Превышение → `429` (движок
   уходит в бэкофф, правило 6).
5. **Пер-игровой предел результата.** В `master:games[]` рядом с
   `{ id, package }` появляется необязательное поле `maxGameScore`
   (дефолт 10 000, обоснование — в `stage_2.md`, 2.6). Мастер клампит
   `best` и `points` перед проксированием и логирует превышение: игра,
   присылающая больше, — либо взломана, либо неверно настроена.
6. Необязательно, но это прямой ответ на «серверов сотни»: **склейка**
   `PUT /rank` по ключу `(user, game)` окном ~2 с в одну запись
   (сумма+максимум, как в `finishGame`), атрибуция — от последнего события
   окна.

## Тесты

`/Users/dmitry/Sites/my/vimp/tests/host/PlayerDataSync.test.js` (файл уже
есть, дописать):

- `finishGame` кладёт очки текущей игры в сумму и максимум и обнуляет
  текущую; вторая игра меньше первой — максимум не падает;
- `finishGame` при нулевых очках не делает ничего (пустых записей нет);
- `load()` берёт три среза одним запросом и заполняет `ratings`;
- `getRating('day')` после `finishGame` отдаёт локально обновлённое
  значение, `all` — нет (снимок);
- `refreshPlacement` внутри `placementTtl` второй запрос не делает.

Предел синхронизации — отдельным `describe` (это правило для ВСЕХ игр):

- нулевые `pendingPoints/pendingBest` → `PUT /rank` не уходит;
- неизменившийся state → `PUT /state` не уходит;
- комната из 32 участников, где заработал один, делает **один** `PUT`;
- второй `flushAll()` внутри `minFlushInterval` не порождает запросов, а с
  `{ urgent: true }` — порождает;
- уход участника и `destroy()` синхронизируют независимо от интервала;
- параллельные `flush` одного участника не наслаиваются (`inFlight`), и
  дельта, добавленная во время запроса, уходит следующим;
- `500` от auth включает бэкофф, успех его сбрасывает.

`/Users/dmitry/Sites/my/vimp/tests/master/`:
`PlacementCache.test.js` (новый, по образцу `LeaderboardCache.test.js`),
ETag/`304` в тестах роутов, токен-бакет, кламп `maxGameScore`.

Регресс, который легко упустить: `tests/host/HostGame.rank.test.js` и
`tests/host/RoundManager.test.js` завязаны на `addRank` — они должны
остаться зелёными через алиас.

## Проверка выхода

```bash
cd /Users/dmitry/Sites/my/vimp
npm test -- tests/host tests/master
npx eslint packages/engine
```

## Готово, когда

- «не изменилось — не отправляем» доказано тестом про комнату из 32
  участников с одним заработавшим;
- интервалом владеет движок, срочные границы его обходят;
- мастер отвечает `304` на неизменившийся топ и режет запись по hostId.
