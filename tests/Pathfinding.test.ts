import { describe, it, expect } from 'vitest';
import { findPath } from '../src/shared/systems/Pathfinding.ts';
import { TileType, type MapData } from '../src/shared/types/map.ts';

function map(rows: string[]): MapData {
  // '.' = floor, '#' = wall
  const grid: TileType[][] = rows.map(row =>
    row.split('').map(ch => (ch === '#' ? TileType.WALL : TileType.FLOOR)),
  );
  return {
    id: 'test', name: 'test',
    width: rows[0].length, height: rows.length, tileSize: 32,
    grid,
    spawns: [], escapeTiles: [], coinZones: [], bombZones: [],
  };
}

describe('findPath', () => {
  it('returns empty array when start equals end', () => {
    const m = map(['....']);
    expect(findPath(1, 0, 1, 0, m)).toEqual([]);
  });

  it('returns direct neighbor for adjacent tiles', () => {
    const m = map(['....']);
    expect(findPath(0, 0, 1, 0, m)).toEqual([{ x: 1, y: 0 }]);
  });

  it('uses diagonal moves (8-connected)', () => {
    const m = map([
      '....',
      '....',
      '....',
    ]);
    // From (0,0) to (2,2), optimal is 2 diagonal moves
    const path = findPath(0, 0, 2, 2, m);
    expect(path).toHaveLength(2);
    expect(path[path.length - 1]).toEqual({ x: 2, y: 2 });
  });

  it('routes around walls', () => {
    const m = map([
      '....',
      '.##.',
      '....',
    ]);
    const path = findPath(0, 1, 3, 1, m);
    expect(path.length).toBeGreaterThan(0);
    expect(path[path.length - 1]).toEqual({ x: 3, y: 1 });
    // Must not step on any wall
    for (const p of path) {
      expect(m.grid[p.y][p.x]).toBe(TileType.FLOOR);
    }
  });

  it('returns empty when destination is a wall', () => {
    const m = map(['.#.']);
    expect(findPath(0, 0, 1, 0, m)).toEqual([]);
  });

  it('returns empty when destination is unreachable', () => {
    const m = map([
      '.#.',
      '.#.',
      '.#.',
    ]);
    expect(findPath(0, 0, 2, 0, m)).toEqual([]);
  });
});
