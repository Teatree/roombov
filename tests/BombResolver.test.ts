import { describe, expect, it } from 'vitest';
import { resolveBombTrigger, shapeTiles } from '../src/shared/systems/BombResolver.ts';
import type { Tile } from '../src/shared/systems/BombResolver.ts';

/**
 * Helpers: sort tile arrays so we can compare without worrying about ordering.
 */
function norm(tiles: Tile[]): string[] {
  return tiles.map(t => `${t.x},${t.y}`).sort();
}

function tileSet(...pairs: [number, number][]): string[] {
  return pairs.map(([x, y]) => `${x},${y}`).sort();
}

describe('shapeTiles', () => {
  it('single covers only the center', () => {
    expect(norm(shapeTiles({ kind: 'single' }, 5, 5))).toEqual(tileSet([5, 5]));
  });

  it('plus radius 1 → 5 tiles', () => {
    const tiles = norm(shapeTiles({ kind: 'plus', radius: 1 }, 5, 5));
    expect(tiles).toEqual(tileSet([5, 5], [6, 5], [4, 5], [5, 6], [5, 4]));
  });

  it('plus radius 2 → 9 tiles', () => {
    const tiles = shapeTiles({ kind: 'plus', radius: 2 }, 0, 0);
    expect(tiles).toHaveLength(9);
    expect(norm(tiles)).toEqual(tileSet(
      [0, 0], [1, 0], [-1, 0], [2, 0], [-2, 0], [0, 1], [0, -1], [0, 2], [0, -2],
    ));
  });

  it('plus radius 3 → 13 tiles', () => {
    expect(shapeTiles({ kind: 'plus', radius: 3 }, 0, 0)).toHaveLength(13);
  });

  it('diag radius 1 → 5 tiles (center + 4 diagonals)', () => {
    const tiles = norm(shapeTiles({ kind: 'diag', radius: 1 }, 10, 10));
    expect(tiles).toEqual(tileSet(
      [10, 10], [11, 11], [9, 11], [11, 9], [9, 9],
    ));
  });

  it('circle radius 4 → 9x9 square = 81 tiles', () => {
    const tiles = shapeTiles({ kind: 'circle', radius: 4 }, 0, 0);
    expect(tiles).toHaveLength(81);
  });

  it('deduplicates overlapping tiles', () => {
    // radius 0 plus = just center (no overlap to dedupe, but sanity-check)
    expect(shapeTiles({ kind: 'plus', radius: 0 }, 1, 1)).toHaveLength(1);
  });
});

describe('resolveBombTrigger', () => {
  describe('rock', () => {
    it('deals damage to one tile', () => {
      const r = resolveBombTrigger('rock', 3, 4);
      expect(norm(r.damageTiles)).toEqual(tileSet([3, 4]));
      expect(r.fireTiles).toHaveLength(0);
      expect(r.lightTiles).toHaveLength(0);
      expect(r.scatterSpawns).toHaveLength(0);
    });
  });

  describe('delay (plus x2)', () => {
    it('hits 9 tiles in a plus pattern', () => {
      const r = resolveBombTrigger('delay', 5, 5);
      expect(r.damageTiles).toHaveLength(9);
    });
  });

  describe('delay_big (plus x3)', () => {
    it('hits 13 tiles', () => {
      const r = resolveBombTrigger('delay_big', 5, 5);
      expect(r.damageTiles).toHaveLength(13);
    });
  });

  describe('delay_tricky (diag x1)', () => {
    it('hits 5 tiles (center + 4 diagonals)', () => {
      const r = resolveBombTrigger('delay_tricky', 5, 5);
      expect(r.damageTiles).toHaveLength(5);
      expect(norm(r.damageTiles)).toEqual(tileSet([5, 5], [6, 6], [4, 6], [6, 4], [4, 4]));
    });
  });

  describe('contact (plus x1)', () => {
    it('hits 5 tiles', () => {
      const r = resolveBombTrigger('contact', 0, 0);
      expect(r.damageTiles).toHaveLength(5);
    });
  });

  describe('banana', () => {
    it('scatters 4 banana_child bombs diagonally, no immediate damage', () => {
      const r = resolveBombTrigger('banana', 5, 5);
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
      const r = resolveBombTrigger('banana_child', 5, 5);
      expect(r.damageTiles).toHaveLength(5);
    });
  });

  describe('flare (circle x4)', () => {
    it('lights 81 tiles for 3 turns, deals no damage', () => {
      const r = resolveBombTrigger('flare', 0, 0);
      expect(r.damageTiles).toHaveLength(0);
      expect(r.lightTiles).toHaveLength(81);
      expect(r.lightDuration).toBe(3);
    });
  });

  describe('molotov (fire plus x1 for 2 turns)', () => {
    it('sets 5 tiles on fire for 2 turns AND deals immediate damage to those tiles', () => {
      const r = resolveBombTrigger('molotov', 5, 5);
      expect(r.fireTiles).toHaveLength(5);
      expect(r.fireDuration).toBe(2);
      // Brief: molotov also deals immediate 1 damage on landing tiles
      expect(r.damageTiles).toHaveLength(5);
      expect(norm(r.damageTiles)).toEqual(norm(r.fireTiles));
    });
  });
});
