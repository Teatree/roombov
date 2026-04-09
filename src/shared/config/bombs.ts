/**
 * Authoritative bomb catalog — all 8 bombs defined in the Bomberman brief.
 *
 * Notation from the brief:
 *   "+ pattern x2" → plus shape with radius 2 (9 tiles: center + 2 in each axis direction)
 *   "diagonal x1"  → diagonal shape with radius 1 (5 tiles: center + 4 diagonals)
 *   "circle x4"    → Chebyshev disc of radius 4 (9x9 square)
 *
 * Every bomb deals at most 1 damage per trigger per Bomberman. Multi-bomb
 * stacking on the same turn is handled in TurnResolver (brief: "if multiple
 * bombs affect the Bomberman on the same turn, he receives only 1 damage").
 */

import type { BombDef, BombType } from '../types/bombs.ts';

export const BOMB_CATALOG: Record<BombType, BombDef> = {
  rock: {
    type: 'rock',
    name: 'Rock',
    fuseTurns: 0,
    behavior: { kind: 'explode', shape: { kind: 'single' } },
    price: 0, // infinite, never bought
    description: 'Infinite fallback. Hits only the target tile.',
  },
  delay: {
    type: 'delay',
    name: 'Delay Bomb',
    fuseTurns: 1,
    behavior: { kind: 'explode', shape: { kind: 'plus', radius: 2 } },
    price: 20,
    description: '+ pattern, radius 2. Explodes next turn.',
  },
  delay_big: {
    type: 'delay_big',
    name: 'Delay Bomb Big',
    fuseTurns: 1,
    behavior: { kind: 'explode', shape: { kind: 'plus', radius: 3 } },
    price: 35,
    description: '+ pattern, radius 3. Explodes next turn.',
  },
  delay_tricky: {
    type: 'delay_tricky',
    name: 'Delay Tricky Bomb',
    fuseTurns: 1,
    behavior: { kind: 'explode', shape: { kind: 'diag', radius: 1 } },
    price: 25,
    description: 'Diagonal pattern, radius 1. Explodes next turn.',
  },
  contact: {
    type: 'contact',
    name: 'Contact Bomb',
    fuseTurns: 0,
    behavior: { kind: 'explode', shape: { kind: 'plus', radius: 1 } },
    price: 30,
    description: '+ pattern, radius 1. Explodes on impact.',
  },
  banana: {
    type: 'banana',
    name: 'Banana',
    fuseTurns: 1,
    // Turn 1: lands and sits. Turn 2: scatters 4 children diagonally.
    // Turn 3: each child explodes in + pattern x1.
    behavior: {
      kind: 'scatter',
      offsets: [
        { dx: -1, dy: -1 },
        { dx: 1, dy: -1 },
        { dx: -1, dy: 1 },
        { dx: 1, dy: 1 },
      ],
      childType: 'banana_child',
    },
    price: 45,
    description: 'Lands, waits 1 turn, scatters 4 sub-bombs diagonally; each explodes next turn.',
  },
  banana_child: {
    type: 'banana_child',
    name: 'Banana Piece',
    fuseTurns: 1,
    behavior: { kind: 'explode', shape: { kind: 'plus', radius: 1 } },
    price: 0, // internal only, not purchasable
    description: 'A scattered banana piece. Explodes in + pattern x1 after 1 turn.',
  },
  flare: {
    type: 'flare',
    name: 'Flare',
    fuseTurns: 0,
    behavior: { kind: 'light', shape: { kind: 'circle', radius: 4 }, durationTurns: 3 },
    price: 15,
    description: 'Lights up a 9x9 area for 3 turns. No damage.',
  },
  molotov: {
    type: 'molotov',
    name: 'Molotov',
    fuseTurns: 0,
    behavior: { kind: 'fire', shape: { kind: 'plus', radius: 1 }, durationTurns: 2 },
    price: 40,
    description: 'Sets a + pattern (radius 1) on fire for 2 turns. Deals damage on landing and each turn.',
  },
};

/** Bomb types players can buy/equip (excludes rock which is infinite/fixed). */
export const PURCHASABLE_BOMBS: BombType[] = [
  'delay', 'delay_big', 'delay_tricky', 'contact', 'banana', 'flare', 'molotov',
];
