/**
 * Chest loot configuration.
 *
 * Two tiers of chests spawn on the map in designated zones. Each chest
 * contains treasures (auto-collected when a player steps on the tile) and
 * random bombs (picked up via the loot panel).
 *
 * Treasures and bombs use the same weighted distribution model: pick K
 * unique types, then split a fixed total across them in proportion to the
 * picked types' weights (see utils/loot-roll.ts). Missing entries = 0
 * chance. Edit the numbers below to tune what players find in chests.
 *
 * Bomb counts: each chest rolls a unique-slot count uniformly inside
 * `slotCount` and then distributes `totalBombs` across those slots in
 * proportion to the picked types' weights.
 *
 * Treasure counts: same algorithm — unique-slot count uniformly inside
 * `treasureSlotCount`, then `totalTreasures` distributed across those
 * picked types by weight.
 */

import type { BombType } from '../types/bombs.ts';
import type { TreasureType } from './treasures.ts';

export interface ChestTierConfig {
  /** Total bombs across all unique slots. */
  totalBombs: number;
  /** Number of unique bomb types. [min, max] inclusive — picked uniformly. */
  slotCount: [number, number];
  /** Relative weight of each bomb type. Drives both type pick and per-slot count. */
  weights: Partial<Record<BombType, number>>;
  /** Total treasures across all unique slots. */
  totalTreasures: number;
  /** Number of unique treasure types. [min, max] inclusive — picked uniformly. */
  treasureSlotCount: [number, number];
  /** Relative weight of each treasure type. Drives both type pick and per-slot count. */
  treasureWeights: Partial<Record<TreasureType, number>>;
}

/**
 * Default uniform treasure weights — every type equally likely to appear.
 * Edit individual values per-tier to bias toward specific treasures.
 */
const UNIFORM_TREASURE_WEIGHTS: Partial<Record<TreasureType, number>> = {
  fish: 100,
  chalice: 100,
  jade: 100,
  books: 100,
  coffee: 100,
  grapes: 100,
  lanterns: 100,
  bones: 100,
  mushrooms: 100,
  amulets: 100,
};

export const CHEST_CONFIG: Record<1 | 2, ChestTierConfig> = {
  1: {
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
    totalTreasures: 25,
    treasureSlotCount: [3, 3],
    treasureWeights: { ...UNIFORM_TREASURE_WEIGHTS },
  },
  2: {
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
    totalTreasures: 75,
    treasureSlotCount: [5, 5],
    treasureWeights: { ...UNIFORM_TREASURE_WEIGHTS },
  },
};
