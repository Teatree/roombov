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
    description: 'A tursy rock. There is always one to throw.',
    category: 'standard',
  },
  bomb: {
    type: 'bomb',
    name: 'Bomb',
    fuseTurns: 1,
    behavior: { kind: 'explode', shape: { kind: 'plus', radius: 4 } },
    price: 25,
    description: 'Simple + pattern blast, radius 4. Detonates next turn.',
    category: 'tactical',
  },
  bomb_wide: {
    type: 'bomb_wide',
    name: 'Wide Bomb',
    fuseTurns: 2,
    behavior: { kind: 'explode', shape: { kind: 'circle', radius: 2, rayCast: true } },
    price: 40,
    description: 'Wide 5x5 blast. Detonates after 2 turns.',
    category: 'tactical',
  },
  delay_tricky: {
    type: 'delay_tricky',
    name: 'Delay Tricky Bomb',
    fuseTurns: 1,
    behavior: { kind: 'explode', shape: { kind: 'diag', radius: 3 } },
    price: 25,
    description: 'Diagonal x pattern blast, radius 3. Detonates next turn.',
    category: 'tactical',
  },
  contact: {
    type: 'contact',
    name: 'Contact Bomb',
    fuseTurns: 0,
    behavior: { kind: 'explode', shape: { kind: 'plus', radius: 1 } },
    price: 95,
    description: 'Detonates on impact. Small + pattern blast.',
    category: 'instant',
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
    price: 30,
    description: 'Splits into 4 sub-bombs diagonally; each detonates a turn later.',
    category: 'tactical',
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
    description: 'Scattered banana piece. Waits a turn, then bursts in a small + blast.',
    category: 'standard',
  },
  flare: {
    type: 'flare',
    name: 'Flare',
    fuseTurns: 0,
    behavior: { kind: 'light', shape: { kind: 'circle', radius: 4 }, durationTurns: 3 },
    price: 5,
    description: 'Lights up a 9x9 area for 3 turns. No damage. Doesn’t break Rush.',
    category: 'utility',
  },
  molotov: {
    type: 'molotov',
    name: 'Molotov',
    fuseTurns: 0,
    behavior: { kind: 'fire', shape: { kind: 'plus', radius: 1 }, durationTurns: 2 },
    price: 100,
    description: 'Sets a 5-tile + ablaze for 2 turns. Burns on landing and each turn after.',
    category: 'instant',
  },
  ender_pearl: {
    type: 'ender_pearl',
    name: 'Ender Pearl',
    fuseTurns: 0,
    behavior: { kind: 'teleport' },
    price: 50,
    description: 'Teleports you to wherever it lands. Doesn’t break Rush.',
    category: 'escape',
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
    price: 15,
    description: 'Steps you 2 tiles toward the target and leaves a smoke cloud behind.',
    category: 'escape',
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
    price: 5,
    description: 'Hidden trap. Fires a flare when an enemy steps within 3 tiles of it.',
    category: 'utility',
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
    price: 65,
    description: '7x7 blast. Anyone caught is stunned for 1 turn.',
    category: 'utility',
  },
  // Special bombs gate behind treasure costs. Pricing tuned against average
  // per-run treasure haul (coffee ~46, mushroom ~206, grapes ~22, lantern ~6):
  // shield uses the most abundant currency, big_huge the rarest.
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
    price: 40,
    treasureCost: { type: 'grapes', amount: 2 },
    description: 'Reveals an 11x11 area, then scatters burning tiles the following turn.',
    category: 'special',
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
    price: 40,
    treasureCost: { type: 'coffee', amount: 5 },
    description: 'Scatters 25 mines across an 11x11 area. Anything that touches them triggers.',
    category: 'special',
  },
  big_huge: {
    type: 'big_huge',
    name: 'Big Huge',
    fuseTurns: 2,
    behavior: { kind: 'explode', shape: { kind: 'circle', radius: 5, rayCast: true } },
    price: 125,
    treasureCost: { type: 'lanterns', amount: 2 },
    description: 'Massive 11x11 explosion. Detonates after 2 turns.',
    category: 'special',
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
    price: 30,
    description: 'Spawns a + shield wall on impact. Blocks movement and explosions for 3 turns.',
    category: 'utility',
  },
};

/**
 * Bomb types players can buy/equip (excludes rock which is infinite/fixed).
 * Order is the canonical display order for the Bombs Shop catalog: grouped by
 * category (tactical → instant → escape → utility → special). This is the
 * single source of truth — the server emits the catalog in this order and the
 * client renders it as-is.
 */
export const PURCHASABLE_BOMBS: BombType[] = [
  // Tactical
  'bomb',
  'bomb_wide',
  'delay_tricky',
  'banana',
  // Instant
  'contact',
  'molotov',
  // Escape
  'ender_pearl',
  'fart_escape',
  // Utility
  'flare',
  'motion_detector_flare',
  'flash',
  'shield',
  // Special
  'phosphorus',
  'cluster_bomb',
  'big_huge',
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
