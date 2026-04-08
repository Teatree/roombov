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
    totalBombs: 7,
    priceRange: [0, 0],
    weights: {
      delay: 5,
      delay_big: 1,
      delay_tricky: 3,
      contact: 3,
      banana: 1,
      flare: 4,
      molotov: 1,
    },
  },
  paid: {
    totalBombs: 10,
    priceRange: [100, 200],
    weights: {
      delay: 4,
      delay_big: 3,
      delay_tricky: 3,
      contact: 4,
      banana: 2,
      flare: 3,
      molotov: 3,
    },
  },
  paid_expensive: {
    totalBombs: 13,
    priceRange: [250, 300],
    weights: {
      delay: 3,
      delay_big: 4,
      delay_tricky: 3,
      contact: 4,
      banana: 4,
      flare: 2,
      molotov: 4,
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
