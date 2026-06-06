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
import type { BombermanTier, IdleAction } from '../types/bomberman.ts';

export interface TierConfig {
  /** How many custom inventory slots this tier carries (excludes the fixed
   *  Rock). Total visible loadout = customSlots + 1. */
  customSlots: number;
  /** Per-slot stack-size range. Each Bomberman in this tier rolls a value
   *  uniformly inside [min, max] inclusive at shop time. */
  stackSizeRange: [number, number];
  /** How many bomb units (total, across all slots) the Bomberman starts with. */
  totalBombs: number;
  /** Max number of unique bomb types (slots used). Capped by `customSlots`. */
  maxUniqueSlots: number;
  /**
   * Relative weight of each purchasable bomb type when rolling the starting
   * inventory. Missing entries are treated as 0.
   */
  weights: Partial<Record<BombType, number>>;
}

export const TIER_CONFIG: Record<BombermanTier, TierConfig> = {
  free: {
    customSlots: 4,
    stackSizeRange: [6, 7],
    /** 3 unique slots, 10 bombs total */
    totalBombs: 10,
    maxUniqueSlots: 3,
    weights: {
      bomb: 100,
      bomb_wide: 100,
      delay_tricky: 100,
      banana: 100,
      flash: 50,
      ender_pearl: 100,
      fart_escape: 100,
      flare: 100,
      shield: 100,
    },
  },
  paid: {
    customSlots: 5,
    stackSizeRange: [8, 9],
    /** 4 unique slots, 14 bombs total */
    totalBombs: 14,
    maxUniqueSlots: 4,
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
      motion_detector_flare: 40,
      flare: 100,
      shield: 100,
    },
  },
  paid_expensive: {
    customSlots: 6,
    stackSizeRange: [10, 12],
    /** 4 unique slots, 16 bombs total */
    totalBombs: 16,
    maxUniqueSlots: 4,
    weights: {
      bomb: 100,
      bomb_wide: 100,
      delay_tricky: 100,
      banana: 100,
      flash: 100,
      contact: 25,
      molotov: 25,
      ender_pearl: 100,
      fart_escape: 100,
      motion_detector_flare: 100,
      flare: 100,
      phosphorus: 10,
      cluster_bomb: 10,
      big_huge: 10,
      shield: 100,
    },
  },
};

/**
 * Pricing formula coefficients. Bomberman shop price is computed from rolled
 * stats + the seeded starting inventory. Tweak these to retune the soft
 * economy without touching code.
 *
 *   slotCost  = max(0, totalSlots - SLOT_THRESHOLD) × COIN_PER_EXTRA_SLOT
 *   stackCost = max(0, stackSize  - STACK_THRESHOLD) × COIN_PER_EXTRA_STACK
 *   bombCost  = Σ (slot.count × BOMB_CATALOG[slot.type].price) × BOMB_COST_RATIO
 *   raw       = (slotCost + stackCost + bombCost) × PRICE_MULTIPLIER
 *   price     = max(MIN_PRICE × PRICE_MULTIPLIER, round-to-nearest-5(raw))
 *
 * Post NEW_META §6 (2026-05-16): every tier — including free — runs through
 * this formula. The minimum-price floor exists to keep free-tier Bombermen
 * from rolling absurdly cheap; their target band is ~50–120 coins.
 *
 * 2026-05-23: `priceMultiplier` raised to 2 to globally double Bomberman
 * prices without retuning each constant individually.
 */
export const BOMBERMAN_PRICING = {
  slotThreshold: 5,
  coinPerExtraSlot: 50,
  stackThreshold: 5,
  coinPerExtraStack: 25,
  /** Share of the loadout's total bomb-shop value that flows into the Bomberman
   *  price. 1.0 = the Bomberman costs 100% of his bombs' coin value. */
  bombCostRatio: 1.0,
  roundToNearest: 5,
  /** Lower bound on the computed price (pre-multiplier). NEW_META §6 — keeps free tier ≥50. */
  minPrice: 50,
  /** Global scalar applied to the final price (and to minPrice). 1 = original tuning. */
  priceMultiplier: 2,
} as const;

/**
 * Migration helper — gives a deterministic mid-tier value for legacy owned
 * Bombermen that pre-date the per-tier stats system. Free → 4/7, Paid → 5/9,
 * Expensive → 6/11. PlayerStore calls this when backfilling missing fields.
 */
export function defaultStatsForTier(tier: BombermanTier): { maxCustomSlots: number; stackSize: number } {
  const cfg = TIER_CONFIG[tier];
  const [min, max] = cfg.stackSizeRange;
  // Midpoint, rounded up so even ranges favor the player a touch.
  const stackSize = Math.ceil((min + max) / 2);
  return { maxCustomSlots: cfg.customSlots, stackSize };
}

/** Composition of a single shop cycle. */
export const SHOP_CYCLE_COMPOSITION: { tier: BombermanTier; count: number }[] = [
  { tier: 'free', count: 2 },
  { tier: 'paid', count: 2 },
  { tier: 'paid_expensive', count: 1 },
];

// ───────────────────────────────────────────────────────────────────────────
// Reworked offer model (2026-06-06). The shop offers 3 identical-template
// Bombermen, all tier-1 ("blue"/`paid` visual): 4 custom slots, stack 5, 2 HP
// (HP is the global base `BALANCE.match.bombermanMaxHp`). Each rolls one
// offensive bomb, one escape, and one flare from the pools below; price is set
// purely by the escape. A bonus FREE Bomberman is offered once all three are
// bought (lighter loadout). See BombermanShopService.
// ───────────────────────────────────────────────────────────────────────────

/** Number of (paid) Bombermen offered per cycle. */
export const SHOP_OFFER_COUNT = 3;

/**
 * Idle Action "class" assigned to the three offered Bombermen — one of each per
 * cycle (the shop service shuffles this with the seeded RNG so slot order
 * varies). Class is independent of the escape-driven price. The bonus FREE
 * Bomberman is always `attack`.
 */
export const OFFER_CLASSES: readonly IdleAction[] = ['attack', 'heal', 'disguise'];

/** Bomb pools each offered Bomberman draws one of. */
export const OFFER_BOMB_POOLS: {
  offensive: BombType[];
  escape: BombType[];
  flare: BombType[];
} = {
  offensive: ['bomb', 'delay_tricky'],        // simple + / diagonal
  escape: ['fart_escape', 'ender_pearl', 'shield'],
  flare: ['flare', 'motion_detector_flare'],  // regular / mine flare
};

/** Fixed price per escape — the offered Bomberman's price ignores its
 *  offensive/flare and is driven entirely by which escape it rolled. */
export const ESCAPE_PRICES: Partial<Record<BombType, number>> = {
  ender_pearl: 600,
  fart_escape: 550,
  shield: 500,
};

/** Stats + loadout counts shared by every offered (paid) Bomberman. */
export const OFFER_STATS = {
  maxCustomSlots: 4,   // excludes Rock; 4th slot left empty
  stackSize: 5,
  offensiveCount: 5,
  escapeCount: 2,
  flareCount: 2,
} as const;

/** The bonus FREE Bomberman: same stats, lighter loadout. */
export const FREE_BONUS_STATS = {
  maxCustomSlots: 4,
  stackSize: 5,
  offensiveCount: 3,
  escapeCount: 1,
  flareCount: 1,
} as const;

/** 2-minute per-player cycle. Each profile carries its own shop state and
 *  ticks forward on wall-clock time, so the carousel feels live regardless
 *  of how long the player was away. */
export const SHOP_CYCLE_DURATION_MS = 2 * 60 * 1000;
