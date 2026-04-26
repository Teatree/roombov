import { describe, it, expect } from 'vitest';
import { distributeByWeight, rollBombLoot } from '../src/shared/utils/loot-roll.ts';

describe('distributeByWeight', () => {
  it('matches the spec example: 5 total, weights [80, 20] → [4, 1]', () => {
    expect(distributeByWeight(5, [80, 20])).toEqual([4, 1]);
  });

  it('always sums to total exactly', () => {
    const cases: Array<[number, number[]]> = [
      [10, [100, 10]],
      [8, [100, 100, 75]],
      [16, [100, 100, 100, 100, 100, 25, 25, 100, 100, 100, 100, 10, 10, 10]],
      [3, [80, 15, 5]],
    ];
    for (const [total, weights] of cases) {
      const out = distributeByWeight(total, weights);
      expect(out.reduce((a, b) => a + b, 0)).toBe(total);
    }
  });

  it('returns zeros when total is zero or weights sum to zero', () => {
    expect(distributeByWeight(0, [50, 50])).toEqual([0, 0]);
    expect(distributeByWeight(5, [0, 0])).toEqual([0, 0]);
  });
});

describe('rollBombLoot', () => {
  it('produces totalBombs across at most slotCount unique types', () => {
    let seed = 1;
    const rng = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const weights = { bomb: 100, banana: 100, flash: 50 } as const;
    for (let i = 0; i < 20; i++) {
      const out = rollBombLoot(weights, 8, 2, rng);
      const sum = out.reduce((a, b) => a + b.count, 0);
      expect(sum).toBe(8);
      expect(out.length).toBeLessThanOrEqual(2);
      // Unique types
      expect(new Set(out.map(b => b.type)).size).toBe(out.length);
    }
  });

  it('drops zero-count entries', () => {
    const rng = (): number => 0.0; // Picks first weighted candidate every time
    // total=3, weights=[80, 15, 5] → [3, 0, 0] → only first is kept
    const out = rollBombLoot({ bomb: 80, banana: 15, flash: 5 }, 3, 3, rng);
    for (const o of out) expect(o.count).toBeGreaterThan(0);
  });
});
