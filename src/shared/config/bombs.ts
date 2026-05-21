/**
 * Authoritative bomb catalog.
 *
 * Notation:
 *   "+ pattern x2" → plus shape with radius 2 (9 tiles: center + 2 in each axis direction)
 *   "diagonal x1"  → diagonal shape with radius 1 (5 tiles: center + 4 diagonals)
 *   "circle x4"    → Chebyshev disc of radius 4 (9x9 square)
 *
 * Every bomb deals at most 1 damage per trigger per Bomberman. Multi-bomb
 * stacking on the same turn is handled in TurnResolver.
 */

import type { BombDef, BombType } from '../types/bombs.ts';
import { BALANCE } from './balance.ts';

export const BOMB_CATALOG: Record<BombType, BombDef> = {
  rock: {
    type: 'rock',
    name: 'Rock',
    fuseTurns: 0,
    behavior: { kind: 'explode', shape: { kind: 'single' } },
    price: 0,
    description: 'Infinite fallback. Hits only the target tile.',
  },
  bomb: {
    type: 'bomb',
    name: 'Bomb',
    fuseTurns: 1,
    behavior: { kind: 'explode', shape: { kind: 'plus', radius: 4 } },
    price: 200,
    description: '+ pattern, radius 4. Explodes next turn.',
  },
  bomb_wide: {
    type: 'bomb_wide',
    name: 'Wide Bomb',
    fuseTurns: 2,
    behavior: { kind: 'explode', shape: { kind: 'circle', radius: 2, rayCast: true } },
    price: 300,
    description: '5x5 area blast (rays from centre — walls block). Takes 2 turns to explode.',
  },
  delay_tricky: {
    type: 'delay_tricky',
    name: 'Delay Tricky Bomb',
    fuseTurns: 1,
    behavior: { kind: 'explode', shape: { kind: 'diag', radius: 3 } },
    price: 200,
    description: 'Diagonal pattern, radius 3. Explodes next turn.',
  },
  contact: {
    type: 'contact',
    name: 'Contact Bomb',
    fuseTurns: 0,
    behavior: { kind: 'explode', shape: { kind: 'plus', radius: 1 } },
    price: 750,
    description: '+ pattern, radius 1. Explodes on impact.',
  },
  banana: {
    type: 'banana',
    name: 'Banana',
    fuseTurns: 1,
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
    price: 250,
    description: 'Lands, 1 turn later scatters 4 sub-bombs diagonally; each explodes next turn.',
  },
  banana_child: {
    // Children sit on the ground for a turn after the banana scatters them
    // (shake + explode pattern). fuseTurns=1 plus the resolver's same-turn
    // decrement-skip for bombs added mid-step gives: scatter T1, shake T2,
    // explode T3 — same wait-a-turn pattern as standard delay bombs.
    type: 'banana_child',
    name: 'Banana Piece',
    fuseTurns: 1,
    behavior: { kind: 'explode', shape: { kind: 'plus', radius: 1 } },
    price: 0,
    description: 'A scattered banana piece. Waits a turn, then explodes in + pattern x1.',
  },
  flare: {
    type: 'flare',
    name: 'Flare',
    fuseTurns: 0,
    behavior: { kind: 'light', shape: { kind: 'circle', radius: 4 }, durationTurns: 3 },
    price: 50,
    description: 'Lights up a 9x9 area for 3 turns. No damage. Does not break Rush.',
  },
  molotov: {
    type: 'molotov',
    name: 'Molotov',
    fuseTurns: 0,
    behavior: { kind: 'fire', shape: { kind: 'plus', radius: 1 }, durationTurns: 2 },
    price: 800,
    description: 'Sets a + pattern (radius 1) on fire for 2 turns. Damage on landing and each turn.',
  },
  ender_pearl: {
    type: 'ender_pearl',
    name: 'Ender Pearl',
    fuseTurns: 0,
    behavior: { kind: 'teleport' },
    price: 200,
    description: 'Teleports you to the landing tile. Does not break Rush.',
  },
  fart_escape: {
    type: 'fart_escape',
    name: 'Fart Escape',
    fuseTurns: 0,
    behavior: {
      kind: 'smoke',
      shape: { kind: 'circle', radius: BALANCE.bombs.fartEscapeSmokeRadius },
      durationTurns: BALANCE.bombs.fartEscapeSmokeTurns,
    },
    price: 100,
    description: 'Escape move: steps 2 tiles toward target and leaves a smoke cloud at your origin.',
  },
  motion_detector_flare: {
    type: 'motion_detector_flare',
    name: 'Motion Detector Flare',
    fuseTurns: 0,
    behavior: {
      kind: 'place_mine',
      mineKind: 'motion_detector',
      lifetimeTurns: BALANCE.bombs.motionDetectorLifetime,
      detectionRadius: BALANCE.bombs.motionDetectorRadius,
    },
    price: 25,
    description: 'Proximity mine. Fires a Flare when an enemy comes within 3 tiles + LoS.',
  },
  flash: {
    type: 'flash',
    name: 'Flash',
    fuseTurns: 1,
    behavior: {
      kind: 'stun_explode',
      // 7×7 square (circle radius 3). Two tiles narrower than Big Huge.
      shape: { kind: 'circle', radius: 3 },
      stunTurns: BALANCE.bombs.flashStunTurns,
    },
    price: 500,
    description: 'Blue 7x7 blast. Bombermen caught are Stunned for 1 turn.',
  },
  phosphorus: {
    type: 'phosphorus',
    name: 'Phosphorus',
    fuseTurns: 0,
    behavior: {
      kind: 'phosphorus_seed',
      revealShape: { kind: 'circle', radius: 5 },
      revealTurns: BALANCE.bombs.phosphorusRevealTurns,
      fireDurationTurns: BALANCE.bombs.phosphorusFireTurns,
    },
    price: 300,
    description: 'SUPER BOMB. Lights up 11x11, then scatters burning tiles next turn.',
  },
  cluster_bomb: {
    type: 'cluster_bomb',
    name: 'Cluster Bomb',
    fuseTurns: 0,
    behavior: {
      kind: 'cluster_seed',
      area: { w: BALANCE.bombs.clusterArea.w, h: BALANCE.bombs.clusterArea.h },
      mineCount: BALANCE.bombs.clusterMineCount,
    },
    price: 300,
    description: 'SUPER BOMB. Scatters 25 mines across an 11x11 area. Mines trigger on touch.',
  },
  big_huge: {
    type: 'big_huge',
    name: 'Big Huge',
    fuseTurns: 2,
    behavior: { kind: 'explode', shape: { kind: 'circle', radius: 5, rayCast: true } },
    price: 1000,
    description: 'SUPER BOMB. 11x11 circle blast (rays from centre — walls block). Takes 2 turns to explode.',
  },
  shield: {
    type: 'shield',
    name: 'Shield Bomb',
    fuseTurns: 0,
    behavior: {
      kind: 'shield_wall',
      shape: { kind: 'plus', radius: 1 },
      durationTurns: BALANCE.bombs.shieldDurationTurns,
    },
    price: 250,
    description: 'Spawns a + shield wall on impact. Blocks movement and explosions for 3 turns. Pushes anyone in the way out (no damage).',
  },
};

/** Bomb types players can buy/equip (excludes rock which is infinite/fixed). */
export const PURCHASABLE_BOMBS: BombType[] = [
  'bomb',
  'bomb_wide',
  'delay_tricky',
  'contact',
  'banana',
  'flare',
  'molotov',
  'ender_pearl',
  'fart_escape',
  'motion_detector_flare',
  'flash',
  'phosphorus',
  'cluster_bomb',
  'big_huge',
  'shield',
];

/**
 * Hardcoded phosphorus fire pattern (from the design spec).
 * Center of the grid is (0, 0); row 0 is dy=-5, row 10 is dy=+5;
 * col 0 is dx=-5, col 10 is dx=+5. 'x' = fire tile, 'o' = empty.
 * Tiles that land on walls/furniture are dropped at runtime.
 */
const PHOSPHORUS_PATTERN: ReadonlyArray<string> = [
  'oxoooxoooxo', // dy = -5
  'xxxoxxxoxxx', // dy = -4
  'oxoooxoooxo', // dy = -3
  'oooxoooxooo', // dy = -2
  'oxoooxoooxo', // dy = -1
  'xxxoxxxoxxx', // dy =  0
  'oxoooxoooxo', // dy = +1
  'oooxoooxooo', // dy = +2
  'oxoooxoooxo', // dy = +3
  'xxxoxxxoxxx', // dy = +4
  'oxoooxoooxo', // dy = +5
];

export const PHOSPHORUS_FIRE_OFFSETS: ReadonlyArray<{ dx: number; dy: number }> = (() => {
  const out: Array<{ dx: number; dy: number }> = [];
  for (let row = 0; row < PHOSPHORUS_PATTERN.length; row++) {
    const line = PHOSPHORUS_PATTERN[row];
    const dy = row - 5;
    for (let col = 0; col < line.length; col++) {
      if (line[col] === 'x') out.push({ dx: col - 5, dy });
    }
  }
  return out;
})();
