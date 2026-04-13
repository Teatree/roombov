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
  | 'delay'
  | 'delay_big'
  | 'delay_wide'
  | 'delay_tricky'
  | 'contact'
  | 'banana'
  | 'banana_child'
  | 'flare'
  | 'molotov'
  | 'ender_pearl';

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
  | { kind: 'teleport' };

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
}

/** An active Flare lit tile (purely visual, no damage). */
export interface LightTile {
  x: number;
  y: number;
  turnsRemaining: number;
}
