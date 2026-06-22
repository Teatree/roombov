// NOTE (2026-06-22): PROVISIONAL — added while investigating a reported
// "second phosphorus bomb does nothing" bug. It proves the *resolver* handles
// two overlapping phosphorus bombs correctly; the real bug (still being traced
// by the user) turned out to be elsewhere. Flagged for removal on the next
// project cleanup unless the phosphorus investigation gives it a reason to stay.
import { describe, expect, it } from 'vitest';
import { resolveTurn } from '../src/shared/systems/TurnResolver.ts';
import { TileType, type MapData } from '../src/shared/types/map.ts';
import type { MatchState, PlayerAction } from '../src/shared/types/match.ts';
import type { BombermanState } from '../src/shared/types/bomberman.ts';
import type { BombInstance } from '../src/shared/types/bombs.ts';

function openMap(size = 21): MapData {
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
    playerId, x, y, hp: 2, alive: true, escaped: false, facing: 'south',
    inventory: { slots: [null, null, null, null] },
    bleedingTurns: 0, rushActive: false, statusEffects: [],
    teleportedThisTurn: false, onHatchIdleTurns: 0, meleeTrapMode: false,
  };
}

function makeState(bombermen: BombermanState[], bombs: BombInstance[]): MatchState {
  return {
    matchId: 'm', mapId: 'test_open', phase: 'input', turnNumber: 1, phaseEndsAt: 0,
    bombermen, chests: [], doors: [], bodies: [], bombs,
    fireTiles: [], lightTiles: [], flares: [],
    smokeClouds: [], mines: [], phosphorusPending: [],
    shieldWalls: [], shieldShards: [], bloodTiles: [], escapeTiles: [],
  };
}

const phosBomb = (id: string, x: number, y: number): BombInstance =>
  ({ id, type: 'phosphorus', ownerId: 'p1', x, y, fuseRemaining: 0 });

const idle = new Map<string, PlayerAction>([['p1', { kind: 'idle' }]]);
const near = (tiles: { x: number; y: number }[], x: number, y: number, r = 2) =>
  tiles.some(t => Math.abs(t.x - x) <= r && Math.abs(t.y - y) <= r);

describe('phosphorus: a second bomb while the first is still burning', () => {
  it('test_phosphorus_second_bomb_overlapping_first_produces_its_own_light_and_fire', () => {
    const map = openMap();
    const owner = makeBomberman('p1', 0, 0);

    // Turn 1 — bomb A detonates at (5,5).
    let { state } = resolveTurn(makeState([owner], [phosBomb('bA', 5, 5)]), idle, map);
    expect(state.flares.filter(f => f.kind === 'phosphorus').length).toBe(1);
    expect(state.phosphorusPending.length).toBe(1);

    // Turn 2 — A's pending ignites fire near (5,5); bomb B detonates at (15,15)
    // while A's flare is still active.
    state.bombs.push(phosBomb('bB', 15, 15));
    ({ state } = resolveTurn(state, idle, map));

    const aFire = state.fireTiles.filter(f => f.kind === 'phosphorus');
    expect(near(aFire, 5, 5)).toBe(true);                 // A's fire ignited
    const phosFlares = state.flares.filter(f => f.kind === 'phosphorus');
    expect(phosFlares.length).toBe(2);                    // BOTH A and B lit
    expect(new Set(phosFlares.map(f => f.id)).size).toBe(2); // distinct ids
    expect(near(state.lightTiles, 15, 15)).toBe(true);    // B casts light
    expect(state.phosphorusPending.length).toBe(1);       // B's pending queued

    // Turn 3 — B's pending ignites fire near (15,15).
    ({ state } = resolveTurn(state, idle, map));
    expect(near(state.fireTiles.filter(f => f.kind === 'phosphorus'), 15, 15)).toBe(true);
  });
});
