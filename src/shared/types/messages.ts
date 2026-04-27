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
import type { TreasureBundle } from '../config/treasures.ts';
import type { BetOutcome, GamblerStreetState } from './gambler-street.ts';
import type { BetTier } from '../config/gambler-street.ts';

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
  endReason: 'all_escaped' | 'all_dead' | 'turn_limit';
  escapedPlayerIds: string[];
  /** Per-player treasures earned this match (keyed by playerId). */
  treasuresEarned: Record<string, TreasureBundle>;
}

// --- Loot (real-time during match, not turn-gated) ---

/**
 * Client → server: pick up a bomb from a collectible or body on the player's
 * current tile. Server validates proximity and slot logic, then broadcasts
 * an updated match_state if the loot succeeds.
 *
 * `targetSlotIndex` uses the same convention as bomb throws:
 *   1..INVENTORY_SLOT_COUNT → inventory.slots[0..N-1]
 *   (slot 0 = Rock is never a valid target)
 *
 * If `targetSlotIndex` already contains a different bomb type, the existing
 * stack is swapped back to the source (per the brief).
 */
export interface LootBombMsg {
  /** 'chest' for chest pickups, 'body' for corpse loot. */
  sourceKind: 'chest' | 'body';
  /** Id of the Chest or DroppedBody. */
  sourceId: string;
  /** The bomb type the player wants to take. */
  bombType: BombType;
  /** Which inventory slot to put it in (1..4). */
  targetSlotIndex: number;
}

/** Server → client result of a shop action. Usable for user-facing toast. */
export interface ShopResultMsg {
  ok: boolean;
  action: 'buy_bomberman' | 'equip_bomberman' | 'buy_bomb' | 'equip_bomb';
  reason?: string;
  message?: string;
}

// --- Gambler Street ---

/** Client → server: refresh the carousel (tick state to now, return current). */
export type GamblerStreetRequestMsg = Record<string, never>;

/** Client → server: place a bet on a specific gambler slot. */
export interface GamblerStreetBetMsg {
  slotIndex: number;
  tier: BetTier;
  pickedHand: 'left' | 'right';
}

/** Server → client: latest carousel state (after a tick). */
export interface GamblerStreetStateMsg {
  state: GamblerStreetState;
}

/** Server → client: result of a bet attempt. */
export interface GamblerStreetBetResultMsg {
  ok: boolean;
  /** Present on success — drives the reveal animation. */
  outcome?: BetOutcome;
  /** Present on success — updated street state. */
  state?: GamblerStreetState;
  /** Present on failure — reason string. */
  reason?: string;
}

// --- Server → client event map ---

/** Server → client: one of your placed mines just tripped. */
export interface MineTriggeredMsg {
  mineId: string;
  x: number;
  y: number;
}

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
  mine_triggered: (msg: MineTriggeredMsg) => void;
  gambler_street_state: (msg: GamblerStreetStateMsg) => void;
  gambler_street_bet_result: (msg: GamblerStreetBetResultMsg) => void;
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
  loot_bomb: (msg: LootBombMsg) => void;
  gambler_street_request: (msg: GamblerStreetRequestMsg) => void;
  gambler_street_bet: (msg: GamblerStreetBetMsg) => void;
}
