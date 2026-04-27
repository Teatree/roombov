/**
 * Gambler Street service.
 *
 * Server-authoritative wrapper around the pure GamblerStreetEngine. Handles:
 *   - lazy ticking on player request (so offline aging works automatically)
 *   - bet resolution: deduct treasure, apply coin reward, replace slot with
 *     a 2-min cooldown, persist
 *
 * The carousel state lives on PlayerProfile so PlayerStore handles persistence
 * the same way it does for treasures, coins, and bomb stockpile.
 */

import type { PlayerProfile } from '../shared/types/player-profile.ts';
import type { BetTier } from '../shared/config/gambler-street.ts';
import { GAMBLER_STREET_GLOBAL } from '../shared/config/gambler-street.ts';
import type { BetOutcome, GamblerStreetState } from '../shared/types/gambler-street.ts';
import { createEmptyGamblerStreet } from '../shared/types/gambler-street.ts';
import {
  tickGamblerStreet,
  resolveBet,
} from '../shared/systems/GamblerStreetEngine.ts';
import type { PlayerStore } from './PlayerStore.ts';

/**
 * Result of attempting a bet. Failure cases are explicit so the client can
 * show an actionable message — but most of these should never occur in a
 * happy-path UI (the buttons only appear when the gambler is alive and the
 * player has the treasure).
 */
export type BetResult =
  | { ok: true; outcome: BetOutcome; state: GamblerStreetState }
  | { ok: false; reason:
      | 'invalid_slot'
      | 'no_gambler'
      | 'gambler_expired'
      | 'insufficient_treasure'
      | 'invalid_tier'
      | 'invalid_hand';
    };

export class GamblerStreetService {
  private playerStore: PlayerStore;

  constructor(playerStore: PlayerStore) {
    this.playerStore = playerStore;
  }

  /**
   * Tick the carousel forward to `now` and persist if anything changed.
   * Returns the (possibly updated) state. Call this on every read so the
   * client always sees an up-to-date carousel.
   */
  async refresh(profile: PlayerProfile, now = Date.now()): Promise<GamblerStreetState> {
    ensureGamblerStreet(profile, now);
    const before = profile.gamblerStreet;
    const next = tickGamblerStreet(before, profile.treasures, now, Math.random);

    // Cheap structural check to avoid a write on every poll.
    if (gamblerStreetUnchanged(before, next)) return before;

    profile.gamblerStreet = next;
    await this.playerStore.save(profile);
    return next;
  }

  /**
   * Resolve a bet against the gambler at `slotIndex`. Mutates the profile
   * (treasures, coins, gamblerStreet) and persists. Returns the outcome so
   * the client can drive the reveal animation.
   */
  async bet(
    profile: PlayerProfile,
    slotIndex: number,
    tier: BetTier,
    pickedHand: 'left' | 'right',
    now = Date.now(),
  ): Promise<BetResult> {
    ensureGamblerStreet(profile, now);
    // Always tick before resolving so an expired gambler is correctly rejected.
    const ticked = tickGamblerStreet(profile.gamblerStreet, profile.treasures, now, Math.random);
    profile.gamblerStreet = ticked;

    const result = resolveBet(ticked, profile.treasures, slotIndex, tier, pickedHand, now, Math.random);
    if (!result.ok) {
      // Persist the tick — even on a no-op bet the lifespans may have advanced.
      if (!gamblerStreetUnchanged(profile.gamblerStreet, ticked)) {
        await this.playerStore.save(profile);
      }
      return { ok: false, reason: result.reason };
    }

    // Apply outcome: deduct treasure, award coins, replace slot.
    const t = result.outcome.treasureType;
    const owned = profile.treasures[t] ?? 0;
    const remaining = owned - result.outcome.treasurePaid;
    if (remaining <= 0) delete profile.treasures[t];
    else profile.treasures[t] = remaining;

    profile.coins += result.outcome.coinsGained;

    const newSlots = ticked.slots.slice();
    newSlots[slotIndex] = result.nextSlot;
    profile.gamblerStreet = {
      ...ticked,
      slots: newSlots,
      lastTickedAt: now,
    };

    await this.playerStore.save(profile);
    return { ok: true, outcome: result.outcome, state: profile.gamblerStreet };
  }
}

/**
 * Backfill gamblerStreet on profiles that were loaded before the migration
 * landed (e.g. cached in-memory pre-restart). Without this guard, ticking
 * `undefined.slots` throws and the socket handler dies silently — leaving the
 * client stuck on "Loading...".
 */
function ensureGamblerStreet(profile: PlayerProfile, now: number): void {
  const gs = (profile as { gamblerStreet?: GamblerStreetState }).gamblerStreet;
  if (!gs || !Array.isArray(gs.slots)) {
    profile.gamblerStreet = createEmptyGamblerStreet(now, GAMBLER_STREET_GLOBAL.slotCount);
  }
}

/**
 * Cheap deep-ish equality check between two carousel states. Returns true if
 * both have the same slot kinds, the same gambler ids in the same positions,
 * and the same cooldown readyAts. We skip the lastTickedAt field because it
 * advances every call.
 */
function gamblerStreetUnchanged(a: GamblerStreetState, b: GamblerStreetState): boolean {
  if (a.slots.length !== b.slots.length) return false;
  if (a.nextGamblerSerial !== b.nextGamblerSerial) return false;
  for (let i = 0; i < a.slots.length; i++) {
    const sa = a.slots[i];
    const sb = b.slots[i];
    if (sa.kind !== sb.kind) return false;
    if (sa.kind === 'gambler' && sb.kind === 'gambler') {
      if (sa.gambler.id !== sb.gambler.id) return false;
    } else if (sa.kind === 'cooldown' && sb.kind === 'cooldown') {
      if (sa.readyAt !== sb.readyAt) return false;
    }
  }
  return true;
}
