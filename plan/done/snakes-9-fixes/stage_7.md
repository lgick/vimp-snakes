# Этап 7 — без голосования и наблюдателей (пункт 8, закрывает и пункт 7) ✅ выполнен

## Отступление от плана (одно)

`admitPlayer` вызывается не в `HostGame.createUser`, а в `firstShotReady`:
`sendFirstShot` уходит ПОСЛЕ createUser и шлёт keyset наблюдателя (`sendKeySet
(socketId, 0)`), затирая клавиши игрока. Команду и строку stat участник
получает по-прежнему на входе (`ParticipantManager.createHuman` →
`participants.joinTeamId`), актора — на первом подтверждённом кадре.

Дополнительно (следствия удаления `modules.vote`, без них конфиг падал):
`buildClientConfig` заводит `modules.vote.params` сам, клиентская модель Vote
держит пустые `menu`/`templates` по умолчанию, а из `src/config/auth.js`
убрана подсказка про клавишу `m`.

## Решение пользователя

Не «оставить `spectatorTeam` как неиспользуемый резерв», а убрать наблюдателей
как концепцию для одно-командных игр — правка движка, аддитивная (opt-in), не
ломающая игры, которые наблюдателей используют. Плюс **отдельный** флаг,
глушащий движковое правило «активных людей меньше двух — сброс статистики и
новый раунд».

Два флага, не один: они про разное (состав команд ↔ жизненный цикл раунда), и
игра, которой нужен только второй, не должна отказываться от наблюдателей.

## Почему это заодно чинит пункт 7 («лишние игроки в stat»)

`HostGame.createUser` (`HostGame.js:825-849`) безусловно зовёт
`this._participants.createHuman(params, socketId)` и сразу
`this._stat.addUser(gameId, this._spectatorId, { name })`, а
`ParticipantManager.createHuman` (`ParticipantManager.js:36-56`) жёстко кладёт
человека в `this._spectatorTeam`. Крючка «положить сразу в играющую команду»
в контракте плагина нет — проверено. Значит сегодня каждый подключившийся,
даже ещё не проголосовавший, виден в stat строкой наблюдателя. Уберём
наблюдателей — уйдут и лишние строки, без отдельного фильтра на стороне игры.

## Изменения в движке — часть A: `noSpectators`

- **`packages/engine/src/lib/gamePlugin.js`** — `REQUIRED_GAME_CONFIG_PATHS`
  (строка 44) содержит `'spectatorTeam'`, а ниже (строка 88-94) проверяется,
  что это ключ `teams`. Ослабить: при `gameConfig.noSpectators === true`
  `spectatorTeam` не обязателен, а `teams` обязан содержать **ровно одну**
  запись. Без флага — всё как сейчас, дословно.
- **`devtools/contract/rules/b4-teams.js`** — то же послабление в
  контракт-правиле, иначе `npm run check:contract` в игре не пройдёт.
- **`ParticipantManager`** — конструктор принимает `spectatorTeam === null`;
  `createHuman` кладёт человека в единственную играющую команду вместо
  `spectatorTeam`. `_spectatorId` в этом режиме — `null`, и все сравнения
  `teamId !== this._spectatorId` обязаны это пережить (их несколько в
  `RoundManager` и `HostGame` — пройти по каждому).
- **`RoundManager`** — публичный `admitPlayer(gameId)`: то, что сегодня
  делает приватная ветка `_setActivePlayer(user, respawnData)` внутри
  `changeTeam` (`RoundManager.js:370-378`), но без team-wipe, без правила
  «<2 игроков» и без сообщений о смене команды. Точку спавна берёт тем же
  способом, что и `_startRound`.
- **`HostGame.createUser`** — при флаге: `stat.addUser` с id играющей команды
  и вызов `roundManager.admitPlayer(gameId)` после того, как участник создан
  и панель заведена (порядок важен: `Panel.updateUser` на неизвестном id
  бросает).
- **`SocketManager.sendFirstVote`** — уже no-op при пустом `initialVote`,
  править не нужно.
- **`RoundManager._checkTeamWipe`** и `_startRound` — проверить, что ветки
  `team === this._spectatorTeam` корректно вырождаются при `null`. В snakes
  team-wipe и так неактивен (kill никогда не репортится, см. этап 5), но код
  общий для всех игр движка.

## Изменения в движке — часть B: `endlessRound`

`RoundManager.changeTeam` (`RoundManager.js:335-341`) при менее чем двух
активных людях делает `this._stat.reset()` и `this.initiateNewRound()`. В
snakes раунд вечный, а stat — единственный счёт: правило обнуляет таблицу
всем при входе или выходе игрока.

- Новый `gameConfig.endlessRound: true` — под ним это правило не применяется.
  Пройти по остальным местам, где раунд рестартует «сам» (истечение
  `roundTime`, `_checkTeamWipe`), и решить по каждому: под флагом раунд не
  должен рестартовать по причинам, не инициированным игрой. Явные вызовы
  (`/nr`, `/bot`) продолжают работать.
- `endlessRound` независим от `noSpectators`: игра может объявить любой из
  них по отдельности.

## Общее для обеих частей

- `packages/engine/CHANGELOG.md` — `### Added` (минор): оба флага opt-in,
  старые конфиги со `spectatorTeam` работают ровно как раньше.
- Документация движка: `docs/en/plugin-api.md` + `docs/ru/`, `docs/ai/03-host-
  plugin.md` (полный справочник `gameConfig`) и `docs/ai/08-gameplay-meta.md`
  (правила раунда) — в том же изменении.
- Полный сьют движка как регресс-сеть: правится общий код, а не путь одной
  игры.

## Изменения в игре (snakes)

- **`src/config/game.js`** — убрать `initialVote`; убрать команду
  `spectators` и ключ `spectatorTeam`; выставить `noSpectators: true` и
  `endlessRound: true`. `teams` становится `{ players: 1 }`.
- **`src/config/client.js`** — убрать `modules.vote` целиком; в
  `modules.stat.params.bodies` убрать запись `2: 'spectators'`; из
  `modules.chat.params.messages.s` убрать текст «Your new status: spectator»
  (индекс 3) **только если** движок перестаёт слать этот код — иначе
  индексы группы `s` сдвинутся и все её сообщения станут врать. Проверить по
  движку, прежде чем трогать массив.
- Комментарии в обоих конфигах, объясняющие, зачем нужен `spectators` и
  `initialVote`, переписать.

## Тесты

- Движок: юнит-тесты нового пути входа (человек сразу в играющей команде, с
  актором и строкой stat там же); ослабленный конфиг-гейт принимает форму без
  `spectatorTeam` и по-прежнему отвергает опечатку в обычном режиме;
  `endlessRound` не даёт `changeTeam` обнулить stat.
- Игра: `tests/host/hostPlugin.test.js` — вход кладёт человека в `players`;
  `tests/config/contract.test.js` и `tests/config/game.test.js` — конфиг без
  `spectatorTeam`/`vote`.

## Проверка

Движок: `npx eslint . && npm test` в `~/Sites/my/vimp`.
Игра: `npx eslint . && npm test`, `npm run check:contract`.
Все пять сценариев `npm run sim --determinism` — состав участников меняется,
это заденет каждый.
Ручная: подключение сразу играющим, без экрана голосования; в stat нет строк
наблюдателей; счёт не обнуляется, когда в комнате остаётся один человек.
