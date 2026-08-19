// System chat codes of the game. A code is 'group:index' and carries no text:
// the text lives on the client, at the same index of
// modules.chat.params.messages[group] (src/config/client.js).
//
// Groups s, v, m, c and n belong to the engine. Registration is a blind
// Object.assign into its registry, so a code in one of them replaces an engine
// message with no warning at all — the game picks its own letter instead.
export default {
  BOTS_SET: 'g:0', // client text: 'Bot snakes in the arena: {0}'
  BOT_COUNT_INVALID: 'g:1', // client text: 'Invalid bot count'
};
