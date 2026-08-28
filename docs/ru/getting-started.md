# Локальная настройка (игра-плагин)

Этот репозиторий собирает `@vimp-games/snakes` — игру-плагин для
[движка VIMP](https://github.com/lgick/vimp-engine). Настройку самого движка
(мастер-сервер, лобби, auth-сервис) см. в его
[getting-started.md](https://github.com/lgick/vimp-engine/blob/main/docs/ru/getting-started.md).

## Требования

- **Node.js 20.11+** (пакет объявляет `engines.node >= 20.11`), npm;
- **Rust-тулчейн** (`rustup` + `wasm-pack`) — нужен для сборки WASM-ядра,
  которое грузят браузерный хост движка и каждый клиент;
- **ffmpeg** — опционально, только для перегенерации звуков.

## Установка

```bash
git clone https://github.com/lgick/vimp-snakes.git
cd vimp-snakes
npm install
```

`vimp-engine` здесь — обычная npm-зависимость (не workspace-симлинк): плагин
импортирует только её публичную поверхность `exports` (`./config/*`,
`./standalone`, `./style.css`).

`pixi.js` — **peer-зависимость**, в бандл не входит: клиентская сборка выносит
её наружу (`vite.config.js`), а в рантайме она обязана резолвиться в тот же
экземпляр модуля, что использует движок (import map на странице хоста). Две
независимые копии PixiJS падают в рантайме — у каждой свой реестр
расширений/пайпов и свои счётчики uid, и объекты одной копии не годятся
рендереру другой.

## Rust-тулчейн

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # rustc + cargo
rustup target add wasm32-unknown-unknown
brew install wasm-pack        # или: cargo install wasm-pack
```

## Сборка

```bash
npm run core:build       # обе цели WASM (web + nodejs)
npm run core:build:web   # браузер/Worker → core/pkg-web/
npm run core:build:node  # Node.js (тесты, headless) → core/pkg-node/
npm run core:test        # cargo test --workspace, включая паритет предиктора
npm run build            # полная сборка: бандлы client+host, ассеты, manifest.json → dist/
```

`npm run core:build` — **не опция и не «потом»**: dev-харнесс (`dev/main.js`)
импортирует wasm из `core/pkg-web/`, поэтому, пока ядро не собрано хоть раз,
Vite не резолвит импорт и `npm run dev` падает на старте.

`npm run build` производит `dist/manifest.json` (`GameManifest`), бандлы
client/host, экспортированный JSON карты (`dist/maps/arena.json`) и звуки —
всё, что мастер отдаёт под `/games/snakes/*` и что динамически импортируют
Worker хоста и клиент. Если собран `core/pkg-node/`, `build:manifest` копирует
его в `dist/core-node/` и объявляет `entries.wasmNode` на этой копии:
публикуется только `dist/` (`files: ["dist"]`), поэтому манифест, указывающий
наружу, работал бы в чекауте и ломался в установленном пакете.

## Матч локально (`npm run dev`)

Самый быстрый цикл не требует ни чекаута движка, ни мастера:
[standalone SDK](https://github.com/lgick/vimp-engine/blob/main/docs/ru/standalone.md)
движка поднимает авторитетный хост, клиент и этот плагин в одной вкладке — без
лобби и OAuth.

```bash
npm run core:build      # WASM (для dev достаточно core/pkg-web/)
npm run audio:process   # звуки → build/sounds/ (нужен ffmpeg; опционально)
npm run dev             # dev-сервер Vite, открывает вкладку
```

Вкладка входит как `Player` (переопределяется `localStorage.vimp_dev_nick`) и
просит трёх ботов — все опции в `dev/main.js` (`startStandaloneGame`,
`assetsBase`, `startupCommands`). **`startupVotes` нет**: игра объявляет
`noSpectators`, поэтому игрок с первой секунды в единственной команде.

`assetsBase` здесь `/build/`:

- **звуки** — `build/sounds/`, продукт `npm run audio:process`; если его нет,
  `predev` подкладывает готовые заглушки из `assets/sounds/`, и матч звучит
  даже на голой машине;
- **картинок нет вовсе**: каждая текстура игры либо рисуется `Graphics`, либо
  печётся процедурно на старте, поэтому `copy-game-images.js` не находит
  `assets/img/` и честно сообщает, что копировать нечего.

WebRTC в этом режиме не используется, а `npm run build` не нужен: Vite отдаёт
`src/**` и `core/pkg-web/*.wasm` напрямую.

## Матч через лобби (локальный чекаут движка)

Чтобы разрабатывать против локальной неопубликованной копии плагина, соберите
его один раз и слинкуйте оба чекаута **друг в друга**:

```bash
cd vimp-snakes && npm run core:build && npm run build   # WASM + dist/

cd vimp-snakes && npm link                    # регистрирует @vimp-games/snakes
cd vimp/packages/engine && npm link           # регистрирует vimp-engine

# в чекауте движка — ВСЕ игры ОДНОЙ командой, иначе вторая линковка затрёт первую
cd vimp && npm link @vimp-games/tanks @vimp-games/snakes
cd vimp-snakes && npm link vimp-engine        # плагин ← движок

cd vimp && npm run dev                        # мастер на https://localhost:3002
```

Обратная линковка важна не меньше прямой: без неё импорты `vimp-engine/*` из
плагина резолвятся в реестровую копию внутри его собственного `node_modules` —
второй экземпляр модуля со своей, молча разъехавшейся `ENGINE_API_VERSION`.
`npm install` в любом из репозиториев заменяет симлинки реестровыми копиями,
так что команды `npm link <имя>` придётся повторить.

Каталог игр мастер строит из `node_modules/@vimp-games/*`, когда `GAMES_MATRIX`
не задана, сортируя по id — поэтому `snakes` идёт первой и становится
**активной** игрой лобби, что и делает кнопку `Create server` кликабельной.
Закрепить другую:

```bash
GAMES_MATRIX='[{"id":"tanks","package":"@vimp-games/tanks"}]' npm run dev
```

Пакет должен быть собран до старта мастера: каталог читает
`dist/manifest.json`, а не исходники. В dev движок затем отдаёт `src/**` и
`core/pkg-web/*.wasm` прямо через Vite `/@fs/` (HMR), поэтому правки JS в
client/host пересборки не требуют.

## Тесты

Стек: **Vitest** + happy-dom. `vitest.config.js` делит прогон на два проекта:

- `unit` — `tests/config/**` (контракт и инварианты игрового конфига),
  `tests/host/**` (`hostPlugin`, `statBridge`, `statBridge.integration`,
  `arenaScaler`), `tests/client/**` (`parts`, `gameOver`) — happy-dom;
- `integration` — `tests/core/**`: настоящее ядро, поднятое из Node через
  `core/pkg-node/`. Сборка не входит в `npm test`, поэтому без
  `npm run core:build:node` проекту нечего включать и набор всё равно зелёный.

Алиас Vite подменяет `core/pkg-web/*.js` на `tests/stubs/wasmCore.js`, чтобы
юнит-тесты импортировали половины плагина в чекауте, где ядро ни разу не
собиралось; заглушка бросает исключение, если её действительно позовут.

Правило проекта: **любое изменение кода заканчивается зелёными `npx eslint .`
и `npm test`**; правка движения в ядре или коэффициентов `models.js`
дополнительно требует `npm run core:test` (паритет предиктора).

## Статическая проверка контракта

```bash
npm run check:contract     # vimp-contract --game .
```

Текстовый проход по конфигам плагина, проверяющий контракт движок↔игра ещё до
сборки: id и классы блоков снапшота, контракт панели (клиент называет каждое
host-поле), наборы клавиш против `playerKeys`, схему авторизации, пары звуков,
картинки карт и то, что точек респавна не меньше `roomDefaults.maxPlayers`.
Запускать после каждой правки в `src/config/` и `src/data/`.

## Headless-сценарии (`npm run sim`)

Движок поставляет headless-раннер, замыкающий цикл
«хост → бинарный кадр → `ClientCore` → hot-буфер → сцена» в одном
Node-процессе и проверяющий движковые инварианты. Запускается из **чекаута
движка** с этим слинкованным пакетом и грузит **собранный** плагин — значит,
сначала `npm run build`, иначе вы проверяете прошлую версию:

```bash
cd vimp
npm run sim -- --game ../vimp-snakes --scenario ../vimp-snakes/scenarios/movement.json --determinism
```

| Сценарий | Что проверяет |
| --- | --- |
| `movement.json` | крейсер и повороты, дрейф предсказания по жёстким порогам |
| `crash-and-respawn.json` | въезд в границу, пребывание мёртвым, клавиша респавна |
| `growth.json` | два игрока, три бота, кристаллы, ускорение, `/bot` |
| `pointer.json` | руление в точку мышью/пальцем, перехват клавиатурой, двойной тап |
| `bots.json` | `/bot <count>` как SET: шесть ботов, потом два, потом отказ, потом ноль |
| `arena-shrink.json` | двенадцать вошли, восемь вышли: арена сжимается на целый шаг и забирает кристаллы старого кольца |

Все шесть обязаны проходить с `--determinism`. Два инварианта пропускаются по
замыслу: `roundLifecycle` (у игры нет конца раунда) и в четырёх из шести
сценариев `predictionDrift` (крушение и респавн — законные разовые всплески;
`movement.json` и `pointer.json` — те два, что следят за *растущим* дрейфом).

Раннер гоняет **настоящее** ядро, поэтому ему нужна та же версия
`vimp-engine-core`, что ожидает сборка движка. При работе против локального
чекаута движка пропатчите cargo локально — **не коммитить**:

```toml
# Cargo.toml, корень воркспейса
[patch.crates-io]
vimp-engine-core = { path = "../vimp/packages/engine/core" }
```

Формат сценариев и калибровка порогов — движковый
[debugging.md](https://github.com/lgick/vimp-engine/blob/main/docs/ru/debugging.md).

---

[Далее: Архитектура →](architecture.md)
