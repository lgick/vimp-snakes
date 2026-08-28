import { snakeColorCss } from '../data/palette.js';

// The colour of a player's nickname in chat.
//
// By default the engine colours a nickname by TEAM (`line${teamId}` in its
// stylesheet), and this game declares a single team — so every nickname came
// out the same colour and told the reader nothing. The snake's colour is the
// one thing that already identifies a player on the arena, so the chat
// borrows it: `participants.setChatColor(gameId, '#rrggbb')` (vimp-engine
// >= 0.22, docs/ai/03-host-plugin.md), applied by the engine to every message
// that player sends afterwards.
//
// The colour index is the CORE's: it is handed out by a counter at
// `spawn_actor` and shipped in the snapshot row, which is a client channel.
// So the core also reports it in a `spawn` custom event, and this module is
// the only thing that listens for one.
//
// Bots are coloured too: `spawn_scripted_actor` delegates to `spawn_actor`,
// so a bot emits the same event. That is deliberate — a bot writes nothing to
// chat itself, but the engine's system lines about it read better in the
// colour the arena shows.
//
// It lives here rather than in StatBridge for the same reason StatBridge
// exists at all: `onCoreEvent` is called with `{ vimp, panel }` and nothing
// else, while `participants` only ever appears in `createModules`.
export default class ChatColors {
  constructor({ participants }) {
    this._participants = participants;
  }

  // `data` is the payload of a CoreEvent::Custom. IDS ARE STRINGS on the
  // engine side and numbers in the payload — see the same note in
  // StatBridge.js.
  onCoreEvent(data) {
    if (!data || data.type !== 'spawn') {
      return;
    }

    const index = Number(data.color);

    if (!Number.isFinite(index) || index < 0) {
      return;
    }

    this._participants?.setChatColor?.(String(data.id), snakeColorCss(index));
  }
}
