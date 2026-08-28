import ArenaScaler from './ArenaScaler.js';
import ChatColors from './ChatColors.js';
import ScriptedManager from './ScriptedManager.js';
import StatBridge from './StatBridge.js';

// Factory of the game's host modules (HostPlugin.createModules). The engine
// reads exactly ONE key off the result — `scripted`; anything else returned
// here is never called by it.
//
// The context is { participants, coreAdapter, panel, stat, chat,
// socketManager, scripted } — there is no timerManager and no voteCoordinator
// in it (those exist only in a chat-command context).
//
// The three modules below are kept in module-scope variables rather than
// returned, because the engine would ignore them either way and because
// `onCoreEvent` has no path to them otherwise: that hook is called with
// `{ vimp, panel }` and nothing else, while `stat`, `socketManager`,
// `coreAdapter` and `participants` only ever appear here. See StatBridge.js,
// ArenaScaler.js and ChatColors.js.
let statBridge = null;
let arenaScaler = null;
let chatColors = null;

export default function createModules(ctx) {
  const scripted = new ScriptedManager(ctx);

  statBridge = new StatBridge(ctx);
  // the scaler rebuilds the map under the running match, and the bot manager
  // hands out respawn points off the map it was last given — so it is handed
  // the instance, not `ctx.scripted` (which is the config object of that name)
  arenaScaler = new ArenaScaler(ctx, scripted);
  chatColors = new ChatColors(ctx);

  return { scripted };
}

/// The bridge for `HostPlugin.onCoreEvent`. Null until the engine has built
/// the modules, which happens before the first tick — a core event arriving
/// earlier is dropped rather than throwing inside the Worker.
export function getStatBridge() {
  return statBridge;
}

/// The arena scaler, on the same terms as the bridge above.
export function getArenaScaler() {
  return arenaScaler;
}

/// The chat-nickname colours, on the same terms as the bridge above.
export function getChatColors() {
  return chatColors;
}
