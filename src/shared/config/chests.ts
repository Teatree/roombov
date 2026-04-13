/**
 * Chest loot configuration.
 *
 * Two tiers of chests spawn on the map in designated zones. Each chest
 * contains coins (auto-collected when a player steps on the tile) and
 * random bombs (picked up via the loot panel).
 *
 * Bomb weights work exactly like the Bomberman shop tier weights — they're
 * relative, normalized at runtime. Missing entries = 0 chance. Edit the
 * numbers below to tune what players find in chests.
 */

import type { BombType } from '../types/bombs.ts';

export interface ChestTierConfig {
  /** Min/max coins (inclusive). Rolled uniformly. */
  coinRange: [number, number];
  /** How many random bomb stacks to include. */
  bombCount: number;
  /** How many units per bomb stack. */
  bombStackSize: number;
  /** Relative weight of each bomb type when rolling chest contents. */
  weights: Partial<Record<BombType, number>>;
}

export const CHEST_CONFIG: Record<1 | 2, ChestTierConfig> = {
  1: {
    coinRange: [10, 20],
    bombCount: 1,
    bombStackSize: 2,
    weights: {
      delay: 5,
      delay_wide: 3,
      delay_tricky: 3,
      contact: 4,
      flare: 3,
    },
  },
  2: {
    coinRange: [30, 40],
    bombCount: 2,
    bombStackSize: 3,
    weights: {
      delay: 3,
      delay_big: 4,
      delay_wide: 3,
      delay_tricky: 3,
      contact: 4,
      banana: 3,
      molotov: 4,
      ender_pearl: 2,
    },
  },
};
