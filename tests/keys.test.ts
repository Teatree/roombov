import { describe, expect, it } from 'vitest';
import { resolveTurn } from '../src/shared/systems/TurnResolver.ts';
import { TileType, type MapData } from '../src/shared/types/map.ts';
import type { MatchState, PlayerAction, DroppedBody } from '../src/shared/types/match.ts';
import type { BombermanState } from '../src/shared/types/bomberman.ts';
import { BALANCE } from '../src/shared/config/balance.ts';

function openMap(size = 10, hatchX = 5, hatchY = 5): MapData {
  const grid: TileType[][] = [];
  for (let y = 0; y < size; y++) {
    const row: TileType[] = [];
    for (let x = 0; x < size; x++) row.push(TileType.FLOOR);
    grid.push(row);
  }
  return {
    id: 'test_keys', name: 'test keys', width: size, height: size, tileSize: 16,
    grid, spawns: [], escapeTiles: [{ id: 0, x: hatchX, y: hatchY }], chestZones: [], keySpawns: [],
  };
}

function makeBomberman(playerId: string, x: number, y: number, opts: { keys?: number; rushActive?: boolean } = {}): BombermanState {
  return {
    playerId,
    x, y,
    hp: 2,
    alive: true,
    escaped: false,
    facing: 'south',
    inventory: { slots: [null, null, null, null] },
    bleedingTurns: 0,
    rushActive: opts.rushActive ?? false,
    statusEffects: [],
    teleportedThisTurn: false,
    onHatchIdleTurns: 0,
    meleeTrapMode: false,
    treasures: {},
    keys: opts.keys ?? 0,
  } as unknown as BombermanState;
}

function makeBody(id: string, x: number, y: number, keys: number): DroppedBody {
  return {
    id, x, y,
    ownerPlayerId: 'dead',
    treasures: {},
    keys,
    bombs: [],
    maxCustomSlots: 4,
    stackSize: 4,
  };
}

function makeState(opts: {
  bombermen: BombermanState[];
  keys?: { x: number; y: number }[];
  bodies?: DroppedBody[];
  isTutorial?: boolean;
  escapeTiles?: { x: number; y: number }[];
  brokenHatches?: { x: number; y: number }[];
}): MatchState {
  return {
    matchId: 'm-keys',
    mapId: 'test_keys',
    phase: 'input',
    turnNumber: 1,
    phaseEndsAt: 0,
    bombermen: opts.bombermen,
    chests: [], doors: [], bodies: opts.bodies ?? [], bombs: [],
    fireTiles: [], lightTiles: [], flares: [],
    smokeClouds: [], mines: [], phosphorusPending: [],
    shieldWalls: [], shieldShards: [],
    bloodTiles: [],
    escapeTiles: opts.escapeTiles ?? [{ x: 5, y: 5 }],
    brokenHatches: opts.brokenHatches ?? [],
    keys: opts.keys ?? [],
    isTutorial: opts.isTutorial,
  };
}

function moveTo(playerId: string, x: number, y: number): Map<string, PlayerAction> {
  const m = new Map<string, PlayerAction>();
  m.set(playerId, { kind: 'move', x, y });
  return m;
}

function idleActions(ids: string[]): Map<string, PlayerAction> {
  const m = new Map<string, PlayerAction>();
  for (const id of ids) m.set(id, { kind: 'idle' });
  return m;
}

describe('Keys system', () => {
  it('test_keys_walkOntoFloorKey_picksItUp', () => {
    // Arrange — bomberman at (1,1), key at (2,1)
    const map = openMap();
    const bm = makeBomberman('p1', 1, 1);
    const state = makeState({ bombermen: [bm], keys: [{ x: 2, y: 1 }] });

    // Act
    const { state: next, events } = resolveTurn(state, moveTo('p1', 2, 1), map);

    // Assert
    expect(next.bombermen[0].keys).toBe(1);
    expect(next.keys).toEqual([]);
    const picks = events.filter(e => e.kind === 'key_pickup') as Array<{ source: string; newCount: number; playerId: string }>;
    expect(picks).toHaveLength(1);
    expect(picks[0].source).toBe('floor');
    expect(picks[0].newCount).toBe(1);
  });

  it('test_keys_capReached_walkPastKey_doesNotPickUp', () => {
    // Arrange — bomberman already at cap walks onto a key tile.
    const map = openMap();
    const cap = BALANCE.keys.requiredPerHatch;
    const bm = makeBomberman('p1', 1, 1, { keys: cap });
    const state = makeState({ bombermen: [bm], keys: [{ x: 2, y: 1 }] });

    // Act
    const { state: next, events } = resolveTurn(state, moveTo('p1', 2, 1), map);

    // Assert
    expect(next.bombermen[0].keys).toBe(cap);
    expect(next.keys).toEqual([{ x: 2, y: 1 }]);
    expect(events.filter(e => e.kind === 'key_pickup')).toHaveLength(0);
  });

  it('test_keys_rushThroughKeyTile_picksItUp', () => {
    // Arrange — rush move from (1,1) to (3,1) crossing key at (2,1).
    const map = openMap();
    const bm = makeBomberman('p1', 1, 1, { rushActive: true });
    const state = makeState({ bombermen: [bm], keys: [{ x: 2, y: 1 }] });
    const actions = new Map<string, PlayerAction>();
    actions.set('p1', { kind: 'move', x: 2, y: 1, rushX: 3, rushY: 1 });

    // Act
    const { state: next, events } = resolveTurn(state, actions, map);

    // Assert — landed at (3,1) but picked up the key on the intermediate step.
    expect(next.bombermen[0].x).toBe(3);
    expect(next.bombermen[0].y).toBe(1);
    expect(next.bombermen[0].keys).toBe(1);
    expect(next.keys).toEqual([]);
    expect(events.filter(e => e.kind === 'key_pickup')).toHaveLength(1);
  });

  it('test_keys_walkOntoBodyWithKeys_autoTransfers', () => {
    // Arrange — body at (2,1) holding 2 keys, picker at (1,1) with 0.
    const map = openMap();
    const bm = makeBomberman('p1', 1, 1);
    const body = makeBody('b1', 2, 1, 2);
    const state = makeState({ bombermen: [bm], bodies: [body] });

    // Act
    const { state: next, events } = resolveTurn(state, moveTo('p1', 2, 1), map);

    // Assert
    expect(next.bombermen[0].keys).toBe(2);
    expect(next.bodies[0].keys).toBe(0);
    const picks = events.filter(e => e.kind === 'key_pickup') as Array<{ source: string }>;
    expect(picks).toHaveLength(2);
    expect(picks.every(p => p.source === 'body')).toBe(true);
  });

  it('test_keys_escapeBlocked_whenBelowCap', () => {
    // Arrange — on hatch, idle, 0 keys, not tutorial.
    const map = openMap();
    const bm = makeBomberman('p1', 5, 5, { keys: 0 });
    const state = makeState({ bombermen: [bm] });

    // Act
    const { state: next, events } = resolveTurn(state, idleActions(['p1']), map);

    // Assert
    expect(next.bombermen[0].escaped).toBe(false);
    expect(next.bombermen[0].onHatchIdleTurns).toBe(0);
    expect(events.filter(e => e.kind === 'escaped')).toHaveLength(0);
  });

  it('test_keys_escapeAllowed_whenAtCap_consumesKeys', () => {
    // Arrange — on hatch, idle, full keys.
    const map = openMap();
    const cap = BALANCE.keys.requiredPerHatch;
    const bm = makeBomberman('p1', 5, 5, { keys: cap });
    const state = makeState({ bombermen: [bm] });

    // Act
    const { state: next, events } = resolveTurn(state, idleActions(['p1']), map);

    // Assert
    expect(next.bombermen[0].escaped).toBe(true);
    expect(next.bombermen[0].keys).toBe(0);
    expect(next.brokenHatches).toEqual([{ x: 5, y: 5 }]);
    expect(events.filter(e => e.kind === 'escaped')).toHaveLength(1);
  });

  it('test_keys_deadBomberman_dropsKeysIntoBody', () => {
    // Arrange — bomberman has 2 keys and 0 hp at start of turn (synthesized
    // death will fire in step 9). To trigger death cleanly without a bomb,
    // we set hp = 0 directly; the resolver's death pass picks it up.
    const map = openMap();
    const bm = makeBomberman('p1', 1, 1, { keys: 2 });
    bm.hp = 0;
    const state = makeState({ bombermen: [bm] });

    // Act
    const { state: next } = resolveTurn(state, idleActions(['p1']), map);

    // Assert — body inherits the keys, dead bomberman now has 0.
    expect(next.bodies).toHaveLength(1);
    expect(next.bodies[0].keys).toBe(2);
    expect(next.bombermen[0].keys).toBe(0);
    expect(next.bombermen[0].alive).toBe(false);
  });

  it('test_keys_tutorialFlag_requiresOneKey_escapesWith1', () => {
    // Arrange — tutorial match, bomberman idles on hatch with 1 key
    // (the tutorial requirement per BALANCE.keys.tutorialRequiredPerHatch
    // after NEW_META §7).
    const map = openMap();
    const bm = makeBomberman('p1', 5, 5, { keys: 1 });
    const state = makeState({ bombermen: [bm], isTutorial: true });

    // Act
    const { state: next, events } = resolveTurn(state, idleActions(['p1']), map);

    // Assert — escape goes through with the reduced tutorial cost.
    expect(next.bombermen[0].escaped).toBe(true);
    expect(events.filter(e => e.kind === 'escaped')).toHaveLength(1);
  });

  it('test_keys_tutorialFlag_zeroKeys_blocksEscape', () => {
    // Arrange — tutorial no longer bypasses keys entirely (NEW_META §7);
    // 0 keys must still block escape.
    const map = openMap();
    const bm = makeBomberman('p1', 5, 5, { keys: 0 });
    const state = makeState({ bombermen: [bm], isTutorial: true });

    // Act
    const { state: next, events } = resolveTurn(state, idleActions(['p1']), map);

    // Assert — escape blocked.
    expect(next.bombermen[0].escaped).toBe(false);
    expect(events.filter(e => e.kind === 'escaped')).toHaveLength(0);
  });

  it('test_keys_emptyKeysField_isBackfilledByCloneState', () => {
    // Arrange — legacy MatchState shape with no `keys` field.
    const map = openMap();
    const bm = makeBomberman('p1', 1, 1);
    const rawState = makeState({ bombermen: [bm] });
    const legacy = { ...rawState } as Partial<MatchState>;
    delete legacy.keys;

    // Act — should not throw.
    const { state: next } = resolveTurn(legacy as MatchState, idleActions(['p1']), map);

    // Assert — backfilled empty array; no crash on undefined.some().
    expect(Array.isArray(next.keys)).toBe(true);
    expect(next.keys).toEqual([]);
  });
});
