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

/// '/rank' — the number the auth service keeps per (user, game); the engine
/// loads it into PlayerDataSync at join.
export const rankCommand = {
  name: '/rank',

  handler(ctx, gameId) {
    ctx.chat.pushSystemByUser(gameId, 'RANK', [
      ctx.playerDataSync.getRank(gameId),
    ]);
  },
};
