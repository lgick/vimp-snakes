# Этап 5 — /rank обновляется после каждой гибели и после выхода (пункт 2)

## Почему это правка движка, а не игры

Ранг — не часть `playerState` (непрозрачной JSON, которую игра пишет через
`vimp.setPlayerState`), а отдельное число на auth-сервисе. Меняет его
**только** `RoundManager.reportKill()` → `playerDataSync.addRank(id, ±1)`
(`packages/engine/src/host/meta/core/RoundManager.js:471,475`), а `reportKill`
вызывается только в ответ на `CoreEvent::Death` (`GameCoreAdapter.js`,
переключение по внешнему тегу события).

В snakes `CoreEvent::Death` никогда не эмитится и не должен — это ключевой
инвариант игры (шапка `src/config/game.js`): иначе раунд перестал бы быть
бесконечным, а с одной командой `players` проверка team-wipe превратила бы
каждое убийство в «team kill», за который движковая таблица даёт убийце
`rank −1` — ровно наоборот нужному.

Значит нужен новый аддитивный крючок, не проходящий через `RoundManager` и
team-wipe вообще.

## Изменения в движке (`/Users/dmitry/Sites/my/vimp`)

- **`packages/engine/src/host/HostGame.js`** — рядом с существующими
  `getPlayerRank`/`getPlayerState`/`setPlayerState` (`HostGame.js:1014-1024`)
  добавить `addPlayerRank(gameId, delta)`, реализованный через уже
  существующий `this._playerDataSync.addRank(gameId, delta)`. Чистая
  прокладка: никакого обращения к `RoundManager`, никакого team-wipe.
  `HostGame` — это и есть объект `vimp`, который `GameCoreAdapter`
  прокидывает в `onCoreEvent` через `_services` (`GameCoreAdapter.js:153`),
  так что метод становится доступен плагину без правки контекста.
- Флаш при выходе игрока уже есть: `HostGame.removeUser` зовёт
  `this._playerDataSync.flush(gameId)` — отдельного крючка «после выхода» не
  требуется.
- `packages/engine/CHANGELOG.md` — `### Added` (минор): новый метод контекста
  `onCoreEvent`, для существующих игр ничего не меняется.
- Тест движка: `addPlayerRank` дергает `playerDataSync.addRank` с теми же
  аргументами и не трогает `RoundManager`.
- Документация движка: `docs/en/host.md` + `docs/ru/host.md` (перечень
  методов фасада `vimp`) и `docs/ai/03-host-plugin.md` (контекст
  `onCoreEvent`) — правило «документация правится в том же изменении».

## Изменения в игре (snakes)

- **`src/host/StatBridge.js::_onDeath`** — когда `killerId !== null` и
  `killerId !== gameId`, вызвать `vimp?.addPlayerRank?.(killerId, 1)` ровно
  один раз, рядом с начислением `KILL_BONUS` из этапа 4. Смерть от края
  арены и самоубийство ранг не трогают (движковая конвенция из
  `docs/ai/08-gameplay-meta.md`: «suicide — no rank change»).
- `vimp` уже приходит в `_onDeath` (`StatBridge.js:113`) — новых параметров
  не нужно. Опциональный вызов (`?.`) обязателен: тестовые стабы и старая
  сборка движка метода не имеют.

## Тесты

- `tests/host/statBridge.test.js` — смерть с убийцей вызывает
  `vimp.addPlayerRank(killerId, 1)` ровно один раз; смерть без убийцы и
  самоубийство не вызывают вовсе; отсутствие метода на `vimp` не роняет
  обработчик.

## Проверка

Движок: `npx eslint . && npm test` в `~/Sites/my/vimp`.
Игра: `npx eslint . && npm test` в `~/Sites/my/vimp-snakes`.
Ручная: `/rank` до и после нескольких убийств — число растёт; после выхода из
комнаты и повторного входа — сохранилось.
