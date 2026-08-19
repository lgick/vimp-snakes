import sounds from './sounds.js';

// The game half of the client CONFIG_DATA: render entities, canvases, key
// sets, panel/stat schemas and the chat/vote texts. The engine deep-merges its
// own defaults under this object and adds `prediction` and `snapshot` itself —
// the host hands the result over through HostPlugin.buildClientGameConfig(),
// so the client never loads this file directly.
export default {
  parts: {
    // snapshot key (or map setId) -> the part classes built for it. A key
    // without an entry is a black canvas: the frame arrives and the client
    // does not know what to draw it with.
    gameSets: {
      s1: ['Snake'],
      cr: ['Crystal'],
      c1: ['Arena'],
    },

    // part class -> canvas. This is the ONLY registration: a class listed in
    // ClientPlugin.parts and in gameSets but missing here answers
    // "Constructor for X not found." at the first frame that needs it.
    entitiesOnCanvas: {
      Arena: 'vimp',
      Snake: 'vimp',
      Crystal: 'vimp',
    },

    // procedural textures, baked once per canvas at startup — the reason this
    // package ships no images. `name` must exist in ClientPlugin.bakers and
    // `component` names the part class that receives the result in `assets`.
    // It bakes WHITE: one texture serves every colour and every tier through
    // `tint` and `scale`, and sixty crystals stay one batch.
    //
    // The snake has no baked asset: its body is a stroked path whose width
    // follows the crystal count every frame, so there is nothing constant to
    // bake.
    bakedAssets: {
      vimp: [
        {
          name: 'crystalGem',
          component: 'Crystal',
          params: { radius: 32, facets: 6 },
        },
      ],
    },

    // the service pool has exactly four entries — renderer, soundManager,
    // assetsBase, localPlayer. An unknown name is not an error: the part just
    // gets undefined and draws nothing.
    componentDependencies: {
      // a snake plays the pickup cue when its own count goes up, and the death
      // cue as it leaves the canvas — but only for the player of THIS tab: an
      // arena of thirty snakes eating at once is a wall of noise, and the cue
      // that matters is your own
      soundManager: ['Snake'],
      // 'is this snake mine?' — the part compares the id it was built with
      // against the client's own game id (engine service, see Snake.js)
      localPlayer: ['Snake'],
    },

    sounds,
  },

  // DOM ids hidden until authentication completes; 'panel' is revealed as
  // display: flex, everything else as display: block
  initIdList: ['vimp', 'panel', 'chat'],

  modules: {
    canvasManager: {
      // the engine CREATES these <canvas> elements — they are not in the HTML.
      // baseScale '1:1' means world->screen 1 at the 1920 px design width: the
      // view shows ~1920 of the 2560-unit arena, so the boundary is a thing
      // you approach rather than a frame you always see.
      canvases: {
        vimp: {
          width: 960,
          height: 600,
          aspectRatio: '16:10',
          baseScale: '1:1',
          dynamicCamera: true,
          // nothing in this game emits CoreEvent::Shake
          shakeCamera: false,
        },
      },
    },

    controls: {
      // [0] spectator, [1] player. The engine switches between them by the
      // KEYSET_DATA port; codes 9, 13, 27, 67 and 77 belong to the engine
      // (stat, enter, escape, chat, vote) and never reach the game.
      keySetList: [
        {
          78: 'nextPlayer', // n
          80: 'prevPlayer', // p
        },
        // every action here must be a key of gameConfig.playerKeys, and vice
        // versa: a name on one side only is a key that sends nothing
        {
          65: 'left', // a
          68: 'right', // d
          87: 'boost', // w
          // R is also what the OK button of the death overlay presses, by
          // dispatching a synthetic keydown/keyup on document — a client
          // plugin has no socket of its own, and the controls module is
          // listening there anyway (src/client/index.js)
          82: 'respawn', // r
        },
      ],

      // указатель (мышь/палец) — второй способ управления, не замена
      // клавишам: A/D/W продолжают работать, а на смартфоне доступен только
      // он. Движок шлёт канал лишь тем играм, что объявили этот ключ, и
      // только в перечисленных наборах клавиш — [1] это набор игрока,
      // наблюдателю рулить нечем.
      pointer: {
        keySets: [1],
        // пороги распознавания двойного тапа (dblclick тач-устройства не
        // гарантируют): второе нажатие в 300 мс и 40 px от первого
        doubleTapMs: 300,
        doubleTapPx: 40,
        // move по проводу не чаще 50 мс: змейка доворачивает не быстрее
        // turnSpeed, чаще ей просто нечего сказать
        sendIntervalMs: 50,
      },
    },

    chat: {
      params: {
        // texts of the system message codes: the host sends 'group:index',
        // the text lives here. Groups s/v/m/c/n are the engine's — the game
        // owns 'g' (see src/host/systemMessages.js).
        messages: {
          s: [
            'Team {0} is full. Your current team: {1}',
            'Your team: {0}',
            'Your new team: {0}',
            'Your new status: spectator',
            '{0} crashed into {1}',
            '{0} joined the game',
            '{0} left the game',
          ],
          v: [
            'A vote has been created',
            'Voting has started',
            'Your vote has been accepted',
            'Voting is temporarily unavailable',
            'Vote passed',
            'Vote failed',
          ],
          m: ['Current map: {0}', 'Next map: {0}'],
          c: ['Command not found', 'Your rank: {0}'],
          n: ['Invalid name', '{0} changed name to {1}'],
          g: ['{0} bot snake(s) spawned'],
        },
      },
    },

    panel: {
      // wire key (gameConfig.panel.fields[*].key) -> field name here.
      // 't' is sent by the engine itself and MUST map to a type: 'time'
      // field, or the round time never appears on the HUD.
      keys: {
        e: 'eaten',
        k: 'kills',
        s: 'score',
        // carried right now — geometry and boost fuel, not a number the HUD
        // shows; the three above are what the player reads
        c: 'crystals',
        // 0 alive / crystals+1 dead — read by the result overlay, never shown
        d: 'dead',
        // gameConfig.panel.activeKey: the core pushes 'CRUISE' / 'BOOST'
        wa: 'mode',
        t: 'time',
      },
      // The order here IS the order of the cells: PanelView builds the row by
      // walking this array (`_buildPanel`). The logo is not among them — the
      // engine has no cell type for one — so it is drawn by `#panel::before`
      // in style.css.
      //
      // The last four are declared but hidden by style.css. Three of them
      // (crystals, dead, mode) are host fields, and invariant 6
      // (panelContract) requires the client to name every one of those; `time`
      // is the engine's own key 't', which PanelView dereferences unguarded —
      // dropping the field crashes the HUD on the first round-time tick, so it
      // stays declared even though this game's round never ends.
      fields: [
        { name: 'eaten', elem: 'panel-eaten', type: 'value' },
        { name: 'kills', elem: 'panel-kills', type: 'value' },
        { name: 'score', elem: 'panel-score', type: 'value' },
        { name: 'crystals', elem: 'panel-crystals', type: 'value' },
        { name: 'dead', elem: 'panel-dead', type: 'value' },
        { name: 'mode', elem: 'panel-mode', type: 'weapon' },
        { name: 'time', elem: 'panel-time', type: 'time' },
      ],
    },

    stat: {
      params: {
        // six columns, positionally matched to the host's `key` indexes.
        // Columns 2..4 are written by this game itself instead of by the
        // engine's kill machinery (src/config/game.js).
        columns: ['snake', 'status', 'eaten', 'kills', 'score', 'ping'],
        // one playing team, so one aggregate header
        heads: {
          1: 'players',
        },
        bodies: {
          1: 'players',
          2: 'spectators',
        },
        // [columnIndex, descending]; sorting is numeric, a text column sorts
        // as 0. The leader is whoever has the most total points (column 4);
        // ties break on crystals eaten (column 2), so a player who earned the
        // same score by eating rather than by killing ranks first.
        sortList: {
          players: [
            [4, true],
            [2, true],
          ],
        },
      },
    },

    vote: {
      params: {
        // template = [title, values?, timeOff?]; 'teams' and 'maps' are
        // substituted by the engine with the live lists
        templates: {
          teamChange: ['Play or watch?', 'teams', true],
          mapChangeBySystem: ['Choose the next map'],
          mapChangeByUser: ['{0} suggested the map: {1}', ['Yes', 'No']],
        },
        menu: [
          ['teamChange', ['Play / watch', 'teams']],
          ['mapChange', ['Suggest map', 'maps']],
        ],
      },
    },
  },

  // texts of the GAME_INFORM_DATA port, addressed by index. The indexes are
  // fixed by the engine (winnerTeam, roundStart, gameOver) — reordering the
  // array changes what the messages mean.
  gameInform: {
    list: ['{0} WINS!', 'SLITHER!', 'GAME OVER!'],
  },
};
