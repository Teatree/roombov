import { describe, expect, it } from 'vitest';
import { resolveTurn } from '../src/shared/systems/TurnResolver.ts';
import { TileType, type MapData } from '../src/shared/types/map.ts';
import type { MatchState, PlayerAction } from '../src/shared/types/match.ts';
import type { BombermanState } from '../src/shared/types/bomberman.ts';

function openMap(size = 20): MapData {
  const grid: TileType[][] = [];
  for (let y = 0; y < size; y++) {
    const row: TileType[] = [];
    for (let x = 0; x < size; x++) row.push(TileType.FLOOR);
    grid.push(row);
  }
  return {
    id: 'test_open', name: 'test open', width: size, height: size, tileSize: 16,
    grid, spawns: [], escapeTiles: [], chestZones: [],
  };
}

function makeBomberman(playerId: string, x: number, y: number): BombermanState {
  return {
    playerId,
    x, y,
    hp: 2,
    alive: true,
    escaped: false,
    facing: 'south',
    inventory: { slots: [null, null, null, null] },
    bleedingTurns: 0,
    rushActive: false,
    statusEffects: [],
    teleportedThisTurn: false,
    onHatchIdleTurns: 0,
    meleeTrapMode: false,
  } as unknown as BombermanState;
}

function makeState(opts: { isTutorial?: boolean; uavNextFireTurn?: number; turnNumber?: number } = {}): MatchState {
  return {
    matchId: 'm-uav',
    mapId: 'test_open',
    phase: 'input',
    turnNumber: opts.turnNumber ?? 1,
    phaseEndsAt: 0,
    bombermen: [makeBomberman('p1', 1, 1)],
    chests: [], doors: [], bodies: [], bombs: [],
    fireTiles: [], lightTiles: [], flares: [],
    smokeClouds: [], mines: [], phosphorusPending: [],
    shieldWalls: [], shieldShards: [],
    bloodTiles: [], escapeTiles: [],
    isTutorial: opts.isTutorial,
    uavNextFireTurn: opts.uavNextFireTurn,
  };
}

function advance(state: MatchState, map: MapData, turns: number): MatchState {
  let cur = state;
  const noActions = new Map<string, PlayerAction>();
  for (let i = 0; i < turns; i++) {
    const res = resolveTurn(cur, noActions, map);
    cur = res.state;
    if (cur.phase === 'ended') break;
  }
  return cur;
}

describe('UAV — periodic map-wide reveal', () => {
  it('test_uav_tutorialMatch_neverFiresOver50Turns', () => {
    // Arrange — tutorial flag set, no UAV scheduled.
    const map = openMap();
    const state = makeState({ isTutorial: true });

    // Act — run 50 turns; UAV step must skip every time.
    const finalState = advance(state, map, 50);

    // Assert — no UAV flares ever spawned (ids start with "uav_").
    expect(finalState.flares.every(f => !f.id.startsWith('uav_'))).toBe(true);
    // Tutorial state shouldn't get a uavNextFireTurn injected anywhere.
    expect(finalState.uavNextFireTurn).toBeUndefined();
  });

  it('test_uav_scheduledTurn_spawnsFlaresCoveringEveryWalkableTile', () => {
    // Arrange — real match scheduled to fire on turn 5. Open 20x20 map.
    const map = openMap(20);
    const state = makeState({ isTutorial: false, uavNextFireTurn: 5 });

    // Act — advance to turn 5 (the firing turn).
    const finalState = advance(state, map, 5);

    // Assert — flares were spawned and tagged with the uav_ prefix.
    const uavFlares = finalState.flares.filter(f => f.id.startsWith('uav_'));
    expect(uavFlares.length).toBeGreaterThan(0);

    // Each flare has the standard radius-4 player-flare shape.
    for (const f of uavFlares) {
      expect(f.initialRadius).toBe(4);
      expect(f.kind).toBeUndefined(); // default yellow visual
    }

    // Cover-check: every walkable tile must be within Chebyshev <=4 of some flare.
    const walkable: Array<{ x: number; y: number }> = [];
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        if (map.grid[y][x] === TileType.FLOOR) walkable.push({ x, y });
      }
    }
    for (const w of walkable) {
      const covered = uavFlares.some(f =>
        Math.max(Math.abs(f.x - w.x), Math.abs(f.y - w.y)) <= 4,
      );
      expect(covered, `walkable tile (${w.x},${w.y}) not covered by any UAV flare`).toBe(true);
    }
  });

  it('test_uav_afterFiring_reschedulesNextRunWithin60To90Turns', () => {
    // Arrange
    const map = openMap();
    const state = makeState({ isTutorial: false, uavNextFireTurn: 5 });

    // Act
    const finalState = advance(state, map, 5);

    // Assert — next UAV scheduled 60 to 90 turns out (exclusive of the just-fired turn).
    expect(finalState.uavNextFireTurn).toBeDefined();
    const gap = finalState.uavNextFireTurn! - 5;
    expect(gap).toBeGreaterThanOrEqual(60);
    expect(gap).toBeLessThanOrEqual(90);
  });

  it('test_uav_emitsUavFiredEvent_onScheduledTurn', () => {
    // Arrange
    const map = openMap();
    const state = makeState({ isTutorial: false, uavNextFireTurn: 1 });

    // Act — fire on turn 1 directly.
    const noActions = new Map<string, PlayerAction>();
    const { events } = resolveTurn(state, noActions, map);

    // Assert — exactly one uav_fired event with the right turn number and
    // per-tile coordinates so the client can play the flash burst VFX.
    const uavEvents = events.filter(e => e.kind === 'uav_fired');
    expect(uavEvents).toHaveLength(1);
    const ev = uavEvents[0] as { kind: 'uav_fired'; turnNumber: number; tiles: Array<{ x: number; y: number }> };
    expect(ev.turnNumber).toBe(1);
    expect(ev.tiles.length).toBeGreaterThan(0);
    // Every tile listed in the event corresponds to a UAV flare actually in state.
    const flareKeys = new Set(state.flares.map(f => `${f.x},${f.y}`));
    // (Use result state, not the initial — capture from a fresh resolve.)
    const res2 = resolveTurn(state, noActions, map);
    const stateFlares = new Set(res2.state.flares.map(f => `${f.x},${f.y}`));
    for (const t of ev.tiles) expect(stateFlares.has(`${t.x},${t.y}`)).toBe(true);
    void flareKeys;
  });
});
