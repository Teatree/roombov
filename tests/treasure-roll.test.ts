import { describe, it, expect } from 'vitest';
import { rollTreasureLoot } from '../src/shared/utils/loot-roll.ts';
import type { TreasureType } from '../src/shared/config/treasures.ts';
import { totalTreasures } from '../src/shared/config/treasures.ts';

function lcgRng(seed = 1): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

describe('rollTreasureLoot', () => {
  it('produces totalTreasures across at most slotCount unique types (wooden chest spec)', () => {
    const rng = lcgRng(42);
    const weights: Partial<Record<TreasureType, number>> = {
      fish: 100, chalice: 100, jade: 100, books: 100, coffee: 100,
      grapes: 100, lanterns: 100, bones: 100, mushrooms: 100, amulets: 100,
    };
    for (let i = 0; i < 50; i++) {
      const bundle = rollTreasureLoot(weights, 5, 3, rng);
      expect(totalTreasures(bundle)).toBe(5);
      const uniqueTypes = Object.keys(bundle).length;
      expect(uniqueTypes).toBeGreaterThan(0);
      expect(uniqueTypes).toBeLessThanOrEqual(3);
    }
  });

  it('produces totalTreasures across at most slotCount unique types (iron chest spec)', () => {
    const rng = lcgRng(7);
    const weights: Partial<Record<TreasureType, number>> = {
      fish: 100, chalice: 100, jade: 100, books: 100, coffee: 100,
      grapes: 100, lanterns: 100, bones: 100, mushrooms: 100, amulets: 100,
    };
    for (let i = 0; i < 50; i++) {
      const bundle = rollTreasureLoot(weights, 15, 5, rng);
      expect(totalTreasures(bundle)).toBe(15);
      expect(Object.keys(bundle).length).toBeLessThanOrEqual(5);
    }
  });

  it('respects zero-weight types (never picks them)', () => {
    const rng = lcgRng(99);
    // Only chalice and fish have nonzero weight; output must contain only these.
    const weights: Partial<Record<TreasureType, number>> = { chalice: 100, fish: 100 };
    for (let i = 0; i < 30; i++) {
      const bundle = rollTreasureLoot(weights, 10, 5, rng);
      for (const t of Object.keys(bundle) as TreasureType[]) {
        expect(t === 'chalice' || t === 'fish').toBe(true);
      }
      expect(totalTreasures(bundle)).toBe(10);
    }
  });

  it('returns empty bundle when total is 0 or weights are empty', () => {
    expect(rollTreasureLoot({}, 5, 3, Math.random)).toEqual({});
    expect(rollTreasureLoot({ fish: 100 }, 0, 3, Math.random)).toEqual({});
    expect(rollTreasureLoot({ fish: 100 }, 5, 0, Math.random)).toEqual({});
  });

  it('drops zero-count entries from the output', () => {
    // When a tiny weight gets rounded to 0, it must not appear in the bundle.
    // total=3, weights pinned so largest=80, smallest=5 → distribution
    // assigns 0 to the lowest-weight slot, which should be removed.
    const rng = (): number => 0.0;
    const bundle = rollTreasureLoot({ fish: 80, chalice: 15, jade: 5 }, 3, 3, rng);
    for (const v of Object.values(bundle)) {
      expect(v).toBeGreaterThan(0);
    }
  });
});
