/**
 * Bomberman shop tier configuration.
 *
 * The brief specifies:
 *  - 3 paid + 2 free = 5 Bombermen per 10-minute cycle
 *  - 1 of the paid is always "expensive"
 *  - Free tier has 7 bombs total, Paid has 10, Paid Expensive has 13
 *  - Prices: paid 100-200 (round to 5), paid expensive 250-300 (round to 5)
 *  - Per-tier weighted probability for bomb types (defined below)
 *
 * Weights are relative — they get normalized inside the shop service.
 * Rock is excluded from the rolled inventory (it's granted as the fixed 5th slot
 * at match time), so these weights cover only the 7 purchasable bomb types.
 */

import type { BombType } from '../types/bombs.ts';
import type { BombermanTier } from '../types/bomberman.ts';

export interface TierConfig {
  /** How many bomb units (total, across the 4 slots) the Bomberman starts with. */
  totalBombs: number;
  /** Max number of unique bomb types (slots used). 1-4. */
  maxUniqueSlots: number;
  /** Price range in coins (inclusive). Rounded to the nearest 5. */
  priceRange: [number, number];
  /**
   * Relative weight of each purchasable bomb type when rolling the starting
   * inventory. Missing entries are treated as 0.
   */
  weights: Partial<Record<BombType, number>>;
}

export const TIER_CONFIG: Record<BombermanTier, TierConfig> = {
  free: {
    /** 3 unique slots, 10 bombs total */
    totalBombs: 10,
    maxUniqueSlots: 3,
    priceRange: [0, 0],
    weights: {
      bomb: 60,
      bomb_wide: 40,
      delay_tricky: 40,
      contact: 5,
      banana: 25,
      flare: 100,
      molotov: 5,
      ender_pearl: 20,
      motion_detector_flare: 25,
      fart_escape: 10,
      flash: 15,
    },
  },
  paid: {
    /** 4 unique slots, 14 bombs total */
    totalBombs: 14,
    maxUniqueSlots: 4,
    priceRange: [100, 200],
    weights: {
      bomb: 60,
      bomb_wide: 40,
      delay_tricky: 40,
      contact: 10,
      banana: 25,
      flare: 100,
      molotov: 10,
      ender_pearl: 20,
      motion_detector_flare: 25,
      fart_escape: 10,
      flash: 20,
    },
  },
  paid_expensive: {
    /** 4 unique slots, 16 bombs total */
    totalBombs: 16,
    maxUniqueSlots: 4,
    priceRange: [250, 300],
    weights: {
      bomb: 50,
      bomb_wide: 40,
      delay_tricky: 40,
      contact: 20,
      banana: 25,
      flare: 100,
      molotov: 20,
      ender_pearl: 25,
      motion_detector_flare: 25,
      fart_escape: 15,
      flash: 25,
      phosphorus: 5,
      cluster_bomb: 5,
      big_huge: 10,
    },
  },
};

/** Composition of a single shop cycle. */
export const SHOP_CYCLE_COMPOSITION: { tier: BombermanTier; count: number }[] = [
  { tier: 'free', count: 2 },
  { tier: 'paid', count: 2 },
  { tier: 'paid_expensive', count: 1 },
];

/** 10-minute cycle as per the brief. */
export const SHOP_CYCLE_DURATION_MS = 10 * 60 * 1000;
