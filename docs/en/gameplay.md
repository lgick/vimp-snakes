# Gameplay

A free-for-all snake arena: one circular map, one endless round, one team.
Everyone is a player — there are no spectators, no rounds to win and nothing
to vote on. All rules are authoritative on the room host (the engine's
[host.md](https://github.com/lgick/vimp-engine/blob/main/docs/en/host.md)) and
are simulated in this game's Rust core ([core.md](core.md)).

## Player journey

1. **Connecting and auth** — the nick is not typed in; it comes from the
   player's lobby identity (the central auth service, verified by JWT), so the
   room's start page is informational (title + controls help) with just a
   **Start** button. The only form parameter is the snake class (default
   `s1`), validated on the host via `isValidModel`. The room limit
   (`roomDefaults.maxPlayers`, 32) is counted **by humans**; a full room
   replies with `roomFull`.
2. **Straight into the arena** — the game declares `noSpectators`, so the
   engine puts the joiner into the only team (`players`) and gives them a
   snake as soon as their first frame is acknowledged. There is no spectator
   stage and no team-selection vote.
3. **Playing** — the snake is always moving; steering is all there is.
4. **Crashing** — the core kills the snake, scatters part of what it carried
   over the map and shows this tab the result overlay
   (`src/client/gameOver.js`) with the score of that life. The life is a
   **game**: its score is reported to the ratings at that moment. Pressing
   **OK** (or `R`) respawns immediately, in place, without a round boundary —
   the engine is never told anybody died — and the score starts again at zero.

## Controls

- **Keyboard**: `A`/`D` turn, `W` boosts while held, `R` respawns.
- **Pointer (mouse/touch)** — the second way to play and the only one a phone
  has: **press and hold** turns the snake towards the point under the pointer,
  no faster than the keys would; **double tap and keep holding** boosts for as
  long as the finger stays down. Releasing hands the snake back to its current
  heading, and taking hold of `A`/`D` cancels the pointer target. The channel
  is muted while the chat or the stat table is open, so typing never steers.
- **Modes**: `c` — chat, `Tab` — stats; `Esc`/`Enter` — control within modes.
  `m` (the engine's vote menu) is deliberately disarmed — see "What this game
  does not have".

Key layout is configured in `src/config/client.js` (`modules.controls`),
commands and their types in `src/config/game.js` (`playerKeys`) — see
[configuration.md](configuration.md#keys-playerkeys).

## The arena

One map, `arena`: a disc derived from the map grid
(`radius = cols * step / 2`), with no walls and no tiles to speak of. The
boundary is what kills — a head that leaves the disc crashes.

The disc **grows with the crowd**: the area per snake is the difficulty curve,
so the grid is a function of the population,
`size = BASE_SIZE * sqrt(players / 8)` rounded up in steps of four players
(`src/data/maps/arena.js`). `src/host/ArenaScaler.js` applies it off the
core's `population` event and hot-swaps the map without an engine map change,
so nobody loses their score to a resize. Below eight players the size is
pinned — a duel in a pond is worse than a duel in a lake.

A **shrink takes the outskirts with it**: crystals left outside the new
boundary are removed rather than stranded there. Outside the disc they could
never be eaten — the boundary stops a head before its pickup reach gets to
them — and they would go on filling `world.maxCrystals`, so the arena would
starve on food nobody could reach ([core.md](core.md#the-crystal-field-crystalsrs)).
That includes the piles of the snakes the shrink itself kills: the sweep is
the last thing the step does, after the crashes are applied.

Respawn points are a sunflower spiral of 64 points, handed out in
bit-reversed order so that any small wave of joiners is spread over the whole
disc instead of piling into the middle; every point faces the centre, fanned
by up to 25°.

## Crystals, growth and the boost

- Crystals spawn at random while the field is below `world.maxCrystals` (60),
  one every `spawnInterval` (0.35 s), in three tiers worth 1 / 3 / 8 with
  weights 70 / 25 / 5.
- Eating one adds its `value` to what the snake **carries**: the body grows
  (`length = baseLength + lengthPerCrystal * crystals`), it thickens
  (`radius = baseRadius + radiusGain * sqrt(crystals)`) and it steers more
  heavily (`turnSpeed - turnSpeedFalloff * sqrt(crystals)`, floored at
  `turnSpeedMin`). A leader stays steerable and stops being nimble — the
  fastest snake in the arena is a small one.
- The **boost** (`W`) multiplies speed by `boostFactor` (1.9) and burns
  `boostDrainPerSecond` (6) crystals per second, dropping them back onto the
  map behind the tail; it is refused below `boostMinCrystals` (2). A boosting
  leader feeds the pack — and pays for the speed: the burnt crystals come off
  the score too (the core's `burn` event, [core.md](core.md)), so a chase is a
  bet rather than a free ride.

## Crashing, kills and the spawn grace

Three ways a life ends, and only one of them is somebody else's doing:

- **The edge** — your head leaves the disc. Nobody is credited.
- **Another snake in front of you** — your head runs into a body that lies
  *ahead* of it (`BodyPath::touches_ahead`). The crash belongs to whoever
  drove into it: a snake that swings into you from the side or from behind
  takes itself out and leaves you alone. Two snakes meeting head on are both
  driving into each other, and both die.
- **Your own tail** — nothing happens, the head passes over it.

A dead snake drops `dropRatio` (0.8) of what it carried over 24 spots along
the body it was dragging, so its haul is on the map for whoever gets there
first.

The first `spawnGraceSeconds` (2) of a life are yours: the snake appears
**whole** — body and all, laid out straight behind the head — stands still,
blinks on every client, kills nobody and cannot be killed. Long enough to read
the arena, and long enough for whoever was flying at that spot to steer
around you.

## Score, ratings and the table (Tab)

**One life is one game.** The engine's own scoring machinery never runs here
(no kill is reported), so `src/host/StatBridge.js` keeps the numbers itself,
per game id, and a **respawn** resets all of them:

| Number | Meaning |
| --- | --- |
| `eaten` | crystals swallowed during this life (internal) |
| `kills` | snakes that crashed into this one during this life (internal) |
| `score` | `eaten + 15 * kills` minus what the boost burnt, floored at zero |

The reset happens on the respawn and not on the death: the result overlay
reads the score off the HUD panel *after* the crash, so zeroing it there would
show the player a zero instead of their result.

A kill pays a flat bonus and nothing else: the victim keeps its own score, and
what it was carrying is already scattered on the map — transferring the score
too was a second reward for the same event and made the leaders run away. The
killer's bonus reaches the ratings with the KILLER's own death, together with
the rest of their game.

### The result of a game

A crash ends the victim's game. The bridge hands the number over —
`vimp.addPlayerPoints(gameId, score)` then `vimp.finishPlayerGame(gameId)` —
and then asks for a flush. Urgent (`{ urgent: true }`) only when the game just
beat the player's daily best, so a record is in the database by the time they
press `Tab`; an ordinary game waits for the engine's own interval. `urgent`
bypasses both that interval and the room's backoff, and spending it on every
crash would spend the room's whole write budget on deaths — nothing is lost by
waiting, the points sit in the engine's pending counters. What that one number
means in each rating is the platform's decision, not the game's:

| Rating | Rule |
| --- | --- |
| daily | the best result of a SINGLE game over the UTC day, live, reset at 00:00 UTC |
| monthly | the SUM of every game of the calendar UTC month, live |
| all-time | the sum over all time, recomputed once a day — both the list and your own row show the snapshot taken at 00:00 UTC |

The lifetime profile follows the same event: `playerState.best` is the best
score of a single life ever played, `playerState.eaten` the crystals swallowed
over all of them.

How often any of this reaches the database is the ENGINE's business — the game
only ever *requests* a flush, and `lobbyConfig.playerData` holds the interval,
the per-room queue and the backoff. A quiet room writes nothing at all.

One known gap: a player who leaves in the MIDDLE of a life reports nothing.
`HostGame.removeUser` starts its final flush before the core reports the
departure, and by the rule this game is scored by ("the score at the END of a
game") an unfinished game has no result to report anyway.

### The table behind `Tab`

`modules.stat.params.mode: 'leaderboard'` (`src/config/client.js`) plus
`statMode: 'leaderboard'` (`src/config/game.js`): `Tab` shows the game's
**global daily top ten** — place · nick · score — and not this room at all.

The list is **pushed by the host**, on the same port as the badges below: the
room asks the master for the top once every 45 s and hands it to all eight of
its players, and a client in a match makes no request of its own. That is the
rule, not an optimisation — a player talks to their game server. At the scale
this is built for (100 games × 100 servers × 8 players) a client asking for
itself would mean thousands of requests a second for a player's own placement,
which no cache can collapse because it is personal to them.

The host sends no rows of the room's own, and there is no header. A player outside the top ten replaces the
tenth line with their own row and their own place; an unranked player gets a
dash instead of a place.

The room's own stat schema (`src/config/game.js`) is down to `name`, `status`,
`score` and `latency`, and it stays only because the engine writes the first,
second and last of them itself. The `rank` column is gone with the rating it
named.

### The badges of the top ten

A place in the global top is worn on the snake itself, and everybody in the
match sees it:

| Place | Badge |
| --- | --- |
| daily top 10 | a diamond pattern down the body |
| monthly top 10 | a crown over the head |

The places arrive on the client's `accolades` service (an engine service, see
[configuration.md](configuration.md#parts--game-entities)) and are matched **by nick** through the global top — the nick is globally unique,
so the badge follows the player onto any server, and it is gone the moment the
place is. It is worn in the match only: the lobby draws none of it.

## HUD panel

Left to right the panel declares five cells and shows exactly one: `score`.
`crystals` (what the snake carries right now), `dead` (0 alive / `crystals+1`
dead — the result overlay's channel), `mode` (`CRUISE`/`BOOST`, pushed by the
core into the engine's "active weapon" cell) and `time` are declared because
the engine's panel contract requires the client to name every host field, and
hidden by CSS. What you are carrying is told by the size of your snake.

## Bots

AI lives in this game's Rust core ([core.md](core.md)): bots are full
participants — they show up in the stat table, drive snakes and are steered
through the same input the players use. A bot heads for the nearest crystal
and swerves when the thing in front of it would kill it. They are added with
`/bot <count>` and give up their slot when a human needs one.

## Chat (`c` key) and commands

Plain text is a message to everyone. Messages starting with `/` are commands.
The engine parses none of its own: the `CommandProcessor` registry is filled
entirely by the game through `HostPlugin.chatCommands`, so the set below is
the whole set:

| Command | Action |
| --- | --- |
| `/bot <N>` | Set the number of bot snakes in the arena — a SET, not an add; `/bot 0` empties it. Restarts the round (the only way to put new actors in the world), which respawns everyone |
| `/name <nick>` | Change name (validated and broadcast by the engine) |
| `/rank` | Your place in the DAILY rating — place, how many are ranked and the points behind it. Re-fetched from the master at the moment you ask, because the place moves with other people's games; an unranked player gets a dash |
| `/nr` | New round — **dev mode only**; in this game a restart just respawns everyone, so it is a debugging tool, not a player's button |
| `/like <reason>` · `/unlike <reason>` | The engine's server rating — intercepted **on the client** and sent to the master, never reaching the host. See the engine's [master.md](https://github.com/lgick/vimp-engine/blob/main/docs/en/master.md#server-rating-likeunlike) |

`/timeleft` and `/mapname` are deliberately absent: they would lie here, since
the round and the map never end. Typing either answers "Command not found".

## What this game does not have

The engine offers a good deal this arena does not want, and every omission is
explicit rather than accidental:

- **No rounds.** `endlessRound: true` silences every restart the engine starts
  by itself — including "fewer than two active humans → wipe the stat table",
  which used to clear the scoreboard whenever the room emptied to one player.
- **No teams and no spectators.** `noSpectators: true`, one team (`players`),
  no `spectatorTeam` key, no vote on the way in.
- **No votes.** There is nothing to vote on — one team, one endless map — so
  the client config declares no `vote` module and the engine's `m` key is
  disarmed by overriding `modules.controls.modes[77]` (the defaults are merged
  recursively, so the key has to be overwritten, not dropped). Without that
  the menu still opened, empty.
- **No weapons, no friendly fire, no dynamic map bodies.** The corresponding
  config paths exist because the engine asserts them, and stay empty.
- **No `soundCues`.** All five engine cues are `null`: they fire off round and
  kill machinery this game does not use. The two sounds it has (`pickup`,
  `death`) are played positionally by the parts through `soundManager`.

## Kicks

- **Idle**: a player with no input/chat for longer than
  `idleKickTimeout.player` gets kicked.
- **Network**: a smoothed (EMA) latency above `maxLatency` or `maxMissedPings`
  consecutive missed pings closes the connection with a technical message.

Both are engine mechanisms — see the engine's
[configuration.md](https://github.com/lgick/vimp-engine/blob/main/docs/en/configuration.md#kicks-rtt-idlekicktimeout).

---

[← Previous: Architecture](architecture.md) · [Next: Core →](core.md)
