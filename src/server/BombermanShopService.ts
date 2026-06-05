/**
 * Bomberman Shop Service — per-player edition.
 *
 * Each player carries their own shop cycle on `profile.bombermanShop`. The
 * cycle is a 2-minute carousel of 5 rotating Bombermen (2 free, 2 paid,
 * 1 paid-expensive) generated lazily on first request and regenerated when
 * its `endsAt` has passed. Wall-clock timestamps mean the cycle ages while
 * the player is offline — they always come back to a freshly-stocked shop
 * with a real timer ticking down.
 *
 * Generation seed mixes the player's id + cycle start time so two players
 * never see the exact same roster, and so a fresh seed produces a new
 * roster every cycle.
 *
 * Purchase removes the bought template from the visible list (tracked via
 * `boughtTemplateIds`) so the bought card stays gone for the rest of the
 * cycle. Slot does NOT refill — the row shrinks until next cycle.
 */

import { rollBombermanName } from '../shared/config/bomberman-names.ts';
import type {
  BombermanShopCycle,
  BombermanTemplate,
  BombInventory,
  BombSlot,
  CharacterVariant,
  CosmeticColors,
  OwnedBomberman,
} from '../shared/types/bomberman.ts';
import { CHARACTER_VARIANTS } from '../shared/types/bomberman.ts';
import type { PlayerProfile } from '../shared/types/player-profile.ts';
import {
  SHOP_CYCLE_DURATION_MS,
  SHOP_OFFER_COUNT,
  OFFER_BOMB_POOLS,
  ESCAPE_PRICES,
  OFFER_STATS,
  FREE_BONUS_STATS,
} from '../shared/config/bomberman-tiers.ts';
import { BALANCE } from '../shared/config/balance.ts';
import { createSeededRandom } from '../shared/utils/seeded-random.ts';
import { rollColors, rollTint } from '../shared/utils/cosmetic-color.ts';
import type { PlayerStore } from './PlayerStore.ts';

export class BombermanShopService {
  private playerStore: PlayerStore;

  constructor(playerStore: PlayerStore) {
    this.playerStore = playerStore;
  }

  /**
   * Return the player's current cycle, regenerating first if it has expired
   * (or never existed). Persists changes immediately so the next request,
   * even after a server restart, sees the same roster + remaining timer.
   */
  async getOrGenerateCycle(profile: PlayerProfile, now = Date.now()): Promise<BombermanShopCycle> {
    const existing = profile.bombermanShop;
    if (existing && now < existing.endsAt) return existing;

    const fresh = this.generateCycle(profile.id, now);
    profile.bombermanShop = fresh;
    await this.playerStore.save(profile);
    return fresh;
  }

  /**
   * Cycle view sent to the client. Same as `getOrGenerateCycle` but with
   * per-player hardship discount applied: when the player owns zero
   * Bombermen AND can't afford the cheapest non-bought one, that cheapest
   * template's price is rewritten to 0 in the returned clone. Persisted
   * cycle is untouched so the discount disappears the moment they earn
   * enough coins or buy a Bomberman.
   */
  async getCycleForClient(profile: PlayerProfile, now = Date.now()): Promise<BombermanShopCycle> {
    const cycle = await this.getOrGenerateCycle(profile, now);

    // Apply the hardship discount (cheapest still-buyable → free for a broke,
    // Bomberman-less player) to the three paid offers.
    const discountedId = hardshipDiscountTemplateId(profile, cycle);
    const base = discountedId
      ? cycle.bombermen.map(b => (b.id === discountedId ? { ...b, price: 0 } : b))
      : cycle.bombermen;

    // Append the bonus FREE Bomberman once all three paid offers are bought
    // (and the bonus itself hasn't been taken). It rides in `bombermen` so the
    // existing client render path shows it like any other card.
    const bombermen = this.shouldOfferFreeBonus(cycle)
      ? [...base, cycle.freeBonus!]
      : base;

    return { ...cycle, bombermen };
  }

  /** True when every paid offer is bought and the bonus free one is available. */
  private shouldOfferFreeBonus(cycle: BombermanShopCycle): boolean {
    if (!cycle.freeBonus) return false;
    const bought = new Set(cycle.boughtTemplateIds);
    if (bought.has(cycle.freeBonus.id)) return false;
    return cycle.bombermen.length > 0 && cycle.bombermen.every(b => bought.has(b.id));
  }

  private generateCycle(playerId: string, now: number): BombermanShopCycle {
    // Seed mixes the player's id and the wall-clock start so each player
    // gets a unique roster and each cycle is fresh.
    const cycleId = `cycle_${playerId}_${now.toString(36)}`;
    const rng = createSeededRandom(hashString(cycleId));

    const bombermen: BombermanTemplate[] = [];
    for (let i = 0; i < SHOP_OFFER_COUNT; i++) {
      bombermen.push(this.rollOffer(rng, `${cycleId}_${i}`));
    }
    // Pre-roll the bonus free Bomberman now (deterministic); it's only shown
    // once all the paid offers are bought (see shouldOfferFreeBonus).
    const freeBonus = this.rollFreeBonus(rng, `${cycleId}_free`);

    return {
      cycleId,
      startedAt: now,
      endsAt: now + SHOP_CYCLE_DURATION_MS,
      bombermen,
      boughtTemplateIds: [],
      freeBonus,
    };
  }

  /**
   * Roll one offered (paid, "blue"/tier-1) Bomberman: 4 slots / stack 5 / 2 HP,
   * loadout = one offensive ×5, one escape ×2, one flare ×2, 4th slot empty.
   * Price is set purely by the escape (see ESCAPE_PRICES).
   */
  private rollOffer(rng: () => number, idPrefix: string): BombermanTemplate {
    const offensive = pick(OFFER_BOMB_POOLS.offensive, rng);
    const escape = pick(OFFER_BOMB_POOLS.escape, rng);
    const flare = pick(OFFER_BOMB_POOLS.flare, rng);

    const slots: (BombSlot | null)[] = [
      { type: offensive, count: OFFER_STATS.offensiveCount },
      { type: escape, count: OFFER_STATS.escapeCount },
      { type: flare, count: OFFER_STATS.flareCount },
      null,
    ];
    const inventory: BombInventory = { slots };

    return {
      id: `${idPrefix}_paid`,
      name: rollBombermanName('paid', rng),
      tier: 'paid', // blue visual
      price: ESCAPE_PRICES[escape] ?? 500,
      colors: rollColors(rng),
      tint: rollTint(rng),
      character: CHARACTER_VARIANTS[Math.floor(rng() * CHARACTER_VARIANTS.length)],
      maxCustomSlots: OFFER_STATS.maxCustomSlots,
      stackSize: OFFER_STATS.stackSize,
      inventory,
    };
  }

  /**
   * Roll the bonus FREE Bomberman (green "CHEAP" tier): same 4 slots / stack 5,
   * lighter loadout = one offensive ×3, one escape ×1, one flare ×1.
   */
  private rollFreeBonus(rng: () => number, idPrefix: string): BombermanTemplate {
    const offensive = pick(OFFER_BOMB_POOLS.offensive, rng);
    const escape = pick(OFFER_BOMB_POOLS.escape, rng);
    const flare = pick(OFFER_BOMB_POOLS.flare, rng);

    const slots: (BombSlot | null)[] = [
      { type: offensive, count: FREE_BONUS_STATS.offensiveCount },
      { type: escape, count: FREE_BONUS_STATS.escapeCount },
      { type: flare, count: FREE_BONUS_STATS.flareCount },
      null,
    ];

    return {
      id: `${idPrefix}_free`,
      name: rollBombermanName('free', rng),
      tier: 'free',
      price: 0,
      colors: rollColors(rng),
      tint: rollTint(rng),
      character: CHARACTER_VARIANTS[Math.floor(rng() * CHARACTER_VARIANTS.length)],
      maxCustomSlots: FREE_BONUS_STATS.maxCustomSlots,
      stackSize: FREE_BONUS_STATS.stackSize,
      inventory: { slots },
    };
  }

  /**
   * Attempt to buy `templateId` for `profile`. Returns a status describing
   * success/failure. On success mutates and persists the profile, and adds
   * the template id to `bombermanShop.boughtTemplateIds` so the bought card
   * stays gone for the rest of the cycle (the client renders only
   * `cycle.bombermen` minus those in `boughtTemplateIds`).
   */
  async buyBomberman(profile: PlayerProfile, templateId: string): Promise<BuyResult> {
    const cycle = await this.getOrGenerateCycle(profile);
    let template = cycle.bombermen.find(b => b.id === templateId);
    // The bonus free Bomberman lives outside `bombermen` and is only buyable
    // once all paid offers are bought (mirrors shouldOfferFreeBonus).
    if (!template && cycle.freeBonus?.id === templateId && this.shouldOfferFreeBonus(cycle)) {
      template = cycle.freeBonus;
    }
    if (!template) return { ok: false, reason: 'not_in_cycle' };

    if (cycle.boughtTemplateIds.includes(templateId)) {
      return { ok: false, reason: 'already_owned' };
    }

    if (profile.ownedBombermen.length >= BALANCE.player.ownedBombermenCap) {
      return { ok: false, reason: 'roster_full' };
    }

    const discountedId = hardshipDiscountTemplateId(profile, cycle);
    const priceToPay = template.id === discountedId ? 0 : template.price;
    if (profile.coins < priceToPay) {
      return { ok: false, reason: 'insufficient_coins' };
    }

    // Purchase — clone inventory so owned is independent from template
    const owned: OwnedBomberman = {
      id: `owned_${profile.id}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: template.name,
      tier: template.tier,
      colors: { ...template.colors },
      tint: template.tint,
      character: template.character,
      maxCustomSlots: template.maxCustomSlots,
      stackSize: template.stackSize,
      inventory: cloneInventory(template.inventory),
      purchasedAt: Date.now(),
      sourceTemplateId: templateId,
      sp: 0,
      lifetimeSp: 0,
      upgrades: { cap: 0, stack: 0, hp: 0 },
    };

    profile.coins -= priceToPay;
    profile.ownedBombermen.push(owned);
    cycle.boughtTemplateIds.push(templateId);

    // Auto-equip if none equipped
    if (!profile.equippedBombermanId) {
      profile.equippedBombermanId = owned.id;
    }

    await this.playerStore.save(profile);
    return { ok: true, ownedId: owned.id };
  }

  async equipBomberman(profile: PlayerProfile, ownedId: string): Promise<BuyResult> {
    if (!profile.ownedBombermen.some(b => b.id === ownedId)) {
      return { ok: false, reason: 'not_owned' };
    }
    profile.equippedBombermanId = ownedId;
    await this.playerStore.save(profile);
    return { ok: true, ownedId };
  }
}

export type BuyResult =
  | { ok: true; ownedId: string }
  | { ok: false; reason: 'not_in_cycle' | 'roster_full' | 'insufficient_coins' | 'not_owned' | 'already_owned' };

// ---- helpers ----

function hashString(s: string): number {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Seeded pick of one element from a non-empty array. */
function pick<T>(arr: readonly T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)];
}

function cloneInventory(inv: BombInventory): BombInventory {
  return {
    slots: inv.slots.map(s => (s ? { ...s } : null)),
  };
}

/**
 * If the player owns no Bombermen and can't afford the cheapest still-buyable
 * template, return that template's id (so it can be discounted to free).
 * Otherwise return null. Already-bought templates and zero-price templates
 * are ignored when picking the cheapest — if the cheapest still-buyable card
 * is already free the player is not stuck.
 */
function hardshipDiscountTemplateId(
  profile: PlayerProfile,
  cycle: BombermanShopCycle,
): string | null {
  if (profile.ownedBombermen.length > 0) return null;
  const bought = new Set(cycle.boughtTemplateIds);
  const buyable = cycle.bombermen.filter(b => !bought.has(b.id));
  if (buyable.length === 0) return null;
  const cheapest = buyable.reduce((a, b) => (b.price < a.price ? b : a));
  if (cheapest.price === 0) return null;
  if (profile.coins >= cheapest.price) return null;
  return cheapest.id;
}

