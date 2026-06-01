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

import type { BombDef, BombShape, BombType, MineKind } from '../types/bombs.ts';
import { BOMB_CATALOG } from '../config/bombs.ts';
import { TileType, type MapData } from '../types/map.ts';
import { hasLineOfSight } from './LineOfSight.ts';

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
  shieldWallTiles: Set<string> = new Set(),
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
  // there — it doesn't pass through. Shield walls FULLY block: the wall tile
  // is excluded from the blast and the ray stops before it.
  const castRay = (dx: number, dy: number, radius: number): void => {
    for (let r = 1; r <= radius; r++) {
      const nx = cx + dx * r;
      const ny = cy + dy * r;
      if (!isFloor(map, nx, ny)) return;
      if (shieldWallTiles.has(`${nx},${ny}`)) return; // full block, no damage
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
      push(cx, cy);
      if (shape.rayCast) {
        // Damage explosion: each candidate tile in the disc must have a clear
        // ray from the centre (LoS rule). Walls, closed doors, and shield
        // walls block. Stops the blast from wrapping around corners — the
        // explosion is geometrically a disc, not a flood.
        const ts = map.tileSize;
        const fromPx = cx * ts + ts / 2;
        const fromPy = cy * ts + ts / 2;
        for (let dy = -shape.radius; dy <= shape.radius; dy++) {
          for (let dx = -shape.radius; dx <= shape.radius; dx++) {
            if (dx === 0 && dy === 0) continue;
            if (Math.max(Math.abs(dx), Math.abs(dy)) > shape.radius) continue;
            const nx = cx + dx;
            const ny = cy + dy;
            if (!isFloor(map, nx, ny)) continue;
            if (shieldWallTiles.has(`${nx},${ny}`)) continue;
            const toPx = nx * ts + ts / 2;
            const toPy = ny * ts + ts / 2;
            if (hasLineOfSight(fromPx, fromPy, toPx, toPy, map.grid, ts, closedDoorTiles, shieldWallTiles)) {
              push(nx, ny);
            }
          }
        }
      } else {
        // BFS flood with 8-neighbor expansion up to the Chebyshev radius.
        // Walls block propagation, so tiles "behind" walls are excluded even
        // though they'd be inside the raw geometric disc. Used for utility
        // coverage (light, smoke, stun) where corner-wrap reads as natural
        // diffusion rather than a physics-defying explosion.
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
              // Shield walls: full block — exclude the tile, don't expand.
              if (shieldWallTiles.has(`${nx},${ny}`)) continue;
              push(nx, ny);
              // Closed doors: include tile but don't expand past them
              if (closedDoorTiles.has(`${nx},${ny}`)) continue;
              queue.push({ x: nx, y: ny, d: cur.d + 1 });
            }
          }
        }
      }
      break;
    }
  }

  return out;
}

/**
 * Preview helper: the full set of tiles a bomb of `type` detonating at (cx, cy)
 * would visually affect. Used by the client's explosion-ghost overlay (both the
 * "aiming" outline and the "landed" filled zone) — NOT used to resolve damage
 * (the turn resolver computes that authoritatively). Pure and deterministic.
 *
 * Mirrors the per-behavior tile math the resolver uses, reusing `shapeTiles`.
 * For Banana (scatter) it unions the blast zones of each deterministic child
 * landing (offsets are fixed, not RNG), so the preview shows the real coverage.
 * Cluster mines scatter via RNG at trigger time, so we can only preview the
 * candidate area (the w×h box of floor tiles).
 */
export function bombAffectedTiles(
  type: BombType, cx: number, cy: number, map: MapData,
  closedDoorTiles: Set<string> = new Set(),
  shieldWallTiles: Set<string> = new Set(),
): Tile[] {
  const def = BOMB_CATALOG[type];
  const b = def.behavior;
  switch (b.kind) {
    case 'explode':
    case 'fire':
    case 'light':
    case 'stun_explode':
    case 'shield_wall':
      return shapeTiles(b.shape, cx, cy, map, closedDoorTiles, shieldWallTiles);

    case 'phosphorus_seed':
      return shapeTiles(b.revealShape, cx, cy, map, closedDoorTiles, shieldWallTiles);

    case 'smoke':
      // Approximate: the smoke footprint at the target. Fart Escape actually
      // pathfinds the thrower a couple tiles first; not previewed precisely.
      return shapeTiles(b.shape, cx, cy, map, closedDoorTiles, shieldWallTiles);

    case 'scatter': {
      // Union of each deterministic child's blast zone (offsets are fixed).
      const seen = new Set<string>();
      const out: Tile[] = [];
      const addAll = (tiles: Tile[]): void => {
        for (const t of tiles) {
          const key = `${t.x},${t.y}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(t);
        }
      };
      for (const off of b.offsets) {
        const childX = cx + off.dx;
        const childY = cy + off.dy;
        if (!isFloor(map, childX, childY)) continue;
        if (shieldWallTiles.has(`${childX},${childY}`)) continue;
        addAll(bombAffectedTiles(b.childType, childX, childY, map, closedDoorTiles, shieldWallTiles));
      }
      return out;
    }

    case 'cluster_seed': {
      // Candidate scatter region: floor tiles inside the w×h box around origin.
      const out: Tile[] = [];
      const halfW = Math.floor(b.area.w / 2);
      const halfH = Math.floor(b.area.h / 2);
      for (let dy = -halfH; dy <= halfH; dy++) {
        for (let dx = -halfW; dx <= halfW; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (!isFloor(map, nx, ny)) continue;
          if (shieldWallTiles.has(`${nx},${ny}`)) continue;
          out.push({ x: nx, y: ny });
        }
      }
      return out;
    }

    case 'place_mine':
      // Detection radius footprint (floor tiles reachable within the radius).
      return shapeTiles({ kind: 'circle', radius: b.detectionRadius }, cx, cy, map, closedDoorTiles, shieldWallTiles);

    case 'teleport':
      // No area effect — just the destination tile.
      return [{ x: cx, y: cy }];
  }
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
  /** Fire kind: 'molotov' (standard orange) or 'phosphorus' (white) for rendering. */
  fireKind?: 'molotov' | 'phosphorus';
  /** Light tiles to spawn (no damage). */
  lightTiles: Tile[];
  lightDuration: number;
  /** Light kind: 'flare' / 'phosphorus' / 'motion_detector' for color variants. */
  lightKind?: 'flare' | 'phosphorus' | 'motion_detector';
  /**
   * Sub-bombs to spawn as a scatter. These are added to the bomb list with the
   * child bomb's own fuse. Empty for non-scatter bombs.
   */
  scatterSpawns: Array<{ type: BombType; x: number; y: number }>;
  /**
   * Stun application — affected bombermen on `stunTiles` get `stunTurns`
   * turns of Stunned. Non-zero only for stun_explode (Flash).
   * Flash does NOT deal damage, only stun.
   */
  stunTurns: number;
  stunTiles: Tile[];
  /**
   * Phosphorus only — seeds a deferred-fire spawn for next turn.
   */
  phosphorusSeed?: { originX: number; originY: number; fireDurationTurns: number };
  /**
   * Mine placement (Motion Detector). Only non-null for place_mine behavior.
   */
  mineToPlace?: { kind: MineKind; lifetimeTurns: number; detectionRadius?: number };
  /**
   * Cluster seed area (Cluster Bomb). TurnResolver does the actual RNG placement
   * using the match's seeded random — BombResolver just surfaces the area.
   */
  clusterSeed?: { area: { w: number; h: number }; mineCount: number };
  /**
   * Smoke cloud deployment (Fart Escape). Tiles inside the circle (BFS-limited
   * by walls, same as circle pattern).
   */
  smokeSpawn?: { tiles: Tile[]; durationTurns: number; radius: number };
}

export function resolveBombTrigger(
  type: BombType, cx: number, cy: number, map: MapData,
  closedDoorTiles: Set<string> = new Set(),
  shieldWallTiles: Set<string> = new Set(),
): BombTriggerResult {
  const def: BombDef = BOMB_CATALOG[type];
  const result: BombTriggerResult = {
    damageTiles: [],
    fireTiles: [],
    fireDuration: 0,
    lightTiles: [],
    lightDuration: 0,
    scatterSpawns: [],
    stunTurns: 0,
    stunTiles: [],
  };

  switch (def.behavior.kind) {
    case 'explode':
      result.damageTiles = shapeTiles(def.behavior.shape, cx, cy, map, closedDoorTiles, shieldWallTiles);
      break;

    case 'fire': {
      const tiles = shapeTiles(def.behavior.shape, cx, cy, map, closedDoorTiles, shieldWallTiles);
      result.fireTiles = tiles;
      result.fireDuration = def.behavior.durationTurns;
      // Molotov also deals immediate damage to Bombermen on the landing tiles
      // per the brief: "immediately dealt 1 damage" on hit/spread.
      result.damageTiles = tiles;
      break;
    }

    case 'light':
      result.lightTiles = shapeTiles(def.behavior.shape, cx, cy, map, closedDoorTiles, shieldWallTiles);
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

    case 'stun_explode': {
      // Flash: NO damage, only stun. The shape defines the stun area.
      result.stunTiles = shapeTiles(def.behavior.shape, cx, cy, map, closedDoorTiles, shieldWallTiles);
      result.stunTurns = def.behavior.stunTurns;
      break;
    }

    case 'phosphorus_seed': {
      result.lightTiles = shapeTiles(def.behavior.revealShape, cx, cy, map, closedDoorTiles, shieldWallTiles);
      result.lightDuration = def.behavior.revealTurns;
      result.lightKind = 'phosphorus';
      result.phosphorusSeed = {
        originX: cx,
        originY: cy,
        fireDurationTurns: def.behavior.fireDurationTurns,
      };
      break;
    }

    case 'cluster_seed': {
      result.clusterSeed = { area: def.behavior.area, mineCount: def.behavior.mineCount };
      break;
    }

    case 'smoke': {
      const tiles = shapeTiles(def.behavior.shape, cx, cy, map, closedDoorTiles, shieldWallTiles);
      const radius = def.behavior.shape.kind === 'circle' ? def.behavior.shape.radius : 0;
      result.smokeSpawn = {
        tiles,
        durationTurns: def.behavior.durationTurns,
        radius,
      };
      break;
    }

    case 'place_mine': {
      result.mineToPlace = {
        kind: def.behavior.mineKind,
        lifetimeTurns: def.behavior.lifetimeTurns,
        detectionRadius: def.behavior.detectionRadius,
      };
      break;
    }

    case 'shield_wall':
      // Shield Bomb is fully handled in TurnResolver — no tiles to compute here.
      break;
  }

  return result;
}
