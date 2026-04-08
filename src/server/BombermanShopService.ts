/**
 * Bomberman Shop Service
 *
 * Maintains the current 10-minute cycle of 5 rotating Bombermen:
 *  - 2 free, 2 paid, 1 paid-expensive
 * Each Bomberman has randomized cosmetic colors and a randomized starting
 * bomb inventory rolled against per-tier weighted probabilities.
 *
 * Cycle transitions happen on demand — any caller asking for the current
 * cycle past its expiry triggers a regeneration. A server-wide 'shop_cycle'
 * broadcast fires on every regeneration so connected clients see the new
 * roster live.
 *
 * Purchase and equip logic mutates PlayerStore profiles directly.
 */

import type { BombType } from '../shared/types/bombs.ts';
import type {
  BombermanTemplate,
  BombermanTier,
  BombInventory,
  BombSlot,
  CosmeticColors,
  OwnedBomberman,
} from '../shared/types/bomberman.ts';
import type { PlayerProfile } from '../shared/types/player-profile.ts';
import {
  SHOP_CYCLE_COMPOSITION,
  SHOP_CYCLE_DURATION_MS,
  TIER_CONFIG,
} from '../shared/config/bomberman-tiers.ts';
import { BALANCE } from '../shared/config/balance.ts';
import { createSeededRandom, seededRandInt } from '../shared/utils/seeded-random.ts';
import type { PlayerStore } from './PlayerStore.ts';

export interface BombermanShopCycle {
  cycleId: string;
  endsAt: number;
  bombermen: BombermanTemplate[];
}

export class BombermanShopService {
  private playerStore: PlayerStore;
  private currentCycle: BombermanShopCycle;
  private onCycleChanged: (cycle: BombermanShopCycle) => void;

  constructor(playerStore: PlayerStore, onCycleChanged: (cycle: BombermanShopCycle) => void) {
    this.playerStore = playerStore;
    this.onCycleChanged = onCycleChanged;
    this.currentCycle = this.generateCycle();
  }

  /** Returns the current cycle, regenerating first if it has expired. */
  getCurrentCycle(): BombermanShopCycle {
    if (Date.now() >= this.currentCycle.endsAt) {
      this.currentCycle = this.generateCycle();
      this.onCycleChanged(this.currentCycle);
    }
    return this.currentCycle;
  }

  private generateCycle(): BombermanShopCycle {
    const cycleId = `cycle_${Date.now()}`;
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
      endsAt: Date.now() + SHOP_CYCLE_DURATION_MS,
      bombermen,
    };
  }

  private rollBomberman(tier: BombermanTier, rng: () => number, idPrefix: string): BombermanTemplate {
    const cfg = TIER_CONFIG[tier];

    // Colors: random hues projected to 24-bit RGB
    const colors: CosmeticColors = {
      shirt: hslToRgb(rng() * 360, 0.65, 0.55),
      pants: hslToRgb(rng() * 360, 0.55, 0.35),
      hair: hslToRgb(rng() * 360, 0.55, 0.45),
    };

    // Price: in range, rounded to nearest 5
    let price = 0;
    if (cfg.priceRange[0] !== cfg.priceRange[1]) {
      const raw = seededRandInt(rng, cfg.priceRange[0], cfg.priceRange[1] + 1);
      price = Math.round(raw / 5) * 5;
    }

    // Starting inventory: roll `totalBombs` units against weights, then pack
    // into 4 stack-limited slots.
    const weights = cfg.weights;
    let totalWeight = 0;
    for (const [, w] of Object.entries(weights) as [BombType, number][]) {
      totalWeight += w ?? 0;
    }
    if (totalWeight === 0) throw new Error(`Tier ${tier} has no bomb weights`);

    const counts: Partial<Record<BombType, number>> = {};
    for (let i = 0; i < cfg.totalBombs; i++) {
      let roll = rng() * totalWeight;
      let picked: BombType = 'contact';
      for (const [t, w] of Object.entries(weights) as [BombType, number][]) {
        if (w === undefined || w === 0) continue;
        roll -= w;
        if (roll <= 0) { picked = t; break; }
      }
      counts[picked] = (counts[picked] ?? 0) + 1;
    }

    const inventory = packInventory(counts);

    return {
      id: `${idPrefix}_${tier}`,
      tier,
      price,
      colors,
      inventory,
    };
  }

  /**
   * Attempt to buy `templateId` for `profile`. Returns a status describing
   * success/failure. On success mutates and persists the profile.
   */
  async buyBomberman(profile: PlayerProfile, templateId: string): Promise<BuyResult> {
    // Cycle must be current
    const cycle = this.getCurrentCycle();
    const template = cycle.bombermen.find(b => b.id === templateId);
    if (!template) return { ok: false, reason: 'not_in_cycle' };

    // Dedup against the exact template id — prevents buying the same
    // Bomberman twice within a shop cycle. A new cycle generates new ids,
    // so the player can buy a "similar" Bomberman again next cycle.
    if (profile.ownedBombermen.some(b => b.sourceTemplateId === templateId)) {
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
      tier: template.tier,
      colors: { ...template.colors },
      inventory: cloneInventory(template.inventory),
      purchasedAt: Date.now(),
      sourceTemplateId: templateId,
    };

    profile.coins -= template.price;
    profile.ownedBombermen.push(owned);

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
 * Pack type→count map into at most 4 stack-limited slots. If the totals
 * exceed 4 slot capacity the overflow is dropped (shouldn't happen with
 * current tier tuning since 13 / 5 = 3 slots max).
 */
function packInventory(counts: Partial<Record<BombType, number>>): BombInventory {
  const stackLimit = BALANCE.match.bombSlotStackLimit;
  const slots: (BombSlot | null)[] = [null, null, null, null];
  let slotIdx = 0;

  const types = Object.entries(counts).filter(([, c]) => c && c > 0) as [BombType, number][];
  // Sort by count descending so higher-count stacks claim slots first
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
