import { describe, expect, it } from 'vitest';
import { resolveTurn } from '../src/shared/systems/TurnResolver.ts';
import { TileType, type MapData } from '../src/shared/types/map.ts';
import type { MatchState, PlayerAction } from '../src/shared/types/match.ts';
import type { BombermanState } from '../src/shared/types/bomberman.ts';

/**
 * All-floor `size`×`size` map. Override walls via `wallTiles` to box a
 * bomberman in for the all-blocked test case.
 */
function makeMap(size = 10, wallTiles: Array<{ x: number; y: number }> = []): MapData {
  const grid: TileType[][] = [];
  for (let y = 0; y < size; y++) {
    const row: TileType[] = [];
    for (let x = 0; x < size; x++) row.push(TileType.FLOOR);
    grid.push(row);
  }
  for (const w of wallTiles) {
    const row = grid[w.y];
    if (row) row[w.x] = TileType.WALL;
  }
  return {
    id: 'test_confused',
    name: 'test confused',
    width: size,
    height: size,
    tileSize: 16,
    grid,
    spawns: [],
    escapeTiles: [],
    chestZones: [],
  };
}

function makeBomberman(playerId: string, x: number, y: number, opts: { stunTurns?: number } = {}): BombermanState {
  const statusEffects =
    opts.stunTurns && opts.stunTurns > 0
      ? [{ kind: 'stunned' as const, turnsRemaining: opts.stunTurns }]
      : [];
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
    statusEffects,
    teleportedThisTurn: false,
    onHatchIdleTurns: 0,
    meleeTrapMode: false,
    treasures: {},
    keys: 0,
  } as unknown as BombermanState;
}

function makeState(bombermen: BombermanState[], matchId = 'm-confused', turnNumber = 1): MatchState {
  return {
    matchId,
    mapId: 'test_confused',
    phase: 'input',
    turnNumber,
    phaseEndsAt: 0,
    bombermen,
    chests: [], doors: [], bodies: [], bombs: [],
    fireTiles: [], lightTiles: [], flares: [],
    smokeClouds: [], mines: [], phosphorusPending: [],
    shieldWalls: [], shieldShards: [],
    bloodTiles: [],
    escapeTiles: [],
    brokenHatches: [],
    keys: [],
  } as unknown as MatchState;
}

function chebyshev(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

describe('Confused stumble (stunned status)', () => {
  it('test_confusedStumble_stunnedActor_movesOneTileInEightNeighbourhood', () => {
    // Arrange — open field, stunned bomberman, player submits idle (would
    // previously have stayed put; with confusion they should stumble 1 tile).
    const map = makeMap();
    const bm = makeBomberman('p1', 5, 5, { stunTurns: 2 });
    const state = makeState([bm]);
    const actions = new Map<string, PlayerAction>([['p1', { kind: 'idle' }]]);

    // Act
    const { state: next } = resolveTurn(state, actions, map);

    // Assert — moved exactly 1 tile (Chebyshev), still within the 8-neighborhood
    const after = next.bombermen.find(b => b.playerId === 'p1')!;
    expect(chebyshev(after.x, after.y, 5, 5)).toBe(1);
  });

  it('test_confusedStumble_playerSubmitsThrow_throwIsDiscardedAndReplacedWithStumble', () => {
    // Arrange — stunned bomberman with a throw action should NOT throw.
    const map = makeMap();
    const bm = makeBomberman('p1', 5, 5, { stunTurns: 2 });
    const state = makeState([bm]);
    const actions = new Map<string, PlayerAction>([
      ['p1', { kind: 'throw', slotIndex: 0, targetX: 5, targetY: 7 } as PlayerAction],
    ]);

    // Act
    const { state: next, events } = resolveTurn(state, actions, map);

    // Assert — no bomb placed, bomberman stumbled 1 tile
    const after = next.bombermen.find(b => b.playerId === 'p1')!;
    expect(next.bombs.length).toBe(0);
    expect(chebyshev(after.x, after.y, 5, 5)).toBe(1);
    expect(events.some(e => e.kind === 'bomb_placed')).toBe(false);
  });

  it('test_confusedStumble_sameInputs_isDeterministic', () => {
    // Arrange — two identical states should produce the same stumble.
    const map = makeMap();
    const stateA = makeState([makeBomberman('p1', 5, 5, { stunTurns: 2 })], 'm-seed', 7);
    const stateB = makeState([makeBomberman('p1', 5, 5, { stunTurns: 2 })], 'm-seed', 7);
    const actions = new Map<string, PlayerAction>([['p1', { kind: 'idle' }]]);

    // Act
    const a = resolveTurn(stateA, actions, map).state.bombermen[0]!;
    const b = resolveTurn(stateB, actions, map).state.bombermen[0]!;

    // Assert — identical destinations
    expect({ x: a.x, y: a.y }).toEqual({ x: b.x, y: b.y });
  });

  it('test_confusedStumble_boxedInByWalls_staysPut', () => {
    // Arrange — surround (5,5) with walls on all 8 neighbours.
    const wallTiles = [
      { x: 4, y: 4 }, { x: 5, y: 4 }, { x: 6, y: 4 },
      { x: 4, y: 5 },                 { x: 6, y: 5 },
      { x: 4, y: 6 }, { x: 5, y: 6 }, { x: 6, y: 6 },
    ];
    const map = makeMap(10, wallTiles);
    const bm = makeBomberman('p1', 5, 5, { stunTurns: 2 });
    const state = makeState([bm]);
    const actions = new Map<string, PlayerAction>([['p1', { kind: 'idle' }]]);

    // Act
    const { state: next, events } = resolveTurn(state, actions, map);

    // Assert — bomberman stayed on (5,5) and emitted an idle event
    const after = next.bombermen.find(b => b.playerId === 'p1')!;
    expect({ x: after.x, y: after.y }).toEqual({ x: 5, y: 5 });
    expect(events.some(e => e.kind === 'idle' && e.playerId === 'p1')).toBe(true);
  });

  it('test_confusedStumble_statusExpiresAfterOneTurn_thenFreeActionResumes', () => {
    // Arrange — bomberman enters the turn with stunTurns = 1 so the
    // end-of-turn ageing removes the status. The NEXT turn should accept
    // their submitted action normally (no forced stumble).
    const map = makeMap();
    const bm = makeBomberman('p1', 5, 5, { stunTurns: 1 });
    const state = makeState([bm]);
    const idle = new Map<string, PlayerAction>([['p1', { kind: 'idle' }]]);

    // Act — turn 1 (stunned, forced stumble), then turn 2 (clean, idle stays put)
    const t1 = resolveTurn(state, idle, map);
    const { x: afterStumbleX, y: afterStumbleY } = t1.state.bombermen[0]!;
    const t2 = resolveTurn(t1.state, idle, map);
    const t2Bm = t2.state.bombermen[0]!;

    // Assert — turn 1 moved 1 tile; turn 2 the actor was no longer stunned
    // and their submitted idle was respected (position unchanged).
    expect(chebyshev(afterStumbleX, afterStumbleY, 5, 5)).toBe(1);
    expect({ x: t2Bm.x, y: t2Bm.y }).toEqual({ x: afterStumbleX, y: afterStumbleY });
    expect((t2Bm.statusEffects ?? []).some(s => s.kind === 'stunned')).toBe(false);
  });

  it('test_confusedStumble_destinationOnlyDiagonal_picksDiagonal', () => {
    // Arrange — block all 4 cardinal neighbours; only diagonals are valid.
    const wallTiles = [
      { x: 5, y: 4 }, // N
      { x: 5, y: 6 }, // S
      { x: 4, y: 5 }, // W
      { x: 6, y: 5 }, // E
    ];
    const map = makeMap(10, wallTiles);
    const bm = makeBomberman('p1', 5, 5, { stunTurns: 2 });
    const state = makeState([bm]);
    const actions = new Map<string, PlayerAction>([['p1', { kind: 'idle' }]]);

    // Act
    const { state: next } = resolveTurn(state, actions, map);

    // Assert — stumble destination is one of the 4 diagonals
    const after = next.bombermen.find(b => b.playerId === 'p1')!;
    const diagonals = new Set([
      '4,4', '6,4', '4,6', '6,6',
    ]);
    expect(diagonals.has(`${after.x},${after.y}`)).toBe(true);
  });
});
