/**
 * Factory meta-progression service.
 *
 * Server-authoritative wrapper over the per-player FactoryStates living on
 * PlayerProfile. Mirrors the pattern of GamblerStreetService: wall-clock
 * timestamps so production keeps ticking while the player is offline,
 * resolved lazily on every read/write.
 *
 *   - resolveAll(profile, now)  → advances every factory by completed cycles,
 *                                 rolling produced bombs into storage.
 *   - startCycle(profile, id)   → pays cost, appends 1 to queue.
 *   - claimOne(profile, id, i)  → pops storage[i] into bombStockpile.
 *   - claimAll(profile, id)     → pops all storage into bombStockpile.
 *
 * All mutations go through PlayerStore.save (write-through).
 */

import type { BombType } from '../shared/types/bombs.ts';
import type { PlayerProfile } from '../shared/types/player-profile.ts';
import type { FactoryId, FactoryState } from '../shared/types/factory.ts';
import { FACTORY_IDS } from '../shared/types/factory.ts';
import {
  FACTORIES,
  rollFactoryBomb,
  type FactoryConfig,
} from '../shared/config/factories.ts';
import type { TreasureBundle } from '../shared/config/treasures.ts';
import type { PlayerStore } from './PlayerStore.ts';

export type FactoryActionResult =
  | { ok: true }
  | { ok: false; reason: 'insufficient_treasures' | 'invalid_factory' | 'nothing_to_claim' | 'invalid_index' };

export class FactoryService {
  private playerStore: PlayerStore;
  /** Override for tests; production uses Math.random. */
  private rand: () => number;
  /** Override for tests; production uses Date.now. */
  private now: () => number;

  constructor(
    playerStore: PlayerStore,
    opts: { rand?: () => number; now?: () => number } = {},
  ) {
    this.playerStore = playerStore;
    this.rand = opts.rand ?? Math.random;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Advance every factory's queue by however many cycles have completed
   * since `firstCycleStartedAt`. Mutates `profile.factories` in place and
   * returns true if anything changed (so the caller can decide whether to
   * persist + emit).
   */
  resolveAll(profile: PlayerProfile, nowMs: number = this.now()): boolean {
    let changed = false;
    for (const id of FACTORY_IDS) {
      if (this.resolveOne(profile.factories[id], FACTORIES[id], nowMs)) {
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Pure-ish per-factory resolver. Pulls completed cycles into storage and
   * advances `firstCycleStartedAt`. Returns true if any cycle completed.
   *
   * Exposed for testing — production code uses resolveAll.
   */
  resolveOne(state: FactoryState, cfg: FactoryConfig, nowMs: number): boolean {
    if (state.queueLength <= 0 || state.firstCycleStartedAt == null) {
      // Defensive: keep state consistent if disk had a queue with no startTime
      // (shouldn't happen, but the migration is tolerant).
      if (state.firstCycleStartedAt != null) state.firstCycleStartedAt = null;
      if (state.queueLength !== 0) state.queueLength = 0;
      return false;
    }

    const elapsed = nowMs - state.firstCycleStartedAt;
    if (elapsed < cfg.cycleDurationMs) return false;

    const completed = Math.min(state.queueLength, Math.floor(elapsed / cfg.cycleDurationMs));
    if (completed <= 0) return false;

    for (let i = 0; i < completed; i++) {
      const rolled = rollFactoryBomb(cfg, this.rand);
      if (rolled) state.storage.push(rolled);
    }

    state.sessionDone += completed;
    state.queueLength -= completed;
    if (state.queueLength <= 0) {
      state.queueLength = 0;
      state.firstCycleStartedAt = null;
    } else {
      // Move the clock forward by the completed batch so the next pending
      // cycle starts on a clean boundary.
      state.firstCycleStartedAt += completed * cfg.cycleDurationMs;
    }
    return true;
  }

  /**
   * Pay the factory cost and append one cycle to the queue. If the queue was
   * empty, anchors the timer at `now`.
   */
  async startCycle(profile: PlayerProfile, factoryId: FactoryId): Promise<FactoryActionResult> {
    const cfg = FACTORIES[factoryId];
    if (!cfg) return { ok: false, reason: 'invalid_factory' };

    // Resolve first so any just-completed cycles land in storage before we
    // mutate the queue (and before we pull treasures the player might have
    // earned by claiming a body in the same wall-clock instant).
    const nowMs = this.now();
    this.resolveAll(profile, nowMs);

    if (!canAfford(profile.treasures, cfg.cost)) {
      return { ok: false, reason: 'insufficient_treasures' };
    }
    deductTreasures(profile.treasures, cfg.cost);

    const state = profile.factories[factoryId];

    // Session counter: if the factory is fully idle (no queue, no active
    // cycle, and the previous session is fully resolved), the new
    // commission starts a fresh "0 / 1 done" session. Otherwise we're
    // adding to the in-progress session.
    if (state.queueLength === 0
        && state.firstCycleStartedAt === null
        && state.sessionDone >= state.sessionTotal) {
      state.sessionDone = 0;
      state.sessionTotal = 0;
    }
    state.sessionTotal += 1;

    if (state.queueLength <= 0 || state.firstCycleStartedAt == null) {
      state.firstCycleStartedAt = nowMs;
      state.queueLength = 1;
    } else {
      state.queueLength += 1;
    }
    await this.playerStore.save(profile);
    return { ok: true };
  }

  /**
   * Claim one bomb from a factory's storage at `index` and move it to the
   * player's stockpile.
   */
  async claimOne(profile: PlayerProfile, factoryId: FactoryId, index: number): Promise<FactoryActionResult> {
    const cfg = FACTORIES[factoryId];
    if (!cfg) return { ok: false, reason: 'invalid_factory' };

    this.resolveAll(profile);

    const state = profile.factories[factoryId];
    if (index < 0 || index >= state.storage.length) {
      return { ok: false, reason: 'invalid_index' };
    }
    const [bomb] = state.storage.splice(index, 1);
    profile.bombStockpile[bomb] = (profile.bombStockpile[bomb] ?? 0) + 1;

    await this.playerStore.save(profile);
    return { ok: true };
  }

  /**
   * Claim every bomb from a factory's storage. No-op (with success) if empty
   * AFTER resolving — the player may have just-finished cycles to scoop up.
   */
  async claimAll(profile: PlayerProfile, factoryId: FactoryId): Promise<FactoryActionResult> {
    const cfg = FACTORIES[factoryId];
    if (!cfg) return { ok: false, reason: 'invalid_factory' };

    this.resolveAll(profile);

    const state = profile.factories[factoryId];
    if (state.storage.length === 0) return { ok: false, reason: 'nothing_to_claim' };

    for (const bomb of state.storage) {
      profile.bombStockpile[bomb] = (profile.bombStockpile[bomb] ?? 0) + 1;
    }
    state.storage = [];

    await this.playerStore.save(profile);
    return { ok: true };
  }
}

function canAfford(wallet: TreasureBundle, cost: TreasureBundle): boolean {
  for (const [type, amount] of Object.entries(cost) as Array<[keyof TreasureBundle, number]>) {
    if ((wallet[type] ?? 0) < (amount ?? 0)) return false;
  }
  return true;
}

function deductTreasures(wallet: TreasureBundle, cost: TreasureBundle): void {
  for (const [type, amount] of Object.entries(cost) as Array<[keyof TreasureBundle, number]>) {
    if (!amount) continue;
    const remaining = (wallet[type] ?? 0) - amount;
    if (remaining <= 0) delete wallet[type];
    else wallet[type] = remaining;
  }
}

/** Re-export rollFactoryBomb so tests don't need a separate import. */
export { rollFactoryBomb };
/** Bomb type re-export to keep test imports tight. */
export type { BombType };
