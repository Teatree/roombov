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

import type { BombType } from '../shared/types/bombs.ts';
import { rollBombermanName } from '../shared/config/bomberman-names.ts';
import type {
  BombermanShopCycle,
  BombermanTemplate,
  BombermanTier,
  BombInventory,
  BombSlot,
  CharacterVariant,
  CosmeticColors,
  OwnedBomberman,
} from '../shared/types/bomberman.ts';
import { CHARACTER_VARIANTS } from '../shared/types/bomberman.ts';
import type { PlayerProfile } from '../shared/types/player-profile.ts';
import {
  SHOP_CYCLE_COMPOSITION,
  SHOP_CYCLE_DURATION_MS,
  TIER_CONFIG,
  BOMBERMAN_PRICING,
} from '../shared/config/bomberman-tiers.ts';
import { BOMB_CATALOG } from '../shared/config/bombs.ts';
import { BALANCE } from '../shared/config/balance.ts';
import { createSeededRandom, seededRandInt } from '../shared/utils/seeded-random.ts';
import { rollBombLoot } from '../shared/utils/loot-roll.ts';
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
    const discountedId = hardshipDiscountTemplateId(profile, cycle);
    if (!discountedId) return cycle;
    return {
      ...cycle,
      bombermen: cycle.bombermen.map(b => (b.id === discountedId ? { ...b, price: 0 } : b)),
    };
  }

  private generateCycle(playerId: string, now: number): BombermanShopCycle {
    // Seed mixes the player's id and the wall-clock start so each player
    // gets a unique roster and each cycle is fresh.
    const cycleId = `cycle_${playerId}_${now.toString(36)}`;
    const seed = hashString(cycleId);
    const rng = createSeededRandom(seed);

    const bombermen: BombermanTemplate[] = [];
    for (const entry of SHOP_CYCLE_COMPOSITION) {
      for (let i = 0; i < entry.count; i++) {
        bombermen.push(this.rollBomberman(entry.tier, rng, `${cycleId}_${bombermen.length}`));
      }
    }

    return {
      cycleId,
      startedAt: now,
      endsAt: now + SHOP_CYCLE_DURATION_MS,
      bombermen,
      boughtTemplateIds: [],
    };
  }

  private rollBomberman(tier: BombermanTier, rng: () => number, idPrefix: string): BombermanTemplate {
    const cfg = TIER_CONFIG[tier];

    // Colors (shop cards) + tint (in-match sprite) share one palette source
    // in src/shared/utils/cosmetic-color.ts so scavs use the same recipe.
    const colors: CosmeticColors = rollColors(rng);
    const tint = rollTint(rng);

    // Tier-driven stats: customSlots is fixed per tier; stackSize is rolled
    // uniformly inside the tier's range so two Bombermen of the same tier
    // can have visibly different ceilings.
    const maxCustomSlots = cfg.customSlots;
    const [stackMin, stackMax] = cfg.stackSizeRange;
    const stackSize = seededRandInt(rng, stackMin, stackMax + 1);

    // Starting inventory: pick unique bomb types weighted, then distribute
    // totalBombs proportionally to those weights (largest-remainder rule).
    // Same algorithm as chests — see utils/loot-roll.ts.
    const rolled = rollBombLoot(cfg.weights, cfg.totalBombs, cfg.maxUniqueSlots, rng);
    if (rolled.length === 0) throw new Error(`Tier ${tier} produced empty inventory`);
    const counts: Partial<Record<BombType, number>> = {};
    for (const r of rolled) counts[r.type] = r.count;

    const inventory = packInventory(counts, maxCustomSlots, stackSize);

    // Derived price — every tier (including free) runs through the same
    // pricing formula post-NEW_META §6. Free-tier Bombermen now cost
    // ~50–120 coins driven by their stack roll + bomb inventory.
    const price = computeBombermanPrice(maxCustomSlots, stackSize, inventory);

    const name = rollBombermanName(tier, rng);

    // Sprite-sheet variant — same random lifecycle as tint.
    const character: CharacterVariant = CHARACTER_VARIANTS[Math.floor(rng() * CHARACTER_VARIANTS.length)];

    return {
      id: `${idPrefix}_${tier}`,
      name,
      tier,
      price,
      colors,
      tint,
      character,
      maxCustomSlots,
      stackSize,
      inventory,
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
    const template = cycle.bombermen.find(b => b.id === templateId);
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

/**
 * Pack type→count map into the Bomberman's custom slot count, respecting
 * its per-slot stack size. If totals exceed slotCount × stackSize the
 * overflow is dropped (shouldn't happen with current tier tuning, which
 * always sizes totalBombs comfortably under that ceiling).
 */
function packInventory(
  counts: Partial<Record<BombType, number>>,
  slotCount: number,
  stackLimit: number,
): BombInventory {
  const slots: (BombSlot | null)[] = new Array(slotCount).fill(null);
  let slotIdx = 0;

  const types = Object.entries(counts).filter(([, c]) => c && c > 0) as [BombType, number][];
  types.sort((a, b) => b[1] - a[1]);

  for (const [type, count] of types) {
    let remaining = count;
    while (remaining > 0 && slotIdx < slots.length) {
      const take = Math.min(remaining, stackLimit);
      slots[slotIdx] = { type, count: take };
      slotIdx++;
      remaining -= take;
    }
  }

  return { slots };
}

/**
 * Bomberman shop price = slot premium + stack premium + `bombCostRatio` ×
 * total bomb-shop value, rounded to the nearest 5 coins. Post 2026-05-24 the
 * ratio is 1.0, so the bomb component is 100 % of the loadout's coin value.
 *
 * `maxCustomSlots` does NOT include Rock; the "Slots" baseline of 5 in the
 * pricing config is the user-facing total (custom + Rock). So a Bomberman
 * with 4 custom slots = 5 total = 0 extra slot premium; 5 custom = 6 total =
 * 1 extra (50c); 6 custom = 7 total = 2 extra (100c).
 *
 * Post NEW_META §6: free tier runs through this helper too (no special case).
 * Output is clamped to BOMBERMAN_PRICING.minPrice so even the cheapest rolls
 * are never sold for less than the configured floor.
 */
function computeBombermanPrice(
  maxCustomSlots: number,
  stackSize: number,
  inventory: BombInventory,
): number {
  const totalSlots = maxCustomSlots + 1; // +1 for Rock
  const slotExtras = Math.max(0, totalSlots - BOMBERMAN_PRICING.slotThreshold);
  const stackExtras = Math.max(0, stackSize - BOMBERMAN_PRICING.stackThreshold);

  const slotCost = slotExtras * BOMBERMAN_PRICING.coinPerExtraSlot;
  const stackCost = stackExtras * BOMBERMAN_PRICING.coinPerExtraStack;

  let bombValue = 0;
  for (const slot of inventory.slots) {
    if (!slot) continue;
    bombValue += slot.count * BOMB_CATALOG[slot.type].price;
  }
  const bombCost = bombValue * BOMBERMAN_PRICING.bombCostRatio;

  const multiplier = BOMBERMAN_PRICING.priceMultiplier;
  const raw = (slotCost + stackCost + bombCost) * multiplier;
  const step = Math.max(1, BOMBERMAN_PRICING.roundToNearest);
  const rounded = Math.round(raw / step) * step;
  return Math.max(BOMBERMAN_PRICING.minPrice * multiplier, rounded);
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

