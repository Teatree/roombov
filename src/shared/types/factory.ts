/**
 * Persistent per-player factory state.
 *
 * Each factory has its own queue (cycles paid for, sequentially produced) and
 * its own storage (produced-but-unclaimed bombs). Queue cycles all share the
 * same per-factory cycleDurationMs, so we only need to store the first cycle's
 * start time + how many cycles remain — completed cycles roll forward
 * lazily on read (server-authoritative via FactoryService.resolveAll).
 */

import type { BombType } from './bombs.ts';

export type FactoryId = 1 | 2 | 3 | 4;
export const FACTORY_IDS: readonly FactoryId[] = [1, 2, 3, 4];

export interface FactoryState {
  /**
   * Wall-clock ms at which the currently-producing cycle began. Null when the
   * queue is empty. Cycle N (0-indexed) completes at
   *   firstCycleStartedAt + (N + 1) * cycleDurationMs
   */
  firstCycleStartedAt: number | null;
  /** Cycles still to produce (current + queued). 0 means idle. */
  queueLength: number;
  /** Produced bombs awaiting Claim. */
  storage: BombType[];
  /**
   * Session counters for the popup's "X / Y done" display. A session is the
   * span between idle-with-nothing-queued and the next commission. Both reset
   * to 0 when the player commissions a new bomb while the factory is fully
   * idle (queueLength === 0 AND firstCycleStartedAt === null AND
   * sessionDone === sessionTotal); the new commission then makes it 0 / 1.
   * sessionDone increments inside resolveOne when bombs roll into storage.
   */
  sessionDone: number;
  sessionTotal: number;
}

export type FactoryStates = Record<FactoryId, FactoryState>;

export function emptyFactoryState(): FactoryState {
  return { firstCycleStartedAt: null, queueLength: 0, storage: [], sessionDone: 0, sessionTotal: 0 };
}

export function createEmptyFactories(): FactoryStates {
  return {
    1: emptyFactoryState(),
    2: emptyFactoryState(),
    3: emptyFactoryState(),
    4: emptyFactoryState(),
  };
}

/**
 * How many bombs are claimable RIGHT NOW from a single factory, including
 * cycles that would have completed since `firstCycleStartedAt` if the server
 * resolved them now. Pure read-only mirror of FactoryService.resolveOne's
 * counting logic — used by client widgets that want to display a live
 * claimable-count without waiting for a server-side resolve.
 */
export function projectedClaimable(
  state: FactoryState,
  cycleDurationMs: number,
  nowMs: number,
): number {
  let count = state.storage.length;
  if (state.queueLength > 0 && state.firstCycleStartedAt != null) {
    const elapsed = nowMs - state.firstCycleStartedAt;
    if (elapsed >= cycleDurationMs) {
      count += Math.min(state.queueLength, Math.floor(elapsed / cycleDurationMs));
    }
  }
  return count;
}
