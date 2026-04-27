import { describe, it, expect } from 'vitest';
import { computeCoinReward } from '../src/shared/systems/GamblerStreetEngine.ts';
import { GAMBLER_TREASURE_TUNING } from '../src/shared/config/gambler-street.ts';

/**
 * Verifies the diminishing-returns curve hits the documented data points
 * and is well-behaved (monotonic non-decreasing, asymptotic on the tail).
 *
 * Reference fish curve (start=200, max=1000, startRatio=0.10, endRatio=0.02):
 *   N=100  → 10
 *   N=200  → 20
 *   N=500  → ≈42 (allow ±2 for log integration)
 *   N=1000 → ≈60 (allow ±2)
 *   N=2000 → ≈80
 */
describe('computeCoinReward (fish reference curve)', () => {
  it('pays the head rate exactly when units are at or below startUnits', () => {
    // Arrange + Act + Assert
    expect(computeCoinReward('fish', 100)).toBe(10);
    expect(computeCoinReward('fish', 200)).toBe(20);
  });

  it('produces ~42 coins at N=500 (log-interpolated middle)', () => {
    expect(computeCoinReward('fish', 500)).toBeGreaterThanOrEqual(40);
    expect(computeCoinReward('fish', 500)).toBeLessThanOrEqual(44);
  });

  it('produces ~60 coins at N=1000 (curve max kink)', () => {
    expect(computeCoinReward('fish', 1000)).toBeGreaterThanOrEqual(58);
    expect(computeCoinReward('fish', 1000)).toBeLessThanOrEqual(62);
  });

  it('extends linearly at endRatio past curveMaxUnits', () => {
    // 1000 fish ≈ 60 coins; +1000 more at 0.02 = +20 coins.
    const at1000 = computeCoinReward('fish', 1000);
    const at2000 = computeCoinReward('fish', 2000);
    const tailGain = at2000 - at1000;
    expect(tailGain).toBeGreaterThanOrEqual(18);
    expect(tailGain).toBeLessThanOrEqual(22);
  });

  it('returns 0 for non-positive unit counts', () => {
    expect(computeCoinReward('fish', 0)).toBe(0);
    expect(computeCoinReward('fish', -5)).toBe(0);
  });
});

describe('computeCoinReward (curve invariants)', () => {
  it('is monotonically non-decreasing across all treasure types', () => {
    // Step through 0..2000 in increments of 25 and verify reward never drops.
    for (const type of Object.keys(GAMBLER_TREASURE_TUNING) as Array<keyof typeof GAMBLER_TREASURE_TUNING>) {
      let prev = 0;
      for (let n = 0; n <= 2000; n += 25) {
        const r = computeCoinReward(type, n);
        expect(r, `${type} at N=${n} regressed from ${prev} to ${r}`).toBeGreaterThanOrEqual(prev);
        prev = r;
      }
    }
  });

  it('rounds to an integer coin reward', () => {
    for (const type of Object.keys(GAMBLER_TREASURE_TUNING) as Array<keyof typeof GAMBLER_TREASURE_TUNING>) {
      for (const n of [1, 7, 50, 250, 600, 1500]) {
        const r = computeCoinReward(type, n);
        expect(Number.isInteger(r), `${type} N=${n} → ${r} not integer`).toBe(true);
      }
    }
  });

  it('respects per-treasure tail rate (amulets > fish at 2000 units)', () => {
    // Amulets are configured rare/valuable; fish are cheap.
    expect(computeCoinReward('amulets', 2000)).toBeGreaterThan(computeCoinReward('fish', 2000));
  });
});
