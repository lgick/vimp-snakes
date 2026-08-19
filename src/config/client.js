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

    // the service pool has exactly three entries — renderer, soundManager,
    // assetsBase. An unknown name is not an error: the part just gets
    // undefined and draws nothing.
    componentDependencies: {
      // a snake plays the pickup cue when its own count goes up, and the death
      // cue as it leaves the canvas — positionally, for every snake, so the
      // one behind you is audible
      soundManager: ['Snake'],
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
        c: 'crystals',
        l: 'length',
        // 0 alive / crystals+1 dead — read by the result overlay, never shown
        d: 'dead',
        // gameConfig.panel.activeKey: the core pushes 'CRUISE' / 'BOOST'
        wa: 'mode',
        t: 'time',
      },
      fields: [
        { name: 'crystals', elem: 'panel-crystals', type: 'value' },
        { name: 'length', elem: 'panel-length', type: 'value' },
        { name: 'mode', elem: 'panel-mode', type: 'weapon' },
        { name: 'time', elem: 'panel-time', type: 'time' },
        // present so invariant 6 (panelContract) holds — the host declares the
        // field, so the client must know its name; style.css keeps it hidden
        { name: 'dead', elem: 'panel-dead', type: 'value' },
      ],
    },

    stat: {
      params: {
        // five columns, positionally matched to the host's `key` indexes.
        // Column 2 is the crystal count: this game writes it itself instead of
        // letting the engine count kills into it (src/config/game.js).
        columns: ['snake', 'status', 'crystals', 'crashes', 'ping'],
        // one playing team, so one aggregate header
        heads: {
          1: 'players',
        },
        bodies: {
          1: 'players',
          2: 'spectators',
        },
        // [columnIndex, descending]; sorting is numeric, a text column sorts
        // as 0. The leader is whoever carries the most crystals.
        sortList: {
          players: [
            [2, true],
            [3, false],
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
