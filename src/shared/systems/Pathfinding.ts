/**
 * Grid pathfinding for 8-connected tile movement.
 *
 * Uses breadth-first search with uniform step cost. Since diagonal moves
 * cost 1 tile (Chebyshev distance), BFS is optimal here — no need for A*.
 *
 * The returned path excludes the starting tile and includes the destination.
 * Returns an empty array if no path exists or start == end.
 */

import type { MapData } from '../types/map.ts';
import { TileType } from '../types/map.ts';

export interface PathTile {
  x: number;
  y: number;
}

const DIRS: Array<[number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [-1, 1], [1, -1], [-1, -1],
];

export function findPath(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  map: MapData,
): PathTile[] {
  if (startX === endX && startY === endY) return [];
  if (!isWalkable(map, endX, endY)) return [];

  const visited = new Set<string>();
  const parent = new Map<string, { x: number; y: number }>();
  const key = (x: number, y: number): string => `${x},${y}`;

  const queue: PathTile[] = [{ x: startX, y: startY }];
  visited.add(key(startX, startY));

  let found = false;
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur.x === endX && cur.y === endY) { found = true; break; }

    for (const [dx, dy] of DIRS) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      if (!isWalkable(map, nx, ny)) continue;
      const k = key(nx, ny);
      if (visited.has(k)) continue;
      visited.add(k);
      parent.set(k, cur);
      queue.push({ x: nx, y: ny });
    }
  }

  if (!found) return [];

  // Reconstruct path from end → start, then reverse
  const path: PathTile[] = [];
  let cur: PathTile | undefined = { x: endX, y: endY };
  while (cur && !(cur.x === startX && cur.y === startY)) {
    path.push(cur);
    cur = parent.get(key(cur.x, cur.y));
  }
  path.reverse();
  return path;
}

function isWalkable(map: MapData, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return false;
  return map.grid[y]?.[x] === TileType.FLOOR;
}
