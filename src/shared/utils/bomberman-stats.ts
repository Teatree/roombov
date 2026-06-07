/**
 * Per-Bomberman derived stats. `OwnedBomberman` stores the BASE values
 * (`maxCustomSlots`, `stackSize`) plus an `upgrades` tier-count per track;
 * every consumer that cares about the *effective* stat at match start (or
 * in the Upgrade popup) goes through these helpers.
 *
 * Keeping the derivation in one place means changing the upgrade step
 * value (currently +1 per tier) is a one-line edit.
 */

import { BALANCE } from '../config/balance.ts';
import type { OwnedBomberman, BombermanUpgradeState } from '../types/bomberman.ts';

const BASE_HP = 2;

export const EMPTY_UPGRADES: BombermanUpgradeState = { cap: 0, stack: 0, hp: 0 };

/** Effective per-slot stack cap = base + stack-upgrade tiers. */
export function effectiveStackSize(bm: Pick<OwnedBomberman, 'stackSize' | 'upgrades'>): number {
  const tiers = bm.upgrades?.stack ?? 0;
  return bm.stackSize + tiers;
}

/** Effective custom-slot count (excludes the always-on Rock slot).
 *  Clamped by `BALANCE.upgrades.cap.totalSlotCap` (total incl. Rock). */
export function effectiveMaxCustomSlots(bm: Pick<OwnedBomberman, 'maxCustomSlots' | 'upgrades'>): number {
  const tiers = bm.upgrades?.cap ?? 0;
  const proposed = bm.maxCustomSlots + tiers;
  // Total slots = Rock + custom. Clamp custom so the total never exceeds the cap.
  const customCap = BALANCE.upgrades.cap.totalSlotCap - 1;
  return Math.min(proposed, customCap);
}

/** Effective max HP for this Bomberman = BASE_HP + hp-upgrade tiers,
 *  clamped at `BALANCE.upgrades.hp.cap`. */
export function effectiveMaxHp(bm: Pick<OwnedBomberman, 'upgrades'>): number {
  const tiers = bm.upgrades?.hp ?? 0;
  return Math.min(BASE_HP + tiers, BALANCE.upgrades.hp.cap);
}

/** How many upgrade tiers are still available on this Bomberman/track.
 *  Hits 0 either because we've bought all per-track tiers or because the
 *  absolute stat cap kicks in (e.g. CAP can't push total slots past 8). */
export function tiersRemaining(
  bm: Pick<OwnedBomberman, 'maxCustomSlots' | 'stackSize' | 'upgrades'>,
  track: keyof BombermanUpgradeState,
): number {
  const applied = bm.upgrades?.[track] ?? 0;
  if (track === 'cap') {
    const perTrackCap = BALANCE.upgrades.cap.maxTiers;
    const totalCustomCap = BALANCE.upgrades.cap.totalSlotCap - 1;
    const headroom = Math.max(0, totalCustomCap - bm.maxCustomSlots);
    return Math.max(0, Math.min(perTrackCap, headroom) - applied);
  }
  if (track === 'stack') {
    return Math.max(0, BALANCE.upgrades.stack.maxTiers - applied);
  }
  // hp
  const hpHeadroom = Math.max(0, BALANCE.upgrades.hp.cap - BASE_HP);
  return Math.max(0, Math.min(BALANCE.upgrades.hp.maxTiers, hpHeadroom) - applied);
}

/** Bomberman "level" shown on the info badge: 1 + the total number of upgrade
 *  tiers bought across all tracks. A freshly-bought Bomberman is level 1; each
 *  upgrade bumps it by one (max 1 + sum of per-track maxTiers). Unowned shop
 *  templates have no `upgrades`, so they read as level 1. */
export function upgradeLevel(bm: Pick<OwnedBomberman, 'upgrades'>): number {
  const u = bm.upgrades ?? EMPTY_UPGRADES;
  return 1 + (u.cap ?? 0) + (u.stack ?? 0) + (u.hp ?? 0);
}

/** True when every upgrade track is at cap. Used for the FULLY UPGRADED banner
 *  and the breadcrumb pip suppressor. */
export function isFullyUpgraded(bm: Pick<OwnedBomberman, 'maxCustomSlots' | 'stackSize' | 'upgrades'>): boolean {
  return tiersRemaining(bm, 'cap') === 0
    && tiersRemaining(bm, 'stack') === 0
    && tiersRemaining(bm, 'hp') === 0;
}
