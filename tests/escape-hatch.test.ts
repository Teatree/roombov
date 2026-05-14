import { describe, expect, it } from 'vitest';
import { resolveTurn } from '../src/shared/systems/TurnResolver.ts';
import { TileType, type MapData } from '../src/shared/types/map.ts';
import type { MatchState, PlayerAction } from '../src/shared/types/match.ts';
import type { BombermanState } from '../src/shared/types/bomberman.ts';

/** All-floor map of the given size, with a single escape hatch at the given coord. */
function mapWithHatch(hatchX: number, hatchY: number, size = 10): MapData {
  const grid: TileType[][] = [];
  for (let y = 0; y < size; y++) {
    const row: TileType[] = [];
    for (let x = 0; x < size; x++) row.push(TileType.FLOOR);
    grid.push(row);
  }
  return {
    id: 'test_hatch', name: 'test hatch', width: size, height: size, tileSize: 16,
    grid, spawns: [], escapeTiles: [{ x: hatchX, y: hatchY }], chestZones: [],
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
    treasures: {},
  } as unknown as BombermanState;
}

function makeState(bombermen: BombermanState[], escapeTiles: { x: number; y: number }[], brokenHatches: { x: number; y: number }[] = []): MatchState {
  return {
    matchId: 'm-hatch',
    mapId: 'test_hatch',
    phase: 'input',
    turnNumber: 1,
    phaseEndsAt: 0,
    bombermen,
    chests: [], doors: [], bodies: [], bombs: [],
    fireTiles: [], lightTiles: [], flares: [],
    smokeClouds: [], mines: [], phosphorusPending: [],
    shieldWalls: [], shieldShards: [],
    bloodTiles: [],
    escapeTiles,
    brokenHatches,
  };
}

function idleActions(ids: string[]): Map<string, PlayerAction> {
  const m = new Map<string, PlayerAction>();
  for (const id of ids) m.set(id, { kind: 'idle' });
  return m;
}

describe('Escape hatch — one-time use', () => {
  it('test_escapeHatch_idleOneTurn_marksEscapedAndBreaksHatch', () => {
    // Arrange — single bomberman standing on the only hatch, idle action.
    const map = mapWithHatch(3, 3);
    const bm = makeBomberman('p1', 3, 3);
    const state = makeState([bm], map.escapeTiles, []);

    // Act
    const { state: next, events } = resolveTurn(state, idleActions(['p1']), map);

    // Assert — bomberman is marked escaped.
    expect(next.bombermen[0].escaped).toBe(true);
    // brokenHatches now contains the hatch coord.
    expect(next.brokenHatches).toEqual([{ x: 3, y: 3 }]);
    // The escaped event carries the hatch position.
    const escEvents = events.filter(e => e.kind === 'escaped');
    expect(escEvents).toHaveLength(1);
    const ev = escEvents[0] as { playerId: string; hatchX: number; hatchY: number };
    expect(ev.playerId).toBe('p1');
    expect(ev.hatchX).toBe(3);
    expect(ev.hatchY).toBe(3);
  });

  it('test_escapeHatch_secondBombermanOnBrokenHatch_doesNotEscape', () => {
    // Arrange — hatch already broken, second bomberman idling on top.
    const map = mapWithHatch(2, 2);
    const bm = makeBomberman('p2', 2, 2);
    const state = makeState([bm], map.escapeTiles, [{ x: 2, y: 2 }]);

    // Act
    const { state: next, events } = resolveTurn(state, idleActions(['p2']), map);

    // Assert — no escape, no new event, brokenHatches unchanged.
    expect(next.bombermen[0].escaped).toBe(false);
    expect(events.filter(e => e.kind === 'escaped')).toHaveLength(0);
    expect(next.brokenHatches).toEqual([{ x: 2, y: 2 }]);
  });

  it('test_escapeHatch_brokenHatchesNotDuplicated_acrossMultipleResolverPasses', () => {
    // Arrange — escape happens, then we re-run the resolver several more
    // turns. The escaped bomberman remains alive+escaped, so step 10 keeps
    // emitting `escaped` events; brokenHatches must stay length 1.
    const map = mapWithHatch(4, 4);
    const bm = makeBomberman('p1', 4, 4);
    let state = makeState([bm], map.escapeTiles, []);
    state = resolveTurn(state, idleActions(['p1']), map).state;
    // After first escape, brokenHatches has [{4,4}]. The match doesn't end
    // because match-end check happens after step 10, so a sole escaped player
    // ends the match with reason 'all_escaped' — we instead seed a second
    // bomberman elsewhere so the match keeps running through subsequent turns.
    // For simplicity here, just spin one more turn on the already-ended state:
    expect(state.brokenHatches).toEqual([{ x: 4, y: 4 }]);
    // Re-run the resolver in a constructed mid-match state: add a living bm.
    state = {
      ...state,
      phase: 'input',
      bombermen: [...state.bombermen, makeBomberman('p2', 0, 0)],
    };
    const { state: next } = resolveTurn(state, idleActions(['p1', 'p2']), map);
    expect(next.brokenHatches).toEqual([{ x: 4, y: 4 }]);
  });

  it('test_escapeHatch_emptyBrokenHatchesField_isBackfilledByCloneState', () => {
    // Arrange — older saved state may not have brokenHatches set. cloneState
    // (called inside resolveTurn) must defensively backfill an empty array
    // so step 9.5's some() call doesn't throw.
    const map = mapWithHatch(5, 5);
    const bm = makeBomberman('p1', 0, 0);
    // Deliberately strip brokenHatches to mimic legacy state shape.
    const rawState = makeState([bm], map.escapeTiles, []);
    const legacyState = { ...rawState } as unknown as MatchState;
    delete (legacyState as Partial<MatchState>).brokenHatches;

    // Act — should not throw.
    const { state: next } = resolveTurn(legacyState, idleActions(['p1']), map);

    // Assert — field is present and well-formed (still empty since nobody escaped).
    expect(Array.isArray(next.brokenHatches)).toBe(true);
    expect(next.brokenHatches).toEqual([]);
  });
});
