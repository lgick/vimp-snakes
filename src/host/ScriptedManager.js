// The bot manager: the game half of "scripted participants". The engine calls
// exactly five methods on it — createMap, getCountsPerTeam, createScripted,
// removeScripted, removeOneForHuman — and never anything else
// (docs/ai/03-host-plugin.md § The `scripted` module contract).
//
// It holds no state that a host handoff may not lose: a restored room
// re-creates the map and respawns everyone, and this object is rebuilt from
// scratch. Worker-safe.
export default class ScriptedManager {
  constructor({ participants, coreAdapter, panel, stat, scripted }) {
    this._participants = participants;
    this._coreAdapter = coreAdapter;
    this._panel = panel;
    this._stat = stat;

    // `scripted` in the context is gameConfig.scripted — a config object, not
    // a module
    this._model = scripted.defaultModel;
    this._respawns = null;
  }

  // called on every map load, with the map data ALREADY scaled
  createMap(mapData) {
    this._respawns = mapData.respawns;
  }

  // { teamName: count } — the engine balances the teams by it
  getCountsPerTeam() {
    const counts = {};

    for (const participant of this._participants.getScripted()) {
      counts[participant.team] = (counts[participant.team] ?? 0) + 1;
    }

    return counts;
  }

  // returns how many were actually created — the caller reports that number,
  // not the number asked for
  createScripted(count, teamName = null) {
    if (!this._respawns) {
      return 0;
    }

    const playableTeams = this._participants.getPlayableTeams();
    let created = 0;

    for (let i = 0; i < count; i += 1) {
      if (this._participants.isFull) {
        break;
      }

      // no team asked for: fill the emptiest one that still has room, so a
      // room of bots stays balanced without anyone steering it. Trying only
      // the emptiest team would stall the whole loop once that one team is
      // out of respawn points while its neighbour still has some.
      const targetTeam = teamName ?? this._pickTeam(playableTeams);

      // team sizes only grow inside this loop, so «no room» is final: the
      // remaining iterations would do nothing but burn `count`
      if (!targetTeam || !this._hasRoom(targetTeam)) {
        break;
      }

      const gameId = this._participants.createScripted({
        team: targetTeam,
        model: this._model,
      });
      const participant = this._participants.get(gameId);

      // A bot has no socket, so the engine never writes its latency cell —
      // whatever is passed here is what the table shows for the whole match.
      // `status` starts empty rather than 'dead': in this game a spawned snake
      // is immediately in play, and the engine never writes that cell either,
      // because it is never told anyone died (src/config/game.js).
      this._stat.addUser(gameId, participant.teamId, {
        name: participant.name,
        status: '',
        latency: 'BOT',
      });
      this._panel.addUser(gameId);

      created += 1;
    }

    return created;
  }

  // the number of respawn points is the hard capacity of a team: past it the
  // engine has nowhere to put the actor
  _hasRoom(teamName) {
    const respawns = this._respawns[teamName];

    return Boolean(
      respawns && this._participants.getTeamSize(teamName) < respawns.length,
    );
  }

  _pickTeam(playableTeams) {
    return (
      [...playableTeams]
        .sort(
          (a, b) =>
            this._participants.getTeamSize(a) -
            this._participants.getTeamSize(b),
        )
        .find(team => this._hasRoom(team)) ?? null
    );
  }

  removeScripted(teamName = null) {
    const scripted = this._participants.getScripted();

    // The copy is not a style choice. `getScripted()` hands back the registry's
    // LIVE array, and `_remove` splices out of that same array — iterating it
    // directly skips every second bot, so a map change with four of them
    // removes two. `filter` already returns a new array; the other branch has
    // to make one.
    const toRemove = teamName
      ? scripted.filter(participant => participant.team === teamName)
      : [...scripted];

    toRemove.forEach(participant => this._remove(participant.gameId));
  }

  // a human needs a slot in a full team: free one and say whether it worked
  removeOneForHuman(teamName) {
    for (const participant of this._participants.getScripted()) {
      if (participant.team === teamName) {
        this._remove(participant.gameId);

        return true;
      }
    }

    return false;
  }

  _remove(gameId) {
    const participant = this._participants.get(gameId);

    if (!participant || !participant.isScripted) {
      return;
    }

    this._stat.removeUser(gameId, participant.teamId);
    this._panel.removeUser(gameId);
    this._coreAdapter.removePlayer(gameId);
    this._participants.remove(gameId);
  }
}
