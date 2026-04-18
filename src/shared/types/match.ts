/**
 * Match state types — the core data model for an in-progress Bomberman match.
 *
 * Types are designed so the TurnResolver can be a pure function:
 *   (state, actions) -> (next state, turn result)
 */

import type { BombermanState } from './bomberman.ts';
import type {
  BombInstance, BombType, FireTile, LightTile,
  SmokeCloud, Mine, PhosphorusPending,
} from './bombs.ts';

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

/** A loot chest on the map. Contains coins (auto-collected on step) and
 *  bombs (manual loot panel pickup). Stays permanently open once any player
 *  steps on it. */
export interface Chest {
  id: string;
  tier: 1 | 2;
  x: number;
  y: number;
  /** Remaining coins — 0 after the first player steps on the tile. */
  coins: number;
  /** Remaining bombs available for looting. Entries are removed/decremented as players pick them up. */
  bombs: Array<{ type: BombType; count: number }>;
  /** Permanently true after any player steps on the chest tile. */
  opened: boolean;
}

/** A double door on the map. Opens on proximity or explosion and stays open. */
export interface DoorInstance {
  id: number;
  tiles: Array<{ x: number; y: number }>;
  orientation: 'horizontal' | 'vertical';
  opened: boolean;
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

/** Active flare on the map. Drives the lightTiles computation each turn. */
export interface ActiveFlare {
  id: string;
  /** Center tile where the flare landed. */
  x: number;
  y: number;
  /** Original Chebyshev radius (typically 4). */
  initialRadius: number;
  /** Full turns remaining (3→2→1→gone). After turn 2, radius shrinks by 1. */
  turnsRemaining: number;
  /**
   * Rendering variant: 'flare' (default white-yellow), 'phosphorus' (red),
   * 'motion_detector' (orange). Affects both the flame visual and the
   * flash/light tile rendering.
   */
  kind?: 'flare' | 'phosphorus' | 'motion_detector';
}

export type TurnPhase = 'input' | 'transition' | 'ended';

/** Action a player chose this turn. */
export type PlayerAction =
  | { kind: 'idle' }
  | { kind: 'move'; x: number; y: number; rushX?: number; rushY?: number }
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
  chests: Chest[];
  doors: DoorInstance[];
  bodies: DroppedBody[];
  bombs: BombInstance[];
  fireTiles: FireTile[];
  lightTiles: LightTile[];
  /** Active flares. Client uses these to render the flame + derive fog reveals. */
  flares: ActiveFlare[];
  /** Active smoke clouds (Fart Escape). */
  smokeClouds: SmokeCloud[];
  /** Dormant mines on the map (Motion Detector + Cluster). */
  mines: Mine[];
  /** Deferred Phosphorus fire spawns (impact turn records; next turn spawns fire tiles). */
  phosphorusPending: PhosphorusPending[];
  /**
   * Tiles with blood splatter left by bleeding Bombermen. Purely cosmetic.
   */
  bloodTiles: { x: number; y: number }[];
  /** Escape points from the map (copied for client rendering). */
  escapeTiles: { x: number; y: number }[];
  /** Match end data, populated once phase === 'ended'. */
  endReason?: 'all_escaped' | 'all_dead' | 'turn_limit';
  /** Ids of players who successfully escaped. */
  escapedPlayerIds?: string[];
}
