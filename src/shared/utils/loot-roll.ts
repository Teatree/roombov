import type { BombType } from '../types/bombs.ts';

/**
 * Roll a bomb-loot bundle: pick `slotCount` unique bomb types weighted by
 * their config weights, then distribute `totalBombs` across the picked types
 * in proportion to those same weights (largest-remainder rounding).
 *
 * Used for both Bomberman starting inventories and chest contents so the
 * rolling rule is identical in every loot source.
 *
 * Determinism: relies entirely on `rng()`, so call sites pass a seeded RNG
 * to keep matches/tutorials reproducible.
 *
 * Edge cases:
 *   - If `slotCount` exceeds the number of types with weight > 0, only that
 *     many slots are filled.
 *   - If a picked type rounds to 0 in the distribution step, it's dropped
 *     from the result (never an empty stack in the returned list).
 */
export function rollBombLoot(
  weights: Partial<Record<BombType, number>>,
  totalBombs: number,
  slotCount: number,
  rng: () => number,
): Array<{ type: BombType; count: number }> {
  const available: Array<[BombType, number]> = (Object.entries(weights) as [BombType, number][])
    .filter(([, w]) => (w ?? 0) > 0);
  if (available.length === 0 || totalBombs <= 0 || slotCount <= 0) return [];

  const picks = pickWeightedWithoutReplacement(available, slotCount, rng);
  const counts = distributeByWeight(totalBombs, picks.map(([, w]) => w));
  const result: Array<{ type: BombType; count: number }> = [];
  for (let i = 0; i < picks.length; i++) {
    if (counts[i] > 0) result.push({ type: picks[i][0], count: counts[i] });
  }
  return result;
}

/**
 * Pick up to `n` items from `pool` weighted by their second element, without
 * replacement. Returns the picked entries in pick order.
 */
function pickWeightedWithoutReplacement<K>(
  pool: Array<[K, number]>,
  n: number,
  rng: () => number,
): Array<[K, number]> {
  const out: Array<[K, number]> = [];
  const remaining = pool.slice();
  const target = Math.min(n, remaining.length);
  for (let s = 0; s < target; s++) {
    const total = remaining.reduce((acc, [, w]) => acc + w, 0);
    if (total <= 0) break;
    let roll = rng() * total;
    let idx = remaining.length - 1;
    for (let j = 0; j < remaining.length; j++) {
      roll -= remaining[j][1];
      if (roll <= 0) { idx = j; break; }
    }
    out.push(remaining[idx]);
    remaining.splice(idx, 1);
  }
  return out;
}

/**
 * Largest-remainder distribution. Splits `total` into len(weights) integer
 * buckets sized proportionally to each weight. Sum of returned numbers equals
 * `total` exactly.
 *
 * Example: distributeByWeight(5, [80, 20]) → [4, 1]
 *          distributeByWeight(10, [100, 10]) → [9, 1]
 */
export function distributeByWeight(total: number, weights: number[]): number[] {
  const sumW = weights.reduce((a, b) => a + b, 0);
  if (sumW <= 0 || total <= 0) return weights.map(() => 0);

  const exact = weights.map(w => (total * w) / sumW);
  const floors = exact.map(Math.floor);
  let remainder = total - floors.reduce((a, b) => a + b, 0);

  // Distribute the remainder by largest fractional part first. Stable on
  // ties — earlier index wins, mirroring Hare-quota convention.
  const order = exact
    .map((e, i) => ({ frac: e - Math.floor(e), i }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  for (let k = 0; k < remainder && k < order.length; k++) {
    floors[order[k].i]++;
  }
  return floors;
}
