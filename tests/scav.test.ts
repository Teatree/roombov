import { describe, expect, it } from 'vitest';
import { resolveTurn } from '../src/shared/systems/TurnResolver.ts';
import { TileType, type MapData } from '../src/shared/types/map.ts';
import type { MatchState, PlayerAction } from '../src/shared/types/match.ts';
import type { BombermanState } from '../src/shared/types/bomberman.ts';

function openMap(size = 20, spawns: Array<{ x: number; y: number }> = []): MapData {
  const grid: TileType[][] = [];
  for (let y = 0; y < size; y++) {
    const row: TileType[] = [];
    for (let x = 0; x < size; x++) row.push(TileType.FLOOR);
    grid.push(row);
  }
  return {
    id: 'test_open', name: 'test open', width: size, height: size, tileSize: 16,
    grid, spawns, escapeTiles: [], chestZones: [],
  };
}

function makeBomberman(playerId: string, x: number, y: number, opts: Partial<BombermanState> = {}): BombermanState {
  return {
    playerId,
    isBot: false,
    bombermanId: 'bm',
    colors: { shirt: 0, pants: 0, hair: 0 },
    tint: 0xffffff,
    character: 'char1',
    x, y,
    hp: 2,
    alive: true,
    treasures: {},
    coins: 0,
    keys: 0,
    maxCustomSlots: 4,
    stackSize: 6,
    inventory: { slots: [null, null, null, null] },
    bleedingTurns: 0,
    escaped: false,
    rushCooldown: 0,
    rushActive: false,
    teleportedThisTurn: false,
    onHatchIdleTurns: 0,
    statusEffects: [],
    meleeTrapMode: false,
    ...opts,
  };
}

function makeState(opts: {
  isTutorial?: boolean;
  scavNextSpawnTurn?: number;
  turnNumber?: number;
  bombermen?: BombermanState[];
} = {}): MatchState {
  return {
    matchId: 'm-scav',
    mapId: 'test_open',
    phase: 'input',
    turnNumber: opts.turnNumber ?? 1,
    phaseEndsAt: 0,
    bombermen: opts.bombermen ?? [makeBomberman('p1', 18, 18)],
    chests: [], doors: [], bodies: [], bombs: [],
    fireTiles: [], lightTiles: [], flares: [],
    smokeClouds: [], mines: [], phosphorusPending: [],
    shieldWalls: [], shieldShards: [],
    bloodTiles: [], escapeTiles: [],
    brokenHatches: [],
    keys: [],
    isTutorial: opts.isTutorial,
    scavNextSpawnTurn: opts.scavNextSpawnTurn,
  };
}

function advance(state: MatchState, map: MapData, turns: number, actions = new Map<string, PlayerAction>()): MatchState {
  let cur = state;
  for (let i = 0; i < turns; i++) {
    const res = resolveTurn(cur, actions, map);
    cur = res.state;
    if (cur.phase === 'ended') break;
  }
  return cur;
}

describe('Scavengers — periodic NPC spawn waves', () => {
  it('test_scav_tutorialMatch_neverSpawnsOver50Turns', () => {
    // Arrange — tutorial flag set, no spawn scheduled. Spawn step must skip.
    const map = openMap(20, [{ x: 1, y: 1 }, { x: 18, y: 1 }]);
    const state = makeState({ isTutorial: true });

    // Act
    const finalState = advance(state, map, 50);

    // Assert — no scavs spawned over 50 turns, no spawn ever scheduled.
    expect(finalState.bombermen.every(b => !b.isScav)).toBe(true);
    expect(finalState.scavNextSpawnTurn).toBeUndefined();
  });

  it('test_scav_scheduledTurn_spawnsTwoOnPlayerSpawnTiles', () => {
    // Arrange — real match, two spawn tiles, one player far enough away from
    // both to leave them out of LoS so both qualify for a scav.
    const map = openMap(20, [{ x: 1, y: 1 }, { x: 18, y: 1 }]);
    const state = makeState({
      isTutorial: false,
      scavNextSpawnTurn: 5,
      bombermen: [makeBomberman('p1', 10, 18)], // far south, no LoS to either spawn
    });

    // Act
    const finalState = advance(state, map, 5);

    // Assert — exactly two new scavs, each on one of the spawn tiles.
    const scavs = finalState.bombermen.filter(b => b.isScav);
    expect(scavs).toHaveLength(2);
    const onSpawnTile = (b: BombermanState) =>
      (b.x === 1 && b.y === 1) || (b.x === 18 && b.y === 1);
    expect(scavs.every(onSpawnTile)).toBe(true);
    // Both must use the scav visual and the fixed loadout.
    for (const s of scavs) {
      expect(s.character).toBe('char5');
      expect(s.isBot).toBe(true);
      expect(s.maxCustomSlots).toBe(4);
      expect(s.stackSize).toBe(6);
      expect(s.inventory.slots[0]).toEqual({ type: 'flare', count: 2 });
      expect(s.inventory.slots[1]).toEqual({ type: 'bomb', count: 6 });
      expect(s.inventory.slots[2]).toEqual({ type: 'bomb_wide', count: 3 });
      expect(s.inventory.slots[3]).toEqual({ type: 'delay_tricky', count: 3 });
    }
  });

  it('test_scav_spawnSuppressed_whenPlayerInLosOfAllSpawnTiles', () => {
    // Arrange — single spawn tile, player standing right on it so LoS check fails.
    const map = openMap(20, [{ x: 5, y: 5 }]);
    const state = makeState({
      isTutorial: false,
      scavNextSpawnTurn: 3,
      bombermen: [makeBomberman('p1', 5, 5)],
    });

    // Act
    const finalState = advance(state, map, 3);

    // Assert — no scavs spawned, but reschedule still happened (we don't
    // retry the same turn; we wait for the next cadence).
    expect(finalState.bombermen.filter(b => b.isScav)).toHaveLength(0);
    expect(finalState.scavNextSpawnTurn).toBeDefined();
    expect(finalState.scavNextSpawnTurn! - 3).toBeGreaterThanOrEqual(20);
    expect(finalState.scavNextSpawnTurn! - 3).toBeLessThanOrEqual(30);
  });

  it('test_scav_afterFiring_reschedulesWithin20To30Turns', () => {
    // Arrange — spawn on turn 5, far player so both tiles qualify.
    const map = openMap(20, [{ x: 1, y: 1 }, { x: 18, y: 1 }]);
    const state = makeState({
      isTutorial: false,
      scavNextSpawnTurn: 5,
      bombermen: [makeBomberman('p1', 10, 18)],
    });

    // Act
    const finalState = advance(state, map, 5);

    // Assert — next wave scheduled 20-30 turns later.
    expect(finalState.scavNextSpawnTurn).toBeDefined();
    const gap = finalState.scavNextSpawnTurn! - 5;
    expect(gap).toBeGreaterThanOrEqual(20);
    expect(gap).toBeLessThanOrEqual(30);
  });

  it('test_scav_endCheck_ignoresAliveScavs', () => {
    // Arrange — dead player + one alive scav already in state. End-check
    // should fire on the next resolve regardless of the scav.
    const dead = makeBomberman('p1', 5, 5, { alive: false, hp: 0 });
    const scav = makeBomberman('scav_0', 10, 10, {
      isBot: true, isScav: true, character: 'char5', bombermanId: 'scav',
    });
    const map = openMap(20, [{ x: 1, y: 1 }]);
    const state = makeState({
      isTutorial: false,
      bombermen: [dead, scav],
    });

    // Act — one resolve is enough; end-check is step 11.
    const finalState = advance(state, map, 1);

    // Assert — match ended (scav alive, but excluded from end-check filter).
    expect(finalState.phase).toBe('ended');
    expect(finalState.endReason).toBe('all_dead');
  });
});
