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

    // Colors: random hues projected to 24-bit RGB (used by shop cards)
    const colors: CosmeticColors = {
      shirt: hslToRgb(rng() * 360, 0.65, 0.55),
      pants: hslToRgb(rng() * 360, 0.55, 0.35),
      hair: hslToRgb(rng() * 360, 0.55, 0.45),
    };

    // Tint: lighter-leaning palette so the sprites pop against the dark
    // dungeon floor. High saturation (0.55–0.85) + high lightness (0.62–0.8)
    // produces vivid pastels — no grays, no muddy darks.
    const tintHue = rng() * 360;
    const tintSat = 0.55 + rng() * 0.3;
    const tintLight = 0.62 + rng() * 0.18;
    const tint = hslToRgb(tintHue, tintSat, tintLight);

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

    // Derived price — Free tier is the player's onboarding option and is
    // pinned at 0 even though the formula would otherwise charge for bombs.
    const price = tier === 'free'
      ? 0
      : computeBombermanPrice(maxCustomSlots, stackSize, inventory);

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

    if (profile.coins < template.price) {
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
    };

    profile.coins -= template.price;
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
 * Bomberman shop price = slot premium + stack premium + 30 % of total bomb
 * shop value, rounded to the nearest 5 coins.
 *
 * `maxCustomSlots` does NOT include Rock; the "Slots" baseline of 5 in the
 * pricing config is the user-facing total (custom + Rock). So a Bomberman
 * with 4 custom slots = 5 total = 0 extra slot premium; 5 custom = 6 total =
 * 1 extra (50c); 6 custom = 7 total = 2 extra (100c).
 *
 * Free tier is special-cased outside this helper (always 0). Callers should
 * skip this for the Free tier.
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

  const raw = slotCost + stackCost + bombCost;
  const step = Math.max(1, BOMBERMAN_PRICING.roundToNearest);
  return Math.round(raw / step) * step;
}

function cloneInventory(inv: BombInventory): BombInventory {
  return {
    slots: inv.slots.map(s => (s ? { ...s } : null)),
  };
}

/** HSL → 0xRRGGBB. h in [0,360), s/l in [0,1]. */
function hslToRgb(h: number, s: number, l: number): number {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; }
  else { r = c; b = x; }
  const m = l - c / 2;
  const R = Math.round((r + m) * 255);
  const G = Math.round((g + m) * 255);
  const B = Math.round((b + m) * 255);
  return (R << 16) | (G << 8) | B;
}
