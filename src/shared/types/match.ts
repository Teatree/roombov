/**
 * Match state types — the core data model for an in-progress Bomberman match.
 *
 * Types are designed so the TurnResolver can be a pure function:
 *   (state, actions) -> (next state, turn result)
 */

import type { BombermanState } from './bomberman.ts';
import type { BombInstance, BombType, FireTile, LightTile } from './bombs.ts';

export interface MatchConfig {
  id: string;
  mapId: string;
  mapName: string;
  maxPlayers: number;
}

/** A carousel entry shown in the lobby. */
export interface MatchListing {
  config: MatchConfig;
  playerCount: number;
  /** Seconds until this match auto-starts. */
  countdown: number;
}

/** Coin bag sitting on a tile (not yet collected). */
export interface CoinBag {
  id: string;
  x: number;
  y: number;
  /** Amount of coins this bag is worth when collected. */
  amount: number;
}

/** Collectible bomb sitting on a tile. */
export interface CollectibleBomb {
  id: string;
  x: number;
  y: number;
  type: BombType;
  count: number;
}

/**
 * A dropped Bomberman body. Left behind when a Bomberman dies. Walking onto
 * it picks up their coins and lets the player loot bombs from their inventory.
 */
export interface DroppedBody {
  id: string;
  x: number;
  y: number;
  ownerPlayerId: string;
  coins: number;
  bombs: { type: BombType; count: number }[];
}

export type TurnPhase = 'input' | 'transition' | 'ended';

/** Action a player chose this turn. */
export type PlayerAction =
  | { kind: 'idle' }
  | { kind: 'move'; x: number; y: number }
  | { kind: 'throw'; slotIndex: number; x: number; y: number };

/**
 * Server-authoritative match state. Distributed to clients on join and
 * after every turn transition.
 */
export interface MatchState {
  matchId: string;
  mapId: string;
  phase: TurnPhase;
  /** 1-indexed turn counter. First input phase is turn 1. */
  turnNumber: number;
  /** Unix ms when the current phase ends. Used for client-side countdown. */
  phaseEndsAt: number;
  bombermen: BombermanState[];
  coinBags: CoinBag[];
  collectibleBombs: CollectibleBomb[];
  bodies: DroppedBody[];
  bombs: BombInstance[];
  fireTiles: FireTile[];
  lightTiles: LightTile[];
  /**
   * Tiles with blood splatter left by bleeding Bombermen. Purely cosmetic.
   */
  bloodTiles: { x: number; y: number }[];
  /** Escape points from the map (copied for client rendering). */
  escapeTiles: { x: number; y: number }[];
  /** Match end data, populated once phase === 'ended'. */
  endReason?: 'all_escaped' | 'all_dead' | 'turn_limit' | 'last_standing';
  /** Ids of players who successfully escaped. */
  escapedPlayerIds?: string[];
}
