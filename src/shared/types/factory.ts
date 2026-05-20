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
}

export type FactoryStates = Record<FactoryId, FactoryState>;

export function emptyFactoryState(): FactoryState {
  return { firstCycleStartedAt: null, queueLength: 0, storage: [] };
}

export function createEmptyFactories(): FactoryStates {
  return {
    1: emptyFactoryState(),
    2: emptyFactoryState(),
    3: emptyFactoryState(),
    4: emptyFactoryState(),
  };
}
