/**
 * Factory meta-progression config.
 *
 * Each Factory consumes a fixed Treasure cost per cycle and produces one
 * random Bomb every `cycleDurationMs`. The bomb is drawn by weighted choice
 * from `bombWeights`. Costs are paid up-front when the player presses BUY,
 * so a queue of N cycles costs N × cost. Production is tracked on the server
 * by wall-clock ms (persists across sessions).
 *
 * Tuning knobs: edit the numbers in FACTORIES freely; the rest of the system
 * is data-driven.
 */

import type { BombType } from '../types/bombs.ts';
import type { FactoryId } from '../types/factory.ts';
import type { TreasureBundle } from './treasures.ts';

export interface FactoryConfig {
  id: FactoryId;
  /** Flavour name shown in the popup header. */
  name: string;
  /** One-line italic flavour line shown directly under the popup header. */
  description: string;
  /** Wall-clock ms a single cycle takes. */
  cycleDurationMs: number;
  /** Treasures spent per cycle (paid at queue time). */
  cost: TreasureBundle;
  /** Relative weights for the weighted bomb roll. Missing/zero → excluded. */
  bombWeights: Partial<Record<BombType, number>>;
}

const MIN = 60 * 1000;

export const FACTORIES: Record<FactoryId, FactoryConfig> = {
  1: {
    id: 1,
    name: 'SPROKKET-5K',
    description: 'Produces a random weak bomb each cycle.',
    cycleDurationMs: 5 * MIN,
    cost: { mushrooms: 50 },
    bombWeights: {
      bomb: 10,
      delay_tricky: 10,
      ender_pearl: 5,
      flare: 10,
    },
  },
  2: {
    id: 2,
    name: 'KLANGWERKS-88',
    description: 'Produces a random tactical bomb each cycle.',
    cycleDurationMs: 10 * MIN,
    cost: { coffee: 20, mushrooms: 50 },
    bombWeights: {
      bomb_wide: 10,
      flash: 10,
      motion_detector_flare: 10,
      shield: 5,
    },
  },
  3: {
    id: 3,
    name: 'GLOMBULATOR',
    description: 'Produces a random utility bomb each cycle.',
    cycleDurationMs: 20 * MIN,
    cost: { grapes: 20, coffee: 30 },
    bombWeights: {
      bomb_wide: 5,
      banana: 10,
      fart_escape: 10,
      cluster_bomb: 5,
      shield: 5,
    },
  },
  4: {
    id: 4,
    name: 'DETONATORIUM',
    description: 'Produces a random super bomb each cycle.',
    cycleDurationMs: 30 * MIN,
    cost: { lanterns: 16, grapes: 30, mushrooms: 100 },
    bombWeights: {
      contact: 10,
      molotov: 10,
      phosphorus: 10,
      big_huge: 10,
    },
  },
};

/**
 * Sum of weights for a factory's bomb table. Useful for distribution tests.
 */
export function totalBombWeight(cfg: FactoryConfig): number {
  let sum = 0;
  for (const w of Object.values(cfg.bombWeights)) sum += w ?? 0;
  return sum;
}

/**
 * Weighted pick from a factory's bomb table.
 *
 * `rand` must return a uniform [0, 1) number — supply Math.random for
 * production or a seeded RNG for tests. Returns null if every weight is zero
 * (treated as a config error by callers).
 */
export function rollFactoryBomb(
  cfg: FactoryConfig,
  rand: () => number,
): BombType | null {
  const entries = Object.entries(cfg.bombWeights).filter(([, w]) => (w ?? 0) > 0) as Array<[BombType, number]>;
  if (entries.length === 0) return null;
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [type, weight] of entries) {
    r -= weight;
    if (r <= 0) return type;
  }
  return entries[entries.length - 1][0];
}
