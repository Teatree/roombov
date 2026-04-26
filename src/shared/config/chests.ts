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
 *
 * Bomb counts: each chest rolls a unique-slot count uniformly inside
 * `slotCount` and then distributes `totalBombs` across those slots in
 * proportion to the picked types' weights (see utils/loot-roll.ts).
 */

import type { BombType } from '../types/bombs.ts';

export interface ChestTierConfig {
  /** Min/max coins (inclusive). Rolled uniformly. */
  coinRange: [number, number];
  /** Total bombs across all unique slots. */
  totalBombs: number;
  /** Number of unique bomb types. [min, max] inclusive — picked uniformly. */
  slotCount: [number, number];
  /** Relative weight of each bomb type. Drives both type pick and per-slot count. */
  weights: Partial<Record<BombType, number>>;
}

export const CHEST_CONFIG: Record<1 | 2, ChestTierConfig> = {
  1: {
    coinRange: [10, 20],
    totalBombs: 5,
    slotCount: [1, 2],
    weights: {
      bomb: 100,
      bomb_wide: 100,
      delay_tricky: 100,
      banana: 100,
      flash: 50,
      contact: 10,
      molotov: 10,
      ender_pearl: 100,
      fart_escape: 100,
      motion_detector_flare: 50,
      flare: 100,
    },
  },
  2: {
    coinRange: [30, 40],
    totalBombs: 8,
    slotCount: [2, 3],
    weights: {
      bomb: 100,
      bomb_wide: 100,
      delay_tricky: 100,
      banana: 100,
      flash: 75,
      contact: 20,
      molotov: 20,
      ender_pearl: 100,
      fart_escape: 100,
      motion_detector_flare: 75,
      flare: 100,
      phosphorus: 15,
      cluster_bomb: 15,
      big_huge: 15,
    },
  },
};
