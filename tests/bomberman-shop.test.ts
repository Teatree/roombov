import { describe, it, expect } from 'vitest';
import { BombermanShopService } from '../src/server/BombermanShopService.ts';
import {
  SHOP_OFFER_COUNT, OFFER_STATS, FREE_BONUS_STATS, ESCAPE_PRICES, OFFER_BOMB_POOLS,
} from '../src/shared/config/bomberman-tiers.ts';
import type { PlayerProfile } from '../src/shared/types/player-profile.ts';

// Minimal store stub — the service only calls save().
const stubStore = { save: async () => {} } as unknown as ConstructorParameters<typeof BombermanShopService>[0];

function mkProfile(coins = 100000): PlayerProfile {
  return {
    id: 'p_test',
    coins,
    treasures: {},
    ownedBombermen: [],
    equippedBombermanId: null,
    bombStockpile: {},
    bombermanShop: null,
  } as unknown as PlayerProfile;
}

describe('BombermanShopService — reworked 3-offer model', () => {
  it('offers exactly 3 tier-1 (blue/paid) Bombermen with the fixed stats + loadout', async () => {
    const svc = new BombermanShopService(stubStore);
    const cycle = await svc.getOrGenerateCycle(mkProfile(), Date.now());

    expect(cycle.bombermen.length).toBe(SHOP_OFFER_COUNT);
    for (const t of cycle.bombermen) {
      expect(t.tier).toBe('paid'); // blue visual
      expect(t.maxCustomSlots).toBe(OFFER_STATS.maxCustomSlots); // 4
      expect(t.stackSize).toBe(OFFER_STATS.stackSize);           // 5
      expect(t.inventory.slots.length).toBe(4);

      const [offensive, escape, flare, fourth] = t.inventory.slots;
      expect(OFFER_BOMB_POOLS.offensive).toContain(offensive!.type);
      expect(offensive!.count).toBe(OFFER_STATS.offensiveCount);  // 5
      expect(OFFER_BOMB_POOLS.escape).toContain(escape!.type);
      expect(escape!.count).toBe(OFFER_STATS.escapeCount);        // 2
      expect(OFFER_BOMB_POOLS.flare).toContain(flare!.type);
      expect(flare!.count).toBe(OFFER_STATS.flareCount);          // 2
      expect(fourth).toBeNull();                                  // 4th slot empty

      // Price is set purely by the escape.
      expect(t.price).toBe(ESCAPE_PRICES[escape!.type]);
    }
  });

  it('pre-rolls a FREE bonus Bomberman with the lighter loadout', async () => {
    const svc = new BombermanShopService(stubStore);
    const cycle = await svc.getOrGenerateCycle(mkProfile(), Date.now());
    const free = cycle.freeBonus!;
    expect(free).toBeDefined();
    expect(free.tier).toBe('free');
    expect(free.price).toBe(0);
    const [off, esc, fl, fourth] = free.inventory.slots;
    expect(off!.count).toBe(FREE_BONUS_STATS.offensiveCount); // 3
    expect(esc!.count).toBe(FREE_BONUS_STATS.escapeCount);    // 1
    expect(fl!.count).toBe(FREE_BONUS_STATS.flareCount);      // 1
    expect(fourth).toBeNull();
  });

  it('only surfaces the free bonus once all 3 paid offers are bought', async () => {
    const svc = new BombermanShopService(stubStore);
    const profile = mkProfile();
    const now = Date.now();
    const cycle = await svc.getOrGenerateCycle(profile, now);

    // None bought → 3 cards, no bonus.
    let view = await svc.getCycleForClient(profile, now);
    expect(view.bombermen.length).toBe(3);
    expect(view.bombermen.some(b => b.id === cycle.freeBonus!.id)).toBe(false);

    // Mark all 3 bought → bonus appears as a 4th card.
    cycle.boughtTemplateIds = cycle.bombermen.map(b => b.id);
    view = await svc.getCycleForClient(profile, now);
    expect(view.bombermen.length).toBe(4);
    expect(view.bombermen[3].id).toBe(cycle.freeBonus!.id);
    expect(view.bombermen[3].price).toBe(0);
  });

  it('refuses to buy the free bonus before all paid offers are bought', async () => {
    const svc = new BombermanShopService(stubStore);
    const profile = mkProfile();
    const cycle = await svc.getOrGenerateCycle(profile, Date.now());
    const freeId = cycle.freeBonus!.id;

    const early = await svc.buyBomberman(profile, freeId);
    expect(early.ok).toBe(false);

    // Buy all three, then the bonus becomes purchasable (and free).
    for (const t of [...cycle.bombermen]) {
      const r = await svc.buyBomberman(profile, t.id);
      expect(r.ok).toBe(true);
    }
    const late = await svc.buyBomberman(profile, freeId);
    expect(late.ok).toBe(true);
  });
});
