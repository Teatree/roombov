/**
 * Bombs Shop Service
 *
 * Unlike the Bomberman shop this is a flat, always-available catalog —
 * players buy individual bombs at fixed prices and they accumulate in a
 * stockpile on the profile. A second flow lets the player equip bombs from
 * the stockpile into their equipped Bomberman's 4 custom slots.
 *
 * Slot rules (from the brief):
 *  - Stacks up to BALANCE.match.bombSlotStackLimit (5) per slot.
 *  - Clicking an empty slot fills it with the chosen bomb from stockpile.
 *  - Clicking an already-filled slot with the same bomb tops it up.
 *  - Clicking a different bomb replaces the slot (old contents return to stockpile).
 */

import type { BombType } from '../shared/types/bombs.ts';
import type { PlayerProfile } from '../shared/types/player-profile.ts';
import type { OwnedBomberman } from '../shared/types/bomberman.ts';
import { BOMB_CATALOG, PURCHASABLE_BOMBS } from '../shared/config/bombs.ts';
import { BALANCE } from '../shared/config/balance.ts';
import type { PlayerStore } from './PlayerStore.ts';

export type BombsShopResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'not_purchasable'
        | 'insufficient_coins'
        | 'no_equipped_bomberman'
        | 'slot_out_of_range'
        | 'not_in_stockpile'
        | 'invalid_bomberman';
    };

export class BombsShopService {
  private playerStore: PlayerStore;

  constructor(playerStore: PlayerStore) {
    this.playerStore = playerStore;
  }

  /** Returns the static purchasable catalog (server authoritative prices). */
  getCatalog(): { type: BombType; name: string; price: number; description: string }[] {
    return PURCHASABLE_BOMBS.map((type) => {
      const def = BOMB_CATALOG[type];
      return { type, name: def.name, price: def.price, description: def.description };
    });
  }

  async buyBomb(profile: PlayerProfile, type: BombType, quantity: number): Promise<BombsShopResult> {
    if (!PURCHASABLE_BOMBS.includes(type)) return { ok: false, reason: 'not_purchasable' };
    const qty = Math.max(1, Math.floor(quantity));
    const def = BOMB_CATALOG[type];
    const total = def.price * qty;
    if (profile.coins < total) return { ok: false, reason: 'insufficient_coins' };

    profile.coins -= total;
    profile.bombStockpile[type] = (profile.bombStockpile[type] ?? 0) + qty;
    await this.playerStore.save(profile);
    return { ok: true };
  }

  /**
   * Equip from stockpile → an equipped-Bomberman slot.
   *
   * Semantics match the brief's interaction rules:
   *  - Empty slot: fills slot with `qty` of `type` (capped at stack limit).
   *    The taken amount is removed from the stockpile.
   *  - Same-type slot: adds up to stack limit (or as much of `qty` fits).
   *  - Different type slot: swaps — old contents go back to stockpile, new
   *    contents fill the slot up to stack limit.
   *
   * The caller specifies a quantity (typically just the requested amount from
   * the UI; the server clamps to what is available and what fits).
   */
  async equipToSlot(
    profile: PlayerProfile,
    type: BombType,
    slotIndex: number,
    requestedQty: number,
  ): Promise<BombsShopResult> {
    if (!PURCHASABLE_BOMBS.includes(type)) return { ok: false, reason: 'not_purchasable' };
    if (slotIndex < 0 || slotIndex > 3) return { ok: false, reason: 'slot_out_of_range' };
    if (!profile.equippedBombermanId) return { ok: false, reason: 'no_equipped_bomberman' };

    const bomberman = this.getEquipped(profile);
    if (!bomberman) return { ok: false, reason: 'invalid_bomberman' };

    const stackLimit = BALANCE.match.bombSlotStackLimit;
    const stockpiled = profile.bombStockpile[type] ?? 0;
    if (stockpiled <= 0) return { ok: false, reason: 'not_in_stockpile' };

    const slot = bomberman.inventory.slots[slotIndex];

    if (!slot) {
      // Fill empty slot
      const take = Math.min(stockpiled, Math.max(1, requestedQty), stackLimit);
      bomberman.inventory.slots[slotIndex] = { type, count: take };
      profile.bombStockpile[type] = stockpiled - take;
    } else if (slot.type === type) {
      // Top-up same-type
      const room = stackLimit - slot.count;
      if (room <= 0) return { ok: true }; // nothing to do, still success
      const take = Math.min(stockpiled, Math.max(1, requestedQty), room);
      slot.count += take;
      profile.bombStockpile[type] = stockpiled - take;
    } else {
      // Swap — return old to stockpile, fill with new
      profile.bombStockpile[slot.type] = (profile.bombStockpile[slot.type] ?? 0) + slot.count;
      const take = Math.min(stockpiled, Math.max(1, requestedQty), stackLimit);
      bomberman.inventory.slots[slotIndex] = { type, count: take };
      profile.bombStockpile[type] = stockpiled - take;
    }

    cleanupStockpile(profile);
    await this.playerStore.save(profile);
    return { ok: true };
  }

  /**
   * Remove a bomb slot back into the stockpile. Used for unequip.
   */
  async unequipSlot(profile: PlayerProfile, slotIndex: number): Promise<BombsShopResult> {
    if (slotIndex < 0 || slotIndex > 3) return { ok: false, reason: 'slot_out_of_range' };
    const bomberman = this.getEquipped(profile);
    if (!bomberman) return { ok: false, reason: 'no_equipped_bomberman' };

    const slot = bomberman.inventory.slots[slotIndex];
    if (!slot) return { ok: true };

    profile.bombStockpile[slot.type] = (profile.bombStockpile[slot.type] ?? 0) + slot.count;
    bomberman.inventory.slots[slotIndex] = null;
    await this.playerStore.save(profile);
    return { ok: true };
  }

  private getEquipped(profile: PlayerProfile): OwnedBomberman | null {
    if (!profile.equippedBombermanId) return null;
    return profile.ownedBombermen.find(b => b.id === profile.equippedBombermanId) ?? null;
  }
}

function cleanupStockpile(profile: PlayerProfile): void {
  for (const key of Object.keys(profile.bombStockpile) as BombType[]) {
    if ((profile.bombStockpile[key] ?? 0) <= 0) {
      delete profile.bombStockpile[key];
    }
  }
}
