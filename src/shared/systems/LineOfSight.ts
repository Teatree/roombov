import { TileType } from '../types/map.ts';

/**
 * Check line of sight between two pixel positions using Bresenham's line on the tile grid.
 * Returns true if there are no wall or furniture tiles blocking the path.
 */
export function hasLineOfSight(
  x1: number, y1: number,
  x2: number, y2: number,
  grid: TileType[][],
  tileSize: number,
): boolean {
  // Convert to tile coordinates
  let tx1 = Math.floor(x1 / tileSize);
  let ty1 = Math.floor(y1 / tileSize);
  const tx2 = Math.floor(x2 / tileSize);
  const ty2 = Math.floor(y2 / tileSize);

  const dx = Math.abs(tx2 - tx1);
  const dy = Math.abs(ty2 - ty1);
  const sx = tx1 < tx2 ? 1 : -1;
  const sy = ty1 < ty2 ? 1 : -1;
  let err = dx - dy;

  while (true) {
    // Check current tile — walls and furniture block LOS
    const tile = grid[ty1]?.[tx1];
    if (tile === TileType.WALL || tile === TileType.FURNITURE) {
      // Allow the starting and ending tiles (entities stand on them)
      if (!(tx1 === Math.floor(x1 / tileSize) && ty1 === Math.floor(y1 / tileSize)) &&
          !(tx1 === tx2 && ty1 === ty2)) {
        return false;
      }
    }

    if (tx1 === tx2 && ty1 === ty2) break;

    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; tx1 += sx; }
    if (e2 < dx) { err += dx; ty1 += sy; }
  }

  return true;
}
