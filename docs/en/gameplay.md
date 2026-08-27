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
   (`src/client/gameOver.js`). Pressing **OK** (or `R`) respawns immediately,
   in place, without a round boundary — the engine is never told anybody died.

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
  leader feeds the pack.

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

## Score and rank (Tab)

The engine's own scoring machinery never runs here (no kill is reported), so
`src/host/StatBridge.js` keeps the numbers itself, per game id, and none of
them ever goes down:

| Number | Meaning |
| --- | --- |
| `eaten` | crystals swallowed, summed over every life (internal) |
| `kills` | snakes that crashed into this one (internal) |
| `score` | `eaten + 15 * kills` — the column the table ranks by |
| `rank` | the engine's cross-game rating, kept on the auth service |

A kill pays a flat bonus and nothing else: the victim keeps its own score, and
what it was carrying is already scattered on the map — transferring the score
too was a second reward for the same event and made the leaders run away.

**Rank** is the number `/rank` reports and the only one that outlives the
session. The engine's own rule is ±1 per kill through `reportKill`, which this
game never reaches — and a kill here is somebody driving into *you*, which a
player cannot go and get, so kills alone left everybody at rank 0. This game
therefore pays **one rank point per 25 crystals eaten** on top of the point
per kill, and pushes the profiles to the auth service itself with
`vimp.flushPlayerData()` — at most once a minute, off the events the bridge
already handles (a pickup, a crash, a join or a leave), and only when
something has actually been earned:
the engine flushes at a round end and a map change, and this game has neither.
Rank is also what the lobby's Daily / Monthly / All-Time leaderboard ranks by.

The stat table has five columns — `snake`, `status`, `rank`, `score`, `ping` —
sorted by score descending, ties broken by rank. `deaths` is deliberately
absent: the engine never fills it here.

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
| `/rank` | Your current rank, as loaded from the auth service |
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
