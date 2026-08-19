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
// The StatBridge below is kept in a module-scope variable rather than returned,
// because the engine would ignore it either way and because `onCoreEvent` has
// no path to it otherwise: that hook is called with `{ vimp, panel }` and
// nothing else, while `stat` only ever appears here. See StatBridge.js.
let statBridge = null;

export default function createModules(ctx) {
  statBridge = new StatBridge(ctx);

  return { scripted: new ScriptedManager(ctx) };
}

/// The bridge for `HostPlugin.onCoreEvent`. Null until the engine has built
/// the modules, which happens before the first tick — a core event arriving
/// earlier is dropped rather than throwing inside the Worker.
export function getStatBridge() {
  return statBridge;
}
