import { describe, expect, it } from 'vitest';
import { hasLineOfSight } from '../src/shared/systems/LineOfSight.ts';
import { TileType } from '../src/shared/types/map.ts';

/**
 * Helpers for constructing tiny test grids. All tiles default to FLOOR;
 * caller seeds walls / furniture / closed doors.
 */
function makeGrid(width: number, height: number): TileType[][] {
  const grid: TileType[][] = [];
  for (let y = 0; y < height; y++) {
    const row: TileType[] = [];
    for (let x = 0; x < width; x++) row.push(TileType.FLOOR);
    grid.push(row);
  }
  return grid;
}

/** Compute the center-of-tile pixel coordinate at tileSize. */
function pxCenter(t: number, ts: number): number {
  return t * ts + ts / 2;
}

const TS = 32;

/**
 * Check LOS from tile A to tile B by converting both to pixel centers.
 * Covers the normal callsite pattern in TurnResolver / BotPlayer.
 */
function los(
  grid: TileType[][],
  ax: number, ay: number,
  bx: number, by: number,
  closed?: Set<string>,
): boolean {
  return hasLineOfSight(pxCenter(ax, TS), pxCenter(ay, TS), pxCenter(bx, TS), pxCenter(by, TS), grid, TS, closed);
}

describe('hasLineOfSight', () => {
  describe('symmetry', () => {
    it('test_los_is_symmetric_on_open_map', () => {
      // Arrange
      const grid = makeGrid(15, 15);
      const pairs: Array<[number, number, number, number]> = [
        [2, 2, 10, 7], [0, 0, 14, 14], [5, 3, 3, 5], [7, 9, 2, 4],
      ];
      // Act / Assert
      for (const [ax, ay, bx, by] of pairs) {
        const ab = los(grid, ax, ay, bx, by);
        const ba = los(grid, bx, by, ax, ay);
        expect(ab).toBe(ba);
      }
    });

    it('test_los_symmetric_with_wall_at_5_5_between_5_4_and_7_5', () => {
      // Arrange — this is the exact case from the Bresenham asymmetry bug
      // trace: forward (5,4)→(7,5) would test (5,5) as a corner neighbor
      // while reverse (7,5)→(5,4) tested (7,4). A wall at (5,5) would
      // previously make A→B block and B→A pass.
      const grid = makeGrid(12, 12);
      grid[5][5] = TileType.WALL;
      // Act
      const ab = los(grid, 5, 4, 7, 5);
      const ba = los(grid, 7, 5, 5, 4);
      // Assert — both directions must agree.
      expect(ab).toBe(ba);
    });

    it('test_los_symmetric_with_wall_at_7_4', () => {
      // Arrange — the mirror-image asymmetry case
      const grid = makeGrid(12, 12);
      grid[4][7] = TileType.WALL;
      // Act
      const ab = los(grid, 5, 4, 7, 5);
      const ba = los(grid, 7, 5, 5, 4);
      // Assert
      expect(ab).toBe(ba);
    });

    it('test_los_symmetric_through_L_corner_wall_layouts', () => {
      // Arrange — reproduces the "corner slip" scenario from playtesting:
      // an L-shape of walls. The ray from either side must see the same
      // result.
      const grid = makeGrid(12, 12);
      grid[5][5] = TileType.WALL;
      grid[5][6] = TileType.WALL;
      grid[6][5] = TileType.WALL;
      // Act
      const ab = los(grid, 4, 4, 7, 7);
      const ba = los(grid, 7, 7, 4, 4);
      // Assert
      expect(ab).toBe(ba);
      // Should be blocked either way — there's no clean diagonal gap.
      expect(ab).toBe(false);
    });
  });

  describe('blockers', () => {
    it('test_los_blocked_by_wall_directly_between_endpoints', () => {
      // Arrange
      const grid = makeGrid(10, 10);
      grid[5][6] = TileType.WALL;
      // Act / Assert — ray from (4,5) to (8,5) hits wall at (6,5)
      expect(los(grid, 4, 5, 8, 5)).toBe(false);
    });

    it('test_los_blocked_by_furniture_directly_between', () => {
      // Arrange
      const grid = makeGrid(10, 10);
      grid[5][6] = TileType.FURNITURE;
      // Act / Assert
      expect(los(grid, 4, 5, 8, 5)).toBe(false);
    });

    it('test_los_passes_through_open_space', () => {
      // Arrange
      const grid = makeGrid(10, 10);
      // Act / Assert
      expect(los(grid, 1, 1, 8, 8)).toBe(true);
    });

    it('test_los_blocked_by_closed_door', () => {
      // Arrange
      const grid = makeGrid(10, 10);
      const closed = new Set<string>(['5,3']);
      // Act — ray from (5,2) to (5,5) passes through door tile (5,3)
      const blocked = los(grid, 5, 2, 5, 5, closed);
      // Assert
      expect(blocked).toBe(false);
    });

    it('test_los_passes_through_open_door', () => {
      // Arrange — no entry in closedDoorTiles means the door is open
      const grid = makeGrid(10, 10);
      const closed = new Set<string>();
      // Act
      const result = los(grid, 5, 2, 5, 5, closed);
      // Assert
      expect(result).toBe(true);
    });
  });

  describe('endpoints', () => {
    it('test_los_endpoint_tiles_are_never_blockers', () => {
      // Arrange — even if the endpoint is technically "inside" a wall
      // (e.g. a bomberman standing on a wall tile via bad map data),
      // the start and end tiles are always considered passable so the
      // two endpoints can see each other.
      const grid = makeGrid(6, 6);
      grid[1][1] = TileType.WALL;
      grid[4][4] = TileType.WALL;
      // Act
      const result = los(grid, 1, 1, 4, 4);
      // Assert
      expect(result).toBe(true);
    });

    it('test_los_same_tile_always_true', () => {
      // Arrange
      const grid = makeGrid(5, 5);
      // Act / Assert
      expect(los(grid, 2, 2, 2, 2)).toBe(true);
    });
  });

  describe('corner slip prevention', () => {
    it('test_los_strict_corner_between_two_diagonal_walls', () => {
      // Arrange — classic "diagonal slip" test: walls at (5,4) and (4,5),
      // ray from (4,4) to (5,5). Loose Bresenham would let the ray sneak
      // through the corner. DDA strict-corner rule blocks it.
      const grid = makeGrid(8, 8);
      grid[4][5] = TileType.WALL;
      grid[5][4] = TileType.WALL;
      // Act
      const ab = los(grid, 4, 4, 5, 5);
      const ba = los(grid, 5, 5, 4, 4);
      // Assert — blocked AND symmetric
      expect(ab).toBe(false);
      expect(ba).toBe(false);
    });
  });
});
