# Доработки vimp-snakes (+ движок, + tanks) — ✅ выполнен

## Контекст

Пять пунктов от пользователя: точная команда ботов, мёртвые panel/stat,
лишний логотип, лишний пункт голосования и ненужные `/timeleft`, `/mapname`.
По ходу работы решение по командам изменилось: движок больше **не разбирает
никаких** чат-команд — весь набор объявляет игра, и одно имя в разных играх
может значить разное.

## 1. Движок: у CommandProcessor нет своих команд — ✅ выполнен

- `packages/engine/src/host/meta/core/CommandProcessor.js` — чистый реестр:
  `parseCommand` ищет имя в `this._commands` и отвечает `COMMANDS_NOT_FOUND`.
  Движковый `switch` (`/name`, `/nr`, `/timeleft`, `/mapname`, `/rank`) удалён.
- `b7-chat-commands.js` — вместо списка зарезервированных имён проверяет
  форму: ведущий слэш, наличие `handler`, отсутствие дублей.
- Тесты: `tests/host/CommandProcessor.test.js` переписан,
  `tests/devtools/contract/rules.test.js` — новые кейсы B7.
- Документация: `docs/ai/03-host-plugin.md`, `docs/ai/12-questionnaire.md`,
  `docs/ru|en/host.md`, `docs/ru|en/plugin-api.md`, `docs/ru|en/architecture.md`,
  `packages/engine/CHANGELOG.md` (breaking).
- Шаблон `create-vimp-game`: добавлен `src/host/metaCommands.js`
  (`/name`, `/nr`, `/rank`), обновлены `index.js` и тест плагина.

## 2. snakes: `/spawn` → `/bot <N>` — ✅ выполнен

`src/host/botCommand.js` (git mv из `spawnCommand.js`): точное количество —
сначала `removeScripted()`, затем `createScripted(N)`; `/bot 0` очищает арену;
`/bot` и `/bot abc` отвечают `BOT_COUNT_INVALID` и ничего не трогают.
Коды `BOTS_SET`/`BOT_COUNT_INVALID` + тексты в `src/config/client.js`.
`dev/main.js`, `scenarios/growth.json`, README обновлены.

## 3. snakes: нули в panel и stat — ✅ выполнен

`src/host/StatBridge.js` брал `Number(data.id)`, а движок раздаёт gameId
строками (`ParticipantManager._nextGameId`) и держит участников в `Map` —
промах ключа, `_record()` → null, ни одной записи. Теперь `String()`.
Регрессия закрыта `tests/host/statBridge.integration.test.js` (настоящие
`ParticipantManager`/`Panel`/`Stat`), фикстуры юнит-тестов переведены на строки.

## 4. snakes: логотип, голосование, команды — ✅ выполнен

- `src/client/style.css` — удалён `#panel::before` (движок рисует `#logo`).
- `src/config/client.js` — из `vote.params.menu` убран пункт «Suggest map».
- `src/host/metaCommands.js` — игра объявляет `/name`, `/nr`, `/rank`;
  `/timeleft` и `/mapname` не регистрируются (раунд и карта вечные).

## 5. vimp-tanks: команды нужны — ✅ выполнен

`src/host/metaCommands.js` с пятью командами (`/name`, `/nr`, `/timeleft`,
`/mapname`, `/rank`), регистрация рядом с `/bot`, тесты
`tests/host/metaCommands.test.js`, docs `gameplay.md` (ru/en), CHANGELOG.

## Проверка — ✅ выполнена

- snakes: `npm test` (103), `npx eslint .`, `npm run check:contract`
  (только прежний warn C6).
- движок: `npm test` (1408), `npx eslint .`.
- tanks: `npm test` (128), `npx eslint .`.
- `npm run build` + `npm run sim --determinism` по всем пяти сценариям —
  зелено. Новый `scenarios/bots.json` показывает 6 → 2 → отказ → 0 ботов.
