import { getArenaScaler } from './createModules.js';

// Chat command '/bot <count>' — sets the number of bot snakes in the arena
// without a vote. It is also what `npm run dev` uses to get a match going
// (startupCommands in dev/main.js).
//
// SET, not add: the count asked for is the count the arena ends up with. The
// bots in play are removed first and `count` fresh ones are created, so
// '/bot 5' after '/bot 10' leaves five, and '/bot 0' empties the arena. The
// cost — the bots' own counters start over — is nothing a player can see, and
// the round restart below resets them anyway.
//
// The argument is mandatory: '/bot' and '/bot abc' report BOT_COUNT_INVALID
// and touch nothing. A command that silently means "one bot" would wipe the
// arena on a typo.
//
// The name must not collide with the engine's own commands (/name, /nr,
// /timeleft, /mapname, /rank): those are matched by a switch BEFORE the game
// registry, so a same-named command registers fine and never fires. The two
// this game does not want are switched off through
// `gameConfig.disabledCommands` instead (src/config/game.js).
export default {
  name: '/bot',

  // ctx = { participants, chat, scripted, roundManager, voteCoordinator,
  //         timerManager, playerDataSync, teams, spectatorTeam, spectatorId,
  //         isDevMode }
  handler(ctx, gameId, args) {
    // the argument is whatever a player typed: '/bot -3' must not mean a
    // negative arena, and '/bot 1e9' must not mean a billion loop iterations
    const requested = Number(args[0]);

    if (args[0] === undefined || !Number.isFinite(requested) || requested < 0) {
      ctx.chat.pushSystemByUser(gameId, 'BOT_COUNT_INVALID');

      return;
    }

    const { maxPlayers } = ctx.participants;
    const wanted = Math.trunc(requested);
    const count = maxPlayers > 0 ? Math.min(wanted, maxPlayers) : wanted;

    // «create, not add»: whoever is in the arena now goes first
    ctx.scripted.removeScripted();

    const created = count > 0 ? ctx.scripted.createScripted(count) : 0;

    // the code is the game's own (src/host/systemMessages.js); the TEXT lives
    // on the client, in modules.chat.params.messages
    ctx.chat.pushSystem('BOTS_SET', [created]);

    // `createScripted` only registers participants; the engine puts actors in
    // the world in `_startRound`, and nowhere else. The round here is endless
    // by design, so without this the new bots would sit as participants with
    // no snake, forever.
    //
    // The cost is real and worth stating: a restart respawns everyone and
    // resets what they were carrying. That is the price of '/bot' in a game
    // with no round boundary to wait for. A pure removal ('/bot 0') needs no
    // restart — `removeScripted` takes the actors out of the core itself.
    if (created > 0) {
      ctx.roundManager.initiateNewRound();

      // ...and a restart reloads the engine's own copy of the map. That copy
      // is kept current by `ArenaScaler` (`vimp.overrideMapData`), so the bots
      // are placed on the disc actually in force — this call puts the same map
      // back in front of the core and the clients afterwards, so nothing is
      // left holding the catalog one. Null before the first population report,
      // and then there is nothing to restore.
      getArenaScaler()?.reapply();
    }
  },
};
