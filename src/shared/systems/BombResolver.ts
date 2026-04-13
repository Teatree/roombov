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
import { TileType, type MapData } from '../types/map.ts';

export interface Tile {
  x: number;
  y: number;
}

function isFloor(map: MapData, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return false;
  const row = map.grid[y];
  if (!row) return false;
  return row[x] === TileType.FLOOR;
}

/**
 * Compute every tile that a shape centered at (cx, cy) covers.
 * Result is deterministic and de-duplicated.
 *
 * Explosions cannot pass through collision tiles (walls/furniture). For ray
 * shapes ('plus', 'diag') each cardinal/diagonal ray halts as soon as it hits
 * a non-floor tile; for 'circle' we BFS-flood outward with 8-neighbor moves up
 * to the Chebyshev radius, which naturally contains the blast behind walls.
 * The center tile is always included (a bomb detonates where it sits even if
 * by some edge case it's not a floor).
 */
export function shapeTiles(
  shape: BombShape, cx: number, cy: number, map: MapData,
  closedDoorTiles: Set<string> = new Set(),
): Tile[] {
  const seen = new Set<string>();
  const out: Tile[] = [];
  const push = (x: number, y: number): void => {
    const key = `${x},${y}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ x, y });
  };

  // Walk a ray one step at a time, stopping at walls. Closed door tiles are
  // included in the blast (the explosion reaches them) but the ray stops
  // there — it doesn't pass through.
  const castRay = (dx: number, dy: number, radius: number): void => {
    for (let r = 1; r <= radius; r++) {
      const nx = cx + dx * r;
      const ny = cy + dy * r;
      if (!isFloor(map, nx, ny)) return;
      push(nx, ny);
      if (closedDoorTiles.has(`${nx},${ny}`)) return; // include but stop
    }
  };

  switch (shape.kind) {
    case 'single':
      push(cx, cy);
      break;

    case 'plus':
      push(cx, cy);
      castRay( 1,  0, shape.radius);
      castRay(-1,  0, shape.radius);
      castRay( 0,  1, shape.radius);
      castRay( 0, -1, shape.radius);
      break;

    case 'diag':
      push(cx, cy);
      castRay( 1,  1, shape.radius);
      castRay(-1,  1, shape.radius);
      castRay( 1, -1, shape.radius);
      castRay(-1, -1, shape.radius);
      break;

    case 'circle': {
      // BFS flood with 8-neighbor expansion up to the Chebyshev radius.
      // Walls block propagation, so tiles "behind" walls are excluded even
      // though they'd be inside the raw geometric disc.
      push(cx, cy);
      type QEntry = { x: number; y: number; d: number };
      const queue: QEntry[] = [{ x: cx, y: cy, d: 0 }];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        if (cur.d >= shape.radius) continue;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cur.x + dx;
            const ny = cur.y + dy;
            const key = `${nx},${ny}`;
            if (seen.has(key)) continue;
            if (!isFloor(map, nx, ny)) continue;
            push(nx, ny);
            // Closed doors: include tile but don't expand past them
            if (closedDoorTiles.has(`${nx},${ny}`)) continue;
            queue.push({ x: nx, y: ny, d: cur.d + 1 });
          }
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

export function resolveBombTrigger(
  type: BombType, cx: number, cy: number, map: MapData,
  closedDoorTiles: Set<string> = new Set(),
): BombTriggerResult {
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
      result.damageTiles = shapeTiles(def.behavior.shape, cx, cy, map, closedDoorTiles);
      break;

    case 'fire': {
      const tiles = shapeTiles(def.behavior.shape, cx, cy, map, closedDoorTiles);
      result.fireTiles = tiles;
      result.fireDuration = def.behavior.durationTurns;
      // Molotov also deals immediate damage to Bombermen on the landing tiles
      // per the brief: "immediately dealt 1 damage" on hit/spread.
      result.damageTiles = tiles;
      break;
    }

    case 'light':
      result.lightTiles = shapeTiles(def.behavior.shape, cx, cy, map, closedDoorTiles);
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

    case 'teleport':
      // Teleport is handled directly in TurnResolver — no tiles to compute.
      break;
  }

  return result;
}
