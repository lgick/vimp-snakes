// The chat commands that used to live inside the engine. The engine has none
// of its own any more: `CommandProcessor` is a bare registry, so every command
// a player can type is declared by the game — and the same name may mean
// something else, or nothing at all, in the next game.
//
// This game keeps three of them and deliberately drops two: `/timeleft` and
// `/mapname` would lie here, because the round and the map never end
// (src/config/game.js). Typing either now answers "Command not found".
//
// The message codes are the engine's own (`RANK`, `COMMANDS_NOT_FOUND` in
// group 'c'); their texts are in `modules.chat.params.messages`
// (src/config/client.js), and the game's own codes live in
// src/host/systemMessages.js.

// ctx = { participants, chat, scripted, roundManager, voteCoordinator,
//         timerManager, playerDataSync, teams, spectatorTeam, spectatorId,
//         isDevMode }

/// '/name <nickname>' — the engine validates and broadcasts it (RoundManager
/// pushes the 'n' group messages itself).
export const nameCommand = {
  name: '/name',

  handler(ctx, gameId, args) {
    ctx.roundManager.changeName(gameId, args.join(' '));
  },
};

/// '/nr' — restart the round. Dev builds only: in this game a restart
/// respawns everyone, so it is a debugging tool and not a player's button.
export const newRoundCommand = {
  name: '/nr',

  handler(ctx, gameId) {
    if (ctx.isDevMode) {
      ctx.roundManager.initiateNewRound();
    } else {
      ctx.chat.pushSystemByUser(gameId, 'COMMANDS_NOT_FOUND');
    }
  },
};

/// '/rank' — the player's place in the DAILY rating: the best result of a
/// single game over the current UTC day, across every server this game runs
/// on. Not a number of the room's own — the place moves with OTHER people's
/// games, so it is re-fetched here rather than recomputed locally.
export const rankCommand = {
  name: '/rank',

  // `CommandProcessor` calls a handler and neither awaits nor catches it
  // (`handler(this._ctx, gameId, arr)`), so this one is fire-and-forget: the
  // answer reaches the chat when the request returns. That is the right shape
  // anyway — a stale place is exactly what the command is asked to avoid —
  // but it also means nothing here may reject: an unhandled rejection in the
  // host worker takes the room down with it, hence the try/catch. The
  // throttling of the request itself lives in PlayerDataSync.
  async handler(ctx, gameId) {
    let rating = null;

    try {
      rating = await ctx.playerDataSync.refreshPlacement(gameId, 'day');
    } catch {
      // an engine without the call, or a request that blew up: answer with
      // whatever the last refresh left behind
      rating = ctx.playerDataSync.getRating?.(gameId, 'day') ?? null;
    }

    const { value = 0, placement = null, total = 0 } = rating ?? {};

    // an unranked player has no place, and a dash says so — the same dash the
    // leaderboard puts in that column (src/config/client.js)
    ctx.chat.pushSystemByUser(gameId, 'RANK', [
      placement ?? '—',
      total,
      value,
    ]);
  },
};
