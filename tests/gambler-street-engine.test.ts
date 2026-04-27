import { describe, it, expect } from 'vitest';
import {
  tickGamblerStreet,
  generateGambler,
  computeAskAmount,
  resolveBet,
} from '../src/shared/systems/GamblerStreetEngine.ts';
import {
  createEmptyGamblerStreet,
  type GamblerStreetState,
} from '../src/shared/types/gambler-street.ts';
import {
  GAMBLER_STREET_GLOBAL,
  GAMBLER_TREASURE_TUNING,
} from '../src/shared/config/gambler-street.ts';
import type { TreasureBundle } from '../src/shared/config/treasures.ts';
import { createSeededRandom } from '../src/shared/utils/seeded-random.ts';

const NOW = 1_700_000_000_000; // arbitrary fixed Unix ms for deterministic tests

function freshState(): GamblerStreetState {
  return createEmptyGamblerStreet(NOW, GAMBLER_STREET_GLOBAL.slotCount);
}

describe('tickGamblerStreet', () => {
  it('fills all 5 slots with gamblers on first tick from empty state', () => {
    // Arrange
    const state = freshState();
    const treasures: TreasureBundle = { fish: 100 };
    const rng = createSeededRandom(1);

    // Act
    const next = tickGamblerStreet(state, treasures, NOW + 1, rng);

    // Assert
    expect(next.slots).toHaveLength(GAMBLER_STREET_GLOBAL.slotCount);
    for (const slot of next.slots) {
      expect(slot.kind).toBe('gambler');
    }
  });

  it('respects max-per-treasure-type cap when generating', () => {
    // Arrange — force 5 slots ready to fill, all at NOW.
    const state = freshState();
    const treasures: TreasureBundle = { fish: 1000 };

    // Act — generate many times with different seeds; cap must hold every time.
    for (let seed = 1; seed <= 50; seed++) {
      const rng = createSeededRandom(seed);
      const next = tickGamblerStreet(state, treasures, NOW + 1, rng);
      const counts: Record<string, number> = {};
      for (const slot of next.slots) {
        if (slot.kind !== 'gambler') continue;
        const t = slot.gambler.treasureType;
        counts[t] = (counts[t] ?? 0) + 1;
      }
      for (const [type, n] of Object.entries(counts)) {
        expect(
          n,
          `seed=${seed} treasure=${type} appeared ${n} times (cap=${GAMBLER_STREET_GLOBAL.maxGamblersPerTreasureType})`,
        ).toBeLessThanOrEqual(GAMBLER_STREET_GLOBAL.maxGamblersPerTreasureType);
      }
    }
  });

  it('does not regenerate gamblers whose lifespan has not yet elapsed', () => {
    // Arrange — populate the street, then tick again 100ms later.
    const state = freshState();
    const treasures: TreasureBundle = {};
    const rng = createSeededRandom(123);
    const populated = tickGamblerStreet(state, treasures, NOW + 1, rng);
    const idsBefore = populated.slots.map((s) => (s.kind === 'gambler' ? s.gambler.id : ''));

    // Act
    const later = tickGamblerStreet(populated, treasures, NOW + 100, rng);
    const idsAfter = later.slots.map((s) => (s.kind === 'gambler' ? s.gambler.id : ''));

    // Assert
    expect(idsAfter).toEqual(idsBefore);
  });

  it('expires gamblers past their lifespan and replaces them after expiryCooldownMs', () => {
    // Arrange — populate, then advance well past the longest lifespan.
    const state = freshState();
    const rng = createSeededRandom(7);
    const populated = tickGamblerStreet(state, {}, NOW + 1, rng);
    const longestLifespan = GAMBLER_STREET_GLOBAL.lifespanRangeMs[1];

    // Act — advance to right after expiry but before the cooldown elapses.
    const justAfterExpiry = tickGamblerStreet(populated, {}, NOW + longestLifespan + 1, rng);
    // All slots should now be cooldown (no replacement yet).
    expect(justAfterExpiry.slots.every((s) => s.kind === 'cooldown')).toBe(true);

    // Advance past the expiry cooldown — slots should be filled again.
    const afterCooldown = tickGamblerStreet(
      justAfterExpiry,
      {},
      NOW + longestLifespan + GAMBLER_STREET_GLOBAL.expiryCooldownMs + 100,
      rng,
    );
    expect(afterCooldown.slots.every((s) => s.kind === 'gambler')).toBe(true);
  });
});

describe('computeAskAmount', () => {
  it('uses the absolute floor range when player owns less than threshold', () => {
    // Arrange — fish: minAmountRange=[20,100], threshold=50, round=5.
    const rng = createSeededRandom(1);
    const tuning = GAMBLER_TREASURE_TUNING.fish;

    // Act + Assert across several seeds
    for (let s = 0; s < 50; s++) {
      const r = createSeededRandom(s);
      const amount = computeAskAmount('fish', 0, r);
      expect(amount).toBeGreaterThanOrEqual(tuning.minAmountRange[0]);
      expect(amount).toBeLessThanOrEqual(tuning.minAmountRange[1]);
      expect(amount % tuning.roundAmountTo).toBe(0);
    }
    // Suppress unused var warning for `rng`.
    void rng;
  });

  it('uses the percentage range when player owns at or above threshold', () => {
    // Arrange — owned=500 fish, percentage range = [0.10, 0.30] → asks for 50..150.
    for (let s = 0; s < 50; s++) {
      const r = createSeededRandom(s);
      const amount = computeAskAmount('fish', 500, r);
      // Asked amount is a % of 500 in the 10–30% range, rounded to 5.
      expect(amount).toBeGreaterThanOrEqual(50);
      expect(amount).toBeLessThanOrEqual(150);
      expect(amount % 5).toBe(0);
    }
  });

  it('floors at the absolute minimum even if percentage rounding would go lower', () => {
    // Arrange — at threshold-1 the absolute branch fires; at exactly threshold
    // the percentage branch fires. With small owned counts the rounding could
    // produce a value below minAbs without the floor.
    for (let s = 0; s < 30; s++) {
      const r = createSeededRandom(s);
      const amount = computeAskAmount('amulets', 21, r); // amulets threshold=20
      expect(amount).toBeGreaterThanOrEqual(GAMBLER_TREASURE_TUNING.amulets.minAmountRange[0]);
    }
  });
});

describe('generateGambler', () => {
  it('produces a Gambler with consistent fields and matching coin reward', () => {
    // Arrange
    const rng = createSeededRandom(42);

    // Act
    const g = generateGambler({ fish: 200 }, {}, NOW, 1, rng);

    // Assert
    expect(g.id).toMatch(/^g_/);
    expect(g.name.length).toBeGreaterThan(0);
    expect(g.treasureAmount).toBeGreaterThan(0);
    expect(g.coinReward).toBeGreaterThanOrEqual(0);
    expect(g.expiresAt).toBeGreaterThan(g.createdAt);
    expect(g.expiresAt - g.createdAt).toBeGreaterThanOrEqual(GAMBLER_STREET_GLOBAL.lifespanRangeMs[0]);
    expect(g.expiresAt - g.createdAt).toBeLessThan(GAMBLER_STREET_GLOBAL.lifespanRangeMs[1]);
  });
});

describe('resolveBet', () => {
  function gamblerStateWithSingleSlot(): { state: GamblerStreetState; rng: () => number } {
    const state = freshState();
    const rng = createSeededRandom(12345);
    const populated = tickGamblerStreet(state, { fish: 1000, amulets: 50, chalice: 100, jade: 100, books: 100, coffee: 100, grapes: 100, lanterns: 100, bones: 100, mushrooms: 100 }, NOW + 1, rng);
    return { state: populated, rng };
  }

  it('refuses bets on cooldown slots', () => {
    const state = freshState(); // all slots are cooldown
    const rng = createSeededRandom(1);
    const result = resolveBet(state, {}, 0, 'cheap', 'left', NOW, rng);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no_gambler');
  });

  it('refuses bets when treasure is insufficient', () => {
    // Arrange
    const { state, rng } = gamblerStateWithSingleSlot();
    const slot0 = state.slots[0];
    if (slot0.kind !== 'gambler') throw new Error('test setup failed');
    const profile: TreasureBundle = {}; // owns nothing of any type

    // Act
    const result = resolveBet(state, profile, 0, 'cheap', 'left', NOW + 2, rng);

    // Assert
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('insufficient_treasure');
  });

  it('produces a winning outcome with correctHand=picked when rng rolls below winChance', () => {
    // Arrange — force the next rng to return 0.0 so any winChance > 0 is a win.
    const { state } = gamblerStateWithSingleSlot();
    const slot0 = state.slots[0];
    if (slot0.kind !== 'gambler') throw new Error('test setup failed');
    const profile: TreasureBundle = { [slot0.gambler.treasureType]: 10_000 };
    const cheapRng = (): number => 0.0;

    // Act
    const result = resolveBet(state, profile, 0, 'cheap', 'left', NOW + 2, cheapRng);

    // Assert
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.outcome.won).toBe(true);
      expect(result.outcome.correctHand).toBe('left');
      expect(result.outcome.coinsGained).toBe(slot0.gambler.coinReward);
      expect(result.outcome.treasurePaid).toBe(slot0.gambler.treasureAmount);
      expect(result.nextSlot.kind).toBe('cooldown');
    }
  });

  it('produces a losing outcome with correctHand=other when rng rolls above winChance', () => {
    // Arrange — force the next rng to return 0.99 so the cheap (50%) bet always loses.
    const { state } = gamblerStateWithSingleSlot();
    const slot0 = state.slots[0];
    if (slot0.kind !== 'gambler') throw new Error('test setup failed');
    const profile: TreasureBundle = { [slot0.gambler.treasureType]: 10_000 };
    const losingRng = (): number => 0.99;

    // Act
    const result = resolveBet(state, profile, 0, 'cheap', 'right', NOW + 2, losingRng);

    // Assert
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.outcome.won).toBe(false);
      expect(result.outcome.correctHand).toBe('left'); // opposite of picked
      expect(result.outcome.coinsGained).toBe(0);
      expect(result.outcome.treasurePaid).toBe(slot0.gambler.treasureAmount);
    }
  });

  it('charges double treasure for the premium tier', () => {
    // Arrange
    const { state } = gamblerStateWithSingleSlot();
    const slot0 = state.slots[0];
    if (slot0.kind !== 'gambler') throw new Error('test setup failed');
    const profile: TreasureBundle = { [slot0.gambler.treasureType]: 10_000 };
    const winRng = (): number => 0.0;

    // Act
    const result = resolveBet(state, profile, 0, 'premium', 'left', NOW + 2, winRng);

    // Assert
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.outcome.treasurePaid).toBe(slot0.gambler.treasureAmount * 2);
    }
  });

  it('refuses bets on expired gamblers', () => {
    // Arrange
    const { state, rng } = gamblerStateWithSingleSlot();
    const slot0 = state.slots[0];
    if (slot0.kind !== 'gambler') throw new Error('test setup failed');
    const profile: TreasureBundle = { [slot0.gambler.treasureType]: 10_000 };
    // Use a `now` past the gambler's expiry.
    const farFuture = slot0.gambler.expiresAt + 1;

    // Act
    const result = resolveBet(state, profile, 0, 'cheap', 'left', farFuture, rng);

    // Assert
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('gambler_expired');
  });
});
