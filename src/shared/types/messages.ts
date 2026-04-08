/**
 * Socket.io message contract between client and server.
 *
 * Single source of truth for networked events. Steps add sections as they
 * land — keep in sync with NetworkManager and GameServer.
 */

import type { PlayerProfile } from './player-profile.ts';
import type { BombermanTemplate } from './bomberman.ts';
import type { BombType } from './bombs.ts';
import type { MatchListing, MatchState, PlayerAction } from './match.ts';
import type { TurnEvent } from '../systems/TurnResolver.ts';

// --- Auth / profile (Step 2) ---

export interface AuthMsg {
  playerId: string;
}

export interface ProfileMsg {
  profile: PlayerProfile;
}

/** Dev-only: wipe profile back to an empty starter state. */
export interface DebugResetMsg {
  confirm: true;
}

// --- Bomberman shop (Step 4) ---

export interface BombermanShopCycleMsg {
  cycleId: string;
  endsAt: number;
  bombermen: BombermanTemplate[];
}

export interface BuyBombermanMsg {
  templateId: string;
}

export interface EquipBombermanMsg {
  ownedId: string;
}

// --- Bombs shop (Step 5) ---

export interface BombsCatalogEntry {
  type: BombType;
  name: string;
  price: number;
  description: string;
}

export interface BombsCatalogMsg {
  catalog: BombsCatalogEntry[];
}

export interface BuyBombMsg {
  type: BombType;
  quantity: number;
}

export interface EquipBombMsg {
  type: BombType;
  slotIndex: number;
  quantity: number;
}

export interface UnequipBombMsg {
  slotIndex: number;
}

// --- Lobby + match (Step 7/8) ---

export interface MatchListingsMsg {
  listings: MatchListing[];
}

export interface JoinMatchMsg {
  matchId: string;
}

export interface JoinedMatchMsg {
  matchId: string;
}

export interface MatchStartMsg {
  matchId: string;
}

export interface MatchStateMsg {
  state: MatchState;
}

export interface PlayerActionMsg {
  action: PlayerAction;
}

export interface TurnResultMsg {
  events: TurnEvent[];
}

export interface MatchEndMsg {
  endReason: 'all_escaped' | 'all_dead' | 'turn_limit' | 'last_standing';
  escapedPlayerIds: string[];
  coinsEarned: Record<string, number>;
}

/** Server → client result of a shop action. Usable for user-facing toast. */
export interface ShopResultMsg {
  ok: boolean;
  action: 'buy_bomberman' | 'equip_bomberman' | 'buy_bomb' | 'equip_bomb';
  reason?: string;
  message?: string;
}

// --- Server → client event map ---

export interface ServerToClientEvents {
  profile: (msg: ProfileMsg) => void;
  bomberman_shop_cycle: (msg: BombermanShopCycleMsg) => void;
  bombs_catalog: (msg: BombsCatalogMsg) => void;
  shop_result: (msg: ShopResultMsg) => void;
  match_listings: (msg: MatchListingsMsg) => void;
  joined_match: (msg: JoinedMatchMsg) => void;
  match_start: (msg: MatchStartMsg) => void;
  match_state: (msg: MatchStateMsg) => void;
  turn_result: (msg: TurnResultMsg) => void;
  match_end: (msg: MatchEndMsg) => void;
}

// --- Client → server event map ---

export interface ClientToServerEvents {
  auth: (msg: AuthMsg) => void;
  debug_reset: (msg: DebugResetMsg) => void;
  bomberman_shop_request: () => void;
  buy_bomberman: (msg: BuyBombermanMsg) => void;
  equip_bomberman: (msg: EquipBombermanMsg) => void;
  bombs_shop_request: () => void;
  buy_bomb: (msg: BuyBombMsg) => void;
  equip_bomb: (msg: EquipBombMsg) => void;
  unequip_bomb: (msg: UnequipBombMsg) => void;
  match_listings_request: () => void;
  join_match: (msg: JoinMatchMsg) => void;
  leave_match: () => void;
  player_action: (msg: PlayerActionMsg) => void;
}
