import { describe, it, expect } from 'vitest';
import { ENGINE_API_VERSION } from 'vimp-engine/config/opcodes.js';
import { assertGameConfigShape } from 'vimp-engine/lib/gamePlugin.js';
import hostPlugin from '../../src/host/index.js';
import clientPlugin from '../../src/client/index.js';
import { SPINE_POINTS } from '../../src/config/snapshot.js';
import { RESPAWN_KEY_CODE } from '../../src/client/gameOver.js';

// Local safety net over `npm run check:contract`: the engine-side validator
// is the source of truth, but it runs as a separate command — these cases
// fail the ordinary test run, in the same change that broke them.
const clientConfig = hostPlugin.buildClientGameConfig();

describe('game config', () => {
  it('passes the engine gate that runs on plugin load', () => {
    expect(() => assertGameConfigShape(hostPlugin)).not.toThrow();
  });

  it('declares one API version in both halves', () => {
    expect(hostPlugin.engineApi).toBe(ENGINE_API_VERSION);
    expect(clientPlugin.engineApi).toBe(ENGINE_API_VERSION);
    expect(hostPlugin.id).toBe(clientPlugin.id);
  });
});

describe('snapshot schema', () => {
  const { snapshot } = hostPlugin.gameConfig;

  it('gives every block a unique id', () => {
    const ids = Object.values(snapshot).map(block => block.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps class 'hot' on indexed blocks only", () => {
    for (const [key, block] of Object.entries(snapshot)) {
      if (block.class === 'hot') {
        expect(['indexed8', 'indexedNoNull8'], key).toContain(block.kind);
      }
    }
  });

  it('interpolates f32 fields of hot blocks only', () => {
    for (const block of Object.values(snapshot)) {
      for (const field of block.fields) {
        if (field.interp !== undefined) {
          expect(block.class).toBe('hot');
          expect(field.ty).toBe('f32');
        }
      }
    }
  });

  it('declares exactly the blocks the two cores pack', () => {
    const { models } = hostPlugin.gameConfig.parts;
    const setIds = Object.values(hostPlugin.gameConfig.maps).map(
      map => map.setId ?? hostPlugin.gameConfig.mapSetId,
    );

    // The core names a snake block after its model (core/src/game.rs) and the
    // crystal block `cr` outright; the ENGINE adds one for the dynamic map
    // bodies, under the map's setId, on every packed frame. A block keyed by
    // none of those is one nothing ever fills — and a missing one makes the
    // packer reject the frame with "unknown snapshot key".
    const expected = new Set([...Object.keys(models), 'cr', ...setIds]);

    expect(new Set(Object.keys(snapshot))).toEqual(expected);
  });

  it('gives the snake block the 16-point spine the core resamples to', () => {
    // SPINE_POINTS is a contract in three places — this schema,
    // core/src/motion.rs and src/client/parts/Snake.js — and nothing at
    // runtime compares them. The row is 32 point fields plus five.
    const fields = snapshot.s1.fields;

    expect(fields).toHaveLength(SPINE_POINTS * 2 + 5);

    for (let i = 0; i < SPINE_POINTS; i += 1) {
      expect(fields[i * 2].name, `point ${i}`).toBe(`p${i}x`);
      expect(fields[i * 2 + 1].name, `point ${i}`).toBe(`p${i}y`);
    }

    expect(fields.slice(SPINE_POINTS * 2).map(field => field.name)).toEqual([
      'angle',
      'radius',
      'crystals',
      'color',
      'boost',
    ]);
  });
});

describe('client config', () => {
  const { gameSets, entitiesOnCanvas, bakedAssets } = clientConfig.parts;

  it('has a gameSets entry for every snapshot key and map setId', () => {
    for (const key of Object.keys(hostPlugin.gameConfig.snapshot)) {
      expect(Object.keys(gameSets)).toContain(key);
    }

    for (const map of Object.values(hostPlugin.gameConfig.maps)) {
      expect(Object.keys(gameSets)).toContain(
        map.setId ?? hostPlugin.gameConfig.mapSetId,
      );
    }
  });

  it('registers every part of a set on a canvas and exports its class', () => {
    for (const names of Object.values(gameSets)) {
      for (const name of names) {
        expect(entitiesOnCanvas[name], name).toBeDefined();
        expect(clientPlugin.parts[name], name).toBeDefined();
      }
    }
  });

  it('bakes only assets that have a baker', () => {
    for (const entries of Object.values(bakedAssets)) {
      for (const entry of entries) {
        expect(clientPlugin.bakers[entry.name], entry.name).toBeDefined();
        expect(entitiesOnCanvas[entry.component], entry.component).toBeDefined();
      }
    }
  });

  it('binds exactly the player keys the host declares', () => {
    const bound = new Set(
      Object.values(clientConfig.modules.controls.keySetList[1]),
    );
    const declared = new Set(Object.keys(hostPlugin.gameConfig.playerKeys));

    expect([...bound].sort()).toEqual([...declared].sort());
  });

  it('declares the pointer channel for the player key set only', () => {
    // The pointer is a SECOND way to play, not a replacement: A/D/W stay
    // bound (the assertion above proves it), and the channel is live only in
    // key set [1] — a spectator has no snake to steer. Dropping `pointer`
    // would silently make the game unplayable on a phone, where there is no
    // keyboard at all.
    const { pointer, keySetList } = clientConfig.modules.controls;

    expect(pointer.keySets).toEqual([1]);
    expect(keySetList[pointer.keySets[0]]).toBeDefined();
    expect(pointer.doubleTapMs).toBeGreaterThan(0);
    expect(pointer.doubleTapPx).toBeGreaterThan(0);
    expect(pointer.sendIntervalMs).toBeGreaterThanOrEqual(0);
  });

  it("maps the engine time key 't' to a time field", () => {
    const { keys, fields } = clientConfig.modules.panel;
    const field = fields.find(item => item.name === keys.t);

    expect(field?.type).toBe('time');
  });

  it('names every host panel field on the client side too', () => {
    // Invariant 6 (panelContract) mechanised: a host field whose wire key the
    // client does not map arrives at the panel under the name `undefined` and
    // is dropped without a word.
    const { keys, fields } = clientConfig.modules.panel;
    const names = new Set(fields.map(field => field.name));

    for (const [name, { key }] of Object.entries(
      hostPlugin.gameConfig.panel.fields,
    )) {
      expect(keys[key], `${name} -> ${key}`).toBeDefined();
      expect(names, `${name}`).toContain(keys[key]);
    }
  });

  // snakes-v3: Tab shows the game's GLOBAL top ten, not this room, so the
  // client columns no longer line up with the host's `key` indexes — there is
  // nothing to line them up with. What the client half must carry instead is
  // the mode and the slice it asks auth for.
  it('asks for the daily top ten instead of the room table', () => {
    const { params } = clientConfig.modules.stat;

    expect(params.mode).toBe('leaderboard');
    expect(params.period).toBe('day');
    expect(params.limit).toBe(10);
    expect(params.columns).toEqual(['#', 'snake', 'score']);
    // the order comes from auth: nothing to sort, and no team in a global list
    expect(params.sortList).toBeUndefined();
    expect(params.bodies).toBeUndefined();
    expect(params.heads).toBeUndefined();
  });

  // The mode is declared TWICE and both halves must agree: the client half
  // above says what to draw, `gameConfig.statMode` says that the host must
  // stop broadcasting the room table. Only the client half and the host
  // broadcasts a table every tick to a client that discards it; only the host
  // half and the client draws a room table nobody fills. Engine rule C11
  // checks this too — it is here because it is THIS game's declaration
  it('declares the same mode on the host half', () => {
    expect(hostPlugin.gameConfig.statMode).toBe('leaderboard');
    expect(hostPlugin.gameConfig.statMode).toBe(clientConfig.modules.stat.params.mode);
  });

  // the client asks nobody: the top arrives on the accolades port, pushed by
  // the host. A refresh interval here would mean a request from the match
  it('has no refresh interval of its own: the top is pushed, not fetched', () => {
    expect(clientConfig.modules.stat.params.refreshMs).toBeUndefined();
    expect(clientConfig.parts.componentDependencies.accolades).toContain('Snake');
  });

  it('keeps the host schema at name, status, score and ping', () => {
    // the `rank` column is gone with the room table, and the keys close up
    // behind it: a gap in the indexes is a column the engine writes nowhere.
    // The other four stay because the ENGINE writes them (RoundManager,
    // RTTManager) even while the client draws a global list
    const { stat } = hostPlugin.gameConfig;
    const byKey = Object.entries(stat)
      .sort(([, a], [, b]) => a.key - b.key)
      .map(([name]) => name);

    expect(byKey).toEqual(['name', 'status', 'score', 'latency']);
    expect(Object.values(stat).map(({ key }) => key)).toEqual([0, 1, 2, 3]);
    expect(stat.rank).toBeUndefined();
  });

  // nothing is voted on here any more: one team, one endless map, and a join
  // that no longer asks. The engine's own defaults still give the module its
  // elems, so the key that opened it has to be disarmed by the game — a menu
  // that opens empty is a menu the player was invited to use
  it('ships no vote module, no initial vote and no key to open one', () => {
    expect(clientConfig.modules.vote?.params).toBeUndefined();
    expect(hostPlugin.gameConfig.initialVote).toBeUndefined();
    // 77 is 'm', the engine's default mode key for the vote menu: the merge
    // is recursive, so the game has to overwrite the key — dropping it would
    // simply leave the engine's own value in place
    expect(clientConfig.modules.controls.modes[77]).toBe('');
  });

  it('leaves the two columns the engine fills to the engine', () => {
    // `name` and `latency` are written by the engine BY NAME (RoundManager,
    // HostGame) — renaming either one silently empties the column.
    const { stat } = hostPlugin.gameConfig;

    expect(stat.name).toBeDefined();
    expect(stat.latency).toBeDefined();
    // and `status`, which RoundManager writes on every team change
    expect(stat.status).toBeDefined();
  });

  it('names every panel key the client maps on the host side too', () => {
    // The mirror of the case above: a client key with no host field is a cell
    // that can never be filled. `t` is the one exception — the engine sends
    // the round time itself, without the game declaring it.
    const { keys } = clientConfig.modules.panel;
    const hostKeys = new Set([
      ...Object.values(hostPlugin.gameConfig.panel.fields).map(
        field => field.key,
      ),
      hostPlugin.gameConfig.panel.activeKey,
      't',
    ]);

    for (const key of Object.keys(keys)) {
      expect(hostKeys, key).toContain(key);
    }
  });

  it('lets the result screen press the respawn key the game actually binds', () => {
    // The OK button of the death overlay works by dispatching a synthetic key
    // event (src/client/gameOver.js) — a client plugin has no socket. If the
    // binding moves and the constant does not, the button silently stops
    // doing anything at all.
    const playerKeys = clientConfig.modules.controls.keySetList[1];

    expect(playerKeys[RESPAWN_KEY_CODE]).toBe('respawn');
    expect(hostPlugin.gameConfig.playerKeys.respawn.type).toBe(1);
  });

  it('gives every system message code a text', () => {
    const texts = clientConfig.modules.chat.params.messages;

    for (const code of Object.values(hostPlugin.systemMessages)) {
      const [group, index] = code.split(':');

      expect(texts[group]?.[Number(index)], code).toBeDefined();
    }
  });
});
