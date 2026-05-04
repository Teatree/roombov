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
  it('test_engine_tick_first_tick_from_empty_fills_all_gamblers', () => {
    // Arrange
    const state = freshState();
    const treasures: TreasureBundle = { fish: 100 };
    const rng = createSeededRandom(1);

    // Act
    const next = tickGamblerStreet(state, treasures, NOW + 1, rng);

    // Assert
    expect(next.gamblers).toHaveLength(GAMBLER_STREET_GLOBAL.slotCount);
    expect(next.pendingArrivals).toHaveLength(0);
  });

  it('test_engine_tick_respects_max_per_treasure_type_cap', () => {
    // Arrange
    const state = freshState();
    const treasures: TreasureBundle = { fish: 1000 };

    // Act + Assert across many seeds
    for (let seed = 1; seed <= 50; seed++) {
      const rng = createSeededRandom(seed);
      const next = tickGamblerStreet(state, treasures, NOW + 1, rng);
      const counts: Record<string, number> = {};
      for (const g of next.gamblers) {
        counts[g.treasureType] = (counts[g.treasureType] ?? 0) + 1;
      }
      for (const [type, n] of Object.entries(counts)) {
        expect(
          n,
          `seed=${seed} treasure=${type} appeared ${n} times (cap=${GAMBLER_STREET_GLOBAL.maxGamblersPerTreasureType})`,
        ).toBeLessThanOrEqual(GAMBLER_STREET_GLOBAL.maxGamblersPerTreasureType);
      }
    }
  });

  it('test_engine_tick_initial_gamblers_are_staggered_by_minStaggerMs', () => {
    // Arrange
    const state = freshState();
    const rng = createSeededRandom(7);

    // Act
    const next = tickGamblerStreet(state, {}, NOW + 1, rng);

    // Assert — adjacent gamblers' expiries differ by >= minStaggerMs.
    for (let i = 1; i < next.gamblers.length; i++) {
      const delta = next.gamblers[i].expiresAt - next.gamblers[i - 1].expiresAt;
      expect(delta).toBeGreaterThanOrEqual(GAMBLER_STREET_GLOBAL.minStaggerMs);
    }
  });

  it('test_engine_tick_does_not_regenerate_gamblers_whose_lifespan_has_not_elapsed', () => {
    // Arrange
    const state = freshState();
    const rng = createSeededRandom(123);
    const populated = tickGamblerStreet(state, {}, NOW + 1, rng);
    const idsBefore = populated.gamblers.map(g => g.id);

    // Act — tick again 100ms later, well within all gamblers' lifespans.
    const later = tickGamblerStreet(populated, {}, NOW + 100, rng);

    // Assert
    expect(later.gamblers.map(g => g.id)).toEqual(idsBefore);
  });

  it('test_engine_tick_removes_expired_gambler_and_queues_pending_arrival', () => {
    // Arrange
    const state = freshState();
    const rng = createSeededRandom(7);
    const populated = tickGamblerStreet(state, {}, NOW + 1, rng);
    const leftmostExpiry = populated.gamblers[0].expiresAt;

    // Act — advance to just after the leftmost gambler's expiry but before
    //       the respawn cooldown could elapse.
    const minRespawn = GAMBLER_STREET_GLOBAL.respawnDelayRangeMs[0];
    const justAfter = tickGamblerStreet(populated, {}, leftmostExpiry + 1, rng);

    // Assert — leftmost is gone; one pending arrival queued for ~now+respawn.
    expect(justAfter.gamblers).toHaveLength(GAMBLER_STREET_GLOBAL.slotCount - 1);
    expect(justAfter.pendingArrivals).toHaveLength(1);
    expect(justAfter.pendingArrivals[0]).toBeGreaterThanOrEqual(leftmostExpiry + minRespawn);
  });

  it('test_engine_tick_respawn_arrives_at_right_end_after_delay', () => {
    // Arrange
    const state = freshState();
    const rng = createSeededRandom(7);
    const populated = tickGamblerStreet(state, {}, NOW + 1, rng);
    const leftmostExpiry = populated.gamblers[0].expiresAt;

    // Act — advance well past expiry + max respawn delay.
    const wayAfter = tickGamblerStreet(
      populated, {},
      leftmostExpiry + GAMBLER_STREET_GLOBAL.respawnDelayRangeMs[1] + 100,
      rng,
    );

    // Assert — back to full count, fresh gambler at the right end.
    expect(wayAfter.gamblers).toHaveLength(GAMBLER_STREET_GLOBAL.slotCount);
    expect(wayAfter.pendingArrivals).toHaveLength(0);
    // The new rightmost did not exist in the previous populated state.
    const previousIds = new Set(populated.gamblers.map(g => g.id));
    const newRightmost = wayAfter.gamblers[wayAfter.gamblers.length - 1];
    expect(previousIds.has(newRightmost.id)).toBe(false);
  });

  it('test_engine_tick_offline_aging_still_produces_full_carousel', () => {
    // Arrange
    const state = freshState();
    const rng = createSeededRandom(99);
    const populated = tickGamblerStreet(state, {}, NOW + 1, rng);

    // Act — simulate the player being offline for an hour. Many remove/respawn
    //       cycles should have happened.
    const oneHourLater = NOW + 60 * 60_000;
    const aged = tickGamblerStreet(populated, {}, oneHourLater, rng);

    // Assert — carousel is fully stocked with fresh gamblers, no leftovers.
    expect(aged.gamblers).toHaveLength(GAMBLER_STREET_GLOBAL.slotCount);
    for (const g of aged.gamblers) {
      expect(g.expiresAt).toBeGreaterThan(oneHourLater);
    }
  });
});

describe('computeAskAmount', () => {
  it('test_compute_ask_amount_uses_absolute_floor_when_owned_below_threshold', () => {
    // Arrange — fish: minAmountRange=[20,100], threshold=50, round=5.
    const tuning = GAMBLER_TREASURE_TUNING.fish;

    // Act + Assert across several seeds
    for (let s = 0; s < 50; s++) {
      const r = createSeededRandom(s);
      const amount = computeAskAmount('fish', 0, r);
      expect(amount).toBeGreaterThanOrEqual(tuning.minAmountRange[0]);
      expect(amount).toBeLessThanOrEqual(tuning.minAmountRange[1]);
      expect(amount % tuning.roundAmountTo).toBe(0);
    }
  });

  it('test_compute_ask_amount_uses_percentage_when_owned_at_or_above_threshold', () => {
    // Arrange — owned=500 fish, percentage range = [0.10, 0.30] → asks 50..150.
    for (let s = 0; s < 50; s++) {
      const r = createSeededRandom(s);
      const amount = computeAskAmount('fish', 500, r);
      expect(amount).toBeGreaterThanOrEqual(50);
      expect(amount).toBeLessThanOrEqual(150);
      expect(amount % 5).toBe(0);
    }
  });

  it('test_compute_ask_amount_floors_at_minimum_even_when_percentage_rounds_lower', () => {
    // Arrange — at threshold-1 absolute branch fires; at threshold percentage
    // branch fires. Small owned counts could round below minAbs without floor.
    for (let s = 0; s < 30; s++) {
      const r = createSeededRandom(s);
      const amount = computeAskAmount('amulets', 21, r); // amulets threshold=20
      expect(amount).toBeGreaterThanOrEqual(GAMBLER_TREASURE_TUNING.amulets.minAmountRange[0]);
    }
  });
});

describe('generateGambler', () => {
  it('test_generate_gambler_produces_valid_gambler_with_matching_coin_reward', () => {
    // Arrange
    const rng = createSeededRandom(42);
    const earliestExpiry = NOW + GAMBLER_STREET_GLOBAL.lifespanRangeMs[0];

    // Act
    const g = generateGambler({ fish: 200 }, {}, NOW, earliestExpiry, 1, rng);

    // Assert
    expect(g.id).toMatch(/^g_/);
    expect(g.name.length).toBeGreaterThan(0);
    expect(g.treasureAmount).toBeGreaterThan(0);
    expect(g.coinReward).toBeGreaterThanOrEqual(0);
    expect(g.expiresAt).toBeGreaterThan(g.createdAt);
    expect(g.expiresAt).toBeGreaterThanOrEqual(earliestExpiry);
  });

  it('test_generate_gambler_clamps_expiry_up_to_earliest_floor', () => {
    // Arrange — set a floor far beyond what a natural lifespan would produce.
    // The generator must clamp up so the staggered carousel invariant holds.
    const rng = createSeededRandom(42);
    const farFloor = NOW + 10 * 60_000; // 10 minutes — well beyond 30-60s lifespan

    // Act
    const g = generateGambler({}, {}, NOW, farFloor, 1, rng);

    // Assert
    expect(g.expiresAt).toBe(farFloor);
  });
});

describe('resolveBet', () => {
  function gamblerStateWithSingleSlot(): { state: GamblerStreetState; rng: () => number } {
    const state = freshState();
    const rng = createSeededRandom(12345);
    const populated = tickGamblerStreet(
      state,
      { fish: 1000, amulets: 50, chalice: 100, jade: 100, books: 100, coffee: 100, grapes: 100, lanterns: 100, bones: 100, mushrooms: 100 },
      NOW + 1,
      rng,
    );
    return { state: populated, rng };
  }

  it('test_resolve_bet_refuses_invalid_slot_when_no_gamblers', () => {
    // Arrange
    const state = freshState(); // no active gamblers yet
    const rng = createSeededRandom(1);

    // Act
    const result = resolveBet(state, {}, 0, 'cheap', 'left', NOW, rng);

    // Assert
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_slot');
  });

  it('test_resolve_bet_refuses_when_treasure_insufficient', () => {
    // Arrange
    const { state, rng } = gamblerStateWithSingleSlot();
    const profile: TreasureBundle = {};

    // Act
    const result = resolveBet(state, profile, 0, 'cheap', 'left', NOW + 2, rng);

    // Assert
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('insufficient_treasure');
  });

  it('test_resolve_bet_winning_outcome_has_correctHand_equals_picked', () => {
    // Arrange — force rng to return 0.0 so any winChance > 0 is a win.
    const { state } = gamblerStateWithSingleSlot();
    const gambler = state.gamblers[0];
    const profile: TreasureBundle = { [gambler.treasureType]: 10_000 };
    const winningRng = (): number => 0.0;

    // Act
    const result = resolveBet(state, profile, 0, 'cheap', 'left', NOW + 2, winningRng);

    // Assert
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.outcome.won).toBe(true);
      expect(result.outcome.correctHand).toBe('left');
      expect(result.outcome.coinsGained).toBe(gambler.coinReward);
      expect(result.outcome.treasurePaid).toBe(gambler.treasureAmount);
      expect(result.respawnAt).toBeGreaterThanOrEqual(NOW + 2 + GAMBLER_STREET_GLOBAL.respawnDelayRangeMs[0]);
    }
  });

  it('test_resolve_bet_losing_outcome_has_correctHand_equals_other', () => {
    // Arrange — force rng to return 0.99 so the cheap (50%) bet always loses.
    const { state } = gamblerStateWithSingleSlot();
    const gambler = state.gamblers[0];
    const profile: TreasureBundle = { [gambler.treasureType]: 10_000 };
    const losingRng = (): number => 0.99;

    // Act
    const result = resolveBet(state, profile, 0, 'cheap', 'right', NOW + 2, losingRng);

    // Assert
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.outcome.won).toBe(false);
      expect(result.outcome.correctHand).toBe('left'); // opposite of picked
      expect(result.outcome.coinsGained).toBe(0);
      expect(result.outcome.treasurePaid).toBe(gambler.treasureAmount);
    }
  });

  it('test_resolve_bet_premium_tier_charges_double_treasure', () => {
    // Arrange
    const { state } = gamblerStateWithSingleSlot();
    const gambler = state.gamblers[0];
    const profile: TreasureBundle = { [gambler.treasureType]: 10_000 };
    const winRng = (): number => 0.0;

    // Act
    const result = resolveBet(state, profile, 0, 'premium', 'left', NOW + 2, winRng);

    // Assert
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.outcome.treasurePaid).toBe(gambler.treasureAmount * 2);
    }
  });

  it('test_resolve_bet_refuses_expired_gambler', () => {
    // Arrange
    const { state, rng } = gamblerStateWithSingleSlot();
    const gambler = state.gamblers[0];
    const profile: TreasureBundle = { [gambler.treasureType]: 10_000 };
    const farFuture = gambler.expiresAt + 1;

    // Act
    const result = resolveBet(state, profile, 0, 'cheap', 'left', farFuture, rng);

    // Assert
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('gambler_expired');
  });
});
