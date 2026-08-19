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
