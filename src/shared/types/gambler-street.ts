/**
 * Gambler Street types.
 *
 * Persistent, server-authoritative state describing each player's gambler
 * carousel. Lives on `PlayerProfile.gamblerStreet`. All timestamps are
 * absolute Unix milliseconds so wall-clock aging works whether the player
 * is online or offline.
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
 * A slot is either occupied by an active gambler, or empty and counting down
 * to the next gambler appearing.
 */
export type GamblerSlot =
  | { kind: 'gambler'; gambler: Gambler }
  | { kind: 'cooldown'; readyAt: number /* unix ms */ };

/**
 * The full street state for one player. Has a fixed slot count
 * (`GAMBLER_STREET_GLOBAL.slotCount`).
 */
export interface GamblerStreetState {
  slots: GamblerSlot[];
  /**
   * Last time the engine ticked this state. Not strictly required for
   * correctness (tick is idempotent given `now`), but useful for debugging.
   */
  lastTickedAt: number;
  /**
   * Monotonic counter used to mint `Gambler.id` deterministically per-player.
   */
  nextGamblerSerial: number;
}

/**
 * Returned from `resolveBet`. The client uses these fields to drive the
 * "Which hand?" reveal animation and update the local UI.
 */
export interface BetOutcome {
  /** Which slot was bet on (index into slots). */
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

/** Empty starting state for a fresh profile. */
export function createEmptyGamblerStreet(now: number, slotCount: number): GamblerStreetState {
  const slots: GamblerSlot[] = [];
  for (let i = 0; i < slotCount; i++) {
    // All slots start in cooldown so the engine generates the initial set
    // on the first tick (consistent code path with all later regenerations).
    slots.push({ kind: 'cooldown', readyAt: now });
  }
  return {
    slots,
    lastTickedAt: now,
    nextGamblerSerial: 1,
  };
}
