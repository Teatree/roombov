/**
 * Bomberman types.
 *
 * A "Bomberman" is a purchased character skin + starting bomb inventory. In
 * shop listings it is a BombermanTemplate (the authored/generated data). Once
 * bought, the player owns an OwnedBomberman which they can equip.
 *
 * During a match the equipped Bomberman is projected into a BombermanState
 * (position, hp, live inventory) by the match room.
 */

import type { BombType, StatusEffect } from './bombs.ts';
import type { TreasureBundle } from '../config/treasures.ts';

/** Tier drives price range + starting bomb count + rarity of premium bombs. */
export type BombermanTier = 'free' | 'paid' | 'paid_expensive';

/**
 * Sprite-sheet variant a Bomberman is rendered with. Each character has its
 * own set of per-direction animation frames under
 * `public/sprites/char{N}_*.png`. Picked randomly per Bomberman at roll
 * time and preserved for the lifetime of the owned Bomberman — same as tint.
 */
export type CharacterVariant =
  | 'char1' | 'char2' | 'char3' | 'char4' | 'char5' | 'char6' | 'char7';

export const CHARACTER_VARIANTS: readonly CharacterVariant[] = [
  'char1', 'char2', 'char3', 'char4', 'char5', 'char6', 'char7',
];

/** Cosmetic random palette generated per Bomberman in the shop cycle. */
export interface CosmeticColors {
  /** RGB hex numbers — Phaser uses 24-bit ints, not strings. */
  shirt: number;
  pants: number;
  hair: number;
}

/**
 * Bomb loadout inventory — up to 4 custom slots plus the fixed infinite Rock.
 *
 * A slot is `null` when empty. Each slot carries a BombType + a count,
 * stacking up to the per-slot limit from BALANCE.match.bombSlotStackLimit.
 */
export interface BombSlot {
  type: BombType;
  count: number;
}

/** Number of custom inventory slots a Bomberman carries (HUD shows this + 1
 *  fixed Rock slot at index 0). Bump this constant to change carry capacity
 *  everywhere — server inventory init, packing, loot panel, HUD, and tutorial
 *  validators all read from it. */
export const INVENTORY_SLOT_COUNT = 5;

export interface BombInventory {
  /** Custom slots (empty = null). Length always equals INVENTORY_SLOT_COUNT. */
  slots: (BombSlot | null)[];
}

export function emptyInventory(): BombInventory {
  return { slots: new Array(INVENTORY_SLOT_COUNT).fill(null) };
}

/**
 * A Bomberman as offered in the shop carousel. Not owned yet.
 * `price` is 0 for the free tier.
 */
export interface BombermanTemplate {
  /** Unique within the current shop cycle. */
  id: string;
  name: string;
  tier: BombermanTier;
  price: number;
  colors: CosmeticColors;
  /**
   * Single 24-bit RGB used by the in-match animated sprite via Sprite.setTint.
   * Generated as a vivid non-gray color so the character stands out on the
   * gray dungeon map. Shop cards still use `colors` for procedural drawing.
   */
  tint: number;
  /** Sprite-sheet variant — randomized from CHARACTER_VARIANTS at roll time. */
  character: CharacterVariant;
  /** Starting bomb inventory generated at cycle time from tier weights. */
  inventory: BombInventory;
}

/** A Bomberman the player owns. Same shape as template + purchase metadata. */
export interface OwnedBomberman {
  id: string;
  name: string;
  tier: BombermanTier;
  colors: CosmeticColors;
  tint: number;
  /** Sprite-sheet variant inherited from the source template. Stable for the
   *  life of this owned Bomberman. */
  character: CharacterVariant;
  /** Live inventory — mutated by the Bombs Shop equip flow. */
  inventory: BombInventory;
  /** Unix ms when the player bought this Bomberman. */
  purchasedAt: number;
  /**
   * The shop-template id this Bomberman was purchased from. Used to prevent
   * buying the same template twice within a single shop cycle.
   */
  sourceTemplateId: string;
}

/** Runtime Bomberman state inside an active match. */
export interface BombermanState {
  /** Socket / player id this Bomberman is controlled by. */
  playerId: string;
  /** The OwnedBomberman id at the time of match start. */
  bombermanId: string;
  colors: CosmeticColors;
  tint: number;
  /** Sprite-sheet variant copied from the equipped OwnedBomberman. */
  character: CharacterVariant;
  /** Tile coordinates. */
  x: number;
  y: number;
  hp: number;
  alive: boolean;
  /** Treasures picked up during this match (dropped on death, kept on escape). */
  treasures: TreasureBundle;
  /** Live bomb inventory (mutates as bombs are thrown / looted). */
  inventory: BombInventory;
  /** Turns remaining bleeding (0 = not bleeding). */
  bleedingTurns: number;
  /** True once the Bomberman has stepped onto an escape tile at turn transition. */
  escaped: boolean;
  /** Consecutive peaceful turns (no enemy nearby, no attacks). Resets on combat. */
  rushCooldown: number;
  /** True when Out of Combat Rush is active (2 tiles/turn movement). */
  rushActive: boolean;
  /**
   * Set for one turn when an Ender Pearl teleport lands this bomberman on a
   * new tile. Blocks the escape-tile check so teleporting onto an escape
   * hatch does NOT extract on the same turn — the player must still be on
   * the hatch at the start of the following turn to escape.
   */
  teleportedThisTurn: boolean;
  /**
   * Count of consecutive turns the bomberman has ended on an escape hatch
   * tile with `idle` as their chosen action (no move, no throw). Escape
   * fires when this reaches 1 — i.e. one full idle turn on the hatch.
   * Resets to 0 whenever the bomberman moves, throws, or steps off.
   */
  onHatchIdleTurns: number;
  /** Active status effects (Stunned from Flash, etc.). Empty by default. */
  statusEffects: StatusEffect[];
  /**
   * Melee Trap Mode — when active, the bomberman crouches in place and
   * will counter-attack any bomberman who walks into Chebyshev-1 range.
   * Entered by skipping a turn (idle). Exited by moving or throwing.
   * Taking damage does NOT exit this mode.
   */
  meleeTrapMode: boolean;
  /**
   * Queued movement waypoints set by Fart Escape. If the player submits no
   * new move next turn, the server consumes one waypoint; if they submit a
   * new move target this is cleared. Optional/undefined when no queue.
   */
  queuedPath?: Array<{ x: number; y: number }>;
}
