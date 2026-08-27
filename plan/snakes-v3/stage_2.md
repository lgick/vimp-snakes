# Этап 2: auth — леджер результатов, три агрегации, суточный снимок

Репозиторий: `/Users/dmitry/Sites/my/vimp/packages/auth`.
Тесты этого пакета лежат в `/Users/dmitry/Sites/my/vimp/tests/auth/`
и запускаются из корня монорепо (`npm test`), а не из пакета.

Файлы: `src/UserRepository.js`, `src/main.js`, `src/lib/validators.js`,
`src/config/auth.js`, `src/db/migrations/007_game_results.sql` (новый),
`src/db/ratingsJob.js` (новый), `package.json` (скрипт), тест
`/Users/dmitry/Sites/my/vimp/tests/auth/UserRepository.test.js`.

## Зачем

Сегодня все три среза считаются ОДНИМ способом — суммой дельт по леджеру
`rank_events` (`src/UserRepository.js:158-197` — `getLeaderboard`,
`:199-250` — `getPlacement`, окна через `periodStart`, `:32-42`). Нужны три
разные агрегации: `MAX` за день, `SUM` за месяц, суточный снимок за всё
время. Значит леджер должен хранить результат игры, а не дельту ранга.

## 2.1 Миграция `007_game_results.sql`

Формат — как у соседних файлов (`migrate.js` прогоняет все файлы каталога
на каждом старте, поэтому всё должно быть идемпотентно: `IF NOT EXISTS`,
`NOT EXISTS`-гварды).

```sql
-- snakes-v3: rank_events становится леджером РЕЗУЛЬТАТОВ ИГР.
--   delta — сумма очков игр, попавших в запись (месячный и общий рейтинги);
--   best  — лучшая ОДИНОЧНАЯ игра среди них (дневной рейтинг).
-- Две колонки, а не строка на игру: движок вправе склеивать несколько
-- завершённых игр одного игрока в один запрос, и при склейке сумма
-- складывается, а максимум берётся максимумом — обе агрегации точны.
ALTER TABLE rank_events ADD COLUMN IF NOT EXISTS best INTEGER NOT NULL DEFAULT 0;

-- история: до этой миграции запись означала «прирост ранга за матч»,
-- ближайший честный аналог результата игры — сама дельта
UPDATE rank_events SET best = GREATEST(delta, 0) WHERE best = 0 AND delta > 0;

-- дневной срез — MAX(best) по тому же окну, что и месячный SUM(delta):
-- индекс 006 (game_id, created_at DESC) WHERE NOT voided обслуживает оба,
-- отдельный не нужен.
```

Проверить, что `ratings.updated_at` уже есть (есть: им пользуется
`recomputeRank`, `src/UserRepository.js:126-131`) — он становится курсором
суточной задачи.

## 2.2 `UserRepository`: запись

`appendRankEvent` (`:106`) и `upsertRank` (`:138`) переписываются в один
метод. Старые имена не оставлять: их единственный вызывающий — `main.js`
этого же пакета.

```js
// snakes-v3: один результат (или склейка нескольких) одного игрока.
// points — сумма очков, best — лучшая одиночная игра.
async recordGameResult(userId, gameId, { points, best }, attribution = {}) {
  const { hosterUserId = null, sessionId = null } = attribution;

  if (points <= 0 && best <= 0) {
    return; // защита в глубину: пустую запись не пишем (движок и так не шлёт)
  }

  await this._db.query(
    `INSERT INTO rank_events (user_id, game_id, hoster_user_id, session_id, delta, best)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, gameId, hosterUserId, sessionId, points, best],
  );
}
```

**Пересчёт `ratings` с горячего пути уходит совсем** — это главный выигрыш
по нагрузке: сейчас каждый `PUT` делает `INSERT` плюс `SUM` по всему
леджеру игрока (`recomputeRank`, `:117`), и этот `SUM` растёт с историей.
`recomputeRank` остаётся — им пользуется `voidHosterContributions` (`:337`)
и суточная задача.

## 2.3 `UserRepository`: чтение, три среза

`periodStart(period)` (`:32`) остаётся как есть — календарные окна UTC.
Меняется то, ЧТО агрегируется:

| Срез | Агрегация | Источник |
| --- | --- | --- |
| `day` | `MAX(best)` по окну `date_trunc('day', now() AT TIME ZONE 'utc')` | леджер |
| `month` | `SUM(delta)` по окну `date_trunc('month', …)` | леджер |
| `all` | `ratings.rank` как есть | суточный снимок |

`getLeaderboard(gameId, limit, period)` — ветка окна становится такой
(остальное — `JOIN users`, `COUNT(*) OVER()`, `RANK() OVER`, `ORDER BY
… , u.nick ASC`, `LIMIT` — не меняется):

```sql
WITH scores AS (
  SELECT e.user_id,
         CASE WHEN $3 = 'day' THEN MAX(e.best) ELSE SUM(e.delta) END::int AS rank
  FROM rank_events e
  WHERE e.game_id = $1 AND e.voided = false AND e.created_at >= <periodStart>
  GROUP BY e.user_id
  HAVING (CASE WHEN $3 = 'day' THEN MAX(e.best) ELSE SUM(e.delta) END) > 0)
SELECT u.nick, s.rank, COUNT(*) OVER() AS total,
       RANK() OVER (ORDER BY s.rank DESC) AS place
FROM scores s JOIN users u ON u.id = s.user_id
WHERE u.nick IS NOT NULL
ORDER BY s.rank DESC, u.nick ASC
LIMIT $2
```

Значение `<periodStart>` подставляется литералом из `periodStart()` — так
сделано и сейчас, и по той же причине (значение приходит из кода, а не от
пользователя; комментарий в файле это объясняет). Срез `$3` можно
подставить и параметром, и литералом — выбрать одно и объяснить в
комментарии.

`getPlacement(userId, gameId, period)` (`:203`) правится симметрично: в
`scores` та же `CASE`-агрегация, `me.rank` и `placement` считаются от неё.
Ответ формы не меняет: `{ placement, total, rank }`.

Форма ответа `getLeaderboard` тоже прежняя:
`{ leaderboard: [{ nick, rank, place }], total }` — движок и лобби на неё
уже завязаны, ломать нельзя.

## 2.4 All-time считается раз в сутки

Новый `src/db/ratingsJob.js`:

- `refreshRatings(db)` — инкремент по курсору `ratings.updated_at`:

```sql
INSERT INTO ratings (user_id, game_id, rank, updated_at)
SELECT e.user_id, e.game_id,
       LEAST($2, GREATEST($1, COALESCE(r.rank, 0) + SUM(e.delta)))::int,
       now()
FROM rank_events e
LEFT JOIN ratings r ON r.user_id = e.user_id AND r.game_id = e.game_id
WHERE e.voided = false
  AND e.created_at >= COALESCE(r.updated_at, '-infinity'::timestamptz)
GROUP BY e.user_id, e.game_id, r.rank
ON CONFLICT (user_id, game_id)
DO UPDATE SET rank = EXCLUDED.rank, updated_at = now()
```

`$1`/`$2` — `config.rank.min`/`config.rank.max`. Граничный случай
«событие ровно в момент `updated_at`» разрешается в пользу повторного
учёта, поэтому курсор двигать строгим `>` от последнего учтённого
`created_at`, а не `now()` — либо, проще и безопаснее, оставить `>=` и
писать `updated_at = now()` (события в микросекунду совпадения
пересчитаются, но такое совпадение стоит одной лишней суммы, а не
двойного начисления, потому что следующее окно начнётся с нового
`updated_at`). Выбранный вариант ОБЯЗАТЕЛЬНО объяснить комментарием в коде
и покрыть тестом.

- `startRatingsJob(db)` — планировщика в auth нет, завести минимальный:
  посчитать миллисекунды до ближайших 00:05 UTC, `setTimeout`, затем
  `setInterval` на 24 часа; каждый прогон логировать
  (`[ratings] refreshed N rows in M ms`). Таймер `.unref()`, чтобы не
  держать процесс в тестах.
- Запуск из `src/main.js` рядом с остальной инициализацией.
- Ручной прогон: скрипт `"db:ratings": "node --env-file-if-exists=../../.env src/db/ratingsJob.js"`
  в `package.json` пакета (файл при прямом запуске зовёт `refreshRatings`
  и выходит).

## 2.5 Роут `PUT /rank`

`src/main.js:371-390`. Тело запроса становится
`{ points, best, hostId, hostSecret }` (атрибуцию мастер подставляет сам —
`readAttribution`). Поле `delta` принимать как алиас `points` ровно на одну
версию, чтобы не ронять старые хосты, и пометить это `TODO` со сроком.

Валидация — новая функция в `src/lib/validators.js` рядом с
`isValidRankDelta`:

```js
// snakes-v3: результат игры. best — одна игра, points — сумма склеенных.
export const isValidGameResult = (points, best, { maxGameScore, maxPoints }) =>
  Number.isInteger(points) && Number.isInteger(best) &&
  points >= 0 && best >= 0 &&
  best <= maxGameScore && points <= maxPoints && best <= points;
```

`best <= points` — не формальность: `best` это максимум среди игр, чья
сумма равна `points`, и нарушение означает битого клиента.

Ответ роута: `{ ok: true }` (пересчитанный `rank` больше не считается на
записи — возвращать его было бы ложью).

## 2.6 Пределы (решение пользователя 9 и «адекватное ограничение»)

`src/config/auth.js:69-77` сейчас: `rank: { min: 0, max: 1000000,
maxDelta: 1000 }`. По новой модели законный результат жизни snakes упрётся
в `maxDelta` и вернётся как `400 invalidRank`.

Расчёт масштаба по данным игры (`vimp-snakes/src/data/models.js`,
`src/data/palette.js`, `src/data/maps/arena.js`):

- ценность кристалла в среднем `0.7·1 + 0.25·3 + 0.05·8 = 1.85` очка;
- на карте одновременно 60 кристаллов (`world.maxCrystals`), спавн — один в
  0.35 с (`world.spawnInterval`): вся комната получает не больше ≈5.3 очка
  в секунду прироста поля;
- базовая арена — радиус 1280 на восемь змей (`BASE_SIZE = 20`,
  `STEP = 128`): 60 кристаллов на ≈5.15 млн кв. единиц, среднее расстояние
  ≈290 единиц при скорости 260 ед/с (`baseSpeed`) → около одного кристалла
  в секунду, **≈110 очков в минуту** у игрока, который только собирает;
- убийство даёт +15 (`KILL_BONUS`) плюс россыпь жертвы
  (`world.dropRatio = 0.8`), буст вычитает 6 очков в секунду
  (`boostDrainPerSecond`).

Отсюда: очень хорошая десятиминутная жизнь — **1000–1500** очков, экстремум
с чередой убийств — **2000–3000**.

| Параметр | Значение | Обоснование |
| --- | --- | --- |
| `rank.maxGameScore` (дефолт) | **10 000** | ×3–5 к достижимому экстремуму snakes |
| `rank.maxPoints` (за запрос) | **200 000** | = `maxGameScore × 20`; окно склейки — минута, столько игр в неё не влезает |
| `rank.max` | оставить **1 000 000** | дневные рекорды по ~1000 копятся ~1000 игровых дней; колонка `INTEGER` |
| `rank.maxDelta` | удалить | заменена парой выше |

Auth обслуживает сотни игр, и один глобальный предел для всех неверен:
у другой игры масштаб очков иной. Поэтому предел **пер-игровой** и живёт на
мастере (этап 3.3, `master:games[]` — конфиг оператора, а не пакета игры);
значения выше — абсолютный потолок auth, последняя линия обороны.

## Тесты (`/Users/dmitry/Sites/my/vimp/tests/auth/UserRepository.test.js`)

Стиль файла: `createDbStub(handlers)` возвращает `{ query: vi.fn(...) }`,
обработчик разбирает SQL по `text.startsWith(...)`/`text.includes(...)`,
названия тестов — по-русски. Добавить:

- `recordGameResult` пишет `delta` и `best` в одну строку и НЕ зовёт
  пересчёт `ratings`;
- `recordGameResult` не пишет ничего при `points = 0, best = 0`;
- `getLeaderboard('day')` строит запрос с `MAX(e.best)`, `getLeaderboard('month')`
  — с `SUM(e.delta)`, `getLeaderboard('all')` — читает `ratings`;
- `getPlacement` в тех же трёх срезах считает `placement` тем же способом,
  что и список (иначе плашка противоречит таблице);
- `refreshRatings` суммирует только события после `updated_at`, клампит в
  `rank.min/max` и переставляет `updated_at`;
- `voidHosterContributions` по-прежнему гасит события и пересчитывает кэш
  (регресс: он остался единственным вызывающим `recomputeRank`).

Валидатор — в `/Users/dmitry/Sites/my/vimp/tests/auth/validators.test.js`:
`isValidGameResult` отвергает отрицательные, дробные, `best > points`,
`best > maxGameScore`, `points > maxPoints`.

## Проверка выхода

```bash
cd /Users/dmitry/Sites/my/vimp
npm test -- tests/auth        # быстрее полного прогона
npx eslint packages/auth
npm run auth:db:migrate       # миграция на существующей базе
npm run auth:db:migrate       # второй прогон — идемпотентность
```

## Готово, когда

- миграция применяется дважды подряд без ошибок;
- три среза дают три разные агрегации и это покрыто тестами;
- запись в леджер — ровно один `INSERT`, пересчёта на горячем пути нет;
- суточная задача считает инкремент и логирует результат.
