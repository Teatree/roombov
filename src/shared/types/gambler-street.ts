/**
 * Gambler Street types.
 *
 * Server-authoritative carousel state. Lives on `PlayerProfile.gamblerStreet`.
 * All timestamps are absolute Unix milliseconds so the carousel ages on
 * wall-clock whether the player is online or not.
 *
 * State model — the conveyor:
 *   - `gamblers`: ordered left-to-right list of currently-visible gamblers,
 *     length 0..slotCount. The leftmost expires first (timers are staggered
 *     by at least `minStaggerMs`).
 *   - `pendingArrivals`: queue of timestamps. Each entry says "a fresh gambler
 *     should appear at the right end at this time." Used to model the 2–6s
 *     gap between a removal and the next arrival.
 *
 * Invariant maintained by the engine:
 *   `gamblers.length + pendingArrivals.length` equals `slotCount` whenever the
 *   carousel is meant to be fully stocked. Drops below only mid-tick (e.g. an
 *   expired gambler is removed before its replacement is queued).
 */

import type { TreasureType } from '../config/treasures.ts';
import type { BetTier } from '../config/gambler-street.ts';

/**
 * A single gambler currently sitting on the street.
 *
 * The "ask" describes what the gambler wants in exchange for ONE attempt at
 * the lower-tier bet. The premium tier costs `treasureAmount * costMultiplier`
 * (multiplier from `GAMBLER_STREET_GLOBAL.betTiers`). On any bet — win or
 * loss — the treasure is consumed and the gambler is removed.
 */
export interface Gambler {
  /** Stable id for this gambler instance. */
  id: string;
  /** Display name (full name, e.g. "Lucía Reyes"). */
  name: string;
  /** Treasure type the gambler is willing to gamble for. */
  treasureType: TreasureType;
  /**
   * Base treasure cost (cheap-tier amount). Premium tier doubles this via
   * the cost multiplier. Always > 0, rounded to the per-treasure step.
   */
  treasureAmount: number;
  /** Coins paid out if the player wins this gambler's bet (either tier). */
  coinReward: number;
  /** Unix ms when the gambler arrived. */
  createdAt: number;
  /** Unix ms when the gambler will leave on their own if no bet is placed. */
  expiresAt: number;
}

/**
 * The full street state for one player.
 */
export interface GamblerStreetState {
  /** Active gamblers, ordered left-to-right (leftmost expires first). */
  gamblers: Gambler[];
  /**
   * Pending arrivals queue — each entry is a Unix-ms timestamp at which a
   * fresh gambler should appear at the right end. Length + gamblers.length
   * sums to `slotCount` in steady state.
   */
  pendingArrivals: number[];
  /**
   * Last time the engine ticked this state. Useful for debugging only —
   * the tick is idempotent given a fixed `(state, now, rng draws)`.
   */
  lastTickedAt: number;
  /** Monotonic counter used to mint `Gambler.id` deterministically. */
  nextGamblerSerial: number;
}

/**
 * Returned from `resolveBet`. The client uses these fields to drive the
 * "Which hand?" reveal animation and update the local UI.
 */
export interface BetOutcome {
  /** Which gambler-list index was bet on (index into `state.gamblers`). */
  slotIndex: number;
  /** Tier the player picked. */
  tier: BetTier;
  /** Did the roll come up a win? */
  won: boolean;
  /** Treasure paid (deducted from profile already). */
  treasureType: TreasureType;
  treasurePaid: number;
  /** Coins gained (0 on loss). */
  coinsGained: number;
  /**
   * Which hand was "correct" for the cosmetic reveal — derived from the
   * player's pick + the win result so the popup can show: pick=left, won → left
   * is correct; pick=left, lost → right is correct.
   */
  correctHand: 'left' | 'right';
}

/**
 * Empty starting state for a fresh profile. The engine's first tick will
 * fill all `slotCount` arrivals immediately (each pendingArrival has
 * `readyAt = now`), producing five gamblers with staggered expiries.
 */
export function createEmptyGamblerStreet(now: number, slotCount: number): GamblerStreetState {
  const pendingArrivals: number[] = [];
  for (let i = 0; i < slotCount; i++) pendingArrivals.push(now);
  return {
    gamblers: [],
    pendingArrivals,
    lastTickedAt: now,
    nextGamblerSerial: 1,
  };
}
