/**
 * Per-Bomberman upgrade transactions. Applies SP/coin/treasure deductions
 * and bumps the OwnedBomberman's tier-count on one of three tracks
 * (cap / stack / hp). Server-authoritative — every client request goes
 * through `applyUpgrade()` which re-validates costs from `BALANCE.upgrades`.
 *
 * SP is per-Bomberman (not per-profile). Coins + treasure costs come from
 * the profile's banked stash. Treasure type per track is fixed in
 * `BALANCE.upgrades.<track>.treasure`.
 */

import type { PlayerProfile } from '../shared/types/player-profile.ts';
import type { BombermanUpgradeState } from '../shared/types/bomberman.ts';
import { BALANCE } from '../shared/config/balance.ts';
import { tiersRemaining } from '../shared/utils/bomberman-stats.ts';
import { PlayerStore } from './PlayerStore.ts';

export type UpgradeTrack = keyof BombermanUpgradeState; // 'cap' | 'stack' | 'hp'

export type UpgradeReason =
  | 'unknown_bomberman'
  | 'no_tiers_left'
  | 'insufficient_sp'
  | 'insufficient_coins'
  | 'insufficient_treasure'
  | 'misconfigured_tier';

export type UpgradeResult =
  | { ok: true; ownedId: string; track: UpgradeTrack; newTierCount: number }
  | { ok: false; reason: UpgradeReason };

/** Read the cost of the NEXT upgrade tier on `track` for an already-applied
 *  `appliedTiers` count. Returns null if the track has no tier at that index
 *  (config mismatch — should be impossible if `tiersRemaining > 0`). */
export function nextTierCost(track: UpgradeTrack, appliedTiers: number):
  | { sp: number; coins: number; treasure: number; treasureType: string }
  | null {
  const cfg = BALANCE.upgrades[track];
  const entry = cfg.tiers[appliedTiers];
  if (!entry) return null;
  return {
    sp: entry.sp,
    coins: entry.coins,
    treasure: entry.treasure,
    treasureType: cfg.treasure,
  };
}

export class BombermanUpgradeService {
  constructor(private readonly playerStore: PlayerStore) {}

  async applyUpgrade(
    profile: PlayerProfile,
    ownedId: string,
    track: UpgradeTrack,
  ): Promise<UpgradeResult> {
    const owned = profile.ownedBombermen.find(b => b.id === ownedId);
    if (!owned) return { ok: false, reason: 'unknown_bomberman' };

    if (tiersRemaining(owned, track) <= 0) {
      return { ok: false, reason: 'no_tiers_left' };
    }

    const applied = owned.upgrades[track];
    const cost = nextTierCost(track, applied);
    if (!cost) return { ok: false, reason: 'misconfigured_tier' };

    if ((owned.sp ?? 0) < cost.sp) return { ok: false, reason: 'insufficient_sp' };
    if (profile.coins < cost.coins) return { ok: false, reason: 'insufficient_coins' };
    const haveTreasure = profile.treasures[cost.treasureType as keyof typeof profile.treasures] ?? 0;
    if (haveTreasure < cost.treasure) {
      return { ok: false, reason: 'insufficient_treasure' };
    }

    owned.sp -= cost.sp;
    profile.coins -= cost.coins;
    const key = cost.treasureType as keyof typeof profile.treasures;
    const remaining = haveTreasure - cost.treasure;
    if (remaining === 0) delete profile.treasures[key];
    else profile.treasures[key] = remaining;
    owned.upgrades[track] = applied + 1;

    await this.playerStore.save(profile);

    return { ok: true, ownedId, track, newTierCount: owned.upgrades[track] };
  }
}
