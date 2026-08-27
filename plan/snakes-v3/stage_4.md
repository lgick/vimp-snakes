# Этап 4: движок — `accolades` и режим stat «дневной топ-10»

Репозиторий: `/Users/dmitry/Sites/my/vimp/packages/engine`.
Опирается на готовые срезы этапов 2–3.

Файлы: `src/config/opcodes.js`, `src/config/wsports.js`,
`src/host/meta/modules/Accolades.js` (новый), `src/host/HostGame.js`,
`src/host/meta/SocketManager.js`, `src/client/main.js`,
`src/client/lib/accolades.js` (новый),
`src/client/components/{view,model,controller}/Stat.js`,
`src/devtools/contract/rules/c6-stat-columns.js`, `src/client/style.css`.

## 4.0 Версия контракта

Добавляются порт и пятый сервис пула зависимостей — это ломающее изменение
контракта плагинов: `ENGINE_API_VERSION` в `src/config/opcodes.js:12`
поднимается `3 → 4`, комментарий над ней дополняется строкой `v4`.

Последствие, которое нельзя пропустить: `GameCatalog`
(`src/master/GameCatalog.js:60-66`) **молча пропускает** игру, собранную под
другую версию, — после этой правки snakes обязана быть пересобрана
(`npm run build` в `/Users/dmitry/Sites/my/vimp-snakes`), иначе она просто
исчезнет из лобби без сообщения об ошибке.

## 4.1 Места участников — новый общий механизм

Награда привязана к нику и обязана работать на любом сервере (решение
пользователя 6), поэтому её источник — ГЛОБАЛЬНЫЙ топ, а не состояние
комнаты. Ник глобально уникален (`users.nick`, миграция 002 auth-сервиса),
и это единственный ключ, по которому топ можно сопоставить с участником.

### Хост: `src/host/meta/modules/Accolades.js`

```js
// Кто из участников комнаты сейчас в глобальном топ-10 — дневном и
// месячном. Источник — тот же публичный топ, что рисует лобби, поэтому
// награда одинакова на любом сервере: она про игрока, а не про комнату.
export default class Accolades {
  constructor({ participants, gameId, fetchImpl, config }) { … }

  // берёт day и month top-10 через мастер, сопоставляет по нику
  async refresh() { … }

  // { [gameId]: { daily: place|null, monthly: place|null } } или null,
  // если с прошлого вызова ничего не изменилось
  shift() { … }
}
```

- URL — `lobbyConfig.leaderboardUrl` (`/auth/leaderboard`), относительный:
  Worker резолвит его от origin мастера, как это уже делает
  `PlayerDataSync`. Запросы идут с `If-None-Match` (этап 3.3), поэтому
  неизменившийся топ стоит `304` и не стоит ни одного обращения к БД: на
  мастере он схлопнут TTL-кэшем на всю сеть.
- Период обновления — `lobbyConfig.accolades.refreshInterval` (дефолт
  **45000** мс) плюс немедленный `refresh()` на вход участника (у
  новичка знак должен появиться сразу, а не через 45 секунд).
- Сопоставление: `participant.name` (ник из JWT) сравнивать с `nick` строк
  топа **без учёта регистра** — уникальность ника в auth
  регистронезависимая (миграция 002).
- Боты и гости в топ не попадают никогда: у них нет записи в auth. Их место
  — `null`, и это нормальный, а не аварийный случай.

### Транспорт

`src/config/wsports.js`, блок `server`: `ACCOLADES_DATA: 18`.
`SocketManager` — метод `sendAccolades(socketId, data)` по образцу
`sendStat` (`src/host/meta/SocketManager.js:337`).
`HostGame` — в цикле рассылки (`src/host/HostGame.js:397-425`, там же где
`sendStat`) отправлять `accolades.shift()`, если он не `null`. Обычно
ничего не изменилось → `null` → рассылки нет вовсе.

### Клиент

`src/client/lib/accolades.js` — сервис по образцу
`src/client/lib/localPlayer.js`:

```js
export function createAccolades() {
  let places = {};

  return {
    apply(data) { places = data || {}; },
    // { daily: place|null, monthly: place|null } — всегда объект
    placeOf(id) { return places[String(id)] || { daily: null, monthly: null }; },
  };
}
```

`src/client/main.js`:

- создать сервис рядом с `localPlayer` (`:281`);
- `socketMethods[PS_ACCOLADES_DATA] = data => accolades.apply(data);` рядом
  с `socketMethods[PS_STAT_DATA]` (`:638`);
- добавить `accolades` в `availableServices` (`:370-383`) — там, где уже
  лежат `renderer`, `soundManager`, `localPlayer`, `assetsBase`.

Часть получит сервис, только если объявит его в
`parts.componentDependencies` (`:325`, `DependencyProvider.collectAll`).

Ядро игры об этом не знает и знать не должно: это косметика, она не идёт ни
в снапшот, ни в симуляцию.

## 4.2 Режим stat `leaderboard`

### Текущее состояние

`StatView._buildStat` (`src/client/components/view/Stat.js:34-76`) всегда
строит `<div class="stat-head">` со `<span>` на каждую колонку и по таблице
на каждую команду; `StatModel.update()` (`model/Stat.js:37`) разбирает
данные хоста; движковая CSS (`src/client/style.css:228-288`) свёрстана под
пять колонок.

### Целевое

Игра объявляет в клиентской половине:

```js
modules: {
  stat: {
    params: {
      mode: 'leaderboard',
      period: 'day',
      limit: 10,
      refreshMs: 15000,      // совпадает с TTL кэша мастера
      columns: ['#', 'snake', 'score'],
    },
  },
}
```

- `_buildStat` в этом режиме **не создаёт `.stat-head`** и не создаёт
  таблиц — строится один список `<div class="stat-leaderboard">` со
  строками `<div class="stat-row">` (место, ник, очки).
- `StatModel.update()` в этом режиме — no-op: данные хоста не рисуются.
  Хост в этом режиме их и не шлёт (см. ниже).
- `open()` обновляет данные не чаще `refreshMs`:
  - `GET /auth/leaderboard?game=&limit=&period=day` — публичный, с
    `If-None-Match` из прошлого ответа;
  - `GET /auth/placement?game=&period=day` с токеном `lobbyAuthModel`
    (`src/client/main.js:2118`, модуль-скоуп);
  - рядом уже лежат лоббийные `fetchLeaderboard` (`:1792`) и
    `fetchPlacement` (`:1812`) — **переиспользовать их**, а не писать
    третью копию;
  - `304`, ошибка сети или отсутствие токена — остаётся последнее известное
    состояние (пустой список на первом открытии, и это нормально).
- Отрисовка строк: `место · ник · очки`. Игрок из топа подсвечивается
  (класс `is-self`); если игрока в топе нет — его строка **заменяет
  десятую**; если он не ранжирован за сегодня (гость, нулевой день) —
  вместо места прочерк `—`, очки — из его `placement.rank` (то есть 0).
- Хост в этом режиме перестаёт слать stat вовсе: в `HostGame`
  (`:418-422`) не звать `sendStat`, когда игра объявила режим
  `leaderboard` (флаг прокидывается из `gameConfig`, как остальные
  режимные флаги вроде `endlessRound`). Трафик на то, что никто не рисует,
  платить незачем.
- `src/devtools/contract/rules/c6-stat-columns.js` жёстко ждёт пять колонок
  под движковую CSS — научить его режиму `leaderboard`: в нём проверять,
  что игра привезла свои стили, а не число колонок.
- Движковая CSS получает минимальный каркас `.stat-leaderboard`
  (сетка из трёх колонок); внешний вид под себя игра доопределяет своим
  `styles` (этап 5.2).

## Тесты

`/Users/dmitry/Sites/my/vimp/tests/client/StatView.test.js` (и
`StatModel`/`StatCtrl` рядом):

- в режиме `leaderboard` `.stat-head` не создаётся, создаётся
  `.stat-leaderboard`;
- `update()` от хоста ничего не рисует;
- повторный `open()` внутри `refreshMs` не делает запросов;
- `304` оставляет прошлый список;
- игрок вне топа заменяет десятую строку; неранжированный получает прочерк;
- регресс: в обычном режиме (`mode` не задан) всё работает как раньше —
  шапка, таблицы, сортировка.

`/Users/dmitry/Sites/my/vimp/tests/host/`:

- `Accolades.test.js` (новый): сопоставление по нику без учёта регистра;
  бот/гость получают `null`; `shift()` отдаёт `null`, когда места не
  изменились, и объект — когда изменились; `304` не считается изменением.

## Проверка выхода

```bash
cd /Users/dmitry/Sites/my/vimp
npm test -- tests/client tests/host tests/master
npx eslint packages/engine
```

## Готово, когда

- `ENGINE_API_VERSION = 4`, и это записано в `docs/ai/*`;
- части могут спросить место игрока, а движок ничего не знает о наградах;
- `Tab` в режиме `leaderboard` рисует список без шапки, а хост в этом
  режиме stat не шлёт.
