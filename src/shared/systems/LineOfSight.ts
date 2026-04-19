import { TileType } from '../types/map.ts';

/**
 * Check line of sight between two pixel positions using the Amanatides-Woo
 * voxel (grid) traversal DDA. Returns true iff nothing along the ray
 * blocks vision.
 *
 * Blockers:
 *   - Walls and Furniture tiles.
 *   - CLOSED doors — passed in via `closedDoorTiles` (keys of the form
 *     `"x,y"`). Open doors are not blockers and may be omitted.
 *
 * The starting and ending tiles are always "seen through" — entities stand
 * on them, and we want visibility of the other bomberman on that tile.
 *
 * Why DDA instead of Bresenham: the tile set visited is defined purely by
 * the line's geometry, so `hasLineOfSight(A, B) === hasLineOfSight(B, A)`
 * for every pair — there's no direction-dependent stepping choice. The old
 * Bresenham implementation was asymmetric at certain corner layouts: one
 * direction would test a "corner neighbor" tile the other didn't, producing
 * inconsistent peek-around-corner results from opposite sides of a wall.
 *
 * Strict corner rule: when the ray passes EXACTLY through a grid corner
 * (tMaxX === tMaxY), both orthogonal neighbor tiles on the way across that
 * corner must be clear. This prevents a ray from sneaking between two
 * walls that meet diagonally.
 */
export function hasLineOfSight(
  x1: number, y1: number,
  x2: number, y2: number,
  grid: TileType[][],
  tileSize: number,
  closedDoorTiles?: Set<string>,
): boolean {
  const startTx = Math.floor(x1 / tileSize);
  const startTy = Math.floor(y1 / tileSize);
  const endTx = Math.floor(x2 / tileSize);
  const endTy = Math.floor(y2 / tileSize);

  // Same tile — always visible to itself.
  if (startTx === endTx && startTy === endTy) return true;

  const isBlocker = (cx: number, cy: number): boolean => {
    if (cx === startTx && cy === startTy) return false;
    if (cx === endTx && cy === endTy) return false;
    const t = grid[cy]?.[cx];
    if (t === TileType.WALL || t === TileType.FURNITURE) return true;
    if (closedDoorTiles && closedDoorTiles.has(`${cx},${cy}`)) return true;
    return false;
  };

  const dx = x2 - x1;
  const dy = y2 - y1;
  const sx = dx > 0 ? 1 : (dx < 0 ? -1 : 0);
  const sy = dy > 0 ? 1 : (dy < 0 ? -1 : 0);

  // tMaxX / tMaxY — distance (in ray parameter t, where t=0 at start,
  // t=1 at end) to the next vertical / horizontal grid line crossing.
  let tMaxX: number;
  if (sx > 0) tMaxX = ((startTx + 1) * tileSize - x1) / dx;
  else if (sx < 0) tMaxX = (startTx * tileSize - x1) / dx;
  else tMaxX = Infinity;

  let tMaxY: number;
  if (sy > 0) tMaxY = ((startTy + 1) * tileSize - y1) / dy;
  else if (sy < 0) tMaxY = (startTy * tileSize - y1) / dy;
  else tMaxY = Infinity;

  // tDeltaX / tDeltaY — ray parameter step per grid line crossed.
  const tDeltaX = sx !== 0 ? Math.abs(tileSize / dx) : Infinity;
  const tDeltaY = sy !== 0 ? Math.abs(tileSize / dy) : Infinity;

  // Small epsilon for the tMaxX === tMaxY corner check — floating-point
  // exactness isn't guaranteed, so treat near-equal as equal.
  const EPS = 1e-9;

  let tx = startTx;
  let ty = startTy;

  // Safety cap — worst case a ray crosses (dx + dy) cells on the axis
  // totals, plus a small buffer. Prevents an infinite loop from any
  // floating-point edge case we haven't anticipated.
  const maxSteps = Math.abs(endTx - startTx) + Math.abs(endTy - startTy) + 4;
  for (let step = 0; step < maxSteps; step++) {
    if (tx === endTx && ty === endTy) return true;

    const diff = tMaxX - tMaxY;
    if (diff < -EPS) {
      // X-axis crossing hits first.
      tx += sx;
      tMaxX += tDeltaX;
    } else if (diff > EPS) {
      // Y-axis crossing hits first.
      ty += sy;
      tMaxY += tDeltaY;
    } else {
      // Exact corner crossing — strict rule: both orthogonal neighbors
      // must be clear or the ray is considered blocked. Prevents the
      // "diagonal slip" between two walls that meet at the corner.
      if (isBlocker(tx + sx, ty) || isBlocker(tx, ty + sy)) return false;
      tx += sx;
      ty += sy;
      tMaxX += tDeltaX;
      tMaxY += tDeltaY;
    }

    if (isBlocker(tx, ty)) return false;
  }
  // Shouldn't reach here for well-formed input — fall back to true.
  return true;
}
