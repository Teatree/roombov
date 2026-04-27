/**
 * Persistent per-player data. Written to disk on the server
 * (`production/player-data/<playerId>.json`) and mirrored to the client after
 * every mutation via the `profile` message.
 */

import type { OwnedBomberman } from './bomberman.ts';
import type { BombType } from './bombs.ts';
import type { TreasureBundle } from '../config/treasures.ts';
import type { GamblerStreetState } from './gambler-street.ts';
import { createEmptyGamblerStreet } from './gambler-street.ts';
import { GAMBLER_STREET_GLOBAL } from '../config/gambler-street.ts';

export interface PlayerProfile {
  id: string;
  /** Unix ms when this profile was first created. */
  createdAt: number;
  /** Unix ms of last write. */
  updatedAt: number;
  /** Soft currency. */
  coins: number;
  /**
   * Persistent treasure stash. Accumulates across matches (each escaped
   * match merges its haul in). Spent at Gambler Street.
   */
  treasures: TreasureBundle;
  /**
   * Bombermen the player owns. Order is stable (roster display).
   * Max length enforced at BALANCE.player.ownedBombermenCap.
   */
  ownedBombermen: OwnedBomberman[];
  /** Currently-equipped Bomberman id, or null if none owned. */
  equippedBombermanId: string | null;
  /**
   * Stockpile of purchased bombs not yet equipped onto a Bomberman.
   * Map from bomb type → count. Used by the Bombs Shop flow.
   */
  bombStockpile: Partial<Record<BombType, number>>;
  /**
   * Gambler Street carousel state — five slots, each either an active
   * gambler or a cooldown countdown. Wall-clock timestamps so the carousel
   * keeps aging while the player is offline.
   */
  gamblerStreet: GamblerStreetState;
}

export function createEmptyProfile(id: string): PlayerProfile {
  const now = Date.now();
  return {
    id,
    createdAt: now,
    updatedAt: now,
    coins: 500,
    treasures: {},
    ownedBombermen: [],
    equippedBombermanId: null,
    bombStockpile: {},
    gamblerStreet: createEmptyGamblerStreet(now, GAMBLER_STREET_GLOBAL.slotCount),
  };
}
