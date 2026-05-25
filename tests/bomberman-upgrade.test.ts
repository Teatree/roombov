import { describe, expect, it } from 'vitest';
import { BombermanUpgradeService, nextTierCost } from '../src/server/BombermanUpgradeService.ts';
import {
  effectiveMaxCustomSlots,
  effectiveMaxHp,
  effectiveStackSize,
  isFullyUpgraded,
  tiersRemaining,
} from '../src/shared/utils/bomberman-stats.ts';
import { BALANCE } from '../src/shared/config/balance.ts';
import { createEmptyGamblerStreet } from '../src/shared/types/gambler-street.ts';
import { GAMBLER_STREET_GLOBAL } from '../src/shared/config/gambler-street.ts';
import { createEmptyFactories } from '../src/shared/types/factory.ts';
import type { PlayerProfile } from '../src/shared/types/player-profile.ts';
import type { OwnedBomberman } from '../src/shared/types/bomberman.ts';

class StubStore {
  saves = 0;
  async save(_p: PlayerProfile): Promise<void> {
    this.saves += 1;
  }
}

function makeOwned(overrides: Partial<OwnedBomberman> = {}): OwnedBomberman {
  return {
    id: 'bm_1',
    name: 'Test',
    tier: 'paid',
    colors: { shirt: 0, pants: 0, hair: 0 },
    tint: 0xffffff,
    character: 'char1',
    maxCustomSlots: 4,
    stackSize: 6,
    inventory: { slots: [null, null, null, null] },
    purchasedAt: 0,
    sourceTemplateId: 't',
    sp: 0,
    upgrades: { cap: 0, stack: 0, hp: 0 },
    ...overrides,
  };
}

function makeProfile(owned: OwnedBomberman): PlayerProfile {
  return {
    id: 'p',
    createdAt: 0,
    updatedAt: 0,
    coins: 100_000,
    treasures: { mushrooms: 999, coffee: 999, grapes: 999 },
    ownedBombermen: [owned],
    equippedBombermanId: owned.id,
    bombStockpile: {},
    gamblerStreet: createEmptyGamblerStreet(0, GAMBLER_STREET_GLOBAL.slotCount),
    bombermanShop: null,
    factories: createEmptyFactories(),
  };
}

describe('bomberman-stats helpers', () => {
  it('test_effectiveStackSize_addsUpgradeTiers', () => {
    const bm = makeOwned({ stackSize: 6, upgrades: { cap: 0, stack: 2, hp: 0 } });
    expect(effectiveStackSize(bm)).toBe(8);
  });

  it('test_effectiveMaxCustomSlots_clampsByTotalSlotCap', () => {
    // Expensive tier owns 6 custom; +1 upgrade = 7 custom (8 total incl Rock).
    const bm = makeOwned({ maxCustomSlots: 6, upgrades: { cap: 0, stack: 0, hp: 0 } });
    bm.upgrades.cap = 2;
    expect(effectiveMaxCustomSlots(bm)).toBe(BALANCE.upgrades.cap.totalSlotCap - 1);
  });

  it('test_effectiveMaxHp_clampsAtHpCap', () => {
    const bm = makeOwned({ upgrades: { cap: 0, stack: 0, hp: 1 } });
    expect(effectiveMaxHp(bm)).toBe(BALANCE.upgrades.hp.cap);
  });

  it('test_tiersRemaining_capRespectsTotalSlotCap', () => {
    // Expensive (6 custom) has only 1 cap upgrade headroom (8 - 1 - 6 = 1).
    const bm = makeOwned({ maxCustomSlots: 6 });
    expect(tiersRemaining(bm, 'cap')).toBe(1);
  });

  it('test_isFullyUpgraded_returnsTrueAtAllCaps', () => {
    const bm = makeOwned({
      maxCustomSlots: 4,
      upgrades: { cap: 2, stack: 3, hp: 1 },
    });
    expect(isFullyUpgraded(bm)).toBe(true);
  });
});

describe('BombermanUpgradeService', () => {
  it('test_applyUpgrade_validPurchase_deductsAndBumps', async () => {
    const owned = makeOwned({ sp: 500 });
    const profile = makeProfile(owned);
    const svc = new BombermanUpgradeService(new StubStore() as never);
    const cost = nextTierCost('cap', 0)!;

    const result = await svc.applyUpgrade(profile, owned.id, 'cap');

    expect(result.ok).toBe(true);
    expect(owned.upgrades.cap).toBe(1);
    expect(owned.sp).toBe(500 - cost.sp);
    expect(profile.coins).toBe(100_000 - cost.coins);
    expect(profile.treasures.mushrooms).toBe(999 - cost.treasure);
  });

  it('test_applyUpgrade_insufficientSp_rejectsAndKeepsResources', async () => {
    const owned = makeOwned({ sp: 0 });
    const profile = makeProfile(owned);
    const svc = new BombermanUpgradeService(new StubStore() as never);

    const result = await svc.applyUpgrade(profile, owned.id, 'cap');

    expect(result).toEqual({ ok: false, reason: 'insufficient_sp' });
    expect(owned.upgrades.cap).toBe(0);
    expect(profile.coins).toBe(100_000);
  });

  it('test_applyUpgrade_capExhausted_rejects', async () => {
    const owned = makeOwned({ sp: 999_999, upgrades: { cap: 2, stack: 0, hp: 0 } });
    const profile = makeProfile(owned);
    const svc = new BombermanUpgradeService(new StubStore() as never);

    const result = await svc.applyUpgrade(profile, owned.id, 'cap');

    expect(result).toEqual({ ok: false, reason: 'no_tiers_left' });
  });

  it('test_applyUpgrade_hpTrackCappedAt1Tier', async () => {
    const owned = makeOwned({ sp: 999_999, upgrades: { cap: 0, stack: 0, hp: 1 } });
    const profile = makeProfile(owned);
    const svc = new BombermanUpgradeService(new StubStore() as never);

    const result = await svc.applyUpgrade(profile, owned.id, 'hp');

    expect(result).toEqual({ ok: false, reason: 'no_tiers_left' });
  });

  it('test_applyUpgrade_unknownBomberman_rejects', async () => {
    const owned = makeOwned();
    const profile = makeProfile(owned);
    const svc = new BombermanUpgradeService(new StubStore() as never);

    const result = await svc.applyUpgrade(profile, 'nope', 'stack');

    expect(result).toEqual({ ok: false, reason: 'unknown_bomberman' });
  });

  it('test_applyUpgrade_persistsThroughStore', async () => {
    const store = new StubStore();
    const owned = makeOwned({ sp: 999_999 });
    const profile = makeProfile(owned);
    const svc = new BombermanUpgradeService(store as never);

    await svc.applyUpgrade(profile, owned.id, 'stack');

    expect(store.saves).toBe(1);
  });
});
