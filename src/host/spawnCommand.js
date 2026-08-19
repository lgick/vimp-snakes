// Chat command '/spawn <count>' — fills the room with bots without a vote.
// It is also what `npm run dev` uses to get a match going (startupCommands in
// dev/main.js).
//
// The name must not collide with the engine's own commands (/name, /nr,
// /timeleft, /mapname, /rank): those are matched by a switch BEFORE the game
// registry, so a same-named command registers fine and never fires.
export default {
  name: '/spawn',

  // ctx = { participants, chat, scripted, roundManager, voteCoordinator,
  //         timerManager, playerDataSync, teams, spectatorTeam, spectatorId,
  //         isDevMode }
  handler(ctx, gameId, args) {
    // the argument is whatever a player typed: '/spawn -3' must not mean
    // zero bots, and '/spawn 1e9' must not mean a billion loop iterations
    const { maxPlayers } = ctx.participants;
    const requested = Math.max(1, Math.trunc(Number(args[0])) || 1);
    const count = maxPlayers > 0 ? Math.min(requested, maxPlayers) : requested;
    const created = ctx.scripted.createScripted(count);

    // the code is the game's own (src/host/systemMessages.js); the TEXT lives
    // on the client, in modules.chat.params.messages
    ctx.chat.pushSystem('BOTS_SPAWNED', [created]);

    // `createScripted` only registers participants; the engine puts actors in
    // the world in `_startRound`, and nowhere else. The round here is endless
    // by design, so without this the new bots would sit as participants with
    // no snake, forever.
    //
    // The cost is real and worth stating: a restart respawns everyone and
    // resets what they were carrying. That is the price of `/spawn` in a game
    // with no round boundary to wait for.
    if (created > 0) {
      ctx.roundManager.initiateNewRound();
    }
  },
};
