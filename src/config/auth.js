import models from '../data/models.js';

// HostPlugin.authSchema — the entry screen the engine renders before a player
// joins (docs/ai/04-client-plugin.md § Auth screen).
//
// Three traps live in this file, and each one has already cost a debugging
// session in a real game:
//   * the container id is `fieldsId`, NOT `formId` — the engine resolves the
//     wrong key to null and the screen dies with a TypeError on first render;
//   * there is NO nickname field: identity comes from the lobby JWT;
//   * the model field must be named exactly `model` — the engine reads
//     `params.model` when it creates the participant, and any other name never
//     reaches it.
//
// This screen is shown ONCE. The engine has no path back to it (AUTH_RESULT
// without an error hides it, starts the modules and sends MODULES_READY), so
// the after-death screen is the game's own overlay in `src/client/index.js`,
// not a return to this one.
export default {
  elems: {
    authId: 'auth',
    fieldsId: 'auth-fields',
    errorId: 'auth-error',
    enterId: 'auth-enter',
    titleId: 'auth-title',
    informsId: 'auth-informs',
  },

  texts: {
    title: 'Vimp Snakes',
    sections: [
      {
        heading: 'How to play',
        lines: [
          { keys: 'a, d', text: 'turn' },
          { keys: 'w', text: 'boost (burns crystals)' },
          { keys: 'r', text: 'respawn after a crash' },
          { separator: true },
          { keys: '', text: 'eat crystals to grow' },
          { keys: '', text: 'the edge and other snakes kill you' },
          { keys: '', text: 'your own tail does not' },
          { separator: true },
          { keys: 'c', text: 'chat' },
          { keys: '<Tab>', text: 'stats', last: true },
        ],
      },
    ],
  },

  params: [
    {
      name: 'model',
      value: 's1',
      options: {
        control: 'select',
        label: 'Snake',
        options: Object.keys(models),
        validator: 'isValidModel',
        storage: 'model',
      },
    },
  ],

  // validators are functions: they are not serialised to the client, they run
  // on the host when the answer comes back
  validators: {
    isValidModel: model => model in models,
  },
};
