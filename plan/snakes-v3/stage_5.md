# Этап 5: snakes — score за жизнь, отчёт результата, таблица, `/rank`, скины

Репозиторий: `/Users/dmitry/Sites/my/vimp-snakes`. Опирается на этапы 1–4.

Файлы: `src/host/StatBridge.js`, `src/host/metaCommands.js`,
`src/config/game.js`, `src/config/client.js`, `src/client/parts/Snake.js`,
`src/client/bakers/` (новый baker короны), `src/client/style.css`,
тесты `tests/host/statBridge.test.js`,
`tests/host/statBridge.integration.test.js`, `tests/config/contract.test.js`,
`tests/host/hostPlugin.test.js`.

## 5.1 `src/host/StatBridge.js`

### Текущее состояние

Запись на участника: `{ participant, eaten, kills, score, flushedEaten,
rankedEaten, published }` (`:262-273`), живёт от входа до выхода. События:
`crystals` → `_onCrystals` (`:152`), `death` → `_onDeath` (`:177`),
`population` → `_publishNewcomers` + `_maybeFlush` (`:130-135`); `respawn`
намеренно не обрабатывается (`:137-138`). Ранг: 1 очко за
`CRYSTALS_PER_RANK = 25` съеденных (`:164-167`) плюс 1 за убийство
(`:198`), пишется через `vimp.addPlayerRank`. `_publish` (`:328`) кладёт в
stat `score` и, если `isPlayerRankLoaded`, `rank`; в панель — `score`.
Свой таймер синхронизации: `FLUSH_INTERVAL_MS = 60_000` (`:82`),
`_maybeFlush` (`:225`).

### Целевое

1. **Per-life.** `score`, `eaten`, `kills` обнуляются на событии `respawn`
   — добавить ветку `case 'respawn':` в `onCoreEvent` (`:116-141`).
   Именно на респауне, а не на смерти: окно результата
   (`src/client/gameOver.js`) читает счёт из панели уже после смерти, и
   обнуление на смерти показало бы игроку ноль вместо его результата.
2. **`burn`** (событие из этапа 1):

```js
case 'burn':
  this._onBurn(gameId, Number(data.burned) || 0, vimp, panel);
  break;
```

   `_onBurn`: `record.score = Math.max(0, record.score - burned)` и
   `_publish`. Из `eaten` сожжённое **не** вычитается: `eaten` — «съедено»,
   а не «имеется», и на нём стоит `playerState.eaten` (пожизненная сумма).
3. **Смерть = конец игры.** В `_onDeath`, после начисления убийце и до
   выхода:

```js
vimp?.addPlayerPoints?.(gameId, victim.score);
vimp?.finishPlayerGame?.(gameId);
this._recordBest(gameId, victim, vimp);
vimp?.flushPlayerData?.({ urgent: true });
```

   Опциональные вызовы (`?.`) — тем же приёмом и по той же причине, что и
   сейчас у `addPlayerRank` (`:218`): старые сборки движка и тестовые
   заглушки не должны падать.
   **Арифметики «дельта против дневного значения» на стороне игры нет
   вовсе** — её делает движок (`finishGame`, этап 3.1). Это принципиально:
   игра сообщает результат, а как он ложится в три рейтинга, решает
   платформа.
   `urgent` здесь оправдан: новый дневной рекорд должен быть в базе к
   моменту, когда игрок нажмёт `Tab`, а не через минуту.
4. **Убийце** по-прежнему `kills += 1` и `score += KILL_BONUS` (15).
   Очки убийцы уходят в рейтинг вместе с его собственной смертью — так
   работает «результат игры»; отдельного начисления рейтинга за килл больше
   нет.
5. **Убрать:** `CRYSTALS_PER_RANK` (`:71`) и цикл `while` в `_onCrystals`
   (`:164-167`); `_addRank` (`:214-220`); запись колонки `rank` и гейт
   `isPlayerRankLoaded` в `_publish` (`:331-337`); поле `rankedEaten` в
   записи. `_maybeFlush`/`FLUSH_INTERVAL_MS` **упростить до просьбы**:
   интервалом теперь владеет движок (этап 3.2), игре достаточно звать
   `vimp.flushPlayerData()` на `population` и `{ urgent: true }` на смерти.
6. `_recordBest` остаётся; `best` в `playerState` теперь «лучший счёт за
   жизнь», и комментарий об этом надо поправить.
7. **Известное ограничение (записать и в код, и в док):** игрок, вышедший
   посреди жизни, свой незавершённый счёт не отдаёт — `HostGame.removeUser`
   (`packages/engine/src/host/HostGame.js:872-896`) стартует финальный
   flush раньше, чем ядро сообщает об уходе. Ловить эту гонку дороже, чем
   она стоит; счёт незавершённой игры и не должен идти в рейтинг по
   решению пользователя («score на конец игры»).

## 5.2 Конфиги, команда, стили

**`src/config/game.js`, блок `stat` (`:206-235`)** — убрать `rank`,
перенумеровать ключи подряд:

```js
stat: {
  name:    { key: 0, bodyMethod: '=', headSync: true, headMethod: '#' },
  status:  { key: 1, bodyMethod: '=', bodyValue: '', headValue: '' },
  score:   { key: 2, bodyMethod: '=', bodyValue: 0, headMethod: '+', headValue: 0 },
  latency: { key: 3, bodyMethod: '=' },
},
```

Схема остаётся, хотя клиент рисует лидерборд: движок продолжает писать
`name`/`status`/`latency` во внутреннюю таблицу (`RoundManager`,
`RTTManager`), и её отсутствие уронит эти пути.

**`src/config/client.js`, `modules.stat.params` (`:224-250`)** — режим
лидерборда:

```js
stat: {
  params: {
    mode: 'leaderboard',   // engine v4: список из auth, а не строки комнаты
    period: 'day',
    limit: 10,
    refreshMs: 15000,
    columns: ['#', 'snake', 'score'],
  },
},
```

`heads`/`bodies`/`sortList` удаляются: порядок задаёт auth, команд в
списке нет.

**`src/config/client.js`, тексты чата (`:182`)** — код `RANK` группы `c`:

```js
c: ['Command not found', 'Your place today: {0} of {1} ({2} points)'],
```

Неранжированному игроку вместо места подставляется `—` — тем же символом,
что и в таблице, чтобы «нет места» выглядело одинаково в обоих местах.

**`src/host/metaCommands.js`, `rankCommand` (`:45-53`)**:

```js
async handler(ctx, gameId) {
  await ctx.playerDataSync.refreshPlacement(gameId, 'day');

  const { value, placement, total } = ctx.playerDataSync.getRating(gameId, 'day');

  ctx.chat.pushSystemByUser(gameId, 'RANK', [placement ?? '—', total, value]);
}
```

Проверить в движке, что `CommandProcessor` умеет асинхронный `handler`;
если нет — не делать `await`, а звать `refreshPlacement` без ожидания и
отвечать по текущим значениям (следующий `/rank` покажет свежие). Выбранный
вариант объяснить комментарием.

**`src/client/style.css`** — стили `.stat-leaderboard`: три колонки
(место — по правому краю, ник — растягивается, очки — по правому краю),
моноширинные цифры (`font-variant-numeric: tabular-nums`), подсветка
`.is-self`. Движковая CSS свёрстана под пятиколоночную таблицу и здесь не
годится; в файле уже есть прецедент — правило C6 разрешает игре привозить
свои стили.

## 5.3 Скины за топ-10 (решение пользователя 6)

**`src/config/client.js`, `componentDependencies` (`:50-58`)** — добавить
`accolades: ['Snake']` рядом с `soundManager` и `localPlayer`.

**`src/client/parts/Snake.js`:**

- в конструкторе (`:105-133`) — `this._accolades = dependencies.accolades;`
  (сохранить сам сервис, НЕ результат вызова);
- место спрашивать **в момент отрисовки**, в `update()` (`:136`), а не в
  конструкторе — ровно по той же причине, по которой это правило записано
  для `localPlayer` в `docs/ai/04-client-plugin.md`: части строятся из
  `FIRST_SHOT_DATA`, раньше первых данных, и флаг, вычисленный один раз,
  будет неверным именно для того, для кого он важен;
- **daily top-10 → ромб на теле.** В `_drawBody` (`:172`), после двух
  существующих `stroke` (основного и тёмного ядра): пройти по `curve` с
  шагом (например каждые `radius * 1.6` длины пути) и нарисовать
  ромбы — `moveTo/lineTo` по четырём точкам от нормали и касательной,
  `fill` светлым оттенком базового цвета. Толщина ромба масштабируется от
  `radius`, чтобы у толстой змеи узор не выглядел точками;
- **monthly top-10 → корона на голове.** В `_drawHead` (`:213`): текстуру
  печёт baker (`src/client/bakers/crown.js`, зарегистрировать в
  `src/client/bakers/index.js` и в `bakedAssets` клиентского конфига, как
  сделан `crystalGem.js`), спрайт ставится над головой и поворачивается по
  `angle`. Если рисовать `Graphics`-ом проще — допустимо и это, но тогда
  без baker'а;
- ромб и корона совместимы: игрок может носить оба одновременно;
- боты и гости мест не имеют — сервис вернёт `{ daily: null, monthly: null }`,
  и это штатный путь, не ошибка.

## Тесты

`tests/host/statBridge.test.js` (стиль файла: явные импорты из `vitest`,
`participantsFor([...])` со строковыми id, `statOf(stat, id)`; см. шапку
файла) — добавить и поправить:

- `respawn` обнуляет `score`, `eaten`, `kills`;
- `burn` вычитает из `score` и не уводит ниже нуля;
- смерть зовёт `addPlayerPoints(id, score)` и `finishPlayerGame(id)` ровно
  по разу, со счётом ИМЕННО этой жизни;
- смерть зовёт `flushPlayerData({ urgent: true })`;
- колонка `rank` не пишется никогда; `isPlayerRankLoaded` не спрашивается;
- сохраняются: убийце начислено ДО обнуления жертвы; смерть от края и
  самоубийство никому не платят; id, сменивший владельца, начинает счёт
  заново;
- заглушка `vimp` без новых методов не роняет мост (старая сборка движка).

`tests/config/contract.test.js` (`:172-247`) — переписать блок stat: в
хостовой схеме нет `rank`, ключи идут подряд, клиентская половина в режиме
`leaderboard` (проверять `mode`/`period`/`limit`, а не соответствие колонок
позициям, — соответствия больше нет).

`tests/host/hostPlugin.test.js` (`:373`) — `/rank` отвечает местом за
сегодня и не падает на неранжированном игроке.

Новый тест части `Snake` (по образцу существующих клиентских тестов
репозитория): при `accolades.placeOf` с местом в daily/monthly рисуются
дополнительные элементы, при `null` — нет.

## Проверка выхода

```bash
cd /Users/dmitry/Sites/my/vimp-snakes
npm run core:build          # если этап 1 пересобирался не в этой сессии
npm test && npx eslint .
npm run check:contract      # C6 не должен падать на режиме leaderboard
npm run build               # ОБЯЗАТЕЛЬНО: манифест с engineApi 4
npm run sim -- … growth.json --determinism
```

## Готово, когда

- в панели после респауна 0, во время буста счёт падает;
- `Tab` показывает дневной топ-10 без шапки, своя строка — с местом или
  прочерком;
- `/rank` отвечает тем же местом;
- игрок из дневного топ-10 виден с ромбом, из месячного — с короной, и
  видно это ИЗ ДРУГОЙ вкладки.
