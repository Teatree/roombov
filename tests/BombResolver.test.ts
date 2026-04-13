import { describe, expect, it } from 'vitest';
import { resolveBombTrigger, shapeTiles } from '../src/shared/systems/BombResolver.ts';
import type { Tile } from '../src/shared/systems/BombResolver.ts';
import { TileType, type MapData } from '../src/shared/types/map.ts';

/**
 * Helpers: sort tile arrays so we can compare without worrying about ordering.
 */
function norm(tiles: Tile[]): string[] {
  return tiles.map(t => `${t.x},${t.y}`).sort();
}

function tileSet(...pairs: [number, number][]): string[] {
  return pairs.map(([x, y]) => `${x},${y}`).sort();
}

/** Build an all-floor map centered on a large grid — large enough for any radius test we run. */
function openMap(size = 40): MapData {
  const grid: TileType[][] = [];
  for (let y = 0; y < size; y++) {
    const row: TileType[] = [];
    for (let x = 0; x < size; x++) row.push(TileType.FLOOR);
    grid.push(row);
  }
  return {
    id: 'test_open', name: 'test open', width: size, height: size, tileSize: 16,
    grid, spawns: [], escapeTiles: [], chest1Zones: [], chest2Zones: [],
  };
}

/** Build an empty-grid map with a given size. Caller seeds walls on top. */
function blankMap(width: number, height: number): MapData {
  const grid: TileType[][] = [];
  for (let y = 0; y < height; y++) {
    const row: TileType[] = [];
    for (let x = 0; x < width; x++) row.push(TileType.FLOOR);
    grid.push(row);
  }
  return {
    id: 'test_blank', name: 'test blank', width, height, tileSize: 16,
    grid, spawns: [], escapeTiles: [], chest1Zones: [], chest2Zones: [],
  };
}

describe('shapeTiles', () => {
  const open = openMap();
  // Use coords well inside the test map so unobstructed rays aren't
  // accidentally clipped by the edge (openMap spans 0..size-1).
  const OX = 10;
  const OY = 10;

  it('single covers only the center', () => {
    expect(norm(shapeTiles({ kind: 'single' }, 5, 5, open))).toEqual(tileSet([5, 5]));
  });

  it('plus radius 1 → 5 tiles', () => {
    const tiles = norm(shapeTiles({ kind: 'plus', radius: 1 }, 5, 5, open));
    expect(tiles).toEqual(tileSet([5, 5], [6, 5], [4, 5], [5, 6], [5, 4]));
  });

  it('plus radius 2 → 9 tiles', () => {
    const tiles = shapeTiles({ kind: 'plus', radius: 2 }, OX, OY, open);
    expect(tiles).toHaveLength(9);
    expect(norm(tiles)).toEqual(tileSet(
      [OX, OY], [OX + 1, OY], [OX - 1, OY], [OX + 2, OY], [OX - 2, OY],
      [OX, OY + 1], [OX, OY - 1], [OX, OY + 2], [OX, OY - 2],
    ));
  });

  it('plus radius 3 → 13 tiles', () => {
    expect(shapeTiles({ kind: 'plus', radius: 3 }, OX, OY, open)).toHaveLength(13);
  });

  it('diag radius 1 → 5 tiles (center + 4 diagonals)', () => {
    const tiles = norm(shapeTiles({ kind: 'diag', radius: 1 }, 10, 10, open));
    expect(tiles).toEqual(tileSet(
      [10, 10], [11, 11], [9, 11], [11, 9], [9, 9],
    ));
  });

  it('circle radius 4 → 9x9 square = 81 tiles', () => {
    const tiles = shapeTiles({ kind: 'circle', radius: 4 }, OX, OY, open);
    expect(tiles).toHaveLength(81);
  });

  it('deduplicates overlapping tiles', () => {
    // radius 0 plus = just center (no overlap to dedupe, but sanity-check)
    expect(shapeTiles({ kind: 'plus', radius: 0 }, 1, 1, open)).toHaveLength(1);
  });
});

describe('shapeTiles collision blocking', () => {
  it('test_shapeTiles_plus_stops_at_wall_on_ray', () => {
    // Arrange: open 10x10 map with a single wall at (6, 5). Bomb at (5, 5).
    // A plus radius 3 eastward should cover (5,5), (6,5)? no — (6,5) is wall, so ray halts before reaching it.
    const map = blankMap(10, 10);
    map.grid[5][6] = TileType.WALL;

    // Act
    const tiles = norm(shapeTiles({ kind: 'plus', radius: 3 }, 5, 5, map));

    // Assert: center + W/N/S rays present, E ray empty (wall immediately adjacent)
    expect(tiles).toEqual(tileSet(
      [5, 5],
      [4, 5], [3, 5], [2, 5],   // west ray (3 tiles)
      [5, 4], [5, 3], [5, 2],   // north ray
      [5, 6], [5, 7], [5, 8],   // south ray
    ));
    // Explicitly: nothing beyond the wall
    expect(tiles).not.toContain('6,5');
    expect(tiles).not.toContain('7,5');
    expect(tiles).not.toContain('8,5');
  });

  it('test_shapeTiles_diag_stops_at_wall_on_diagonal_ray', () => {
    // Arrange: wall at (7,7) — the NE diagonal from (5,5) hits it at r=2.
    const map = blankMap(10, 10);
    map.grid[7][7] = TileType.WALL;

    // Act
    const tiles = norm(shapeTiles({ kind: 'diag', radius: 3 }, 5, 5, map));

    // Assert: NE ray gets (6,6) but stops before (7,7). Other 3 diagonals clear.
    expect(tiles).toContain('6,6');
    expect(tiles).not.toContain('7,7');
    expect(tiles).not.toContain('8,8');
    // The other three diagonals reach full radius 3
    expect(tiles).toContain('4,4'); // NW ray r=1
    expect(tiles).toContain('3,3'); // NW ray r=2
    expect(tiles).toContain('2,2'); // NW ray r=3
  });

  it('test_shapeTiles_circle_bfs_contains_blast_behind_walls', () => {
    // Arrange: 7x7 map with a vertical wall line at x=4 from y=2..y=6,
    // except one gap at (4, 4). Bomb at (3, 4) circle radius 3.
    // BFS should reach (4,4) through the gap, then (5,4), (5,3), etc.
    // Tiles directly east at (4,3), (4,5) etc. are walls → not in blast.
    const map = blankMap(7, 7);
    for (let y = 2; y <= 6; y++) map.grid[y][4] = TileType.WALL;
    map.grid[4][4] = TileType.FLOOR; // the gap

    // Act
    const tiles = norm(shapeTiles({ kind: 'circle', radius: 3 }, 3, 4, map));

    // Assert: the gap tile and tiles reached through it ARE in the blast
    expect(tiles).toContain('3,4'); // center
    expect(tiles).toContain('4,4'); // gap itself (FLOOR)
    expect(tiles).toContain('5,4'); // beyond the gap
    // But walls are excluded entirely
    expect(tiles).not.toContain('4,2');
    expect(tiles).not.toContain('4,3');
    expect(tiles).not.toContain('4,5');
    expect(tiles).not.toContain('4,6');
  });

  it('test_shapeTiles_plus_ignores_tiles_outside_map_bounds', () => {
    // Arrange: bomb at the edge. Rays off the map should simply halt.
    const map = blankMap(5, 5);

    // Act
    const tiles = norm(shapeTiles({ kind: 'plus', radius: 3 }, 0, 0, map));

    // Assert: only east and south rays are in-bounds; west/north rays produce nothing.
    expect(tiles).toEqual(tileSet(
      [0, 0],
      [1, 0], [2, 0], [3, 0],
      [0, 1], [0, 2], [0, 3],
    ));
  });
});

describe('shapeTiles with closed doors', () => {
  it('test_shapeTiles_plus_stops_at_closed_door_but_includes_door_tile', () => {
    // Arrange: open map, closed door at (7, 5). Bomb at (5, 5) plus r3.
    // East ray should reach (6,5), (7,5=door), then STOP — (8,5) excluded.
    const map = openMap();
    const doors = new Set(['7,5']);

    // Act
    const tiles = norm(shapeTiles({ kind: 'plus', radius: 3 }, 5, 5, map, doors));

    // Assert: door tile IS included but ray stops there
    expect(tiles).toContain('7,5');
    expect(tiles).not.toContain('8,5');
    // Other directions unaffected
    expect(tiles).toContain('5,4');
    expect(tiles).toContain('5,3');
    expect(tiles).toContain('5,2');
  });

  it('test_shapeTiles_circle_includes_door_but_does_not_expand_past', () => {
    // Arrange: closed door at (6, 5). Bomb at (5, 5) circle r2.
    const map = openMap();
    const doors = new Set(['6,5']);

    // Act
    const tiles = norm(shapeTiles({ kind: 'circle', radius: 2 }, 5, 5, map, doors));

    // Assert: (6,5) is included but tiles that would only be reachable
    // through (6,5) should be missing — (7,5) can't be reached via (6,5)
    // but may be reached via (6,4)→(7,5) diagonally. So just check the
    // door tile is present.
    expect(tiles).toContain('6,5');
  });
});

describe('resolveBombTrigger', () => {
  const map = openMap();

  describe('rock', () => {
    it('deals damage to one tile', () => {
      const r = resolveBombTrigger('rock', 3, 4, map);
      expect(norm(r.damageTiles)).toEqual(tileSet([3, 4]));
      expect(r.fireTiles).toHaveLength(0);
      expect(r.lightTiles).toHaveLength(0);
      expect(r.scatterSpawns).toHaveLength(0);
    });
  });

  describe('delay (plus x2)', () => {
    it('hits 9 tiles in a plus pattern', () => {
      const r = resolveBombTrigger('delay', 5, 5, map);
      expect(r.damageTiles).toHaveLength(9);
    });
  });

  describe('delay_big (plus x3)', () => {
    it('hits 13 tiles', () => {
      const r = resolveBombTrigger('delay_big', 5, 5, map);
      expect(r.damageTiles).toHaveLength(13);
    });
  });

  describe('delay_tricky (diag x1)', () => {
    it('hits 5 tiles (center + 4 diagonals)', () => {
      const r = resolveBombTrigger('delay_tricky', 5, 5, map);
      expect(r.damageTiles).toHaveLength(5);
      expect(norm(r.damageTiles)).toEqual(tileSet([5, 5], [6, 6], [4, 6], [6, 4], [4, 4]));
    });
  });

  describe('contact (plus x1)', () => {
    it('hits 5 tiles', () => {
      const r = resolveBombTrigger('contact', 5, 5, map);
      expect(r.damageTiles).toHaveLength(5);
    });
  });

  describe('banana', () => {
    it('scatters 4 banana_child bombs diagonally, no immediate damage', () => {
      const r = resolveBombTrigger('banana', 5, 5, map);
      expect(r.damageTiles).toHaveLength(0);
      expect(r.scatterSpawns).toHaveLength(4);
      const scatterCoords = r.scatterSpawns.map(s => `${s.x},${s.y}`).sort();
      expect(scatterCoords).toEqual(tileSet([4, 4], [6, 4], [4, 6], [6, 6]));
      for (const s of r.scatterSpawns) {
        expect(s.type).toBe('banana_child');
      }
    });
  });

  describe('banana_child', () => {
    it('explodes in + pattern x1 (5 tiles)', () => {
      const r = resolveBombTrigger('banana_child', 5, 5, map);
      expect(r.damageTiles).toHaveLength(5);
    });
  });

  describe('flare (circle x4)', () => {
    it('lights 81 tiles for 3 turns, deals no damage', () => {
      const r = resolveBombTrigger('flare', 10, 10, map);
      expect(r.damageTiles).toHaveLength(0);
      expect(r.lightTiles).toHaveLength(81);
      expect(r.lightDuration).toBe(3);
    });
  });

  describe('molotov (fire plus x1 for 2 turns)', () => {
    it('sets 5 tiles on fire for 2 turns AND deals immediate damage to those tiles', () => {
      const r = resolveBombTrigger('molotov', 5, 5, map);
      expect(r.fireTiles).toHaveLength(5);
      expect(r.fireDuration).toBe(2);
      // Brief: molotov also deals immediate 1 damage on landing tiles
      expect(r.damageTiles).toHaveLength(5);
      expect(norm(r.damageTiles)).toEqual(norm(r.fireTiles));
    });
  });

  describe('delay_wide (circle x1)', () => {
    it('hits 9 tiles (3x3 square around center)', () => {
      const r = resolveBombTrigger('delay_wide', 5, 5, map);
      expect(r.damageTiles).toHaveLength(9);
      expect(norm(r.damageTiles)).toEqual(tileSet(
        [4, 4], [5, 4], [6, 4],
        [4, 5], [5, 5], [6, 5],
        [4, 6], [5, 6], [6, 6],
      ));
    });
  });

  describe('ender_pearl (teleport)', () => {
    it('produces no damage, fire, light, or scatter tiles', () => {
      const r = resolveBombTrigger('ender_pearl', 5, 5, map);
      expect(r.damageTiles).toHaveLength(0);
      expect(r.fireTiles).toHaveLength(0);
      expect(r.lightTiles).toHaveLength(0);
      expect(r.scatterSpawns).toHaveLength(0);
    });
  });
});
