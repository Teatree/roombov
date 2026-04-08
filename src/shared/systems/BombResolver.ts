/**
 * Pure functions for bomb tile computation.
 *
 * No Phaser imports, no mutation of external state — BombResolver takes a
 * bomb (type + center tile) and returns the set of tiles it affects. The
 * turn resolver combines these sets with Bomberman positions to decide who
 * takes damage, and with fire/light state for the lingering effects.
 *
 * All coordinates are in tile space (integer x, y).
 */

import type { BombDef, BombShape, BombType } from '../types/bombs.ts';
import { BOMB_CATALOG } from '../config/bombs.ts';

export interface Tile {
  x: number;
  y: number;
}

/**
 * Compute every tile that a shape centered at (cx, cy) covers.
 * Result is deterministic and de-duplicated.
 */
export function shapeTiles(shape: BombShape, cx: number, cy: number): Tile[] {
  const seen = new Set<string>();
  const out: Tile[] = [];
  const push = (x: number, y: number): void => {
    const key = `${x},${y}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ x, y });
  };

  switch (shape.kind) {
    case 'single':
      push(cx, cy);
      break;

    case 'plus':
      push(cx, cy);
      for (let r = 1; r <= shape.radius; r++) {
        push(cx + r, cy);
        push(cx - r, cy);
        push(cx, cy + r);
        push(cx, cy - r);
      }
      break;

    case 'diag':
      push(cx, cy);
      for (let r = 1; r <= shape.radius; r++) {
        push(cx + r, cy + r);
        push(cx - r, cy + r);
        push(cx + r, cy - r);
        push(cx - r, cy - r);
      }
      break;

    case 'circle': {
      // Chebyshev disc (square)
      for (let dy = -shape.radius; dy <= shape.radius; dy++) {
        for (let dx = -shape.radius; dx <= shape.radius; dx++) {
          push(cx + dx, cy + dy);
        }
      }
      break;
    }
  }

  return out;
}

/**
 * Resolved effect of triggering a bomb of `type` at (cx, cy).
 *
 * Triggering is the moment the fuse runs out (or impact for fuse 0). The
 * turn resolver consumes this to mutate the match state.
 */
export interface BombTriggerResult {
  /** Tiles that deal immediate 1-damage on trigger. Empty for non-damaging bombs. */
  damageTiles: Tile[];
  /** Fire tiles to spawn with this bomb's duration. */
  fireTiles: Tile[];
  fireDuration: number;
  /** Light tiles to spawn (no damage). */
  lightTiles: Tile[];
  lightDuration: number;
  /**
   * Sub-bombs to spawn as a scatter. These are added to the bomb list with the
   * child bomb's own fuse. Empty for non-scatter bombs.
   */
  scatterSpawns: Array<{ type: BombType; x: number; y: number }>;
}

export function resolveBombTrigger(type: BombType, cx: number, cy: number): BombTriggerResult {
  const def: BombDef = BOMB_CATALOG[type];
  const result: BombTriggerResult = {
    damageTiles: [],
    fireTiles: [],
    fireDuration: 0,
    lightTiles: [],
    lightDuration: 0,
    scatterSpawns: [],
  };

  switch (def.behavior.kind) {
    case 'explode':
      result.damageTiles = shapeTiles(def.behavior.shape, cx, cy);
      break;

    case 'fire': {
      const tiles = shapeTiles(def.behavior.shape, cx, cy);
      result.fireTiles = tiles;
      result.fireDuration = def.behavior.durationTurns;
      // Molotov also deals immediate damage to Bombermen on the landing tiles
      // per the brief: "immediately dealt 1 damage" on hit/spread.
      result.damageTiles = tiles;
      break;
    }

    case 'light':
      result.lightTiles = shapeTiles(def.behavior.shape, cx, cy);
      result.lightDuration = def.behavior.durationTurns;
      break;

    case 'scatter':
      for (const off of def.behavior.offsets) {
        result.scatterSpawns.push({
          type: def.behavior.childType,
          x: cx + off.dx,
          y: cy + off.dy,
        });
      }
      break;
  }

  return result;
}
