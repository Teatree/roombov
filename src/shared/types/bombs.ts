/**
 * Bomb catalog types.
 *
 * Two layers:
 *  1. BombDef — static, authored data. Lives in `config/bombs.ts`. Describes
 *     what a bomb *is* (pattern, fuse, on-hit behavior, price).
 *  2. BombInstance — runtime state for a placed bomb on a map during a match.
 *     Created by TurnResolver when a player throws a bomb.
 *
 * Patterns are described declaratively so `BombResolver` can turn a (type,
 * centerTile) pair into a set of affected tiles without bespoke code per bomb.
 */

export type BombType =
  | 'rock'
  | 'bomb'             // renamed from delay_big
  | 'bomb_wide'        // renamed from delay_wide
  | 'delay_tricky'
  | 'contact'
  | 'banana'
  | 'banana_child'
  | 'flare'
  | 'molotov'
  | 'ender_pearl'
  // New bombs:
  | 'fart_escape'
  | 'motion_detector_flare'
  | 'flash'
  | 'phosphorus'
  | 'cluster_bomb'
  | 'big_huge';

/**
 * Shape primitives used by BombResolver to compute the affected tile set.
 *  - 'single': just the center tile
 *  - 'plus':   center + the four axis-aligned tiles out to `radius`
 *              (radius 1 = 5 tiles, radius 2 = 9 tiles)
 *  - 'diag':   center + the four diagonal tiles out to `radius`
 *  - 'circle': Chebyshev-distance disc (square) of the given radius
 */
export type BombShape =
  | { kind: 'single' }
  | { kind: 'plus'; radius: number }
  | { kind: 'diag'; radius: number }
  | { kind: 'circle'; radius: number };

/** What a bomb does when it "triggers" (either on impact or fuse expiry). */
export type BombBehavior =
  /** Standard explosion: deal 1 damage to every Bomberman on affected tiles. */
  | { kind: 'explode'; shape: BombShape }
  /** Drop sub-bombs at offsets. Used by the Banana. */
  | { kind: 'scatter'; offsets: Array<{ dx: number; dy: number }>; childType: BombType }
  /** Light up tiles (no damage). Used by the Flare. */
  | { kind: 'light'; shape: BombShape; durationTurns: number }
  /** Leave burning tiles that damage anything on them each turn. Used by the Molotov. */
  | { kind: 'fire'; shape: BombShape; durationTurns: number }
  /** Teleport the thrower to the landing tile. Used by Ender Pearl. */
  | { kind: 'teleport' }
  /**
   * Plus-radius explode + apply Stunned status to every hit Bomberman for
   * `stunTurns` turns. Used by Flash.
   */
  | { kind: 'stun_explode'; shape: BombShape; stunTurns: number }
  /**
   * Impact-turn reveal (red flare-style light) + deferred fire spawn next
   * turn using a hardcoded offset list. Used by Phosphorus.
   */
  | { kind: 'phosphorus_seed'; revealShape: BombShape; revealTurns: number; fireDurationTurns: number }
  /**
   * Seed mines across a w×h area. Used by Cluster Bomb.
   */
  | { kind: 'cluster_seed'; area: { w: number; h: number }; mineCount: number }
  /**
   * Deploy a smoke cloud at the origin. Used by Fart Escape.
   * Shape is always 'circle' for the smoke footprint.
   */
  | { kind: 'smoke'; shape: BombShape; durationTurns: number }
  /**
   * Arm a motion-detector mine in place. Used by Motion Detector Flare.
   */
  | { kind: 'place_mine'; mineKind: MineKind; lifetimeTurns: number; detectionRadius: number };

/** Distinct mine kinds — render differently and trigger with different rules. */
export type MineKind = 'motion_detector' | 'cluster';

export interface BombDef {
  type: BombType;
  name: string;
  /**
   * Turns between placement and trigger.
   *  - 0 = contact/impact (triggers on the same turn as the throw)
   *  - 1 = standard delay (triggers on the next turn)
   */
  fuseTurns: number;
  behavior: BombBehavior;
  /** Price in coins when buying from the Bombs Shop. */
  price: number;
  /** Short flavour/help text shown in the shop. */
  description: string;
}

/** Runtime state for a bomb that has been thrown onto the map. */
export interface BombInstance {
  id: string;
  type: BombType;
  ownerId: string;
  x: number;
  y: number;
  /** Turns remaining until trigger. 0 = trigger at end of the current turn. */
  fuseRemaining: number;
}

/** An active Molotov fire tile. */
export interface FireTile {
  x: number;
  y: number;
  turnsRemaining: number;
  ownerId: string;
  /**
   * Optional kind — changes client rendering (e.g. whiter phosphorus flames).
   * Defaults to 'molotov' when absent.
   */
  kind?: 'molotov' | 'phosphorus';
}

/** An active Flare lit tile (purely visual, no damage). */
export interface LightTile {
  x: number;
  y: number;
  turnsRemaining: number;
  /** Optional kind for color variants (e.g. phosphorus red, motion detector orange). */
  kind?: 'flare' | 'phosphorus' | 'motion_detector';
}

/** A persistent smoke cloud deployed by Fart Escape. */
export interface SmokeCloud {
  id: string;
  ownerId: string;
  /** Center tile. */
  x: number;
  y: number;
  /** Tiles the smoke occupies. Computed at spawn; stored for cheap lookups. */
  tiles: Array<{ x: number; y: number }>;
  /** Turns remaining before cloud dissipates. */
  turnsRemaining: number;
  /** Original radius, for rendering. */
  radius: number;
}

/** A dormant mine placed on a tile. */
export interface Mine {
  id: string;
  kind: MineKind;
  ownerId: string;
  x: number;
  y: number;
  /** Turns remaining until automatic trigger (passive expiry). */
  lifetimeRemaining: number;
  /** For motion_detector: Chebyshev detection radius. */
  detectionRadius?: number;
  /**
   * When set, the mine is "primed" and will trigger after this many turns
   * (counted down each turn). Cluster mines set this to 1 when another
   * explosion hits them so they shake for a turn before chaining.
   */
  primedCountdown?: number;
}

/** Deferred fire spawn — phosphorus seeds these on impact to spawn next turn. */
export interface PhosphorusPending {
  id: string;
  ownerId: string;
  originX: number;
  originY: number;
  fireDurationTurns: number;
}

/** A status effect active on a bomberman. */
export type StatusEffect =
  | { kind: 'stunned'; turnsRemaining: number; sourceId?: string };
