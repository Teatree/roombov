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
    /** 1-2 unique bomb slots, 4 bombs total */
    bombCount: 2,
    bombStackSize: 2,
    weights: {
      bomb: 60,
      bomb_wide: 30,
      delay_tricky: 30,
      contact: 0,
      banana: 50,
      flare: 100,
      molotov: 0,
      ender_pearl: 20,
      motion_detector_flare: 20,
      fart_escape: 10,
      flash: 20,
    },
  },
  2: {
    coinRange: [30, 40],
    /** 2-3 unique bomb slots, 8 bombs total */
    bombCount: 3,
    bombStackSize: 3,
    weights: {
      bomb: 50,
      bomb_wide: 40,
      delay_tricky: 40,
      contact: 10,
      banana: 50,
      flare: 100,
      molotov: 10,
      ender_pearl: 20,
      motion_detector_flare: 25,
      fart_escape: 15,
      flash: 25,
      phosphorus: 5,
      cluster_bomb: 5,
      big_huge: 10,
    },
  },
};
