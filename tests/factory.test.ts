import { describe, expect, it } from 'vitest';
import { FactoryService, rollFactoryBomb } from '../src/server/FactoryService.ts';
import { FACTORIES, totalBombWeight } from '../src/shared/config/factories.ts';
import { createEmptyFactories } from '../src/shared/types/factory.ts';
import type { PlayerProfile } from '../src/shared/types/player-profile.ts';
import { createEmptyGamblerStreet } from '../src/shared/types/gambler-street.ts';
import { GAMBLER_STREET_GLOBAL } from '../src/shared/config/gambler-street.ts';
import { createSeededRandom } from '../src/shared/utils/seeded-random.ts';

/** Minimal PlayerStore stub — captures saves without touching disk. */
class StubStore {
  saved = 0;
  async save(_p: PlayerProfile): Promise<void> {
    this.saved += 1;
  }
}

function makeProfile(overrides: Partial<PlayerProfile> = {}): PlayerProfile {
  const now = 0;
  return {
    id: 'p_test',
    createdAt: now,
    updatedAt: now,
    coins: 0,
    treasures: {},
    ownedBombermen: [],
    equippedBombermanId: null,
    bombStockpile: {},
    gamblerStreet: createEmptyGamblerStreet(now, GAMBLER_STREET_GLOBAL.slotCount),
    bombermanShop: null,
    factories: createEmptyFactories(),
    ...overrides,
  };
}

function makeService(rand: () => number, now: () => number): FactoryService {
  return new FactoryService(new StubStore() as never, { rand, now });
}

describe('FactoryService', () => {
  it('test_factory_startCycle_withoutTreasures_returnsInsufficient', async () => {
    // Arrange
    const profile = makeProfile();
    const svc = makeService(Math.random, () => 0);

    // Act
    const result = await svc.startCycle(profile, 1);

    // Assert
    expect(result).toEqual({ ok: false, reason: 'insufficient_treasures' });
    expect(profile.factories[1].queueLength).toBe(0);
  });

  it('test_factory_startCycle_deductsCost_andQueuesCycle', async () => {
    // Arrange — Factory #1 costs mushrooms x 25.
    const profile = makeProfile({ treasures: { mushrooms: 50 } });
    const svc = makeService(() => 0, () => 1_000);

    // Act
    const result = await svc.startCycle(profile, 1);

    // Assert
    expect(result.ok).toBe(true);
    expect(profile.treasures.mushrooms).toBe(25);
    expect(profile.factories[1].queueLength).toBe(1);
    expect(profile.factories[1].firstCycleStartedAt).toBe(1_000);
  });

  it('test_factory_startCycle_secondQueueDoesNotResetTimer', async () => {
    // Arrange — Factory #1 has been running for 60s, queue 1.
    const profile = makeProfile({
      treasures: { mushrooms: 100 },
      factories: {
        ...createEmptyFactories(),
        1: { firstCycleStartedAt: 1_000, queueLength: 1, storage: [] },
      } as never,
    });
    const svc = makeService(() => 0, () => 61_000);

    // Act
    await svc.startCycle(profile, 1);

    // Assert — timer still anchored at 1_000, queue length now 2.
    expect(profile.factories[1].firstCycleStartedAt).toBe(1_000);
    expect(profile.factories[1].queueLength).toBe(2);
  });

  it('test_factory_resolveAll_completedCyclesAreRolledIntoStorage', async () => {
    // Arrange — Factory #1 (5min cycle), queued 4 cycles, 11 min later.
    const profile = makeProfile({
      factories: {
        ...createEmptyFactories(),
        1: { firstCycleStartedAt: 0, queueLength: 4, storage: [] },
      } as never,
    });
    const rng = createSeededRandom(42);
    const svc = makeService(rng, () => 11 * 60 * 1000);

    // Act
    const changed = svc.resolveAll(profile);

    // Assert — exactly 2 completed (5min + 5min), 2 still queued, timer advanced.
    expect(changed).toBe(true);
    expect(profile.factories[1].storage.length).toBe(2);
    expect(profile.factories[1].queueLength).toBe(2);
    expect(profile.factories[1].firstCycleStartedAt).toBe(10 * 60 * 1000);
  });

  it('test_factory_resolveAll_offlineCompletionsAllResolve', async () => {
    // Arrange — queued 4 cycles, came back 100 hours later.
    const profile = makeProfile({
      factories: {
        ...createEmptyFactories(),
        4: { firstCycleStartedAt: 0, queueLength: 4, storage: [] },
      } as never,
    });
    const svc = makeService(createSeededRandom(7), () => 100 * 60 * 60 * 1000);

    // Act
    svc.resolveAll(profile);

    // Assert — all 4 produced, queue empty, timer null.
    expect(profile.factories[4].storage.length).toBe(4);
    expect(profile.factories[4].queueLength).toBe(0);
    expect(profile.factories[4].firstCycleStartedAt).toBeNull();
  });

  it('test_factory_claimOne_movesBombToStockpile', async () => {
    // Arrange
    const profile = makeProfile({
      factories: {
        ...createEmptyFactories(),
        1: { firstCycleStartedAt: null, queueLength: 0, storage: ['bomb', 'flare'] },
      } as never,
    });
    const svc = makeService(Math.random, () => 0);

    // Act
    const result = await svc.claimOne(profile, 1, 0);

    // Assert
    expect(result.ok).toBe(true);
    expect(profile.factories[1].storage).toEqual(['flare']);
    expect(profile.bombStockpile.bomb).toBe(1);
  });

  it('test_factory_claimAll_movesEverything_andClearsStorage', async () => {
    // Arrange
    const profile = makeProfile({
      factories: {
        ...createEmptyFactories(),
        2: { firstCycleStartedAt: null, queueLength: 0, storage: ['flash', 'flash', 'shield'] },
      } as never,
    });
    const svc = makeService(Math.random, () => 0);

    // Act
    const result = await svc.claimAll(profile, 2);

    // Assert
    expect(result.ok).toBe(true);
    expect(profile.factories[2].storage).toEqual([]);
    expect(profile.bombStockpile.flash).toBe(2);
    expect(profile.bombStockpile.shield).toBe(1);
  });

  it('test_factory_claimAll_emptyStorage_returnsNothingToClaim', async () => {
    // Arrange
    const profile = makeProfile();
    const svc = makeService(Math.random, () => 0);

    // Act
    const result = await svc.claimAll(profile, 1);

    // Assert
    expect(result).toEqual({ ok: false, reason: 'nothing_to_claim' });
  });
});

describe('rollFactoryBomb (weighted distribution)', () => {
  it('test_rollFactoryBomb_onlyProducesBombsWithNonZeroWeights', () => {
    // Arrange
    const rng = createSeededRandom(123);
    const cfg = FACTORIES[1];
    const allowed = new Set(Object.entries(cfg.bombWeights)
      .filter(([, w]) => (w ?? 0) > 0)
      .map(([t]) => t));

    // Act — sample many times.
    for (let i = 0; i < 500; i++) {
      const rolled = rollFactoryBomb(cfg, rng);
      // Assert — every roll must be in the allowed set.
      expect(rolled).not.toBeNull();
      expect(allowed.has(rolled!)).toBe(true);
    }
  });

  it('test_rollFactoryBomb_distributionMatchesWeights_approximately', () => {
    // Arrange — 20_000 samples is enough to be within ~5% per bucket for the
    // factory tables we ship (no weight is below 5/35 ≈ 14%).
    const cfg = FACTORIES[1];
    const rng = createSeededRandom(0xC0FFEE);
    const total = totalBombWeight(cfg);
    const samples = 20_000;
    const counts: Record<string, number> = {};

    // Act
    for (let i = 0; i < samples; i++) {
      const t = rollFactoryBomb(cfg, rng)!;
      counts[t] = (counts[t] ?? 0) + 1;
    }

    // Assert — every bucket within 20% of its expected share (loose; this is
    // a regression bound, not a statistics test).
    for (const [type, weight] of Object.entries(cfg.bombWeights)) {
      if (!weight) continue;
      const expectedShare = weight / total;
      const observed = (counts[type] ?? 0) / samples;
      expect(observed).toBeGreaterThan(expectedShare * 0.8);
      expect(observed).toBeLessThan(expectedShare * 1.2);
    }
  });
});
